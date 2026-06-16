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

export interface AgentFailure {
  label: string;
  phase?: string;
  index: number;
  key: string;
  attempts: number;
  error: string;
}

export type RunRecordStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunnerConfig {
  backend: string;
  model?: string;
  geminiCommand?: string;
  piCommand?: string;
  provider?: string;
  baseUrl?: string;
  thinking?: string;
  piApi?: string;
  tools?: string;
  excludeTools?: string;
  noTools?: boolean;
}

export interface RunRecord {
  runId: string;
  name: string;
  description?: string;
  status: RunRecordStatus;
  source: string;
  scriptPath?: string;
  runner?: RunnerConfig;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  agentCount?: number;
  cacheHits?: number;
  failureCount?: number;
  failures?: AgentFailure[];
  declaredPhases?: string[];
  phases?: string[];
  logs?: string[];
  error?: string;
  args?: unknown;
  result?: unknown;
}

export type AgentStatus = "confirmed" | "killed" | "ok" | "failed";
export type FlowAgentStatus = AgentStatus | "running";

export interface AgentView {
  key: string;
  label: string;
  phase?: string;
  createdAt: number;
  status: FlowAgentStatus;
  resultPreview: string;
  hasSchema: boolean;
  hasSession: boolean;
  sessionId?: string;
  live?: boolean;
}

export interface PhaseView {
  title: string;
  agents: AgentView[];
}

export interface RunViewStats {
  agentCount: number;
  cacheHits: number;
  durationMs?: number;
  phaseCounts: Record<string, number>;
}

export interface RunView {
  phases: PhaseView[];
  agents: AgentView[];
  stats: RunViewStats;
}

export interface RunDetailResponse {
  record: RunRecord;
  view: RunView;
  live: LiveEvent[];
}

export interface WorkflowProgressAgent {
  type: "agent";
  backend?: string;
  label: string;
  phase?: string;
  state: "started" | "completed" | "cached" | "failed" | "skipped";
  prompt?: string;
  options?: WorkflowAgentOptions;
  result?: unknown;
  error?: string;
  index?: number;
  key?: string;
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

export type LiveEvent =
  | { type: "run-meta"; runId: string; record: RunRecord; [key: string]: unknown }
  | { type: "run-finished"; runId: string; [key: string]: unknown }
  | { type: "progress"; runId: string; event?: WorkflowProgressEvent; [key: string]: unknown };

export interface LiveAgent {
  key: string;
  label: string;
  phase?: string;
  state: WorkflowProgressAgent["state"];
  backend?: string;
  prompt?: string;
  options?: WorkflowAgentOptions;
  sessionId?: string;
  result?: unknown;
  error?: string;
}

export interface AgentDetail {
  key: string;
  runId: string;
  backend?: string;
  prompt: string;
  options: WorkflowAgentOptions;
  result?: unknown;
  createdAt: number;
  sessionId?: string;
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
}

export interface AgentTokenGroup {
  backend: string;
  model: string;
  provider?: string;
  agentCount: number;
  withUsage: number;
  pendingCount: number;
  usage: TokenUsage;
}

export interface RunTokenSummary {
  runId: string;
  generatedAt: number;
  agentCount: number;
  withUsage: number;
  pendingCount: number;
  totals: TokenUsage;
  groups: AgentTokenGroup[];
}

export interface SessionMeta {
  id?: string;
  timestamp?: string;
  cwd?: string;
  cliVersion?: string;
  originator?: string;
  modelProvider?: string;
  model?: string;
  effort?: string;
}

export type SessionItem =
  | { kind: "message"; role: string; text: string }
  | { kind: "reasoning"; summary: string }
  | { kind: "web_search"; query?: string; queries?: string[]; status?: string }
  | { kind: "function_call"; name: string; arguments: unknown; callId?: string }
  | { kind: "function_call_output"; callId?: string; output: string; truncated?: boolean }
  | { kind: "other"; itemType: string; raw: string };

export interface ParsedSession {
  sessionPath?: string;
  meta: SessionMeta;
  items: SessionItem[];
  usage?: TokenUsage;
}

export interface LiveSeed {
  logs: string[];
  agents: Map<string, LiveAgent>;
}
