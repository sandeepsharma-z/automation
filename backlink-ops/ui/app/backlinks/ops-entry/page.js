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

  // Live results
  const [recentJobs, setRecentJobs] = useState([]);
  const pollRef = useRef(null);

  async function loadRecentJobs() {
    try {
      const res = await fetch("/api/backlinks/queue?limit=20&type=blog_commenting", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const rows = Array.isArray(data.rows) ? data.rows : [];
      setRecentJobs(rows.slice(0, 20));
    } catch (_) {}
  }

  useEffect(() => {
    loadRecentJobs();
    pollRef.current = setInterval(loadRecentJobs, 5000);
    return () => clearInterval(pollRef.current);
  }, []);

  // Load profile from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(PROFILE_KEY);
      if (saved) setProfile((prev) => ({ ...prev, ...JSON.parse(saved) }));
    } catch (_) {}
  }, []);
  useEffect(() => {
    fetch("/api/backlinks/profile", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!data?.profile) return;
        setProfile((prev) => ({
          ...prev,
          website_url: data.profile.default_website_url || prev.website_url,
          author_name: data.profile.default_username || prev.author_name,
          email: data.profile.default_email || prev.email,
          password: data.profile.default_password || prev.password,
          company_name: data.profile.company_name || prev.company_name,
          company_address: data.profile.company_address || prev.company_address,
          company_phone: data.profile.company_phone || prev.company_phone,
          company_description: data.profile.company_description || prev.company_description,
          notes: data.profile.notes || prev.notes,
        }));
      })
      .catch(() => {});
  }, []);

  function saveProfile() {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      setProfileSaved(true);
      setTimeout(() => setProfileSaved(false), 2000);
      fetch("/api/backlinks/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          default_website_url: profile.website_url,
          default_username: profile.author_name,
          default_email: profile.email,
          default_password: profile.password,
          default_site_name: profile.company_name || profile.author_name,
          company_name: profile.company_name,
          company_address: profile.company_address,
          company_phone: profile.company_phone,
          company_description: profile.company_description,
          notes: profile.notes,
        }),
      }).catch(() => {});
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
              <span>Your Name <em>(shown as commenter name on blogs)</em></span>
              <input placeholder="John Smith" value={profile.author_name} onChange={(e) => setProfileField("author_name", e.target.value)} />
            </label>
            <label className="field">
              <span>Email <em>(filled in email field)</em></span>
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

      {/* ── LIVE RESULTS ─────────────────────────────────────────────── */}
      {recentJobs.length > 0 && (
        <div className="card-inner results-panel" style={{ marginTop: 16 }}>
          <div className="section-header">
            <span>Recent Blog Comment Jobs</span>
            <button className="btn-sm secondary" onClick={loadRecentJobs}>Refresh</button>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table className="link-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Blog URL</th>
                  <th>Status</th>
                  <th>Result</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {recentJobs.map((job, i) => {
                  const blogUrl = String(job.input?.directory_url || job.directory_url || "");
                  const st = String(job.output?.status || job.status || "queued");
                  const createdLink = String(job.output?.created_link || job.created_link || "");
                  const statusReason = String(job.output?.status_reason || job.status_reason || "");
                  const createdAt = job.input?.created_at || job.created_at || "";
                  const stClass = st === "success" || st === "completed" ? "status-completed"
                    : st === "running" ? "status-running"
                    : st === "failed" ? "status-failed"
                    : "status-queued";
                  return (
                    <tr key={job.row_key || i}>
                      <td className="num-cell">{job.row_key}</td>
                      <td>
                        <a href={blogUrl} target="_blank" rel="noreferrer" className="link-url">
                          {blogUrl.replace(/^https?:\/\//, "").slice(0, 60)}
                        </a>
                      </td>
                      <td><span className={`chip ${stClass}`}>{st}</span></td>
                      <td className="result-cell">
                        {createdLink
                          ? <a href={createdLink} target="_blank" rel="noreferrer" className="link-url">View ↗</a>
                          : <span className="muted">{statusReason.slice(0, 60) || "-"}</span>}
                      </td>
                      <td className="muted">{toRelativeTime(createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <style jsx>{`
        .ops-root { max-width: 1400px; margin: 0 auto; }
        .ops-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.4fr) minmax(260px, 0.7fr);
          gap: 16px;
          align-items: start;
        }
        .card-inner {
          background: #fff;
          border: 1px solid #dde5f7;
          border-radius: 14px;
          padding: 20px;
          box-shadow: 0 2px 12px rgba(30,60,140,.07), 0 1px 3px rgba(30,60,140,.05);
        }
        .section-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          padding-bottom: 12px;
          border-bottom: 1px solid #eef2fc;
          font-weight: 700;
          font-size: 14px;
          color: #0f1c3a;
        }
        .two-col {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        .field {
          display: flex;
          flex-direction: column;
          gap: 5px;
          margin-bottom: 12px;
        }
        .field span { font-size: 12.5px; font-weight: 600; color: #3d5080; }
        .field em { font-style: normal; color: #94a3b8; font-weight: 400; }
        .field input, .field textarea, .field select {
          border: 1.5px solid #dde5f7;
          border-radius: 9px;
          padding: 9px 12px;
          font-size: 13.5px;
          background: #f8fbff;
          transition: border-color .15s, box-shadow .15s;
          outline: none;
          color: #0f1c3a;
        }
        .field input:focus, .field textarea:focus {
          border-color: #2563eb;
          box-shadow: 0 0 0 3px rgba(37,99,235,.1);
          background: #fff;
        }
        .field textarea { resize: vertical; }
        .field input::placeholder, .field textarea::placeholder { color: #b0bdd6; }
        .row { display: flex; align-items: center; gap: 8px; }
        .muted { color: #7a90b8; font-size: 12.5px; }
        .btn-sm {
          padding: 6px 14px;
          border-radius: 8px;
          font-size: 12.5px;
          font-weight: 600;
          cursor: pointer;
          border: 1.5px solid #dde5f7;
          background: #f8fbff;
          color: #3d5080;
          transition: all .15s;
        }
        .btn-sm:hover { background: #eff4ff; border-color: #2563eb; color: #2563eb; }
        .btn-sm.secondary { background: #f1f5f9; color: #3d5080; border-color: #d1daf0; }
        .runs-list { display: flex; flex-direction: column; gap: 7px; max-height: 340px; overflow-y: auto; }
        .run-item {
          width: 100%; text-align: left; border: 1.5px solid #dde5f7; border-radius: 10px;
          padding: 10px 12px; background: #f8fbff; cursor: pointer; font-size: 13px;
          transition: all .15s;
        }
        .run-item:hover { background: #eff4ff; border-color: #93c5fd; }
        .run-item.is-active { background: #eff4ff; border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.1); }
        .run-row { display: flex; justify-content: space-between; align-items: center; font-weight: 600; }
        .run-meta { display: flex; justify-content: space-between; font-size: 11.5px; color: #7a90b8; margin-top: 5px; }
        .empty-hint {
          border: 1.5px dashed #c5d5f0; border-radius: 10px; padding: 20px;
          color: #7a90b8; font-size: 13.5px; text-align: center; background: #f8fbff;
        }
        .empty-hint a { color: #2563eb; font-weight: 600; }
        .sticky-bar {
          position: sticky; top: 0; z-index: 2; padding: 10px 0;
          background: #fff; display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
          border-bottom: 1px solid #eef2fc; margin-bottom: 10px;
        }
        .sticky-bar input {
          border: 1.5px solid #dde5f7; border-radius: 9px; padding: 7px 12px;
          font-size: 13px; background: #f8fbff; outline: none;
          transition: border-color .15s;
        }
        .sticky-bar input:focus { border-color: #2563eb; background: #fff; }
        .link-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .link-table th {
          padding: 9px 10px; text-align: left; font-size: 11.5px; font-weight: 700;
          text-transform: uppercase; letter-spacing: .04em;
          background: #f5f8ff; border-bottom: 2px solid #dde5f7; color: #7a90b8;
          position: sticky; top: 50px; z-index: 1;
        }
        .link-table td { padding: 9px 10px; border-bottom: 1px solid #f0f4fb; vertical-align: middle; }
        .link-table tr:hover td { background: #f5f8ff; }
        .link-table tr.is-selected td { background: #eff4ff; }
        .link-url { color: #2563eb; text-decoration: none; font-size: 12.5px; word-break: break-all; font-weight: 500; }
        .link-url:hover { text-decoration: underline; }
        .link-title { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
        .chip {
          display: inline-block; padding: 3px 9px; border-radius: 999px;
          font-size: 11px; font-weight: 700; border: 1px solid #d4ddf1;
        }
        .status-completed, .status-success { background: #f0fdf4; border-color: #86efac; color: #16a34a; }
        .status-queued  { background: #f5f8ff; border-color: #bfdbfe; color: #1d4ed8; }
        .status-running { background: #eff4ff; border-color: #93c5fd; color: #1d4ed8; }
        .status-failed  { background: #fff1f1; border-color: #fca5a5; color: #dc2626; }
        .status-no_results { background: #f8f8f8; border-color: #d1d5db; color: #6b7280; }
        .type-blog-comment { background: #eff4ff; border-color: #bfdbfe; color: #1e40af; }
        .type-write-for-us { background: #f0fdf4; border-color: #86efac; color: #166534; }
        .type-forum { background: #fefce8; border-color: #fde68a; color: #92400e; }
        .type-general { background: #f8fafc; border-color: #cbd5e1; color: #475569; }
        .submit-bar {
          position: sticky; bottom: 0; background: rgba(255,255,255,.97); backdrop-filter: blur(8px); z-index: 10;
          border-top: 1px solid #dde5f7; padding: 14px 0; margin-top: 16px;
          display: flex; align-items: center; gap: 14px;
        }
        .btn-start {
          padding: 13px 32px;
          background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
          color: #fff; border: none; border-radius: 11px;
          font-size: 15px; font-weight: 700; cursor: pointer; white-space: nowrap;
          box-shadow: 0 4px 16px rgba(37,99,235,.35);
          transition: all .15s;
        }
        .btn-start:hover:not(:disabled) {
          box-shadow: 0 6px 20px rgba(37,99,235,.45);
          transform: translateY(-1px);
        }
        .btn-start:disabled { opacity: 0.5; cursor: not-allowed; transform: none; box-shadow: none; }
        .msg { font-size: 13px; padding: 10px 14px; border-radius: 9px; border: 1px solid; line-height: 1.5; }
        .msg.error { background: #fff1f1; border-color: #fca5a5; color: #b91c1c; }
        .msg.success { background: #f0fdf4; border-color: #86efac; color: #15803d; }
        .msg.success a { color: #15803d; font-weight: 600; text-decoration: underline; }
        .results-panel { margin-top: 16px; }
        .num-cell { font-size: 12px; color: #7a90b8; font-weight: 600; width: 40px; }
        .result-cell { max-width: 280px; font-size: 12.5px; }
        @media (max-width: 900px) {
          .ops-grid { grid-template-columns: 1fr; }
          .two-col { grid-template-columns: 1fr; }
        }
      `}</style>
    </div>
  );
}
