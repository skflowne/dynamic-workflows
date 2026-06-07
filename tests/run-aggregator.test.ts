import assert from "node:assert/strict";
import test from "node:test";
import { buildRunView } from "../src/web/run-aggregator.js";
import type { RunRecord } from "../src/run-store.js";
import type { WorkflowJournalEntry } from "../src/types.js";

function entry(partial: Partial<WorkflowJournalEntry> & { key: string }): WorkflowJournalEntry {
  return {
    runId: "wf_test",
    prompt: "p",
    options: {},
    result: {},
    createdAt: 0,
    ...partial,
  };
}

const RECORD: RunRecord = {
  runId: "wf_test",
  name: "demo",
  status: "completed",
  source: "named",
  startedAt: 1000,
  durationMs: 5000,
  agentCount: 4,
  cacheHits: 1,
  phases: ["Scope", "Verify", "Synthesize"],
};

test("buildRunView groups agents by phase in declared order, then appends extras", () => {
  const entries: WorkflowJournalEntry[] = [
    entry({ key: "a", createdAt: 3, options: { label: "synth", phase: "Synthesize" }, result: "report text" }),
    entry({ key: "b", createdAt: 1, options: { label: "scope", phase: "Scope", schema: { type: "object" } }, result: { angles: 5 } }),
    entry({ key: "c", createdAt: 2, options: { label: "v0", phase: "Verify" }, result: { refuted: false, evidence: "ok" } }),
    entry({ key: "d", createdAt: 4, options: { label: "fetch", phase: "Fetch" }, result: { url: "x" }, sessionId: "sess-d" }),
  ];

  const view = buildRunView(RECORD, entries);

  // Declared phases keep order; the undeclared "Fetch" phase is appended after.
  assert.deepEqual(view.phases.map((p) => p.title), ["Scope", "Verify", "Synthesize", "Fetch"]);
  assert.deepEqual(view.stats.phaseCounts, { Scope: 1, Verify: 1, Synthesize: 1, Fetch: 1 });

  // Flat agent list is createdAt-ordered.
  assert.deepEqual(view.agents.map((a) => a.key), ["b", "c", "a", "d"]);

  const verify = view.phases.find((p) => p.title === "Verify")?.agents[0];
  assert.ok(verify);
  assert.equal(verify.status, "confirmed"); // refuted:false -> confirmed

  const fetch = view.phases.find((p) => p.title === "Fetch")?.agents[0];
  assert.ok(fetch);
  assert.equal(fetch.hasSession, true);
  assert.equal(fetch.sessionId, "sess-d");

  const scope = view.phases.find((p) => p.title === "Scope")?.agents[0];
  assert.ok(scope);
  assert.equal(scope.hasSchema, true);
});

test("buildRunView orders by declaredPhases and pre-renders empty declared phases", () => {
  // The script only called phase() for Scope/Verify/Synthesize; Search & Fetch were set via agent
  // `phase:` options, so record.phases is misordered. declaredPhases (meta.phases) is authoritative.
  const record: RunRecord = {
    ...RECORD,
    declaredPhases: ["Scope", "Search", "Fetch", "Verify", "Synthesize"],
    phases: ["Scope", "Verify", "Synthesize"],
  };
  const entries = [
    entry({ key: "scope", createdAt: 1, options: { label: "scope", phase: "Scope" } }),
    entry({ key: "search", createdAt: 2, options: { label: "search", phase: "Search" } }),
    entry({ key: "fetch", createdAt: 3, options: { label: "fetch", phase: "Fetch" } }),
    entry({ key: "verify", createdAt: 4, options: { label: "v0", phase: "Verify" } }),
    // Synthesize intentionally has no agent yet — declared-but-empty must still render (pending).
  ];

  const view = buildRunView(record, entries);

  assert.deepEqual(view.phases.map((p) => p.title), ["Scope", "Search", "Fetch", "Verify", "Synthesize"]);
  assert.equal(view.phases.find((p) => p.title === "Synthesize")?.agents.length, 0);
  assert.equal(view.stats.phaseCounts.Synthesize, 0);
});

test("buildRunView derives killed status and result previews", () => {
  const entries = [
    entry({ key: "k", options: { label: "killer", phase: "Verify" }, result: { refuted: true, evidence: "contradicted" } }),
  ];
  const view = buildRunView({ ...RECORD, phases: ["Verify"] }, entries);
  const a = view.agents[0];
  assert.ok(a);
  assert.equal(a.status, "killed");
  assert.ok(a.resultPreview.includes("refuted"));
});
