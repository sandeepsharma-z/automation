'use client';

import { useEffect, useMemo } from 'react';

export default function GlobalError({ error, reset }) {
  const message = useMemo(() => String(error?.message || 'Unknown runtime error'), [error]);

  function isChunkError(text) {
    const value = String(text || '').toLowerCase();
    return value.includes('loading chunk') || value.includes('chunkloaderror');
  }

  function hardReload() {
    try {
      if (typeof window.caches?.keys === 'function') {
        window.caches.keys().then((keys) => keys.forEach((key) => window.caches.delete(key))).catch(() => {});
      }
    } catch (_) {
      // ignore cache API failures
    }
    const url = new URL(window.location.href);
    url.searchParams.set('__hr', String(Date.now()));
    window.location.replace(url.toString());
  }

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Global app error:', error);

    if (!isChunkError(message)) return;
    const key = 'admin_chunk_reload_once';
    try {
      if (sessionStorage.getItem(key) === '1') return;
      sessionStorage.setItem(key, '1');
      hardReload();
    } catch (_) {
      // keep manual actions available if storage is unavailable
    }
  }, [error, message]);

  useEffect(() => {
    if (isChunkError(message)) return;
    try {
      sessionStorage.removeItem('admin_chunk_reload_once');
    } catch (_) {
      // ignore
    }
  }, [message]);

  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}>
      <section className="card">
        <h3>UI crashed</h3>
        <p style={{ color: '#5d7fb6' }}>A client-side error occurred. Use Retry first, then Hard Reload if needed.</p>
        <pre className="codebox" style={{ marginBottom: 12 }}>
          {message}
        </pre>
        <div className="stack">
          <button onClick={() => reset()}>Retry</button>
          <button className="secondary" onClick={() => hardReload()}>
            Hard Reload
          </button>
        </div>
      </section>
    </main>
  );
}
