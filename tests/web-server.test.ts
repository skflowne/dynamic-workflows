import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWebServer } from "../src/web/server.js";
import { RunEventLog, runEventsPath } from "../src/web/event-log.js";
import type { RunRecord } from "../src/run-store.js";
import type { WorkflowJournalEntry } from "../src/types.js";

const MARKER = "subagent spawned by a deterministic workflow orchestration script";
const START = 1780795940000;

function dayDir(base: string, ts: number): string {
  const d = new Date(ts);
  return path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
}

async function get(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : undefined };
}

test("web server exposes runs, run view, agent detail, and the linked Codex session", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-web-"));
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "cw-web-sessions-"));
  const server = createWebServer({ cwd, version: "9.9.9", sessionsDir });
  let port = 0;
  try {
    const runId = "wf_web";
    const record: RunRecord = {
      runId,
      name: "web demo",
      description: "a demo run",
      status: "completed",
      source: "named",
      startedAt: START,
      completedAt: START + 30000,
      durationMs: 30000,
      agentCount: 1,
      cacheHits: 0,
      phases: ["Verify"],
      logs: ["did a thing"],
    };
    await mkdir(path.join(cwd, ".codex-workflow", "runs"), { recursive: true });
    await writeFile(path.join(cwd, ".codex-workflow", "runs", `${runId}.json`), JSON.stringify(record), "utf8");

    const prompt = "VERIFY-CLAIM-UNIQUE-12345";
    const entry: WorkflowJournalEntry = {
      key: "deadbeef",
      runId,
      prompt,
      options: { label: "v0:claim", phase: "Verify", schema: { type: "object" } },
      result: { refuted: false, evidence: "supported" },
      createdAt: START + 5000,
    };
    await mkdir(path.join(cwd, ".codex-workflow", "journal", runId), { recursive: true });
    await writeFile(path.join(cwd, ".codex-workflow", "journal", runId, "deadbeef.json"), JSON.stringify(entry), "utf8");

    // A matching Codex rollout in the time window.
    const rollout = [
      { type: "session_meta", payload: { id: "sess-web", originator: "codex_sdk_ts", cwd } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${MARKER}\n\n${prompt}` }] } },
      { type: "response_item", payload: { type: "web_search_call", status: "completed", action: { query: "veeva" } } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "{\"refuted\":false}" }] } },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n");
    const sdir = dayDir(sessionsDir, START + 1000);
    await mkdir(sdir, { recursive: true });
    const rolloutPath = path.join(sdir, "rollout-web.jsonl");
    await writeFile(rolloutPath, rollout, "utf8");
    await utimes(rolloutPath, new Date(START + 1000), new Date(START + 1000));

    const bound = await server.listen(0);
    port = bound.port;
    const base = bound.url;

    const health = await get(`${base}/api/health`);
    assert.equal(health.json.version, "9.9.9");

    const runs = await get(`${base}/api/runs`);
    assert.equal(runs.json.length, 1);
    assert.equal(runs.json[0].runId, runId);

    const detail = await get(`${base}/api/runs/${runId}`);
    assert.equal(detail.json.record.name, "web demo");
    assert.deepEqual(detail.json.view.phases.map((p: any) => p.title), ["Verify"]);
    assert.equal(detail.json.view.agents[0].status, "confirmed");

    const agent = await get(`${base}/api/runs/${runId}/agents/deadbeef`);
    assert.equal(agent.json.prompt, prompt);
    assert.equal(agent.json.options.label, "v0:claim");

    const session = await get(`${base}/api/runs/${runId}/agents/deadbeef/session`);
    assert.equal(session.status, 200);
    assert.equal(session.json.meta.id, "sess-web");
    assert.ok(session.json.items.some((i: any) => i.kind === "web_search" && i.query === "veeva"));

    const missing = await get(`${base}/api/runs/${runId}/agents/nope`);
    assert.equal(missing.status, 404);
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(sessionsDir, { recursive: true, force: true });
  }
});

test("web server aggregates agent token usage grouped by actual session model", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-web-tokens-"));
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "cw-web-token-sessions-"));
  const server = createWebServer({ cwd, version: "9.9.9", sessionsDir });
  try {
    const runId = "wf_tokens";
    const record: RunRecord = {
      runId,
      name: "token demo",
      status: "completed",
      source: "named",
      startedAt: START,
      completedAt: START + 30000,
      durationMs: 30000,
      agentCount: 3,
      cacheHits: 0,
      phases: ["Verify"],
    };
    await mkdir(path.join(cwd, ".codex-workflow", "runs"), { recursive: true });
    await writeFile(path.join(cwd, ".codex-workflow", "runs", `${runId}.json`), JSON.stringify(record), "utf8");

    const entries: WorkflowJournalEntry[] = [
      {
        key: "agent-a",
        runId,
        prompt: "prompt a",
        options: { label: "a", phase: "Verify", model: "workflow-hardcoded" },
        result: "a",
        createdAt: START + 1000,
        sessionId: "sess-a",
      },
      {
        key: "agent-b",
        runId,
        prompt: "prompt b",
        options: { label: "b", phase: "Verify", model: "gpt-5.4" },
        result: "b",
        createdAt: START + 2000,
        sessionId: "sess-b",
      },
      {
        key: "agent-c",
        runId,
        prompt: "prompt c",
        options: { label: "c", phase: "Verify", model: "gpt-5.4" },
        result: "c",
        createdAt: START + 3000,
      },
    ];
    const journalDir = path.join(cwd, ".codex-workflow", "journal", runId);
    await mkdir(journalDir, { recursive: true });
    for (const entry of entries) {
      await writeFile(path.join(journalDir, `${entry.key}.json`), JSON.stringify(entry), "utf8");
    }

    const sdir = dayDir(sessionsDir, START + 1000);
    await mkdir(sdir, { recursive: true });
    const rollout = (sessionId: string, model: string, input: number, output: number, reasoning: number, total: number) =>
      [
        { type: "session_meta", payload: { id: sessionId, originator: "codex_sdk_ts", cwd, model_provider: "openai" } },
        { type: "turn_context", payload: { model } },
        {
          type: "event_msg",
          payload: {
            type: "token_count",
            info: { total_token_usage: { input_tokens: input, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: total } },
          },
        },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n");
    await writeFile(path.join(sdir, "rollout-sess-a.jsonl"), rollout("sess-a", "gpt-5.5", 100, 20, 5, 125), "utf8");
    await writeFile(path.join(sdir, "rollout-sess-b.jsonl"), rollout("sess-b", "gpt-5.4", 50, 10, 2, 62), "utf8");

    const bound = await server.listen(0);
    const tokens = await get(`${bound.url}/api/runs/${runId}/tokens`);

    assert.equal(tokens.status, 200);
    assert.equal(tokens.json.agentCount, 3);
    assert.equal(tokens.json.withUsage, 2);
    assert.equal(tokens.json.pendingCount, 1);
    assert.equal(tokens.json.totals.inputTokens, 150);
    assert.equal(tokens.json.totals.outputTokens, 30);
    assert.equal(tokens.json.totals.reasoningOutputTokens, 7);
    assert.equal(tokens.json.totals.totalTokens, 187);

    const byModel = new Map<string, any>(tokens.json.groups.map((group: any) => [`${group.backend}:${group.model}`, group]));
    const gpt55 = byModel.get("codex:gpt-5.5");
    const gpt54 = byModel.get("codex:gpt-5.4");
    assert.equal(gpt55.usage.totalTokens, 125);
    assert.equal(gpt55.provider, "openai");
    assert.equal(gpt54.usage.totalTokens, 62);
    assert.equal(gpt54.agentCount, 2);
    assert.equal(gpt54.pendingCount, 1);
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(sessionsDir, { recursive: true, force: true });
  }
});

test("broadcast pushes live progress events to SSE subscribers (in-process path)", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-web-sse-"));
  const server = createWebServer({ cwd, version: "9.9.9" });
  const ac = new AbortController();
  try {
    const runId = "wf_sse";
    // A run record so the /events replay endpoint resolves (it 404s on unknown runs).
    const record: RunRecord = { runId, name: "sse", status: "running", source: "scriptPath", startedAt: START };
    await mkdir(path.join(cwd, ".codex-workflow", "runs"), { recursive: true });
    await writeFile(path.join(cwd, ".codex-workflow", "runs", `${runId}.json`), JSON.stringify(record), "utf8");

    const bound = await server.listen(0);
    // Open the SSE stream; once the fetch resolves the subscriber is registered server-side.
    const res = await fetch(`${bound.url}/api/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    server.broadcast({ runId, type: "progress", event: { kind: "log", message: "hello-sse" } });

    let buf = "";
    let received: any;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const start = buf.indexOf("data: ");
      const end = start >= 0 ? buf.indexOf("\n\n", start) : -1;
      if (start >= 0 && end > start) {
        received = JSON.parse(buf.slice(start + 6, end));
        break;
      }
    }

    assert.ok(received, "expected an SSE data event");
    assert.equal(received.runId, runId);
    assert.equal(received.event.message, "hello-sse");

    // The same event is buffered for late subscribers (replay).
    const events = await get(`${bound.url}/api/runs/${runId}/events`);
    assert.equal(events.json.length, 1);
    assert.equal(events.json[0].event.message, "hello-sse");
  } finally {
    ac.abort();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("web server exposes live running agent detail before journal entry exists", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-web-live-agent-"));
  const geminiSessionsDir = await mkdtemp(path.join(tmpdir(), "cw-web-gemini-sessions-"));
  const server = createWebServer({ cwd, version: "9.9.9", geminiSessionsDir });
  try {
    const runId = "wf_live_agent";
    const record: RunRecord = {
      runId,
      name: "live agent",
      status: "running",
      source: "scriptPath",
      startedAt: START,
      declaredPhases: ["Scope"],
    };
    await mkdir(path.join(cwd, ".codex-workflow", "runs"), { recursive: true });
    await writeFile(path.join(cwd, ".codex-workflow", "runs", `${runId}.json`), JSON.stringify(record), "utf8");

    const geminiDir = path.join(geminiSessionsDir, "project", "chats");
    await mkdir(geminiDir, { recursive: true });
    const geminiPath = path.join(geminiDir, "session-2026-06-08T00-00-gemini.jsonl");
    const geminiSession = [
      { sessionId: "gemini-live-session", projectHash: "p", startTime: "2026-06-08T00:00:00Z", kind: "main" },
      { id: "u1", timestamp: "2026-06-08T00:00:01Z", type: "user", content: [{ text: "read me while running" }] },
      { id: "g1", timestamp: "2026-06-08T00:00:02Z", type: "gemini", content: "live trace", model: "gemini-test" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n");
    await writeFile(geminiPath, geminiSession, "utf8");
    await utimes(geminiPath, new Date(START + 1000), new Date(START + 1000));

    const bound = await server.listen(0);
    server.broadcast({
      runId,
      type: "progress",
      event: {
        type: "agent",
        state: "started",
        key: "live-key",
        index: 1,
        label: "scope",
        phase: "Scope",
        backend: "gemini",
        prompt: "read me while running",
        options: { label: "scope", phase: "Scope", model: "gemini-test" },
        sessionId: "gemini-live-session",
      },
    });

    const detail = await get(`${bound.url}/api/runs/${runId}`);
    assert.equal(detail.json.live.length, 1);

    const agent = await get(`${bound.url}/api/runs/${runId}/agents/live-key`);
    assert.equal(agent.status, 200);
    assert.equal(agent.json.prompt, "read me while running");
    assert.equal(agent.json.options.model, "gemini-test");
    assert.equal(agent.json.backend, "gemini");
    assert.equal(agent.json.sessionId, "gemini-live-session");
    assert.equal(agent.json.result, undefined);

    const session = await get(`${bound.url}/api/runs/${runId}/agents/live-key/session`);
    assert.equal(session.status, 200);
    assert.equal(session.json.meta.id, "gemini-live-session");
    assert.equal(session.json.meta.modelProvider, "gemini");
    assert.ok(session.json.items.some((item: any) => item.kind === "message" && item.role === "assistant" && item.text === "live trace"));
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(geminiSessionsDir, { recursive: true, force: true });
  }
});

test("server tails a run's events file: initial scan, fs.watch, and drainRun", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-tail-"));
  const dataDir = path.join(cwd, ".codex-workflow");
  const server = createWebServer({ cwd, version: "9.9.9" });
  try {
    const runId = "wf_tail";
    const runsDirPath = path.join(dataDir, "runs");
    await mkdir(runsDirPath, { recursive: true });
    const record: RunRecord = { runId, name: "tail", status: "running", source: "scriptPath", startedAt: START };
    await writeFile(path.join(runsDirPath, `${runId}.json`), JSON.stringify(record), "utf8");

    // One event present BEFORE the server starts — the initial scan in listen() must ingest it.
    const eventsPath = runEventsPath(dataDir, runId);
    const line = (event: object) => `${JSON.stringify(event)}\n`;
    await writeFile(eventsPath, line({ runId, type: "progress", event: { type: "log", message: "before" } }), "utf8");

    const bound = await server.listen(0);
    const base = bound.url;

    const detail = await get(`${base}/api/runs/${runId}`);
    assert.equal(detail.json.live.length, 1, "initial scan should ingest the pre-existing event");
    assert.equal(detail.json.live[0].event.message, "before");

    // Append while running — fs.watch should tail it (poll the replay buffer with a deadline).
    await appendFile(eventsPath, line({ runId, type: "progress", event: { type: "log", message: "during" } }), "utf8");
    const deadline = Date.now() + 3000;
    let events: any[] = [];
    while (Date.now() < deadline) {
      events = (await get(`${base}/api/runs/${runId}/events`)).json;
      if (events.length >= 2) break;
    }
    assert.equal(events.length, 2, "fs.watch should have tailed the appended line");
    assert.equal(events[1].event.message, "during");

    // drainRun ingests a freshly-appended line deterministically, without depending on fs.watch.
    await appendFile(eventsPath, line({ runId, type: "run-finished", status: "completed" }), "utf8");
    await server.drainRun(runId);
    events = (await get(`${base}/api/runs/${runId}/events`)).json;
    assert.equal(events.length, 3);
    assert.equal(events[2].type, "run-finished");
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("web server overlays live resume state without overwriting the stored terminal record", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-live-overlay-"));
  const dataDir = path.join(cwd, ".codex-workflow");
  const server = createWebServer({ cwd, version: "9.9.9" });
  try {
    const runId = "wf_overlay";
    const runsDirPath = path.join(dataDir, "runs");
    await mkdir(runsDirPath, { recursive: true });
    const stored: RunRecord = {
      runId,
      name: "overlay",
      status: "completed",
      source: "scriptPath",
      startedAt: START,
      completedAt: START + 1000,
      result: { value: "old" },
    };
    await writeFile(path.join(runsDirPath, `${runId}.json`), JSON.stringify(stored), "utf8");

    const eventsPath = runEventsPath(dataDir, runId);
    const liveRecord: RunRecord = {
      runId,
      name: "overlay",
      status: "running",
      source: "scriptPath",
      startedAt: START + 2000,
    };
    await writeFile(eventsPath, `${JSON.stringify({ runId, type: "run-meta", record: liveRecord })}\n`, "utf8");

    const bound = await server.listen(0);
    let detail = await get(`${bound.url}/api/runs/${runId}`);
    assert.equal(detail.json.record.status, "running");
    assert.equal(detail.json.record.result, undefined);

    await appendFile(eventsPath, `${JSON.stringify({ runId, type: "run-finished", status: "failed", error: "boom" })}\n`);
    await server.drainRun(runId);
    detail = await get(`${bound.url}/api/runs/${runId}`);
    assert.equal(detail.json.record.status, "completed");
    assert.deepEqual(detail.json.record.result, { value: "old" });
  } finally {
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Regression guard for the in-process viewer: the producer (RunEventLog) and the server live in the
// SAME process, exactly as `run` does. A held-open append stream's writes don't fire fs.watch on
// macOS, which silently broke live updates — so this drives events through the REAL producer API
// (not appendFile) and asserts the same-process server still tails them live.
test("in-process: server tails events written through the real RunEventLog", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cw-inproc-"));
  const dataDir = path.join(cwd, ".codex-workflow");
  const server = createWebServer({ cwd, version: "9.9.9" });
  const runId = "wf_inproc";
  const log = new RunEventLog(runEventsPath(dataDir, runId));
  try {
    const runsDirPath = path.join(dataDir, "runs");
    await mkdir(runsDirPath, { recursive: true });
    const record: RunRecord = { runId, name: "inproc", status: "running", source: "scriptPath", startedAt: START };
    await writeFile(path.join(runsDirPath, `${runId}.json`), JSON.stringify(record), "utf8");

    await log.open();
    log.append({ runId, type: "run-meta", record });
    const bound = await server.listen(0);

    // Emit progress through the producer API only — no manual file writes.
    log.append({ runId, type: "progress", event: { type: "agent", key: "a1", label: "scope", phase: "Scope", state: "started" } });
    log.append({ runId, type: "progress", event: { type: "log", message: "hello-inproc" } });

    const deadline = Date.now() + 4000;
    let events: any[] = [];
    while (Date.now() < deadline) {
      events = (await get(`${bound.url}/api/runs/${runId}/events`)).json;
      if (events.length >= 3) break;
    }
    assert.equal(events.length, 3, "same-process server must tail RunEventLog appends (watch or poll)");
    assert.equal(events[2].event.message, "hello-inproc");
  } finally {
    await log.close();
    await log.remove();
    await server.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
