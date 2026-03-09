"use client";

import { useEffect, useState } from "react";

export default function RowDetailPage({ params }) {
  const rowKey = params.rowKey;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [draftText, setDraftText] = useState("");

  async function load() {
    try {
      const res = await fetch(`/api/backlinks/row/${rowKey}`, { cache: "no-store" });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Unable to load row");
      setData(payload.row);
      const suggested = String(payload?.row?.artifacts?.approval_request?.draft_selected || "");
      setDraftText(suggested);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function retryRow() {
    setMessage("");
    setError("");
    try {
      const res = await fetch("/api/backlinks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_key: rowKey, headless: false }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Retry failed");
      setMessage(
        payload.already_running
          ? (payload.message || `Run already active: ${payload.session_id || payload.run_id}`)
          : `Retry started: run ${payload.run_id}`
      );
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function submitApproval(approved) {
    if (!data) return;
    try {
      const res = await fetch("/api/backlinks/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: data.run_id,
          site_slug: data.site_slug,
          approved,
          edited_draft: draftText,
        }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || "Approval update failed");
      setMessage(approved ? "Submitted for execution." : "Skipped by operator.");
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  useEffect(() => {
    load();
  }, [rowKey]);

  if (!data) {
    return <div className="card">{error || "Loading..."}</div>;
  }

  const hasApprovalRequest = Boolean(data.artifacts?.approval_request) && !data.artifacts?.approval_decision;
  const req = data.artifacts?.approval_request || {};
  const uniquenessLabel = String(req?.uniqueness_check?.label || "").trim();
  const showOnlyRegenerated = Boolean(req?.similarity_blocked);
  return (
    <div>
      <section className="card">
        <h2 style={{ marginTop: 0 }}>Row {rowKey}</h2>
        <div className="row">
          <button onClick={retryRow}>Retry (Approval required again)</button>
          {hasApprovalRequest ? (
            <>
              <button onClick={() => submitApproval(true)}>Submit</button>
              <button className="secondary" onClick={() => submitApproval(false)}>
                Skip
              </button>
            </>
          ) : null}
        </div>
        {message ? <p>{message}</p> : null}
        {error ? <p style={{ color: "#b91c1c" }}>{error}</p> : null}
      </section>

      <section className="card grid2">
        <div>
          <h3>Input Fields</h3>
          <pre>{JSON.stringify(data.input || {}, null, 2)}</pre>
        </div>
        <div>
          <h3>Output Fields</h3>
          <pre>{JSON.stringify(data.output || {}, null, 2)}</pre>
        </div>
      </section>

      {hasApprovalRequest ? (
        <section className="card">
          <h3>Ready To Submit Checkpoint</h3>
          <p><strong>Status:</strong> {String(req.status || "pending")}</p>
          {uniquenessLabel ? <p><strong>{uniquenessLabel}</strong></p> : null}
          {req?.duplicate_warning ? <p style={{ color: "#b45309" }}><strong>{String(req.duplicate_warning)}</strong></p> : null}
          <p><strong>Detected fields:</strong></p>
          <pre>{JSON.stringify(req.detected_fields || {}, null, 2)}</pre>
          <label className="field">
            <span>Editable Draft</span>
            <textarea rows={8} value={draftText} onChange={(e) => setDraftText(e.target.value)} />
          </label>
          <p><strong>Draft suggestions{showOnlyRegenerated ? " (regenerated)" : ""}:</strong></p>
          <pre>{JSON.stringify(req.draft_suggestions || [], null, 2)}</pre>
        </section>
      ) : null}

      <section className="card">
        <h3>Per Target Results</h3>
        <pre>{JSON.stringify(data.output?.results || [], null, 2)}</pre>
      </section>

      <section className="card">
        <h3>Artifacts</h3>
        {(data.artifacts?.screenshots || []).length ? (
          <div className="card-grid">
            {(data.artifacts?.screenshots || []).map((file) => (
              <img
                key={file}
                className="preview"
                src={`/api/backlinks/artifact?run_id=${encodeURIComponent(data.run_id)}&site_slug=${encodeURIComponent(
                  data.site_slug
                )}&file=${encodeURIComponent(file)}`}
                alt={file}
              />
            ))}
          </div>
        ) : <p>No screenshot</p>}
        {(data.artifacts?.html_files || []).map((file) => (
          <p key={file}>
            <a
              href={`/api/backlinks/artifact?run_id=${encodeURIComponent(data.run_id)}&site_slug=${encodeURIComponent(
                data.site_slug
              )}&file=${encodeURIComponent(file)}`}
              target="_blank"
            >
              Open {file}
            </a>
          </p>
        ))}
      </section>

      <section className="card">
        <h3>Run Logs</h3>
        <pre>{JSON.stringify(data.events || [], null, 2)}</pre>
      </section>
    </div>
  );
}
