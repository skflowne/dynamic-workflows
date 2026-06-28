#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  doctorCommand,
  listCommand,
  resumeCommand,
  runCommand,
  runsCommand,
  serveCommand,
  showCommand,
  validateCommand,
  type RunFlags,
} from "./cli/commands.js";

const OPTIONS = {
  args: { type: "string" },
  config: { type: "string" },
  provider: { type: "string" },
  concurrency: { type: "string" },
  budget: { type: "string" },
  "max-agents": { type: "string" },
  "agent-retries": { type: "string" },
  "agent-timeout": { type: "string" },
  cwd: { type: "string" },
  bun: { type: "string" },
  "idle-timeout": { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  "no-progress": { type: "boolean" },
  port: { type: "string" },
  open: { type: "boolean" },
  "no-open": { type: "boolean" },
  "no-web": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const HELP = `codex-workflow — run Claude-compatible dynamic workflows, backed by Codex, Gemini CLI, or pi.

Usage:
  codex-workflow run <file|name> [options]   Run a workflow file or registered name
  codex-workflow resume <runId> [options]    Re-run a recorded run, reusing its cached agents
  codex-workflow list [--json]               List workflows from .claude/workflows and ~/.claude/workflows
  codex-workflow serve [--port N] [--open]   Start the local web viewer for runs
  codex-workflow validate <file> [--json]    Parse & validate a workflow (no tokens used)
  codex-workflow runs [--json]               List recorded run history
  codex-workflow show <runId> [--json]       Show a recorded run
  codex-workflow doctor                      Check Bun, agent backends, the provider config, and the viewer

Run options:
  --args <json|@file.json>   Arguments passed to the workflow as \`args\`
  --config <path>            Provider config file (TS/JS); auto-discovers codex-workflow.config.* in cwd / data dir
  --provider <name>          Run-level default provider from the config (per-agent: agent({provider}))
  --concurrency <n>          Max concurrent agents (capped at 16)
  --budget <tokens>          Token budget (estimate) shared across the run
  --max-agents <n>           Hard cap on total agent() calls (default 1000)
  --agent-retries <n>        Retries per agent on transient failure (default 2; agent() returns null when exhausted)
  --agent-timeout <ms>       Per-agent total-duration timeout in ms (0 disables; default 900000)
  --cwd <dir>                Working directory for agents (default: cwd)
  --bun <path>               Path to the Bun binary
  --idle-timeout <ms>         Bun child idle watchdog in ms (0 disables; default 300000)
  --json                     Emit machine-readable JSON (suppresses progress & viewer)
  --quiet                    Suppress progress output
  --no-progress              Plain (non-TTY) progress lines

Viewer:
  run starts an in-process viewer on a random port (lives for the run; stays up
  after it finishes in a terminal until Ctrl-C). serve is a standalone viewer for
  browsing all past runs.
  --port <n>                 Viewer port for \`serve\` (default 4173 or a free port)
  --open                     Open the run's viewer in the browser (run)
  --no-open                  Do not open a browser (serve)
  --no-web                   Do not start the viewer during \`run\`

  -h, --help                 Show this help
  -v, --version              Show version

Workflows are open TS/JS executed under Bun; each agent() spawns an independent backend session.
Every run needs a provider config (codex-workflow.config.ts) that names the backends/models; it is
auto-discovered in the project dir or the data dir, or passed with --config. Route a call with
agent({provider:"name"}) or agent({model:"id"}), or set a run default with --provider / config.default.
Pass run a path to a workflow file (e.g. examples/deep-research.js).
Bare names resolve from .claude/workflows and ~/.claude/workflows.
resume restores the workflow's script path / name and args from the run record
(reusing completed agents from its journal); --args and other flags override.
`;

async function main(): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(2), options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n\nRun \`codex-workflow --help\` for usage.\n`);
    return 2;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];
  const target = positionals[1];

  if (values.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }
  if (values.help || command === undefined || command === "help") {
    process.stdout.write(HELP);
    return command === undefined && !values.help ? 1 : 0;
  }

  const flags = values as RunFlags & { cwd?: string; json?: boolean };

  switch (command) {
    case "run":
      return runCommand(target, flags);
    case "resume":
      return resumeCommand(target, flags);
    case "list":
      return listCommand(flags);
    case "serve":
      return serveCommand(flags);
    case "validate":
      return validateCommand(target, flags);
    case "runs":
      return runsCommand(flags);
    case "show":
      return showCommand(target, flags);
    case "doctor":
      return doctorCommand(flags);
    default:
      process.stderr.write(`error: unknown command "${command}"\n\nRun \`codex-workflow --help\` for usage.\n`);
      return 2;
  }
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return `codex-workflow ${pkg.version ?? "0.0.0"}`;
  } catch {
    return "codex-workflow (unknown version)";
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
