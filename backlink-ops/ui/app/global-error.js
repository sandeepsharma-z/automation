"use client";

import { useEffect, useMemo } from "react";

function isChunkError(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("loading chunk") || text.includes("chunkloaderror");
}

export default function GlobalError({ error, reset }) {
  const message = useMemo(() => String(error?.message || error || "Unknown error"), [error]);

  useEffect(() => {
    if (!isChunkError(message)) return;
    const key = "backlink_ops_chunk_reload_once";
    try {
      if (sessionStorage.getItem(key) === "1") return;
      sessionStorage.setItem(key, "1");
      window.location.reload();
    } catch (_) {
      // Ignore storage errors and keep manual controls visible.
    }
  }, [message]);

  return (
    <html lang="en">
      <body>
        <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
          <div
            style={{
              maxWidth: 920,
              margin: "0 auto",
              border: "1px solid #c6d5f3",
              borderRadius: 12,
              padding: 20,
              background: "#fff",
            }}
          >
            <h1 style={{ marginTop: 0 }}>UI crashed</h1>
            <p style={{ marginTop: 0, color: "#334155" }}>
              A client-side error occurred. Use Retry first. If chunk files changed, use Hard Reload.
            </p>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "#f8fafc",
                border: "1px solid #e2e8f0",
                borderRadius: 10,
                padding: 12,
              }}
            >
              {message}
            </pre>
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button onClick={() => reset()}>Retry</button>
              <button onClick={() => window.location.reload()} style={{ background: "#334155", color: "#fff" }}>
                Hard Reload
              </button>
            </div>
          </div>
        </main>
      </body>
    </html>
  );
}
