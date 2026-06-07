import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWebServer } from "../src/web/server.js";
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
