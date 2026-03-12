'use client';

import { useEffect, useRef, useState } from 'react';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

const STATUS_COLOR = {
  draft:     { bg: '#dbeafe', color: '#1e40af' },
  published: { bg: '#dcfce7', color: '#166534' },
  failed:    { bg: '#fee2e2', color: '#dc2626' },
  pending:   { bg: '#fef9c3', color: '#854d0e' },
};

function statusPill(status) {
  const s = String(status || 'draft').toLowerCase();
  const c = STATUS_COLOR[s] || STATUS_COLOR.draft;
  return (
    <span style={{ background: c.bg, color: c.color, borderRadius: 20, padding: '2px 10px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
      {s}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

/* ── Preview Modal ────────────────────────────────────────────────── */
function PreviewModal({ draftId, onClose }) {
  const [data, setData]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab]     = useState('preview');
  const iframeRef         = useRef(null);

  useEffect(() => {
    apiFetch(`/api/blog-agent/${draftId}`)
      .then((d) => setData(d))
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, [draftId]);

  useEffect(() => {
    if (tab !== 'preview' || !iframeRef.current || !data?.content_html) return;
    const doc = iframeRef.current.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:system-ui,sans-serif;line-height:1.78;padding:24px 32px;max-width:820px;margin:0 auto;color:#10244d}
      h1,h2,h3{color:#193766;line-height:1.3}h1{font-size:2rem}h2{font-size:1.4rem;margin-top:2rem;border-bottom:2px solid #e8f1ff;padding-bottom:.3rem}
      p{margin:.8rem 0}ul,ol{padding-left:1.4rem}li{margin:.3rem 0}
      code{background:#eef4ff;padding:2px 6px;border-radius:4px;font-size:.9em}
      blockquote{border-left:4px solid #2f6fff;margin:0;padding:8px 16px;background:#f0f6ff;border-radius:0 8px 8px 0}
      table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #c8daf5;padding:8px 12px}th{background:#e8f1ff}
      a{color:#2f6fff}details{border:1px solid #c5d8f8;border-radius:8px;margin:8px 0}summary{padding:10px 14px;font-weight:700;cursor:pointer}
    </style></head><body>${data.content_html}</body></html>`);
    doc.close();
  }, [tab, data]);

  function downloadHtml() {
    const blob = new Blob([data.content_html || ''], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${data.slug || `draft-${draftId}`}.html`;
    a.click();
  }

  function copyHtml() {
    navigator.clipboard.writeText(data?.content_html || '').catch(() => {});
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,30,80,.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: '#fff', borderRadius: 18, width: '100%', maxWidth: 980, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,.25)' }}>

        {/* Modal header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(124,169,243,.24)', display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(240,248,255,.9)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#132d58', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {loading ? 'Loading…' : (data?.title || `Draft #${draftId}`)}
            </div>
            {data?.slug && <code style={{ fontSize: 12, color: '#607eaf', background: 'none' }}>/{data.slug}</code>}
          </div>
          <button type="button" onClick={onClose} style={{ background: 'rgba(255,255,255,.8)', border: '1px solid rgba(124,169,243,.4)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer', fontSize: 13, color: '#274774' }}>✕ Close</button>
        </div>

        {loading && <div style={{ padding: 48, textAlign: 'center', color: '#607eaf' }}>Loading draft…</div>}
        {error  && <div style={{ padding: 24, color: '#dc2626' }}>{error}</div>}

        {data && !loading && (
          <>
            {/* Tabs */}
            <div style={{ display: 'flex', gap: 4, padding: '8px 16px', background: 'rgba(245,250,255,.8)', borderBottom: '1px solid rgba(124,169,243,.24)' }}>
              {[
                { id: 'preview', label: '👁 Preview' },
                { id: 'meta',    label: '🏷 SEO Meta' },
                { id: 'html',    label: '💻 HTML' },
              ].map((t) => (
                <button key={t.id} type="button" onClick={() => setTab(t.id)}
                  style={{ padding: '6px 14px', fontSize: 13, borderRadius: 8, border: tab === t.id ? '1px solid rgba(106,158,240,.55)' : '1px solid transparent', background: tab === t.id ? 'rgba(180,213,255,.85)' : 'transparent', color: tab === t.id ? '#123873' : '#4b6290', cursor: 'pointer', fontWeight: tab === t.id ? 700 : 400 }}>
                  {t.label}
                </button>
              ))}
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button type="button" onClick={copyHtml} style={{ padding: '5px 12px', fontSize: 12, borderRadius: 8, border: '1px solid rgba(124,169,243,.4)', background: 'rgba(219,234,254,.5)', color: '#274774', cursor: 'pointer' }}>📋 Copy HTML</button>
                <button type="button" onClick={downloadHtml} style={{ padding: '5px 12px', fontSize: 12, borderRadius: 8, border: '1px solid rgba(124,169,243,.4)', background: 'rgba(219,234,254,.5)', color: '#274774', cursor: 'pointer' }}>⬇️ Download</button>
              </div>
            </div>

            {tab === 'preview' && (
              <iframe ref={iframeRef} title="Preview" style={{ flex: 1, border: 'none', minHeight: 500 }} />
            )}

            {tab === 'meta' && (
              <div style={{ padding: '16px 20px', overflow: 'auto', display: 'grid', gap: 12 }}>
                {[
                  { key: 'Title',      val: data.title },
                  { key: 'Slug',       val: data.slug },
                  { key: 'Meta Title', val: data.meta_title },
                  { key: 'Meta Desc',  val: data.meta_description },
                  { key: 'Status',     val: data.status },
                  { key: 'Platform',   val: data.platform },
                  { key: 'Word Count', val: data.word_count },
                ].map(({ key, val }) => val && (
                  <div key={key} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, paddingBottom: 10, borderBottom: '1px solid rgba(124,169,243,.2)' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#5b7fb9', textTransform: 'uppercase', letterSpacing: '.05em', paddingTop: 2 }}>{key}</span>
                    <span style={{ fontSize: 14, color: '#10244d', lineHeight: 1.5 }}>{val}</span>
                  </div>
                ))}
              </div>
            )}

            {tab === 'html' && (
              <pre style={{ flex: 1, margin: 0, overflow: 'auto', background: '#0f172a', color: '#e2e8f0', padding: '16px 20px', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {data.content_html}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ── Main Page ──────────────────────────────────────────────────────── */
export default function BlogHistoryPage() {
  const [drafts, setDrafts]       = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [search, setSearch]       = useState('');
  const [previewId, setPreviewId] = useState(null);

  useEffect(() => {
    apiFetch('/api/drafts?limit=100')
      .then((d) => setDrafts(Array.isArray(d) ? d : []))
      .catch((e) => setError(String(e.message || e)))
      .finally(() => setLoading(false));
  }, []);

  const filtered = drafts.filter((d) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return String(d.title || '').toLowerCase().includes(q) || String(d.slug || '').toLowerCase().includes(q);
  });

  return (
    <AuthGate>
      <main>
        <Header title="📋 Blog History" subtitle="Previously generated blogs — preview, copy HTML, or download." />

        {previewId && <PreviewModal draftId={previewId} onClose={() => setPreviewId(null)} />}

        <div className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              placeholder="Search by title or slug…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: 220 }}
            />
            <span style={{ fontSize: 13, color: '#607eaf', whiteSpace: 'nowrap' }}>
              {filtered.length} blogs
            </span>
          </div>
        </div>

        {loading && <div className="card" style={{ padding: 48, textAlign: 'center', color: '#607eaf' }}>Loading blog history…</div>}
        {error   && <div className="msg error">{error}</div>}

        {!loading && filtered.length === 0 && (
          <div className="card empty-state" style={{ padding: 48, textAlign: 'center' }}>
            <div style={{ fontSize: '3rem', marginBottom: 12 }}>📄</div>
            <h4>No blogs found</h4>
            <p>Generate your first blog using External Blog Generator.</p>
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div style={{ display: 'grid', gap: 12 }}>
            {filtered.map((d) => (
              <div key={d.id} className="card" style={{ padding: '16px 20px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: '#5b7fb9', fontWeight: 600 }}>#{d.id}</span>
                    {statusPill(d.status)}
                    <span style={{ fontSize: 12, color: '#607eaf' }}>{fmtDate(d.created_at)}</span>
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: '#132d58', marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {d.title || `Draft #${d.id}`}
                  </div>
                  <code style={{ fontSize: 12, color: '#607eaf', background: 'none' }}>/{d.slug}</code>
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="secondary"
                    style={{ padding: '7px 14px', fontSize: 13 }}
                    onClick={() => setPreviewId(d.id)}
                  >
                    👁 Preview
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </AuthGate>
  );
}
