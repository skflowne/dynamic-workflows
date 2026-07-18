import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { sanitizeRunId, type RunRecord } from "../run-store.js";
import type { AgentFailure, WorkflowJournalEntry } from "../types.js";

/**
 * Turns a {@link RunRecord} + its journal entries into the shape the web overview renders: agents
 * grouped under the run's declared phases, a flat agent list ordered by creation, and roll-up stats.
 * Pure and synchronous so it's trivially unit-testable; the I/O lives in {@link readJournalEntries}.
 */

export type AgentStatus = "confirmed" | "killed" | "ok" | "failed";

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
  const journalAgents = entries.map(toAgentView);
  // Failed agents are not journaled (so --resume re-attempts them); fold their detail in from the
  // record so the flow shows them as historical "failed" nodes. Skip any whose key is somehow already
  // present, and order by ordinal-after-start so they interleave roughly when they happened.
  const seen = new Set(journalAgents.map((a) => a.key));
  const failureAgents = (record.failures ?? [])
    .filter((failure) => !seen.has(failure.key))
    .map((failure) => failureToAgentView(failure, record.startedAt));
  const agents = [...journalAgents, ...failureAgents].sort((a, b) => a.createdAt - b.createdAt);

  // Seed the declared pipeline first so phases render in their authoritative meta.phases order — NOT
  // the order phase() happened to be called (a workflow may set a phase via an agent's `phase:` option
  // without ever calling phase(), which would otherwise sort it last). Prefer the declared pipeline;
  // fall back to the executed-phase list for older records. Then bucket each agent; any phase an agent
  // references that wasn't declared lands in an appended group.
  const declared = record.declaredPhases ?? record.phases ?? [];
  const declaredSet = new Set(declared);
  const byPhase = new Map<string, AgentView[]>();
  for (const title of declared) byPhase.set(title, []);
  for (const agent of agents) {
    const phase = agent.phase ?? UNGROUPED;
    if (!byPhase.has(phase)) byPhase.set(phase, []);
    byPhase.get(phase)!.push(agent);
  }

  const phases: PhaseView[] = [];
  const phaseCounts: Record<string, number> = {};
  for (const [title, list] of byPhase) {
    // Keep declared phases even when empty so the pipeline pre-renders them (pending); drop only
    // undeclared phases that ended up with no agents.
    if (list.length === 0 && !declaredSet.has(title)) continue;
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

function failureToAgentView(failure: AgentFailure, startedAt: number): AgentView {
  return {
    key: failure.key,
    label: failure.label,
    ...(failure.phase ? { phase: failure.phase } : {}),
    // No real timestamp (failures aren't journaled); derive an ordering key from the 1-based ordinal.
    createdAt: (startedAt ?? 0) + failure.index,
    status: "failed",
    resultPreview: preview(failure.error),
    hasSchema: false,
    hasSession: false,
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

// Journal files are immutable once written (a fresh run/agent always gets a fresh key), so per-run
// parsed entries are cached by filename and only re-read when a new file shows up. Keyed by the
// resolved directory (already unique per journalDir+runId) so distinct data dirs never collide.
const journalFileCache = new Map<string, Map<string, WorkflowJournalEntry>>();

/** Reads every journal entry for a run from `<journalDir>/<runId>/*.json`. */
export async function readJournalEntries(journalDir: string, runId: string): Promise<WorkflowJournalEntry[]> {
  const dir = path.join(journalDir, sanitizeRunId(runId));
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  let cache = journalFileCache.get(dir);
  if (!cache) {
    cache = new Map();
    journalFileCache.set(dir, cache);
  }
  const jsonFiles = new Set(files.filter((file) => file.endsWith(".json")));
  // Drop cached entries for files that no longer exist (rare, but keeps the cache from growing stale).
  for (const cachedFile of cache.keys()) {
    if (!jsonFiles.has(cachedFile)) cache.delete(cachedFile);
  }
  for (const file of jsonFiles) {
    if (cache.has(file)) continue;
    try {
      cache.set(file, JSON.parse(await readFile(path.join(dir, file), "utf8")) as WorkflowJournalEntry);
    } catch {
      // skip unreadable entry — left uncached so the next call retries it
    }
  }
  return [...cache.values()];
}
