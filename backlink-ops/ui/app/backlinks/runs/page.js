"use client";

import { useEffect, useState } from "react";

export default function RunsPage() {
  const [runs, setRuns] = useState([]);
  const [error, setError] = useState("");

  async function load() {
    try {
      const res = await fetch("/api/backlinks/runs", { cache: "no-store" });
      const data = await res.json();
      setRuns(data.runs || []);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="card">
      <h2 style={{ marginTop: 0 }}>Runs</h2>
      <div className="row" style={{ marginBottom: 12 }}>
        <button onClick={load} className="secondary">
          Refresh
        </button>
      </div>
      {error ? <div style={{ color: "#b91c1c" }}>{error}</div> : null}
      <table>
        <thead>
          <tr>
            <th>Run ID</th>
            <th>Total Rows</th>
            <th>Counts</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.run_id}>
              <td>{run.run_id}</td>
              <td>{run.total}</td>
              <td>
                <pre>{JSON.stringify(run.counts || {}, null, 2)}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

