import { randomUUID } from "node:crypto";
import { WorkflowAbortError } from "./errors.js";
import { parseWorkflowScript } from "./parser.js";
import { runWorkflow } from "./runtime.js";
import {
  buildWorkflowResolver,
  persistWorkflowScript,
  resolveWorkflowInput,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowSourceKind,
  type WorkflowToolOptions,
} from "./workflow-tool.js";

export type WorkflowTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkflowLaunchOutput {
  status: "async_launched";
  taskId: string;
  taskType: "local_workflow";
  workflowName: string;
  runId: string;
  summary: string;
  scriptPath?: string;
  source: WorkflowSourceKind;
}

export interface WorkflowTask<T = unknown> {
  taskId: string;
  runId: string;
  workflowName: string;
  summary: string;
  status: WorkflowTaskStatus;
  startedAt: number;
  completedAt?: number;
  output?: WorkflowOutput<T>;
  error?: string;
  promise: Promise<WorkflowOutput<T>>;
}

export class WorkflowTaskManager {
  private readonly tasks = new Map<string, WorkflowTaskRecord>();

  async launch<T = unknown>(input: WorkflowInput, options: WorkflowToolOptions): Promise<WorkflowLaunchOutput> {
    const resolved = await resolveWorkflowInput(input, options.registry);
    const meta = parseWorkflowScript(resolved.script).meta;
    const runId = input.resumeFromRunId ?? `wf_${randomUUID().slice(0, 12)}`;
    const taskId = `task_local_workflow_${randomUUID().slice(0, 8)}`;
    const abortController = new AbortController();
    const scriptPath = await persistWorkflowScript(resolved.script, runId, options.persistDir, resolved.scriptPath);

    const task: WorkflowTaskRecord<T> = {
      taskId,
      runId,
      workflowName: meta.name,
      summary: meta.description,
      status: "running",
      startedAt: Date.now(),
      promise: Promise.resolve(undefined as never),
      abortController,
    };
    this.tasks.set(taskId, task);

    task.promise = runWorkflow<T>(resolved.script, {
      ...options,
      args: input.args,
      runId,
      runner: options.runner,
      signal: abortController.signal,
      resolveWorkflow: options.resolveWorkflow ?? buildWorkflowResolver(options.registry),
    })
      .then((result) => {
        const output: WorkflowOutput<T> = {
          status: "completed",
          taskType: "local_workflow",
          workflowName: result.meta.name,
          runId: result.runId,
          summary: result.meta.description,
          result: result.result,
          source: resolved.source,
          ...(scriptPath !== undefined ? { scriptPath } : {}),
          stats: {
            agentCount: result.agentCount,
            cacheHits: result.cacheHits,
            durationMs: result.durationMs,
            phases: result.phases,
            logs: result.logs,
            failures: result.failures,
          },
        };
        task.status = "completed";
        task.completedAt = Date.now();
        task.output = output;
        return output;
      })
      .catch((error) => {
        task.completedAt = Date.now();
        task.status = abortController.signal.aborted ? "cancelled" : "failed";
        task.error = error instanceof Error ? error.message : String(error);
        throw error;
      });

    // Avoid unhandled rejection if callers use getTask()/listTasks() instead of wait().
    task.promise.catch(() => undefined);

    return {
      status: "async_launched",
      taskId,
      taskType: "local_workflow",
      workflowName: meta.name,
      runId,
      summary: meta.description,
      source: resolved.source,
      ...(scriptPath !== undefined ? { scriptPath } : {}),
    };
  }

  getTask<T = unknown>(taskId: string): WorkflowTask<T> | undefined {
    return this.tasks.get(taskId) as WorkflowTask<T> | undefined;
  }

  listTasks(): WorkflowTask[] {
    return [...this.tasks.values()];
  }

  async wait<T = unknown>(taskId: string): Promise<WorkflowOutput<T>> {
    const task = this.getTask<T>(taskId);
    if (!task) throw new Error(`Workflow task ${taskId} not found`);
    return task.promise;
  }

  cancel(taskId: string): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Workflow task ${taskId} not found`);
    if (task.status !== "running") return;
    task.status = "cancelled";
    task.completedAt = Date.now();
    task.error = new WorkflowAbortError().message;
    task.abortController.abort();
  }
}

interface WorkflowTaskRecord<T = unknown> extends WorkflowTask<T> {
  abortController: AbortController;
}
