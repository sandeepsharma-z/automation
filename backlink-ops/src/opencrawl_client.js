import { URL } from "node:url";

function nowIso() {
  return new Date().toISOString();
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

function buildHeaders() {
  const apiKey = String(process.env.OPENCRAWL_API_KEY || "").trim();
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "ContentOpsAI/1.0",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * Extract actual result links from DuckDuckGo HTML-only or Bing search page HTML.
 * DDG HTML-only version has direct links or /l/?uddg= redirects.
 * Bing has links in h2>a href= tags (when not JavaScript-gated).
 */
function extractSearchResultLinks(html, sourceUrl) {
  const links = [];
  const isDdg = String(sourceUrl || "").includes("duckduckgo.com");

  if (isDdg) {
    // DDG HTML: result links appear as:
    //   href="//duckduckgo.com/l/?uddg=https%3A%2F%2Factualsite.com%2F...&rut=..."
    // (protocol-relative URL, uddg= param contains the actual destination URL)
    const uddgPattern = /href="[^"]*\/l\/\?uddg=(https?%3A%2F%2F[^"&]+)/gi;
    let m;
    while ((m = uddgPattern.exec(html)) !== null) {
      try {
        links.push({ url: decodeURIComponent(m[1]), title: "" });
      } catch (_) {}
    }
    // Fallback: direct https:// links with result__a class
    if (!links.length) {
      const directPattern = /class="[^"]*result__a[^"]*"[^>]*href="(https?:\/\/[^"]+)"/gi;
      while ((m = directPattern.exec(html)) !== null) {
        const url = m[1];
        if (url && !url.includes("duckduckgo.com")) links.push({ url, title: "" });
      }
    }
  } else {
    // Bing: result links typically appear as <h2><a href="https://...">
    const bingPattern = /<h2[^>]*>\s*<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>/gi;
    let m;
    while ((m = bingPattern.exec(html)) !== null) {
      const url = m[1];
      if (url && !url.includes("bing.com") && !url.includes("microsoft.com") && !url.includes("msn.com")) {
        links.push({ url, title: "" });
      }
    }
  }

  return links;
}

/**
 * Search for URLs using Crawl4AI as the browser backend.
 * Uses Crawl4AI's POST /crawl endpoint to fetch DDG/Bing search pages and extracts result links.
 */
export async function fetchOpenCrawlSearch({ query, limit = 30, timeoutMs = 30000, apiUrl = "" } = {}) {
  const keyword = String(query || "").trim();
  if (!keyword) return { ok: false, error: "keyword_required", items: [] };

  const endpoint = String(apiUrl || process.env.OPENCRAWL_API_URL || "").trim().replace(/\/+$/g, "");
  if (!endpoint) return { ok: false, error: "opencrawl_api_url_missing", items: [] };

  // Use DDG HTML-only (no JS required) as primary, Bing as secondary
  const searchUrls = [
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(keyword)}&kl=us-en`,
    `https://www.bing.com/search?q=${encodeURIComponent(keyword)}&count=30&setlang=en&cc=US`,
  ];

  const items = [];
  const seen = new Set();

  for (const searchUrl of searchUrls) {
    if (items.length >= limit) break;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(timeoutMs || 30000));
      const resp = await fetch(`${endpoint}/crawl`, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify({ urls: [searchUrl], priority: 5 }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) continue;

      const data = await resp.json().catch(() => ({}));
      const result = Array.isArray(data?.results) ? data.results[0] : null;
      if (!result?.success) continue;

      const html = String(result.html || "");
      if (!html) continue;

      const extractedLinks = extractSearchResultLinks(html, searchUrl);
      for (const link of extractedLinks) {
        const norm = normalizeUrl(link.url);
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        items.push({
          url: norm,
          domain: normalizeDomain(norm),
          title: String(link.title || "").trim(),
          snippet: "",
          discovered_at: null,
        });
        if (items.length >= limit) break;
      }
    } catch (_) {
      // Try next search engine
    }
  }

  if (!items.length) return { ok: false, error: "no_results", items: [] };
  return { ok: true, provider: "opencrawl", items, fetched_at: nowIso() };
}

/**
 * Fetch a single page's HTML via Crawl4AI's POST /crawl endpoint.
 */
export async function fetchOpenCrawlPage({ url, timeoutMs = 20000, apiUrl = "" } = {}) {
  const targetUrl = normalizeUrl(url);
  if (!targetUrl) return { ok: false, error: "invalid_url", html: "" };

  const endpoint = String(apiUrl || process.env.OPENCRAWL_API_URL || "").trim().replace(/\/+$/g, "");
  if (!endpoint) return { ok: false, error: "opencrawl_api_url_missing", html: "" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Number(timeoutMs || 20000));
    const resp = await fetch(`${endpoint}/crawl`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ urls: [targetUrl], priority: 3 }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, error: `http_${resp.status}`, html: "" };

    const data = await resp.json().catch(() => ({}));
    const result = Array.isArray(data?.results) ? data.results[0] : null;
    if (!result?.success) return { ok: false, error: "crawl_failed", html: "" };

    const html = String(result.html || result.cleaned_html || "");
    if (!html) return { ok: false, error: "empty_response", html: "" };

    return { ok: true, html, fetched_at: nowIso() };
  } catch (err) {
    return { ok: false, error: `request_failed:${String(err?.message || err)}`, html: "" };
  }
}
