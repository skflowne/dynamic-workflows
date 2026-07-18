import assert from "node:assert/strict";
import test from "node:test";
import { runWorkflow, ScriptedAgentRunner, WorkflowRegistry } from "../src/index.js";
import type { WorkflowAgentRunner } from "../src/index.js";
import { buildWorkflowResolver } from "../src/workflow-tool.js";

const CHILD = `export const meta = { name: 'child', description: 'child workflow' }
const results = await parallel(args.items.map((i) => () => agent('child:' + i, { label: i })))
return results
`;

test("workflow() runs a nested workflow sharing the agent-count cap", async () => {
  const registry = new WorkflowRegistry();
  registry.register(CHILD, "built-in");
  const runner = new ScriptedAgentRunner((call) => `done:${call.prompt}`);

  const result = await runWorkflow(
    `export const meta = { name: 'parent', description: 'parent workflow' }
const a = await agent('root work', { label: 'root' })
const nested = await workflow('child', { items: ['x', 'y'] })
return { a, nested }
`,
    { runner, resolveWorkflow: buildWorkflowResolver(registry) },
  );

  assert.deepEqual(result.result, {
    a: "done:root work",
    nested: ["done:child:x", "done:child:y"],
  });
  // 1 root agent + 2 child agents, counted against the same shared cap.
  assert.equal(result.agentCount, 3);
});

test("workflow() shares the token budget across root and nested runs", async () => {
  const registry = new WorkflowRegistry();
  registry.register(
    `export const meta = { name: 'spendy', description: 'reports shared spend' }
await agent('b', { label: 'b' })
return { spent: budget.spent() }
`,
    "built-in",
  );
  const runner = new ScriptedAgentRunner((call) => `done:${call.prompt}`);

  const result = await runWorkflow<{ spent: { spent: number } }>(
    `export const meta = { name: 'spendy_parent', description: 'p' }
await agent('a', { label: 'a' })
const spent = await workflow('spendy', {})
return { spent }
`,
    { runner, resolveWorkflow: buildWorkflowResolver(registry) },
  );

  // Each "done:x" result estimates to 2 tokens; by the time the child's agent('b') response
  // returns, the shared pool reflects both the root and the nested agent (2 + 2 = 4).
  assert.equal(result.result.spent.spent, 4);
});

test("workflow() nesting is one level only", async () => {
  const registry = new WorkflowRegistry();
  registry.register(
    `export const meta = { name: 'deep', description: 'tries to nest again' }
return await workflow('deep', {})
`,
    "built-in",
  );
  const runner = new ScriptedAgentRunner(() => "x");

  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'deep_parent', description: 'p' }
return await workflow('deep', {})
`,
        { runner, resolveWorkflow: buildWorkflowResolver(registry) },
      ),
    /one level only/,
  );
});

test("workflow() without a resolver throws a helpful error", async () => {
  await assert.rejects(
    () =>
      runWorkflow(
        `export const meta = { name: 'no_resolver', description: 'p' }
return await workflow('child', {})
`,
        { runner: new ScriptedAgentRunner(() => "x") },
      ),
    /requires a resolver/,
  );
});

test("runWorkflow tears down a fire-and-forget nested workflow left in flight (no orphan)", async () => {
  // The root fires a nested workflow() WITHOUT awaiting it; that nested run's agent blocks until aborted.
  // A root-side gate agent only resolves once the nested agent has actually started, so the nested Bun
  // child is provably in flight when the root returns. On teardown the nested promise (tracked in
  // inFlight) is awaited and the nested child (inheriting ctx.agentSignal) is killed — its blocking agent
  // is aborted — rather than leaking an orphaned Bun child that re-arms its idle watchdog forever.
  let nestedAborted = false;
  let markNestedStarted!: () => void;
  const nestedStarted = new Promise<void>((resolve) => {
    markNestedStarted = resolve;
  });

  const registry = new WorkflowRegistry();
  registry.register(
    `export const meta = { name: 'child_hang', description: 'blocks until aborted' }
return await agent('hang forever', { label: 'hang' })
`,
    "built-in",
  );

  const runner: WorkflowAgentRunner = {
    run(call, signal) {
      if (call.prompt === "hang forever") {
        return new Promise((_resolve, reject) => {
          markNestedStarted();
          const onAbort = () => {
            nestedAborted = true;
            reject(new Error("aborted"));
          };
          if (signal?.aborted) return onAbort();
          signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      // The root gate: do not let the root finish until the nested agent has started.
      return nestedStarted.then(() => "go");
    },
  };

  const result = await runWorkflow<{ ok: boolean }>(
    `export const meta = { name: 'ff_nested', description: 'fire and forget nested workflow' }
workflow('child_hang', {})
await agent('root gate', { label: 'gate' })
return { ok: true }
`,
    { runner, resolveWorkflow: buildWorkflowResolver(registry), concurrency: 4 },
  );

  assert.deepEqual(result.result, { ok: true });
  // The nested agent was in flight and got aborted on teardown (proving the nested child was killed,
  // not orphaned) — and the run completed instead of hanging on the un-awaited nested workflow.
  assert.equal(nestedAborted, true);
});

test("runWorkflow cancels fire-and-forget agents left in flight at finish", async () => {
  let started = false;
  let aborted = false;
  const runner = new ScriptedAgentRunner(
    (_call, signal) =>
      new Promise((_resolve, reject) => {
        started = true;
        const onAbort = () => {
          aborted = true;
          reject(new Error("aborted"));
        };
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        // Otherwise never resolves — simulates a long-running Codex thread.
      }),
  );

  const result = await runWorkflow<{ ok: boolean }>(
    `export const meta = { name: 'leaky', description: 'fire and forget' }
agent('long running', { label: 'leak' })
return { ok: true }
`,
    { runner },
  );

  assert.deepEqual(result.result, { ok: true });
  assert.equal(started, true);
  assert.equal(aborted, true);
});
