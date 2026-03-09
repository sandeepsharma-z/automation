'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

export default function LibraryPage() {
  const params = useParams();
  const projectId = params.id;
  const [items, setItems] = useState([]);
  const [ragStatus, setRagStatus] = useState(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const loadLibrary = async () => {
    const data = await apiFetch(`/api/projects/${projectId}/library`);
    setItems(data);
  };

  const loadRagStatus = async () => {
    const data = await apiFetch(`/api/projects/${projectId}/rag/status`);
    setRagStatus(data);
  };

  const load = async () => {
    try {
      setError('');
      await Promise.all([loadLibrary(), loadRagStatus()]);
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  useEffect(() => {
    if (projectId) load();
  }, [projectId]);

  const reindex = async () => {
    try {
      setError('');
      setMessage('');
      const res = await apiFetch(`/api/projects/${projectId}/reindex-library`, { method: 'POST' });
      setMessage(`Reindex queued: ${res.task_id}`);
      setTimeout(() => {
        loadRagStatus().catch(() => {});
      }, 2000);
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  return (
    <AuthGate>
      <main>
        <Header title={`Library ${projectId}`} />
        <div className="stack" style={{ marginBottom: 12 }}>
          <button className="secondary" onClick={load}>Refresh</button>
          <button onClick={reindex}>Reindex for RAG</button>
        </div>
        {message ? <div className="msg">{message}</div> : null}
        {error ? <div className="msg error">{error}</div> : null}

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>RAG Status</h3>
          <p>Indexed docs: {ragStatus?.doc_count ?? 0}</p>
          <p>Last indexed: {ragStatus?.indexed_at || 'Not indexed yet'}</p>
        </section>

        <section className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Title</th>
                <th>URL</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.type}</td>
                  <td>{item.title}</td>
                  <td><a href={item.url} target="_blank">{item.url}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </AuthGate>
  );
}
