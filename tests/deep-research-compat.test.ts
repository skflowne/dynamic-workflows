import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseWorkflowScript, runWorkflow, ScriptedAgentRunner, type WorkflowAgentCall } from "../src/index.js";

const fixturePath =
  process.env.DEEP_RESEARCH_WORKFLOW_PATH ?? fileURLToPath(new URL("../examples/deep-research.js", import.meta.url));

const maybeTest = existsSync(fixturePath) ? test : test.skip;

maybeTest("runs the Claude deep-research workflow script with a stubbed agent runner", async () => {
  const script = readFileSync(fixturePath, "utf8");
  const parsed = parseWorkflowScript(script);
  assert.equal(parsed.meta.name, "deep-research");

  const runner = new ScriptedAgentRunner(createDeepResearchStub());
  const result = await runWorkflow<any>(script, {
    args: "What does the compatibility runtime need to support?",
    runner,
    concurrency: 8,
  });

  assert.equal(result.meta.name, "deep-research");
  assert.equal(result.result.question, "What does the compatibility runtime need to support?");
  assert.ok(result.result.summary.includes("compatibility"));
  assert.ok(Array.isArray(result.result.findings));
  assert.ok(result.result.findings.length >= 1);
  assert.ok(result.result.stats.sourcesFetched >= 3);
  assert.ok(result.result.stats.claimsVerified >= 3);
  assert.ok(runner.calls.some((call) => call.options.label === "scope"));
  assert.ok(runner.calls.some((call) => call.options.label?.startsWith("search:")));
  assert.ok(runner.calls.some((call) => call.options.label?.startsWith("fetch:")));
  assert.ok(runner.calls.some((call) => call.options.label?.startsWith("v0:")));
  assert.ok(runner.calls.some((call) => call.options.label === "synthesize"));
});

maybeTest("deep-research empty args exits before spawning agents", async () => {
  const script = readFileSync(fixturePath, "utf8");
  const runner = new ScriptedAgentRunner(createDeepResearchStub());
  const result = await runWorkflow<any>(script, { args: "  ", runner });

  assert.match(result.result.error, /No research question provided/);
  assert.equal(runner.calls.length, 0);
});

maybeTest("deep-research returns no-claims summary without verify or synthesize", async () => {
  const script = readFileSync(fixturePath, "utf8");
  const runner = new ScriptedAgentRunner(createDeepResearchStub({ mode: "no-claims" }));
  const result = await runWorkflow<any>(script, { args: "No claims scenario", runner });

  assert.match(result.result.summary, /No claims extracted/);
  assert.equal(result.result.stats.claims, 0);
  assert.ok(!runner.calls.some((call) => call.options.label?.startsWith("v0:")));
  assert.ok(!runner.calls.some((call) => call.options.label === "synthesize"));
});

maybeTest("deep-research handles all-refuted claims without synthesis", async () => {
  const script = readFileSync(fixturePath, "utf8");
  const runner = new ScriptedAgentRunner(createDeepResearchStub({ mode: "all-refuted" }));
  const result = await runWorkflow<any>(script, { args: "All refuted scenario", runner });

  assert.equal(result.result.findings.length, 0);
  assert.match(result.result.summary, /All .* claims refuted/);
  assert.ok(result.result.refuted.length > 0);
  assert.ok(!runner.calls.some((call) => call.options.label === "synthesize"));
});

maybeTest("deep-research salvages confirmed claims when synthesize returns null", async () => {
  const script = readFileSync(fixturePath, "utf8");
  const runner = new ScriptedAgentRunner(createDeepResearchStub({ mode: "null-synthesis" }));
  const result = await runWorkflow<any>(script, { args: "Null synthesis scenario", runner });

  assert.match(result.result.summary, /Synthesis step was skipped or failed/);
  assert.equal(result.result.findings.length, 0);
  assert.ok(result.result.confirmed.length > 0);
  assert.ok(runner.calls.some((call) => call.options.label === "synthesize"));
});

maybeTest("deep-research drops a failed fetch (null) instead of mislabeling it unreliable", async () => {
  const script = readFileSync(fixturePath, "utf8");
  const runner = new ScriptedAgentRunner(createDeepResearchStub({ mode: "fetch-throw-once" }));
  // Claude parity: a failed agent() returns null (it does not throw), so the fixture DROPS the source
  // via `.filter(Boolean)` rather than routing it through `.catch()` and labeling it "unreliable" (see
  // the fixture's own comment). agentMaxAttempts:1 makes the single stub throw terminal so we observe
  // the null path: one of three angle sources fails → two survive, the failure is recorded, run completes.
  const result = await runWorkflow<any>(script, { args: "Fetch throw scenario", runner, agentMaxAttempts: 1 });

  assert.equal(result.failures.length, 1);
  assert.equal(result.result.sources.filter((source: any) => source.quality === "unreliable").length, 0);
  assert.ok(result.result.stats.sourcesFetched >= 2);
  assert.ok(result.result.findings.length >= 1);
});

type DeepResearchStubMode = "happy" | "no-claims" | "all-refuted" | "null-synthesis" | "fetch-throw-once";

function createDeepResearchStub(options: { mode?: DeepResearchStubMode } = {}) {
  const mode = options.mode ?? "happy";
  let fetchThrown = false;
  return (call: WorkflowAgentCall): unknown => deepResearchStub(call, mode, () => {
    if (fetchThrown) return false;
    fetchThrown = true;
    return true;
  });
}

function deepResearchStub(call: WorkflowAgentCall, mode: DeepResearchStubMode, shouldThrowFetch: () => boolean): unknown {
  const label = call.options.label ?? "";
  if (label === "scope") {
    return {
      question: "What does the compatibility runtime need to support?",
      summary: "Check compatibility runtime support for orchestration APIs.",
      angles: [
        { label: "api", query: "workflow runtime api compatibility", rationale: "Core API surface" },
        { label: "schema", query: "structured output schema validation", rationale: "Schema behavior" },
        { label: "execution", query: "parallel pipeline agent orchestration", rationale: "Execution behavior" },
      ],
    };
  }

  if (label.startsWith("search:")) {
    const angle = label.slice("search:".length);
    return {
      results: [
        {
          url: `https://example.com/${angle}`,
          title: `${angle} source`,
          snippet: "Compatibility source",
          relevance: "high",
        },
        {
          url: `https://www.example.com/${angle}/?utm_source=test`,
          title: `${angle} duplicate-ish source`,
          snippet: "Duplicate URL normalization source",
          relevance: "medium",
        },
      ],
    };
  }

  if (label.startsWith("fetch:")) {
    const source = sourceUrlFromPrompt(call.prompt);
    if (mode === "fetch-throw-once" && shouldThrowFetch()) {
      throw new Error(`fetch failed for ${source.href}`);
    }
    return {
      sourceQuality: "primary",
      publishDate: "2026-06-06",
      claims:
        mode === "no-claims"
          ? []
          : [
              {
                claim: `Runtime supports ${source.pathname.replace("/", "") || "root"} orchestration`,
                quote: "The runtime supports agent, parallel, pipeline, phase, and log.",
                importance: "central",
              },
            ],
    };
  }

  if (/^v\d+:/.test(label)) {
    const voter = Number(label.match(/^v(\d+):/)?.[1] ?? 0);
    const refuted = mode === "all-refuted" ? voter < 2 : voter === 2;
    return {
      refuted,
      evidence:
        refuted
          ? "Adversarial vote refutes the claim for this scenario."
          : "Supported by the source quote and compatible runtime API coverage.",
      confidence: refuted ? "low" : "high",
      counterSource: refuted ? "https://example.com/counterpoint" : undefined,
    };
  }

  if (label === "synthesize") {
    if (mode === "null-synthesis") return null;
    return {
      summary:
        "The compatibility runtime needs to support agent orchestration, structured schemas, phases, logs, and fan-out/fan-in control.",
      findings: [
        {
          claim: "The runtime supports the deep-research orchestration surface.",
          confidence: "high",
          sources: ["https://example.com/api", "https://example.com/schema"],
          evidence: "Stubbed voters confirmed the claims with two supporting votes per claim.",
          vote: "2-1",
        },
      ],
      caveats: "This is a deterministic stub test, not a live web research run.",
      openQuestions: ["How closely should Codex runner failure semantics match Claude Code?"],
    };
  }

  throw new Error(`Unhandled deep-research stub label: ${label}`);
}

function sourceUrlFromPrompt(prompt: string): URL {
  const match = prompt.match(/\*\*URL:\*\*\s+(https?:\/\/\S+)/);
  return new URL(match?.[1] ?? "https://example.com/unknown");
}
