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

function candidateSearchUrls(baseEndpoint) {
  const base = String(baseEndpoint || "").trim().replace(/\/+$/g, "");
  if (!base) return [];
  if (base.endsWith("/search")) return [base];
  return [`${base}/search`, `${base}/api/search`, `${base}/v1/search`];
}

function candidateExtractUrls(baseEndpoint) {
  const base = String(baseEndpoint || "").trim().replace(/\/+$/g, "");
  if (!base) return [];
  if (base.endsWith("/search")) {
    const root = base.slice(0, -"/search".length);
    return [`${root}/extract`, `${root}/fetch`, `${root}/page`];
  }
  return [`${base}/extract`, `${base}/fetch`, `${base}/page`];
}

function defaultLocalSearchUrls() {
  const bases = [
    "http://127.0.0.1:11235",
    "http://localhost:11235",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
  ];
  const out = [];
  for (const base of bases) {
    out.push(...candidateSearchUrls(base));
  }
  return [...new Set(out)];
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

export async function fetchOpenCrawlSearch({ query, limit = 30, timeoutMs = 20000, apiUrl = "" } = {}) {
  const keyword = String(query || "").trim();
  if (!keyword) return { ok: false, error: "keyword_required", items: [] };

  const endpoint = String(apiUrl || process.env.OPENCRAWL_API_URL || "").trim();
  const candidates = endpoint ? candidateSearchUrls(endpoint) : defaultLocalSearchUrls();
  if (!candidates.length) return { ok: false, error: "opencrawl_api_url_missing", items: [] };

  const payload = {
    query: keyword,
    keyword,
    mode: "keyword_search",
    limit: Math.max(1, Math.min(Number(limit || 30), 200)),
  };

  let lastError = "opencrawl_failed";
  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(timeoutMs || 20000));
      const resp = await fetch(url, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) {
        lastError = `opencrawl_http_${resp.status}`;
        continue;
      }
      const data = await resp.json().catch(() => ({}));
      if (data?.ok === false) {
        lastError = String(data.error || "opencrawl_failed");
        continue;
      }
      const rows = Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.results)
          ? data.results
          : Array.isArray(data?.pages)
            ? data.pages
            : Array.isArray(data?.data)
              ? data.data
              : Array.isArray(data)
                ? data
                : [];
      const items = [];
      const seen = new Set();
      for (const row of rows) {
        const norm = normalizeUrl(row?.url || row?.link || "");
        if (!norm || seen.has(norm)) continue;
        seen.add(norm);
        items.push({
          url: norm,
          domain: normalizeDomain(norm),
          title: String(row?.title || "").trim(),
          snippet: String(row?.snippet || row?.description || "").trim(),
          discovered_at: String(row?.discovered_at || row?.first_seen || "") || null,
        });
        if (items.length >= payload.limit) break;
      }
      return { ok: true, provider: "opencrawl", items, fetched_at: nowIso() };
    } catch (err) {
      lastError = `opencrawl_request_failed:${String(err?.message || err)}`;
    }
  }

  return { ok: false, error: lastError, items: [] };
}

export async function fetchOpenCrawlPage({ url, timeoutMs = 20000, apiUrl = "" } = {}) {
  const targetUrl = normalizeUrl(url);
  if (!targetUrl) return { ok: false, error: "invalid_url", html: "" };

  const endpoint = String(apiUrl || process.env.OPENCRAWL_API_URL || "").trim();
  const candidates = candidateExtractUrls(endpoint || "");
  if (!candidates.length) return { ok: false, error: "opencrawl_api_url_missing", html: "" };

  const payloads = [
    { url: targetUrl, mode: "extract" },
    { url: targetUrl, extract: true },
    { target_url: targetUrl },
  ];

  let lastError = "opencrawl_fetch_failed";
  for (const endpointUrl of candidates) {
    for (const payload of payloads) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Number(timeoutMs || 20000));
        const resp = await fetch(endpointUrl, {
          method: "POST",
          headers: buildHeaders(),
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!resp.ok) {
          lastError = `opencrawl_http_${resp.status}`;
          continue;
        }
        const data = await resp.json().catch(() => ({}));
        if (data?.ok === false) {
          lastError = String(data.error || "opencrawl_failed");
          continue;
        }
        const html = String(data?.html || data?.raw_html || data?.content_html || data?.content || "");
        if (html) return { ok: true, html, fetched_at: nowIso() };
        lastError = "empty_response";
      } catch (err) {
        lastError = `opencrawl_request_failed:${String(err?.message || err)}`;
      }
    }
  }

  return { ok: false, error: lastError, html: "" };
}
