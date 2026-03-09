'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

export default function TopicsPage() {
  const params = useParams();
  const projectId = params.id;
  const [topics, setTopics] = useState([]);
  const [form, setForm] = useState({ title: '', primary_keyword: '', secondary_keywords: '', desired_word_count: 1200 });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const data = await apiFetch(`/api/projects/${projectId}/topics`);
      setTopics(data);
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  useEffect(() => {
    if (projectId) load();
  }, [projectId]);

  const addTopic = async (event) => {
    event.preventDefault();
    setError('');
    setMessage('');
    try {
      await apiFetch(`/api/topics/project/${projectId}`, {
        method: 'POST',
        body: JSON.stringify({
          title: form.title,
          primary_keyword: form.primary_keyword,
          secondary_keywords_json: form.secondary_keywords
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
          desired_word_count: Number(form.desired_word_count || 1200),
        }),
      });
      setForm({ title: '', primary_keyword: '', secondary_keywords: '', desired_word_count: 1200 });
      setMessage('Topic created');
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const runTopic = async (topicId) => {
    try {
      const data = await apiFetch(`/api/topics/${topicId}/run`, { method: 'POST' });
      setMessage(`Pipeline run queued: ${data.pipeline_run_id}`);
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const importCsv = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await apiFetch(`/api/projects/${projectId}/topics/import`, {
        method: 'POST',
        body: formData,
      });
      setMessage(`Imported ${data.inserted} topics`);
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  return (
    <AuthGate>
      <main>
        <Header title={`Topics ${projectId}`} />
        {message ? <div className="msg">{message}</div> : null}
        {error ? <div className="msg error">{error}</div> : null}

        <section className="card" style={{ marginBottom: 16 }}>
          <h3>Create Topic</h3>
          <form onSubmit={addTopic}>
            <div className="form-row">
              <label>
                Title
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} required />
              </label>
              <label>
                Primary Keyword
                <input value={form.primary_keyword} onChange={(e) => setForm({ ...form, primary_keyword: e.target.value })} required />
              </label>
            </div>
            <div className="form-row">
              <label>
                Secondary Keywords (comma-separated)
                <input value={form.secondary_keywords} onChange={(e) => setForm({ ...form, secondary_keywords: e.target.value })} />
              </label>
              <label>
                Desired Word Count
                <input
                  type="number"
                  value={form.desired_word_count}
                  onChange={(e) => setForm({ ...form, desired_word_count: e.target.value })}
                />
              </label>
            </div>
            <div className="stack">
              <button type="submit">Create Topic</button>
              <label>
                <span>Import CSV </span>
                <input type="file" accept=".csv" onChange={importCsv} />
              </label>
            </div>
          </form>
        </section>

        <section className="card">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Keyword</th>
                <th>Status</th>
                <th>Run</th>
              </tr>
            </thead>
            <tbody>
              {topics.map((topic) => (
                <tr key={topic.id}>
                  <td>{topic.title}</td>
                  <td>{topic.primary_keyword}</td>
                  <td>{topic.status}</td>
                  <td>
                    <button className="secondary" onClick={() => runTopic(topic.id)}>Run</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ marginTop: 12 }}>
            Open run details via URL: <code>/pipeline-runs/{`{run_id}`}</code>
          </p>
        </section>
      </main>
    </AuthGate>
  );
}
