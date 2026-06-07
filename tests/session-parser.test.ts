import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexSession } from "../src/web/session-parser.js";

const ROLLOUT = [
  {
    type: "session_meta",
    timestamp: "2026-06-07T01:32:45Z",
    payload: {
      id: "abc-123",
      timestamp: "2026-06-07T01:32:44Z",
      cwd: "/tmp/x",
      originator: "codex_sdk_ts",
      cli_version: "0.137.0",
      model_provider: "openai",
    },
  },
  { type: "event_msg", payload: { type: "task_started" } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello prompt" }] } },
  { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking about it" }] } },
  { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "OPAQUE" } },
  {
    type: "response_item",
    payload: { type: "web_search_call", status: "completed", action: { type: "search", query: "q1", queries: ["q1", "q2"] } },
  },
  { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}', call_id: "c1" } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "file.txt" } },
  { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the answer" }] } },
  {
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 100, output_tokens: 20, reasoning_output_tokens: 8, total_tokens: 120 }, model_context_window: 258400 },
    },
  },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

test("parseCodexSession extracts meta, ordered items, and usage", () => {
  const s = parseCodexSession(ROLLOUT);

  assert.equal(s.meta.id, "abc-123");
  assert.equal(s.meta.originator, "codex_sdk_ts");
  assert.equal(s.meta.cliVersion, "0.137.0");
  assert.equal(s.meta.modelProvider, "openai");
  assert.equal(s.meta.cwd, "/tmp/x");

  // Encrypted-only reasoning (empty summary) is skipped; the meaningful one is kept.
  const kinds = s.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["message", "reasoning", "web_search", "function_call", "function_call_output", "message"]);

  const user = s.items[0];
  assert.ok(user?.kind === "message");
  assert.equal(user.role, "user");
  assert.equal(user.text, "hello prompt");

  const reasoning = s.items[1];
  assert.ok(reasoning?.kind === "reasoning");
  assert.equal(reasoning.summary, "thinking about it");

  const search = s.items[2];
  assert.ok(search?.kind === "web_search");
  assert.equal(search.query, "q1");
  assert.deepEqual(search.queries, ["q1", "q2"]);

  const call = s.items[3];
  assert.ok(call?.kind === "function_call");
  assert.equal(call.name, "exec_command");
  assert.deepEqual(call.arguments, { cmd: "ls" });
  assert.equal(call.callId, "c1");

  const output = s.items[4];
  assert.ok(output?.kind === "function_call_output");
  assert.equal(output.output, "file.txt");

  const assistant = s.items[5];
  assert.ok(assistant?.kind === "message");
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.text, "the answer");

  assert.equal(s.usage?.totalTokens, 120);
  assert.equal(s.usage?.inputTokens, 100);
  assert.equal(s.usage?.contextWindow, 258400);
});

test("parseCodexSession tolerates blank and malformed lines", () => {
  const raw = `\n  \n{"type":"session_meta","payload":{"id":"x"}}\nnot-json\n{"type":"response_item","payload":{"type":"message","role":"user","content":"plain string"}}`;
  const s = parseCodexSession(raw);
  assert.equal(s.meta.id, "x");
  assert.equal(s.items.length, 1);
  const only = s.items[0];
  assert.ok(only?.kind === "message");
  assert.equal(only.text, "plain string");
});
