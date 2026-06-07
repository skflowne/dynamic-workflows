#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  doctorCommand,
  listCommand,
  runCommand,
  runsCommand,
  serveCommand,
  showCommand,
  validateCommand,
  type RunFlags,
} from "./cli/commands.js";

const OPTIONS = {
  args: { type: "string" },
  model: { type: "string" },
  concurrency: { type: "string" },
  budget: { type: "string" },
  "max-agents": { type: "string" },
  resume: { type: "string" },
  cwd: { type: "string" },
  sandbox: { type: "string" },
  approval: { type: "string" },
  reasoning: { type: "string" },
  bun: { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean" },
  "no-progress": { type: "boolean" },
  port: { type: "string" },
  open: { type: "boolean" },
  "no-open": { type: "boolean" },
  "no-web": { type: "boolean" },
  daemon: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

const HELP = `codex-workflow — run Claude-compatible dynamic workflows, backed by Codex.

Usage:
  codex-workflow run <file|name> [options]   Run a workflow (foreground, live progress)
  codex-workflow serve [--port N] [--open]   Start the local web viewer for runs
  codex-workflow list [--json]               List discovered workflows
  codex-workflow validate <file> [--json]    Parse & validate a workflow (no tokens used)
  codex-workflow runs [--json]               List recorded run history
  codex-workflow show <runId> [--json]       Show a recorded run
  codex-workflow doctor                      Check Bun, Codex CLI, auth, and workflow dirs

Run options:
  --args <json|@file.json>   Arguments passed to the workflow as \`args\`
  --model <model>            Codex model for every agent() call
  --concurrency <n>          Max concurrent agents (capped at 16)
  --budget <tokens>          Token budget (estimate) shared across the run
  --max-agents <n>           Hard cap on total agent() calls (default 1000)
  --resume <runId>           Reuse a prior run's journal cache
  --cwd <dir>                Working directory for agents (default: cwd)
  --sandbox <mode>           read-only | workspace-write | danger-full-access
  --approval <policy>        never | on-request | on-failure | untrusted
  --reasoning <effort>       minimal | low | medium | high | xhigh
  --bun <path>               Path to the Bun binary
  --json                     Emit machine-readable JSON (suppresses progress & viewer)
  --quiet                    Suppress progress output
  --no-progress              Plain (non-TTY) progress lines

Viewer options (run / serve):
  --port <n>                 Viewer port (serve; default 4173 or a free port)
  --open                     Open the viewer in the browser
  --no-open                  Do not open a browser (serve)
  --no-web                   Do not auto-start the viewer during \`run\`

  -h, --help                 Show this help
  -v, --version              Show version

Workflows are open TS/JS executed under Bun; each agent() spawns a Codex thread.
Web search + network access are always enabled for agents.
Discovered from: ./.claude/workflows, ~/.claude/workflows, ~/.codex/workflows.
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
    case "serve":
      return serveCommand(flags);
    case "list":
      return listCommand(flags);
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
