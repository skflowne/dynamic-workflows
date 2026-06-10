import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunRecord } from "../run-store.js";
import type { WorkflowJournalEntry } from "../types.js";
import type { CodexSessionItem, CodexSessionMeta, CodexSessionUsage, ParsedCodexSession } from "./session-parser.js";

export interface PiSessionLink {
  sessionPath: string;
  sessionId?: string;
}

export interface PiSessionOptions {
  sessionsDir?: string;
  now?: number;
}

const WINDOW_BEFORE_MS = 5_000;
const WINDOW_AFTER_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;

/**
 * pi (pi-coding-agent) session root. Sessions are JSONL files named `<ISO-timestamp>_<uuid>.jsonl`,
 * where `<uuid>` is the full session id. By default pi writes under `~/.pi/agent/sessions/--<cwd>--/`,
 * but this tool passes `--session-dir <dataDir>/pi/sessions` so the viewer reads them from one known
 * place. `linkPiAgent` walks the tree recursively either way.
 */
export function defaultPiSessionsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "sessions");
}

export async function linkPiAgent(
  record: RunRecord,
  entry: WorkflowJournalEntry,
  options: PiSessionOptions = {},
): Promise<PiSessionLink | undefined> {
  const sessionsDir = options.sessionsDir ?? defaultPiSessionsDir();
  const now = options.now ?? Date.now();

  // A recorded sessionId is an exact anchor — match it across ALL session files, ignoring the run's
  // time window (this is what lets `resume` link a cached agent whose file was written during the
  // ORIGINAL run, before record.startedAt was reset). pi puts the full uuid in the filename.
  if (entry.sessionId) {
    const all = await collectPiSessionFiles(sessionsDir);
    const filenameHit = all.find((candidate) => path.basename(candidate.path).includes(entry.sessionId as string));
    if (filenameHit) return { sessionPath: filenameHit.path, sessionId: entry.sessionId };

    for (const candidate of all) {
      const sessionId = await readPiSessionId(candidate.path);
      if (sessionId === entry.sessionId) return { sessionPath: candidate.path, sessionId };
    }
  }

  // No sessionId (or it matched no file): fall back to a prompt-content match, kept within the run's
  // time window so the fuzzy match can't grab an unrelated run that reused the same prompt.
  const windowStart = record.startedAt - WINDOW_BEFORE_MS;
  const windowEnd = (record.completedAt ?? now) + WINDOW_AFTER_MS;
  const candidates = await collectPiSessionFiles(sessionsDir, { start: windowStart, end: windowEnd });
  for (const candidate of candidates) {
    const info = await readPiSessionInfo(candidate.path);
    if (info.subagentText?.includes(entry.prompt)) {
      return { sessionPath: candidate.path, ...(info.sessionId ? { sessionId: info.sessionId } : {}) };
    }
  }
  return undefined;
}

export async function parsePiSessionFile(filePath: string): Promise<ParsedCodexSession> {
  return parsePiSession(await readFile(filePath, "utf8"));
}

export function parsePiSession(raw: string): ParsedCodexSession {
  const meta: CodexSessionMeta = { modelProvider: "pi" };
  const items: CodexSessionItem[] = [];
  let usage: CodexSessionUsage | undefined;

  for (const record of piRecords(raw)) {
    const type = record.type as string | undefined;

    if (type === "session") {
      if (typeof record.id === "string") meta.id = record.id;
      if (typeof record.timestamp === "string") meta.timestamp = record.timestamp;
      if (typeof record.cwd === "string") meta.cwd = record.cwd;
      continue;
    }
    if (type === "model_change") {
      if (typeof record.modelId === "string") meta.model = record.modelId;
      if (typeof record.provider === "string") meta.modelProvider = record.provider;
      continue;
    }
    if (type === "thinking_level_change") {
      if (typeof record.thinkingLevel === "string") meta.effort = record.thinkingLevel;
      continue;
    }
    if (type !== "message") continue;

    const message = record.message as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") continue;
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "user") {
      const text = piContentText(message.content);
      if (text) items.push({ kind: "message", role: "user", text });
      continue;
    }
    if (role === "assistant") {
      items.push(...piAssistantBlocks(message.content));
      const nextUsage = piUsage(message.usage);
      if (nextUsage) usage = nextUsage;
      continue;
    }
    if (role === "toolResult") {
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
      items.push({
        kind: "function_call_output",
        ...(callId ? { callId } : {}),
        output: clip(piContentText(message.content)),
      });
      continue;
    }
    if (role === "bashExecution") {
      const command = typeof message.command === "string" ? message.command : "";
      const output = typeof message.output === "string" ? message.output : "";
      items.push({ kind: "function_call_output", output: clip(command ? `$ ${command}\n${output}` : output) });
    }
  }

  return usage ? { meta, items, usage } : { meta, items };
}

function piAssistantBlocks(content: unknown): CodexSessionItem[] {
  if (typeof content === "string") return content ? [{ kind: "message", role: "assistant", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: CodexSessionItem[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const node = block as Record<string, unknown>;
    switch (node.type) {
      case "text":
        if (typeof node.text === "string" && node.text) out.push({ kind: "message", role: "assistant", text: node.text });
        break;
      case "thinking": {
        const summary = typeof node.thinking === "string" ? node.thinking : "";
        if (summary) out.push({ kind: "reasoning", summary });
        break;
      }
      case "toolCall": {
        const callId = typeof node.toolCallId === "string" ? node.toolCallId : typeof node.id === "string" ? node.id : undefined;
        out.push({
          kind: "function_call",
          name: typeof node.toolName === "string" ? node.toolName : typeof node.name === "string" ? node.name : "tool",
          arguments: node.args ?? node.input ?? {},
          ...(callId ? { callId } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

async function collectPiSessionFiles(
  sessionsDir: string,
  window?: { start: number; end: number },
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  await walk(sessionsDir, async (filePath) => {
    if (!filePath.endsWith(".jsonl")) return;
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(filePath)).mtimeMs;
    } catch {
      return;
    }
    if (window && (mtimeMs < window.start || mtimeMs > window.end)) return;
    out.push({ path: filePath, mtimeMs });
  });
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

async function walk(dir: string, visit: (filePath: string) => Promise<void>): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, visit);
    else if (entry.isFile()) await visit(full);
  }
}

async function readPiSessionId(filePath: string): Promise<string | undefined> {
  // The session header is the file's first record — decide on the first parseable line instead of
  // parsing the whole file (this runs in a per-candidate loop over the entire sessions tree).
  try {
    for (const line of (await readFile(filePath, "utf8")).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as Record<string, unknown>;
        return record.type === "session" && typeof record.id === "string" ? record.id : undefined;
      } catch {
        continue; // tolerate a corrupt leading line
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function readPiSessionInfo(filePath: string): Promise<{ sessionId?: string; subagentText?: string }> {
  try {
    const parsed = parsePiSession(await readFile(filePath, "utf8"));
    const firstUser = parsed.items.find(
      (item): item is Extract<CodexSessionItem, { kind: "message" }> => item.kind === "message" && item.role === "user",
    );
    return {
      ...(parsed.meta.id ? { sessionId: parsed.meta.id } : {}),
      ...(firstUser?.text ? { subagentText: firstUser.text } : {}),
    };
  } catch {
    return {};
  }
}

function piRecords(raw: string): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const node = JSON.parse(line) as unknown;
      if (node && typeof node === "object" && !Array.isArray(node)) records.push(node as Record<string, unknown>);
    } catch {
      // tolerate partial/corrupt trailing lines
    }
  }
  return records;
}

function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object") {
        const node = part as Record<string, unknown>;
        return typeof node.text === "string" ? node.text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("");
}

function piUsage(value: unknown): CodexSessionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tokens = value as Record<string, unknown>;
  const usage: CodexSessionUsage = {};
  putNumber(usage, "inputTokens", tokens.input);
  putNumber(usage, "cachedInputTokens", tokens.cacheRead);
  putNumber(usage, "outputTokens", tokens.output);
  putNumber(usage, "totalTokens", tokens.totalTokens);
  return Object.keys(usage).length ? usage : undefined;
}

function putNumber(target: CodexSessionUsage, key: keyof CodexSessionUsage, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function clip(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${text.length - MAX_OUTPUT_CHARS} chars]` : text;
}
