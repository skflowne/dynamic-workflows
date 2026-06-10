import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { GeminiCliAgentRunner, runWorkflow } from "../src/index.js";
import type { WorkflowAgentCall, WorkflowAgentMeta } from "../src/index.js";

function makeCall(prompt: string, model?: string): WorkflowAgentCall {
  return {
    prompt,
    options: { label: "gemini", ...(model ? { model } : {}) },
    index: 1,
    runId: "wf_gemini_test",
    cacheKey: "k",
  };
}

test("GeminiCliAgentRunner parses Gemini JSON output and reports metadata", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-runner-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const prompt = valueAfter("-p") || valueAfter("--prompt") || "";
const model = valueAfter("--model") || valueAfter("-m") || "none";
const session = valueAfter("--session-id") || "";
console.error("startup noise");
console.log(JSON.stringify({
  session_id: session,
  response: [model, args.includes("-y"), args.includes("-o"), Boolean(session), prompt.includes("payload")].join(":"),
  stats: { models: { [model]: { tokens: { candidates: 7, total: 99 } } } }
}));
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const metas: WorkflowAgentMeta[] = [];
    const runner = new GeminiCliAgentRunner({
      command: fakeGemini,
      cwd: dir,
      model: "runner-model",
      // Generous: under full-suite parallel load the fake CLI's node startup can exceed 1s, which
      // intermittently tripped this as a spurious agent timeout.
      agentTimeoutMs: 10000,
    });
    const result = await runner.run(makeCall("payload", "call-model"), undefined, (meta) => metas.push(meta));

    assert.equal(result, "runner-model:true:true:true:true");
    const sessionIds = metas.map((meta) => meta.sessionId).filter(Boolean);
    assert.equal(sessionIds.length, 2);
    assert.equal(sessionIds[0], sessionIds[1]);
    assert.ok(metas.some((meta) => meta.outputTokens === 7));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GeminiCliAgentRunner finds Gemini JSON in noisy stderr", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-stderr-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
console.error('YOLO mode is enabled. All tool calls will be automatically approved.');
console.error('Tool with name "mcp_geminix_gitlab_get_merge_request_diffs" is already registered. Overwriting.');
console.error('debug noise before wrapper: {not valid json}');
console.error(JSON.stringify({
  session_id: "stderr-session",
  response: "stderr-ok",
  stats: { models: { "gemini-test": { tokens: { candidates: 5 } } } }
}));
console.error('trailing warning after wrapper');
process.exit(1);
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const metas: WorkflowAgentMeta[] = [];
    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir, model: "gemini-test" });
    const result = await runner.run(makeCall("payload"), undefined, (meta) => metas.push(meta));

    assert.equal(result, "stderr-ok");
    assert.ok(metas.some((meta) => meta.sessionId === "stderr-session"));
    assert.ok(metas.some((meta) => meta.outputTokens === 5));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GeminiCliAgentRunner sums output tokens across multiple models", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-multimodel-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  session_id: "multi-session",
  response: "multi-ok",
  stats: { models: {
    "gemini-flash": { tokens: { candidates: 4, total: 1000 } },
    "gemini-pro": { tokens: { candidates: 6, total: 2000 } }
  } }
}));
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const metas: WorkflowAgentMeta[] = [];
    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir });
    const result = await runner.run(makeCall("payload"), undefined, (meta) => metas.push(meta));

    assert.equal(result, "multi-ok");
    // candidates summed across BOTH models (4 + 6 = 10) — not just the first model, and not the
    // input-inclusive `total` (which would be 1000/3000 and badly overcount the budget).
    assert.ok(
      metas.some((meta) => meta.outputTokens === 10),
      `expected summed outputTokens=10, got ${JSON.stringify(metas)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GeminiCliAgentRunner embeds the JSON schema in the prompt (no native schema flag)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-schema-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    // The fake CLI echoes back whether the schema's field name reached it via the -p prompt.
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const valueAfter = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const prompt = valueAfter("-p") || "";
console.log(JSON.stringify({
  session_id: "schema-session",
  response: JSON.stringify({ sawField: prompt.includes("magic_field_xyz"), sawSchemaHeader: prompt.includes("JSON Schema your output must satisfy") })
}));
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir });
    const call: WorkflowAgentCall = {
      prompt: "extract the thing",
      options: {
        label: "x",
        schema: { type: "object", properties: { magic_field_xyz: { type: "string" } }, required: ["magic_field_xyz"] },
      },
      index: 1,
      runId: "wf_schema",
      cacheKey: "k",
    };
    const result = await runner.run(call, undefined, () => {});
    // Gemini has no native schema flag, so the schema (field name + header) must appear in the prompt.
    assert.match(String(result), /"sawField":true/);
    assert.match(String(result), /"sawSchemaHeader":true/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "GeminiCliAgentRunner executes a live Gemini CLI agent turn",
  { skip: process.env.RUN_GEMINI_CLI_LIVE === "1" ? false : "Set RUN_GEMINI_CLI_LIVE=1 to run the live Gemini CLI test." },
  async () => {
    const result = await runWorkflow(
      `export const meta = {
  name: 'gemini_cli_live',
  description: 'Live Gemini CLI smoke test'
}

return agent('Return exactly this text and nothing else: gemini-workflow-live-ok', { label: 'echo' })
`,
      {
        runner: new GeminiCliAgentRunner({
          cwd: process.cwd(),
          model: process.env.GEMINI_CLI_MODEL ?? "gemini-3.5-flash",
          agentTimeoutMs: 120000,
        }),
      },
    );

    assert.equal(String(result.result).trim(), "gemini-workflow-live-ok");
  },
);
