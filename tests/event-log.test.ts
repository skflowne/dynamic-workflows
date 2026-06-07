import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunEventLog, runEventsPath } from "../src/web/event-log.js";

test("runEventsPath pairs the events file with the record by basename", () => {
  const p = runEventsPath("/data", "wf_abc");
  assert.equal(p, path.join("/data", "runs", "wf_abc.events.jsonl"));
});

test("RunEventLog appends JSONL lines, then close + remove deletes the file", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cw-evt-"));
  try {
    const filePath = runEventsPath(dataDir, "wf_evt");
    const log = new RunEventLog(filePath);
    await log.open();
    log.append({ runId: "wf_evt", type: "run-meta", record: { name: "demo" } });
    log.append({ runId: "wf_evt", type: "progress", event: { type: "log", message: "hello" } });
    log.append({ runId: "wf_evt", type: "run-finished", status: "completed" });
    await log.close();

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]!).type, "run-meta");
    assert.equal(JSON.parse(lines[1]!).event.message, "hello");
    assert.equal(JSON.parse(lines[2]!).status, "completed");

    await log.remove();
    await assert.rejects(stat(filePath), /ENOENT/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("RunEventLog is best-effort: append before open and remove of a missing file are no-ops", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cw-evt-"));
  try {
    const log = new RunEventLog(runEventsPath(dataDir, "wf_noop"));
    // Never opened — append must not throw and writes nothing.
    log.append({ runId: "wf_noop", type: "progress", event: { type: "log", message: "x" } });
    await log.remove(); // file never created — must not throw
    assert.ok(true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
