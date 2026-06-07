import assert from "node:assert/strict";
import test from "node:test";
import { ProgressRenderer } from "../src/cli/progress.js";
import type { WorkflowProgressEvent } from "../src/types.js";

function capture() {
  const chunks: string[] = [];
  const stream = { isTTY: false, write: (s: string) => (chunks.push(s), true) } as unknown as NodeJS.WriteStream;
  return { stream, headers: () => chunks.join("").split("\n").filter((l) => l.startsWith("▸ ")).map((l) => l.slice(2)) };
}

test("phase header advances from agent {phase} options (set inside parallel/pipeline), once each in order", () => {
  const cap = capture();
  const r = new ProgressRenderer("plain", cap.stream);
  const ev = (e: WorkflowProgressEvent) => r.handle(e);

  // Mirrors deep-research: phase() for Scope/Verify, but Search/Fetch carried on the agent option only.
  ev({ type: "phase", title: "Scope" });
  ev({ type: "agent", label: "scope", phase: "Scope", state: "started" });
  ev({ type: "agent", label: "scope", phase: "Scope", state: "cached" });
  ev({ type: "agent", label: "search:a", phase: "Search", state: "started" });
  ev({ type: "agent", label: "search:a", phase: "Search", state: "cached" });
  ev({ type: "agent", label: "fetch:x", phase: "Fetch", state: "started" });
  ev({ type: "agent", label: "fetch:x", phase: "Fetch", state: "completed" });
  ev({ type: "phase", title: "Verify" });
  ev({ type: "agent", label: "v0", phase: "Verify", state: "started" });

  assert.deepEqual(cap.headers(), ["Scope", "Search", "Fetch", "Verify"]);
});

test("interleaved pipeline phases don't flip-flop the header (each phase headed once)", () => {
  const cap = capture();
  const r = new ProgressRenderer("plain", cap.stream);
  const ev = (e: WorkflowProgressEvent) => r.handle(e);

  // Search and Fetch overlap (pipeline): a fetch starts before later searches finish.
  ev({ type: "agent", label: "search:a", phase: "Search", state: "started" });
  ev({ type: "agent", label: "fetch:a1", phase: "Fetch", state: "started" });
  ev({ type: "agent", label: "search:b", phase: "Search", state: "started" });
  ev({ type: "agent", label: "fetch:b1", phase: "Fetch", state: "started" });

  assert.deepEqual(cap.headers(), ["Search", "Fetch"]); // not Search, Fetch, Search, Fetch
});

test("explicit phase() re-entry still prints each time (loop-style workflows)", () => {
  const cap = capture();
  const r = new ProgressRenderer("plain", cap.stream);
  r.handle({ type: "phase", title: "Iterate" });
  r.handle({ type: "agent", label: "a", phase: "Iterate", state: "cached" }); // seen → no extra header
  r.handle({ type: "phase", title: "Iterate" });

  assert.deepEqual(cap.headers(), ["Iterate", "Iterate"]);
});
