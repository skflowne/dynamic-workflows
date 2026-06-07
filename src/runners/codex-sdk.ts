import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Codex, type CodexOptions, type SandboxMode, type ThreadOptions } from "@openai/codex-sdk";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner } from "../types.js";

const exec = promisify(execFile);

/** Per-agent total-duration timeout (defends against a single Codex turn hanging forever). */
const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;

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
 * Honors the Claude-style agent options: `model`, `schema` (StructuredOutput), `label`/`phase`
 * (prompt context), `agentType` as prompt context, and `isolation: 'worktree'` (a fresh detached
 * git worktree).
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
    const baseCwd = this.options.cwd ?? process.cwd();
    const worktree = call.options.isolation === "worktree" ? await this.createWorktree(baseCwd) : undefined;
    const workingDirectory = worktree?.dir ?? baseCwd;

    const timeoutMs = this.options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    let timeoutController: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timeoutController = new AbortController();
      timer = setTimeout(() => timeoutController?.abort(), timeoutMs);
    }
    const turnSignal = combineSignals(signal, timeoutController?.signal);

    try {
      const threadOptions: ThreadOptions = {
        workingDirectory,
        sandboxMode: this.options.sandboxMode ?? "workspace-write",
        skipGitRepoCheck: this.options.skipGitRepoCheck ?? true,
        approvalPolicy: this.options.approvalPolicy ?? "never",
      };
      const model = call.options.model ?? this.options.model;
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
      if (turnSignal !== undefined) turnOptions.signal = turnSignal;

      let turn: Awaited<ReturnType<typeof thread.run>>;
      try {
        turn = await thread.run(buildPrompt(call, this.options.baseInstructions, Boolean(worktree)), turnOptions);
      } catch (error) {
        // A timeout aborts via our own controller (not the run-level signal) — surface a clear message
        // so the runtime treats it as a retryable agent failure rather than a workflow cancellation.
        if (timeoutController?.signal.aborted && !signal?.aborted) {
          throw new Error(`agent exceeded agentTimeoutMs (${timeoutMs}ms)`);
        }
        throw error;
      }
      // thread.id (the Codex session/rollout UUID) is populated once the turn starts — report it so
      // the runtime can link this agent to its full session trace in ~/.codex/sessions.
      if (thread.id) onMeta?.({ sessionId: thread.id });
      if (typeof turn.usage?.output_tokens === "number") onMeta?.({ outputTokens: turn.usage.output_tokens });
      return turn.finalResponse;
    } finally {
      if (timer) clearTimeout(timer);
      if (worktree) await worktree.cleanup(onMeta);
    }
  }

  /** Creates a detached git worktree off `baseCwd`; returns undefined-safe cleanup on failure. */
  private async createWorktree(
    baseCwd: string,
  ): Promise<{ dir: string; cleanup: (onMeta?: (meta: WorkflowAgentMeta) => void) => Promise<void> } | undefined> {
    try {
      await exec("git", ["-C", baseCwd, "rev-parse", "--is-inside-work-tree"]);
    } catch {
      return undefined; // Not a git repo — fall back to baseCwd (prompt notes the limitation).
    }
    const dir = await mkdtemp(path.join(os.tmpdir(), "codex-workflow-worktree-"));
    try {
      await exec("git", ["-C", baseCwd, "worktree", "add", "--detach", dir]);
    } catch {
      await rm(dir, { recursive: true, force: true });
      return undefined;
    }
    return {
      dir,
      cleanup: async (onMeta) => {
        // Claude parity: remove the worktree if the agent made no changes, preserve it for review if
        // it did. `--porcelain` lists modified + untracked entries; a non-empty result means dirty.
        let dirty = false;
        try {
          const { stdout } = await exec("git", ["-C", dir, "status", "--porcelain"]);
          dirty = stdout.trim().length > 0;
        } catch {
          dirty = false; // If status fails, fall through to removal.
        }
        if (dirty) {
          onMeta?.({ worktreePath: dir, worktreePreserved: true });
          return;
        }
        try {
          await exec("git", ["-C", baseCwd, "worktree", "remove", "--force", dir]);
        } catch {
          // best-effort
        }
        await rm(dir, { recursive: true, force: true });
      },
    };
  }
}

/** Combines an optional run-level signal with an optional timeout signal into one. */
function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([a, b]);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
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
  const parts = [
    baseInstructions,
    "You are a subagent spawned by a deterministic workflow orchestration script.",
    'Your final response is returned verbatim as this agent() call\'s result — it is your return value, not a message to a human. Output only the literal result; do not add confirmations like "Done." or any preamble. Be concise — the script parses your output.',
    call.options.phase ? `Workflow phase: ${call.options.phase}` : undefined,
    call.options.label ? `Task label: ${call.options.label}` : undefined,
    call.options.agentType
      ? `Requested Claude-style agentType label: ${call.options.agentType}. Codex does not load Claude's built-in agent definitions; use this as role/task context only.`
      : undefined,
    call.options.isolation && !inWorktree
      ? `Requested isolation: ${call.options.isolation} (not available here — work in the current directory)`
      : inWorktree
        ? "You are running in an isolated git worktree. The worktree is removed automatically if you make no changes, or preserved for review if you do; changes here do not affect the main checkout."
        : undefined,
    call.options.schema
      ? [
          "Structured output contract:",
          "- You MUST return ONLY JSON conforming to the provided output schema; it is the call's entire result.",
          "- Do not wrap the JSON in Markdown fences.",
          "- Do not add any prose before or after the JSON.",
          "- If your output fails schema validation the call fails — return corrected JSON.",
        ].join("\n")
      : undefined,
    call.prompt,
  ].filter(Boolean);
  return parts.join("\n\n");
}
