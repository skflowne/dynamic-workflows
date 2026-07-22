import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
// The runner now feeds the prompt on stdin (empty -p triggers headless mode).
const prompt = require("node:fs").readFileSync(0, "utf8");
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
const prompt = require("node:fs").readFileSync(0, "utf8");
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

test("GeminiCliAgentRunner does NOT fall back to input-inclusive `total` tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-nototal-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    // Only `total` is present (no candidates/output). total includes input tokens, so the runner must
    // NOT report it — it should leave outputTokens unset so the runtime falls back to estimateTokens.
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
console.log(JSON.stringify({
  session_id: "nototal-session",
  response: "ok",
  stats: { models: { "gemini-test": { tokens: { total: 5000 } } } }
}));
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const metas: WorkflowAgentMeta[] = [];
    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir });
    const result = await runner.run(makeCall("payload"), undefined, (meta) => metas.push(meta));

    assert.equal(result, "ok");
    assert.ok(
      !metas.some((meta) => typeof meta.outputTokens === "number"),
      `expected NO outputTokens reported (total must not be used), got ${JSON.stringify(metas)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GeminiCliAgentRunner captures trailing stdout flushed at close (not truncated on exit)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-flush-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    // Emit a large (multi-chunk) response; the runner must accumulate every chunk and only settle once
    // all stdout has drained at `close`, never truncating on an early `exit`. The write callback ensures
    // the writer itself fully flushes the pipe before exiting.
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
const big = "x".repeat(500000);
process.stdout.write(JSON.stringify({ session_id: "flush-session", response: big }), () => process.exit(0));
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir, agentTimeoutMs: 10000 });
    const result = await runner.run(makeCall("payload"), undefined, () => {});
    assert.equal(String(result).length, 500000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GeminiCliAgentRunner rejects with the canonical agentTimeoutMs message when a turn hangs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-timeout-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    // Never produces output — sleeps well past the tiny agentTimeoutMs below, so the runner's own
    // timeout (not a user abort) must fire and reject with the shared turn-control message
    // (src/runners/turn-control.ts `agentTimeoutError`), which the runtime treats as a retryable
    // agent failure (not a workflow cancellation) — the message text is the observable contract
    // across the Bun-child IPC boundary.
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
process.on("SIGTERM", () => process.exit(1));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir, agentTimeoutMs: 300 });
    await assert.rejects(
      () => runner.run(makeCall("payload"), undefined, () => {}),
      /agent exceeded agentTimeoutMs \(300ms\)/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GeminiCliAgentRunner SIGKILLs a child that ignores SIGTERM on abort", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-sigkill-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    const readyFile = path.join(dir, "trap-ready");
    // Traps SIGTERM and keeps running — only SIGKILL can stop it. It touches `readyFile` AFTER the trap
    // is installed so the test can wait for that before aborting (otherwise a SIGTERM racing node's
    // startup would hit the default handler and kill it, masking the SIGKILL-escalation we're testing).
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
require("node:fs").writeFileSync(${JSON.stringify(readyFile)}, "ok");
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    // agentTimeoutMs generous so the abort (not a timeout) is what's under test.
    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir, agentTimeoutMs: 60000 });
    const controller = new AbortController();
    const pending = runner.run(makeCall("payload"), controller.signal, () => {});
    // Wait until the child's SIGTERM trap is definitely installed.
    while (!existsSync(readyFile)) await delay(20);
    const abortedAt = Date.now();
    controller.abort();
    await assert.rejects(() => pending, /agent aborted/);
    // Must have waited out the SIGTERM grace and escalated to SIGKILL (~2s) before settling.
    assert.ok(Date.now() - abortedAt >= 1500, "expected to wait for the SIGKILL grace before settling");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("GeminiCliAgentRunner terminates tool descendants on abort", { skip: process.platform === "win32" ? "POSIX process-group assertion" : false }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-gemini-tree-"));
  try {
    const fakeGemini = path.join(dir, "fake-gemini");
    const childPidPath = path.join(dir, "child.pid");
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(childPidPath)}, String(child.pid));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const runner = new GeminiCliAgentRunner({ command: fakeGemini, cwd: dir, agentTimeoutMs: 60000 });
    const controller = new AbortController();
    const pending = runner.run(makeCall("payload"), controller.signal, () => {});
    while (!existsSync(childPidPath)) await delay(20);
    const childPid = Number(await (await import("node:fs/promises")).readFile(childPidPath, "utf8"));

    controller.abort();
    await assert.rejects(() => pending, /agent aborted/);
    await assert.rejects(async () => process.kill(childPid, 0), /ESRCH/);
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
