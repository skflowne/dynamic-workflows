import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { fetchJson } from "./api";
import { escapeHtml, fmtDuration, fmtNum, fmtTime, highlightJson, looksLikeMarkdown, renderResultString, renderResultValue } from "./render";
import type {
  AgentDetail,
  AgentTokenGroup,
  AgentView,
  FlowAgentStatus,
  LiveAgent,
  LiveEvent,
  LiveSeed,
  ParsedSession,
  PhaseView,
  RunDetailResponse,
  RunRecord,
  RunSummary,
  RunTokenSummary,
  SessionItem,
  SessionMeta,
  TokenUsage,
  WorkflowProgressAgent,
  WorkflowProgressEvent,
} from "./types";

const MAX_LIVE_LOGS = 1000;

type DrawerTab = "result" | "prompt" | "session";

interface LoadState<T> {
  value?: T;
  error?: string;
  loading: boolean;
}

const emptyLoad = <T,>(): LoadState<T> => ({ loading: false });

export default function App(): ReactNode {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [streamStale, setStreamStale] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runData, setRunData] = useState<RunDetailResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [phaseExpansionTouched, setPhaseExpansionTouched] = useState(false);
  const [liveAgents, setLiveAgents] = useState<Map<string, LiveAgent>>(new Map());
  const [liveLogs, setLiveLogs] = useState<string[]>([]);
  const [tokenSummary, setTokenSummary] = useState<RunTokenSummary | null>(null);
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [drawerEntry, setDrawerEntry] = useState<LoadState<AgentDetail>>(emptyLoad);
  const [activeTab, setActiveTab] = useState<DrawerTab>("result");
  const [sessionState, setSessionState] = useState<LoadState<ParsedSession>>(emptyLoad);

  const selectedRunIdRef = useRef<string | null>(null);
  const runDataRef = useRef<RunDetailResponse | null>(null);
  const selectSeqRef = useRef(0);
  const drawerSeqRef = useRef(0);
  const refetchTimerRef = useRef<number | null>(null);
  const tokenTimerRef = useRef<number | null>(null);
  const tokenRefetchTimerRef = useRef<number | null>(null);
  const tokenFetchingRef = useRef(false);
  const sessionTimerRef = useRef<number | null>(null);
  const sessionFetchingRef = useRef(false);
  const flowRef = useRef<HTMLDivElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const logsRef = useRef<HTMLDivElement | null>(null);
  const lastFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    selectedRunIdRef.current = selectedRunId;
  }, [selectedRunId]);

  useEffect(() => {
    runDataRef.current = runData;
  }, [runData]);

  const stopTokenAutoRefresh = useCallback(() => {
    if (tokenTimerRef.current !== null) window.clearInterval(tokenTimerRef.current);
    if (tokenRefetchTimerRef.current !== null) window.clearTimeout(tokenRefetchTimerRef.current);
    tokenTimerRef.current = null;
    tokenRefetchTimerRef.current = null;
  }, []);

  const closeDrawer = useCallback(() => {
    drawerSeqRef.current++; // invalidate any in-flight openDrawer() fetch
    if (sessionTimerRef.current !== null) window.clearInterval(sessionTimerRef.current);
    sessionTimerRef.current = null;
    setDrawerKey(null);
    setDrawerEntry(emptyLoad<AgentDetail>());
    setSessionState(emptyLoad<ParsedSession>());
    setActiveTab("result");
    lastFocusRef.current?.focus();
    lastFocusRef.current = null;
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      const records = await fetchJson<RunSummary[]>("/api/runs");
      setRuns(records);
      setRunsError(null);
      return records;
    } catch (error) {
      // Caught here (not left to reject) so callers that chain off loadRuns() — in particular the
      // mount effect resolving a /runs/:id deep link — still run even when the sidebar list fails.
      setRunsError(errorMessage(error));
      return [];
    }
  }, []);

  const selectRun = useCallback(
    async (runId: string, push = true) => {
      const seq = ++selectSeqRef.current;
      stopTokenAutoRefresh();
      closeDrawer();
      setSelectedRunId(runId);
      selectedRunIdRef.current = runId;
      setExpandedPhases(new Set());
      setPhaseExpansionTouched(false);
      setLiveAgents(new Map());
      setLiveLogs([]);
      setTokenSummary(null);
      setRunError(null);
      setRunLoading(true);
      setSidebarOpen(false);
      if (push && location.pathname !== `/runs/${encodeURIComponent(runId)}`) {
        history.pushState({ runId }, "", `/runs/${encodeURIComponent(runId)}`);
      }
      try {
        const data = await fetchJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(runId)}`);
        if (seq !== selectSeqRef.current) return;
        const seed = seedLiveFromBuffer(data.live);
        setLiveLogs(seed.logs);
        setLiveAgents(seed.agents);
        setRunData(data);
      } catch (error) {
        if (seq !== selectSeqRef.current) return;
        setRunData(null);
        setRunError(errorMessage(error));
      } finally {
        if (seq === selectSeqRef.current) setRunLoading(false);
      }
    },
    [closeDrawer, stopTokenAutoRefresh],
  );

  const refreshTokenSummary = useCallback(async () => {
    const runId = selectedRunIdRef.current;
    if (!runId || tokenFetchingRef.current) return;
    tokenFetchingRef.current = true;
    try {
      const summary = await fetchJson<RunTokenSummary>(`/api/runs/${encodeURIComponent(runId)}/tokens`);
      if (runId === selectedRunIdRef.current) setTokenSummary(summary);
    } catch {
      // Token linkage is best-effort while session files are still being written.
    } finally {
      tokenFetchingRef.current = false;
    }
  }, []);

  const scheduleTokenRefetch = useCallback(
    (delay = 700) => {
      if (tokenRefetchTimerRef.current !== null) window.clearTimeout(tokenRefetchTimerRef.current);
      tokenRefetchTimerRef.current = window.setTimeout(() => {
        tokenRefetchTimerRef.current = null;
        void refreshTokenSummary();
      }, delay);
    },
    [refreshTokenSummary],
  );

  const patchSelectedRun = useCallback(async () => {
    const runId = selectedRunIdRef.current;
    if (!runId) return;
    try {
      const data = await fetchJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(runId)}`);
      if (runId === selectedRunIdRef.current) setRunData(data);
    } catch {
      // Ignore transient live-run read races.
    }
  }, []);

  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current !== null) return;
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null;
      void patchSelectedRun();
    }, 350);
  }, [patchSelectedRun]);

  const pollRunning = useCallback(async () => {
    const runId = selectedRunIdRef.current;
    if (!runId) return;
    let data: RunDetailResponse;
    try {
      data = await fetchJson<RunDetailResponse>(`/api/runs/${encodeURIComponent(runId)}`);
    } catch {
      return;
    }
    if (data.record.status === "running") {
      if (runId === selectedRunIdRef.current) setRunData(data);
    } else {
      await selectRun(runId, false);
      await loadRuns();
    }
  }, [loadRuns, selectRun]);

  const applyProgress = useCallback(
    (event: WorkflowProgressEvent | undefined) => {
      if (!event) return;
      if (event.type === "log") {
        // Cap at MAX_LIVE_LOGS: an unbounded `[...prev, x]` on every log line makes each append copy
        // an ever-growing array (O(n) per event, O(n^2) over the life of a long/chatty run). Slicing to
        // a fixed window keeps each copy — and the rendered log pane — bounded.
        setLiveLogs((prev) => (prev.length >= MAX_LIVE_LOGS ? [...prev.slice(prev.length - MAX_LIVE_LOGS + 1), event.message] : [...prev, event.message]));
        return;
      }
      if (event.type === "agent" && event.key) {
        setLiveAgents((prev) => rememberLiveAgent(prev, event));
        scheduleTokenRefetch();
      }
      scheduleRefetch();
    },
    [scheduleRefetch, scheduleTokenRefetch],
  );

  const handleLive = useCallback(
    (msg: LiveEvent) => {
      if (msg.type === "run-meta") {
        const current = selectedRunIdRef.current;
        const shouldSelect = msg.runId === current || !current;
        void loadRuns().then(() => {
          if (shouldSelect) void selectRun(msg.runId, Boolean(!current));
        });
        return;
      }
      if (msg.runId !== selectedRunIdRef.current) {
        if (msg.type === "run-finished") void loadRuns();
        return;
      }
      if (msg.type === "run-finished") {
        void selectRun(msg.runId, false);
        void loadRuns();
        return;
      }
      if (msg.type === "progress") applyProgress(msg.event);
    },
    [applyProgress, loadRuns, selectRun],
  );

  const openDrawer = useCallback(
    async (key: string) => {
      const runId = selectedRunIdRef.current;
      if (!runId) return;
      // Guard against a drawer-open race: if the user opens agent A then agent B before A's fetch
      // resolves, A's response must not clobber B's already-loading (or loaded) drawer state.
      const seq = ++drawerSeqRef.current;
      lastFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDrawerKey(key);
      setActiveTab("result");
      setSessionState(emptyLoad<ParsedSession>());
      setDrawerEntry({ loading: true });
      try {
        const entry = await fetchJson<AgentDetail>(`/api/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(key)}`);
        if (seq === drawerSeqRef.current && selectedRunIdRef.current === runId) setDrawerEntry({ value: entry, loading: false });
      } catch (error) {
        if (seq === drawerSeqRef.current) setDrawerEntry({ error: errorMessage(error), loading: false });
      }
    },
    [],
  );

  const loadSession = useCallback(async () => {
    const runId = selectedRunIdRef.current;
    if (!runId || !drawerKey || sessionFetchingRef.current) return;
    sessionFetchingRef.current = true;
    setSessionState((prev) => ({ ...prev, loading: !prev.value }));
    try {
      const session = await fetchJson<ParsedSession>(`/api/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(drawerKey)}/session`);
      if (selectedRunIdRef.current === runId) setSessionState({ value: session, loading: false });
    } catch (error) {
      setSessionState((prev) => ({
        ...(prev.value ? { value: prev.value } : {}),
        error: errorMessage(error),
        loading: false,
      }));
    } finally {
      sessionFetchingRef.current = false;
    }
  }, [drawerKey]);

  const copyText = useCallback(async (text: string, node: HTMLButtonElement) => {
    try {
      await navigator.clipboard.writeText(text);
      node.classList.add("copied");
      window.setTimeout(() => node.classList.remove("copied"), 900);
    } catch {
      // Clipboard access may be unavailable in some local browser contexts.
    }
  }, []);

  const merged = useMemo(() => mergedPhases(runData?.view.phases ?? [], liveAgents), [liveAgents, runData?.view.phases]);

  useEffect(() => {
    if (!phaseExpansionTouched && expandedPhases.size === 0 && merged.some((phase) => phase.agents.length > 0)) {
      setExpandedPhases(new Set(defaultExpandedPhases(merged)));
    }
  }, [expandedPhases.size, merged, phaseExpansionTouched]);

  useEffect(() => {
    void loadRuns().then(() => {
      const match = location.pathname.match(/^\/runs\/(.+)$/);
      if (match?.[1]) void selectRun(decodeURIComponent(match[1]), false);
    });
  }, [loadRuns, selectRun]);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = (event) => {
      setStreamStale(false);
      try {
        handleLive(JSON.parse(event.data) as LiveEvent);
      } catch {
        // Ignore malformed stream frames.
      }
    };
    es.onopen = () => setStreamStale(false);
    es.onerror = () => {
      // The browser's EventSource auto-reconnects on its own; just mark the stream stale so the live
      // indicator reflects it. The 3s polls (pollRunning / refreshTokenSummary / patchSelectedRun) keep
      // the view current in the meantime.
      setStreamStale(true);
    };
    return () => es.close();
  }, [handleLive]);

  useEffect(() => {
    const onPopState = () => {
      const match = location.pathname.match(/^\/runs\/(.+)$/);
      if (match?.[1]) void selectRun(decodeURIComponent(match[1]), false);
      else {
        setSelectedRunId(null);
        selectedRunIdRef.current = null;
        setRunData(null);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [selectRun]);

  useEffect(() => {
    const running = runData?.record.status === "running";
    void refreshTokenSummary();
    if (!running) {
      stopTokenAutoRefresh();
      return;
    }
    tokenTimerRef.current = window.setInterval(() => void refreshTokenSummary(), 3000);
    const pollTimer = window.setInterval(() => void pollRunning(), 3000);
    return () => {
      if (tokenTimerRef.current !== null) window.clearInterval(tokenTimerRef.current);
      tokenTimerRef.current = null;
      window.clearInterval(pollTimer);
    };
  }, [pollRunning, refreshTokenSummary, runData?.record.status, selectedRunId, stopTokenAutoRefresh]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(() => drawTreeBranches(flowRef.current));
    return () => window.cancelAnimationFrame(raf);
  }, [expandedPhases, merged]);

  useEffect(() => {
    let raf: number | null = null;
    const onResize = () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => drawTreeBranches(flowRef.current));
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  useEffect(() => {
    const logs = logsRef.current;
    if (logs) logs.scrollTop = logs.scrollHeight;
  }, [liveLogs]);

  useEffect(() => {
    if (drawerKey) window.requestAnimationFrame(() => closeButtonRef.current?.focus());
  }, [drawerKey]);

  useEffect(() => {
    if (activeTab === "session") void loadSession();
    else if (sessionTimerRef.current !== null) {
      window.clearInterval(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
  }, [activeTab, loadSession]);

  useEffect(() => {
    if (sessionTimerRef.current !== null) window.clearInterval(sessionTimerRef.current);
    sessionTimerRef.current = null;
    if (!drawerKey || activeTab !== "session" || runData?.record.status !== "running") return;
    sessionTimerRef.current = window.setInterval(() => void loadSession(), 2000);
    return () => {
      if (sessionTimerRef.current !== null) window.clearInterval(sessionTimerRef.current);
      sessionTimerRef.current = null;
    };
  }, [activeTab, drawerKey, loadSession, runData?.record.status]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        if (drawerKey) {
          closeDrawer();
          return;
        }
        if (sidebarOpen) setSidebarOpen(false);
      }
      if (event.key === "Tab" && drawerKey) trapDrawerFocus(event, drawerRef.current);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, drawerKey, sidebarOpen]);

  useEffect(
    () => () => {
      if (refetchTimerRef.current !== null) window.clearTimeout(refetchTimerRef.current);
      stopTokenAutoRefresh();
      if (sessionTimerRef.current !== null) window.clearInterval(sessionTimerRef.current);
    },
    [stopTokenAutoRefresh],
  );

  const liveActive = runData?.record.status === "running" && !streamStale;
  const visibleAgentCount = merged.reduce((sum, phase) => sum + phase.agents.length, 0);

  return (
    <div id="app">
      <header className="mobile-topbar">
        <button className="mobile-menu" aria-label="Open run history" aria-controls="sidebar" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(true)}>
          &#9776;
        </button>
        <div className="mobile-brand">Codex Workflow</div>
        <LiveDot active={liveActive} mobile />
      </header>

      <Sidebar
        runs={runs}
        error={runsError}
        onRetry={() => void loadRuns()}
        filter={filter}
        selectedRunId={selectedRunId}
        open={sidebarOpen}
        liveActive={liveActive}
        onFilter={setFilter}
        onSelect={(runId) => void selectRun(runId)}
      />

      <main className="main" id="main">
        {!selectedRunId ? (
          <EmptyState />
        ) : (
          <RunView
            data={runData}
            error={runError}
            loading={runLoading}
            phases={merged}
            expandedPhases={expandedPhases}
            visibleAgentCount={visibleAgentCount}
            tokenSummary={tokenSummary}
            liveLogs={liveLogs}
            flowRef={flowRef}
            logsRef={logsRef}
            onTogglePhase={(title) => {
              setPhaseExpansionTouched(true);
              setExpandedPhases((prev) => {
                const next = new Set(prev);
                if (next.has(title)) next.delete(title);
                else next.add(title);
                return next;
              });
            }}
            onOpenAgent={(key) => void openDrawer(key)}
            onCopy={copyText}
          />
        )}
      </main>

      {sidebarOpen ? <button className="sidebar-scrim" aria-label="Close run history" onClick={() => setSidebarOpen(false)} /> : null}
      {drawerKey ? <button className="drawer-scrim" aria-label="Close agent detail" onClick={closeDrawer} /> : null}
      {drawerKey ? (
        <Drawer
          drawerRef={drawerRef}
          closeButtonRef={closeButtonRef}
          entry={drawerEntry}
          activeTab={activeTab}
          sessionState={sessionState}
          onClose={closeDrawer}
          onTab={setActiveTab}
        />
      ) : null}
    </div>
  );
}

function Sidebar(props: {
  runs: RunSummary[];
  error: string | null;
  onRetry: () => void;
  filter: string;
  selectedRunId: string | null;
  open: boolean;
  liveActive: boolean;
  onFilter: (value: string) => void;
  onSelect: (runId: string) => void;
}): ReactNode {
  const filtered = props.runs.filter((run) => {
    const query = props.filter.toLowerCase();
    return !query || run.name.toLowerCase().includes(query) || run.runId.toLowerCase().includes(query);
  });
  return (
    <aside className={`sidebar${props.open ? " open" : ""}`} id="sidebar">
      <header className="sidebar-head">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            *
          </span>
          <div className="brand-text">
            <div className="brand-title">Codex Workflow</div>
            <div className="brand-sub">run viewer</div>
          </div>
        </div>
        <LiveDot active={props.liveActive} />
      </header>
      <div className="sidebar-search">
        <input type="search" placeholder="Filter runs..." autoComplete="off" value={props.filter} onChange={(event) => props.onFilter(event.currentTarget.value)} />
      </div>
      {props.error ? (
        <div className="sidebar-error" role="alert">
          <span>Failed to load run history: {props.error}</span>
          <button type="button" onClick={props.onRetry}>
            Retry
          </button>
        </div>
      ) : null}
      <nav className="run-list" aria-label="Run history">
        {filtered.length === 0 ? (
          <div className="muted-note">{props.error ? "Could not load runs." : "No matching runs."}</div>
        ) : (
          filtered.map((run) => {
            const agents = run.agentCount != null ? `${run.agentCount} agents` : run.status === "running" ? "running..." : "";
            return (
              <button key={run.runId} className={`run-item${run.runId === props.selectedRunId ? " active" : ""}`} onClick={() => props.onSelect(run.runId)}>
                <div className="run-item-top">
                  <span className={`status-dot ${run.status}`} />
                  <span className="run-item-name">{run.name}</span>
                </div>
                <div className="run-item-meta">
                  {fmtTime(run.startedAt)} · {fmtDuration(run.durationMs)}
                  {agents ? ` · ${agents}` : ""}
                </div>
              </button>
            );
          })
        )}
      </nav>
      <footer className="sidebar-foot">
        {props.runs.length} run{props.runs.length === 1 ? "" : "s"} recorded
      </footer>
    </aside>
  );
}

function LiveDot({ active, mobile = false }: { active: boolean; mobile?: boolean }): ReactNode {
  return (
    <div className={`live-dot${mobile ? " mobile-live" : ""}${active ? " active" : ""}`} title="live stream">
      <span className="dot" />
      <span className="live-label">live</span>
    </div>
  );
}

function EmptyState(): ReactNode {
  return (
    <div className="empty-state">
      <div className="empty-mark">*</div>
      <h1>Select a run</h1>
      <p>Run details, agent progress, logs, and linked Codex sessions appear here.</p>
    </div>
  );
}

function RunView(props: {
  data: RunDetailResponse | null;
  error: string | null;
  loading: boolean;
  phases: PhaseView[];
  expandedPhases: Set<string>;
  visibleAgentCount: number;
  tokenSummary: RunTokenSummary | null;
  liveLogs: string[];
  flowRef: React.RefObject<HTMLDivElement | null>;
  logsRef: React.RefObject<HTMLDivElement | null>;
  onTogglePhase: (title: string) => void;
  onOpenAgent: (key: string) => void;
  onCopy: (text: string, node: HTMLButtonElement) => void;
}): ReactNode {
  if (props.loading && !props.data) return <section className="run-view"><div className="loading">Loading run</div></section>;
  if (props.error) return <section className="run-view"><div className="muted-note">Could not load run: {props.error}</div></section>;
  if (!props.data) return <section className="run-view"><div className="muted-note">No run selected.</div></section>;

  const { record, view } = props.data;
  const hasResult = record.result !== undefined && record.result !== null;

  return (
    <section className="run-view">
      <div className="rv-head">
        <div className="rv-eyebrow">{record.source || "workflow"}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <h1 className="rv-title">{record.name}</h1>
          <span className={`pill ${record.status}`}>
            <span className={`status-dot ${record.status}`} />
            {record.status}
          </span>
          <span className="rv-stats">
            <HeadStats record={record} stats={view.stats} visibleAgentCount={props.visibleAgentCount} />
          </span>
        </div>
        {record.description ? <p className="rv-desc">{record.description}</p> : null}
        <RunMeta record={record} onCopy={props.onCopy} />
      </div>

      <TokenSection summary={props.tokenSummary} />
      <InputSection record={record} />
      <FlowSection phases={props.phases} expandedPhases={props.expandedPhases} flowRef={props.flowRef} onTogglePhase={props.onTogglePhase} onOpenAgent={props.onOpenAgent} />
      {hasResult ? (
        <>
          <ResultSection record={record} />
          <Logs record={record} liveLogs={props.liveLogs} logsRef={props.logsRef} />
        </>
      ) : (
        <>
          <Logs record={record} liveLogs={props.liveLogs} logsRef={props.logsRef} />
          <ResultSection record={record} />
        </>
      )}
    </section>
  );
}

function HeadStats({ record, stats, visibleAgentCount }: { record: RunRecord; stats: { agentCount: number; cacheHits: number; durationMs?: number }; visibleAgentCount: number }): ReactNode {
  const duration = stats.durationMs ?? (record.status === "running" && record.startedAt ? Date.now() - record.startedAt : undefined);
  return (
    <>
      <span className="rv-stat">
        <b>{fmtNum(Math.max(stats.agentCount ?? 0, visibleAgentCount))}</b> agents
      </span>
      <span className="rv-stat-sep">·</span>
      <span className="rv-stat">
        <b>{fmtDuration(duration)}</b>
      </span>
      {stats.cacheHits ? (
        <>
          <span className="rv-stat-sep">·</span>
          <span className="rv-stat">
            <b>{fmtNum(stats.cacheHits)}</b> cache hits
          </span>
        </>
      ) : null}
    </>
  );
}

function RunMeta({ record, onCopy }: { record: RunRecord; onCopy: (text: string, node: HTMLButtonElement) => void }): ReactNode {
  return (
    <div className="rv-meta-row">
      <CopyChip label="run" value={record.runId} onCopy={onCopy} />
      {record.scriptPath ? <CopyChip label="script" value={record.scriptPath} onCopy={onCopy} /> : null}
    </div>
  );
}

function CopyChip({ label, value, onCopy }: { label: string; value: string; onCopy: (text: string, node: HTMLButtonElement) => void }): ReactNode {
  return (
    <button className="meta-chip" title={`Copy ${label}`} onClick={(event) => void onCopy(value, event.currentTarget)}>
      <span className="meta-label">{label}</span>
      <span className="meta-value">{value}</span>
    </button>
  );
}

function TokenSection({ summary }: { summary: RunTokenSummary | null }): ReactNode {
  if (summary && summary.agentCount === 0) return null;
  if (!summary) {
    return (
      <>
        <div className="section-label">
          Agent tokens <span className="hint">linking session traces...</span>
        </div>
        <div className="token-board loading">Waiting for token usage.</div>
      </>
    );
  }
  const pending = summary.pendingCount ? ` · ${fmtNum(summary.pendingCount)} pending` : "";
  return (
    <>
      <div className="section-label">
        Agent tokens <span className="hint">{fmtNum(summary.withUsage)}/{fmtNum(summary.agentCount)} agents linked{pending}</span>
      </div>
      <div className="token-board">
        <div className="token-total-row">
          <TokenMetric label="total" value={summary.totals?.totalTokens} />
          <TokenMetric label="input" value={summary.totals?.inputTokens} />
          <TokenMetric label="output" value={summary.totals?.outputTokens} />
          <TokenMetric label="reasoning" value={summary.totals?.reasoningOutputTokens} />
          <TokenMetric label="cached" value={summary.totals?.cachedInputTokens} />
        </div>
        {summary.groups?.length ? (
          <div className="token-groups">{summary.groups.map((group) => <TokenGroup group={group} key={`${group.backend}\0${group.model}`} />)}</div>
        ) : (
          <div className="token-empty">No linked token usage yet.</div>
        )}
      </div>
    </>
  );
}

function TokenGroup({ group }: { group: AgentTokenGroup }): ReactNode {
  return (
    <div className="token-group">
      <div className="token-model">
        <span className="token-backend">{group.backend}</span>
        <strong>{group.model}</strong>
        {group.provider ? <span className="token-provider">{group.provider}</span> : null}
        <span className="token-agents">{fmtNum(group.withUsage)}/{fmtNum(group.agentCount)} agents</span>
        {group.pendingCount ? <span className="tag">{fmtNum(group.pendingCount)} pending</span> : null}
      </div>
      <div className="token-metrics">
        <TokenMetric label="total" value={group.usage?.totalTokens} />
        <TokenMetric label="input" value={group.usage?.inputTokens} />
        <TokenMetric label="output" value={group.usage?.outputTokens} />
        <TokenMetric label="reasoning" value={group.usage?.reasoningOutputTokens} />
        <TokenMetric label="cached" value={group.usage?.cachedInputTokens} />
      </div>
    </div>
  );
}

function TokenMetric({ label, value }: { label: string; value: number | undefined }): ReactNode {
  return (
    <div className="token-metric">
      <div className="tm-value">{fmtNum(value)}</div>
      <div className="tm-label">{label}</div>
    </div>
  );
}

function InputSection({ record }: { record: RunRecord }): ReactNode {
  if (record.args === undefined || record.args === null) return null;
  return (
    <>
      <div className="section-label">Input</div>
      <Html className="result-card" html={renderResultValue(record.args)} />
    </>
  );
}

function ResultSection({ record }: { record: RunRecord }): ReactNode {
  if (record.status === "running") return null;
  const result = record.result;
  if (result === undefined || result === null) {
    if (record.status !== "completed") return null;
    return (
      <>
        <div className="section-label">Result</div>
        <div className="result-card">
          <div className="muted-note">No final result was recorded for this run.</div>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="section-label">Result</div>
      <div className="result-card">
        <Html html={renderResultValue(result)} />
        <details className="result-raw">
          <summary>Raw JSON</summary>
          <Html className="json-block" html={highlightJson(result)} />
        </details>
      </div>
    </>
  );
}

function Logs({ record, liveLogs, logsRef }: { record: RunRecord; liveLogs: string[]; logsRef: React.RefObject<HTMLDivElement | null> }): ReactNode {
  const persisted = record.logs && record.logs.length ? record.logs : [];
  const logs = persisted.length ? persisted : liveLogs;
  if (!logs.length && record.status !== "running") return null;
  return (
    <>
      <div className="section-label">Workflow log</div>
      <div className="logs" id="logs-box" ref={logsRef}>
        {logs.length ? logs.map((line, index) => <div className="log-line" key={`${index}:${line}`}>{line}</div>) : <div className="log-empty">waiting for log output...</div>}
      </div>
    </>
  );
}

function FlowSection(props: {
  phases: PhaseView[];
  expandedPhases: Set<string>;
  flowRef: React.RefObject<HTMLDivElement | null>;
  onTogglePhase: (title: string) => void;
  onOpenAgent: (key: string) => void;
}): ReactNode {
  if (!props.phases.length) return <div className="muted-note">No agents recorded yet.</div>;
  return (
    <>
      <div className="section-label">Pipeline</div>
      <div className="flow flow-tree" id="flow" ref={props.flowRef}>
        {props.phases.map((phase, index) => (
          <PhaseBranch
            key={phase.title}
            phase={phase}
            index={index}
            total={props.phases.length}
            expanded={props.expandedPhases.has(phase.title)}
            onTogglePhase={props.onTogglePhase}
            onOpenAgent={props.onOpenAgent}
          />
        ))}
      </div>
    </>
  );
}

function PhaseBranch(props: {
  phase: PhaseView;
  index: number;
  total: number;
  expanded: boolean;
  onTogglePhase: (title: string) => void;
  onOpenAgent: (key: string) => void;
}): ReactNode {
  const badge = phaseBadge(props.phase);
  return (
    <div className={`flow-branch${props.expanded ? " expanded" : ""}${badge.pending ? " pending" : ""}${badge.inProgress ? " in-progress" : ""}`} data-phase-title={props.phase.title}>
      <svg className="tree-svg" aria-hidden="true" />
      <div className={`branch-axis${props.index === 0 ? " first" : ""}${props.index === props.total - 1 ? " last" : ""}`}>
        <span className="axis-line" />
        <button
          className={`flow-phase${badge.inProgress ? " in-progress" : ""}${badge.pending ? " pending" : ""}${props.expanded ? " active" : ""}`}
          aria-expanded={props.expanded}
          onClick={() => props.onTogglePhase(props.phase.title)}
        >
          <span className="fp-dot" />
          <span className="fp-name">{props.phase.title}</span>
          {badge.pending ? null : <span className="fp-count">{badge.badge}</span>}
          <span className="fp-chev">v</span>
        </button>
      </div>
      <div className="branch-panel" hidden={!props.expanded}>
        {props.expanded ? <Fan phase={props.phase} onOpenAgent={props.onOpenAgent} /> : null}
      </div>
    </div>
  );
}

function Fan({ phase, onOpenAgent }: { phase: PhaseView; onOpenAgent: (key: string) => void }): ReactNode {
  const visible = visibleAgents(phase);
  const compact = phase.agents.length > 48 ? " compact" : "";
  return (
    <div className="fan-main">
      <div className={`fan-grid${compact}`}>
        {visible.length ? visible.map((agent, index) => <AgentNode key={agent.key} agent={agent} delayMs={Math.min(index * 12, 300)} onOpenAgent={onOpenAgent} />) : <div className="muted-note">No agents.</div>}
      </div>
      {phase.agents.length > visible.length ? <div className="fan-note">Showing first {visible.length} of {fmtNum(phase.agents.length)} agents.</div> : null}
    </div>
  );
}

function AgentNode({ agent, delayMs, onOpenAgent }: { agent: AgentView; delayMs: number; onOpenAgent: (key: string) => void }): ReactNode {
  return (
    <button className={nodeClassName(agent)} data-key={agent.key} data-live={agent.live ? "1" : undefined} title={nodeTitle(agent)} style={{ animationDelay: `${delayMs}ms` }} onClick={() => onOpenAgent(agent.key)}>
      <span className={`fn-dot ${agent.status}`} />
      <span className="fn-label">{agent.label}</span>
    </button>
  );
}

function Drawer(props: {
  drawerRef: React.RefObject<HTMLElement | null>;
  closeButtonRef: React.RefObject<HTMLButtonElement | null>;
  entry: LoadState<AgentDetail>;
  activeTab: DrawerTab;
  sessionState: LoadState<ParsedSession>;
  onClose: () => void;
  onTab: (tab: DrawerTab) => void;
}): ReactNode {
  const entry = props.entry.value;
  const options = entry?.options ?? {};
  return (
    <aside className="drawer" aria-label="Agent detail" ref={props.drawerRef}>
      {props.entry.loading ? (
        <div className="loading">Loading agent</div>
      ) : props.entry.error ? (
        <div className="muted-note">{props.entry.error}</div>
      ) : entry ? (
        <>
          <div className="drawer-head">
            <div className="dh-top">
              <div className="drawer-title">{options.label || "agent"}</div>
              <button className="drawer-close" aria-label="Close" ref={props.closeButtonRef} onClick={props.onClose}>
                x
              </button>
            </div>
            <div className="drawer-meta">
              {options.phase ? <span className="tag">{options.phase}</span> : null}
              {options.model ? <span className="tag">{options.model}</span> : null}
              {entry.sessionId ? <span className="tag session">session {entry.sessionId.slice(0, 8)}</span> : null}
            </div>
          </div>
          <div className="tabs">
            <TabButton tab="result" active={props.activeTab} onTab={props.onTab}>Result</TabButton>
            <TabButton tab="prompt" active={props.activeTab} onTab={props.onTab}>Prompt</TabButton>
            <TabButton tab="session" active={props.activeTab} onTab={props.onTab}>Session</TabButton>
          </div>
          <div className="drawer-body">
            <Panel name="result" active={props.activeTab}>
              <DrawerResult result={entry.result} />
            </Panel>
            <Panel name="prompt" active={props.activeTab}>
              <div className="codeblock">{entry.prompt}</div>
            </Panel>
            <Panel name="session" active={props.activeTab}>
              <SessionPanel state={props.sessionState} />
            </Panel>
          </div>
        </>
      ) : null}
    </aside>
  );
}

function TabButton({ tab, active, onTab, children }: { tab: DrawerTab; active: DrawerTab; onTab: (tab: DrawerTab) => void; children: ReactNode }): ReactNode {
  return (
    <button className={`tab${active === tab ? " active" : ""}`} onClick={() => onTab(tab)}>
      {children}
    </button>
  );
}

function Panel({ name, active, children }: { name: DrawerTab; active: DrawerTab; children: ReactNode }): ReactNode {
  return (
    <div className={`panel${active === name ? " active" : ""}`} data-panel={name}>
      {children}
    </div>
  );
}

function DrawerResult({ result }: { result: unknown }): ReactNode {
  if (result === undefined) return <div className="muted-note">No result yet.</div>;
  if (typeof result === "string" && looksLikeMarkdown(result)) return <Html className="drawer-result-markdown" html={renderResultString(result)} />;
  if (typeof result === "string") return <div className="codeblock">{result}</div>;
  return <Html className="json-block" html={highlightJson(result)} />;
}

function SessionPanel({ state }: { state: LoadState<ParsedSession> }): ReactNode {
  if (state.loading && !state.value) return <div className="loading" id="session-loading">Linking session</div>;
  if (!state.value) {
    return (
      <div className="muted-note">
        No linked session trace.
        {state.error ? <><br /><span style={{ fontSize: "11.5px" }}>{state.error}</span></> : null}
      </div>
    );
  }
  return (
    <>
      <SessionMetaView meta={state.value.meta} />
      <SessionUsage usage={state.value.usage} />
      <div className="timeline" id="session-timeline" data-count={state.value.items.length}>
        {state.value.items.length ? state.value.items.map((item, index) => <SessionItemView item={item} key={sessionItemKey(item, index)} />) : <div className="muted-note">Session has no displayable items.</div>}
      </div>
    </>
  );
}

function SessionMetaView({ meta }: { meta: SessionMeta }): ReactNode {
  return (
    <div className="drawer-meta" style={{ marginBottom: 14 }}>
      {meta.id ? <span className="tag">{meta.id}</span> : null}
      {meta.model || meta.modelProvider ? <span className="tag">model: {meta.model || meta.modelProvider}</span> : null}
      {meta.effort ? <span className="tag effort">effort: {meta.effort}</span> : null}
      {meta.cliVersion ? <span className="tag">codex {meta.cliVersion}</span> : null}
    </div>
  );
}

function SessionUsage({ usage }: { usage: TokenUsage | undefined }): ReactNode {
  if (!usage) return null;
  return (
    <div className="usage-bar" id="session-usage">
      <UsageMetric label="total tokens" value={usage.totalTokens} />
      <UsageMetric label="input" value={usage.inputTokens} />
      <UsageMetric label="output" value={usage.outputTokens} />
      <UsageMetric label="reasoning" value={usage.reasoningOutputTokens} />
      <UsageMetric label="cached" value={usage.cachedInputTokens} />
    </div>
  );
}

function UsageMetric({ label, value }: { label: string; value: number | undefined }): ReactNode {
  return (
    <div className="u">
      <div className="uv">{fmtNum(value)}</div>
      <div className="ul">{label}</div>
    </div>
  );
}

const expandedRoles = new Set(["user", "assistant", "developer", "system"]);

function SessionItemView({ item }: { item: SessionItem }): ReactNode {
  if (item.kind === "message") {
    const head = <span className="tl-badge">{item.role || "unknown"}</span>;
    if (!expandedRoles.has(item.role)) return <CollapsibleItem className={`role-${item.role}`} head={head} body={<>{item.text}</>} />;
    return (
      <div className={`tl-item role-${item.role}`}>
        <div className="tl-head">{head}</div>
        <div className="tl-body">{item.text}</div>
      </div>
    );
  }
  if (item.kind === "reasoning") return <CollapsibleItem className="reasoning" head="* reasoning" body={item.summary} />;
  if (item.kind === "web_search") {
    const queries = uniqueStrings([item.query, ...(item.queries ?? [])]);
    const head = <><span className="tl-badge">web search</span>{item.status ?? ""}</>;
    const body = queries.length ? queries.map((query) => <div className="search-q" key={query}>{query}</div>) : <span className="muted-note">search</span>;
    return <CollapsibleItem className="web_search" head={head} body={body} />;
  }
  if (item.kind === "function_call") {
    const args = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments, null, 2);
    return <CollapsibleItem className="tool" head={`cmd ${item.name}`} body={args} />;
  }
  if (item.kind === "function_call_output") return <CollapsibleItem className="tool" head={`output${item.truncated ? " (truncated)" : ""}`} body={item.output} />;
  return <CollapsibleItem className="other" head={`item ${item.itemType || "item"}`} body={item.raw} />;
}

function CollapsibleItem({ className, head, body }: { className: string; head: ReactNode; body: ReactNode }): ReactNode {
  return (
    <details className={`tl-item ${className} collapsible`}>
      <summary className="tl-head">{head}</summary>
      <div className="tl-body">{body}</div>
    </details>
  );
}

function Html({ html, className }: { html: string; className?: string }): ReactNode {
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

function seedLiveFromBuffer(buffer: LiveEvent[]): LiveSeed {
  let logs: string[] = [];
  let agents = new Map<string, LiveAgent>();
  for (const event of buffer) {
    if (event.type === "run-meta") {
      logs = [];
      agents = new Map();
      continue;
    }
    if (event.type === "run-finished") {
      agents = new Map();
      continue;
    }
    if (event.type !== "progress" || !event.event) continue;
    if (event.event.type === "log") logs.push(event.event.message);
    else if (event.event.type === "agent" && event.event.key) agents = rememberLiveAgent(agents, event.event);
  }
  return { logs, agents };
}

function rememberLiveAgent(prev: Map<string, LiveAgent>, event: WorkflowProgressAgent): Map<string, LiveAgent> {
  if (!event.key) return prev;
  const next = new Map(prev);
  const old = next.get(event.key);
  const options = event.options || old?.options;
  const result = event.result ?? old?.result;
  next.set(event.key, {
    ...old,
    key: event.key,
    label: event.label || old?.label || "agent",
    state: event.state || old?.state || "started",
    ...(result !== undefined ? { result } : {}),
    ...optionalString("phase", event.phase || old?.phase),
    ...optionalString("backend", event.backend || old?.backend),
    ...optionalString("prompt", event.prompt ?? old?.prompt),
    ...(options ? { options } : {}),
    ...optionalString("sessionId", event.sessionId || old?.sessionId),
    ...optionalString("error", event.error || old?.error),
  });
  return next;
}

function mergedPhases(base: PhaseView[], liveAgents: Map<string, LiveAgent>): PhaseView[] {
  const phases = base.map((phase) => ({ title: phase.title, agents: phase.agents.slice() }));
  if (liveAgents.size === 0) return phases;
  const journalKeys = new Set<string>();
  for (const phase of phases) for (const agent of phase.agents) journalKeys.add(agent.key);
  const byTitle = new Map<string, PhaseView>(phases.map((phase) => [phase.title, phase]));
  for (const live of liveAgents.values()) {
    if (journalKeys.has(live.key)) continue;
    const title = live.phase || "Other";
    let group = byTitle.get(title);
    if (!group) {
      group = { title, agents: [] };
      byTitle.set(title, group);
      phases.push(group);
    }
    group.agents.push({
      key: live.key,
      label: live.label,
      status: live.state === "failed" ? "failed" : live.state === "started" ? "running" : "ok",
      resultPreview: live.state === "started" ? "running..." : "",
      hasSchema: Boolean(live.options?.schema),
      hasSession: Boolean(live.sessionId),
      live: true,
      createdAt: 0,
      ...(live.phase ? { phase: live.phase } : {}),
      ...(live.sessionId ? { sessionId: live.sessionId } : {}),
    });
  }
  return phases;
}

function optionalString<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return value ? { [key]: value } as { [P in K]?: string } : {};
}

function phaseBadge(phase: PhaseView): { total: number; done: number; pending: boolean; inProgress: boolean; badge: string } {
  const total = phase.agents.length;
  const done = phase.agents.filter((agent) => agent.status !== "running").length;
  const pending = total === 0;
  return { total, done, pending, inProgress: done < total, badge: pending ? "" : done < total ? `${done}/${total}` : `${total}` };
}

function defaultExpandedPhases(phases: PhaseView[]): string[] {
  return phases.filter((phase) => phase.agents.length > 0).map((phase) => phase.title);
}

function visibleAgents(phase: PhaseView): AgentView[] {
  return phase.agents.slice(0, 180);
}

function nodeClassName(agent: AgentView): string {
  return `flow-node ${agent.status}${agent.live ? " pending" : ""}`;
}

function nodeTitle(agent: AgentView): string {
  return agent.resultPreview || agent.label;
}

function drawTreeBranches(flow: HTMLDivElement | null): void {
  if (!flow) return;
  for (const branch of flow.querySelectorAll<HTMLElement>(".flow-branch")) {
    if (branch.classList.contains("expanded")) drawTreeBranch(branch);
    else clearTreeBranch(branch);
  }
}

function clearTreeBranch(branch: HTMLElement): void {
  const svg = branch.querySelector<SVGSVGElement>(".tree-svg");
  if (svg) svg.innerHTML = "";
}

function drawTreeBranch(branch: HTMLElement): void {
  const svg = branch.querySelector<SVGSVGElement>(".tree-svg");
  const phase = branch.querySelector<HTMLElement>(".flow-phase");
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
  for (const node of branch.querySelectorAll<HTMLElement>(".flow-node")) {
    const nb = node.getBoundingClientRect();
    const ex = nb.left - base.left - 4;
    const ey = nb.top + nb.height / 2 - base.top;
    const c = Math.max((ex - sx) * 0.5, 18);
    paths += `<path class="tree-line" d="M${sx.toFixed(1)},${sy.toFixed(1)} C${(sx + c).toFixed(1)},${sy.toFixed(1)} ${(ex - c).toFixed(1)},${ey.toFixed(1)} ${ex.toFixed(1)},${ey.toFixed(1)}"/>`;
  }
  svg.innerHTML = paths;
}

function trapDrawerFocus(event: globalThis.KeyboardEvent, drawer: HTMLElement | null): void {
  if (!drawer) return;
  const focusable = [...drawer.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])')].filter(
    (node) => !node.hasAttribute("disabled") && node.offsetParent !== null,
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
}

function sessionItemKey(item: SessionItem, index: number): string {
  if (item.kind === "function_call" || item.kind === "function_call_output") return `${item.kind}:${item.callId ?? index}`;
  if (item.kind === "message") return `${item.kind}:${item.role}:${index}`;
  return `${item.kind}:${index}`;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
