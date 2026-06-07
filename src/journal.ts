import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkflowAgentCall, WorkflowAgentOptions, WorkflowJournal, WorkflowJournalEntry } from "./types.js";

export class InMemoryWorkflowJournal implements WorkflowJournal {
  private readonly entries = new Map<string, WorkflowJournalEntry>();

  get(runId: string, key: string): WorkflowJournalEntry | undefined {
    return this.entries.get(storageKey(runId, key));
  }

  put(entry: WorkflowJournalEntry): void {
    this.entries.set(storageKey(entry.runId, entry.key), structuredClone(entry));
  }

  clear(runId?: string): void {
    if (!runId) {
      this.entries.clear();
      return;
    }
    for (const key of this.entries.keys()) {
      if (key.startsWith(`${runId}:`)) this.entries.delete(key);
    }
  }
}

export class FileWorkflowJournal implements WorkflowJournal {
  constructor(private readonly directory: string) {}

  async get(runId: string, key: string): Promise<WorkflowJournalEntry | undefined> {
    try {
      const raw = await readFile(this.entryPath(runId, key), "utf8");
      return JSON.parse(raw) as WorkflowJournalEntry;
    } catch {
      return undefined;
    }
  }

  async put(entry: WorkflowJournalEntry): Promise<void> {
    const dir = path.join(this.directory, entry.runId);
    await mkdir(dir, { recursive: true });
    await writeFile(this.entryPath(entry.runId, entry.key), JSON.stringify(entry, null, 2), "utf8");
  }

  private entryPath(runId: string, key: string): string {
    return path.join(this.directory, runId, `${key}.json`);
  }
}

export function workflowAgentCacheKey(input: {
  prompt: string;
  options: WorkflowAgentOptions;
}): string {
  return createHash("sha256")
    .update(stableStringify({ prompt: input.prompt, options: input.options }))
    .digest("hex");
}

export function cloneJournalResult(entry: WorkflowJournalEntry): unknown {
  return structuredClone(entry.result);
}

export function journalEntryFromCall(call: WorkflowAgentCall, result: unknown, sessionId?: string): WorkflowJournalEntry {
  return {
    key: call.cacheKey,
    runId: call.runId,
    prompt: call.prompt,
    options: structuredClone(call.options),
    result: structuredClone(result),
    createdAt: Date.now(),
    ...(sessionId ? { sessionId } : {}),
  };
}

function storageKey(runId: string, key: string): string {
  return `${runId}:${key}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`)
    .join(",")}}`;
}
