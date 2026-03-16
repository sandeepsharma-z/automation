import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { nowIso, sleep } from "./utils.js";
import { requestHumanApproval } from "./approval.js";
import { createBrowserDriver } from "./browser_driver.js";

const DOMAIN_HISTORY_FILE = path.resolve(import.meta.dirname, "..", "storage", "backlink-ops", "domain_comment_history.json");
const MAX_DOMAIN_HISTORY = 120;
const MAX_GLOBAL_HISTORY = 800;
const DOMAIN_SIM_THRESHOLD = Number(process.env.BLOG_COMMENT_DOMAIN_SIM_THRESHOLD || 0.55);
const GLOBAL_SIM_THRESHOLD = Number(process.env.BLOG_COMMENT_GLOBAL_SIM_THRESHOLD || 0.65);
const RELIABILITY_DELAYS = {
  afterNavigationMs: 2000,
  afterScrollMs: 500,
  beforeClickMs: 800,
  afterClickMs: 3000,
  betweenFieldsMs: 300,
};

function logDebugState(logger, { rowKey, siteName, state, selector = "", actionTaken = "", result = "", note = "" }) {
  logger?.log?.({
    row_key: rowKey,
    site_name: siteName,
    action: "debug_state",
    status: result || "info",
    debug_state: String(state || ""),
    selector_found: String(selector || ""),
    action_taken: String(actionTaken || ""),
    result: String(result || ""),
    error_message: String(note || ""),
  });
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

function safeWords(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function normalizeCommentText(text = "") {
  return safeWords(text).join(" ");
}

function hashText(value = "") {
  return crypto.createHash("sha1").update(String(value || "")).digest("hex");
}

function buildShingles(text = "", k = 5) {
  const tokens = safeWords(text);
  if (tokens.length < k) return new Set(tokens.length ? [tokens.join(" ")] : []);
  const out = new Set();
  for (let i = 0; i <= tokens.length - k; i += 1) {
    out.add(tokens.slice(i, i + k).join(" "));
  }
  return out;
}

function jaccard(aSet, bSet) {
  if (!aSet.size || !bSet.size) return 0;
  let inter = 0;
  for (const item of aSet) if (bSet.has(item)) inter += 1;
  return inter / (aSet.size + bSet.size - inter);
}

function levenshteinRatio(a = "", b = "") {
  const s = String(a || "");
  const t = String(b || "");
  if (!s && !t) return 1;
  if (!s || !t) return 0;
  const n = s.length;
  const m = t.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dp[i][0] = i;
  for (let j = 0; j <= m; j += 1) dp[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const dist = dp[n][m];
  return 1 - (dist / Math.max(n, m));
}

function similarityScore(a = "", b = "") {
  const an = normalizeCommentText(a);
  const bn = normalizeCommentText(b);
  if (!an || !bn) return 0;
  const shingleJ = jaccard(buildShingles(an, 5), buildShingles(bn, 5));
  const editR = levenshteinRatio(an.slice(0, 1600), bn.slice(0, 1600));
  return Math.max(shingleJ, editR * 0.9);
}

function loadHistory() {
  const data = readJson(DOMAIN_HISTORY_FILE, { entries: [] });
  if (!Array.isArray(data?.entries)) return { entries: [] };
  return data;
}

function saveHistory(data) {
  writeJson(DOMAIN_HISTORY_FILE, { entries: Array.isArray(data?.entries) ? data.entries : [] });
}

function appendHistory({ domain, url, commentText }) {
  const normalized = normalizeCommentText(commentText);
  if (!normalized) return;
  const history = loadHistory();
  const entry = {
    domain: String(domain || "").toLowerCase(),
    url: String(url || ""),
    created_at: nowIso(),
    comment_text: String(commentText || ""),
    normalized_hash: hashText(normalized),
    shingles_signature: [...buildShingles(normalized, 5)].slice(0, 200),
  };
  history.entries.push(entry);
  history.entries = history.entries.slice(-MAX_GLOBAL_HISTORY);
  saveHistory(history);
}

function historyForDomain(domain = "") {
  const d = String(domain || "").toLowerCase();
  const history = loadHistory();
  const domainEntries = history.entries.filter((e) => String(e.domain || "") === d).slice(-MAX_DOMAIN_HISTORY);
  const globalEntries = history.entries.slice(-MAX_GLOBAL_HISTORY);
  return { domainEntries, globalEntries };
}

function bestSimilarityAgainst(entries = [], text = "") {
  let best = 0;
  for (const item of entries) {
    const score = similarityScore(item?.comment_text || "", text);
    if (score > best) best = score;
  }
  return best;
}

function extractUrlTokens(url = "") {
  try {
    const parsed = new URL(String(url || ""));
    const tokens = parsed.pathname
      .split(/[\/\-_]+/g)
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length >= 3 && !/^\d+$/.test(v));
    return [...new Set(tokens)].slice(0, 6);
  } catch (_) {
    return [];
  }
}

function sentenceSplit(text = "") {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/g)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40);
}

async function collectPageFacts(driver, targetLink) {
  const base = await driver.evaluate(() => {
    const title = String(document.title || "").replace(/\s+/g, " ").trim();
    const meta = String(document.querySelector("meta[name='description']")?.getAttribute("content") || "").replace(/\s+/g, " ").trim();
    const headings = Array.from(document.querySelectorAll("h1, h2"))
      .map((el) => String(el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 8);
    const bodyBlocks = Array.from(document.querySelectorAll("article p, main p, .entry-content p, p"))
      .map((el) => String(el.textContent || "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length >= 40)
      .slice(0, 12);
    return { title, meta, headings, bodyBlocks };
  }).catch(() => ({ title: "", meta: "", headings: [], bodyBlocks: [] }));

  const sentences = [];
  for (const block of base.bodyBlocks || []) {
    for (const s of sentenceSplit(block)) {
      if (sentences.length >= 4) break;
      sentences.push(s);
    }
    if (sentences.length >= 4) break;
  }

  const quoteFragment = (() => {
    const source = sentences[0] || base.headings?.[1] || base.meta || "";
    const tokens = safeWords(source).slice(0, 12);
    return tokens.join(" ");
  })();

  const microDetail = (() => {
    const pool = [...(base.headings || []), ...(sentences || [])].join(" ");
    const num = pool.match(/\b\d+(?:\.\d+)?\b/);
    if (num) return num[0];
    const cap = pool.match(/\b[A-Z][a-zA-Z]{2,}\b/);
    if (cap) return cap[0];
    return (extractUrlTokens(targetLink)[0] || "").slice(0, 24);
  })();

  return {
    title: String(base.title || "").trim(),
    meta: String(base.meta || "").trim(),
    headings: Array.isArray(base.headings) ? base.headings.slice(0, 8) : [],
    key_sentences: sentences,
    quote_fragment: quoteFragment,
    slug_tokens: extractUrlTokens(targetLink),
    micro_detail: String(microDetail || "").trim(),
  };
}

function buildGroundedDraft({ facts, variant = 0, forcePhrase = false }) {
  const heading = String(facts.headings?.[0] || facts.title || "this article").trim();
  const heading2 = String(facts.headings?.[1] || facts.key_sentences?.[0] || "").trim();
  const key1 = String(facts.key_sentences?.[0] || facts.meta || "").trim();
  const key2 = String(facts.key_sentences?.[1] || "").trim();
  const salt = String(facts.micro_detail || facts.slug_tokens?.[0] || "").trim();
  const quote = String(facts.quote_fragment || "").trim();

  const opinions = [
    "My take is that this approach is practical because it balances clarity with execution.",
    "In my opinion, this works well because the structure makes implementation less error-prone.",
    "I feel this is stronger than generic advice because the steps are concrete and testable.",
  ];
  const questions = [
    "If someone starts today, what would you prioritize first and why?",
    "Would you adjust this flow for a small team versus a solo operator?",
    "What signal tells you this method is working in the first week?",
  ];

  const lines = [];
  lines.push(`I read your post on "${heading}" and found it genuinely useful.`);
  if (heading2) lines.push(`The part around "${heading2}" gave a clear direction.`);
  if (key1) lines.push(`One specific point that stood out was: ${key1.slice(0, 180)}.`);
  if (key2) lines.push(`Another detail I noted was ${key2.slice(0, 170)}.`);
  if (salt) lines.push(`That micro-detail around "${salt}" made the explanation feel grounded.`);
  if (forcePhrase && quote) lines.push(`I also liked the phrase "${quote}" because it captures the intent clearly.`);
  lines.push(opinions[variant % opinions.length]);
  lines.push(questions[variant % questions.length]);
  lines.push("Thanks for sharing such a clear breakdown with real context.");

  let text = lines.join(" ").replace(/\s+/g, " ").trim();
  let tokens = safeWords(text);
  if (tokens.length < 60) {
    text = `${text} I am saving this as a reference for future implementation reviews because it is easier to apply than generic summaries.`;
    tokens = safeWords(text);
  }
  if (tokens.length > 120) {
    text = tokens.slice(0, 120).join(" ");
  }

  const mustPhrase = heading2 || key1 || facts.slug_tokens?.[0] || "";
  if (mustPhrase && !String(text).toLowerCase().includes(String(mustPhrase).toLowerCase().slice(0, 10))) {
    text = `${text} The mention of ${mustPhrase.slice(0, 60)} was especially relevant.`;
  }

  return text;
}

function generateDraftSet({ facts, domainEntries, globalEntries, maxAttempts = 3, forcePhrase = false }) {
  const warnings = [];
  let candidates = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const batch = [];
    for (let v = 0; v < 12 && batch.length < 5; v += 1) {
      const draft = buildGroundedDraft({ facts, variant: v + attempt * 3, forcePhrase: forcePhrase || attempt > 0 });
      const simDomain = bestSimilarityAgainst(domainEntries, draft);
      const simGlobal = bestSimilarityAgainst(globalEntries, draft);
      const blocked = simDomain >= DOMAIN_SIM_THRESHOLD || simGlobal >= GLOBAL_SIM_THRESHOLD;
      batch.push({
        text: draft,
        sim_domain: Number(simDomain.toFixed(3)),
        sim_global: Number(simGlobal.toFixed(3)),
        blocked,
      });
    }
    const accepted = batch.filter((d) => !d.blocked);
    if (accepted.length) {
      candidates = accepted.slice(0, 3);
      break;
    }
    warnings.push(`attempt_${attempt + 1}_blocked_by_similarity`);
    candidates = batch.slice(0, 3);
  }

  const allBlocked = candidates.length > 0 && candidates.every((c) => c.blocked);
  return { drafts: candidates, allBlocked, warnings };
}

async function detectCaptchaGate(driver) {
  return driver.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 6 && r.height > 6;
    };
    const body = String(document.body?.innerText || "").toLowerCase();
    const html = String(document.documentElement?.outerHTML || "").toLowerCase();
    const hardText = /verify you're human|verify you are human|unusual traffic|complete (the )?captcha|security check|required challenge|robot check|prove you are human/.test(body);
    const challengeFrame = document.querySelector(
      "iframe[src*='recaptcha/api2/bframe'], iframe[title*='challenge' i][src*='recaptcha'], iframe[src*='hcaptcha.com'][src*='challenge']"
    );
    const visibleCheckbox = Array.from(document.querySelectorAll(
      ".recaptcha-checkbox-border, iframe[title*='recaptcha' i], iframe[src*='hcaptcha.com'], .h-captcha, .g-recaptcha"
    )).some((el) => isVisible(el));
    const passiveSignals = /recaptcha|hcaptcha/.test(html) || !!document.querySelector(".grecaptcha-badge, script[src*='recaptcha'], script[src*='hcaptcha']");
    const hasGate = hardText || isVisible(challengeFrame) || visibleCheckbox;
    return { hasGate, passiveSignals };
  }).catch(() => ({ hasGate: false, passiveSignals: false }));
}

async function detectAccessGateway(driver) {
  return driver.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 3 && r.height > 3;
    };
    const bodyText = String(document.body?.innerText || "").toLowerCase();
    const hasParentHint = /to leave a comment, click|to post a comment, click|please sign in to comment/.test(bodyText);
    const authTextRx = /(sign in|continue with|login with|authenticate)/i;

    const candidates = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']"));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const txt = String(el.textContent || el.getAttribute("value") || "").trim();
      const href = String(el.getAttribute("href") || "").toLowerCase();
      const cls = String(el.className || "").toLowerCase();
      const id = String(el.id || "").toLowerCase();
      const hasLogo = Boolean(
        el.querySelector("img[alt*='google' i], img[alt*='facebook' i], img[alt*='apple' i], svg[aria-label*='google' i], svg[aria-label*='facebook' i], svg[aria-label*='apple' i]")
      ) || /(google|facebook|apple)/.test(`${cls} ${id} ${txt.toLowerCase()}`);
      const isAuthHref = href.includes("accounts.google.com") || href.includes("facebook.com") || href.includes("appleid.apple.com") || href.includes("service=blogger");
      if (authTextRx.test(txt) || hasLogo || isAuthHref) {
        return {
          detected: true,
          selector_hint: el.id ? `#${el.id}` : "",
          has_parent_hint: hasParentHint,
        };
      }
    }

    const authFrame = document.querySelector("iframe[src*='accounts.google.com'], iframe[src*='facebook.com'], iframe[src*='appleid.apple.com']");
    if (authFrame && isVisible(authFrame)) {
      return { detected: true, selector_hint: "iframe_auth", has_parent_hint: hasParentHint };
    }
    return { detected: false };
  }).catch(() => ({ detected: false }));
}

async function continueAccessGateway({ driver, page, row = {}, sourceUrl = "", logger, rowKey, siteName }) {
  const hasSecurityGate = async (ctxPage) =>
    ctxPage.evaluate(() => {
      const body = String(document.body?.innerText || "").toLowerCase();
      return (
        body.includes("this browser or app may not be secure")
        || body.includes("couldn't sign you in")
        || body.includes("try using a different browser")
      );
    }).catch(() => false);

  const stableClick = async (ctxPage, selector) => {
    const loc = ctxPage.locator(selector).first();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const visible = await loc.isVisible({ timeout: 1500 }).catch(() => false);
      if (!visible) continue;
      await loc.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
      await sleep(RELIABILITY_DELAYS.afterScrollMs);
      await loc.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
      await sleep(RELIABILITY_DELAYS.beforeClickMs);
      const clicked = await loc.click({ timeout: 6000, delay: 0 }).then(() => true).catch(() => false);
      await sleep(RELIABILITY_DELAYS.afterClickMs);
      if (clicked) return true;
    }
    return false;
  };

  const clickGatewayInContext = async (ctxPage) => {
    const selectors = [
      "button:has-text('Sign in with Google')",
      "a:has-text('Sign in with Google')",
      "button:has-text('Continue with Google')",
      "a:has-text('Continue with Google')",
      "button:has-text('Login with Google')",
      "a:has-text('Login with Google')",
      "button:has-text('Sign in')",
      "a:has-text('Sign in')",
      "button:has-text('Continue with')",
      "a:has-text('Continue with')",
      "button:has-text('Authenticate')",
      "a:has-text('Authenticate')",
      "a[href*='accounts.google.com']",
      "a[href*='service=blogger']",
      "button:has(img[alt*='google' i])",
      "a:has(img[alt*='google' i])",
    ];
    for (const selector of selectors) {
      const clicked = await stableClick(ctxPage, selector);
      if (clicked) return { clicked: true, selector };
    }
    return { clicked: false, selector: "" };
  };
  const clickCommentEntryInContext = async (ctxPage) => {
    const selectors = [
      "a:has-text('Add comment')",
      "button:has-text('Add comment')",
      "a:has-text('Leave a comment')",
      "button:has-text('Leave a comment')",
      "a:has-text('Leave Reply')",
      "button:has-text('Leave Reply')",
      "a:has-text('Reply')",
      "button:has-text('Reply')",
      "a[href*='#comment']",
      "a[href*='#respond']",
    ];
    for (const selector of selectors) {
      const clicked = await stableClick(ctxPage, selector);
      if (clicked) return { clicked: true, selector };
    }
    return { clicked: false, selector: "" };
  };

  const inspectGoogleAuthState = async (ctxPage) => ctxPage.evaluate(() => {
    const hasPassword = Boolean(document.querySelector("input[type='password'], input[name='Passwd'], input[autocomplete='current-password']"));
    const hasEmailInput = Boolean(document.querySelector("input[type='email'], input[name='identifier'], input[autocomplete='username'], input[type='tel']"));
    const accountNode = document.querySelector("[data-identifier], div[role='link'][data-email], li [data-email]");
    const body = String(document.body?.innerText || "").toLowerCase();
    const already = /already signed in|you are signed in|continue as|choose an account/.test(body);
    return {
      hasPassword,
      hasEmailInput,
      hasAccountList: Boolean(accountNode),
      already,
    };
  }).catch(() => ({ hasPassword: false, hasEmailInput: false, hasAccountList: false, already: false }));

  const clickFirstGoogleAccount = async (ctxPage) => {
    const accountSelectors = [
      "[data-identifier]",
      "div[role='link'][data-email]",
      "li [data-email]",
      "div[role='button'][data-email]",
    ];
    for (const selector of accountSelectors) {
      const clicked = await stableClick(ctxPage, selector);
      if (clicked) return { clicked: true, selector };
    }
    return { clicked: false, selector: "" };
  };

  let clickedRes = await clickGatewayInContext(page);
  if (!clickedRes.clicked) {
    const frames = page.frames().filter((f) => f !== page.mainFrame());
    for (const frame of frames) {
      clickedRes = await clickGatewayInContext(frame);
      if (clickedRes.clicked) break;
    }
  }
  if (!clickedRes.clicked) {
    let entryRes = await clickCommentEntryInContext(page);
    if (!entryRes.clicked) {
      const frames = page.frames().filter((f) => f !== page.mainFrame());
      for (const frame of frames) {
        entryRes = await clickCommentEntryInContext(frame);
        if (entryRes.clicked) break;
      }
    }
    if (entryRes.clicked) {
      logDebugState(logger, {
        rowKey,
        siteName,
        state: "button_found",
        selector: entryRes.selector,
        actionTaken: "open_comment_entry",
        result: "success",
        note: "comment entry clicked; retrying google access detection",
      });
      await sleep(RELIABILITY_DELAYS.afterClickMs);
      clickedRes = await clickGatewayInContext(page);
      if (!clickedRes.clicked) {
        const frames = page.frames().filter((f) => f !== page.mainFrame());
        for (const frame of frames) {
          clickedRes = await clickGatewayInContext(frame);
          if (clickedRes.clicked) break;
        }
      }
    }
  }
  logDebugState(logger, {
    rowKey,
    siteName,
    state: "button_found",
    selector: clickedRes.selector,
    actionTaken: "detect_sign_in_button",
    result: clickedRes.selector ? "success" : "fail",
    note: clickedRes.selector ? "google access button located" : "google access button not located",
  });

  logDebugState(logger, {
    rowKey,
    siteName,
    state: "clicked",
    selector: clickedRes.selector,
    actionTaken: "click_access_button",
    result: clickedRes.clicked ? "success" : "fail",
    note: clickedRes.clicked ? "access continuation button click attempted" : "access continuation button not clickable",
  });

  if (!clickedRes.clicked) {
    return { access_status: "manual_access_required", next_step: "click_gateway_button" };
  }

  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await sleep(5000);
  const popup = await popupPromise;
  logDebugState(logger, {
    rowKey,
    siteName,
    state: "popup_opened",
    selector: "",
    actionTaken: "wait_for_popup_or_redirect",
    result: popup ? "success" : "fail",
    note: popup ? "popup opened after access button click" : "no popup detected; checking same page/iframe auth flow",
  });
  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
    await sleep(RELIABILITY_DELAYS.afterNavigationMs);
    if (await hasSecurityGate(popup)) {
      return { access_status: "manual_access_required", next_step: "google_security_gate_manual" };
    }
    const popupState = await inspectGoogleAuthState(popup);
    if (popupState.hasAccountList) {
      const accountClick = await clickFirstGoogleAccount(popup);
      logDebugState(logger, {
        rowKey,
        siteName,
        state: "click_attempted",
        selector: accountClick.selector,
        actionTaken: "click_google_account_from_list",
        result: accountClick.clicked ? "success" : "fail",
        note: "popup account list detected",
      });
      await sleep(RELIABILITY_DELAYS.afterClickMs);
    } else if (popupState.hasPassword || popupState.hasEmailInput || popupState.already) {
      logger?.log?.({
        row_key: rowKey,
        site_name: siteName,
        action: "access_gateway",
        status: "manual_access_required",
        error_message: popupState.hasPassword
          ? "password_step_detected_manual_required"
          : "auth_popup_detected_manual_entry_needed",
      });
      return { access_status: "manual_access_required", next_step: "manual_login_in_popup" };
    }
  }

  const formNow = await discoverCommentForm({ driver, page, targetLink: sourceUrl, sourceUrl, maxScrollSteps: 3 }).catch(() => ({ found: false }));
  if (formNow?.found) {
    return { access_status: "access_granted", next_step: "continue_form_fill", detection: formNow };
  }

  const state = await driver.evaluate(() => {
    const hasEmail = Boolean(document.querySelector("input[type='email'], input[name='identifier'], input[autocomplete='username'], input[type='tel']"));
    const hasPassword = Boolean(document.querySelector("input[type='password'], input[name='Passwd'], input[autocomplete='current-password']"));
    const body = String(document.body?.innerText || "").toLowerCase();
    const already = /already signed in|you are signed in|continue as/.test(body);
    const authHint = /sign in with google|continue with google|login with google|to leave a comment, click/.test(body);
    return { hasEmail, hasPassword, already, authHint };
  }).catch(() => ({ hasEmail: false, hasPassword: false, already: false, authHint: false }));
  const currentUrl = String(page.url() || "").toLowerCase();
  const sameTabAuthUrl = currentUrl.includes("accounts.google.com") || currentUrl.includes("service=blogger") || currentUrl.includes("/comment/fullpage/post/");

  if (await hasSecurityGate(page)) {
    return { access_status: "manual_access_required", next_step: "google_security_gate_manual" };
  }

  if (state.hasEmail || state.hasPassword || sameTabAuthUrl) {
    logDebugState(logger, {
      rowKey,
      siteName,
      state: "auth_state_detected",
      selector: "",
      actionTaken: "check_same_tab_auth_state",
      result: "manual_access_required",
      note: `same_tab_auth_url=${sameTabAuthUrl}; has_email=${Boolean(state.hasEmail)}; has_password=${Boolean(state.hasPassword)}`,
    });
    return { access_status: "manual_access_required", next_step: "manual_login_required" };
  }

  const frameEmailState = await Promise.all(
    page.frames().filter((f) => f !== page.mainFrame()).map((frame) =>
      frame
        .evaluate(() => Boolean(document.querySelector("input[type='email'], input[name='identifier'], input[autocomplete='username'], input[type='tel']")))
        .catch(() => false)
    )
  ).catch(() => []);
  if (Array.isArray(frameEmailState) && frameEmailState.some(Boolean)) {
    return { access_status: "manual_access_required", next_step: "manual_login_required" };
  }

  if (state.already) {
    return { access_status: "access_granted", next_step: "retry_form_detection" };
  }
  if (state.authHint) {
    return { access_status: "manual_access_required", next_step: "manual_login_required" };
  }
  return { access_status: "manual_access_required", next_step: "await_access_gateway_completion" };
}

async function discoverCommentForm({ driver, page, targetLink, sourceUrl = "", maxScrollSteps = 10 }) {
  const scanMain = async () => driver.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 3 && r.height > 3;
    };
    const css = (el, fallback = "") => {
      if (!el) return fallback;
      if (el.id) return `#${el.id}`;
      const tag = String(el.tagName || "").toLowerCase();
      const name = String(el.getAttribute("name") || "").trim();
      if (name) return `${tag}[name='${name.replace(/'/g, "\\'")}']`;
      const cls = String(el.className || "").split(/\s+/).find(Boolean);
      return cls ? `${tag}.${cls}` : fallback || tag;
    };
    const nearSubmit = (el) => {
      if (!el) return null;
      const root = el.closest("form, article, section, .comment-form, #respond") || document;
      const candidates = Array.from(root.querySelectorAll("button, input[type='submit'], input[type='button'], a"));
      const r1 = el.getBoundingClientRect();
      const cx1 = r1.left + (r1.width / 2);
      const cy1 = r1.top + (r1.height / 2);
      let best = null;
      for (const c of candidates) {
        if (!isVisible(c)) continue;
        const t = `${String(c.textContent || "").toLowerCase()} ${String(c.getAttribute("value") || "").toLowerCase()}`.trim();
        if (!/(submit|post|reply|comment|send)/.test(t) && c.tagName.toLowerCase() !== "input") continue;
        const r2 = c.getBoundingClientRect();
        const cx2 = r2.left + (r2.width / 2);
        const cy2 = r2.top + (r2.height / 2);
        const d = Math.hypot(cx1 - cx2, cy1 - cy2);
        if (!best || d < best.distance) best = { node: c, distance: d };
      }
      return best;
    };
    const buildFound = (box, submitNode, confidence) => {
      const form = box.closest("form") || document.querySelector("form#commentform, #respond form, form[action*='comment' i], form");
      const submit = submitNode || (form
        ? form.querySelector("button[type='submit'], input[type='submit'], button[name*='submit' i], input[name*='submit' i], button, input[value*='comment' i]")
        : document.querySelector("button[type='submit'], input[type='submit']"));
      const name = form?.querySelector("input[name*='author' i], input[name*='name' i], #author") || null;
      const email = form?.querySelector("input[type='email'], input[name*='email' i], #email") || null;
      const website = form?.querySelector("input[name='url'], input[name*='website' i], input[name*='site' i], #url") || null;
      const phone = form?.querySelector("input[type='tel'], input[name*='phone' i], input[name*='mobile' i], input[id*='phone' i], input[id*='mobile' i]") || null;
      const html = String(document.documentElement?.outerHTML || "").toLowerCase();
      const cms = html.includes("wp-comments-post") || html.includes("commentform") || html.includes("id=\"respond\"")
        ? "wordpress"
        : (html.includes("blogger") || html.includes("blogspot"))
          ? "blogspot"
          : html.includes("disqus")
            ? "disqus"
            : "unknown";
      return {
        found: true,
        reason: "",
        comment_box_selector: css(box, "textarea, [contenteditable='true'], [role='textbox']"),
        submit_selector: css(submit, "button[type='submit'], input[type='submit']"),
        name_selector: css(name, "input[name*='author' i], input[name*='name' i]"),
        email_selector: css(email, "input[type='email'], input[name*='email' i]"),
        website_selector: css(website, "input[name='url'], input[name*='website' i]"),
        phone_selector: css(phone, "input[type='tel'], input[name*='phone' i], input[name*='mobile' i]"),
        form_selector: css(form, "form"),
        cms_type_guess: cms,
        confidence_score: Math.min(100, Math.max(0, Number(confidence || 0))),
      };
    };

    // Step 2: direct selectors in strict order.
    const directSelectors = [
      "textarea#comment",
      "textarea[name='comment']",
      "#commentform textarea",
      ".comment-form textarea",
      "form:has(textarea):has(button[type='submit']) textarea",
      "textarea[placeholder*='comment' i]",
      "textarea[aria-label*='comment' i]",
      "[contenteditable='true'][aria-label*='comment' i]",
      "[contenteditable='true'][placeholder*='comment' i]",
      "[role='textbox'][aria-label*='comment' i]",
      "input[name*='comment' i]:not([type='hidden'])",
      "input[placeholder*='comment' i]:not([type='hidden'])",
      "input[name*='message' i]:not([type='hidden'])",
      "input[placeholder*='message' i]:not([type='hidden'])",
    ];
    for (const sel of directSelectors) {
      const nodes = Array.from(document.querySelectorAll(sel)).filter((n) => isVisible(n));
      if (!nodes.length) continue;
      const box = nodes[0];
      const submitHit = nearSubmit(box);
      return buildFound(box, submitHit?.node || null, 88);
    }

    const bodyText = String(document.body?.innerText || "").toLowerCase();
    const authHints = [
      "to leave a comment, click the button below to sign in",
      "sign in with google",
      "sign in to comment",
      "login to comment",
      "log in to comment",
    ];
    const hasAuthText = authHints.some((t) => bodyText.includes(t));
    const authButton = Array.from(document.querySelectorAll("a,button,input[type='button'],input[type='submit']"))
      .some((el) => {
        const t = String(el.textContent || el.getAttribute("value") || "").toLowerCase();
        const href = String(el.getAttribute("href") || "").toLowerCase();
        return (
          t.includes("sign in") ||
          t.includes("log in") ||
          href.includes("blogger.com/comment/fullpage/post") ||
          href.includes("/comment/fullpage/post") ||
          href.includes("accounts.google.com") ||
          href.includes("service=blogger")
        );
      });
    if (hasAuthText || authButton) {
      return { found: false, reason: "access_required", cms: "blogspot" };
    }

    // Step 4: HTML/context keyword search around comment-capable editor controls.
    const html = String(document.documentElement?.outerHTML || "").toLowerCase();
    if (/(comment|reply|submit)/.test(html)) {
      const editors = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox'], input:not([type='hidden'])"))
        .filter((el) => isVisible(el))
        .filter((el) => {
          const tag = String(el.tagName || "").toLowerCase();
          if (tag === "textarea") return true;
          if (el.isContentEditable) return true;
          const role = String(el.getAttribute("role") || "").toLowerCase();
          if (role === "textbox") return true;
          const type = String(el.getAttribute("type") || "text").toLowerCase();
          if (!["text", "search", ""].includes(type)) return false;
          const hint = [
            el.getAttribute("name") || "",
            el.getAttribute("id") || "",
            el.getAttribute("placeholder") || "",
            el.getAttribute("aria-label") || "",
            el.getAttribute("title") || "",
          ].join(" ").toLowerCase();
          return /(comment|message|feedback|review|reply|description)/.test(hint);
        });
      for (const box of editors) {
        const container = box.closest("form, article, section, .comment-form, #respond, .comments") || box.parentElement;
        const ctx = String(container?.innerText || "").toLowerCase();
        if (!/(comment|reply|submit)/.test(ctx)) continue;
        const submitHit = nearSubmit(box);
        if (submitHit?.node) return buildFound(box, submitHit.node, 74);
      }
    }

    // Step 5: final broad editor scoring.
    const allTextareas = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox'], input:not([type='hidden'])"))
      .filter((t) => isVisible(t))
      .filter((el) => {
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "textarea") return true;
        if (el.isContentEditable) return true;
        const role = String(el.getAttribute("role") || "").toLowerCase();
        if (role === "textbox") return true;
        const type = String(el.getAttribute("type") || "text").toLowerCase();
        return ["text", "search", ""].includes(type);
      });
    let best = null;
    for (const box of allTextareas) {
      const form = box.closest("form");
      const ph = String(box.getAttribute("placeholder") || "").toLowerCase();
      const hint = [
        box.getAttribute("name") || "",
        box.getAttribute("id") || "",
        box.getAttribute("aria-label") || "",
        box.getAttribute("title") || "",
      ].join(" ").toLowerCase();
      const formText = String(form?.innerText || box.closest("section,article,div")?.innerText || "").toLowerCase();
      const submitHit = nearSubmit(box);
      let score = 0;
      if (/(comment|message)/.test(ph)) score += 35;
      if (/(comment|message|feedback|review|reply|description)/.test(hint)) score += 30;
      if (/(comment|reply|post)/.test(formText)) score += 25;
      if (submitHit?.distance != null && submitHit.distance < 200) score += 35;
      if (box.id === "comment" || hint.includes("comment")) score += 30;
      if (!best || score > best.score) best = { box, submit: submitHit?.node || null, score };
    }
    if (best && best.score >= 30) {
      return buildFound(best.box, best.submit, 50 + Math.min(45, best.score));
    }

    // Blogger/third-party comment widget often requires account sign-in and does not expose native textarea.
    const hasBloggerWidget =
      html.includes("meta content=\"blogger\"") ||
      html.includes("window.goog.comments") ||
      html.includes("goog.comments.render") ||
      html.includes("id=\"comment-holder\"") ||
      html.includes("www.blogger.com/static/v1/jsbin/blogger.widgets.comments");
    if (hasBloggerWidget) {
      const hasRevealEntry = Array.from(document.querySelectorAll("a,button,[role='button'],summary"))
        .some((el) => /(add( a)? comment|leave reply|write comment|reply|comment now)/.test(String(el.textContent || "").toLowerCase()));
      if (hasRevealEntry) {
        return { found: false, reason: "no_form_detected", cms: "blogspot" };
      }
      return { found: false, reason: "access_required", cms: "blogspot" };
    }

    return { found: false, reason: "no_form_detected", cms: "unknown" };
  });

  const anchorHash = await driver.evaluate(() => String(location.hash || "").toLowerCase()).catch(() => "");
  if (anchorHash && ["#comment", "#respond", "#comments", "#commentform"].some((v) => anchorHash.includes(v))) {
    const baseUrl = String(sourceUrl || "").trim();
    if (baseUrl) {
      const withHash = `${baseUrl.split("#")[0]}${anchorHash.startsWith("#") ? anchorHash : ""}`;
      await driver.goto(withHash, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    }
    await sleep(500);
  } else {
    await driver.evaluate(() => {
      const a = document.querySelector("a[href*='#respond'], a[href*='#comments'], a[href*='#comment']");
      if (a) a.click();
    }).catch(() => {});
    await sleep(400);
  }

  let firstScan = await scanMain().catch(() => ({ found: false, reason: "no_form_detected" }));
  if (firstScan?.found) return { ...firstScan, scroll_steps: 0 };

  const captchaCheck = await detectCaptchaGate(driver);
  if (captchaCheck.hasGate && !firstScan?.found) {
    return { found: false, reason: "captcha_gate", scroll_steps: 0, cms_type_guess: firstScan?.cms || "unknown", confidence_score: 0 };
  }

  const frames = page.frames().filter((f) => f !== page.mainFrame());
  for (const frame of frames) {
    const hasIframeAccessGateway = await frame.evaluate(() => {
      const body = String(document.body?.innerText || "").toLowerCase();
      if (/to leave a comment, click|sign in with google|add comment|add a comment/.test(body)) return true;
      const authLink = Array.from(document.querySelectorAll("a,button,[role='button'],input[type='button'],input[type='submit']"))
        .some((el) => {
          const txt = String(el.textContent || el.getAttribute("value") || "").toLowerCase();
          const href = String(el.getAttribute("href") || "").toLowerCase();
          return (
            /(sign in|continue with|login with|authenticate|add( a)? comment)/.test(txt) ||
            href.includes("blogger.com/comment/fullpage/post") ||
            href.includes("/comment/fullpage/post") ||
            href.includes("accounts.google.com") ||
            href.includes("service=blogger")
          );
        });
      return authLink;
    }).catch(() => false);
    if (hasIframeAccessGateway) {
      return { found: false, reason: "access_required", scroll_steps: 0, cms_type_guess: "blogspot", confidence_score: 40 };
    }

    const hasIframeComment = await frame.evaluate(() => {
      return Boolean(document.querySelector(
        "form#commentform, textarea#comment, textarea[name='comment'], textarea[name*='comment' i], textarea[placeholder*='comment' i], [contenteditable='true'], [role='textbox'][aria-label*='comment' i], input[name*='comment' i], input[placeholder*='comment' i]"
      ));
    }).catch(() => false);
    if (hasIframeComment) {
      return { found: false, reason: "iframe_comment_form", scroll_steps: 0, cms_type_guess: "unknown", confidence_score: 0 };
    }
  }

  // Step 3: fixed 500px scroll + 1s wait, max 5 attempts.
  for (let step = 1; step <= 5; step += 1) {
    await driver.evaluate(() => {
      window.scrollBy({ top: 500, left: 0, behavior: "instant" });
    }).catch(() => {});
    await sleep(1000);
    const result = await scanMain().catch(() => ({ found: false, reason: "no_form_detected" }));
    if (result?.found) return { ...result, scroll_steps: step };
    firstScan = result;
  }

  // Step 6: click reveal links/buttons and retry once.
  const revealClicked = await driver.evaluate(() => {
    const items = Array.from(document.querySelectorAll("a,button,[role='button'],summary"));
    for (const el of items) {
      const txt = String(el.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
      const href = String(el.getAttribute("href") || "").toLowerCase().trim();
      const strongIntent = /(add( a)? comment|leave reply|write comment|show comments|post a comment|reply|comment now)/.test(txt);
      const bloggerFullpage = href.includes("blogger.com/comment/fullpage/post") || href.includes("/comment/fullpage/post");
      if (!strongIntent && !bloggerFullpage) continue;
      const classId = `${String(el.id || "").toLowerCase()} ${String(el.className || "").toLowerCase()}`;
      const isLikelyFeed =
        href.includes("/feeds/") ||
        href.includes("comments/default") ||
        href.includes("atom") ||
        href.endsWith(".xml") ||
        href.includes("blogger.com/feeds");
      if (isLikelyFeed) continue;
      if (!strongIntent && href && !href.startsWith("#") && !/(respond|reply|comment)/.test(href) && !/(respond|reply|comment)/.test(classId)) {
        continue;
      }
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (s.display === "none" || s.visibility === "hidden" || r.width < 4 || r.height < 4) continue;
      try { el.click(); return true; } catch (_) {}
    }
    return false;
  }).catch(() => false);

  if (revealClicked) {
    await sleep(2000);
    let retry = await scanMain().catch(() => ({ found: false, reason: "no_form_detected" }));
    if (retry?.found) return { ...retry, scroll_steps: 6 };
    for (let step = 1; step <= 5; step += 1) {
      await driver.evaluate(() => {
        window.scrollBy({ top: 500, left: 0, behavior: "instant" });
      }).catch(() => {});
      await sleep(1000);
      retry = await scanMain().catch(() => ({ found: false, reason: "no_form_detected" }));
      if (retry?.found) return { ...retry, scroll_steps: 6 + step };
    }
    firstScan = retry;
  }

  return {
    found: false,
    reason: (() => {
      const r = String(firstScan?.reason || "no_form_detected");
      if (r && r !== "no_form_detected") return r;
      return r;
    })(),
    scroll_steps: 5,
    cms_type_guess: firstScan?.cms || "unknown",
    confidence_score: 0,
  };
}

async function enforceFormVisible(driver, selector) {
  await driver.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
  }, selector).catch(() => {});
  await sleep(120);
  const ready = await driver.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return false;
    try { el.focus(); } catch (_) {}
    return true;
  }, selector).catch(() => false);
  return Boolean(ready);
}

async function detectPostSignals(driver) {
  return driver.evaluate(() => {
    const body = String(document.body?.innerText || "").toLowerCase();
    const hash = String(location.hash || "").toLowerCase();
    const hasCaptcha = /hcaptcha|recaptcha|verify you're human|verify you are human|unusual traffic/.test(body)
      || !!document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], .g-recaptcha, .h-captcha");
    const isBlocked = /forbidden|blocked|access denied|spam detected|not allowed|security check failed/.test(body);
    const isDuplicate = /duplicate comment detected|it looks as though you've already said that|duplicate comment|you are posting comments too quickly/.test(body);
    const moderation = /awaiting moderation|held for moderation|awaiting approval|your comment is awaiting moderation/.test(body);
    const success = /comment submitted|comment posted|thank you for your comment|your comment has been posted/.test(body);
    const hasCommentAnchor = /#comment-\d+/.test(hash);
    return { hasCaptcha, isBlocked, isDuplicate, moderation, success, hasCommentAnchor };
  }).catch(() => ({ hasCaptcha: false, isBlocked: false, isDuplicate: false, moderation: false, success: false, hasCommentAnchor: false }));
}

function uniquenessStatusLine(bestDomain, bestGlobal, domainCount) {
  const best = Math.max(bestDomain, bestGlobal);
  const ok = bestDomain < DOMAIN_SIM_THRESHOLD && bestGlobal < GLOBAL_SIM_THRESHOLD;
  return {
    ok,
    sim: Number(best.toFixed(2)),
    domain_seen_count: Number(domainCount || 0),
    label: `Uniqueness check: ${ok ? "OK" : "Blocked"} (sim=${Number(best.toFixed(2))}) | Domain seen: ${Number(domainCount || 0)} comments`,
  };
}

function extractPrimaryUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/https?:\/\/[^\s<>"']+/i);
  if (match && match[0]) return match[0].trim();
  return raw.split(/[\n|;,]+/g).map((v) => v.trim()).find(Boolean) || "";
}

export async function runAdaptiveBlogCommenting({
  page,
  row,
  target,
  targetLink,
  runDir,
  runId,
  siteSlug,
  siteName,
  rowKey,
  approvalMode,
  captureArtifacts,
  logger,
}) {
  const { driver, fallbackUsed } = createBrowserDriver(page);
  const typingDelay = String(process.env.BLOG_COMMENT_TYPING_DELAY_MS || "40-120").trim();
  const scrollBeforeType = String(process.env.BLOG_COMMENT_SCROLL_BEFORE_TYPE || "1").trim() !== "0";
  const waitForManualVerification = String(process.env.BLOG_COMMENT_WAIT_FOR_MANUAL_VERIFICATION || "0").trim() !== "0";
  const verificationWaitMs = Math.max(10000, Number(process.env.BLOG_COMMENT_VERIFICATION_WAIT_MS || 15 * 60 * 1000));
  const verificationPollMs = Math.max(1500, Number(process.env.BLOG_COMMENT_VERIFICATION_POLL_MS || 5000));
  const forceManualApproval = String(process.env.BLOG_COMMENT_FORCE_MANUAL_APPROVAL || "0").trim() === "1";
  const prefillOnly = String(process.env.BLOG_COMMENT_PREFILL_ONLY || "0").trim() === "1";
  const autoApproveSubmit = String(process.env.AUTO_APPROVE_SUBMIT || "1").trim() === "1";
  const skipDuplicateBlock = String(process.env.BLOG_COMMENT_SKIP_DUPLICATE_BLOCK || "0").trim() === "1";

  const forceFieldValue = async (selector, value) => {
    const val = String(value || "").trim();
    if (!val) return false;
    return driver.evaluate(({ sel, v }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const tag = String(el.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input") {
        try { el.removeAttribute("readonly"); } catch (_) {}
        try { el.removeAttribute("disabled"); } catch (_) {}
        el.focus();
        try {
          const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, v);
          else el.value = v;
        } catch (_) {
          el.value = v;
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return String(el.value || "").trim().length > 0;
      }
      if (el.isContentEditable) {
        el.focus();
        el.textContent = v;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return String(el.textContent || "").trim().length > 0;
      }
      return false;
    }, { sel: selector, v: val }).catch(() => false);
  };

  const forceFillCommentEverywhere = async (commentText = "") => {
    const text = String(commentText || "").trim();
    if (!text) return false;
    return driver.evaluate((value) => {
      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 8 && r.height > 8;
      };
      const hintFor = (el) => [
        el.getAttribute("name") || "",
        el.getAttribute("id") || "",
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        String(el.closest("label")?.textContent || ""),
      ].join(" ").toLowerCase();
      const setValue = (el) => {
        const tag = String(el.tagName || "").toLowerCase();
        try { el.removeAttribute("readonly"); } catch (_) {}
        try { el.removeAttribute("disabled"); } catch (_) {}
        if (tag === "textarea" || tag === "input") {
          try {
            const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(el, value);
            else el.value = value;
          } catch (_) {
            el.value = value;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return String(el.value || "").trim().length > 0;
        }
        if (el.isContentEditable || String(el.getAttribute("role") || "").toLowerCase() === "textbox") {
          el.textContent = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return String(el.textContent || "").trim().length > 0;
        }
        return false;
      };

      const direct = Array.from(document.querySelectorAll(
        "textarea[placeholder*='comment' i], textarea[aria-label*='comment' i], textarea[name*='comment' i], textarea, [contenteditable='true'], [role='textbox']"
      )).filter((el) => isVisible(el));
      for (const el of direct) {
        const hint = hintFor(el);
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "textarea" || el.isContentEditable || String(el.getAttribute("role") || "").toLowerCase() === "textbox" || /(comment|message|reply|feedback|description)/.test(hint)) {
          if (setValue(el)) return true;
        }
      }

      // fallback: largest visible textarea-like editor on page
      const all = Array.from(document.querySelectorAll("textarea, [contenteditable='true'], [role='textbox'], input[type='text'], input[type='search']"))
        .filter((el) => isVisible(el))
        .map((el) => ({ el, area: (el.getBoundingClientRect().width * el.getBoundingClientRect().height) }))
        .sort((a, b) => b.area - a.area);
      for (const it of all) {
        if (setValue(it.el)) return true;
      }
      return false;
    }, text).catch(() => false);
  };

  const buildProfilePayload = (commentText = "") => {
    const isEmailAddr = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ""));
    const username = String(row.username || "").trim();
    const phoneFallback = String(row.company_phone || "").trim();
    const emailFallback = String(row.email || "").trim()
      || (isEmailAddr(username) ? username : "");
    const nameFallback = String((!isEmailAddr(username) && username) || row.company_name || "").trim();
    return {
      comment: String(commentText || "").trim(),
      name: nameFallback,
      email: emailFallback,
      website: String(row.default_website_url || "").trim(),
      password: String(row.password || "").trim(),
      phone: phoneFallback,
      company_name: String(row.company_name || "").trim(),
      company_address: String(row.company_address || "").trim(),
    };
  };

  const genericFormFill = async (payload) => {
    return driver.evaluate((data) => {
      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 4 && rect.height > 4;
      };
      const isDisabled = (el) => Boolean(el.disabled) || String(el.getAttribute("aria-disabled") || "").toLowerCase() === "true";
      const isReadOnly = (el) => Boolean(el.readOnly) || String(el.getAttribute("readonly") || "").toLowerCase() === "true";
      const labelTextFor = (el) => {
        const id = el.getAttribute("id");
        if (!id) return "";
        const label = document.querySelector(`label[for="${id}"]`);
        return String(label?.textContent || "").toLowerCase();
      };
      const textFor = (el) => String(el?.textContent || el?.getAttribute?.("value") || "").toLowerCase();
      const hintFor = (el) => [
        el.getAttribute("name") || "",
        el.getAttribute("id") || "",
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        labelTextFor(el),
      ].join(" ").toLowerCase();
      const looksHoneypot = (el) => {
        const hint = hintFor(el);
        if (/(honeypot|trap|bot|captcha|token|csrf|nonce)/.test(hint)) return true;
        const style = window.getComputedStyle(el);
        return style.opacity === "0" || style.pointerEvents === "none";
      };
      const setNativeValue = (el, value) => {
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "input" || tag === "textarea") {
          const proto = tag === "input" ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, value);
          else el.value = value;
          return true;
        }
        return false;
      };
      const setVal = (el, value) => {
        const v = String(value || "").trim();
        if (!v) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "textarea" || tag === "input" || tag === "select") {
          el.focus();
          if (tag === "select") {
            const opts = Array.from(el.options || []);
            const match = opts.find((o) => String(o.value || "").trim() === v || String(o.textContent || "").trim() === v);
            if (match) {
              el.value = String(match.value || "");
            } else {
              const firstNonEmpty = opts.find((o) => {
                const txt = String(o.textContent || "").toLowerCase().trim();
                const val = String(o.value || "").trim();
                if (!val) return false;
                return !/(select|choose|pick|--|option)/.test(txt);
              }) || opts.find((o) => String(o.value || "").trim()) || opts[0];
              if (firstNonEmpty) el.value = String(firstNonEmpty.value || "");
            }
          } else {
            setNativeValue(el, v);
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          return true;
        }
        if (el.isContentEditable) {
          el.focus();
          el.textContent = v;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("blur", { bubbles: true }));
          return true;
        }
        return false;
      };

      const getForms = () => {
        const forms = Array.from(document.querySelectorAll("form"));
        const synthetic = Array.from(document.querySelectorAll("[role='form'], .comment-form, .contact-form, .form, section, article"))
          .filter((el) => {
            if (!isVisible(el)) return false;
            const inputs = el.querySelectorAll("input, textarea, select, [contenteditable='true']");
            return inputs.length >= 2;
          });
        const uniq = [];
        for (const el of [...forms, ...synthetic]) {
          if (!uniq.includes(el)) uniq.push(el);
        }
        return uniq;
      };
      const scoreForm = (container) => {
        const txt = `${textFor(container)} ${container?.getAttribute?.("id") || ""} ${container?.getAttribute?.("class") || ""}`.toLowerCase();
        let score = 0;
        if (/(comment|reply|feedback|review|contact|message)/.test(txt)) score += 40;
        const fields = container.querySelectorAll("input, textarea, select, [contenteditable='true']");
        const submitBtns = container.querySelectorAll("button, input[type='submit'], [role='button']");
        score += Math.min(30, fields.length * 3);
        score += Math.min(20, submitBtns.length * 5);
        return score;
      };
      const pickContainer = () => {
        const forms = getForms();
        if (!forms.length) return document;
        let best = forms[0];
        let bestScore = scoreForm(best);
        for (const f of forms.slice(1)) {
          const s = scoreForm(f);
          if (s > bestScore) {
            best = f;
            bestScore = s;
          }
        }
        return best;
      };
      const container = pickContainer();
      const fieldSelector = "input, textarea, select, [contenteditable='true']";
      const fields = Array.from(container.querySelectorAll(fieldSelector))
        .filter((el) => isVisible(el) && !isDisabled(el) && !isReadOnly(el) && !looksHoneypot(el));

      let filled = 0;
      let checked = 0;
      const radioDone = new Set();
      for (const el of fields) {
        const tag = String(el.tagName || "").toLowerCase();
        const type = String(el.getAttribute("type") || "").toLowerCase();
        const hint = hintFor(el);

        if (type === "hidden" || type === "file" || type === "image" || type === "color" || type === "range") continue;
        if (type === "checkbox") {
          if (!el.checked) {
            el.click();
            checked += 1;
          }
          continue;
        }
        if (type === "radio") {
          const key = String(el.getAttribute("name") || "");
          if (!radioDone.has(key) && !el.checked) {
            el.click();
            radioDone.add(key);
            checked += 1;
          }
          continue;
        }

        let value = "";
        if (type === "email" || hint.includes("email")) value = data.email;
        else if (type === "url" || hint.includes("website") || hint.includes("url") || hint.includes("site")) value = data.website;
        else if (type === "password" || hint.includes("password")) value = data.password;
        else if (type === "tel" || hint.includes("phone") || hint.includes("mobile")) value = data.phone;
        else if (type === "number" && (hint.includes("phone") || hint.includes("mobile") || hint.includes("tel"))) value = data.phone;
        else if (hint.includes("address")) value = data.company_address;
        else if (hint.includes("company") || hint.includes("business") || hint.includes("organization")) value = data.company_name;
        else if (hint.includes("name") || hint.includes("author")) value = data.name;
        else if (hint.includes("comment") || hint.includes("message") || hint.includes("description") || hint.includes("content") || hint.includes("body")) value = data.comment;
        else if (tag === "textarea" || el.isContentEditable) value = data.comment;
        else if (type === "search" || type === "text" || type === "number" || !type) value = data.company_name || data.name || String(data.comment || "").slice(0, 140);

        if (setVal(el, value)) filled += 1;
      }

      const roleBoxes = Array.from(container.querySelectorAll("[role='checkbox']")).filter((el) => isVisible(el) && !isDisabled(el));
      for (const box of roleBoxes) {
        const checkedState = String(box.getAttribute("aria-checked") || "").toLowerCase();
        if (checkedState !== "true") {
          box.click();
          checked += 1;
        }
      }

      const submitLike = Array.from(container.querySelectorAll("button, input[type='submit'], input[type='button'], [role='button'], a"))
        .filter((el) => isVisible(el) && !isDisabled(el))
        .map((el) => {
          const txt = `${textFor(el)} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
          let score = 0;
          if (String(el.getAttribute("type") || "").toLowerCase() === "submit") score += 10;
          if (/(submit|post|send|reply|comment|publish|save)/.test(txt)) score += 20;
          if (/(cancel|reset|close|back)/.test(txt)) score -= 20;
          return { el, score };
        })
        .sort((a, b) => b.score - a.score);
      const selectorFor = (el) => {
        if (!el) return "";
        if (el.id) return `#${el.id}`;
        const name = String(el.getAttribute("name") || "").trim();
        const type = String(el.getAttribute("type") || "").trim();
        const tag = String(el.tagName || "").toLowerCase();
        if (name) return `${tag}[name="${name}"]`;
        if (type) return `${tag}[type="${type}"]`;
        return tag || "";
      };
      const submitCandidates = submitLike.slice(0, 4).map((row) => selectorFor(row.el)).filter(Boolean);
      const submitSelector = submitCandidates[0] || "button[type='submit'], input[type='submit']";

      const requiredFields = fields.filter((el) => {
        const required = el.hasAttribute("required") || String(el.getAttribute("aria-required") || "").toLowerCase() === "true";
        if (!required) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "select") return String(el.value || "").trim().length > 0;
        if (el.isContentEditable) return String(el.textContent || "").trim().length > 0;
        return String(el.value || "").trim().length > 0;
      }).length;

      return {
        ok: filled > 0 || checked > 0,
        filled_count: filled,
        checked_count: checked,
        required_filled_count: requiredFields,
        container_tag: String(container?.tagName || "").toLowerCase(),
        submit_selector: submitSelector,
        submit_candidates: submitCandidates,
      };
    }, payload).catch(() => ({
      ok: false,
      filled_count: 0,
      checked_count: 0,
      required_filled_count: 0,
      container_tag: "",
      submit_selector: "button[type='submit'], input[type='submit']",
      submit_candidates: [],
    }));
  };

  const tryGenericFallbackFlow = async ({ reason = "generic_fallback", commentText = "", facts = null }) => {
    const payload = buildProfilePayload(commentText);
    const filled = await genericFormFill(payload);
    if (!filled?.ok) return null;

    logDebugState(logger, {
      rowKey,
      siteName,
      state: "form_filled_generic",
      selector: filled.submit_selector,
      actionTaken: "fill_any_visible_form_fields",
      result: "success",
      note: `${reason}; filled=${Number(filled.filled_count || 0)}; checked=${Number(filled.checked_count || 0)}; required=${Number(filled.required_filled_count || 0)}; container=${String(filled.container_tag || "unknown")}`,
    });
    logger?.log?.({
      row_key: rowKey,
      site_name: siteName,
      action: "adaptive_stage",
      status: "ok",
      error_message: `generic_fallback_prefilled reason=${reason}`,
    });

    const approval = autoApproveSubmit
      ? { approved: true, screenshotPath: "", htmlPath: "" }
      : await requestHumanApproval({
          page,
          runDir,
          runId,
          siteSlug,
          siteName,
          rowKey,
          mode: approvalMode,
          artifactNameBase: "pre_submit_generic",
          forceManual: forceManualApproval,
          prefillOnly,
          requestPayload: {
            status: "ready_to_submit",
            driver_used: driver.name,
            fallback_used: true,
            reason,
            detected_fields: {
              submit_selector: filled.submit_selector,
              submit_candidates: Array.isArray(filled.submit_candidates) ? filled.submit_candidates.slice(0, 4) : [],
            },
            page_facts: facts ? {
              title: facts.title,
              headings: facts.headings?.slice?.(0, 4) || [],
              key_sentences: facts.key_sentences?.slice?.(0, 4) || [],
            } : {},
          },
        });

    if (!approval.approved) {
      return {
        status: "skipped",
        status_reason: "Operator declined submit at generic fallback checkpoint.",
        created_link: "",
        result_title: "",
        artifacts: [approval.screenshotPath, approval.htmlPath].filter(Boolean),
      };
    }

    const beforeSubmitUrl = String(page.url() || "");
    const submitCandidates = [
      String(filled.submit_selector || "").trim(),
      ...(Array.isArray(filled.submit_candidates) ? filled.submit_candidates : []),
      "button[type='submit']",
      "input[type='submit']",
      "button:not([type])",
      "[role='button']",
    ].map((s) => String(s || "").trim()).filter(Boolean);
    const uniqSubmitCandidates = [...new Set(submitCandidates)];
    let post = await detectPostSignals(driver);
    for (const submitSel of uniqSubmitCandidates) {
      if (post?.success || post?.moderation || post?.hasCommentAnchor || post?.hasCaptcha || post?.isBlocked) break;
      const clicked = await driver.click(submitSel, {
        timeout: 12000,
        maxAttempts: 2,
        verifyUrlChangedFrom: beforeSubmitUrl,
        verifyAppearSelector: "body",
      }).catch(() => false);
      if (!clicked) continue;
      await sleep(2200);
      post = await detectPostSignals(driver);
    }
    const artifacts = await captureArtifacts({
      page,
      siteDir,
      baseName: "post_submit_generic",
      rowKey,
      siteName,
      action: "post_submit_state",
      status: post?.isBlocked ? "blocked" : (post?.hasCaptcha ? "pending_verification" : "submitted"),
      errorMessage: `generic_fallback_submit reason=${reason}`,
      targetLink,
    });

    if (post?.hasCaptcha) {
      return { status: "pending_verification", status_reason: "captcha_gate", created_link: "", result_title: "", artifacts };
    }
    if (post?.isBlocked) {
      return { status: "blocked", status_reason: "blocked_by_site", created_link: "", result_title: "", artifacts };
    }
    return {
      status: "submitted_pending_moderation",
      status_reason: `Generic form submit attempted (${reason}).`,
      created_link: "",
      result_title: "",
      artifacts,
    };
  };

  const ensureCheckboxTicked = async () => {
    return driver.evaluate(() => {
      const hint = /(save my name|remember me|save my|consent|cookie|email.*website)/i;
      const inputs = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']"));
      for (const el of inputs) {
        const label = document.querySelector(`label[for='${el.id}']`);
        const text = String(label?.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").toLowerCase();
        if (!hint.test(text)) continue;
        const checked = (el instanceof HTMLInputElement) ? el.checked : el.getAttribute("aria-checked") === "true";
        if (!checked) {
          label?.click?.();
          el?.click?.();
        }
      }

      const labels = Array.from(document.querySelectorAll("label")).filter((l) => hint.test(String(l.textContent || "").toLowerCase()));
      for (const label of labels) {
        const forId = label.getAttribute("for");
        if (forId) {
          const linked = document.getElementById(forId);
          if (linked && linked instanceof HTMLInputElement && linked.type === "checkbox" && !linked.checked) {
            label.click();
            linked.click();
          }
        } else {
          const box = label.querySelector("input[type='checkbox']");
          if (box && !box.checked) {
            label.click();
            box.click();
          }
        }
      }
      return true;
    }).catch(() => false);
  };

  const autoMapFields = async () => {
    return driver.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const s = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== "none" && s.visibility !== "hidden" && r.width > 4 && r.height > 4;
      };
      const pickSelector = (el) => {
        if (!el) return "";
        const id = el.getAttribute("id");
        if (id) return `#${CSS.escape(id)}`;
        const name = el.getAttribute("name");
        if (name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
        const placeholder = el.getAttribute("placeholder");
        if (placeholder) return `${el.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`;
        return "";
      };
      const inputs = Array.from(document.querySelectorAll("input, textarea")).filter((el) => {
        if (el.tagName.toLowerCase() === "textarea") return true;
        const type = String(el.getAttribute("type") || "text").toLowerCase();
        return ["text", "email", "url", "tel", "number"].includes(type);
      }).filter(isVisible);
      const score = (el, patterns) => {
        const hay = [
          el.getAttribute("name") || "",
          el.getAttribute("id") || "",
          el.getAttribute("placeholder") || "",
          el.getAttribute("aria-label") || "",
          el.getAttribute("title") || "",
          String(el.closest("label")?.textContent || ""),
        ].join(" ").toLowerCase();
        let s = 0;
        for (const p of patterns) {
          if (hay.includes(p)) s += 2;
        }
        const type = String(el.getAttribute("type") || "").toLowerCase();
        if (patterns.includes("email") && type === "email") s += 6;
        if (patterns.includes("url") && type === "url") s += 5;
        return s;
      };

      const emailPatterns = ["email", "e-mail"];
      const namePatterns = ["name", "author", "full name", "your name"];
      const websitePatterns = ["website", "url", "site", "web"];
      const phonePatterns = ["phone", "mobile", "whatsapp", "contact number", "telephone", "tel"];

      const ranked = (patterns) => inputs
        .map((el) => ({ el, score: score(el, patterns) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score);

      const emailEl = ranked(emailPatterns)[0]?.el || inputs.find((el) => String(el.getAttribute("type") || "").toLowerCase() === "email") || null;
      const websiteEl = ranked(websitePatterns)[0]?.el || inputs.find((el) => String(el.getAttribute("type") || "").toLowerCase() === "url") || null;
      const phoneEl = ranked(phonePatterns)[0]?.el || inputs.find((el) => ["tel", "number"].includes(String(el.getAttribute("type") || "").toLowerCase())) || null;
      let nameEl = ranked(namePatterns)[0]?.el || null;
      if (!nameEl) {
        nameEl = inputs.find((el) => {
          const type = String(el.getAttribute("type") || "text").toLowerCase();
          if (!["text", "tel", "number"].includes(type)) return false;
          if (el === emailEl || el === websiteEl || el === phoneEl) return false;
          return true;
        }) || null;
      }

      return {
        email: pickSelector(emailEl),
        name: pickSelector(nameEl),
        website: pickSelector(websiteEl),
        phone: pickSelector(phoneEl),
      };
    }).catch(() => ({ email: "", name: "", website: "", phone: "" }));
  };
  const siteDir = path.join(runDir, runId, siteSlug);
  const sourceUrl = extractPrimaryUrl(row?.directory_url || row?.site_url || "");
  logger?.log?.({
    row_key: rowKey,
    site_name: siteName,
    action: "adaptive_stage",
    status: "running",
    error_message: `start driver=${driver.name}${fallbackUsed ? " fallback" : ""}`,
  });

  let detection = await discoverCommentForm({
    driver,
    page,
    targetLink,
    sourceUrl,
    maxScrollSteps: 10,
  });
  logger?.log?.({
    row_key: rowKey,
    site_name: siteName,
    action: "adaptive_stage",
    status: detection?.found ? "ok" : "failed",
    error_message: detection?.found
      ? `form_detected confidence=${detection.confidence_score} cms=${detection.cms_type_guess}`
      : `form_not_found reason=${String(detection?.reason || "no_form_detected")}`,
  });
  if (!detection?.found) {
    const isCaptchaGate = String(detection?.reason || "") === "captcha_gate";
    const isAccessRequired = ["auth_required", "access_required"].includes(String(detection?.reason || ""));
    const gatewayDetected = await detectAccessGateway(driver).catch(() => ({ detected: false }));
    if (gatewayDetected?.detected) {
      logDebugState(logger, {
        rowKey,
        siteName,
        state: "button_found",
        selector: String(gatewayDetected?.selector_hint || ""),
        actionTaken: "detect_access_gateway",
        result: "success",
        note: "access continuation button detected while form missing",
      });
    }

    if (isAccessRequired || gatewayDetected?.detected) {
      const continuation = await continueAccessGateway({
        driver,
        page,
        row,
        sourceUrl,
        logger,
        rowKey,
        siteName,
      });
      if (continuation.access_status === "access_granted") {
        detection = continuation.detection || await discoverCommentForm({
          driver,
          page,
          targetLink,
          sourceUrl,
          maxScrollSteps: 4,
        }).catch(() => ({ found: false, reason: "no_form_detected" }));
      } else if (continuation.access_status === "manual_access_required") {
        const artifacts = await captureArtifacts({
          page,
          siteDir,
          baseName: "comment_manual_access_required",
          rowKey,
          siteName,
          action: "manual_access_required",
          status: "manual_access_required",
          errorMessage: `${continuation.access_status}:${continuation.next_step}`,
          targetLink,
        });
        return {
          status: "manual_access_required",
          status_reason: `manual_access_required | ${continuation.next_step}`,
          created_link: "",
          result_title: "",
          artifacts,
        };
      }
    }

    if ((isCaptchaGate || isAccessRequired || gatewayDetected?.detected) && waitForManualVerification) {
      logger?.log?.({
        row_key: rowKey,
        site_name: siteName,
        action: "adaptive_stage",
        status: (isAccessRequired || gatewayDetected?.detected) ? "manual_access_required" : "pending_verification",
        error_message: `waiting_for_manual_verification up_to_ms=${verificationWaitMs}`,
      });
      const deadline = Date.now() + verificationWaitMs;
      while (Date.now() < deadline) {
        await sleep(verificationPollMs);
        detection = await discoverCommentForm({
          driver,
          page,
          targetLink,
          sourceUrl,
          maxScrollSteps: 3,
        }).catch(() => ({ found: false, reason: "no_form_detected" }));
        if (detection?.found) {
          logger?.log?.({
            row_key: rowKey,
            site_name: siteName,
            action: "adaptive_stage",
            status: "ok",
            error_message: "manual_verification_completed_form_detected",
          });
          break;
        }
      }
    }
  }

  if (!detection?.found) {
    const reason = String(detection?.reason || "");
    const isCaptchaGate = reason === "captcha_gate";
    const isAccessRequired = ["auth_required", "access_required"].includes(reason);
    if (!isCaptchaGate && !isAccessRequired) {
      const fallbackResult = await tryGenericFallbackFlow({
        reason: `form_not_found:${reason || "no_form_detected"}`,
        commentText: String(row.company_description || row.notes || "").slice(0, 500),
        facts: null,
      });
      if (fallbackResult) return fallbackResult;
    }
    const status = isCaptchaGate
      ? "pending_verification"
      : isAccessRequired
        ? "manual_access_required"
        : "needs_manual_mapping";
    const artifacts = await captureArtifacts({
      page,
      siteDir,
      baseName: isCaptchaGate
        ? "comment_pending_verification"
        : isAccessRequired
          ? "comment_access_required"
          : "comment_needs_manual_mapping",
      rowKey,
      siteName,
      action: isCaptchaGate
        ? "pending_verification"
        : isAccessRequired
          ? "manual_access_required"
          : "needs_manual_mapping",
      status,
      errorMessage: String(detection?.reason || "no_form_detected"),
      targetLink,
    });
    return {
      status,
      status_reason: String(detection?.reason || "no_form_detected"),
      created_link: "",
      result_title: "",
      artifacts,
    };
  }

  const mapped = {
    comment_box_selector: String(target?.selectors?.comment_box || target?.selectors?.description || detection.comment_box_selector || "").trim(),
    submit_selector: String(target?.selectors?.submit_button || target?.selectors?.submit || detection.submit_selector || "button[type='submit'], input[type='submit']").trim(),
    name_selector: String(target?.selectors?.name || detection.name_selector || "input[name*='author' i], input[name*='name' i]").trim(),
    email_selector: String(target?.selectors?.email || detection.email_selector || "input[type='email'], input[name*='email' i]").trim(),
    website_selector: String(target?.selectors?.website || target?.selectors?.target_link || detection.website_selector || "input[name='url'], input[name*='website' i]").trim(),
    phone_selector: String(target?.selectors?.phone || target?.selectors?.mobile || detection.phone_selector || "input[type='tel'], input[name*='phone' i], input[name*='mobile' i]").trim(),
    form_selector: String(target?.selectors?.form || detection.form_selector || "form").trim(),
  };

  const selectorLooksLike = async (selector, hint) => {
    if (!selector) return false;
    return driver.evaluate(({ sel, h }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const type = String(el.getAttribute("type") || "").toLowerCase();
      const hay = [
        el.getAttribute("name") || "",
        el.getAttribute("id") || "",
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
        String(el.closest("label")?.textContent || ""),
      ].join(" ").toLowerCase();
      if (h === "email") return type === "email" || hay.includes("email");
      if (h === "website") return type === "url" || hay.includes("website") || hay.includes("url");
      if (h === "name") return hay.includes("name") || hay.includes("author");
      if (h === "phone") return type === "tel" || type === "number" || hay.includes("phone") || hay.includes("mobile") || hay.includes("whatsapp") || hay.includes("contact");
      return false;
    }, { sel: selector, h: hint }).catch(() => false);
  };

  const autoMap = await autoMapFields();
  if (autoMap?.email && (!(await driver.exists(mapped.email_selector)) || !(await selectorLooksLike(mapped.email_selector, "email")))) {
    mapped.email_selector = autoMap.email;
  }
  if (autoMap?.name && (!(await driver.exists(mapped.name_selector)) || !(await selectorLooksLike(mapped.name_selector, "name")))) {
    mapped.name_selector = autoMap.name;
  }
  if (autoMap?.website && (!(await driver.exists(mapped.website_selector)) || !(await selectorLooksLike(mapped.website_selector, "website")))) {
    mapped.website_selector = autoMap.website;
  }
  if (autoMap?.phone && (!(await driver.exists(mapped.phone_selector)) || !(await selectorLooksLike(mapped.phone_selector, "phone")))) {
    mapped.phone_selector = autoMap.phone;
  }

  const readyBox = await enforceFormVisible(driver, mapped.comment_box_selector);
  if (!readyBox) {
    const fallbackResult = await tryGenericFallbackFlow({
      reason: "comment_box_not_visible",
      commentText: String(row.company_description || row.notes || "").slice(0, 500),
      facts: null,
    });
    if (fallbackResult) return fallbackResult;

    const artifacts = await captureArtifacts({
      page,
      siteDir,
      baseName: "comment_needs_manual_mapping",
      rowKey,
      siteName,
      action: "needs_manual_mapping",
      status: "needs_manual_mapping",
      errorMessage: "no_form_detected",
      targetLink,
    });
    return {
      status: "needs_manual_mapping",
      status_reason: "no_form_detected",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }

  const domain = await driver.evaluate(() => location.hostname.replace(/^www\./, "")).catch(() => "");
  const facts = await collectPageFacts(driver, targetLink);
  const { domainEntries, globalEntries } = historyForDomain(domain);

  const draftPack = generateDraftSet({ facts, domainEntries, globalEntries, maxAttempts: 3, forcePhrase: false });
  const selected = String(draftPack.drafts?.[0]?.text || "").trim();
  if (!selected) {
    const artifacts = await captureArtifacts({
      page,
      siteDir,
      baseName: "comment_needs_manual_mapping",
      rowKey,
      siteName,
      action: "needs_manual_mapping",
      status: "needs_manual_mapping",
      errorMessage: "no_form_detected",
      targetLink,
    });
    return {
      status: "needs_manual_mapping",
      status_reason: "no_form_detected",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }

  const selectedClamped = String(selected || "").slice(0, 420);
  const bestDomain = bestSimilarityAgainst(domainEntries, selectedClamped);
  const bestGlobal = bestSimilarityAgainst(globalEntries, selectedClamped);
  const uniqueness = uniquenessStatusLine(bestDomain, bestGlobal, domainEntries.length);

  if (scrollBeforeType) {
    await driver.evaluate(() => window.scrollBy({ top: Math.floor(Math.random() * 120) + 60, left: 0, behavior: "instant" })).catch(() => {});
    await sleep(100 + Math.floor(Math.random() * 180));
  }

  const profilePayload = buildProfilePayload(selectedClamped);
  const nameVal = String(profilePayload.name || "").trim();
  const emailVal = String(profilePayload.email || "").trim();
  const websiteVal = String(profilePayload.website || "").trim();
  const phoneVal = String(profilePayload.phone || "").trim();
  if (!emailVal || !phoneVal) {
    const artifacts = await captureArtifacts({
      page,
      siteDir,
      baseName: "comment_missing_profile_fields",
      rowKey,
      siteName,
      action: "missing_profile_fields",
      status: "manual_access_required",
      errorMessage: `missing_profile_fields:${!emailVal ? "email" : ""}${(!emailVal && !phoneVal) ? "," : ""}${!phoneVal ? "phone" : ""}`,
      targetLink,
    });
    return {
      status: "manual_access_required",
      status_reason: "missing_profile_fields: email/phone required in saved profile defaults",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }
  if (nameVal) {
    await driver.type(mapped.name_selector, nameVal, { charByChar: true, typingDelayRange: typingDelay }).catch(() => {});
    await forceFieldValue(mapped.name_selector, nameVal);
  }
  if (emailVal) {
    await driver.type(mapped.email_selector, emailVal, { charByChar: true, typingDelayRange: typingDelay }).catch(() => {});
    await forceFieldValue(mapped.email_selector, emailVal);
  }
  if (phoneVal) {
    await driver.type(mapped.phone_selector, phoneVal, { charByChar: true, typingDelayRange: typingDelay }).catch(() => {});
    await forceFieldValue(mapped.phone_selector, phoneVal);
  }
  if (websiteVal) {
    await driver.type(mapped.website_selector, websiteVal, { charByChar: true, typingDelayRange: typingDelay }).catch(() => {});
    await forceFieldValue(mapped.website_selector, websiteVal);
  }

  await forceFieldValue(mapped.comment_box_selector, selectedClamped);
  await driver.type(mapped.comment_box_selector, selectedClamped.slice(0, 140), { charByChar: true, typingDelayRange: typingDelay }).catch(() => {});
  await forceFillCommentEverywhere(selectedClamped);
  const hasCommentAfterInitialType = await driver.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") return String(el.value || "").trim().length > 0;
    if (el.isContentEditable) return String(el.textContent || "").trim().length > 0;
    return false;
  }, mapped.comment_box_selector).catch(() => false);
  if (!hasCommentAfterInitialType) {
    await driver.click(mapped.comment_box_selector, { timeout: 5000 }).catch(() => {});
    await page.keyboard.type(selectedClamped.slice(0, 120), { delay: 14 }).catch(() => {});
    await forceFillCommentEverywhere(selectedClamped);
  }

  const hasCommentText = await driver.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") return String(el.value || "").trim().length > 0;
    if (el.isContentEditable) return String(el.textContent || "").trim().length > 0;
    return false;
  }, mapped.comment_box_selector).catch(() => false);
  if (!hasCommentText) {
    const bruteFilled = await forceFillCommentEverywhere(selectedClamped);
    if (bruteFilled) {
      const verifyBrute = await driver.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "textarea" || tag === "input") return String(el.value || "").trim().length > 0;
        if (el.isContentEditable) return String(el.textContent || "").trim().length > 0;
        return false;
      }, mapped.comment_box_selector).catch(() => false);
      if (verifyBrute) {
        logger?.log?.({
          row_key: rowKey,
          site_name: siteName,
          action: "adaptive_stage",
          status: "ok",
          error_message: "comment_box_force_fill_recovered",
        });
      }
    }
  }

  const hasCommentTextFinal = await driver.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "textarea" || tag === "input") return String(el.value || "").trim().length > 0;
    if (el.isContentEditable) return String(el.textContent || "").trim().length > 0;
    return false;
  }, mapped.comment_box_selector).catch(() => false);
  if (!hasCommentTextFinal) {
    const fallbackResult = await tryGenericFallbackFlow({
      reason: "comment_box_fill_failed",
      commentText: selectedClamped,
      facts,
    });
    if (fallbackResult) return fallbackResult;

    const artifacts = await captureArtifacts({
      page,
      siteDir,
      baseName: "comment_needs_manual_mapping",
      rowKey,
      siteName,
      action: "needs_manual_mapping",
      status: "needs_manual_mapping",
      errorMessage: "comment_box_fill_failed",
      targetLink,
    });
    return {
      status: "needs_manual_mapping",
      status_reason: "comment_box_fill_failed",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }
  // Safety net: force-fill any visible required email/tel fields still empty.
  await driver.evaluate((vals) => {
    const isVisible = (el) => {
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 3 && r.height > 3;
    };
    const fill = (el, v) => {
      if (!el || !v) return false;
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    };
    const reqInputs = Array.from(document.querySelectorAll("input[required], input[aria-required='true']"))
      .filter((el) => isVisible(el) && !el.disabled && !el.readOnly);
    for (const el of reqInputs) {
      const type = String(el.getAttribute("type") || "text").toLowerCase();
      const hint = [
        el.getAttribute("name") || "",
        el.getAttribute("id") || "",
        el.getAttribute("placeholder") || "",
        el.getAttribute("aria-label") || "",
        el.getAttribute("title") || "",
      ].join(" ").toLowerCase();
      if (String(el.value || "").trim()) continue;
      if (type === "email" || hint.includes("email")) fill(el, vals.email);
      else if (type === "tel" || type === "number" || hint.includes("phone") || hint.includes("mobile") || hint.includes("contact")) fill(el, vals.phone);
      else if (hint.includes("name") || hint.includes("author")) fill(el, vals.name);
      else if (type === "url" || hint.includes("website") || hint.includes("url")) fill(el, vals.website);
    }
    return true;
  }, { name: nameVal, email: emailVal, phone: phoneVal, website: websiteVal }).catch(() => {});

    await ensureCheckboxTicked();

    await driver.evaluate(() => {
      const textHints = /(save my name|remember me|save my|consent|cookie)/i;
      const candidates = Array.from(document.querySelectorAll("input[type='checkbox'], [role='checkbox']"));
      for (const box of candidates) {
        const label = document.querySelector(`label[for='${box.id}']`);
        const labelText = String(label?.textContent || box.getAttribute("aria-label") || "").toLowerCase();
        if (!textHints.test(labelText)) continue;
        const isChecked = (box instanceof HTMLInputElement) ? box.checked : box.getAttribute("aria-checked") === "true";
        if (!isChecked) {
          label?.click?.();
          box?.click?.();
        }
      }
    }).catch(() => {});
  logDebugState(logger, {
    rowKey,
    siteName,
    state: "form_filled",
    selector: mapped.comment_box_selector,
    actionTaken: "fill_comment_form_fields",
    result: "success",
    note: `comment=${mapped.comment_box_selector}; name=${mapped.name_selector}; email=${mapped.email_selector}; phone=${mapped.phone_selector}; website=${mapped.website_selector}`,
  });
  logger?.log?.({
    row_key: rowKey,
    site_name: siteName,
    action: "adaptive_stage",
    status: "ok",
    error_message: "fields_prefilled_waiting_approval",
  });

  const approval = autoApproveSubmit
    ? { approved: true, screenshotPath: "", htmlPath: "", decision: {} }
    : await requestHumanApproval({
        page,
        runDir,
        runId,
        siteSlug,
        siteName,
        rowKey,
        mode: approvalMode,
        artifactNameBase: "pre_submit_adaptive",
        forceManual: forceManualApproval,
        prefillOnly,
        requestPayload: {
          status: "ready_to_submit",
          driver_used: driver.name,
          cms_guess: detection.cms_type_guess,
          detection_confidence: detection.confidence_score,
          form_detected: true,
          fallback_used: fallbackUsed,
          scroll_steps: detection.scroll_steps,
          detected_fields: mapped,
          page_facts: {
            title: facts.title,
            headings: facts.headings.slice(0, 4),
            key_sentences: facts.key_sentences.slice(0, 4),
            quote_fragment: facts.quote_fragment,
          },
          draft_selected: selectedClamped,
          draft_suggestions: draftPack.drafts,
          draft_hash: hashText(selectedClamped),
          similarity_score: Number(Math.max(bestDomain, bestGlobal).toFixed(3)),
          uniqueness_check: uniqueness,
          similarity_blocked: draftPack.allBlocked,
          warnings: draftPack.warnings,
        },
      });
  logger?.log?.({
    row_key: rowKey,
    site_name: siteName,
    action: "adaptive_stage",
    status: approval?.approved ? "ok" : "skipped",
    error_message: approval?.approved ? "approval_granted" : "approval_not_granted",
  });

  if (!approval.approved) {
    const timedOut = Boolean(approval?.decision?.timed_out);
    return {
      status: "skipped",
      status_reason: timedOut
        ? "Approval checkpoint timed out."
        : "Operator declined submit at ready_to_submit checkpoint.",
      created_link: "",
      result_title: "",
      artifacts: [approval.screenshotPath, approval.htmlPath].filter(Boolean),
    };
  }

  const finalDraft = String(approval?.decision?.edited_draft || selectedClamped).trim().slice(0, 420);
  const finalDomainSim = bestSimilarityAgainst(domainEntries, finalDraft);
  const finalGlobalSim = bestSimilarityAgainst(globalEntries, finalDraft);

  if (!skipDuplicateBlock && (finalDomainSim >= DOMAIN_SIM_THRESHOLD || finalGlobalSim >= GLOBAL_SIM_THRESHOLD)) {
    const regenPack = generateDraftSet({ facts, domainEntries, globalEntries, maxAttempts: 3, forcePhrase: true });
    await requestHumanApproval({
      page,
      runDir,
      runId,
      siteSlug,
      siteName,
      rowKey,
      mode: "ui",
      artifactNameBase: "similarity_ready_to_submit",
      forceManual: true,
      prefillOnly: forceManualApproval || prefillOnly,
      requestPayload: {
        status: "ready_to_submit",
        duplicate_warning: "Similarity block triggered before submit. New drafts generated.",
        detected_fields: mapped,
        draft_selected: String(regenPack.drafts?.[0]?.text || ""),
        draft_suggestions: regenPack.drafts,
        uniqueness_check: uniquenessStatusLine(finalDomainSim, finalGlobalSim, domainEntries.length),
        similarity_blocked: true,
      },
    });

    const artifacts = await captureArtifacts({
      page,
      siteDir,
      baseName: "duplicate_prevented",
      rowKey,
      siteName,
      action: "duplicate_prevented",
      status: "failed_duplicate",
      errorMessage: "Similarity threshold exceeded; new drafts generated.",
      targetLink,
    });

    return {
      status: "failed_duplicate",
      status_reason: "Duplicate risk blocked before submit. New drafts generated.",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }

  await driver.type(mapped.comment_box_selector, finalDraft, { charByChar: true, typingDelayRange: typingDelay }).catch(() => {});

  const beforeSubmitUrl = String(page.url() || "");
  logDebugState(logger, {
    rowKey,
    siteName,
    state: "submit_attempted",
    selector: mapped.submit_selector,
    actionTaken: "click_submit",
    result: "running",
    note: "attempting submit click",
  });
  const submitClicked = await driver.click(mapped.submit_selector, {
    timeout: 12000,
    maxAttempts: 3,
    verifyUrlChangedFrom: beforeSubmitUrl,
    verifyAppearSelector: "body",
  }).catch(() => false);
  if (!submitClicked) {
    await driver.click("button[type='submit'], input[type='submit']", {
      timeout: 12000,
      maxAttempts: 3,
      verifyUrlChangedFrom: beforeSubmitUrl,
      verifyAppearSelector: "body",
    }).catch(() => false);
    logger?.log?.({
      row_key: rowKey,
      site_name: siteName,
      action: "adaptive_stage",
      status: "running",
      error_message: "submit_click_unverified_retry_fallback",
    });
  }
  await sleep(2200);

  const post = await detectPostSignals(driver);
  const artifacts = await captureArtifacts({
    page,
    siteDir,
    baseName: "post_submit_adaptive",
    rowKey,
    siteName,
    action: "post_submit_state",
    status: "submitted",
    errorMessage: "post submit snapshot",
    targetLink,
  });

  if (post.hasCaptcha) {
    return {
      status: "pending_verification",
      status_reason: "captcha_gate",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }
  if (post.isBlocked) {
    return {
      status: "blocked",
      status_reason: "blocked_by_site",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }

  if (!skipDuplicateBlock && post.isDuplicate) {
    const regenPack = generateDraftSet({ facts, domainEntries, globalEntries, maxAttempts: 3, forcePhrase: true });
    await requestHumanApproval({
      page,
      runDir,
      runId,
      siteSlug,
      siteName,
      rowKey,
      mode: "ui",
      artifactNameBase: "duplicate_ready_to_submit",
      forceManual: true,
      prefillOnly: forceManualApproval || prefillOnly,
      requestPayload: {
        status: "ready_to_submit",
        duplicate_warning: "Duplicate detected. New drafts generated.",
        detected_fields: mapped,
        draft_selected: String(regenPack.drafts?.[0]?.text || ""),
        draft_suggestions: regenPack.drafts,
        uniqueness_check: uniquenessStatusLine(bestSimilarityAgainst(domainEntries, String(regenPack.drafts?.[0]?.text || "")), bestSimilarityAgainst(globalEntries, String(regenPack.drafts?.[0]?.text || "")), domainEntries.length),
      },
    });
    return {
      status: "failed_duplicate",
      status_reason: "Duplicate detected. New drafts generated.",
      created_link: "",
      result_title: "",
      artifacts,
    };
  }

  const draftSnippet = normalizeCommentText(finalDraft).split(" ").slice(0, 10).join(" ");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  await sleep(1400);

  const verify = await driver.evaluate((snippet, beforeUrlVal) => {
    const body = String(document.body?.innerText || "").toLowerCase();
    const hash = String(location.hash || "").toLowerCase();
    const url = String(location.href || "");
    const moderation = /your comment is awaiting moderation|awaiting moderation|held for moderation/.test(body);
    const textSeen = snippet ? body.includes(String(snippet || "").toLowerCase()) : false;
    const commentAnchor = /#comment-\d+/.test(hash) || /#comment-\d+/.test(url);
    const redirectedBack = beforeUrlVal ? url.split("#")[0] === String(beforeUrlVal || "").split("#")[0] : false;
    return { moderation, textSeen, commentAnchor, redirectedBack };
  }, draftSnippet, beforeSubmitUrl).catch(() => ({ moderation: false, textSeen: false, commentAnchor: false, redirectedBack: false }));

  if (verify.moderation || verify.textSeen || verify.commentAnchor) {
    appendHistory({ domain, url: targetLink, commentText: finalDraft });
    logDebugState(logger, {
      rowKey,
      siteName,
      state: "success",
      selector: mapped.submit_selector,
      actionTaken: "verify_post_submit",
      result: "success",
      note: verify.moderation ? "awaiting moderation signal found" : "comment presence/anchor signal found",
    });
    return {
      status: "success",
      status_reason: verify.moderation ? "Your comment is awaiting moderation." : "Comment verification signal detected.",
      created_link: verify.commentAnchor ? String(page.url() || "") : "",
      result_title: "",
      artifacts,
    };
  }

  appendHistory({ domain, url: targetLink, commentText: finalDraft });
  logDebugState(logger, {
    rowKey,
    siteName,
    state: "fail",
    selector: mapped.submit_selector,
    actionTaken: "verify_post_submit",
    result: "fail",
    note: "no explicit success signal after submit; marked submitted_pending_moderation",
  });
  return {
    status: "submitted_pending_moderation",
    status_reason: "No duplicate signal; submit likely pending moderation.",
    created_link: "",
    result_title: "",
    artifacts,
  };
}
