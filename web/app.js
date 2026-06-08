"use strict";

/* Codex Workflow viewer — single-page client. Reads the JSON API, renders the overview + agent
   drill-down (prompt / result / full Codex session), and live-updates via the SSE stream. */

const state = {
  runs: [],
  filter: "",
  selectedRunId: null,
  runData: null,
  drawerKey: null,
  expandedPhases: new Set(), // phase titles; live updates can insert/reorder phase groups
  phaseExpansionTouched: false,
  lastFocus: null,
  liveAgents: new Map(), // key -> {key, label, phase, state} for in-flight/just-finished agents
  liveLogs: [], // log lines seen via SSE (record.logs is only persisted at completion)
  refetchTimer: null,
  backstopTimer: null, // low-frequency poll while a running run is open (self-heals missed live events)
};

const $ = (sel) => document.querySelector(sel);
const el = (id) => document.getElementById(id);

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return res.json();
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDuration(ms) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function fmtNum(n) {
  return n == null ? "—" : Number(n).toLocaleString();
}

/* ----------------------------- Run list (sidebar) ----------------------------- */

async function loadRuns(selectAfter) {
  state.runs = await fetchJSON("/api/runs");
  renderRunList();
  el("sidebar-foot").textContent = `${state.runs.length} run${state.runs.length === 1 ? "" : "s"} recorded`;
  if (selectAfter) selectRun(selectAfter);
}

function renderRunList() {
  const list = el("run-list");
  const f = state.filter.toLowerCase();
  const runs = state.runs.filter((r) => !f || r.name.toLowerCase().includes(f) || r.runId.toLowerCase().includes(f));
  if (runs.length === 0) {
    list.innerHTML = `<div class="muted-note">No matching runs.</div>`;
    return;
  }
  list.innerHTML = runs
    .map((r) => {
      const active = r.runId === state.selectedRunId ? " active" : "";
      const agents = r.agentCount != null ? `${r.agentCount} agents` : r.status === "running" ? "running…" : "";
      return `<button class="run-item${active}" data-run="${escapeHtml(r.runId)}">
        <div class="run-item-top">
          <span class="status-dot ${r.status}"></span>
          <span class="run-item-name">${escapeHtml(r.name)}</span>
        </div>
        <div class="run-item-meta">${fmtTime(r.startedAt)} · ${fmtDuration(r.durationMs)}${agents ? " · " + agents : ""}</div>
      </button>`;
    })
    .join("");
}

/* ----------------------------- Run view (main) ----------------------------- */

async function selectRun(runId, push = true) {
  state.selectedRunId = runId;
  state.expandedPhases = new Set();
  state.phaseExpansionTouched = false;
  state.liveAgents.clear();
  state.liveLogs = [];
  closeSidebar();
  renderRunList();
  if (push && location.pathname !== `/runs/${runId}`) history.pushState({ runId }, "", `/runs/${runId}`);
  el("empty-state").hidden = true;
  const view = el("run-view");
  view.hidden = false;
  view.innerHTML = `<div class="loading">Loading run</div>`;
  try {
    state.runData = await fetchJSON(`/api/runs/${encodeURIComponent(runId)}`);
    seedLiveFromBuffer(state.runData.live); // replay events emitted before we connected
    renderRunView(state.runData);
  } catch (err) {
    view.innerHTML = `<div class="muted-note">Could not load run: ${escapeHtml(err.message)}</div>`;
  }
}

// Seed the client-side live state (logs + in-flight agents) from the server's per-run event buffer,
// so opening an already-running run shows everything emitted so far — not just events from now on.
function seedLiveFromBuffer(buffer) {
  state.liveLogs = [];
  state.liveAgents.clear();
  for (const ev of buffer || []) {
    if (ev.type === "run-meta") {
      state.liveLogs = [];
      state.liveAgents.clear();
      continue;
    }
    if (ev.type === "run-finished") {
      state.liveAgents.clear();
      continue;
    }
    if (ev.type !== "progress" || !ev.event) continue;
    const e = ev.event;
    if (e.type === "log") state.liveLogs.push(e.message);
    else if (e.type === "agent" && e.key) state.liveAgents.set(e.key, { key: e.key, label: e.label, phase: e.phase, state: e.state });
  }
}

function renderRunView(data) {
  const { record, view } = data;
  const desc = record.description ? `<p class="rv-desc">${escapeHtml(record.description)}</p>` : "";
  const stats = view.stats;
  const phases = mergedPhases();
  ensureDefaultExpandedPhases(phases);
  const visibleAgentCount = phases.reduce((sum, phase) => sum + phase.agents.length, 0);
  // When a real result exists it's the answer — show it above the logs, which become secondary.
  const hasResult = record.result !== undefined && record.result !== null;
  const root = el("run-view");
  root.innerHTML = `
    <div class="rv-head">
      <div class="rv-eyebrow">${escapeHtml(record.source || "workflow")}</div>
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <h1 class="rv-title">${escapeHtml(record.name)}</h1>
        <span class="pill ${record.status}"><span class="status-dot ${record.status}"></span>${record.status}</span>
        <span class="rv-stats">${renderHeadStats(record, stats, visibleAgentCount)}</span>
      </div>
      ${desc}
      ${renderRunMeta(record)}
    </div>

    ${renderInputSection(record)}
    <div id="flow-section">${renderFlowSection(phases)}</div>
    ${hasResult ? renderResultSection(record) + renderLogs(record) : renderLogs(record) + renderResultSection(record)}
  `;
  requestAnimationFrame(drawTreeBranches);
  setLiveActive(record.status === "running");
}

// The agents / duration / cache-hits run inside `.rv-stats`. Extracted so the live-tick path can
// refresh just this box in place (no animation here) instead of re-rendering the whole head.
function renderHeadStats(record, stats, visibleAgentCount) {
  const duration = stats.durationMs ?? (record.status === "running" && record.startedAt ? Date.now() - record.startedAt : undefined);
  return `<span class="rv-stat"><b>${fmtNum(Math.max(stats.agentCount ?? 0, visibleAgentCount))}</b> agents</span>
    <span class="rv-stat-sep">·</span>
    <span class="rv-stat"><b>${fmtDuration(duration)}</b></span>
    ${stats.cacheHits ? `<span class="rv-stat-sep">·</span><span class="rv-stat"><b>${fmtNum(stats.cacheHits)}</b> cache hits</span>` : ""}`;
}

function renderRunMeta(record) {
  const chips = [
    `<button class="meta-chip" data-copy="${escapeHtml(record.runId)}" title="Copy run id"><span class="meta-label">run</span><span class="meta-value">${escapeHtml(record.runId)}</span></button>`,
  ];
  if (record.scriptPath) {
    chips.push(
      `<button class="meta-chip" data-copy="${escapeHtml(record.scriptPath)}" title="Copy script path"><span class="meta-label">script</span><span class="meta-value">${escapeHtml(record.scriptPath)}</span></button>`,
    );
  }
  return `<div class="rv-meta-row">${chips.join("")}</div>`;
}

function setLiveActive(active) {
  document.querySelectorAll(".live-dot").forEach((node) => node.classList.toggle("active", active));
  // While a run is live, keep a backstop poll running (see pollRunning); stop it once it's terminal.
  if (active) {
    if (!state.backstopTimer) state.backstopTimer = setInterval(pollRunning, 3000);
  } else if (state.backstopTimer) {
    clearInterval(state.backstopTimer);
    state.backstopTimer = null;
  }
}

// During a run, record.logs is empty (only persisted at completion) — fall back to the live log
// buffer and always render the box so streaming `log` events have somewhere to land.
function renderLogs(record) {
  const persisted = record.logs && record.logs.length ? record.logs : [];
  const logs = persisted.length ? persisted : state.liveLogs;
  const running = record.status === "running";
  if (!logs.length && !running) return "";
  const body = logs.length
    ? logs.map((l) => `<div class="log-line">${escapeHtml(l)}</div>`).join("")
    : `<div class="log-empty">waiting for log output…</div>`;
  return `<div class="section-label">Workflow log</div><div class="logs" id="logs-box">${body}</div>`;
}

/* ---- Input: the args passed into the workflow ---- */

function renderInputSection(record) {
  if (record.args === undefined || record.args === null) return "";
  return `<div class="section-label">Input</div>
    <div class="result-card">${renderResultValue(record.args, 0)}</div>`;
}

/* ---- Final result: what the workflow script returned ---- */

function renderResultSection(record) {
  if (record.status === "running") return "";
  const r = record.result;
  if (r === undefined || r === null) {
    if (record.status !== "completed") return "";
    return `<div class="section-label">Result</div>
      <div class="result-card"><div class="muted-note">No final result was recorded for this run.</div></div>`;
  }
  return `<div class="section-label">Result</div>
    <div class="result-card">${renderResultValue(r, 0)}
      <details class="result-raw"><summary>Raw JSON</summary><div class="json-block">${highlightJson(r)}</div></details>
    </div>`;
}

// Human-readable rendering of an arbitrary result value (strings as prose, lists as cards/bullets).
function renderResultValue(v, depth) {
  if (v === null || v === undefined) return `<span class="result-scalar">—</span>`;
  if (typeof v === "string") return `<div class="result-text">${escapeHtml(v)}</div>`;
  if (typeof v !== "object") return `<span class="result-scalar">${escapeHtml(String(v))}</span>`;
  if (Array.isArray(v)) {
    if (v.length === 0) return `<span class="result-scalar">—</span>`;
    if (v.every((x) => x === null || typeof x !== "object")) {
      return `<ul class="result-list">${v.map((x) => `<li>${escapeHtml(String(x))}</li>`).join("")}</ul>`;
    }
    if (canRenderObjectTable(v)) return renderObjectTable(v);
    return `<div class="result-items">${v.map((x) => `<div class="result-subcard">${renderResultValue(x, depth + 1)}</div>`).join("")}</div>`;
  }
  // plain object → labeled fields. Adaptive: a run of *uniformly short* scalar fields tiles into a
  // multi-column grid (e.g. a `stats` block of numbers). Anything with varying/longer content —
  // URLs, prose, arrays, nested objects, or a lone scalar — renders as a full-width row instead.
  const entries = Object.entries(v);
  if (entries.length === 0) return `<span class="result-scalar">{}</span>`;
  if (depth > 3) return `<div class="json-block">${highlightJson(v)}</div>`;
  let out = "";
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
    if (bucket.length === 1) {
      // a lone short field is not a stat block — render it full-width, not in a 1-column grid
      const [k, val] = bucket[0];
      out += `<div class="result-field"><div class="result-key">${escapeHtml(humanizeKey(k))}</div><div class="result-fieldval">${renderResultValue(val, depth + 1)}</div></div>`;
      bucket = [];
      return;
    }
    out += `<div class="result-grid">${bucket
      .map(
        ([k, val]) => `<div class="result-cell"><div class="result-key">${escapeHtml(humanizeKey(k))}</div><div class="result-cellval">${escapeHtml(formatScalar(val))}</div></div>`,
      )
      .join("")}</div>`;
    bucket = [];
  };
  for (const [k, val] of entries) {
    if (isCompact(val)) {
      bucket.push([k, val]);
    } else {
      flush();
      // Nested objects/arrays add a real hierarchy level → indent their value with a guide line.
      // Plain (long) strings are still the field's own value, so they stay at the base margin.
      const nested = val !== null && typeof val === "object";
      out += `<div class="result-field"><div class="result-key">${escapeHtml(humanizeKey(k))}</div><div class="result-fieldval${nested ? " nested" : ""}">${renderResultValue(val, depth + 1)}</div></div>`;
    }
  }
  flush();
  return out;
}

// A value is "compact" (grid-tileable) when it's a short scalar — number, boolean, or a brief
// single-line string. Long strings / arrays / objects render full-width instead.
// "Compact" = a short scalar that tiles cleanly in a narrow (~130px) stat-grid cell. Anything
// that isn't — a URL, a longer string, prose — is left out so it renders as a full-width row
// instead of being crammed into a column and wrapping into an unreadable vertical stack.
function isCompact(v) {
  if (v === null) return true;
  if (typeof v === "number" || typeof v === "boolean") return true;
  if (typeof v !== "string" || v.includes("\n")) return false;
  if (/^https?:\/\//i.test(v.trim())) return false; // URLs always get their own full-width row
  // display width, not char count: CJK / fullwidth glyphs are ~2× wide, so a short-looking
  // Chinese sentence still overflows a narrow stat cell — keep such prose out of the grid.
  let width = 0;
  for (const ch of v) width += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  return width <= 24;
}

function formatScalar(v) {
  return v === null || v === undefined ? "—" : String(v);
}

function canRenderObjectTable(items) {
  if (!items.length || items.length > 200) return false;
  const keys = new Set();
  for (const item of items) {
    if (!isPlainObject(item)) return false;
    for (const [key, value] of Object.entries(item)) {
      keys.add(key);
      if (keys.size > 8 || !isCompact(value)) return false;
    }
  }
  return keys.size > 0;
}

function renderObjectTable(items) {
  const keys = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const head = keys.map((key) => `<th>${escapeHtml(humanizeKey(key))}</th>`).join("");
  const rows = items
    .map((item) => `<tr>${keys.map((key) => `<td>${escapeHtml(formatScalar(item[key]))}</td>`).join("")}</tr>`)
    .join("");
  return `<div class="result-table-wrap"><table class="result-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// camelCase / snake_case key → spaced label, e.g. "sourcesFetched" -> "sources Fetched".
function humanizeKey(k) {
  return String(k)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/* ---- Pipeline flow graph: phase nodes wired together; each expands to a fan of agent nodes ---- */

// Merges completed agents (from the journal) with live in-flight agents (from the SSE stream) so a
// "running" placeholder node shows the moment an agent starts, before its journal entry exists.
function mergedPhases() {
  const view = state.runData?.view;
  const phases = view ? view.phases.map((p) => ({ title: p.title, agents: p.agents.slice() })) : [];
  if (state.liveAgents.size === 0) return phases;

  const journalKeys = new Set();
  for (const p of phases) for (const a of p.agents) journalKeys.add(a.key);
  const byTitle = new Map(phases.map((p) => [p.title, p]));

  for (const la of state.liveAgents.values()) {
    if (journalKeys.has(la.key)) continue; // the real (clickable) node already exists
    const title = la.phase || "Other";
    let grp = byTitle.get(title);
    if (!grp) {
      grp = { title, agents: [] };
      byTitle.set(title, grp);
      phases.push(grp);
    }
    grp.agents.push({
      key: la.key,
      label: la.label,
      status: la.state === "failed" ? "failed" : la.state === "started" ? "running" : "ok",
      resultPreview: la.state === "started" ? "running…" : "",
      hasSchema: false,
      hasSession: false,
      live: true,
    });
  }
  return phases;
}

// While agents are still in flight, a phase shows completed/total (x/y); otherwise just the count.
// A declared phase with no agents yet is "pending".
function phaseBadge(p) {
  const total = p.agents.length;
  const done = p.agents.filter((a) => a.status !== "running").length;
  const pending = total === 0;
  return { total, done, pending, inProgress: done < total, badge: pending ? "" : done < total ? `${done}/${total}` : `${total}` };
}

function defaultExpandedPhases(phases) {
  return phases.filter((phase) => phase.agents.length > 0).map((phase) => phase.title);
}

function ensureDefaultExpandedPhases(phases) {
  if (!state.phaseExpansionTouched && state.expandedPhases.size === 0) state.expandedPhases = new Set(defaultExpandedPhases(phases));
}

function phaseNodeHtml(p) {
  const { pending, inProgress, badge } = phaseBadge(p);
  const expanded = state.expandedPhases.has(p.title);
  const active = expanded ? " active" : "";
  return `<button class="flow-phase${inProgress ? " in-progress" : ""}${pending ? " pending" : ""}${active}" data-phase-title="${escapeHtml(p.title)}" aria-expanded="${expanded ? "true" : "false"}">
        <span class="fp-dot"></span>
        <span class="fp-name">${escapeHtml(p.title)}</span>
        ${pending ? "" : `<span class="fp-count">${badge}</span>`}
        <span class="fp-chev">v</span>
      </button>`;
}

function renderFlowSection(phases) {
  if (!phases.length) return `<div class="muted-note">No agents recorded yet.</div>`;
  return `<div class="section-label">Pipeline</div>
    <div class="flow flow-tree" id="flow">
      ${phases.map((phase, index) => renderPhaseBranch(phase, index, phases.length)).join("")}
    </div>`;
}

function renderPhaseBranch(phase, index, total) {
  const expanded = state.expandedPhases.has(phase.title);
  const { pending, inProgress } = phaseBadge(phase);
  return `<div class="flow-branch${expanded ? " expanded" : ""}${pending ? " pending" : ""}${inProgress ? " in-progress" : ""}" data-phase-title="${escapeHtml(phase.title)}">
    <svg class="tree-svg" aria-hidden="true"></svg>
    <div class="branch-axis${index === 0 ? " first" : ""}${index === total - 1 ? " last" : ""}">
      <span class="axis-line"></span>
      ${phaseNodeHtml(phase)}
    </div>
    <div class="branch-panel"${expanded ? "" : " hidden"}>
      ${expanded ? renderFan(phase) : ""}
    </div>
  </div>`;
}

function visibleAgents(p) {
  return p.agents.slice(0, 180);
}

// Every node carries `data-key`; live (not-yet-journaled) nodes also get `data-live`, which keeps
// them visible but non-clickable until their journal entry exists.
function nodeClassName(a) {
  return `flow-node ${a.status}${a.live ? " pending" : ""}`;
}

function nodeTitle(a) {
  return a.resultPreview || a.label;
}

function nodeInner(a) {
  return `<span class="fn-dot ${a.status}"></span><span class="fn-label">${escapeHtml(a.label)}</span>`;
}

function fanNodeHtml(a, delayMs) {
  return `<button class="${nodeClassName(a)}" data-key="${escapeHtml(a.key)}"${a.live ? ' data-live="1"' : ""} title="${escapeHtml(nodeTitle(a))}"${delayMs != null ? ` style="animation-delay:${delayMs}ms"` : ""}>${nodeInner(a)}</button>`;
}

function fanNodesHtml(visible) {
  const nodes = visible.map((a, i) => fanNodeHtml(a, Math.min(i * 12, 300))).join("");
  return nodes || '<div class="muted-note">No agents.</div>';
}

function fanNoteHtml(p, visible) {
  return p.agents.length > visible.length ? `<div class="fan-note">Showing first ${visible.length} of ${fmtNum(p.agents.length)} agents.</div>` : "";
}

function renderFan(p) {
  const visible = visibleAgents(p);
  const compact = p.agents.length > 48 ? " compact" : "";
  return `<div class="fan-main">
      <div class="fan-grid${compact}">${fanNodesHtml(visible)}</div>
      ${fanNoteHtml(p, visible)}
    </div>`;
}

function togglePhase(title) {
  state.phaseExpansionTouched = true;
  if (state.expandedPhases.has(title)) state.expandedPhases.delete(title);
  else state.expandedPhases.add(title);
  renderCurrentFlow();
}

function renderCurrentFlow() {
  const section = el("flow-section");
  if (!section) return;
  section.innerHTML = renderFlowSection(mergedPhases());
  requestAnimationFrame(drawTreeBranches);
}

function drawTreeBranches() {
  for (const branch of document.querySelectorAll(".flow-branch.expanded")) {
    drawTreeBranch(branch);
  }
}

function drawTreeBranch(branch) {
  const svg = branch.querySelector(".tree-svg");
  const phase = branch.querySelector(".flow-phase");
  if (!svg || !phase) return;
  if (branch.querySelectorAll(".flow-node").length > 120 || matchMedia("(max-width: 720px)").matches) {
    svg.innerHTML = "";
    return;
  }
  const base = branch.getBoundingClientRect();
  svg.setAttribute("width", String(base.width));
  svg.setAttribute("height", String(base.height));
  svg.setAttribute("viewBox", `0 0 ${base.width} ${base.height}`);
  const pb = phase.getBoundingClientRect();
  const sx = pb.right - base.left - 2;
  const sy = pb.top + pb.height / 2 - base.top;
  let paths = "";
  for (const n of branch.querySelectorAll(".flow-node")) {
    const nb = n.getBoundingClientRect();
    const ex = nb.left - base.left - 4;
    const ey = nb.top + nb.height / 2 - base.top;
    const c = Math.max((ex - sx) * 0.5, 18);
    paths += `<path class="tree-line" d="M${sx.toFixed(1)},${sy.toFixed(1)} C${(sx + c).toFixed(1)},${sy.toFixed(1)} ${(ex - c).toFixed(1)},${ey.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}"/>`;
  }
  svg.innerHTML = paths;
}

/* ---- Live update: refresh stats and repaint the tree while preserving multi-expanded state. ---- */

function patchFlow(phases) {
  const section = el("flow-section");
  if (!section) return;
  section.innerHTML = renderFlowSection(phases);
  requestAnimationFrame(drawTreeBranches);
}

// Live-tick entry point (replaces a full renderRunView on every refetch): refresh the head stats +
// status pill + flow IN PLACE. Logs are appended live in applyProgress; result/finish counts are
// handled by the run-finished full render — so this path deliberately touches neither.
function patchRunView(data) {
  state.runData = data;
  const { record, view } = data;
  const phases = mergedPhases();
  ensureDefaultExpandedPhases(phases);
  const visibleAgentCount = phases.reduce((sum, p) => sum + p.agents.length, 0);
  const statsBox = $(".rv-stats");
  if (statsBox) statsBox.innerHTML = renderHeadStats(record, view.stats, visibleAgentCount);
  // Repaint the pill only on an actual status change — re-rendering it every tick would restart the
  // running-dot blink so it never animates.
  const pill = $(".rv-head .pill");
  if (pill && !pill.classList.contains(record.status)) {
    pill.className = `pill ${record.status}`;
    pill.innerHTML = `<span class="status-dot ${record.status}"></span>${escapeHtml(record.status)}`;
  }
  setLiveActive(record.status === "running");
  patchFlow(phases);
}

/* ----------------------------- Drawer (agent detail) ----------------------------- */

async function openDrawer(key) {
  state.drawerKey = key;
  state.lastFocus = document.activeElement;
  const drawer = el("drawer");
  const scrim = el("drawer-scrim");
  scrim.hidden = false;
  drawer.hidden = false;
  drawer.innerHTML = `<div class="loading">Loading agent</div>`;
  let entry;
  try {
    entry = await fetchJSON(`/api/runs/${encodeURIComponent(state.selectedRunId)}/agents/${encodeURIComponent(key)}`);
  } catch (err) {
    drawer.innerHTML = `<div class="muted-note">${escapeHtml(err.message)}</div>`;
    return;
  }
  const opts = entry.options || {};
  drawer.innerHTML = `
    <div class="drawer-head">
      <div class="dh-top">
        <div class="drawer-title">${escapeHtml(opts.label || "agent")}</div>
        <button class="drawer-close" id="drawer-close" aria-label="Close">✕</button>
      </div>
      <div class="drawer-meta">
        ${opts.phase ? `<span class="tag">${escapeHtml(opts.phase)}</span>` : ""}
        ${opts.model ? `<span class="tag">${escapeHtml(opts.model)}</span>` : ""}
        ${entry.sessionId ? `<span class="tag session">session ${escapeHtml(entry.sessionId.slice(0, 8))}</span>` : ""}
      </div>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="result">Result</button>
      <button class="tab" data-tab="prompt">Prompt</button>
      <button class="tab" data-tab="session">Codex session</button>
    </div>
    <div class="drawer-body">
      <div class="panel active" data-panel="result">${renderResult(entry.result)}</div>
      <div class="panel" data-panel="prompt"><div class="codeblock">${escapeHtml(entry.prompt)}</div></div>
      <div class="panel" data-panel="session"><div class="loading" id="session-loading">Linking Codex session</div></div>
    </div>
  `;
  requestAnimationFrame(() => el("drawer-close")?.focus());
}

function renderResult(result) {
  if (typeof result === "string") return `<div class="codeblock">${escapeHtml(result)}</div>`;
  return `<div class="json-block">${highlightJson(result)}</div>`;
}

async function loadSession() {
  const panel = $('.panel[data-panel="session"]');
  if (!panel || panel.dataset.loaded) return;
  panel.dataset.loaded = "1";
  try {
    const s = await fetchJSON(`/api/runs/${encodeURIComponent(state.selectedRunId)}/agents/${encodeURIComponent(state.drawerKey)}/session`);
    panel.innerHTML = renderSession(s);
  } catch (err) {
    panel.innerHTML = `<div class="muted-note">No linked Codex session.<br/><span style="font-size:11.5px">${escapeHtml(err.message)}</span></div>`;
  }
}

function renderSession(s) {
  const m = s.meta || {};
  const metaLine = `<div class="drawer-meta" style="margin-bottom:14px">
      ${m.id ? `<span class="tag">${escapeHtml(m.id)}</span>` : ""}
      ${m.model || m.modelProvider ? `<span class="tag">${escapeHtml(m.model || m.modelProvider)}</span>` : ""}
      ${m.cliVersion ? `<span class="tag">codex ${escapeHtml(m.cliVersion)}</span>` : ""}
    </div>`;
  const u = s.usage;
  const usage = u
    ? `<div class="usage-bar">
        <div class="u"><div class="uv">${fmtNum(u.totalTokens)}</div><div class="ul">total tokens</div></div>
        <div class="u"><div class="uv">${fmtNum(u.inputTokens)}</div><div class="ul">input</div></div>
        <div class="u"><div class="uv">${fmtNum(u.outputTokens)}</div><div class="ul">output</div></div>
        <div class="u"><div class="uv">${fmtNum(u.reasoningOutputTokens)}</div><div class="ul">reasoning</div></div>
        <div class="u"><div class="uv">${fmtNum(u.cachedInputTokens)}</div><div class="ul">cached</div></div>
      </div>`
    : "";
  const items = (s.items || []).map(renderSessionItem).join("");
  return metaLine + usage + `<div class="timeline">${items || '<div class="muted-note">Session has no displayable items.</div>'}</div>`;
}

function renderSessionItem(it) {
  if (it.kind === "message") {
    const role = it.role || "unknown";
    return `<div class="tl-item role-${escapeHtml(role)}"><div class="tl-head"><span class="tl-badge">${escapeHtml(role)}</span></div><div class="tl-body">${escapeHtml(it.text)}</div></div>`;
  }
  if (it.kind === "reasoning") {
    return `<div class="tl-item reasoning"><div class="tl-head">✦ reasoning</div><div class="tl-body">${escapeHtml(it.summary)}</div></div>`;
  }
  if (it.kind === "web_search") {
    const qs = [];
    if (it.query) qs.push(it.query);
    if (Array.isArray(it.queries)) for (const q of it.queries) if (!qs.includes(q)) qs.push(q);
    const body = qs.length ? qs.map((q) => `<div class="search-q">${escapeHtml(q)}</div>`).join("") : '<span class="muted-note">search</span>';
    return `<div class="tl-item web_search"><div class="tl-head"><span class="tl-badge">web search</span>${
      it.status ? escapeHtml(it.status) : ""
    }</div><div class="tl-body">${body}</div></div>`;
  }
  if (it.kind === "function_call") {
    const args = typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments, null, 2);
    return `<div class="tl-item tool"><div class="tl-head">⌘ ${escapeHtml(it.name)}</div><div class="tl-body">${escapeHtml(args)}</div></div>`;
  }
  if (it.kind === "function_call_output") {
    return `<div class="tl-item tool"><div class="tl-head">↳ output${it.truncated ? " (truncated)" : ""}</div><div class="tl-body">${escapeHtml(it.output)}</div></div>`;
  }
  return "";
}

function closeDrawer() {
  el("drawer").hidden = true;
  el("drawer-scrim").hidden = true;
  state.drawerKey = null;
  if (state.lastFocus && typeof state.lastFocus.focus === "function") state.lastFocus.focus();
  state.lastFocus = null;
}

function openSidebar() {
  el("sidebar").classList.add("open");
  el("sidebar-scrim").hidden = false;
  el("mobile-menu")?.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  el("sidebar")?.classList.remove("open");
  const scrim = el("sidebar-scrim");
  if (scrim) scrim.hidden = true;
  el("mobile-menu")?.setAttribute("aria-expanded", "false");
}

/* ----------------------------- JSON highlight ----------------------------- */

function highlightJson(obj) {
  let json;
  try {
    json = JSON.stringify(obj, null, 2);
  } catch {
    return escapeHtml(String(obj));
  }
  return escapeHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "n";
      if (/^"/.test(match)) cls = /:$/.test(match) ? "k" : "s";
      else if (/true|false|null/.test(match)) cls = "b";
      return `<span class="${cls}">${match}</span>`;
    },
  );
}

/* ----------------------------- Live stream ----------------------------- */

function connectStream() {
  const es = new EventSource("/api/stream");
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleLive(msg);
  };
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
}

function handleLive(msg) {
  if (msg.type === "run-meta") {
    const hadSelection = Boolean(state.selectedRunId);
    const shouldSelect = msg.runId === state.selectedRunId || !hadSelection;
    loadRuns().then(() => {
      if (shouldSelect) selectRun(msg.runId, !hadSelection); // auto-focus fresh runs; refresh selected resumes
    });
    return;
  }
  if (msg.runId !== state.selectedRunId) {
    if (msg.type === "run-finished") loadRuns();
    return;
  }
  if (msg.type === "run-finished") {
    selectRun(msg.runId, false);
    loadRuns();
    return;
  }
  if (msg.type === "progress") applyProgress(msg.event);
}

function applyProgress(event) {
  if (!event) return;
  if (event.type === "log") {
    state.liveLogs.push(event.message);
    const box = el("logs-box");
    if (box) {
      const empty = box.querySelector(".log-empty");
      if (empty) empty.remove();
      const div = document.createElement("div");
      div.className = "log-line";
      div.textContent = event.message;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }
    return;
  }
  // Track in-flight agents so a "running" placeholder node shows immediately.
  if (event.type === "agent" && event.key) {
    state.liveAgents.set(event.key, { key: event.key, label: event.label, phase: event.phase, state: event.state });
  }
  // Debounced refetch re-renders the flow (merged journal + live) and pulls fresh stats/result.
  scheduleRefetch();
}

function scheduleRefetch() {
  if (state.refetchTimer) return;
  state.refetchTimer = setTimeout(async () => {
    state.refetchTimer = null;
    if (!state.selectedRunId) return;
    try {
      const data = await fetchJSON(`/api/runs/${encodeURIComponent(state.selectedRunId)}`);
      // Incremental: patch head stats + flow in place (keyed by agent key) — never tear down and
      // re-animate the whole agent fan on every tick.
      patchRunView(data);
    } catch {
      /* ignore transient errors during a live run */
    }
  }, 350);
}

// Backstop poll: while a running run is open, refetch on a low-frequency timer so the view self-heals
// if a live event was missed — e.g. a standalone `serve` that raced the producer deleting the events
// file and never saw `run-finished`. Push (the SSE tailer) keeps it snappy; this only guarantees
// eventual consistency. Correctness rides on the disk record/journal, never on event delivery.
async function pollRunning() {
  if (!state.selectedRunId) return;
  let data;
  try {
    data = await fetchJSON(`/api/runs/${encodeURIComponent(state.selectedRunId)}`);
  } catch {
    return; // transient — try again on the next tick
  }
  if (data.record.status === "running") {
    patchRunView(data);
  } else {
    // Finished without us hearing run-finished — do the full finish render (result + final counts).
    selectRun(state.selectedRunId, false);
    loadRuns();
  }
}

/* ----------------------------- Events / routing ----------------------------- */

document.addEventListener("click", (e) => {
  const menu = e.target.closest("#mobile-menu");
  if (menu) return openSidebar();

  if (e.target.id === "sidebar-scrim") return closeSidebar();

  const copy = e.target.closest("[data-copy]");
  if (copy) return copyText(copy);

  const runBtn = e.target.closest(".run-item");
  if (runBtn) return selectRun(runBtn.dataset.run);

  const node = e.target.closest(".flow-node");
  if (node) return node.dataset.live ? undefined : openDrawer(node.dataset.key); // live nodes have no detail yet

  const phase = e.target.closest(".flow-phase");
  if (phase) return togglePhase(phase.dataset.phaseTitle);

  if (e.target.closest("#drawer-close") || e.target.id === "drawer-scrim") return closeDrawer();

  const tab = e.target.closest(".tab");
  if (tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === tab.dataset.tab));
    if (tab.dataset.tab === "session") loadSession();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!el("drawer").hidden) return closeDrawer();
    if (el("sidebar").classList.contains("open")) return closeSidebar();
  }
  if (e.key === "Tab" && !el("drawer").hidden) trapDrawerFocus(e);
});

el("run-search").addEventListener("input", (e) => {
  state.filter = e.target.value;
  renderRunList();
});

window.addEventListener("popstate", () => {
  const m = location.pathname.match(/^\/runs\/(.+)$/);
  if (m) selectRun(decodeURIComponent(m[1]), false);
});

let resizeRaf = null;
window.addEventListener("resize", () => {
  if (!state.expandedPhases.size) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    drawTreeBranches();
  });
});

async function copyText(button) {
  const text = button.dataset.copy || "";
  try {
    await navigator.clipboard.writeText(text);
    button.classList.add("copied");
    setTimeout(() => button.classList.remove("copied"), 900);
  } catch {
    // Clipboard access can be unavailable on some local browser contexts; keep the UI unchanged.
  }
}

function trapDrawerFocus(event) {
  const drawer = el("drawer");
  const focusable = [...drawer.querySelectorAll('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (node) => !node.disabled && node.offsetParent !== null,
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ----------------------------- Boot ----------------------------- */

(async function boot() {
  connectStream();
  const m = location.pathname.match(/^\/runs\/(.+)$/);
  await loadRuns(m ? decodeURIComponent(m[1]) : undefined);
})();
