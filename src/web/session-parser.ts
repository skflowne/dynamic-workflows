import { readFile } from "node:fs/promises";

/**
 * Parses a single Codex rollout file (`~/.codex/sessions/<date>/rollout-*.jsonl`) into a clean,
 * ordered timeline the web viewer can render: messages, reasoning summaries, web searches, tool
 * calls + their output, and final token usage. The raw rollout is JSONL — one envelope per line of
 * shape `{ type, timestamp, payload }`.
 */

export interface CodexSessionMeta {
  id?: string;
  timestamp?: string;
  cwd?: string;
  cliVersion?: string;
  originator?: string;
  modelProvider?: string;
  model?: string;
}

export type CodexSessionItem =
  | { kind: "message"; role: string; text: string }
  | { kind: "reasoning"; summary: string }
  | { kind: "web_search"; query?: string; queries?: string[]; status?: string }
  | { kind: "function_call"; name: string; arguments: unknown; callId?: string }
  | { kind: "function_call_output"; callId?: string; output: string; truncated?: boolean };

export interface CodexSessionUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  contextWindow?: number;
}

export interface ParsedCodexSession {
  meta: CodexSessionMeta;
  items: CodexSessionItem[];
  usage?: CodexSessionUsage;
}

const MAX_OUTPUT_CHARS = 16_000;

export async function parseCodexSessionFile(filePath: string): Promise<ParsedCodexSession> {
  const raw = await readFile(filePath, "utf8");
  return parseCodexSession(raw);
}

export function parseCodexSession(raw: string): ParsedCodexSession {
  const meta: CodexSessionMeta = {};
  const items: CodexSessionItem[] = [];
  let usage: CodexSessionUsage | undefined;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // tolerate partial/corrupt trailing lines
    }
    const type = envelope.type as string | undefined;
    const payload = (envelope.payload ?? {}) as Record<string, unknown>;

    if (type === "session_meta") {
      setMeta(meta, "id", str(payload.id));
      setMeta(meta, "timestamp", str(payload.timestamp) ?? str(envelope.timestamp));
      setMeta(meta, "cwd", str(payload.cwd));
      setMeta(meta, "cliVersion", str(payload.cli_version));
      setMeta(meta, "originator", str(payload.originator));
      setMeta(meta, "modelProvider", str(payload.model_provider));
      setMeta(meta, "model", str(payload.model));
      continue;
    }

    if (type === "turn_context") {
      setMeta(meta, "model", str(payload.model));
      continue;
    }

    if (type === "event_msg") {
      const usageFromEvent = readUsage(payload);
      if (usageFromEvent) usage = usageFromEvent; // keep the latest (cumulative) usage snapshot
      continue;
    }

    if (type === "response_item") {
      const item = parseResponseItem(payload);
      if (item) items.push(item);
    }
  }

  return usage ? { meta, items, usage } : { meta, items };
}

function parseResponseItem(payload: Record<string, unknown>): CodexSessionItem | undefined {
  switch (payload.type) {
    case "message": {
      const role = str(payload.role) ?? "unknown";
      const text = extractContentText(payload.content);
      return { kind: "message", role, text };
    }
    case "reasoning": {
      const summary = extractReasoningSummary(payload.summary);
      // Skip pure-encrypted reasoning with no human-readable summary — nothing to show.
      return summary ? { kind: "reasoning", summary } : undefined;
    }
    case "web_search_call": {
      const action = (payload.action ?? {}) as Record<string, unknown>;
      const query = str(action.query);
      const queries = Array.isArray(action.queries) ? (action.queries.filter((q) => typeof q === "string") as string[]) : [];
      const status = str(payload.status);
      return {
        kind: "web_search",
        ...(query ? { query } : {}),
        ...(queries.length ? { queries } : {}),
        ...(status ? { status } : {}),
      };
    }
    case "function_call": {
      const callId = str(payload.call_id);
      return {
        kind: "function_call",
        name: str(payload.name) ?? "tool",
        arguments: parseMaybeJson(payload.arguments),
        ...(callId ? { callId } : {}),
      };
    }
    case "function_call_output": {
      const callId = str(payload.call_id);
      const rawOut = stringifyOutput(payload.output);
      const truncated = rawOut.length > MAX_OUTPUT_CHARS;
      return {
        kind: "function_call_output",
        ...(callId ? { callId } : {}),
        output: truncated ? `${rawOut.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${rawOut.length - MAX_OUTPUT_CHARS} chars]` : rawOut,
        ...(truncated ? { truncated: true } : {}),
      };
    }
    default:
      return undefined;
  }
}

function readUsage(payload: Record<string, unknown>): CodexSessionUsage | undefined {
  if (payload.type !== "token_count") return undefined;
  const info = (payload.info ?? {}) as Record<string, unknown>;
  const total = (info.total_token_usage ?? {}) as Record<string, unknown>;
  if (Object.keys(total).length === 0) return undefined;
  const usage: CodexSessionUsage = {};
  const put = (key: keyof CodexSessionUsage, value: number | undefined) => {
    if (value !== undefined) usage[key] = value;
  };
  put("inputTokens", num(total.input_tokens));
  put("cachedInputTokens", num(total.cached_input_tokens));
  put("outputTokens", num(total.output_tokens));
  put("reasoningOutputTokens", num(total.reasoning_output_tokens));
  put("totalTokens", num(total.total_tokens));
  put("contextWindow", num(info.model_context_window));
  return usage;
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      parts.push(entry);
    } else if (entry && typeof entry === "object") {
      const e = entry as Record<string, unknown>;
      const text = str(e.text) ?? str(e.input_text) ?? str(e.output_text);
      if (text) parts.push(text);
    }
  }
  return parts.join("");
}

function extractReasoningSummary(summary: unknown): string {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const entry of summary) {
    if (typeof entry === "string") parts.push(entry);
    else if (entry && typeof entry === "object") {
      const text = str((entry as Record<string, unknown>).text);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n\n");
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.output === "string") return o.output;
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return value === undefined || value === null ? "" : String(value);
}

function setMeta(meta: CodexSessionMeta, key: keyof CodexSessionMeta, value: string | undefined): void {
  if (value !== undefined) meta[key] = value;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
