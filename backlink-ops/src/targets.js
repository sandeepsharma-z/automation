import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

function normalizeHost(urlLike) {
  try {
    const host = new URL(urlLike).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

export function loadTargets(targetsPath) {
  const content = fs.readFileSync(targetsPath, "utf8");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error("targets.json must be an array");
  }
  return parsed;
}

export function findAllowlistedTarget(targets, siteUrl) {
  const siteHost = normalizeHost(siteUrl);
  if (!siteHost) return null;
  for (const target of targets) {
    const baseHost = normalizeHost(target.base_url || target.domain || "");
    if (!baseHost) continue;
    if (siteHost === baseHost || siteHost.endsWith(`.${baseHost}`)) {
      return target;
    }
  }
  return null;
}

export function validateTargetMapping(row, target, extraRequiredFields = [], extraRequiredSelectors = []) {
  const isBlogCommenting = Array.isArray(extraRequiredSelectors) && extraRequiredSelectors.includes("comment_box");
  const required = [...new Set([
    ...(!isBlogCommenting && Array.isArray(target.required_fields) ? target.required_fields : []),
    ...(Array.isArray(extraRequiredFields) ? extraRequiredFields : []),
  ])];
  const requiredSelectors = [...new Set([
    ...(Array.isArray(extraRequiredSelectors) ? extraRequiredSelectors : []),
  ])];
  const selectors = target.selectors || {};

  const missingSheetFields = required.filter((field) => !String(row[field] || "").trim());
  const selectorKeyMap = {
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
  };
  const selectorAliasMap = {
    comment_box: "comment_box|comment|description",
    submit_button: "submit_button|submit",
  };
  const missingSelectors = [];
  for (const field of required) {
    if (isBlogCommenting) continue;
    const selectorKey = selectorKeyMap[field] || field;
    const keys = String(selectorKey).split("|").map((v) => v.trim()).filter(Boolean);
    const found = keys.some((key) => hasSelector(selectors[key]));
    if (!found) {
      missingSelectors.push(keys[0] || selectorKey);
    }
  }
  for (const selectorKey of requiredSelectors) {
    const alias = selectorAliasMap[selectorKey] || selectorKey;
    const keys = String(alias).split("|").map((v) => v.trim()).filter(Boolean);
    const found = keys.some((key) => hasSelector(selectors[key]));
    if (!found) missingSelectors.push(keys[0] || selectorKey);
  }

  if (requiredSelectors.length === 0 && !hasSelector(selectors.submit_button) && !hasSelector(selectors.submit)) {
    missingSelectors.push("submit_button");
  }

  return {
    ok: missingSheetFields.length === 0 && missingSelectors.length === 0,
    missingSheetFields,
    missingSelectors: [...new Set(missingSelectors)],
  };
}

function hasSelector(value) {
  if (!value) return false;
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "object") {
    return Boolean(String(value.css || "").trim() || String(value.xpath || "").trim());
  }
  return false;
}

function getLockPath(targetsPath) {
  return `${targetsPath}.lock`;
}

function acquireLock(lockPath, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
    }
  }
  throw new Error("Could not acquire targets.json write lock.");
}

function releaseLock(lockPath) {
  try {
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
  } catch (_) {
    // ignore
  }
}

function writeTargetsAtomic(targetsPath, data) {
  const tmpPath = `${targetsPath}.tmp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, targetsPath);
}

export function upsertTargetSelectors(targetsPath, siteUrl, selectorPatch = {}) {
  const lockPath = getLockPath(targetsPath);
  acquireLock(lockPath);
  try {
    const targets = loadTargets(targetsPath);
    const siteHost = normalizeHost(siteUrl);
    if (!siteHost) throw new Error("Invalid site URL for selector mapping.");

    const idx = targets.findIndex((item) => {
      const baseHost = normalizeHost(item.base_url || item.domain || "");
      return Boolean(baseHost) && (siteHost === baseHost || siteHost.endsWith(`.${baseHost}`));
    });
    if (idx < 0) throw new Error(`Allowlisted target not found for host: ${siteHost}`);

    const existing = targets[idx];
    const nextSelectors = { ...(existing.selectors || {}), ...selectorPatch };
    targets[idx] = {
      ...existing,
      allowed: true,
      selectors: nextSelectors,
    };

    writeTargetsAtomic(targetsPath, targets);
    return targets[idx];
  } finally {
    releaseLock(lockPath);
  }
}

export function resolveTargetsPath(projectRoot) {
  return path.join(projectRoot, "targets.json");
}
