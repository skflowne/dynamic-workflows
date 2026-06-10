/**
 * Per-agent turn control shared by the Codex and Gemini runners: a total-duration timeout combined
 * with the run-level abort signal, plus the canonical timeout-error message. The error message text
 * is an observable contract — it is flattened to message-only across the Bun-child IPC boundary, and
 * the runtime treats `agent exceeded agentTimeoutMs (...)` as a retryable agent failure (not a
 * workflow cancellation), so both runners must emit it identically.
 */

/** Per-agent total-duration timeout (defends against a single backend turn hanging forever). */
export const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60 * 1000;

export interface AgentTimeout {
  /** Signal to pass to the backend turn: the run-level signal combined with the timeout signal. */
  signal: AbortSignal | undefined;
  /** True once *our* timeout fired and the run-level signal did not — i.e. a timeout, not a cancel. */
  timedOut: () => boolean;
  /** Clears the underlying timer. Always call in a `finally`. */
  clear: () => void;
}

/**
 * Arms a per-agent timeout. `timeoutMs <= 0` disables it (the run-level signal is passed through
 * unchanged and `timedOut()` is always false).
 */
export function startAgentTimeout(timeoutMs: number, runSignal: AbortSignal | undefined): AgentTimeout {
  if (!(timeoutMs > 0)) {
    return { signal: runSignal, timedOut: () => false, clear: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: combineSignals(runSignal, controller.signal),
    timedOut: () => controller.signal.aborted && runSignal?.aborted !== true,
    clear: () => clearTimeout(timer),
  };
}

export function agentTimeoutError(timeoutMs: number): Error {
  return new Error(`agent exceeded agentTimeoutMs (${timeoutMs}ms)`);
}

/** Combines an optional run-level signal with an optional timeout signal into one. */
export function combineSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (!a) return b;
  if (!b) return a;
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === "function") return anyFn([a, b]);
  // Fallback for runtimes without AbortSignal.any. Detach both listeners on the first abort —
  // otherwise every agent() leaks a listener on the long-lived, run-level signal.
  const controller = new AbortController();
  const onAbort = () => {
    a.removeEventListener("abort", onAbort);
    b.removeEventListener("abort", onAbort);
    controller.abort();
  };
  if (a.aborted || b.aborted) controller.abort();
  else {
    a.addEventListener("abort", onAbort);
    b.addEventListener("abort", onAbort);
  }
  return controller.signal;
}
