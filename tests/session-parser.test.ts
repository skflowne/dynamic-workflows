import assert from "node:assert/strict";
import test from "node:test";
import { parseGeminiSession } from "../src/web/gemini-session.js";
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
  { type: "turn_context", payload: { model: "gpt-5.5", effort: "xhigh", summary: "auto" } },
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
  // model + reasoning effort come from turn_context
  assert.equal(s.meta.model, "gpt-5.5");
  assert.equal(s.meta.effort, "xhigh");

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

test("parseCodexSession surfaces custom/tool-search items and unknown types instead of dropping them", () => {
  const raw = [
    { type: "response_item", payload: { type: "custom_tool_call", call_id: "c9", name: "apply_patch", input: "*** Begin Patch" } },
    { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "c9", output: "ok" } },
    { type: "response_item", payload: { type: "tool_search_call", call_id: "t1", arguments: { query: "spawn" } } },
    { type: "response_item", payload: { type: "tool_search_output", call_id: "t1", tools: [{ name: "spawn_agent" }] } },
    { type: "response_item", payload: { type: "image_thing", note: "brand new type" } },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n");
  const s = parseCodexSession(raw);

  assert.deepEqual(
    s.items.map((i) => i.kind),
    ["function_call", "function_call_output", "function_call", "function_call_output", "other"],
  );

  // custom_tool_call keeps its name and maps `input` → arguments (a raw apply_patch body, not JSON)
  const apply = s.items[0];
  assert.ok(apply?.kind === "function_call");
  assert.equal(apply.name, "apply_patch");
  assert.equal(apply.arguments, "*** Begin Patch");

  // tool_search_call has no `name` → falls back to the item type; its output stringifies `tools`
  const search = s.items[2];
  assert.ok(search?.kind === "function_call");
  assert.equal(search.name, "tool_search_call");
  const searchOut = s.items[3];
  assert.ok(searchOut?.kind === "function_call_output");
  assert.match(searchOut.output, /spawn_agent/);

  // a genuinely unrecognized type is preserved as `other` with its raw payload, never dropped
  const other = s.items[4];
  assert.ok(other?.kind === "other");
  assert.equal(other.itemType, "image_thing");
  assert.match(other.raw, /brand new type/);
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

test("parseGeminiSession extracts JSONL meta, messages, thoughts, tool calls, and usage", () => {
  const raw = [
    { sessionId: "gem-sess", projectHash: "p", startTime: "2026-06-08T00:00:00Z", kind: "main" },
    { id: "u1", timestamp: "2026-06-08T00:00:01Z", type: "user", content: [{ text: "hello gemini" }] },
    {
      id: "g1",
      timestamp: "2026-06-08T00:00:02Z",
      type: "gemini",
      content: "",
      thoughts: [{ subject: "Plan", description: "think" }],
      tokens: { input: 10, output: 2, cached: 1, thoughts: 3, total: 16 },
      model: "gemini-test",
    },
    { $set: { lastUpdated: "2026-06-08T00:00:03Z" } },
    {
      id: "g1",
      timestamp: "2026-06-08T00:00:02Z",
      type: "gemini",
      content: "answer",
      thoughts: [{ subject: "Plan", description: "think" }],
      tokens: { input: 10, output: 2, cached: 1, thoughts: 3, total: 16 },
      model: "gemini-test",
      toolCalls: [{ id: "t1", name: "read_file", args: { file_path: "x" }, resultDisplay: "file contents" }],
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");

  const s = parseGeminiSession(raw);

  assert.equal(s.meta.id, "gem-sess");
  assert.equal(s.meta.timestamp, "2026-06-08T00:00:00Z");
  assert.equal(s.meta.modelProvider, "gemini");
  assert.equal(s.meta.model, "gemini-test");

  const kinds = s.items.map((i) => i.kind);
  assert.deepEqual(kinds, ["message", "reasoning", "message", "function_call", "function_call_output"]);

  const call = s.items[3];
  assert.ok(call?.kind === "function_call");
  assert.equal(call.name, "read_file");
  assert.deepEqual(call.arguments, { file_path: "x" });

  const output = s.items[4];
  assert.ok(output?.kind === "function_call_output");
  assert.equal(output.output, "file contents");

  assert.equal(s.usage?.inputTokens, 10);
  assert.equal(s.usage?.cachedInputTokens, 1);
  assert.equal(s.usage?.reasoningOutputTokens, 3);
  assert.equal(s.usage?.totalTokens, 16);
});

test("parseGeminiSession extracts pretty JSON session files with messages", () => {
  const raw = JSON.stringify(
    {
      sessionId: "pretty-gem",
      startTime: "2026-06-08T01:00:00Z",
      messages: [
        { id: "u1", timestamp: "2026-06-08T01:00:01Z", type: "user", content: [{ text: "pretty prompt" }] },
        { id: "g1", timestamp: "2026-06-08T01:00:02Z", type: "gemini", content: "pretty answer", model: "gemini-pretty" },
      ],
    },
    null,
    2,
  );

  const s = parseGeminiSession(raw);

  assert.equal(s.meta.id, "pretty-gem");
  assert.equal(s.meta.model, "gemini-pretty");
  assert.deepEqual(
    s.items.map((item) => (item.kind === "message" ? `${item.role}:${item.text}` : item.kind)),
    ["user:pretty prompt", "assistant:pretty answer"],
  );
});
