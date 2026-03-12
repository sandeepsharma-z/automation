"use client";
import { useState, useEffect, useRef } from "react";

/* ─── Tag-chip input ─────────────────────────────────────────────────── */
function TagInput({ value, onChange, placeholder }) {
  const [input, setInput] = useState("");
  const tags = Array.isArray(value) ? value : [];

  function add(raw) {
    const newTags = raw
      .split(/[,\n]+/)
      .map((s) => s.trim())
      .filter((s) => s && !tags.includes(s));
    if (newTags.length) onChange([...tags, ...newTags]);
    setInput("");
  }

  function onKeyDown(e) {
    if (["Enter", ",", "Tab"].includes(e.key)) {
      e.preventDefault();
      if (input.trim()) add(input);
    } else if (e.key === "Backspace" && !input && tags.length) {
      onChange(tags.slice(0, -1));
    }
  }

  function onPaste(e) {
    e.preventDefault();
    add(e.clipboardData.getData("text"));
  }

  return (
    <div className="tag-wrap">
      {tags.map((t, i) => (
        <span key={i} className="tag">
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
        className="tag-input"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onBlur={() => { if (input.trim()) add(input); }}
        placeholder={tags.length === 0 ? placeholder : "Add more…"}
      />
    </div>
  );
}

/* ─── Progress steps ─────────────────────────────────────────────────── */
const STEPS = [
  { icon: "🔍", label: "Searching top-ranking pages…" },
  { icon: "📖", label: "Reading competitor content…" },
  { icon: "🧠", label: "Analysing content gaps & NLP signals…" },
  { icon: "✍️",  label: "Writing your SEO-optimised blog…" },
  { icon: "✅", label: "Quality check & finalising…" },
];

function ProgressPanel({ step }) {
  return (
    <div className="progress-panel">
      <div className="progress-spinner" />
      <div className="progress-steps">
        {STEPS.map((s, i) => (
          <div
            key={i}
            className={`progress-step ${i < step ? "done" : i === step ? "active" : "waiting"}`}
          >
            <span className="ps-icon">{i < step ? "✅" : s.icon}</span>
            <span className="ps-label">{s.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── HTML Preview ───────────────────────────────────────────────────── */
function HtmlPreview({ html }) {
  const iframeRef = useRef(null);
  useEffect(() => {
    if (!iframeRef.current) return;
    const doc = iframeRef.current.contentDocument;
    doc.open();
    doc.write(`<!doctype html><html><head><meta charset="utf-8"><style>
      body{font-family:system-ui,sans-serif;line-height:1.7;padding:24px;max-width:760px;margin:0 auto;color:#1e293b}
      h1,h2,h3{color:#1e40af;line-height:1.3}h1{font-size:2rem}h2{font-size:1.4rem;margin-top:2rem}
      h3{font-size:1.1rem}p{margin:.8rem 0}ul,ol{padding-left:1.4rem}li{margin:.3rem 0}
      code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:.9em}
      pre{background:#f1f5f9;padding:12px;border-radius:8px;overflow-x:auto}
      blockquote{border-left:4px solid #3b82f6;margin:0;padding:8px 16px;background:#eff6ff;color:#1e40af}
      table{border-collapse:collapse;width:100%}td,th{border:1px solid #e2e8f0;padding:8px 12px}th{background:#f8fafc}
      img{max-width:100%;border-radius:8px}a{color:#2563eb}
    </style></head><body>${html}</body></html>`);
    doc.close();
  }, [html]);
  return <iframe ref={iframeRef} className="html-preview-frame" title="Blog Preview" />;
}

/* ─── Copy button ────────────────────────────────────────────────────── */
function CopyBtn({ text, label = "Copy" }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button type="button" className="btn btn-sm btn-ghost" onClick={copy}>
      {copied ? "✅ Copied!" : `📋 ${label}`}
    </button>
  );
}

/* ─── Main page ──────────────────────────────────────────────────────── */
const DEFAULT_FORM = {
  project_id: "",
  topic: "",
  primary_keyword: "",
  secondary_keywords: [],
  nlp_terms: [],
  note: "",
  word_count: 1500,
  tone: "professional",
  country: "in",
};

export default function BlogGenPage() {
  const [form, setForm]         = useState(DEFAULT_FORM);
  const [projects, setProjects] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [step, setStep]         = useState(0);
  const [draft, setDraft]       = useState(null);
  const [error, setError]       = useState("");
  const [tab, setTab]           = useState("preview"); // preview | meta | html
  const stepTimerRef            = useRef(null);

  /* load projects */
  useEffect(() => {
    fetch("/api/blog-gen/projects")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length) {
          setProjects(data);
          setForm((f) => ({ ...f, project_id: String(data[0].id) }));
        }
      })
      .catch(() => {});
  }, []);

  function set(key, val) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  /* auto-advance progress bar during generation */
  function startStepTimer() {
    let s = 0;
    setStep(0);
    stepTimerRef.current = setInterval(() => {
      s = Math.min(s + 1, STEPS.length - 1);
      setStep(s);
    }, 22000); // advance step every ~22s
  }
  function stopStepTimer() {
    if (stepTimerRef.current) clearInterval(stepTimerRef.current);
  }

  async function onGenerate(e) {
    e.preventDefault();
    if (!form.primary_keyword.trim() && !form.topic.trim()) {
      setError("Primary keyword ya topic daalein.");
      return;
    }
    setError("");
    setDraft(null);
    setLoading(true);
    startStepTimer();

    try {
      const res = await fetch("/api/blog-gen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Generation failed.");
      } else {
        setStep(STEPS.length - 1);
        setTimeout(() => setDraft(data), 600);
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
    const blob = new Blob([draft.html], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${draft.slug || "blog"}.html`;
    a.click();
  }

  const wordCount = draft?.html
    ? draft.html.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean).length
    : 0;

  return (
    <>
      <div className="bg-page">
        {/* ── Header ── */}
        <div className="page-header">
          <div>
            <h2 className="page-title">✍️ Blog Generator</h2>
            <p className="page-sub">
              Competitor research → gap analysis → SEO-optimised blog — fully automated.
            </p>
          </div>
        </div>

        <div className="bg-body">
          {/* ══ LEFT: Form ══ */}
          <form className="bg-form card" onSubmit={onGenerate}>
            {/* Section: Topic & Keywords */}
            <div className="form-section">
              <div className="section-label">🎯 Topic & Keywords</div>

              <label className="field-label">Blog Topic</label>
              <input
                className="field-input"
                placeholder="e.g. Best accounting software for small businesses in India"
                value={form.topic}
                onChange={(e) => set("topic", e.target.value)}
              />

              <label className="field-label required">Primary Keyword</label>
              <input
                className="field-input"
                placeholder="e.g. accounting software India"
                value={form.primary_keyword}
                onChange={(e) => set("primary_keyword", e.target.value)}
                required
              />

              <label className="field-label">
                Secondary Keywords
                <span className="field-hint"> — Enter karo, comma ya Enter se add hoga</span>
              </label>
              <TagInput
                value={form.secondary_keywords}
                onChange={(v) => set("secondary_keywords", v)}
                placeholder="e.g. GST billing software, invoicing app…"
              />

              <label className="field-label">
                NLP / LSI Terms
                <span className="field-hint"> — Semantic words jo blog mein include honge</span>
              </label>
              <TagInput
                value={form.nlp_terms}
                onChange={(v) => set("nlp_terms", v)}
                placeholder="e.g. accounts payable, balance sheet, tally alternative…"
              />

              <label className="field-label">
                Note / Extra Instructions
                <span className="field-hint"> — AI ko additional context dein</span>
              </label>
              <textarea
                className="field-input field-textarea"
                placeholder="e.g. Focus on Chartered Accountants. Mention AccountX in examples. Include a comparison table."
                value={form.note}
                onChange={(e) => set("note", e.target.value)}
                rows={3}
              />
            </div>

            {/* Section: Settings */}
            <div className="form-section">
              <div className="section-label">⚙️ Settings</div>

              <div className="settings-row">
                <div className="settings-col">
                  <label className="field-label">Target Word Count</label>
                  <div className="slider-row">
                    <input
                      type="range"
                      min={600}
                      max={4000}
                      step={100}
                      value={form.word_count}
                      onChange={(e) => set("word_count", Number(e.target.value))}
                      className="slider"
                    />
                    <span className="slider-val">{form.word_count.toLocaleString()}</span>
                  </div>
                </div>

                <div className="settings-col">
                  <label className="field-label">Tone</label>
                  <select
                    className="field-input"
                    value={form.tone}
                    onChange={(e) => set("tone", e.target.value)}
                  >
                    <option value="auto">Auto (AI decides)</option>
                    <option value="professional">Professional</option>
                    <option value="conversational">Conversational</option>
                    <option value="casual">Casual</option>
                    <option value="technical">Technical</option>
                    <option value="authoritative">Authoritative</option>
                  </select>
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-col">
                  <label className="field-label">Target Country</label>
                  <select
                    className="field-input"
                    value={form.country}
                    onChange={(e) => set("country", e.target.value)}
                  >
                    <option value="in">🇮🇳 India</option>
                    <option value="us">🇺🇸 USA</option>
                    <option value="gb">🇬🇧 UK</option>
                    <option value="au">🇦🇺 Australia</option>
                    <option value="ca">🇨🇦 Canada</option>
                  </select>
                </div>

                <div className="settings-col">
                  <label className="field-label">Project</label>
                  <select
                    className="field-input"
                    value={form.project_id}
                    onChange={(e) => set("project_id", e.target.value)}
                  >
                    {projects.length === 0 && <option value="1">Default (Project 1)</option>}
                    {projects.map((p) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.name || `Project ${p.id}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {error && <div className="alert alert-error">{error}</div>}

            <button
              type="submit"
              className="btn btn-primary btn-generate"
              disabled={loading}
            >
              {loading ? (
                <>
                  <span className="btn-spinner" /> Generating…
                </>
              ) : (
                "⚡ Generate Blog"
              )}
            </button>

            <p className="gen-note">
              AI will research top-ranking competitors, analyse gaps, and write a blog that outranks them.
              Takes ~60–120 seconds.
            </p>
          </form>

          {/* ══ RIGHT: Results ══ */}
          <div className="bg-result">
            {!loading && !draft && (
              <div className="empty-result card">
                <div className="empty-icon">📄</div>
                <div className="empty-title">Your blog will appear here</div>
                <div className="empty-sub">
                  Fill the form and click Generate Blog to create an SEO-optimised post
                  based on what&apos;s currently ranking for your keyword.
                </div>
              </div>
            )}

            {loading && <ProgressPanel step={step} />}

            {draft && !loading && (
              <div className="draft-card card">
                {/* Draft header */}
                <div className="draft-header">
                  <div className="draft-meta-row">
                    <span className="status-pill status-draft">Draft</span>
                    <span className="draft-words">~{wordCount.toLocaleString()} words</span>
                    {draft.cost_estimate_usd > 0 && (
                      <span className="draft-cost">${draft.cost_estimate_usd.toFixed(4)}</span>
                    )}
                  </div>
                  <h3 className="draft-title">{draft.title}</h3>
                  <div className="draft-slug">/{draft.slug}</div>
                </div>

                {/* Tabs */}
                <div className="result-tabs">
                  {[
                    { id: "preview", label: "👁 Preview" },
                    { id: "meta",    label: "🏷 SEO Meta" },
                    { id: "html",    label: "💻 HTML" },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`result-tab ${tab === t.id ? "active" : ""}`}
                      onClick={() => setTab(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                {/* Tab content */}
                {tab === "preview" && (
                  <div className="tab-content">
                    <HtmlPreview html={draft.html || ""} />
                  </div>
                )}

                {tab === "meta" && (
                  <div className="tab-content meta-panel">
                    <div className="meta-row">
                      <span className="meta-key">Title</span>
                      <span className="meta-val">{draft.title}</span>
                      <CopyBtn text={draft.title} label="Title" />
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">Slug</span>
                      <span className="meta-val">{draft.slug}</span>
                      <CopyBtn text={draft.slug} label="Slug" />
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">Meta Title</span>
                      <span className="meta-val">{draft.meta_title}</span>
                      <CopyBtn text={draft.meta_title} label="Meta Title" />
                    </div>
                    <div className="meta-row">
                      <span className="meta-key">Meta Desc</span>
                      <span className="meta-val">{draft.meta_description}</span>
                      <CopyBtn text={draft.meta_description} label="Meta Desc" />
                    </div>
                    {draft.faq_json?.length > 0 && (
                      <div className="meta-row faq-row">
                        <span className="meta-key">FAQs</span>
                        <div className="faq-list">
                          {draft.faq_json.map((faq, i) => (
                            <div key={i} className="faq-item">
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

                {tab === "html" && (
                  <div className="tab-content">
                    <div className="html-toolbar">
                      <CopyBtn text={draft.html || ""} label="Copy HTML" />
                      <button type="button" className="btn btn-sm btn-ghost" onClick={downloadHtml}>
                        ⬇️ Download HTML
                      </button>
                    </div>
                    <pre className="html-code">{draft.html}</pre>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        /* ── Layout ── */
        .bg-page { padding: 0; }
        .page-header {
          display: flex; align-items: flex-start; justify-content: space-between;
          padding: 28px 32px 20px;
          border-bottom: 1px solid var(--border);
        }
        .page-title { font-size: 1.5rem; font-weight: 700; color: var(--blue); margin: 0 0 4px; }
        .page-sub { color: var(--muted); font-size: .88rem; margin: 0; }
        .bg-body {
          display: grid;
          grid-template-columns: 380px 1fr;
          gap: 24px;
          padding: 24px 32px 32px;
          align-items: start;
        }
        @media (max-width: 960px) {
          .bg-body { grid-template-columns: 1fr; }
        }

        /* ── Form card ── */
        .bg-form {
          display: flex; flex-direction: column; gap: 0;
          padding: 24px;
          position: sticky; top: 20px;
        }
        .form-section { margin-bottom: 20px; }
        .section-label {
          font-size: .75rem; font-weight: 700; letter-spacing: .06em;
          text-transform: uppercase; color: var(--blue);
          margin-bottom: 14px; padding-bottom: 8px;
          border-bottom: 1px solid var(--border);
        }
        .field-label {
          display: block; font-size: .82rem; font-weight: 600;
          color: #374151; margin-bottom: 5px; margin-top: 12px;
        }
        .field-label.required::after { content: " *"; color: #ef4444; }
        .field-hint { font-weight: 400; color: var(--muted); font-size: .78rem; }
        .field-input {
          width: 100%; box-sizing: border-box;
          border: 1.5px solid var(--border); border-radius: 8px;
          padding: 9px 12px; font-size: .88rem; color: #1e293b;
          background: var(--surface2);
          transition: border-color .15s, box-shadow .15s;
          outline: none;
        }
        .field-input:focus { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
        .field-textarea { resize: vertical; min-height: 70px; font-family: inherit; }

        /* Tag input */
        .tag-wrap {
          display: flex; flex-wrap: wrap; gap: 5px; align-items: center;
          border: 1.5px solid var(--border); border-radius: 8px;
          padding: 7px 10px; background: var(--surface2);
          min-height: 42px; cursor: text;
          transition: border-color .15s, box-shadow .15s;
        }
        .tag-wrap:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }
        .tag {
          display: inline-flex; align-items: center; gap: 4px;
          background: #dbeafe; color: #1e40af;
          border-radius: 20px; padding: 2px 10px 2px 10px;
          font-size: .78rem; font-weight: 500;
        }
        .tag-del {
          background: none; border: none; cursor: pointer;
          color: #3b82f6; font-size: 1rem; line-height: 1; padding: 0; margin: 0;
        }
        .tag-del:hover { color: #ef4444; }
        .tag-input {
          border: none; outline: none; background: transparent;
          font-size: .85rem; flex: 1; min-width: 100px; color: #1e293b;
        }

        /* Settings grid */
        .settings-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .settings-col {}
        .slider-row { display: flex; align-items: center; gap: 10px; }
        .slider { flex: 1; accent-color: var(--blue); }
        .slider-val { font-size: .85rem; font-weight: 700; color: var(--blue); min-width: 48px; }

        /* Alert */
        .alert { border-radius: 8px; padding: 10px 14px; font-size: .85rem; margin-bottom: 12px; }
        .alert-error { background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; }

        /* Generate button */
        .btn-generate {
          width: 100%; padding: 13px; font-size: 1rem; font-weight: 700;
          border-radius: 10px; margin-top: 4px;
        }
        .btn-spinner {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
          border-radius: 50%; animation: spin .6s linear infinite;
          vertical-align: middle; margin-right: 6px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .gen-note { font-size: .76rem; color: var(--muted); text-align: center; margin: 8px 0 0; }

        /* ── Result panel ── */
        .bg-result {}
        .empty-result {
          padding: 60px 32px; text-align: center;
          border: 2px dashed var(--border);
          background: var(--surface2);
        }
        .empty-icon { font-size: 3rem; margin-bottom: 12px; }
        .empty-title { font-size: 1.1rem; font-weight: 700; color: #374151; margin-bottom: 8px; }
        .empty-sub { font-size: .87rem; color: var(--muted); max-width: 320px; margin: 0 auto; line-height: 1.6; }

        /* Progress */
        .progress-panel {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 16px;
          padding: 36px 32px;
          box-shadow: var(--shadow);
          text-align: center;
        }
        .progress-spinner {
          width: 48px; height: 48px;
          border: 4px solid #e0e7ff; border-top-color: var(--blue);
          border-radius: 50%; animation: spin .8s linear infinite;
          margin: 0 auto 24px;
        }
        .progress-steps { display: flex; flex-direction: column; gap: 12px; }
        .progress-step {
          display: flex; align-items: center; gap: 12px;
          padding: 10px 16px; border-radius: 10px;
          font-size: .9rem; transition: all .3s;
        }
        .progress-step.done { background: #f0fdf4; color: #166534; }
        .progress-step.active { background: #eff6ff; color: var(--blue); font-weight: 600; }
        .progress-step.waiting { color: #94a3b8; }
        .ps-icon { font-size: 1.2rem; width: 24px; text-align: center; }
        .ps-label { flex: 1; text-align: left; }

        /* Draft card */
        .draft-card { padding: 0; overflow: hidden; }
        .draft-header {
          padding: 20px 24px 16px;
          background: linear-gradient(135deg, #eff6ff 0%, #f0f9ff 100%);
          border-bottom: 1px solid var(--border);
        }
        .draft-meta-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
        .draft-title { font-size: 1.15rem; font-weight: 700; color: #1e293b; margin: 0 0 6px; line-height: 1.4; }
        .draft-slug { font-size: .82rem; color: var(--muted); font-family: monospace; }
        .draft-words { font-size: .82rem; color: #64748b; background: #f1f5f9; padding: 2px 8px; border-radius: 20px; }
        .draft-cost { font-size: .8rem; color: #16a34a; background: #f0fdf4; padding: 2px 8px; border-radius: 20px; }

        /* Tabs */
        .result-tabs {
          display: flex; gap: 0;
          border-bottom: 1px solid var(--border);
          padding: 0 20px;
          background: var(--surface2);
        }
        .result-tab {
          padding: 11px 18px; border: none; background: none;
          font-size: .88rem; font-weight: 500; color: var(--muted);
          cursor: pointer; border-bottom: 2px solid transparent;
          transition: color .15s, border-color .15s; margin-bottom: -1px;
        }
        .result-tab.active { color: var(--blue); border-bottom-color: var(--blue); font-weight: 700; }
        .result-tab:hover:not(.active) { color: #374151; }

        /* Tab content */
        .tab-content { padding: 0; }
        .html-preview-frame {
          width: 100%; height: 600px; border: none;
          border-radius: 0 0 12px 12px;
        }

        /* Meta panel */
        .meta-panel { padding: 16px 20px; display: flex; flex-direction: column; gap: 2px; }
        .meta-row {
          display: grid; grid-template-columns: 90px 1fr auto;
          gap: 10px; align-items: start;
          padding: 10px 0; border-bottom: 1px solid var(--border);
        }
        .meta-row:last-child { border-bottom: none; }
        .meta-key { font-size: .78rem; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; padding-top: 2px; }
        .meta-val { font-size: .88rem; color: #1e293b; line-height: 1.5; }
        .faq-row { grid-template-columns: 90px 1fr; }
        .faq-list { display: flex; flex-direction: column; gap: 10px; }
        .faq-item { font-size: .85rem; color: #374151; background: var(--surface2); padding: 10px 12px; border-radius: 8px; line-height: 1.6; }

        /* HTML tab */
        .html-toolbar {
          display: flex; gap: 8px; padding: 10px 16px;
          background: var(--surface2); border-bottom: 1px solid var(--border);
        }
        .html-code {
          font-size: .75rem; font-family: 'Consolas', 'Monaco', monospace;
          padding: 16px 20px; overflow-x: auto; max-height: 540px;
          background: #0f172a; color: #e2e8f0;
          margin: 0; border-radius: 0 0 12px 12px;
          white-space: pre-wrap; word-break: break-all;
        }

        /* Buttons */
        .btn { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; border: none; border-radius: 8px; font-weight: 600; transition: all .15s; }
        .btn-primary { background: linear-gradient(135deg, var(--blue) 0%, var(--blue-dark) 100%); color: #fff; }
        .btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(37,99,235,.4); }
        .btn-primary:disabled { opacity: .6; cursor: not-allowed; transform: none; }
        .btn-sm { padding: 6px 12px; font-size: .82rem; }
        .btn-ghost { background: var(--surface); border: 1px solid var(--border); color: #374151; }
        .btn-ghost:hover { background: #f1f5f9; }

        /* Status pills */
        .status-pill { display: inline-block; border-radius: 20px; padding: 3px 10px; font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
        .status-draft { background: #fef3c7; color: #92400e; }
      `}</style>
    </>
  );
}
