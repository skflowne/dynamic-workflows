import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { constants as fsConstants, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { CodexSdkAgentRunner, type CodexSdkAgentRunnerOptions } from "../runners/codex-sdk.js";
import { GeminiCliAgentRunner, type GeminiCliAgentRunnerOptions } from "../runners/gemini-cli.js";
import { PiCliAgentRunner, type PiCliAgentRunnerOptions } from "../runners/pi-cli.js";
import type { SandboxMode, ThreadOptions } from "@openai/codex-sdk";
import { defaultWorkflowDirs, WorkflowController } from "../controller.js";
import { WorkflowAbortError, WorkflowInputError } from "../errors.js";
import { parseWorkflowScript } from "../parser.js";
import { FileRunStore, type RunnerConfig, type RunRecord } from "../run-store.js";
import { acquireRunLock, type RunLock } from "../run-lock.js";
import type {
  WorkflowAgentCall,
  WorkflowAgentMeta,
  WorkflowAgentRunner,
  WorkflowProgressEvent,
  WorkflowRunnerResolver,
} from "../types.js";
import {
  discoverProviderConfig,
  loadProviderConfig,
  type LoadedProviderConfig,
  type ProviderDef,
} from "../providers/config.js";
import { buildRunnerResolver, type ProviderRunnerFactories } from "../providers/registry.js";
import { WorkflowRegistry, type WorkflowInput } from "../workflow-tool.js";
import { ProgressRenderer, type ProgressMode } from "./progress.js";
import { createWebServer, type WorkflowWebServer } from "../web/server.js";
import { RunEventLog, runEventsPath } from "../web/event-log.js";
import { openBrowser, pickPort } from "../web/launcher.js";
import { workflowDataDir, runsDir, journalDir, piHomeDir, piSessionsDir } from "../paths.js";

const exec = promisify(execFile);

export interface RunFlags {
  args?: string;
  backend?: string;
  model?: string;
  concurrency?: string;
  budget?: string;
  "max-agents"?: string;
  "agent-retries"?: string;
  "agent-timeout"?: string;
  cwd?: string;
  sandbox?: string;
  approval?: string;
  reasoning?: string;
  reasoningEffort?: string;
  bun?: string;
  "gemini-command"?: string;
  "pi-command"?: string;
  /** Provider config file (`--config`); discovered automatically when omitted. */
  config?: string;
  /** Run-level default provider name selected from the config (`--provider`). */
  provider?: string;
  /** pi backend provider id (`--pi-provider`, e.g. openai/anthropic). */
  "pi-provider"?: string;
  "base-url"?: string;
  "api-key"?: string;
  "pi-api"?: string;
  thinking?: string;
  tools?: string;
  "exclude-tools"?: string;
  "no-tools"?: boolean;
  // Provider-config-only knobs (no CLI flag; set by providerDefToFlags from a ProviderDef).
  baseInstructions?: string;
  /** Raw extra CLI args for the gemini/pi backends (ProviderDef `args`). */
  extraArgs?: string[];
  webSearch?: boolean;
  networkAccess?: boolean;
  webSearchMode?: string;
  yolo?: boolean;
  approve?: boolean;
  contextFiles?: boolean;
  "idle-timeout"?: string;
  json?: boolean;
  quiet?: boolean;
  "no-progress"?: boolean;
  port?: string;
  open?: boolean;
  "no-open"?: boolean;
  "no-web"?: boolean;
}

const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_MODES = ["never", "on-request", "on-failure", "untrusted"];
const REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const AGENT_BACKENDS = ["codex", "gemini", "pi"] as const;
type AgentBackend = (typeof AGENT_BACKENDS)[number];
const PI_API_SHAPES = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

/** `codex-workflow run <file>` */
export async function runCommand(target: string | undefined, flags: RunFlags): Promise<number> {
  if (!target) {
    process.stderr.write("error: `run` requires a workflow file path or registered name\n");
    return 2;
  }

  const cwd = path.resolve(flags.cwd ?? process.cwd());
  let input: WorkflowInput;
  try {
    input = await buildRunInput(target, cwd, flags);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  return executeRun(input, `wf_${randomId()}`, cwd, flags);
}

/**
 * `codex-workflow resume <runId>` — re-run a recorded run, reusing its journal cache. Reconstructs the
 * workflow input (script path / registered name + the original `args`) straight from the saved run record,
 * so the user need not re-type the file path or `--args`. CLI flags (`--args`, `--config`, …) still override.
 */
export async function resumeCommand(runId: string | undefined, flags: RunFlags): Promise<number> {
  if (!runId) {
    process.stderr.write("error: `resume` requires a runId\n");
    return 2;
  }
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const record = await new FileRunStore(runsDir(workflowDataDir())).get(runId);
  if (!record) {
    process.stderr.write(`error: run ${runId} not found (see \`codex-workflow runs\`)\n`);
    return 1;
  }

  let input: WorkflowInput;
  if (record.source === "named") {
    input = { name: record.name };
  } else if (record.scriptPath) {
    input = { scriptPath: record.scriptPath };
  } else {
    process.stderr.write(`error: run ${runId} was an inline workflow with no saved script — cannot resume from the CLI\n`);
    return 1;
  }

  // --args overrides the recorded args; without it, executeRun inherits the run record's stored args.
  let override: unknown;
  try {
    override = await parseArgsValue(flags.args, cwd);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (override !== undefined) input.args = override;

  // Reload the same provider config and re-select the same default so the re-run agents route
  // identically. The journal cache key embeds each agent's provider/model, so cached agents replay
  // regardless; a drifted config only affects re-run agents (warned at run time).
  if (flags.config === undefined && record.runner?.configPath !== undefined) flags.config = record.runner.configPath;
  if (flags.provider === undefined && record.runner?.defaultProvider !== undefined) flags.provider = record.runner.defaultProvider;

  return executeRun(input, runId, cwd, flags, { resumeRecord: record });
}

/**
 * Shared run engine behind `run` and `resume`: sets up the journal-resume run id, the run record, the
 * in-process viewer, Ctrl-C handling, and the controller, then executes and persists the outcome.
 */
async function executeRun(
  input: WorkflowInput,
  runId: string,
  cwd: string,
  flags: RunFlags,
  options: { resumeRecord?: RunRecord } = {},
): Promise<number> {
  const json = flags.json === true;
  const mode: ProgressMode = json || flags.quiet ? "silent" : flags["no-progress"] ? "plain" : "pretty";
  const renderer = new ProgressRenderer(mode);

  // Runtime data (runs/journal/links) lives in the global data dir so it's shared across projects;
  // `cwd` stays the project dir (where Codex agents run).
  const dataDir = workflowDataDir();
  let runner: WorkflowAgentRunner | WorkflowRunnerResolver;
  let loadedConfig: LoadedProviderConfig | undefined;
  try {
    parseAgentTimeoutFlag(flags["agent-timeout"]); // validate up front; throws on a negative value
    loadedConfig = await loadProviderConfigForRun(cwd, dataDir, flags);
    if (loadedConfig) {
      process.stderr.write(`${dim("▸")} Providers: ${dim(loadedConfig.path)} (${Object.keys(loadedConfig.config.providers).length})\n`);
      const priorHash = options.resumeRecord?.runner?.configHash;
      if (priorHash && priorHash !== loadedConfig.hash) {
        process.stderr.write(`${yellow("!")} provider config changed since this run — re-run agents use the new mapping (cached agents are unaffected).\n`);
      }
    }
    runner = buildAgentRunnerResolver(cwd, flags, dataDir, loadedConfig);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const runsPath = runsDir(dataDir);
  const runStore = new FileRunStore(runsPath);
  let runLock: RunLock;
  try {
    runLock = await acquireRunLock(runsPath, runId);
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  let lockReleased = false;
  const releaseRunLock = async (): Promise<void> => {
    if (lockReleased) return;
    lockReleased = true;
    await runLock.release();
  };

  try {
    input.resumeFromRunId = runId;

    // A re-run (resume) inherits the recorded run's args unless this invocation overrides them. The
    // workflow script is the deterministic orchestrator and is re-executed from the top on resume; it
    // needs its original inputs to reproduce the same agent() calls (same prompts → same journal cache
    // keys → cache hits). Inheriting here means the stored args are never silently dropped — and are
    // re-persisted into the record below, so they survive every subsequent resume.
    if (input.args === undefined) {
      const prior = options.resumeRecord ?? (await runStore.get(runId));
      if (prior?.args !== undefined) input.args = prior.args;
    }

    // Surface the declared pipeline (meta.phases, in order) so the viewer can order and pre-render the
    // phases before any agent runs — independent of which phases the script actually enters via phase().
    const declaredPhases = await readDeclaredPhases(input);

    const startedAt = Date.now();
    const baseRecord: RunRecord = {
      runId,
      name: options.resumeRecord?.name ?? input.name ?? path.basename(String(input.scriptPath ?? "inline")),
      ...(options.resumeRecord?.description ? { description: options.resumeRecord.description } : {}),
      status: "running",
      source: input.name ? "named" : input.scriptPath ? "scriptPath" : "inline",
      runner: resolveRunnerConfig(flags, loadedConfig),
      startedAt,
      ...(declaredPhases ? { declaredPhases } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
      ...(input.scriptPath ? { scriptPath: path.resolve(String(input.scriptPath)) } : {}),
    };
    const protectPriorRecordOnFailure = options.resumeRecord?.status === "completed";
    if (!options.resumeRecord) await runStore.save(baseRecord);

    // Live-event bus: every progress event is appended to `runs/<id>.events.jsonl` as the single
    // cross-process liveness transport. Any server — this run's in-process viewer AND a standalone
    // `serve` — tails that file and fans events to its SSE clients. The file is deleted once the run
    // ends (its durable content is promoted into the run record). Best-effort: never breaks the run.
    const eventLog = new RunEventLog(runEventsPath(dataDir, runId));
    await eventLog.open();
    eventLog.append({ runId, type: "run-meta", record: baseRecord });

    // In-process viewer: each run binds its own server on a random (OS-assigned) port (skipped for
    // --json machine output and --no-web). It tails the events file like any other server. All viewer
    // I/O is best-effort: a failed viewer must never break the run.
    const webEnabled = !json && flags["no-web"] !== true;
    let server: WorkflowWebServer | undefined;
    let viewerUrl: string | undefined;
    if (webEnabled) {
      try {
        server = createWebServer({ dataDir, version: readPkgVersion() });
        const bound = await server.listen(0);
        viewerUrl = bound.url;
        process.stderr.write(`${dim("▸")} Viewer: ${bold(`${bound.url}/runs/${runId}`)}\n`);
        if (flags.open) openBrowser(`${bound.url}/runs/${runId}`);
      } catch (error) {
        server = undefined;
        viewerUrl = undefined;
        process.stderr.write(`${yellow("!")} viewer unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    const onProgress = (event: WorkflowProgressEvent): void => {
      renderer.handle(event);
      eventLog.append({ runId, type: "progress", event });
    };

    // Terminal handshake: append the run-finished event, flush+close the stream, let this process's own
    // server drain it to EOF (so its SSE clients get run-finished regardless of fs.watch timing), then
    // delete the now-redundant file. A remote `serve` self-heals via the client's backstop poll.
    const finishEvents = async (event: Record<string, unknown>): Promise<void> => {
      eventLog.append({ runId, ...event });
      await eventLog.close();
      await server?.drainRun(runId);
      await eventLog.remove();
    };

    // Ctrl-C handling: the first signal aborts the workflow (the runtime winds down in-flight Codex
    // threads, then controller.run() rejects with WorkflowAbortError → the cancel branch below). A second
    // signal during winddown force-quits. Handlers are removed before finishViewer so the lingering-viewer
    // gets its own clean SIGINT handler.
    const abort = new AbortController();
    let interrupted = false;
    const onInterrupt = (): void => {
      if (interrupted) {
        process.stderr.write(`\n${yellow("⊘")} Force quit.\n`);
        process.exit(130);
      }
      interrupted = true;
      abort.abort();
      renderer.finish();
      process.stderr.write(`\n${yellow("⊘")} Interrupting — winding down running agents (Ctrl-C again to force quit)…\n`);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onInterrupt);
    const clearInterruptHandlers = (): void => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
    };

    const controller = new WorkflowController({
      cwd,
      runner,
      onProgress,
      signal: abort.signal,
      persistDir: runsDir(dataDir),
      journalDir: journalDir(dataDir),
      ...numericFlag("concurrency", flags.concurrency),
      ...numericFlag("maxAgents", flags["max-agents"]),
      ...agentAttemptsFlag(flags["agent-retries"]),
      ...numericFlag("tokenBudget", flags.budget),
      ...numericFlag("workflowIdleTimeoutMs", flags["idle-timeout"]),
      ...(flags.bun ? { bunPath: flags.bun } : {}),
    });

    try {
      const output = await controller.run(input);
      clearInterruptHandlers();
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
        failureCount: output.stats.failures.length,
        // Promote failure detail into the record — the events file (its only other home) is about to be
        // deleted, and failed agents are never journaled, so this is where the viewer reads them from.
        ...(output.stats.failures.length ? { failures: output.stats.failures } : {}),
        phases: output.stats.phases,
        logs: output.stats.logs,
        result: output.result,
        ...(output.scriptPath ? { scriptPath: output.scriptPath } : {}),
      });
      await finishEvents({ type: "run-finished", status: "completed" });

      if (json) {
        process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      } else {
        printRunSummary(output.workflowName, output.runId, output.stats, output.scriptPath);
        process.stdout.write(`${stringifyResult(output.result)}\n`);
      }
      await releaseRunLock();
      return finishViewer(server, viewerUrl, runId, 0);
    } catch (error) {
      clearInterruptHandlers();
      renderer.finish();
      if (interrupted || error instanceof WorkflowAbortError) {
        if (!protectPriorRecordOnFailure) await runStore.save({ ...baseRecord, status: "cancelled", completedAt: Date.now() });
        await finishEvents({ type: "run-finished", status: "cancelled" });
        process.stderr.write(`\n${yellow("⊘")} Cancelled ${dim(`(${runId})`)} — partial progress saved.\n`);
        process.stderr.write(`${dim(`  Resume (reuse completed agents): codex-workflow resume ${runId}`)}\n`);
        if (server) await server.close();
        await releaseRunLock();
        return 130;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (!protectPriorRecordOnFailure) await runStore.save({ ...baseRecord, status: "failed", completedAt: Date.now(), error: message });
      await finishEvents({ type: "run-finished", status: "failed", error: message });
      process.stderr.write(`\nworkflow failed: ${message}\n`);
      await releaseRunLock();
      return finishViewer(server, viewerUrl, runId, 1);
    }
  } finally {
    await releaseRunLock();
  }
}

/**
 * After a run prints its result, decide the in-process viewer's fate: when stdout is a TTY, keep it
 * live (the open socket holds the foreground process up) and exit on Ctrl-C; otherwise (piped/scripted)
 * close it and return immediately. Returns the exit code (or a never-resolving promise while lingering).
 */
function finishViewer(
  server: WorkflowWebServer | undefined,
  viewerUrl: string | undefined,
  runId: string,
  exitCode: number,
): Promise<number> | number {
  if (!server) return exitCode;
  if (process.stdout.isTTY !== true) {
    return server.close().then(() => exitCode);
  }
  const deepUrl = `${viewerUrl}/runs/${runId}`;
  process.stderr.write(`${dim("▸")} Viewer still live at ${bold(deepUrl)} ${dim("— press Ctrl-C to stop")}\n`);
  const shutdown = () => {
    void server.close().finally(() => process.exit(exitCode));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Never resolves; the listening server keeps the foreground process alive until a signal arrives.
  return new Promise<number>(() => {});
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

/** `codex-workflow list` */
export async function listCommand(flags: { cwd?: string; json?: boolean }): Promise<number> {
  const cwd = path.resolve(flags.cwd ?? process.cwd());
  const dirs = defaultWorkflowDirs(cwd);
  const registry = new WorkflowRegistry(dirs);
  const workflows = await registry.list();

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify(
        workflows.map((workflow) => ({
          name: workflow.name,
          description: workflow.meta.description,
          source: workflow.source,
          path: workflow.path,
          phases: workflow.meta.phases ?? [],
        })),
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (workflows.length === 0) {
    process.stdout.write(`No workflows found in ${dirs.map((entry) => entry.dir).join(", ")}.\n`);
    return 0;
  }

  for (const workflow of workflows) {
    const source = workflow.path ? `${workflow.source}:${workflow.path}` : workflow.source;
    process.stdout.write(`${bold(workflow.name)}  ${dim(source)}\n`);
    process.stdout.write(`  ${workflow.meta.description}\n`);
    if (workflow.meta.phases?.length) {
      process.stdout.write(`  phases: ${workflow.meta.phases.map((phase) => phase.title).join(" → ")}\n`);
    }
  }
  return 0;
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
  if (record.failureCount) process.stdout.write(`  ${yellow(`failed agents: ${record.failureCount}`)} (use \`resume ${record.runId}\` to re-attempt)\n`);
  if (record.phases?.length) process.stdout.write(`  phases: ${record.phases.join(" → ")}\n`);
  if (record.error) process.stdout.write(`  ${red(`error: ${record.error}`)}\n`);
  if (record.logs?.length) {
    process.stdout.write("  logs:\n");
    for (const line of record.logs) process.stdout.write(`    ${dim(line)}\n`);
  }
  return 0;
}

/**
 * `codex-workflow serve` — the standalone viewer for browsing the full run history (foreground;
 * blocks until signalled). Distinct from `run`'s in-process per-run viewer: this is a plain server
 * with no daemon/`web.json` state. Prefers port 4173 for a stable URL, or `--port` to pin one.
 */
export async function serveCommand(flags: RunFlags): Promise<number> {
  const dataDir = workflowDataDir();

  let requestedPort: number | undefined;
  if (flags.port !== undefined) {
    requestedPort = Number(flags.port);
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
      process.stderr.write("error: --port must be an integer 0–65535\n");
      return 2;
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

  process.stdout.write(`${green("✓")} Viewer running at ${bold(bound.url)}  ${dim("(Ctrl-C to stop)")}\n`);
  if (flags["no-open"] !== true) openBrowser(bound.url);

  const shutdown = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Stay alive until signalled; the server keeps serving in the meantime.
  return new Promise<number>(() => {});
}

/** `codex-workflow doctor` */
export async function doctorCommand(flags: RunFlags): Promise<number> {
  let ok = true;
  const required = (good: boolean, label: string, hint?: string) => {
    if (!good) ok = false;
    process.stdout.write(`${good ? green("✓") : red("✗")} ${label}${good || !hint ? "" : `\n    ${dim(hint)}`}\n`);
  };
  const optional = (good: boolean, label: string, hint?: string) => {
    process.stdout.write(`${good ? green("✓") : yellow("!")} ${label}${good || !hint ? "" : `\n    ${dim(hint)}`}\n`);
  };

  const bun = await tryExec("bun", ["--version"]);
  required(bun.ok, `Bun runtime${bun.ok ? ` (${bun.out.trim()})` : ""}`, "Install Bun: https://bun.sh — workflows execute in a Bun child process.");

  const dataDir = workflowDataDir();
  const cwd = path.resolve(flags.cwd ?? process.cwd());

  // Provider config is required for `run`. Validate it and collect the backends it actually uses.
  const usedBackends = new Set<string>();
  try {
    const configPath = await discoverProviderConfig(cwd, dataDir, flags.config);
    if (!configPath) {
      required(false, "provider config", "Required for `run`: create codex-workflow.config.ts (in this project or the data dir) or pass --config <path>.");
    } else {
      const { config } = await loadProviderConfig(configPath);
      const names = Object.keys(config.providers);
      for (const p of Object.values(config.providers)) usedBackends.add(p.backend);
      required(true, `provider config (${names.length}): ${dim(configPath)}`);
      process.stdout.write(`    ${dim(`providers: ${names.join(", ")}${config.default ? ` · default: ${config.default}` : ""} · backends: ${[...usedBackends].join(", ")}`)}\n`);
    }
  } catch (error) {
    required(false, "provider config", error instanceof Error ? error.message : String(error));
  }

  // Probe each backend CLI; required when the config uses it, otherwise just informational.
  const codex = await tryExec("codex", ["--version"]);
  const auth = await pathExists(path.join(os.homedir(), ".codex", "auth.json"));
  const gemini = await tryExec(process.env.CODEX_WORKFLOW_GEMINI_COMMAND ?? "gemini", ["--version"]);
  const pi = await tryExec(process.env.CODEX_WORKFLOW_PI_COMMAND ?? "pi", ["--version"]);
  const check = (used: boolean, good: boolean, label: string, hint: string) => (used ? required(good, label, hint) : optional(good, label, hint));

  check(usedBackends.has("codex"), codex.ok && auth, `Codex CLI + auth${codex.ok ? ` (${codex.out.trim()})` : ""}`, "Install Codex CLI and run `codex login`.");
  check(usedBackends.has("gemini"), gemini.ok, `Gemini CLI${gemini.ok ? ` (${gemini.out.trim()})` : ""}`, "Install the Gemini CLI, or set CODEX_WORKFLOW_GEMINI_COMMAND.");
  check(usedBackends.has("pi"), pi.ok, `pi CLI${pi.ok ? ` (${pi.out.trim()})` : ""}`, "Install pi (npm i -g @earendil-works/pi-coding-agent), or set CODEX_WORKFLOW_PI_COMMAND.");

  process.stdout.write(`${green("✓")} data dir: ${dataDir}\n`);
  process.stdout.write(`${dim("·")} viewer: ${dim("starts in-process per `run` (random port); `codex-workflow serve` browses history")}\n`);

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

async function buildRunInput(
  target: string,
  cwd: string,
  flags: RunFlags,
): Promise<WorkflowInput> {
  const args = await parseArgsValue(flags.args, cwd);
  const asPath = path.resolve(cwd, target);
  if (await isFile(asPath)) {
    return { scriptPath: asPath, ...(args !== undefined ? { args } : {}) };
  }
  if (looksLikeWorkflowPath(target)) {
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

/**
 * Discover + load the provider config for a run. A config is required (`--config` or an auto-discovered
 * `codex-workflow.config.*`); the token-free `CODEX_WORKFLOW_FAKE_AGENT` mode is the only exception,
 * since it has no real backend to route to.
 */
async function loadProviderConfigForRun(
  cwd: string,
  dataDir: string,
  flags: RunFlags,
): Promise<LoadedProviderConfig | undefined> {
  const configPath = await discoverProviderConfig(cwd, dataDir, flags.config);
  if (!configPath) {
    if (process.env.CODEX_WORKFLOW_FAKE_AGENT) return undefined;
    throw new WorkflowInputError(
      "no provider config found — create codex-workflow.config.ts in this project (or the data dir), or pass --config <path>. See README › Provider config.",
    );
  }
  return loadProviderConfig(configPath);
}

/**
 * Build the per-agent runner resolver, routing `agent({provider})` / `agent({model})` through the
 * loaded provider config. Provider runners are built lazily on first use and cached per provider:model.
 */
function buildAgentRunnerResolver(
  cwd: string,
  flags: RunFlags,
  dataDir: string,
  loaded: LoadedProviderConfig | undefined,
): WorkflowRunnerResolver {
  // No config is reachable only under CODEX_WORKFLOW_FAKE_AGENT — every agent gets the fake runner.
  if (!loaded) return () => buildAgentRunner(cwd, flags, dataDir);
  const factories: ProviderRunnerFactories = {
    forProvider: (_name, def, effectiveModel) => buildAgentRunner(cwd, providerDefToFlags(def, effectiveModel, flags), dataDir),
  };
  return buildRunnerResolver(loaded.config, factories, {
    ...(flags.provider ? { defaultProvider: flags.provider } : {}),
    source: loaded.path,
  });
}

/**
 * Project a {@link ProviderDef} onto a synthetic {@link RunFlags} so the existing per-backend runner
 * builders can consume it. The API key is read from `apiKeyEnv` here (in-memory only, never persisted);
 * run-level flags like `--agent-timeout` carry through unless the provider overrides them.
 */
function providerDefToFlags(def: ProviderDef, effectiveModel: string | undefined, base: RunFlags): RunFlags {
  const flags: RunFlags = { backend: def.backend };
  if (effectiveModel) flags.model = effectiveModel;
  const timeout = def.agentTimeoutMs !== undefined ? String(def.agentTimeoutMs) : base["agent-timeout"];
  if (timeout !== undefined) flags["agent-timeout"] = timeout;
  if (def.baseInstructions) flags.baseInstructions = def.baseInstructions;
  if (def.backend === "codex") {
    if (def.sandbox) flags.sandbox = def.sandbox;
    if (def.approval) flags.approval = def.approval;
    if (def.reasoning) flags.reasoning = def.reasoning;
    if (def.webSearch !== undefined) flags.webSearch = def.webSearch;
    if (def.networkAccess !== undefined) flags.networkAccess = def.networkAccess;
    if (def.webSearchMode) flags.webSearchMode = def.webSearchMode;
  } else if (def.backend === "gemini") {
    if (def.geminiCommand) flags["gemini-command"] = def.geminiCommand;
    if (def.yolo !== undefined) flags.yolo = def.yolo;
    if (def.args?.length) flags.extraArgs = def.args;
  } else {
    if (def.piCommand) flags["pi-command"] = def.piCommand;
    if (def.piProvider) flags["pi-provider"] = def.piProvider;
    if (def.baseUrl) flags["base-url"] = def.baseUrl;
    if (def.api) flags["pi-api"] = def.api;
    if (def.apiKeyEnv) {
      const key = process.env[def.apiKeyEnv];
      if (key) flags["api-key"] = key; // in-memory only; never written to a record or the generated models.json
    }
    if (def.thinking) flags.thinking = def.thinking;
    if (def.tools?.length) flags.tools = def.tools.join(",");
    if (def.excludeTools?.length) flags["exclude-tools"] = def.excludeTools.join(",");
    if (def.noTools) flags["no-tools"] = true;
    if (def.approve !== undefined) flags.approve = def.approve;
    if (def.contextFiles !== undefined) flags.contextFiles = def.contextFiles;
    if (def.args?.length) flags.extraArgs = def.args;
  }
  return flags;
}

function buildAgentRunner(cwd: string, flags: RunFlags, dataDir: string): WorkflowAgentRunner {
  if (process.env.CODEX_WORKFLOW_FAKE_AGENT) return new FakeAgentRunner();

  const backend = resolveBackend(flags.backend);
  if (backend === "gemini") return buildGeminiRunner(cwd, flags);
  if (backend === "pi") return buildPiRunner(cwd, flags, dataDir);
  return buildCodexRunner(cwd, flags);
}

function buildCodexRunner(cwd: string, flags: RunFlags): WorkflowAgentRunner {
  const options: CodexSdkAgentRunnerOptions = { cwd };
  if (flags.model) options.model = flags.model;
  if (flags.sandbox) options.sandboxMode = assertOneOf(flags.sandbox, SANDBOX_MODES, "sandbox") as SandboxMode;
  if (flags.approval) options.approvalPolicy = assertOneOf(flags.approval, APPROVAL_MODES, "approval") as ThreadOptions["approvalPolicy"];
  const reasoning = flags.reasoning ?? flags.reasoningEffort;
  if (reasoning) options.modelReasoningEffort = assertOneOf(reasoning, REASONING_EFFORTS, "reasoning") as ThreadOptions["modelReasoningEffort"];
  const codexTimeout = parseAgentTimeoutFlag(flags["agent-timeout"]);
  if (codexTimeout !== undefined) options.agentTimeoutMs = codexTimeout;
  if (flags.baseInstructions) options.baseInstructions = flags.baseInstructions;
  // Web search + network access default on (a provider config may opt out per provider).
  options.webSearchEnabled = flags.webSearch ?? true;
  options.networkAccessEnabled = flags.networkAccess ?? true;
  if (flags.webSearchMode) options.webSearchMode = flags.webSearchMode as ThreadOptions["webSearchMode"];
  return new CodexSdkAgentRunner(options);
}

function buildGeminiRunner(cwd: string, flags: RunFlags): WorkflowAgentRunner {
  const options: GeminiCliAgentRunnerOptions = { cwd };
  options.command = flags["gemini-command"] ?? process.env.CODEX_WORKFLOW_GEMINI_COMMAND ?? "gemini";
  if (flags.model) options.model = flags.model;
  const geminiTimeout = parseAgentTimeoutFlag(flags["agent-timeout"]);
  if (geminiTimeout !== undefined) options.agentTimeoutMs = geminiTimeout;
  if (flags.baseInstructions) options.baseInstructions = flags.baseInstructions;
  if (flags.extraArgs) options.args = flags.extraArgs;
  if (flags.yolo !== undefined) options.yolo = flags.yolo;
  return new GeminiCliAgentRunner(options);
}

function buildPiRunner(cwd: string, flags: RunFlags, dataDir: string): WorkflowAgentRunner {
  const options: PiCliAgentRunnerOptions = { cwd };
  options.command = flags["pi-command"] ?? process.env.CODEX_WORKFLOW_PI_COMMAND ?? "pi";
  // pi writes session JSONL here; the viewer reads linked sessions from the same path.
  options.sessionDir = piSessionsDir(dataDir);
  if (flags.model) options.model = flags.model;
  if (flags["pi-provider"]) options.provider = flags["pi-provider"];
  if (flags["base-url"]) {
    options.baseUrl = flags["base-url"];
    // A custom endpoint needs a config home to host the generated models.json.
    options.agentDir = piHomeDir(dataDir);
  }
  if (flags["api-key"]) options.apiKey = flags["api-key"];
  if (flags["pi-api"]) {
    options.api = assertOneOf(flags["pi-api"], PI_API_SHAPES, "api") as NonNullable<PiCliAgentRunnerOptions["api"]>;
  }
  if (flags.thinking) options.thinking = assertOneOf(flags.thinking, REASONING_EFFORTS, "thinking");
  if (flags["no-tools"]) options.noTools = true;
  if (flags.tools) options.tools = splitList(flags.tools);
  if (flags["exclude-tools"]) options.excludeTools = splitList(flags["exclude-tools"]);
  if (flags.baseInstructions) options.baseInstructions = flags.baseInstructions;
  if (flags.extraArgs) options.args = flags.extraArgs;
  if (flags.approve !== undefined) options.approve = flags.approve;
  if (flags.contextFiles !== undefined) options.contextFiles = flags.contextFiles;
  const piTimeout = parseAgentTimeoutFlag(flags["agent-timeout"]);
  if (piTimeout !== undefined) options.agentTimeoutMs = piTimeout;

  if (options.baseUrl && !options.model) {
    throw new WorkflowInputError("a pi provider with `baseUrl` requires `model` (the model id sent to the endpoint)");
  }
  return new PiCliAgentRunner(options);
}

function splitList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveBackend(raw: string | undefined): AgentBackend {
  const value = raw ?? "codex";
  return assertOneOf(value, [...AGENT_BACKENDS], "provider backend") as AgentBackend;
}

/** Snapshots the provider config + run default a run used so `resume` reloads the same routing. */
function resolveRunnerConfig(flags: RunFlags, loaded?: LoadedProviderConfig): RunnerConfig {
  const config: RunnerConfig = {};
  if (loaded) {
    config.configPath = loaded.path;
    config.configHash = loaded.hash;
  }
  if (flags.provider) config.defaultProvider = flags.provider;
  return config;
}

/** Parses `--agent-timeout` (ms): a non-negative number, where 0 disables the timeout. */
function parseAgentTimeoutFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const timeout = Number(raw);
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new WorkflowInputError(`--agent-timeout must be a non-negative number of ms (0 disables), got "${raw}"`);
  }
  return timeout;
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

/** `--agent-retries <n>` → agentMaxAttempts = n + 1 (n retries means n+1 total attempts). */
function agentAttemptsFlag(raw: string | undefined): { agentMaxAttempts?: number } {
  if (raw === undefined) return {};
  const retries = Number(raw);
  if (!Number.isFinite(retries) || retries < 0) throw new WorkflowInputError(`--agent-retries must be a non-negative number, got "${raw}"`);
  return { agentMaxAttempts: Math.trunc(retries) + 1 };
}

function looksLikeWorkflowPath(target: string): boolean {
  return target.includes("/") || target.includes("\\") || /\.(m?[jt]s)$/.test(target);
}

/** Parses meta.phases titles for the declared pipeline order. Best-effort (CLI runs are path-based). */
async function readDeclaredPhases(input: WorkflowInput): Promise<string[] | undefined> {
  try {
    const script = input.scriptPath ? await readFile(String(input.scriptPath), "utf8") : input.script;
    if (!script) return undefined;
    const phases = parseWorkflowScript(script).meta.phases;
    return phases?.length ? phases.map((phase) => phase.title) : undefined;
  } catch {
    return undefined; // fall back to executed-phase order
  }
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

async function tryExec(cmd: string, args: string[], timeoutMs = 5000): Promise<{ ok: boolean; out: string }> {
  try {
    // `doctor` probes external binaries (bun/codex/gemini --version); a misbehaving same-named binary
    // on PATH must not hang the whole check, so cap each probe with a timeout (SIGTERM on expiry).
    const { stdout } = await exec(cmd, args, { timeout: timeoutMs });
    return { ok: true, out: stdout };
  } catch {
    return { ok: false, out: "" };
  }
}

function printRunSummary(
  name: string,
  runId: string,
  stats: { agentCount: number; cacheHits: number; durationMs: number; phases: string[]; failures: { label: string }[] },
  scriptPath?: string,
): void {
  const failed = stats.failures.length;
  const failedSuffix = failed > 0 ? `, ${yellow(`${failed} failed`)}` : "";
  process.stderr.write(
    `\n${green("✓")} ${bold(name)} ${dim(`(${runId})`)} — ${stats.agentCount} agents, ${stats.cacheHits} cached${failedSuffix}, ${(stats.durationMs / 1000).toFixed(1)}s\n`,
  );
  if (scriptPath) {
    process.stderr.write(`${dim(`  Iterate: edit ${scriptPath} then re-run`)}\n`);
  }
  process.stderr.write(`${dim(`  Resume (reuse completed agents): codex-workflow resume ${runId}`)}\n`);
  if (failed > 0) {
    process.stderr.write(`${dim(`  ${failed} agent(s) failed — \`resume ${runId}\` will re-attempt them.`)}\n`);
  }
  process.stderr.write("\n");
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
