import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createDetachedWorktree } from "../src/runners/worktree.js";
import type { WorkflowAgentMeta } from "../src/index.js";

const exec = promisify(execFile);

/** Creates a throwaway git repo with one commit so `git worktree add --detach` has something to check out. */
async function makeGitRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-worktree-repo-"));
  await exec("git", ["-C", dir, "init", "-q"]);
  await exec("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", dir, "config", "user.name", "Test"]);
  await writeFile(path.join(dir, "README.md"), "hello\n", "utf8");
  await exec("git", ["-C", dir, "add", "."]);
  await exec("git", ["-C", dir, "commit", "-q", "-m", "init"]);
  return dir;
}

test("createDetachedWorktree preserves the worktree when the agent leaves dirty changes", async () => {
  const repo = await makeGitRepo();
  try {
    const worktree = await createDetachedWorktree(repo);
    assert.ok(worktree, "expected a worktree to be created for a git repo");
    // Simulate the agent editing a file inside the worktree.
    await writeFile(path.join(worktree!.dir, "README.md"), "changed\n", "utf8");

    const metas: WorkflowAgentMeta[] = [];
    await worktree!.cleanup((meta) => metas.push(meta));

    // Dirty → preserved: the directory must still exist, `git worktree list` must still know about it,
    // and onMeta must report worktreePreserved with the path (this is what the runner logs to the user).
    assert.ok(existsSync(worktree!.dir), "expected the dirty worktree directory to survive cleanup");
    const { stdout } = await exec("git", ["-C", repo, "worktree", "list"]);
    assert.ok(stdout.includes(worktree!.dir), "expected `git worktree list` to still list the preserved worktree");
    assert.ok(
      metas.some((meta) => meta.worktreePreserved === true && meta.worktreePath === worktree!.dir),
      `expected a worktreePreserved meta event, got ${JSON.stringify(metas)}`,
    );
  } finally {
    await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  }
});

test("createDetachedWorktree removes the worktree when the agent leaves it clean", async () => {
  const repo = await makeGitRepo();
  try {
    const worktree = await createDetachedWorktree(repo);
    assert.ok(worktree, "expected a worktree to be created for a git repo");

    // No changes made — the agent left the worktree exactly as checked out.
    const metas: WorkflowAgentMeta[] = [];
    await worktree!.cleanup((meta) => metas.push(meta));

    // Clean → removed: the directory must be gone and `git worktree list` must no longer know about it;
    // no worktreePreserved meta should have been emitted.
    assert.ok(!existsSync(worktree!.dir), "expected the clean worktree directory to be removed");
    const { stdout } = await exec("git", ["-C", repo, "worktree", "list"]);
    assert.ok(!stdout.includes(worktree!.dir), "expected `git worktree list` to no longer list the removed worktree");
    assert.ok(
      !metas.some((meta) => meta.worktreePreserved === true),
      `expected no worktreePreserved meta event, got ${JSON.stringify(metas)}`,
    );
  } finally {
    await exec("git", ["-C", repo, "worktree", "prune"]).catch(() => {});
    await rm(repo, { recursive: true, force: true });
  }
});
