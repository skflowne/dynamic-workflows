"use strict";

/* Codex Workflow viewer — single-page client. Reads the JSON API, renders the overview + agent
   drill-down (prompt / result / full Codex session), and live-updates via the SSE stream. */

const state = {
  runs: [],
  filter: "",
  selectedRunId: null,
  runData: null,
  drawerKey: null,
  expandedPhase: null,
  liveAgents: new Map(), // key -> {key, label, phase, state} for in-flight/just-finished agents
  liveLogs: [], // log lines seen via SSE (record.logs is only persisted at completion)
  refetchTimer: null,
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
  state.expandedPhase = null;
  state.liveAgents.clear();
  state.liveLogs = [];
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
    if (ev.type !== "progress" || !ev.event) continue;
    const e = ev.event;
    if (e.type === "log") state.liveLogs.push(e.message);
    else if (e.type === "agent" && e.key) state.liveAgents.set(e.key, { key: e.key, label: e.label, phase: e.phase, state: e.state });
  }
}

function renderRunView(data) {
  const { record, view } = data;
  state.expandedPhase = null;
  const desc = record.description ? `<p class="rv-desc">${escapeHtml(record.description)}</p>` : "";
  const stats = view.stats;
  const root = el("run-view");
  root.innerHTML = `
    <div class="rv-head">
      <div class="rv-eyebrow">${escapeHtml(record.source || "workflow")}</div>
      <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
        <h1 class="rv-title">${escapeHtml(record.name)}</h1>
        <span class="pill ${record.status}"><span class="status-dot ${record.status}"></span>${record.status}</span>
      </div>
      ${desc}
      <div class="rv-runid">${escapeHtml(record.runId)}${record.scriptPath ? " · " + escapeHtml(record.scriptPath) : ""}</div>
    </div>

    <div class="rv-stats">
      <div class="stat"><div class="stat-val">${fmtNum(stats.agentCount)}</div><div class="stat-label">Agents</div></div>
      <div class="stat"><div class="stat-val">${fmtDuration(stats.durationMs)}</div><div class="stat-label">Duration</div></div>
      <div class="stat"><div class="stat-val">${view.phases.length}</div><div class="stat-label">Phases</div></div>
      ${stats.cacheHits ? `<div class="stat"><div class="stat-val">${fmtNum(stats.cacheHits)}</div><div class="stat-label">Cache hits</div></div>` : ""}
    </div>

    ${renderInputSection(record)}
    <div id="flow-section">${renderFlowSection(mergedPhases())}</div>
    ${renderLogs(record)}
    ${renderResultSection(record)}
  `;
  el("live-dot").classList.toggle("active", record.status === "running");
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
  return `<div class="section-label">Input <span class="hint">— arguments passed to the workflow</span></div>
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
  return `<div class="section-label">Result <span class="hint">— the workflow's final output</span></div>
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
    return `<div class="result-items">${v.map((x) => `<div class="result-subcard">${renderResultValue(x, depth + 1)}</div>`).join("")}</div>`;
  }
  // plain object → labeled fields. Adaptive: runs of short scalar fields tile into a multi-column
  // grid (e.g. a `stats` block of numbers); long fields (prose, arrays, nested objects) stay full-width.
  const entries = Object.entries(v);
  if (entries.length === 0) return `<span class="result-scalar">{}</span>`;
  if (depth > 3) return `<div class="json-block">${highlightJson(v)}</div>`;
  let out = "";
  let bucket = [];
  const flush = () => {
    if (!bucket.length) return;
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
      out += `<div class="result-field"><div class="result-key">${escapeHtml(humanizeKey(k))}</div>${renderResultValue(val, depth + 1)}</div>`;
    }
  }
  flush();
  return out;
}

// A value is "compact" (grid-tileable) when it's a short scalar — number, boolean, or a brief
// single-line string. Long strings / arrays / objects render full-width instead.
function isCompact(v) {
  if (v === null) return true;
  if (typeof v === "number" || typeof v === "boolean") return true;
  return typeof v === "string" && v.length <= 48 && !v.includes("\n");
}

function formatScalar(v) {
  return v === null || v === undefined ? "—" : String(v);
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

function renderFlowSection(phases) {
  if (!phases.length) return `<div class="muted-note">No agents recorded yet.</div>`;
  const rail = phases
    .map((p, i) => {
      // While agents are still in flight, show completed/total (x/y); otherwise just the count.
      const total = p.agents.length;
      const done = p.agents.filter((a) => a.status !== "running").length;
      const badge = done < total ? `${done}/${total}` : `${total}`;
      const node = `<button class="flow-phase${done < total ? " in-progress" : ""}" data-phase-idx="${i}">
        <span class="fp-dot"></span>
        <span class="fp-name">${escapeHtml(p.title)}</span>
        <span class="fp-count">${badge}</span>
        <span class="fp-chev">▾</span>
      </button>`;
      return i < phases.length - 1 ? node + `<span class="flow-link"></span>` : node;
    })
    .join("");
  return `<div class="section-label">Pipeline <span class="hint">— click a phase to expand its agents</span></div>
    <div class="flow" id="flow">
      <div class="flow-rail">${rail}</div>
      <div class="flow-expansion" id="flow-expansion" hidden></div>
    </div>`;
}

function renderFan(p) {
  const nodes = p.agents
    .map(
      (a, i) => `<button class="flow-node ${a.status}${a.live ? " pending" : ""}" ${a.live ? "" : `data-key="${escapeHtml(a.key)}"`} title="${escapeHtml(a.resultPreview || a.label)}" style="animation-delay:${Math.min(i * 12, 300)}ms">
        <span class="fn-dot ${a.status}"></span>
        <span class="fn-label">${escapeHtml(a.label)}</span>
      </button>`,
    )
    .join("");
  return `<svg class="fan-svg" aria-hidden="true"></svg>
    <div class="fan-hub">
      <span class="fh-dot"></span>
      <span class="fh-name">${escapeHtml(p.title)}</span>
      <span class="fh-count">${p.agents.length} agent${p.agents.length === 1 ? "" : "s"}</span>
    </div>
    <div class="fan-grid">${nodes}</div>`;
}

function togglePhase(idx) {
  if (state.expandedPhase === idx) {
    state.expandedPhase = null;
    const exp = el("flow-expansion");
    exp.hidden = true;
    exp.innerHTML = "";
    document.querySelectorAll(".flow-phase").forEach((b) => b.classList.remove("active"));
    return;
  }
  expandPhase(idx);
}

function expandPhase(idx) {
  const phases = mergedPhases();
  if (!phases || !phases[idx]) return;
  state.expandedPhase = idx;
  document.querySelectorAll(".flow-phase").forEach((b, i) => b.classList.toggle("active", i === idx));
  const exp = el("flow-expansion");
  exp.innerHTML = renderFan(phases[idx]);
  exp.hidden = false;
  positionPointer(idx);
  // Synchronous draw (getBoundingClientRect forces layout); a deferred pass catches font/wrap reflow.
  drawFan();
  requestAnimationFrame(drawFan);
}

// Aligns the expansion panel's pointer triangle under the active phase node.
function positionPointer(idx) {
  const btn = document.querySelectorAll(".flow-phase")[idx];
  const flow = el("flow");
  const exp = el("flow-expansion");
  if (!btn || !flow || !exp) return;
  const b = btn.getBoundingClientRect();
  const f = flow.getBoundingClientRect();
  exp.style.setProperty("--pointer-x", `${b.left + b.width / 2 - f.left}px`);
}

// Draws SVG curves from the phase hub out to every agent node (a fan-out).
function drawFan() {
  const exp = el("flow-expansion");
  if (!exp || exp.hidden) return;
  const svg = exp.querySelector(".fan-svg");
  const hub = exp.querySelector(".fan-hub");
  if (!svg || !hub) return;
  const base = exp.getBoundingClientRect();
  svg.setAttribute("width", String(base.width));
  svg.setAttribute("height", String(base.height));
  svg.setAttribute("viewBox", `0 0 ${base.width} ${base.height}`);
  const hb = hub.getBoundingClientRect();
  const sx = hb.right - base.left;
  const sy = hb.top + hb.height / 2 - base.top;
  let paths = "";
  for (const n of exp.querySelectorAll(".flow-node")) {
    const nb = n.getBoundingClientRect();
    const ex = nb.left - base.left;
    const ey = nb.top + nb.height / 2 - base.top;
    const c = Math.max((ex - sx) * 0.5, 18);
    paths += `<path class="fan-line" d="M${sx.toFixed(1)},${sy.toFixed(1)} C${(sx + c).toFixed(1)},${sy.toFixed(1)} ${(ex - c).toFixed(1)},${ey.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}"/>`;
  }
  svg.innerHTML = paths;
}

// Re-render the flow (merged journal + live agents) and restore the open phase + its fan.
function refreshFlow() {
  const section = el("flow-section");
  if (!section) return;
  const open = state.expandedPhase;
  const phases = mergedPhases();
  section.innerHTML = renderFlowSection(phases);
  state.expandedPhase = null;
  if (open != null && phases[open]) expandPhase(open);
}

/* ----------------------------- Drawer (agent detail) ----------------------------- */

async function openDrawer(key) {
  state.drawerKey = key;
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
    loadRuns().then(() => {
      if (!state.selectedRunId) selectRun(msg.runId); // auto-focus a freshly started run
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
      state.runData = data;
      // Re-render the pipeline flow (completed + running agents) without disturbing an open drawer.
      refreshFlow();
    } catch {
      /* ignore transient errors during a live run */
    }
  }, 350);
}

/* ----------------------------- Events / routing ----------------------------- */

document.addEventListener("click", (e) => {
  const runBtn = e.target.closest(".run-item");
  if (runBtn) return selectRun(runBtn.dataset.run);

  const node = e.target.closest(".flow-node");
  if (node) return node.dataset.key ? openDrawer(node.dataset.key) : undefined; // live nodes have no detail yet

  const phase = e.target.closest(".flow-phase");
  if (phase) return togglePhase(Number(phase.dataset.phaseIdx));

  if (e.target.closest("#drawer-close") || e.target.id === "drawer-scrim") return closeDrawer();

  const tab = e.target.closest(".tab");
  if (tab) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === tab.dataset.tab));
    if (tab.dataset.tab === "session") loadSession();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el("drawer").hidden) closeDrawer();
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
  if (state.expandedPhase == null) return;
  if (resizeRaf) cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    positionPointer(state.expandedPhase);
    drawFan();
  });
});

/* ----------------------------- Boot ----------------------------- */

(async function boot() {
  connectStream();
  const m = location.pathname.match(/^\/runs\/(.+)$/);
  await loadRuns(m ? decodeURIComponent(m[1]) : undefined);
})();
