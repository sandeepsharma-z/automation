'use client';

import Link from 'next/link';
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
  if (normalized.includes('storage/media/')) return `/media/${normalized.split('storage/media/')[1]}`;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

export default function DraftsPage() {
  const [projects, setProjects] = useState([]);
  const [drafts, setDrafts] = useState([]);
  const [projectId, setProjectId] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = async (selectedProjectId = projectId) => {
    try {
      setMessage('');
      const [projectRows, draftRows] = await Promise.all([
        apiFetch('/api/projects'),
        apiFetch(selectedProjectId ? `/api/drafts?project_id=${selectedProjectId}&limit=20` : '/api/drafts?limit=20'),
      ]);
      setProjects(projectRows || []);
      setDrafts(draftRows || []);
      setError('');
    } catch (err) {
      setError(parseApiError(err));
    }
  };

  useEffect(() => {
    load('');
  }, []);

  const projectMap = useMemo(() => {
    const map = {};
    projects.forEach((project) => {
      map[String(project.id)] = project;
    });
    return map;
  }, [projects]);

  const resolveImageSrc = (imagePath) => {
    const normalized = normalizeMediaPath(imagePath);
    if (!normalized) return '';
    return `${API_URL}${normalized}`;
  };

  const publishNow = async (draftId) => {
    try {
      setBusyId(draftId);
      setMessage('');
      setError('');
      try {
        await apiFetch(`/api/drafts/${draftId}/approve`, { method: 'POST' });
      } catch (_) {
        // already approved/published
      }
      await apiFetch(`/api/drafts/${draftId}/publish`, {
        method: 'POST',
        body: JSON.stringify({ mode: 'publish_now' }),
      });
      setMessage(`Draft #${draftId} publish queued.`);
      await load();
    } catch (err) {
      setError(parseApiError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <AuthGate>
      <main>
        <Header title="Drafts" subtitle="Review generated blogs, preview images, and publish to live site." />

        {message ? <div className="msg">{message}</div> : null}
        {error ? <div className="msg error">{error}</div> : null}

        <section className="card" style={{ marginBottom: 12 }}>
          <div className="projects-toolbar">
            <div>
              <h3>Draft Directory</h3>
              <p>Generated drafts are listed here with image preview and one-click publish.</p>
            </div>
            <div className="stack">
              <select
                value={projectId}
                onChange={(e) => {
                  const value = e.target.value;
                  setProjectId(value);
                  load(value);
                }}
              >
                <option value="">All projects</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} (#{project.id})
                  </option>
                ))}
              </select>
              <button className="secondary" onClick={() => load()}>Refresh</button>
            </div>
          </div>

          <div className="projects-list">
            {drafts.length === 0 ? (
              <div className="empty-state">
                <h4>No drafts found</h4>
                <p>Generate a blog from Blog Agent and it will appear here.</p>
              </div>
            ) : (
              drafts.map((draft) => (
                <article key={draft.id} className="project-row" style={{ alignItems: 'center' }}>
                  <div>
                    <h4>{draft.title}</h4>
                    <p>
                      Draft #{draft.id} | {draft.status} | {draft.platform} |{' '}
                      {projectMap[String(draft.project_id)]?.name || `Project #${draft.project_id}`}
                    </p>
                    {draft.image_path ? (
                      <img
                        src={resolveImageSrc(draft.image_path)}
                        alt={draft.title}
                        width="220"
                        height="120"
                        loading="lazy"
                        decoding="async"
                        style={{ objectFit: 'cover', borderRadius: 8, border: '1px solid #b7ccef' }}
                        onError={(e) => {
                          e.currentTarget.src = `${FALLBACK_API_URL}${normalizeMediaPath(draft.image_path)}`;
                        }}
                      />
                    ) : (
                      <p>No featured image</p>
                    )}
                  </div>
                  <div className="project-tags">
                    <span className="pill">Similarity {Number(draft?.similarity_score || 0).toFixed(3)}</span>
                    <span className="pill muted">
                      {draft?.created_at ? new Date(draft.created_at).toLocaleString() : 'n/a'}
                    </span>
                  </div>
                  <div className="stack">
                    <Link href={`/drafts/${draft.id}`}>
                      <button className="secondary">Preview</button>
                    </Link>
                    <button disabled={busyId === draft.id} onClick={() => publishNow(draft.id)}>
                      {busyId === draft.id ? 'Publishing...' : 'Publish Live'}
                    </button>
                  </div>
                </article>
              ))
            )}
          </div>
        </section>
      </main>
    </AuthGate>
  );
}
