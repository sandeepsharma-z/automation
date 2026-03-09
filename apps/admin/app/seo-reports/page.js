'use client';

import { useMemo, useState } from 'react';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

const DEFAULT_FORM = {
  website_url: '',
  keywords_text: '',
  country: 'in',
  language: 'en',
};

function parseKeywords(raw) {
  return String(raw || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function SeoReportsPage() {
  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState(null);

  const keywords = useMemo(() => parseKeywords(form.keywords_text), [form.keywords_text]);

  const runReport = async () => {
    if (!form.website_url.trim()) {
      setError('Website URL is required.');
      return;
    }
    if (!keywords.length) {
      setError('Add at least one keyword (one per line).');
      return;
    }

    setLoading(true);
    setError('');
    try {
      const data = await apiFetch('/api/seo-reports/run', {
        method: 'POST',
        body: JSON.stringify({
          website_url: form.website_url.trim(),
          keywords,
          country: form.country.trim().toLowerCase(),
          language: form.language.trim().toLowerCase(),
        }),
      });
      setReport(data);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthGate>
      <main>
        <Header
          title="SEO Reports"
          subtitle="Run keyword ranking reports by website URL and keyword set using your configured SERP provider."
        />

        {error ? <div className="msg error">{error}</div> : null}

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>Run Ranking Report</h3>
          <div className="form-row">
            <label>
              Website URL
              <input
                placeholder="https://example.com"
                value={form.website_url}
                onChange={(e) => setForm({ ...form, website_url: e.target.value })}
              />
            </label>
            <label>
              Country
              <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
            </label>
            <label>
              Language
              <input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} />
            </label>
          </div>

          <label>
            Keywords (one per line)
            <textarea
              rows={8}
              placeholder={'dental implants in india\nbest braces clinic jaipur\nsmile makeover cost'}
              value={form.keywords_text}
              onChange={(e) => setForm({ ...form, keywords_text: e.target.value })}
            />
          </label>

          <div className="stack">
            <button onClick={runReport} disabled={loading}>
              {loading ? 'Running Report...' : 'Generate SEO Report'}
            </button>
            <span className="pill muted">Keywords detected: {keywords.length}</span>
          </div>
        </section>

        {report ? (
          <>
            <section className="card" style={{ marginBottom: 12 }}>
              <h3>Summary</h3>
              <div className="stats-grid">
                <article className="stat-card">
                  <p>Domain</p>
                  <h2>{report.domain}</h2>
                  <span>Target website</span>
                </article>
                <article className="stat-card">
                  <p>Found</p>
                  <h2>{report.summary?.found_count ?? 0}</h2>
                  <span>Keywords with ranking</span>
                </article>
                <article className="stat-card">
                  <p>Average Rank</p>
                  <h2>{report.summary?.average_rank ?? 'NA'}</h2>
                  <span>Across found keywords</span>
                </article>
                <article className="stat-card">
                  <p>Visibility</p>
                  <h2>{report.summary?.visibility_percent ?? 0}%</h2>
                  <span>Found / total keywords</span>
                </article>
              </div>
            </section>

            <section className="card">
              <h3>Keyword Rankings</h3>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Keyword</th>
                      <th>Rank</th>
                      <th>Matched URL</th>
                      <th>Top Results</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.items || []).map((item) => (
                      <tr key={item.keyword}>
                        <td>{item.keyword}</td>
                        <td>{item.rank || 'Not in top results'}</td>
                        <td>
                          {item.found_url ? (
                            <a href={item.found_url} target="_blank" rel="noreferrer">
                              {item.found_url}
                            </a>
                          ) : (
                            'NA'
                          )}
                        </td>
                        <td>
                          <div style={{ display: 'grid', gap: 6 }}>
                            {(item.top_results || []).slice(0, 5).map((row) => (
                              <div key={`${item.keyword}-${row.position}`}>
                                {row.position}.{' '}
                                <a href={row.url} target="_blank" rel="noreferrer">
                                  {row.title || row.url}
                                </a>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </main>
    </AuthGate>
  );
}
