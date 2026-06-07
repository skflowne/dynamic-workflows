# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`codex-workflow` is a CLI + library that runs **Claude Code-style dynamic workflows** on top of
**OpenAI Codex**. A workflow is an open TS/JS script with a `meta` block and top-level `await`; the
orchestration primitives (`agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `args`,
`budget`) are injected at runtime. Each `agent()` call runs as an independent Codex thread via
`@openai/codex-sdk`. The CLI is the primary deliverable; the library underneath is reused by it.

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
node dist/cli.js doctor          # checks Bun, Codex CLI, ~/.codex/auth.json, workflow dirs, viewer
node dist/cli.js serve --port 4173   # local web viewer (overview + per-step + full Codex session)
```

- **`CODEX_WORKFLOW_FAKE_AGENT=1`** makes the CLI use a built-in deterministic runner (returns
  `fake:<prompt>` / `"{}"`), so `run` works without Codex/tokens. Used by `tests/cli.test.ts`.
- **`RUN_CODEX_SDK_LIVE=1`** un-gates the one live Codex SDK test (spends tokens). Off by default.
- Requires **Bun** (workflow bodies execute in a Bun child) and **Codex CLI** authenticated via
  `codex login` (the SDK reuses `~/.codex/auth.json`) for real runs.

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
  when the child is not waiting on a parent-handled `agent()`/`workflow()` request, so long Codex
  agents are not killed just because the workflow script is awaiting them.

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
aborts it and awaits in-flight runner promises so Codex threads stop cleanly.

### Module map
- `src/parser.ts` — TS-AST parse. `meta` **must be the first statement and a pure literal**.
  Rewrites top-level `import`/`export` into an async-function-safe body (dynamic imports; type-only
  and re-exports erased; anonymous `export default` bound to a name).
- `src/runners/codex-sdk.ts` — real runner. `startThread()` **per `agent()` call** (never resumes →
  every agent is a fresh, independent Codex session). Maps `model`/`sandbox`/`approval`/reasoning;
  `isolation:'worktree'` creates a real detached `git worktree`. **`toStrictJsonSchema()`** rewrites
  loose Claude schemas into OpenAI-strict form before sending (see gotchas).
- `src/runners/scripted.ts` — deterministic test runner.
- `src/paths.ts` — resolves the **global data dir** (`~/.codex-workflow`, override `CODEX_WORKFLOW_HOME`)
  holding `runs/`, `journal/`, `links/`. Shared across projects; the CLI passes these into
  the controller/store/server (`cwd` stays the project dir — where agents run & workflows are discovered).
- `src/journal.ts` — per-agent result cache keyed by `{prompt, options, runId}` hash → enables
  `--resume`. Files at `~/.codex-workflow/journal/<runId>/<hash>.json` (prompt + options + result + sessionId).
- `src/run-store.ts` — run history at `~/.codex-workflow/runs/<runId>.json` (incl. `args`/`result`) → powers `runs`/`show`.
- `src/workflow-tool.ts` — Claude-compatible `{script|name|scriptPath|resumeFromRunId}` input shape,
  `WorkflowRegistry` (dir discovery for `.js`/`.mjs`/`.ts`/`.mts` workflows), and
  `buildWorkflowResolver` (resolves `workflow()` refs: `{scriptPath}` or a path-like string → file;
  a bare name → registry, when one is provided). File refs resolve relative to the run `cwd`.
- `src/controller.ts` — facade wiring runner + registry + journal + task manager. Defaults scan
  `.claude/workflows` and `~/.claude/workflows` via `defaultWorkflowDirs`.
- `src/task-manager.ts` — async launch/wait/cancel (library-level; the CLI runs foreground).
- `src/cli.ts` + `src/cli/` — `parseArgs`-based CLI
  (`run`/`list`/`serve`/`validate`/`runs`/`show`/`doctor`),
  `progress.ts` (TTY status-line renderer), `commands.ts` (command impls + runner factory).
  `run` accepts a workflow file path or a bare registered name; path-like missing targets report file
  not found rather than falling through to name lookup.
- `src/web/` + `web/` — **local web viewer** (zero-dep Node `http`, vanilla SPA, claude.ai-styled).
  `server.ts` serves a JSON API (`/api/runs`, `/api/runs/:id` → run-aggregator view, `…/agents/:key`
  → journal entry, `…/agents/:key/session` → parsed Codex trace) + a global SSE stream (`/api/stream`),
  and exposes an in-process `broadcast(event)` for liveness. `run-aggregator.ts` groups journal entries
  into phase buckets; `session-parser.ts` turns a rollout `.jsonl` into a timeline
  (messages/reasoning/web-search/tool calls/usage); `session-linker.ts` maps each agent → its rollout
  file (exact via the journal's new `sessionId`, else heuristic content-match within the run's time
  window, cached in `~/.codex-workflow/links/`); `launcher.ts` is just free-port + open-browser helpers.
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
- **`agentType` is prompt context only.** Claude's built-in agent definitions/tool bundles are not
  loaded; full equivalence would require a separate agent registry surface.
- **Web search + network are always enabled** for agents (no flag to disable — set by design in
  `buildAgentRunner`).
- **Model resolution:** `agent({model})` > current `meta.phases[].model` > runner/`--model` >
  Codex's own default (e.g. `~/.codex/config.toml`). We only set `threadOptions.model` when one of
  those workflow/runner layers explicitly provides it.
- **Build layout:** `tsconfig.json` uses `rootDir: "src"` so output is `dist/index.js` / `dist/cli.js`
  (the `bin`). Tests are excluded from emit and typechecked separately via `tsconfig.test.json`.
- **Observability layers** when debugging a run: the **web viewer** (in-process per `run` on a random
  port, or `serve` to browse history) → overview + per-step + linked Codex session; workflow logs/stats
  → `show <runId>`; per-subagent
  prompt+result → `~/.codex-workflow/journal/<runId>/*.json`; full subagent trace (reasoning, web
  searches, tool calls) → `~/.codex/sessions/<date>/rollout-*.jsonl` (`codex resume <sessionUUID>`).
- `AGENTS.md` is a symlink to this file (Codex reads `AGENTS.md`).
