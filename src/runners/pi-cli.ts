import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorkflowInputError } from "../errors.js";
import type { WorkflowAgentCall, WorkflowAgentMeta, WorkflowAgentRunner } from "../types.js";
import { buildSubagentPrompt } from "./prompt.js";
import { agentTimeoutError, DEFAULT_AGENT_TIMEOUT_MS, startAgentTimeout } from "./turn-control.js";
import { createDetachedWorktree } from "./worktree.js";

/** Output buffer ceilings — a runaway pi turn (e.g. tool-spam loop) must never OOM the parent. */
const MAX_STDOUT_BYTES = 64 * 1024 * 1024;
const MAX_STDERR_BYTES = 4 * 1024 * 1024;

/** Env var the generated models.json references for the custom provider's API key (keeps it off disk). */
const CUSTOM_API_KEY_ENV = "CODEX_WORKFLOW_PI_API_KEY";
/** Provider name used in the generated models.json when a custom `baseUrl` is supplied. */
const CUSTOM_PROVIDER = "custom";

export interface PiCliAgentRunnerOptions {
  /** pi CLI executable. Defaults to `pi`. */
  command?: string;
  /** Extra arguments inserted before the generated headless flags. */
  args?: string[];
  cwd?: string;
  /** `--model` (supports `provider/id` and `:<thinking>`). With `baseUrl`, this is the model id sent to the API. */
  model?: string;
  /** `--provider`. Ignored when `baseUrl` is set (a synthetic `custom` provider is generated instead). */
  provider?: string;
  /** API key. Passed via `--api-key` for built-in providers, or injected via env for a custom `baseUrl`. */
  apiKey?: string;
  /**
   * Custom OpenAI-compatible (or Anthropic-compatible) endpoint. pi has no `--base-url` flag, so when
   * this is set the runner materializes a `models.json` under `agentDir` describing a synthetic provider
   * and points pi at it via `PI_CODING_AGENT_DIR`.
   */
  baseUrl?: string;
  /** Provider API shape for a custom `baseUrl`. Defaults to `openai-completions`. */
  api?: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  /** `--thinking <level>`. */
  thinking?: string;
  /** `--tools` allowlist (comma-joined). */
  tools?: string[];
  /** `--exclude-tools` denylist (comma-joined). */
  excludeTools?: string[];
  /** Pass `--no-tools` (disable all tools — a pure text turn). */
  noTools?: boolean;
  /** Trust project-local files for the run (`-a`). Defaults to true so non-interactive turns don't stall. */
  approve?: boolean;
  /** Load AGENTS.md/CLAUDE.md (`--no-context-files` when false). Defaults to false (clean, cheap subagents). */
  contextFiles?: boolean;
  /** `PI_CODING_AGENT_DIR` — agent config home. Required (and used to host the generated models.json) when `baseUrl` is set. */
  agentDir?: string;
  /** `--session-dir` — where pi writes session files; the viewer reads linked sessions from here. */
  sessionDir?: string;
  baseInstructions?: string;
  /** Per-agent total-duration timeout in ms. Defaults to 15 min; set 0 to disable. */
  agentTimeoutMs?: number;
}

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface PiAssistantMessage {
  role: string;
  content?: unknown;
  usage?: PiUsage;
  stopReason?: string;
  errorMessage?: string;
}

/**
 * Runs each workflow `agent()` call as an independent `pi` (pi-coding-agent) process in headless
 * `--mode json` mode. pi is a full agentic harness (read/bash/edit/write/grep/find/ls tools), so unlike
 * a raw chat-completions backend its subagents can explore the repo and run commands.
 *
 * pi has no native structured-output schema flag, so schema enforcement stays in the workflow runtime:
 * this runner returns the final assistant text, and the runtime parses/validates it when `agent({schema})`
 * is used. pi auto-persists each session as JSONL under `sessionDir`, which the viewer links + parses.
 */
export class PiCliAgentRunner implements WorkflowAgentRunner {
  /** Memoized models.json materialization (written at most once per runner instance). */
  private modelsConfigReady: Promise<void> | undefined;

  constructor(private readonly options: PiCliAgentRunnerOptions = {}) {}

  async run(
    call: WorkflowAgentCall,
    signal?: AbortSignal,
    onMeta?: (meta: WorkflowAgentMeta) => void,
  ): Promise<unknown> {
    onMeta?.({ backend: "pi" });
    const baseCwd = this.options.cwd ?? process.cwd();
    const worktree = call.options.isolation === "worktree" ? await createDetachedWorktree(baseCwd) : undefined;
    const workingDirectory = worktree?.dir ?? baseCwd;
    const prompt = buildSubagentPrompt(call, {
      baseInstructions: this.options.baseInstructions,
      backendName: "pi",
      inWorktree: Boolean(worktree),
      // pi has no native schema flag, so the schema text must live in the prompt.
      embedSchema: true,
    });

    const timeoutMs = this.options.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
    const timeout = startAgentTimeout(timeoutMs, signal);

    try {
      await this.ensureModelsConfig();
      const result = await runPiProcess(buildPiArgs(prompt, this.options), {
        command: this.options.command ?? "pi",
        cwd: workingDirectory,
        env: this.spawnEnv(),
        signal: timeout.signal,
        timedOut: timeout.timedOut,
        timeoutMs,
      });
      if (result.sessionId) onMeta?.({ backend: "pi", sessionId: result.sessionId });
      if (typeof result.outputTokens === "number") onMeta?.({ outputTokens: result.outputTokens });
      // A turn can legitimately end on a text-less assistant message (only thinking/tool-call blocks).
      // With a schema that empty string would die in JSON parsing downstream with a cryptic message —
      // fail here with the real reason instead, so the runtime's retry loop logs something actionable.
      if (call.options.schema !== undefined && result.response === "") {
        throw new Error("pi returned no text content (final assistant message had only thinking/tool-call blocks); cannot satisfy agent({schema})");
      }
      return result.response;
    } finally {
      timeout.clear();
      if (worktree) await worktree.cleanup(onMeta);
    }
  }

  /** Writes `<agentDir>/models.json` with a synthetic OpenAI/Anthropic-compatible provider when `baseUrl` is set. */
  private ensureModelsConfig(): Promise<void> {
    if (!this.options.baseUrl) return Promise.resolve();
    if (!this.options.agentDir) {
      return Promise.reject(
        new WorkflowInputError("pi backend: baseUrl requires an agentDir to host the generated models.json"),
      );
    }
    if (!this.options.model) {
      return Promise.reject(new WorkflowInputError("pi backend: baseUrl requires a --model (the model id sent to the endpoint)"));
    }
    if (!this.modelsConfigReady) {
      this.modelsConfigReady = writePiModelsConfig(this.options.agentDir, {
        baseUrl: this.options.baseUrl,
        api: this.options.api ?? "openai-completions",
        model: this.options.model,
        hasApiKey: Boolean(this.options.apiKey),
      });
    }
    return this.modelsConfigReady;
  }

  private spawnEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.agentDir) env.PI_CODING_AGENT_DIR = this.options.agentDir;
    // For a custom baseUrl, the generated models.json resolves the key from this env var (never written to disk).
    if (this.options.baseUrl && this.options.apiKey) env[CUSTOM_API_KEY_ENV] = this.options.apiKey;
    return env;
  }
}

function buildPiArgs(prompt: string, options: PiCliAgentRunnerOptions): string[] {
  const args = [...(options.args ?? [])];
  args.push("-p", "--mode", "json");
  if (options.contextFiles !== true) args.push("--no-context-files");

  if (options.baseUrl) {
    // Custom endpoint → the synthetic provider in the generated models.json; key comes from env.
    args.push("--provider", CUSTOM_PROVIDER, "--model", requireModel(options.model));
  } else {
    if (options.provider) args.push("--provider", options.provider);
    if (options.model) args.push("--model", options.model);
    if (options.apiKey) args.push("--api-key", options.apiKey);
  }

  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.noTools) args.push("--no-tools");
  else {
    if (options.tools?.length) args.push("--tools", options.tools.join(","));
    if (options.excludeTools?.length) args.push("--exclude-tools", options.excludeTools.join(","));
  }
  if (options.approve !== false) args.push("--approve");
  if (options.sessionDir) args.push("--session-dir", options.sessionDir);

  // Prompt is a positional argument; keep it last so it can't be parsed as a flag value.
  args.push(prompt);
  return args;
}

function requireModel(model: string | undefined): string {
  if (!model) throw new WorkflowInputError("pi backend: baseUrl requires a --model");
  return model;
}

/** Writes the synthetic provider config pi reads from `<agentDir>/models.json`. */
export async function writePiModelsConfig(
  agentDir: string,
  provider: { baseUrl: string; api: string; model: string; hasApiKey: boolean },
): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  const config = {
    providers: {
      [CUSTOM_PROVIDER]: {
        name: "codex-workflow custom endpoint",
        baseUrl: provider.baseUrl,
        api: provider.api,
        // pi requires the apiKey field and errors on a reference to an unset env var, so a keyless
        // endpoint (Ollama, vLLM, ...) gets a literal placeholder instead of the env reference.
        apiKey: provider.hasApiKey ? `$${CUSTOM_API_KEY_ENV}` : "dummy",
        models: [
          {
            id: provider.model,
            name: provider.model,
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  };
  await writeFile(path.join(agentDir, "models.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function runPiProcess(
  args: string[],
  options: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal | undefined;
    timedOut: () => boolean;
    timeoutMs: number;
  },
): Promise<{ response: string; sessionId?: string; outputTokens?: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const settle = (error: unknown, value?: { response: string; sessionId?: string; outputTokens?: number }) => {
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
      settle(new Error(`pi ${stream} exceeded ${limit} bytes — aborting to avoid unbounded buffering`));
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
    child.on("error", (error) => settle(normalizePiSpawnError(error, options.command)));
    child.on("exit", (code, signalName) => {
      if (settled) return;
      // pi exits 0 even when the model turn errored, so success/failure is decided by the LAST assistant
      // message's stopReason, NOT the exit code (see the events parse below).
      const parsed = parsePiEvents(stdout);
      if (parsed.error) {
        settle(new Error(`pi agent failed: ${parsed.error}`));
        return;
      }
      if (parsed.hasAssistant) {
        settle(undefined, {
          response: parsed.response,
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          ...(parsed.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
        });
        return;
      }
      // No parseable assistant turn at all → surface stderr / exit status as the failure.
      const detail = cleanErrorText(stderr) || `exit code ${code ?? "unknown"}${signalName ? `, signal ${signalName}` : ""}`;
      settle(new Error(`pi produced no assistant response: ${detail}`));
    });
  });
}

interface ParsedPiEvents {
  response: string;
  sessionId?: string;
  outputTokens?: number;
  /** True once any assistant message was seen (distinguishes "errored turn" from "no output at all"). */
  hasAssistant: boolean;
  /** Set when the final assistant turn ended in an error (pi still exits 0). */
  error?: string;
}

/**
 * Parses pi's `--mode json` NDJSON event stream. Tracks the session id (first `session` event), the
 * text of the LAST assistant message (the final answer), and the summed `usage.output` across all
 * assistant messages (a tool-using turn produces several). Surfaces the final turn's error, if any.
 */
export function parsePiEvents(raw: string): ParsedPiEvents {
  let sessionId: string | undefined;
  let lastAssistant: PiAssistantMessage | undefined;
  let outputTokens: number | undefined;
  let hasAssistant = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // tolerate non-JSON noise / partial trailing lines
    }
    const type = event.type as string | undefined;
    if (type === "session" && typeof event.id === "string") {
      sessionId = event.id;
      continue;
    }
    // Each assistant message is finalized once, in a `message_end`. turn_end/agent_end repeat the same
    // message, so summing usage off message_end only keeps the token total from being double-counted.
    if (type === "message_end") {
      const message = asAssistantMessage(event.message);
      if (message) {
        hasAssistant = true;
        lastAssistant = message;
        const out = message.usage?.output;
        if (typeof out === "number") outputTokens = (outputTokens ?? 0) + out;
      }
    }
  }

  if (lastAssistant && (lastAssistant.stopReason === "error" || lastAssistant.errorMessage)) {
    return { response: "", hasAssistant, ...(sessionId ? { sessionId } : {}), error: cleanPiErrorMessage(lastAssistant.errorMessage) };
  }
  return {
    response: lastAssistant ? assistantText(lastAssistant.content) : "",
    hasAssistant,
    ...(sessionId ? { sessionId } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function asAssistantMessage(value: unknown): PiAssistantMessage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as PiAssistantMessage;
  return message.role === "assistant" ? message : undefined;
}

/** Joins the `text` content blocks of an assistant message (thinking/toolCall blocks are not part of the result). */
function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const node = block as Record<string, unknown>;
    if (node.type === "text" && typeof node.text === "string") parts.push(node.text);
  }
  return parts.join("");
}

/** pi's `errorMessage` is often a nested JSON string; surface the innermost human-readable message. */
function cleanPiErrorMessage(errorMessage: string | undefined): string {
  if (!errorMessage) return "assistant turn ended with an error";
  let text = errorMessage;
  for (let depth = 0; depth < 4; depth++) {
    try {
      const parsed = JSON.parse(text) as unknown;
      const message = extractMessage(parsed);
      if (message === undefined) break;
      text = message;
    } catch {
      break;
    }
  }
  return text.trim().slice(0, 2000) || "assistant turn ended with an error";
}

function extractMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    const inner = node.error ?? node.message;
    if (typeof inner === "string") return inner;
    if (inner && typeof inner === "object") return extractMessage(inner);
  }
  return undefined;
}

function cleanErrorText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("at ") && !line.startsWith("file://"))
    .join("\n")
    .slice(0, 2000);
}

function normalizePiSpawnError(error: Error, command: string): Error {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return new WorkflowInputError(
      `pi CLI not found at "${command}". Install it (npm i -g @earendil-works/pi-coding-agent), add it to PATH, or pass --pi-command <path> / command in the library API.`,
    );
  }
  return error;
}
