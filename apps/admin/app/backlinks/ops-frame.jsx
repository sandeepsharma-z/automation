'use client';

import { useEffect, useMemo, useState } from 'react';

export default function BacklinkOpsFrame({ path, title, compact = false }) {
  const [health, setHealth] = useState({ loading: true, ok: false, base: '', tried: [], error: '' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let mounted = true;
    async function loadHealth() {
      setHealth((prev) => ({ ...prev, loading: true }));
      try {
        const res = await fetch('/api/backlinks/ops-health', { cache: 'no-store' });
        const data = await res.json();
        if (!mounted) return;
        setHealth({
          loading: false,
          ok: Boolean(data?.ok),
          base: String(data?.base || ''),
          tried: Array.isArray(data?.tried) ? data.tried : [],
          error: String(data?.error || ''),
        });
      } catch (err) {
        if (!mounted) return;
        setHealth({
          loading: false,
          ok: false,
          base: '',
          tried: [],
          error: String(err?.message || err),
        });
      }
    }
    loadHealth();
    return () => {
      mounted = false;
    };
  }, [reloadKey]);

  const src = useMemo(() => {
    if (!health.base) return '';
    const sep = path.includes('?') ? '&' : '?';
    return `${health.base}${path}${sep}__embed=1&__admin=1&__v=${Date.now()}`;
  }, [health.base, path, reloadKey]);

  return (
    <section className="card" style={{ padding: 14 }}>
      {!compact ? (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}>{title}</h3>
            <div style={{ fontSize: 13, opacity: 0.75 }}>
              Source: <code>{src || 'checking...'}</code>
            </div>
          </div>
          <div className="stack">
            {src ? (
              <a href={src} target="_blank" rel="noreferrer">
                <button>Open Full</button>
              </a>
            ) : null}
            <button className="secondary" onClick={() => setReloadKey((k) => k + 1)}>
              Reload
            </button>
          </div>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
          {src ? (
            <a href={src} target="_blank" rel="noreferrer">
              <button>Open Full</button>
            </a>
          ) : null}
          <button className="secondary" onClick={() => setReloadKey((k) => k + 1)}>
            Reload
          </button>
        </div>
      )}

      {health.loading ? (
        <div className="card" style={{ minHeight: '220px', display: 'grid', placeItems: 'center' }}>
          Checking Backlink Ops UI...
        </div>
      ) : null}

      {!health.loading && !health.ok ? (
        <div className="card" style={{ minHeight: '220px' }}>
          <h4 style={{ marginTop: 0 }}>Backlink Ops UI Not Reachable</h4>
          <p style={{ marginTop: 8 }}>
            Port `3015` par service down hai, isliye gray cloud page dikh rahi thi.
          </p>
          <p style={{ marginTop: 8 }}>
            Start command: <code>cd backlink-ops/ui && npm run dev</code>
          </p>
          {!!health.tried.length ? (
            <p style={{ marginTop: 8 }}>
              Tried: <code>{health.tried.join(', ')}</code>
            </p>
          ) : null}
          {health.error ? <p style={{ color: '#8a1734' }}>{health.error}</p> : null}
        </div>
      ) : null}

      {!health.loading && health.ok && src ? (
        <iframe
          key={src}
          title={title}
          src={src}
          style={{ width: '100%', minHeight: '75vh', border: '1px solid #c6d5f3', borderRadius: 12, background: '#fff' }}
        />
      ) : null}
    </section>
  );
}
