import fs from "node:fs";
import path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createQueueRow, loadProfileDefaults } from "./backend.js";

const FINDER_STORAGE_FILE = "backlink_finder_results.json";
const FINDER_JOBS_DIR = "backlink_finder_jobs";

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function projectRoot() {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  return path.resolve(currentDir, "..", "..");
}

function storageRoot() {
  return path.join(projectRoot(), "storage");
}

function finderStorePath() {
  return path.join(storageRoot(), FINDER_STORAGE_FILE);
}

function finderJobsPath() {
  return path.join(storageRoot(), FINDER_JOBS_DIR);
}

function ensureFinderStore() {
  const filePath = finderStorePath();
  if (!fs.existsSync(filePath)) {
    writeJson(filePath, { runs: [] });
  }
}

function readFinderStore() {
  ensureFinderStore();
  const data = readJson(finderStorePath(), { runs: [] });
  if (!Array.isArray(data?.runs)) return { runs: [] };
  return { runs: data.runs };
}

function writeFinderStore(data) {
  writeJson(finderStorePath(), { runs: Array.isArray(data?.runs) ? data.runs : [] });
}

function normalizeEngine(value) {
  const key = String(value || "bing").trim().toLowerCase();
  if (key === "duckduckgo") return "duckduckgo";
  return "bing";
}

function normalizeKeywords(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v || "").trim()).filter(Boolean))];
  }
  const text = String(value || "");
  return [...new Set(text
    .split(/[\n,]+/g)
    .map((v) => v.trim())
    .filter(Boolean))];
}

function normalizeTemplates(value) {
  const defaults = [
    "{keyword} \"leave a comment\" blog",
    "{keyword} \"leave a reply\"",
    "{keyword} \"post a comment\"",
    "\"write for us\" {keyword}",
  ];
  const lines = String(value || "")
    .split(/\n+/g)
    .map((v) => v.trim())
    .filter(Boolean);
  if (!lines.length) return defaults;
  return lines;
}

function normalizeRunInput(payload = {}) {
  const options = payload?.options || {};
  const minDelayMs = 0;
  const maxDelayMs = 0;
  const resultsPerKeyword = Math.max(1, Math.min(100, Number(options.results_per_keyword || options.resultsPerKeyword || 50)));
  const headless = options.headless == null
    ? true
    : (String(options.headless) === "1" || options.headless === true);
  const includeAllSites = options.include_all_sites == null
    ? false
    : options.include_all_sites !== false;
  const minQualityScore = Math.max(0, Number(options.min_quality_score || 5));
  return {
    keywords: normalizeKeywords(payload.keywords),
    templates: normalizeTemplates(payload.template || payload.templates),
    engine: normalizeEngine(payload.engine),
    options: {
      min_delay_ms: minDelayMs,
      max_delay_ms: maxDelayMs,
      headless,
      results_per_keyword: resultsPerKeyword,
      allow_engine_fallback: true,
      include_all_sites: includeAllSites,
      min_quality_score: minQualityScore,
    },
  };
}

function normalizeUrl(urlLike) {
  try {
    const url = new URL(String(urlLike || "").trim());
    url.hash = "";
    const pathname = (url.pathname || "/").replace(/\/+$/g, "") || "/";
    url.pathname = pathname;
    const search = new URLSearchParams(url.search || "");
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"].forEach((k) => search.delete(k));
    const query = search.toString();
    url.search = query ? `?${query}` : "";
    return url.toString();
  } catch (_) {
    return "";
  }
}

function normalizeDomain(urlLike) {
  try {
    return new URL(String(urlLike || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function listQueueRowsRaw() {
  const file = path.join(storageRoot(), "local_rows.json");
  const data = readJson(file, { rows: [] });
  return Array.isArray(data?.rows) ? data.rows : [];
}

function wasProcessedRecently(row, nowMs, windowMs) {
  const timestamps = [row?.completed_at, row?.started_at, row?.created_at]
    .map((v) => new Date(String(v || "")).getTime())
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!timestamps.length) return false;
  return timestamps.some((stamp) => (nowMs - stamp) <= windowMs);
}

function hasRecentExistingUrl(normalizedUrl) {
  if (!normalizedUrl) return false;
  const rows = listQueueRowsRaw();
  const nowMs = Date.now();
  const recentWindowMs = 30 * 24 * 60 * 60 * 1000;
  for (const row of rows) {
    const rowUrl = normalizeUrl(row?.directory_url || row?.site_url || "");
    if (!rowUrl) continue;
    if (rowUrl === normalizedUrl) {
      if (wasProcessedRecently(row, nowMs, recentWindowMs)) return true;
      const status = String(row?.status || "").toLowerCase();
      if (["queued", "running", "submitted", "pending_verification"].includes(status)) return true;
    }
  }
  return false;
}

function summarizeRun(run) {
  return {
    run_id: String(run.run_id || ""),
    created_at: String(run.created_at || ""),
    updated_at: String(run.updated_at || ""),
    status: String(run.status || "queued"),
    engine: String(run.engine || "duckduckgo"),
    keywords_count: Number(run.keywords_count || 0),
    current_keyword_index: Number(run.current_keyword_index || 0),
    current_keyword: String(run.current_keyword || ""),
    total_links_collected: Number(run.total_links_collected || 0),
    artifacts: Array.isArray(run.artifacts) ? run.artifacts : [],
    summary: String(run.summary || ""),
    options: run.options || {},
  };
}

export function startBacklinksFinderRun(payload = {}) {
  const normalized = normalizeRunInput(payload);
  const mode = String(payload?.mode || "").trim().toLowerCase();
  const manualMode = mode === "manual";
  if (!manualMode && !normalized.keywords.length) {
    throw new Error("At least one keyword is required.");
  }

  const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const createdAt = nowIso();
  const run = {
    run_id: runId,
    created_at: createdAt,
    updated_at: createdAt,
    status: "running",
    engine: normalized.engine,
    options: normalized.options,
    keywords_count: normalized.keywords.length,
    current_keyword_index: 0,
    current_keyword: "",
    total_links_collected: 0,
    templates: normalized.templates,
    keywords: normalized.keywords,
    links: [],
    artifacts: [],
    summary: manualMode ? "manual_run_created" : "run_started",
  };

  const store = readFinderStore();
  store.runs.unshift(run);
  writeFinderStore(store);

  if (manualMode) {
    run.status = "completed";
    writeFinderStore(store);
    return { run_id: runId };
  }

  ensureDir(finderJobsPath());
  const inputFile = path.join(finderJobsPath(), `finder-run-${runId}.json`);
  writeJson(inputFile, {
    run_id: runId,
    keywords: normalized.keywords,
    templates: normalized.templates,
    engine: normalized.engine,
    options: normalized.options,
  });

  const runnerFile = path.join(projectRoot(), "backlink_finder.js");
  const child = spawn("node", [runnerFile, `--run-id=${runId}`, `--input-file=${inputFile}`], {
    cwd: projectRoot(),
    env: {
      ...process.env,
      DATA_SOURCE: "local",
    },
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return { run_id: runId };
}

export function listBacklinksFinderRuns(limit = 25) {
  const store = readFinderStore();
  return store.runs
    .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")))
    .slice(0, Number(limit || 25))
    .map((run) => summarizeRun(run));
}

export function getBacklinksFinderRun(runId) {
  const store = readFinderStore();
  const run = store.runs.find((item) => String(item?.run_id || "") === String(runId || ""));
  if (!run) return null;
  return run;
}

export function importBacklinksFinderUrls({ runId, urls = [], keyword = "", queryUsed = "", engine = "manual" } = {}) {
  const incoming = Array.isArray(urls) ? urls : [];
  if (!incoming.length) return { ok: true, added: 0, deduped: 0 };

  const store = readFinderStore();
  const idx = store.runs.findIndex((item) => String(item?.run_id || "") === String(runId || ""));
  if (idx < 0) return { ok: false, error: "Run not found." };

  const run = store.runs[idx];
  const links = Array.isArray(run.links) ? run.links : [];
  const seen = new Set(links.map((item) => normalizeUrl(item?.url || "")).filter(Boolean));
  let maxCounter = 0;
  for (const item of links) {
    const rawId = String(item?.id || "");
    const n = Number(rawId.split("-").at(-1));
    if (Number.isFinite(n)) maxCounter = Math.max(maxCounter, n);
  }

  let added = 0;
  let deduped = 0;
  for (const raw of incoming) {
    const normalized = normalizeUrl(raw);
    if (!normalized) {
      deduped += 1;
      continue;
    }
    if (seen.has(normalized)) {
      deduped += 1;
      continue;
    }
    seen.add(normalized);
    maxCounter += 1;
    links.push({
      id: `${run.run_id}-${maxCounter}`,
      keyword: String(keyword || "manual_seed").trim() || "manual_seed",
      query: String(queryUsed || "manual_url_import").trim() || "manual_url_import",
      url: normalized,
      domain: normalizeDomain(normalized),
      title: "",
      engine: String(engine || "manual").trim() || "manual",
      collected_at: nowIso(),
      status: "new",
    });
    added += 1;
  }

  run.links = links;
  run.total_links_collected = links.length;
  run.updated_at = nowIso();
  if (!String(run.status || "").trim()) run.status = "completed";
  run.summary = added > 0 ? `manual_urls_imported:${added}` : run.summary || "manual_urls_imported:0";

  writeFinderStore(store);
  return { ok: true, added, deduped, run };
}

export function deleteBacklinksFinderLinks({ runId, linkIds = [] } = {}) {
  const ids = new Set((Array.isArray(linkIds) ? linkIds : []).map((v) => String(v || "")).filter(Boolean));
  if (!ids.size) return { ok: true, removed: 0 };

  const store = readFinderStore();
  const idx = store.runs.findIndex((item) => String(item?.run_id || "") === String(runId || ""));
  if (idx < 0) return { ok: false, error: "Run not found." };

  const run = store.runs[idx];
  const before = Array.isArray(run.links) ? run.links.length : 0;
  run.links = (Array.isArray(run.links) ? run.links : []).filter((item) => !ids.has(String(item?.id || "")));
  const removed = before - run.links.length;
  run.total_links_collected = run.links.length;
  run.updated_at = nowIso();

  writeFinderStore(store);
  return { ok: true, removed, run };
}

export function enqueueBacklinksFinderLinks({ runId, linkIds = [] } = {}) {
  const ids = new Set((Array.isArray(linkIds) ? linkIds : []).map((v) => String(v || "")).filter(Boolean));
  if (!ids.size) return { ok: true, added: 0, skipped: 0, queued_row_keys: [] };

  const profileDefaults = loadProfileDefaults() || {};
  const profileWebsite = String(profileDefaults.default_website_url || "").trim();
  const profileUsername = String(profileDefaults.default_username || "").trim();
  const profileEmail = String(profileDefaults.default_email || "").trim();
  const profilePassword = String(profileDefaults.default_password || "").trim();
  const profileSiteName = String(profileDefaults.default_site_name || profileDefaults.company_name || "").trim();

  const store = readFinderStore();
  const idx = store.runs.findIndex((item) => String(item?.run_id || "") === String(runId || ""));
  if (idx < 0) return { ok: false, error: "Run not found." };

  const run = store.runs[idx];
  const links = Array.isArray(run.links) ? run.links : [];
  const selected = links.filter((item) => ids.has(String(item?.id || "")));

  let added = 0;
  let skipped = 0;
  const queuedRowKeys = [];

  for (const link of selected) {
    const normalized = normalizeUrl(link?.url || "");
    if (!normalized || hasRecentExistingUrl(normalized)) {
      skipped += 1;
      link.status = "ignored";
      continue;
    }

    const meta = {
      source: "finder",
      keyword: String(link?.keyword || ""),
      query: String(link?.query || ""),
      engine: String(link?.engine || run.engine || "duckduckgo"),
      collected_at: String(link?.collected_at || run.created_at || nowIso()),
      normalized_url: normalized,
    };

    const row = createQueueRow({
      backlink_type: "blog_commenting",
      directory_url: normalized,
      site_url: normalized,
      site_name: String(link?.domain || ""),
      default_website_url: profileWebsite,
      username: profileUsername,
      email: profileEmail,
      password: profilePassword,
      site_name: profileSiteName || String(link?.domain || ""),
      target_links: profileWebsite || normalized,
      target_link: profileWebsite || normalized,
      notes: `finder_meta:${JSON.stringify(meta)}`,
      tags: ["finder", String(meta.engine || "")].filter(Boolean),
      status: "queued",
      status_reason: "imported_from_backlinks_finder",
    });

    if (row?.row_key) {
      added += 1;
      queuedRowKeys.push(String(row.row_key));
      link.status = "queued";
      link.queue_row_key = String(row.row_key);
      link.queued_at = nowIso();
    } else {
      skipped += 1;
      link.status = "ignored";
    }
  }

  run.updated_at = nowIso();
  run.total_links_collected = links.length;
  writeFinderStore(store);

  return {
    ok: true,
    added,
    skipped,
    queued_row_keys: queuedRowKeys,
    run,
  };
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function exportBacklinksFinderCsv(runId) {
  const run = getBacklinksFinderRun(runId);
  if (!run) return "";

  const header = [
    "id",
    "keyword",
    "query",
    "url",
    "domain",
    "title",
    "engine",
    "opportunity_type",
    "quality_score",
    "da_estimate",
    "has_comment_form",
    "has_url_field",
    "is_dofollow",
    "page_verified",
    "verified_via",
    "source",
    "collected_at",
    "status",
  ];
  const rows = [header.join(",")];

  for (const item of Array.isArray(run.links) ? run.links : []) {
    rows.push([
      item.id || "",
      item.keyword || "",
      item.query || "",
      item.url || "",
      item.domain || normalizeDomain(item.url || ""),
      item.title || "",
      item.engine || run.engine || "",
      item.opportunity_type || "",
      item.quality_score != null ? String(item.quality_score) : "",
      item.da_estimate != null ? String(item.da_estimate) : "",
      item.has_comment_form != null ? (item.has_comment_form ? "yes" : "no") : "",
      item.has_url_field != null ? (item.has_url_field ? "yes" : "no") : "",
      item.is_dofollow != null ? (item.is_dofollow ? "dofollow" : "nofollow") : "",
      item.page_verified ? "yes" : "no",
      item.verified_via || "",
      item.source || item.engine || "",
      item.collected_at || run.created_at || "",
      item.status || "new",
    ].map(csvEscape).join(","));
  }

  return rows.join("\n");
}
