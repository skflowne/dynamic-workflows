import os from "node:os";
import path from "node:path";
import { FileWorkflowJournal } from "./journal.js";
import { CodexSdkAgentRunner, type CodexSdkAgentRunnerOptions } from "./runners/codex-sdk.js";
import { WorkflowTaskManager, type WorkflowLaunchOutput, type WorkflowTask } from "./task-manager.js";
import type { WorkflowAgentRunner, WorkflowJournal } from "./types.js";
import {
  runWorkflowTool,
  WorkflowRegistry,
  type RegisteredWorkflow,
  type WorkflowInput,
  type WorkflowOutput,
  type WorkflowRegistryDirectory,
  type WorkflowToolOptions,
} from "./workflow-tool.js";

type WorkflowControllerRunOptions = Omit<
  WorkflowToolOptions,
  "runner" | "registry" | "journal" | "persistDir" | "cwd"
>;

export interface WorkflowControllerOptions extends WorkflowControllerRunOptions {
  cwd?: string;
  homeDir?: string;
  runner?: WorkflowAgentRunner;
  codex?: CodexSdkAgentRunnerOptions;
  registry?: WorkflowRegistry;
  taskManager?: WorkflowTaskManager;
  journal?: WorkflowJournal;
  persistDir?: string;
  journalDir?: string;
  workflowDirs?: Array<string | WorkflowRegistryDirectory>;
}

export class WorkflowController {
  readonly cwd: string;
  readonly registry: WorkflowRegistry;
  readonly taskManager: WorkflowTaskManager;
  readonly runner: WorkflowAgentRunner;
  readonly journal: WorkflowJournal;
  readonly persistDir: string;
  private readonly runOptions: WorkflowControllerRunOptions;

  constructor(options: WorkflowControllerOptions = {}) {
    this.cwd = path.resolve(options.cwd ?? process.cwd());
    const homeDir = options.homeDir ?? os.homedir();
    const workflowDirs = options.workflowDirs ?? defaultWorkflowDirs(this.cwd, homeDir);

    this.registry = options.registry ?? new WorkflowRegistry(workflowDirs);
    this.taskManager = options.taskManager ?? new WorkflowTaskManager();
    this.runner = options.runner ?? new CodexSdkAgentRunner({ cwd: this.cwd, ...(options.codex ?? {}) });
    this.persistDir = options.persistDir ?? path.join(this.cwd, ".codex-workflow", "runs");
    this.journal = options.journal ?? new FileWorkflowJournal(options.journalDir ?? path.join(this.cwd, ".codex-workflow", "journal"));
    this.runOptions = controllerRunOptions(options);
  }

  register(
    script: string,
    source: RegisteredWorkflow["source"] = "built-in",
    scriptPath?: string,
  ): RegisteredWorkflow {
    return this.registry.register(script, source, scriptPath);
  }

  listWorkflows(): Promise<RegisteredWorkflow[]> {
    return this.registry.list();
  }

  run<T = unknown>(input: WorkflowInput): Promise<WorkflowOutput<T>> {
    return runWorkflowTool<T>(input, this.workflowOptions());
  }

  launch<T = unknown>(input: WorkflowInput): Promise<WorkflowLaunchOutput> {
    return this.taskManager.launch<T>(input, this.workflowOptions());
  }

  wait<T = unknown>(taskId: string): Promise<WorkflowOutput<T>> {
    return this.taskManager.wait<T>(taskId);
  }

  getTask<T = unknown>(taskId: string): WorkflowTask<T> | undefined {
    return this.taskManager.getTask<T>(taskId);
  }

  listTasks(): WorkflowTask[] {
    return this.taskManager.listTasks();
  }

  cancel(taskId: string): void {
    this.taskManager.cancel(taskId);
  }

  private workflowOptions(): WorkflowToolOptions {
    return {
      ...this.runOptions,
      cwd: this.cwd,
      runner: this.runner,
      registry: this.registry,
      journal: this.journal,
      persistDir: this.persistDir,
    };
  }
}

export function defaultWorkflowDirs(cwd: string, homeDir: string = os.homedir()): WorkflowRegistryDirectory[] {
  return [
    { dir: path.join(cwd, ".claude", "workflows"), source: "project" },
    { dir: path.join(homeDir, ".claude", "workflows"), source: "user" },
  ];
}

function controllerRunOptions(options: WorkflowControllerOptions): WorkflowControllerRunOptions {
  const runOptions: WorkflowControllerRunOptions = {};
  if (options.concurrency !== undefined) runOptions.concurrency = options.concurrency;
  if (options.maxAgents !== undefined) runOptions.maxAgents = options.maxAgents;
  if (options.tokenBudget !== undefined) runOptions.tokenBudget = options.tokenBudget;
  if (options.signal !== undefined) runOptions.signal = options.signal;
  if (options.onProgress !== undefined) runOptions.onProgress = options.onProgress;
  if (options.bunPath !== undefined) runOptions.bunPath = options.bunPath;
  return runOptions;
}
