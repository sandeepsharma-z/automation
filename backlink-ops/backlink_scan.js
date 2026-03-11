import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { chromium } from "playwright";
import { fetchOpenCrawlPage, fetchOpenCrawlSearch } from "./src/opencrawl_client.js";

function parseArgs(argv = []) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, value] = raw.slice(2).split("=");
    out[key] = value ?? "";
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(filePath, rows) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, rows.join("\n"), "utf8");
}

function normalizeUrl(urlLike) {
  try {
    const url = new URL(String(urlLike || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    url.username = "";
    url.password = "";
    const pathname = (url.pathname || "/").replace(/\/+$/g, "") || "/";
    url.pathname = pathname;
    const query = new URLSearchParams(url.search || "");
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid"].forEach((k) => query.delete(k));
    const clean = query.toString();
    url.search = clean ? `?${clean}` : "";
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

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

function relTypeFromRel(rel) {
  const value = String(rel || "").toLowerCase();
  if (!value) return "dofollow";
  if (value.includes("nofollow") || value.includes("ugc") || value.includes("sponsored")) return "nofollow";
  return "dofollow";
}

const BLOCKED_DOMAINS = new Set([
  "google.com",
  "bing.com",
  "duckduckgo.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "pinterest.com",
  "reddit.com",
  "wikipedia.org",
  "xhamster.com",
  "xvideos.com",
  "pornhub.com",
  "xnxx.com",
  "redtube.com",
  "youporn.com",
  "bokeppx.com",
  "bokeppx.tv",
  "bokeppxtv.com",
]);

function isBlockedDomain(domain = "") {
  const d = String(domain || "").toLowerCase();
  if (!d) return true;
  if (BLOCKED_DOMAINS.has(d)) return true;
  for (const blocked of BLOCKED_DOMAINS) {
    if (d.endsWith(`.${blocked}`)) return true;
  }
  if (/\b(xhamster|xvideos|pornhub|xnxx|redtube|youporn|bokeppx|adult|xxx)\b/.test(d)) return true;
  return false;
}

function isCrawlableUrl(url) {
  const lower = String(url || "").toLowerCase();
  if (!lower.startsWith("http")) return false;
  if (lower.startsWith("mailto:") || lower.startsWith("tel:") || lower.startsWith("javascript:")) return false;
  if (/\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|rar|7z|mp3|mp4|avi|mov|mkv|doc|docx|ppt|pptx)$/i.test(lower)) return false;
  const domain = normalizeDomain(url);
  if (isBlockedDomain(domain)) return false;
  return true;
}

function extractLinksFromHtml(html, baseUrl) {
  const out = [];
  const anchorRegex = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const attrs = String(match[1] || "");
    const body = String(match[2] || "");
    const hrefMatch = attrs.match(/\bhref\s*=\s*["']([^"']+)["']/i);
    if (!hrefMatch) continue;
    const rawHref = String(hrefMatch[1] || "").trim();
    if (!rawHref || rawHref.startsWith("#")) continue;
    let resolved = "";
    try {
      resolved = normalizeUrl(new URL(rawHref, baseUrl).toString());
    } catch (_) {
      resolved = normalizeUrl(rawHref);
    }
    if (!resolved || !isCrawlableUrl(resolved)) continue;
    const relMatch = attrs.match(/\brel\s*=\s*["']([^"']+)["']/i);
    const rel = relMatch ? relMatch[1] : "";
    const anchorText = decodeHtml(body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    out.push({
      href: resolved,
      anchor_text: anchorText,
      rel_type: relTypeFromRel(rel),
    });
  }
  return out;
}

function shouldRender(html = "") {
  const text = String(html || "");
  if (!text) return true;
  if (text.length < 800) return true;
  if (/__NEXT_DATA__|id="__next"|data-reactroot|data-vue-meta/i.test(text)) return true;
  const bodyText = text.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
  if (bodyText.replace(/\s+/g, " ").trim().length < 200) return true;
  return false;
}

async function extractLinksFromRendered(page) {
  return page.evaluate(() => {
    const links = [];
    const seen = new Set();
    const norm = (value) => {
      try {
        const url = new URL(value, window.location.href);
        url.hash = "";
        url.username = "";
        url.password = "";
        const pathname = (url.pathname || "/").replace(/\/+$/g, "") || "/";
        url.pathname = pathname;
        const query = new URLSearchParams(url.search || "");
        ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid"].forEach((k) => query.delete(k));
        const clean = query.toString();
        url.search = clean ? `?${clean}` : "";
        return url.toString();
      } catch (_) {
        return "";
      }
    };
    document.querySelectorAll("a[href]").forEach((el) => {
      const href = String(el.getAttribute("href") || "").trim();
      if (!href || href.startsWith("#")) return;
      const resolved = norm(href);
      if (!resolved || seen.has(resolved)) return;
      seen.add(resolved);
      const rel = String(el.getAttribute("rel") || "");
      const text = String(el.textContent || "").replace(/\s+/g, " ").trim();
      links.push({ href: resolved, anchor_text: text, rel_type: rel.toLowerCase() });
    });
    return links;
  });
}

async function postDiscoveredBacklinks(items = []) {
  const base = String(process.env.BACKLINKS_API_URL || "").trim();
  if (!base) return { ok: false, error: "BACKLINKS_API_URL missing" };
  const token = String(process.env.BACKLINKS_API_TOKEN || "").trim();
  const apiUrl = base.endsWith("/api/backlinks/discovered") ? base : `${base.replace(/\/+$/g, "")}/api/backlinks/discovered`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ items }),
    });
    if (!resp.ok) {
      return { ok: false, error: `api_http_${resp.status}` };
    }
    const data = await resp.json().catch(() => ({}));
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetDomain = String(args.domain || "").trim().toLowerCase();
  if (!targetDomain) {
    throw new Error("--domain is required");
  }

  const competitors = String(args.competitors || process.env.COMPETITOR_DOMAINS || "")
    .split(/[,\n]+/g)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const maxDepth = Math.max(1, Math.min(3, Number(args["max-depth"] || 3)));
  const maxPages = Math.max(50, Math.min(2000, Number(args["max-pages"] || 400)));
  const rateLimitMs = Math.max(200, Number(args["rate-limit-ms"] || 1200));
  const headless = String(args.headless || process.env.HEADLESS || "1") !== "0";
  const scanId = String(args["run-id"] || `${Date.now()}-${Math.floor(Math.random() * 10000)}`);

  const projectRoot = path.resolve(process.cwd());
  const reportDir = path.join(projectRoot, "storage", "backlink_scans", scanId);
  ensureDir(reportDir);

  const seedDomains = [targetDomain, ...competitors];
  const seedUrls = [];
  for (const domain of seedDomains) {
    seedUrls.push(`https://${domain}`);
    seedUrls.push(`https://${domain}/blog`);
    seedUrls.push(`https://${domain}/news`);
  }

  const serpQueries = [];
  for (const domain of seedDomains) {
    serpQueries.push(`"${domain}"`);
    serpQueries.push(`"${domain}" blog`);
    serpQueries.push(`"${domain}" "leave a reply"`);
  }

  const queue = [];
  const visited = new Set();
  const queued = new Set();

  const enqueue = (url, depth) => {
    const norm = normalizeUrl(url);
    if (!norm || !isCrawlableUrl(norm)) return;
    if (visited.has(norm) || queued.has(norm)) return;
    queued.add(norm);
    queue.push({ url: norm, depth });
  };

  seedUrls.forEach((url) => enqueue(url, 0));

  for (const query of serpQueries) {
    const result = await fetchOpenCrawlSearch({ query, limit: 50 });
    if (result.ok) {
      for (const item of result.items || []) {
        enqueue(item.url, 0);
      }
    }
  }

  let browser = null;
  const backlinks = [];
  const backlinkKeySet = new Set();
  let pagesProcessed = 0;

  while (queue.length && pagesProcessed < maxPages) {
    const next = queue.shift();
    if (!next) break;
    if (visited.has(next.url)) continue;
    visited.add(next.url);
    pagesProcessed += 1;

    await sleep(rateLimitMs);

    let html = "";
    let needRender = false;
    const crawl = await fetchOpenCrawlPage({ url: next.url, timeoutMs: 20000 });
    if (crawl.ok && crawl.html) {
      html = crawl.html;
      needRender = shouldRender(html);
    } else {
      needRender = true;
    }

    let links = [];
    if (html) {
      links = extractLinksFromHtml(html, next.url);
    }

    if (needRender) {
      if (!browser) browser = await chromium.launch({ headless });
      const page = await browser.newPage();
      try {
        await page.goto(next.url, { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        const renderedLinks = await extractLinksFromRendered(page);
        if (renderedLinks.length) {
          links = renderedLinks.map((item) => ({
            href: normalizeUrl(item.href),
            anchor_text: String(item.anchor_text || "").trim(),
            rel_type: relTypeFromRel(item.rel_type),
          })).filter((item) => item.href);
        }
      } catch (_) {
        // ignore render failures
      } finally {
        await page.close().catch(() => {});
      }
    }

    for (const link of links) {
      if (!link?.href) continue;
      const href = normalizeUrl(link.href);
      if (!href) continue;
      const targetDomainFound = normalizeDomain(href);
      if (targetDomainFound === targetDomain) {
        const key = `${next.url}||${href}||${String(link.anchor_text || "")}`.toLowerCase();
        if (!backlinkKeySet.has(key)) {
          backlinkKeySet.add(key);
          backlinks.push({
            source_url: next.url,
            target_url: href,
            anchor_text: String(link.anchor_text || "").trim() || null,
            rel_type: String(link.rel_type || "").trim() || null,
            discovered_at: nowIso(),
            domain_authority_placeholder: 0.0,
          });
        }
      }

      if (next.depth + 1 <= maxDepth) {
        enqueue(href, next.depth + 1);
      }
    }
  }

  if (browser) {
    await browser.close();
  }

  const jsonPath = path.join(reportDir, "backlinks.json");
  writeJson(jsonPath, {
    run_id: scanId,
    domain: targetDomain,
    discovered_at: nowIso(),
    pages_processed: pagesProcessed,
    backlinks,
  });

  const csvRows = [
    ["source_url", "target_url", "anchor_text", "rel_type", "discovered_at", "domain_authority_placeholder"].join(","),
  ];
  for (const row of backlinks) {
    csvRows.push([
      row.source_url,
      row.target_url,
      row.anchor_text || "",
      row.rel_type || "",
      row.discovered_at || "",
      row.domain_authority_placeholder ?? 0.0,
    ].map(csvEscape).join(","));
  }
  writeCsv(path.join(reportDir, "backlinks.csv"), csvRows);

  if (backlinks.length && String(process.env.BACKLINKS_API_URL || "").trim()) {
    await postDiscoveredBacklinks(backlinks);
  }
}

main().catch((err) => {
  console.error("[backlink-scan]", err?.message || err);
  process.exit(1);
});
