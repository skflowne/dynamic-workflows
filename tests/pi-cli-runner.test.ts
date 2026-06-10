import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiCliAgentRunner, runWorkflow } from "../src/index.js";
import { parsePiEvents } from "../src/runners/pi-cli.js";
import type { WorkflowAgentCall, WorkflowAgentMeta } from "../src/index.js";

function makeCall(prompt: string, options: Partial<WorkflowAgentCall["options"]> = {}): WorkflowAgentCall {
  return { prompt, options: { label: "pi", ...options }, index: 1, runId: "wf_pi_test", cacheKey: "k" };
}

/**
 * Writes a fake `pi` that emits pi's real `--mode json` event stream (session → agent_start →
 * message_end[user] → message_end[assistant] → turn_end → agent_end). The assistant body is built
 * from `bodyExpr` (JS evaluated with `args`, `flag(name)`, `prompt`, `env` in scope) so each test can
 * assert what reached the CLI.
 */
async function writeFakePi(
  dir: string,
  opts: { bodyExpr: string; usageOutput?: number; stopReason?: string; errorMessage?: string; contentJson?: string },
): Promise<string> {
  const file = path.join(dir, "fake-pi");
  const content = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const env = process.env;
const prompt = args[args.length - 1] || "";
const text = String(${opts.bodyExpr});
const content = ${opts.contentJson ?? (opts.stopReason === "error" ? "[]" : `[{ type: "thinking", thinking: "deciding" }, { type: "text", text }]`)};
const assistant = {
  role: "assistant",
  content,
  api: "openai-completions",
  provider: flag("--provider") || "google",
  model: flag("--model") || "?",
  usage: { input: 100, output: ${opts.usageOutput ?? 7}, cacheRead: 0, cacheWrite: 0, totalTokens: ${100 + (opts.usageOutput ?? 7)}, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: ${JSON.stringify(opts.stopReason ?? "stop")},
  ${opts.errorMessage ? `errorMessage: ${JSON.stringify(opts.errorMessage)},` : ""}
  timestamp: 1,
};
const sessionId = "019eaf6c-79c5-70e0-8b8c-a7b688facbdd";
const sessionDir = flag("--session-dir");
const out = [];
out.push(JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-06-10T00:00:00.000Z", cwd: process.cwd() }));
out.push(JSON.stringify({ type: "agent_start" }));
out.push(JSON.stringify({ type: "turn_start" }));
out.push(JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: prompt }], timestamp: 1 } }));
out.push(JSON.stringify({ type: "message_end", message: assistant }));
out.push(JSON.stringify({ type: "turn_end", message: assistant, toolResults: [] }));
out.push(JSON.stringify({ type: "agent_end", messages: [assistant] }));
console.error("pi startup noise on stderr");
console.log(out.join("\\n"));
// pi exits 0 even on a model error — success/failure is decided by stopReason, not exit code.
process.exit(0);
`;
  await writeFile(file, content, "utf8");
  await chmod(file, 0o755);
  return file;
}

test("PiCliAgentRunner parses the JSON event stream, returns assistant text, reports session + tokens", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-runner-"));
  try {
    const fakePi = await writeFakePi(dir, {
      bodyExpr: `["model=" + flag("--model"), "provider=" + flag("--provider"), "json=" + has("--mode"), "noctx=" + has("--no-context-files"), "approve=" + has("--approve"), "promptHasPayload=" + prompt.includes("payload")].join(";")`,
      usageOutput: 42,
    });

    const metas: WorkflowAgentMeta[] = [];
    const runner = new PiCliAgentRunner({ command: fakePi, cwd: dir, model: "deepseek-v4-flash", provider: "deepseek", agentTimeoutMs: 5000 });
    const result = await runner.run(makeCall("payload here"), undefined, (meta) => metas.push(meta));

    assert.equal(result, "model=deepseek-v4-flash;provider=deepseek;json=true;noctx=true;approve=true;promptHasPayload=true");
    assert.ok(metas.some((m) => m.backend === "pi"));
    assert.ok(metas.some((m) => m.sessionId === "019eaf6c-79c5-70e0-8b8c-a7b688facbdd"));
    assert.ok(metas.some((m) => m.outputTokens === 42), `expected outputTokens=42, got ${JSON.stringify(metas)}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiCliAgentRunner treats a stopReason:error turn as a failure even though pi exits 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-err-"));
  try {
    const fakePi = await writeFakePi(dir, {
      bodyExpr: `""`,
      stopReason: "error",
      errorMessage: JSON.stringify({ error: { message: "Connection error.", code: 502 } }),
    });

    const runner = new PiCliAgentRunner({ command: fakePi, cwd: dir, model: "m", agentTimeoutMs: 5000 });
    await assert.rejects(() => runner.run(makeCall("x"), undefined, () => {}), /pi agent failed:.*Connection error/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiCliAgentRunner embeds the JSON schema in the prompt (no native schema flag)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-schema-"));
  try {
    const fakePi = await writeFakePi(dir, {
      bodyExpr: `JSON.stringify({ sawField: prompt.includes("magic_field_xyz"), sawSchemaHeader: prompt.includes("JSON Schema your output must satisfy") })`,
    });
    const runner = new PiCliAgentRunner({ command: fakePi, cwd: dir, model: "m" });
    const result = await runner.run(
      makeCall("extract", { schema: { type: "object", properties: { magic_field_xyz: { type: "string" } }, required: ["magic_field_xyz"] } }),
      undefined,
      () => {},
    );
    assert.match(String(result), /"sawField":true/);
    assert.match(String(result), /"sawSchemaHeader":true/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiCliAgentRunner materializes models.json for a custom base URL and injects the key via env", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-baseurl-"));
  try {
    const agentDir = path.join(dir, "home");
    // The fake reads PI_CODING_AGENT_DIR/models.json and echoes back what the runner generated.
    const fakePi = await writeFakePi(dir, {
      bodyExpr: `(() => {
        const cfg = JSON.parse(fs.readFileSync(env.PI_CODING_AGENT_DIR + "/models.json", "utf8"));
        const p = cfg.providers.custom;
        return ["provider=" + flag("--provider"), "baseUrl=" + p.baseUrl, "apiRef=" + p.apiKey, "keyEnv=" + (env.CODEX_WORKFLOW_PI_API_KEY || ""), "modelId=" + p.models[0].id].join(";");
      })()`,
    });

    const runner = new PiCliAgentRunner({
      command: fakePi,
      cwd: dir,
      agentDir,
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-secret",
      model: "deepseek-v4-flash",
    });
    const result = await runner.run(makeCall("hi"), undefined, () => {});

    assert.equal(
      result,
      "provider=custom;baseUrl=https://api.deepseek.com;apiRef=$CODEX_WORKFLOW_PI_API_KEY;keyEnv=sk-secret;modelId=deepseek-v4-flash",
    );
    // The literal key must never be written to the models.json on disk.
    const onDisk = await readFile(path.join(agentDir, "models.json"), "utf8");
    assert.doesNotMatch(onDisk, /sk-secret/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiCliAgentRunner writes a literal placeholder key for a keyless base URL (Ollama/vLLM)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-keyless-"));
  try {
    const agentDir = path.join(dir, "home");
    const fakePi = await writeFakePi(dir, {
      bodyExpr: `(() => {
        const cfg = JSON.parse(fs.readFileSync(env.PI_CODING_AGENT_DIR + "/models.json", "utf8"));
        return ["apiRef=" + cfg.providers.custom.apiKey, "keyEnvSet=" + ("CODEX_WORKFLOW_PI_API_KEY" in env)].join(";");
      })()`,
    });

    // No apiKey: the config must NOT reference the env var (pi errors on unset env refs).
    const runner = new PiCliAgentRunner({ command: fakePi, cwd: dir, agentDir, baseUrl: "http://localhost:11434/v1", model: "llama3" });
    const result = await runner.run(makeCall("hi"), undefined, () => {});
    assert.equal(result, "apiRef=dummy;keyEnvSet=false");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PiCliAgentRunner fails clearly when a schema turn ends with a text-less assistant message", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-notext-"));
  try {
    // Successful stop, but the final assistant message carries only thinking/toolCall blocks.
    const fakePi = await writeFakePi(dir, {
      bodyExpr: `""`,
      contentJson: `[{ type: "thinking", thinking: "hmm" }, { type: "toolCall", toolCallId: "c1", toolName: "bash", args: {} }]`,
    });

    const runner = new PiCliAgentRunner({ command: fakePi, cwd: dir, model: "m" });
    const schemaCall = makeCall("extract", { schema: { type: "object", properties: {}, required: [] } });
    await assert.rejects(() => runner.run(schemaCall, undefined, () => {}), /no text content/);

    // Without a schema the empty string is a legitimate result and must pass through.
    const plain = await runner.run(makeCall("just do it"), undefined, () => {});
    assert.equal(plain, "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parsePiEvents sums output tokens across multiple assistant turns and returns the last answer", () => {
  const stream = [
    JSON.stringify({ type: "session", id: "sess-1" }),
    JSON.stringify({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "q" }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", toolName: "bash", args: { command: "ls" } }], usage: { output: 5 }, stopReason: "tool_use" } }),
    JSON.stringify({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "file.txt" }] } }),
    JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "final answer" }], usage: { output: 8 }, stopReason: "stop" } }),
  ].join("\n");

  const parsed = parsePiEvents(stream);
  assert.equal(parsed.response, "final answer");
  assert.equal(parsed.sessionId, "sess-1");
  assert.equal(parsed.outputTokens, 13); // 5 + 8 across both assistant turns
  assert.equal(parsed.error, undefined);
});

test(
  "PiCliAgentRunner executes a live pi agent turn",
  { skip: process.env.RUN_PI_CLI_LIVE === "1" ? false : "Set RUN_PI_CLI_LIVE=1 (and provide credentials) to run the live pi test." },
  async () => {
    const result = await runWorkflow(
      `export const meta = { name: 'pi_live', description: 'Live pi smoke test' }
return agent('Reply with exactly this and nothing else: pi-workflow-live-ok', { label: 'echo' })
`,
      {
        runner: new PiCliAgentRunner({
          cwd: process.cwd(),
          ...(process.env.PI_CLI_MODEL ? { model: process.env.PI_CLI_MODEL } : {}),
          ...(process.env.PI_CLI_PROVIDER ? { provider: process.env.PI_CLI_PROVIDER } : {}),
          ...(process.env.PI_CLI_BASE_URL ? { baseUrl: process.env.PI_CLI_BASE_URL, agentDir: path.join(tmpdir(), "pi-live-home") } : {}),
          ...(process.env.PI_CLI_API_KEY ? { apiKey: process.env.PI_CLI_API_KEY } : {}),
          noTools: true,
          agentTimeoutMs: 120000,
        }),
      },
    );
    assert.equal(String(result.result).trim(), "pi-workflow-live-ok");
  },
);
