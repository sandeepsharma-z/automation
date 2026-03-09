import fs from "node:fs";
import path from "node:path";

const LOCK_RETRY_MS = 120;
const LOCK_TIMEOUT_MS = 5000;

function projectRoot() {
  return path.resolve(process.cwd(), "..");
}

function targetsFilePath() {
  return path.join(projectRoot(), "targets.json");
}

function lockFilePath() {
  return `${targetsFilePath()}.lock`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTargetsLock(fn) {
  const lockPath = lockFilePath();
  const started = Date.now();
  while (Date.now() - started < LOCK_TIMEOUT_MS) {
    try {
      const handle = fs.openSync(lockPath, "wx");
      fs.closeSync(handle);
      try {
        return await fn();
      } finally {
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
      }
    } catch (err) {
      if (err && err.code !== "EEXIST") throw err;
      await sleep(LOCK_RETRY_MS);
    }
  }
  throw new Error("Could not acquire targets.json write lock. Please retry.");
}

function readTargetsUnsafe() {
  const filePath = targetsFilePath();
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("targets.json must be an array.");
  }
  return parsed;
}

function writeTargetsAtomicUnsafe(targets) {
  const filePath = targetsFilePath();
  const tmpPath = `${filePath}.tmp-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const data = JSON.stringify(targets, null, 2);
  fs.writeFileSync(tmpPath, data, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function normalizeType(value) {
  return String(value || "business_directory")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "business_directory";
}

function slugToTitle(slug) {
  return String(slug || "")
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Allowlisted Target";
}

export function extractDomainFromUrl(directoryUrl) {
  try {
    const parsed = new URL(String(directoryUrl || "").trim());
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

export async function listTargets() {
  const targets = readTargetsUnsafe();
  return targets.map((item) => ({
    domain: extractDomainFromUrl(item.base_url || item.domain || ""),
    base_url: String(item.base_url || ""),
    allowed: Boolean(item.allowed),
    type: normalizeType(item.type),
    name: String(item.name || ""),
    notes: String(item.notes || ""),
  }));
}

export async function upsertAllowlistedTarget({ directory_url = "", type = "business_directory" } = {}) {
  const domain = extractDomainFromUrl(directory_url);
  if (!domain) {
    throw new Error("Invalid directory_url. Please provide a valid URL.");
  }
  const normalizedType = normalizeType(type);

  return withTargetsLock(async () => {
    const targets = readTargetsUnsafe();
    const idx = targets.findIndex((item) => {
      const host = extractDomainFromUrl(item.base_url || item.domain || "");
      return host === domain;
    });

    const nextEntry = {
      name: slugToTitle(domain),
      domain,
      base_url: `https://${domain}`,
      allowed: true,
      type: normalizedType,
      notes: "Added from Backlink Ops UI allowlist action.",
      rate_limit_ms: 180000,
      retries: 2,
      human_approval_required: true,
      required_fields: Array.isArray(targets[idx]?.required_fields) ? targets[idx].required_fields : [],
      selectors: typeof targets[idx]?.selectors === "object" && targets[idx]?.selectors ? targets[idx].selectors : {},
    };

    if (idx >= 0) {
      targets[idx] = {
        ...targets[idx],
        ...nextEntry,
        selectors: typeof targets[idx]?.selectors === "object" && targets[idx]?.selectors ? targets[idx].selectors : {},
      };
    } else {
      targets.push(nextEntry);
    }

    writeTargetsAtomicUnsafe(targets);
    return {
      ok: true,
      domain,
      message: `${domain} added to allowlist`,
    };
  });
}
