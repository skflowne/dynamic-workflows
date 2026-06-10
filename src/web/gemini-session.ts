import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunRecord } from "../run-store.js";
import type { WorkflowJournalEntry } from "../types.js";
import type { CodexSessionItem, CodexSessionMeta, CodexSessionUsage, ParsedCodexSession } from "./session-parser.js";

export interface GeminiSessionLink {
  sessionPath: string;
  sessionId?: string;
}

export interface GeminiSessionOptions {
  sessionsDir?: string;
  now?: number;
}

const WINDOW_BEFORE_MS = 5_000;
const WINDOW_AFTER_MS = 60_000;
const MAX_OUTPUT_CHARS = 16_000;

/**
 * Gemini CLI session root. Verified against Gemini CLI 0.45.2: sessions live at
 * `~/.gemini/tmp/<project>/chats/session-<ts>-<id>.jsonl` (older runs use `.json`), where `<project>`
 * is derived from the agent's cwd. `linkGeminiAgent` walks this tree recursively, so worktree agents
 * (cwd = a temp dir → a different `<project>` subdir) are still found within the run's time window.
 */
export function defaultGeminiSessionsDir(): string {
  return path.join(os.homedir(), ".gemini", "tmp");
}

export async function linkGeminiAgent(
  record: RunRecord,
  entry: WorkflowJournalEntry,
  options: GeminiSessionOptions = {},
): Promise<GeminiSessionLink | undefined> {
  const sessionsDir = options.sessionsDir ?? defaultGeminiSessionsDir();
  const now = options.now ?? Date.now();

  // A recorded sessionId is an exact anchor — match it across ALL session files, ignoring the run's
  // time window. This is what lets `resume` link a cached agent whose session file was written during
  // the ORIGINAL run: resume reuses the runId but resets record.startedAt to now, so the original
  // file's mtime falls outside this run's window. The filename carries the sessionId's first segment.
  if (entry.sessionId) {
    const all = await collectGeminiSessionFiles(sessionsDir);
    const short = entry.sessionId.split("-")[0] ?? entry.sessionId;
    const filenameHit = all.find((candidate) => path.basename(candidate.path).includes(short));
    if (filenameHit) return { sessionPath: filenameHit.path, sessionId: entry.sessionId };

    for (const candidate of all) {
      const sessionId = await readGeminiSessionId(candidate.path);
      if (sessionId === entry.sessionId) return { sessionPath: candidate.path, sessionId };
    }
  }

  // No sessionId (or it matched no file): fall back to a prompt-content match, kept within the time
  // window so the fuzzy match can't grab an unrelated run that happened to reuse the same prompt.
  const windowStart = record.startedAt - WINDOW_BEFORE_MS;
  const windowEnd = (record.completedAt ?? now) + WINDOW_AFTER_MS;
  const candidates = await collectGeminiSessionFiles(sessionsDir, { start: windowStart, end: windowEnd });
  for (const candidate of candidates) {
    const info = await readGeminiSessionInfo(candidate.path);
    if (info.subagentText?.includes(entry.prompt)) {
      return { sessionPath: candidate.path, ...(info.sessionId ? { sessionId: info.sessionId } : {}) };
    }
  }
  return undefined;
}

export async function parseGeminiSessionFile(filePath: string): Promise<ParsedCodexSession> {
  return parseGeminiSession(await readFile(filePath, "utf8"));
}

export function parseGeminiSession(raw: string): ParsedCodexSession {
  const meta: CodexSessionMeta = { modelProvider: "gemini" };
  const items: CodexSessionItem[] = [];
  let usage: CodexSessionUsage | undefined;

  for (const node of geminiRecords(raw)) {
    if (typeof node.sessionId === "string") {
      meta.id = node.sessionId;
      if (typeof node.startTime === "string") meta.timestamp = node.startTime;
      continue;
    }
    if (typeof node.model === "string") meta.model = node.model;

    if (node.type === "user") {
      const text = geminiContentText(node.content);
      if (text) items.push({ kind: "message", role: "user", text });
      for (const output of geminiFunctionResponses(node.content)) {
        items.push({ kind: "function_call_output", output });
      }
      continue;
    }

    if (node.type === "gemini") {
      for (const thought of geminiThoughts(node.thoughts)) items.push({ kind: "reasoning", summary: thought });
      const text = typeof node.content === "string" ? node.content : geminiContentText(node.content);
      if (text) items.push({ kind: "message", role: "assistant", text });
      items.push(...geminiToolCalls(node.toolCalls));
      const nextUsage = geminiUsage(node.tokens);
      if (nextUsage) usage = nextUsage;
    }
  }

  return usage ? { meta, items, usage } : { meta, items };
}

async function collectGeminiSessionFiles(
  sessionsDir: string,
  window?: { start: number; end: number },
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const out: Array<{ path: string; mtimeMs: number }> = [];
  await walk(sessionsDir, async (filePath) => {
    const base = path.basename(filePath);
    if (!base.startsWith("session-") || (!base.endsWith(".jsonl") && !base.endsWith(".json"))) return;
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

async function readGeminiSessionId(filePath: string): Promise<string | undefined> {
  try {
    return geminiRecords(await readFile(filePath, "utf8")).find((node) => typeof node.sessionId === "string")?.sessionId as string | undefined;
  } catch {
    return undefined;
  }
}

async function readGeminiSessionInfo(filePath: string): Promise<{ sessionId?: string; subagentText?: string }> {
  try {
    const parsed = parseGeminiSession(await readFile(filePath, "utf8"));
    const firstUser = parsed.items.find((item): item is Extract<CodexSessionItem, { kind: "message" }> => item.kind === "message" && item.role === "user");
    return {
      ...(parsed.meta.id ? { sessionId: parsed.meta.id } : {}),
      ...(firstUser?.text ? { subagentText: firstUser.text } : {}),
    };
  } catch {
    return {};
  }
}

function geminiRecords(raw: string): Array<Record<string, unknown>> {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    const node = JSON.parse(trimmed) as unknown;
    return normalizeGeminiRecords(recordsFromGeminiNode(node));
  } catch {
    // Fall through to JSONL parsing.
  }

  const records: Array<Record<string, unknown>> = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const node = JSON.parse(line) as unknown;
      if (node && typeof node === "object" && !Array.isArray(node)) records.push(node as Record<string, unknown>);
    } catch {
      // tolerate partial/corrupt trailing lines
    }
  }
  return normalizeGeminiRecords(records);
}

function recordsFromGeminiNode(node: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(node)) {
    return node.flatMap(recordsFromGeminiNode);
  }
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const messages = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.history)
      ? record.history
      : Array.isArray(record.records)
        ? record.records
        : undefined;
  if (!messages) return [record];
  return [record, ...messages.filter((item): item is Record<string, unknown> => item && typeof item === "object" && !Array.isArray(item))];
}

function normalizeGeminiRecords(records: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if ("$set" in record) continue;
    const id = typeof record.id === "string" ? record.id : undefined;
    if (!id) {
      out.push(record);
      continue;
    }
    const existing = byId.get(id);
    if (existing) {
      Object.assign(existing, record);
      continue;
    }
    const copy = { ...record };
    byId.set(id, copy);
    out.push(copy);
  }
  return out;
}

function geminiContentText(content: unknown): string {
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

function geminiFunctionResponses(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const response = (part as Record<string, unknown>).functionResponse;
    if (response !== undefined) out.push(stringifyGeminiOutput(response));
  }
  return out;
}

function geminiThoughts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((thought) => {
      if (!thought || typeof thought !== "object") return "";
      const node = thought as Record<string, unknown>;
      const subject = typeof node.subject === "string" ? node.subject : "";
      const description = typeof node.description === "string" ? node.description : "";
      return [subject, description].filter(Boolean).join("\n");
    })
    .filter(Boolean);
}

function geminiToolCalls(value: unknown): CodexSessionItem[] {
  if (!Array.isArray(value)) return [];
  const out: CodexSessionItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const call = item as Record<string, unknown>;
    const callId = typeof call.id === "string" ? call.id : undefined;
    out.push({
      kind: "function_call",
      name: typeof call.name === "string" ? call.name : "tool",
      arguments: call.args ?? {},
      ...(callId ? { callId } : {}),
    });
    const output = call.resultDisplay ?? call.result;
    if (output !== undefined) {
      out.push({
        kind: "function_call_output",
        ...(callId ? { callId } : {}),
        output: stringifyGeminiOutput(output),
      });
    }
  }
  return out;
}

function geminiUsage(value: unknown): CodexSessionUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const tokens = value as Record<string, unknown>;
  const usage: CodexSessionUsage = {};
  putNumber(usage, "inputTokens", tokens.input);
  putNumber(usage, "cachedInputTokens", tokens.cached);
  putNumber(usage, "outputTokens", tokens.output);
  putNumber(usage, "reasoningOutputTokens", tokens.thoughts);
  putNumber(usage, "totalTokens", tokens.total);
  return Object.keys(usage).length ? usage : undefined;
}

function putNumber(target: CodexSessionUsage, key: keyof CodexSessionUsage, value: unknown): void {
  if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
}

function stringifyGeminiOutput(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated ${text.length - MAX_OUTPUT_CHARS} chars]` : text;
}
