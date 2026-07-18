import { randomUUID } from "node:crypto";
import { WorkflowInputError } from "../errors.js";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner } from "../types.js";
import { buildSubagentPrompt } from "./prompt.js";
import { spawnAgentProcess, type SpawnAgentResult } from "./spawn-process.js";
import { DEFAULT_AGENT_TIMEOUT_MS, startAgentTimeout } from "./turn-control.js";
import { createDetachedWorktree } from "./worktree.js";

/** Output buffer ceilings — a runaway Gemini turn (e.g. YOLO tool spam) must never OOM the parent. */
const MAX_STDOUT_BYTES = 32 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

export interface GeminiCliAgentRunnerOptions {
  /** Gemini CLI executable. Defaults to `gemini`. */
  command?: string;
  /** Extra arguments inserted before generated `--model`, `-y`, `-o json`, and `-p`. */
  args?: string[];
  cwd?: string;
  model?: string;
  baseInstructions?: string;
  /** Per-agent total-duration timeout in ms. Defaults to 15 min; set 0 to disable. */
  agentTimeoutMs?: number;
  /** Emit `-o json` and parse the wrapper. Defaults to true. */
  jsonOutput?: boolean;
  /** Emit `-y` so Gemini auto-accepts tools. Defaults to true. */
  yolo?: boolean;
}

interface GeminiJsonOutput {
  session_id?: unknown;
  response?: unknown;
  error?: unknown;
  stats?: unknown;
}

/**
 * Runs each workflow `agent()` call as an independent Gemini CLI process.
 *
 * Gemini CLI has no structured-output schema flag, so schema enforcement stays in the workflow
 * runtime: this runner returns the final response text, and the runtime parses/validates it when
 * `agent({ schema })` is used.
 */
export class GeminiCliAgentRunner implements WorkflowAgentRunner {
  constructor(private readonly options: GeminiCliAgentRunnerOptions = {}) {}

  async run(
    call: WorkflowAgentCall,
    signal?: AbortSignal,
    onMeta?: (meta: WorkflowAgentMeta) => void,
  ): Promise<unknown> {
    const baseCwd = this.options.cwd ?? process.cwd();
    const worktree = call.options.isolation === "worktree" ? await createDetachedWorktree(baseCwd) : undefined;
    const workingDirectory = worktree?.dir ?? baseCwd;
    const prompt = buildSubagentPrompt(call, {
      baseInstructions: this.options.baseInstructions,
      backendName: "Gemini CLI",
      inWorktree: Boolean(worktree),
      // Gemini has no native schema flag, so the schema text must live in the prompt.
      embedSchema: true,
    });

    const timeoutMs = this.options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const timeout = startAgentTimeout(timeoutMs, signal);

    const sessionId = resolveGeminiSessionId(this.options.args);
    onMeta?.({ backend: "gemini", ...(sessionId ? { sessionId } : {}) });
    const command = this.options.command ?? "gemini";

    try {
      // The prompt goes on stdin (Gemini appends `-p` to stdin input) so a huge fan-in prompt can't
      // blow past the OS ARG_MAX limit and isn't visible in `ps`; `-p ""` forces headless mode.
      const raw = await spawnAgentProcess({
        command,
        args: buildGeminiArgs(this.options.model, this.options, sessionId),
        cwd: workingDirectory,
        env: process.env,
        stdin: prompt,
        maxStdoutBytes: MAX_STDOUT_BYTES,
        maxStderrBytes: MAX_STDERR_BYTES,
        label: "Gemini CLI",
        signal: timeout.signal,
        timedOut: timeout.timedOut,
        timeoutMs,
        normalizeSpawnError: (error) => normalizeGeminiSpawnError(error, command),
      });
      const result = parseGeminiResult(raw, this.options.jsonOutput !== false);
      if (result.error) throw new Error(result.error);
      if (result.sessionId) onMeta?.({ backend: "gemini", sessionId: result.sessionId });
      if (typeof result.outputTokens === "number") onMeta?.({ outputTokens: result.outputTokens });
      return result.response;
    } finally {
      timeout.clear();
      if (worktree) await worktree.cleanup(onMeta);
    }
  }
}

function buildGeminiArgs(
  model: string | undefined,
  options: GeminiCliAgentRunnerOptions,
  sessionId: string | undefined,
): string[] {
  const args = [...(options.args ?? [])];
  if (model !== undefined) args.push("--model", model);
  if (options.yolo !== false) args.push("-y");
  if (options.jsonOutput !== false) args.push("-o", "json");
  if (sessionId !== undefined && !hasGeminiSessionSelector(args)) args.push("--session-id", sessionId);
  // Empty `-p` triggers headless mode; the actual prompt is fed on stdin (see run()).
  args.push("-p", "");
  return args;
}

function resolveGeminiSessionId(args: string[] | undefined): string | undefined {
  const explicit = optionValue(args, "--session-id");
  if (explicit) return explicit;
  return hasGeminiSessionSelector(args ?? []) ? undefined : randomUUID();
}

function hasGeminiSessionSelector(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === "--session-id" ||
      arg.startsWith("--session-id=") ||
      arg === "--resume" ||
      arg.startsWith("--resume=") ||
      arg === "-r" ||
      arg === "--session-file" ||
      arg.startsWith("--session-file="),
  );
}

function optionValue(args: string[] | undefined, name: string): string | undefined {
  if (!args) return undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) return args[i + 1];
    const prefix = `${name}=`;
    if (arg?.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

interface GeminiParseResult {
  response: unknown;
  sessionId?: string;
  outputTokens?: number;
  /** Set when the turn failed; the caller throws it (kept out of the happy path so meta is reported). */
  error?: string;
}

function parseGeminiResult(raw: SpawnAgentResult, parseJsonWrapper: boolean): GeminiParseResult {
  const parsed = parseJsonWrapper ? parseGeminiOutput(raw.stdout) ?? parseGeminiOutput(raw.stderr) : undefined;
  if (parsed) {
    const error = geminiErrorMessage(parsed);
    if (error) return { response: "", error };
    // `response` is normally a string; if Gemini returns a structured object we pass it through
    // unchanged to normalizeAgentResult (saves a JSON round-trip when agent({schema}) is used).
    return {
      response: typeof parsed.response === "string" ? parsed.response : parsed.response ?? "",
      ...metaFromGeminiJson(parsed),
    };
  }

  const text = raw.stdout.trim();
  if (raw.code === 0 && text) return { response: text };

  const detail =
    cleanErrorText(raw.stderr) || text || `exit code ${raw.code ?? "unknown"}${raw.signal ? `, signal ${raw.signal}` : ""}`;
  return { response: "", error: `Gemini CLI failed: ${detail}` };
}

function parseGeminiOutput(text: string): GeminiJsonOutput | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  // Candidates in priority order: (1) the whole string — clean `-o json`; (2) brace-balanced slices
  // around a `session_id` marker — a wrapper embedded in surrounding CLI noise; (3) a naive slice from
  // the first `{` to end — last-resort fallback for wrappers without a `session_id` (may carry trailing
  // noise, hence ranked last). The first candidate that parses into a wrapper-shaped object wins.
  const candidates = [trimmed, ...jsonObjectCandidates(trimmed)];
  const objectStart = trimmed.indexOf("{");
  if (objectStart > 0) candidates.push(trimmed.slice(objectStart));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === "object" && ("response" in parsed || "error" in parsed || "session_id" in parsed)) {
        return parsed as GeminiJsonOutput;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const marker of ['{"session_id"', '"session_id"']) {
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const markerIndex = text.indexOf(marker, searchFrom);
      if (markerIndex < 0) break;
      const start = marker.startsWith("{") ? markerIndex : text.lastIndexOf("{", markerIndex);
      if (start >= 0) {
        const end = matchingJsonObjectEnd(text, start);
        candidates.push(text.slice(start, end ?? text.length).trim());
      }
      searchFrom = markerIndex + marker.length;
    }
  }
  return candidates;
}

function matchingJsonObjectEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

function geminiErrorMessage(parsed: GeminiJsonOutput): string | undefined {
  if (!("error" in parsed)) return undefined;
  const error = parsed.error;
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const node = error as Record<string, unknown>;
    const message = typeof node.message === "string" ? node.message : JSON.stringify(node);
    const type = typeof node.type === "string" ? `${node.type}: ` : "";
    return `${type}${message}`;
  }
  return String(error);
}

function metaFromGeminiJson(parsed: GeminiJsonOutput): { sessionId?: string; outputTokens?: number } {
  const out: { sessionId?: string; outputTokens?: number } = {};
  if (typeof parsed.session_id === "string") out.sessionId = parsed.session_id;
  const outputTokens = sumModelOutputTokens(parsed.stats);
  if (typeof outputTokens === "number") out.outputTokens = outputTokens;
  return out;
}

/** Sums output tokens across *all* models in `stats.models` — a single turn may use more than one. */
function sumModelOutputTokens(stats: unknown): number | undefined {
  if (!stats || typeof stats !== "object") return undefined;
  const models = (stats as { models?: unknown }).models;
  if (!models || typeof models !== "object") return undefined;
  let total = 0;
  let found = false;
  for (const model of Object.values(models as Record<string, unknown>)) {
    if (!model || typeof model !== "object") continue;
    const tokens = (model as { tokens?: unknown }).tokens;
    if (!tokens || typeof tokens !== "object") continue;
    const record = tokens as Record<string, unknown>;
    // `candidates` (and `output`) are generation-only. NEVER fall back to `total`, which includes input
    // tokens and would inflate budget.spent(); when neither is present, leave it undefined so the
    // runtime falls back to estimateTokens.
    const value = numberField(record, "candidates") ?? numberField(record, "output");
    if (typeof value === "number") {
      total += value;
      found = true;
    }
  }
  return found ? total : undefined;
}

function numberField(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function cleanErrorText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("at ") && !line.startsWith("file://"))
    .join("\n")
    .slice(0, 2000);
}

function normalizeGeminiSpawnError(error: Error, command: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WorkflowInputError(
      `Gemini CLI not found at "${command}". Install Gemini CLI, add it to PATH, or pass --gemini-command <path> / command in the library API.`,
    );
  }
  return error;
}
