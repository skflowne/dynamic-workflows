import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import type { AgentFailure } from "./types.js";
import type { WorkflowSourceKind } from "./workflow-tool.js";

export type RunRecordStatus = "running" | "completed" | "failed" | "cancelled";

/**
 * Runner configuration a run used. A run resolves its backends/models from a provider config, so this
 * records the config file (path + a secret-free content hash) and the run-level default provider, which
 * is all `resume` needs to reload the same routing. The journal cache key is provider/model-aware, so
 * cached agents replay regardless; only re-run agents go through the (re-loaded) config.
 */
export interface RunnerConfig {
  /** Provider config file this run loaded (`--config` or discovered), so `resume` reloads the same one. */
  configPath?: string;
  /** Secret-free content hash of the loaded provider config — `resume` warns if it has since drifted. */
  configHash?: string;
  /** Run-level default provider name (`--provider`) selected from the config. */
  defaultProvider?: string;
}

export interface RunRecord {
  runId: string;
  name: string;
  description?: string;
  status: RunRecordStatus;
  source: WorkflowSourceKind;
  scriptPath?: string;
  /** Runner config this run used (backend/model/gemini-command) — lets `resume` reuse it. */
  runner?: RunnerConfig;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  agentCount?: number;
  cacheHits?: number;
  /** Count of agents that failed after exhausting retries. */
  failureCount?: number;
  /**
   * Detail of agents that failed after exhausting retries. Failed agents are deliberately NOT
   * journaled (so `--resume` re-attempts them), so this is the only place their detail is persisted —
   * promoted here from the in-memory run result so the viewer can render them as historical nodes.
   */
  failures?: AgentFailure[];
  /** Declared pipeline (meta.phases titles, in order) — the canonical phase order for the viewer. */
  declaredPhases?: string[];
  phases?: string[];
  logs?: string[];
  error?: string;
  /** The arguments passed into the workflow (the `args` value). Shown in the viewer. */
  args?: unknown;
  /** The workflow's final return value (what the script `return`ed). Shown in the viewer. */
  result?: unknown;
}

/**
 * Tiny file-backed history of workflow runs, one JSON document per run under `<dir>`. Powers the
 * CLI `runs` / `show` commands so completed runs can be browsed after the process exits.
 */
export class FileRunStore {
  constructor(private readonly dir: string) {}

  async save(record: RunRecord): Promise<void> {
    await atomicWriteFile(this.recordPath(record.runId), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Merges a partial update into an existing record (no-op if the run is unknown). */
  async update(runId: string, patch: Partial<RunRecord>): Promise<void> {
    const existing = await this.get(runId);
    if (!existing) return;
    await this.save({ ...existing, ...patch });
  }

  async get(runId: string): Promise<RunRecord | undefined> {
    try {
      return JSON.parse(await readFile(this.recordPath(runId), "utf8")) as RunRecord;
    } catch {
      return undefined;
    }
  }

  /** Returns all records, newest first. */
  async list(): Promise<RunRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        records.push(JSON.parse(await readFile(path.join(this.dir, entry), "utf8")) as RunRecord);
      } catch {
        // Skip unreadable records.
      }
    }
    return records.sort((a, b) => b.startedAt - a.startedAt);
  }

  private recordPath(runId: string): string {
    return path.join(this.dir, `${sanitizeRunId(runId)}.json`);
  }
}

/** Maps a runId to a filesystem-safe basename, shared by the record file and its live-events file. */
export function sanitizeRunId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
