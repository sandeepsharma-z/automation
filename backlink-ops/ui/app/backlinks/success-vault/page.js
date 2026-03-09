"use client";

import { useEffect, useState } from "react";

export default function SuccessVaultPage() {
  const [entries, setEntries] = useState([]);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [error, setError] = useState("");

  async function load() {
    setError("");
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (type.trim()) params.set("type", type.trim());
      const res = await fetch(`/api/backlinks/success-vault?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load success vault");
      setEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Success Vault</h2>
      <div className="form-row">
        <label className="field">
          <span>Search</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="site, target, created link..." />
        </label>
        <label className="field">
          <span>Backlink Type</span>
          <input value={type} onChange={(e) => setType(e.target.value)} placeholder="business_directory" />
        </label>
      </div>
      <div className="stack" style={{ marginBottom: 12 }}>
        <button onClick={load}>Apply</button>
      </div>
      {error ? <div className="msg error">{error}</div> : null}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Type</th>
              <th>Site</th>
              <th>Target Link</th>
              <th>Submitted Comment Link</th>
              <th>Title</th>
              <th>Run</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, idx) => (
              <tr key={`${entry.run_id}-${entry.row_key}-${idx}`}>
                <td>{entry.timestamp || "-"}</td>
                <td>{entry.backlink_type || "-"}</td>
                <td>{entry.site_url || entry.site_name || "-"}</td>
                <td>{entry.target_link || "-"}</td>
                <td>
                  {(entry.submitted_comment_link || entry.created_link) ? (
                    <a href={(entry.submitted_comment_link || entry.created_link)} target="_blank" rel="noreferrer">
                      {(entry.submitted_comment_link || entry.created_link)}
                    </a>
                  ) : "-"}
                </td>
                <td>{entry.result_title || "-"}</td>
                <td>{entry.run_id || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
