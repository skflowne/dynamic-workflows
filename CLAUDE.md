# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`codex-workflow` is a CLI + library that runs **Claude Code-style dynamic workflows** on top of
pluggable agent backends (**OpenAI Codex** by default, **Gemini CLI** with `--backend gemini`, and
**pi** — the pi-coding-agent harness — with `--backend pi`, which also reaches any OpenAI/Anthropic-
compatible endpoint via `--base-url`). A
workflow is an open TS/JS script with a `meta` block and top-level `await`; the
orchestration primitives (`agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`,
`budget`) are injected at runtime. Each `agent()` call runs as an independent backend session. The
CLI is the primary deliverable; the library underneath is reused by it.

## Commands

```bash
npm run build          # tsc -> dist/ (emits dist/index.js AND dist/cli.js — the bin)
npm test               # build + full unit suite (ScriptedAgentRunner, no tokens)
npm run test:unit      # unit suite only (requires a prior build for tests that spawn dist/cli.js)
npm run typecheck      # tsc over src + tests via tsconfig.test.json (no emit)
npm run test:deepresearch   # runs the real Claude deep-research gist against a stubbed runner

# Run a single test file:
npx tsx --test tests/nested-workflow.test.ts

# CLI smoke (token-free fake runner — see env flags below):
CODEX_WORKFLOW_FAKE_AGENT=1 node dist/cli.js run examples/hello.js --args '{"name":"Ada"}'
node dist/cli.js list            # lists .claude/workflows and ~/.claude/workflows
node dist/cli.js doctor          # checks Bun, selected backend, workflow dirs, viewer
node dist/cli.js serve --port 4173   # local web viewer (overview + per-step detail)
```

- **`CODEX_WORKFLOW_FAKE_AGENT=1`** makes the CLI use a built-in deterministic runner (returns
  `fake:<prompt>` / `"{}"`), so `run` works without Codex/tokens. Used by `tests/cli.test.ts`.
- **`RUN_CODEX_SDK_LIVE=1`** un-gates the one live Codex SDK test (spends tokens). Off by default.
- **`RUN_GEMINI_CLI_LIVE=1`** un-gates the one live Gemini CLI smoke test. Off by default.
- **`RUN_PI_CLI_LIVE=1`** un-gates the one live pi smoke test (set `PI_CLI_MODEL`/`PI_CLI_PROVIDER`
  or `PI_CLI_BASE_URL`+`PI_CLI_API_KEY`). Off by default.
- Requires **Bun** (workflow bodies execute in a Bun child) and exactly one real agent backend for
  real runs: Codex CLI authenticated via `codex login` for `--backend codex`, Gemini CLI for
  `--backend gemini`, or `pi` (npm `@earendil-works/pi-coding-agent`) for `--backend pi`.

## Architecture (the mental model matters most)

The "orchestrator" is **deterministic code (the workflow script), not an LLM**. Subagents are
isolated and stateless; they never share context with each other. Data flows between steps because
the *script* holds each `agent()`'s return value in a variable and embeds it into the next agent's
prompt. Fan-out → collect → (pure-code transform | feed into next agents | synthesize) is the whole
pattern. Understanding this explains everything below.

### Two-process execution + IPC (`src/runtime.ts`)
`runWorkflow()` spawns a **Bun child process** running a generated source (`bunRunnerSource`) that
contains the workflow body inside `__workflow_main()`, with the primitives injected as globals.
Parent ↔ child talk over **JSONL on stdio**, every line prefixed `__CODEX_WORKFLOW_IPC__`:
- child → parent **requests**: `{type:"agent"}` and `{type:"workflow"}` (parent fulfills, replies
  with `{kind:"response", value, spent}`); **events**: `phase`/`log`; terminal `result`/`error`.
- The child resolves an agent's `phase` locally (from `phase()` calls) and sends it in the request,
  so the parent holds no global "current phase" — this keeps concurrent/nested phases race-free.
- The Bun child has an idle watchdog (`workflowIdleTimeoutMs`, default 300000ms). It is armed only
  when the child is not waiting on a parent-handled `agent()`/`workflow()` request, so long agent
  turns are not killed just because the workflow script is awaiting them.

### Shared RunContext + `workflow()` nesting
`createRunContext()` builds one context per top-level run holding the concurrency limiter, agent
count cap (`maxAgents`, default 1000), token budget, journal, and abort signal. `workflow(name)`
runs another workflow **inline, one level deep**, reusing the *same* RunContext — so nested agents
count against the same caps and the same journal. `budget.spent()` stays synchronous in the child
by mirroring the parent's shared total piggybacked on each agent response. Nesting beyond depth 1
throws.

### Cancellation / leaked agents
Each run has an internal `AbortController` combined with the user signal via `AbortSignal.any`. When
the workflow finishes (including early, with un-awaited fire-and-forget `agent()` calls), the parent
aborts it and awaits in-flight runner promises so backend sessions/processes stop cleanly.

### Agent failure / retry / budget semantics (Claude parity)
- **`agent()` retries then returns `null` (it does NOT throw on failure).** `ctx.runAgent` wraps the
  runner + `normalizeAgentResult` in a retry loop (`agentMaxAttempts`, default 3; `--agent-retries n`
  → `n+1`). Schema-validation failures are retryable too. On exhaustion it records the failure on
  `state.failures` and returns `null` — so the Claude `.filter(Boolean)` idiom works. Abort/cap/budget
  errors are thrown *before* the loop and never become `null`. Failed agents are **not journaled**, so
  `resume` re-attempts them. Failures surface as `WorkflowRunResult.failures` / `WorkflowOutput.stats.failures`.
- **`budget.spent()` uses real output tokens** when the runner reports them (Codex
  `turn.usage.output_tokens`; Gemini sums `stats.models.*.tokens.candidates` across **all** models in
  the turn — `candidates` is generation-only, so do NOT fall back to `total`, which includes input),
  falling back to `estimateTokens` (len/4) only when unavailable. Cache hits cost 0.
- **`WorkflowAgentCapError`** (distinct from `WorkflowBudgetExceededError`) fires at the `maxAgents`
  cap; its message names the `budget.remaining()`-Infinity loop trap. Note: error **type** is flattened
  to message-only across the Bun-child IPC boundary — the message text is the observable contract.
- **Per-agent timeout** (`agentTimeoutMs`, default 15min, `--agent-timeout`, 0 disables) aborts a single
  hung backend turn → surfaces as a retryable failure. This is a total-duration cap; it fills the gap
  left by the workflow idle watchdog being disarmed while awaiting an agent.

### Module map
- `src/parser.ts` — TS-AST parse. `meta` **must be the first statement and a pure literal**.
  Rewrites top-level `import`/`export` into an async-function-safe body (dynamic imports; type-only
  and re-exports erased; anonymous `export default` bound to a name).
- `src/runners/codex-sdk.ts` — real runner. `startThread()` **per `agent()` call** (never resumes →
  every agent is a fresh, independent Codex session). Maps runner/CLI `model`, `sandbox`,
  `approval`, and reasoning; intentionally ignores workflow-authored `agent({model})` /
  `meta.phases[].model` values so Claude workflows with hard-coded model names remain portable.
  `isolation:'worktree'` creates a real detached `git worktree` (preserved for review if the agent left
  changes, else force-removed). `buildPrompt()` injects the verbatim-return discipline (+ strict-JSON
  contract when a schema is set). Reports `outputTokens` via `onMeta`; enforces `agentTimeoutMs`.
  **`toStrictJsonSchema()`** rewrites loose Claude schemas into OpenAI-strict form before sending (see gotchas).
- `src/runners/gemini-cli.ts` — real Gemini runner. Spawns a fresh `gemini` process per `agent()` call
  using runner/CLI `--model <model>` (workflow-authored models are ignored), `-y`, `-o json`, and
  `-p <prompt>`. Parses the JSON wrapper's `response`, `session_id`, and
  `stats.models.*.tokens.candidates`; no native schema is sent to Gemini, so the runtime's AJV
  validation/retry loop is the contract for `agent({schema})`. Supports `isolation:'worktree'`
  with the same detached git worktree behavior. CLI selection is `--backend gemini` or
  `CODEX_WORKFLOW_BACKEND=gemini`; `--gemini-command` / `CODEX_WORKFLOW_GEMINI_COMMAND` override the binary.
  Raw `spawn` stdout/stderr are bounded (32MB/4MB) so a runaway YOLO turn can't OOM the parent.
- `src/runners/pi-cli.ts` — real pi runner (`@earendil-works/pi-coding-agent`, a full agentic harness:
  read/bash/edit/write/grep/find/ls tools). Spawns `pi -p --mode json --no-context-files [--approve]
  [--tools …] --provider/--model/--session-dir … "<prompt>"` per `agent()`. Parses pi's NDJSON event
  stream: session id from the first `{type:"session"}`, the **last assistant `message_end`** text-blocks
  as the result, and summed `usage.output` across assistant turns for `outputTokens`. **pi exits 0 even
  when the model turn errored — success/failure is decided by the last assistant message's `stopReason`
  (`"error"` ⇒ throw a retryable failure), NOT the exit code.** No native schema flag, so the runtime's
  AJV loop is the `agent({schema})` contract (prompt-embedded, like Gemini). `isolation:'worktree'`
  supported. **Custom OpenAI/Anthropic-compatible endpoint:** pi has no `--base-url` flag, so when
  `baseUrl` is set the runner writes a synthetic-provider `models.json` under `agentDir`
  (`PI_CODING_AGENT_DIR`) and points pi at it (`--provider custom`); the API key is injected via env
  (`CODEX_WORKFLOW_PI_API_KEY`, referenced as `$VAR` in models.json) and **never written to disk** —
  without an apiKey the config gets a literal `"dummy"` (pi errors on unset env refs; keyless endpoints
  like Ollama accept anything). CLI
  selection is `--backend pi` / `CODEX_WORKFLOW_BACKEND=pi`; `--pi-command` / `CODEX_WORKFLOW_PI_COMMAND`
  override the binary. stdout/stderr bounded (64MB/4MB).
- `src/runners/prompt.ts` — shared subagent prompt discipline used by the Codex, Gemini, and pi runners.
- `src/runners/worktree.ts` — shared detached-`git worktree` lifecycle (create + dirty-aware
  preserve/remove cleanup) used by all CLI runners.
- `src/runners/turn-control.ts` — shared per-agent timeout + run/timeout abort-signal combination
  (leak-free listener cleanup) + the canonical `agent exceeded agentTimeoutMs (...)` error message,
  used by all runners.
- `src/runners/scripted.ts` — deterministic test runner.
- `src/paths.ts` — resolves the **global data dir** (`~/.codex-workflow`, override `CODEX_WORKFLOW_HOME`)
  holding `runs/`, `journal/`, `links/`. Shared across projects; the CLI passes these into
  the controller/store/server (`cwd` stays the project dir — where agents run & workflows are discovered).
- `src/journal.ts` — per-agent result cache keyed by `{prompt, options, runId}` hash → enables
  `resume`. Files at `~/.codex-workflow/journal/<runId>/<hash>.json` (prompt + options + result + sessionId).
- `src/run-store.ts` — run history at `~/.codex-workflow/runs/<runId>.json` (incl. `args`/`result`) → powers `runs`/`show`.
- `src/workflow-tool.ts` — Claude-compatible `{script|name|scriptPath|resumeFromRunId}` input shape,
  `WorkflowRegistry` (dir discovery for `.js`/`.mjs`/`.ts`/`.mts` workflows), and
  `buildWorkflowResolver` (resolves `workflow()` refs: `{scriptPath}` or a path-like string → file;
  a bare name → registry, when one is provided). File refs resolve relative to the run `cwd`.
- `src/controller.ts` — facade wiring runner + registry + journal + task manager. Defaults scan
  `.claude/workflows` and `~/.claude/workflows` via `defaultWorkflowDirs`.
- `src/task-manager.ts` — async launch/wait/cancel (library-level; the CLI runs foreground).
- `src/cli.ts` + `src/cli/` — `parseArgs`-based CLI
  (`run`/`resume`/`list`/`serve`/`validate`/`runs`/`show`/`doctor`),
  `progress.ts` (TTY status-line renderer), `commands.ts` (command impls + backend-aware runner factory).
  `run` accepts a workflow file path or a bare registered name; path-like missing targets report file
  not found rather than falling through to name lookup. `run` and `resume` share `executeRun()`:
  `resume <runId>` reconstructs the input (script path / name + `args`) from the run record and reuses
  the journal cache; Ctrl-C aborts the in-flight run, marks it `cancelled`, and prints the `resume` hint.
  The record also persists the runner config (`RunRecord.runner`: backend/model/gemini-command, plus the
  pi backend's pi-command/provider/base-url/pi-api/thinking/tools/exclude-tools/no-tools — but **never
  the API key**); `resume`
  **inherits** it when the flag is omitted and **refuses** an explicit `--backend` that disagrees with the
  recorded one (the journal cache key is NOT backend-aware, so resuming under a different backend would
  silently mix results). Historical records without `runner` are treated as the codex backend. pi-only
  flags (`--provider`/`--base-url`/`--api-key`/`--pi-api`/`--thinking`/`--tools`/`--exclude-tools`/
  `--no-tools`) error on codex/gemini; codex-only flags (`--sandbox`/`--approval`/`--reasoning`) error on pi.
- `src/web/` + `web/` — **local web viewer** (zero-dep Node `http`, vanilla SPA, claude.ai-styled).
  `server.ts` serves a JSON API (`/api/runs`, `/api/runs/:id` → run-aggregator view, `…/agents/:key`
  → journal entry, `…/agents/:key/session` → parsed Codex trace) + a global SSE stream (`/api/stream`),
  and exposes an in-process `broadcast(event)` for liveness. `run-aggregator.ts` groups journal entries
  into phase buckets; `session-parser.ts` turns a rollout `.jsonl` into a timeline
  (messages/reasoning/web-search/tool calls/usage); `session-linker.ts` (Codex), `gemini-session.ts`
  (Gemini), and `pi-session.ts` (pi — parses pi's `<ts>_<uuid>.jsonl` tree into the same timeline shape;
  the server picks the linker by `entry.backend`, and the runner writes pi sessions to `<dataDir>/pi/sessions`
  via `--session-dir`, which the server reads back) map each agent → its session file. Exact match via the journal's `sessionId` searches **all**
  session files regardless of date/mtime — this is what lets `resume` link a cached agent whose file was
  written during the original run (resume reuses the runId but resets `record.startedAt` to now, so the
  old file falls outside this run's window). Only the `sessionId`-less heuristic content-match is scoped
  to the run's time window (to avoid grabbing an unrelated run that reused the same prompt). Codex links
  cached in `~/.codex-workflow/links/`; `launcher.ts` is just free-port + open-browser helpers.
  **The viewer runs in-process: `run` (unless `--json`/`--no-web`) binds its own server on a random
  port, pushes `onProgress` events via `broadcast()`, and (when stdout is a TTY) keeps it live after
  the run until Ctrl-C; non-interactive runs close it immediately. `serve` is the standalone
  browse-history viewer (foreground; no daemon/`web.json`).** Static `web/` assets are NOT compiled by
  tsc; the server resolves them at `<moduleDir>/../../web` (project-root `web/` under both `dist/` and
  `tsx`). **Session linkage requires `originator: "codex_sdk_ts"`** rollouts (set by the SDK runner).

## Critical invariants / non-obvious gotchas

- **Deliberate divergence from Claude:** workflows run as **unrestricted TS/JS under Bun** — `Date.now`,
  `Math.random`, imports, fs, `Bun` are all allowed (Claude forbids the nondeterministic ones). A
  Claude workflow is a runnable subset; resume is therefore *best-effort* via the journal.
- **Codex requires strict JSON Schema.** OpenAI structured output rejects schemas without
  `additionalProperties:false` + all keys in `required` on every object. The runner sends a
  strictified copy (`toStrictJsonSchema`), but the runtime validates results against the **original
  (loose)** schema. Optional fields are made nullable in the strict copy and stripped back out before
  loose-schema validation. When touching schema handling, keep these two separate.
- **Gemini has no native schema flag in this integration.** The Gemini runner adds the shared
  structured-output prompt instructions, returns text from the JSON wrapper's `response`, and relies
  on `normalizeAgentResult` + AJV for validation/retry.
- **pi exits 0 on a failed model turn.** Never trust pi's exit code for success/failure — inspect the
  last assistant `message_end`'s `stopReason` (`"error"` + nested-JSON `errorMessage` ⇒ throw). pi also
  runs its own `auto_retry` cycles inside one invocation (multiple `agent_start`/`agent_end`), on top of
  the runtime's retry loop. pi (like Gemini) has no native JSON-schema flag → AJV is the `agent({schema})`
  contract. The pi backend's custom-`baseUrl` config is the only place this tool generates a backend
  config file (`models.json`); keep the API key out of it (env-injected via `$CODEX_WORKFLOW_PI_API_KEY`).
- **`agentType` is prompt context only.** Claude's built-in agent definitions/tool bundles are not
  loaded; full equivalence would require a separate agent registry surface.
- **Web search + network are always enabled for Codex agents** (no flag to disable — set by design in
  `buildCodexRunner`). Gemini uses the local Gemini CLI's configured capabilities. pi runs with its
  full built-in tool set (read/bash/edit/write/grep/find/ls) plus `--approve` by default; narrow it with
  `--tools`/`--exclude-tools`/`--no-tools`.
- **Model resolution:** the runtime still attaches `agent({model})` / `meta.phases[].model` to
  `WorkflowAgentCall.options` for Claude compatibility and custom runners, but the built-in Codex,
  Gemini, and pi runners intentionally ignore workflow-authored model values. Use runner/CLI `--model` to
  select a built-in backend model; otherwise each backend uses its own default. (For pi + `--base-url`,
  `--model` is required and is the model id sent to the endpoint.)
- **Build layout:** `tsconfig.json` uses `rootDir: "src"` so output is `dist/index.js` / `dist/cli.js`
  (the `bin`). Tests are excluded from emit and typechecked separately via `tsconfig.test.json`.
- **Observability layers** when debugging a run: the **web viewer** (in-process per `run` on a random
  port, or `serve` to browse history) → overview + per-step details; workflow logs/stats →
  `show <runId>`; per-subagent prompt+result → `~/.codex-workflow/journal/<runId>/*.json`; Codex
  full traces (reasoning, web searches, tool calls) → `~/.codex/sessions/<date>/rollout-*.jsonl`
  (`codex resume <sessionUUID>`); pi full traces → `~/.codex-workflow/pi/sessions/<ts>_<uuid>.jsonl`.
- `AGENTS.md` is a symlink to this file (Codex reads `AGENTS.md`).
