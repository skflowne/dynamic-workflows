import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexSdkAgentRunner, type CodexSdkAgentRunnerOptions } from "../runners/codex-sdk.js";
import type { SandboxMode, ThreadOptions } from "@openai/codex-sdk";
import { WorkflowController, defaultWorkflowDirs } from "../controller.js";
import { WorkflowInputError } from "../errors.js";
import { parseWorkflowScript } from "../parser.js";
import { FileRunStore, type RunRecord } from "../run-store.js";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner, WorkflowProgressEvent } from "../types.js";
import { WorkflowRegistry, type WorkflowRegistryDirectory } from "../workflow-tool.js";
import { ProgressRenderer, type ProgressMode } from "./progress.js";
import { createWebServer } from "../web/server.js";
import {
  clearServerState,
  ensureBackgroundServer,
  openBrowser,
  pickPort,
  postIngest,
  readServerState,
  writeServerState,
  healthCheck,
} from "../web/launcher.js";
import { workflowDataDir, runsDir, journalDir } from "../paths.js";

const exec = promisify(execFile);

export interface RunFlags {
  args?: string;
  model?: string;
  concurrency?: string;
  budget?: string;
  "max-agents"?: string;
  resume?: string;
  cwd?: string;
  sandbox?: string;
  approval?: string;
  reasoning?: string;
  reasoningEffort?: string;
  bun?: string;
  json?: boolean;
  quiet?: boolean;
  "no-progress"?: boolean;
  port?: string;
  open?: boolean;
  "no-open"?: boolean;
  "no-web"?: boolean;
  daemon?: boolean;
}

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_MODES = ["never", "on-request", "on-failure", "untrusted"];
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

/** `codex-workflow run <file|name>` */
export async function runCommand(target: string | undefined, flags: RunFlags): Promise<number> {
  if (!target) {
    process.stderr.write("error: `run` requires a workflow file path or registered name\n");
    return 2;
  }

  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const json = flags.json === true;
  const mode: ProgressMode = json || flags.quiet ? "silent" : flags["no-progress"] ? "plain" : "pretty";
  const renderer = new ProgressRenderer(mode);

  // Runtime data (runs/journal/links) lives in the global data dir so it's shared across projects;
  // `cwd` stays the project dir (where Codex agents run and workflows are discovered).
  const dataDir = workflowDataDir();
  const workflowDirs = cliWorkflowDirs(cwd);
  const registry = new WorkflowRegistry(workflowDirs);
  const runner = buildAgentRunner(cwd, flags);
  const runStore = new FileRunStore(runsDir(dataDir));

  const input = await buildRunInput(target, cwd, flags);
  const runId = flags.resume ?? `wf_${randomId()}`;
  input.resumeFromRunId = runId;

  const startedAt = Date.now();
  const baseRecord: RunRecord = {
    runId,
    name: typeof input.name === "string" ? input.name : path.basename(String(input.scriptPath ?? "inline")),
    status: "running",
    source: input.scriptPath ? "scriptPath" : "named",
    startedAt,
    ...(input.args !== undefined ? { args: input.args } : {}),
    ...(input.scriptPath ? { scriptPath: path.resolve(String(input.scriptPath)) } : {}),
  };
  await runStore.save(baseRecord);

  // Background viewer: auto-start a reusable server (skipped for --json machine output and --no-web).
  // All viewer I/O is best-effort — a missing server must never affect the run itself.
  const webEnabled = !json && flags["no-web"] !== true;
  let viewerUrl: string | undefined;
  if (webEnabled) {
    try {
      const { url } = await ensureBackgroundServer(dataDir);
      viewerUrl = url;
      process.stderr.write(`${dim("▸")} Viewer: ${bold(`${url}/runs/${runId}`)}\n`);
      if (flags.open) openBrowser(`${url}/runs/${runId}`);
      postIngest(url, { runId, type: "run-meta", record: baseRecord });
    } catch (error) {
      process.stderr.write(`${yellow("!")} viewer unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  const onProgress = (event: WorkflowProgressEvent): void => {
    renderer.handle(event);
    if (viewerUrl) postIngest(viewerUrl, { runId, type: "progress", event });
  };

  const controller = new WorkflowController({
    cwd,
    runner,
    registry,
    onProgress,
    persistDir: runsDir(dataDir),
    journalDir: journalDir(dataDir),
    ...numericFlag("concurrency", flags.concurrency),
    ...numericFlag("maxAgents", flags["max-agents"]),
    ...numericFlag("tokenBudget", flags.budget),
    ...(flags.bun ? { bunPath: flags.bun } : {}),
  });

  try {
    const output = await controller.run(input);
    renderer.finish();
    await runStore.save({
      ...baseRecord,
      name: output.workflowName,
      description: output.summary,
      status: "completed",
      source: output.source,
      completedAt: Date.now(),
      durationMs: output.stats.durationMs,
      agentCount: output.stats.agentCount,
      cacheHits: output.stats.cacheHits,
      phases: output.stats.phases,
      logs: output.stats.logs,
      result: output.result,
      ...(output.scriptPath ? { scriptPath: output.scriptPath } : {}),
    });
    if (viewerUrl) postIngest(viewerUrl, { runId, type: "run-finished", status: "completed" });

    if (json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      printRunSummary(output.workflowName, output.runId, output.stats);
      process.stdout.write(`${stringifyResult(output.result)}\n`);
    }
    return 0;
  } catch (error) {
    renderer.finish();
    const message = error instanceof Error ? error.message : String(error);
    await runStore.save({ ...baseRecord, status: "failed", completedAt: Date.now(), error: message });
    if (viewerUrl) postIngest(viewerUrl, { runId, type: "run-finished", status: "failed", error: message });
    process.stderr.write(`\nworkflow failed: ${message}\n`);
    return 1;
  }
}

/** `codex-workflow list` */
export async function listCommand(flags: { cwd?: string; json?: boolean }): Promise<number> {
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const registry = new WorkflowRegistry(cliWorkflowDirs(cwd));
  const workflows = await registry.list();

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        workflows.map((w) => ({ name: w.name, description: w.meta.description, whenToUse: w.meta.whenToUse, source: w.source, path: w.path })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (workflows.length === 0) {
    process.stdout.write("No workflows found. Add scripts to .claude/workflows/, ~/.claude/workflows/, or ~/.codex/workflows/.\n");
    return 0;
  }
  for (const w of workflows) {
    process.stdout.write(`${w.name}  ${dim(`(${w.source})`)}\n`);
    process.stdout.write(`  ${w.meta.description}\n`);
    if (w.meta.whenToUse) process.stdout.write(`  ${dim(`when: ${w.meta.whenToUse}`)}\n`);
  }
  return 0;
}

/** `codex-workflow validate <file>` */
export async function validateCommand(target: string | undefined, flags: { json?: boolean }): Promise<number> {
  if (!target) {
    process.stderr.write("error: `validate` requires a workflow file path\n");
    return 2;
  }
  let script: string;
  try {
    script = await readFile(path.resolve(target), "utf8");
  } catch (error) {
    process.stderr.write(`error: cannot read ${target}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const { meta } = parseWorkflowScript(script);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ valid: true, meta }, null, 2)}\n`);
    } else {
      process.stdout.write(`${green("✓")} valid workflow: ${bold(meta.name)}\n`);
      process.stdout.write(`  ${meta.description}\n`);
      if (meta.phases?.length) process.stdout.write(`  phases: ${meta.phases.map((p) => p.title).join(" → ")}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) process.stdout.write(`${JSON.stringify({ valid: false, error: message }, null, 2)}\n`);
    else process.stderr.write(`${red("✗")} invalid workflow: ${message}\n`);
    return 1;
  }
}

/** `codex-workflow runs` */
export async function runsCommand(flags: { cwd?: string; json?: boolean }): Promise<number> {
  const store = new FileRunStore(runsDir());
  const records = await store.list();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(records, null, 2)}\n`);
    return 0;
  }
  if (records.length === 0) {
    process.stdout.write("No runs recorded yet.\n");
    return 0;
  }
  for (const r of records) {
    const when = new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 19);
    const dur = r.durationMs !== undefined ? `${(r.durationMs / 1000).toFixed(1)}s` : "—";
    const agents = r.agentCount !== undefined ? `${r.agentCount} agents` : "";
    process.stdout.write(`${statusGlyph(r.status)} ${bold(r.runId)}  ${r.name}  ${dim(`${when} · ${dur} · ${agents}`)}\n`);
    if (r.error) process.stdout.write(`  ${red(r.error)}\n`);
  }
  return 0;
}

/** `codex-workflow show <runId>` */
export async function showCommand(runId: string | undefined, flags: { cwd?: string; json?: boolean }): Promise<number> {
  if (!runId) {
    process.stderr.write("error: `show` requires a runId\n");
    return 2;
  }
  const store = new FileRunStore(runsDir());
  const record = await store.get(runId);
  if (!record) {
    process.stderr.write(`error: run ${runId} not found\n`);
    return 1;
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${statusGlyph(record.status)} ${bold(record.name)}  ${dim(record.runId)}\n`);
  if (record.description) process.stdout.write(`  ${record.description}\n`);
  process.stdout.write(`  status: ${record.status}\n`);
  if (record.scriptPath) process.stdout.write(`  script: ${record.scriptPath}\n`);
  if (record.durationMs !== undefined) process.stdout.write(`  duration: ${(record.durationMs / 1000).toFixed(1)}s\n`);
  if (record.agentCount !== undefined) process.stdout.write(`  agents: ${record.agentCount} (cache hits: ${record.cacheHits ?? 0})\n`);
  if (record.phases?.length) process.stdout.write(`  phases: ${record.phases.join(" → ")}\n`);
  if (record.error) process.stdout.write(`  ${red(`error: ${record.error}`)}\n`);
  if (record.logs?.length) {
    process.stdout.write("  logs:\n");
    for (const line of record.logs) process.stdout.write(`    ${dim(line)}\n`);
  }
  return 0;
}

/** `codex-workflow serve` — start the local web viewer (foreground; blocks until signalled). */
export async function serveCommand(flags: RunFlags): Promise<number> {
  const dataDir = workflowDataDir();
  const daemon = flags.daemon === true;

  let requestedPort: number | undefined;
  if (flags.port !== undefined) {
    requestedPort = Number(flags.port);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      process.stderr.write("error: --port must be an integer 0–65535\n");
      return 2;
    }
  }

  // Reuse an already-running viewer rather than double-binding (foreground invocations only).
  if (!daemon) {
    const existing = await readServerState(dataDir);
    if (existing && (await healthCheck(existing.url))) {
      process.stdout.write(`${green("✓")} Viewer already running at ${bold(existing.url)}\n`);
      if (flags["no-open"] !== true) openBrowser(existing.url);
      return 0;
    }
  }

  const port = requestedPort ?? (await pickPort());
  const server = createWebServer({ dataDir, version: readPkgVersion() });
  let bound: { port: number; url: string };
  try {
    bound = await server.listen(port);
  } catch (error) {
    process.stderr.write(`error: could not start viewer on port ${port}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  await writeServerState(dataDir, { pid: process.pid, port: bound.port, url: bound.url, startedAt: Date.now() });

  if (!daemon) {
    process.stdout.write(`${green("✓")} Viewer running at ${bold(bound.url)}  ${dim("(Ctrl-C to stop)")}\n`);
    if (flags["no-open"] !== true) openBrowser(bound.url);
  }

  const shutdown = () => {
    void clearServerState(dataDir).finally(() => server.close().finally(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Stay alive until signalled; the server keeps serving in the meantime.
  return new Promise<number>(() => {});
}

/** `codex-workflow doctor` */
export async function doctorCommand(flags: { cwd?: string }): Promise<number> {
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  let ok = true;
  const line = (good: boolean, label: string, hint?: string) => {
    if (!good) ok = false;
    process.stdout.write(`${good ? green("✓") : red("✗")} ${label}${good || !hint ? "" : `\n    ${dim(hint)}`}\n`);
  };

  const bun = await tryExec("bun", ["--version"]);
  line(bun.ok, `Bun runtime${bun.ok ? ` (${bun.out.trim()})` : ""}`, "Install Bun: https://bun.sh — workflows execute in a Bun child process.");

  const codex = await tryExec("codex", ["--version"]);
  line(codex.ok, `Codex CLI${codex.ok ? ` (${codex.out.trim()})` : ""}`, "Install Codex CLI and run `codex login`.");

  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  const auth = await pathExists(authPath);
  line(auth, "Codex auth (~/.codex/auth.json)", "Run `codex login` to authenticate.");

  for (const { dir } of cliWorkflowDirs(cwd)) {
    const exists = await pathExists(dir);
    process.stdout.write(`${exists ? green("✓") : dim("·")} workflow dir: ${dir}${exists ? "" : dim(" (not present)")}\n`);
  }

  const dataDir = workflowDataDir();
  process.stdout.write(`${green("✓")} data dir: ${dataDir}\n`);

  const viewer = await readServerState(dataDir);
  const viewerUp = viewer ? await healthCheck(viewer.url) : false;
  process.stdout.write(
    `${viewerUp ? green("✓") : dim("·")} viewer server: ${viewerUp ? viewer!.url : dim("not running (auto-starts on `run`, or `codex-workflow serve`)")}\n`,
  );

  process.stdout.write(ok ? `\n${green("Ready.")}\n` : `\n${yellow("Some checks failed — see hints above.")}\n`);
  return ok ? 0 : 1;
}

function readPkgVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// --- helpers ------------------------------------------------------------------------------------

function cliWorkflowDirs(cwd: string): WorkflowRegistryDirectory[] {
  return [
    ...defaultWorkflowDirs(cwd, os.homedir()),
    { dir: path.join(os.homedir(), ".codex", "workflows"), source: "user" },
  ];
}

async function buildRunInput(
  target: string,
  cwd: string,
  flags: RunFlags,
): Promise<{ name?: string; scriptPath?: string; args?: unknown; resumeFromRunId?: string }> {
  const args = await parseArgsValue(flags.args, cwd);
  const asPath = path.resolve(cwd, target);
  if (await isFile(asPath)) {
    return { scriptPath: asPath, ...(args !== undefined ? { args } : {}) };
  }
  // Looks like a path but does not exist → surface a clear file error rather than a name lookup.
  if (target.includes("/") || target.includes(path.sep) || /\.(m?[jt]s)$/.test(target)) {
    throw new WorkflowInputError(`workflow file not found: ${target}`);
  }
  return { name: target, ...(args !== undefined ? { args } : {}) };
}

async function parseArgsValue(raw: string | undefined, cwd: string): Promise<unknown> {
  if (raw === undefined) return undefined;
  const text = raw.startsWith("@") ? await readFile(path.resolve(cwd, raw.slice(1)), "utf8") : raw;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new WorkflowInputError(`--args must be JSON (or @file.json): ${error instanceof Error ? error.message : String(error)}`);
  }
}

function buildAgentRunner(cwd: string, flags: RunFlags): WorkflowAgentRunner {
  if (process.env.CODEX_WORKFLOW_FAKE_AGENT) return new FakeAgentRunner();

  const options: CodexSdkAgentRunnerOptions = { cwd };
  if (flags.model) options.model = flags.model;
  if (flags.sandbox) options.sandboxMode = assertOneOf(flags.sandbox, SANDBOX_MODES, "--sandbox") as SandboxMode;
  if (flags.approval) options.approvalPolicy = assertOneOf(flags.approval, APPROVAL_MODES, "--approval") as ThreadOptions["approvalPolicy"];
  const reasoning = flags.reasoning ?? flags.reasoningEffort;
  if (reasoning) options.modelReasoningEffort = assertOneOf(reasoning, REASONING_EFFORTS, "--reasoning") as ThreadOptions["modelReasoningEffort"];
  // Web search + network access are always enabled for agents.
  options.webSearchEnabled = true;
  options.networkAccessEnabled = true;
  return new CodexSdkAgentRunner(options);
}

/** Deterministic, token-free runner used by tests via CODEX_WORKFLOW_FAKE_AGENT=1. */
class FakeAgentRunner implements WorkflowAgentRunner {
  async run(call: WorkflowAgentCall): Promise<unknown> {
    if (call.options.schema) return "{}";
    return `fake:${call.prompt}`;
  }
}

function numericFlag<K extends string>(key: K, raw: string | undefined): Partial<Record<K, number>> {
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new WorkflowInputError(`${key} must be a number, got "${raw}"`);
  return { [key]: value } as Record<K, number>;
}

function assertOneOf(value: string, allowed: string[], flag: string): string {
  if (!allowed.includes(value)) {
    throw new WorkflowInputError(`${flag} must be one of: ${allowed.join(", ")} (got "${value}")`);
  }
  return value;
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function tryExec(cmd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await exec(cmd, args);
    return { ok: true, out: stdout };
  } catch {
    return { ok: false, out: "" };
  }
}

function printRunSummary(name: string, runId: string, stats: { agentCount: number; cacheHits: number; durationMs: number; phases: string[] }): void {
  process.stderr.write(
    `\n${green("✓")} ${bold(name)} ${dim(`(${runId})`)} — ${stats.agentCount} agents, ${stats.cacheHits} cached, ${(stats.durationMs / 1000).toFixed(1)}s\n\n`,
  );
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2);
}

// Minimal ANSI helpers (stdout is not assumed to be a TTY; colors only when interactive).
const useColor = process.stderr.isTTY === true && !process.env.NO_COLOR;
function paint(text: string, code: string): string {
  return useColor ? `\x1b[${code}m${text}\x1b[0m` : text;
}
const bold = (t: string) => paint(t, "1");
const dim = (t: string) => paint(t, "2");
const red = (t: string) => paint(t, "31");
const green = (t: string) => paint(t, "32");
const yellow = (t: string) => paint(t, "33");

function statusGlyph(status: RunRecord["status"]): string {
  switch (status) {
    case "completed":
      return green("✓");
    case "failed":
      return red("✗");
    case "cancelled":
      return yellow("⊘");
    default:
      return dim("⟳");
  }
}

function randomId(): string {
  return randomUUID().slice(0, 12);
}

export type { WorkflowProgressEvent };
