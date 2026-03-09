'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

export default function PipelineRunPage() {
  const params = useParams();
  const runId = params.id;
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let timer;
    const load = async () => {
      try {
        const data = await apiFetch(`/api/pipeline-runs/${runId}`);
        setPayload(data);
        setError('');
        if (data.run?.status === 'running' || data.run?.status === 'queued') {
          timer = setTimeout(load, 2500);
        }
      } catch (err) {
        setError(String(err.message || err));
      }
    };
    if (runId) load();
    return () => clearTimeout(timer);
  }, [runId]);

  const draftId = payload?.events?.find((event) => event.meta_json?.draft_id)?.meta_json?.draft_id;

  return (
    <AuthGate>
      <main>
        <Header title={`Pipeline Run ${runId}`} />
        {error ? <div className="msg error">{error}</div> : null}
        {payload ? (
          <>
            <section className="card" style={{ marginBottom: 12 }}>
              <p>Status: {payload.run.status}</p>
              <p>Stage: {payload.run.stage}</p>
              {draftId ? <Link href={`/drafts/${draftId}`}>Open Draft #{draftId}</Link> : null}
            </section>
            <section className="card">
              <h3>Events</h3>
              <div className="codebox">
                {payload.events.map((event) => (
                  <div key={event.id}>
                    [{event.created_at}] {event.level.toUpperCase()} {event.message} {JSON.stringify(event.meta_json)}
                  </div>
                ))}
              </div>
            </section>
          </>
        ) : null}
      </main>
    </AuthGate>
  );
}
