import { createReadStream, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileRunStore, type RunRecord } from "../run-store.js";
import { runEventsPath } from "./event-log.js";
import { buildRunView, readJournalEntries } from "./run-aggregator.js";
import { linkRun } from "./session-linker.js";
import { parseCodexSessionFile } from "./session-parser.js";

/**
 * Zero-dependency HTTP server for the workflow viewer. Serves the static SPA from `web/`, a JSON API
 * over the run-store + journal + linked Codex sessions, and a global SSE stream for liveness.
 *
 * Liveness flows through a single transport: a run's events are appended to `runs/<id>.events.jsonl`
 * (the cross-process bus) by the `run` command, and every server — the in-process one started by
 * `run` AND a standalone `serve` — tails that file via {@link FSWatcher} and fans events to its SSE
 * subscribers. There is no in-memory shortcut: a `run` viewer tails its own file, `serve` tails
 * everyone's, identical code. {@link WorkflowWebServer.broadcast} is retained for programmatic/test
 * use. Binds 127.0.0.1 only.
 */

const EVENTS_SUFFIX = ".events.jsonl";
/** A terminal-record orphan events file older than this is reaped on server start (hard-kill leftovers). */
const ORPHAN_GRACE_MS = 60_000;
/**
 * Poll backstop interval. `fs.watch` is the snappy path, but it's unreliable for content appends on
 * some platforms (notably macOS), so a low-frequency rescan guarantees delivery — keeping the file
 * transport as live as the old in-memory broadcast. Cheap: one readdir + a few small reads per tick.
 */
const POLL_MS = 300;

export interface WebServerOptions {
  /** Runtime data root (runs/journal/links). Defaults to `<cwd>/.codex-workflow` when only `cwd` is given. */
  dataDir?: string;
  cwd?: string;
  version?: string;
  sessionsDir?: string;
  webDir?: string;
}

export interface LiveEvent {
  runId: string;
  [key: string]: unknown;
}

const MAX_BUFFER = 2000;

export interface WorkflowWebServer {
  server: http.Server;
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
  /** Push a live event into the in-memory buffer + every SSE subscriber. Mainly for tests/programmatic use. */
  broadcast(event: LiveEvent): void;
  /**
   * Synchronously read a run's events file to EOF and ingest any unseen lines, so this server's buffer
   * and SSE clients are guaranteed complete before the file is deleted. The `run` command calls this
   * (in-process) after closing the events stream and before unlinking it, making completion delivery
   * independent of {@link FSWatcher} timing. No-op if the file is absent.
   */
  drainRun(runId: string): Promise<void>;
  close(): Promise<void>;
}

export function createWebServer(options: WebServerOptions): WorkflowWebServer {
  const base = options.dataDir
    ? path.resolve(options.dataDir)
    : path.join(path.resolve(options.cwd ?? process.cwd()), ".codex-workflow");
  const runsDir = path.join(base, "runs");
  const journalDir = path.join(base, "journal");
  const linksDir = path.join(base, "links");
  const webDir = options.webDir ?? resolveWebDir();
  const store = new FileRunStore(runsDir);

  // In-memory liveness: per-run event buffers (for replay) + global SSE subscribers.
  const buffers = new Map<string, LiveEvent[]>();
  const subscribers = new Set<http.ServerResponse>();

  // Fan one event into the replay buffer + every live SSE subscriber. Used by both the file tailer
  // (the normal path) and the public broadcast() (tests/programmatic).
  const ingest = (event: LiveEvent) => {
    const buffer = buffers.get(event.runId) ?? [];
    buffer.push(event);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    buffers.set(event.runId, buffer);
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) res.write(data);
  };

  // ---- File tailer: the single liveness transport (see header). ----
  const offsets = new Map<string, number>(); // events file -> bytes consumed
  const partials = new Map<string, string>(); // events file -> trailing partial line
  const chains = new Map<string, Promise<void>>(); // per-file read serializer (avoids watch/drain races)
  let watcher: FSWatcher | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  // Serialize all reads of one file through a promise chain so a watch-triggered tail and a drainRun()
  // never read overlapping ranges or fight over the offset cursor.
  const schedule = (filePath: string, task: () => Promise<void>): Promise<void> => {
    const next = (chains.get(filePath) ?? Promise.resolve()).then(task, task);
    chains.set(filePath, next.catch(() => {}));
    return next;
  };

  // Read newly-appended bytes of an events file and ingest each complete JSONL line. Tolerates a
  // truncated/rotated file (resets) and a missing file (drops its cursor state).
  const readNew = async (filePath: string): Promise<void> => {
    let handle;
    try {
      handle = await open(filePath, "r");
    } catch {
      offsets.delete(filePath);
      partials.delete(filePath);
      return;
    }
    try {
      const { size } = await handle.stat();
      let start = offsets.get(filePath) ?? 0;
      if (size < start) {
        start = 0;
        partials.delete(filePath);
      }
      if (size <= start) {
        offsets.set(filePath, size);
        return;
      }
      const buffer = Buffer.allocUnsafe(size - start);
      await handle.read(buffer, 0, size - start, start);
      offsets.set(filePath, size);
      const text = (partials.get(filePath) ?? "") + buffer.toString("utf8");
      const lastNewline = text.lastIndexOf("\n");
      if (lastNewline < 0) {
        partials.set(filePath, text);
        return;
      }
      partials.set(filePath, text.slice(lastNewline + 1));
      for (const line of text.slice(0, lastNewline).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          ingest(JSON.parse(trimmed) as LiveEvent);
        } catch {
          // Skip an unparseable / partially-written line.
        }
      }
    } finally {
      await handle.close();
    }
  };

  // Catch up a run's events file (used at server start for in-progress runs, and after `serve` first
  // sees a new file). Terminal-record orphans older than the grace are reaped instead of tailed.
  const tailFile = (filePath: string): Promise<void> => schedule(filePath, () => readNew(filePath));

  async function scanExisting(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(runsDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(EVENTS_SUFFIX)) continue;
      const filePath = path.join(runsDir, name);
      const recordPath = path.join(runsDir, `${name.slice(0, -EVENTS_SUFFIX.length)}.json`);
      const record = await readRecord(recordPath);
      if (record && record.status !== "running") {
        await reapOrphan(filePath);
        continue;
      }
      await tailFile(filePath);
    }
  }

  async function reapOrphan(filePath: string): Promise<void> {
    try {
      const { mtimeMs } = await stat(filePath);
      if (Date.now() - mtimeMs < ORPHAN_GRACE_MS) return; // a sibling process may still be tailing it
      await unlink(filePath);
      offsets.delete(filePath);
      partials.delete(filePath);
    } catch {
      // best-effort cleanup
    }
  }

  async function readRecord(recordPath: string): Promise<RunRecord | undefined> {
    try {
      return JSON.parse(await readFile(recordPath, "utf8")) as RunRecord;
    } catch {
      return undefined;
    }
  }

  async function startTailer(): Promise<void> {
    try {
      await mkdir(runsDir, { recursive: true });
    } catch {
      // ignore — readdir below will just find nothing
    }
    await scanExisting();
    try {
      watcher = watch(runsDir, (_event, filename) => {
        if (!filename) {
          void scanExisting();
          return;
        }
        const name = filename.toString();
        if (name.endsWith(EVENTS_SUFFIX)) void tailFile(path.join(runsDir, name));
      });
      watcher.on("error", () => {
        /* watch errors are non-fatal; the poll backstop below covers gaps */
      });
    } catch {
      // Platform without fs.watch: the poll backstop alone keeps things live.
    }
    // Poll backstop: re-scan on a timer so content appends are always picked up even when fs.watch
    // doesn't fire for them (held-open writers / macOS). Re-reads go through the same per-file
    // serializer as the watcher, so there's no double-ingest.
    pollTimer = setInterval(() => void scanExisting(), POLL_MS);
    if (typeof pollTimer.unref === "function") pollTimer.unref();
  }

  const broadcast = ingest;

  const drainRun = async (runId: string): Promise<void> => {
    const filePath = runEventsPath(base, runId);
    await schedule(filePath, async () => {
      // Loop until the offset stops advancing — the producer has already closed the stream, so this
      // reaches a stable EOF in one or two passes.
      let previous = -1;
      for (;;) {
        await readNew(filePath);
        const current = offsets.get(filePath) ?? 0;
        if (current === previous) break;
        previous = current;
      }
    });
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }

    // ---- API ----
    if (segments[0] === "api") {
      if (segments[1] === "health") {
        sendJson(res, 200, { ok: true, version: options.version ?? "0.0.0" });
        return;
      }
      if (url.pathname === "/api/stream") {
        openStream(res);
        return;
      }
      if (segments[1] === "runs" && segments.length === 2) {
        sendJson(res, 200, await store.list());
        return;
      }
      if (segments[1] === "runs" && segments.length >= 3) {
        const runId = decodeURIComponent(segments[2] as string);
        await handleRunRoute(runId, segments.slice(3), res);
        return;
      }
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // ---- Static SPA ----
    await serveStatic(url.pathname, res, webDir);
  }

  async function handleRunRoute(runId: string, rest: string[], res: http.ServerResponse): Promise<void> {
    const record = await store.get(runId);
    if (!record) {
      sendJson(res, 404, { error: `run ${runId} not found` });
      return;
    }
    const entries = await readJournalEntries(journalDir, runId);

    // GET /api/runs/:id
    if (rest.length === 0) {
      sendJson(res, 200, { record, view: buildRunView(record, entries), live: buffers.get(runId) ?? [] });
      return;
    }
    // GET /api/runs/:id/events
    if (rest.length === 1 && rest[0] === "events") {
      sendJson(res, 200, buffers.get(runId) ?? []);
      return;
    }
    // GET /api/runs/:id/agents/:key[/session]
    if (rest[0] === "agents" && rest[1]) {
      const key = decodeURIComponent(rest[1]);
      const entry = entries.find((e) => e.key === key);
      if (!entry) {
        sendJson(res, 404, { error: "agent not found" });
        return;
      }
      if (rest[2] === "session") {
        const links = await linkRun(record, entries, { linksDir, ...(options.sessionsDir ? { sessionsDir: options.sessionsDir } : {}) });
        const link = links[key];
        if (!link) {
          sendJson(res, 404, { error: "no linked Codex session for this agent" });
          return;
        }
        try {
          const session = await parseCodexSessionFile(link.sessionPath);
          sendJson(res, 200, { sessionPath: link.sessionPath, ...session });
        } catch (error) {
          sendJson(res, 404, { error: `could not read session: ${error instanceof Error ? error.message : String(error)}` });
        }
        return;
      }
      sendJson(res, 200, entry);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  function openStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(": connected\n\n");
    subscribers.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
      clearInterval(ping);
      subscribers.delete(res);
    });
  }

  return {
    server,
    async listen(port: number, host = "127.0.0.1") {
      const bound = await new Promise<{ port: number; url: string }>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const actual = typeof addr === "object" && addr ? addr.port : port;
          resolve({ port: actual, url: `http://${host}:${actual}` });
        });
      });
      await startTailer();
      return bound;
    },
    broadcast,
    drainRun,
    close() {
      return new Promise((resolve) => {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = undefined;
        watcher?.close();
        watcher = undefined;
        for (const res of subscribers) res.end();
        subscribers.clear();
        server.close(() => resolve());
      });
    },
  };
}

function resolveWebDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/web/server.js -> ../../web ; src/web/server.ts (tsx) -> ../../web ; both = <project>/web
  return path.resolve(here, "..", "..", "web");
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string, res: http.ServerResponse, webDir: string): Promise<void> {
  const requested = pathname === "/" ? "/index.html" : pathname;
  // Resolve safely within webDir; non-asset paths (e.g. /runs/:id deep links) fall back to the SPA.
  const candidate = path.normalize(path.join(webDir, requested));
  const isInside = candidate === webDir || candidate.startsWith(webDir + path.sep);
  const target = isInside && (await isFile(candidate)) ? candidate : path.join(webDir, "index.html");

  if (!(await isFile(target))) {
    sendJson(res, 404, { error: "web assets not built" });
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
    "cache-control": "no-cache",
  });
  createReadStream(target).pipe(res);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
