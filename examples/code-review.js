/**
 * Claude Code — built-in (HIDDEN) "code-review" Workflow  —  SOURCE
 * =================================================================
 *
 * WHAT THIS IS
 *   The fan-out engine behind the `/code-review` skill when it runs at
 *   high / xhigh / max effort. Registered as a HIDDEN bundled workflow
 *   (name: "code-review", hidden: true) — you never invoke it directly;
 *   the skill launches it via Workflow({ name: "code-review", args: "<level> [target]" }).
 *   Structure: Scope -> pipeline(per-angle Find -> dedup -> Verify) -> Sweep -> Synthesize.
 *
 * LINEAGE  ("bughunter")
 *   Internally this family is called "bughunter" — Anthropic's automated PR
 *   reviewer. The deep-research workflow's own comment says it was
 *   "Ported from bughunter architecture" (git/grep swapped for WebSearch/WebFetch),
 *   so code-review and deep-research are siblings of the same find->verify->synthesize
 *   pattern. NOTE: there is NO standalone "bughunter" workflow in the client binary.
 *   `initBundledWorkflows()` registers exactly two workflows: code-review + deep-research.
 *   The real "bughunter" that auto-reviews monorepo PRs runs SERVER-SIDE and is not
 *   shipped in the client; this `code-review` workflow IS its local form (both read the
 *   same Statsig config key `tengu_review_bughunter_config`, cost ~$10-20, ~10-20 min).
 *
 * WHERE IT CAME FROM
 *   Not a user-editable file. Compiled into the Claude Code native executable and
 *   registered at runtime by initBundledWorkflows() -> osO() -> { T0K()=deep-research, eWK()=code-review }.
 *   Extracted from:
 *     ~/.local/share/claude/versions/2.1.162   (Mach-O 64-bit arm64 executable)
 *   at byte offset ~205,764,069–205,776,662, by carving that range, stripping NUL
 *   padding, and decoding the embedded \uXXXX escapes. The `meta` block (name /
 *   description / whenToUse / phases) was substituted from its string constants
 *   (DrH / aWK / sWK / tWK). Claude Code version: 2.1.162.
 *
 * ── SUPPLEMENTARY NOTES ─────────────────────────────────────────────────────
 *
 * 1) EFFORT PARAMETERIZATION (see LEVEL_PARAMS below)
 *    A single `level` arg scales the entire fan-out — same engine, different breadth:
 *
 *      level   correctnessAngles  perAngle  maxFindings  sweep
 *      ─────   ─────────────────  ────────  ───────────  ─────
 *      high          3               6          10        off
 *      xhigh         5               8          15        on
 *      max           5               8          15        on   (differs only in API
 *                                                                reasoning effort, NOT
 *                                                                in the fan-out shape)
 *
 *    Total finders = correctnessAngles + 4 cleanup angles (reuse / simplification /
 *    efficiency / altitude). So "high" = 7 finders, "xhigh"/"max" = 9 finders + sweep.
 *
 * 2) SWEEP PHASE  (xhigh / max only — code-review has it, deep-research does not)
 *    After the main find->verify pass, one FRESH finder is given the list of
 *    already-found candidates and told to hunt ONLY for gaps the first pass missed.
 *    A deliberate "catch the tail" mechanism; returns empty rather than padding.
 *
 * 3) PIPELINE WITH NO BARRIER  (Find -> dedup -> Verify)
 *    Finders stream into verification as they complete — a finder's candidates are
 *    deduped (file + line-bucketed via dedupKey) against a shared `seen` Map and
 *    verified immediately, while other finders are still running. `verifySlots`
 *    (MAX_VERIFY = 25) is a hard budget; overflow candidates are recorded in
 *    `budgetDropped`, never silently lost.
 *
 * 4) ONE VERIFIER PER CANDIDATE (vs deep-research's 3-vote panel)
 *    Each candidate gets a single independent verifier returning CONFIRMED /
 *    PLAUSIBLE / REFUTED. Code defects are more locally checkable than web claims,
 *    so one skeptical verifier suffices where research needs majority voting.
 *    Ranking: correctness outranks cleanup; CONFIRMED outranks PLAUSIBLE; then cap.
 *
 * 5) USER TARGET RIDES ALONG EVERYWHERE
 *    The verbatim `target` (PR/branch/path or free-form "focus on X" / "only review Y")
 *    is woven into SCOPE_BLOCK and passed to every finder, verifier, and the sweep —
 *    so focus areas and skip requests are honored, not just used for diff scoping.
 *
 * 6) BUILD-TIME PROMPT CONSTANTS  (the 6 `${JSON.stringify(...)}` markers below)
 *    CORRECTNESS_ANGLES / CLEANUP_ANGLES / VERDICT_LADDER / VERDICT_LADDER_RECALL /
 *    CLEANUP_PRECEDENCE / SWEEP_GAP_FOCUS are large review-prompt texts inlined at
 *    BUILD time from shared variables (QWK / u6_ / hPH / vPH / yPH / di8 / ci8 / ZV_ / li8).
 *    They are the actual review instructions; left as markers here so the
 *    orchestration stays readable. All control-flow logic below is verbatim.
 *
 * NOTE
 *   Reverse-engineered from Anthropic's proprietary Claude Code binary, reproduced
 *   for study/reference. All rights to the original code belong to Anthropic.
 */

export const meta = {
  name: 'code-review',
  description: 'Workflow-backed code review — one finder agent per review angle, an independent verifier for every candidate, then a ranked, capped findings report.',
  whenToUse: 'Launched by the /code-review skill at high, xhigh, or max effort when workflows are enabled. Pass args as "<level> [target]" — level is high, xhigh, or max; target is an optional PR number, branch, ref range, path, or free-form review instructions (e.g. "only review src/foo.ts", "focus on error handling").',
  phases: [
    {"title":"Scope","detail":"Pin the diff command, changed files, and conventions"},
    {"title":"Find","detail":"One finder agent per review angle (correctness + cleanup), streaming into verify"},
    {"title":"Verify","detail":"One independent verifier per candidate — CONFIRMED / PLAUSIBLE / REFUTED"},
    {"title":"Sweep","detail":"Fresh finder hunting only for gaps (xhigh/max)"},
    {"title":"Synthesize","detail":"Merge duplicates, rank, cap the report"}
  ],
}

// code-review: Scope → pipeline(per-angle Find → dedup → Verify) → Sweep (xhigh/max) → Synthesize
// Effort parameterization mirrors the inline /code-review cells:
//   high  → 3 correctness + 4 cleanup angles × 6 → ≤10 findings
//   xhigh → 5 correctness + 4 cleanup angles × 8 → sweep → ≤15 findings
//   max   → same structure as xhigh (the API reasoning effort differs, not the fan-out)
const LEVEL_PARAMS = {
  high: { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
  max: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
}
const MAX_VERIFY = 25
const SWEEP_MAX = 8

const RAW_ARGS = (typeof args === "string" ? args : "").trim()
const FIRST = RAW_ARGS.split(/\s+/)[0] || ""
// Own-property check so Object.prototype keys ("constructor", "toString") never parse as a level.
const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST)
const LEVEL = FIRST_IS_LEVEL ? FIRST : "high"
const TARGET = FIRST_IS_LEVEL ? RAW_ARGS.slice(FIRST.length).trim() : RAW_ARGS
const P = LEVEL_PARAMS[LEVEL]

// Prompt fragments shared with the inline /code-review cells (one source of truth).
const CORRECTNESS_ANGLES = ${JSON.stringify(isO)}
const CLEANUP_ANGLES = ${JSON.stringify(rsO)}
const VERDICT_LADDER = ${JSON.stringify(di8)}
const VERDICT_LADDER_RECALL = ${JSON.stringify(ci8)}
const CLEANUP_PRECEDENCE = ${JSON.stringify(ZV_)}
const SWEEP_GAP_FOCUS = ${JSON.stringify(li8)}

// ─── Schemas ───
const SCOPE_SCHEMA = {
  type: "object", required: ["diffCommand", "files", "summary"],
  properties: {
    diffCommand: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
    conventions: { type: "string" },
  },
}
const CANDIDATES_SCHEMA = {
  type: "object", required: ["candidates"],
  properties: {
    candidates: { type: "array", items: {
      type: "object", required: ["file", "summary", "failure_scenario"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        summary: { type: "string" },
        failure_scenario: { type: "string" },
      },
    }},
  },
}
const VERDICT_SCHEMA = {
  type: "object", required: ["verdict", "evidence"],
  properties: {
    verdict: { enum: ["CONFIRMED", "PLAUSIBLE", "REFUTED"] },
    evidence: { type: "string" },
  },
}
const REPORT_SCHEMA = {
  type: "object", required: ["summary", "findings"],
  properties: {
    summary: { type: "string" },
    findings: { type: "array", items: {
      type: "object", required: ["file", "summary", "failure_scenario", "verdict"],
      properties: {
        file: { type: "string" },
        line: { type: "number" },
        summary: { type: "string" },
        failure_scenario: { type: "string" },
        verdict: { enum: ["CONFIRMED", "PLAUSIBLE"] },
      },
    }},
  },
}

// ─── Phase 0: Scope ───
phase("Scope")
const scope = await agent(
  "Establish the scope of a code review.\n\n" +
  (TARGET
    ? "Review target / instructions (passed by the user, verbatim): \"" + TARGET + "\". If it names a PR number, branch, ref range, or file path, build the matching git diff command for it; if it is a free-form instruction (e.g. only review certain files, focus on certain areas), honor any scope restriction when building the diff command and start from the current branch diff ('git diff @{upstream}...HEAD', falling back to 'git diff main...HEAD' or 'git diff HEAD~1') for whatever it does not narrow.\n"
    : "No explicit target — review the current branch: prefer 'git diff @{upstream}...HEAD' (fall back to 'git diff main...HEAD' or 'git diff HEAD~1'), and if there are uncommitted changes also include 'git diff HEAD'.\n") +
  "\n1. Determine the exact diff command(s) for the review and run them to confirm they produce a non-empty diff.\n" +
  "2. List the changed files.\n" +
  "3. Summarize what changed in one paragraph.\n" +
  "4. Read CLAUDE.md files relevant to the changed files and note conventions a reviewer should know.\n\n" +
  "Return diffCommand exactly as a reviewer should run it. Structured output only.",
  { label: "scope", schema: SCOPE_SCHEMA }
)
if (!scope) {
  return { error: "Scope agent returned no result — cannot establish the review scope." }
}
if (!scope.files || scope.files.length === 0) {
  return { level: LEVEL, target: TARGET || undefined, summary: "No changes found to review.", findings: [], stats: { finders: 0, candidates: 0, verified: 0 } }
}
log(LEVEL + " review: " + scope.files.length + " changed files")

const SCOPE_BLOCK =
  "## Review scope\n" +
  "Diff command: " + scope.diffCommand + "\n" +
  "Changed files (" + scope.files.length + "):\n" +
  scope.files.map(f => "  - " + f).join("\n") + "\n\n" +
  "## What changed\n" + scope.summary + "\n\n" +
  "## Conventions\n" + (scope.conventions || "(none noted)") + "\n" +
  // The user's verbatim target/instructions ride along to every finder,
  // verifier, and sweep agent so focus areas and skip requests are honored,
  // not just used for diff scoping.
  (TARGET
    ? "\n## User instructions (verbatim)\n" + TARGET + "\nHonor any scope restrictions or focus areas stated above — they take precedence over your angle's default breadth. Do not surface findings the instructions ask to skip.\n"
    : "")

// ─── Prompts ───
const FINDER_PROMPT = f =>
  "## Code-review finder — " + f.label + "\n\n" + SCOPE_BLOCK + "\n" +
  "Run the diff command above and review ONLY through the lens of your assigned angle:\n\n" +
  f.text + "\n" +
  (f.kind === "cleanup" ? CLEANUP_PRECEDENCE + "\n" : "") +
  "Surface up to " + P.perAngle + " candidate findings, each with file, line, a one-line summary, and a concrete failure_scenario. " +
  "Pass every candidate with a nameable failure scenario through — do not silently drop half-believed candidates; an independent verifier judges them next. " +
  "If nothing qualifies, return an empty list.\n\nStructured output only."

const VERIFIER_PROMPT = c =>
  "## Code-review verifier\n\n" + SCOPE_BLOCK + "\n" +
  "## Candidate finding\n" +
  "File: " + c.file + (c.line != null ? ":" + c.line : "") + "\n" +
  "Summary: " + c.summary + "\n" +
  "Failure scenario: " + c.failure_scenario + "\n\n" +
  "Run the diff command above, read the relevant file(s), and return exactly one verdict:\n\n" +
  VERDICT_LADDER + "\n\n" + VERDICT_LADDER_RECALL + "\n\n" +
  "Structured output only. Evidence must quote or cite the relevant line(s)."

// ─── Dedup + verify-budget state — accumulates as finders complete (pipeline has no barrier) ───
const dedupKey = c => c.file + ":" + (c.line != null ? Math.round(c.line / 5) * 5 : "x:" + c.summary.toLowerCase().slice(0, 40))
const seen = new Map()
const dupes = []
const budgetDropped = []
let verifySlots = MAX_VERIFY

function verifyCandidate(c) {
  const short = (c.file || "").split("/").pop()
  return agent(VERIFIER_PROMPT(c), { label: "verify:" + short, phase: "Verify", schema: VERDICT_SCHEMA })
    .then(v => (v ? { ...c, verdict: v.verdict, evidence: v.evidence } : null))
}

// ─── Find → dedup → Verify, no barrier between finders ───
const FINDERS = CORRECTNESS_ANGLES.slice(0, P.correctnessAngles)
  .map(a => ({ ...a, kind: "correctness" }))
  .concat(CLEANUP_ANGLES.map(a => ({ ...a, kind: "cleanup" })))

const finderResults = await pipeline(
  FINDERS,

  f => agent(FINDER_PROMPT(f), { label: f.label, phase: "Find", schema: CANDIDATES_SCHEMA }).then(r => {
    if (!r) return { finder: f, candidates: [] }
    log(f.label + ": " + r.candidates.length + " candidates")
    return { finder: f, candidates: r.candidates.slice(0, P.perAngle) }
  }),

  result => {
    const novel = result.candidates.filter(c => {
      const key = dedupKey(c)
      if (seen.has(key)) {
        dupes.push(c)
        return false
      }
      if (verifySlots <= 0) {
        budgetDropped.push(c)
        return false
      }
      seen.set(key, true)
      verifySlots--
      return true
    })
    return parallel(novel.map(c => () => verifyCandidate({ ...c, kind: result.finder.kind })))
  }
)

let verified = finderResults.flat().filter(Boolean)

// ─── Sweep (xhigh/max): one fresh finder hunting only for gaps ───
if (P.sweep) {
  phase("Sweep")
  const knownBlock = verified.length > 0
    ? verified.map(c => "- " + c.file + (c.line != null ? ":" + c.line : "") + " — " + c.summary).join("\n")
    : "(none)"
  const sweep = await agent(
    "## Code-review sweep — gaps only\n\n" + SCOPE_BLOCK + "\n" +
    "## Already-found candidates (do NOT re-derive or re-confirm these)\n" + knownBlock + "\n\n" +
    "Re-read the diff and the enclosing functions looking ONLY for defects not already listed. " +
    "Focus on what the first pass tends to miss: " + SWEEP_GAP_FOCUS + "\n\n" +
    "Surface up to " + SWEEP_MAX + " additional candidates. If nothing new, return an empty list — do not pad.\n\nStructured output only.",
    { label: "sweep", phase: "Sweep", schema: CANDIDATES_SCHEMA }
  )
  if (sweep && sweep.candidates.length > 0) {
    const novel = sweep.candidates.slice(0, SWEEP_MAX).filter(c => !seen.has(dedupKey(c)))
    log("sweep: " + novel.length + " new candidates")
    const sweepVerified = await parallel(novel.map(c => () => verifyCandidate({ ...c, kind: "correctness" })))
    verified = verified.concat(sweepVerified.filter(Boolean))
  }
}

const surviving = verified.filter(c => c.verdict !== "REFUTED")
const refuted = verified.filter(c => c.verdict === "REFUTED")
log("Verify done: " + verified.length + " verified → " + surviving.length + " kept, " + refuted.length + " refuted")

const stats = {
  level: LEVEL,
  finders: FINDERS.length,
  candidates: seen.size + dupes.length + budgetDropped.length,
  verified: verified.length,
  refuted: refuted.length,
  dupes: dupes.length,
  budgetDropped: budgetDropped.length,
}

if (surviving.length === 0) {
  return {
    level: LEVEL, target: TARGET || undefined,
    summary: "No findings survived verification.",
    findings: [],
    stats,
  }
}

// ─── Synthesize: rank, merge semantic dupes, cap ───
phase("Synthesize")
// Correctness bugs outrank cleanup findings when the cap forces a cut;
// CONFIRMED outranks PLAUSIBLE within each group.
const rank = c => (c.kind === "cleanup" ? 2 : 0) + (c.verdict === "PLAUSIBLE" ? 1 : 0)
const ranked = surviving.slice().sort((a, b) => rank(a) - rank(b))
const block = ranked.map((c, i) =>
  "### [" + i + "] " + c.file + (c.line != null ? ":" + c.line : "") + " (" + c.verdict + (c.kind === "cleanup" ? ", cleanup" : "") + ")\n" +
  c.summary + "\nFailure scenario: " + c.failure_scenario + "\nVerifier evidence: " + c.evidence + "\n"
).join("\n")

const report = await agent(
  "## Synthesis: final code-review report\n\n" +
  ranked.length + " findings survived independent verification (" + LEVEL + "-effort review).\n\n" + block + "\n" +
  "## Instructions\n" +
  "1. Merge findings that describe the same defect (same root cause) — combine their evidence.\n" +
  "2. Rank most-severe first. Correctness bugs always outrank cleanup findings.\n" +
  "3. Keep at most " + P.maxFindings + " findings; drop the least severe beyond the cap.\n" +
  "4. Write a 2-3 sentence summary of the review.\n\nStructured output only.",
  { label: "synthesize", schema: REPORT_SCHEMA }
)

// Synthesis skipped/errored — salvage the verified findings unmerged rather
// than discarding the run.
const findings = report
  ? report.findings.slice(0, P.maxFindings)
  : ranked.slice(0, P.maxFindings).map(c => ({
      file: c.file, line: c.line, summary: c.summary, failure_scenario: c.failure_scenario, verdict: c.verdict,
    }))

return {
  level: LEVEL,
  target: TARGET || undefined,
  summary: report ? report.summary : "Synthesis step was skipped or failed — returning verified findings unmerged.",
  findings,
  refuted: refuted.map(c => ({ file: c.file, line: c.line, summary: c.summary })),
  stats: { ...stats, reported: findings.length },
}