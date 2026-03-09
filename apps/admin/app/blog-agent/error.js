'use client';

import { useEffect } from 'react';

export default function BlogAgentError({ error, reset }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('Blog Agent route error:', error);
  }, [error]);

  return (
    <main style={{ maxWidth: 980, margin: '0 auto', padding: 24 }}>
      <section className="card">
        <h3>Blog Agent crashed</h3>
        <p style={{ color: '#5d7fb6' }}>
          Blank screen avoid karne ke liye fallback dikhaya gaya hai. Niche retry karo.
        </p>
        <pre className="codebox" style={{ marginBottom: 12 }}>
          {String(error?.message || 'Unknown rendering error')}
        </pre>
        <div className="stack">
          <button onClick={() => reset()}>Try Again</button>
          <button className="secondary" onClick={() => window.location.reload()}>
            Hard Reload
          </button>
        </div>
      </section>
    </main>
  );
}
