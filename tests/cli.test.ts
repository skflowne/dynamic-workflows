import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

function runCli(
  args: string[],
  cwd: string,
  options: { fakeAgent?: boolean; env?: Record<string, string> } = {},
): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CODEX_WORKFLOW_HOME: cwd, ...(options.env ?? {}) };
    if (options.fakeAgent !== false) env.CODEX_WORKFLOW_FAKE_AGENT = "1";
    else delete env.CODEX_WORKFLOW_FAKE_AGENT;
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      // Isolate run history to the temp dir (CODEX_WORKFLOW_HOME) so tests never touch the real ~/.codex-workflow.
      env,
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

test("CLI run supports the Gemini backend", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-gemini-"));
  try {
    const wfPath = path.join(dir, "gemini_demo.js");
    await writeFile(
      wfPath,
      `export const meta = {
  name: 'gemini_demo',
  description: 'Gemini CLI backend workflow',
  phases: [{ title: 'Work', model: 'claude-phase-model' }],
}

phase('Work')
return agent('from cli', { label: 'gemini', model: 'claude-hardcoded-model' })
`,
      "utf8",
    );
    const fakeGemini = path.join(dir, "fake-gemini");
    await writeFile(
      fakeGemini,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const prompt = valueAfter("-p") || valueAfter("--prompt") || "";
const model = valueAfter("--model") || valueAfter("-m") || "none";
console.log(JSON.stringify({
  session_id: "cli-gemini-session",
  response: "fake-gemini:" + model + ":" + prompt.includes("from cli"),
  stats: { models: { [model]: { tokens: { candidates: 3, total: 20 } } } }
}));
`,
      "utf8",
    );
    await chmod(fakeGemini, 0o755);

    const run = await runCli(
      ["run", wfPath, "--backend", "gemini", "--model", "test-gemini", "--gemini-command", fakeGemini, "--json", "--cwd", dir],
      dir,
      { fakeAgent: false },
    );
    assert.equal(run.code, 0, run.stderr);
    const output = JSON.parse(run.stdout) as { status: string; result: string; stats: { agentCount: number } };
    assert.equal(output.status, "completed");
    assert.equal(output.result, "fake-gemini:test-gemini:true");
    assert.equal(output.stats.agentCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects a negative --agent-timeout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-timeout-"));
  try {
    const wfPath = path.join(dir, "wf.js");
    await writeFile(wfPath, "export const meta = { name: 'x', description: 'x' }\nreturn 'x'\n", "utf8");
    // Real backend path (FAKE short-circuits before runner construction); the flag is validated while
    // building the runner, so it fails fast with exit 2 before any backend session starts.
    // `--agent-timeout=-5` (equals form): a bare `--agent-timeout -5` is rejected earlier by parseArgs.
    const result = await runCli(["run", wfPath, "--agent-timeout=-5", "--cwd", dir], dir, { fakeAgent: false });
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stderr, /--agent-timeout must be a non-negative number/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI records the run backend and resume refuses a conflicting one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-resume-backend-"));
  try {
    const wfPath = path.join(dir, "cli_demo.js");
    await writeFile(wfPath, WORKFLOW, "utf8");

    // Run on the default (codex) backend; resolveRunnerConfig records it even under the FAKE agent.
    const run = await runCli(["run", wfPath, "--args", '{"who":"Ada"}', "--json", "--cwd", dir], dir);
    assert.equal(run.code, 0, run.stderr);
    const runId = (JSON.parse(run.stdout) as { runId: string }).runId;

    // The record persisted the backend (CODEX_WORKFLOW_HOME=dir → record at <dir>/runs/<id>.json).
    const recPath = path.join(dir, "runs", `${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    const record = JSON.parse(await readFile(recPath, "utf8")) as { runner?: { backend?: string } };
    assert.equal(record.runner?.backend, "codex");

    // Resuming with a conflicting backend is refused (exit 2) instead of silently mixing backends.
    const conflict = await runCli(["resume", runId, "--backend", "gemini", "--cwd", dir], dir);
    assert.equal(conflict.code, 2, conflict.stdout);
    assert.match(conflict.stderr, /used backend "codex"/);
    assert.match(conflict.stderr, /--backend "gemini"/);

    // Resuming without --backend inherits the recorded codex backend and succeeds.
    const resumed = await runCli(["resume", runId, "--json", "--cwd", dir], dir);
    assert.equal(resumed.code, 0, resumed.stderr);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI persists --model and resume inherits it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-resume-model-"));
  try {
    const wfPath = path.join(dir, "cli_demo.js");
    await writeFile(wfPath, WORKFLOW, "utf8");

    const run = await runCli(["run", wfPath, "--model", "my-test-model", "--json", "--cwd", dir], dir);
    assert.equal(run.code, 0, run.stderr);
    const runId = (JSON.parse(run.stdout) as { runId: string }).runId;

    const recPath = path.join(dir, "runs", `${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    const recBefore = JSON.parse(await readFile(recPath, "utf8")) as { runner?: { model?: string } };
    assert.equal(recBefore.runner?.model, "my-test-model");

    // Resume WITHOUT --model: the recorded model is inherited (and re-persisted into the record).
    const resumed = await runCli(["resume", runId, "--json", "--cwd", dir], dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    const recAfter = JSON.parse(await readFile(recPath, "utf8")) as { runner?: { model?: string } };
    assert.equal(recAfter.runner?.model, "my-test-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI persists the pi runner config (base-url/pi-api/tools) and resume inherits it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-resume-pi-"));
  try {
    const wfPath = path.join(dir, "cli_demo.js");
    await writeFile(wfPath, WORKFLOW, "utf8");

    const run = await runCli(
      [
        "run", wfPath,
        "--backend", "pi",
        "--base-url", "https://api.example.com",
        "--model", "my-model",
        "--pi-api", "anthropic-messages",
        "--tools", "read,grep",
        "--thinking", "low",
        "--json", "--cwd", dir,
      ],
      dir,
    );
    assert.equal(run.code, 0, run.stderr);
    const runId = (JSON.parse(run.stdout) as { runId: string }).runId;

    type PiRunner = { backend?: string; baseUrl?: string; piApi?: string; tools?: string; thinking?: string };
    const recPath = path.join(dir, "runs", `${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    const recBefore = JSON.parse(await readFile(recPath, "utf8")) as { runner?: PiRunner };
    assert.equal(recBefore.runner?.backend, "pi");
    assert.equal(recBefore.runner?.baseUrl, "https://api.example.com");
    assert.equal(recBefore.runner?.piApi, "anthropic-messages");
    assert.equal(recBefore.runner?.tools, "read,grep");
    assert.equal(recBefore.runner?.thinking, "low");

    // Resume with NO pi flags: pi-api/tools must travel with base-url, or the uncached agents would
    // silently switch API shape / tool set relative to the original run.
    const resumed = await runCli(["resume", runId, "--json", "--cwd", dir], dir);
    assert.equal(resumed.code, 0, resumed.stderr);
    const recAfter = JSON.parse(await readFile(recPath, "utf8")) as { runner?: PiRunner };
    assert.equal(recAfter.runner?.baseUrl, "https://api.example.com");
    assert.equal(recAfter.runner?.piApi, "anthropic-messages");
    assert.equal(recAfter.runner?.tools, "read,grep");
    assert.equal(recAfter.runner?.thinking, "low");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI rejects Codex-only flags with the Gemini backend", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-gemini-flags-"));
  try {
    const wfPath = path.join(dir, "gemini_demo.js");
    await writeFile(wfPath, "export const meta = { name: 'x', description: 'x' }\nreturn 'x'\n", "utf8");
    const result = await runCli(["run", wfPath, "--backend", "gemini", "--approval", "never", "--cwd", dir], dir, {
      fakeAgent: false,
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--approval is only supported with --backend codex/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI resume failure preserves a prior completed run record", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cli-resume-preserve-"));
  try {
    const wfPath = path.join(dir, "cli_demo.js");
    await writeFile(wfPath, WORKFLOW, "utf8");

    const run = await runCli(["run", wfPath, "--args", '{"who":"Ada"}', "--json", "--cwd", dir], dir);
    assert.equal(run.code, 0, run.stderr);
    const first = JSON.parse(run.stdout) as { runId: string; result: { who: string } };
    assert.equal(first.result.who, "Ada");

    await writeFile(
      wfPath,
      `export const meta = {
  name: 'cli_demo',
  description: 'CLI smoke workflow',
  phases: [{ title: 'Work' }],
}

throw new Error('resume boom')
`,
      "utf8",
    );

    const resumed = await runCli(["resume", first.runId, "--json", "--cwd", dir], dir);
    assert.equal(resumed.code, 1);
    assert.match(resumed.stderr, /resume boom/);

    const show = await runCli(["show", first.runId, "--json", "--cwd", dir], dir);
    assert.equal(show.code, 0, show.stderr);
    const record = JSON.parse(show.stdout) as { status: string; result: { who: string }; error?: string };
    assert.equal(record.status, "completed");
    assert.equal(record.result.who, "Ada");
    assert.equal(record.error, undefined);
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
