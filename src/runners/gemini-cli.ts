import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { WorkflowInputError } from "../errors.js";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner } from "../types.js";
import { buildSubagentPrompt } from "./prompt.js";
import { agentTimeoutError, DEFAULT_AGENT_TIMEOUT_MS, startAgentTimeout } from "./turn-control.js";
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

    try {
      const result = await runGeminiProcess(
        buildGeminiArgs(prompt, this.options.model, this.options, sessionId),
        {
          command: this.options.command ?? "gemini",
          cwd: workingDirectory,
          parseJsonWrapper: this.options.jsonOutput !== false,
          signal: timeout.signal,
          timedOut: timeout.timedOut,
          timeoutMs,
        },
      );
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
  prompt: string,
  model: string | undefined,
  options: GeminiCliAgentRunnerOptions,
  sessionId: string | undefined,
): string[] {
  const args = [...(options.args ?? [])];
  if (model !== undefined) args.push("--model", model);
  if (options.yolo !== false) args.push("-y");
  if (options.jsonOutput !== false) args.push("-o", "json");
  if (sessionId !== undefined && !hasGeminiSessionSelector(args)) args.push("--session-id", sessionId);
  args.push("-p", prompt);
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

async function runGeminiProcess(
  args: string[],
  options: {
    command: string;
    cwd: string;
    parseJsonWrapper: boolean;
    signal: AbortSignal | undefined;
    timedOut: () => boolean;
    timeoutMs: number;
  },
): Promise<{ response: unknown; sessionId?: string; outputTokens?: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const settle = (error: unknown, value?: { response: unknown; sessionId?: string; outputTokens?: number }) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value ?? { response: "" });
    };

    const abort = () => {
      child.kill("SIGTERM");
      settle(options.timedOut() ? agentTimeoutError(options.timeoutMs) : new Error("agent aborted"));
    };

    const overflow = (stream: string, limit: number) => {
      child.kill("SIGTERM");
      settle(new Error(`Gemini CLI ${stream} exceeded ${limit} bytes — aborting to avoid unbounded buffering`));
    };

    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) return overflow("stdout", MAX_STDOUT_BYTES);
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) return overflow("stderr", MAX_STDERR_BYTES);
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => settle(normalizeGeminiSpawnError(error, options.command)));
    child.on("exit", (code, signal) => {
      if (settled) return;
      const parsed = options.parseJsonWrapper ? parseGeminiOutput(stdout) ?? parseGeminiOutput(stderr) : undefined;
      if (parsed) {
        const error = geminiErrorMessage(parsed);
        if (error) {
          settle(new Error(error));
          return;
        }
        // `response` is normally a string; if Gemini returns a structured object we pass it through
        // unchanged to normalizeAgentResult (saves a JSON round-trip when agent({schema}) is used).
        settle(undefined, {
          response: typeof parsed.response === "string" ? parsed.response : parsed.response ?? "",
          ...metaFromGeminiJson(parsed),
        });
        return;
      }

      const text = stdout.trim();
      if (code === 0 && text) {
        settle(undefined, { response: text });
        return;
      }

      const detail = cleanErrorText(stderr) || text || `exit code ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}`;
      settle(new Error(`Gemini CLI failed: ${detail}`));
    });
  });
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
    const value = numberField(record, "candidates") ?? numberField(record, "output") ?? numberField(record, "total");
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
