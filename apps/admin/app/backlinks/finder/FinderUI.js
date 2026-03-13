"use client";

import { useEffect, useMemo, useState } from "react";

const PAGE_SIZE = 50;

const TEMPLATE_PRESETS = {
  blog_comments: {
    label: "Blog Comments",
    template: "{keyword} \"leave a comment\" blog",
  },
  leave_reply: {
    label: "Leave a Reply",
    template: "{keyword} \"leave a reply\"",
  },
  forums: {
    label: "Forums",
    template: "inurl:forum \"register\" {keyword}",
  },
  write_for_us: {
    label: "Write for Us",
    template: "\"write for us\" {keyword}",
  },
  custom: {
    label: "Custom",
    template: "",
  },
};

const ENGINE_OPTIONS = [
  { value: "duckduckgo", label: "DuckDuckGo" },
  { value: "bing", label: "Bing" },
];

function toRelativeTime(input) {
  const value = new Date(String(input || "")).getTime();
  if (!Number.isFinite(value) || value <= 0) return "-";
  const diffSec = Math.floor((Date.now() - value) / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const min = Math.floor(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function formatDateTime(input) {
  const date = new Date(String(input || ""));
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

function shortRunId(runId) {
  const raw = String(runId || "");
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

function normalizeKeywordsText(raw) {
  return String(raw || "").split(/[\n,]+/g).map((v) => v.trim()).filter(Boolean);
}

function StatusChip({ status }) {
  const s = String(status || "").toLowerCase();
  const colors = {
    running: { bg: "#dbeafe", color: "#1d4ed8", border: "#bfdbfe" },
    completed: { bg: "#dcfce7", color: "#15803d", border: "#bbf7d0" },
    failed: { bg: "#fee2e2", color: "#b91c1c", border: "#fecaca" },
    no_results: { bg: "#fef9c3", color: "#854d0e", border: "#fef08a" },
    pending_verification: { bg: "#fef3c7", color: "#92400e", border: "#fde68a" },
    queued: { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" },
  };
  const style = colors[s] || colors.queued;
  return (
    <span style={{
      display: "inline-block", padding: "2px 10px", borderRadius: 20, fontSize: 12,
      fontWeight: 600, background: style.bg, color: style.color, border: `1px solid ${style.border}`,
    }}>
      {status || "queued"}
    </span>
  );
}

export default function BacklinksFinderUI() {
  const [keywords, setKeywords] = useState("");
  const [engine, setEngine] = useState("bing");
  const [maxResults, setMaxResults] = useState(50);
  const [headless, setHeadless] = useState(true);
  const [includeAllSites, setIncludeAllSites] = useState(true);
  const [preset, setPreset] = useState("blog_comments");
  const [customTemplate, setCustomTemplate] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [activeRun, setActiveRun] = useState(null);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const appliedTemplate = useMemo(() => {
    if (preset === "custom") return String(customTemplate || "").trim();
    return TEMPLATE_PRESETS[preset]?.template || TEMPLATE_PRESETS.blog_comments.template;
  }, [preset, customTemplate]);

  async function loadRuns({ silent = false } = {}) {
    if (!silent) setLoadingRuns(true);
    try {
      const res = await fetch("/api/backlinks-finder/runs", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to load runs");
      const nextRuns = Array.isArray(data.runs) ? data.runs : [];
      setRuns(nextRuns);
      if (!activeRunId && nextRuns.length) setActiveRunId(String(nextRuns[0].run_id || ""));
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (!silent) setLoadingRuns(false);
    }
  }

  async function loadRun(runId, { silent = false } = {}) {
    if (!runId) { setActiveRun(null); return; }
    if (!silent) setLoadingRun(true);
    try {
      const res = await fetch(`/api/backlinks-finder/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to load run");
      setActiveRun(data.run || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (!silent) setLoadingRun(false);
    }
  }

  useEffect(() => { loadRuns(); }, []);
  useEffect(() => { loadRun(activeRunId); setPage(1); setSelectedIds(new Set()); }, [activeRunId]);

  const activeRunSummary = useMemo(() => runs.find((r) => String(r.run_id || "") === String(activeRunId || "")) || null, [runs, activeRunId]);
  const isRunning = String(activeRunSummary?.status || activeRun?.status || "") === "running";

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => { loadRuns({ silent: true }); if (activeRunId) loadRun(activeRunId, { silent: true }); }, 3000);
    return () => clearInterval(t);
  }, [isRunning, activeRunId]);

  const links = useMemo(() => Array.isArray(activeRun?.links) ? activeRun.links : [], [activeRun]);
  const filteredLinks = useMemo(() => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return links;
    return links.filter((item) => [item.keyword, item.query, item.url, item.domain, item.title, item.status, item.engine]
      .map((v) => String(v || "").toLowerCase()).join(" ").includes(q));
  }, [links, query]);

  const totalPages = Math.max(1, Math.ceil(filteredLinks.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageLinks = useMemo(() => filteredLinks.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filteredLinks, safePage]);
  const pageSelectedCount = pageLinks.filter((item) => selectedIds.has(String(item?.id || ""))).length;

  function setPresetSafe(key) {
    setPreset(key);
    if (key !== "custom") setCustomTemplate(TEMPLATE_PRESETS[key]?.template || "");
  }

  async function startRun() {
    setError(""); setMessage("");
    const kws = normalizeKeywordsText(keywords);
    if (!kws.length) { setError("Please enter at least one keyword."); return; }
    if (!appliedTemplate) { setError("Template cannot be empty."); return; }
    setBusyAction("run");
    try {
      const res = await fetch("/api/backlinks-finder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: kws, template: appliedTemplate, engine,
          options: { results_per_keyword: Number(maxResults || 50), headless: Boolean(headless), include_all_sites: Boolean(includeAllSites), min_delay_ms: 0, max_delay_ms: 0 },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start run");
      const runId = String(data.run_id || "");
      setMessage(`Run started: ${runId}`);
      await loadRuns({ silent: true });
      setActiveRunId(runId);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusyAction("");
    }
  }

  async function enqueueSelected() {
    if (!activeRunId || !selectedIds.size) return;
    setBusyAction("enqueue"); setError(""); setMessage("");
    try {
      const res = await fetch("/api/backlinks-finder/enqueue", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRunId, link_ids: [...selectedIds] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to enqueue");
      setSelectedIds(new Set());
      setMessage(`Queued ${data.added}, skipped ${data.skipped}.`);
      await loadRun(activeRunId, { silent: true });
    } catch (err) { setError(String(err?.message || err)); }
    finally { setBusyAction(""); }
  }

  async function deleteSelected() {
    if (!activeRunId || !selectedIds.size) return;
    setBusyAction("delete"); setError(""); setMessage("");
    try {
      const res = await fetch("/api/backlinks-finder/delete-links", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRunId, link_ids: [...selectedIds] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete");
      setSelectedIds(new Set());
      setMessage(`Removed ${data.removed} link(s).`);
      await loadRun(activeRunId, { silent: true }); await loadRuns({ silent: true });
    } catch (err) { setError(String(err?.message || err)); }
    finally { setBusyAction(""); }
  }

  const progressIndex = Number(activeRunSummary?.current_keyword_index || 0);
  const progressTotal = Number(activeRunSummary?.keywords_count || 0);
  const runError = activeRun?.error_message || activeRun?.summary;

  return (
    <div style={{ maxWidth: 1400, margin: "0 auto", padding: "0 0 60px" }}>
      <style>{`
        .bf-label { display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 6px; }
        .bf-hint { font-size: 12px; color: #6b7280; font-weight: 400; margin-left: 6px; }
        .bf-input { width: 100%; padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; background: #fff; box-sizing: border-box; outline: none; font-family: inherit; }
        .bf-input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.1); }
        .bf-select { width: 100%; padding: 9px 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; background: #fff; box-sizing: border-box; cursor: pointer; font-family: inherit; }
        .bf-btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; border: none; transition: all .15s; font-family: inherit; }
        .bf-btn-primary { background: #2563eb; color: #fff; }
        .bf-btn-primary:hover:not(:disabled) { background: #1d4ed8; }
        .bf-btn-secondary { background: #f1f5f9; color: #374151; border: 1px solid #e2e8f0; }
        .bf-btn-secondary:hover:not(:disabled) { background: #e2e8f0; }
        .bf-btn-danger { background: #fee2e2; color: #b91c1c; border: 1px solid #fecaca; }
        .bf-btn-danger:hover:not(:disabled) { background: #fecaca; }
        .bf-btn:disabled { opacity: .5; cursor: not-allowed; }
        .bf-card { background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; padding: 20px 22px; }
        .bf-run-item { width: 100%; text-align: left; padding: 10px 12px; border: 1px solid #e5e7eb; border-radius: 10px; background: #fafafa; cursor: pointer; margin-bottom: 6px; transition: all .15s; font-family: inherit; }
        .bf-run-item:hover { border-color: #93c5fd; background: #eff6ff; }
        .bf-run-item.active { border-color: #2563eb; background: #eff6ff; }
        .bf-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .bf-table th { background: #f8fafc; border-bottom: 2px solid #e5e7eb; padding: 10px 12px; text-align: left; font-size: 12px; font-weight: 700; color: #6b7280; white-space: nowrap; }
        .bf-table td { padding: 9px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
        .bf-table tr:hover td { background: #f8fafc; }
        .bf-tag { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; background: #f1f5f9; color: #475569; }
        .bf-toggle-row { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #f8fafc; border: 1px solid #e5e7eb; border-radius: 10px; cursor: pointer; user-select: none; }
        .bf-toggle-row input[type=checkbox] { width: 16px; height: 16px; accent-color: #2563eb; cursor: pointer; }
      `}</style>

      {/* Top Section: Form + Recent Runs */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20, marginBottom: 24 }}>

        {/* Left: Form */}
        <div className="bf-card">
          <div style={{ marginBottom: 16 }}>
            <label className="bf-label">Keywords <span className="bf-hint">— one per line or comma-separated</span></label>
            <textarea
              className="bf-input"
              rows={5}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder={"Best Accounting KPO in India\npayroll software for CA firms\nGST filing services"}
              style={{ resize: "vertical" }}
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
            <button className="bf-btn bf-btn-primary" onClick={startRun} disabled={busyAction === "run" || !normalizeKeywordsText(keywords).length}>
              {busyAction === "run" ? "⏳ Starting…" : "🔍 Find Links"}
            </button>
            <button className="bf-btn bf-btn-secondary" onClick={() => loadRuns()} disabled={loadingRuns}>
              {loadingRuns ? "Refreshing…" : "↻ Refresh"}
            </button>
          </div>

          {/* Advanced toggle */}
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 13, color: "#2563eb", fontWeight: 600, marginBottom: showAdvanced ? 14 : 0, fontFamily: "inherit" }}
          >
            {showAdvanced ? "▲ Hide Advanced" : "▼ Advanced Settings"}
          </button>

          {showAdvanced && (
            <div style={{ display: "grid", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <div>
                  <label className="bf-label">Search Engine</label>
                  <select className="bf-select" value={engine} onChange={(e) => setEngine(e.target.value)}>
                    {ENGINE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="bf-label">Max results per keyword</label>
                  <input className="bf-input" type="number" min={1} max={100} value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value || 50))} />
                </div>
              </div>

              <label className="bf-toggle-row">
                <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#374151" }}>Headless mode</div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>{headless ? "Browser runs in background (faster)" : "Browser window visible (slower, use for CAPTCHA)"}</div>
                </div>
              </label>

              <label className="bf-toggle-row">
                <input type="checkbox" checked={includeAllSites} onChange={(e) => setIncludeAllSites(e.target.checked)} />
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#374151" }}>Include all sites</div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>{includeAllSites ? "Return all results (more links, less strict filtering)" : "Strict mode — only sites matching keyword in URL/title"}</div>
                </div>
              </label>

              <div>
                <label className="bf-label">Template Preset</label>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                  {Object.entries(TEMPLATE_PRESETS).map(([key, val]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setPresetSafe(key)}
                      style={{
                        padding: "5px 14px", borderRadius: 20, fontSize: 13, fontWeight: 500, cursor: "pointer", border: "1px solid",
                        background: preset === key ? "#dbeafe" : "#f8fafc",
                        color: preset === key ? "#1d4ed8" : "#374151",
                        borderColor: preset === key ? "#93c5fd" : "#e5e7eb",
                        fontFamily: "inherit",
                      }}
                    >
                      {val.label}
                    </button>
                  ))}
                </div>

                {preset === "custom" ? (
                  <div>
                    <label className="bf-label">Custom Template <span className="bf-hint">use {"{keyword}"} as placeholder</span></label>
                    <textarea
                      className="bf-input"
                      rows={3}
                      value={customTemplate}
                      onChange={(e) => setCustomTemplate(e.target.value)}
                      placeholder='inurl:comment "leave a reply" {keyword}'
                    />
                  </div>
                ) : (
                  <div style={{ padding: "8px 12px", background: "#f0f9ff", borderRadius: 8, fontSize: 13, color: "#0369a1", border: "1px solid #bae6fd" }}>
                    <strong>Template:</strong> <code style={{ fontFamily: "monospace" }}>{appliedTemplate}</code>
                  </div>
                )}
              </div>
            </div>
          )}

          {error && <div style={{ marginTop: 14, padding: "10px 14px", background: "#fee2e2", color: "#b91c1c", borderRadius: 8, fontSize: 13 }}>⚠ {error}</div>}
          {message && <div style={{ marginTop: 14, padding: "10px 14px", background: "#dcfce7", color: "#15803d", borderRadius: 8, fontSize: 13 }}>✓ {message}</div>}
        </div>

        {/* Right: Recent Runs */}
        <div className="bf-card" style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Recent Runs</h3>
            {loadingRuns && <span style={{ fontSize: 12, color: "#6b7280" }}>Refreshing…</span>}
          </div>

          {!runs.length ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#9ca3af", fontSize: 13, textAlign: "center", padding: 24 }}>
              No runs yet.<br />Enter keywords and click Find Links.
            </div>
          ) : (
            <div style={{ flex: 1, overflowY: "auto", maxHeight: 380 }}>
              {runs.map((run) => (
                <button
                  key={run.run_id}
                  type="button"
                  onClick={() => setActiveRunId(String(run.run_id || ""))}
                  className={`bf-run-item${String(activeRunId) === String(run.run_id) ? " active" : ""}`}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1e3a5f", fontFamily: "monospace" }}>{shortRunId(run.run_id)}</span>
                    <StatusChip status={run.status} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7280" }}>
                    <span>{Number(run.total_links_collected || 0)} links</span>
                    <span>{toRelativeTime(run.created_at)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Running banner */}
      {isRunning && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 10, marginBottom: 16, fontSize: 14, color: "#1d4ed8" }}>
          <span style={{ display: "inline-block", width: 16, height: 16, border: "2px solid #93c5fd", borderTopColor: "#2563eb", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
          Running keyword {progressIndex}/{progressTotal || "?"}{activeRunSummary?.current_keyword ? ` — "${activeRunSummary.current_keyword}"` : ""} · {Number(activeRunSummary?.total_links_collected || 0)} links found
        </div>
      )}

      {/* Failed error display */}
      {String(activeRun?.status || "") === "failed" && runError && (
        <div style={{ padding: "12px 16px", background: "#fee2e2", border: "1px solid #fecaca", borderRadius: 10, marginBottom: 16, fontSize: 13, color: "#b91c1c" }}>
          <strong>Run failed:</strong> {runError}
        </div>
      )}

      {/* Verification banner */}
      {String(activeRun?.status || "") === "pending_verification" && (
        <div style={{ padding: "12px 16px", background: "#fef3c7", border: "1px solid #fde68a", borderRadius: 10, marginBottom: 16, fontSize: 13, color: "#92400e" }}>
          <strong>⚠ Needs verification.</strong> CAPTCHA or verification checkpoint detected.
          {Array.isArray(activeRun?.artifacts) && activeRun.artifacts.length > 0 && (
            <span> Artifacts: {activeRun.artifacts.slice(0, 3).map((a, i) => <a key={a} href={a} target="_blank" rel="noreferrer" style={{ marginLeft: 6 }}>[{i + 1}]</a>)}</span>
          )}
        </div>
      )}

      {/* Results Section */}
      <div className="bf-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: "#0f172a" }}>Results</h3>
            {activeRunId && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>Run: <code style={{ fontFamily: "monospace" }}>{activeRunId}</code></div>}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="bf-btn bf-btn-secondary" onClick={exportCsv} disabled={!activeRunId} style={{ padding: "7px 14px", fontSize: 13 }}>
              ⬇ Export CSV
            </button>
          </div>
        </div>

        {/* Filter + actions bar */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12, padding: "10px 14px", background: "#f8fafc", borderRadius: 10, border: "1px solid #e5e7eb" }}>
          <input
            className="bf-input"
            placeholder="Filter by keyword, URL, domain, status…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ flex: 1, minWidth: 200, padding: "7px 12px" }}
          />
          <button className="bf-btn bf-btn-secondary" onClick={() => { const next = new Set(selectedIds); for (const item of pageLinks) if (item?.id) next.add(String(item.id)); setSelectedIds(next); }} style={{ padding: "7px 14px", fontSize: 13 }}>Select page</button>
          <button className="bf-btn bf-btn-secondary" onClick={() => { const next = new Set(selectedIds); for (const item of filteredLinks) if (item?.id) next.add(String(item.id)); setSelectedIds(next); }} style={{ padding: "7px 14px", fontSize: 13 }}>Select all</button>
          <button className="bf-btn bf-btn-secondary" onClick={() => setSelectedIds(new Set())} style={{ padding: "7px 14px", fontSize: 13 }}>Clear</button>
          <button className="bf-btn bf-btn-primary" onClick={enqueueSelected} disabled={busyAction === "enqueue" || !selectedIds.size} style={{ padding: "7px 14px", fontSize: 13 }}>
            {busyAction === "enqueue" ? "Queuing…" : `→ Queue (${selectedIds.size})`}
          </button>
          <button className="bf-btn bf-btn-danger" onClick={deleteSelected} disabled={busyAction === "delete" || !selectedIds.size} style={{ padding: "7px 14px", fontSize: 13 }}>
            🗑 Remove ({selectedIds.size})
          </button>
        </div>

        <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
          Selected: <strong>{selectedIds.size}</strong> · Showing: <strong>{pageLinks.length}</strong> · Filtered: <strong>{filteredLinks.length}</strong> · Total: <strong>{links.length}</strong>
        </div>

        {loadingRun && <div style={{ padding: 20, textAlign: "center", color: "#6b7280", fontSize: 13 }}>Loading run details…</div>}

        <div style={{ overflowX: "auto" }}>
          <table className="bf-table" style={{ minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input
                    type="checkbox"
                    checked={pageLinks.length > 0 && pageSelectedCount === pageLinks.length}
                    onChange={(e) => {
                      if (e.target.checked) { const next = new Set(selectedIds); for (const item of pageLinks) if (item?.id) next.add(String(item.id)); setSelectedIds(next); }
                      else { setSelectedIds((prev) => { const next = new Set(prev); for (const item of pageLinks) next.delete(String(item?.id || "")); return next; }); }
                    }}
                  />
                </th>
                <th>Keyword</th>
                <th>Query</th>
                <th>URL</th>
                <th>Title</th>
                <th>Engine</th>
                <th>Quality</th>
                <th>Collected</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pageLinks.length === 0 && !loadingRun && (
                <tr><td colSpan={9} style={{ textAlign: "center", padding: 40, color: "#9ca3af" }}>
                  {links.length === 0 ? "No results yet. Select a run or start a new one." : "No results match your filter."}
                </td></tr>
              )}
              {pageLinks.map((item) => (
                <tr key={item.id}>
                  <td><input type="checkbox" checked={selectedIds.has(String(item?.id || ""))} onChange={() => toggleSelectOne(item?.id)} /></td>
                  <td style={{ maxWidth: 140, wordBreak: "break-word" }}><span className="bf-tag">{item.keyword || "-"}</span></td>
                  <td style={{ maxWidth: 180, wordBreak: "break-word", fontSize: 12, color: "#6b7280" }} title={item.query || ""}>{item.query ? item.query.slice(0, 60) + (item.query.length > 60 ? "…" : "") : "-"}</td>
                  <td style={{ maxWidth: 220 }}>
                    {item.url ? <><a href={item.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#2563eb", wordBreak: "break-all" }}>{item.url.slice(0, 60)}{item.url.length > 60 ? "…" : ""}</a><div style={{ fontSize: 11, color: "#9ca3af" }}>{item.domain}</div></> : "-"}
                  </td>
                  <td style={{ maxWidth: 180, fontSize: 12 }} title={item.title || ""}>{item.title ? item.title.slice(0, 55) + (item.title.length > 55 ? "…" : "") : "-"}</td>
                  <td style={{ fontSize: 12 }}>{item.engine || "-"}</td>
                  <td style={{ fontSize: 12 }}>{Number.isFinite(Number(item.quality_score)) ? Number(item.quality_score) : "-"}</td>
                  <td style={{ fontSize: 12, whiteSpace: "nowrap" }}>{formatDateTime(item.collected_at)}</td>
                  <td><StatusChip status={item.status || "new"} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <button className="bf-btn bf-btn-secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} style={{ padding: "7px 16px" }}>← Prev</button>
            <span style={{ fontSize: 13, color: "#6b7280" }}>Page {safePage} of {totalPages}</span>
            <button className="bf-btn bf-btn-secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} style={{ padding: "7px 16px" }}>Next →</button>
          </div>
        )}
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );

  function exportCsv() {
    if (!activeRunId) return;
    window.open(`/api/backlinks-finder/export.csv?run_id=${encodeURIComponent(activeRunId)}`, "_blank");
  }

  function toggleSelectOne(id) {
    const key = String(id || "");
    if (!key) return;
    setSelectedIds((prev) => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }
}
