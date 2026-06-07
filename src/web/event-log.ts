import { appendFile, mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { sanitizeRunId } from "../run-store.js";
import type { LiveEvent } from "./server.js";

/**
 * Producer-side writer for a run's live-event log — the cross-process event bus that lets a separate
 * `serve` process (or any second viewer) tail a run's progress without an in-memory channel. The
 * `run` command appends every progress/run-meta/run-finished event here as JSONL; a server's file
 * tailer ({@link createWebServer}) reads it and fans events to its SSE subscribers.
 *
 * Each event is written with a discrete `appendFile` (open → append → close), NOT a long-lived
 * append stream: a held-open fd's writes do NOT fire `fs.watch` content notifications on macOS, so
 * the in-process viewer (which tails its own file) would never see live updates. Discrete appends
 * notify watchers reliably and flush each line in full. Writes are serialized through a promise chain
 * to preserve order under rapid bursts.
 *
 * The file is transient: it is deleted once the run finishes (its durable content — the final result,
 * stats, and failure detail — is promoted into the run record). All operations are best-effort so a
 * filesystem hiccup can never break the run itself.
 */

/** Path of a run's live-events file, paired with its record by basename (`<id>.events.jsonl`). */
export function runEventsPath(dataDir: string, runId: string): string {
  return path.join(dataDir, "runs", `${sanitizeRunId(runId)}.events.jsonl`);
}

export class RunEventLog {
  private queue: Promise<void> = Promise.resolve();
  private opened = false;
  private broken = false;

  constructor(private readonly filePath: string) {}

  /** Creates (truncating any stale leftover) the events file. Silently degrades to a no-op on failure. */
  async open(): Promise<void> {
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, ""); // fresh file even on a same-id re-run (resume)
      this.opened = true;
    } catch {
      this.broken = true;
    }
  }

  /** Appends one event as a JSONL line. Order-preserving (serialized); never throws. */
  append(event: LiveEvent): void {
    if (!this.opened || this.broken) return;
    const line = `${JSON.stringify(event)}\n`;
    this.queue = this.queue
      .then(() => appendFile(this.filePath, line))
      .catch(() => {
        this.broken = true;
      });
  }

  /** Resolves once every queued append has been flushed (so a consumer can drain a complete file). */
  async close(): Promise<void> {
    await this.queue.catch(() => {});
  }

  /** Deletes the file. Call after {@link close} and after any in-process server has drained it. */
  async remove(): Promise<void> {
    try {
      await unlink(this.filePath);
    } catch {
      // Already gone, or never created — nothing to clean up.
    }
  }
}
