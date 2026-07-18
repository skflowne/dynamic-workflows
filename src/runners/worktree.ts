import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkflowAgentMeta } from "../types.js";

const exec = promisify(execFile);

export interface Worktree {
  dir: string;
  /** Removes the worktree if the agent left no changes; preserves it for review (via onMeta) if it did. */
  cleanup: (onMeta?: (meta: WorkflowAgentMeta) => void) => Promise<void>;
}

/**
 * Creates a detached `git worktree` off `baseCwd` so an `isolation: 'worktree'` agent works on an
 * isolated copy of the repo. Returns `undefined` (caller falls back to `baseCwd`) when `baseCwd` is
 * not a git repo or the worktree cannot be created. Shared verbatim by the Codex and Gemini runners.
 */
export async function createDetachedWorktree(baseCwd: string): Promise<Worktree | undefined> {
  try {
    await exec("git", ["-C", baseCwd, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    return undefined; // Not a git repo — fall back to baseCwd (prompt notes the limitation).
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-worktree-"));
  try {
    await exec("git", ["-C", baseCwd, "worktree", "add", "--detach", dir]);
  } catch {
    await rm(dir, { recursive: true, force: true });
    return undefined;
  }
  return {
    dir,
    cleanup: async (onMeta) => {
      // Claude parity: remove the worktree if the agent made no changes, preserve it for review if
      // it did. `--porcelain` lists modified + untracked entries; a non-empty result means dirty.
      let dirty = false;
      try {
        // Large maxBuffer: a big agent diff can produce far more than the 1MB default of --porcelain,
        // and an overflow throw would otherwise be caught below and misclassified as clean.
        const { stdout } = await exec("git", ["-C", dir, "status", "--porcelain"], { maxBuffer: 64 * 1024 * 1024 });
        dirty = stdout.trim().length > 0;
      } catch {
        dirty = true; // Conservative: if status fails, preserve the worktree rather than destroy output.
      }
      if (dirty) {
        onMeta?.({ worktreePath: dir, worktreePreserved: true });
        return;
      }
      try {
        await exec("git", ["-C", baseCwd, "worktree", "remove", "--force", dir]);
      } catch {
        // best-effort
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}
