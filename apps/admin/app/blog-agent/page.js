'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AuthGate from '@/components/AuthGate';
import Header from '@/components/Header';
import { apiFetch } from '@/lib/api';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8010';
const FALLBACK_API_URL = process.env.NEXT_PUBLIC_API_FALLBACK_URL || 'http://localhost:8000';
const LAST_PROJECT_KEY = 'contentops_blog_agent_last_project_id';
const ACTIVE_RUN_KEY = 'contentops_blog_agent_active_run_id';
const ACTIVE_RUN_PROJECT_KEY = 'contentops_blog_agent_active_project_id';
const ACTIVE_GEN_STARTED_AT_KEY = 'contentops_blog_agent_active_started_at';
const ACTIVE_TASK_KEY = 'contentops_blog_agent_active_task_id';

const DEFAULT_FORM = {
  project_id: '',
  platform: 'none',
  topic_mode: 'keyword',
  topic: '',
  primary_keyword: '',
  secondary_keywords_text: '',
  tone: 'auto',
  country: 'in',
  language: 'en',
  desired_word_count: 1200,
  image_mode: 'featured+inline',
  inline_images_count: 2,
  autopublish: false,
  publish_status: 'draft',
  schedule_datetime: '',
};

const GENERATION_STAGE_MESSAGES = [
  { afterSec: 0, text: 'Starting research and outline synthesis...' },
  { afterSec: 8, text: 'Analyzing web/context and building structure...' },
  { afterSec: 18, text: 'Writing long-form draft + SEO metadata...' },
  { afterSec: 35, text: 'Running QA checks and similarity guard...' },
  { afterSec: 50, text: 'Generating featured/inline images and finalizing preview...' },
];

const STAGE_PROGRESS_MAP = {
  queued: 6,
  research: 22,
  brief: 38,
  draft: 60,
  qa: 75,
  image: 86,
  'save-draft': 93,
  'outline-completed': 95,
  completed: 100,
  failed: 100,
};

const RUN_ALLOCATION_SOFT_TIMEOUT_MS = 45_000;
const RUN_ALLOCATION_HARD_TIMEOUT_MS = 15 * 60_000;

function parseSecondaryKeywords(text) {
  return String(text || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHostFromUrl(url) {
  try {
    const host = new URL(String(url || '').trim()).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function hashSeed(value) {
  const text = String(value || '').trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

function normalizeHexColor(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const hex = raw.startsWith('#') ? raw : `#${raw}`;
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(hex)) {
    const a = hex[1];
    const b = hex[2];
    const c = hex[3];
    return `#${a}${a}${b}${b}${c}${c}`.toLowerCase();
  }
  return '';
}

function hexToRgb(hex) {
  const value = normalizeHexColor(hex);
  if (!value) return null;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  const toHex = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function mixHex(a, b, ratio = 0.5) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return normalizeHexColor(a) || normalizeHexColor(b) || '';
  const k = Math.max(0, Math.min(1, Number(ratio)));
  return rgbToHex(
    ca.r * (1 - k) + cb.r * k,
    ca.g * (1 - k) + cb.g * k,
    ca.b * (1 - k) + cb.b * k
  );
}

function rgbaFromHex(hex, alpha = 1) {
  const rgb = hexToRgb(hex);
  if (!rgb) return '';
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`;
}

function hslToHex(h, s, l) {
  const ss = s / 100;
  const ll = l / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ll - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function previewThemeVarsFromHost(host) {
  const seed = hashSeed(host || 'default-preview');
  const hue = seed % 360;
  const accent = hslToHex(hue, 62, 42);
  const accentSoft = hslToHex((hue + 18) % 360, 74, 64);
  const border = hslToHex(hue, 52, 78);
  const surface = hslToHex(hue, 45, 97);
  return {
    '--preview-accent': accent,
    '--preview-accent-soft': accentSoft,
    '--preview-border': border,
    '--preview-surface': surface,
    '--preview-faq-border': rgbaFromHex(accent, 0.34),
    '--preview-faq-summary-bg': rgbaFromHex(accent, 0.15),
    '--preview-faq-summary-color': accent,
    '--preview-faq-body-bg': rgbaFromHex(accentSoft, 0.14),
    '--preview-faq-shadow': rgbaFromHex(accent, 0.18),
  };
}

function previewThemeVarsFromProject(project) {
  const settings = project?.settings_json || {};
  const host = normalizeHostFromUrl(project?.base_url || '');

  const primary = normalizeHexColor(
    settings.brand_primary_color ||
    settings.primary_color ||
    settings.accent_color ||
    settings.theme_color
  );
  const secondary = normalizeHexColor(
    settings.brand_secondary_color ||
    settings.secondary_color ||
    settings.accent_color_secondary
  );
  const surface = normalizeHexColor(
    settings.brand_surface_color ||
    settings.surface_color ||
    settings.background_color
  );

  if (!primary) {
    return previewThemeVarsFromHost(host);
  }

  const accent = primary;
  const accentSoft = secondary || mixHex(primary, '#ffffff', 0.34);
  const borderColor = mixHex(primary, '#ffffff', 0.62);
  const surfaceColor = surface || mixHex(primary, '#ffffff', 0.93);

  return {
    '--preview-accent': accent,
    '--preview-accent-soft': accentSoft,
    '--preview-border': borderColor,
    '--preview-surface': surfaceColor,
    '--preview-faq-border': rgbaFromHex(accent, 0.34),
    '--preview-faq-summary-bg': rgbaFromHex(accent, 0.15),
    '--preview-faq-summary-color': accent,
    '--preview-faq-body-bg': rgbaFromHex(accentSoft, 0.14),
    '--preview-faq-shadow': rgbaFromHex(accent, 0.18),
  };
}

function shortenUrlForDisplay(url, max = 84) {
  const value = String(url || '').trim();
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(24, max - 20))}...${value.slice(-16)}`;
}

function parseApiError(err) {
  const message = String(err?.message || err || 'Unknown API error');
  try {
    const parsed = JSON.parse(message);
    if (parsed?.detail) return String(parsed.detail);
  } catch (_) {
    // no-op
  }
  return message;
}

function extractProviderLimitMessage(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return '';
  const signals = [
    'insufficient_quota',
    'quota',
    'rate limit',
    'rate_limit',
    '429',
    'billing',
    'token limit',
    'context length',
    'openaierror',
  ];
  const matched = signals.some((s) => text.includes(s));
  if (!matched) return '';
  return 'OpenAI limit reached or provider throttled. Update billing/limits and retry.';
}

function extractProviderAuthMessage(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return '';
  const openAiSignal =
    text.includes('openai') ||
    text.includes('api.openai.com') ||
    text.includes('gpt-') ||
    text.includes('image generation');
  const signals = [
    'invalid api key',
    'incorrect api key',
    'auth failed',
    'unauthorized',
    'openai api key is not configured',
    'openai auth failed',
  ];
  const matched =
    signals.some((s) => text.includes(s)) ||
    (openAiSignal && (text.includes('401') || text.includes('403') || text.includes('forbidden')));
  if (!matched) return '';
  return 'OpenAI key/model invalid. Fix Settings > OpenAI and retry.';
}

function statusClass(type) {
  if (type === 'error') return 'msg error';
  return 'msg';
}

function formatIstTime(value) {
  if (!value) return '';
  try {
    const raw = String(value || '').trim();
    const hasTz = /([zZ]|[+\-]\d{2}:\d{2})$/.test(raw);
    const safe = hasTz ? raw : `${raw}Z`;
    return new Date(safe).toLocaleTimeString('en-IN', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch (_) {
    return '';
  }
}

function formatIstDateTime(value) {
  if (!value) return '';
  try {
    const raw = String(value || '').trim();
    const hasTz = /([zZ]|[+\-]\d{2}:\d{2})$/.test(raw);
    const safe = hasTz ? raw : `${raw}Z`;
    return new Date(safe).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    });
  } catch (_) {
    return '';
  }
}

function normalizeMediaPath(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;

  const normalized = raw.replace(/\\/g, '/');
  if (normalized.startsWith('/media/')) return normalized;
  if (normalized.includes('/media/')) return normalized.slice(normalized.indexOf('/media/'));
  if (normalized.startsWith('media/')) return `/${normalized}`;
  if (normalized.includes('storage/media/')) {
    return `/media/${normalized.split('storage/media/')[1]}`;
  }
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function rewritePreviewHtml(html, apiBase, fallbackBase, useFallback = false) {
  const source = String(html || '');
  if (!source) return source;
  const base = useFallback ? fallbackBase : apiBase;
  return source.replace(/(<img[^>]+src=["'])([^"']+)(["'][^>]*>)/gi, (_, prefix, src, suffix) => {
    const normalized = normalizeMediaPath(src);
    if (!normalized) return `${prefix}${src}${suffix}`;
    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
      return `${prefix}${normalized}${suffix}`;
    }
    return `${prefix}${base}${normalized}${suffix}`;
  });
}

function stripDebugSectionsFromHtml(value) {
  const source = String(value || '');
  if (!source) return '';
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return source;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(source, 'text/html');
    Array.from(doc.querySelectorAll('.contentops-hero')).forEach((node) => node.remove());
    const labels = new Set([
      'sources analyzed',
      'what we improved vs analyzed pages',
      'key research signals',
      'research signals',
      'source urls',
      'sources',
      'references',
      'citations',
      'research links',
    ]);
    const norm = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const headings = Array.from(doc.querySelectorAll('h2, h3'));
    headings.forEach((heading) => {
      const label = norm(heading.textContent || '');
      if (!labels.has(label)) return;
      let node = heading.nextElementSibling;
      heading.remove();
      while (node) {
        const next = node.nextElementSibling;
        if (['H2', 'H3'].includes(node.tagName)) break;
        node.remove();
        node = next;
      }
    });
    const isFaqLabel = (label) => {
      const l = String(label || '').toLowerCase();
      return l.startsWith('frequently asked questions') || l.startsWith('frequently asked question') || l === 'faq' || l === 'faqs' || l.startsWith('faq ') || l.startsWith('faqs ') || l === 'faq section';
    };
    const detailQuestions = new Set(
      Array.from(doc.querySelectorAll('details > summary'))
        .map((n) => norm(n.textContent || '').replace(/\?+$/, ''))
        .filter(Boolean)
    );
    const hasAccordionFaq = detailQuestions.size > 0;
    if (hasAccordionFaq) {
      // Remove any plain FAQ question-answer duplicates and enforce single heading before accordion.
      Array.from(doc.querySelectorAll('h3, h4')).forEach((heading) => {
        const key = norm(heading.textContent || '').replace(/\?+$/, '');
        if (!detailQuestions.has(key)) return;
        let node = heading.nextElementSibling;
        heading.remove();
        while (node) {
          const next = node.nextElementSibling;
          if (['H2', 'H3', 'H4'].includes(node.tagName)) break;
          node.remove();
          node = next;
        }
      });
      Array.from(doc.querySelectorAll('h2, h3, p')).forEach((node) => {
        const label = norm(node.textContent || '');
        if (isFaqLabel(label)) node.remove();
      });
      const firstDetails = doc.querySelector('details');
      if (firstDetails) {
        const faqH2 = doc.createElement('h2');
        faqH2.textContent = 'Frequently Asked Questions';
        firstDetails.parentNode.insertBefore(faqH2, firstDetails);
      }
    } else {
      // Fallback when no accordion exists: keep only first FAQ heading block.
      let faqSeen = false;
      Array.from(doc.querySelectorAll('h2, h3, p')).forEach((heading) => {
        const label = norm(heading.textContent || '');
        if (!isFaqLabel(label)) return;
        if (!faqSeen) {
          faqSeen = true;
          return;
        }
        let node = heading.nextElementSibling;
        heading.remove();
        while (node) {
          const next = node.nextElementSibling;
          if (['H2'].includes(node.tagName)) break;
          node.remove();
          node = next;
        }
      });
    }
    Array.from(doc.querySelectorAll('p')).forEach((node) => {
      const txt = String(node.textContent || '').toLowerCase();
      if (txt.includes('action sprint:')) {
        node.remove();
        return;
      }
      if (txt.includes('{{') || txt.includes('{%')) {
        node.remove();
        return;
      }
      if (txt.includes('decision-ready') || txt.includes('reader-first') || txt.includes('execution-focused')) {
        node.remove();
        return;
      }
      if (txt.includes('can be addressed effectively by aligning goals, execution steps, and measurable checkpoints')) {
        node.remove();
        return;
      }
      const urls = txt.match(/https?:\/\/\S+/g) || [];
      if (urls.length >= 2 || txt.startsWith('https://') || txt.startsWith('http://')) {
        node.remove();
      }
    });
    Array.from(doc.querySelectorAll('h2, h3')).forEach((node) => {
      const label = norm(node.textContent || '');
      if (label === 'in this guide') {
        let next = node.nextElementSibling;
        node.remove();
        while (next) {
          const cursor = next;
          next = next.nextElementSibling;
          if (['H2', 'H3'].includes(cursor.tagName)) break;
          cursor.remove();
        }
        return;
      }
      node.textContent = String(node.textContent || '').replace(/^\s*\d{1,2}\s*[\.\):-]?\s*/g, '').trim();
    });
    Array.from(doc.querySelectorAll('li')).forEach((node) => {
      const txt = String(node.textContent || '').trim().toLowerCase();
      if (txt.includes('action sprint:') || txt.includes('{{') || txt.includes('{%')) {
        node.remove();
        return;
      }
      if (txt.startsWith('https://') || txt.startsWith('http://')) {
        node.remove();
      }
    });
    Array.from(doc.querySelectorAll('span, div')).forEach((node) => {
      const txt = String(node.textContent || '').trim().toLowerCase();
      if (!txt) return;
      if (txt === 'decision-ready' || txt === 'reader-first' || txt === 'execution-focused') {
        node.remove();
      }
    });
    // Remove leftover decorative/grid blocks created by old layout injectors.
    Array.from(doc.querySelectorAll('div')).forEach((node) => {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const style = String(node.getAttribute('style') || '').toLowerCase();
      if (
        style.includes('grid-template-columns:repeat(3') ||
        text.includes('decision-ready') ||
        text.includes('reader-first') ||
        text.includes('execution-focused')
      ) {
        node.remove();
        return;
      }
      if (!text) {
        node.remove();
      }
    });
    Array.from(doc.querySelectorAll('h1, h2, h3, h4')).forEach((node) => {
      const cleaned = String(node.textContent || '').replace(/^\s*\d{1,2}\s*[\.\):-]?\s*/g, '').trim();
      if (!cleaned) {
        node.remove();
        return;
      }
      node.textContent = cleaned;
    });
    // Allow theme-driven FAQ colors by removing hardcoded inline styles from generated accordion HTML.
    Array.from(doc.querySelectorAll('details, details > summary, details > p')).forEach((node) => {
      node.removeAttribute('style');
    });
    const html = String(doc.body?.innerHTML || source)
      .replace(/\{\{[^}]+\}\}/g, '')
      .replace(/\{%[^%]+%\}/g, '');
    return html;
  } catch (_) {
    return source;
  }
}

function extractDraftIdFromRunEvents(events) {
  const rows = Array.isArray(events) ? events : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const evt = rows[i] || {};
    const msg = String(evt.message || '').toLowerCase();
    const meta = evt.meta_json || {};
    if (msg.includes('draft saved') && Number(meta.draft_id || 0) > 0) {
      return Number(meta.draft_id);
    }
  }
  return null;
}

function isRunOpen(run) {
  if (!run || typeof run !== 'object') return false;
  const status = String(run.status || '').toLowerCase();
  if (!['queued', 'running'].includes(status)) return false;
  if (run.finished_at) return false;
  return true;
}

export default function BlogAgentPage() {
  const [projects, setProjects] = useState([]);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [outlineEditor, setOutlineEditor] = useState('[]');
  const [draftState, setDraftState] = useState(null);
  const [activeDraftId, setActiveDraftId] = useState(null);
  const [errorPanel, setErrorPanel] = useState('');
  const [alerts, setAlerts] = useState([]);
  const [mediaFallback, setMediaFallback] = useState({});
  const [busyAction, setBusyAction] = useState('');
  const [actionLocked, setActionLocked] = useState(false);
  const [generationStartedAt, setGenerationStartedAt] = useState(null);
  const [generationHint, setGenerationHint] = useState('');
  const [generationProgress, setGenerationProgress] = useState(0);
  const [progressTarget, setProgressTarget] = useState(0);
  const [generationErrorMsg, setGenerationErrorMsg] = useState('');
  const [cancelingGeneration, setCancelingGeneration] = useState(false);
  const [imageStageNoticeShown, setImageStageNoticeShown] = useState(false);
  const [activeRunId, setActiveRunId] = useState(null);
  const [activeTaskId, setActiveTaskId] = useState(null);
  const [runFloorId, setRunFloorId] = useState(0);
  const [draftFloorId, setDraftFloorId] = useState(0);
  const [liveRunState, setLiveRunState] = useState(null);
  const [showOutlineEditor, setShowOutlineEditor] = useState(false);
  const [researchTab, setResearchTab] = useState('crawl');
  const [showProductCrawlRows, setShowProductCrawlRows] = useState(false);
  const [auditData, setAuditData] = useState(null);
  const actionLockRef = useRef(false);
  const lastRunTouchRef = useRef(0);
  const isTopicAssistMode = useMemo(
    () => String(form.topic_mode || '').toLowerCase().includes('topic'),
    [form.topic_mode]
  );

  const startGenerationUi = useCallback((hintText = GENERATION_STAGE_MESSAGES[0].text) => {
    actionLockRef.current = true;
    setActionLocked(true);
    setBusyAction('Generating full blog...');
    setGenerationStartedAt(Date.now());
    setGenerationHint(hintText);
    setGenerationProgress((prev) => (prev > 0 ? prev : 4));
    setProgressTarget((prev) => (prev > 0 ? prev : 8));
    lastRunTouchRef.current = Date.now();
  }, []);

  const clearGenerationUi = useCallback((opts = {}) => {
    const preserveError = Boolean(opts?.preserveError);
    actionLockRef.current = false;
    setActionLocked(false);
    setBusyAction('');
    setGenerationStartedAt(null);
    setGenerationHint('');
    if (!preserveError) {
      setGenerationErrorMsg('');
    }
    setActiveRunId(null);
    setActiveTaskId(null);
    setRunFloorId(0);
    setDraftFloorId(0);
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(ACTIVE_RUN_KEY);
      window.localStorage.removeItem(ACTIVE_RUN_PROJECT_KEY);
      window.localStorage.removeItem(ACTIVE_GEN_STARTED_AT_KEY);
      window.localStorage.removeItem(ACTIVE_TASK_KEY);
    }
    setTimeout(() => {
      setProgressTarget(0);
      setGenerationProgress(0);
    }, 700);
  }, []);

  const pushAlert = (type, text) => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setAlerts((prev) => [{ id, type, text }, ...prev].slice(0, 4));
  };

  const removeAlert = (id) => {
    setAlerts((prev) => prev.filter((item) => item.id !== id));
  };

  const resolveImageSrc = (path, key) => {
    const normalized = normalizeMediaPath(path);
    if (!normalized) return '';
    const base = mediaFallback[key] ? FALLBACK_API_URL : API_URL;
    return `${base}${normalized}`;
  };

  const projectMap = useMemo(() => {
    const map = {};
    projects.forEach((project) => {
      map[String(project.id)] = project;
    });
    return map;
  }, [projects]);
  const selectedProjectHost = useMemo(
    () => normalizeHostFromUrl(projectMap[String(form.project_id)]?.base_url || ''),
    [projectMap, form.project_id]
  );

  const previewHtml = useMemo(() => {
    const rewritten = rewritePreviewHtml(draftState?.content_html || '', API_URL, FALLBACK_API_URL);
    return stripDebugSectionsFromHtml(rewritten);
  }, [draftState?.content_html]);
  const previewThemeVars = useMemo(
    () => previewThemeVarsFromProject(projectMap[String(form.project_id)] || null),
    [projectMap, form.project_id]
  );
  const researchSources = useMemo(
    () => (Array.isArray(draftState?.sources_json) ? draftState.sources_json : []),
    [draftState?.sources_json]
  );
  const crawlSources = useMemo(
    () => (Array.isArray(draftState?.crawl_sources) ? draftState.crawl_sources : []),
    [draftState?.crawl_sources]
  );
  const visibleCrawlSources = useMemo(
    () => (showProductCrawlRows ? crawlSources : crawlSources.filter((row) => String(row?.page_type || '').toLowerCase() !== 'product')),
    [crawlSources, showProductCrawlRows]
  );
  const evidencePanel = useMemo(
    () => (Array.isArray(draftState?.evidence_panel) ? draftState.evidence_panel : []),
    [draftState?.evidence_panel]
  );
  const pipelineEvents = useMemo(
    () => (Array.isArray(draftState?.pipeline_events) ? draftState.pipeline_events : []),
    [draftState?.pipeline_events]
  );
  const livePipelineEvents = useMemo(
    () => (Array.isArray(liveRunState?.events) ? liveRunState.events : []),
    [liveRunState?.events]
  );
  const generationBusy = busyAction === 'Generating full blog...';
  const liveStageLabel = useMemo(() => {
    const fallbackStage = generationBusy ? 'queued' : (draftState?.pipeline_stage || 'queued');
    const stage = String(liveRunState?.run?.stage || fallbackStage).toLowerCase();
    const map = {
      queued: 'Queued',
      research: 'Research',
      brief: 'Brief',
      draft: 'Draft Writing',
      qa: 'QA',
      image: 'Image',
      'save-draft': 'Save Draft',
      completed: 'Completed',
      failed: 'Failed',
    };
    return map[stage] || stage || 'Queued';
  }, [liveRunState?.run?.stage, draftState?.pipeline_stage, generationBusy]);
  const liveResearchLinks = useMemo(() => {
    const urls = new Set();
    const includeDraftFallback = !generationBusy;
    const addMany = (items) => {
      (items || []).forEach((value) => {
        if (!(typeof value === 'string' && value.startsWith('http'))) return;
        const host = normalizeHostFromUrl(value);
        if (selectedProjectHost && host && host === selectedProjectHost) return;
        urls.add(value);
      });
    };
    if (includeDraftFallback) {
      addMany(draftState?.research_summary?.top_competitor_urls);
      addMany((draftState?.sources_json || []).map((item) => item?.url).filter(Boolean));
    }
    livePipelineEvents.forEach((evt) => {
      const meta = evt?.meta_json || {};
      addMany(meta.top_urls || []);
      addMany(meta.validated_competitor_urls || []);
      addMany(meta.top_competitor_urls || []);
      addMany(meta.crawl_candidate_urls || []);
      addMany(meta.requested_urls || []);
      addMany(meta.planned_urls || []);
    });
    return Array.from(urls).slice(0, 16);
  }, [draftState?.research_summary?.top_competitor_urls, draftState?.sources_json, livePipelineEvents, selectedProjectHost, generationBusy]);
  const liveProgressNotes = useMemo(() => {
    const notes = [];
    const seenText = new Set();
    const sortedEvents = [...livePipelineEvents].sort((a, b) => {
      const ta = new Date(a?.created_at || 0).getTime();
      const tb = new Date(b?.created_at || 0).getTime();
      return tb - ta;
    });
    sortedEvents.forEach((evt) => {
      const baseText = String(evt?.message || '').trim();
      const meta = evt?.meta_json || {};
      let text = baseText;
      if (/opencrawl discovery failed/i.test(baseText) && String(meta?.error || '').trim()) {
        text = `${baseText}: ${String(meta.error).trim()}`;
      }
      if (!text) return;
      const key = text.toLowerCase();
      if (seenText.has(key)) return;
      seenText.add(key);
      notes.push({
        id: evt?.id || `${text}-${evt?.created_at || Date.now()}`,
        time: evt?.created_at,
        text,
      });
      if (notes.length >= 10) return;
    });
    return notes;
  }, [livePipelineEvents]);
  const lastLiveEventAt = useMemo(() => {
    if (!liveProgressNotes.length) return '';
    return liveProgressNotes[0]?.time || '';
  }, [liveProgressNotes]);
  const liveHeadlineText = useMemo(
    () => (liveProgressNotes.length ? String(liveProgressNotes[0]?.text || '').trim() : ''),
    [liveProgressNotes]
  );
  const researchEventDetails = useMemo(() => {
    const allEvents = generationBusy ? [...(livePipelineEvents || [])] : [...(pipelineEvents || []), ...(livePipelineEvents || [])];
    const pick = (name) => [...allEvents].reverse().find((evt) => String(evt?.message || '') === name);
    const aiStart = pick('AI competitor synthesis started');
    const aiDone = pick('AI competitor synthesis completed');
    const library = pick('Library aggregation completed');
    const links = pick('Internal link planning completed');
    const finalResearch = pick('Research stage completed');

    const topUrls = [
      ...(aiDone?.meta_json?.top_competitor_urls || []),
      ...(finalResearch?.meta_json?.top_competitor_urls || []),
    ].filter((u, i, arr) => {
      if (!(typeof u === 'string' && u.startsWith('http'))) return false;
      const host = normalizeHostFromUrl(u);
      if (selectedProjectHost && host && host === selectedProjectHost) return false;
      return arr.indexOf(u) === i;
    });

    const plannedUrls = (links?.meta_json?.planned_urls || []).filter((u) => typeof u === 'string' && u.startsWith('http'));
    const competitorRequested = Number(
      (aiStart?.meta_json?.competitor_candidate_urls || aiStart?.meta_json?.candidate_site_urls || []).length
    );

    return {
      web_query: aiStart?.meta_json?.keyword || form.primary_keyword || '',
      web_result_count: Number((aiDone?.meta_json?.top_competitor_urls || []).length),
      competitor_requested: competitorRequested,
      competitor_success: Number((aiDone?.meta_json?.top_competitor_urls || []).length),
      library_count: Number(library?.meta_json?.library_count || 0),
      sitemap_count: Number(library?.meta_json?.sitemap_count || draftState?.research_summary?.sitemap_urls_count || 0),
      augmented_total: Number(library?.meta_json?.augmented_total || 0),
      internal_candidate_count: Number(links?.meta_json?.candidate_count || draftState?.research_summary?.internal_candidate_count || 0),
      internal_plan_count: Number(links?.meta_json?.plan_count || draftState?.research_summary?.internal_plan_count || 0),
      ai_observations: Array.isArray(aiDone?.meta_json?.observations) ? aiDone.meta_json.observations : [],
      ai_subtopics: Array.isArray(aiDone?.meta_json?.subtopics) ? aiDone.meta_json.subtopics : [],
      top_urls: topUrls.slice(0, 20),
      planned_urls: plannedUrls.slice(0, 20),
    };
  }, [pipelineEvents, livePipelineEvents, form.primary_keyword, draftState?.research_summary?.sitemap_urls_count, draftState?.research_summary?.internal_candidate_count, draftState?.research_summary?.internal_plan_count, selectedProjectHost, generationBusy]);
  const outlinePreviewItems = useMemo(() => {
    if (Array.isArray(draftState?.outline_json) && draftState.outline_json.length > 0) {
      return draftState.outline_json;
    }
    try {
      const parsed = JSON.parse(outlineEditor || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }, [draftState?.outline_json, outlineEditor]);

  const isGeneratingFull = useMemo(() => busyAction === 'Generating full blog...', [busyAction]);
  const isGeneratingImages = useMemo(() => busyAction === 'Generating images...', [busyAction]);
  const currentPipelineStage = useMemo(
    () => String(liveRunState?.run?.stage || draftState?.pipeline_stage || '').toLowerCase(),
    [liveRunState?.run?.stage, draftState?.pipeline_stage]
  );
  const isImageStageActive = useMemo(
    () => isGeneratingImages || (isGeneratingFull && ['image', 'save-draft'].includes(currentPipelineStage)),
    [isGeneratingImages, isGeneratingFull, currentPipelineStage]
  );

  useEffect(() => {
    if (isImageStageActive && !imageStageNoticeShown) {
      pushAlert('success', 'Image generation started: featured + inline visuals are being prepared.');
      setImageStageNoticeShown(true);
    }
    if (!isImageStageActive && imageStageNoticeShown) {
      setImageStageNoticeShown(false);
    }
  }, [isImageStageActive, imageStageNoticeShown]);

  const beginAction = (label) => {
    if (actionLockRef.current) return false;
    actionLockRef.current = true;
    setActionLocked(true);
    setBusyAction(label);
    setGenerationErrorMsg('');
    return true;
  };

  const endAction = () => {
    actionLockRef.current = false;
    setActionLocked(false);
    setBusyAction('');
  };

  const applyDraftState = useCallback((state) => {
    if (!state) return;
    setDraftState(state);
    if (state.draft_id) {
      setActiveDraftId(state.draft_id);
    }
    if (state.outline_json) {
      setOutlineEditor(JSON.stringify(state.outline_json || [], null, 2));
    }
  }, []);

  const buildGeneratePayload = () => {
    const secondary_keywords = parseSecondaryKeywords(form.secondary_keywords_text);
    const rawTopic = String(form.topic || '').trim();
    const rawPrimary = String(form.primary_keyword || '').trim();
    const derivedPrimary = rawPrimary || (isTopicAssistMode ? rawTopic : '');
    return {
      project_id: Number(form.project_id),
      platform: form.platform,
      topic: isTopicAssistMode ? rawTopic || null : null,
      primary_keyword: derivedPrimary,
      secondary_keywords,
      tone: form.tone,
      country: form.country,
      language: form.language,
      desired_word_count: Number(form.desired_word_count || 1200),
      image_mode: form.image_mode,
      inline_images_count: Math.max(0, Math.min(3, Number(form.inline_images_count || 0))),
      autopublish: Boolean(form.autopublish),
      publish_status: form.publish_status,
      schedule_datetime: form.schedule_datetime ? new Date(form.schedule_datetime).toISOString() : null,
      outline_override: safeParseOutline(),
      force_new: true,
    };
  };

  const onProjectChange = async (value) => {
    const selectedProject = projects.find((project) => String(project.id) === String(value));
    const projectCountry = selectedProject?.settings_json?.country || '';
    const projectLanguage = selectedProject?.settings_json?.language || '';
    setForm((prev) => ({
      ...prev,
      project_id: value,
      platform: selectedProject?.platform || prev.platform,
      country: projectCountry || prev.country || 'in',
      language: projectLanguage || prev.language || 'en',
    }));
    setDraftState(null);
    setActiveDraftId(null);
    setOutlineEditor('[]');
    setGenerationHint('');
    setErrorPanel('');
    if (typeof window !== 'undefined') {
      if (value) window.localStorage.setItem(LAST_PROJECT_KEY, String(value));
      else window.localStorage.removeItem(LAST_PROJECT_KEY);
    }
    if (!value) return;
    try {
      await loadLatestDraftForProject(value);
    } catch (_) {
      // no-op
    }
  };

  const safeParseOutline = () => {
    try {
      const parsed = JSON.parse(outlineEditor || '[]');
      if (!Array.isArray(parsed)) return null;
      return parsed.map((item) => String(item)).filter(Boolean);
    } catch (_) {
      return null;
    }
  };

  const resolveFreshDraftId = useCallback(
    async (candidateDraftId) => {
      const candidate = Number(candidateDraftId || 0);
      if (candidate > Number(draftFloorId || 0)) return candidate;
      const rows = await apiFetch(`/api/drafts?project_id=${Number(form.project_id)}&limit=10`);
      const all = Array.isArray(rows) ? rows : [];
      const fresh = all
        .map((row) => Number(row?.id || 0))
        .filter((id) => id > Number(draftFloorId || 0))
        .sort((a, b) => b - a)[0];
      return Number(fresh || 0);
    },
    [draftFloorId, form.project_id]
  );

  const loadLatestDraftForProject = useCallback(
    async (projectId) => {
      const pid = Number(projectId || 0);
      if (!pid) return null;
      const rows = await apiFetch(`/api/drafts?project_id=${pid}&limit=1`);
      const latest = rows?.[0];
      if (latest?.id) {
        const state = await apiFetch(`/api/blog-agent/${latest.id}`);
        applyDraftState(state);
        return state;
      }
      return null;
    },
    [applyDraftState]
  );

  const loadProjects = async () => {
    try {
      const data = await apiFetch('/api/projects');
      setProjects(data || []);
      const firstProject = data?.[0];
      const fromStorage =
        typeof window !== 'undefined' ? window.localStorage.getItem(LAST_PROJECT_KEY) || '' : '';
      const fromQuery =
        typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('project_id') || '' : '';
      const selected = fromQuery || fromStorage || String(firstProject?.id || '');
      const selectedProject = (data || []).find((project) => String(project.id) === String(selected)) || firstProject;
      if (selected) {
        setForm((prev) => ({
          ...prev,
          project_id: selected,
          platform: prev.platform === 'none' ? (selectedProject?.platform || 'none') : prev.platform,
          country: selectedProject?.settings_json?.country || prev.country || 'in',
          language: selectedProject?.settings_json?.language || prev.language || 'en',
        }));
        try {
          await loadLatestDraftForProject(selected);
        } catch (_) {
          // no-op: keep form usable even if draft preload fails
        }
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(LAST_PROJECT_KEY, String(selected));
        }
      }
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
    }
  };


  const loadDraftState = useCallback(async (draftId) => {
    try {
      const data = await apiFetch(`/api/blog-agent/${draftId}`);
      applyDraftState(data);
      return data;
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
      return null;
    }
  }, [applyDraftState]);

  const downloadJson = useCallback((filename, value) => {
    if (typeof window === 'undefined') return;
    const blob = new Blob([JSON.stringify(value || {}, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, []);

  useEffect(() => {
    const draftId = Number(draftState?.draft_id || 0);
    if (!draftId) {
      setAuditData(null);
      return;
    }
    let closed = false;
    (async () => {
      try {
        const data = await apiFetch(`/api/blog-agent/${draftId}/audit`);
        if (!closed) setAuditData(data || null);
      } catch (_) {
        if (!closed) setAuditData(null);
      }
    })();
    return () => {
      closed = true;
    };
  }, [draftState?.draft_id]);

  useEffect(() => {
    loadProjects();
  }, [loadLatestDraftForProject]);

  useEffect(() => {
    if (!form.project_id || isGeneratingFull) return;
    let closed = false;
    const shouldAttemptResume = () => {
      if (typeof window === 'undefined') return true;
      const project = String(window.localStorage.getItem(ACTIVE_RUN_PROJECT_KEY) || '');
      const startedAt = Number(window.localStorage.getItem(ACTIVE_GEN_STARTED_AT_KEY) || 0);
      if (!project || project !== String(form.project_id)) return false;
      if (!startedAt) return true;
      return Date.now() - startedAt < 1000 * 60 * 20;
    };
    const resume = async () => {
      if (!shouldAttemptResume()) return;
      const startedAtMs =
        typeof window !== 'undefined'
          ? Number(window.localStorage.getItem(ACTIVE_GEN_STARTED_AT_KEY) || 0)
          : 0;
      const storedRunId =
        typeof window !== 'undefined'
          ? Number(window.localStorage.getItem(ACTIVE_RUN_KEY) || 0)
          : 0;
      const storedTaskId =
        typeof window !== 'undefined'
          ? String(window.localStorage.getItem(ACTIVE_TASK_KEY) || '')
          : '';
      try {
        const rows = await apiFetch(`/api/pipeline-runs?project_id=${Number(form.project_id)}`);
        const allRuns = Array.isArray(rows) ? rows : [];

        const matchedById = storedRunId ? allRuns.find((item) => Number(item.id) === storedRunId) : null;
        const matchedByTime =
          startedAtMs > 0
            ? allRuns.find((item) => {
                const started = Date.parse(item?.started_at || '');
                return Number.isFinite(started) && started >= startedAtMs - 30_000;
              })
            : null;
        const targetRun =
          matchedById ||
          matchedByTime ||
          [...allRuns]
            .filter((item) => isRunOpen(item))
            .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))[0] ||
          null;

        if (closed || !targetRun?.id) {
          if (storedTaskId) {
            try {
              const taskState = await apiFetch(`/api/blog-agent/task/${encodeURIComponent(storedTaskId)}`);
              const taskStatus = String(taskState?.state || '').toUpperCase();
              if (taskStatus === 'SUCCESS') {
                const result = taskState?.result || {};
                const reusedExisting = Boolean(result?.reused_existing);
                const reusedDraftId = Number(result?.draft_id || result?.state?.draft_id || 0);
                if (reusedExisting && reusedDraftId > 0) {
                  await loadDraftState(reusedDraftId);
                  pushAlert('success', `Existing draft reused (Draft #${reusedDraftId})`);
                  clearGenerationUi();
                  return;
                }
                const rawDraftId = Number(result?.draft_id || result?.state?.draft_id || 0);
                const draftId = await resolveFreshDraftId(rawDraftId);
                if (draftId) {
                  await loadDraftState(draftId);
                  pushAlert('success', `Recovered generated draft after refresh (Draft #${draftId})`);
                  clearGenerationUi();
                  return;
                }
                setGenerationHint('Task finished. Waiting for draft indexing...');
                setProgressTarget((prev) => Math.max(prev, 92));
                return;
              }
              if (taskStatus === 'FAILURE') {
                const failMessage = String(taskState?.error || 'Generation task failed');
                setGenerationErrorMsg(failMessage);
                pushAlert('error', failMessage);
                setErrorPanel(failMessage);
                clearGenerationUi({ preserveError: true });
                return;
              }
            } catch (_) {
              // no-op
            }
          }
          const graceMs = 15 * 1000;
          if (startedAtMs && Date.now() - startedAtMs > graceMs) {
            clearGenerationUi();
          }
          return;
        }

        const targetStatus = String(targetRun.status || '').toLowerCase();
        if (targetStatus === 'completed') {
          const details = await apiFetch(`/api/pipeline-runs/${targetRun.id}`);
          if (closed) return;
          const events = Array.isArray(details?.events) ? details.events : [];
          const recoveredDraftId = extractDraftIdFromRunEvents(events);
          if (recoveredDraftId) {
            await loadDraftState(recoveredDraftId);
            pushAlert('success', `Recovered generated draft after refresh (Draft #${recoveredDraftId})`);
          }
          clearGenerationUi();
          return;
        }
        if (targetStatus === 'failed') {
          clearGenerationUi({ preserveError: true });
          pushAlert('error', targetRun.error_message || 'Generation failed');
          return;
        }

        startGenerationUi('Resuming active generation run after refresh...');
        setProgressTarget((prev) => Math.max(prev, 12));
        setActiveRunId(targetRun.id);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(ACTIVE_RUN_KEY, String(targetRun.id));
          window.localStorage.setItem(ACTIVE_RUN_PROJECT_KEY, String(form.project_id));
          if (storedTaskId) {
            window.localStorage.setItem(ACTIVE_TASK_KEY, storedTaskId);
            setActiveTaskId(storedTaskId);
          }
        }
      } catch (_) {
        setGenerationHint((prev) => prev || 'Resyncing generation state...');
      }
    };
    resume();
    const interval = setInterval(resume, 2200);
    return () => {
      closed = true;
      clearInterval(interval);
    };
  }, [form.project_id, isGeneratingFull, startGenerationUi, clearGenerationUi, loadDraftState]);

  useEffect(() => {
    if (!form.project_id) return;
    const selected = projectMap[String(form.project_id)];
    if (selected?.platform && form.platform === 'none') {
      setForm((prev) => ({ ...prev, platform: selected.platform }));
    }
  }, [form.project_id, projectMap, form.platform]);

  useEffect(() => {
    if (!form.project_id || busyAction) return;
    if (activeDraftId) return;
    loadLatestDraftForProject(form.project_id).catch(() => {
      // no-op
    });
  }, [form.project_id, busyAction, activeDraftId, loadLatestDraftForProject]);

  useEffect(() => {
    if (!isGeneratingFull || !generationStartedAt) return;
    const interval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - generationStartedAt) / 1000);
      const stage = [...GENERATION_STAGE_MESSAGES].reverse().find((item) => elapsedSec >= item.afterSec);
      if (stage?.text && !generationHint) {
        setGenerationHint(stage.text);
      }
      const timedTarget = Math.min(90, 6 + elapsedSec * 1.6);
      setProgressTarget((prev) => Math.max(prev, timedTarget));
    }, 1000);
    return () => clearInterval(interval);
  }, [isGeneratingFull, generationStartedAt, generationHint]);

  useEffect(() => {
    if (!isGeneratingFull) return;
    const interval = setInterval(() => {
      setGenerationProgress((prev) => {
        if (prev >= progressTarget) return prev;
        const gap = progressTarget - prev;
        const step = gap > 20 ? 1.9 : gap > 10 ? 1.2 : gap > 4 ? 0.8 : 0.45;
        return Math.min(progressTarget, prev + step);
      });
    }, 160);
    return () => clearInterval(interval);
  }, [isGeneratingFull, progressTarget]);

  useEffect(() => {
    if (!isGeneratingFull || !form.project_id) return;
    let closed = false;
    const tick = async () => {
      try {
        const rows = await apiFetch(`/api/pipeline-runs?project_id=${Number(form.project_id)}`);
        const allRuns = Array.isArray(rows) ? rows : [];
        const scopedRuns = runFloorId > 0 ? allRuns.filter((item) => Number(item.id || 0) > Number(runFloorId)) : allRuns;
        const runCandidate =
          (activeRunId ? allRuns.find((item) => Number(item.id) === Number(activeRunId)) : null) ||
          [...scopedRuns]
            .filter((item) => isRunOpen(item))
            .sort((a, b) => Number(b?.id || 0) - Number(a?.id || 0))[0] ||
          null;
        if (!runCandidate?.id) {
          let taskStillRunning = false;
          if (activeTaskId) {
            try {
              const taskState = await apiFetch(`/api/blog-agent/task/${encodeURIComponent(activeTaskId)}`);
              const taskStatus = String(taskState?.state || '').toUpperCase();
              if (taskStatus === 'SUCCESS') {
                const result = taskState?.result || {};
                const reusedExisting = Boolean(result?.reused_existing);
                const reusedDraftId = Number(result?.draft_id || result?.state?.draft_id || 0);
                if (reusedExisting && reusedDraftId > 0) {
                  await loadDraftState(reusedDraftId);
                  pushAlert('success', `Existing draft reused (Draft #${reusedDraftId})`);
                  endAction();
                  clearGenerationUi();
                  return;
                }
                const rawDraftId = Number(result?.draft_id || result?.state?.draft_id || 0);
                const draftId = await resolveFreshDraftId(rawDraftId);
                if (draftId) {
                  await loadDraftState(draftId);
                  pushAlert('success', `Full blog generated (Draft #${draftId})`);
                  endAction();
                  clearGenerationUi();
                  return;
                }
                setGenerationHint('Task finished. Waiting for draft indexing...');
                setProgressTarget((prev) => Math.max(prev, 92));
                return;
              }
              if (taskStatus === 'FAILURE') {
                const failMessage = String(taskState?.error || 'Generation task failed');
                setGenerationErrorMsg(failMessage);
                pushAlert('error', failMessage);
                setErrorPanel(failMessage);
                clearGenerationUi({ preserveError: true });
                return;
              }
              if (['PENDING', 'RECEIVED', 'STARTED', 'RETRY'].includes(taskStatus)) {
                taskStillRunning = true;
                const hint =
                  taskStatus === 'RETRY'
                    ? 'Worker retried this generation. Waiting for run allocation...'
                    : 'Task queued on worker. Waiting for run allocation...';
                setGenerationHint(hint);
                setProgressTarget((prev) => Math.max(prev, 16));
              }
              if (taskStatus === 'REVOKED') {
                const canceledMsg = 'Generation was canceled before run allocation.';
                setGenerationErrorMsg(canceledMsg);
                setErrorPanel(canceledMsg);
                pushAlert('error', canceledMsg);
                clearGenerationUi({ preserveError: true });
                return;
              }
            } catch (_) {
              // no-op
            }
          }
          const elapsedMs = generationStartedAt ? Date.now() - generationStartedAt : 0;
          if (taskStillRunning && elapsedMs < RUN_ALLOCATION_HARD_TIMEOUT_MS) {
            if (elapsedMs > RUN_ALLOCATION_SOFT_TIMEOUT_MS) {
              setGenerationHint('Worker is healthy; task is still queued. Waiting for run allocation...');
              setProgressTarget((prev) => Math.max(prev, 22));
            } else {
              setGenerationHint((prev) => prev || 'Waiting for worker to allocate run...');
              setProgressTarget((prev) => Math.max(prev, 12));
            }
            return;
          }
          if (elapsedMs > RUN_ALLOCATION_SOFT_TIMEOUT_MS) {
            try {
              const workerHealth = await apiFetch('/api/debug/worker');
              const healthy = Boolean(workerHealth?.ok);
              if (healthy) {
                if (elapsedMs > RUN_ALLOCATION_HARD_TIMEOUT_MS) {
                  let allocationMsg =
                    'Generation is queued too long before run allocation. Worker is healthy but queue/run mapping is delayed; retry generation.';
                  try {
                    const draftRows = await apiFetch(`/api/drafts?project_id=${Number(form.project_id)}&limit=1`);
                    const latestDraft = draftRows?.[0];
                    if (latestDraft?.id) {
                      await loadDraftState(latestDraft.id);
                    }
                  } catch (_) {
                    // no-op
                  }
                  setGenerationErrorMsg(allocationMsg);
                  pushAlert('error', allocationMsg);
                  setErrorPanel(allocationMsg);
                  clearGenerationUi({ preserveError: true });
                  return;
                }
                setGenerationHint('Worker is healthy; waiting for run allocation...');
                setProgressTarget((prev) => Math.max(prev, 20));
                return;
              }
              const reason = String(workerHealth?.reason || 'unknown');
              const suggestion = String(workerHealth?.suggestion || '').trim();
              const workerMsg = suggestion
                ? `Queue worker issue (${reason}). ${suggestion}`
                : `Queue worker issue (${reason}). Check local_run_worker.ps1 and retry.`;
              setGenerationErrorMsg(workerMsg);
              pushAlert('error', workerMsg);
              setErrorPanel(workerMsg);
              clearGenerationUi({ preserveError: true });
              return;
            } catch (_) {
              const workerMsg =
                'Queue worker is not consuming tasks. Check `local_run_worker.ps1`, then retry generation.';
              setGenerationErrorMsg(workerMsg);
              pushAlert('error', workerMsg);
              setErrorPanel(workerMsg);
              clearGenerationUi({ preserveError: true });
              return;
            }
          }
          setGenerationHint((prev) => prev || 'Waiting for worker to allocate run...');
          setProgressTarget((prev) => Math.max(prev, 12));
          return;
        }
        if (!activeRunId) setActiveRunId(runCandidate.id);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(ACTIVE_RUN_KEY, String(runCandidate.id));
          window.localStorage.setItem(ACTIVE_RUN_PROJECT_KEY, String(form.project_id));
        }

        const details = await apiFetch(`/api/pipeline-runs/${runCandidate.id}`);
        if (closed) return;
        const run = details?.run || runCandidate;
        const events = Array.isArray(details?.events) ? details.events : [];
        setLiveRunState({ run, events });
        lastRunTouchRef.current = Date.now();

        const stage = String(run?.stage || '').toLowerCase();
        const status = String(run?.status || '').toLowerCase();
        const mapped = STAGE_PROGRESS_MAP[stage];
        if (typeof mapped === 'number') {
          setProgressTarget((prev) => Math.max(prev, Math.min(98, mapped)));
        }
        const latestEvt = events.length ? events[events.length - 1] : null;
        if (latestEvt?.message) setGenerationHint(latestEvt.message);
        const providerAuthMessage =
          extractProviderAuthMessage(run?.error_message) || extractProviderAuthMessage(latestEvt?.message);
        if (providerAuthMessage) {
          setGenerationErrorMsg(providerAuthMessage);
          setErrorPanel(providerAuthMessage);
          pushAlert('error', providerAuthMessage);
          clearGenerationUi({ preserveError: true });
          return;
        }
        const providerLimitMessage =
          extractProviderLimitMessage(latestEvt?.message) ||
          extractProviderLimitMessage(run?.error_message) ||
          extractProviderLimitMessage(JSON.stringify(latestEvt?.meta_json || {}));
        if (providerLimitMessage) {
          setGenerationErrorMsg(providerLimitMessage);
          setErrorPanel(providerLimitMessage);
          pushAlert('error', providerLimitMessage);
          clearGenerationUi({ preserveError: true });
          return;
        }

        if (status === 'completed') {
          setProgressTarget(100);
          const savedDraftId = extractDraftIdFromRunEvents(events);
          if (savedDraftId) {
            await loadDraftState(savedDraftId);
            pushAlert('success', `Full blog generated (Draft #${savedDraftId})`);
            if (typeof window !== 'undefined') {
              setTimeout(() => {
                document.getElementById('live-blog-preview')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }, 120);
            }
          } else {
            const recoveredDraftId = await resolveFreshDraftId(0);
            if (recoveredDraftId) {
              await loadDraftState(recoveredDraftId);
              pushAlert('success', `Full blog generated (Draft #${recoveredDraftId})`);
            } else {
              pushAlert('error', 'Run completed but fresh draft id not found yet. Retry refresh once.');
            }
          }
          endAction();
          clearGenerationUi();
          return;
        }
        if (status === 'failed') {
          setProgressTarget(100);
          const failMessage = run?.error_message || latestEvt?.message || 'Generation failed';
          setGenerationErrorMsg(failMessage);
          pushAlert('error', failMessage);
          setErrorPanel(failMessage);
          clearGenerationUi({ preserveError: true });
        }
      } catch (_) {
        setGenerationHint((prev) => prev || 'Network delay detected. Retrying progress sync...');
      }
    };
    tick();
    const interval = setInterval(tick, 1800);
    return () => {
      closed = true;
      clearInterval(interval);
    };
  }, [isGeneratingFull, form.project_id, activeRunId, activeTaskId, runFloorId, generationStartedAt, loadDraftState, clearGenerationUi, resolveFreshDraftId]);

  useEffect(() => {
    if (!isGeneratingFull) return;
    const interval = setInterval(() => {
      const sinceTouch = Date.now() - (lastRunTouchRef.current || 0);
      if (sinceTouch > 15000) {
        setGenerationHint('Still processing in background... syncing latest stage.');
        setProgressTarget((prev) => Math.min(96, Math.max(prev, 70)));
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [isGeneratingFull]);

  const validateGenerate = () => {
    if (!form.project_id) return 'Select a project first.';
    if (isTopicAssistMode && !String(form.topic || '').trim()) {
      return 'Topic mode selected: please enter a topic.';
    }
    const secondary = parseSecondaryKeywords(form.secondary_keywords_text);
    const hasPrimary = String(form.primary_keyword || '').trim().length > 0;
    const hasTopic = String(form.topic || '').trim().length > 0;
    if (!hasPrimary && secondary.length === 0 && !hasTopic) {
      return 'Provide at least one keyword (primary or secondary).';
    }
    if (form.publish_status === 'schedule' && !form.schedule_datetime) {
      return 'Schedule datetime is required for schedule mode.';
    }
    return '';
  };

  const onGenerateOutline = async () => {
    const issue = validateGenerate();
    if (issue) {
      pushAlert('error', issue);
      setErrorPanel(issue);
      return;
    }
    try {
      const precheck = await apiFetch('/api/settings/test/openai', { method: 'POST' });
      if (!precheck?.ok) {
        const msg = precheck?.error || 'OpenAI test failed. Fix API key/model in Settings first.';
        pushAlert('error', msg);
        setErrorPanel(msg);
        return;
      }
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
      return;
    }
    if (!beginAction('Generating outline...')) return;
    try {
      setErrorPanel('');
      setGenerationHint('');
      const result = await apiFetch('/api/blog-agent/outline', {
        method: 'POST',
        body: JSON.stringify(buildGeneratePayload()),
      });
      if (result?.draft_id) {
        await loadDraftState(result.draft_id);
      }
      if (result?.reused_existing) {
        pushAlert('success', `Existing recent draft reused (Draft #${result?.draft_id || 'n/a'})`);
      } else {
        pushAlert('success', `Outline generated (Draft #${result?.draft_id || 'n/a'})`);
      }
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
    } finally {
      endAction();
    }
  };

  const onGenerateFull = async () => {
    const issue = validateGenerate();
    if (issue) {
      pushAlert('error', issue);
      setErrorPanel(issue);
      return;
    }
    try {
      const precheck = await apiFetch('/api/settings/test/openai', { method: 'POST' });
      if (!precheck?.ok) {
        const msg = precheck?.error || 'OpenAI test failed. Fix API key/model in Settings first.';
        pushAlert('error', msg);
        setErrorPanel(msg);
        return;
      }
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
      return;
    }
    if (!beginAction('Generating full blog...')) return;
    try {
      setErrorPanel('');
      setGenerationErrorMsg('');
      setGenerationStartedAt(Date.now());
      setGenerationHint(GENERATION_STAGE_MESSAGES[0].text);
      setGenerationProgress(4);
      setProgressTarget(8);
      setLiveRunState(null);
      setActiveRunId(null);
      setActiveTaskId(null);
      setRunFloorId(0);
      setDraftFloorId(0);
      lastRunTouchRef.current = Date.now();
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(ACTIVE_RUN_KEY);
        window.localStorage.removeItem(ACTIVE_TASK_KEY);
        window.localStorage.setItem(ACTIVE_RUN_PROJECT_KEY, String(form.project_id));
        window.localStorage.setItem(ACTIVE_GEN_STARTED_AT_KEY, String(Date.now()));
      }
      try {
        const existingRuns = await apiFetch(`/api/pipeline-runs?project_id=${Number(form.project_id)}`);
        const maxId = (Array.isArray(existingRuns) ? existingRuns : []).reduce(
          (acc, item) => Math.max(acc, Number(item?.id || 0)),
          0
        );
        setRunFloorId(maxId);
      } catch (_) {
        setRunFloorId(0);
      }
      try {
        const existingDrafts = await apiFetch(`/api/drafts?project_id=${Number(form.project_id)}&limit=10`);
        const maxDraftId = (Array.isArray(existingDrafts) ? existingDrafts : []).reduce(
          (acc, item) => Math.max(acc, Number(item?.id || 0)),
          0
        );
        setDraftFloorId(maxDraftId);
      } catch (_) {
        setDraftFloorId(0);
      }
      const queued = await apiFetch('/api/blog-agent/generate?async_job=true', {
        method: 'POST',
        body: JSON.stringify({ ...buildGeneratePayload(), force_new: true }),
      });
      const queuedTaskId = String(queued?.task_id || '').trim();
      if (queuedTaskId) {
        setActiveTaskId(queuedTaskId);
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(ACTIVE_TASK_KEY, queuedTaskId);
        }
      }
      pushAlert('success', 'Generation queued. Live research/progress updating below.');
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
      setGenerationErrorMsg(text);
      clearGenerationUi({ preserveError: true });
    } finally {
      // Generation unlock happens after pipeline completion/failure in polling effect.
    }
  };

  const onRegenerate = async () => {
    if (!beginAction('Regenerating draft...')) return;
    const draftId = activeDraftId || draftState?.draft_id;
    if (!draftId) {
      const message = 'Generate or load a draft first.';
      pushAlert('error', message);
      setErrorPanel(message);
      endAction();
      return;
    }
    try {
      setErrorPanel('');
      setGenerationStartedAt(Date.now());
      setGenerationHint('Regenerating with a new structure...');
      setGenerationProgress(8);
      const result = await apiFetch(`/api/blog-agent/${draftId}/regenerate`, {
        method: 'POST',
        body: JSON.stringify({
          force_different_structure: true,
          tone: form.tone,
          image_mode: form.image_mode,
          inline_images_count: Number(form.inline_images_count || 0),
          outline_override: safeParseOutline(),
        }),
      });
      const newDraftId = result?.draft_id || result?.state?.draft_id;
      if (result?.state?.draft_id) {
        applyDraftState(result.state);
      } else if (newDraftId) {
        await loadDraftState(newDraftId);
      }
      pushAlert('success', `Regenerated with new structure (Draft #${newDraftId || 'n/a'})`);
      setGenerationProgress(100);
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
    } finally {
      endAction();
      setGenerationStartedAt(null);
      setGenerationHint('');
      setTimeout(() => setGenerationProgress(0), 800);
    }
  };

  const onGenerateImagesOnly = async () => {
    if (!beginAction('Generating images...')) return;
    const draftId = activeDraftId || draftState?.draft_id;
    if (!draftId) {
      const message = 'Draft required for image generation.';
      pushAlert('error', message);
      setErrorPanel(message);
      endAction();
      return;
    }
    try {
      setErrorPanel('');
      await apiFetch(`/api/blog-agent/${draftId}/images`, {
        method: 'POST',
        body: JSON.stringify({
          image_mode: form.image_mode,
          inline_images_count: Math.max(0, Math.min(3, Number(form.inline_images_count || 0))),
        }),
      });
      await loadDraftState(draftId);
      pushAlert('success', 'Images generated and attached to draft.');
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
    } finally {
      endAction();
    }
  };

  const onPublish = async () => {
    if (!beginAction('Publishing draft...')) return;
    const draftId = activeDraftId || draftState?.draft_id;
    if (!draftId) {
      const message = 'Draft required before publish.';
      pushAlert('error', message);
      setErrorPanel(message);
      endAction();
      return;
    }
    const mode = form.publish_status === 'schedule' ? 'scheduled' : form.publish_status;
    if (mode === 'scheduled' && !form.schedule_datetime) {
      const message = 'Select schedule datetime first.';
      pushAlert('error', message);
      setErrorPanel(message);
      endAction();
      return;
    }
    try {
      setErrorPanel('');
      const autoTags = Array.from(
        new Set([form.primary_keyword, ...parseSecondaryKeywords(form.secondary_keywords_text)].map((v) => String(v || '').trim()).filter(Boolean))
      );
      await apiFetch(`/api/blog-agent/${draftId}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          mode,
          platform: form.platform,
          scheduled_at: mode === 'scheduled' ? new Date(form.schedule_datetime).toISOString() : null,
          tags: autoTags,
          categories: [],
          blog_id: null,
        }),
      });
      await loadDraftState(draftId);
      pushAlert('success', `Publish request sent in mode: ${mode}`);
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
    } finally {
      endAction();
    }
  };

  const onSaveOutline = async () => {
    const draftId = activeDraftId || draftState?.draft_id;
    if (!draftId) {
      const message = 'Draft required before saving outline.';
      pushAlert('error', message);
      setErrorPanel(message);
      return;
    }
    const parsed = safeParseOutline();
    if (!parsed) {
      const message = 'Outline must be a valid JSON array.';
      pushAlert('error', message);
      setErrorPanel(message);
      return;
    }
    try {
      await apiFetch(`/api/drafts/${draftId}`, {
        method: 'PUT',
        body: JSON.stringify({ outline_json: parsed }),
      });
      await loadDraftState(draftId);
      pushAlert('success', 'Outline updated in draft.');
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
    }
  };

  const onStopGeneration = async () => {
    if (cancelingGeneration || !busyAction) return;
    setCancelingGeneration(true);
    try {
      let targetRunId = Number(activeRunId || liveRunState?.run?.id || 0);
      if (!targetRunId && form.project_id) {
        const rows = await apiFetch(`/api/pipeline-runs?project_id=${Number(form.project_id)}`);
        const active = (Array.isArray(rows) ? rows : []).find((item) =>
          ['queued', 'running'].includes(String(item?.status || '').toLowerCase())
        );
        targetRunId = Number(active?.id || 0);
      }

      if (targetRunId > 0) {
        await apiFetch(`/api/pipeline-runs/${targetRunId}/cancel`, { method: 'POST' });
      }

      const stoppedMessage = 'Generation stopped by user.';
      setGenerationErrorMsg(stoppedMessage);
      setErrorPanel(stoppedMessage);
      pushAlert('success', 'Generation stopped.');
      clearGenerationUi({ preserveError: true });
    } catch (err) {
      const text = parseApiError(err);
      pushAlert('error', text);
      setErrorPanel(text);
      setGenerationErrorMsg(text);
    } finally {
      setCancelingGeneration(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && busyAction && !cancelingGeneration) {
        event.preventDefault();
        onStopGeneration();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', onKeyDown);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('keydown', onKeyDown);
      }
    };
  }, [busyAction, cancelingGeneration, onStopGeneration]);

  return (
    <AuthGate>
      <main>
        <Header title="Blog Agent" subtitle="Generate unique, research-backed blogs with SEO, images, and one-click publishing controls." />

        <section className="alerts-zone" style={busyAction ? { marginTop: 78 } : undefined}>
          {busyAction || generationErrorMsg ? (
            <div className={`msg sticky-generate-loader ${generationErrorMsg ? 'error' : ''}`}>
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                  <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                    {generationErrorMsg
                      ? generationErrorMsg
                      : `${busyAction} Please wait. Press Stop (or Esc) to cancel.${
                          isGeneratingFull && ['image', 'save-draft'].includes(currentPipelineStage)
                            ? ' Image generation is in progress...'
                            : ''
                        }${liveHeadlineText ? ` ${liveHeadlineText}` : (generationHint ? ` ${generationHint}` : '')}`}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                    {isGeneratingFull ? <strong>{Math.min(100, Math.max(0, Math.round(generationProgress)))}%</strong> : null}
                    {busyAction ? (
                      <button className="danger" onClick={onStopGeneration} disabled={cancelingGeneration}>
                        {cancelingGeneration ? 'Stopping...' : 'Stop'}
                      </button>
                    ) : null}
                    {generationErrorMsg && !busyAction ? (
                      <button className="secondary" onClick={() => setGenerationErrorMsg('')}>
                        Dismiss
                      </button>
                    ) : null}
                  </div>
                </div>
                {(isGeneratingFull || isGeneratingImages) && !generationErrorMsg ? (
                  <div className="progress-shell">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${Math.min(100, Math.max(0, isGeneratingImages ? 85 : generationProgress))}%`,
                      }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {alerts.map((item) => (
            <div key={item.id} className={statusClass(item.type)}>
              <span>{item.text}</span>
              <button className="secondary" onClick={() => removeAlert(item.id)}>Dismiss</button>
            </div>
          ))}
        </section>

        {isGeneratingFull ? (
          <section className="card live-console-card" style={{ marginBottom: 12 }}>
            <div className="projects-toolbar" style={{ marginBottom: 8 }}>
              <div>
                <h3>Live Generation Console</h3>
                <p>Realtime execution trace: research, fetches, links, and draft stages.</p>
              </div>
              <span className="pill">{liveStageLabel}</span>
            </div>
            <div className="live-console-metrics">
              <div className="live-metric">
                <span>Stage</span>
                <strong>{liveStageLabel}</strong>
              </div>
              <div className="live-metric">
                <span>Events</span>
                <strong>{liveProgressNotes.length}</strong>
              </div>
              <div className="live-metric">
                <span>Sources</span>
                <strong>{liveResearchLinks.length}</strong>
              </div>
              <div className="live-metric">
                <span>Last Update</span>
                <strong>{lastLiveEventAt ? `${formatIstTime(lastLiveEventAt)} IST` : 'Waiting...'}</strong>
              </div>
            </div>
            <div className="live-console-grid">
              <div className="live-console-panel">
                <h4 className="live-console-subtitle">Execution Timeline</h4>
                <ul className="live-console-list">
                  {liveProgressNotes.length ? (
                    liveProgressNotes.map((note) => (
                      <li key={note.id}>
                        <span>{note.text}</span>
                        {note.time ? <small>{formatIstTime(note.time)} IST</small> : null}
                      </li>
                    ))
                  ) : (
                    <li><span>Initializing run and fetching first signals...</span></li>
                  )}
                </ul>
              </div>
              <div className="live-console-panel">
                <h4 className="live-console-subtitle">Competitive Sources Stream</h4>
                <div className="live-links-wrap">
                  {liveResearchLinks.length ? (
                    liveResearchLinks.map((url) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer" title={url}>
                        <strong className="live-link-host">{normalizeHostFromUrl(url) || 'source'}</strong>
                        <span>{shortenUrlForDisplay(url)}</span>
                      </a>
                    ))
                  ) : (
                    <span className="live-console-empty">No external competitor links discovered yet...</span>
                  )}
                </div>
                {(researchEventDetails.ai_observations || []).length ? (
                  <>
                    <h4 className="live-console-subtitle" style={{ marginTop: 12 }}>AI Research Notes</h4>
                    <ul className="live-console-list">
                      {researchEventDetails.ai_observations.slice(0, 6).map((note, idx) => (
                        <li key={`ai-note-${idx}`}><span>{note}</span></li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </div>
          </section>
        ) : null}

        {errorPanel ? (
          <section className="card" style={{ marginBottom: 12 }}>
            <h3>Error Panel</h3>
            <pre className="codebox">{errorPanel}</pre>
          </section>
        ) : null}

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>Agent Inputs</h3>
          <div className="form-row">
            <label>
              Project
              <select value={form.project_id} onChange={(e) => onProjectChange(e.target.value)}>
                <option value="">Select project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} (#{project.id})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Platform
              <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                <option value="none">none</option>
                <option value="wordpress">wordpress</option>
                <option value="shopify">shopify</option>
              </select>
            </label>
            <label>
              Tone
              <select value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value })}>
                <option value="auto">auto (recommended)</option>
                <option value="professional">professional</option>
                <option value="friendly">friendly</option>
                <option value="authoritative">authoritative</option>
                <option value="conversational">conversational</option>
              </select>
            </label>
            <label>
              Country
              <input value={form.country} onChange={(e) => setForm({ ...form, country: e.target.value })} />
            </label>
            <label>
              Language
              <input value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} />
            </label>
            <label>
              Desired Words
              <input
                type="number"
                min={300}
                value={form.desired_word_count}
                onChange={(e) => setForm({ ...form, desired_word_count: Number(e.target.value || 1200) })}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              Input Mode
              <select value={form.topic_mode} onChange={(e) => setForm({ ...form, topic_mode: e.target.value })}>
                <option value="keyword">Keyword-driven (recommended)</option>
                <option value="topic">Topic + keyword assist</option>
              </select>
            </label>
            <label>
              Topic / Title {isTopicAssistMode ? '(required)' : '(optional)'}
              <input
                placeholder="e.g. Complete smile makeover process for working professionals"
                value={form.topic}
                onChange={(e) => setForm({ ...form, topic: e.target.value })}
              />
            </label>
          </div>

          <div className="form-row">
            <label>
              Primary Keyword
              <input
                placeholder="e.g. dental services in india"
                value={form.primary_keyword}
                onChange={(e) => setForm({ ...form, primary_keyword: e.target.value })}
              />
            </label>
            <label>
              Secondary Keywords (comma separated)
              <input
                placeholder="keyword 1, keyword 2, keyword 3"
                value={form.secondary_keywords_text}
                onChange={(e) => setForm({ ...form, secondary_keywords_text: e.target.value })}
              />
            </label>
          </div>

          <p style={{ marginTop: 0, color: '#5c7dad' }}>
            In keyword mode, title/topic, outline, meta fields, focus keyphrase, internal links, and tags are auto-generated.
            In topic mode, your topic is respected and keywords refine depth + SEO mapping.
            Tone in auto mode is inferred from keyword intent + project context. Competitor research is AI-driven.
          </p>
          <p style={{ marginTop: 0, color: '#5c7dad' }}>
            Note: Generate Outline is preview-only and does not create a new draft.
          </p>

          <div className="blog-agent-taglist" style={{ marginBottom: 10 }}>
            {parseSecondaryKeywords(form.secondary_keywords_text).map((tag) => (
              <span key={tag} className="pill">{tag}</span>
            ))}
          </div>

          <div className="form-row">
            <label>
              Image Mode
              <select value={form.image_mode} onChange={(e) => setForm({ ...form, image_mode: e.target.value })}>
                <option value="featured_only">featured_only</option>
                <option value="featured+inline">featured+inline</option>
                <option value="prompts_only">prompts_only</option>
              </select>
            </label>
            <label>
              Inline Images Count
              <input
                type="number"
                min={0}
                max={3}
                value={form.inline_images_count}
                onChange={(e) =>
                  setForm({
                    ...form,
                    inline_images_count: Math.max(0, Math.min(3, Number(e.target.value || 0))),
                  })
                }
              />
            </label>
            <label>
              Publish Status
              <select value={form.publish_status} onChange={(e) => setForm({ ...form, publish_status: e.target.value })}>
                <option value="draft">draft</option>
                <option value="publish_now">publish_now</option>
                <option value="schedule">schedule</option>
              </select>
            </label>
            <label>
              Autopublish
              <select value={form.autopublish ? 'true' : 'false'} onChange={(e) => setForm({ ...form, autopublish: e.target.value === 'true' })}>
                <option value="false">off</option>
                <option value="true">on</option>
              </select>
            </label>
            {form.publish_status === 'schedule' ? (
              <label>
                Schedule Datetime
                <input
                  type="datetime-local"
                  value={form.schedule_datetime}
                  onChange={(e) => setForm({ ...form, schedule_datetime: e.target.value })}
                />
              </label>
            ) : null}
          </div>

          <div className="stack">
            <button disabled={Boolean(busyAction) || actionLocked} onClick={onGenerateOutline}>Generate Outline</button>
            <button disabled={Boolean(busyAction) || actionLocked} onClick={onGenerateFull}>Generate Full Blog</button>
            <button disabled={Boolean(busyAction) || actionLocked || !activeDraftId} className="secondary" onClick={onRegenerate}>Regenerate with Different Structure</button>
            <button disabled={Boolean(busyAction) || actionLocked || !activeDraftId} className="secondary" onClick={onGenerateImagesOnly}>Generate Images Only</button>
            <button disabled={Boolean(busyAction) || actionLocked || !activeDraftId} onClick={onPublish}>Publish</button>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <h3>Research Activity (Live)</h3>
          <p className="section-note">
            Yaha live AI research, competitor URLs, internal URLs, aur library/sitemap processing ka status dikhega.
          </p>
          {draftState || liveRunState ? (
            <>
              <div className="stats-grid" style={{ marginBottom: 12 }}>
                <article className="stat-card">
                  <p>Pipeline Stage</p>
                  <h3>{draftState?.pipeline_stage || liveRunState?.run?.stage || 'n/a'}</h3>
                  <span>Current progress stage</span>
                </article>
                <article className="stat-card">
                  <p>Competitor Sources</p>
                  <h3>{Number(draftState?.research_summary?.source_count || 0)}</h3>
                  <span>Fetched competitor/context URLs</span>
                </article>
                <article className="stat-card">
                  <p>Link Candidates</p>
                  <h3>{Number(draftState?.research_summary?.internal_candidate_count || 0)}</h3>
                  <span>Possible internal links</span>
                </article>
                <article className="stat-card">
                  <p>Sitemap URLs</p>
                  <h3>{Number(draftState?.research_summary?.sitemap_urls_count || 0)}</h3>
                  <span>Extra website URLs discovered</span>
                </article>
              </div>

              <div className="table-wrap" style={{ marginBottom: 10 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Competitor Domains</th>
                      <th>Top Competitor URLs</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        {(draftState?.research_summary?.competitor_domains || draftState?.research_summary?.source_domains || []).length
                          ? (draftState?.research_summary?.competitor_domains || draftState?.research_summary?.source_domains || []).join(', ')
                          : 'No competitor domains captured'}
                      </td>
                      <td>
                        {(draftState?.research_summary?.top_competitor_urls || []).length
                          ? (draftState?.research_summary?.top_competitor_urls || []).join(' | ')
                          : 'No competitor URLs captured'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <details className="accordion" open>
                <summary>Research Details (AI Competitor + Internal Linking)</summary>
                <div className="accordion-body">
                  <div className="stats-grid" style={{ marginBottom: 12 }}>
                    <article className="stat-card">
                      <p>Web Research Results</p>
                      <h3>{researchEventDetails.web_result_count}</h3>
                      <span>{researchEventDetails.web_query || 'No keyword logged (AI mode)'}</span>
                    </article>
                    <article className="stat-card">
                      <p>Competitor Fetch</p>
                      <h3>{researchEventDetails.competitor_success}</h3>
                      <span>{researchEventDetails.competitor_requested} requested</span>
                    </article>
                    <article className="stat-card">
                      <p>Library Total</p>
                      <h3>{researchEventDetails.augmented_total || researchEventDetails.library_count}</h3>
                      <span>Library + sitemap context</span>
                    </article>
                    <article className="stat-card">
                      <p>Internal Plan</p>
                      <h3>{researchEventDetails.internal_plan_count}</h3>
                      <span>{researchEventDetails.internal_candidate_count} candidates</span>
                    </article>
                  </div>

                  <div className="table-wrap" style={{ marginBottom: 10 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Discovered Competitor URLs</th>
                          <th>Planned Internal Link URLs</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>
                            {researchEventDetails.top_urls.length ? (
                              researchEventDetails.top_urls.map((url) => (
                                <div key={`competitor-${url}`} style={{ marginBottom: 4 }}>
                                  <a href={url} target="_blank" rel="noreferrer">{url}</a>
                                </div>
                              ))
                            ) : (
                              'No competitor URLs captured for this run'
                            )}
                          </td>
                          <td>
                            {researchEventDetails.planned_urls.length ? (
                              researchEventDetails.planned_urls.map((url) => (
                                <div key={`internal-${url}`} style={{ marginBottom: 4 }}>
                                  <a href={url} target="_blank" rel="noreferrer">{url}</a>
                                </div>
                              ))
                            ) : (
                              'No internal plan URLs logged'
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {(researchEventDetails.ai_observations.length || researchEventDetails.ai_subtopics.length) ? (
                    <div className="form-row">
                      <label>
                        AI Research Observations
                        <textarea
                          rows={6}
                          readOnly
                          value={
                            researchEventDetails.ai_observations.length
                              ? researchEventDetails.ai_observations.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
                              : 'No observations captured yet.'
                          }
                        />
                      </label>
                      <label>
                        AI Subtopics Extracted
                        <textarea
                          rows={6}
                          readOnly
                          value={
                            researchEventDetails.ai_subtopics.length
                              ? researchEventDetails.ai_subtopics.map((item, idx) => `${idx + 1}. ${item}`).join('\n')
                              : 'No subtopics captured yet.'
                          }
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              </details>

              {livePipelineEvents.length ? (
                <details className="accordion" open>
                  <summary>Live Event Stream ({livePipelineEvents.length})</summary>
                  <div className="accordion-body table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Level</th>
                          <th>Message</th>
                          <th>Meta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {livePipelineEvents.slice(-12).reverse().map((evt) => (
                          <tr key={`live-${evt.id}`}>
                            <td>{evt.created_at ? `${formatIstTime(evt.created_at)} IST` : '-'}</td>
                            <td>{evt.level}</td>
                            <td>{evt.message}</td>
                            <td>
                              <pre className="codebox" style={{ margin: 0 }}>
                                {JSON.stringify(evt.meta_json || {}, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ) : null}
            </>
          ) : (
            <p>No research yet. Enter keywords and click Generate Full Blog.</p>
          )}
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <div className="projects-toolbar">
            <div>
              <h3>Competitor Intelligence</h3>
              <p>Crawl discovery sources, extracted evidence, content brief, and measurable QA scores.</p>
            </div>
            {auditData ? (
              <div className="stack">
                <button className="secondary" onClick={() => downloadJson('crawl_candidates.json', auditData.crawl_candidates_json || {})}>Download crawl_candidates.json</button>
                <button className="secondary" onClick={() => downloadJson('extracts.json', auditData.extracts_json || [])}>Download extracts.json</button>
                <button className="secondary" onClick={() => downloadJson('brief.json', auditData.brief_json || {})}>Download brief.json</button>
                <button className="secondary" onClick={() => downloadJson('qa.json', auditData.qa_json || {})}>Download qa.json</button>
              </div>
            ) : null}
          </div>

          <div className="stack" style={{ marginBottom: 10 }}>
            <button className={researchTab === 'crawl' ? '' : 'secondary'} onClick={() => setResearchTab('crawl')}>Crawl Discovery</button>
            <button className={researchTab === 'evidence' ? '' : 'secondary'} onClick={() => setResearchTab('evidence')}>What We Extracted</button>
            <button className={researchTab === 'brief' ? '' : 'secondary'} onClick={() => setResearchTab('brief')}>Content Brief</button>
            <button className={researchTab === 'qa' ? '' : 'secondary'} onClick={() => setResearchTab('qa')}>QA Scores</button>
          </div>

          {researchTab === 'crawl' ? (
            <div className="table-wrap">
              <div style={{ marginBottom: 10 }}>
                <button className="secondary" onClick={() => setShowProductCrawlRows((v) => !v)}>
                  {showProductCrawlRows ? 'Hide Product Pages' : 'Show Product Pages'}
                </button>
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>URL</th>
                    <th>Domain</th>
                    <th>Type</th>
                    <th>Strength</th>
                    <th>Freshness</th>
                    <th>Inlinks</th>
                    <th>Fetch</th>
                  </tr>
                </thead>
                <tbody>
                  {(visibleCrawlSources || []).length ? (
                    visibleCrawlSources.map((row, idx) => (
                      <tr key={`crawl-${row.url || idx}`}>
                        <td><a href={row.url} target="_blank" rel="noreferrer">{row.url}</a></td>
                        <td>{row.domain || '-'}</td>
                        <td>{row.page_type || '-'}</td>
                        <td>{Number(row.competitive_strength_score || 0).toFixed(2)}</td>
                        <td>{Number(row.freshness_score || 0).toFixed(2)}</td>
                        <td>{row.inlink_count ?? '-'}</td>
                        <td>{row.fetch_status || 'pending'}</td>
                      </tr>
                    ))
                  ) : (
                    <tr><td colSpan={7}>No crawl discovery rows captured yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ) : null}

          {researchTab === 'evidence' ? (
            <div>
              {(evidencePanel || []).length ? (
                evidencePanel.map((row, idx) => (
                  <details key={`ev-${row.url || idx}`} className="accordion" open={idx === 0}>
                    <summary>{row.title || row.url}</summary>
                    <div className="accordion-body">
                      <p><a href={row.url} target="_blank" rel="noreferrer">{row.url}</a></p>
                      <pre className="codebox">{JSON.stringify({
                        headings: row.headings || {},
                        entities: row.entities || [],
                        faqs: row.faqs || [],
                        content_length_estimate: row.content_length_estimate || 0,
                        media_count: row.media_count || 0,
                        table_count: row.table_count || 0,
                        trust_signals: row.trust_signals || {},
                      }, null, 2)}</pre>
                    </div>
                  </details>
                ))
              ) : (
                <p>No extracted evidence yet.</p>
              )}
            </div>
          ) : null}

          {researchTab === 'brief' ? (
            <pre className="codebox">{JSON.stringify(draftState?.content_brief || {}, null, 2)}</pre>
          ) : null}

          {researchTab === 'qa' ? (
            <pre className="codebox">{JSON.stringify(draftState?.qa_scores || {}, null, 2)}</pre>
          ) : null}
        </section>

        <section className="card" style={{ marginBottom: 12 }}>
          <div className="projects-toolbar">
            <div>
              <h3>Generated Outline</h3>
              <p>Live outline built from keyword + AI competitor/internal research context.</p>
            </div>
            <div className="stack">
              <button className="secondary" onClick={() => setShowOutlineEditor((v) => !v)}>
                {showOutlineEditor ? 'Hide Outline JSON' : 'Edit Outline JSON'}
              </button>
              <button className="secondary" onClick={onSaveOutline}>Save Outline</button>
            </div>
          </div>
          <details className="accordion" open>
            <summary>Outline Preview</summary>
            <div className="accordion-body">
              {outlinePreviewItems.length ? (
                <ol>
                  {outlinePreviewItems.map((item, idx) => (
                    <li key={`${idx}-${item}`} style={{ marginBottom: 6 }}>{item}</li>
                  ))}
                </ol>
              ) : (
                <p>No outline yet. Click Generate Full Blog to build from live AI research.</p>
              )}
              {showOutlineEditor ? (
                <textarea rows={10} value={outlineEditor} onChange={(e) => setOutlineEditor(e.target.value)} />
              ) : null}
            </div>
          </details>
        </section>

        {draftState ? (
          <>
            <section className="card" style={{ marginBottom: 12 }}>
              <h3>SEO + Quality</h3>
              <div className="stats-grid" style={{ marginBottom: 12 }}>
                <article className="stat-card">
                  <p>Similarity Score</p>
                  <h3>{Number(draftState.similarity_score || 0).toFixed(3)}</h3>
                  <span>Lower is safer</span>
                </article>
                <article className="stat-card">
                  <p>Structure Type</p>
                  <h3>{draftState.structure_type || 'n/a'}</h3>
                  <span>Current pattern family</span>
                </article>
                <article className="stat-card">
                  <p>Draft Status</p>
                  <h3>{draftState.status}</h3>
                  <span>Workflow state</span>
                </article>
                <article className="stat-card">
                  <p>Platform</p>
                  <h3>{draftState.platform || 'none'}</h3>
                  <span>Publish target</span>
                </article>
                <article className="stat-card">
                  <p>Word Count</p>
                  <h3>{Number(draftState.word_count || 0)}</h3>
                  <span>Generated body length</span>
                </article>
              </div>

              <div className="form-row">
                <label>
                  Meta Title
                  <input value={draftState.meta_title || ''} readOnly />
                </label>
                <label>
                  Meta Description
                  <input value={draftState.meta_description || ''} readOnly />
                </label>
                <label>
                  Slug
                  <input value={draftState.slug || ''} readOnly />
                </label>
              </div>
            </section>

            <section className="card" style={{ marginBottom: 12 }}>
              <h3>Featured + Inline Images</h3>
              {isImageStageActive ? (
                <div className="msg" style={{ marginBottom: 10 }}>
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <span>
                        {isGeneratingImages ? 'Generating featured + inline images...' : 'Image stage running in full generation...'}
                      </span>
                      <strong>{isGeneratingImages ? '85%' : `${Math.max(86, Math.min(98, Math.round(generationProgress)))}%`}</strong>
                    </div>
                    <div className="progress-shell" style={{ boxShadow: 'inset 0 0 0 1px rgba(72, 142, 240, 0.22)' }}>
                      <div
                        className="progress-fill"
                        style={{ width: isGeneratingImages ? '85%' : `${Math.max(86, Math.min(98, Math.round(generationProgress)))}%` }}
                      />
                    </div>
                  </div>
                </div>
              ) : null}
              <p className="section-note">
                If visuals look placeholder-like, go to Settings and verify OpenAI key + image model (`gpt-image-1`), then click Generate Images Only.
              </p>
              {draftState.image_path ? (
                <div className="blog-agent-image-wrap">
                  <figure>
                    <figcaption>Featured</figcaption>
                    <img
                      src={resolveImageSrc(draftState.image_path, `featured-${draftState.draft_id}`)}
                      alt={draftState.alt_text || 'featured'}
                      loading="lazy"
                      decoding="async"
                      onError={() => setMediaFallback((prev) => ({ ...prev, [`featured-${draftState.draft_id}`]: true }))}
                    />
                  </figure>
                </div>
              ) : (
                <p>
                  No featured image generated yet. Current prompt: {draftState.image_prompt || 'n/a'}.
                  Check Settings {'>'} OpenAI key and click Generate Images Only.
                </p>
              )}

              <div className="blog-agent-inline-grid">
                {(draftState.images || [])
                  .filter((image) => image.kind === 'inline')
                  .map((image) => (
                    <figure key={image.id}>
                      <img
                        src={resolveImageSrc(image.image_path, `inline-${image.id}`)}
                        alt={image.alt_text || `inline-${image.id}`}
                        loading="lazy"
                        decoding="async"
                        onError={() => setMediaFallback((prev) => ({ ...prev, [`inline-${image.id}`]: true }))}
                      />
                    </figure>
                  ))}
              </div>
            </section>

            <section id="live-blog-preview" className="card" style={{ marginBottom: 12 }}>
              <h3>Live Blog Preview (With Inline Images)</h3>
              {isGeneratingFull ? (
                <div className="msg" style={{ marginBottom: 10 }}>
                  <div style={{ width: '100%' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                      <span>Rendering live preview...</span>
                      <strong>{Math.min(100, Math.max(0, Math.round(generationProgress)))}%</strong>
                    </div>
                    <div className="progress-shell">
                      <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, generationProgress))}%` }} />
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="blog-agent-html-preview" style={previewThemeVars} dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </section>

            <section className="card" style={{ marginBottom: 12 }}>
              <details className="accordion" open>
                <summary>Internal Links + Anchors ({(draftState.internal_links_json || []).length})</summary>
                <div className="accordion-body table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Anchor</th>
                        <th>URL</th>
                        <th>Reason</th>
                        <th>Section Hint</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(draftState.internal_links_json || []).map((link, idx) => (
                        <tr key={`${link.url}-${idx}`}>
                          <td>{link.anchor}</td>
                          <td><a href={link.url} target="_blank" rel="noreferrer">{link.url}</a></td>
                          <td>{link.reason || ''}</td>
                          <td>{link.section_hint || ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>

            <section className="card" style={{ marginBottom: 12 }}>
              <h3>Research Trace</h3>
              <div className="stats-grid" style={{ marginBottom: 12 }}>
                <article className="stat-card">
                  <p>Pipeline Run</p>
                  <h3>{draftState.pipeline_run_id || 'n/a'}</h3>
                  <span>{draftState.pipeline_status || 'unknown'}</span>
                </article>
                <article className="stat-card">
                  <p>Current Stage</p>
                  <h3>{draftState.pipeline_stage || 'n/a'}</h3>
                  <span>Latest pipeline stage</span>
                </article>
                <article className="stat-card">
                  <p>Sources</p>
                  <h3>{Number(draftState.research_summary?.source_count || researchSources.length)}</h3>
                  <span>Competitor/context references</span>
                </article>
                <article className="stat-card">
                  <p>Domains</p>
                  <h3>{Number((draftState.research_summary?.source_domains || []).length)}</h3>
                  <span>Unique source domains</span>
                </article>
              </div>

              {draftState.pipeline_error ? (
                <div className="msg error" style={{ marginBottom: 12 }}>
                  Pipeline error: {draftState.pipeline_error}
                </div>
              ) : null}

              <details className="accordion">
                <summary>Research Sources ({researchSources.length})</summary>
                <div className="accordion-body table-wrap">
                  <table className="table" style={{ marginBottom: 12 }}>
                    <thead>
                      <tr>
                        <th>Title</th>
                        <th>Domain</th>
                        <th>URL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {researchSources.length === 0 ? (
                        <tr>
                          <td colSpan={3}>No external sources captured for this run.</td>
                        </tr>
                      ) : (
                        researchSources.map((src, idx) => (
                          <tr key={`${src.url || 'src'}-${idx}`}>
                            <td>{src.title || 'Untitled source'}</td>
                            <td>{src.domain || 'n/a'}</td>
                            <td><a href={src.url} target="_blank" rel="noreferrer">{src.url}</a></td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </details>

              <details className="accordion">
                <summary>Pipeline Event Log ({pipelineEvents.length})</summary>
                <div className="accordion-body table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Level</th>
                        <th>Message</th>
                        <th>Meta</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pipelineEvents.length === 0 ? (
                        <tr>
                          <td colSpan={4}>No pipeline events yet.</td>
                        </tr>
                      ) : (
                        pipelineEvents.map((evt) => (
                          <tr key={evt.id}>
                            <td>{evt.created_at ? `${formatIstDateTime(evt.created_at)} IST` : '-'}</td>
                            <td>{evt.level}</td>
                            <td>{evt.message}</td>
                            <td>
                              <pre className="codebox" style={{ margin: 0 }}>
                                {JSON.stringify(evt.meta_json || {}, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </details>
            </section>

          </>
        ) : (
          <section className="card">
            <h3>Draft Preview</h3>
            <p>Generate outline or full draft to see SEO preview, links, similarity score, and images.</p>
          </section>
        )}
      </main>
    </AuthGate>
  );
}
