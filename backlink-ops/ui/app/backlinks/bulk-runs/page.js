"use client";

import { useMemo, useState } from "react";

const SCHEMA_FIELDS = [
  "backlink_type",
  "site_url",
  "site_name",
  "username",
  "email",
  "password",
  "company_name",
  "company_address",
  "company_phone",
  "company_description",
  "target_links",
  "anchor_text",
  "category",
  "notes",
  "tags",
];

function parseTableText(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const rows = lines.map((line) => splitCsvLine(line, delimiter));
  const headers = rows[0].map((h) => String(h || "").trim());
  return {
    headers,
    rows: rows.slice(1).map((cols) => {
      const out = {};
      headers.forEach((header, idx) => {
        out[header] = cols[idx] ?? "";
      });
      return out;
    }),
  };
}

function splitCsvLine(line, delimiter) {
  if (delimiter === "\t") return line.split("\t");
  const out = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

export default function BulkRunsPage() {
  const [rawText, setRawText] = useState("");
  const [mapping, setMapping] = useState({});
  const [preview, setPreview] = useState(null);
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(false);

  const parsed = useMemo(() => parseTableText(rawText), [rawText]);
  const mappedRows = useMemo(() => {
    if (!parsed.rows.length) return [];
    return parsed.rows.map((row) => {
      const out = {};
      for (const [csvHeader, schemaField] of Object.entries(mapping)) {
        if (!schemaField) continue;
        out[schemaField] = row[csvHeader];
      }
      return out;
    });
  }, [parsed, mapping]);

  async function loadFile(file) {
    if (!file) return;
    const text = await file.text();
    setRawText(text);
  }

  function autoMap() {
    const next = {};
    for (const header of parsed.headers) {
      const normalized = String(header || "").trim().toLowerCase().replace(/\s+/g, "_");
      if (SCHEMA_FIELDS.includes(normalized)) next[header] = normalized;
      else if (normalized === "target_link") next[header] = "target_links";
      else if (normalized === "type") next[header] = "backlink_type";
      else next[header] = "";
    }
    setMapping(next);
  }

  async function runPreview() {
    setError("");
    setMessage("");
    setLoadingPreview(true);
    try {
      const res = await fetch("/api/backlinks/bulk-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: mappedRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Preview failed");
      setPreview(data);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setLoadingPreview(false);
    }
  }

  async function importRows() {
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/backlinks/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: mappedRows }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      setMessage(`${data.created_count || 0} rows added to queue.`);
      await loadRuns();
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function loadRuns() {
    setError("");
    try {
      const res = await fetch("/api/backlinks/runs?include_rows=1", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to load runs");
      setRuns(Array.isArray(data.runs) ? data.runs : []);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Bulk Runs</h2>
      <div className="card" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>Bulk Import</h3>
        <div className="form-row">
          <label className="field">
            <span>Upload CSV</span>
            <input type="file" accept=".csv,.txt,.tsv" onChange={(e) => loadFile(e.target.files?.[0])} />
          </label>
        </div>
        <label className="field field-wide">
          <span>Paste CSV/TSV table</span>
          <textarea rows={8} value={rawText} onChange={(e) => setRawText(e.target.value)} placeholder="Paste rows with header here..." />
        </label>
        <div className="stack" style={{ marginTop: 10 }}>
          <button className="secondary" onClick={autoMap}>Auto Map Columns</button>
          <button onClick={runPreview} disabled={!mappedRows.length || loadingPreview}>Preview & Validate</button>
          <button onClick={importRows} disabled={!mappedRows.length}>Import To Queue</button>
          <button className="secondary" onClick={loadRuns}>Refresh Runs</button>
        </div>
      </div>

      {parsed.headers.length ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>Column Mapping</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>CSV Column</th>
                  <th>Map to Schema Field</th>
                </tr>
              </thead>
              <tbody>
                {parsed.headers.map((header) => (
                  <tr key={header}>
                    <td>{header}</td>
                    <td>
                      <select value={mapping[header] || ""} onChange={(e) => setMapping((prev) => ({ ...prev, [header]: e.target.value }))}>
                        <option value="">(ignore)</option>
                        {SCHEMA_FIELDS.map((field) => (
                          <option key={field} value={field}>{field}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3 style={{ marginTop: 0 }}>Validation Preview</h3>
          <div className="stack" style={{ marginBottom: 10 }}>
            <span className="pill">total: {preview.counts?.total || 0}</span>
            <span className="pill">allowed: {preview.counts?.allowed || 0}</span>
            <span className="pill">blocked: {preview.counts?.blocked || 0}</span>
            <span className="pill">mapping-needed: {preview.counts?.mapping_needed || 0}</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>site_url</th>
                  <th>backlink_type</th>
                  <th>target_links</th>
                  <th>status</th>
                  <th>reason</th>
                </tr>
              </thead>
              <tbody>
                {(preview.rows || []).slice(0, 40).map((item) => (
                  <tr key={`preview-${item.row_index}`}>
                    <td>{item.row_index}</td>
                    <td>{item.row?.site_url}</td>
                    <td>{item.row?.backlink_type || "business_directory"}</td>
                    <td>{item.target_links_count}</td>
                    <td><span className="pill">{item.status}</span></td>
                    <td>{item.status_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Run Monitoring</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Total Rows</th>
                <th>Row Counts</th>
                <th>Target Totals</th>
                <th>Rows / target status</th>
                <th>Export</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.run_id}>
                  <td>{run.run_id}</td>
                  <td>{run.total}</td>
                  <td><pre className="codebox">{JSON.stringify(run.counts || {}, null, 2)}</pre></td>
                  <td><pre className="codebox">{JSON.stringify(run.target_totals || {}, null, 2)}</pre></td>
                  <td>
                    <pre className="codebox">{JSON.stringify((run.rows || []).slice(0, 8), null, 2)}</pre>
                  </td>
                  <td>
                    <a href={`/api/backlinks/runs/export?run_id=${encodeURIComponent(run.run_id)}`} target="_blank" rel="noreferrer">Export CSV</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {message ? <div className="msg" style={{ marginTop: 12 }}>{message}</div> : null}
      {error ? <div className="msg error" style={{ marginTop: 12 }}>{error}</div> : null}
    </section>
  );
}

