import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryWorkflowJournal, ScriptedAgentRunner, WorkflowController } from "../src/index.js";

const projectScript = `export const meta = {
  name: 'project_demo',
  description: 'Project workflow demo',
  phases: [{ title: 'Run' }]
}

phase('Run')
const value = await agent('project ' + args.name, { label: 'project' })
return { value }
`;

const userScript = `export const meta = {
  name: 'user_demo',
  description: 'User workflow demo'
}

return agent('user', { label: 'user' })
`;

const registeredScript = `export const meta = {
  name: 'registered_demo',
  description: 'Registered workflow demo'
}

return agent('registered ' + args.name, { label: 'registered' })
`;

test("WorkflowController lists default project/user workflows and registered workflows", async () => {
  const { cwd, homeDir, cleanup } = await temporaryWorkflowTree();
  try {
    const controller = new WorkflowController({
      cwd,
      homeDir,
      runner: new ScriptedAgentRunner(() => "unused"),
    });
    controller.register(registeredScript);

    const workflows = await controller.listWorkflows();
    assert.deepEqual(
      workflows.map((workflow) => `${workflow.source}:${workflow.name}`),
      ["project:project_demo", "built-in:registered_demo", "user:user_demo"],
    );
  } finally {
    await cleanup();
  }
});

test("WorkflowController runs named workflows through shared dependencies", async () => {
  const { cwd, homeDir, cleanup } = await temporaryWorkflowTree();
  try {
    const runner = new ScriptedAgentRunner((call) => `done:${call.prompt}`);
    const controller = new WorkflowController({ cwd, homeDir, runner });

    const output = await controller.run({ name: "project_demo", args: { name: "named" } });

    assert.equal(output.status, "completed");
    assert.equal(output.workflowName, "project_demo");
    assert.equal(output.source, "named");
    assert.deepEqual(output.result, { value: "done:project named" });
    assert.equal(output.stats.agentCount, 1);
    assert.equal(output.stats.phases[0], "Run");
  } finally {
    await cleanup();
  }
});

test("WorkflowController launches and waits for background workflows", async () => {
  const { cwd, homeDir, cleanup } = await temporaryWorkflowTree();
  try {
    const runner = new ScriptedAgentRunner((call) => `done:${call.prompt}`);
    const controller = new WorkflowController({ cwd, homeDir, runner });

    const launch = await controller.launch({ name: "project_demo", args: { name: "async" } });
    assert.equal(launch.status, "async_launched");
    assert.equal(launch.workflowName, "project_demo");
    assert.ok(launch.taskId.startsWith("task_local_workflow_"));
    assert.ok(launch.runId.startsWith("wf_"));
    assert.equal(controller.getTask(launch.taskId)?.status, "running");

    const output = await controller.wait<any>(launch.taskId);
    assert.deepEqual(output.result, { value: "done:project async" });
    assert.equal(controller.getTask(launch.taskId)?.status, "completed");
  } finally {
    await cleanup();
  }
});

test("WorkflowController cancellation aborts the active runner call", async () => {
  const { cwd, homeDir, cleanup } = await temporaryWorkflowTree();
  try {
    const runner = new ScriptedAgentRunner(
      (_call, signal) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          setTimeout(() => resolve("too late"), 100);
        }),
    );
    const controller = new WorkflowController({ cwd, homeDir, runner });

    const launch = await controller.launch({ name: "project_demo", args: { name: "cancel" } });
    controller.cancel(launch.taskId);

    await assert.rejects(() => controller.wait(launch.taskId), /Workflow aborted|aborted/);
    assert.equal(controller.getTask(launch.taskId)?.status, "cancelled");
  } finally {
    await cleanup();
  }
});

test("WorkflowController passes journal and resumeFromRunId through blocking runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-controller-resume-"));
  try {
    const journal = new InMemoryWorkflowJournal();
    let invocations = 0;
    const runner = new ScriptedAgentRunner((call) => {
      invocations++;
      return `fresh:${invocations}:${call.prompt}`;
    });
    const controller = new WorkflowController({ runner, journal, persistDir: path.join(dir, "runs") });

    const first = await controller.run({
      script: registeredScript,
      args: { name: "resume" },
      resumeFromRunId: "wf_controller",
    });
    const second = await controller.run({
      script: registeredScript,
      args: { name: "resume" },
      resumeFromRunId: "wf_controller",
    });

    assert.deepEqual(first.result, "fresh:1:registered resume");
    assert.deepEqual(second.result, "fresh:1:registered resume");
    assert.equal(first.stats.cacheHits, 0);
    assert.equal(second.stats.cacheHits, 1);
    assert.equal(invocations, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function temporaryWorkflowTree(): Promise<{ cwd: string; homeDir: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "codex-workflow-controller-"));
  const cwd = path.join(root, "project");
  const homeDir = path.join(root, "home");
  const projectWorkflows = path.join(cwd, ".claude", "workflows");
  const userWorkflows = path.join(homeDir, ".claude", "workflows");
  await mkdir(projectWorkflows, { recursive: true });
  await mkdir(userWorkflows, { recursive: true });
  await writeFile(path.join(projectWorkflows, "project_demo.js"), projectScript, "utf8");
  await writeFile(path.join(userWorkflows, "user_demo.js"), userScript, "utf8");
  await writeFile(path.join(userWorkflows, "broken.js"), "export const meta = 'bad'", "utf8");
  return {
    cwd,
    homeDir,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
