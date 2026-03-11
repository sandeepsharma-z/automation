"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const PROFILE_KEY = "ops_entry_profile_v1";
const PAGE_SIZE = 50;

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

function shortRunId(runId) {
  const raw = String(runId || "");
  return raw.length <= 14 ? raw : `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

const EMPTY_PROFILE = {
  website_url: "",
  author_name: "",
  email: "",
  password: "",
  company_name: "",
  company_address: "",
  company_phone: "",
  company_description: "",
  notes: "",
};

export default function OpsEntryPage() {
  // Profile state
  const [profile, setProfile] = useState(EMPTY_PROFILE);
  const [profileSaved, setProfileSaved] = useState(false);

  // Finder runs
  const [runs, setRuns] = useState([]);
  const [activeRunId, setActiveRunId] = useState("");
  const [activeRun, setActiveRun] = useState(null);
  const [loadingRun, setLoadingRun] = useState(false);

  // Link selection
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [filterQuery, setFilterQuery] = useState("");
  const [page, setPage] = useState(1);

  // Submission state
  const [headless, setHeadless] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState(null);
  const [error, setError] = useState("");

  // Load profile from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PROFILE_KEY);
      if (saved) setProfile((prev) => ({ ...prev, ...JSON.parse(saved) }));
    } catch (_) {}
  }, []);

  function saveProfile() {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
    } catch (_) {}
  }

  function setProfileField(key, value) {
    setProfile((prev) => ({ ...prev, [key]: value }));
  }

  // Load finder runs on mount
  useEffect(() => {
    loadRuns();
  }, []);

  async function loadRuns() {
    try {
      const res = await fetch("/api/backlinks-finder/runs", { cache: "no-store" });
      const data = await res.json();
      const nextRuns = Array.isArray(data.runs) ? data.runs : [];
      setRuns(nextRuns);
      if (!activeRunId && nextRuns.length) {
        setActiveRunId(String(nextRuns[0].run_id || ""));
      }
    } catch (_) {}
  }

  // Load run details when activeRunId changes
  useEffect(() => {
    if (!activeRunId) { setActiveRun(null); return; }
    setLoadingRun(true);
    fetch(`/api/backlinks-finder/runs/${encodeURIComponent(activeRunId)}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => { setActiveRun(data.run || null); setSelectedIds(new Set()); setPage(1); })
      .catch(() => {})
      .finally(() => setLoadingRun(false));
  }, [activeRunId]);

  const links = useMemo(() => (Array.isArray(activeRun?.links) ? activeRun.links : []), [activeRun]);

  const filteredLinks = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return links;
    return links.filter((item) =>
      [item.url, item.domain, item.title, item.keyword, item.engine, item.opportunity_type]
        .map((v) => String(v || "").toLowerCase()).join(" ").includes(q)
    );
  }, [links, filterQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredLinks.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageLinks = useMemo(() => filteredLinks.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), [filteredLinks, safePage]);

  function selectPage() {
    setSelectedIds((prev) => { const next = new Set(prev); pageLinks.forEach((l) => l?.id && next.add(String(l.id))); return next; });
  }
  function selectAllFiltered() {
    setSelectedIds((prev) => { const next = new Set(prev); filteredLinks.forEach((l) => l?.id && next.add(String(l.id))); return next; });
  }
  function clearSelection() { setSelectedIds(new Set()); }
  function toggleOne(id) {
    const key = String(id || "");
    setSelectedIds((prev) => { const next = new Set(prev); next.has(key) ? next.delete(key) : next.add(key); return next; });
  }

  const selectedLinks = useMemo(() => {
    if (!activeRun?.links) return [];
    return activeRun.links.filter((l) => selectedIds.has(String(l?.id || "")));
  }, [activeRun, selectedIds]);

  async function startBlogCommenting() {
    setError("");
    setSubmitResult(null);

    if (!profile.website_url.trim()) { setError("Website URL is required in your profile."); return; }
    if (!selectedLinks.length) { setError("Please select at least one link to comment on."); return; }

    setSubmitting(true);
    try {
      // Build queue rows from selected links
      const rows = selectedLinks.map((link) => ({
        directory_url: link.url,
        site_url: link.url,
        target_links: profile.website_url.trim(),
        target_link: profile.website_url.trim(),
        backlink_type: "blog_commenting",
        category: "Blog Commenting",
        site_name: String(link.domain || ""),
        notes: [
          profile.notes ? `Instructions: ${profile.notes}` : "",
          `finder_keyword:${link.keyword || ""}`,
          `finder_run:${activeRunId}`,
        ].filter(Boolean).join(" | "),
      }));

      const defaults = {
        default_website_url: profile.website_url.trim(),
        username: profile.author_name.trim(),
        email: profile.email.trim(),
        password: profile.password.trim(),
        company_name: profile.company_name.trim(),
        company_address: profile.company_address.trim(),
        company_phone: profile.company_phone.trim(),
        company_description: profile.company_description.trim(),
        notes: profile.notes.trim(),
        backlink_type: "blog_commenting",
        category: "Blog Commenting",
      };

      const res = await fetch("/api/backlinks/queue/bulk-add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, defaults, auto_run: true, headless }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to start");

      setSubmitResult({
        added: Number(data.added || 0),
        rejected: Number(data.rejected?.length || 0),
        runStarted: Boolean(data.run?.started || data.run?.attached_to_running),
        sessionId: String(data.run?.session_id || ""),
      });

      // Clear selection after successful submit
      setSelectedIds(new Set());
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setSubmitting(false);
    }
  }

  const pageSelectedCount = pageLinks.filter((l) => selectedIds.has(String(l?.id || ""))).length;

  return (
    <div className="ops-root">
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>Blog Commenting</h2>
      <p className="muted" style={{ marginTop: 0, marginBottom: 20 }}>
        Fill in your profile, select URLs from the backlinks finder, then start — the bot types comments naturally into each blog form.
      </p>

      <div className="ops-grid">
        {/* ── LEFT: Profile ───────────────────────────────────────────── */}
        <div className="card-inner">
          <div className="section-header">
            <span>Your Profile</span>
            <button className="btn-sm secondary" onClick={saveProfile}>
              {profileSaved ? "Saved ✓" : "Save Profile"}
            </button>
          </div>

          <label className="field">
            <span>Your Website URL <em>(link we'll build)</em></span>
            <input
              type="url"
              placeholder="https://yoursite.com"
              value={profile.website_url}
              onChange={(e) => setProfileField("website_url", e.target.value)}
            />
          </label>

          <div className="two-col">
            <label className="field">
              <span>Author / Username</span>
              <input placeholder="John Smith" value={profile.author_name} onChange={(e) => setProfileField("author_name", e.target.value)} />
            </label>
            <label className="field">
              <span>Email</span>
              <input type="email" placeholder="you@email.com" value={profile.email} onChange={(e) => setProfileField("email", e.target.value)} />
            </label>
          </div>

          <div className="two-col">
            <label className="field">
              <span>Password <em>(for signups)</em></span>
              <input type="password" placeholder="••••••••" value={profile.password} onChange={(e) => setProfileField("password", e.target.value)} />
            </label>
            <label className="field">
              <span>Company / Brand Name</span>
              <input placeholder="Accountx" value={profile.company_name} onChange={(e) => setProfileField("company_name", e.target.value)} />
            </label>
          </div>

          <div className="two-col">
            <label className="field">
              <span>Phone</span>
              <input placeholder="+91 90000 00000" value={profile.company_phone} onChange={(e) => setProfileField("company_phone", e.target.value)} />
            </label>
            <label className="field">
              <span>Address</span>
              <input placeholder="City, State, Country" value={profile.company_address} onChange={(e) => setProfileField("company_address", e.target.value)} />
            </label>
          </div>

          <label className="field">
            <span>About Your Business <em>(used to write contextual comments)</em></span>
            <textarea
              rows={4}
              placeholder="We provide KPO / accounting outsourcing services for CAs and businesses across India. Specialise in GST, bookkeeping, payroll..."
              value={profile.company_description}
              onChange={(e) => setProfileField("company_description", e.target.value)}
            />
          </label>

          <label className="field">
            <span>Special Instructions / Preferred Anchor Texts</span>
            <textarea
              rows={3}
              placeholder="Use anchor text: 'accounting KPO services'. Avoid mentioning competitors. Keep comments under 100 words."
              value={profile.notes}
              onChange={(e) => setProfileField("notes", e.target.value)}
            />
          </label>

          <div className="field" style={{ marginTop: 6 }}>
            <label className="row" style={{ gap: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} style={{ width: 16 }} />
              <span>Headless mode <em>(hide browser — faster)</em></span>
            </label>
          </div>
        </div>

        {/* ── RIGHT: Finder Run Selector ───────────────────────────────── */}
        <div className="card-inner">
          <div className="section-header">
            <span>Finder Runs</span>
            <button className="btn-sm secondary" onClick={loadRuns}>Refresh</button>
          </div>

          {!runs.length ? (
            <div className="empty-hint">No runs found. Go to <a href="/backlinks/finder">Backlinks Finder</a> first.</div>
          ) : (
            <div className="runs-list">
              {runs.map((run) => {
                const isActive = String(activeRunId) === String(run.run_id || "");
                return (
                  <button
                    key={run.run_id}
                    className={`run-item ${isActive ? "is-active" : ""}`}
                    onClick={() => setActiveRunId(String(run.run_id || ""))}
                  >
                    <div className="run-row">
                      <strong title={run.run_id}>{shortRunId(run.run_id)}</strong>
                      <span className={`chip status-${run.status}`}>{run.status}</span>
                    </div>
                    <div className="run-meta">
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

      {/* ── LINK TABLE ───────────────────────────────────────────────── */}
      <div className="card-inner" style={{ marginTop: 14 }}>
        <div className="section-header">
          <span>
            Links from Run
            {activeRunId ? <span className="muted" style={{ fontSize: 12, fontWeight: 400, marginLeft: 8 }}>{activeRunId}</span> : null}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            {selectedIds.size} selected / {filteredLinks.length} shown / {links.length} total
          </span>
        </div>

        <div className="sticky-bar">
          <input
            placeholder="Filter by URL, domain, keyword..."
            value={filterQuery}
            onChange={(e) => setFilterQuery(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
          />
          <button className="btn-sm secondary" onClick={selectPage}>Select page</button>
          <button className="btn-sm secondary" onClick={selectAllFiltered}>Select all filtered</button>
          <button className="btn-sm secondary" onClick={clearSelection}>Clear</button>
        </div>

        {loadingRun ? <div className="muted" style={{ padding: "12px 0" }}>Loading links...</div> : null}

        {!loadingRun && !links.length && activeRunId ? (
          <div className="empty-hint" style={{ marginTop: 8 }}>No links in this run. Select a completed run that has links.</div>
        ) : null}

        {pageLinks.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="link-table">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={pageLinks.length > 0 && pageSelectedCount === pageLinks.length}
                      onChange={(e) => e.target.checked ? selectPage() : setSelectedIds((prev) => {
                        const next = new Set(prev);
                        pageLinks.forEach((l) => next.delete(String(l?.id || "")));
                        return next;
                      })}
                    />
                  </th>
                  <th>URL</th>
                  <th>Title</th>
                  <th>Keyword</th>
                  <th>Type</th>
                  <th>Score</th>
                  <th>Engine</th>
                </tr>
              </thead>
              <tbody>
                {pageLinks.map((item) => (
                  <tr key={item.id} className={selectedIds.has(String(item?.id || "")) ? "is-selected" : ""}>
                    <td>
                      <input type="checkbox" checked={selectedIds.has(String(item?.id || ""))} onChange={() => toggleOne(item?.id)} />
                    </td>
                    <td>
                      <a href={item.url} target="_blank" rel="noreferrer" className="link-url">{item.url}</a>
                      <div className="muted" style={{ fontSize: 11 }}>{item.domain}</div>
                    </td>
                    <td><span className="link-title" title={item.title}>{item.title || "-"}</span></td>
                    <td>{item.keyword || "-"}</td>
                    <td>
                      {item.opportunity_type ? (
                        <span className={`chip type-${String(item.opportunity_type).replace(/_/g, "-")}`}>{item.opportunity_type}</span>
                      ) : "-"}
                    </td>
                    <td>{Number.isFinite(Number(item.quality_score)) ? Number(item.quality_score) : "-"}</td>
                    <td>{item.engine || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {totalPages > 1 ? (
          <div className="row" style={{ justifyContent: "space-between", marginTop: 10 }}>
            <button className="btn-sm secondary" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1}>← Prev</button>
            <span className="muted">Page {safePage} / {totalPages}</span>
            <button className="btn-sm secondary" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}>Next →</button>
          </div>
        ) : null}
      </div>

      {/* ── SUBMIT BAR ───────────────────────────────────────────────── */}
      <div className="submit-bar">
        <div style={{ flex: 1 }}>
          {error ? <div className="msg error">{error}</div> : null}
          {submitResult ? (
            <div className="msg success">
              ✓ {submitResult.added} blog comment job{submitResult.added !== 1 ? "s" : ""} queued.
              {submitResult.rejected > 0 ? ` (${submitResult.rejected} skipped — missing URL)` : ""}
              {" "}{submitResult.runStarted ? "Runner started — watch the queue for progress." : ""}
              {" "}<a href="/backlinks/intake">View Queue →</a>
            </div>
          ) : null}
        </div>
        <button
          className="btn-start"
          disabled={submitting || !selectedIds.size || !profile.website_url.trim()}
          onClick={startBlogCommenting}
        >
          {submitting
            ? "Starting..."
            : selectedIds.size
              ? `▶ Start Blog Commenting (${selectedIds.size} sites)`
              : "Select links to start"}
        </button>
      </div>

      <style jsx>{`
        .ops-root { max-width: 1400px; margin: 0 auto; }
        .ops-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.7fr);
          gap: 14px;
          align-items: start;
        }
        .card-inner {
          background: #fff;
          border: 1px solid #d5e0f6;
          border-radius: 12px;
          padding: 16px;
        }
        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 14px;
          font-weight: 600;
          font-size: 15px;
        }
        .two-col {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 10px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          margin-bottom: 10px;
          font-size: 13px;
        }
        .field span, .field > label { color: #475569; }
        .field em { font-style: normal; color: #94a3b8; }
        .field input, .field textarea, .field select {
          border: 1px solid #d0dbf2;
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          background: #f8fbff;
        }
        .field textarea { resize: vertical; }
        .row { display: flex; align-items: center; gap: 8px; }
        .muted { color: #64748b; }
        .btn-sm {
          padding: 5px 12px;
          border-radius: 7px;
          font-size: 12px;
          cursor: pointer;
          border: 1px solid #d0dbf2;
          background: #f8fbff;
          color: #1e3a8a;
        }
        .btn-sm:hover { background: #eef4ff; }
        .btn-sm.secondary { background: #f1f5f9; color: #475569; }
        .runs-list { display: flex; flex-direction: column; gap: 6px; max-height: 320px; overflow-y: auto; }
        .run-item {
          width: 100%; text-align: left; border: 1px solid #d0dbf2; border-radius: 8px;
          padding: 8px 10px; background: #f8fbff; cursor: pointer; font-size: 13px;
        }
        .run-item:hover { background: #eef4ff; border-color: #9fb6e5; }
        .run-item.is-active { background: #e8f0ff; border-color: #6a93db; }
        .run-row { display: flex; justify-content: space-between; align-items: center; }
        .run-meta { display: flex; justify-content: space-between; font-size: 11px; color: #64748b; margin-top: 4px; }
        .empty-hint {
          border: 1px dashed #b8c8ea; border-radius: 8px; padding: 12px;
          color: #64748b; font-size: 13px; background: #f8fbff;
        }
        .empty-hint a { color: #1d4ed8; }
        .sticky-bar {
          position: sticky; top: 0; z-index: 2; padding: 8px 0;
          background: #fff; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
          border-bottom: 1px solid #e8eef8; margin-bottom: 8px;
        }
        .sticky-bar input {
          border: 1px solid #d0dbf2; border-radius: 8px; padding: 6px 10px;
          font-size: 13px; background: #f8fbff;
        }
        .link-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .link-table th {
          padding: 8px 10px; text-align: left; font-size: 12px;
          background: #f0f5ff; border-bottom: 1px solid #d5e0f6; color: #475569;
          position: sticky; top: 46px; z-index: 1;
        }
        .link-table td { padding: 7px 10px; border-bottom: 1px solid #f0f4fb; vertical-align: top; }
        .link-table tr.is-selected td { background: #eef4ff; }
        .link-url { color: #1d4ed8; text-decoration: none; font-size: 12px; word-break: break-all; }
        .link-url:hover { text-decoration: underline; }
        .link-title { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
        .chip {
          display: inline-block; padding: 2px 8px; border-radius: 999px;
          font-size: 11px; font-weight: 600; border: 1px solid #d4ddf1;
        }
        .status-completed, .status-success { background: #e9faef; border-color: #9ad9ac; color: #166534; }
        .status-running { background: #e8f0ff; border-color: #9bb4ef; color: #1d4ed8; }
        .status-no_results { background: #f8f8f8; border-color: #ccc; color: #64748b; }
        .status-failed { background: #fff0f0; border-color: #efb1b1; color: #9f1239; }
        .type-blog-comment { background: #eef4ff; border-color: #bdd0f5; color: #1e40af; }
        .type-write-for-us { background: #f0fdf4; border-color: #86efac; color: #166534; }
        .type-forum { background: #fef9c3; border-color: #fde68a; color: #92400e; }
        .type-general { background: #f1f5f9; border-color: #cbd5e1; color: #475569; }
        .submit-bar {
          position: sticky; bottom: 0; background: #fff; z-index: 10;
          border-top: 1px solid #d5e0f6; padding: 12px 0; margin-top: 14px;
          display: flex; align-items: center; gap: 14px;
        }
        .btn-start {
          padding: 11px 28px; background: #1d4ed8; color: #fff;
          border: none; border-radius: 10px; font-size: 15px; font-weight: 600;
          cursor: pointer; white-space: nowrap;
        }
        .btn-start:hover:not(:disabled) { background: #1e40af; }
        .btn-start:disabled { opacity: 0.55; cursor: not-allowed; }
        .msg { font-size: 13px; padding: 8px 12px; border-radius: 8px; border: 1px solid; }
        .msg.error { background: #fff0f0; border-color: #fca5a5; color: #b91c1c; }
        .msg.success { background: #e9faef; border-color: #86efac; color: #166534; }
        .msg.success a { color: #166534; font-weight: 600; }
        @media (max-width: 900px) {
          .ops-grid { grid-template-columns: 1fr; }
          .two-col { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
