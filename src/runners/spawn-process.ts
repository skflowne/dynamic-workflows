import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { AgentOutputLimitExceededError } from "../errors.js";
import { agentTimeoutError } from "./turn-control.js";

/**
 * Shared child-process plumbing for the CLI runners (Gemini, pi). Spawns the backend, buffers stdout/
 * stderr with byte ceilings, and settles only after the child has fully **closed** — never on `exit`,
 * which can fire before trailing stdout is delivered and would truncate the parsed result.
 *
 * Termination discipline (abort / timeout / output-overflow): send SIGTERM, wait a grace period for the
 * child to close, then escalate to SIGKILL if it is still alive — and only settle once the child has
 * actually closed. A process that ignores SIGTERM therefore can't keep running (burning tokens) while
 * the runtime believes it stopped, and the caller's worktree cleanup can't tear out the cwd of a
 * still-live child (the returned promise doesn't resolve until the child is gone).
 */

/** Grace period between SIGTERM and the escalating SIGKILL. */
const SIGKILL_GRACE_MS = 2000;

export interface SpawnAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to the child's stdin then closed. When set, stdin is piped; otherwise it's ignored. */
  stdin?: string;
  /** Total buffered stdout ceiling. Set to 0 when stdout is consumed incrementally and not retained. */
  maxStdoutBytes: number;
  maxStderrBytes: number;
  /** Incremental decoded stdout consumer. Exceptions terminate the child and reject the run. */
  onStdoutText?: (text: string) => void;
  /** Defaults to true. Disable when onStdoutText retains all state needed by the caller. */
  retainStdout?: boolean;
  /** Backend label used in overflow error messages, e.g. "Gemini CLI" or "pi". */
  label: string;
  signal: AbortSignal | undefined;
  timedOut: () => boolean;
  timeoutMs: number;
  /** Maps a spawn `error` event (e.g. ENOENT / E2BIG) to a friendlier error. */
  normalizeSpawnError: (error: Error) => Error;
}

export interface SpawnAgentResult {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export function spawnAgentProcess(options: SpawnAgentOptions): Promise<SpawnAgentResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: [options.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });

    // StringDecoder keeps multi-byte UTF-8 characters intact across chunk boundaries (a naive
    // per-chunk buffer.toString would corrupt them, silently dropping/mangling data lines).
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    /** Set once we decide to fail; the reason is deferred until the child has closed. */
    let pendingError: unknown;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const clearKillTimer = () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = undefined;
      }
    };

    const settle = (error: unknown, value?: SpawnAgentResult) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      clearKillTimer();
      if (error) reject(error);
      else resolve(value as SpawnAgentResult);
    };

    // Begins SIGTERM→(grace)→SIGKILL termination and records the failure. Does NOT settle the promise —
    // that happens from the `close` handler once the child is actually gone.
    const terminate = (error: unknown) => {
      if (settled || pendingError !== undefined) return;
      pendingError = error;
      killProcessTree(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killTimer = undefined;
        killProcessTree(child.pid, "SIGKILL");
      }, SIGKILL_GRACE_MS);
      killTimer.unref?.();
    };

    const onAbort = () => {
      terminate(options.timedOut() ? agentTimeoutError(options.timeoutMs) : new Error("agent aborted"));
    };

    const overflow = (stream: string, limit: number) => {
      terminate(new AgentOutputLimitExceededError(`${options.label} ${stream} exceeded ${limit} bytes — aborting to avoid unbounded buffering`));
    };

    const consumeStdout = (text: string) => {
      if (!text) return;
      try {
        options.onStdoutText?.(text);
      } catch (error) {
        terminate(error);
        return;
      }
      if (options.retainStdout !== false) stdout += text;
    };

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout!.on("data", (chunk: Buffer) => {
      if (pendingError !== undefined) return; // draining a doomed child; don't keep buffering
      stdoutBytes += chunk.length;
      if (options.maxStdoutBytes > 0 && stdoutBytes > options.maxStdoutBytes) return overflow("stdout", options.maxStdoutBytes);
      consumeStdout(stdoutDecoder.write(chunk));
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (pendingError !== undefined) return;
      stderrBytes += chunk.length;
      if (stderrBytes > options.maxStderrBytes) return overflow("stderr", options.maxStderrBytes);
      stderr += stderrDecoder.write(chunk);
    });

    // A spawn failure (ENOENT / E2BIG) emits `error` and never `close`, so settle here directly.
    child.on("error", (error) => settle(options.normalizeSpawnError(error)));

    // Settle on `close` (all stdio ended) — not `exit` — so trailing stdout is never truncated.
    child.on("close", (code, signalName) => {
      consumeStdout(stdoutDecoder.end());
      stderr += stderrDecoder.end();
      if (pendingError !== undefined) {
        settle(pendingError);
        return;
      }
      settle(undefined, { stdout, stderr, code, signal: signalName });
    });

    if (options.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // ignore EPIPE if the child exits before reading its prompt
      child.stdin.end(options.stdin);
    }
  });
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  if (process.platform === "win32") {
    const args = signal === "SIGKILL" ? ["/pid", String(pid), "/t", "/f"] : ["/pid", String(pid), "/t"];
    spawn("taskkill", args, { stdio: "ignore" }).unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may already have exited.
  }
}
