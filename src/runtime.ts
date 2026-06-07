import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Ajv } from "ajv/dist/ajv.js";
import { WorkflowAbortError, WorkflowBudgetExceededError, WorkflowInputError } from "./errors.js";
import { cloneJournalResult, journalEntryFromCall, workflowAgentCacheKey } from "./journal.js";
import { parseWorkflowScript } from "./parser.js";
import type {
  JsonSchema,
  WorkflowAgentOptions,
  WorkflowRef,
  WorkflowRunOptions,
  WorkflowRunResult,
} from "./types.js";

const MAX_ITEMS_PER_CALL = 4096;

interface RuntimeState {
  logs: string[];
  phases: string[];
  agentCount: number;
  nextAgentIndex: number;
  cacheHits: number;
  spent: number;
}

interface ChildRequestMessage {
  kind: "request";
  id: number;
  type: string;
  payload: {
    prompt?: unknown;
    options?: unknown;
    nameOrRef?: unknown;
    args?: unknown;
    depth?: unknown;
  };
}

interface ChildEventMessage {
  kind: "event";
  type: "phase" | "log";
  payload: Record<string, unknown>;
}

interface ChildResultMessage {
  kind: "result";
  value: unknown;
}

interface ChildErrorMessage {
  kind: "error";
  error: {
    message: string;
    stack?: string;
  };
}

type ChildMessage = ChildRequestMessage | ChildEventMessage | ChildResultMessage | ChildErrorMessage;

/**
 * Shared per-run state. Created once for the top-level workflow and reused by every nested
 * `workflow()` invocation so that all agents — across the root and nested scripts — share the same
 * concurrency limiter, agent-count cap, token budget, journal, and abort signal.
 */
interface RunContext {
  state: RuntimeState;
  limiter: <T>(fn: () => Promise<T>) => Promise<T>;
  maxAgents: number;
  tokenBudget: number | null | undefined;
  bunPath: string;
  cwd: string;
  userSignal?: AbortSignal;
  /** Internal controller; aborted once the root workflow settles to cancel any leaked agents. */
  internalAbort: AbortController;
  /** Signal handed to the runner: fires on user cancel OR internal cleanup. */
  agentSignal: AbortSignal;
  /** In-flight runner promises, awaited on teardown so Codex threads stop cleanly. */
  inFlight: Set<Promise<unknown>>;
  options: WorkflowRunOptions;
  emitLog: (message: unknown) => void;
  recordPhase: (title: unknown) => void;
  runAgent: (prompt: unknown, options?: unknown) => Promise<unknown>;
  runNestedWorkflow: (nameOrRef: unknown, args: unknown, callerDepth: number) => Promise<unknown>;
}

interface BunChildOptions {
  bunPath: string;
  cwd: string;
  signal?: AbortSignal;
  emitLog: (message: unknown) => void;
  recordPhase: (title: unknown) => void;
  runAgent: (prompt: unknown, options?: unknown) => Promise<unknown>;
  runNestedWorkflow: (nameOrRef: unknown, args: unknown, callerDepth: number) => Promise<unknown>;
  spent: () => number;
}

const ajv = new Ajv({ allErrors: true, strict: false });
const IPC_PREFIX = "__CODEX_WORKFLOW_IPC__";

export async function runWorkflow<T = unknown>(
  script: string,
  options: WorkflowRunOptions,
): Promise<WorkflowRunResult<T>> {
  const started = Date.now();
  const parsed = parseWorkflowScript(script);
  const runId = options.runId ?? `wf_${cryptoRandomId()}`;
  const ctx = createRunContext(options, runId);

  try {
    const result = await executeWorkflow(parsed.body, parsed.meta.name, ctx, options.args, 0, undefined);

    assertStructuredCloneable(result, "workflow result");
    const clonedResult = structuredClone(result);

    return {
      meta: parsed.meta,
      result: clonedResult as T,
      logs: ctx.state.logs,
      phases: ctx.state.phases,
      agentCount: ctx.state.agentCount,
      durationMs: Date.now() - started,
      runId,
      cacheHits: ctx.state.cacheHits,
    };
  } finally {
    if (ctx.inFlight.size > 0) {
      ctx.emitLog(`workflow finished with ${ctx.inFlight.size} un-awaited agent(s) still in flight; cancelling them.`);
    }
    ctx.internalAbort.abort();
    await Promise.allSettled([...ctx.inFlight]);
  }
}

function createRunContext(options: WorkflowRunOptions, runId: string): RunContext {
  const state: RuntimeState = { logs: [], phases: [], agentCount: 0, nextAgentIndex: 0, cacheHits: 0, spent: 0 };
  const limiter = createLimiter(resolveConcurrency(options.concurrency));
  const internalAbort = new AbortController();
  const agentSignal = options.signal ? anySignal([internalAbort.signal, options.signal]) : internalAbort.signal;
  const inFlight = new Set<Promise<unknown>>();

  const emitLog = (message: unknown) => {
    const text = String(message);
    state.logs.push(text);
    options.onProgress?.({ type: "log", message: text });
  };

  const recordPhase = (title: unknown) => {
    const text = requireString(title, "phase title");
    if (!state.phases.includes(text)) state.phases.push(text);
    options.onProgress?.({ type: "phase", title: text });
  };

  const throwIfUserAborted = () => {
    if (options.signal?.aborted) throw new WorkflowAbortError();
  };

  const ctx: RunContext = {
    state,
    limiter,
    maxAgents: options.maxAgents ?? 1000,
    tokenBudget: options.tokenBudget,
    bunPath: options.bunPath ?? process.env.BUN_PATH ?? "bun",
    cwd: options.cwd ?? process.cwd(),
    internalAbort,
    agentSignal,
    inFlight,
    options,
    emitLog,
    recordPhase,
    runAgent: () => Promise.reject(new Error("runAgent not initialized")),
    runNestedWorkflow: () => Promise.reject(new Error("runNestedWorkflow not initialized")),
    ...(options.signal !== undefined ? { userSignal: options.signal } : {}),
  };

  ctx.runAgent = async (prompt: unknown, rawOptions: unknown = {}) => {
    throwIfUserAborted();
    if (state.agentCount >= ctx.maxAgents) {
      throw new WorkflowBudgetExceededError(
        `Workflow agent() call cap reached (${ctx.maxAgents}). Add a hard iteration cap to the loop, or pass a token budget.`,
      );
    }
    if (ctx.tokenBudget !== null && ctx.tokenBudget !== undefined && remainingBudget(ctx.tokenBudget, state) <= 0) {
      throw new WorkflowBudgetExceededError("workflow token budget exhausted");
    }

    const taskPrompt = requireString(prompt, "agent prompt");
    const agentOptions = normalizeAgentOptions(rawOptions);
    const assignedPhase = agentOptions.phase;
    const index = ++state.nextAgentIndex;
    const label = agentOptions.label?.trim() || defaultAgentLabel(assignedPhase, index);
    const callOptions = withAgentIdentity(agentOptions, label, assignedPhase);
    const cacheKey = workflowAgentCacheKey({ prompt: taskPrompt, options: callOptions });
    const call = {
      prompt: taskPrompt,
      options: callOptions,
      index,
      runId,
      cacheKey,
      ...(assignedPhase !== undefined ? { phase: assignedPhase } : {}),
    };

    return limiter(async () => {
      state.agentCount++;
      options.onProgress?.(agentProgress(label, assignedPhase, "started", { index, key: cacheKey }));
      try {
        throwIfUserAborted();
        const cached = await options.journal?.get(call.runId, cacheKey);
        if (cached) {
          const result = cloneJournalResult(cached);
          state.cacheHits++;
          state.spent += estimateTokens(result);
          options.onProgress?.(
            agentProgress(label, assignedPhase, "cached", {
              result,
              index,
              key: cacheKey,
              ...(cached.sessionId ? { sessionId: cached.sessionId } : {}),
            }),
          );
          return result;
        }

        if (ctx.internalAbort.signal.aborted) throw new WorkflowAbortError();
        let sessionId: string | undefined;
        const onMeta = (meta: { sessionId?: string }) => {
          if (meta.sessionId) sessionId = meta.sessionId;
        };
        const runPromise = Promise.resolve(options.runner.run(call, ctx.agentSignal, onMeta));
        inFlight.add(runPromise);
        let raw: unknown;
        try {
          raw = await runPromise;
        } finally {
          inFlight.delete(runPromise);
        }
        throwIfUserAborted();
        const result = normalizeAgentResult(raw, agentOptions.schema);
        await options.journal?.put(journalEntryFromCall(call, result, sessionId));
        state.spent += estimateTokens(result);
        options.onProgress?.(
          agentProgress(label, assignedPhase, "completed", { result, index, key: cacheKey, ...(sessionId ? { sessionId } : {}) }),
        );
        return result;
      } catch (error) {
        if (error instanceof WorkflowAbortError || options.signal?.aborted || ctx.internalAbort.signal.aborted) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        emitLog(`agent ${label} failed: ${message}`);
        options.onProgress?.(agentProgress(label, assignedPhase, "failed", { error: message, index, key: cacheKey }));
        throw error;
      }
    });
  };

  ctx.runNestedWorkflow = async (nameOrRef: unknown, args: unknown, callerDepth: number) => {
    throwIfUserAborted();
    if (callerDepth >= 1) {
      throw new WorkflowInputError("workflow() nesting is one level only");
    }
    if (!options.resolveWorkflow) {
      throw new WorkflowInputError(
        "workflow() requires a resolver/registry, but none was configured for this run.",
      );
    }
    const ref = toWorkflowRef(nameOrRef);
    const resolved = await options.resolveWorkflow(ref);
    const parsed = parseWorkflowScript(resolved.script);
    return executeWorkflow(parsed.body, parsed.meta.name, ctx, args, callerDepth + 1, resolved.name);
  };

  return ctx;
}

/**
 * Generates the Bun runner source for one script and executes it in a child process. The child
 * routes `agent()`, `workflow()`, `phase()`, and `log()` back to the shared {@link RunContext}.
 */
async function executeWorkflow(
  body: string,
  name: string,
  ctx: RunContext,
  args: unknown,
  depth: number,
  phasePrefix: string | undefined,
): Promise<unknown> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-bun-"));
  try {
    const safeName = (name || "workflow").replace(/[^A-Za-z0-9_.-]/g, "_") || "workflow";
    const runnerPath = path.join(tempDir, `${safeName}.runner.ts`);
    await writeFile(runnerPath, bunRunnerSource(body, ctx.tokenBudget, args, ctx.cwd, depth, phasePrefix), "utf8");
    const childOptions: BunChildOptions = {
      bunPath: ctx.bunPath,
      cwd: ctx.cwd,
      emitLog: ctx.emitLog,
      recordPhase: ctx.recordPhase,
      runAgent: ctx.runAgent,
      runNestedWorkflow: ctx.runNestedWorkflow,
      spent: () => ctx.state.spent,
    };
    if (ctx.userSignal !== undefined) childOptions.signal = ctx.userSignal;
    return await runBunChild(runnerPath, childOptions);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function bunRunnerSource(
  body: string,
  tokenBudget: number | null | undefined,
  args: unknown,
  cwd: string,
  depth: number,
  phasePrefix: string | undefined,
): string {
  return `const IPC_PREFIX = ${JSON.stringify(IPC_PREFIX)};
let nextRequestId = 1;
const pendingRequests = new Map();
const pendingWorkflowPromises = new Set();
let stdinBuffer = "";
let sharedSpent = 0;
const tokenBudget = ${tokenBudget === undefined ? "null" : JSON.stringify(tokenBudget)};
const args = ${args === undefined ? "undefined" : JSON.stringify(args)};
const cwd = ${JSON.stringify(cwd)};
const __depth = ${JSON.stringify(depth)};
const __phasePrefix = ${phasePrefix === undefined ? "undefined" : JSON.stringify(phasePrefix)};
let currentPhase = __phasePrefix;

function send(message) {
  process.stdout.write(IPC_PREFIX + JSON.stringify(message) + "\\n");
}

function finish(message) {
  send(message);
  setTimeout(() => process.exit(0), 0);
}

function emitLog(message) {
  send({ kind: "event", type: "log", payload: { message: String(message) } });
}

function request(type, payload) {
  const id = nextRequestId++;
  send({ kind: "request", id, type, payload });
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
  });
}

function trackWorkflowPromise(promise) {
  pendingWorkflowPromises.add(promise);
  promise.finally(() => pendingWorkflowPromises.delete(promise)).catch(() => undefined);
  return promise;
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdinBuffer += chunk;
  let index;
  while ((index = stdinBuffer.indexOf("\\n")) >= 0) {
    const line = stdinBuffer.slice(0, index);
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (!line.startsWith(IPC_PREFIX)) continue;
    const message = JSON.parse(line.slice(IPC_PREFIX.length));
    if (message.kind !== "response") continue;
    if (typeof message.spent === "number") sharedSpent = message.spent;
    const pending = pendingRequests.get(message.id);
    if (!pending) continue;
    pendingRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.value);
  }
});

console.log = (...values) => emitLog(values.join(" "));
console.info = console.log;
console.warn = (...values) => emitLog("[warn] " + values.join(" "));
console.error = (...values) => emitLog("[error] " + values.join(" "));

function phase(title) {
  const text = String(title);
  currentPhase = __phasePrefix ? __phasePrefix + " \\u00b7 " + text : text;
  send({ kind: "event", type: "phase", payload: { title: currentPhase } });
}

function log(message) {
  emitLog(message);
}

function agent(prompt, options = {}) {
  const opts = options && typeof options === "object" ? { ...options } : options;
  if (opts && typeof opts === "object" && opts.phase === undefined && currentPhase !== undefined) {
    opts.phase = currentPhase;
  }
  return trackWorkflowPromise(request("agent", { prompt, options: opts }));
}

function workflow(nameOrRef, workflowArgs) {
  if (__depth > 0) {
    throw new Error("workflow() nesting is one level only");
  }
  return trackWorkflowPromise(request("workflow", { nameOrRef, args: workflowArgs, depth: __depth }));
}

async function parallel(thunks) {
  if (!Array.isArray(thunks)) throw new TypeError("parallel() expects an array of functions");
  if (thunks.length > ${MAX_ITEMS_PER_CALL}) {
    throw new Error("parallel() accepts at most ${MAX_ITEMS_PER_CALL} items; received " + thunks.length);
  }
  if (thunks.some((thunk) => typeof thunk !== "function")) {
    throw new TypeError("parallel() expects an array of functions, not promises. Wrap each call: () => agent(...)");
  }
  return Promise.all(
    thunks.map(async (thunk, index) => {
      try {
        return await thunk();
      } catch (error) {
        emitLog("parallel[" + index + "] failed: " + errorMessage(error));
        return null;
      }
    }),
  );
}

async function pipeline(items, ...stages) {
  if (!Array.isArray(items)) throw new TypeError("pipeline() expects an array as the first argument");
  if (items.length > ${MAX_ITEMS_PER_CALL}) {
    throw new Error("pipeline() accepts at most ${MAX_ITEMS_PER_CALL} items; received " + items.length);
  }
  if (stages.some((stage) => typeof stage !== "function")) {
    throw new TypeError("pipeline() stages must be functions: pipeline(items, item => ..., result => ...)");
  }
  return Promise.all(
    items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch (error) {
          emitLog("pipeline[" + index + "] failed: " + errorMessage(error));
          return null;
        }
      }
      return value;
    }),
  );
}

const budget = Object.freeze({
  total: tokenBudget,
  spent: () => sharedSpent,
  remaining: () => tokenBudget == null ? Infinity : Math.max(0, tokenBudget - sharedSpent),
});

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertNoWorkflowPromises(value, seen = new Set()) {
  if (value === null || typeof value !== "object") return;
  if (typeof value.then === "function") {
    throw new Error("workflow result must be serializable; did you forget to await agent(), parallel(), pipeline(), or workflow()?");
  }
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertNoWorkflowPromises(item, seen);
    return;
  }
  for (const item of Object.values(value)) assertNoWorkflowPromises(item, seen);
}

async function __workflow_main() {
${body}
}

try {
  const result = await __workflow_main();
  assertNoWorkflowPromises(result);
  finish({ kind: "result", value: result });
} catch (error) {
  finish({
    kind: "error",
    error: {
      message: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  });
}
`;
}

async function runBunChild(runnerPath: string, options: BunChildOptions): Promise<unknown> {
  const child = spawn(options.bunPath, [runnerPath], {
    cwd: options.cwd,
    env: process.env,
    stdio: "pipe",
  });

  return new Promise<unknown>((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const settle = (error: unknown, value?: unknown) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value);
    };

    const abort = () => {
      child.kill("SIGTERM");
      settle(new WorkflowAbortError());
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => settle(error));
    child.on("exit", (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settle(new WorkflowInputError("Bun workflow exited without producing a result"));
        return;
      }
      const detail = stderrBuffer.trim() || `exit code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}`;
      settle(new WorkflowInputError(`Bun workflow failed: ${detail}`));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      let index: number;
      while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        handleChildStdoutLine(child, line, options, settle);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrBuffer += text;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) options.emitLog(`[stderr] ${line}`);
      }
    });
  });
}

function handleChildStdoutLine(
  child: ChildProcessWithoutNullStreams,
  line: string,
  options: BunChildOptions,
  settle: (error: unknown, value?: unknown) => void,
): void {
  if (!line.startsWith(IPC_PREFIX)) {
    if (line.trim()) options.emitLog(line);
    return;
  }

  let message: ChildMessage;
  try {
    message = JSON.parse(line.slice(IPC_PREFIX.length)) as ChildMessage;
  } catch (error) {
    settle(new WorkflowInputError(`Invalid Bun workflow IPC message: ${errorMessage(error)}`));
    return;
  }

  if (message.kind === "event") {
    if (message.type === "phase") options.recordPhase(message.payload.title);
    else if (message.type === "log") options.emitLog(message.payload.message);
    return;
  }

  if (message.kind === "request") {
    if (message.type === "agent") {
      options
        .runAgent(message.payload.prompt, message.payload.options)
        .then((value) => sendChildResponse(child, message.id, value, undefined, options.spent()))
        .catch((error) => sendChildResponse(child, message.id, undefined, error, options.spent()));
      return;
    }
    if (message.type === "workflow") {
      const callerDepth = typeof message.payload.depth === "number" ? message.payload.depth : 0;
      options
        .runNestedWorkflow(message.payload.nameOrRef, message.payload.args, callerDepth)
        .then((value) => sendChildResponse(child, message.id, value, undefined, options.spent()))
        .catch((error) => sendChildResponse(child, message.id, undefined, error, options.spent()));
      return;
    }
    sendChildResponse(child, message.id, undefined, new WorkflowInputError(`Unknown workflow request: ${message.type}`), options.spent());
    return;
  }

  if (message.kind === "result") {
    settle(undefined, message.value);
    return;
  }

  if (message.kind === "error") {
    const error = new WorkflowInputError(message.error.message);
    if (message.error.stack) error.stack = message.error.stack;
    settle(error);
  }
}

function sendChildResponse(
  child: ChildProcessWithoutNullStreams,
  id: number,
  value: unknown,
  error?: unknown,
  spent?: number,
): void {
  const message = error
    ? { kind: "response", id, error: { message: errorMessage(error) }, spent }
    : { kind: "response", id, value, spent };
  // The child may have already exited (e.g. fire-and-forget agent() left in flight); guard the write.
  if (!child.stdin.writable) return;
  try {
    child.stdin.write(`${IPC_PREFIX}${JSON.stringify(message)}\n`);
  } catch {
    // Child gone; nothing to deliver to.
  }
}

function normalizeAgentOptions(value: unknown): WorkflowAgentOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError("agent options must be an object");
  const options = value as WorkflowAgentOptions;
  const normalized: WorkflowAgentOptions = { ...options };
  setOptionalString(normalized, "label", options.label, "agent label");
  setOptionalString(normalized, "phase", options.phase, "agent phase");
  setOptionalString(normalized, "model", options.model, "agent model");
  setOptionalString(normalized, "isolation", options.isolation, "agent isolation");
  setOptionalString(normalized, "agentType", options.agentType, "agent type");
  return normalized;
}

function normalizeAgentResult(result: unknown, schema: JsonSchema | undefined): unknown {
  if (!schema) return result;
  if (result === null) return null;
  const value = typeof result === "string" ? parseJsonResult(result) : result;
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new WorkflowInputError(`StructuredOutput validation failure: ${ajv.errorsText(validate.errors)}`);
  }
  return value;
}

function parseJsonResult(text: string): unknown {
  try {
    return JSON.parse(stripJsonFences(text));
  } catch {
    throw new WorkflowInputError("agent({schema}) completed without JSON structured output");
  }
}

/** Strips a leading/trailing Markdown code fence (```json ... ```), tolerating chatty models. */
function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const withoutOpen = trimmed.replace(/^```[a-zA-Z0-9_-]*\s*\n?/, "");
  return withoutOpen.replace(/\n?```\s*$/, "").trim();
}

function resolveConcurrency(requested: number | undefined): number {
  const cpuBased = Math.max(1, (os.cpus()?.length ?? 4) - 2);
  const ceiling = Math.min(16, cpuBased);
  if (requested === undefined) return ceiling;
  return Math.max(1, Math.min(requested, 16));
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

function toWorkflowRef(value: unknown): WorkflowRef {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { scriptPath?: unknown }).scriptPath === "string") {
    return { scriptPath: (value as { scriptPath: string }).scriptPath };
  }
  throw new WorkflowInputError('workflow() expects a name string or { scriptPath: "..." }');
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active--;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function setOptionalString<T extends WorkflowAgentOptions, K extends keyof T>(
  target: T,
  key: K,
  value: unknown,
  name: string,
): void {
  if (value === undefined) delete target[key];
  else target[key] = requireString(value, name) as T[K];
}

function withAgentIdentity(
  options: WorkflowAgentOptions,
  label: string,
  phase: string | undefined,
): WorkflowAgentOptions {
  return {
    ...options,
    label,
    ...(phase !== undefined ? { phase } : {}),
  };
}

function agentProgress(
  label: string,
  phase: string | undefined,
  state: "started" | "completed" | "cached" | "failed" | "skipped",
  extra: Record<string, unknown> = {},
) {
  return {
    type: "agent" as const,
    label,
    state,
    ...(phase !== undefined ? { phase } : {}),
    ...extra,
  };
}

function defaultAgentLabel(phase: string | undefined, index: number): string {
  return phase ? `${phase} agent ${index}` : `agent ${index}`;
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? "").length / 4);
}

function remainingBudget(tokenBudget: number, state: RuntimeState): number {
  return Math.max(0, tokenBudget - state.spent);
}

function assertStructuredCloneable(value: unknown, name: string): void {
  try {
    structuredClone(value);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new WorkflowInputError(
      `${name} must be structured-cloneable; did you forget to await agent(), parallel(), pipeline(), or workflow()?${detail}`,
    );
  }
}

function cryptoRandomId(): string {
  return randomUUID().slice(0, 12);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
