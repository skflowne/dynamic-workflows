import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkRun } from "../src/web/session-linker.js";
import type { RunRecord } from "../src/run-store.js";
import type { WorkflowJournalEntry } from "../src/types.js";

const MARKER = "subagent spawned by a deterministic workflow orchestration script";

function dayDir(base: string, ts: number): string {
  const d = new Date(ts);
  return path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
}

function rollout(sessionId: string, promptBody: string): string {
  return [
    { type: "session_meta", payload: { id: sessionId, originator: "codex_sdk_ts", cwd: "/tmp" } },
    {
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: `${MARKER}\n\n${promptBody}` }] },
    },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] } },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
}

async function writeRollout(sessionsDir: string, ts: number, file: string, content: string): Promise<string> {
  const dir = dayDir(sessionsDir, ts);
  await mkdir(dir, { recursive: true });
  const full = path.join(dir, file);
  await writeFile(full, content, "utf8");
  await utimes(full, new Date(ts), new Date(ts));
  return full;
}

const START = 1780795940000;
const RECORD: RunRecord = { runId: "wf_link", name: "demo", status: "completed", source: "named", startedAt: START, completedAt: START + 60000 };

test("linkRun matches by content when no sessionId is stored (historical runs)", async () => {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "cw-sessions-"));
  try {
    await writeRollout(sessionsDir, START + 1000, "rollout-A.jsonl", rollout("uuid-A", "UNIQUE-PROMPT-ALPHA verify this claim"));
    await writeRollout(sessionsDir, START + 2000, "rollout-B.jsonl", rollout("uuid-B", "UNIQUE-PROMPT-BETA fetch this source"));
    // Decoy outside the time window must be ignored.
    await writeRollout(sessionsDir, START + 999999, "rollout-OLD.jsonl", rollout("uuid-OLD", "UNIQUE-PROMPT-ALPHA verify this claim"));

    const entries: WorkflowJournalEntry[] = [
      { key: "a", runId: "wf_link", prompt: "UNIQUE-PROMPT-ALPHA verify this claim", options: {}, result: {}, createdAt: 0 },
      { key: "b", runId: "wf_link", prompt: "UNIQUE-PROMPT-BETA fetch this source", options: {}, result: {}, createdAt: 0 },
    ];

    const links = await linkRun(RECORD, entries, { sessionsDir });
    const a = links.a;
    const b = links.b;
    assert.ok(a && b);
    assert.equal(path.basename(a.sessionPath), "rollout-A.jsonl");
    assert.equal(a.sessionId, "uuid-A");
    assert.equal(path.basename(b.sessionPath), "rollout-B.jsonl");
  } finally {
    await rm(sessionsDir, { recursive: true, force: true });
  }
});

test("linkRun uses the stored sessionId exactly when present", async () => {
  const sessionsDir = await mkdtemp(path.join(tmpdir(), "cw-sessions-"));
  try {
    await writeRollout(sessionsDir, START + 1000, "rollout-2026-sess-EXACT.jsonl", rollout("sess-EXACT", "anything"));
    await writeRollout(sessionsDir, START + 2000, "rollout-2026-sess-OTHER.jsonl", rollout("sess-OTHER", "anything"));

    const entries: WorkflowJournalEntry[] = [
      { key: "x", runId: "wf_link", prompt: "anything", options: {}, result: {}, createdAt: 0, sessionId: "sess-EXACT" },
    ];
    const links = await linkRun(RECORD, entries, { sessionsDir });
    const x = links.x;
    assert.ok(x);
    assert.equal(x.sessionId, "sess-EXACT");
    assert.equal(path.basename(x.sessionPath), "rollout-2026-sess-EXACT.jsonl");
  } finally {
    await rm(sessionsDir, { recursive: true, force: true });
  }
});
