import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowInputError } from "./errors.js";
import { parseWorkflowScript } from "./parser.js";
import { runWorkflow } from "./runtime.js";
import type {
  WorkflowAgentRunner,
  WorkflowMeta,
  WorkflowRef,
  WorkflowResolver,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./types.js";

export interface WorkflowInput {
  script?: string;
  name?: string;
  description?: string;
  title?: string;
  args?: unknown;
  scriptPath?: string;
  resumeFromRunId?: string;
}

export interface WorkflowOutput<T = unknown> {
  status: "completed";
  taskType: "local_workflow";
  workflowName: string;
  runId: string;
  summary: string;
  result: T;
  scriptPath?: string;
  source: WorkflowSourceKind;
  stats: {
    agentCount: number;
    cacheHits: number;
    durationMs: number;
    phases: string[];
    logs: string[];
  };
}

export type WorkflowSourceKind = "inline" | "named" | "scriptPath";

export interface WorkflowToolOptions extends Omit<WorkflowRunOptions, "args" | "runId" | "runner"> {
  runner: WorkflowAgentRunner;
  registry?: WorkflowRegistry;
  persistDir?: string;
}

export interface RegisteredWorkflow {
  name: string;
  script: string;
  path?: string;
  source: "built-in" | "project" | "user";
  meta: WorkflowMeta;
}

export interface WorkflowRegistryDirectory {
  dir: string;
  source: "project" | "user";
}

export class WorkflowRegistry {
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  private readonly workflowDirs: WorkflowRegistryDirectory[];

  constructor(workflowDirs: Array<string | WorkflowRegistryDirectory> = []) {
    this.workflowDirs = workflowDirs.map((entry) => (typeof entry === "string" ? { dir: entry, source: "project" } : entry));
  }

  register(script: string, source: RegisteredWorkflow["source"] = "built-in", scriptPath?: string): RegisteredWorkflow {
    const meta = parseWorkflowScript(script).meta;
    const workflow: RegisteredWorkflow = {
      name: meta.name,
      script,
      source,
      meta,
      ...(scriptPath !== undefined ? { path: scriptPath } : {}),
    };
    this.workflows.set(meta.name, workflow);
    return workflow;
  }

  async resolve(name: string): Promise<RegisteredWorkflow | null> {
    const direct = this.workflows.get(name);
    if (direct) return direct;

    for (const { dir, source } of this.workflowDirs) {
      const workflow = await findWorkflowInDir(dir, name, source);
      if (workflow) {
        this.workflows.set(workflow.name, workflow);
        return workflow;
      }
    }

    return null;
  }

  async list(): Promise<RegisteredWorkflow[]> {
    const workflows = new Map(this.workflows);

    for (const { dir, source } of this.workflowDirs) {
      for (const workflow of await scanWorkflowsDir(dir, source)) {
        if (!workflows.has(workflow.name)) workflows.set(workflow.name, workflow);
      }
    }

    return [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export async function runWorkflowTool<T = unknown>(
  input: WorkflowInput,
  options: WorkflowToolOptions,
): Promise<WorkflowOutput<T>> {
  const resolved = await resolveWorkflowInput(input, options.registry, options.cwd);
  const runId = input.resumeFromRunId ?? `wf_${randomUUID().slice(0, 12)}`;
  const persistedScriptPath = await persistWorkflowScript(resolved.script, runId, options.persistDir, resolved.scriptPath);
  const result = await runWorkflow<T>(resolved.script, {
    ...options,
    args: input.args,
    runId,
    runner: options.runner,
    resolveWorkflow: options.resolveWorkflow ?? buildWorkflowResolver(options.registry, options.cwd),
  });

  return workflowOutput(result, resolved.source, persistedScriptPath);
}

/**
 * Builds the resolver used by the in-script `workflow()` primitive: `{ scriptPath }` reads the file;
 * a **path-like string** (contains a separator or ends in `.js`/`.ts`/`.mjs`) is loaded as a file
 * relative to `cwd`; any other bare string is looked up by name in the registry (when one is
 * provided).
 */
export function buildWorkflowResolver(registry: WorkflowRegistry | undefined, cwd: string = process.cwd()): WorkflowResolver {
  return async (ref: WorkflowRef) => {
    const scriptPath =
      typeof ref === "object" && ref && "scriptPath" in ref
        ? ref.scriptPath
        : typeof ref === "string" && looksLikePath(ref)
          ? ref
          : undefined;
    if (scriptPath !== undefined) {
      const resolvedPath = path.resolve(cwd, scriptPath);
      const script = await readWorkflowFile(resolvedPath);
      return { script, name: parseWorkflowScript(script).meta.name };
    }
    const name = String(ref);
    const found = await registry?.resolve(name);
    if (!found) throw new WorkflowInputError(`workflow("${name}") not found — pass a path (e.g. workflow("./other.js")) or register it`);
    return { script: found.script, name: found.name };
  };
}

function looksLikePath(ref: string): boolean {
  return ref.includes("/") || ref.includes("\\") || /\.(m?[jt]s)$/.test(ref);
}

export async function resolveWorkflowInput(
  input: WorkflowInput,
  registry: WorkflowRegistry | undefined,
  cwd: string = process.cwd(),
): Promise<{ script: string; source: WorkflowSourceKind; scriptPath?: string }> {
  if (input.scriptPath) {
    const resolvedPath = path.resolve(cwd, input.scriptPath);
    if (input.script !== undefined) return { script: input.script, source: "scriptPath", scriptPath: resolvedPath };
    return {
      script: await readWorkflowFile(resolvedPath),
      source: "scriptPath",
      scriptPath: resolvedPath,
    };
  }

  if (input.name) {
    const registered = await registry?.resolve(input.name);
    if (!registered) throw new WorkflowInputError(`Workflow "${input.name}" not found.`);
    return { script: input.script ?? registered.script, source: "named" };
  }

  if (input.script !== undefined) return { script: input.script, source: "inline" };

  throw new WorkflowInputError("Must provide script, name, or scriptPath");
}

async function readWorkflowFile(filePath: string): Promise<string> {
  if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
    throw new WorkflowInputError(`UNC paths are not allowed for workflow scriptPath: ${filePath}`);
  }
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkflowInputError(`Failed to read workflow script file ${filePath}: ${message}`);
  }
}

export async function persistWorkflowScript(
  script: string,
  runId: string,
  persistDir: string | undefined,
  existingPath: string | undefined,
): Promise<string | undefined> {
  if (!persistDir) return existingPath;
  await mkdir(persistDir, { recursive: true });
  const scriptPath = existingPath ?? path.join(persistDir, `${runId}.workflow.js`);
  await writeFile(scriptPath, script, "utf8");
  return scriptPath;
}

function workflowOutput<T>(
  result: WorkflowRunResult<T>,
  source: WorkflowSourceKind,
  scriptPath: string | undefined,
): WorkflowOutput<T> {
  return {
    status: "completed",
    taskType: "local_workflow",
    workflowName: result.meta.name,
    runId: result.runId,
    summary: result.meta.description,
    result: result.result,
    source,
    ...(scriptPath !== undefined ? { scriptPath } : {}),
    stats: {
      agentCount: result.agentCount,
      cacheHits: result.cacheHits,
      durationMs: result.durationMs,
      phases: result.phases,
      logs: result.logs,
    },
  };
}

export async function scanWorkflowsDir(
  dir: string,
  source: RegisteredWorkflow["source"],
): Promise<RegisteredWorkflow[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const workflows: RegisteredWorkflow[] = [];
  for (const entry of entries) {
    if (!/\.(m?[jt]s)$/.test(entry)) continue;
    const candidatePath = path.join(dir, entry);
    try {
      const script = await readFile(candidatePath, "utf8");
      const parsed = parseWorkflowScript(script);
      workflows.push({
        name: parsed.meta.name,
        script,
        path: candidatePath,
        source,
        meta: parsed.meta,
      });
    } catch {
      // Discovery ignores invalid workflow candidates; direct scriptPath execution still reports parse errors.
    }
  }

  return workflows;
}

async function findWorkflowInDir(
  dir: string,
  name: string,
  source: RegisteredWorkflow["source"],
): Promise<RegisteredWorkflow | null> {
  for (const workflow of await scanWorkflowsDir(dir, source)) {
    const workflowPath = workflow.path;
    const basename = workflowPath ? path.basename(workflowPath, path.extname(workflowPath)) : workflow.name;
    if (workflow.name === name || basename === name) return workflow;
  }
  return null;
}
