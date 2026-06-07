import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowSourceKind } from "./workflow-tool.js";

export type RunRecordStatus = "running" | "completed" | "failed" | "cancelled";

export interface RunRecord {
  runId: string;
  name: string;
  description?: string;
  status: RunRecordStatus;
  source: WorkflowSourceKind;
  scriptPath?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  agentCount?: number;
  cacheHits?: number;
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
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.recordPath(record.runId), `${JSON.stringify(record, null, 2)}\n`, "utf8");
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
    return path.join(this.dir, `${sanitizeId(runId)}.json`);
  }
}

function sanitizeId(runId: string): string {
  return runId.replace(/[^A-Za-z0-9_.-]/g, "_");
}
