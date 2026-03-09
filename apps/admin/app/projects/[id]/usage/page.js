'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

export default function UsagePage() {
  const params = useParams();
  const projectId = params.id;
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = async () => {
      try {
        const data = await apiFetch(`/api/projects/${projectId}/usage`);
        setUsage(data);
        setError('');
      } catch (err) {
        setError(String(err.message || err));
      }
    };
    if (projectId) load();
  }, [projectId]);

  return (
    <AuthGate>
      <main>
        <Header title={`Usage ${projectId}`} />
        {error ? <div className="msg error">{error}</div> : null}
        {usage ? (
          <section className="card-grid">
            <article className="card"><h3>Topics</h3><p>{usage.topics}</p></article>
            <article className="card"><h3>Pipeline Runs</h3><p>{usage.pipeline_runs}</p></article>
            <article className="card"><h3>Input Tokens</h3><p>{usage.token_input}</p></article>
            <article className="card"><h3>Output Tokens</h3><p>{usage.token_output}</p></article>
            <article className="card"><h3>Estimated Cost</h3><p>${usage.cost_estimate_usd.toFixed(4)}</p></article>
          </section>
        ) : null}
      </main>
    </AuthGate>
  );
}
