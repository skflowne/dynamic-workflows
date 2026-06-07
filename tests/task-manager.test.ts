import assert from "node:assert/strict";
import test from "node:test";
import { ScriptedAgentRunner, WorkflowTaskManager } from "../src/index.js";

const script = `export const meta = {
  name: 'task_demo',
  description: 'Background task demo',
  phases: [{ title: 'Run' }]
}

phase('Run')
const value = await agent('work', { label: 'work' })
return { value }
`;

test("WorkflowTaskManager launches a background workflow and waits for output", async () => {
  const manager = new WorkflowTaskManager();
  const runner = new ScriptedAgentRunner((call) => `done:${call.prompt}`);

  const launch = await manager.launch({ script }, { runner });
  assert.equal(launch.status, "async_launched");
  assert.equal(launch.workflowName, "task_demo");

  const running = manager.getTask(launch.taskId);
  assert.equal(running?.status, "running");

  const output = await manager.wait<any>(launch.taskId);
  assert.equal(output.status, "completed");
  assert.deepEqual(output.result, { value: "done:work" });
  assert.equal(manager.getTask(launch.taskId)?.status, "completed");
});

test("WorkflowTaskManager cancel aborts the running workflow", async () => {
  const manager = new WorkflowTaskManager();
  const runner = new ScriptedAgentRunner(
    (_call, signal) =>
      new Promise((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        setTimeout(() => resolve("too late"), 100);
      }),
  );

  const launch = await manager.launch({ script }, { runner });
  manager.cancel(launch.taskId);

  await assert.rejects(() => manager.wait(launch.taskId), /Workflow aborted|aborted/);
  assert.equal(manager.getTask(launch.taskId)?.status, "cancelled");
});
