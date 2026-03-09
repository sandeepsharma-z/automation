import fs from "node:fs";

const RELIABILITY_DELAYS = {
  afterNavigationMs: 2000,
  afterScrollMs: 500,
  beforeClickMs: 800,
  afterClickMs: 3000,
  betweenFieldsMs: 300,
};

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function parseTypingRange(input, fallback = [40, 120]) {
  const raw = String(input || "").trim();
  if (!raw.includes("-")) return fallback;
  const [a, b] = raw.split("-").map((v) => Number(v.trim()));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return fallback;
  return [Math.max(5, Math.min(a, b)), Math.max(5, Math.max(a, b))];
}

function randInt(min, max) {
  const lo = Math.min(Number(min || 0), Number(max || 0));
  const hi = Math.max(Number(min || 0), Number(max || 0));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

class BaseDriver {
  constructor(page, name) {
    this.page = page;
    this.name = name;
  }

  async goto(url, options = {}) {
    const res = await this.page.goto(url, options);
    await waitMs(RELIABILITY_DELAYS.afterNavigationMs);
    return res;
  }

  async evaluate(fn, arg) {
    return this.page.evaluate(fn, arg);
  }

  async queryFirstVisible(selectors = []) {
    for (const selector of selectors) {
      const loc = this.page.locator(selector).first();
      const visible = await loc.isVisible({ timeout: 250 }).catch(() => false);
      if (visible) return { selector, locator: loc };
    }
    return null;
  }

  async exists(selector) {
    const count = await this.page.locator(selector).count().catch(() => 0);
    return Number(count || 0) > 0;
  }

  async scrollIntoView(selector) {
    await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }, selector).catch(() => {});
    await this.page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await waitMs(RELIABILITY_DELAYS.afterScrollMs);
  }

  async isInViewport(selector) {
    return this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      return r.bottom >= 0 && r.right >= 0 && r.top <= window.innerHeight && r.left <= window.innerWidth;
    }, selector).catch(() => false);
  }

  async isElementInteractable(selector) {
    return this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: "missing" };
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none" || rect.width <= 0 || rect.height <= 0) {
        return { ok: false, reason: "not_visible" };
      }
      const disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
      if (disabled) return { ok: false, reason: "disabled" };
      const cx = rect.left + (rect.width / 2);
      const cy = rect.top + (rect.height / 2);
      const topEl = document.elementFromPoint(cx, cy);
      if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
        return { ok: false, reason: "covered" };
      }
      return { ok: true, reason: "" };
    }, selector).catch(() => ({ ok: false, reason: "check_failed" }));
  }

  async stabilizeElement(selector, waitVisibleMs = 5000) {
    await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }, selector).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    const inViewport = await this.isInViewport(selector);
    if (!inViewport) {
      await this.page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.page.locator(selector).first().waitFor({ state: "visible", timeout: waitVisibleMs }).catch(() => {});
    return this.isElementInteractable(selector);
  }

  async click(selector, options = {}) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts || 3));
    const waitVisibleMs = Math.max(500, Number(options.waitVisibleMs || 5000));
    const settleMs = Math.max(0, Number(options.settleMs == null ? RELIABILITY_DELAYS.beforeClickMs : options.settleMs));
    const postClickMs = Math.max(0, Number(options.postClickMs == null ? RELIABILITY_DELAYS.afterClickMs : options.postClickMs));
    const verifyUrlChangedFrom = String(options.verifyUrlChangedFrom || "");
    const verifyAppearSelector = String(options.verifyAppearSelector || "");
    let lastReason = "";

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const ready = await this.stabilizeElement(selector, waitVisibleMs);
      if (!ready.ok) {
        lastReason = `ready_check:${ready.reason || "unknown"}`;
      }

      await new Promise((r) => setTimeout(r, settleMs));

      try {
        await this.page.locator(selector).first().click({
          timeout: Number(options.timeout || 8000),
          force: Boolean(options.force || false),
          trial: false,
          delay: Number(options.delay || 0),
        });
        await waitMs(postClickMs);
      } catch (err) {
        lastReason = `click_error:${String(err?.message || err || "unknown")}`;
      }

      let verified = false;
      if (!verifyUrlChangedFrom && !verifyAppearSelector) {
        verified = true;
      } else {
        const urlChanged = verifyUrlChangedFrom
          ? String(this.page.url() || "") !== verifyUrlChangedFrom
          : false;
        const appeared = verifyAppearSelector
          ? await this.page.locator(verifyAppearSelector).first().isVisible({ timeout: 1200 }).catch(() => false)
          : false;
        verified = urlChanged || appeared;
      }
      if (verified) return true;

      lastReason = lastReason || "verify_not_met";
      await this.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
      }, selector).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
    }

    // Best-effort final attempt so flow can continue with logging upstream.
    await this.page.locator(selector).first().click({ timeout: 3000 }).catch(() => {});
    await waitMs(postClickMs);
    return false;
  }

  async type(selector, text, options = {}) {
    const value = String(text || "");
    const [minDelay, maxDelay] = parseTypingRange(options.typingDelayRange, [40, 120]);
    const input = this.page.locator(selector).first();
    await input.click({ timeout: 4000 }).catch(() => {});
    const filled = await input.fill(value, { timeout: 6000 }).then(() => true).catch(() => false);
    if (filled && !options.charByChar) {
      await waitMs(RELIABILITY_DELAYS.betweenFieldsMs);
      return;
    }
    await input.fill("").catch(() => {});
    for (const ch of value) {
      await input.type(ch, { delay: randInt(minDelay, maxDelay) }).catch(() => {});
    }

    // Fallback for sites where Playwright typing/fill is blocked by overlays or custom listeners.
    const hasValue = await this.page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const tag = String(el.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input") return String(el.value || "").trim().length > 0;
      if (el.isContentEditable) return String(el.textContent || "").trim().length > 0;
      return false;
    }, selector).catch(() => false);
    if (hasValue) return;

    await this.page.evaluate(({ sel, val }) => {
      const target = document.querySelector(sel);
      if (!target) return false;
      const tag = String(target.tagName || "").toLowerCase();
      if (tag === "textarea" || tag === "input") {
        target.focus();
        target.value = val;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(new Event("blur", { bubbles: true }));
        return String(target.value || "").trim().length > 0;
      }
      if (target.isContentEditable) {
        target.focus();
        target.textContent = val;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
        target.dispatchEvent(new Event("blur", { bubbles: true }));
        return String(target.textContent || "").trim().length > 0;
      }
      return false;
    }, { sel: selector, val: value }).catch(() => false);
    await waitMs(RELIABILITY_DELAYS.betweenFieldsMs);
  }

  async screenshot(filePath) {
    return this.page.screenshot({ path: filePath, fullPage: true });
  }

  async htmlSnapshot(filePath) {
    const html = await this.page.content().catch(() => "");
    fs.writeFileSync(filePath, html, "utf8");
    return filePath;
  }
}

export class OpenClawDriver extends BaseDriver {
  constructor(page) {
    super(page, "openclaw");
  }
}

export class PlaywrightDriver extends BaseDriver {
  constructor(page) {
    super(page, "playwright");
  }
}

export function createBrowserDriver(page, preferred = "") {
  const wanted = String(preferred || process.env.BROWSER_DRIVER || "openclaw").trim().toLowerCase();
  const allowFallback = String(process.env.BROWSER_DRIVER_FALLBACK || "1").trim() === "1";
  if (wanted === "openclaw") {
    if (String(process.env.OPENCLAW_DISABLED || "0").trim() === "1" && allowFallback) {
      return { driver: new PlaywrightDriver(page), fallbackUsed: true };
    }
    return { driver: new OpenClawDriver(page), fallbackUsed: false };
  }
  return { driver: new PlaywrightDriver(page), fallbackUsed: false };
}
