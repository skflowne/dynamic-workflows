import os from "node:os";
import path from "node:path";

/**
 * Root directory for codex-workflow's runtime data — run history, per-agent journal, and session
 * links. Global (under the user's home) by default so runs from every project share one store;
 * override with `CODEX_WORKFLOW_HOME` (used by tests for isolation, and by anyone who wants a
 * project-local store).
 */
export function workflowDataDir(): string {
  const override = process.env.CODEX_WORKFLOW_HOME;
  return override && override.trim() ? path.resolve(override) : path.join(os.homedir(), ".codex-workflow");
}

export function runsDir(dataDir = workflowDataDir()): string {
  return path.join(dataDir, "runs");
}

export function journalDir(dataDir = workflowDataDir()): string {
  return path.join(dataDir, "journal");
}

export function linksDir(dataDir = workflowDataDir()): string {
  return path.join(dataDir, "links");
}

/**
 * Where the pi backend writes its session JSONL (passed to `pi --session-dir`). The single source of
 * truth for this path — the web server imports it as its default, so runner and viewer always agree.
 */
export function piSessionsDir(dataDir = workflowDataDir()): string {
  return path.join(dataDir, "pi", "sessions");
}

/** pi agent-config home (`PI_CODING_AGENT_DIR`) used to host a generated models.json for a custom base URL. */
export function piHomeDir(dataDir = workflowDataDir()): string {
  return path.join(dataDir, "pi", "home");
}
