import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { linkGeminiAgent } from "../src/web/gemini-session.js";
import { linkRun } from "../src/web/session-linker.js";
import type { RunRecord } from "../src/run-store.js";
import type { WorkflowJournalEntry } from "../src/types.js";

// A resume reuses the runId but resets record.startedAt to "now", so a cached agent's session file —
// written during the ORIGINAL run — has an mtime (and, for Codex, a date dir) outside this run's
// window. The recorded sessionId is an exact anchor and must link regardless of the window.

function resumeRecord(now: number): RunRecord {
  return { runId: "wf_resume", name: "x", status: "completed", source: "scriptPath", startedAt: now, completedAt: now };
}

test("linkGeminiAgent links by sessionId across resume (file mtime outside the window)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-link-gemini-"));
  try {
    const sessionsDir = path.join(dir, "gtmp");
    const chats = path.join(sessionsDir, "proj", "chats");
    await mkdir(chats, { recursive: true });
    const sessionId = "abcd1234-aaaa-bbbb-cccc-000000000000";
    const file = path.join(chats, `session-2026-01-01T00-00-${sessionId.split("-")[0]}.jsonl`);
    await writeFile(file, `${JSON.stringify({ sessionId, startTime: "2026-01-01T00:00:00Z", kind: "main" })}\n`, "utf8");
    const past = new Date(1000); // far before the resume window
    await utimes(file, past, past);

    const now = Date.now();
    const entry: WorkflowJournalEntry = {
      key: "k", runId: "wf_resume", backend: "gemini", sessionId, prompt: "p", options: {}, result: null, createdAt: 0,
    };
    const link = await linkGeminiAgent(resumeRecord(now), entry, { sessionsDir, now });
    assert.ok(link, "should link by sessionId despite mtime outside the window");
    assert.equal(link?.sessionPath, file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("linkRun links a Codex agent by sessionId across resume (rollout in a different date dir)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-link-codex-"));
  try {
    const sessionsDir = path.join(dir, "sessions");
    const dayDir = path.join(sessionsDir, "2026", "01", "01"); // the ORIGINAL run's date, not "now"
    await mkdir(dayDir, { recursive: true });
    const sessionId = "11111111-2222-3333-4444-555555555555";
    const file = path.join(dayDir, `rollout-2026-01-01T00-00-00-${sessionId}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId } })}\n`, "utf8");
    const past = new Date(1000);
    await utimes(file, past, past);

    const now = Date.now();
    const entry: WorkflowJournalEntry = {
      key: "k", runId: "wf_resume", sessionId, prompt: "p", options: {}, result: null, createdAt: 0,
    };
    const links = await linkRun(resumeRecord(now), [entry], { sessionsDir, now });
    assert.equal(links["k"]?.sessionPath, file);
    assert.equal(links["k"]?.sessionId, sessionId);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
