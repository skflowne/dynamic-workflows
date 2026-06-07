import { spawn } from "node:child_process";
import net from "node:net";

/**
 * Small helpers for the viewer: pick a free TCP port and open a URL in the default browser. The
 * viewer itself runs in-process (see `cli/commands.ts`) — `run` binds an OS-assigned random port and
 * `serve` prefers {@link PREFERRED_PORT}; there is no detached daemon or `web.json` state file.
 */

const PREFERRED_PORT = 4173;

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
