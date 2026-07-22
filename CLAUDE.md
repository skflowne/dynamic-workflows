# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`codex-workflow` is a CLI + library that runs **Claude Code-style dynamic workflows** on top of
pluggable agent backends (**OpenAI Codex**, **Gemini CLI**, and **pi** — the pi-coding-agent harness,
which also reaches any OpenAI/Anthropic-compatible endpoint). A
workflow is an open TS/JS script with a `meta` block and top-level `await`; the
orchestration primitives (`agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`,
`budget`) are injected at runtime. Each `agent()` call runs as an independent backend session. The
CLI is the primary deliverable; the library underneath is reused by it.

**Every run needs a provider config** (`--config`, or an auto-discovered
`codex-workflow.config.{ts,mts,js,mjs}` in the project dir or the data dir; the only exception is the
token-free `CODEX_WORKFLOW_FAKE_AGENT` mode). It names a set of providers (each = backend + model +
endpoint + credential-env + tuning), so a *single* run can route different `agent()` calls to different
backends/models: `agent({provider:"name"})`, `agent({model:"id"})` (routes to the provider declaring
that model), `--provider <name>` for a run-level default, else `config.default`. A call that resolves to
none of these throws. The CLI itself only **selects and orchestrates** (`--config`/`--provider` plus
run-level/output flags); all backend/model/tuning lives in the config. See `src/providers/`.

## Commands

```bash
npm run build          # Vite React viewer -> web/ + tsc -> dist/ (emits dist/index.js AND dist/cli.js — the bin)
npm test               # build + full unit suite (ScriptedAgentRunner, no tokens)
npm run test:unit      # unit suite only (requires a prior build for tests that spawn dist/cli.js)
npm run typecheck      # tsc over src/tests + strict web-src React TS (no emit)
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
- Requires **Bun** (workflow bodies execute in a Bun child), a provider config, and the CLI for each
  backend the config uses: Codex CLI authenticated via `codex login` for `codex` providers, Gemini CLI
  for `gemini` providers, or `pi` (npm `@earendil-works/pi-coding-agent`) for `pi` providers.

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
  → `n+1`; per-call `agent({maxAttempts})` overrides it). Schema-validation failures are retryable too.
  `AgentOutputLimitExceededError` is non-retryable because replaying a tool-heavy mutation turn is unsafe.
  On exhaustion (or a non-retryable failure) it records the failure on
  `state.failures` and returns `null` — so the Claude `.filter(Boolean)` idiom works. Abort/cap/budget
  errors are thrown *before* the loop and never become `null`. Failed agents are **not journaled**, so
  `resume` re-attempts them. Failures surface as `WorkflowRunResult.failures` / `WorkflowOutput.stats.failures`.
- **`budget.spent()` uses real output tokens** when the runner reports them (Codex
  `turn.usage.output_tokens`; Gemini sums `stats.models.*.tokens.candidates` across **all** models in
  the turn — `candidates` is generation-only, so do NOT fall back to `total`, which includes input),
  falling back to `estimateTokens` (len/4) only when unavailable, and counts a failed/retried attempt's
  tokens too (a rejected turn still burned real tokens), not just the eventual success. Cache hits cost 0.
- **`WorkflowAgentCapError`** (distinct from `WorkflowBudgetExceededError`) fires at the `maxAgents`
  cap; its message names the `budget.remaining()`-Infinity loop trap. Error **type** is flattened to
  message-only across the Bun-child IPC boundary, but fatal errors (agent-cap, budget-exceeded, abort,
  provider-routing) also carry a structured `fatal` flag alongside the message, so `parallel()`/
  `pipeline()` key off that flag to rethrow (hard-fail) rather than swallow into `null` — message text
  plus this flag are the observable contract.
- **Per-agent timeout** (`agentTimeoutMs`, default 15min, `--agent-timeout`, 0 disables) aborts a single
  hung backend turn → surfaces as a retryable failure. This is a total-duration cap; it fills the gap
  left by the workflow idle watchdog being disarmed while awaiting an agent.

### Module map
- `src/parser.ts` — TS-AST parse. `meta` **must be the first statement and a pure literal**.
  Rewrites top-level `import`/`export` into an async-function-safe body (dynamic imports; type-only
  and re-exports erased; anonymous `export default` bound to a name).
- `src/providers/config.ts` — provider-config types (`ProviderDef`/`ProvidersConfig`), discovery
  (`--config` → cwd → global data dir), TS/JS loading (`ts.transpileModule` + data: URL import, no new
  dep), and validation (rejects unknown top-level/provider keys; per-backend allowed fields; enum-valued
  fields — codex `sandbox`/`approval`/`reasoning`/`webSearchMode`, pi `thinking`; pi's
  `baseUrl`-requires-`model`; unknown `default`; secret-free content hash). Also `resolveProviderName`
  (validated lookup) + `buildModelIndex`, reused by the registry.
- `src/providers/registry.ts` — `buildRunnerResolver(config, factories, {defaultProvider})` → the
  per-agent `WorkflowRunnerResolver`. Backend-agnostic (the CLI injects a `forProvider` factory that
  closes over `buildAgentRunner` + flags); implements the provider → model → default chain (throws if a
  call resolves to none) and caches runners per `provider:model`.
- `src/runners/codex-sdk.ts` — real runner. `startThread()` **per `agent()` call** (never resumes →
  every agent is a fresh, independent Codex session). Maps the resolved provider's `model`, `sandbox`,
  `approval`, and reasoning; a raw workflow-authored `agent({model})` reaches the backend only when a
  provider declares that model (otherwise it's a routing hint, see Model resolution).
  `isolation:'worktree'` creates a real detached `git worktree` (preserved for review if the agent left
  changes — or if the dirty-check itself fails — else force-removed). `buildPrompt()` injects the
  verbatim-return discipline (+ strict-JSON
  contract when a schema is set). Reports `outputTokens` via `onMeta`; enforces `agentTimeoutMs`.
  **`toStrictJsonSchema()`** rewrites loose Claude schemas into OpenAI-strict form before sending (see gotchas).
- `src/runners/gemini-cli.ts` — real Gemini runner. Spawns a fresh `gemini` process per `agent()` call
  using the provider's `model` (`--model <model>`), `-y`, `-o json`; the prompt itself is fed on
  **stdin** with `-p ""` (empty `-p` triggers headless mode) rather than as a CLI arg, so a huge fan-in
  prompt can't blow past the OS `ARG_MAX` and isn't visible in `ps`. Parses the JSON wrapper's
  `response`, `session_id`, and `stats.models.*.tokens.candidates`; no native schema is sent to Gemini,
  so the runtime's AJV validation/retry loop is the contract for `agent({schema})`. Supports
  `isolation:'worktree'` with the same detached git worktree behavior. Selected by a provider's
  `backend: 'gemini'`; the binary comes from the provider's `geminiCommand` or
  `CODEX_WORKFLOW_GEMINI_COMMAND`. Spawns via `spawn-process.ts` (see below); stdout/stderr bounded
  (32MB/4MB) so a runaway YOLO turn can't OOM the parent.
- `src/runners/pi-cli.ts` — real pi runner (`@earendil-works/pi-coding-agent`, a full agentic harness:
  read/bash/edit/write/grep/find/ls tools). Spawns `pi -p --mode json --no-context-files [--approve]
  [--tools …] --provider/--model/--session-dir … "<prompt>"` per `agent()`. Parses pi's NDJSON event
  stream incrementally without retaining the complete tool-heavy transcript: session id from the first
  `{type:"session"}`, the **last assistant `message_end`** text-blocks as the result, and summed
  `usage.output` across assistant turns for `outputTokens`. Individual unterminated NDJSON events are
  capped at 16MB, while total stream size is bounded by the turn timeout rather than an in-memory buffer.
  **pi exits 0 even
  when the model turn errored — success/failure is decided by the last assistant message's `stopReason`
  (`"error"` ⇒ throw a retryable failure), NOT the exit code.** A failed turn still reports its
  `sessionId`/`outputTokens` via `onMeta` *before* throwing, so a failed agent's partial usage/session
  linkage isn't lost. No native schema flag, so the runtime's AJV loop is the `agent({schema})` contract
  (prompt-embedded, like Gemini). `isolation:'worktree'` supported. **Custom OpenAI/Anthropic-compatible
  endpoint:** pi has no `--base-url` flag, so when `baseUrl` is set the runner writes a synthetic-provider
  `models.json` under a per-config **subdirectory** of `agentDir` named `custom-<sha256(baseUrl,api,model)
  [0:16]>` (`PI_CODING_AGENT_DIR` points at that subdirectory — avoids two differently-configured custom
  providers colliding on one `models.json`) and points pi at it (`--provider custom`); the API key is
  injected via env (`CODEX_WORKFLOW_PI_API_KEY`, referenced as `$VAR` in models.json) and **never written
  to disk** — without an apiKey the config gets a literal `"dummy"` (pi errors on unset env refs; keyless
  endpoints like Ollama accept anything). Selected by a provider's `backend: 'pi'`; the binary comes from
  the provider's `piCommand` or `CODEX_WORKFLOW_PI_COMMAND`. Spawns via `spawn-process.ts`; stdout/stderr
  bounded (64MB/4MB); an argv-too-large spawn error (`E2BIG`, from a huge prompt as a positional arg) is
  caught and rethrown with a clear message.
- `src/runners/spawn-process.ts` — shared child-process plumbing for the Gemini and pi runners: decodes
  stdout/stderr via `StringDecoder` (keeps multi-byte UTF-8 intact across chunk boundaries) up to their
  byte ceilings, and only **settles on the child's `close` event, never `exit`** (which can fire before
  trailing stdout is delivered and would truncate the result). Abort / timeout / overflow send SIGTERM,
  wait a 2s grace period, then escalate to SIGKILL.
- `src/runners/prompt.ts` — shared subagent prompt discipline used by the Codex, Gemini, and pi runners.
- `src/runners/worktree.ts` — shared detached-`git worktree` lifecycle (create + dirty-aware
  preserve/remove cleanup) used by all CLI runners. The dirty check (`git status --porcelain`) runs with
  a 64MB `maxBuffer`; if that check itself fails, the worktree is conservatively **preserved** (not
  removed) rather than risk destroying output.
- `src/runners/turn-control.ts` — shared per-agent timeout + run/timeout abort-signal combination
  (leak-free listener cleanup) + the canonical `agent exceeded agentTimeoutMs (...)` error message,
  used by all runners.
- `src/runners/scripted.ts` — deterministic test runner.
- `src/paths.ts` — resolves the **global data dir** (`~/.codex-workflow`, override `CODEX_WORKFLOW_HOME`)
  holding `runs/`, `journal/`, `links/`. Shared across projects; the CLI passes these into
  the controller/store/server (`cwd` stays the project dir — where agents run & workflows are discovered).
- `src/journal.ts` — per-agent result cache keyed by `{prompt, options, runId}` hash (`options` excludes
  an AUTO-generated `label`, which embeds a nondeterministic arrival-order index — a user-set label still
  counts; this changed the key shape, so journals written before this change won't cache-hit) → enables
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
  `progress.ts` (TTY status-line renderer), `commands.ts` (command impls + provider/runner wiring).
  `commands.ts` owns: `loadProviderConfigForRun` (discover+load; required for a real run — only
  `CODEX_WORKFLOW_FAKE_AGENT` may skip it), `providerDefToFlags` (project a `ProviderDef` onto a synthetic
  `RunFlags` so the per-backend builders consume it — and read `apiKeyEnv` from `process.env` here,
  in-memory only), and `buildAgentRunnerResolver` (wrap `buildRunnerResolver` with a `forProvider` factory).
  `run` accepts a workflow file path or a bare registered name; path-like missing targets report file
  not found rather than falling through to name lookup. `run` and `resume` share `executeRun()`, which
  validates every numeric run flag up front (`--concurrency`/`--budget`/`--max-agents`/`--agent-retries`/
  `--agent-timeout`/`--idle-timeout`; `serve`'s `--port` is validated separately in `serveCommand`; all of
  them go through `preprocessNegativeNumericArgs()` in `src/cli.ts` so a negative value like `--budget -5`
  doesn't get misparsed by `node:util`'s `parseArgs`) — a bad value exits 2 as a usage error before any
  run record is persisted:
  `resume <runId>` reconstructs the input (script path / name + `args`) from the run record and reuses
  the journal cache, persisting a `"running"`-status record for the duration of the re-run (like a fresh
  `run`); Ctrl-C aborts the in-flight run, marks it `cancelled`, and prints the `resume` hint.
  The record persists only the routing it needs (`RunRecord.runner`:
  `configPath`/`configHash`/`defaultProvider` — no backend/model/secrets); `resume` reloads the recorded
  config (warning if its hash drifted) and re-selects the same default. The CLI is selection-only:
  `--config` chooses the provider config, `--provider` sets the run-level default provider; everything
  else (backend, model, sandbox/approval/reasoning, base-url/api/apiKeyEnv/thinking/tools/…) is a
  `ProviderDef` field. `doctor` validates the discovered/`--config` config and checks the CLI for each
  backend the config actually uses.
- `src/web/` + `web-src/` + `web/` — **local web viewer** (zero-dep Node `http` server,
  bundled React/TypeScript SPA, claude.ai-styled). `web-src/` is the strict TS frontend source;
  `npm run build:web` runs `tsc -p tsconfig.web.json` and Vite, emitting static assets into `web/`.
  `server.ts` serves a JSON API (`/api/runs` — a summary projection only, no `result`/`logs`/`args`/
  `failures`; `/api/runs/:id` → the full run-aggregator view, `…/agents/:key` → journal entry,
  `…/agents/:key/session` → parsed Codex trace) + a global SSE stream (`/api/stream`), rejects any
  request whose `Host` header isn't a localhost/loopback variant with 403 (DNS-rebinding guard, since
  the server binds `127.0.0.1` but a browser can still send an arbitrary Host header), and exposes an
  in-process `broadcast(event)` for liveness (SSE writes are guarded so a dead connection can't throw).
  Session-parse/link results and journal-entry reads are cached (session parsing keyed by file
  path+mtime+size); per-run event buffers are dropped a grace period after the run finishes to bound
  memory on a long-lived viewer process. `run-aggregator.ts` groups journal entries
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
  browse-history viewer (foreground; no daemon/`web.json`).** The server resolves built `web/` assets
  at `<moduleDir>/../../web` (project-root `web/` under both `dist/` and `tsx`). **Session linkage
  requires `originator: "codex_sdk_ts"`** rollouts (set by the SDK runner).

## Critical invariants / non-obvious gotchas

- **Deliberate divergence from Claude:** workflows run as **unrestricted TS/JS under Bun** — `Date.now`,
  `Math.random`, imports, fs, `Bun` are all allowed (Claude forbids the nondeterministic ones). A
  Claude workflow is a runnable subset; resume is therefore *best-effort* via the journal.
- **Codex requires strict JSON Schema.** OpenAI structured output rejects schemas without
  `additionalProperties:false` + all keys in `required` on every object. The runner sends a
  strictified copy (`toStrictJsonSchema`), but the runtime validates results against the **original
  (loose)** schema. Optional fields are made nullable in the strict copy and stripped back out before
  loose-schema validation. A schema-valued `additionalProperties` (e.g. `Record<string, T>`) is
  preserved recursively rather than forced to `false`; a nullable `enum` gets `null` folded into the
  enum array, and a nullable `const` becomes a nullable `enum`; `$defs`/`definitions`/`patternProperties`
  are treated as maps of name → subschema and recursed into (not as this node's own `properties`/
  `required`). When touching schema handling, keep these two separate.
- **Gemini has no native schema flag in this integration.** The Gemini runner adds the shared
  structured-output prompt instructions, returns text from the JSON wrapper's `response`, and relies
  on `normalizeAgentResult` + AJV for validation/retry.
- **pi exits 0 on a failed model turn.** Never trust pi's exit code for success/failure — inspect the
  last assistant `message_end`'s `stopReason` (`"error"` + nested-JSON `errorMessage` ⇒ throw). pi also
  runs its own `auto_retry` cycles inside one invocation (multiple `agent_start`/`agent_end`), on top of
  the runtime's retry loop. pi (like Gemini) has no native JSON-schema flag → AJV is the `agent({schema})`
  contract. The pi backend's custom-`baseUrl` config is the only place this tool generates a backend
  config file (`models.json`); keep the API key out of it (env-injected via `$CODEX_WORKFLOW_PI_API_KEY`).
- **`agentType` is a prompt role directive** (`prompt.ts` injects "Act as the \"<type>\" subagent…" for
  all backends, so the model adopts the role the name implies). Claude's built-in agent definitions/tool
  bundles are NOT loaded — there's no name→system-prompt/tool registry, so a bare descriptive name is all
  the model gets; full equivalence would require a separate agent-definitions surface.
- **Web search + network default on for Codex providers** (`buildCodexRunner` sets them `?? true`); a
  provider opts out via `webSearch`/`networkAccess`. Gemini uses the local Gemini CLI's configured
  capabilities. pi runs with its full built-in tool set (read/bash/edit/write/grep/find/ls) plus
  `approve` by default; narrow it via a provider's `tools`/`excludeTools`/`noTools`.
- **Model resolution:** the runtime attaches `agent({model})` / `meta.phases[].model` to
  `WorkflowAgentCall.options`; the per-backend runners send whatever model `providerDefToFlags` resolved
  (never a raw workflow-authored value directly). `agent({model})` is a **routing key**: a config that
  declares that model (a provider's `model`/`models`) routes the call there *and* sends that model to the
  backend; a model no provider declares is ignored (the call falls through to `--provider`/`config.default`),
  so stock Claude workflows with hard-coded model names stay portable. `agent({provider})` selects a
  provider by name.
- **Provider routing (`src/providers/`)** is per-`agent()` and lives in `WorkflowRunOptions.runner`,
  typed `WorkflowAgentRunner | WorkflowRunnerResolver`. The runtime normalizes a bare runner to
  `() => runner` and calls the resolver once per **uncached** agent — *after* the journal cache check,
  *before* the retry loop — so an unknown provider / ambiguous model / unresolvable call **hard-fails**
  the run (like cap/budget) instead of retrying into a `null`. `config.ts` loads+validates the TS/JS config
  (reusing the already-present `typescript` dep to transpile `.ts` via a data: URL — no new dependency;
  relative imports in a `.ts` config won't resolve, `.js`/`.mjs` are imported from their file URL).
  `registry.ts` `buildRunnerResolver()` is backend-agnostic (a `forProvider` factory is injected by the
  CLI) and caches built runners per `provider:model`. **provider/model ride in `agent` options → they're
  in the journal cacheKey**, so the same prompt under two providers is two entries (no cross-provider
  cache hit), which is what makes mixing safe across `resume`. A `ProviderDef` carries every backend knob:
  `agentTimeoutMs` + `baseInstructions` (all); codex `sandbox`/`approval`/`reasoning`/`webSearch`/
  `networkAccess`/`webSearchMode`; gemini `geminiCommand`/`yolo`/`args`; pi `thinking`/`tools`/
  `excludeTools`/`noTools`/`approve`/`contextFiles`/`piProvider`/`baseUrl`/`api`/`apiKeyEnv`/`piCommand`/
  `args` (`args` = raw extra CLI flags, a passthrough escape hatch for gemini/pi). They flow through
  `providerDefToFlags` → the per-backend builders. `RunnerConfig` records only
  `configPath`/`configHash`/`defaultProvider` (no backend/model/secrets); `resume` reloads the recorded
  config (warning if its hash drifted). Secrets stay out of the config — a pi provider names a credential
  env var via `apiKeyEnv`, read at runner-build time and **never persisted**.
- **Build layout:** `tsconfig.json` uses `rootDir: "src"` so output is `dist/index.js` / `dist/cli.js`
  (the `bin`). Tests are excluded from emit and typechecked separately via `tsconfig.test.json`.
- **Observability layers** when debugging a run: the **web viewer** (in-process per `run` on a random
  port, or `serve` to browse history) → overview + per-step details; workflow logs/stats →
  `show <runId>`; per-subagent prompt+result → `~/.codex-workflow/journal/<runId>/*.json`; Codex
  full traces (reasoning, web searches, tool calls) → `~/.codex/sessions/<date>/rollout-*.jsonl`
  (`codex resume <sessionUUID>`); pi full traces → `~/.codex-workflow/pi/sessions/<ts>_<uuid>.jsonl`.
- `AGENTS.md` is a symlink to this file (Codex reads `AGENTS.md`).
