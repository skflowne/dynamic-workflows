import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

const WORKFLOW = `export const meta = {
  name: 'cli_demo',
  description: 'CLI smoke workflow',
  phases: [{ title: 'Work' }],
}

phase('Work')
const items = await parallel(['a', 'b'].map((x) => () => agent('do ' + x, { label: 'do:' + x })))
return { items, who: (args && args.who) || 'nobody' }
`;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      // Isolate run history to the temp dir (CODEX_WORKFLOW_HOME) so tests never touch the real ~/.codex-workflow.
      env: { ...process.env, CODEX_WORKFLOW_FAKE_AGENT: "1", NO_COLOR: "1", CODEX_WORKFLOW_HOME: cwd },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test("CLI validate / run --json / runs / show end-to-end (no tokens)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-"));
  try {
    const wfPath = path.join(dir, "cli_demo.js");
    await writeFile(wfPath, WORKFLOW, "utf8");

    // validate
    const validate = await runCli(["validate", wfPath], dir);
    assert.equal(validate.code, 0, validate.stderr);
    assert.match(validate.stdout, /valid workflow: cli_demo/);

    // run by path with --json
    const run = await runCli(["run", wfPath, "--args", '{"who":"Ada"}', "--json", "--cwd", dir], dir);
    assert.equal(run.code, 0, run.stderr);
    const output = JSON.parse(run.stdout) as {
      status: string;
      runId: string;
      result: { who: string; items: string[] };
      stats: { agentCount: number };
    };
    assert.equal(output.status, "completed");
    assert.equal(output.result.who, "Ada");
    assert.deepEqual(output.result.items, ["fake:do a", "fake:do b"]);
    assert.equal(output.stats.agentCount, 2);

    // runs --json includes the recorded run
    const runs = await runCli(["runs", "--json", "--cwd", dir], dir);
    assert.equal(runs.code, 0, runs.stderr);
    const records = JSON.parse(runs.stdout) as Array<{ runId: string; status: string }>;
    assert.ok(records.some((r) => r.runId === output.runId && r.status === "completed"));

    // show <runId>
    const show = await runCli(["show", output.runId, "--cwd", dir], dir);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /status: completed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI resume re-runs a recorded run by id, restoring args and reusing the journal cache", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-resume-"));
  try {
    const wfPath = path.join(dir, "cli_demo.js");
    await writeFile(wfPath, WORKFLOW, "utf8");

    // Initial run with args — agents run fresh (no cache).
    const run = await runCli(["run", wfPath, "--args", '{"who":"Ada"}', "--json", "--cwd", dir], dir);
    assert.equal(run.code, 0, run.stderr);
    const first = JSON.parse(run.stdout) as {
      runId: string;
      result: { who: string };
      stats: { agentCount: number; cacheHits: number };
    };
    assert.equal(first.result.who, "Ada");
    assert.equal(first.stats.cacheHits, 0);

    // Resume by id ONLY — no file path, no --args. args is restored from the record and every agent
    // is served from the journal (cacheHits === agentCount).
    const resumed = await runCli(["resume", first.runId, "--json", "--cwd", dir], dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    const second = JSON.parse(resumed.stdout) as {
      runId: string;
      result: { who: string };
      stats: { agentCount: number; cacheHits: number };
    };
    assert.equal(second.runId, first.runId);
    assert.equal(second.result.who, "Ada");
    assert.equal(second.stats.cacheHits, second.stats.agentCount);

    // --args overrides the recorded args.
    const overridden = await runCli(["resume", first.runId, "--args", '{"who":"Grace"}', "--json", "--cwd", dir], dir);
    assert.equal(overridden.code, 0, overridden.stderr);
    assert.equal((JSON.parse(overridden.stdout) as { result: { who: string } }).result.who, "Grace");

    // Unknown run id → clean error, exit 1.
    const missing = await runCli(["resume", "wf_does-not-exist", "--cwd", dir], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI list discovers project workflows by name, including TypeScript files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-list-"));
  try {
    const workflowDir = path.join(dir, ".claude", "workflows");
    await mkdir(workflowDir, { recursive: true });
    await writeFile(
      path.join(workflowDir, "named_demo.ts"),
      `export const meta = {
  name: 'named_demo',
  description: 'Named workflow',
  phases: [{ title: 'Named' }],
} as const
return 'listed'
`,
      "utf8",
    );

    const listed = await runCli(["list", "--json", "--cwd", dir], dir);
    assert.equal(listed.code, 0, listed.stderr);
    const workflows = JSON.parse(listed.stdout) as Array<{ name: string; source: string; path: string }>;
    const found = workflows.find((workflow) => workflow.name === "named_demo");
    assert.ok(found);
    assert.equal(found.source, "project");
    assert.equal(found.path, path.join(workflowDir, "named_demo.ts"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI validate reports invalid workflows with a non-zero exit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-bad-"));
  try {
    const bad = path.join(dir, "bad.js");
    await writeFile(bad, "const notMeta = 1\nreturn 1\n", "utf8");
    const result = await runCli(["validate", bad], dir);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid workflow/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI errors clearly on unknown command and missing file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-err-"));
  try {
    const unknown = await runCli(["frobnicate"], dir);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /unknown command/);

    const missing = await runCli(["run", "./does-not-exist.js", "--cwd", dir], dir);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not found/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
