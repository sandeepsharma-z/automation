import { google } from "googleapis";
import { colToLetter } from "./utils.js";

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

const OUTPUT_COLUMNS = [
  "results",
  "result_title",
  "created_link",
  "status",
  "status_reason",
  "run_id",
  "started_at",
  "completed_at",
  "screenshot_url",
];

function getEnv(name, fallback = "") {
  const value = process.env[name] ?? fallback;
  return String(value).trim();
}

function getSheetContext() {
  const spreadsheetId = getEnv("GOOGLE_SHEET_ID");
  if (!spreadsheetId) {
    throw new Error("Missing GOOGLE_SHEET_ID");
  }
  const range = getEnv("GOOGLE_SHEET_RANGE", "Sheet1!A1:Z");
  const sheetName = range.includes("!") ? range.split("!")[0] : "Sheet1";
  return { spreadsheetId, range, sheetName };
}

function getAuthClient() {
  const clientEmail = getEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL");
  const privateKeyRaw = getEnv("GOOGLE_PRIVATE_KEY");
  if (!clientEmail || !privateKeyRaw) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY");
  }
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

function getSheetsApi() {
  const auth = getAuthClient();
  return google.sheets({ version: "v4", auth });
}

function normalizeHeader(header) {
  return String(header || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

function normalizeWorkflowType(value) {
  return String(value || "business_directory")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "business_directory";
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

function normalizeTags(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || "").trim()).filter(Boolean);
  return String(value || "")
    .split(/[,\n|]+/g)
    .map((v) => v.trim())
    .filter(Boolean);
}

function hostHash(urlLike = "") {
  const base = String(urlLike || "").trim().toLowerCase();
  let hash = 0;
  for (let i = 0; i < base.length; i += 1) {
    hash = ((hash << 5) - hash) + base.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36).slice(0, 8) || "0";
}

export async function ensureColumns() {
  const sheets = getSheetsApi();
  const { spreadsheetId, range, sheetName } = getSheetContext();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];
  const existingHeader = (values[0] || []).map(normalizeHeader);

  const mandatory = [...INPUT_COLUMNS, ...OUTPUT_COLUMNS];
  const missing = mandatory.filter((col) => !existingHeader.includes(col));
  if (!missing.length) {
    return existingHeader;
  }

  const updatedHeader = [...existingHeader, ...missing];
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1:${colToLetter(updatedHeader.length)}1`,
    valueInputOption: "RAW",
    requestBody: { values: [updatedHeader] },
  });
  return updatedHeader;
}

export async function readRows() {
  const sheets = getSheetsApi();
  const { spreadsheetId, range } = getSheetContext();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const values = res.data.values || [];
  const header = (values[0] || []).map(normalizeHeader);

  const rows = values.slice(1).map((vals, idx) => {
    const rowObj = {};
    header.forEach((h, i) => {
      rowObj[h] = vals[i] ?? "";
    });

    rowObj.default_website_url = String(rowObj.default_website_url || "").trim();
    rowObj.directory_url = String(rowObj.directory_url || rowObj.site_url || "").trim();
    rowObj.site_url = rowObj.directory_url;
    const targetLinks = normalizeTargetLinks(rowObj.target_links || rowObj.target_link);
    rowObj.target_links = targetLinks;
    rowObj.target_link = targetLinks[0] || "";
    rowObj.tags = normalizeTags(rowObj.tags);
    rowObj.results = parseResults(rowObj.results);
    rowObj.backlink_type = normalizeWorkflowType(rowObj.backlink_type || "business_directory");
    rowObj.__rowIndex = idx + 2;
    rowObj.__rowKey = `${idx + 2}-${hostHash(rowObj.directory_url || rowObj.site_url)}`;
    return rowObj;
  });

  return { header, rows };
}

function hasPendingTargets(row) {
  const targets = normalizeTargetLinks(row.target_links || row.target_link);
  if (!targets.length) return true;
  const resultMap = new Map(parseResults(row.results).map((r) => [String(r?.target_link || ""), String(r?.status || "").toLowerCase()]));
  return targets.some((target) => {
    const status = resultMap.get(target) || "";
    return !["success", "skipped", "blocked", "needs_manual_mapping"].includes(status);
  });
}

export async function getQueue({ limit = 20, rowKey = "", includeRetry = false } = {}) {
  await ensureColumns();
  const { rows } = await readRows();

  let filtered = rows;
  if (rowKey) {
    filtered = rows.filter((r) => String(r.__rowKey) === String(rowKey));
  } else if (includeRetry) {
    filtered = rows
      .filter((r) =>
        ["", "queued", "running", "submitted", "pending_verification", "access_required", "manual_access_required", "failed", "skipped", "needs_manual_mapping", "blocked"].includes(
          String(r.status || "").trim().toLowerCase()
        )
      )
      .filter(hasPendingTargets);
  } else {
    filtered = rows
      .filter((r) => ["", "queued", "running", "submitted", "pending_verification", "access_required", "manual_access_required"].includes(String(r.status || "").trim().toLowerCase()))
      .filter(hasPendingTargets);
  }
  return filtered.slice(0, Number(limit || 20));
}

export async function updateRow(rowIndex, updates) {
  const sheets = getSheetsApi();
  const { spreadsheetId, sheetName } = getSheetContext();
  const { header } = await readRows();

  const maxCol = Math.max(header.length, 1);
  const rowRange = `${sheetName}!A${rowIndex}:${colToLetter(maxCol)}${rowIndex}`;
  const rowRes = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: rowRange,
  });
  const rowValues = [...((rowRes.data.values && rowRes.data.values[0]) || [])];
  while (rowValues.length < maxCol) rowValues.push("");

  for (const [key, value] of Object.entries(updates || {})) {
    const normalized = normalizeHeader(key);
    const colIdx = header.indexOf(normalized);
    if (colIdx >= 0) {
      if (normalized === "target_links") {
        rowValues[colIdx] = normalizeTargetLinks(value).join("|");
      } else if (normalized === "tags") {
        rowValues[colIdx] = normalizeTags(value).join("|");
      } else if (normalized === "results") {
        rowValues[colIdx] = JSON.stringify(parseResults(value));
      } else {
        rowValues[colIdx] = value == null ? "" : String(value);
      }
    }
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: rowRange,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] },
  });
}

export { INPUT_COLUMNS, OUTPUT_COLUMNS };
