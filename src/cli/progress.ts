import type { WorkflowProgressEvent } from "../types.js";

export type ProgressMode = "pretty" | "plain" | "silent";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

/**
 * Streams workflow progress to a stream (stderr by default). On a TTY it keeps a single transient
 * "running …" status line at the bottom and prints permanent lines above it; otherwise it falls
 * back to plain prefixed lines. `silent` suppresses everything (used with `--json`).
 */
export class ProgressRenderer {
  private running = 0;
  private completed = 0;
  private failed = 0;
  private statusActive = false;
  private readonly color: boolean;

  constructor(
    private readonly mode: ProgressMode,
    private readonly stream: NodeJS.WriteStream = process.stderr,
  ) {
    this.color = mode === "pretty" && stream.isTTY === true && !process.env.NO_COLOR;
  }

  handle = (event: WorkflowProgressEvent): void => {
    if (this.mode === "silent") return;
    switch (event.type) {
      case "phase":
        this.print("");
        this.print(this.paint(`▸ ${event.title}`, "bold"));
        break;
      case "log":
        this.print(this.paint(`  ${event.message}`, "dim"));
        break;
      case "agent":
        this.handleAgent(event);
        break;
    }
  };

  private handleAgent(event: Extract<WorkflowProgressEvent, { type: "agent" }>): void {
    if (event.state === "started") {
      this.running++;
      this.renderStatus(event.label);
      return;
    }

    if (this.running > 0) this.running--;
    if (event.state === "failed") {
      this.failed++;
      this.print(`  ${this.paint("✗", "red")} ${event.label}${event.error ? this.paint(` — ${event.error}`, "dim") : ""}`);
    } else if (event.state === "cached") {
      this.completed++;
      this.print(`  ${this.paint("◆", "cyan")} ${event.label} ${this.paint("(cached)", "dim")}`);
    } else {
      this.completed++;
      this.print(`  ${this.paint("✓", "green")} ${event.label}`);
    }
    this.renderStatus();
  }

  /** Clears the transient status line so a final result can be printed cleanly. */
  finish(): void {
    this.clearStatus();
  }

  private renderStatus(current?: string): void {
    if (!this.color) return; // Only the TTY pretty mode shows a transient line.
    if (this.running <= 0) {
      this.clearStatus();
      return;
    }
    const label = current ? `: ${current}` : "";
    this.stream.write(`\r\x1b[K${ANSI.dim}⟳ running ${this.running} agent(s)${label}${ANSI.reset}`);
    this.statusActive = true;
  }

  private clearStatus(): void {
    if (this.statusActive) {
      this.stream.write("\r\x1b[K");
      this.statusActive = false;
    }
  }

  private print(line: string): void {
    if (this.statusActive) this.stream.write("\r\x1b[K");
    this.stream.write(`${line}\n`);
    this.statusActive = false;
    this.renderStatus();
  }

  private paint(text: string, style: keyof typeof ANSI): string {
    if (!this.color) return text;
    return `${ANSI[style]}${text}${ANSI.reset}`;
  }
}
