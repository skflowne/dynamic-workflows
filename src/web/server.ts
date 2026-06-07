import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileRunStore } from "../run-store.js";
import { buildRunView, readJournalEntries } from "./run-aggregator.js";
import { linkRun } from "./session-linker.js";
import { parseCodexSessionFile } from "./session-parser.js";

/**
 * Zero-dependency HTTP server for the workflow viewer. Serves the static SPA from `web/`, a JSON API
 * over the run-store + journal + linked Codex sessions, a global SSE stream for liveness, and an
 * `/api/ingest` endpoint the `run` process posts progress events to. Binds 127.0.0.1 only.
 */

export interface WebServerOptions {
  /** Runtime data root (runs/journal/links). Defaults to `<cwd>/.codex-workflow` when only `cwd` is given. */
  dataDir?: string;
  cwd?: string;
  version?: string;
  sessionsDir?: string;
  webDir?: string;
}

interface LiveEvent {
  runId: string;
  [key: string]: unknown;
}

const MAX_BUFFER = 2000;

export interface WorkflowWebServer {
  server: http.Server;
  listen(port: number, host?: string): Promise<{ port: number; url: string }>;
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

  const broadcast = (event: LiveEvent) => {
    const buffer = buffers.get(event.runId) ?? [];
    buffer.push(event);
    if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
    buffers.set(event.runId, buffer);
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) res.write(data);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);

    if (req.method === "POST" && url.pathname === "/api/ingest") {
      const body = await readBody(req);
      try {
        const parsed = JSON.parse(body) as LiveEvent;
        if (parsed && typeof parsed.runId === "string") broadcast(parsed);
      } catch {
        // ignore malformed ingest — liveness is best-effort
      }
      res.writeHead(204).end();
      return;
    }

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
    listen(port: number, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          const actual = typeof addr === "object" && addr ? addr.port : port;
          resolve({ port: actual, url: `http://${host}:${actual}` });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
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

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8_000_000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}
