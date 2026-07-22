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
  /**
   * Selects which configured provider (or alias) handles this agent — resolved against the provider
   * config (`--config`). When omitted, `model` may route to a provider; otherwise the run default /
   * anonymous backend is used. See {@link WorkflowRunnerResolver}.
   */
  provider?: string;
  /** Total attempts for this call. Overrides the run-wide agentMaxAttempts; mutation agents should use 1. */
  maxAttempts?: number;
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
  /** Runner/backend identifier, e.g. "codex" or "gemini". */
  backend?: string;
  sessionId?: string;
  /** Real output tokens this agent spent, when the runner can report them (feeds `budget`). */
  outputTokens?: number;
  /** Path of an isolation worktree this agent ran in, reported when it is preserved for review. */
  worktreePath?: string;
  /** True when the worktree had changes and was kept on disk instead of being removed. */
  worktreePreserved?: boolean;
}

/** A single agent that failed after exhausting its retries (collected onto the run result). */
export interface AgentFailure {
  label: string;
  phase?: string;
  /** 1-based ordinal assigned by the runtime. */
  index: number;
  /** Stable journal cache key for this agent. */
  key: string;
  /** Number of attempts made before giving up. */
  attempts: number;
  /** Last error message. */
  error: string;
}

export interface WorkflowAgentRunner {
  run(call: WorkflowAgentCall, signal?: AbortSignal, onMeta?: (meta: WorkflowAgentMeta) => void): Promise<unknown>;
}

/**
 * Picks the {@link WorkflowAgentRunner} for a single `agent()` call from its (normalized) options —
 * the hook behind per-agent provider/model routing. Called once per uncached agent (after the journal
 * cache check), so a thrown error (unknown provider, ambiguous model) hard-fails the run rather than
 * becoming a retryable `null`. A plain runner is accepted anywhere this is, and wrapped as `() => runner`.
 */
export type WorkflowRunnerResolver = (options: WorkflowAgentOptions) => WorkflowAgentRunner;

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
  backend?: string;
  label: string;
  phase?: string;
  state: "started" | "completed" | "cached" | "failed" | "skipped";
  /** Prompt/options are included on live started events so the viewer can open running agents. */
  prompt?: string;
  options?: WorkflowAgentOptions;
  result?: unknown;
  error?: string;
  /** 1-based ordinal assigned by the runtime; lets the viewer key live agent cards. */
  index?: number;
  /** Stable journal cache key for this agent — lets the viewer match a live node to its journal entry. */
  key?: string;
  /** Backend session/thread id once known. */
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
  /** A single runner, or a per-agent {@link WorkflowRunnerResolver} for provider/model routing. */
  runner: WorkflowAgentRunner | WorkflowRunnerResolver;
  runId?: string;
  concurrency?: number;
  maxAgents?: number;
  /** Total attempts per agent (1 = no retry). Defaults to 3. On exhaustion agent() returns null. */
  agentMaxAttempts?: number;
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
  /** Agents that failed after exhausting retries (each returned null to the script). */
  failures: AgentFailure[];
}

export interface ParsedWorkflow {
  meta: WorkflowMeta;
  body: string;
}

export interface WorkflowJournalEntry {
  key: string;
  runId: string;
  /** Runner/backend identifier, when known. Historical entries may omit it and are treated as Codex. */
  backend?: string;
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
