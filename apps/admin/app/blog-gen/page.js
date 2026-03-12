'use client';

import { useEffect, useRef, useState } from 'react';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

/* ─── Tag-chip input ─────────────────────────────────────────────────── */
function TagInput({ value, onChange, placeholder }) {
  const [input, setInput] = useState('');
  const tags = Array.isArray(value) ? value : [];

  function add(raw) {
    const newTags = raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s && !tags.includes(s));
    if (newTags.length) onChange([...tags, ...newTags]);
    setInput('');
  }

  function onKeyDown(e) {
    if (['Enter', ',', 'Tab'].includes(e.key)) {
      e.preventDefault();
      if (input.trim()) add(input);
    } else if (e.key === 'Backspace' && !input && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  function onPaste(e) {
    e.preventDefault();
    add(e.clipboardData.getData('text'));
  }

  return (
    <div className="tag-wrap">
      {tags.map((t, i) => (
        <span key={i} className="bg-tag">
          {t}
          <button
            type="button"
            className="tag-del"
            onClick={() => onChange(tags.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </span>
      ))}
      <input
        className="tag-input-bare"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => { if (input.trim()) add(input); }}
        placeholder={tags.length === 0 ? placeholder : 'Add more…'}
      />
    </div>
  );
}

/* ─── Progress steps ─────────────────────────────────────────────────── */
const STEPS = [
  { icon: '🔍', label: 'Searching top-ranking competitor pages…' },
  { icon: '📖', label: 'Reading & extracting competitor content…' },
  { icon: '🧠', label: 'Analysing content gaps & NLP signals…' },
  { icon: '✍️', label: 'Writing your SEO-optimised blog post…' },
  { icon: '✅', label: 'Running quality checks & finalising…' },
];

function ProgressPanel({ step }) {
  return (
    <div className="bg-progress card">
      <div className="bg-spinner" />
      <p style={{ textAlign: 'center', color: '#4064a6', margin: '0 0 20px', fontWeight: 600 }}>
        Generating your blog — please wait (60–120s)
      </p>
      <div style={{ display: 'grid', gap: 10 }}>
        {STEPS.map((s, i) => (
          <div
            key={i}
            className={`bg-step ${i < step ? 'step-done' : i === step ? 'step-active' : 'step-wait'}`}
          >
            <span style={{ fontSize: '1.1rem', width: 24, textAlign: 'center' }}>
              {i < step ? '✅' : s.icon}
            </span>
            <span>{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── HTML Preview iframe ────────────────────────────────────────────── */
function HtmlPreview({ html }) {
  const iframeRef = useRef(null);
  useEffect(() => {
    if (!iframeRef.current) return;
    const doc = iframeRef.current.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:system-ui,sans-serif;line-height:1.78;padding:24px 32px;max-width:820px;margin:0 auto;color:#10244d}
      h1,h2,h3{color:#193766;line-height:1.3}h1{font-size:2rem}h2{font-size:1.4rem;margin-top:2rem;border-bottom:2px solid #e8f1ff;padding-bottom:.3rem}
      h3{font-size:1.1rem}p{margin:.8rem 0}ul,ol{padding-left:1.4rem}li{margin:.3rem 0}
      code{background:#eef4ff;padding:2px 6px;border-radius:4px;font-size:.9em;color:#1a3f7a}
      pre{background:#eef4ff;padding:12px;border-radius:8px;overflow-x:auto}
      blockquote{border-left:4px solid #2f6fff;margin:0;padding:8px 16px;background:#f0f6ff;color:#193766;border-radius:0 8px 8px 0}
      table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid #c8daf5;padding:8px 12px}th{background:#e8f1ff;color:#193766}
      img{max-width:100%;border-radius:8px}a{color:#2f6fff}
      details{border:1px solid #c5d8f8;border-radius:8px;margin:8px 0}summary{padding:10px 14px;font-weight:700;cursor:pointer;color:#193766}
    </style></head><body>${html}</body></html>`);
    doc.close();
  }, [html]);
  return <iframe ref={iframeRef} className="bg-iframe" title="Blog Preview" />;
}

/* ─── Copy button ────────────────────────────────────────────────────── */
function CopyBtn({ text, label = 'Copy' }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button type="button" className="secondary" style={{ padding: '6px 12px', fontSize: 13 }} onClick={copy}>
      {copied ? '✅ Copied!' : `📋 ${label}`}
    </button>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────────── */
const DEFAULT_FORM = {
  project_id: '',
  topic: '',
  primary_keyword: '',
  secondary_keywords: [],
  nlp_terms: [],
  note: '',
  word_count: 1500,
  tone: 'auto',
  country: 'in',
  gen_image: false,
  image_prompt: '',
  image_size: '1024x1024',
};

export default function BlogGenPage() {
  const [form, setForm]         = useState(DEFAULT_FORM);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [step, setStep]         = useState(0);
  const [draft, setDraft]       = useState(null);
  const [error, setError]       = useState('');
  const [tab, setTab]           = useState('preview');
  const [genImage, setGenImage] = useState(null);   // { b64, revised_prompt, size }
  const [imgLoading, setImgLoading] = useState(false);
  const [imgError, setImgError] = useState('');
  const stepTimer               = useRef(null);

  /* load projects */
  useEffect(() => {
    apiFetch('/api/projects')
      .then((data) => {
        if (Array.isArray(data) && data.length) {
          setProjects(data);
          setForm((f) => ({ ...f, project_id: String(data[0].id) }));
        }
      })
      .catch(() => {});
  }, []);

  function set(key, val) { setForm((f) => ({ ...f, [key]: val })); }

  function startStepTimer() {
    let s = 0;
    setStep(0);
    stepTimer.current = setInterval(() => {
      s = Math.min(s + 1, STEPS.length - 1);
      setStep(s);
    }, 22000);
  }
  function stopStepTimer() { if (stepTimer.current) clearInterval(stepTimer.current); }

  async function onGenerate(e) {
    e.preventDefault();
    if (!form.primary_keyword.trim() && !form.topic.trim()) {
      setError('Primary keyword ya topic zaroori hai.');
      return;
    }
    setError('');
    setDraft(null);
    setGenImage(null);
    setImgError('');
    setLoading(true);
    startStepTimer();

    try {
      const primaryKw = form.primary_keyword.trim() || form.topic.trim();
      const secondaryKws = [
        ...form.secondary_keywords,
        ...form.nlp_terms,
      ].filter((k) => k.toLowerCase() !== primaryKw.toLowerCase());

      let topicText = form.topic.trim() || primaryKw;
      if (form.note.trim()) topicText += `\n\nExtra instructions: ${form.note.trim()}`;

      const payload = {
        project_id: Number(form.project_id) || 1,
        platform: 'none',
        primary_keyword: primaryKw,
        secondary_keywords: secondaryKws,
        topic: topicText,
        tone: 'auto',
        country: form.country,
        language: 'en',
        desired_word_count: Number(form.word_count),
        image_mode: 'featured_only',
        inline_images_count: 0,
        autopublish: false,
        publish_status: 'draft',
        force_new: true,
      };

      const data = await apiFetch('/api/blog-agent/generate?async_job=false', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setStep(STEPS.length - 1);
      setTimeout(() => setDraft(data), 500);

      /* ── Image generation (optional) ── */
      if (form.gen_image) {
        const imgPrompt = form.image_prompt.trim() ||
          `Featured blog image for: ${form.topic.trim() || form.primary_keyword.trim()}. Professional, clean, SEO blog style.`;
        setImgLoading(true);
        try {
          const imgData = await fetch('/api/image-gen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: imgPrompt, size: form.image_size }),
          }).then((r) => r.json());
          if (imgData.error) setImgError(imgData.error);
          else setGenImage(imgData);
        } catch (imgErr) {
          setImgError(String(imgErr.message || imgErr));
        } finally {
          setImgLoading(false);
        }
      }
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      stopStepTimer();
      setLoading(false);
    }
  }

  function downloadHtml() {
    if (!draft?.html) return;
    const blob = new Blob([draft.html], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.slug || 'blog'}.html`;
    a.click();
  }

  const wordCount = draft?.html
    ? draft.html.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <AuthGate>
      <main className="bg-main">
        <Header
          title="✍️ Blog Generator"
          subtitle="Competitor research → content gap analysis → SEO-optimised blog. No login required for generation."
        />

        <div className="bg-shell">
          {/* ══ LEFT: Form ══ */}
          <form className="bg-form card" onSubmit={onGenerate}>

            <div className="bg-section-label">🎯 Topic & Keywords</div>

            <label className="bg-label">Blog Topic</label>
            <input
              placeholder="e.g. Best accounting software for small businesses in India"
              value={form.topic}
              onChange={(e) => set('topic', e.target.value)}
            />

            <label className="bg-label">
              Primary Keyword <span className="bg-required">*</span>
            </label>
            <input
              placeholder="e.g. accounting software India"
              value={form.primary_keyword}
              onChange={(e) => set('primary_keyword', e.target.value)}
              required
            />

            <label className="bg-label">
              Secondary Keywords
              <span className="bg-hint"> — comma ya Enter se add karo</span>
            </label>
            <TagInput
              value={form.secondary_keywords}
              onChange={(v) => set('secondary_keywords', v)}
              placeholder="e.g. GST billing, invoicing app…"
            />

            <label className="bg-label">
              NLP / LSI Terms
              <span className="bg-hint"> — semantic words jo blog mein include honge</span>
            </label>
            <TagInput
              value={form.nlp_terms}
              onChange={(v) => set('nlp_terms', v)}
              placeholder="e.g. accounts payable, balance sheet, tally alternative…"
            />

            <label className="bg-label">
              Note / Extra Instructions
              <span className="bg-hint"> — AI ko additional context</span>
            </label>
            <textarea
              placeholder="e.g. Focus on CAs. Mention AccountX. Include comparison table."
              value={form.note}
              onChange={(e) => set('note', e.target.value)}
              rows={3}
              style={{ resize: 'vertical' }}
            />

            <div className="bg-section-label" style={{ marginTop: 20 }}>⚙️ Settings</div>

            <label>
              Project
              <select value={form.project_id} onChange={(e) => set('project_id', e.target.value)}>
                {projects.length === 0 && <option value="1">Default (Project 1)</option>}
                {projects.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name || `Project ${p.id}`}
                  </option>
                ))}
              </select>
            </label>

            <div className="form-row">
              <label>
                Target Country
                <select value={form.country} onChange={(e) => set('country', e.target.value)}>
                  <option value="in">🇮🇳 India</option>
                  <option value="us">🇺🇸 USA</option>
                  <option value="gb">🇬🇧 UK</option>
                  <option value="au">🇦🇺 Australia</option>
                  <option value="ca">🇨🇦 Canada</option>
                </select>
              </label>
              <label>
                Word Count: <strong style={{ color: '#2f6fff' }}>{form.word_count.toLocaleString()}</strong>
                <input
                  type="range"
                  min={600}
                  max={4000}
                  step={100}
                  value={form.word_count}
                  onChange={(e) => set('word_count', Number(e.target.value))}
                  style={{ accentColor: '#2f6fff', marginTop: 6 }}
                />
              </label>
            </div>

            {/* ── Image Generator toggle ── */}
            <div className="bg-section-label" style={{ marginTop: 20 }}>🖼️ Image Generator</div>

            <label className="bg-img-toggle-row">
              <span className="bg-img-toggle-switch">
                <input
                  type="checkbox"
                  checked={form.gen_image}
                  onChange={(e) => set('gen_image', e.target.checked)}
                />
                <span className="bg-img-slider" />
              </span>
              <span style={{ fontSize: 14, fontWeight: 600, color: '#274774' }}>
                Generate featured image with AI
              </span>
              <span style={{ fontSize: 12, color: '#607eaf', marginLeft: 6 }}>
                (DALL-E 3 via OpenAI)
              </span>
            </label>

            {form.gen_image && (
              <div style={{ display: 'grid', gap: 10, marginTop: 6, padding: '14px 16px', background: 'rgba(219,234,254,.25)', borderRadius: 12, border: '1px solid rgba(124,169,243,.3)' }}>
                <label className="bg-label" style={{ margin: 0 }}>
                  Image Prompt
                  <span className="bg-hint"> — leave blank to auto-generate from topic</span>
                </label>
                <textarea
                  placeholder={`e.g. A professional illustration of ${form.topic || form.primary_keyword || 'accounting software'}, clean flat design, blue tones`}
                  value={form.image_prompt}
                  onChange={(e) => set('image_prompt', e.target.value)}
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
                <label className="bg-label" style={{ margin: 0 }}>Image Size</label>
                <select value={form.image_size} onChange={(e) => set('image_size', e.target.value)}>
                  <option value="1024x1024">Square — 1024×1024</option>
                  <option value="1792x1024">Landscape — 1792×1024 (wide)</option>
                  <option value="1024x1792">Portrait — 1024×1792 (tall)</option>
                </select>
              </div>
            )}

            {error && <div className="msg error">{error}</div>}

            <button type="submit" disabled={loading} style={{ marginTop: 8, width: '100%', padding: '13px 20px', fontSize: 15 }}>
              {loading ? '⏳ Generating…' : '⚡ Generate Blog'}
            </button>

            <p style={{ textAlign: 'center', color: '#607eaf', fontSize: 12, margin: '8px 0 0' }}>
              AI researches top competitors, analyses gaps, writes an SEO-winning post. Takes ~60–120s.
            </p>
          </form>

          {/* ══ RIGHT: Results ══ */}
          <div className="bg-result">
            {!loading && !draft && (
              <div className="card empty-state" style={{ padding: 48, textAlign: 'center' }}>
                <div style={{ fontSize: '3rem', marginBottom: 12 }}>📄</div>
                <h4>Generated blog will appear here</h4>
                <p>Fill the form → click Generate Blog → AI will research top-ranking pages for your keyword and write a better post.</p>
              </div>
            )}

            {loading && <ProgressPanel step={step} />}

            {draft && !loading && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {/* Header */}
                <div className="bg-draft-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <span className="pill">Draft</span>
                    <span className="pill muted">~{wordCount.toLocaleString()} words</span>
                    {draft.cost_estimate_usd > 0 && (
                      <span className="pill muted" style={{ color: '#166534' }}>
                        ${draft.cost_estimate_usd.toFixed(4)}
                      </span>
                    )}
                  </div>
                  <h2 style={{ margin: '0 0 6px', fontSize: '1.25rem', color: '#132d58' }}>{draft.title}</h2>
                  <code style={{ fontSize: 12, color: '#607eaf', background: 'none' }}>/{draft.slug}</code>
                </div>

                {/* Tabs */}
                <div className="bg-tabs">
                  {[
                    { id: 'preview', label: '👁 Preview' },
                    { id: 'meta',    label: '🏷 SEO Meta' },
                    { id: 'html',    label: '💻 HTML' },
                    ...(form.gen_image ? [{ id: 'image', label: '🖼️ Image' }] : []),
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTab(t.id)}
                      className={`secondary bg-tab ${tab === t.id ? 'bg-tab-active' : ''}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {tab === 'preview' && <HtmlPreview html={draft.html || ''} />}

                {tab === 'meta' && (
                  <div style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
                    {[
                      { key: 'Title',     val: draft.title },
                      { key: 'Slug',      val: draft.slug },
                      { key: 'Meta Title',val: draft.meta_title },
                      { key: 'Meta Desc', val: draft.meta_description },
                    ].map(({ key, val }) => (
                      <div key={key} className="bg-meta-row">
                        <span className="bg-meta-key">{key}</span>
                        <span style={{ flex: 1, fontSize: 14, color: '#10244d', lineHeight: 1.5 }}>{val}</span>
                        <CopyBtn text={val || ''} label={key} />
                      </div>
                    ))}
                    {draft.faq_json?.length > 0 && (
                      <div>
                        <p style={{ margin: '8px 0 6px', fontWeight: 700, color: '#193766', fontSize: 13 }}>
                          FAQs ({draft.faq_json.length})
                        </p>
                        <div style={{ display: 'grid', gap: 8 }}>
                          {draft.faq_json.map((faq, i) => (
                            <div key={i} className="codebox" style={{ fontSize: 13 }}>
                              <strong>Q:</strong> {faq.question || faq.q}
                              <br />
                              <strong>A:</strong> {faq.answer || faq.a}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {tab === 'html' && (
                  <div>
                    <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderBottom: '1px solid rgba(124,169,243,.24)', background: 'rgba(245,250,255,.8)' }}>
                      <CopyBtn text={draft.html || ''} label="Copy HTML" />
                      <button type="button" className="secondary" style={{ padding: '6px 12px', fontSize: 13 }} onClick={downloadHtml}>
                        ⬇️ Download HTML
                      </button>
                    </div>
                    <pre className="codebox" style={{ margin: 0, borderRadius: '0 0 16px 16px', maxHeight: 540, overflow: 'auto', background: '#0f172a', color: '#e2e8f0', border: 'none', padding: '16px 20px', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {draft.html}
                    </pre>
                  </div>
                )}

                {tab === 'image' && (
                  <div style={{ padding: '20px 24px' }}>
                    {imgLoading && (
                      <div className="bg-progress" style={{ padding: '32px 0' }}>
                        <div className="bg-spinner" />
                        <p style={{ color: '#4064a6', fontWeight: 600, margin: 0 }}>Generating image via DALL-E 3…</p>
                      </div>
                    )}
                    {imgError && !imgLoading && (
                      <div className="msg error">{imgError}</div>
                    )}
                    {genImage && !imgLoading && (
                      <div style={{ display: 'grid', gap: 16 }}>
                        <img
                          src={`data:image/png;base64,${genImage.b64}`}
                          alt="AI Generated"
                          className="bg-gen-img"
                        />
                        {genImage.revised_prompt && (
                          <div style={{ fontSize: 12, color: '#607eaf', background: 'rgba(219,234,254,.4)', borderRadius: 8, padding: '10px 14px' }}>
                            <strong style={{ color: '#274774' }}>Revised prompt:</strong> {genImage.revised_prompt}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button
                            type="button"
                            className="secondary"
                            style={{ padding: '6px 14px', fontSize: 13 }}
                            onClick={() => {
                              const a = document.createElement('a');
                              a.href = `data:image/png;base64,${genImage.b64}`;
                              a.download = `${draft.slug || 'blog'}-image.png`;
                              a.click();
                            }}
                          >
                            ⬇️ Download PNG
                          </button>
                        </div>
                      </div>
                    )}
                    {!imgLoading && !imgError && !genImage && (
                      <p style={{ color: '#607eaf', textAlign: 'center' }}>Image will appear here after generation.</p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>

    </AuthGate>
  );
}
