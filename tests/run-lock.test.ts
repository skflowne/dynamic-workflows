import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireRunLock } from "../src/run-lock.js";

test("run lock rejects concurrent acquisition for the same run id and releases cleanly", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cw-run-lock-"));
  try {
    const first = await acquireRunLock(dir, "wf_lock");
    await assert.rejects(() => acquireRunLock(dir, "wf_lock"), /already running or resuming/);

    await first.release();
    const second = await acquireRunLock(dir, "wf_lock");
    await second.release();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
