import type { WorkflowAgentCall } from "../types.js";

interface SubagentPromptOptions {
  baseInstructions: string | undefined;
  backendName: string;
  inWorktree: boolean;
  /**
   * Embed the JSON Schema text in the prompt. Set for backends WITHOUT native structured output
   * (Gemini) — otherwise "the provided output schema" is a dangling reference the model never sees, so
   * it can only guess fields. Codex leaves this off because it sends the schema as a native parameter.
   */
  embedSchema?: boolean;
}

export function buildSubagentPrompt(call: WorkflowAgentCall, options: SubagentPromptOptions): string {
  const parts = [
    options.baseInstructions,
    "You are a subagent spawned by a deterministic workflow orchestration script.",
    'Your final response is returned verbatim as this agent() call\'s result — it is your return value, not a message to a human. Output only the literal result; do not add confirmations like "Done." or any preamble. Be concise — the script parses your output.',
    call.options.phase ? `Workflow phase: ${call.options.phase}` : undefined,
    call.options.label ? `Task label: ${call.options.label}` : undefined,
    call.options.agentType
      ? `Act as the "${call.options.agentType}" subagent: adopt the role, expertise, and working conventions that this agent type implies, and apply them throughout the task below.`
      : undefined,
    call.options.isolation && !options.inWorktree
      ? `Requested isolation: ${call.options.isolation} (not available here — work in the current directory)`
      : options.inWorktree
        ? "You are running in an isolated git worktree. The worktree is removed automatically if you make no changes, or preserved for review if you do; changes here do not affect the main checkout."
        : undefined,
    call.options.schema ? structuredOutputContract(call.options.schema, options.embedSchema ?? false) : undefined,
    call.prompt,
  ].filter(Boolean);
  return parts.join("\n\n");
}

function structuredOutputContract(schema: unknown, embed: boolean): string {
  const lines = [
    "Structured output contract:",
    "- You MUST return ONLY JSON conforming to the provided output schema; it is the call's entire result.",
    "- Do not wrap the JSON in Markdown fences.",
    "- Do not add any prose before or after the JSON.",
    "- If your output fails schema validation the call fails — return corrected JSON.",
  ];
  if (embed) {
    lines.push("", "JSON Schema your output must satisfy:", safeJsonSchema(schema));
  }
  return lines.join("\n");
}

function safeJsonSchema(schema: unknown): string {
  try {
    return JSON.stringify(schema, null, 2);
  } catch {
    return String(schema);
  }
}
