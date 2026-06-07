export interface WorkflowMetaPhase {
  title: string;
  detail?: string;
  model?: string;
}

export interface WorkflowMeta {
  name: string;
  description: string;
  title?: string;
  whenToUse?: string;
  phases?: WorkflowMetaPhase[];
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  enum?: JsonValue[];
  const?: JsonValue;
  description?: string;
  [key: string]: unknown;
}

export interface WorkflowAgentOptions {
  label?: string;
  phase?: string;
  schema?: JsonSchema;
  model?: string;
  isolation?: "worktree" | "remote" | string;
  agentType?: string;
}

export interface WorkflowAgentCall {
  prompt: string;
  options: WorkflowAgentOptions;
  index: number;
  phase?: string;
  runId: string;
  cacheKey: string;
}

/** Metadata a runner can report back mid-run (e.g. the Codex session/thread id). */
export interface WorkflowAgentMeta {
  sessionId?: string;
}

export interface WorkflowAgentRunner {
  run(call: WorkflowAgentCall, signal?: AbortSignal, onMeta?: (meta: WorkflowAgentMeta) => void): Promise<unknown>;
}

/** A reference to another workflow, as accepted by the in-script `workflow()` primitive. */
export type WorkflowRef = string | { scriptPath: string };

/** Resolves a `workflow(nameOrRef)` reference to its source for nested execution. */
export type WorkflowResolver = (ref: WorkflowRef) => Promise<{ script: string; name: string }>;

export interface WorkflowBudget {
  total: number | null;
  spent(): number;
  remaining(): number;
}

export interface WorkflowProgressAgent {
  type: "agent";
  label: string;
  phase?: string;
  state: "started" | "completed" | "cached" | "failed" | "skipped";
  result?: unknown;
  error?: string;
  /** 1-based ordinal assigned by the runtime; lets the viewer key live agent cards. */
  index?: number;
  /** Stable journal cache key for this agent — lets the viewer match a live node to its journal entry. */
  key?: string;
  /** Codex session/thread id once known (completed/cached agents on supported runners). */
  sessionId?: string;
}

export interface WorkflowProgressPhase {
  type: "phase";
  title: string;
}

export interface WorkflowProgressLog {
  type: "log";
  message: string;
}

export type WorkflowProgressEvent = WorkflowProgressAgent | WorkflowProgressPhase | WorkflowProgressLog;

export interface WorkflowRunOptions {
  args?: unknown;
  cwd?: string;
  runner: WorkflowAgentRunner;
  runId?: string;
  concurrency?: number;
  maxAgents?: number;
  tokenBudget?: number | null;
  signal?: AbortSignal;
  onProgress?: (event: WorkflowProgressEvent) => void;
  journal?: WorkflowJournal;
  bunPath?: string;
  /**
   * Maximum time the Bun workflow child may sit idle while not waiting on parent-run agent/workflow
   * requests. Set to null or <= 0 to disable. Defaults to 5 minutes.
   */
  workflowIdleTimeoutMs?: number | null;
  /** Resolves nested `workflow(nameOrRef)` calls. Without it, `workflow()` throws at runtime. */
  resolveWorkflow?: WorkflowResolver;
}

export interface WorkflowRunResult<T = unknown> {
  meta: WorkflowMeta;
  result: T;
  logs: string[];
  phases: string[];
  agentCount: number;
  durationMs: number;
  runId: string;
  cacheHits: number;
}

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  body: string;
}

export interface WorkflowJournalEntry {
  key: string;
  runId: string;
  prompt: string;
  options: WorkflowAgentOptions;
  result: unknown;
  createdAt: number;
  /** Codex session/thread id for this agent, when the runner reported one. */
  sessionId?: string;
}

export interface WorkflowJournal {
  get(runId: string, key: string): Promise<WorkflowJournalEntry | undefined> | WorkflowJournalEntry | undefined;
  put(entry: WorkflowJournalEntry): Promise<void> | void;
}
