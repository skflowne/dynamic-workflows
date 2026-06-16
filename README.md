# codex-dynamic-workflows

Run **Claude Code-style dynamic workflows** from the command line, backed by **OpenAI Codex**,
**Gemini CLI**, or **pi** (the pi-coding-agent harness, which also reaches any OpenAI/Anthropic-
compatible endpoint) — with a **live visual run viewer** that shows the whole pipeline, every step's
progress, and the complete agent result behind each step.

A workflow is an open TypeScript/JavaScript script with a `meta` block and top-level `await`. The
orchestration primitives — `agent()`, `parallel()`, `pipeline()`, `workflow()`, `phase()`, `log()`,
`args`, `budget` — are injected by the runtime. Each `agent()` call runs as an independent backend
session: a Codex thread by default, a fresh Gemini CLI process with `--backend gemini`, or a fresh pi
process with `--backend pi`. The script body itself executes unrestricted under **Bun**.

```bash
codex-workflow run examples/deep-research.js --args '"what changed in the API?"'   # auto-starts the viewer
```

The CLI binary is named `codex-workflow`.

## Why

Claude Code ships a built-in `Workflow` tool for fan-out/verify/synthesize orchestration. This brings
the same authoring model to Codex users as a standalone CLI: the same script shape runs unchanged,
but the subagents can run through Codex using your local `codex login` credentials, through Gemini
CLI using your local Gemini CLI authentication, or through **pi** — a full agentic harness (file +
shell tools) that you can point at any OpenAI/Anthropic-compatible API (OpenAI, DeepSeek, vLLM,
Ollama, LiteLLM, …) via `--base-url`.

## Requirements

- **Node 20+** (uses `node:util` `parseArgs`, `AbortSignal.any`).
- **[Bun](https://bun.sh)** — workflow scripts execute in a Bun child process.
- **[Codex CLI](https://github.com/openai/codex)** authenticated via `codex login` (the SDK reuses
  `~/.codex/auth.json`) for the default `codex` backend.
- **Gemini CLI** for `--backend gemini`.
- **[pi](https://pi.dev)** (`npm i -g @earendil-works/pi-coding-agent`) for `--backend pi`; supply
  credentials via a provider env var (e.g. `OPENAI_API_KEY`), `--api-key`, or `--base-url` + `--api-key`
  for a custom OpenAI/Anthropic-compatible endpoint.
- Only one real agent backend is needed for `run`; none is needed for `validate`/`list`.

## Install

```bash
npm install
npm run build      # builds the React viewer into web/ and emits dist/, including dist/cli.js
npm link           # optional: exposes `codex-workflow` on your PATH
```

Check your environment:

```bash
codex-workflow doctor
```

## CLI

```text
codex-workflow run <file|name> [options]   Run a workflow file or registered name
codex-workflow resume <runId> [options]    Re-run a recorded run, reusing its cached agents
codex-workflow list [--json]               List workflows from .claude/workflows and ~/.claude/workflows
codex-workflow serve [--port N] [--open]   Start the local web viewer for runs
codex-workflow validate <file> [--json]    Parse & validate a workflow (no tokens used)
codex-workflow runs [--json]               List recorded run history
codex-workflow show <runId> [--json]       Show a recorded run
codex-workflow doctor                      Check Bun, selected agent backend, and the viewer
```

`run` takes a workflow file path (absolute or relative) or a bare registered name. Name lookup scans
project `.claude/workflows` and user `~/.claude/workflows`; file-like targets (`./x.js`, `x.ts`,
etc.) are treated as paths and report a file-not-found error if missing.

`resume <runId>` re-runs a previously recorded run: it reconstructs the script path / registered name
**and** the original `args` straight from the run record, and reuses every completed `agent()` call
from that run's journal cache (only failed/unrun agents re-execute). Pressing Ctrl-C during a run
cancels it cleanly and prints the `resume` command to pick it back up. The run options below also
apply to `resume` — pass `--args` (or most flags) there to override what was recorded. The **backend**
(plus `--model` / `--gemini-command`, and the pi backend's `--pi-command` / `--provider` / `--base-url`
/ `--pi-api` / `--thinking` / `--tools` / `--exclude-tools` / `--no-tools` — but **not** the API key,
which resume re-reads from `--api-key` or the provider env var) is inherited from the record when
omitted; an explicit `--backend` that conflicts with the recorded one is refused, since the journal
cache is not backend-aware and resuming under a different backend would silently mix results.

Run options:

| Flag | Meaning |
| --- | --- |
| `--args <json\|@file.json>` | Value exposed to the script as `args` |
| `--backend <codex\|gemini\|pi>` | Agent backend (default: `codex`; can also use `CODEX_WORKFLOW_BACKEND`) |
| `--model <model>` | Model for every `agent()` call on the selected built-in backend |
| `--concurrency <n>` | Max concurrent agents (capped at 16) |
| `--budget <tokens>` | Token budget (estimate) shared across the run |
| `--max-agents <n>` | Hard cap on total `agent()` calls (default 1000) |
| `--cwd <dir>` | Working directory for agents |
| `--sandbox <mode>` | Codex only: `read-only` \| `workspace-write` \| `danger-full-access` |
| `--approval <policy>` | Codex only: `never` \| `on-request` \| `on-failure` \| `untrusted` |
| `--reasoning <effort>` | Codex only: `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `--provider <name>` | pi only: backend provider (e.g. `openai`, `anthropic`, `deepseek`) |
| `--base-url <url>` | pi only: custom OpenAI/Anthropic-compatible endpoint (requires `--model`) |
| `--api-key <key>` | pi only: API key (or set the provider's env var, e.g. `OPENAI_API_KEY`) |
| `--pi-api <shape>` | pi only: `openai-completions` (default) \| `openai-responses` \| `anthropic-messages` \| `google-generative-ai` |
| `--thinking <level>` | pi only: `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `--tools` / `--exclude-tools <list>` | pi only: comma-separated tool allowlist / denylist |
| `--no-tools` | pi only: disable all tools (a pure text turn) |
| `--bun <path>` | Path to the Bun binary |
| `--gemini-command <path>` | Gemini CLI executable for `--backend gemini` (or `CODEX_WORKFLOW_GEMINI_COMMAND`) |
| `--pi-command <path>` | pi executable for `--backend pi` (or `CODEX_WORKFLOW_PI_COMMAND`) |
| `--idle-timeout <ms>` | Bun child idle watchdog in milliseconds (`0` disables; default 300000) |
| `--json` | Machine-readable output to stdout (suppresses progress) |
| `--quiet` / `--no-progress` | Reduce / plainify progress output |

For the Codex backend, web search + network access are **always enabled** for agents. The pi backend
runs with its full built-in tool set (read/bash/edit/write/grep/find/ls) plus `--approve` by default;
narrow it with `--tools` / `--exclude-tools` / `--no-tools`. For a custom `--base-url`, the runner
generates a pi `models.json` describing the endpoint and injects the API key via env (never written to
disk); omit `--api-key` for keyless endpoints (Ollama, vLLM, …) and a placeholder is sent instead. pi
exits 0 even on a model error, so failures are detected from the turn's stop reason.

Run history, the per-agent journal, and session links are recorded in a **global** data dir,
`~/.codex-workflow/` (override with `CODEX_WORKFLOW_HOME`), so runs from every project are shared by
one store and one viewer.

### Example

```bash
# Validate, then run a bundled example without spending tokens:
codex-workflow validate examples/hello.js
CODEX_WORKFLOW_FAKE_AGENT=1 codex-workflow run examples/hello.js --args '{"name":"Ada"}'

# Real run, JSON result piped to jq:
codex-workflow run examples/hello.js --args '{"name":"Ada"}' --json | jq .result

# Real Gemini CLI run:
codex-workflow run examples/hello.js --backend gemini --model gemini-3.5-flash --args '{"name":"Ada"}'

# Real pi run against a custom OpenAI-compatible endpoint (e.g. DeepSeek):
codex-workflow run examples/hello.js --backend pi \
  --base-url https://api.deepseek.com --api-key "$DEEPSEEK_API_KEY" --model deepseek-v4-flash \
  --args '{"name":"Ada"}'
```

`examples/nested-demo.js` demonstrates the `workflow()` nesting primitive (nesting by path; registered
names work when the target workflow is in a discovered workflow directory).

### `examples/`

Sample scripts you run by **path** (`codex-workflow run examples/<file>`).

- `hello.js` — minimal `agent()` + `parallel()` demo.
- `nested-demo.js` — `workflow()` nesting by path (`workflow('examples/hello.js', …)`); run from the repo root.
- `complex-chain.js`, `live-check.js` — small original demos.
- `deep-research.js` — Claude Code's built-in `deep-research` workflow (fan-out → fetch → 3-vote
  verify → synthesize); runnable here as-is.
- `code-review.js` — Claude Code's built-in hidden `code-review` workflow. **Reference only**: it was
  extracted from the compiled client with unresolved `${…}` template placeholders, so it does not
  parse/run; it's included to document the find → verify → synthesize architecture.

## Viewer

A local web viewer (zero server-side runtime dependencies: Node's `http` serves a bundled React/TypeScript SPA) visualizes runs:

- **Pipeline flow graph** — phases wired together; click one to expand a fan of its agent nodes.
- **Per-step progress** — agents appear as "running" placeholders the moment they start (phase badges
  show `done/total`), then flip to ✓ / ✕ as they finish.
- **Per-agent detail** — drill into any agent to see its prompt and structured result; Codex-backed
  runs also link the complete rollout with messages, reasoning, web searches, tool calls, and usage.
- **Input & Result** — the workflow's `args` and final return value, rendered top and bottom.
- **Live** — the page streams updates over SSE (logs, phase progress, status) with no refresh.

`run` **auto-starts a viewer in-process on a random port** (unless `--json` or `--no-web`) and prints
its URL, so you can watch that run live. The server lives for the duration of the run; when you're in a
terminal it then **stays up until you press Ctrl-C** so you can inspect the result, and exits
immediately when the output is piped/scripted. Each `run` is its own ephemeral server — there is no
shared resident daemon.

To browse **all** past runs, start the standalone viewer (foreground; Ctrl-C to stop):

```bash
codex-workflow serve            # opens http://127.0.0.1:4173 (or --port N)
```

## Workflow API

```js
export const meta = {
  name: 'review-changes',
  description: 'Review the diff across dimensions and verify each finding.',
  whenToUse: 'After a logical chunk of work.',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

phase('Review')
const findings = await pipeline(
  DIMENSIONS,
  (d) => agent(d.prompt, { label: 'review:' + d.key, phase: 'Review', schema: FINDINGS }),
  (review) => parallel(review.findings.map((f) => () =>
    agent('Adversarially verify: ' + f.title, { phase: 'Verify', schema: VERDICT })))
)
return { findings: findings.flat().filter(Boolean) }
```

- `agent(prompt, opts?)` — spawn one subagent on the selected backend. Options: `label`, `phase`,
  `schema` (JSON Schema → validated structured output), `model`, `agentType`, `isolation:
  'worktree'` (runs in a fresh detached git worktree). Built-in Codex/Gemini/pi runners intentionally
  ignore workflow-authored `model` values (`agent({ model })` and `meta.phases[].model`) so Claude
  workflows with hard-coded model names remain portable; use CLI/library `--model` / runner options
  to choose the backend model. `agentType` is prompt context only; the backends do not load Claude's
  built-in agent definitions or tool bundles. Without a schema it returns the final text; with a
  schema it returns the validated object. Neither Gemini CLI nor pi receives a native JSON schema, so
  schema correctness is enforced by the workflow runtime and failed validation is retried like any
  other agent failure.
- `parallel(thunks)` — run `() => …` thunks concurrently; a thrown thunk resolves to `null`.
- `pipeline(items, stage1, stage2, …)` — run each item through all stages independently (no barrier);
  stages receive `(prevResult, originalItem, index)`; a throwing stage drops the item to `null`.
- `workflow(ref, args?)` — run another workflow inline (one level deep), sharing this run's
  concurrency limiter, agent-count cap, token budget, journal, and abort signal. `ref` is a path to a
  workflow file or registered name — a path-like string (`'./other.js'`) or `{ scriptPath }`, resolved
  relative to the run `cwd`, or a bare name resolved from the workflow registry.
- `phase(title)`, `log(message)`, `args`, `budget` (`total`, `spent()`, `remaining()` — shared across
  the root and nested workflows).

### Compatibility note (intentional divergence)

Claude blocks `Date.now()` / `Math.random()` / `new Date()` inside workflow scripts to keep replay
deterministic. **codex-workflow runs scripts as open, unrestricted TS/JS under Bun** — a Claude
workflow is a runnable subset, and you may additionally use anything Bun/Node provide (imports, the
filesystem, `Bun`, etc.). Resume is therefore *best-effort*: completed `agent()` calls are cached in a
journal keyed by prompt+options+runId and reused on `resume`, but non-deterministic script logic is
not snapshotted.

Codex structured output also requires stricter JSON Schema than Claude. The Codex runner sends a
strict copy to Codex while preserving the original schema for runtime validation; optional fields are
represented as nullable in the strict copy and stripped back out before loose-schema validation.

## Library use

The CLI is built on a small library you can embed:

```ts
import { CodexSdkAgentRunner, GeminiCliAgentRunner, PiCliAgentRunner, WorkflowController } from "codex-workflow";

const controller = new WorkflowController({
  runner: new CodexSdkAgentRunner({ cwd: process.cwd() }),
  concurrency: 8,
});

const geminiController = new WorkflowController({
  runner: new GeminiCliAgentRunner({ cwd: process.cwd(), model: "gemini-3.5-flash" }),
});

// pi against a custom OpenAI-compatible endpoint. `agentDir` hosts the generated models.json;
// `sessionDir` is where pi writes session JSONL (point the viewer at the same path).
const piController = new WorkflowController({
  runner: new PiCliAgentRunner({
    cwd: process.cwd(),
    baseUrl: "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: "deepseek-v4-flash",
    agentDir: "/tmp/pi-home",
    sessionDir: "/tmp/pi-sessions",
  }),
});

const output = await controller.run({ scriptPath: "examples/deep-research.js", args: "What changed?" });
// or inline: controller.run({ script, args })
// background: controller.launch() -> taskId, controller.wait(taskId), controller.cancel(taskId)
```

`runWorkflow`, `runWorkflowTool`, `FileWorkflowJournal`, `FileRunStore`, and `ScriptedAgentRunner` are
also exported. `WorkflowRegistry` / `buildWorkflowResolver` remain available for embedders who want
custom name-based discovery.

## Architecture

```text
codex-workflow run
  -> WorkflowController
       -> runWorkflowTool() (blocking) / WorkflowTaskManager (async launch/wait/cancel)
       -> resolve script | name | scriptPath, parseWorkflowScript()
       -> runWorkflow()
            -> shared RunContext: concurrency limiter, agent-count cap, token budget, journal, abort
            -> Bun child process executes the open TS/JS body
            -> JSONL IPC routes agent()/workflow()/phase()/log() back to the parent
                 -> CodexSdkAgentRunner  (real Codex threads)
                 -> GeminiCliAgentRunner (real Gemini CLI processes)
                 -> PiCliAgentRunner     (real pi processes; OpenAI/Anthropic-compatible via --base-url)
                 -> ScriptedAgentRunner  (deterministic tests)
       -> FileRunStore records run history -> `runs` / `show`
```

## Verify

```bash
npm test                  # build + unit suite (scripted runner; no tokens)
npm run typecheck         # tsc over src + tests
npm run test:deepresearch # runs the real Claude deep-research workflow against a stubbed runner
```

The live Codex, Gemini, and pi paths are gated to avoid spending tokens / external service calls:

```bash
RUN_CODEX_SDK_LIVE=1 npm test
RUN_GEMINI_CLI_LIVE=1 npm test
# pi: set PI_CLI_MODEL/PI_CLI_PROVIDER, or PI_CLI_BASE_URL + PI_CLI_API_KEY for a custom endpoint.
RUN_PI_CLI_LIVE=1 PI_CLI_BASE_URL=https://api.deepseek.com PI_CLI_API_KEY=sk-... PI_CLI_MODEL=deepseek-v4-flash npm test
```

`test:deepresearch` runs the vendored `deep-research` workflow (`examples/deep-research.js`) against a
stubbed runner. (Override the path with `DEEP_RESEARCH_WORKFLOW_PATH`.)

## Not included (yet)

- MCP server / in-Codex tool registration (this is a standalone CLI by design).
- Remote/cloud workflows; a long-running background daemon.
- Claude built-in agent definitions/tool bundles behind `agentType`; selected backends receive
  `agentType` as prompt context only.
