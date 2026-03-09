'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

export default function ProjectsPage() {
  const [projects, setProjects] = useState([]);
  const [recentDrafts, setRecentDrafts] = useState([]);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setError('');
      const data = await apiFetch('/api/projects');
      setProjects(data);
      const drafts = await apiFetch('/api/drafts?limit=20');
      setRecentDrafts(drafts || []);
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const metrics = useMemo(() => {
    const total = projects.length;
    const wp = projects.filter((item) => item.platform === 'wordpress').length;
    const shopify = projects.filter((item) => item.platform === 'shopify').length;
    const withOpenAI = projects.filter((item) => Boolean(item.settings_json?.openai_api_key_enc)).length;
    const drafts = recentDrafts.length;
    return { total, wp, shopify, withOpenAI, drafts };
  }, [projects, recentDrafts]);

  const latestByProject = useMemo(() => {
    const map = {};
    recentDrafts.forEach((draft) => {
      if (!map[String(draft.project_id)]) {
        map[String(draft.project_id)] = draft;
      }
    });
    return map;
  }, [recentDrafts]);

  return (
    <AuthGate>
      <main>
        <Header title="Projects" subtitle="Manage site connections, defaults, and execution pipelines from one control surface." />

        <section className="stats-grid">
          <article className="stat-card">
            <p>Total Projects</p>
            <h3>{metrics.total}</h3>
            <span>Active workspaces</span>
          </article>
          <article className="stat-card">
            <p>WordPress</p>
            <h3>{metrics.wp}</h3>
            <span>Connected blogs/stores</span>
          </article>
          <article className="stat-card">
            <p>Shopify</p>
            <h3>{metrics.shopify}</h3>
            <span>Connected shops</span>
          </article>
          <article className="stat-card">
            <p>OpenAI Ready</p>
            <h3>{metrics.withOpenAI}</h3>
            <span>Projects with key override</span>
          </article>
          <article className="stat-card">
            <p>Recent Drafts</p>
            <h3>{metrics.drafts}</h3>
            <span>Latest generated content</span>
          </article>
        </section>

        <section className="card">
          <div className="projects-toolbar">
            <div>
              <h3>Project Directory</h3>
              <p>Open a project to manage sync, topics, patterns, and publishing.</p>
            </div>
            <div className="stack">
              <Link href="/projects/new">
                <button>Create Project</button>
              </Link>
              <button className="secondary" onClick={load}>Refresh</button>
            </div>
          </div>

          {error ? <div className="msg error">{error}</div> : null}

          <div className="projects-list">
            {projects.length === 0 ? (
              <div className="empty-state">
                <h4>No projects yet</h4>
                <p>Create your first project to start the content pipeline.</p>
              </div>
            ) : (
              projects.map((project) => (
                <article key={project.id} className="project-row">
                  <div>
                    <h4>{project.name}</h4>
                    <p>{project.base_url}</p>
                    {latestByProject[String(project.id)] ? (
                      <p style={{ marginTop: 6 }}>
                        Latest Draft: <strong>{latestByProject[String(project.id)].title}</strong>{' '}
                        ({latestByProject[String(project.id)].status})
                      </p>
                    ) : (
                      <p style={{ marginTop: 6 }}>Latest Draft: none</p>
                    )}
                  </div>
                  <div className="project-tags">
                    <span className="pill">{project.platform}</span>
                    <span className="pill muted">ID #{project.id}</span>
                  </div>
                  <div>
                    <Link href={`/projects/${project.id}`}>
                      <button className="secondary">Open Workspace</button>
                    </Link>
                    {latestByProject[String(project.id)] ? (
                      <Link href={`/drafts/${latestByProject[String(project.id)].id}`}>
                        <button style={{ marginLeft: 8 }}>Open Latest Draft</button>
                      </Link>
                    ) : null}
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
