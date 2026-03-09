"use client";

import { useEffect, useMemo, useState } from "react";

const PAGE_SIZE = 50;

const TEMPLATE_PRESETS = {
  blog_comments: {
    label: "Blog Comments",
    template: "inurl:blog \"leave a reply\" {keyword}",
  },
  accounts_profile: {
    label: "Accounts/Profile",
    template: "inurl:blog intitle:accounts {keyword}",
  },
  forums: {
    label: "Forums",
    template: "inurl:forum \"register\" {keyword}",
  },
  write_for_us: {
    label: "Write for us",
    template: "\"write for us\" {keyword}",
  },
  custom: {
    label: "Custom",
    template: "",
  },
};

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
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function formatDateTime(input) {
  const date = new Date(String(input || ""));
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function shortRunId(runId) {
  const raw = String(runId || "");
  if (raw.length <= 14) return raw;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function normalizeKeywordsText(raw) {
  return String(raw || "")
    .split(/[\n,]+/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

export default function BacklinksFinderPage() {
  const [keywords, setKeywords] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [engine, setEngine] = useState("bing");
  const [maxResults, setMaxResults] = useState(50);
  const [headless, setHeadless] = useState(true);
  const [preset, setPreset] = useState("blog_comments");
  const [customTemplate, setCustomTemplate] = useState("");

  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [activeRun, setActiveRun] = useState(null);

  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingRun, setLoadingRun] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const appliedTemplate = useMemo(() => {
    if (preset === "custom") {
      return String(customTemplate || "").trim();
    }
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
      if (!activeRunId && nextRuns.length) {
        setActiveRunId(String(nextRuns[0].run_id || ""));
      }
      if (activeRunId && !nextRuns.some((run) => String(run.run_id) === String(activeRunId))) {
        setActiveRunId(nextRuns[0] ? String(nextRuns[0].run_id || "") : "");
      }
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (!silent) setLoadingRuns(false);
    }
  }

  async function loadRun(runId, { silent = false } = {}) {
    if (!runId) {
      setActiveRun(null);
      return;
    }
    if (!silent) setLoadingRun(true);
    try {
      const res = await fetch(`/api/backlinks-finder/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to load run details");
      setActiveRun(data.run || null);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      if (!silent) setLoadingRun(false);
    }
  }

  useEffect(() => {
    loadRuns();
  }, []);

  useEffect(() => {
    loadRun(activeRunId);
    setPage(1);
    setSelectedIds(new Set());
  }, [activeRunId]);

  const activeRunSummary = useMemo(() => {
    return runs.find((run) => String(run.run_id || "") === String(activeRunId || "")) || null;
  }, [runs, activeRunId]);

  useEffect(() => {
    const runStatus = String(activeRunSummary?.status || activeRun?.status || "");
    if (runStatus !== "running") return undefined;
    const timer = setInterval(() => {
      loadRuns({ silent: true });
      if (activeRunId) loadRun(activeRunId, { silent: true });
    }, 3000);
    return () => clearInterval(timer);
  }, [activeRunSummary?.status, activeRun?.status, activeRunId]);

  const links = useMemo(() => (Array.isArray(activeRun?.links) ? activeRun.links : []), [activeRun]);

  const filteredLinks = useMemo(() => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return links;
    return links.filter((item) => {
      const hay = [item.keyword, item.query, item.url, item.domain, item.title, item.status, item.engine, item.quality_score]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      return hay.includes(q);
    });
  }, [links, query]);

  const totalPages = Math.max(1, Math.ceil(filteredLinks.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageLinks = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE;
    return filteredLinks.slice(start, start + PAGE_SIZE);
  }, [filteredLinks, safePage]);

  const pageSelectedCount = pageLinks.filter((item) => selectedIds.has(String(item?.id || ""))).length;

  function setPresetSafe(nextPreset) {
    const key = String(nextPreset || "blog_comments");
    setPreset(key);
    if (key !== "custom") {
      setCustomTemplate(TEMPLATE_PRESETS[key]?.template || TEMPLATE_PRESETS.blog_comments.template);
    }
  }

  async function startRun() {
    setError("");
    setMessage("");

    const keywordList = normalizeKeywordsText(keywords);
    if (!keywordList.length) {
      setError("Please add at least one keyword.");
      return;
    }

    const finalTemplate = String(appliedTemplate || "").trim();
    if (!finalTemplate) {
      setError("Template cannot be empty.");
      return;
    }

    setBusyAction("run");
    try {
      const res = await fetch("/api/backlinks-finder/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keywords: keywordList,
          template: finalTemplate,
          engine,
          options: {
            results_per_keyword: Number(maxResults || 50),
            min_delay_ms: 0,
            max_delay_ms: 0,
            headless: Boolean(headless),
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Run start failed");

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

  const canStartRun = useMemo(() => {
    const keywordList = normalizeKeywordsText(keywords);
    return keywordList.length > 0 && Number(maxResults || 0) > 0;
  }, [keywords, maxResults]);

  function selectPage() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of pageLinks) {
        if (item?.id) next.add(String(item.id));
      }
      return next;
    });
  }

  function selectAllFiltered() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const item of filteredLinks) {
        if (item?.id) next.add(String(item.id));
      }
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function toggleSelectOne(id) {
    const key = String(id || "");
    if (!key) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function enqueueSelected() {
    const ids = [...selectedIds];
    if (!activeRunId || !ids.length) return;

    setBusyAction("enqueue");
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/backlinks-finder/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRunId, link_ids: ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to enqueue links");
      clearSelection();
      setMessage(`Queued ${data.added}, skipped ${data.skipped}.`);
      await loadRun(activeRunId, { silent: true });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusyAction("");
    }
  }

  async function deleteSelected() {
    const ids = [...selectedIds];
    if (!activeRunId || !ids.length) return;

    setBusyAction("delete");
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/backlinks-finder/delete-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: activeRunId, link_ids: ids }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to delete links");
      clearSelection();
      setMessage(`Removed ${data.removed} link(s).`);
      await loadRun(activeRunId, { silent: true });
      await loadRuns({ silent: true });
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusyAction("");
    }
  }

  function exportCsv() {
    if (!activeRunId) return;
    window.open(`/api/backlinks-finder/export.csv?run_id=${encodeURIComponent(activeRunId)}`, "_blank");
  }

  const isRunning = String(activeRunSummary?.status || activeRun?.status || "") === "running";
  const progressIndex = Number(activeRunSummary?.current_keyword_index || activeRun?.current_keyword_index || 0);
  const progressTotal = Number(activeRunSummary?.keywords_count || activeRun?.keywords_count || 0);
  const showVerificationBanner = String(activeRun?.status || "") === "pending_verification";

  return (
    <section className="card finder-root">
      <h2 style={{ marginTop: 0 }}>Backlinks Finder</h2>

      <div className="finder-top-grid">
        <div className="finder-pane">
          <div className="field" style={{ marginBottom: 12 }}>
            <span>Keywords</span>
            <textarea
              rows={7}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder={"seo agency\nplumbing services\nweb design mumbai"}
            />
          </div>

          <div className="row" style={{ marginBottom: 12 }}>
            <button onClick={startRun} disabled={busyAction === "run" || !canStartRun}>
              {busyAction === "run" ? "Starting..." : "Find Links"}
            </button>
            <button className="secondary" onClick={() => loadRuns()} disabled={loadingRuns}>Refresh Runs</button>
          </div>

          <details open={showAdvanced} onToggle={(e) => setShowAdvanced(e.currentTarget.open)} className="finder-advanced">
            <summary>Advanced</summary>
            <div className="finder-advanced-content">
              <div className="form-grid">
                <label className="field">
                  <span>Engine</span>
                  <select value={engine} onChange={(e) => setEngine(e.target.value)}>
                    <option value="duckduckgo">DuckDuckGo</option>
                    <option value="bing">Bing</option>
                  </select>
                </label>
                <label className="field">
                  <span>Max results per keyword</span>
                  <input type="number" min={1} max={100} value={maxResults} onChange={(e) => setMaxResults(Number(e.target.value || 50))} />
                </label>
              </div>

              <label className="row" style={{ marginTop: 8 }}>
                <input style={{ width: 16 }} type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
                <span>Headless mode</span>
              </label>

              <div className="field" style={{ marginTop: 10 }}>
                <span>Template preset</span>
                <div className="row">
                  <select value={preset} onChange={(e) => setPresetSafe(e.target.value)}>
                    {Object.entries(TEMPLATE_PRESETS).map(([key, val]) => (
                      <option key={key} value={key}>{val.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => setPresetSafe(preset)}
                  >
                    Reset to preset
                  </button>
                </div>
              </div>

              {preset === "custom" ? (
                <div className="field" style={{ marginTop: 10 }}>
                  <span>Custom query template</span>
                  <textarea
                    rows={4}
                    value={customTemplate}
                    onChange={(e) => setCustomTemplate(e.target.value)}
                    placeholder='inurl:comment "leave a reply" {keyword}'
                  />
                </div>
              ) : null}
            </div>
          </details>

        </div>

        <div className="finder-pane">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
            <h3 style={{ margin: 0 }}>Recent Runs</h3>
            {loadingRuns ? <span className="muted">Refreshing...</span> : null}
          </div>

          {!runs.length ? (
            <div className="finder-empty">No runs yet. Add keywords and click Find Links.</div>
          ) : (
            <div className="finder-runs-list">
              {runs.map((run) => {
                const isSelected = String(activeRunId || "") === String(run.run_id || "");
                return (
                  <button
                    type="button"
                    key={run.run_id}
                    onClick={() => setActiveRunId(String(run.run_id || ""))}
                    className={`finder-run-item ${isSelected ? "is-selected" : ""}`}
                  >
                    <div className="finder-run-row">
                      <strong title={run.run_id}>{shortRunId(run.run_id)}</strong>
                      <span className={`finder-status-chip status-${String(run.status || "").toLowerCase()}`}>{run.status}</span>
                    </div>
                    <div className="finder-run-meta">
                      <span>{Number(run.total_links_collected || 0)} links</span>
                      <span>{toRelativeTime(run.created_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {isRunning ? (
        <div className="finder-banner info">
          <span className="spinner" />
          <span>
            Running... ({progressIndex}/{progressTotal || "?"}) {activeRunSummary?.current_keyword ? `- ${activeRunSummary.current_keyword}` : ""} | Links: {Number(activeRunSummary?.total_links_collected || activeRun?.total_links_collected || 0)}
          </span>
        </div>
      ) : null}

      {showVerificationBanner ? (
        <div className="finder-banner warn">
          <strong>Needs verification.</strong>
          <span> Verification checkpoint detected for this run.</span>
          {Array.isArray(activeRun?.artifacts) && activeRun.artifacts.length ? (
            <span>
              {" "}Artifacts:{" "}
              {activeRun.artifacts.slice(0, 3).map((artifact, idx) => (
                <a key={artifact} href={artifact} target="_blank" rel="noreferrer">[{idx + 1}]</a>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {message ? <div style={{ color: "#166534", marginTop: 10 }}>{message}</div> : null}
      {error ? <div style={{ color: "#b91c1c", marginTop: 10 }}>{error}</div> : null}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Run Details</h3>
          <div className="muted">{activeRunId ? `Run: ${activeRunId}` : "Select a run"}</div>
        </div>

        <div className="finder-sticky-actions">
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <input placeholder="Filter links" value={query} onChange={(e) => setQuery(e.target.value)} style={{ minWidth: 220, flex: 1 }} />
            <button className="secondary" onClick={selectPage}>Select all (page)</button>
            <button className="secondary" onClick={selectAllFiltered}>Select all (all filtered)</button>
            <button className="secondary" onClick={clearSelection}>Clear</button>
            <button onClick={enqueueSelected} disabled={busyAction === "enqueue" || !selectedIds.size}>Send to Blog Comment Queue</button>
            <button className="danger" onClick={deleteSelected} disabled={busyAction === "delete" || !selectedIds.size}>Remove selected</button>
            <button className="secondary" onClick={exportCsv} disabled={!activeRunId}>Export CSV</button>
          </div>
        </div>

        <div className="muted" style={{ marginBottom: 8 }}>
          Selected: {selectedIds.size} | Showing: {pageLinks.length} | Total: {links.length} | Filtered: {filteredLinks.length}
        </div>

        {loadingRun ? <div className="muted">Loading run details...</div> : null}

        <div style={{ overflowX: "auto" }}>
          <table className="results-table" style={{ minWidth: 1360 }}>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    checked={pageLinks.length > 0 && pageSelectedCount === pageLinks.length}
                    onChange={(e) => {
                      if (e.target.checked) {
                        selectPage();
                      } else {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          for (const item of pageLinks) next.delete(String(item?.id || ""));
                          return next;
                        });
                      }
                    }}
                  />
                </th>
                <th>Keyword</th>
                <th>Query used</th>
                <th>URL</th>
                <th>Title</th>
                <th>Engine</th>
                <th>Quality</th>
                <th>Collected At</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {pageLinks.map((item) => (
                <tr key={item.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selectedIds.has(String(item?.id || ""))}
                      onChange={() => toggleSelectOne(item?.id)}
                    />
                  </td>
                  <td>{item.keyword || "-"}</td>
                  <td title={item.query || ""}>{item.query || "-"}</td>
                  <td>
                    {item.url ? (
                      <div>
                        <a href={item.url} target="_blank" rel="noreferrer">{item.url}</a>
                        <div className="muted finder-domain">{item.domain || "-"}</div>
                      </div>
                    ) : "-"}
                  </td>
                  <td>
                    <span className="finder-title" title={item.title || ""}>{item.title || "-"}</span>
                  </td>
                  <td>{item.engine || "-"}</td>
                  <td>{Number.isFinite(Number(item.quality_score)) ? Number(item.quality_score) : "-"}</td>
                  <td>{formatDateTime(item.collected_at)}</td>
                  <td>
                    <span className={`finder-status-chip status-${String(item.status || "new").toLowerCase()}`}>{item.status || "new"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {totalPages > 1 ? (
          <div className="row" style={{ justifyContent: "space-between", marginTop: 12 }}>
            <button className="secondary" onClick={() => setPage((prev) => Math.max(1, prev - 1))} disabled={safePage <= 1}>Prev</button>
            <span className="muted">Page {safePage} of {totalPages}</span>
            <button className="secondary" onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))} disabled={safePage >= totalPages}>Next</button>
          </div>
        ) : null}
      </div>

      <style jsx>{`
        .finder-root {
          overflow: visible;
        }
        .finder-top-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.35fr) minmax(320px, 0.85fr);
          gap: 14px;
          align-items: start;
        }
        .finder-pane {
          background: #fff;
          border: 1px solid #d5e0f6;
          border-radius: 12px;
          padding: 14px;
        }
        .finder-advanced summary {
          cursor: pointer;
          font-weight: 600;
        }
        .finder-advanced-content {
          margin-top: 10px;
        }
        .finder-empty {
          border: 1px dashed #b8c8ea;
          border-radius: 10px;
          padding: 14px;
          color: #475569;
          background: #f8fbff;
        }
        .finder-runs-list {
          display: grid;
          gap: 8px;
          max-height: 380px;
          overflow: auto;
        }
        .finder-run-item {
          width: 100%;
          text-align: left;
          border: 1px solid #d0dbf2;
          border-radius: 10px;
          padding: 10px;
          background: #f8fbff;
          color: #0f172a;
        }
        .finder-run-item:hover {
          border-color: #9fb6e5;
          background: #eef4ff;
        }
        .finder-run-item.is-selected {
          border-color: #6a93db;
          background: #e8f0ff;
        }
        .finder-run-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 10px;
        }
        .finder-run-meta {
          margin-top: 6px;
          display: flex;
          justify-content: space-between;
          color: #475569;
          font-size: 12px;
        }
        .finder-banner {
          margin-top: 10px;
          padding: 10px 12px;
          border-radius: 10px;
          display: flex;
          gap: 8px;
          align-items: center;
          border: 1px solid;
        }
        .finder-banner.info {
          background: #eef4ff;
          border-color: #b7caf0;
          color: #1e3a8a;
        }
        .finder-banner.warn {
          background: #fff8e8;
          border-color: #f3d18f;
          color: #8a4b07;
        }
        .finder-banner.warn a {
          color: #8a4b07;
          margin-right: 6px;
          text-decoration: underline;
        }
        .finder-sticky-actions {
          position: sticky;
          top: 0;
          z-index: 2;
          padding: 10px 0;
          background: #fff;
        }
        .finder-domain {
          font-size: 12px;
          margin-top: 2px;
        }
        .finder-title {
          max-width: 280px;
          display: inline-block;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          vertical-align: bottom;
        }
        .finder-status-chip {
          border-radius: 999px;
          border: 1px solid #d4ddf1;
          padding: 2px 8px;
          font-size: 12px;
          font-weight: 600;
          text-transform: capitalize;
        }
        .status-running {
          background: #e8f0ff;
          border-color: #9bb4ef;
          color: #1d4ed8;
        }
        .status-completed, .status-success {
          background: #e9faef;
          border-color: #9ad9ac;
          color: #166534;
        }
        .status-pending_verification {
          background: #fff7e6;
          border-color: #f6cd8a;
          color: #92400e;
        }
        .status-failed {
          background: #fff0f0;
          border-color: #efb1b1;
          color: #9f1239;
        }
        .danger {
          background: #b42318;
        }
        @media (max-width: 980px) {
          .finder-top-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </section>
  );
}
