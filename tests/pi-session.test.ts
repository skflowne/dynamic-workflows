import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkPiAgent, parsePiSession } from "../src/web/pi-session.js";
import type { RunRecord } from "../src/run-store.js";
import type { WorkflowJournalEntry } from "../src/types.js";

// A real-shape pi session file (captured from pi 0.79.1 --session-dir output).
const SESSION_ID = "019eaf6c-79c5-70e0-8b8c-a7b688facbdd";
const SESSION_JSONL = [
  JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp: "2026-06-10T02:46:22.405Z", cwd: "/private/tmp/pi-deepseek" }),
  JSON.stringify({ type: "model_change", id: "a1", parentId: null, provider: "custom", modelId: "deepseek-v4-flash" }),
  JSON.stringify({ type: "thinking_level_change", id: "a2", parentId: "a1", thinkingLevel: "off" }),
  JSON.stringify({ type: "message", id: "u1", parentId: "a2", message: { role: "user", content: [{ type: "text", text: "Reply with exactly this and nothing else: pi-ok" }] } }),
  JSON.stringify({
    type: "message",
    id: "m1",
    parentId: "u1",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "The user wants exactly pi-ok.", thinkingSignature: "reasoning_content" },
        { type: "toolCall", toolCallId: "call_1", toolName: "bash", args: { command: "echo hi" } },
        { type: "text", text: "pi-ok" },
      ],
      usage: { input: 455, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 505, cost: { total: 0 } },
      stopReason: "stop",
    },
  }),
  JSON.stringify({ type: "message", id: "t1", parentId: "m1", message: { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "hi" }], isError: false } }),
].join("\n");

test("parsePiSession maps pi records to the viewer's timeline shape", () => {
  const parsed = parsePiSession(SESSION_JSONL);

  assert.equal(parsed.meta.id, SESSION_ID);
  assert.equal(parsed.meta.model, "deepseek-v4-flash");
  assert.equal(parsed.meta.modelProvider, "custom");
  assert.equal(parsed.meta.effort, "off");
  assert.equal(parsed.meta.cwd, "/private/tmp/pi-deepseek");

  const kinds = parsed.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["message", "reasoning", "function_call", "message", "function_call_output"]);

  const [userMsg, reasoning, call, answer, toolOut] = parsed.items;
  assert.ok(userMsg && userMsg.kind === "message" && userMsg.role === "user");
  assert.ok(reasoning && reasoning.kind === "reasoning" && reasoning.summary.includes("pi-ok"));
  assert.ok(call && call.kind === "function_call" && call.name === "bash" && call.callId === "call_1");
  assert.ok(answer && answer.kind === "message" && answer.role === "assistant" && answer.text === "pi-ok");
  assert.ok(toolOut && toolOut.kind === "function_call_output" && toolOut.output.includes("hi"));

  assert.equal(parsed.usage?.inputTokens, 455);
  assert.equal(parsed.usage?.outputTokens, 50);
  assert.equal(parsed.usage?.totalTokens, 505);
});

test("linkPiAgent resolves an agent to its session file by exact sessionId in the filename", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-link-"));
  try {
    const sessionsDir = path.join(dir, "sessions");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, `2026-06-10T02-46-22-405Z_${SESSION_ID}.jsonl`);
    await writeFile(file, SESSION_JSONL, "utf8");

    const record: RunRecord = { runId: "wf_x", name: "x", status: "completed", source: "scriptPath", startedAt: Date.now() - 1000, completedAt: Date.now() };
    const entry: WorkflowJournalEntry = { key: "k", runId: "wf_x", backend: "pi", prompt: "Reply with exactly this and nothing else: pi-ok", options: {}, result: "pi-ok", createdAt: Date.now(), sessionId: SESSION_ID };

    const link = await linkPiAgent(record, entry, { sessionsDir });
    assert.ok(link, "expected a link");
    assert.equal(link?.sessionPath, file);
    assert.equal(link?.sessionId, SESSION_ID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("linkPiAgent falls back to a prompt-content match within the run window when no sessionId is recorded", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-pi-link2-"));
  try {
    const sessionsDir = path.join(dir, "sessions");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(sessionsDir, { recursive: true });
    const file = path.join(sessionsDir, `2026-06-10T02-46-22-405Z_${SESSION_ID}.jsonl`);
    await writeFile(file, SESSION_JSONL, "utf8");

    const now = Date.now();
    const record: RunRecord = { runId: "wf_x", name: "x", status: "completed", source: "scriptPath", startedAt: now - 1000, completedAt: now };
    const entry: WorkflowJournalEntry = { key: "k", runId: "wf_x", backend: "pi", prompt: "Reply with exactly this and nothing else: pi-ok", options: {}, result: "pi-ok", createdAt: now };

    const link = await linkPiAgent(record, entry, { sessionsDir, now });
    assert.ok(link, "expected a fallback link by prompt content");
    assert.equal(link?.sessionId, SESSION_ID);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
