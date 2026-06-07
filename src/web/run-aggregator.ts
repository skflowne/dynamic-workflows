import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { RunRecord } from "../run-store.js";
import type { WorkflowJournalEntry } from "../types.js";

/**
 * Turns a {@link RunRecord} + its journal entries into the shape the web overview renders: agents
 * grouped under the run's declared phases, a flat agent list ordered by creation, and roll-up stats.
 * Pure and synchronous so it's trivially unit-testable; the I/O lives in {@link readJournalEntries}.
 */

export type AgentStatus = "confirmed" | "killed" | "ok";

export interface AgentView {
  key: string;
  label: string;
  phase?: string;
  createdAt: number;
  status: AgentStatus;
  resultPreview: string;
  hasSchema: boolean;
  hasSession: boolean;
  sessionId?: string;
}

export interface PhaseView {
  title: string;
  agents: AgentView[];
}

export interface RunView {
  phases: PhaseView[];
  agents: AgentView[];
  stats: {
    agentCount: number;
    cacheHits: number;
    durationMs?: number;
    phaseCounts: Record<string, number>;
  };
}

const UNGROUPED = "Other";
const PREVIEW_CHARS = 220;

export function buildRunView(record: RunRecord, entries: WorkflowJournalEntry[]): RunView {
  const agents = entries
    .map(toAgentView)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Seed declared phases first (preserves the pipeline order), then bucket each agent; any phase an
  // agent references that wasn't declared — or no phase at all — lands in an appended group.
  const byPhase = new Map<string, AgentView[]>();
  for (const title of record.phases ?? []) byPhase.set(title, []);
  for (const agent of agents) {
    const phase = agent.phase ?? UNGROUPED;
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push(agent);
  }

  const phases: PhaseView[] = [];
  const phaseCounts: Record<string, number> = {};
  for (const [title, list] of byPhase) {
    if (list.length === 0) continue; // declared-but-empty phases still show in the pipeline via record.phases
    phases.push({ title, agents: list });
    phaseCounts[title] = list.length;
  }

  return {
    phases,
    agents,
    stats: {
      agentCount: record.agentCount ?? agents.length,
      cacheHits: record.cacheHits ?? 0,
      ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
      phaseCounts,
    },
  };
}

function toAgentView(entry: WorkflowJournalEntry): AgentView {
  return {
    key: entry.key,
    label: entry.options.label ?? "agent",
    ...(entry.options.phase ? { phase: entry.options.phase } : {}),
    createdAt: entry.createdAt,
    status: deriveStatus(entry.result),
    resultPreview: preview(entry.result),
    hasSchema: Boolean(entry.options.schema),
    hasSession: Boolean(entry.sessionId),
    ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
  };
}

/** Generic status: adversarial-verifier results carry `refuted`; everything else is just "ok". */
function deriveStatus(result: unknown): AgentStatus {
  if (result && typeof result === "object" && "refuted" in result) {
    return (result as { refuted: unknown }).refuted === true ? "killed" : "confirmed";
  }
  return "ok";
}

function preview(result: unknown): string {
  const text = typeof result === "string" ? result : safeStringify(result);
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_CHARS ? `${collapsed.slice(0, PREVIEW_CHARS)}…` : collapsed;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Reads every journal entry for a run from `<journalDir>/<runId>/*.json`. */
export async function readJournalEntries(journalDir: string, runId: string): Promise<WorkflowJournalEntry[]> {
  const dir = path.join(journalDir, runId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const entries: WorkflowJournalEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      entries.push(JSON.parse(await readFile(path.join(dir, file), "utf8")) as WorkflowJournalEntry);
    } catch {
      // skip unreadable entry
    }
  }
  return entries;
}
