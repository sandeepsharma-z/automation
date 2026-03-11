import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { spawn } from "node:child_process";
import { getWorkflow, listWorkflows } from "./workflows.js";

const DEBUG_BACKLINK_OPS = String(process.env.DEBUG_BACKLINK_OPS || "").trim() === "1";
const RUNNABLE_STATUSES = new Set(["queued"]);

const RUN_SESSION = {
  running: false,
  session_id: "",
  current_row_id: "",
  started_at: "",
  stop_requested: false,
  child_pid: 0,
  last_error: "",
  headless: true,
  row_keys: [],
  force_retry: false,
  force: false,
};

function isPidAlive(pid) {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function resetRunSession(reason = "") {
  RUN_SESSION.running = false;
  RUN_SESSION.stop_requested = false;
  RUN_SESSION.child_pid = 0;
  RUN_SESSION.current_row_id = "";
  RUN_SESSION.row_keys = [];
  RUN_SESSION.force_retry = false;
  RUN_SESSION.force = false;
  if (reason) RUN_SESSION.last_error = String(reason);
}

function reconcileRunSessionState() {
  if (!RUN_SESSION.running) return;
  const startedAtMs = new Date(String(RUN_SESSION.started_at || "")).getTime();
  const ageMs = Number.isFinite(startedAtMs) && startedAtMs > 0 ? Date.now() - startedAtMs : 0;
  const hasAliveChild = isPidAlive(RUN_SESSION.child_pid);
  const staleNoChild = !RUN_SESSION.child_pid && !RUN_SESSION.current_row_id && ageMs > 20_000;
  const deadChild = RUN_SESSION.child_pid && !hasAliveChild;
  if (staleNoChild || deadChild) {
    resetRunSession(staleNoChild ? "Recovered stale run session." : "Recovered dead runner process.");
  }
}

function normalizeRowKeys(rowKeys = []) {
  return Array.isArray(rowKeys) ? [...new Set(rowKeys.map((v) => String(v || "").trim()).filter(Boolean))] : [];
}

const INPUT_COLUMNS = [
  "backlink_type",
  "site_name",
  "default_website_url",
  "directory_url",
  "site_url",
  "username",
  "email",
  "password",
  "company_name",
  "company_address",
  "company_phone",
  "company_description",
  "target_links",
  "target_link",
  "anchor_text",
  "category",
  "notes",
  "tags",
];

const SELECTOR_KEY_MAP = {
  username: "username|name",
  email: "email",
  password: "password",
  company_name: "website_name|name",
  company_address: "address",
  company_phone: "phone",
  company_description: "description|comment_box",
  target_link: "target_link|website",
  category: "category",
  notes: "notes",
  anchor_text: "anchor_text",
  tags: "tags",
};

function normalizeWorkflowType(value) {
  return String(value || "business_directory")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "business_directory";
}

export function projectRoot() {
  return path.resolve(process.cwd(), "..");
}

function localStorePath() {
  return path.join(projectRoot(), "storage", "local_rows.json");
}

function runsRoot() {
  return path.join(projectRoot(), "runs");
}

function targetsPath() {
  return path.join(projectRoot(), "targets.json");
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

function nowIso() {
  return new Date().toISOString();
}

function normalizeHost(urlLike) {
  try {
    return new URL(String(urlLike || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function normalizeTargetLinks(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((v) => String(v || "").trim()).filter(Boolean))];
  }
  return [...new Set(String(value || "")
    .split(/[\n|;,]+/g)
    .map((v) => v.trim())
    .filter(Boolean))];
}

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[,\n|]+/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseResults(value) {
  if (Array.isArray(value)) return value;
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeResult(item = {}) {
  return {
    target_link: String(item.target_link || "").trim(),
    created_link: String(item.created_link || "").trim(),
    result_title: String(item.result_title || "").trim(),
    status: String(item.status || "queued").trim(),
    status_reason: String(item.status_reason || "").trim(),
    artifacts: Array.isArray(item.artifacts) ? item.artifacts.map((v) => String(v || "").trim()).filter(Boolean) : [],
    updated_at: String(item.updated_at || "").trim(),
  };
}

function aggregateFromResults(results) {
  const list = results.map((r) => normalizeResult(r));
  const counts = list.reduce((acc, item) => {
    const key = String(item.status || "queued").toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  let status = "queued";
  if (!list.length) status = "queued";
  else if (list.every((item) => item.status === "success")) status = "success";
  else if (list.some((item) => item.status === "running")) status = "running";
  else if (list.some((item) => item.status === "failed")) status = "failed";
  else if (list.some((item) => item.status === "pending_verification")) status = "pending_verification";
  else if (list.some((item) => item.status === "manual_access_required")) status = "manual_access_required";
  else if (list.some((item) => item.status === "access_required")) status = "access_required";
  else if (list.some((item) => item.status === "submitted")) status = "submitted";
  else if (list.some((item) => item.status === "needs_manual_mapping")) status = "needs_manual_mapping";
  else if (list.some((item) => item.status === "blocked")) status = "blocked";
  else if (list.every((item) => item.status === "skipped")) status = "skipped";

  const createdLinks = [...new Set(list.map((item) => item.created_link).filter(Boolean))];
  const titles = [...new Set(list.map((item) => item.result_title).filter(Boolean))];

  const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(", ");
  const detailReason = list.find((item) => item.status !== "success" && item.status_reason)?.status_reason || "";
  const summaryLower = String(summary || "").toLowerCase();
  const detailLower = String(detailReason || "").toLowerCase();
  const shouldIncludeDetail = Boolean(detailReason) && detailLower !== status && detailLower !== summaryLower;

  return {
    status,
    status_reason: [summary, shouldIncludeDetail ? detailReason : ""].filter(Boolean).join(" | "),
    created_link: createdLinks.join("|"),
    result_title: titles.join(" | "),
    results: list,
  };
}

function normalizeInput(input = {}) {
  const out = {};
  for (const col of INPUT_COLUMNS) {
    out[col] = input[col] == null ? "" : input[col];
  }

  out.default_website_url = String(out.default_website_url || input.website_url || "").trim();
  out.directory_url = String(out.directory_url || out.site_url || input.site_url || "").trim();
  out.site_url = out.directory_url;

  out.backlink_type = normalizeWorkflowType(out.backlink_type || "business_directory");
  out.target_links = normalizeTargetLinks(out.target_links || out.target_link);
  out.target_link = out.target_links[0] || "";
  out.tags = normalizeTags(out.tags);

  for (const textField of [
    "default_website_url",
    "directory_url",
    "site_name",
    "site_url",
    "username",
    "email",
    "password",
    "company_name",
    "company_address",
    "company_phone",
    "company_description",
    "anchor_text",
    "category",
    "notes",
  ]) {
    out[textField] = String(out[textField] || "").trim();
  }

  return out;
}

function ensureLocalStore() {
  const file = localStorePath();
  if (!fs.existsSync(file)) {
    writeJson(file, { rows: [] });
  }
}

function readStore() {
  ensureLocalStore();
  const data = readJson(localStorePath(), { rows: [] });
  if (!Array.isArray(data.rows)) return { rows: [] };
  return data;
}

function writeStore(data) {
  writeJson(localStorePath(), data);
}

function healStaleRunningRows(maxAgeMs = 30 * 60 * 1000) {
  if (RUN_SESSION.running) return;
  const data = readStore();
  let changed = false;
  for (let i = 0; i < data.rows.length; i += 1) {
    const row = data.rows[i] || {};
    const status = String(row.status || "").toLowerCase().trim();
    if (status !== "running") continue;
    const startedAt = new Date(String(row.started_at || "")).getTime();
    if (!Number.isFinite(startedAt) || startedAt <= 0) continue;
    if ((Date.now() - startedAt) < maxAgeMs) continue;
    data.rows[i] = {
      ...row,
      status: "failed",
      status_reason: "stale_running_recovered",
      completed_at: nowIso(),
    };
    changed = true;
  }
  if (changed) {
    writeStore(data);
  }
}

function patchLocalRow(rowKey, mutate) {
  ensureLocalStore();
  const data = readStore();
  const idx = data.rows.findIndex((row) => String(row.row_key || "") === String(rowKey || ""));
  if (idx < 0) return null;
  const current = data.rows[idx];
  const next = { ...current, ...(typeof mutate === "function" ? mutate(current) : mutate || {}) };
  data.rows[idx] = next;
  writeStore(data);
  return next;
}

function stopAllRunningRows() {
  const data = readStore();
  let changed = false;
  let touched = 0;
  const stamp = nowIso();

  for (let i = 0; i < data.rows.length; i += 1) {
    const row = data.rows[i] || {};
    const status = String(row.status || "").toLowerCase().trim();
    const rawResults = parseResults(row.results);
    let resultChanged = false;
    const nextResults = rawResults.map((item) => {
      const normalized = normalizeResult(item);
      if (String(normalized.status || "").toLowerCase() !== "running") return normalized;
      resultChanged = true;
      return {
        ...normalized,
        status: "queued",
        status_reason: "stopped_by_user",
        updated_at: stamp,
      };
    });

    if (status !== "running" && !resultChanged) continue;
    data.rows[i] = {
      ...row,
      status: "queued",
      status_reason: "stopped_by_user",
      completed_at: "",
      results: resultChanged ? nextResults : rawResults,
    };
    changed = true;
    touched += 1;
  }

  if (changed) {
    writeStore(data);
  }
  return touched;
}

function getNextQueuedRow() {
  const rows = listLocalRowsRaw();
  return rows.find((row) => RUNNABLE_STATUSES.has(String(row.status || "").toLowerCase())) || null;
}

function getRowByKey(rowKey) {
  return listLocalRowsRaw().find((row) => String(row.__rowKey || row.row_key || "") === String(rowKey || "")) || null;
}

function terminatePid(pid) {
  const parsed = Number(pid || 0);
  if (!parsed) return;
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(parsed), "/T", "/F"], { stdio: "ignore", detached: true });
      killer.unref();
    } else {
      process.kill(parsed, "SIGTERM");
    }
  } catch (_) {
    // best effort
  }
}

function listLocalRowsRaw() {
  return readStore().rows.map((row) => {
    const targetLinks = normalizeTargetLinks(row.target_links || row.target_link);
    const results = parseResults(row.results);
    const aggregated = aggregateFromResults(results);
    return {
      ...row,
      default_website_url: String(row.default_website_url || "").trim(),
      directory_url: String(row.directory_url || row.site_url || "").trim(),
      backlink_type: normalizeWorkflowType(row.backlink_type || "business_directory"),
      target_links: targetLinks,
      target_link: targetLinks[0] || "",
      tags: normalizeTags(row.tags),
      results: results,
      status: row.status || aggregated.status || "queued",
      status_reason: row.status_reason || aggregated.status_reason || "",
      created_link: row.created_link || aggregated.created_link || "",
      result_title: row.result_title || aggregated.result_title || "",
      __rowKey: String(row.row_key),
    };
  });
}

function listRunIds() {
  if (!fs.existsSync(runsRoot())) return [];
  return fs
    .readdirSync(runsRoot(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => (a > b ? -1 : 1));
}

function listRowsFromRuns() {
  const out = [];
  for (const runId of listRunIds()) {
    const runDir = path.join(runsRoot(), runId);
    const sites = fs.existsSync(runDir) ? fs.readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
    for (const site of sites) {
      const rowJson = path.join(runDir, site.name, "row.json");
      if (!fs.existsSync(rowJson)) continue;
      const row = readJson(rowJson, null);
      if (!row) continue;
      out.push({ ...row, run_id: runId, site_slug: site.name });
    }
  }
  return out;
}

function readRunEvents(runId) {
  const eventsFile = path.join(runsRoot(), runId, "events.jsonl");
  if (!fs.existsSync(eventsFile)) return [];
  return fs
    .readFileSync(eventsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function readApprovalArtifacts(runId, siteSlug) {
  if (!runId || !siteSlug) return {};
  const siteDir = path.join(runsRoot(), runId, siteSlug);
  return {
    approval_request: readJson(path.join(siteDir, "approval_request.json"), null),
    approval_decision: readJson(path.join(siteDir, "approval_decision.json"), null),
  };
}

function buildLatestRunRowMap() {
  const rows = listRowsFromRuns().sort((a, b) => String(b.run_id || "").localeCompare(String(a.run_id || "")));
  const latest = new Map();
  for (const row of rows) {
    const key = String(row.row_key || "");
    if (!key || latest.has(key)) continue;
    latest.set(key, row);
  }
  return latest;
}

function mapLocalRowToView(row, latestRunRow = null) {
  const workflow = getWorkflow(row.backlink_type);
  const directoryUrl = String(row.directory_url || row.site_url || "");
  const defaultWebsiteUrl = String(row.default_website_url || "");
  const runId = String(row.run_id || latestRunRow?.run_id || "");
  const siteSlug = String(latestRunRow?.site_slug || "");
  const artifacts = readApprovalArtifacts(runId, siteSlug);
  return {
    row_key: String(row.__rowKey || row.row_key || ""),
    run_id: runId,
    site_slug: siteSlug,
    workflow_type: workflow.type,
    input: {
      ...row,
      directory_url: directoryUrl,
      site_url: directoryUrl,
      default_website_url: defaultWebsiteUrl,
      credentials: {
        username: row.username || "",
        email: row.email || "",
        password: row.password || "",
      },
      business_profile: {
        company_name: row.company_name || "",
        company_address: row.company_address || "",
        company_phone: row.company_phone || "",
        company_description: row.company_description || "",
      },
    },
    output: {
      status: row.status || "queued",
      status_reason: row.status_reason || "",
      result_title: row.result_title || "",
      created_link: row.created_link || "",
      run_id: row.run_id || "",
      started_at: row.started_at || "",
      completed_at: row.completed_at || "",
      screenshot_url: row.screenshot_url || "",
      results: parseResults(row.results),
    },
    events: [],
    artifacts,
  };
}

function loadTargets() {
  const parsed = readJson(targetsPath(), []);
  return Array.isArray(parsed) ? parsed : [];
}

function upsertAllowlistedTargetForUrl(siteUrl, type = "business_directory") {
  const host = normalizeHost(siteUrl);
  if (!host) {
    return { ok: false, reason: "invalid_host", target: null };
  }
  const file = targetsPath();
  const targets = loadTargets();
  const existingIndex = targets.findIndex((target) => {
    const targetHost = normalizeHost(target.base_url || target.domain || "");
    return targetHost && (host === targetHost || host.endsWith(`.${targetHost}`));
  });

  const now = nowIso();
  const normalizedType = normalizeWorkflowType(type || "business_directory");
  if (existingIndex >= 0) {
    const prev = targets[existingIndex] || {};
    targets[existingIndex] = {
      ...prev,
      name: String(prev.name || host),
      base_url: String(prev.base_url || `https://${host}`),
      allowed: true,
      type: String(prev.type || normalizedType),
      notes: String(prev.notes || "Auto-allowlisted from queue intake."),
      required_fields: Array.isArray(prev.required_fields) ? prev.required_fields : [],
      selectors: (prev.selectors && typeof prev.selectors === "object") ? prev.selectors : {},
      updated_at: now,
    };
  } else {
    targets.push({
      name: host,
      base_url: `https://${host}`,
      domain: host,
      allowed: true,
      type: normalizedType,
      notes: "Auto-allowlisted from queue intake.",
      required_fields: [],
      selectors: {},
      created_at: now,
      updated_at: now,
    });
  }

  writeJson(file, targets);
  return { ok: true, reason: existingIndex >= 0 ? "updated" : "created", target: targets[existingIndex >= 0 ? existingIndex : targets.length - 1] };
}

function findTargetForSite(siteUrl) {
  const host = normalizeHost(siteUrl);
  if (!host) return null;
  const targets = loadTargets();
  return targets.find((target) => {
    const targetHost = normalizeHost(target.base_url || target.domain || "");
    return targetHost && (host === targetHost || host.endsWith(`.${targetHost}`));
  }) || null;
}

function validateSelectorsForWorkflow(target, workflow) {
  const isBlogCommenting = String(workflow?.type || "").toLowerCase() === "blog_commenting";
  const autoDetectSelectors = Boolean(workflow?.auto_detect_selectors);
  if (isBlogCommenting) {
    // Blog commenting flow uses runtime auto-detection on page.
    // Do not block queue rows on missing pre-mapped selectors.
    return [];
  }
  if (autoDetectSelectors) {
    // Some workflows can discover common fields/buttons at runtime.
    // Keep queue rows runnable instead of blocking intake on empty selector maps.
    return [];
  }
  const required = [...new Set([
    ...(!isBlogCommenting && Array.isArray(target?.required_fields) ? target.required_fields : []),
    ...(Array.isArray(workflow?.required_fields) ? workflow.required_fields : []),
  ])];
  const selectors = target?.selectors || {};
  const requiredSelectorAliases = {
    comment_box: "comment_box|comment|description",
    submit_button: "submit_button|submit",
  };
  const hasSelector = (val) => {
    if (!val) return false;
    if (typeof val === "string") return Boolean(val.trim());
    if (typeof val === "object") return Boolean(String(val.css || "").trim() || String(val.xpath || "").trim());
    return false;
  };

  const missingSelectors = [];
  for (const field of required) {
    if (isBlogCommenting) continue;
    if (["site_url", "directory_url", "default_website_url", "site_name", "backlink_type", "target_links", "tags"].includes(field)) continue;
    const selectorKey = SELECTOR_KEY_MAP[field] || field;
    const keys = String(selectorKey).split("|").map((v) => v.trim()).filter(Boolean);
    const found = keys.some((key) => hasSelector(selectors[key]));
    if (!found) missingSelectors.push(keys[0] || selectorKey);
  }
  for (const selectorKey of Array.isArray(workflow?.required_selectors) ? workflow.required_selectors : []) {
    const alias = requiredSelectorAliases[selectorKey] || selectorKey;
    const keys = String(alias).split("|").map((v) => v.trim()).filter(Boolean);
    const found = keys.some((key) => hasSelector(selectors[key]));
    if (!found) missingSelectors.push(keys[0] || selectorKey);
  }

  if (
    workflow?.uses_playwright
    && !isBlogCommenting
    && !(Array.isArray(workflow?.required_selectors) && workflow.required_selectors.length)
    && !hasSelector(selectors.submit_button)
    && !hasSelector(selectors.submit)
  ) {
    missingSelectors.push("submit_button");
  }
  return [...new Set(missingSelectors)];
}

function validateBulkRow(normalizedRow) {
  const errors = [];
  const warnings = [];

  if (!normalizedRow.directory_url) errors.push("directory_url is required");
  if (!normalizedRow.target_links.length) errors.push("target_links is required");

  let target = findTargetForSite(normalizedRow.directory_url);
  if (!target || !target.allowed) {
    const autoAllow = upsertAllowlistedTargetForUrl(normalizedRow.directory_url, normalizedRow.backlink_type);
    if (autoAllow.ok) {
      warnings.push("Directory URL auto-allowlisted.");
      target = autoAllow.target || findTargetForSite(normalizedRow.directory_url);
    } else {
      return {
        status: "blocked",
        status_reason: "directory_url is not allowlisted in targets.json",
        errors,
        warnings,
        target,
      };
    }
  }

  const workflow = getWorkflow(normalizedRow.backlink_type);
  const missingFields = workflow.required_fields.filter((field) => {
    if (field === "target_link") return !normalizedRow.target_links.length;
    return !String(normalizedRow[field] || "").trim();
  });
  if (missingFields.length) {
    errors.push(`missing required fields: ${missingFields.join(", ")}`);
  }

  const missingSelectors = validateSelectorsForWorkflow(target, workflow);
  if (missingSelectors.length) {
    return {
      status: "needs_manual_mapping",
      status_reason: `missing selectors: ${missingSelectors.join(", ")}`,
      errors,
      warnings,
      target,
    };
  }

  return {
    status: errors.length ? "needs_manual_mapping" : "queued",
    status_reason: errors.length ? errors.join("; ") : "ready",
    errors,
    warnings,
    target,
  };
}

export function startRun({ limit = 1, rowKey = "", forceRetry = false, approvalMode = "ui", headless = false, force = false } = {}) {
  const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const args = [path.join(projectRoot(), "src", "runner.js"), `--limit=${Number(limit || 1)}`, `--run-id=${runId}`];
  if (rowKey) args.push(`--row-key=${rowKey}`);
  if (forceRetry) args.push("--force-retry=1");
  if (force) args.push("--force=1");

  const env = {
    ...process.env,
    APPROVAL_MODE: approvalMode,
    AUTO_APPROVE_SUBMIT: String(process.env.AUTO_APPROVE_SUBMIT || "1"),
    DATA_SOURCE: "local",
    HEADLESS: headless ? "1" : String(process.env.HEADLESS || "0"),
  };

  const child = spawn("node", args, {
    cwd: projectRoot(),
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return runId;
}

function runSingleRowInChild({ rowKey, headless = true, forceRetry = false, force = false }) {
  return new Promise((resolve, reject) => {
    const runId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const args = [path.join(projectRoot(), "src", "runner.js"), "--limit=1", `--row-key=${String(rowKey)}`, `--run-id=${runId}`];
    if (forceRetry) args.push("--force-retry=1");
    if (force) args.push("--force=1");

    const env = {
      ...process.env,
      APPROVAL_MODE: "ui",
      AUTO_APPROVE_SUBMIT: String(process.env.AUTO_APPROVE_SUBMIT || "1"),
      DATA_SOURCE: "local",
      HEADLESS: headless ? "1" : String(process.env.HEADLESS || "0"),
    };

    const child = spawn("node", args, {
      cwd: projectRoot(),
      env,
      detached: false,
      stdio: "ignore",
    });

    RUN_SESSION.child_pid = Number(child.pid || 0);
    const timeoutMs = Math.max(120_000, Number(process.env.BACKLINK_ROW_TIMEOUT_MS || 1_800_000));
    const timeoutHandle = setTimeout(() => {
      try {
        terminatePid(child.pid);
      } catch (_) {
        // best effort
      }
      RUN_SESSION.child_pid = 0;
      reject(new Error(`runner timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timeoutHandle);
      RUN_SESSION.child_pid = 0;
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timeoutHandle);
      RUN_SESSION.child_pid = 0;
      if (Number(code || 0) === 0) {
        resolve({ ok: true, run_id: runId });
      } else {
        reject(new Error(`runner exited with code ${code}`));
      }
    });
  });
}

function pickNextSessionRow(rowKeys = []) {
  const rows = listLocalRowsRaw();
  if (!Array.isArray(rowKeys) || !rowKeys.length) {
    const runnable = rows.filter((row) => RUNNABLE_STATUSES.has(String(row.status || "").toLowerCase()));
    if (!runnable.length) return null;
    const retryFirst = runnable.find((row) => String(row.status_reason || "").toLowerCase().includes("retry_requested"));
    return retryFirst || runnable[0] || null;
  }
  const wanted = new Set(rowKeys.map((v) => String(v || "")));
  return rows.find((row) => {
    const key = String(row.__rowKey || row.row_key || "");
    if (!wanted.has(key)) return false;
    return RUNNABLE_STATUSES.has(String(row.status || "").toLowerCase());
  }) || null;
}

async function processRunSessionQueue(sessionId) {
  while (RUN_SESSION.running && RUN_SESSION.session_id === sessionId && !RUN_SESSION.stop_requested) {
    const next = pickNextSessionRow(RUN_SESSION.row_keys);
    if (!next) break;

    const rowKey = String(next.__rowKey || next.row_key || "");
    if (!rowKey) break;

    RUN_SESSION.current_row_id = rowKey;
    patchLocalRow(rowKey, (row) => ({
      status: "running",
      status_reason: "row_started",
      run_id: row.run_id || `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      started_at: row.started_at || nowIso(),
      completed_at: "",
    }));

    try {
      await runSingleRowInChild({
        rowKey,
        headless: RUN_SESSION.headless,
        forceRetry: RUN_SESSION.force_retry,
        force: RUN_SESSION.force,
      });
      const rowAfter = getRowByKey(rowKey);
      if (rowAfter && String(rowAfter.status || "").toLowerCase() === "running") {
        patchLocalRow(rowKey, () => ({
          status: "failed",
          status_reason: "runner finished without terminal status",
          completed_at: nowIso(),
        }));
      }
    } catch (err) {
      const stopped = RUN_SESSION.stop_requested;
      patchLocalRow(rowKey, (row) => ({
        status: stopped ? "queued" : "failed",
        status_reason: stopped ? "stopped_by_user" : String(err?.message || err || "row_failed"),
        completed_at: stopped ? "" : nowIso(),
      }));
      if (!stopped) {
        RUN_SESSION.last_error = String(err?.message || err || "");
      }
    } finally {
      RUN_SESSION.current_row_id = "";
    }
  }

  const stoppedByUser = RUN_SESSION.stop_requested;
  RUN_SESSION.running = false;
  RUN_SESSION.stop_requested = false;
  RUN_SESSION.child_pid = 0;
  RUN_SESSION.current_row_id = "";
  RUN_SESSION.last_error = stoppedByUser ? "Stopped by user" : RUN_SESSION.last_error;
  RUN_SESSION.row_keys = [];
  RUN_SESSION.force_retry = false;
  RUN_SESSION.force = false;
}

export function startRunSession({ headless = true, rowKeys = [], forceRetry = false, force = false } = {}) {
  reconcileRunSessionState();
  if (RUN_SESSION.running) {
    return {
      ok: true,
      running: true,
      session_id: RUN_SESSION.session_id,
      current_row_id: RUN_SESSION.current_row_id || "",
      started_at: RUN_SESSION.started_at || "",
      already_running: true,
    };
  }

  const sessionId = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  RUN_SESSION.running = true;
  RUN_SESSION.session_id = sessionId;
  RUN_SESSION.current_row_id = "";
  RUN_SESSION.started_at = nowIso();
  RUN_SESSION.stop_requested = false;
  RUN_SESSION.child_pid = 0;
  RUN_SESSION.last_error = "";
  RUN_SESSION.headless = Boolean(headless);
  RUN_SESSION.row_keys = normalizeRowKeys(rowKeys);
  RUN_SESSION.force_retry = Boolean(forceRetry);
  RUN_SESSION.force = Boolean(force);

  processRunSessionQueue(sessionId).catch((err) => {
    RUN_SESSION.running = false;
    RUN_SESSION.child_pid = 0;
    RUN_SESSION.current_row_id = "";
    RUN_SESSION.stop_requested = false;
    RUN_SESSION.last_error = String(err?.message || err || "session_failed");
    RUN_SESSION.row_keys = [];
    RUN_SESSION.force_retry = false;
    RUN_SESSION.force = false;
  });

  return {
    ok: true,
    running: true,
    session_id: sessionId,
    current_row_id: "",
    started_at: RUN_SESSION.started_at || "",
    already_running: false,
  };
}

export function attachRowsToActiveSession(rowKeys = []) {
  reconcileRunSessionState();
  const normalized = normalizeRowKeys(rowKeys);
  if (!RUN_SESSION.running || !normalized.length) {
    return {
      ok: true,
      running: Boolean(RUN_SESSION.running),
      attached: 0,
      session_id: RUN_SESSION.session_id || "",
    };
  }
  if (!RUN_SESSION.row_keys.length) {
    return {
      ok: true,
      running: true,
      attached: 0,
      session_id: RUN_SESSION.session_id || "",
      mode: "all_queued_dynamic",
    };
  }
  const before = new Set(RUN_SESSION.row_keys.map((v) => String(v || "")));
  for (const key of normalized) before.add(key);
  RUN_SESSION.row_keys = [...before];
  return {
    ok: true,
    running: true,
    attached: RUN_SESSION.row_keys.length,
    session_id: RUN_SESSION.session_id || "",
    mode: "explicit_row_keys",
  };
}

export function startRowRetrySession({ rowKey, headless = false } = {}) {
  reconcileRunSessionState();
  const key = String(rowKey || "").trim();
  if (!key) {
    return { ok: false, error: "row_key is required." };
  }
  const existing = getRowByKey(key);
  if (!existing) {
    return { ok: false, error: "Row not found." };
  }
  upsertAllowlistedTargetForUrl(existing.directory_url || existing.site_url || "", existing.backlink_type || "business_directory");
  const normalizedResults = parseResults(existing.results).map((item) => {
    const normalized = normalizeResult(item);
    if (normalized.status === "running") {
      return { ...normalized, status: "queued", status_reason: "retry_requested", updated_at: nowIso() };
    }
    return normalized;
  });
  patchLocalRow(key, () => ({
    status: "queued",
    status_reason: "retry_requested",
    completed_at: "",
    results: normalizedResults,
  }));

  if (RUN_SESSION.running) {
    const attached = attachRowsToActiveSession([key]);
    return {
      ok: true,
      running: true,
      session_id: RUN_SESSION.session_id,
      already_running: true,
      attached: Number(attached?.attached || 0),
      message: "Attached row to active run session.",
    };
  }

  const started = startRunSession({
    headless: Boolean(headless),
    rowKeys: [key],
    forceRetry: true,
    force: true,
  });
  if (started?.ok && started?.running && !started?.already_running) {
    RUN_SESSION.current_row_id = key;
    patchLocalRow(key, (row) => ({
      status: "running",
      status_reason: "retry_started",
      run_id: row.run_id || `${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      started_at: row.started_at || nowIso(),
      completed_at: "",
    }));
    return {
      ...started,
      current_row_id: key,
    };
  }
  return started;
}

export function stopRunSession() {
  reconcileRunSessionState();
  const hadSession = Boolean(RUN_SESSION.running);
  if (RUN_SESSION.running) {
    RUN_SESSION.stop_requested = true;
  }
  const stoppedRows = stopAllRunningRows();
  if (RUN_SESSION.child_pid) {
    terminatePid(RUN_SESSION.child_pid);
  }
  return {
    ok: true,
    running: false,
    session_id: RUN_SESSION.session_id,
    stopped_row_id: RUN_SESSION.current_row_id || "",
    stopped_rows: stoppedRows,
    had_session: hadSession,
  };
}

export function getRunSessionStatus() {
  reconcileRunSessionState();
  return {
    running: Boolean(RUN_SESSION.running),
    child_alive: Boolean(RUN_SESSION.running && isPidAlive(RUN_SESSION.child_pid)),
    session_id: RUN_SESSION.session_id || "",
    current_row_id: RUN_SESSION.current_row_id || "",
    started_at: RUN_SESSION.started_at || "",
    stop_requested: Boolean(RUN_SESSION.stop_requested),
    last_error: RUN_SESSION.last_error || "",
    row_keys: [...RUN_SESSION.row_keys],
  };
}

export async function readQueueRows(limit = 200) {
  ensureLocalStore();
  healStaleRunningRows();
  const latestRunRows = buildLatestRunRowMap();
  const rows = listLocalRowsRaw().slice(0, Number(limit || 200));
  if (DEBUG_BACKLINK_OPS) {
    console.log("[backlink-ops][queue] read", { limit: Number(limit || 200), returned: rows.length });
  }
  return rows.map((row) => mapLocalRowToView(row, latestRunRows.get(String(row.__rowKey || row.row_key || "")) || null));
}

export function readRowsByStatus(statuses = []) {
  ensureLocalStore();
  const localRows = listLocalRowsRaw();
  if (!statuses.length) return localRows.map(mapLocalRowToView);
  const wanted = new Set(statuses.map((s) => String(s).toLowerCase()));
  return localRows.filter((r) => wanted.has(String(r.status || "").toLowerCase())).map(mapLocalRowToView);
}

export function readRuns({ includeRows = false } = {}) {
  const runRows = listRowsFromRuns();
  const map = new Map();
  for (const row of runRows) {
    const runId = row.run_id || "";
    if (!map.has(runId)) {
      map.set(runId, {
        run_id: runId,
        total: 0,
        counts: {},
        target_totals: { total: 0, success: 0, failed: 0, pending_verification: 0, access_required: 0, manual_access_required: 0, blocked: 0, needs_manual_mapping: 0, skipped: 0 },
        rows: [],
      });
    }
    const item = map.get(runId);
    item.total += 1;
    const status = String(row.output?.status || "unknown");
    item.counts[status] = (item.counts[status] || 0) + 1;

    const rowResults = Array.isArray(row.output?.results) ? row.output.results : [];
    item.target_totals.total += rowResults.length;
    for (const res of rowResults) {
      const key = String(res?.status || "unknown");
      item.target_totals[key] = (item.target_totals[key] || 0) + 1;
    }

    if (includeRows) {
      item.rows.push({
        row_key: String(row.row_key || ""),
        site_url: String(row.input?.site_url || ""),
        site_name: String(row.input?.site_name || ""),
        backlink_type: String(row.input?.backlink_type || "business_directory"),
        status,
        results: rowResults,
      });
    }
  }
  return [...map.values()].sort((a, b) => String(b.run_id).localeCompare(String(a.run_id)));
}

export function readRunDetail(runId) {
  const runs = readRuns({ includeRows: true });
  return runs.find((run) => String(run.run_id) === String(runId)) || null;
}

export async function readRowDetail(rowKey) {
  const fromRuns = listRowsFromRuns().find((r) => String(r.row_key || "") === String(rowKey));
  if (fromRuns) {
    const siteDir = path.join(runsRoot(), fromRuns.run_id, fromRuns.site_slug);
    const events = readRunEvents(fromRuns.run_id).filter((e) => String(e.row_key || "") === String(rowKey));
    return {
      ...fromRuns,
      events,
      artifacts: {
        screenshots: fs.existsSync(siteDir)
          ? fs.readdirSync(siteDir).filter((name) => /^pre_submit_\d+\.png$/i.test(name) || name === "pre_submit.png")
          : [],
        html_files: fs.existsSync(siteDir)
          ? fs.readdirSync(siteDir).filter((name) => /^pre_submit_\d+\.html$/i.test(name) || name === "pre_submit.html")
          : [],
        approval_request: readJson(path.join(siteDir, "approval_request.json"), null),
        approval_decision: readJson(path.join(siteDir, "approval_decision.json"), null),
      },
    };
  }

  const local = listLocalRowsRaw().find((r) => String(r.__rowKey) === String(rowKey));
  return local ? mapLocalRowToView(local) : null;
}

export function writeApprovalDecision({ runId, siteSlug, approved, reason = "", edited_draft = "" }) {
  const filePath = path.join(runsRoot(), runId, siteSlug, "approval_decision.json");
  if (!fs.existsSync(path.dirname(filePath))) {
    throw new Error("Run/site directory not found for approval.");
  }
  writeJson(filePath, {
    approved: Boolean(approved),
    reason: String(reason || ""),
    edited_draft: String(edited_draft || ""),
    decided_at: nowIso(),
  });
}

export function createQueueRow(payload) {
  ensureLocalStore();
  const data = readStore();
  const maxId = data.rows.reduce((max, row) => Math.max(max, Number(row.row_key || 0)), 0);
  const normalized = normalizeInput(payload);
  const validation = validateBulkRow(normalized);
  const row = {
    row_key: String(maxId + 1),
    ...normalized,
    credentials: {
      username: normalized.username,
      email: normalized.email,
      password: normalized.password,
    },
    business_profile: {
      company_name: normalized.company_name,
      company_address: normalized.company_address,
      company_phone: normalized.company_phone,
      company_description: normalized.company_description,
    },
    results: [],
    result_title: "",
    created_link: "",
    status: validation.status,
    status_reason: validation.status_reason,
    run_id: "",
    started_at: "",
    completed_at: "",
    screenshot_url: "",
    created_at: nowIso(),
  };
  data.rows.push(row);
  writeStore(data);
  return row;
}

export function createQueueRowsBulk(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const rawDefaults = payload.defaults || {};
  const defaults = normalizeInput({
    ...rawDefaults,
    username: rawDefaults.username || rawDefaults.default_username || "",
    email: rawDefaults.email || rawDefaults.default_email || "",
    password: rawDefaults.password || rawDefaults.default_password || "",
    site_name: rawDefaults.site_name || rawDefaults.default_site_name || "",
    directory_url: rawDefaults.directory_url || rawDefaults.site_url || "",
  });
  const created = [];
  const rejected = [];

  for (let i = 0; i < rows.length; i += 1) {
    const raw = rows[i] || {};
    const merged = normalizeInput({
      ...defaults,
      ...raw,
      default_website_url: raw.default_website_url || defaults.default_website_url || "",
      directory_url: raw.directory_url || raw.site_url || defaults.directory_url || "",
      site_url: raw.directory_url || raw.site_url || defaults.directory_url || "",
      username: raw.username || defaults.username || "",
      email: raw.email || defaults.email || "",
      password: raw.password || defaults.password || "",
      site_name: raw.site_name || defaults.site_name || defaults.company_name || "",
      company_name: raw.company_name || defaults.company_name || "",
      company_address: raw.company_address || defaults.company_address || "",
      company_phone: raw.company_phone || defaults.company_phone || "",
      company_description: raw.company_description || defaults.company_description || "",
      notes: raw.notes || defaults.notes || "",
      category: raw.category || raw.link_type || defaults.category || defaults.backlink_type || "",
      backlink_type: raw.backlink_type || raw.link_type || defaults.backlink_type || "business_directory",
      target_links: raw.target_links || raw.target_link || "",
      target_link: raw.target_link || "",
    });

    if (!merged.directory_url || !merged.target_links.length) {
      rejected.push({
        index: i,
        reason: !merged.directory_url ? "directory_url is required" : "target_links is required",
        row: merged,
      });
      continue;
    }

    created.push(createQueueRow(merged));
  }

  if (DEBUG_BACKLINK_OPS) {
    console.log("[backlink-ops][queue] bulk-add", {
      requested: rows.length,
      added: created.length,
      rejected: rejected.length,
    });
  }

  return { ok: true, added: created.length, rows: created, rejected };
}

export function removeQueueRow(rowKey) {
  ensureLocalStore();
  const data = readStore();
  const before = data.rows.length;
  data.rows = data.rows.filter((row) => String(row.row_key || "") !== String(rowKey || ""));
  const removed = before - data.rows.length;
  writeStore(data);
  return { ok: removed > 0, removed };
}

export function bulkPreviewRows(payload = {}) {
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const normalizedRows = rows.map((raw, idx) => {
    const normalized = normalizeInput(raw);
    const validation = validateBulkRow(normalized);
    return {
      row_index: idx + 1,
      row: normalized,
      status: validation.status,
      status_reason: validation.status_reason,
      allowed: validation.status !== "blocked",
      needs_manual_mapping: validation.status === "needs_manual_mapping",
      target_links_count: normalized.target_links.length,
      host: normalizeHost(normalized.site_url),
    };
  });

  const counts = normalizedRows.reduce((acc, item) => {
    acc.total += 1;
    if (item.status === "queued") acc.allowed += 1;
    if (item.status === "blocked") acc.blocked += 1;
    if (item.status === "needs_manual_mapping") acc.mapping_needed += 1;
    return acc;
  }, { total: 0, allowed: 0, blocked: 0, mapping_needed: 0 });

  return { rows: normalizedRows, counts, workflows: listWorkflows() };
}

export function bulkImportRows(payload = {}) {
  const preview = bulkPreviewRows(payload);
  const created = [];
  for (const item of preview.rows) {
    const row = createQueueRow({
      ...item.row,
      status: item.status,
      status_reason: item.status_reason,
    });
    created.push(row);
  }
  return { created_count: created.length, created };
}

export function listSuccessVault() {
  const rows = readRowsByStatus([]);
  const entries = [];
  const seen = new Set();

  for (const row of rows) {
    const results = Array.isArray(row.output?.results) ? row.output.results : [];
    let appendedFromResults = false;
    for (const result of results) {
      if (String(result?.status || "").toLowerCase() !== "success") continue;
      if (!String(result?.created_link || "").trim()) continue;
      const normalizedCreated = String(result.created_link || "").trim();
      const dedupeKey = [
        String(row.row_key || ""),
        String(row.output?.run_id || row.run_id || ""),
        String(result.target_link || ""),
        normalizedCreated,
      ].join("|");
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      entries.push({
        row_key: row.row_key,
        run_id: row.output?.run_id || row.run_id || "",
        timestamp: result.updated_at || row.output?.completed_at || row.output?.started_at || "",
        backlink_type: row.input?.backlink_type || "business_directory",
        site_url: row.input?.site_url || "",
        site_name: row.input?.site_name || "",
        target_link: result.target_link || "",
        created_link: normalizedCreated,
        submitted_comment_link: normalizedCreated,
        result_title: result.result_title || "",
      });
      appendedFromResults = true;
    }

    if (!appendedFromResults) {
      const rowStatus = String(row.output?.status || "").toLowerCase();
      const rowCreatedLink = String(row.output?.created_link || "").trim();
      if ((rowStatus === "success" || rowStatus === "submitted") && rowCreatedLink) {
        const dedupeKey = [
          String(row.row_key || ""),
          String(row.output?.run_id || row.run_id || ""),
          String(row.input?.target_link || ""),
          rowCreatedLink,
        ].join("|");
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey);
          entries.push({
            row_key: row.row_key,
            run_id: row.output?.run_id || row.run_id || "",
            timestamp: row.output?.completed_at || row.output?.started_at || "",
            backlink_type: row.input?.backlink_type || "business_directory",
            site_url: row.input?.site_url || "",
            site_name: row.input?.site_name || "",
            target_link: row.input?.target_link || "",
            created_link: rowCreatedLink,
            submitted_comment_link: rowCreatedLink,
            result_title: row.output?.result_title || "",
          });
        }
      }
    }
  }

  return entries.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

export function exportRunCsv(runId) {
  const run = readRunDetail(runId);
  if (!run) return "";
  const lines = [
    [
      "run_id",
      "row_key",
      "backlink_type",
      "site_url",
      "site_name",
      "target_link",
      "status",
      "status_reason",
      "created_link",
      "result_title",
    ].join(","),
  ];

  for (const row of run.rows || []) {
    const rowResults = Array.isArray(row.results) ? row.results : [];
    if (!rowResults.length) {
      lines.push([
        run.run_id,
        row.row_key,
        row.backlink_type,
        row.site_url,
        row.site_name,
        "",
        row.status,
        "",
        "",
        "",
      ].map(csvEscape).join(","));
      continue;
    }
    for (const result of rowResults) {
      lines.push([
        run.run_id,
        row.row_key,
        row.backlink_type,
        row.site_url,
        row.site_name,
        result.target_link || "",
        result.status || "",
        result.status_reason || "",
        result.created_link || "",
        result.result_title || "",
      ].map(csvEscape).join(","));
    }
  }

  return lines.join("\n");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
