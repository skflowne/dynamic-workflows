# codex-dynamic-workflows

Run **Claude Code-style dynamic workflows** from the command line, backed by **OpenAI Codex** — with
a **live visual run viewer** that shows the whole pipeline, every step's progress, and the complete
Codex session behind each agent.

A workflow is an open TypeScript/JavaScript script with a `meta` block and top-level `await`. The
orchestration primitives — `agent()`, `parallel()`, `pipeline()`, `workflow()`, `phase()`, `log()`,
`args`, `budget` — are injected by the runtime. Each `agent()` call runs as an independent **Codex
thread** via `@openai/codex-sdk`. The script body itself executes unrestricted under **Bun**.

```bash
codex-workflow run deep-research --args '"what changed in the API?"'   # auto-starts the viewer
```

The CLI binary is named `codex-workflow`.

## Why

Claude Code ships a built-in `Workflow` tool for fan-out/verify/synthesize orchestration. This brings
the same authoring model to Codex users as a standalone CLI: the same script shape runs unchanged,
but the subagents are Codex threads using your local `codex login` credentials and models.

## Requirements

- **Node 20+** (uses `node:util` `parseArgs`, `AbortSignal.any`).
- **[Bun](https://bun.sh)** — workflow scripts execute in a Bun child process.
- **[Codex CLI](https://github.com/openai/codex)** authenticated via `codex login` (the SDK reuses
  `~/.codex/auth.json`). Only needed for real runs, not for `validate`/`list`.

## Install

```bash
npm install
npm run build      # emits dist/, including the dist/cli.js bin
npm link           # optional: exposes `codex-workflow` on your PATH
```

Check your environment:

```bash
codex-workflow doctor
```

## CLI

```text
codex-workflow run <file|name> [options]   Run a workflow (foreground, live progress)
codex-workflow serve [--port N] [--open]   Start the local web viewer for runs
codex-workflow list [--json]               List discovered workflows
codex-workflow validate <file> [--json]    Parse & validate a workflow (no tokens used)
codex-workflow runs [--json]               List recorded run history
codex-workflow show <runId> [--json]       Show a recorded run
codex-workflow doctor                      Check Bun, Codex CLI, auth, workflow dirs, viewer
```

Run options:

| Flag | Meaning |
| --- | --- |
| `--args <json\|@file.json>` | Value exposed to the script as `args` |
| `--model <model>` | Codex model for every `agent()` call |
| `--concurrency <n>` | Max concurrent agents (capped at 16) |
| `--budget <tokens>` | Token budget (estimate) shared across the run |
| `--max-agents <n>` | Hard cap on total `agent()` calls (default 1000) |
| `--resume <runId>` | Reuse a prior run's journal cache |
| `--cwd <dir>` | Working directory for agents |
| `--sandbox <mode>` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--approval <policy>` | `never` \| `on-request` \| `on-failure` \| `untrusted` |
| `--reasoning <effort>` | `minimal` \| `low` \| `medium` \| `high` \| `xhigh` |
| `--bun <path>` | Path to the Bun binary |

Web search + network access are **always enabled** for agents.
| `--json` | Machine-readable output to stdout (suppresses progress) |
| `--quiet` / `--no-progress` | Reduce / plainify progress output |

Workflows are discovered from `./.claude/workflows`, `~/.claude/workflows`, and `~/.codex/workflows`.
Run history, the per-agent journal, and session links are recorded in a **global** data dir,
`~/.codex-workflow/` (override with `CODEX_WORKFLOW_HOME`), so runs from every project are shared by
one store and one viewer.

### Example

```bash
# Validate, then run a bundled example without spending tokens:
codex-workflow validate .claude/workflows/hello.js
CODEX_WORKFLOW_FAKE_AGENT=1 codex-workflow run hello --args '{"name":"Ada"}'

# Real run, JSON result piped to jq:
codex-workflow run hello --args '{"name":"Ada"}' --json | jq .result
```

`.claude/workflows/nested-demo.js` demonstrates the `workflow()` nesting primitive.

### `examples/`

Sample scripts you run by **path** (`codex-workflow run examples/<file>`); unlike `.claude/workflows/`,
they are not registered for name lookup or `list`.

- `complex-chain.js`, `live-check.js` — small original demos.
- `deep-research.js` — Claude Code's built-in `deep-research` workflow (fan-out → fetch → 3-vote
  verify → synthesize); runnable here as-is.
- `code-review.js` — Claude Code's built-in hidden `code-review` workflow. **Reference only**: it was
  extracted from the compiled client with unresolved `${…}` template placeholders, so it does not
  parse/run; it's included to document the find → verify → synthesize architecture.

## Viewer

A local web viewer (zero runtime dependencies — Node's `http` + a vanilla SPA) visualizes runs:

- **Pipeline flow graph** — phases wired together; click one to expand a fan of its agent nodes.
- **Per-step progress** — agents appear as "running" placeholders the moment they start (phase badges
  show `done/total`), then flip to ✓ / ✕ as they finish.
- **Full Codex session** — drill into any agent to see its prompt, structured result, and the complete
  rollout: messages, reasoning, web searches, tool calls, and token usage.
- **Input & Result** — the workflow's `args` and final return value, rendered top and bottom.
- **Live** — the page streams updates over SSE (logs, phase progress, status) with no refresh.

```bash
codex-workflow serve            # foreground; opens http://127.0.0.1:4173
```

`run` also **auto-starts the viewer in the background** (unless `--json` or `--no-web`) and prints its
URL, so you can watch a run live. The server is shared across projects and persists until stopped.

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

- `agent(prompt, opts?)` — spawn a Codex subagent. Options: `label`, `phase`, `schema` (JSON Schema →
  validated structured output), `model`, `agentType`, `isolation: 'worktree'` (runs in a fresh
  detached git worktree). Without a schema it returns the final text; with a schema it returns the
  validated object.
- `parallel(thunks)` — run `() => …` thunks concurrently; a thrown thunk resolves to `null`.
- `pipeline(items, stage1, stage2, …)` — run each item through all stages independently (no barrier);
  stages receive `(prevResult, originalItem, index)`; a throwing stage drops the item to `null`.
- `workflow(nameOrRef, args?)` — run another workflow inline (one level deep), sharing this run's
  concurrency limiter, agent-count cap, token budget, journal, and abort signal. Accepts a registered
  name or `{ scriptPath }`.
- `phase(title)`, `log(message)`, `args`, `budget` (`total`, `spent()`, `remaining()` — shared across
  the root and nested workflows).

### Compatibility note (intentional divergence)

Claude blocks `Date.now()` / `Math.random()` / `new Date()` inside workflow scripts to keep replay
deterministic. **codex-workflow runs scripts as open, unrestricted TS/JS under Bun** — a Claude
workflow is a runnable subset, and you may additionally use anything Bun/Node provide (imports, the
filesystem, `Bun`, etc.). Resume is therefore *best-effort*: completed `agent()` calls are cached in a
journal keyed by prompt+options+runId and reused on `--resume`, but non-deterministic script logic is
not snapshotted.

## Library use

The CLI is built on a small library you can embed:

```ts
import { CodexSdkAgentRunner, WorkflowController } from "codex-workflow";

const controller = new WorkflowController({
  runner: new CodexSdkAgentRunner({ cwd: process.cwd() }),
  concurrency: 8,
});

const output = await controller.run({ name: "deep-research", args: "What changed?" });
// background: controller.launch() -> taskId, controller.wait(taskId), controller.cancel(taskId)
```

`runWorkflow`, `runWorkflowTool`, `WorkflowRegistry`, `FileWorkflowJournal`, `FileRunStore`,
`buildWorkflowResolver`, and `ScriptedAgentRunner` are also exported.

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
                 -> ScriptedAgentRunner  (deterministic tests)
       -> FileRunStore records run history -> `runs` / `show`
```

## Verify

```bash
npm test                  # build + unit suite (scripted runner; no tokens)
npm run typecheck         # tsc over src + tests
npm run test:deepresearch # runs the real Claude deep-research workflow against a stubbed runner
```

The live Codex path is gated to avoid spending tokens:

```bash
RUN_CODEX_SDK_LIVE=1 npm test
```

`test:deepresearch` runs the vendored `deep-research` workflow (`examples/deep-research.js`) against a
stubbed runner. (Override the path with `DEEP_RESEARCH_WORKFLOW_PATH`.)

## Not included (yet)

- MCP server / in-Codex tool registration (this is a standalone CLI by design).
- Remote/cloud workflows; a long-running background daemon.
- Real LLM token accounting — `budget` uses a length-based estimate.
