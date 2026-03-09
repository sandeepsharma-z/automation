'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

export default function PatternsPage() {
  const params = useParams();
  const projectId = params.id;
  const [patterns, setPatterns] = useState([]);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    try {
      const data = await apiFetch(`/api/projects/${projectId}/patterns`);
      const shaped = (data || []).map((pattern) => ({
        ...pattern,
        outline_text: (pattern.outline_json || []).join('\n'),
        cta_text: pattern.cta_text || '',
        faq_schema_enabled: Boolean(pattern.faq_schema_enabled),
      }));
      setPatterns(shaped);
      setError('');
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  useEffect(() => {
    if (projectId) load();
  }, [projectId]);

  const toggle = async (patternId) => {
    try {
      await apiFetch(`/api/projects/${projectId}/patterns/${patternId}/toggle`, { method: 'POST' });
      setMsg('Pattern toggled');
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const savePattern = async (pattern) => {
    try {
      await apiFetch(`/api/projects/${projectId}/patterns/${pattern.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          outline_json: pattern.outline_text
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean),
          cta_text: pattern.cta_text,
          faq_schema_enabled: Boolean(pattern.faq_schema_enabled),
          enabled: Boolean(pattern.enabled),
        }),
      });
      setMsg(`Saved ${pattern.pattern_key}`);
      setError('');
      await load();
    } catch (err) {
      setError(String(err.message || err));
    }
  };

  const patchLocal = (id, field, value) => {
    setPatterns((prev) => prev.map((pattern) => (pattern.id === id ? { ...pattern, [field]: value } : pattern)));
  };

  return (
    <AuthGate>
      <main>
        <Header title={`Patterns ${projectId}`} />
        {msg ? <div className="msg">{msg}</div> : null}
        {error ? <div className="msg error">{error}</div> : null}
        <section className="card-grid">
          {patterns.map((pattern) => (
            <article className="card" key={pattern.id}>
              <h3>{pattern.pattern_key}</h3>
              <p>Usage: {pattern.usage_count}</p>
              <div className="stack" style={{ marginBottom: 8 }}>
                <button className="secondary" onClick={() => toggle(pattern.id)}>
                  {pattern.enabled ? 'Disable' : 'Enable'}
                </button>
              </div>
              <label>
                Outline Skeleton (one heading per line)
                <textarea
                  rows={6}
                  value={pattern.outline_text}
                  onChange={(e) => patchLocal(pattern.id, 'outline_text', e.target.value)}
                />
              </label>
              <label>
                CTA Text
                <input
                  value={pattern.cta_text}
                  onChange={(e) => patchLocal(pattern.id, 'cta_text', e.target.value)}
                />
              </label>
              <label>
                FAQ Schema
                <select
                  value={pattern.faq_schema_enabled ? 'true' : 'false'}
                  onChange={(e) => patchLocal(pattern.id, 'faq_schema_enabled', e.target.value === 'true')}
                >
                  <option value="false">disabled</option>
                  <option value="true">enabled</option>
                </select>
              </label>
              <div className="stack" style={{ marginTop: 8 }}>
                <button onClick={() => savePattern(pattern)}>Save Pattern</button>
              </div>
            </article>
          ))}
        </section>
      </main>
    </AuthGate>
  );
}
