import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  FileWorkflowJournal,
  InMemoryWorkflowJournal,
  runWorkflow,
  ScriptedAgentRunner,
  WorkflowAbortError,
  WorkflowAgentCapError,
  WorkflowBudgetExceededError,
  WorkflowInputError,
} from "../src/index.js";
import type { WorkflowAgentMeta, WorkflowAgentRunner } from "../src/index.js";

test("runWorkflow executes agent, parallel, pipeline, phase, log, and args", async () => {
  const cwdDir = await mkdtemp(path.join(tmpdir(), "codex-workflow-cwd-"));
  const runner = new ScriptedAgentRunner((call) => {
    if (call.options.schema) return { value: call.prompt.toUpperCase() };
    return `text:${call.prompt}`;
  });

  try {
    const result = await runWorkflow(
      `export const meta = {
  name: 'runtime_demo',
  description: 'Exercise runtime primitives',
  phases: [{ title: 'Scope' }, { title: 'Work' }]
}

phase('Scope')
log('starting ' + args.name)
const one = await agent('scope', { label: 'scope' })
phase('Work')
const many = await parallel(['a', 'b'].map(x => () => agent(x, {
  label: 'item ' + x,
  schema: {
    type: 'object',
    required: ['value'],
    properties: { value: { type: 'string' } }
  }
})))
const piped = await pipeline([1, 2], n => n + 1, n => n * 2)
return { one, many, piped, cwd }
`,
      {
        args: { name: "demo" },
        cwd: cwdDir,
        runner,
      },
    );

    assert.equal(result.meta.name, "runtime_demo");
    assert.deepEqual(result.phases, ["Scope", "Work"]);
    assert.equal(result.logs[0], "starting demo");
    assert.equal(result.agentCount, 3);
    assert.deepEqual(result.result, {
      one: "text:scope",
      many: [{ value: "A" }, { value: "B" }],
      piped: [4, 6],
      cwd: cwdDir,
    });
  } finally {
    await rm(cwdDir, { recursive: true, force: true });
  }
});

test("runWorkflow executes open TS/JS through Bun with direct Node side effects", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-open-"));
  try {
    const outputPath = path.join(dir, "out.txt");
    const result = await runWorkflow(
      `export const meta: { name: string; description: string } = {
  name: 'open_runtime',
  description: 'Open Bun runtime'
} as const

import { writeFileSync } from 'node:fs'
import pathModule, { basename } from 'node:path'
type Payload = { written: string; base: string; randomOk: boolean; nowOk: boolean; functionOk: boolean }

const now: number = Date.now()
const randomValue: number = Math.random()
const dynamicPath = await import('node:path')
const viaRequire = require('node:path')
writeFileSync(args.file, basename(args.file) + ':' + dynamicPath.dirname(args.file))
export const helper = pathModule.sep

return {
  written: Bun.file(args.file).exists() ? 'yes' : 'no',
  base: viaRequire.basename(args.file),
  randomOk: randomValue >= 0 && randomValue < 1,
  nowOk: new Date(now).getTime() === now,
  functionOk: Function('return Date.now() > 0')(),
} satisfies Payload
`,
      {
        args: { file: outputPath },
        runner: new ScriptedAgentRunner(() => "unused"),
      },
    );

    assert.deepEqual(result.result, {
      written: "yes",
      base: "out.txt",
      randomOk: true,
      nowOk: true,
      functionOk: true,
    });
    assert.equal(await readFile(outputPath, "utf8"), `out.txt:${dir}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("parallel rejects promise arrays like Claude workflow runtime", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'bad_parallel', description: 'Bad parallel shape' }
const p = agent('x', { label: 'x' })
return parallel([p])
`,
        { runner: new ScriptedAgentRunner(() => "x") },
      ),
    /parallel\(\) expects an array of functions/,
  );
});

test("runWorkflow catches unawaited agent promises in final result", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'promise_leak', description: 'Return promise' }
const value = agent('x', { label: 'x' })
return { value }
`,
        { runner: new ScriptedAgentRunner(() => "x") },
      ),
    /did you forget to await agent\(\)/,
  );
});

test("runWorkflow reuses completed agent calls from journal on resume", async () => {
  const journal = new InMemoryWorkflowJournal();
  let invocations = 0;
  const runner = new ScriptedAgentRunner((call) => {
    invocations++;
    return `fresh:${invocations}:${call.prompt}`;
  });
  const script = `export const meta = { name: 'resume_demo', description: 'Resume cached agents' }
const value = await agent('same prompt', { label: 'same' })
return { value }
`;

  const first = await runWorkflow(script, { runner, journal, runId: "wf_resume" });
  const second = await runWorkflow(script, { runner, journal, runId: "wf_resume" });

  assert.deepEqual(first.result, { value: "fresh:1:same prompt" });
  assert.deepEqual(second.result, { value: "fresh:1:same prompt" });
  assert.equal(first.cacheHits, 0);
  assert.equal(second.cacheHits, 1);
  assert.equal(second.agentCount, 1);
  assert.equal(invocations, 1);
});

test("runWorkflow journal key changes when prompt or options change", async () => {
  const journal = new InMemoryWorkflowJournal();
  let invocations = 0;
  const runner = new ScriptedAgentRunner((call) => {
    invocations++;
    return `fresh:${invocations}:${call.prompt}:${call.options.label}`;
  });

  const scriptA = `export const meta = { name: 'key_a', description: 'Key A' }
return agent('prompt A', { label: 'same' })
`;
  const scriptB = `export const meta = { name: 'key_b', description: 'Key B' }
return agent('prompt B', { label: 'same' })
`;

  await runWorkflow(scriptA, { runner, journal, runId: "wf_key" });
  const second = await runWorkflow(scriptB, { runner, journal, runId: "wf_key" });

  assert.equal(second.cacheHits, 0);
  assert.equal(invocations, 2);
});

test("FileWorkflowJournal reuses cached agent results across runner instances", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-journal-"));
  try {
    const journal = new FileWorkflowJournal(dir);
    const script = `export const meta = { name: 'file_journal', description: 'File journal' }
const value = await agent('persist me', { label: 'persist' })
return { value }
`;

    let firstInvocations = 0;
    await runWorkflow(script, {
      runner: new ScriptedAgentRunner(() => {
        firstInvocations++;
        return "from first runner";
      }),
      journal,
      runId: "wf_file",
    });

    let secondInvocations = 0;
    const second = await runWorkflow(script, {
      runner: new ScriptedAgentRunner(() => {
        secondInvocations++;
        return "from second runner";
      }),
      journal: new FileWorkflowJournal(dir),
      runId: "wf_file",
    });

    assert.equal(firstInvocations, 1);
    assert.equal(secondInvocations, 0);
    assert.equal(second.cacheHits, 1);
    assert.deepEqual(second.result, { value: "from first runner" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkflow enforces maxAgents before limiter-queued calls start", async () => {
  let invocations = 0;
  const runner = new ScriptedAgentRunner(async (call) => {
    invocations++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return call.prompt;
  });

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'agent_cap', description: 'Agent cap' }
const calls = [0, 1, 2].map((n) => agent('p' + n, { label: 'p' + n }))
return Promise.all(calls)
`,
        { runner, concurrency: 1, maxAgents: 2 },
      ),
    /agent\(\) call cap reached/,
  );

  assert.ok(invocations <= 2);
});

test("runWorkflow reports missing Bun with an actionable error", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'missing_bun', description: 'Missing Bun' }
return 1
`,
        {
          bunPath: "definitely-not-a-bun-binary",
          runner: new ScriptedAgentRunner(() => "unused"),
        },
      ),
    /Bun runtime not found/,
  );
});

test("runWorkflow strips null optional structured fields before loose-schema validation", async () => {
  const result = await runWorkflow(
    `export const meta = { name: 'optional_schema', description: 'Optional structured output' }
return agent('json', {
  label: 'json',
  schema: {
    type: 'object',
    required: ['required'],
    properties: {
      required: { type: 'string' },
      optional: { type: 'string' },
    },
  },
})
`,
    {
      runner: new ScriptedAgentRunner(() => ({ required: "ok", optional: null })),
    },
  );

  assert.deepEqual(result.result, { required: "ok" });
});

test("runWorkflow applies meta phase model unless an agent sets model explicitly", async () => {
  const result = await runWorkflow(
    `export const meta = {
  name: 'phase_model',
  description: 'Phase model',
  phases: [{ title: 'Plan', model: 'phase-model' }],
}
phase('Plan')
const inherited = await agent('inherited', { label: 'inherited' })
const explicit = await agent('explicit', { label: 'explicit', model: 'explicit-model' })
return { inherited, explicit }
`,
    {
      runner: new ScriptedAgentRunner((call) => call.options.model ?? "none"),
    },
  );

  assert.deepEqual(result.result, {
    inherited: "phase-model",
    explicit: "explicit-model",
  });
});

test("runWorkflow retries a transient agent failure then succeeds", async () => {
  let attempts = 0;
  const runner = new ScriptedAgentRunner(() => {
    attempts++;
    if (attempts < 3) throw new Error(`transient ${attempts}`);
    return "recovered";
  });

  const result = await runWorkflow<{ value: unknown }>(
    `export const meta = { name: 'retry_ok', description: 'Retry then succeed' }
const value = await agent('flaky', { label: 'flaky' })
return { value }
`,
    { runner, agentMaxAttempts: 3 },
  );

  assert.equal(attempts, 3);
  assert.equal(result.result.value, "recovered");
  assert.equal(result.failures.length, 0);
});

test("runWorkflow returns null and records a failure after exhausting retries", async () => {
  let attempts = 0;
  const runner = new ScriptedAgentRunner(() => {
    attempts++;
    throw new Error("always fails");
  });

  const result = await runWorkflow<{ value: unknown }>(
    `export const meta = { name: 'retry_exhausted', description: 'Exhaust retries' }
const value = await agent('doomed', { label: 'doomed' })
return { value }
`,
    { runner, agentMaxAttempts: 2 },
  );

  assert.equal(attempts, 2);
  assert.equal(result.result.value, null);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0]?.label, "doomed");
  assert.equal(result.failures[0]?.attempts, 2);
  assert.match(result.failures[0]?.error ?? "", /always fails/);
});

test("budget uses runner-reported output tokens and cache hits cost nothing", async () => {
  // A runner that reports a fixed real token count via onMeta on every live run.
  const runner: WorkflowAgentRunner = {
    async run(call, _signal, onMeta?: (meta: WorkflowAgentMeta) => void) {
      onMeta?.({ outputTokens: 100 });
      return call.prompt;
    },
  };

  const result = await runWorkflow<{ spent: number }>(
    `export const meta = { name: 'budget_real', description: 'Real token budget' }
const a = await agent('same', { label: 'x' })
const b = await agent('same', { label: 'x' })
return { a, b, spent: budget.spent() }
`,
    { runner, journal: new InMemoryWorkflowJournal() },
  );

  // First call is live (+100 real tokens); the second is an identical cache hit (+0, not the
  // length/4 estimate). Total stays 100 — proving real usage feeds spent and cache hits are free.
  assert.equal(result.result.spent, 100);
  assert.equal(result.cacheHits, 1);
});

test("runWorkflow progress exposes running agent detail before journal write", async () => {
  const events: any[] = [];
  const runner: WorkflowAgentRunner = {
    async run(call, _signal, onMeta?: (meta: WorkflowAgentMeta) => void) {
      onMeta?.({ sessionId: "sess-live" });
      return `ok:${call.prompt}`;
    },
  };

  await runWorkflow(
    `export const meta = { name: 'live_detail', description: 'Live detail' }
return agent('inspect while running', { label: 'inspect', model: 'm-live' })
`,
    {
      runner,
      onProgress: (event) => events.push(event),
    },
  );

  const started = events.filter((event) => event.type === "agent" && event.state === "started");
  assert.ok(started.length >= 1);
  assert.equal(started[0].prompt, "inspect while running");
  assert.equal(started[0].options.label, "inspect");
  assert.equal(started[0].options.model, "m-live");
  assert.ok(started.some((event) => event.sessionId === "sess-live"));
});

test("runWorkflow abort tolerates a late agent response after the Bun child is closed", async () => {
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const runner: WorkflowAgentRunner = {
    async run() {
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 40));
      return "late result";
    },
  };

  const promise = runWorkflow(
    `export const meta = { name: 'abort_late_agent', description: 'Abort with late agent response' }
return agent('slow', { label: 'slow' })
`,
    { runner, signal: controller.signal },
  );

  await started;
  controller.abort();
  await assert.rejects(promise, WorkflowAbortError);
});

test("the agent cap error carries the Claude-style 'remaining() returns Infinity' guidance", async () => {
  // In-process, the cap throws WorkflowAgentCapError; once it crosses the Bun-child IPC boundary the
  // type is flattened to a message-only error, so the distinctive guidance text is the contract.
  assert.ok(new WorkflowAgentCapError("x") instanceof Error);
  const runner = new ScriptedAgentRunner((call) => call.prompt);
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'cap_type', description: 'Cap error type' }
return Promise.all([0, 1, 2].map((n) => agent('p' + n, { label: 'p' + n })))
`,
        { runner, concurrency: 1, maxAgents: 2 },
      ),
    /agent\(\) call cap reached \(2\)[\s\S]*remaining\(\) returns Infinity/,
  );
});

test("budget counts real tokens burned by failed (validation-rejected) attempts", async () => {
  // Every turn completes and reports 50 real output tokens, but returns non-JSON so schema validation
  // rejects it — a completed-but-rejected turn. All three attempts burned tokens; spent must reflect that.
  const runner: WorkflowAgentRunner = {
    async run(_call, _signal, onMeta?: (meta: WorkflowAgentMeta) => void) {
      onMeta?.({ outputTokens: 50 });
      return "not json";
    },
  };

  const result = await runWorkflow<{ v: unknown; spent: number }>(
    `export const meta = { name: 'burn_failed', description: 'Failed attempts burn tokens' }
const v = await agent('x', {
  label: 'x',
  schema: { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
})
return { v, spent: budget.spent() }
`,
    { runner, agentMaxAttempts: 3 },
  );

  assert.equal(result.result.v, null);
  assert.equal(result.failures.length, 1);
  // 3 attempts x 50 tokens each — not 0 (which is what the old success-only accounting recorded).
  assert.equal(result.result.spent, 150);
});

test("a throwing onProgress(completed) does not re-run or re-spend the agent", async () => {
  let invocations = 0;
  const runner = new ScriptedAgentRunner(() => {
    invocations++;
    return "ok";
  });

  const result = await runWorkflow(
    `export const meta = { name: 'progress_throw', description: 'Throwing onProgress' }
return agent('x', { label: 'x' })
`,
    {
      runner,
      agentMaxAttempts: 3,
      onProgress: (event) => {
        if (event.type === "agent" && event.state === "completed") throw new Error("boom");
      },
    },
  );

  // The callback threw AFTER a successful model turn; C7 makes it best-effort so the agent is not retried.
  assert.equal(invocations, 1);
  assert.equal(result.result, "ok");
  assert.equal(result.failures.length, 0);
});

test("a failing journal.put does not re-run the agent (best-effort cache write)", async () => {
  let invocations = 0;
  const runner = new ScriptedAgentRunner(() => {
    invocations++;
    return "ok";
  });
  const journal = {
    get: () => undefined,
    put: () => {
      throw new Error("disk full");
    },
  };

  const result = await runWorkflow(
    `export const meta = { name: 'put_throw', description: 'Throwing journal.put' }
return agent('x', { label: 'x' })
`,
    { runner, agentMaxAttempts: 3, journal },
  );

  assert.equal(invocations, 1);
  assert.equal(result.result, "ok");
  assert.equal(result.failures.length, 0);
});

test("parallel() rethrows a fatal agent-cap error instead of collapsing it to null", async () => {
  const runner = new ScriptedAgentRunner(async (call) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return call.prompt;
  });

  // The 3rd agent() hits the cap → a fatal error that must survive the IPC boundary (via the structured
  // `fatal` flag) and be rethrown by parallel(), hard-failing the run rather than becoming a null item.
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'cap_parallel', description: 'Cap inside parallel' }
return parallel([0, 1, 2].map((n) => () => agent('p' + n, { label: 'p' + n })))
`,
        { runner, concurrency: 1, maxAgents: 2 },
      ),
    /agent\(\) call cap reached/,
  );
});

test("agent() throws WorkflowBudgetExceededError once the token budget is exhausted", async () => {
  // In-process, ctx.runAgent throws this dedicated type (src/runtime.ts); once it crosses the
  // Bun-child IPC boundary the type is flattened to a generic WorkflowInputError, so (like the
  // agent-cap error) the message text is the real observable contract below.
  assert.ok(new WorkflowBudgetExceededError("x") instanceof Error);

  // Every turn reports 50 real output tokens; a budget of 40 is exhausted before the first
  // agent() call even completes its retry loop — the throw happens synchronously in ctx.runAgent,
  // before any live run, so no runner turn is actually spent here.
  const runner: WorkflowAgentRunner = {
    async run(call, _signal, onMeta?: (meta: WorkflowAgentMeta) => void) {
      onMeta?.({ outputTokens: 50 });
      return call.prompt;
    },
  };

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'budget_exhausted', description: 'Budget exhausted throws' }
const a = await agent('first', { label: 'first' })
const b = await agent('second', { label: 'second' })
return { a, b }
`,
        { runner, tokenBudget: 40 },
      ),
    // Once the error crosses the Bun-child IPC boundary it is flattened to a generic
    // WorkflowInputError (message-only contract, same as the cap error above); the distinctive
    // "workflow token budget exhausted" text — which in-process is a WorkflowBudgetExceededError,
    // see src/runtime.ts's ctx.runAgent — is what's observable here.
    /workflow token budget exhausted/,
  );
});

test("parallel() rethrows a fatal budget-exceeded error instead of collapsing it to null", async () => {
  const runner: WorkflowAgentRunner = {
    async run(call, _signal, onMeta?: (meta: WorkflowAgentMeta) => void) {
      onMeta?.({ outputTokens: 50 });
      return call.prompt;
    },
  };

  // The lone `await agent('warm', ...)` burns 50 tokens against a 40-token budget, so by the time
  // parallel() synchronously dispatches its 3 thunks, remainingBudget() is already <= 0 for every
  // one of them (the budget check in ctx.runAgent runs synchronously before the concurrency limiter,
  // so gating on `spent` mid-flight inside parallel() itself is not observable — this is the
  // deterministic way to make the budget check fail for calls issued from inside parallel()).
  // Like the cap test above, this fatal error must survive the IPC boundary (structured `fatal`
  // flag) and be rethrown by parallel(), hard-failing the run rather than becoming a null item.
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'budget_parallel', description: 'Budget exceeded inside parallel' }
await agent('warm', { label: 'warm' })
return parallel([0, 1, 2].map((n) => () => agent('p' + n, { label: 'p' + n })))
`,
        { runner, tokenBudget: 40 },
      ),
    /workflow token budget exhausted/,
  );
});

test("Bun-child idle watchdog kills a workflow that busy-waits without calling agent()", async () => {
  // No agent()/workflow() call is ever made, so the child never sends an IPC request and the parent's
  // idle watchdog (armed whenever the child is not waiting on a parent-handled request) must fire on
  // its own. The busy-wait uses short setTimeout ticks (not a tight synchronous loop) so the child's
  // event loop stays responsive enough to be killed and exit cleanly once the parent settles.
  const runner = new ScriptedAgentRunner(() => "unused");

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'idle_watchdog', description: 'Busy-wait with no agent calls' }
const start = Date.now()
while (Date.now() - start < 5000) {
  await new Promise((resolve) => setTimeout(resolve, 10))
}
return 'done'
`,
        { runner, workflowIdleTimeoutMs: 300 },
      ),
    (err: unknown) => {
      assert.ok(err instanceof WorkflowInputError);
      assert.match((err as Error).message, /Bun workflow made no progress for 300ms/);
      return true;
    },
  );
});

test("auto-labeled agents hash stably regardless of run-global arrival index (resume cache)", async () => {
  const journal = new InMemoryWorkflowJournal();
  let sharedRuns = 0;
  const runner = new ScriptedAgentRunner((call) => {
    if (call.prompt === "shared") sharedRuns++;
    return `r:${call.prompt}`;
  });

  // Run 1: 'shared' is the only agent → arrival index 1 → auto label "agent 1".
  await runWorkflow(
    `export const meta = { name: 'idx_a', description: 'shared first' }
return agent('shared')
`,
    { runner, journal, runId: "wf_idx" },
  );

  // Run 2 (same runId + journal): two fillers run first, so 'shared' now has arrival index 3 → auto
  // label "agent 3". If the auto label were part of the cache key this would MISS and re-run the agent.
  const second = await runWorkflow(
    `export const meta = { name: 'idx_b', description: 'shared last' }
await agent('filler-1')
await agent('filler-2')
return agent('shared')
`,
    { runner, journal, runId: "wf_idx" },
  );

  assert.equal(second.result, "r:shared");
  // 'shared' ran once (run 1); run 2 was a cache hit despite a different arrival index / display label.
  assert.equal(sharedRuns, 1);
});
