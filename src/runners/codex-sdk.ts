import { Codex, type CodexOptions, type SandboxMode, type ThreadOptions } from "@openai/codex-sdk";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner } from "../types.js";
import { buildSubagentPrompt } from "./prompt.js";
import { agentTimeoutError, DEFAULT_AGENT_TIMEOUT_MS, startAgentTimeout } from "./turn-control.js";
import { createDetachedWorktree } from "./worktree.js";

export interface CodexSdkAgentRunnerOptions {
  codex?: Codex;
  codexOptions?: CodexOptions;
  cwd?: string;
  model?: string;
  sandboxMode?: SandboxMode;
  skipGitRepoCheck?: boolean;
  approvalPolicy?: ThreadOptions["approvalPolicy"];
  networkAccessEnabled?: boolean;
  webSearchMode?: ThreadOptions["webSearchMode"];
  webSearchEnabled?: boolean;
  modelReasoningEffort?: ThreadOptions["modelReasoningEffort"];
  additionalDirectories?: string[];
  baseInstructions?: string;
  /** Per-agent total-duration timeout in ms. Defaults to 15 min; set 0 to disable. */
  agentTimeoutMs?: number;
}

/**
 * Runs each workflow `agent()` call as an independent Codex thread via `@openai/codex-sdk`.
 * Honors the Claude-style agent options: `schema` (StructuredOutput), `label`/`phase` (prompt
 * context), `agentType` as a role directive in the prompt, and `isolation: 'worktree'` (a fresh detached git
 * worktree). In-script `model` values are intentionally ignored; select the Codex model at the
 * runner/CLI layer instead so Claude workflows with hard-coded model names remain portable.
 */
export class CodexSdkAgentRunner implements WorkflowAgentRunner {
  private readonly codex: Codex;

  constructor(private readonly options: CodexSdkAgentRunnerOptions = {}) {
    this.codex = options.codex ?? new Codex(options.codexOptions);
  }

  async run(
    call: WorkflowAgentCall,
    signal?: AbortSignal,
    onMeta?: (meta: WorkflowAgentMeta) => void,
  ): Promise<unknown> {
    onMeta?.({ backend: "codex" });
    const baseCwd = this.options.cwd ?? process.cwd();
    const worktree = call.options.isolation === "worktree" ? await createDetachedWorktree(baseCwd) : undefined;
    const workingDirectory = worktree?.dir ?? baseCwd;

    const timeoutMs = this.options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const timeout = startAgentTimeout(timeoutMs, signal);

    try {
      const threadOptions: ThreadOptions = {
        workingDirectory,
        sandboxMode: this.options.sandboxMode ?? "workspace-write",
        skipGitRepoCheck: this.options.skipGitRepoCheck ?? true,
        approvalPolicy: this.options.approvalPolicy ?? "never",
      };
      const model = this.options.model;
      if (model !== undefined) threadOptions.model = model;
      if (this.options.networkAccessEnabled !== undefined) threadOptions.networkAccessEnabled = this.options.networkAccessEnabled;
      if (this.options.webSearchMode !== undefined) threadOptions.webSearchMode = this.options.webSearchMode;
      if (this.options.webSearchEnabled !== undefined) threadOptions.webSearchEnabled = this.options.webSearchEnabled;
      if (this.options.modelReasoningEffort !== undefined) {
        threadOptions.modelReasoningEffort = this.options.modelReasoningEffort;
      }
      if (this.options.additionalDirectories !== undefined) threadOptions.additionalDirectories = this.options.additionalDirectories;

      const thread = this.codex.startThread(threadOptions);

      const turnOptions: Parameters<typeof thread.run>[1] = {};
      // Codex/OpenAI structured output requires a *strict* JSON Schema (every object must set
      // additionalProperties:false and list all keys in `required`). Claude workflow schemas are
      // looser, so transform before sending; optional fields become nullable in the strict copy, and
      // the runtime still validates results against the original (looser) schema.
      if (call.options.schema !== undefined) turnOptions.outputSchema = toStrictJsonSchema(call.options.schema);
      if (timeout.signal !== undefined) turnOptions.signal = timeout.signal;

      let turn: Awaited<ReturnType<typeof thread.run>>;
      try {
        turn = await thread.run(buildPrompt(call, this.options.baseInstructions, Boolean(worktree)), turnOptions);
      } catch (error) {
        // A timeout aborts via our own controller (not the run-level signal) — surface a clear message
        // so the runtime treats it as a retryable agent failure rather than a workflow cancellation.
        if (timeout.timedOut()) throw agentTimeoutError(timeoutMs);
        throw error;
      }
      // thread.id (the Codex session/rollout UUID) is populated once the turn starts — report it so
      // the runtime can link this agent to its full session trace in ~/.codex/sessions.
      if (thread.id) onMeta?.({ sessionId: thread.id });
      if (typeof turn.usage?.output_tokens === "number") onMeta?.({ outputTokens: turn.usage.output_tokens });
      return turn.finalResponse;
    } finally {
      timeout.clear();
      if (worktree) await worktree.cleanup(onMeta);
    }
  }
}

/**
 * Rewrites a (possibly loose) JSON Schema into OpenAI/Codex strict form: every object schema gets
 * `additionalProperties: false` and a `required` listing all of its properties. Properties that were
 * optional in the original schema are made nullable in the strict copy so the model can satisfy
 * OpenAI strict mode without changing the caller-visible loose schema semantics. Recurses through
 * `properties`, `items`, and `anyOf`/`oneOf`/`allOf`. Leaves non-object schemas untouched.
 */
export function toStrictJsonSchema(schema: unknown): unknown {
  return strictify(schema);
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;

  const original = node as Record<string, unknown>;
  const originalRequired = stringSet(original.required);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(original)) {
    out[key] = key === "properties" ? strictifyProperties(value, originalRequired) : strictify(value);
  }

  const type = out.type;
  const isObjectType = type === "object" || (Array.isArray(type) && type.includes("object"));
  if (out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as Record<string, unknown>);
  } else if (isObjectType) {
    out.additionalProperties = false;
  }
  return out;
}

// `properties` is a map of name -> subschema; strictify each subschema but keep the map shape.
function strictifyProperties(value: unknown, required: Set<string>): unknown {
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [name, subschema] of Object.entries(value as Record<string, unknown>)) {
    const strict = strictify(subschema);
    out[name] = required.has(name) ? strict : nullableSchema(strict);
  }
  return out;
}

function stringSet(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item): item is string => typeof item === "string"));
}

function nullableSchema(schema: unknown): unknown {
  if (allowsNull(schema)) return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { anyOf: [schema, { type: "null" }] };
  }

  const out: Record<string, unknown> = { ...(schema as Record<string, unknown>) };
  if (typeof out.type === "string") {
    out.type = [out.type, "null"];
    return out;
  }
  if (Array.isArray(out.type)) {
    out.type = [...out.type, "null"];
    return out;
  }
  if (Array.isArray(out.anyOf)) {
    out.anyOf = [...out.anyOf, { type: "null" }];
    return out;
  }
  if (Array.isArray(out.oneOf)) {
    out.oneOf = [...out.oneOf, { type: "null" }];
    return out;
  }
  return { anyOf: [out, { type: "null" }] };
}

function allowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const node = schema as Record<string, unknown>;
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.includes("null")) return true;
  if (Array.isArray(node.enum) && node.enum.includes(null)) return true;
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = node[key];
    if (Array.isArray(branches) && branches.some(allowsNull)) return true;
  }
  return false;
}

export function buildPrompt(call: WorkflowAgentCall, baseInstructions: string | undefined, inWorktree: boolean): string {
  return buildSubagentPrompt(call, { baseInstructions, backendName: "Codex", inWorktree });
}
