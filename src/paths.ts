import os from "node:os";
import path from "node:path";

/**
 * Root directory for codex-workflow's runtime data — run history, per-agent journal, session links,
 * and the viewer's pid/port file. Global (under the user's home) by default so runs from every
 * project share one store and one viewer; override with `CODEX_WORKFLOW_HOME` (used by tests for
 * isolation, and by anyone who wants a project-local store).
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

export function webStatePath(dataDir = workflowDataDir()): string {
  return path.join(dataDir, "web.json");
}
