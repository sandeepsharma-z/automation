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
  { icon: '🔍', label: 'Searching top-ranking competitor pages for your keyword…' },
  { icon: '📖', label: 'Crawling & extracting competitor content, headings, entities…' },
  { icon: '🧠', label: 'Analysing content gaps, NLP signals & building SEO brief…' },
  { icon: '✍️', label: 'Writing your SEO-optimised blog post with AI…' },
  { icon: '✅', label: 'Running quality checks, internal linking & finalising…' },
];

function ProgressPanel({ step, elapsed, onCancel }) {
  const min = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  const timeStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
  return (
    <div className="bg-progress card">
      <div className="bg-spinner" />
      <p style={{ textAlign: 'center', color: '#4064a6', margin: '0 0 4px', fontWeight: 600 }}>
        Generating your blog — this takes 2–8 minutes
      </p>
      <p style={{ textAlign: 'center', color: '#607eaf', margin: '0 0 20px', fontSize: 13 }}>
        ⏱ Elapsed: <strong style={{ color: '#274774' }}>{timeStr}</strong> — AI is working, do not close this page
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
      {step >= 2 && (
        <p style={{ margin: '16px 0 0', textAlign: 'center', fontSize: 12, color: '#607eaf' }}>
          Research phase takes longest (3–6 min) — AI is reading competitor pages &amp; building content brief
        </p>
      )}
      <div style={{ marginTop: 20, textAlign: 'center' }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: '9px 24px', fontSize: 13, fontWeight: 600, background: 'rgba(254,226,226,.8)', color: '#dc2626', border: '1px solid rgba(252,165,165,.6)', borderRadius: 10, cursor: 'pointer' }}
        >
          ⛔ Stop Generation
        </button>
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
const LINK_PLACEMENT_OPTIONS = [
  'Intro / Opening section',
  'Features section',
  'Benefits section',
  'How it Works section',
  'Comparison / Table section',
  'Tips / Best Practices section',
  'FAQ section',
  'Conclusion / CTA section',
];

const DEFAULT_FORM = {
  website_url: '',
  topic: '',
  primary_keyword: '',
  secondary_keywords: [],
  nlp_terms: [],
  internal_link_anchors: [],
  link_placements: [],
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
  const [loading, setLoading]   = useState(false);
  const [step, setStep]         = useState(0);
  const [draft, setDraft]       = useState(null);
  const [error, setError]       = useState('');
  const [tab, setTab]           = useState('preview');
  const [genImage, setGenImage] = useState(null);   // { b64, revised_prompt, size }
  const [imgLoading, setImgLoading] = useState(false);
  const [imgError, setImgError] = useState('');
  const [editedHtml, setEditedHtml] = useState('');  // HTML with manually applied links
  const [elapsed, setElapsed]   = useState(0);
  const stepTimer               = useRef(null);
  const elapsedTimer            = useRef(null);
  const cancelRef               = useRef(null);  // AbortController for active generation
  // Outline-first workflow
  const [outlineData, setOutlineData]       = useState(null);   // { outline, faqs, seo, pipeline_run_id }
  const [editedOutline, setEditedOutline]   = useState([]);     // user-editable heading list
  const [outlineLoading, setOutlineLoading] = useState(false);
  const [outlineError, setOutlineError]     = useState('');

  function set(key, val) { setForm((f) => ({ ...f, [key]: val })); }

  function startStepTimer() {
    let s = 0;
    let e = 0;
    setStep(0);
    setElapsed(0);
    stepTimer.current = setInterval(() => {
      s += 1;
      if (s >= STEPS.length) s = 2;
      setStep(s);
    }, 30000);
    elapsedTimer.current = setInterval(() => {
      e += 1;
      setElapsed(e);
    }, 1000);
  }
  function stopStepTimer() {
    if (stepTimer.current) clearInterval(stepTimer.current);
    if (elapsedTimer.current) clearInterval(elapsedTimer.current);
  }

  function cancelGeneration() {
    if (cancelRef.current) {
      cancelRef.current.abort();
      cancelRef.current = null;
    }
    stopStepTimer();
    setLoading(false);
    setError('Generation cancelled.');
  }

  async function onGenerateOutline(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (!form.primary_keyword.trim() && !form.topic.trim()) {
      setOutlineError('Primary keyword ya topic zaroori hai.');
      return;
    }
    setOutlineError('');
    setOutlineData(null);
    setEditedOutline([]);
    setOutlineLoading(true);
    try {
      const primaryKw = form.primary_keyword.trim() || form.topic.trim();
      const secondaryKws = [...form.secondary_keywords, ...form.nlp_terms]
        .filter((k) => k.toLowerCase() !== primaryKw.toLowerCase());
      let topicText = form.topic.trim() || primaryKw;
      if (form.note.trim()) topicText += `\n\nExtra instructions: ${form.note.trim()}`;
      const siteUrl = form.website_url.trim().replace(/\/+$/, '');
      const payload = {
        project_id: 1,
        platform: 'none',
        website_url: siteUrl || undefined,
        internal_link_anchors: form.internal_link_anchors.length ? form.internal_link_anchors : undefined,
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
      const data = await apiFetch('/api/blog-agent/outline?async_job=false', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 600000,
      });
      setOutlineData(data);
      setEditedOutline(Array.isArray(data.outline) ? [...data.outline] : []);
    } catch (err) {
      setOutlineError(String(err.message || err));
    } finally {
      setOutlineLoading(false);
    }
  }

  async function onGenerate(e, outlineOverride) {
    if (e && e.preventDefault) e.preventDefault();
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
      if (form.link_placements.length && form.internal_link_anchors.length) {
        topicText += `\n\nInternal link placement instructions: Place internal links naturally within these specific sections of the article — ${form.link_placements.join(', ')}. Do NOT cluster all links in one place; distribute them contextually.`;
      }

      const siteUrl = form.website_url.trim().replace(/\/+$/, '');
      const payload = {
        project_id: 1,
        platform: 'none',
        website_url: siteUrl || undefined,
        internal_link_anchors: form.internal_link_anchors.length ? form.internal_link_anchors : undefined,
        primary_keyword: primaryKw,
        secondary_keywords: secondaryKws,
        topic: topicText,
        tone: 'auto',
        country: form.country,
        language: 'en',
        desired_word_count: Number(form.word_count),
        image_mode: 'featured_only',
        inline_images_count: 0,
        outline_override: outlineOverride && outlineOverride.length ? outlineOverride : undefined,
        autopublish: false,
        publish_status: 'draft',
        force_new: true,
      };

      cancelRef.current = new AbortController();
      const data = await apiFetch('/api/blog-agent/generate?async_job=false', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 900000,
        signal: cancelRef.current.signal,
      });
      cancelRef.current = null;

      setStep(STEPS.length - 1);
      setTimeout(() => {
        setDraft(data);
        setEditedHtml('');  // reset on new generation
        setOutlineData(null); // clear outline panel once blog is generated
      }, 500);

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

  /* Normalise response — API returns { draft_id, state: { title, content_html, crawl_sources, evidence_panel, ... } } */
  const s = draft?.state || {};
  const blogHtml      = s.content_html  || '';
  const blogTitle     = s.title         || '';
  const blogSlug      = s.slug          || '';
  const sources       = Array.isArray(s.crawl_sources)  ? s.crawl_sources  : [];
  const evidencePanel = Array.isArray(s.evidence_panel) ? s.evidence_panel : [];
  const research      = s.research_summary              || {};
  const faqList       = Array.isArray(s.faq_json)       ? s.faq_json       : [];
  const qaScores      = s.qa_scores                     || {};
  const pipelineEvents = Array.isArray(s.pipeline_events) ? s.pipeline_events : [];

  // editedHtml takes priority once user has applied any links manually
  const activeHtml = editedHtml || blogHtml;

  // Parse internal_link_anchors into { anchor, url, applied } objects
  const siteBase = form.website_url.trim().replace(/\/+$/, '');
  const parsedAnchors = form.internal_link_anchors.map((raw) => {
    if (raw.includes('|')) {
      const [a, u] = raw.split('|', 2);
      return { anchor: a.trim(), url: u.trim() };
    }
    const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { anchor: raw.trim(), url: siteBase ? `${siteBase}/${slug}/` : `/${slug}/` };
  });

  function applyLink(anchor, url) {
    const base = editedHtml || blogHtml;
    // Replace first unlinked occurrence of anchor text (case-insensitive, whole word boundary)
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `(?<!<a[^>]*>)(?<!href="[^"]*)(${escaped})(?![^<]*<\\/a>)`,
      'i'
    );
    // Simple approach: find first occurrence not already inside an <a> tag
    const newHtml = base.replace(regex, `<a href="${url}" title="${anchor}">${anchor}</a>`);
    if (newHtml !== base) {
      setEditedHtml(newHtml);
      return true;
    }
    return false;
  }

  function removeLink(url) {
    const base = editedHtml || blogHtml;
    const escaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`<a[^>]*href="${escaped}"[^>]*>([^<]*)<\\/a>`, 'gi');
    setEditedHtml(base.replace(regex, '$1'));
  }

  function isApplied(url) {
    return activeHtml.includes(`href="${url}"`);
  }

  function downloadHtml() {
    if (!activeHtml) return;
    const blob = new Blob([activeHtml], { type: 'text/html' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${blogSlug || 'blog'}.html`;
    a.click();
  }

  const wordCount = activeHtml
    ? activeHtml.replace(/<[^>]+>/g, ' ').trim().split(/\s+/).filter(Boolean).length
    : (s.word_count || 0);

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
              Internal Link Anchors
              <span className="bg-hint"> — type karo phir Enter dabao</span>
            </label>
            <TagInput
              value={form.internal_link_anchors}
              onChange={(v) => set('internal_link_anchors', v)}
              placeholder="Anchor text likhko → Enter dabao (e.g. payroll software)"
            />
            <p style={{ fontSize: 12, color: '#607eaf', margin: '4px 0 0' }}>
              Format: <code style={{ background: 'rgba(219,234,254,.5)', padding: '1px 5px', borderRadius: 4, fontSize: 11 }}>Anchor Text|https://url.com</code> &nbsp;ya sirf anchor text (URL auto-bnega) · Enter ya comma se add karo
            </p>
            {form.internal_link_anchors.length > 0 && (
              <p style={{ fontSize: 12, color: '#166534', margin: '4px 0 0', fontWeight: 600 }}>
                ✅ {form.internal_link_anchors.length} anchor{form.internal_link_anchors.length > 1 ? 's' : ''} added — Apply Links tab mein click karke blog mein insert karo
              </p>
            )}

            <label className="bg-label">
              Link Placement Suggestion
              <span className="bg-hint"> — kis section mein links place hone chahiye</span>
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px', background: 'rgba(219,234,254,.2)', borderRadius: 12, border: '1px solid rgba(124,169,243,.28)' }}>
              {LINK_PLACEMENT_OPTIONS.map((opt) => {
                const checked = form.link_placements.includes(opt);
                return (
                  <label
                    key={opt}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '5px 12px', borderRadius: 20, fontSize: 13, fontWeight: 500, background: checked ? '#dbeafe' : 'rgba(255,255,255,.85)', color: checked ? '#1e40af' : '#4b6290', border: checked ? '1px solid rgba(96,165,250,.6)' : '1px solid rgba(124,169,243,.3)', transition: 'all .15s', userSelect: 'none' }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      style={{ display: 'none' }}
                      onChange={() => {
                        const cur = form.link_placements;
                        set('link_placements', checked ? cur.filter((x) => x !== opt) : [...cur, opt]);
                      }}
                    />
                    {checked ? '✅' : '○'} {opt}
                  </label>
                );
              })}
            </div>
            {form.link_placements.length > 0 && (
              <p style={{ fontSize: 12, color: '#607eaf', margin: '4px 0 0' }}>
                ✓ Links will be placed in: <strong style={{ color: '#274774' }}>{form.link_placements.join(' · ')}</strong>
              </p>
            )}

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

            <label className="bg-label">
              Website URL
              <span className="bg-hint"> — aapki website ka link (optional)</span>
            </label>
            <input
              type="url"
              placeholder="e.g. https://houseofdasdi.com"
              value={form.website_url}
              onChange={(e) => set('website_url', e.target.value)}
            />

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
            {outlineError && <div className="msg error">{outlineError}</div>}

            <button
              type="button"
              disabled={loading || outlineLoading}
              onClick={onGenerateOutline}
              style={{ width: '100%', padding: '13px 20px', fontSize: 15, marginTop: 8, background: outlineLoading ? 'rgba(219,234,254,.5)' : undefined, opacity: loading || outlineLoading ? 0.7 : 1 }}
            >
              {outlineLoading ? '⏳ Generating outline…' : '📋 Generate Outline'}
            </button>

            <p style={{ textAlign: 'center', color: '#607eaf', fontSize: 12, margin: '8px 0 0' }}>
              AI researches top competitors, builds outline — review &amp; approve before full generation.
            </p>
          </form>

          {/* ══ RIGHT: Results ══ */}
          <div className="bg-result">
            {!loading && !draft && !outlineData && !outlineLoading && (
              <div className="card empty-state" style={{ padding: 48, textAlign: 'center' }}>
                <div style={{ fontSize: '3rem', marginBottom: 12 }}>📄</div>
                <h4>Generated blog will appear here</h4>
                <p>Fill the form → click <strong>Generate Outline First</strong> to review headings, or <strong>Generate Blog Directly</strong> to skip straight to the full post.</p>
              </div>
            )}

            {/* ── Outline loading ── */}
            {outlineLoading && (
              <div className="card bg-progress" style={{ padding: '40px 32px', textAlign: 'center' }}>
                <div className="bg-spinner" />
                <p style={{ color: '#4064a6', fontWeight: 600, margin: '0 0 6px' }}>Researching competitors &amp; generating outline…</p>
                <p style={{ color: '#607eaf', fontSize: 13, margin: 0 }}>Takes 1–3 minutes. AI reads top-ranking pages to build a content plan.</p>
              </div>
            )}

            {/* ── Outline editor ── */}
            {outlineData && !loading && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div className="bg-draft-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
                    <span className="pill" style={{ background: 'rgba(219,234,254,.8)', color: '#1e40af' }}>📋 Outline Ready</span>
                    <span className="pill muted">{editedOutline.length} headings</span>
                  </div>
                  <h2 style={{ margin: '0 0 4px', fontSize: '1.1rem', color: '#132d58' }}>
                    {outlineData.seo?.meta_title || 'Blog Outline'}
                  </h2>
                  <p style={{ margin: 0, fontSize: 12, color: '#607eaf' }}>
                    Review and edit the headings below. Click <strong>Approve &amp; Generate</strong> when ready.
                  </p>
                </div>

                <div style={{ padding: '16px 20px', display: 'grid', gap: 8 }}>
                  {editedOutline.map((heading, i) => (
                    <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#9ca3af', minWidth: 24, textAlign: 'right', flexShrink: 0 }}>
                        {i < Math.min(5, editedOutline.length) && editedOutline.length > 1 ? 'H2' : 'H3'}
                      </span>
                      <input
                        value={heading}
                        onChange={(e) => {
                          const updated = [...editedOutline];
                          updated[i] = e.target.value;
                          setEditedOutline(updated);
                        }}
                        style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(124,169,243,.4)', fontSize: 14, color: '#10244d', background: 'rgba(245,250,255,.9)' }}
                      />
                      <button
                        type="button"
                        onClick={() => setEditedOutline(editedOutline.filter((_, j) => j !== i))}
                        style={{ flexShrink: 0, padding: '6px 10px', fontSize: 13, background: 'none', border: '1px solid rgba(252,165,165,.6)', borderRadius: 8, color: '#dc2626', cursor: 'pointer' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}

                  {/* Add heading */}
                  <button
                    type="button"
                    onClick={() => setEditedOutline([...editedOutline, ''])}
                    style={{ width: '100%', padding: '8px', border: '1px dashed rgba(124,169,243,.5)', borderRadius: 8, background: 'none', color: '#5b7fb9', fontSize: 13, cursor: 'pointer', marginTop: 4 }}
                  >
                    + Add Heading
                  </button>
                </div>

                {/* FAQs preview */}
                {Array.isArray(outlineData.faqs) && outlineData.faqs.length > 0 && (
                  <details style={{ margin: '0 20px 16px', border: '1px solid rgba(124,169,243,.3)', borderRadius: 10 }}>
                    <summary style={{ padding: '8px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600, color: '#5b7fb9' }}>
                      💬 FAQs from outline ({outlineData.faqs.length})
                    </summary>
                    <div style={{ padding: '8px 14px' }}>
                      {outlineData.faqs.map((faq, i) => (
                        <div key={i} style={{ fontSize: 12, color: '#4b6290', padding: '5px 0', borderBottom: '1px solid rgba(124,169,243,.15)' }}>
                          <strong>Q:</strong> {typeof faq === 'string' ? faq : (faq.question || faq.q || JSON.stringify(faq))}
                        </div>
                      ))}
                    </div>
                  </details>
                )}

                {/* Action buttons */}
                <div style={{ padding: '16px 20px', display: 'flex', gap: 10, borderTop: '1px solid rgba(124,169,243,.2)', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => {
                      const filtered = editedOutline.filter((h) => h.trim());
                      if (!filtered.length) { alert('Please add at least one heading.'); return; }
                      onGenerate(null, filtered);
                    }}
                    style={{ flex: 1, padding: '12px 20px', fontSize: 15, fontWeight: 700, minWidth: 160 }}
                  >
                    {loading ? '⏳ Generating…' : '✅ Approve & Generate Blog'}
                  </button>
                  <button
                    type="button"
                    disabled={outlineLoading || loading}
                    onClick={onGenerateOutline}
                    className="secondary"
                    style={{ padding: '12px 18px', fontSize: 14 }}
                  >
                    🔄 Regenerate Outline
                  </button>
                </div>
              </div>
            )}

            {loading && <ProgressPanel step={step} elapsed={elapsed} onCancel={cancelGeneration} />}

            {draft && !loading && (
              <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
                {/* Header */}
                <div className="bg-draft-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                    <span className="pill">Draft #{draft.draft_id}</span>
                    <span className="pill muted">~{Number(wordCount).toLocaleString()} words</span>
                    {sources.length > 0 && (
                      <span className="pill muted" style={{ color: '#166534' }}>
                        {sources.length} competitor sources
                      </span>
                    )}
                    {draft.status && (
                      <span className="pill muted">{draft.status}</span>
                    )}
                  </div>
                  <h2 style={{ margin: '0 0 6px', fontSize: '1.25rem', color: '#132d58' }}>{blogTitle}</h2>
                  {blogSlug && <code style={{ fontSize: 12, color: '#607eaf', background: 'none' }}>/{blogSlug}</code>}
                </div>

                {/* Tabs */}
                <div className="bg-tabs">
                  {[
                    { id: 'preview',  label: '👁 Preview' },
                    { id: 'links',    label: `🔗 Apply Links${parsedAnchors.length ? ` (${parsedAnchors.length})` : ''}` },
                    { id: 'meta',     label: '🏷 SEO Meta' },
                    { id: 'html',     label: '💻 HTML' },
                    { id: 'research', label: `🔬 Research (${evidencePanel.length || sources.length})` },
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

                {tab === 'preview' && <HtmlPreview html={activeHtml} />}

                {tab === 'links' && (
                  <div style={{ padding: '16px 20px' }}>
                    {parsedAnchors.length === 0 ? (
                      <div style={{ textAlign: 'center', padding: '32px 0', color: '#607eaf' }}>
                        <div style={{ fontSize: '2rem', marginBottom: 10 }}>🔗</div>
                        <p style={{ margin: 0 }}>No internal link anchors added yet.</p>
                        <p style={{ fontSize: 13, margin: '6px 0 0' }}>Add anchors in the form on the left (Internal Link Anchors field).</p>
                      </div>
                    ) : (
                      <>
                        <p style={{ margin: '0 0 14px', fontSize: 13, color: '#4b6290' }}>
                          Click <strong>Apply</strong> to insert each anchor as a hyperlink in the blog. The first unlinked occurrence of the text will be wrapped.
                        </p>
                        <div style={{ display: 'grid', gap: 10 }}>
                          {parsedAnchors.map(({ anchor, url }, i) => {
                            const applied = isApplied(url);
                            return (
                              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: applied ? 'rgba(220,252,231,.6)' : 'rgba(219,234,254,.25)', borderRadius: 12, border: `1px solid ${applied ? 'rgba(74,222,128,.4)' : 'rgba(124,169,243,.3)'}`, flexWrap: 'wrap' }}>
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 700, fontSize: 14, color: '#132d58', marginBottom: 2 }}>
                                    {anchor}
                                  </div>
                                  <code style={{ fontSize: 12, color: '#607eaf', background: 'none', wordBreak: 'break-all' }}>{url}</code>
                                </div>
                                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                                  {applied ? (
                                    <>
                                      <span style={{ fontSize: 12, color: '#166534', fontWeight: 600, padding: '5px 10px', background: 'rgba(187,247,208,.6)', borderRadius: 8, border: '1px solid rgba(74,222,128,.4)' }}>
                                        ✅ Applied
                                      </span>
                                      <button
                                        type="button"
                                        className="secondary"
                                        style={{ padding: '5px 12px', fontSize: 12, color: '#dc2626', borderColor: 'rgba(252,165,165,.6)' }}
                                        onClick={() => removeLink(url)}
                                      >
                                        ✕ Remove
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      type="button"
                                      className="secondary"
                                      style={{ padding: '5px 14px', fontSize: 13, fontWeight: 600 }}
                                      onClick={() => {
                                        const ok = applyLink(anchor, url);
                                        if (!ok) alert(`"${anchor}" not found in blog text (may already be linked or text not present).`);
                                      }}
                                    >
                                      🔗 Apply
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {editedHtml && (
                          <div style={{ marginTop: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <CopyBtn text={activeHtml} label="Copy Updated HTML" />
                            <button type="button" className="secondary" style={{ padding: '6px 12px', fontSize: 13 }} onClick={downloadHtml}>
                              ⬇️ Download Updated HTML
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              style={{ padding: '6px 12px', fontSize: 13, color: '#dc2626' }}
                              onClick={() => setEditedHtml('')}
                            >
                              ↩ Reset All Links
                            </button>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {tab === 'meta' && (
                  <div style={{ padding: '16px 20px', display: 'grid', gap: 12 }}>
                    {[
                      { key: 'Title',      val: blogTitle },
                      { key: 'Slug',       val: blogSlug },
                      { key: 'Meta Title', val: s.meta_title },
                      { key: 'Meta Desc',  val: s.meta_description },
                    ].map(({ key, val }) => (
                      <div key={key} className="bg-meta-row">
                        <span className="bg-meta-key">{key}</span>
                        <span style={{ flex: 1, fontSize: 14, color: '#10244d', lineHeight: 1.5 }}>{val || <em style={{ color: '#94a3b8' }}>—</em>}</span>
                        <CopyBtn text={val || ''} label={key} />
                      </div>
                    ))}
                    {faqList.length > 0 && (
                      <div>
                        <p style={{ margin: '8px 0 6px', fontWeight: 700, color: '#193766', fontSize: 13 }}>
                          FAQs ({faqList.length})
                        </p>
                        <div style={{ display: 'grid', gap: 8 }}>
                          {faqList.map((faq, i) => (
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
                      <CopyBtn text={activeHtml} label="Copy HTML" />
                      <button type="button" className="secondary" style={{ padding: '6px 12px', fontSize: 13 }} onClick={downloadHtml}>
                        ⬇️ Download HTML
                      </button>
                    </div>
                    <pre className="codebox" style={{ margin: 0, borderRadius: '0 0 16px 16px', maxHeight: 540, overflow: 'auto', background: '#0f172a', color: '#e2e8f0', border: 'none', padding: '16px 20px', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                      {activeHtml}
                    </pre>
                  </div>
                )}

                {tab === 'research' && (
                  <div style={{ padding: '16px 20px', display: 'grid', gap: 20 }}>

                    {/* ── Stats row ── */}
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                      {[
                        { label: 'Competitor Pages', val: sources.length || research.source_count || 0, icon: '📄' },
                        { label: 'Domains Crawled',  val: (research.source_domains || []).length || 0, icon: '🌐' },
                        { label: 'Top URLs',         val: (research.top_competitor_urls || []).length, icon: '🔗' },
                        { label: 'Evidence Items',   val: evidencePanel.length, icon: '🧠' },
                        ...(qaScores.overall_score > 0 ? [{ label: 'QA Score', val: `${Math.round(qaScores.overall_score)}/100`, icon: '✅' }] : []),
                      ].map(({ label, val, icon }) => (
                        <div key={label} style={{ flex: 1, minWidth: 110, background: 'rgba(219,234,254,.4)', borderRadius: 10, padding: '10px 14px', textAlign: 'center' }}>
                          <div style={{ fontSize: '1.2rem' }}>{icon}</div>
                          <div style={{ fontSize: 20, fontWeight: 700, color: '#1e40af', marginTop: 2 }}>{val}</div>
                          <div style={{ fontSize: 11, color: '#5b7fb9', marginTop: 1 }}>{label}</div>
                        </div>
                      ))}
                    </div>

                    {/* ── QA scores ── */}
                    {qaScores.overall_score > 0 && (
                      <div style={{ background: 'rgba(220,252,231,.5)', borderRadius: 12, padding: '12px 16px', border: '1px solid rgba(74,222,128,.3)' }}>
                        <p style={{ margin: '0 0 10px', fontWeight: 700, color: '#166534', fontSize: 13 }}>✅ Quality Assessment Scores</p>
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                          {[
                            { k: 'Overall',     v: qaScores.overall_score },
                            { k: 'Originality', v: qaScores.originality_score },
                            { k: 'Coverage',    v: qaScores.coverage_score },
                            { k: 'E-E-A-T',     v: qaScores.eeat_score },
                            { k: 'Practicality',v: qaScores.practicality_score },
                          ].filter(x => x.v > 0).map(({ k, v }) => (
                            <div key={k} style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: 16, fontWeight: 700, color: v >= 70 ? '#166534' : v >= 50 ? '#854d0e' : '#dc2626' }}>{Math.round(v)}</div>
                              <div style={{ fontSize: 11, color: '#4b6290' }}>{k}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Top competitor URLs ── */}
                    {(research.top_competitor_urls || []).length > 0 && (
                      <div>
                        <p style={{ margin: '0 0 8px', fontWeight: 700, color: '#193766', fontSize: 13 }}>🏆 Top Competitor URLs Analysed</p>
                        <div style={{ display: 'grid', gap: 5 }}>
                          {(research.top_competitor_urls || []).map((url, i) => (
                            <a key={i} href={url} target="_blank" rel="noopener noreferrer"
                              style={{ fontSize: 12, color: '#2f6fff', wordBreak: 'break-all', padding: '6px 10px', background: 'rgba(219,234,254,.25)', borderRadius: 7, display: 'block' }}>
                              {i + 1}. {url}
                            </a>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Evidence panel — rich competitor analysis ── */}
                    {evidencePanel.length > 0 && (
                      <div>
                        <p style={{ margin: '0 0 10px', fontWeight: 700, color: '#193766', fontSize: 13 }}>🧠 Competitor Intelligence ({evidencePanel.length} pages)</p>
                        <div style={{ display: 'grid', gap: 10 }}>
                          {evidencePanel.map((ev, i) => (
                            <details key={i} style={{ border: '1px solid rgba(124,169,243,.3)', borderRadius: 12, overflow: 'hidden' }}>
                              <summary style={{ padding: '10px 14px', cursor: 'pointer', background: 'rgba(245,250,255,.9)', fontWeight: 600, fontSize: 13, color: '#132d58', display: 'flex', alignItems: 'center', gap: 8, listStyle: 'none' }}>
                                <span style={{ minWidth: 20, fontSize: 12, color: '#5b7fb9' }}>#{i + 1}</span>
                                <span style={{ flex: 1 }}>{ev.title || ev.url}</span>
                                {ev.competitive_strength_score > 0 && (
                                  <span style={{ fontSize: 11, background: 'rgba(219,234,254,.8)', color: '#1e40af', borderRadius: 6, padding: '2px 7px', fontWeight: 700 }}>
                                    Score: {Math.round(ev.competitive_strength_score)}
                                  </span>
                                )}
                              </summary>
                              <div style={{ padding: '12px 14px', background: '#fff', fontSize: 13 }}>
                                {ev.url && (
                                  <a href={ev.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2f6fff', fontSize: 12, wordBreak: 'break-all', display: 'block', marginBottom: 8 }}>{ev.url}</a>
                                )}
                                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
                                  {ev.content_length_estimate > 0 && <span style={{ color: '#5b7fb9', fontSize: 12 }}>📝 {ev.content_length_estimate} words</span>}
                                  {ev.media_count > 0 && <span style={{ color: '#5b7fb9', fontSize: 12 }}>🖼️ {ev.media_count} media</span>}
                                  {ev.table_count > 0 && <span style={{ color: '#5b7fb9', fontSize: 12 }}>📊 {ev.table_count} tables</span>}
                                  {ev.freshness_score > 0 && <span style={{ color: '#5b7fb9', fontSize: 12 }}>📅 Freshness: {Math.round(ev.freshness_score)}</span>}
                                </div>
                                {/* Headings */}
                                {Array.isArray(ev.headings?.h2) && ev.headings.h2.length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#5b7fb9', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>H2 Headings</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                                      {ev.headings.h2.slice(0, 8).map((h, j) => (
                                        <span key={j} style={{ fontSize: 12, background: 'rgba(219,234,254,.5)', color: '#274774', borderRadius: 6, padding: '3px 8px' }}>{h}</span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {/* Entities */}
                                {Array.isArray(ev.entities) && ev.entities.length > 0 && (
                                  <div style={{ marginBottom: 8 }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#5b7fb9', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>Key Entities / Topics</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                                      {ev.entities.slice(0, 12).map((ent, j) => (
                                        <span key={j} style={{ fontSize: 11, background: 'rgba(254,249,195,.8)', color: '#854d0e', borderRadius: 6, padding: '2px 7px', border: '1px solid rgba(253,224,71,.4)' }}>
                                          {typeof ent === 'string' ? ent : (ent.text || ent.name || JSON.stringify(ent))}
                                        </span>
                                      ))}
                                    </div>
                                  </div>
                                )}
                                {/* FAQs from competitor */}
                                {Array.isArray(ev.faqs) && ev.faqs.length > 0 && (
                                  <div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#5b7fb9', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 4 }}>FAQs found ({ev.faqs.length})</div>
                                    {ev.faqs.slice(0, 3).map((faq, j) => (
                                      <div key={j} style={{ fontSize: 12, color: '#4b6290', marginBottom: 4 }}>
                                        <strong>Q:</strong> {typeof faq === 'string' ? faq : (faq.question || faq.q || '')}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </details>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Crawl sources fallback (basic) ── */}
                    {evidencePanel.length === 0 && sources.length > 0 && (
                      <div>
                        <p style={{ margin: '0 0 8px', fontWeight: 700, color: '#193766', fontSize: 13 }}>📄 Crawled Sources ({sources.length})</p>
                        <div style={{ display: 'grid', gap: 8 }}>
                          {sources.map((src, i) => (
                            <div key={i} style={{ padding: '10px 14px', background: 'rgba(245,250,255,.9)', borderRadius: 10, border: '1px solid rgba(124,169,243,.25)', fontSize: 13 }}>
                              <div style={{ fontWeight: 600, color: '#193766', marginBottom: 4 }}>{src.title || src.domain || src.url}</div>
                              {src.url && <a href={src.url} target="_blank" rel="noopener noreferrer" style={{ color: '#2f6fff', fontSize: 12, wordBreak: 'break-all' }}>{src.url}</a>}
                              <div style={{ display: 'flex', gap: 12, marginTop: 4, flexWrap: 'wrap' }}>
                                {src.competitive_strength_score > 0 && <span style={{ fontSize: 11, color: '#5b7fb9' }}>Score: {Math.round(src.competitive_strength_score)}</span>}
                                {src.fetch_status && <span style={{ fontSize: 11, color: src.fetch_status === 'ok' ? '#166534' : '#dc2626' }}>{src.fetch_status}</span>}
                                {src.snippet && <p style={{ margin: '4px 0 0', color: '#4b6290', lineHeight: 1.5, fontSize: 12 }}>{src.snippet}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* ── Pipeline events log ── */}
                    {pipelineEvents.length > 0 && (
                      <details style={{ border: '1px solid rgba(124,169,243,.25)', borderRadius: 10 }}>
                        <summary style={{ padding: '8px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#5b7fb9' }}>
                          📋 Pipeline Events Log ({pipelineEvents.length})
                        </summary>
                        <div style={{ padding: '8px 14px', maxHeight: 220, overflow: 'auto' }}>
                          {pipelineEvents.map((ev, i) => (
                            <div key={i} style={{ fontSize: 11, color: '#607eaf', padding: '3px 0', borderBottom: '1px solid rgba(124,169,243,.1)' }}>
                              <span style={{ color: '#9ca3af', marginRight: 8 }}>[{String(ev.stage || '').toUpperCase()}]</span>
                              {ev.message || ev.event || JSON.stringify(ev)}
                            </div>
                          ))}
                        </div>
                      </details>
                    )}

                    {sources.length === 0 && evidencePanel.length === 0 && (research.top_competitor_urls || []).length === 0 && (
                      <p style={{ color: '#607eaf', textAlign: 'center', padding: '20px 0' }}>No research data available for this draft.</p>
                    )}
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
                              a.download = `${blogSlug || 'blog'}-image.png`;
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
