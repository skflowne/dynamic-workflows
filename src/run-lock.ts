import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowInputError } from "./errors.js";
import { sanitizeRunId } from "./run-store.js";

const UNKNOWN_LOCK_STALE_MS = 60 * 60 * 1000;

interface LockFile {
  runId: string;
  pid: number;
  hostname: string;
  token: string;
  createdAt: number;
}

export interface RunLock {
  path: string;
  release(): Promise<void>;
}

/** Best-effort per-run mutex so two resumes cannot race on the same record/events/journal namespace. */
export async function acquireRunLock(runsDir: string, runId: string): Promise<RunLock> {
  await mkdir(runsDir, { recursive: true });
  const lockPath = path.join(runsDir, `${sanitizeRunId(runId)}.lock`);
  const lock: LockFile = {
    runId,
    pid: process.pid,
    hostname: os.hostname(),
    token: randomUUID(),
    createdAt: Date.now(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await writeFile(handle, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return {
        path: lockPath,
        release: async () => {
          const current = await readLock(lockPath);
          if (current?.token === lock.token) await unlink(lockPath).catch(() => {});
        },
      };
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      if (!(await reapStaleLock(lockPath))) {
        throw new WorkflowInputError(
          `run ${runId} is already running or resuming. Wait for it to finish, or remove the stale lock at ${lockPath}.`,
        );
      }
    }
  }

  throw new WorkflowInputError(`could not acquire run lock for ${runId}`);
}

async function reapStaleLock(lockPath: string): Promise<boolean> {
  const lock = await readLock(lockPath);
  if (lock?.hostname === os.hostname() && Number.isInteger(lock.pid) && lock.pid > 0) {
    if (isPidAlive(lock.pid)) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  }

  try {
    const info = await stat(lockPath);
    if (Date.now() - info.mtimeMs < UNKNOWN_LOCK_STALE_MS) return false;
    await unlink(lockPath).catch(() => {});
    return true;
  } catch {
    return true;
  }
}

async function readLock(lockPath: string): Promise<LockFile | undefined> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as LockFile;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ESRCH";
  }
}

function isFileExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}
