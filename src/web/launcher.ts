import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";

/**
 * Lifecycle for the detached background viewer server. The `run` command calls
 * {@link ensureBackgroundServer}: if a healthy server is already recorded in
 * `.codex-workflow/web.json` it's reused, otherwise a free port is chosen and a detached
 * `codex-workflow serve --daemon` child is spawned and waited on until it answers `/api/health`.
 */

export interface ServerState {
  pid: number;
  port: number;
  url: string;
  startedAt: number;
}

const PREFERRED_PORT = 4173;

export function serverStatePath(dataDir: string): string {
  return path.join(dataDir, "web.json");
}

export async function readServerState(dataDir: string): Promise<ServerState | undefined> {
  try {
    return JSON.parse(await readFile(serverStatePath(dataDir), "utf8")) as ServerState;
  } catch {
    return undefined;
  }
}

export async function writeServerState(dataDir: string, state: ServerState): Promise<void> {
  await mkdir(path.dirname(serverStatePath(dataDir)), { recursive: true });
  await writeFile(serverStatePath(dataDir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function clearServerState(dataDir: string): Promise<void> {
  await rm(serverStatePath(dataDir), { force: true }).catch(() => {});
}

export async function healthCheck(url: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/health`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

/** Returns a live viewer URL, reusing an existing healthy server or spawning a detached one. */
export async function ensureBackgroundServer(
  dataDir: string,
  options: { cliEntry?: string } = {},
): Promise<{ url: string; port: number; reused: boolean }> {
  const existing = await readServerState(dataDir);
  if (existing && (await healthCheck(existing.url))) {
    return { url: existing.url, port: existing.port, reused: true };
  }

  const port = await pickPort();
  const cliEntry = options.cliEntry ?? process.argv[1];
  if (!cliEntry) throw new Error("cannot determine CLI entry point to spawn the viewer server");
  // The detached `serve --daemon` resolves the (global) data dir itself, so it serves the same store.
  const child = spawn(process.execPath, [cliEntry, "serve", "--port", String(port), "--daemon"], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();

  const url = `http://127.0.0.1:${port}`;
  const ready = await waitForHealth(url, 10_000);
  if (!ready) throw new Error(`viewer server did not start on ${url}`);
  return { url, port, reused: false };
}

async function waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthCheck(url, 800)) return true;
    await delay(150);
  }
  return false;
}

/** Prefer 4173; fall back to an OS-assigned free port if it's taken. */
export async function pickPort(preferred = PREFERRED_PORT): Promise<number> {
  if (await isPortFree(preferred)) return preferred;
  return freePort();
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fire-and-forget POST of a live progress event to a running viewer (never throws). */
export function postIngest(url: string, payload: unknown): void {
  try {
    const body = JSON.stringify(payload);
    const req = http.request(`${url}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
    });
    req.on("error", () => {});
    req.setTimeout(1000, () => req.destroy());
    req.end(body);
  } catch {
    // best-effort: a missing/slow viewer must never break a run
  }
}

/** Best-effort cross-platform "open this URL in the default browser". */
export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  } catch {
    // ignore — opening a browser is a convenience, not a requirement
  }
}
