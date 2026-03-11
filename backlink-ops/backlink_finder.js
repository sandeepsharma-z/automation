import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";
import { chromium } from "playwright";
import { fetchOpenCrawlSearch, fetchOpenCrawlPage } from "./src/opencrawl_client.js";

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

function decodeDdgHref(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/l/?") || raw.includes("duckduckgo.com/l/?")) {
    try {
      const parsed = new URL(raw.startsWith("http") ? raw : `https://duckduckgo.com${raw}`);
      const target = parsed.searchParams.get("uddg") || parsed.searchParams.get("rut") || "";
      return target ? decodeURIComponent(target) : raw;
    } catch (_) {
      return raw;
    }
  }
  return raw;
}

function decodeBingHref(href) {
  const raw = String(href || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const host = String(parsed.hostname || "").toLowerCase();
    if (host.includes("bing.com") && parsed.pathname.startsWith("/ck/a")) {
      const u = String(parsed.searchParams.get("u") || "").trim();
      if (!u) return raw;
      if (u.startsWith("a1")) {
        const payload = u.slice(2);
        try {
          const decoded = Buffer.from(payload, "base64").toString("utf8").trim();
          if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
        } catch (_) {
          // fall through
        }
      }
      try {
        const decoded = decodeURIComponent(u);
        if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
      } catch (_) {
        // keep raw
      }
    }
  } catch (_) {
    // keep raw
  }
  return raw;
}

const BLOCKED_DOMAINS = new Set([
  "bing.com",
  "google.com",
  "duckduckgo.com",
  "youtube.com",
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "pinterest.com",
  "reddit.com",
  "wikipedia.org",
  "microsoft.com",
  "apple.com",
  "translate.google.com",
  "support.google.com",
  "blog.youtube",
  "feedspot.com",
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

const TRUSTED_TLDS = [".com", ".org", ".net", ".co.uk", ".in", ".co", ".io", ".edu", ".gov"];
const LOW_QUALITY_TLDS = [".xyz", ".top", ".click", ".gq", ".tk", ".cf", ".ml", ".work", ".buzz"];
const SPAM_TERMS = [
  "casino",
  "bet",
  "porn",
  "sex",
  "xxx",
  "adult",
  "escort",
  "camgirl",
  "cams",
  "onlyfans",
  "xhamster",
  "xvideos",
  "pornhub",
  "xnxx",
  "redtube",
  "youporn",
  "boke",
  "loan",
  "crypto",
  "viagra",
  "hack",
  "crack",
  "apk",
];
const LOW_INTENT_TERMS = [
  "meaning",
  "definition",
  "grammar",
  "synonym",
  "translate",
  "crossword",
  "solver",
  "generator",
  "checker",
  "tool",
  "how to remove",
  "disable comments",
  "remove leave a reply",
  "get rid of leave a reply",
  "best blogs",
  "top blogs",
  "blogs and websites",
  "official blog",
];

function detectIntent(query = "", template = "") {
  const lower = `${String(query || "").toLowerCase()} ${String(template || "").toLowerCase()}`;
  if (/(comment|leave a reply|reply|respond)/i.test(lower)) return "comment";
  if (/\binurl:blog\b/i.test(lower)) return "comment";
  if (/(inurl:forum|forum|thread|discussion|board|register)/i.test(lower)) return "forum";
  if (/(write for us|guest post|contribute)/i.test(lower)) return "write_for_us";
  if (/(intitle:accounts|inurl:account|profile|signup|register)/i.test(lower)) return "accounts";
  return "general";
}

function tokenize(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/g)
    .filter((v) => v.length >= 3);
}

const KEYWORD_STOP_TERMS = new Set([
  "blog",
  "blogs",
  "post",
  "posts",
  "comment",
  "comments",
  "reply",
  "leave",
  "best",
  "top",
  "guide",
  "review",
  "oil",
  "pure",
  "method",
  "methods",
  "and",
  "the",
  "for",
  "with",
]);

function keywordTokens(keyword = "") {
  return tokenize(keyword).filter((t) => !KEYWORD_STOP_TERMS.has(t));
}

function keywordOverlapCount(candidate = {}, keyword = "") {
  const terms = keywordTokens(keyword);
  if (!terms.length) return 0;
  const hay = `${String(candidate?.title || "").toLowerCase()} ${String(candidate?.url || "").toLowerCase()}`;
  let count = 0;
  for (const term of terms) {
    if (hay.includes(term)) count += 1;
  }
  return count;
}

function asciiRatio(text = "") {
  const value = String(text || "");
  if (!value) return 1;
  let ascii = 0;
  for (const ch of value) {
    if (ch.charCodeAt(0) <= 127) ascii += 1;
  }
  return ascii / value.length;
}

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

function qualityScore({ url = "", domain = "", title = "", keyword = "", query = "" } = {}) {
  const lowerUrl = String(url || "").toLowerCase();
  const lowerDomain = String(domain || "").toLowerCase();
  const lowerTitle = String(title || "").toLowerCase();
  const lowerQuery = String(query || "").toLowerCase();
  const intent = detectIntent(query);
  const keywordTerms = tokenize(keyword);
  const titleTerms = tokenize(title);
  const urlTerms = tokenize(url);
  const titleSet = new Set(titleTerms);
  const urlSet = new Set(urlTerms);

  if (!lowerDomain || !lowerUrl) return -999;
  if (isBlockedDomain(lowerDomain)) return -999;
  if (lowerDomain.includes("xn--")) return -120;
  if (LOW_QUALITY_TLDS.some((tld) => lowerDomain.endsWith(tld))) return -120;
  if (SPAM_TERMS.some((term) => lowerDomain.includes(term) || lowerTitle.includes(term) || lowerUrl.includes(term))) return -200;
  if (LOW_INTENT_TERMS.some((term) => lowerTitle.includes(term) || lowerUrl.includes(term))) return -140;
  if (/\b(best|top)\s+\d+\b/.test(lowerTitle) && /\b(blog|blogs|websites)\b/.test(lowerTitle)) return -145;
  if (/\b(list|directory|roundup)\b/.test(lowerTitle) && /\b(blog|blogs|sites|websites)\b/.test(lowerTitle)) return -130;
  if (/\bpowered by wordpress\b/.test(lowerTitle)) return -135;
  let score = 30;
  if (asciiRatio(`${title} ${url}`) < 0.65) score -= 20;
  if (keywordOverlapCount({ url, title }, keyword) === 0) score -= 40;
  if (/\/(blog|blogs|news|insights)\/?$/.test(lowerUrl)) score -= 20;
  if (/\/(category|tag|archive|author)\//.test(lowerUrl)) return -130;
  if (/\b(top|best)\s*\d+\b/.test(lowerUrl) && /\bblog/.test(lowerUrl)) return -130;

  for (const term of keywordTerms) {
    if (titleSet.has(term)) score += 8;
    if (urlSet.has(term)) score += 4;
  }

  const commentSignals = /(comment|reply|discussion|respond|blog|post)/i;
  const accountSignals = /(account|signup|register|profile|join|member)/i;
  const forumSignals = /(forum|thread|discussion|board|topic)/i;
  const writeSignals = /(write for us|guest post|contribute|submit post)/i;

  if (intent === "comment") {
    const hasCommentSignal = commentSignals.test(lowerTitle) || commentSignals.test(lowerUrl);
    if (!hasCommentSignal) score -= 35;
    if (commentSignals.test(lowerTitle)) score += 14;
    if (commentSignals.test(lowerUrl)) score += 10;
    const keywordMatchCount = keywordTerms.filter((term) => titleSet.has(term) || urlSet.has(term)).length;
    if (keywordTerms.length && keywordMatchCount === 0) score -= 20;
  } else if (intent === "accounts") {
    const hasAccountSignal = accountSignals.test(lowerTitle) || accountSignals.test(lowerUrl);
    if (!hasAccountSignal) return -95;
    if (accountSignals.test(lowerTitle)) score += 10;
    if (accountSignals.test(lowerUrl)) score += 8;
    if (!/\bblog\b/.test(lowerTitle) && !/\bblog\b/.test(lowerUrl)) return -90;
    const keywordMatchCount = keywordTerms.filter((term) => titleSet.has(term) || urlSet.has(term)).length;
    if (keywordTerms.length && keywordMatchCount === 0) return -90;
  } else if (intent === "forum") {
    const hasForumSignal = forumSignals.test(lowerTitle) || forumSignals.test(lowerUrl);
    if (!hasForumSignal) return -95;
    if (forumSignals.test(lowerTitle)) score += 10;
    if (forumSignals.test(lowerUrl)) score += 8;
  } else if (intent === "write_for_us") {
    const hasWriteSignal = writeSignals.test(lowerTitle) || writeSignals.test(lowerUrl);
    if (!hasWriteSignal) return -95;
    if (writeSignals.test(lowerTitle)) score += 10;
    if (writeSignals.test(lowerUrl)) score += 8;
  }

  if (TRUSTED_TLDS.some((tld) => lowerDomain.endsWith(tld))) score += 8;

  const pathDepth = lowerUrl.split("/").filter(Boolean).length;
  if (pathDepth >= 8) score -= 8;
  if ((lowerUrl.match(/[0-9]/g) || []).length >= 10) score -= 8;
  if ((lowerUrl.match(/-/g) || []).length >= 8) score -= 5;
  if (asciiRatio(`${title} ${url}`) < 0.65) score -= 12;
  if (lowerTitle.length < 6) score -= 6;
  if (lowerDomain.length > 35) score -= 5;
  if (keywordTerms.length > 0) {
    const matches = keywordTerms.filter((term) => titleSet.has(term) || urlSet.has(term)).length;
    if (matches === 0) score -= 14;
    else if (matches >= Math.min(2, keywordTerms.length)) score += 8;
  }

  return score;
}

async function hasCommentFormSignals(context, url, cache) {
  const key = String(url || "").trim();
  if (!key) return false;
  if (cache.has(key)) return Boolean(cache.get(key));
  try {
    const res = await context.request.get(key, { timeout: 15000, failOnStatusCode: false });
    if (!res || !res.ok()) {
      cache.set(key, false);
      return false;
    }
    const body = String(await res.text()).toLowerCase();
    if (!body || body.length < 200) {
      cache.set(key, false);
      return false;
    }

    if (/(comments are closed|commenting has been turned off|comment is closed)/i.test(body)) {
      cache.set(key, false);
      return false;
    }

    const hasCommentField = /(name=["']comment["']|id=["']comment["']|class=["'][^"']*comment-form|id=["']respond["'])/i.test(body);
    const hasSubmitAction = /(post comment|submit comment|leave a reply|wp-comments-post\.php|type=["']submit["'][^>]{0,160}(comment|reply))/i.test(body);
    const hasAuthorField = /(name=["']author["']|name=["']email["'])/i.test(body);
    const ok = hasCommentField && (hasSubmitAction || hasAuthorField);
    cache.set(key, ok);
    return ok;
  } catch (_) {
    cache.set(key, false);
    return false;
  }
}

function looksLikeCommentPage(candidate = {}) {
  const hay = `${String(candidate?.url || "").toLowerCase()} ${String(candidate?.title || "").toLowerCase()}`;
  if (/\b(crossword|solver|meaning|grammar|generator|checker)\b/.test(hay)) return false;
  if (SPAM_TERMS.some((term) => hay.includes(term))) return false;
  return /(comment|comments|reply|leave a reply|post comment|respond|#comment|comment-form)/i.test(hay);
}

function isRelaxedCommentCandidate(candidate = {}) {
  const hay = `${String(candidate?.url || "").toLowerCase()} ${String(candidate?.title || "").toLowerCase()} ${String(candidate?.query || "").toLowerCase()}`;
  if (LOW_INTENT_TERMS.some((term) => hay.includes(term))) return false;
  if (SPAM_TERMS.some((term) => hay.includes(term))) return false;
  if (/\b(crossword|solver|meaning|grammar|generator|checker|baidu|zhidao)\b/.test(hay)) return false;
  return /(\bblog\b|\/blog\/|\/post\/|\/article\/|leave a reply|post comment|add comment|comments?\b)/i.test(hay);
}

async function hasRenderedCommentSignals(context, page, url, cache) {
  const key = `render:${String(url || "").trim()}`;
  if (!url) return false;
  if (cache.has(key)) return Boolean(cache.get(key));
  try {
    const verifyPage = page || await context.newPage();
    await verifyPage.goto(String(url), { waitUntil: "domcontentloaded", timeout: 30000 });
    await verifyPage.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
    const found = await verifyPage.evaluate(() => {
      const visible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 2 && r.height > 2;
      };
      const hasTextarea = Array.from(document.querySelectorAll(
        "textarea#comment, textarea[name='comment'], textarea[name*='comment' i], #commentform textarea, .comment-form textarea, #respond textarea"
      )).some((el) => visible(el));
      const hasForm = Boolean(document.querySelector("form#commentform, #respond form, form[action*='comment' i], form[class*='comment' i]"));
      const hasSubmit = Array.from(document.querySelectorAll("button, input[type='submit'], a")).some((el) => {
        if (!visible(el)) return false;
        const text = String(el.textContent || el.getAttribute("value") || "").toLowerCase();
        return /(post comment|submit comment|leave a reply|reply|comment)/.test(text);
      });
      const body = String(document.body?.innerText || "").toLowerCase();
      const hasCommentCopy = /(leave a reply|leave a comment|post comment|add comment|write a comment|comments?\s*\(|\d+\s+comments?)/.test(body);
      const authToComment = /(sign in with google|sign in to comment|log in to comment|to leave a comment, click)/.test(body);
      const hasCommentSectionCopy = /(leave a reply|leave a comment|post comment|add comment|write a comment|comments?)/.test(body);
      return (hasTextarea && (hasForm || hasSubmit || hasCommentCopy)) || (hasCommentSectionCopy && (hasForm || hasSubmit)) || authToComment;
    }).catch(() => false);
    cache.set(key, Boolean(found));
    if (!page) {
      await verifyPage.close().catch(() => {});
    }
    return Boolean(found);
  } catch (_) {
    cache.set(key, false);
    return false;
  }
}

function randomBetween(min, max) {
  const lo = Math.min(Number(min || 0), Number(max || 0));
  const hi = Math.max(Number(min || 0), Number(max || 0));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function buildFallbackQueries(baseQuery, keyword, templateIntent) {
  const base = String(baseQuery || "").trim();
  const kw = String(keyword || "").trim();
  const out = [];
  const push = (q) => {
    const qq = String(q || "").trim().replace(/\s+/g, " ");
    if (!qq) return;
    if (!out.some((x) => x.toLowerCase() === qq.toLowerCase())) out.push(qq);
  };

  push(base);
  if (templateIntent !== "comment") return out;

  // Keep the same keyword intent, but suppress common noisy SERP buckets.
  push(`${base} -crossword -solver -meaning -definition -grammar -generator -checker -wordplays`);
  push(`inurl:blog ${kw} "leave a reply" -"powered by wordpress" -crossword -solver -wordplays`);
  push(`inurl:blog ${kw} "post comment" -crossword -solver -wordplays`);
  push(`${kw} "leave a comment" -crossword -solver -wordplays`);
  push(`${kw} "post comment" -crossword -solver -wordplays`);
  push(`${kw} "leave a reply" blog -crossword -solver -wordplays`);
  push(`inurl:blog ${kw} -crossword -solver -wordplays`);
  push(`${kw} "comments" blog -crossword -solver -wordplays`);
  return out;
}

function resolveBrowserLaunchOptions(headless = false) {
  const explicitPath = String(process.env.PLAYWRIGHT_EXECUTABLE_PATH || "").trim();
  const candidates = [
    explicitPath,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);

  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) {
        return {
          headless: Boolean(headless),
          executablePath: bin,
          args: ["--disable-blink-features=AutomationControlled"],
        };
      }
    } catch (_) {
      // continue
    }
  }
  return { headless: Boolean(headless), args: ["--disable-blink-features=AutomationControlled"] };
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = process.cwd();
const storageRoot = path.join(projectRoot, "storage");
const runsRoot = path.join(projectRoot, "runs");
const finderStorePath = path.join(storageRoot, "backlink_finder_results.json");

function readStore() {
  const data = readJson(finderStorePath, { runs: [] });
  if (!Array.isArray(data?.runs)) return { runs: [] };
  return data;
}

function writeStore(data) {
  writeJson(finderStorePath, { runs: Array.isArray(data?.runs) ? data.runs : [] });
}

function patchRun(runId, mutate) {
  const store = readStore();
  const idx = store.runs.findIndex((item) => String(item?.run_id || "") === String(runId || ""));
  if (idx < 0) return null;
  const current = store.runs[idx] || {};
  const next = typeof mutate === "function" ? mutate(current) : { ...current, ...(mutate || {}) };
  store.runs[idx] = next;
  writeStore(store);
  return next;
}

function detectVerificationSignals(text = "") {
  const lower = String(text || "").toLowerCase();
  const signals = [
    "verify you are human",
    "prove you are human",
    "unusual traffic",
    "automated queries",
    "captcha",
    "detected unusual",
    "attention required",
    "are you a robot",
  ];
  return signals.some((word) => lower.includes(word));
}

async function collectDuckDuckGo(page, query, maxResults, seenUrls) {
  const out = [];
  let noGrowthStreak = 0;
  let offset = 0;
  const maxPages = 40;
  let triedWebFallback = false;

  for (let pageNum = 0; pageNum < maxPages; pageNum += 1) {
    if (out.length >= maxResults) break;
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&s=${offset}&kl=uk-en`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (detectVerificationSignals(bodyText)) {
      return { blocked: true, results: out };
    }

    const pageData = await page.evaluate(() => {
      const rows = [];
      const nodes = document.querySelectorAll(".result, .web-result, .result__body, .results_links, .result__content");
      for (const node of nodes) {
        const link = node.querySelector("a.result__a, h2 a, a[data-testid='result-title-a'], .result__title a");
        if (!link) continue;
        const href = String(link.getAttribute("href") || "").trim();
        const title = String((link.textContent || "").trim());
        rows.push({ href, title });
      }
      if (!rows.length) {
        const fallbackLinks = document.querySelectorAll("a.result__a, .result__title a, .result-title a, h2 a");
        for (const link of fallbackLinks) {
          rows.push({
            href: String(link.getAttribute("href") || "").trim(),
            title: String((link.textContent || "").trim()),
          });
        }
      }
      const noResult = Boolean(document.querySelector(".result--no-result, .no-results, .no-results__message"));
      return { rows, noResult };
    }).catch(() => ({ rows: [], noResult: false }));
    const items = Array.isArray(pageData?.rows) ? pageData.rows : [];

    const beforeCount = out.length;
    for (const item of items) {
      const decoded = decodeDdgHref(item?.href || "");
      const normalized = normalizeUrl(decoded);
      if (!normalized) continue;
      const domain = normalizeDomain(normalized);
      if (!domain) continue;
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      out.push({ url: normalized, title: String(item?.title || "").trim(), domain });
      if (out.length >= maxResults) break;
    }

    if (out.length === beforeCount) {
      noGrowthStreak += 1;
    } else {
      noGrowthStreak = 0;
    }

    if (!items.length && pageData?.noResult && !triedWebFallback) {
      triedWebFallback = true;
      const webUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}&kl=uk-en&ia=web`;
      await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      const webItems = await page.evaluate(() => {
        const rows = [];
        const nodes = document.querySelectorAll(
          "article[data-testid='result'], .react-results--main article, .result, .wLL07_0Xnd1QZpzpfR4W"
        );
        for (const node of nodes) {
          const link = node.querySelector("a[data-testid='result-title-a'], h2 a, a[href^='http']");
          if (!link) continue;
          rows.push({
            href: String(link.getAttribute("href") || "").trim(),
            title: String((link.textContent || "").trim()),
          });
        }
        if (!rows.length) {
          const links = document.querySelectorAll("a[data-testid='result-title-a'], h2 a");
          for (const link of links) {
            rows.push({
              href: String(link.getAttribute("href") || "").trim(),
              title: String((link.textContent || "").trim()),
            });
          }
        }
        return rows;
      }).catch(() => []);
      for (const item of webItems) {
        const decoded = decodeDdgHref(item?.href || "");
        const normalized = normalizeUrl(decoded);
        if (!normalized) continue;
        const domain = normalizeDomain(normalized);
        if (!domain) continue;
        if (seenUrls.has(normalized)) continue;
        seenUrls.add(normalized);
        out.push({ url: normalized, title: String(item?.title || "").trim(), domain });
        if (out.length >= maxResults) break;
      }
    }

    if (noGrowthStreak >= 3) break;
    offset += 30;
  }

  return { blocked: false, results: out };
}

async function collectBing(page, query, maxResults, seenUrls) {
  const out = [];
  const pages = [1, 11, 21, 31, 41, 51, 61, 71, 81, 91];

  for (const first of pages) {
    if (out.length >= maxResults) break;
    const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=50&first=${first}&setlang=en-US&cc=GB&ensearch=1`;
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const bodyText = await page.locator("body").innerText().catch(() => "");
    if (detectVerificationSignals(bodyText)) {
      return { blocked: true, results: out };
    }

    const items = await page.evaluate(() => {
      const rows = [];
      const nodes = document.querySelectorAll(
        "li.b_algo h2 a, #b_results li h2 a, #b_results h2 a, .b_algo h2 a, a.tilk, .algo h2 a"
      );
      for (const link of nodes) {
        const href = String(link.getAttribute("href") || "").trim();
        if (!href) continue;
        rows.push({
          href,
          title: String((link.textContent || "").trim()),
        });
      }
      return rows;
    }).catch(() => []);

    for (const item of items) {
      const resolvedHref = decodeBingHref(item?.href || "");
      const normalized = normalizeUrl(resolvedHref);
      if (!normalized) continue;
      const domain = normalizeDomain(normalized);
      if (!domain) continue;
      if (domain === "bing.com" || domain.endsWith(".bing.com")) continue;
      if (seenUrls.has(normalized)) continue;
      seenUrls.add(normalized);
      out.push({ url: normalized, title: String(item?.title || "").trim(), domain });
      if (out.length >= maxResults) break;
    }
  }

  return { blocked: false, results: out };
}

async function withRetry(task, retries = 3, baseDelay = 1200) {
  let lastErr = null;
  for (let i = 0; i < retries; i += 1) {
    try {
      return await task(i + 1);
    } catch (err) {
      lastErr = err;
      await sleep(baseDelay * (i + 1));
    }
  }
  throw lastErr || new Error("Operation failed");
}

async function captureArtifacts(page, runId, meta = {}) {
  const dir = path.join(runsRoot, `finder-${runId}`);
  ensureDir(dir);
  const stamp = Date.now();
  const screenshotPath = path.join(dir, `artifact-${stamp}.png`);
  const htmlPath = path.join(dir, `artifact-${stamp}.html`);
  const metaPath = path.join(dir, `artifact-${stamp}.json`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  fs.writeFileSync(htmlPath, html, "utf8");
  writeJson(metaPath, {
    run_id: runId,
    captured_at: nowIso(),
    url: page.url(),
    ...meta,
  });

  return [screenshotPath, htmlPath, metaPath];
}

// ─── OpenCrawl-powered helpers ────────────────────────────────────────────────

function detectOpportunityType(url = "", title = "", html = "") {
  const lUrl = String(url || "").toLowerCase();
  const lTitle = String(title || "").toLowerCase();
  const lHtml = String(html || "").slice(0, 8000).toLowerCase();
  const hay = `${lUrl} ${lTitle}`;

  if (/(write.for.us|guest.post|submit.a.post|contribute.to|become.a.contributor)/i.test(hay)) return "write_for_us";
  if (/(\/forum\/|\/forums\/|\/thread\/|\/board\/|\/topic\/|phpbb|vbulletin|xenforo|discourse)/i.test(lUrl)) return "forum";
  if (/(\/resources\/|\/resource-page|\/useful-links|\/recommended|\/partners\/|\/links\/)/i.test(lUrl)) return "resource_page";
  if (/(\/directory\/|\/listing\/|\/business-directory|\/bizdir|\/yellowpages|\/citations?\/)/i.test(lUrl)) return "directory";

  // HTML-level signals (if page was fetched)
  if (lHtml) {
    if (/(write for us|guest post|submit.{0,20}article|contributor guidelines)/i.test(lHtml)) return "write_for_us";
    if (/(resource page|useful links|recommended (sites|resources|links))/i.test(lHtml)) return "resource_page";
    if (/(name=["']comment["']|id=["']comment["']|id=["']respond["']|class=["'][^"']*comment-form)/i.test(lHtml)) return "blog_comment";
  }

  if (/(\/blog\/|\/post\/|\/article\/|\/news\/|\/p\/[0-9])/i.test(lUrl)) return "blog_comment";
  return "general";
}

function estimateDomainAuthority(domain = "", html = "") {
  let score = 20;
  const d = String(domain || "").toLowerCase();

  // TLD-based signals
  if (d.endsWith(".edu")) score += 40;
  else if (d.endsWith(".gov")) score += 35;
  else if (d.endsWith(".org")) score += 15;
  else if (d.endsWith(".com") || d.endsWith(".net")) score += 10;
  else if (d.endsWith(".io") || d.endsWith(".co")) score += 6;

  // Domain name quality
  const bare = d.replace(/^www\./, "").split(".")[0];
  if (bare.length >= 4 && bare.length <= 14) score += 5;
  if (/^[a-z0-9]+$/.test(bare)) score += 4; // no hyphens = cleaner brand

  // HTML signals
  if (html) {
    const lHtml = String(html).slice(0, 15000).toLowerCase();
    if (html.length > 80000) score += 8;
    else if (html.length > 30000) score += 4;
    if (/(twitter\.com|facebook\.com|linkedin\.com|instagram\.com)/.test(lHtml)) score += 3;
    if (/wp-content|\/wp-includes/.test(lHtml)) score += 4; // WordPress = established
    if (/schema\.org|og:title|og:description/.test(lHtml)) score += 3; // structured data
    if (/disqus|intensedebate|livefyre/.test(lHtml)) score += 2; // 3rd party comments
  }

  return Math.min(100, Math.max(0, score));
}

function extractCommentFormSignals(html = "") {
  if (!html) {
    return {
      hasCommentForm: false, hasAuthorField: false, hasEmailField: false,
      hasUrlField: false, hasSubmitButton: false, commentsClosed: false, isDoFollow: true,
    };
  }
  const commentsClosed = /(comments are closed|commenting has been turned off|comment is closed|comments? disabled)/i.test(html);
  const hasCommentForm = /(name=["']comment["']|id=["']comment["']|class=["'][^"']{0,60}comment-form|id=["']respond["'])/i.test(html);
  const hasAuthorField = /name=["']author["']/i.test(html);
  const hasEmailField = /name=["']email["']/i.test(html);
  const hasUrlField = /name=["']url["']|name=["']website["']|name=["']homepage["']/i.test(html);
  const hasSubmitButton = /(post comment|submit comment|leave a reply|add comment|type=["']submit["'][^>]{0,120}(comment|reply))/i.test(html);
  // If there's NO nofollow on comment links, treat as dofollow opportunity
  const noFollowComments = /rel=["'][^"']*nofollow[^"']*["'][^>]{0,80}(comment|reply)|comment[^>]{0,80}rel=["'][^"']*nofollow/i.test(html);
  return { hasCommentForm, hasAuthorField, hasEmailField, hasUrlField, hasSubmitButton, commentsClosed, isDoFollow: !noFollowComments };
}

async function collectOpenCrawl(keyword, templates, limit, alreadySeen, apiUrl) {
  const results = [];
  if (!apiUrl) return results;

  // Build diverse queries from templates + keyword variants
  const queries = new Set();
  for (const tpl of templates.slice(0, 5)) {
    const q = tpl.includes("{keyword}") ? tpl.replaceAll("{keyword}", keyword) : `${tpl} ${keyword}`;
    queries.add(String(q).trim());
  }
  // High-value direct queries
  queries.add(keyword);
  queries.add(`${keyword} blog`);
  queries.add(`${keyword} "leave a reply"`);
  queries.add(`${keyword} "write for us"`);
  queries.add(`${keyword} "guest post"`);
  queries.add(`${keyword} resource page`);
  queries.add(`${keyword} inurl:blog`);

  const seen = new Set([...alreadySeen]);

  for (const query of queries) {
    if (results.length >= limit * 2) break;
    try {
      const resp = await fetchOpenCrawlSearch({ query, limit: Math.min(60, limit * 2), apiUrl, timeoutMs: 18000 });
      if (!resp?.ok || !Array.isArray(resp.items) || !resp.items.length) continue;

      for (const item of resp.items) {
        const normalized = normalizeUrl(item.url || "");
        if (!normalized || seen.has(normalized)) continue;
        const domain = normalizeDomain(normalized);
        if (!domain || isBlockedDomain(domain)) continue;

        const score = qualityScore({ url: normalized, domain, title: String(item.title || ""), keyword, query });
        if (score < -80) continue; // filter extreme spam only, OpenCrawl data is usually cleaner

        seen.add(normalized);
        const opportunityType = detectOpportunityType(normalized, String(item.title || ""));
        results.push({
          url: normalized,
          domain,
          title: String(item.title || "").trim(),
          snippet: String(item.snippet || "").trim(),
          score,
          query,
          engine: "opencrawl",
          intent: opportunityType,
          opportunity_type: opportunityType,
          discovered_at: item.discovered_at || null,
          source: "opencrawl_search",
        });
      }
    } catch (_) {
      // OpenCrawl query failed, skip to next query
    }
  }

  // Sort by score descending before returning
  return results.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

async function enrichCandidateViaOpenCrawl(candidate, signalCache, apiUrl) {
  if (!apiUrl || !candidate?.url) return null;

  const cacheKey = `oc_page:${candidate.url}`;
  if (signalCache.has(cacheKey)) return signalCache.get(cacheKey);

  try {
    const resp = await fetchOpenCrawlPage({ url: candidate.url, apiUrl, timeoutMs: 15000 });
    if (!resp?.ok || !resp.html) {
      signalCache.set(cacheKey, null);
      return null;
    }

    const signals = extractCommentFormSignals(resp.html);
    const daEstimate = estimateDomainAuthority(String(candidate.domain || ""), resp.html);
    const opportunityType = detectOpportunityType(candidate.url, String(candidate.title || ""), resp.html);

    const enrichment = {
      has_comment_form: signals.hasCommentForm && !signals.commentsClosed,
      has_author_field: signals.hasAuthorField,
      has_email_field: signals.hasEmailField,
      has_url_field: signals.hasUrlField,
      has_submit_button: signals.hasSubmitButton,
      comments_closed: signals.commentsClosed,
      is_dofollow: signals.isDoFollow,
      da_estimate: daEstimate,
      opportunity_type: opportunityType,
      page_verified: true,
      verified_via: "opencrawl",
    };

    signalCache.set(cacheKey, enrichment);
    return enrichment;
  } catch (_) {
    signalCache.set(cacheKey, null);
    return null;
  }
}

// Unified signal check: tries OpenCrawl page fetch first (fast), falls back to Playwright.
// Also mutates candidate in-place with enrichment data if OpenCrawl succeeds.
async function checkPageSignals(context, verifyPage, candidate, signalCache, openCrawlApiUrl) {
  // 1. Try OpenCrawl page fetch (no browser needed, much faster)
  if (openCrawlApiUrl && candidate?.url) {
    const enrichment = await enrichCandidateViaOpenCrawl(candidate, signalCache, openCrawlApiUrl);
    if (enrichment !== null) {
      // Apply enrichment to candidate
      Object.assign(candidate, enrichment);
      if (enrichment.comments_closed) return false;
      if (enrichment.has_comment_form) return true;
      // OpenCrawl returned data but no comment form found - trust it
      return false;
    }
    // null means OpenCrawl fetch failed - fall through to Playwright
  }

  // 2. Fallback: Playwright HTTP request check (fast, no render)
  const hasSignals = await hasCommentFormSignals(context, candidate.url, signalCache);
  if (hasSignals) return true;

  // 3. Fallback: Playwright full render check (slow but thorough)
  return hasRenderedCommentSignals(context, verifyPage, candidate.url, signalCache);
}

function buildLinkRow(runId, counter, candidate, keyword) {
  return {
    id: `${runId}-${counter}`,
    keyword: String(keyword || ""),
    query: String(candidate.query || ""),
    url: String(candidate.url || ""),
    domain: String(candidate.domain || normalizeDomain(candidate.url || "")),
    title: String(candidate.title || ""),
    engine: String(candidate.engine || ""),
    quality_score: Number(candidate.score || 0),
    opportunity_type: String(candidate.opportunity_type || candidate.intent || detectOpportunityType(candidate.url || "", candidate.title || "")),
    has_comment_form: Boolean(candidate.has_comment_form),
    has_url_field: Boolean(candidate.has_url_field),
    is_dofollow: candidate.is_dofollow !== false, // default true when unknown
    da_estimate: Number(candidate.da_estimate || 0),
    page_verified: Boolean(candidate.page_verified),
    verified_via: String(candidate.verified_via || ""),
    source: String(candidate.source || candidate.engine || ""),
    collected_at: nowIso(),
    status: "new",
  };
}

async function run() {
  const runId = String(args["run-id"] || "").trim();
  const inputFile = String(args["input-file"] || "").trim();

  if (!runId || !inputFile) {
    throw new Error("run-id and input-file are required");
  }

  const payload = readJson(inputFile, null);
  if (!payload) {
    throw new Error("Input payload not found");
  }

  const keywords = Array.isArray(payload.keywords) ? payload.keywords.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const templates = Array.isArray(payload.templates) ? payload.templates.map((v) => String(v || "").trim()).filter(Boolean) : [];
  const engine = String(payload.engine || "bing").trim().toLowerCase() === "duckduckgo" ? "duckduckgo" : "bing";
  const allowEngineFallback = payload?.options?.allow_engine_fallback !== false;
  const minDelayMs = Math.max(0, Number(payload.options?.min_delay_ms || 0));
  const maxDelayMs = Math.max(minDelayMs, Number(payload.options?.max_delay_ms || 0));
  const headless = Boolean(payload.options?.headless);
  const effectiveHeadless = engine === "duckduckgo" ? false : headless;
  const perKeywordLimit = Math.max(1, Math.min(100, Number(payload.options?.results_per_keyword || 50)));
  const includeAllSites = payload?.options?.include_all_sites !== false;
  const minQualityScore = Number(payload?.options?.min_quality_score ?? (includeAllSites ? 0 : 5));
  const openCrawlApiUrl = String(process.env.OPENCRAWL_API_URL || payload?.options?.opencrawl_api_url || "").trim();
  const useOpenCrawl = Boolean(openCrawlApiUrl);

  let browser = null;
  let context = null;
  let page = null;
  let verifyPage = null;
  let pendingVerification = false;
  const artifacts = [];

  patchRun(runId, (current) => ({
    ...current,
    status: "running",
    summary: "collecting_links",
    effective_headless: effectiveHeadless,
    current_keyword_index: 0,
    current_keyword: "",
    updated_at: nowIso(),
  }));

  try {
    browser = await chromium.launch(resolveBrowserLaunchOptions(effectiveHeadless));
    context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      timezoneId: "America/New_York",
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    });
    page = await context.newPage();
    verifyPage = await context.newPage();

    const allLinks = [];
    const globalSeen = new Set();
    const signalCache = new Map();
    let linkIdCounter = 1;

    for (let keywordIndex = 0; keywordIndex < keywords.length; keywordIndex += 1) {
      const keyword = keywords[keywordIndex];
      const keywordLinks = [];
      const keywordSeen = new Set();
      const keywordCandidates = [];
      const keywordCandidateSeen = new Set();
      const preferredEngines = allowEngineFallback
        ? (engine === "duckduckgo" ? ["duckduckgo", "bing"] : ["bing", "duckduckgo"])
        : [engine];

      patchRun(runId, (current) => ({
        ...current,
        updated_at: nowIso(),
        status: "running",
        current_keyword_index: keywordIndex + 1,
        current_keyword: keyword,
        summary: `running_keyword:${keyword}`,
      }));

      // ── OpenCrawl primary collection (no browser needed) ──────────────────
      if (useOpenCrawl) {
        try {
          const ocResults = await collectOpenCrawl(keyword, templates, perKeywordLimit * 2, keywordSeen, openCrawlApiUrl);
          for (const item of ocResults) {
            if (globalSeen.has(item.url) || keywordCandidateSeen.has(item.url)) continue;
            keywordCandidateSeen.add(item.url);
            keywordSeen.add(item.url);
            keywordCandidates.push(item);
          }
          patchRun(runId, (current) => ({
            ...current,
            updated_at: nowIso(),
            summary: `opencrawl_collected:${keywordCandidates.length}:${keyword}`,
          }));
        } catch (_) {
          // OpenCrawl failed - fall through to browser-based engines
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      for (const template of templates) {
        if (keywordLinks.length >= perKeywordLimit) break;

        const rawQuery = template.includes("{keyword}") ? template.replaceAll("{keyword}", keyword) : `${template} ${keyword}`;
        const baseQuery = String(rawQuery || "").trim();
        const templateIntent = detectIntent(template, template);
        const fallbackQueries = buildFallbackQueries(baseQuery, keyword, templateIntent);

        const seenQueries = new Set();
        for (const query of fallbackQueries) {
          const queryText = String(query || "").trim();
          if (!queryText || seenQueries.has(queryText.toLowerCase())) continue;
          seenQueries.add(queryText.toLowerCase());
          if (keywordLinks.length >= perKeywordLimit) break;

          for (const currentEngine of preferredEngines) {
            if (keywordLinks.length >= perKeywordLimit) break;

            const remaining = perKeywordLimit - keywordLinks.length;
            const result = await withRetry(async () => {
              if (currentEngine === "duckduckgo") {
                return collectDuckDuckGo(page, queryText, remaining, keywordSeen);
              }
              return collectBing(page, queryText, remaining, keywordSeen);
            }, 2, 250);

            if (result.blocked) {
              pendingVerification = true;
              const cap = await captureArtifacts(page, runId, {
                type: "pending_verification",
                reason: `verification_detected_for_query:${queryText}`,
                keyword,
                query: queryText,
                engine: currentEngine,
              });
              artifacts.push(...cap);
              break;
            }

            const collected = Array.isArray(result.results) ? result.results : [];
            for (const item of collected) {
              const normalized = normalizeUrl(item?.url || "");
              if (!normalized) continue;
              if (globalSeen.has(normalized)) continue;
              if (keywordCandidateSeen.has(normalized)) continue;

              const domain = String(item?.domain || normalizeDomain(normalized));
              const title = String(item?.title || "").trim();
              if (!includeAllSites && keywordOverlapCount({ url: normalized, title }, keyword) === 0) continue;
              const score = qualityScore({
                url: normalized,
                domain,
                title,
                keyword,
                query: queryText,
              });
              if (!Number.isFinite(score) || score < minQualityScore) continue;

              keywordCandidateSeen.add(normalized);
              const effectiveIntent = templateIntent === "general" ? detectIntent(queryText, template) : templateIntent;
              keywordCandidates.push({
                url: normalized,
                domain,
                title,
                score,
                query: queryText,
                engine: currentEngine,
                intent: effectiveIntent,
              });
            }

            // If this engine produced enough fresh URLs, move to next query.
            if (collected.length >= remaining) break;
          }

          if (pendingVerification) break;
        }

        if (pendingVerification) break;

        if (maxDelayMs > 0) {
          await sleep(randomBetween(minDelayMs, maxDelayMs));
        }
      }

      const sortedCandidates = keywordCandidates
        .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
      const thresholds = includeAllSites ? [-9999] : [24, 16, 10, 6, 0];
      const perDomainCount = new Map();
      for (const threshold of thresholds) {
        for (const candidate of sortedCandidates) {
          if (keywordLinks.length >= perKeywordLimit) break;
          if (globalSeen.has(candidate.url)) continue;
          if (Number(candidate.score || 0) < Math.max(threshold, minQualityScore)) continue;

          const hostKey = String(candidate.domain || "");
          const currentDomainCount = Number(perDomainCount.get(hostKey) || 0);
          if (!includeAllSites && currentDomainCount >= 2) continue;

          const candidateIntent = String(candidate.intent || detectIntent(candidate.query || ""));
          if (!includeAllSites && candidateIntent === "comment") {
            const hasPageSignals = await checkPageSignals(context, verifyPage, candidate, signalCache, openCrawlApiUrl);
            if (!hasPageSignals) continue;
          }
          if (!includeAllSites && keywordOverlapCount(candidate, keyword) === 0) continue;

          globalSeen.add(candidate.url);
          perDomainCount.set(hostKey, currentDomainCount + 1);
          const linkRow = buildLinkRow(runId, linkIdCounter++, candidate, keyword);
          keywordLinks.push(linkRow);
          allLinks.push(linkRow);
        }
        if (keywordLinks.length >= perKeywordLimit) break;
      }

      // Soft fallback: if strict form-signal validation produced zero links,
      // allow top comment-like candidates only when comment-form signals exist.
      if (!keywordLinks.length) {
        for (const candidate of sortedCandidates) {
          if (keywordLinks.length >= perKeywordLimit) break;
          if (globalSeen.has(candidate.url)) continue;
          if (Number(candidate.score || 0) < Math.max(18, minQualityScore)) continue;
          const hostKey = String(candidate.domain || "");
          const currentDomainCount = Number(perDomainCount.get(hostKey) || 0);
          if (!includeAllSites && currentDomainCount >= 2) continue;
          if (!looksLikeCommentPage(candidate)) continue;
          const candidateIntent = String(candidate.intent || detectIntent(candidate.query || ""));
          if (!includeAllSites && candidateIntent === "comment") {
            const hasPageSignals = await checkPageSignals(context, verifyPage, candidate, signalCache, openCrawlApiUrl);
            if (!hasPageSignals) continue;
          }
          if (!includeAllSites && keywordOverlapCount(candidate, keyword) === 0) continue;

          globalSeen.add(candidate.url);
          perDomainCount.set(hostKey, currentDomainCount + 1);
          const linkRow = buildLinkRow(runId, linkIdCounter++, candidate, keyword);
          keywordLinks.push(linkRow);
          allLinks.push(linkRow);
        }
      }

      // If still below requested limit, do a controlled fill using same-query candidates only.
      if (keywordLinks.length < perKeywordLimit) {
        for (const candidate of sortedCandidates) {
          if (keywordLinks.length >= perKeywordLimit) break;
          if (globalSeen.has(candidate.url)) continue;
          if (Number(candidate.score || 0) < Math.max(5, minQualityScore)) continue;
          if (!String(candidate.query || "").trim()) continue;

          const hostKey = String(candidate.domain || "");
          const currentDomainCount = Number(perDomainCount.get(hostKey) || 0);
          if (!includeAllSites && currentDomainCount >= 2) continue;
          const candidateIntent = String(candidate.intent || detectIntent(candidate.query || ""));
          if (!includeAllSites && candidateIntent === "comment") {
            const hasPageSignals = await checkPageSignals(context, verifyPage, candidate, signalCache, openCrawlApiUrl);
            if (!hasPageSignals) continue;
          }
          if (!includeAllSites && keywordOverlapCount(candidate, keyword) === 0) continue;

          globalSeen.add(candidate.url);
          perDomainCount.set(hostKey, currentDomainCount + 1);
          const linkRow = buildLinkRow(runId, linkIdCounter++, candidate, keyword);
          keywordLinks.push(linkRow);
          allLinks.push(linkRow);
        }
      }

      // Final relaxed fill for comment intent: keep quality guardrails but avoid hard no-results.
      if (keywordLinks.length < perKeywordLimit) {
        for (const candidate of sortedCandidates) {
          if (keywordLinks.length >= perKeywordLimit) break;
          if (globalSeen.has(candidate.url)) continue;
          if (Number(candidate.score || 0) < minQualityScore) continue;

          const candidateIntent = String(candidate.intent || detectIntent(candidate.query || ""));
          if (!includeAllSites && candidateIntent !== "comment") continue;
          if (!includeAllSites && !isRelaxedCommentCandidate(candidate)) continue;

          const hostKey = String(candidate.domain || "");
          const currentDomainCount = Number(perDomainCount.get(hostKey) || 0);
          if (!includeAllSites && currentDomainCount >= 2) continue;
          if (!includeAllSites && candidateIntent === "comment") {
            const hasPageSignals = await checkPageSignals(context, verifyPage, candidate, signalCache, openCrawlApiUrl);
            if (!hasPageSignals) continue;
          }
          if (!includeAllSites && keywordOverlapCount(candidate, keyword) === 0) continue;

          globalSeen.add(candidate.url);
          perDomainCount.set(hostKey, currentDomainCount + 1);
          const linkRow = buildLinkRow(runId, linkIdCounter++, candidate, keyword);
          keywordLinks.push(linkRow);
          allLinks.push(linkRow);
        }
      }

      // Ultimate fallback: capture visible SERP links with basic safety filters
      // so runs do not end in 0-links when engines return weakly matched results.
      if (keywordLinks.length < perKeywordLimit) {
        for (const candidate of sortedCandidates) {
          if (keywordLinks.length >= perKeywordLimit) break;
          if (globalSeen.has(candidate.url)) continue;
          if (Number(candidate.score || 0) < minQualityScore) continue;
          if (!candidate?.url || !candidate?.domain) continue;
          const hay = `${String(candidate.url || "").toLowerCase()} ${String(candidate.title || "").toLowerCase()}`;
          if (SPAM_TERMS.some((term) => hay.includes(term))) continue;
          if (LOW_INTENT_TERMS.some((term) => hay.includes(term))) continue;
          if (LOW_QUALITY_TLDS.some((tld) => String(candidate.domain || "").endsWith(tld))) continue;
          if (isBlockedDomain(String(candidate.domain || ""))) continue;
          const candidateIntent = String(candidate.intent || detectIntent(candidate.query || ""));
          if (!includeAllSites && candidateIntent === "comment") {
            const hasPageSignals = await checkPageSignals(context, verifyPage, candidate, signalCache, openCrawlApiUrl);
            if (!hasPageSignals) continue;
          }

          const hostKey = String(candidate.domain || "");
          const currentDomainCount = Number(perDomainCount.get(hostKey) || 0);
          if (!includeAllSites && currentDomainCount >= 2) continue;
          if (!includeAllSites && keywordOverlapCount(candidate, keyword) === 0) continue;

          globalSeen.add(candidate.url);
          perDomainCount.set(hostKey, currentDomainCount + 1);
          const linkRow = buildLinkRow(runId, linkIdCounter++, candidate, keyword);
          keywordLinks.push(linkRow);
          allLinks.push(linkRow);
        }
      }

      patchRun(runId, (current) => ({
        ...current,
        updated_at: nowIso(),
        status: pendingVerification ? "pending_verification" : "running",
        current_keyword_index: keywordIndex + 1,
        current_keyword: keyword,
        summary: pendingVerification ? `pending_verification:${keyword}` : `processed_keyword:${keyword}`,
        total_links_collected: allLinks.length,
        links: allLinks,
      }));

      if (pendingVerification) break;
    }

    if (page) {
      const finalArtifacts = await captureArtifacts(page, runId, {
        type: "run_complete",
        status: pendingVerification ? "pending_verification" : "completed",
        total_links: allLinks.length,
      });
      artifacts.push(...finalArtifacts);
    }

    patchRun(runId, (current) => ({
      ...current,
      updated_at: nowIso(),
      status: pendingVerification ? "pending_verification" : (allLinks.length ? "completed" : "no_results"),
      current_keyword_index: keywords.length,
      current_keyword: "",
      summary: pendingVerification ? "verification_checkpoint_detected" : (allLinks.length ? "links_collected" : "no_links_found"),
      total_links_collected: Array.isArray(current.links) ? current.links.length : 0,
      artifacts: [...new Set([...(Array.isArray(current.artifacts) ? current.artifacts : []), ...artifacts])],
    }));
  } catch (err) {
    if (page) {
      const cap = await captureArtifacts(page, runId, {
        type: "run_failed",
        error: String(err?.message || err || "unknown_error"),
      });
      artifacts.push(...cap);
    }

    patchRun(runId, (current) => ({
      ...current,
      updated_at: nowIso(),
      status: "failed",
      current_keyword: "",
      summary: String(err?.message || err || "run_failed"),
      artifacts: [...new Set([...(Array.isArray(current.artifacts) ? current.artifacts : []), ...artifacts])],
    }));

    throw err;
  } finally {
    try {
      await verifyPage?.close();
    } catch (_) {
      // ignore
    }
    try {
      await page?.close();
    } catch (_) {
      // ignore
    }
    try {
      await context?.close();
    } catch (_) {
      // ignore
    }
    try {
      await browser?.close();
    } catch (_) {
      // ignore
    }
  }
}

run().then(() => {
  process.exit(0);
}).catch((err) => {
  console.error("[backlink-finder]", err?.message || err);
  process.exit(1);
});
