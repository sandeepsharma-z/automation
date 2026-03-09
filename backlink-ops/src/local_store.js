import fs from "node:fs";
import path from "node:path";

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

const OUTPUT_DEFAULTS = {
  results: [],
  result_title: "",
  created_link: "",
  status: "queued",
  status_reason: "",
  run_id: "",
  started_at: "",
  completed_at: "",
  screenshot_url: "",
};

function normalizeWorkflowType(value) {
  return String(value || "business_directory")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "business_directory";
}

function storePath(projectRoot) {
  return path.join(projectRoot, "storage", "local_rows.json");
}

function readStore(projectRoot) {
  const file = storePath(projectRoot);
  if (!fs.existsSync(file)) {
    return { rows: [] };
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data.rows)) return { rows: [] };
    return data;
  } catch (_) {
    return { rows: [] };
  }
}

function writeStore(projectRoot, data) {
  const file = storePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function normalizeRowInput(input = {}) {
  const out = {};
  for (const col of INPUT_COLUMNS) {
    out[col] = String(input[col] || "").trim();
  }
  out.backlink_type = normalizeWorkflowType(out.backlink_type || "business_directory");
  out.default_website_url = String(input.default_website_url || out.default_website_url || "").trim();
  out.directory_url = String(input.directory_url || input.site_url || out.directory_url || out.site_url || "").trim();
  out.site_url = out.directory_url;
  const targets = normalizeTargetLinks(input.target_links || input.target_link || out.target_links || out.target_link);
  out.target_links = targets;
  out.target_link = targets[0] || "";
  out.tags = normalizeTags(input.tags || out.tags);
  return out;
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
  if (Array.isArray(value)) {
    return value.map((v) => String(v || "").trim()).filter(Boolean);
  }
  return String(value || "")
    .split(/[,\n|]+/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function normalizeResults(results) {
  if (!Array.isArray(results)) return [];
  return results.map((item) => ({
    target_link: String(item?.target_link || "").trim(),
    created_link: String(item?.created_link || "").trim(),
    result_title: String(item?.result_title || "").trim(),
    status: String(item?.status || "queued").trim(),
    status_reason: String(item?.status_reason || "").trim(),
    artifacts: Array.isArray(item?.artifacts) ? item.artifacts.map((v) => String(v || "").trim()).filter(Boolean) : [],
    updated_at: String(item?.updated_at || "").trim(),
  }));
}

export function ensureLocalStore(projectRoot) {
  const data = readStore(projectRoot);
  writeStore(projectRoot, data);
}

export function addLocalRow(projectRoot, input) {
  const data = readStore(projectRoot);
  const maxId = data.rows.reduce((max, r) => Math.max(max, Number(r.row_key || 0)), 0);
  const rowKey = String(maxId + 1);
  const row = {
    row_key: rowKey,
    ...normalizeRowInput(input),
    ...OUTPUT_DEFAULTS,
    results: normalizeResults(input.results || []),
  };
  data.rows.push(row);
  writeStore(projectRoot, data);
  return row;
}

export function listLocalRows(projectRoot) {
  const data = readStore(projectRoot);
  return data.rows.map((row) => ({
    ...row,
    backlink_type: normalizeWorkflowType(row.backlink_type || "business_directory"),
    directory_url: String(row.directory_url || row.site_url || "").trim(),
    site_url: String(row.directory_url || row.site_url || "").trim(),
    target_links: normalizeTargetLinks(row.target_links || row.target_link),
    tags: normalizeTags(row.tags),
    results: normalizeResults(row.results),
    __rowKey: String(row.row_key),
  }));
}

function hasPendingTargetLinks(row) {
  const targetLinks = normalizeTargetLinks(row.target_links || row.target_link);
  if (!targetLinks.length) return true;
  const resultMap = new Map(normalizeResults(row.results).map((r) => [r.target_link, String(r.status || "").toLowerCase()]));
  return targetLinks.some((target) => {
    const status = resultMap.get(target) || "";
    return !["success", "skipped", "blocked", "needs_manual_mapping"].includes(status);
  });
}

export function getLocalQueue(projectRoot, { limit = 20, rowKey = "", includeRetry = false } = {}) {
  const rows = listLocalRows(projectRoot);
  let filtered = rows;
  if (rowKey) {
    filtered = rows.filter((r) => String(r.__rowKey) === String(rowKey));
  } else if (includeRetry) {
    filtered = rows.filter((r) =>
      ["", "queued", "running", "submitted", "pending_verification", "access_required", "manual_access_required", "failed", "skipped", "needs_manual_mapping", "blocked"].includes(
        String(r.status || "").toLowerCase().trim()
      )
    ).filter(hasPendingTargetLinks);
  } else {
    filtered = rows
      .filter((r) => ["", "queued", "running", "submitted", "pending_verification", "access_required", "manual_access_required"].includes(String(r.status || "").toLowerCase().trim()))
      .filter(hasPendingTargetLinks);
  }
  return filtered.slice(0, Number(limit || 20));
}

export function updateLocalRow(projectRoot, rowKey, updates = {}) {
  const data = readStore(projectRoot);
  const idx = data.rows.findIndex((row) => String(row.row_key) === String(rowKey));
  if (idx < 0) {
    return null;
  }
  const merged = { ...data.rows[idx], ...updates };
  merged.backlink_type = normalizeWorkflowType(merged.backlink_type || "business_directory");
  merged.directory_url = String(merged.directory_url || merged.site_url || "").trim();
  merged.site_url = merged.directory_url;
  merged.target_links = normalizeTargetLinks(merged.target_links || merged.target_link);
  merged.target_link = merged.target_links[0] || "";
  merged.tags = normalizeTags(merged.tags);
  merged.results = normalizeResults(merged.results);
  data.rows[idx] = merged;
  writeStore(projectRoot, data);
  return data.rows[idx];
}
