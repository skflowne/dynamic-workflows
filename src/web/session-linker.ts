import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunRecord } from "../run-store.js";
import type { WorkflowJournalEntry } from "../types.js";

/**
 * Links each workflow agent (journal entry) to the Codex rollout file that captured its full
 * session trace under `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`.
 *
 * Two strategies, in order:
 *  1. Exact — newer runs store the Codex `sessionId` (= rollout UUID) on the journal entry; we just
 *     locate the file whose name contains that id.
 *  2. Heuristic — older runs (recorded before sessionId capture) are matched by content: a rollout
 *     created during the run window whose "subagent spawned by a deterministic workflow…" user
 *     message contains the journal entry's prompt. Validated at 104/104 on the deep-research demo.
 *
 * Results are cached per-run at `<linksDir>/<runId>.json` and merged incrementally (so live runs
 * that gain agents over time only match the newcomers).
 */

export interface SessionLink {
  sessionPath: string;
  sessionId?: string;
}

export interface LinkRunOptions {
  sessionsDir?: string;
  linksDir?: string;
  now?: number;
}

const SUBAGENT_MARKER = "subagent spawned by a deterministic workflow";
const WINDOW_BEFORE_MS = 5_000;
const WINDOW_AFTER_MS = 60_000;

export async function linkRun(
  record: RunRecord,
  entries: WorkflowJournalEntry[],
  options: LinkRunOptions = {},
): Promise<Record<string, SessionLink>> {
  const sessionsDir = options.sessionsDir ?? defaultSessionsDir();
  const linksDir = options.linksDir;
  const now = options.now ?? Date.now();

  const cache = linksDir ? await readCache(linksDir, record.runId) : {};
  const missing = entries.filter((e) => !cache[e.key]);
  if (missing.length === 0) return cache;

  const windowStart = record.startedAt - WINDOW_BEFORE_MS;
  const windowEnd = (record.completedAt ?? now) + WINDOW_AFTER_MS;
  const candidates = await collectCandidateSessions(sessionsDir, windowStart, windowEnd, record.startedAt, windowEnd);

  const usedPaths = new Set(Object.values(cache).map((l) => l.sessionPath));
  const result: Record<string, SessionLink> = { ...cache };

  // Pass 1: exact links via stored sessionId.
  for (const entry of missing) {
    if (!entry.sessionId) continue;
    const hit = candidates.find((c) => !usedPaths.has(c.path) && c.path.includes(entry.sessionId as string));
    if (hit) {
      result[entry.key] = { sessionPath: hit.path, sessionId: entry.sessionId };
      usedPaths.add(hit.path);
    }
  }

  // Pass 2: heuristic content match for whatever's left.
  const stillMissing = missing.filter((e) => !result[e.key]);
  if (stillMissing.length > 0) {
    const unmatched = candidates.filter((c) => !usedPaths.has(c.path));
    const infos = await Promise.all(unmatched.map(async (c) => ({ path: c.path, ...(await readSessionInfo(c.path)) })));
    for (const entry of stillMissing) {
      const hit = infos.find((p) => !usedPaths.has(p.path) && p.subagentText !== undefined && p.subagentText.includes(entry.prompt));
      if (hit) {
        result[entry.key] = { sessionPath: hit.path, ...(hit.sessionId ? { sessionId: hit.sessionId } : {}) };
        usedPaths.add(hit.path);
      }
    }
  }

  if (linksDir && Object.keys(result).length > Object.keys(cache).length) {
    await writeCache(linksDir, record.runId, result).catch(() => {});
  }
  return result;
}

/** Convenience: resolve a single agent's session file path (or undefined). */
export async function linkAgent(
  record: RunRecord,
  entries: WorkflowJournalEntry[],
  key: string,
  options: LinkRunOptions = {},
): Promise<SessionLink | undefined> {
  const links = await linkRun(record, entries, options);
  return links[key];
}

export function defaultSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

interface Candidate {
  path: string;
  mtimeMs: number;
}

async function collectCandidateSessions(
  sessionsDir: string,
  windowStart: number,
  windowEnd: number,
  rangeStart: number,
  rangeEnd: number,
): Promise<Candidate[]> {
  const dayDirs = candidateDayDirs(sessionsDir, rangeStart, rangeEnd);
  const out: Candidate[] = [];
  for (const dir of dayDirs) {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.startsWith("rollout-") || !file.endsWith(".jsonl")) continue;
      const full = path.join(dir, file);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(full)).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs >= windowStart && mtimeMs <= windowEnd) out.push({ path: full, mtimeMs });
    }
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

/** Local-date `<dir>/YYYY/MM/DD` directories spanning the run, ±1 day of slack for tz/midnight. */
function candidateDayDirs(sessionsDir: string, rangeStart: number, rangeEnd: number): string[] {
  const dirs = new Set<string>();
  const DAY = 86_400_000;
  for (let t = rangeStart - DAY; t <= rangeEnd + DAY; t += DAY) {
    dirs.add(dayDir(sessionsDir, new Date(t)));
  }
  dirs.add(dayDir(sessionsDir, new Date(rangeEnd + DAY)));
  return [...dirs];
}

function dayDir(sessionsDir: string, d: Date): string {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return path.join(sessionsDir, yyyy, mm, dd);
}

/** Reads a rollout's session id + the subagent user message carrying the workflow prompt. */
async function readSessionInfo(filePath: string): Promise<{ sessionId?: string; subagentText?: string }> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return {};
  }
  let sessionId: string | undefined;
  let subagentText: string | undefined;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let env: Record<string, unknown>;
    try {
      env = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = (env.payload ?? {}) as Record<string, unknown>;
    if (env.type === "session_meta" && typeof payload.id === "string") {
      sessionId = payload.id;
    } else if (env.type === "response_item" && payload.type === "message" && payload.role === "user") {
      const text = extractText(payload.content);
      if (text.includes(SUBAGENT_MARKER)) subagentText = text;
    }
    if (sessionId && subagentText) break;
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(subagentText ? { subagentText } : {}),
  };
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        const e = c as Record<string, unknown>;
        return (e.text as string) ?? (e.input_text as string) ?? "";
      }
      return "";
    })
    .join("");
}

async function readCache(linksDir: string, runId: string): Promise<Record<string, SessionLink>> {
  try {
    const raw = await readFile(cachePath(linksDir, runId), "utf8");
    return JSON.parse(raw) as Record<string, SessionLink>;
  } catch {
    return {};
  }
}

async function writeCache(linksDir: string, runId: string, links: Record<string, SessionLink>): Promise<void> {
  await mkdir(linksDir, { recursive: true });
  await writeFile(cachePath(linksDir, runId), JSON.stringify(links, null, 2), "utf8");
}

function cachePath(linksDir: string, runId: string): string {
  return path.join(linksDir, `${runId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}
