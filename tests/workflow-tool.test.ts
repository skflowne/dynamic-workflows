import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runWorkflowTool, ScriptedAgentRunner, WorkflowRegistry } from "../src/index.js";

const script = `export const meta = {
  name: 'tool_demo',
  description: 'Demo workflow tool',
  phases: [{ title: 'Run' }]
}

phase('Run')
const value = await agent('hello ' + args.name, { label: 'hello' })
return { value }
`;

test("runWorkflowTool executes inline scripts and persists a script copy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-tool-"));
  try {
    const runner = new ScriptedAgentRunner((call) => `result:${call.prompt}`);
    const output = await runWorkflowTool(
      { script, args: { name: "inline" } },
      {
        runner,
        persistDir: dir,
      },
    );

    assert.equal(output.status, "completed");
    assert.equal(output.workflowName, "tool_demo");
    assert.equal(output.source, "inline");
    assert.deepEqual(output.result, { value: "result:hello inline" });
    assert.ok(output.scriptPath);
    assert.equal(await readFile(output.scriptPath, "utf8"), script);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkflowTool resolves named workflows from registry", async () => {
  const registry = new WorkflowRegistry();
  registry.register(script);
  const runner = new ScriptedAgentRunner((call) => `result:${call.prompt}`);

  const output = await runWorkflowTool({ name: "tool_demo", args: { name: "named" } }, { registry, runner });

  assert.equal(output.source, "named");
  assert.deepEqual(output.result, { value: "result:hello named" });
});

test("runWorkflowTool resolves scriptPath and uses resumeFromRunId as run id", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-workflow-path-"));
  try {
    const file = path.join(dir, "tool_demo.js");
    await writeFile(file, script, "utf8");
    const runner = new ScriptedAgentRunner((call) => `run:${call.runId}:${call.prompt}`);

    const output = await runWorkflowTool(
      { scriptPath: "tool_demo.js", args: { name: "path" }, resumeFromRunId: "wf_resume-test" },
      { runner, cwd: dir },
    );

    assert.equal(output.source, "scriptPath");
    assert.equal(output.runId, "wf_resume-test");
    assert.deepEqual(output.result, { value: "run:wf_resume-test:hello path" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
