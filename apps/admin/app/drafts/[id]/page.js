'use client';

import { useEffect, useMemo, useState } from 'react';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8010';
const FALLBACK_API_URL = process.env.NEXT_PUBLIC_API_FALLBACK_URL || 'http://localhost:8000';

function parseApiError(err) {
  const message = String(err?.message || err || 'Unknown API error');
  try {
    const parsed = JSON.parse(message);
    if (parsed?.detail) return String(parsed.detail);
  } catch (_) {
    // no-op
  }
  return message;
}

function normalizeMediaPath(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/media/')) return normalized;
  if (normalized.includes('/media/')) return normalized.slice(normalized.indexOf('/media/'));
  if (normalized.startsWith('media/')) return `/${normalized}`;
  if (normalized.includes('storage/media/')) {
    return `/media/${normalized.split('storage/media/')[1]}`;
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function sanitizePreviewHtml(value) {
  const source = String(value || '');
  if (!source) return '';
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return source;
  }
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(source, 'text/html');
    const blockedSelectors = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base'];
    blockedSelectors.forEach((selector) => {
      doc.querySelectorAll(selector).forEach((node) => node.remove());
    });
    return doc.body?.innerHTML || source;
  } catch (_) {
    return source;
  }
}

function stripDebugSectionsFromHtml(value) {
  const source = String(value || '');
  if (!source) return '';
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return source;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(source, 'text/html');
    const labels = new Set([
      'sources analyzed',
      'what we improved vs analyzed pages',
      'key research signals',
      'research signals',
      'source urls',
      'sources',
      'references',
      'citations',
      'research links',
    ]);
    const norm = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    Array.from(doc.querySelectorAll('h2, h3, p')).forEach((heading) => {
      const label = norm(heading.textContent || '');
      if (!labels.has(label)) return;
      let node = heading.nextElementSibling;
      heading.remove();
      while (node) {
        const next = node.nextElementSibling;
        if (['H2', 'H3'].includes(node.tagName)) break;
        node.remove();
        node = next;
      }
    });
    const isFaqLabel = (label) => {
      const l = String(label || '').toLowerCase();
      return l.startsWith('frequently asked questions') || l.startsWith('frequently asked question') || l === 'faq' || l === 'faqs' || l.startsWith('faq ') || l.startsWith('faqs ') || l === 'faq section';
    };
    const detailQuestions = new Set(
      Array.from(doc.querySelectorAll('details > summary'))
        .map((n) => norm(n.textContent || '').replace(/\?+$/, ''))
        .filter(Boolean)
    );
    const hasAccordionFaq = detailQuestions.size > 0;
    if (hasAccordionFaq) {
      Array.from(doc.querySelectorAll('h3, h4')).forEach((heading) => {
        const key = norm(heading.textContent || '').replace(/\?+$/, '');
        if (!detailQuestions.has(key)) return;
        let node = heading.nextElementSibling;
        heading.remove();
        while (node) {
          const next = node.nextElementSibling;
          if (['H2', 'H3', 'H4'].includes(node.tagName)) break;
          node.remove();
          node = next;
        }
      });
      Array.from(doc.querySelectorAll('h2, h3, p')).forEach((node) => {
        const label = norm(node.textContent || '');
        if (isFaqLabel(label)) node.remove();
      });
      const firstDetails = doc.querySelector('details');
      if (firstDetails) {
        const faqH2 = doc.createElement('h2');
        faqH2.textContent = 'Frequently Asked Questions';
        firstDetails.parentNode.insertBefore(faqH2, firstDetails);
      }
    } else {
      let faqSeen = false;
      Array.from(doc.querySelectorAll('h2, h3, p')).forEach((heading) => {
        const label = norm(heading.textContent || '');
        if (!isFaqLabel(label)) return;
        if (!faqSeen) {
          faqSeen = true;
          return;
        }
        let node = heading.nextElementSibling;
        heading.remove();
        while (node) {
          const next = node.nextElementSibling;
          if (['H2'].includes(node.tagName)) break;
          node.remove();
          node = next;
        }
      });
    }
    Array.from(doc.querySelectorAll('p')).forEach((node) => {
      const txt = norm(node.textContent || '');
      if (txt.includes('action sprint')) {
        node.remove();
        return;
      }
      if (txt.includes('decision ready') || txt.includes('reader first') || txt.includes('execution focused')) {
        node.remove();
        return;
      }
      if (txt.includes('{{') || txt.includes('{%')) {
        node.remove();
        return;
      }
      if (txt.includes('key research signals')) node.remove();
      if (txt.includes('can be addressed effectively by aligning goals execution steps and measurable checkpoints')) {
        node.remove();
        return;
      }
      const raw = String(node.textContent || '').trim().toLowerCase();
      const urls = raw.match(/https?:\/\/\S+/g) || [];
      if (urls.length >= 2 || raw.startsWith('https://') || raw.startsWith('http://')) {
        node.remove();
      }
    });
    Array.from(doc.querySelectorAll('h2, h3')).forEach((node) => {
      const label = norm(node.textContent || '');
      if (label === 'in this guide') {
        let next = node.nextElementSibling;
        node.remove();
        while (next) {
          const cursor = next;
          next = next.nextElementSibling;
          if (['H2', 'H3'].includes(cursor.tagName)) break;
          cursor.remove();
        }
        return;
      }
      node.textContent = String(node.textContent || '').replace(/^\s*\d{1,2}\s*[\.\):-]?\s*/g, '').trim();
    });
    Array.from(doc.querySelectorAll('li')).forEach((node) => {
      const txt = String(node.textContent || '').trim().toLowerCase();
      if (txt.includes('action sprint') || txt.includes('{{') || txt.includes('{%')) {
        node.remove();
        return;
      }
      if (txt.startsWith('https://') || txt.startsWith('http://')) {
        node.remove();
      }
    });
    Array.from(doc.querySelectorAll('h1, h2, h3, h4')).forEach((node) => {
      const cleaned = String(node.textContent || '').replace(/^\s*\d{1,2}\s*[\.\):-]?\s*/g, '').trim();
      if (!cleaned) {
        node.remove();
        return;
      }
      node.textContent = cleaned;
    });
    Array.from(doc.querySelectorAll('details, details > summary, details > p')).forEach((node) => {
      node.removeAttribute('style');
    });
    return String(doc.body?.innerHTML || source)
      .replace(/\{\{[^}]+\}\}/g, '')
      .replace(/\{%[^%]+%\}/g, '');
  } catch (_) {
    return source;
  }
}

export default function DraftPage({ params }) {
  const rawDraftId = params?.id;
  const draftId = Array.isArray(rawDraftId) ? rawDraftId[0] : rawDraftId;
  const [draft, setDraft] = useState(null);
  const [draftState, setDraftState] = useState(null);
  const [scheduleAt, setScheduleAt] = useState('');
  const [message, setMessage] = useState('');
  const [publishResult, setPublishResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [mediaFallback, setMediaFallback] = useState({});

  const resolveImageSrc = (path, key) => {
    const normalized = normalizeMediaPath(path);
    if (!normalized) return '';
    const base = mediaFallback[key] ? FALLBACK_API_URL : API_URL;
    return `${base}${normalized}`;
  };

  const previewHtml = useMemo(() => {
    const sanitized = sanitizePreviewHtml(draft?.html || '');
    return stripDebugSectionsFromHtml(sanitized);
  }, [draft?.html]);

  const load = async () => {
    try {
      setBusy(true);
      setBusyLabel('Loading draft data...');
      setLoading(true);
      const data = await apiFetch(`/api/drafts/${draftId}`);
      setDraft(data);
      try {
        const state = await apiFetch(`/api/blog-agent/${draftId}`);
        setDraftState(state);
      } catch (_) {
        setDraftState(null);
      }
      setError('');
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setBusy(false);
      setBusyLabel('');
      setLoading(false);
    }
  };

  useEffect(() => {
    if (draftId) load();
  }, [draftId]);

  const save = async () => {
    try {
      setBusy(true);
      setBusyLabel('Saving draft...');
      await apiFetch(`/api/drafts/${draftId}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: draft.title,
          slug: draft.slug,
          html: draft.html,
          meta_title: draft.meta_title,
          meta_description: draft.meta_description,
          internal_links_json: draft.internal_links_json,
          status: draft.status,
        }),
      });
      setMessage('Draft saved');
      setError('');
      await load();
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const testConnection = async () => {
    if (!draft?.project_id) return;
    try {
      setBusy(true);
      setBusyLabel('Testing project connection...');
      const data = await apiFetch(`/api/projects/${draft.project_id}/test-connection`, { method: 'POST' });
      setMessage(`Connection OK: ${JSON.stringify(data.result || data)}`);
      setError('');
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const publish = async (mode) => {
    try {
      setBusy(true);
      setBusyLabel(mode === 'scheduled' ? 'Scheduling publish...' : 'Publishing to live site...');
      await apiFetch(`/api/drafts/${draftId}`, {
        method: 'PUT',
        body: JSON.stringify({
          title: draft.title,
          slug: draft.slug,
          html: draft.html,
          meta_title: draft.meta_title,
          meta_description: draft.meta_description,
          internal_links_json: draft.internal_links_json,
          status: draft.status,
        }),
      });
      const body = { mode };
      if (mode === 'scheduled') {
        if (!scheduleAt) {
          setError('Select a schedule datetime first');
          setBusy(false);
          setBusyLabel('');
          return;
        }
        body.scheduled_at = new Date(scheduleAt).toISOString();
      }

      if (mode !== 'draft' && draft?.status !== 'approved' && draft?.status !== 'published') {
        await apiFetch(`/api/drafts/${draftId}/approve`, { method: 'POST' });
      }

      const data = await apiFetch(`/api/drafts/${draftId}/publish`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setMessage(`Publish ${data.status || 'done'}: ${data.publish_record_id}`);
      setPublishResult(data);
      setError('');
      await load();
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  const approve = async () => {
    try {
      setBusy(true);
      setBusyLabel('Approving draft...');
      await apiFetch(`/api/drafts/${draftId}/approve`, { method: 'POST' });
      setMessage('Draft approved');
      setError('');
      await load();
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setBusy(false);
      setBusyLabel('');
    }
  };

  return (
    <AuthGate>
      <main>
        <Header title={`Draft ${draftId}`} />
        {message ? <div className="msg">{message}</div> : null}
        {publishResult?.published_url ? (
          <div className="msg">
            Published URL:{' '}
            <a href={publishResult.published_url} target="_blank" rel="noreferrer">
              {publishResult.published_url}
            </a>
          </div>
        ) : null}
        {error ? <div className="msg error">{error}</div> : null}
        {busy ? (
          <div className="msg sticky-generate-loader">
            <div style={{ width: '100%' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <span>{busyLabel || 'Working...'}</span>
                <strong>In progress</strong>
              </div>
              <div className="progress-shell">
                <div className="progress-fill" style={{ width: '92%' }} />
              </div>
            </div>
          </div>
        ) : null}
        {loading ? <div className="msg">Loading draft...</div> : null}
        {draft ? (
          <section className="card">
            <p>Status: <strong>{draft.status}</strong></p>
            <div className="form-row">
              <label>
                Title
                <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
              </label>
              <label>
                Slug
                <input value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
              </label>
            </div>
            <div className="form-row">
              <label>
                Meta Title
                <input value={draft.meta_title} onChange={(e) => setDraft({ ...draft, meta_title: e.target.value })} />
              </label>
              <label>
                Meta Description
                <input
                  value={draft.meta_description}
                  onChange={(e) => setDraft({ ...draft, meta_description: e.target.value })}
                />
              </label>
            </div>
            <div style={{ marginTop: 12 }}>
              <div className="projects-toolbar">
                <h3>Content</h3>
                <button className="secondary" onClick={() => setEditMode((prev) => !prev)}>
                  {editMode ? 'Switch to Preview' : 'Switch to Edit'}
                </button>
              </div>
              {editMode ? (
                <label>
                  HTML
                  <textarea rows={20} value={draft.html} onChange={(e) => setDraft({ ...draft, html: e.target.value })} />
                </label>
              ) : (
                <div className="blog-agent-html-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              )}
            </div>

            <section className="card" style={{ marginTop: 12 }}>
              <h3>Chosen Internal Links</h3>
              <p>Total: {draft.internal_links_json?.length || 0}</p>
              <table className="table">
                <thead>
                  <tr>
                    <th>Anchor</th>
                    <th>URL</th>
                  </tr>
                </thead>
                <tbody>
                  {(draft.internal_links_json || []).map((link, idx) => (
                    <tr key={`${link.url}-${idx}`}>
                      <td>{link.anchor}</td>
                      <td><a href={link.url} target="_blank" rel="noreferrer">{link.url}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section className="card" style={{ marginTop: 12 }}>
              <h3>Featured + Inline Images</h3>
              {(draftState?.image_path || draft?.image_path) ? (
                <div className="blog-agent-image-wrap">
                  <figure>
                    <figcaption>Featured</figcaption>
                    <img
                      src={resolveImageSrc(draftState?.image_path || draft?.image_path, `featured-${draftId}`)}
                      alt={draftState?.alt_text || draft?.alt_text || 'featured'}
                      loading="lazy"
                      decoding="async"
                      onError={() => setMediaFallback((prev) => ({ ...prev, [`featured-${draftId}`]: true }))}
                    />
                  </figure>
                </div>
              ) : (
                <p>No featured image attached to this draft.</p>
              )}

              <div className="blog-agent-inline-grid">
                {(draftState?.images || [])
                  .filter((img) => img.kind === 'inline')
                  .map((img) => (
                    <figure key={img.id}>
                      <figcaption>Inline #{img.position}</figcaption>
                      <img
                        src={resolveImageSrc(img.image_path, `inline-${img.id}`)}
                        alt={img.alt_text || `inline-${img.id}`}
                        loading="lazy"
                        decoding="async"
                        onError={() => setMediaFallback((prev) => ({ ...prev, [`inline-${img.id}`]: true }))}
                      />
                    </figure>
                  ))}
              </div>
            </section>

            <div className="stack" style={{ marginTop: 12 }}>
              <button disabled={busy} onClick={approve}>Approve</button>
              <button disabled={busy} onClick={save}>Save Draft</button>
              <button disabled={busy} className="secondary" onClick={() => publish('draft')}>Push as Draft</button>
              <button disabled={busy} className="secondary" onClick={() => publish('publish_now')}>Publish Now</button>
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
              />
              <button disabled={busy} className="secondary" onClick={() => publish('scheduled')}>Schedule Publish</button>
              <button disabled={busy} className="secondary" onClick={testConnection}>Test Project Connection</button>
            </div>
          </section>
        ) : null}
      </main>
    </AuthGate>
  );
}
