import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Codex, type CodexOptions, type SandboxMode, type ThreadOptions } from "@openai/codex-sdk";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner } from "../types.js";

const exec = promisify(execFile);

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
}

/**
 * Runs each workflow `agent()` call as an independent Codex thread via `@openai/codex-sdk`.
 * Honors the Claude-style agent options: `model`, `schema` (StructuredOutput), `label`/`phase`
 * (prompt context), `agentType`, and `isolation: 'worktree'` (a fresh detached git worktree).
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
      // looser, so transform before sending; the runtime still validates results against the
      // original (looser) schema.
      if (call.options.schema !== undefined) turnOptions.outputSchema = toStrictJsonSchema(call.options.schema);
      if (signal !== undefined) turnOptions.signal = signal;

      const turn = await thread.run(buildPrompt(call, this.options.baseInstructions, Boolean(worktree)), turnOptions);
      // thread.id (the Codex session/rollout UUID) is populated once the turn starts — report it so
      // the runtime can link this agent to its full session trace in ~/.codex/sessions.
      if (thread.id) onMeta?.({ sessionId: thread.id });
      return turn.finalResponse;
    } finally {
      if (worktree) await worktree.cleanup();
    }
  }

  /** Creates a detached git worktree off `baseCwd`; returns undefined-safe cleanup on failure. */
  private async createWorktree(baseCwd: string): Promise<{ dir: string; cleanup: () => Promise<void> } | undefined> {
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
      cleanup: async () => {
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

/**
 * Rewrites a (possibly loose) JSON Schema into OpenAI/Codex strict form: every object schema gets
 * `additionalProperties: false` and a `required` listing all of its properties. Recurses through
 * `properties`, `items`, and `anyOf`/`oneOf`/`allOf`. Leaves non-object schemas untouched.
 */
export function toStrictJsonSchema(schema: unknown): unknown {
  return strictify(schema);
}

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify);
  if (!node || typeof node !== "object") return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = key === "properties" ? strictifyProperties(value) : strictify(value);
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
function strictifyProperties(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [name, subschema] of Object.entries(value as Record<string, unknown>)) {
    out[name] = strictify(subschema);
  }
  return out;
}

function buildPrompt(call: WorkflowAgentCall, baseInstructions: string | undefined, inWorktree: boolean): string {
  const parts = [
    baseInstructions,
    "You are a subagent spawned by a deterministic workflow orchestration script.",
    "Your final response is returned verbatim as this agent() call's result.",
    call.options.phase ? `Workflow phase: ${call.options.phase}` : undefined,
    call.options.label ? `Task label: ${call.options.label}` : undefined,
    call.options.agentType ? `Act as workflow subagent type: ${call.options.agentType}` : undefined,
    call.options.isolation && !inWorktree
      ? `Requested isolation: ${call.options.isolation} (not available here — work in the current directory)`
      : inWorktree
        ? "You are running in an isolated git worktree; changes here do not affect the main checkout."
        : undefined,
    call.options.schema
      ? [
          "Structured output contract:",
          "- Return only JSON that conforms to the provided output schema.",
          "- Do not wrap JSON in Markdown fences.",
          "- Do not add prose before or after the JSON.",
        ].join("\n")
      : undefined,
    call.prompt,
  ].filter(Boolean);
  return parts.join("\n\n");
}
