import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { enrichRowWithAi } from "./ai_fill.js";
import { applyGenericMapper } from "./mappers/generic.js";
import { runInteractiveSelectorMapper } from "./selector_mapper.js";
import { requestHumanApproval } from "./approval.js";
import { extractSubmissionResult } from "./extract.js";
import { runAdaptiveBlogCommenting } from "./blog_comment_intelligence.js";
import { createRunLogger } from "./logger.js";
import { ensureColumns, getQueue, updateRow } from "./sheets.js";
import { ensureLocalStore, getLocalQueue, updateLocalRow } from "./local_store.js";
import { findAllowlistedTarget, loadTargets, resolveTargetsPath, upsertTargetSelectors, validateTargetMapping } from "./targets.js";
import { getWorkflow } from "./workflows/index.js";
import { ensureDir, nowIso, parseArgs, randomInt, sleep, slugify, writeJson } from "./utils.js";

const args = parseArgs(process.argv.slice(2));

const PROJECT_ROOT = path.resolve(path.join(import.meta.dirname, ".."));
const RUNS_ROOT = path.join(PROJECT_ROOT, "runs");
const HEADLESS = String(process.env.HEADLESS || "0") === "1";
const APPROVAL_MODE = String(process.env.APPROVAL_MODE || "ui").toLowerCase();
const RETRIES = 2;
const LIMIT = Number(args.limit || 1);
const FORCE_RETRY = String(args["force-retry"] || "0") === "1";
const FORCE = String(args.force || "0") === "1" || FORCE_RETRY;
const ONLY_ROW_KEY = String(args["row-key"] || "");
const RUN_ID = String(args["run-id"] || `${Date.now()}-${randomInt(1000, 9999)}`);
const DATA_SOURCE = String(process.env.DATA_SOURCE || "local").toLowerCase();
const MIN_DELAY_MIN = Number(process.env.MIN_DELAY_MINUTES || 3);
const MAX_DELAY_MIN = Number(process.env.MAX_DELAY_MINUTES || 7);
const SKIP_DELAY = String(process.env.SKIP_DELAY || "0") === "1";
const AUTO_APPROVE_SUBMIT = String(process.env.AUTO_APPROVE_SUBMIT || "1") === "1";
const TARGET_PROCESS_TIMEOUT_MS = Math.max(45000, Number(process.env.TARGET_PROCESS_TIMEOUT_MS || 8 * 60 * 1000));
const TARGETS_PATH = resolveTargetsPath(PROJECT_ROOT);
const RELIABILITY_DELAYS = {
  afterNavigationMs: 2000,
  afterScrollMs: 500,
};

ensureDir(RUNS_ROOT);
const logger = createRunLogger(RUN_ID, RUNS_ROOT);

// === STEALTH CONFIGURATION ===
const STEALTH_ENABLED = String(process.env.STEALTH_MODE || "1") === "1";
const HUMAN_BEHAVIOR_ENABLED = String(process.env.HUMAN_BEHAVIOR || "1") === "1";
const MOUSE_STATE = new WeakMap();

async function smoothMouseMove(page, targetX, targetY) {
  const viewport = page.viewportSize() || { width: 1920, height: 1080 };
  const prev = MOUSE_STATE.get(page) || {
    x: Math.floor(viewport.width * 0.5),
    y: Math.floor(viewport.height * 0.5),
  };
  const startX = Number(prev.x || 0);
  const startY = Number(prev.y || 0);

  const steps = 15 + Math.floor(Math.random() * 6); // 15-20
  const dx = targetX - startX;
  const dy = targetY - startY;
  const controlX = startX + dx * 0.5 + (Math.random() - 0.5) * Math.max(18, Math.abs(dx) * 0.22);
  const controlY = startY + dy * 0.5 + (Math.random() - 0.5) * Math.max(18, Math.abs(dy) * 0.22);

  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const oneMinusT = 1 - t;
    const x = oneMinusT * oneMinusT * startX + 2 * oneMinusT * t * controlX + t * t * targetX;
    const y = oneMinusT * oneMinusT * startY + 2 * oneMinusT * t * controlY + t * t * targetY;
    await page.mouse.move(x, y);
    await sleep(10 + Math.floor(Math.random() * 21)); // 10-30ms
  }

  MOUSE_STATE.set(page, { x: targetX, y: targetY });
}

async function realisticTyping(page, selector, text) {
  const input = page.locator(selector).first();
  await input.click({ delay: 60 + Math.floor(Math.random() * 91), timeout: 4000 }).catch(() => {});
  await sleep(80 + Math.floor(Math.random() * 140));

  const pressChar = async (char) => {
    await page.keyboard.press(char).catch(async () => {
      await page.keyboard.insertText(char).catch(() => {});
    });
  };

  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];

    if (Math.random() < 0.03 && /[a-zA-Z]/.test(char)) {
      let wrongChar = char.toLowerCase();
      while (wrongChar === char.toLowerCase()) {
        wrongChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
      }
      await pressChar(wrongChar);
      await sleep(160 + Math.floor(Math.random() * 141));
      await page.keyboard.press("Backspace").catch(() => {});
      await sleep(160 + Math.floor(Math.random() * 141));
      await pressChar(char);
      await sleep(90 + Math.floor(Math.random() * 111));
      continue;
    }

    await pressChar(char);
    await sleep(50 + Math.floor(Math.random() * 101)); // 50-150ms

    if (char === " ") {
      await sleep(200 + Math.floor(Math.random() * 301)); // 200-500ms
    }
  }
}

async function handleInteractiveElement(page) {
  const MAX_RETRIES = 3;
  const challengeSignals = [
    "iframe[title*='challenge' i]",
    "iframe[title*='captcha' i]",
    "iframe[src*='captcha']",
    "iframe[src*='challenge']",
    "[id*='captcha' i]",
    "[class*='captcha' i]",
    "[id*='challenge' i]",
    "[class*='challenge' i]",
    "[aria-label*='captcha' i]",
  ];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const iframeLocator = page.locator("iframe").filter({
        has: page.locator("input[type='checkbox']"),
      }).first();

      const iframeVisible = await iframeLocator.isVisible({ timeout: 1200 }).catch(() => false);
      if (!iframeVisible) {
        return "completed";
      }

      const iframeBox = await iframeLocator.boundingBox();
      if (!iframeBox) {
        return "retry";
      }

      const moveX = iframeBox.x + iframeBox.width * (0.45 + Math.random() * 0.1);
      const moveY = iframeBox.y + iframeBox.height * (0.45 + Math.random() * 0.1);

      await smoothMouseMove(page, moveX, moveY);
      await sleep(250 + Math.floor(Math.random() * 450));
      await page.mouse.click(moveX, moveY, { delay: 60 + Math.floor(Math.random() * 90) });

      await sleep(3000);

      let hasChallenge = false;
      for (const signal of challengeSignals) {
        const visible = await page.locator(signal).first().isVisible({ timeout: 600 }).catch(() => false);
        if (visible) {
          hasChallenge = true;
          break;
        }
      }

      if (!hasChallenge) {
        return "completed";
      }

      if (attempt < MAX_RETRIES) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
        await sleep(1000 + Math.floor(Math.random() * 900));
        continue;
      }

      return "manual_needed";
    } catch (_) {
      if (attempt >= MAX_RETRIES) return "manual_needed";
      await page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await sleep(1000 + Math.floor(Math.random() * 900));
    }
  }

  return "manual_needed";
}

function resolveBrowserLaunchOptions(headlessOverride = null) {
  const resolvedHeadless = headlessOverride == null ? HEADLESS : Boolean(headlessOverride);
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
          headless: resolvedHeadless, 
          executablePath: bin,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-popup-blocking',
            '--disable-prompt-on-repost',
            '--force-color-profile=srgb',
            '--no-first-run',
            '--password-store=basic',
            '--use-mock-keychain',
            '--window-size=1920,1080',
            '--start-maximized',
            '--lang=en-US,en',
            '--timezone=America/New_York',
            `--user-agent=${getRandomUserAgent()}`,
          ]
        };
      }
    } catch (_) {
      // continue
    }
  }
  return { 
    headless: resolvedHeadless,
    args: ['--disable-blink-features=AutomationControlled']
  };
}

function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// === STEALTH INJECTION SCRIPT ===
const STEALTH_SCRIPT = `
(() => {
  // Override navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });

  // Override chrome runtime
  window.chrome = {
    runtime: {
      OnInstalledReason: {
        CHROME_UPDATE: "chrome_update",
        INSTALL: "install",
        SHARED_MODULE_UPDATE: "shared_module_update",
        UPDATE: "update"
      },
      OnRestartRequiredReason: {
        APP_UPDATE: "app_update",
        OS_UPDATE: "os_update",
        PERIODIC: "periodic"
      },
      PlatformArch: {
        ARM: "arm",
        ARM64: "arm64",
        MIPS: "mips",
        MIPS64: "mips64",
        X86_32: "x86-32",
        X86_64: "x86-64"
      },
      PlatformNaclArch: {
        ARM: "arm",
        MIPS: "mips",
        MIPS64: "mips64",
        MIPS64EL: "mips64el",
        MIPSEL: "mipsel",
        X86_32: "x86-32",
        X86_64: "x86-64"
      },
      PlatformOs: {
        ANDROID: "android",
        CROS: "cros",
        LINUX: "linux",
        MAC: "mac",
        OPENBSD: "openbsd",
        WIN: "win"
      },
      RequestUpdateCheckStatus: {
        NO_UPDATE: "no_update",
        THROTTLED: "throttled",
        UPDATE_AVAILABLE: "update_available"
      }
    }
  };

  // Override permissions
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) => (
    parameters.name === 'notifications' ?
      Promise.resolve({ state: Notification.permission }) :
      originalQuery(parameters)
  );

  // Override plugins
  Object.defineProperty(navigator, 'plugins', {
    get: () => [
      {
        name: "Chrome PDF Plugin",
        filename: "internal-pdf-viewer",
        description: "Portable Document Format",
        version: "undefined",
        length: 1,
        item: () => null,
        namedItem: () => null
      },
      {
        name: "Chrome PDF Viewer",
        filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
        description: "Portable Document Format",
        version: "undefined",
        length: 1,
        item: () => null,
        namedItem: () => null
      },
      {
        name: "Native Client",
        filename: "internal-nacl-plugin",
        description: "Native Client module",
        version: "undefined",
        length: 2,
        item: () => null,
        namedItem: () => null
      }
    ]
  });

  // Override languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en', 'hi-IN']
  });

  // Override WebGL
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter(parameter);
  };

  // Canvas fingerprint randomization
  const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const originalGetImageData = CanvasRenderingContext2D.prototype.getImageData;
  
  HTMLCanvasElement.prototype.toDataURL = function(type, encoderOptions) {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = this.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(this, 0, 0);
    
    // Add subtle noise
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      if (Math.random() > 0.95) {
        data[i] += Math.random() > 0.5 ? 1 : -1;
        data[i+1] += Math.random() > 0.5 ? 1 : -1;
        data[i+2] += Math.random() > 0.5 ? 1 : -1;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return originalToDataURL.call(canvas, type, encoderOptions);
  };

  // Override notification
  window.Notification = class Notification {
    static permission = "default";
    static requestPermission = () => Promise.resolve("default");
    constructor() {}
  };

  // Override device memory
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => 8
  });

  // Override hardware concurrency
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => 4
  });
})();
`;

// === HUMAN BEHAVIOR SIMULATION ===
class HumanBehaviorSimulator {
  constructor(page) {
    this.page = page;
    this.mouseX = 0;
    this.mouseY = 0;
  }

  async naturalDelay(min = 1000, max = 4000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    // Add "thinking" time occasionally
    if (Math.random() > 0.7) {
      await sleep(delay + Math.floor(Math.random() * 2000));
    } else {
      await sleep(delay);
    }
  }

  async humanLikeTyping(selector, text) {
    if (typeof selector === "string") {
      await realisticTyping(this.page, selector, text);
      return;
    }

    const element = selector;
    await element.click({ delay: 60 + Math.floor(Math.random() * 91), timeout: 4000 }).catch(() => {});
    await sleep(80 + Math.floor(Math.random() * 140));

    const pressChar = async (char) => {
      await this.page.keyboard.press(char).catch(async () => {
        await this.page.keyboard.insertText(char).catch(() => {});
      });
    };

    const value = String(text || "");
    for (let i = 0; i < value.length; i += 1) {
      const char = value[i];
      if (Math.random() < 0.03 && /[a-zA-Z]/.test(char)) {
        let wrongChar = char.toLowerCase();
        while (wrongChar === char.toLowerCase()) {
          wrongChar = String.fromCharCode(97 + Math.floor(Math.random() * 26));
        }
        await pressChar(wrongChar);
        await sleep(160 + Math.floor(Math.random() * 141));
        await this.page.keyboard.press("Backspace").catch(() => {});
        await sleep(160 + Math.floor(Math.random() * 141));
        await pressChar(char);
        await sleep(90 + Math.floor(Math.random() * 111));
        continue;
      }
      await pressChar(char);
      await sleep(50 + Math.floor(Math.random() * 101));
      if (char === " ") {
        await sleep(200 + Math.floor(Math.random() * 301));
      }
    }
  }

  async naturalMouseMove(targetX, targetY) {
    await smoothMouseMove(this.page, targetX, targetY);
    this.mouseX = targetX;
    this.mouseY = targetY;
  }

  async naturalScroll(direction = 'down', intensity = 'medium') {
    const amounts = {
      low: [100, 300],
      medium: [300, 600],
      high: [600, 1000]
    };
    
    const [min, max] = amounts[intensity];
    const targetScroll = Math.floor(Math.random() * (max - min + 1)) + min;
    let scrolled = 0;
    
    while (scrolled < targetScroll) {
      const chunk = Math.floor(Math.random() * 100) + 50;
      const scrollAmount = direction === 'down' ? chunk : -chunk;
      
      await this.page.evaluate((y) => window.scrollBy({ top: y, left: 0, behavior: 'smooth' }), scrollAmount);
      scrolled += chunk;
      
      // Reading pause
      await sleep(Math.random() * 1500 + 500);
      
      // Occasional reverse scroll (re-reading)
      if (Math.random() > 0.9) {
        await this.page.evaluate((y) => window.scrollBy({ top: y, left: 0, behavior: 'smooth' }), -chunk / 2);
        await sleep(Math.random() * 1000 + 300);
      }
    }
    
    // Final reading pause
    await sleep(Math.random() * 2000 + 1000);
  }

  async randomInteraction() {
    const interactions = [
      () => this.randomHover(),
      () => this.randomClick(),
      () => this.randomTabSwitch(),
      () => this.randomTextSelection()
    ];
    
    const randomInteraction = interactions[Math.floor(Math.random() * interactions.length)];
    await randomInteraction();
  }

  async randomHover() {
    const elements = await this.page.locator('p, h1, h2, h3, article').all();
    if (elements.length > 0) {
      const randomElement = elements[Math.floor(Math.random() * elements.length)];
      const box = await randomElement.boundingBox();
      if (box) {
        await this.naturalMouseMove(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(Math.random() * 1000 + 500);
      }
    }
  }

  async randomClick() {
    const safeSelectors = ['p', 'article', 'main', 'section'];
    const selector = safeSelectors[Math.floor(Math.random() * safeSelectors.length)];
    const elements = await this.page.locator(selector).all();
    if (elements.length > 0) {
      const randomElement = elements[Math.floor(Math.random() * elements.length)];
      await randomElement.click({ force: true }).catch(() => {});
    }
  }

  async randomTabSwitch() {
    // Simulate Alt+Tab behavior
    await this.page.evaluate(() => {
      window.blur();
      setTimeout(() => window.focus(), Math.random() * 1000 + 500);
    });
    await sleep(Math.random() * 1500 + 1000);
  }

  async randomTextSelection() {
    try {
      const heading = await this.page.locator('h1, h2').first();
      const box = await heading.boundingBox();
      if (box) {
        await this.page.mouse.move(box.x, box.y);
        await this.page.mouse.down();
        await this.page.mouse.move(box.x + box.width, box.y + box.height);
        await this.page.mouse.up();
        await sleep(Math.random() * 500 + 200);
      }
    } catch (_) {}
  }
}

// === CAPTCHA EVASION STRATEGIES ===
class CaptchaEvasion {
  constructor(page, humanSimulator) {
    this.page = page;
    this.human = humanSimulator;
  }

  async injectStealth() {
    if (!STEALTH_ENABLED) return;
    
    await this.page.addInitScript(() => {
      // Remove Playwright-specific properties
      delete window.__playwright;
      delete window.__pw_manual;
      delete window.__PW_inspect;
      
      // Override toString to hide automation
      const originalToString = Function.prototype.toString;
      Function.prototype.toString = function() {
        if (this === Function.prototype.toString) return 'function toString() { [native code] }';
        return originalToString.call(this);
      };
    });
    
    await this.page.evaluate(STEALTH_SCRIPT);
  }

  async evadeCaptcha() {
    // Check for common captcha indicators
    const captchaSelectors = [
      "iframe[src*='recaptcha']",
      "iframe[title*='captcha' i]",
      ".g-recaptcha",
      "[id*='captcha' i]",
      "[class*='captcha' i]",
      "input[name*='captcha' i]",
      "div[data-sitekey]",
      ".h-captcha",
      "iframe[src*='hcaptcha']"
    ];

    for (const selector of captchaSelectors) {
      const element = this.page.locator(selector).first();
      const isVisible = await element.isVisible({ timeout: 1000 }).catch(() => false);
      
      if (isVisible) {
        console.log(`Captcha detected: ${selector}`);
        
        // Strategy 1: Try to bypass by simulating human behavior first
        await this.human.naturalDelay(2000, 5000);
        await this.human.naturalScroll('down', 'medium');
        await this.human.randomInteraction();
        
        // Strategy 2: Check if it's a checkbox captcha
        if (selector.includes('recaptcha')) {
          const checkbox = this.page.locator('.recaptcha-checkbox-border').first();
          if (await checkbox.isVisible({ timeout: 2000 }).catch(() => false)) {
            await this.solveRecaptchaCheckbox(checkbox);
          }
        }
        
        return true;
      }
    }
    
    return false;
  }

  async solveRecaptchaCheckbox(checkbox) {
    try {
      // Natural mouse movement to checkbox
      const box = await checkbox.boundingBox();
      if (box) {
        await this.human.naturalMouseMove(box.x + box.width / 2, box.y + box.height / 2);
        await this.human.naturalDelay(500, 1500);
        
        // Hover before click
        await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await sleep(Math.random() * 500 + 200);
        
        // Click with slight randomization
        await checkbox.click({ 
          position: { 
            x: box.width / 2 + (Math.random() - 0.5) * 5, 
            y: box.height / 2 + (Math.random() - 0.5) * 5 
          },
          delay: Math.random() * 100 + 50
        });
        
        // Wait for challenge
        await sleep(3000);
        
        // Check if challenge appeared
        const challengeFrame = this.page.locator("iframe[title*='recaptcha challenge']").first();
        if (await challengeFrame.isVisible({ timeout: 5000 }).catch(() => false)) {
          // Challenge appeared - try to back out and retry
          const backButton = this.page.locator("#recaptcha-reload-button").first();
          if (await backButton.isVisible().catch(() => false)) {
            await backButton.click();
            await sleep(2000);
          }
          return false;
        }
        
        return true;
      }
    } catch (e) {
      console.log('Recaptcha solve failed:', e.message);
      return false;
    }
  }

  async preFlightCheck() {
    // Warm-up browsing to establish human-like session
    await this.human.naturalDelay(2000, 4000);
    await this.human.naturalScroll('down', 'low');
    await this.human.randomInteraction();
  }
}

function normalizeTargetLinks(value) {
  const source = Array.isArray(value)
    ? value.map((v) => String(v || "")).join("\n")
    : String(value || "");
  const urls = String(source).match(/https?:\/\/[^\s<>"']+/gi) || [];
  if (urls.length) {
    return [...new Set(urls.map((v) => v.trim()).filter(Boolean))];
  }
  return [...new Set(String(source)
    .split(/[\n|;,]+/g)
    .map((v) => v.trim())
    .filter(Boolean))];
}

function extractPrimaryUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const matched = raw.match(/https?:\/\/[^\s<>"']+/i);
  if (matched && matched[0]) return matched[0].trim();
  return raw.split(/[\n|;,]+/g).map((v) => v.trim()).find(Boolean) || "";
}

function normalizeHost(urlLike) {
  try {
    return new URL(String(urlLike || "")).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
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

function normalizeResult(item = {}) {
  return {
    target_link: String(item.target_link || "").trim(),
    created_link: String(item.created_link || "").trim(),
    result_title: String(item.result_title || "").trim(),
    status: String(item.status || "queued").trim(),
    status_reason: String(item.status_reason || "").trim(),
    artifacts: Array.isArray(item.artifacts) ? item.artifacts.map((v) => String(v || "").trim()).filter(Boolean) : [],
    updated_at: String(item.updated_at || "").trim(),
  };
}

function getResultMap(results = []) {
  return new Map(results.map((item) => [String(item.target_link || ""), normalizeResult(item)]));
}

function aggregateOutput(results = []) {
  const list = results.map((r) => normalizeResult(r));
  const counts = list.reduce((acc, item) => {
    const key = String(item.status || "queued").toLowerCase();
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  let status = "queued";
  if (!list.length) {
    status = "queued";
  } else if (list.every((item) => item.status === "success")) {
    status = "success";
  } else if (list.some((item) => item.status === "running")) {
    status = "running";
  } else if (list.some((item) => item.status === "failed")) {
    status = "failed";
  } else if (list.some((item) => item.status === "pending_verification")) {
    status = "pending_verification";
  } else if (list.some((item) => item.status === "manual_access_required")) {
    status = "manual_access_required";
  } else if (list.some((item) => item.status === "access_required")) {
    status = "access_required";
  } else if (list.some((item) => item.status === "submitted")) {
    status = "submitted";
  } else if (list.some((item) => item.status === "needs_manual_mapping")) {
    status = "needs_manual_mapping";
  } else if (list.some((item) => item.status === "blocked")) {
    status = "blocked";
  } else if (list.every((item) => item.status === "skipped")) {
    status = "skipped";
  }

  const createdLinks = [...new Set(list.map((item) => item.created_link).filter(Boolean))];
  const titles = [...new Set(list.map((item) => item.result_title).filter(Boolean))];
  const summary = Object.entries(counts)
    .map(([key, value]) => `${key}:${value}`)
    .join(", ");
  const detailReason = list.find((item) => item.status !== "success" && item.status_reason)?.status_reason || "";
  const summaryLower = String(summary || "").toLowerCase();
  const detailLower = String(detailReason || "").toLowerCase();
  const shouldIncludeDetail = Boolean(detailReason) && detailLower !== status && detailLower !== summaryLower;
  const reason = [summary, shouldIncludeDetail ? detailReason : ""].filter(Boolean).join(" | ");

  return {
    results: list,
    status,
    status_reason: reason,
    created_link: createdLinks.join("|"),
    result_title: titles.join(" | "),
  };
}

async function ensureDataSourceReady() {
  if (DATA_SOURCE === "sheets") {
    await ensureColumns();
    return;
  }
  ensureLocalStore(PROJECT_ROOT);
}

async function loadQueueRows() {
  if (DATA_SOURCE === "sheets") {
    return getQueue({
      limit: LIMIT,
      rowKey: ONLY_ROW_KEY,
      includeRetry: FORCE_RETRY,
    });
  }
  return getLocalQueue(PROJECT_ROOT, {
    limit: LIMIT,
    rowKey: ONLY_ROW_KEY,
    includeRetry: FORCE_RETRY,
  });
}

async function persistRowOutput(row, updates) {
  if (DATA_SOURCE === "sheets") {
    await updateRow(row.__rowIndex, updates);
    return;
  }
  updateLocalRow(PROJECT_ROOT, row.__rowKey, updates);
}

function snapshotRow(runId, siteSlug, rowData) {
  const rowPath = path.join(RUNS_ROOT, runId, siteSlug, "row.json");
  writeJson(rowPath, rowData);
}

async function safeGoto(page, url, rowKey, siteName, humanSimulator = null) {
  let lastError = "";
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await sleep(RELIABILITY_DELAYS.afterNavigationMs);
      await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
      
      if (humanSimulator) {
        await humanSimulator.naturalScroll('down', 'medium');
        await sleep(RELIABILITY_DELAYS.afterScrollMs);
      }
      
      return;
    } catch (err) {
      lastError = String(err.message || err);
      logger.log({
        row_key: rowKey,
        site_name: siteName,
        action: "navigate",
        status: "retrying",
        error_message: `attempt ${attempt}: ${lastError}`,
      });
      if (attempt < RETRIES) {
        await sleep(5000);
      }
    }
  }
  throw new Error(lastError || "Navigation failed");
}

function makeResult(targetLink, status, reason = "", extra = {}) {
  return normalizeResult({
    target_link: targetLink,
    status,
    status_reason: reason,
    updated_at: nowIso(),
    ...extra,
  });
}

function resolveSelectorValue(selectors = {}, key) {
  const value = selectors[key];
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  const css = String(value.css || "").trim();
  if (css) return css;
  const xpath = String(value.xpath || "").trim();
  if (!xpath) return "";
  return xpath.startsWith("xpath=") ? xpath : `xpath=${xpath}`;
}

async function capturePageArtifacts({ page, siteDir, baseName, rowKey, siteName, action, status, errorMessage = "", targetLink = "" }) {
  ensureDir(siteDir);
  const safeBase = String(baseName || "artifact").replace(/[^a-z0-9_-]+/gi, "_");
  const screenshotPath = path.join(siteDir, `${safeBase}.png`);
  const htmlPath = path.join(siteDir, `${safeBase}.html`);
  const metaPath = path.join(siteDir, `${safeBase}.json`);

  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  const html = await page.content().catch(() => "");
  if (html) fs.writeFileSync(htmlPath, html, "utf8");

  const meta = {
    captured_at: nowIso(),
    step: action,
    status,
    row_key: rowKey,
    site_name: siteName,
    target_link: targetLink,
    final_url: page.url(),
    page_title: await page.title().catch(() => ""),
    message: errorMessage,
  };
  writeJson(metaPath, meta);

  logger.log({
    row_key: rowKey,
    site_name: siteName,
    action,
    status,
    screenshot_path: screenshotPath,
    error_message: errorMessage,
  });

  return [screenshotPath, htmlPath, metaPath];
}

async function detectCommentForm(page, timeoutMs = 12000) {
  const textareaSelectors = [
    "textarea#comment",
    "textarea[name*='comment' i]",
    "textarea[name*='reply' i]",
    "textarea[name*='message' i]",
    "textarea[id*='comment' i]",
    "textarea[id*='reply' i]",
    "textarea[placeholder*='write a comment' i]",
    "textarea[placeholder*='leave a comment' i]",
    ".comment-form textarea",
    "form[action*='comment' i] textarea",
    "form[id*='comment' i] textarea",
    "form[class*='comment' i] textarea",
    "textarea[placeholder*='comment' i]",
    "textarea[placeholder*='reply' i]",
    "textarea[aria-label*='comment' i]",
    "[contenteditable='true'][aria-label*='comment' i]",
    "[contenteditable='true'][placeholder*='comment' i]",
    "[contenteditable='true'][data-placeholder*='comment' i]",
    "[role='textbox'][aria-label*='comment' i]",
    "[role='textbox'][placeholder*='comment' i]",
    ".comment-form [contenteditable='true']",
    "form[action*='comment' i] [contenteditable='true']",
    "section[class*='comment' i] [contenteditable='true']",
    "div[id*='comment' i] [contenteditable='true']",
  ];
  const submitSelectors = [
    "button:has-text('Post Comment')",
    "button:has-text('Submit Comment')",
    "button:has-text('Comment')",
    "button:has-text('Post')",
    "button:has-text('Publish')",
    "input[value*='Post Comment' i]",
    "input[value*='Submit Comment' i]",
    "input[value*='Comment' i]",
    "input[value*='Post' i]",
    "button:has-text('Reply')",
    "input[value*='Reply' i]",
    "button[type='submit']",
    "input[type='submit']",
    "button[name*='submit' i]",
    "input[name*='submit' i]",
    "button[id*='submit' i]",
    "button[class*='submit' i]",
  ];

  const findFirstVisibleLocator = async (scope, selector, maxChecks = 20) => {
    try {
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);
      const limit = Math.min(Number(count || 0), maxChecks);
      for (let i = 0; i < limit; i += 1) {
        const candidate = locator.nth(i);
        if (await candidate.isVisible().catch(() => false)) {
          return candidate;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  };

  const findFirstLocator = async (scope, selector, maxChecks = 20) => {
    try {
      const locator = scope.locator(selector);
      const count = await locator.count().catch(() => 0);
      const limit = Math.min(Number(count || 0), maxChecks);
      if (limit <= 0) return null;
      return locator.nth(0);
    } catch (_) {
      return null;
    }
  };

  const clickedRevealTargets = new Set();

  const revealCommentSection = async () => {
    const revealSelectors = [
      "a[href*='#comment']",
      "a[href*='#respond']",
      "a[href*='comment' i]",
      "button[href*='comment' i]",
      "button:has-text('Leave a Reply')",
      "a:has-text('Leave a Reply')",
      "button:has-text('Add Comment')",
      "a:has-text('Add Comment')",
      "button:has-text('Leave a Comment')",
      "a:has-text('Leave a Comment')",
      "button:has-text('Write a comment')",
      "a:has-text('Write a comment')",
      "button:has-text('Comments')",
      "a:has-text('Comments')",
      "[role='button']:has-text('Comments')",
      "summary:has-text('Comments')",
      "[aria-controls*='comment' i]",
      "[data-toggle*='comment' i]",
      "[data-target*='comment' i]",
      "[class*='comment-toggle' i]",
      "[id*='comment-toggle' i]",
      ".comments-link",
      ".comments-title",
      "h1:has-text('Comments')",
      "h2:has-text('Comments')",
      "h3:has-text('Comments')",
    ];

    const canClickRevealTarget = async (locator) => {
      try {
        const meta = await locator.evaluate((node) => {
          const tag = String(node.tagName || "").toLowerCase();
          const href = String(node.getAttribute("href") || "").trim();
          const classes = String(node.getAttribute("class") || "").toLowerCase();
          const id = String(node.getAttribute("id") || "").toLowerCase();
          const role = String(node.getAttribute("role") || "").toLowerCase();
          const ariaControls = String(node.getAttribute("aria-controls") || "").toLowerCase();
          const dataToggle = String(node.getAttribute("data-toggle") || "").toLowerCase();
          const dataTarget = String(node.getAttribute("data-target") || "").toLowerCase();
          const onClick = String(node.getAttribute("onclick") || "").toLowerCase();
          const text = String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          const parentHint = String(node.closest("[id*='comment' i], [class*='comment' i], [id*='reply' i], [class*='reply' i]")?.getAttribute("class") || "").toLowerCase();
          const rect = node.getBoundingClientRect();
          const key = [
            tag,
            id,
            classes,
            href,
            text.slice(0, 80),
            Math.round(rect?.x || 0),
            Math.round(rect?.y || 0),
            Math.round(rect?.width || 0),
            Math.round(rect?.height || 0),
          ].join("|");
          return { tag, href, classes, id, role, ariaControls, dataToggle, dataTarget, onClick, text, parentHint, key };
        });
        if (!meta) return false;
        if (!meta.key) return false;
        if (clickedRevealTargets.has(meta.key)) return false;
        if (/^-\s*comments?/.test(meta.text)) return false;
        if (/^hide\s+comments?/.test(meta.text)) return false;

        if (["button", "summary"].includes(meta.tag)) return true;

        if (meta.role === "button" || meta.role === "tab") return true;
        if (meta.ariaControls.includes("comment") || meta.ariaControls.includes("reply")) return true;
        if (meta.dataToggle.includes("comment") || meta.dataTarget.includes("comment")) return true;
        if (meta.onClick.includes("comment") || meta.onClick.includes("reply")) return true;
        if (meta.classes.includes("toggle") || meta.id.includes("toggle")) return true;
        if (meta.parentHint.includes("comment") || meta.parentHint.includes("reply")) return true;

        if (meta.tag !== "a") {
          return /(^|\W)(comments?|leave a reply|add comment|write a comment|reply)(\W|$)/i.test(meta.text);
        }

        const href = String(meta.href || "").toLowerCase();
        if (!href) return false;

        if (
          href.includes("/feed") ||
          href.endsWith(".xml") ||
          href.startsWith("mailto:") ||
          href.startsWith("tel:")
        ) {
          return false;
        }

        if (href.startsWith("#")) return true;
        if (href.includes("#comment") || href.includes("#respond")) return true;
        if (href.startsWith("javascript:")) return true;
        if (meta.classes.includes("toggle") || meta.role === "button") return true;
        return false;
      } catch (_) {
        return false;
      }
    };

    const hasQuickVisibleCommentForm = async () => {
      const quickSelectors = [
        "#respond",
        "form#commentform",
        "textarea#comment",
        "textarea[name*='comment' i]",
        "form[action*='comment' i] textarea",
        ".comment-form textarea",
      ];
      for (const selector of quickSelectors) {
        const visible = await page.locator(selector).first().isVisible({ timeout: 200 }).catch(() => false);
        if (visible) return true;
      }
      return false;
    };

    const clickReveal = async (target) => {
      const key = await target.evaluate((node) => {
        const tag = String(node.tagName || "").toLowerCase();
        const id = String(node.getAttribute("id") || "");
        const classes = String(node.getAttribute("class") || "");
        const href = String(node.getAttribute("href") || "");
        const text = String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
        const rect = node.getBoundingClientRect();
        return [
          tag,
          id,
          classes,
          href,
          text,
          Math.round(rect?.x || 0),
          Math.round(rect?.y || 0),
          Math.round(rect?.width || 0),
          Math.round(rect?.height || 0),
        ].join("|");
      }).catch(() => "");
      if (key && clickedRevealTargets.has(key)) return false;

      const beforeUrl = String(page.url() || "");
      await target.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
      await target.click({ timeout: 2000 }).catch(() => {});
      if (key) clickedRevealTargets.add(key);
      await sleep(350);

      const afterUrl = String(page.url() || "");
      if (afterUrl && beforeUrl && afterUrl !== beforeUrl) {
        const lowerAfter = afterUrl.toLowerCase();
        if (lowerAfter.includes("/feed") || lowerAfter.endsWith(".xml")) {
          await page.goBack({ timeout: 5000 }).catch(() => {});
          await sleep(250);
        }
      }
      return await hasQuickVisibleCommentForm();
    };

    const localClicked = new Set();
    for (const selector of revealSelectors) {
      const items = page.locator(selector);
      const count = await items.count().catch(() => 0);
      const max = Math.min(8, Number(count || 0));
      for (let i = 0; i < max; i += 1) {
        const btn = items.nth(i);
        if (!await btn.isVisible().catch(() => false)) continue;
        const candidateKey = await btn.evaluate((node) => {
          const rect = node.getBoundingClientRect();
          return [
            String(node.tagName || "").toLowerCase(),
            String(node.getAttribute("id") || ""),
            String(node.getAttribute("class") || ""),
            String(node.getAttribute("href") || ""),
            String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80),
            Math.round(rect?.x || 0),
            Math.round(rect?.y || 0),
          ].join("|");
        }).catch(() => "");
        if (candidateKey && localClicked.has(candidateKey)) continue;
        const clickable = await canClickRevealTarget(btn);
        if (!clickable) continue;
        if (candidateKey) localClicked.add(candidateKey);
        const revealed = await clickReveal(btn);
        if (revealed) return true;
      }
    }

    const textTriggers = page.locator("text=/\\+?\\s*comments?|leave\\s+a\\s+reply|add\\s+comment|write\\s+a\\s+comment|reply/i");
    const triggerCount = await textTriggers.count().catch(() => 0);
    const triggerMax = Math.min(12, Number(triggerCount || 0));
    for (let i = 0; i < triggerMax; i += 1) {
      const trigger = textTriggers.nth(i);
      if (!await trigger.isVisible().catch(() => false)) continue;
      const candidateKey = await trigger.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        return [
          String(node.tagName || "").toLowerCase(),
          String(node.getAttribute("id") || ""),
          String(node.getAttribute("class") || ""),
          String(node.getAttribute("href") || ""),
          String(node.textContent || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80),
          Math.round(rect?.x || 0),
          Math.round(rect?.y || 0),
        ].join("|");
      }).catch(() => "");
      if (candidateKey && localClicked.has(candidateKey)) continue;
      const clickable = await canClickRevealTarget(trigger);
      if (!clickable) continue;
      if (candidateKey) localClicked.add(candidateKey);
      const revealed = await clickReveal(trigger);
      if (revealed) return true;
    }
    return false;
  };

  const isLikelyCommentForm = async (textarea) => {
    try {
      const score = await textarea.evaluate((node) => {
        const form = node.closest("form");
        const formText = (form?.textContent || "").toLowerCase();
        const formAttrs = [
          form?.getAttribute("id") || "",
          form?.getAttribute("class") || "",
          form?.getAttribute("name") || "",
          form?.getAttribute("action") || "",
        ].join(" ").toLowerCase();
        const near = (node.closest("section, article, div, main")?.textContent || "").slice(0, 1200).toLowerCase();
        const placeholder = String(node.getAttribute("placeholder") || node.getAttribute("data-placeholder") || "").toLowerCase();
        const ariaLabel = String(node.getAttribute("aria-label") || "").toLowerCase();
        const positiveWords = ["comment", "reply", "discussion", "post comment", "leave a reply", "add comment"];
        const negativeWords = ["contact us", "newsletter", "support ticket", "feedback form", "subscribe", "search"];
        let scoreValue = 0;
        for (const word of positiveWords) {
          if (formText.includes(word)) scoreValue += 2;
          if (formAttrs.includes(word)) scoreValue += 3;
          if (near.includes(word)) scoreValue += 1;
          if (placeholder.includes(word)) scoreValue += 3;
          if (ariaLabel.includes(word)) scoreValue += 3;
        }
        for (const word of negativeWords) {
          if (formText.includes(word) || formAttrs.includes(word) || near.includes(word) || placeholder.includes(word) || ariaLabel.includes(word)) scoreValue -= 2;
        }
        return scoreValue;
      });
      return Number(score || 0) >= 0;
    } catch (_) {
      return true;
    }
  };

  const findScopedSubmit = async (scope, textareaSelector, submitSelector) => {
    const scopedSelectors = [
      `form:has(${textareaSelector}) ${submitSelector}`,
      `section:has(${textareaSelector}) ${submitSelector}`,
      `article:has(${textareaSelector}) ${submitSelector}`,
      `div:has(${textareaSelector}) ${submitSelector}`,
    ];
    for (const scopedSelector of scopedSelectors) {
      const candidate = await findFirstVisibleLocator(scope, scopedSelector, 12);
      if (candidate) return candidate;
    }
    return null;
  };

  const probeScope = async (scope) => {
    for (const textareaSelector of textareaSelectors) {
      const textarea = await findFirstVisibleLocator(scope, textareaSelector, 24);
      if (!textarea) continue;

      let submit = null;
      try {
        const formScoped = textarea.locator("xpath=ancestor::form[1]");
        for (const submitSelector of submitSelectors) {
          const candidate = await findFirstVisibleLocator(formScoped, submitSelector, 12);
          if (candidate) {
            submit = { selector: submitSelector, locator: candidate };
            break;
          }
        }
      } catch (_) {
        // fallback below
      }

      if (!submit) {
        for (const submitSelector of submitSelectors) {
          const candidate = await findScopedSubmit(scope, textareaSelector, submitSelector);
          if (candidate) {
            submit = { selector: submitSelector, locator: candidate };
            break;
          }
        }
      }

      if (!submit) {
        for (const submitSelector of submitSelectors) {
          const candidate = await findFirstVisibleLocator(scope, submitSelector, 24);
          if (candidate) {
            submit = { selector: submitSelector, locator: candidate };
            break;
          }
        }
      }

      if (!submit) continue;
      const likelyComment = await isLikelyCommentForm(textarea);
      if (!likelyComment) continue;

      return {
        ok: true,
        textareaSelector,
        textarea,
        submitSelector: submit.selector,
        submit: submit.locator,
      };
    }

    const wordpressFormLocator = scope
      .locator("form#commentform, #respond form.comment-form, #respond form[action*='wp-comments-post.php']")
      .first();
    const wordpressCommentForm = await wordpressFormLocator.isVisible().catch(() => false);

    if (wordpressCommentForm) {
      let textarea = await findFirstVisibleLocator(
        scope,
        "#commentform textarea#comment, #respond textarea#comment, #comment-form-comment textarea[name='comment']",
        12
      );
      if (!textarea) {
        // Verbum on some WordPress pages keeps the textarea hidden (display:none)
        // and mirrors input in JS UI; we can still populate hidden textarea directly.
        textarea = await findFirstLocator(
          scope,
          "#commentform textarea#comment, #respond textarea#comment, #comment-form-comment textarea[name='comment']",
          12
        );
      }
      if (textarea) {
        const submit = await findFirstVisibleLocator(
          scope,
          "#comment-submit, #commentform button[type='submit'], #commentform input[type='submit']",
          12
        );
        if (submit) {
          return {
            ok: true,
            textareaSelector: "#comment",
            textarea,
            submitSelector: "#comment-submit",
            submit,
          };
        }
      }
    }

    return null;
  };

  const probeOnce = async () => {
    const onPage = await probeScope(page);
    if (onPage) return onPage;

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const inFrame = await probeScope(frame);
      if (inFrame) return inFrame;
    }
    return null;
  };

  const slowScrollSweep = async () => {
    const total = await page.evaluate(() => Math.max(
      document.body?.scrollHeight || 0,
      document.documentElement?.scrollHeight || 0
    )).catch(() => 0);
    if (!total) return;
    const viewport = page.viewportSize()?.height || 900;
    const step = Math.max(500, Math.floor(viewport * 0.8));
    let pos = 0;
    while (pos <= total + step) {
      await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: "instant" }), pos).catch(() => {});
      await sleep(180);
      await revealCommentSection();
      const found = await probeOnce();
      if (found) return found;
      pos += step;
    }
    return null;
  };

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await revealCommentSection();
    const foundNow = await probeOnce();
    if (foundNow) return foundNow;

    const foundByScroll = await slowScrollSweep();
    if (foundByScroll) return foundByScroll;

    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" })).catch(() => {});
    await sleep(250);
  }

  return { ok: false };
}

async function scrollToCommentForm(page, textareaLocator) {
  try {
    await textareaLocator.scrollIntoViewIfNeeded({ timeout: 3000 });
  } catch (_) {
    // continue
  }
  try {
    await page.evaluate((el) => {
      if (!el) return;
      const rect = el.getBoundingClientRect();
      window.scrollBy({ top: rect.top - Math.max(120, window.innerHeight * 0.25), left: 0, behavior: "instant" });
    }, await textareaLocator.elementHandle());
  } catch (_) {
    // continue
  }
}

async function detectVerificationGate(page) {
  const captchaChecks = [
    "iframe[src*='recaptcha']",
    "iframe[title*='captcha' i]",
    ".g-recaptcha",
    "[id*='captcha' i]",
    "[class*='captcha' i]",
    "input[name*='captcha' i]",
    "label:has-text('Anti-spam')",
    "text=/I am not a robot/i",
  ];
  for (const selector of captchaChecks) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout: 500 }).catch(() => false);
      if (visible) return { kind: "captcha", selector };
    } catch (_) {
      // ignore
    }
  }

  const authChecks = [
    "a:has-text('Log in to comment')",
    "a:has-text('Sign in to comment')",
    "text=/you\\s+must\\s+be\\s+logged\\s+in\\s+to\\s+(leave|post)\\s+a?\\s*comment/i",
    "text=/must\\s+log\\s+in\\s+to\\s+(leave|post)\\s+a?\\s*comment/i",
    "text=/log\\s*in\\s*to\\s*(leave|post)?\\s*a?\\s*comment/i",
    "text=/sign\\s*in\\s*to\\s*(leave|post)?\\s*a?\\s*comment/i",
  ];
  for (const selector of authChecks) {
    try {
      const visible = await page.locator(selector).first().isVisible({ timeout: 500 }).catch(() => false);
      if (!visible) continue;

      const hasGuestFields = await page.evaluate(() => {
        const nameField = document.querySelector("#commentform input[name='author'], #respond input[name='author']");
        const emailField = document.querySelector("#commentform input[name='email'], #respond input[name='email']");
        const hasName = !!nameField;
        const hasEmail = !!emailField;
        return hasName && hasEmail;
      }).catch(() => false);

      if (!hasGuestFields) return { kind: "auth", selector };
    } catch (_) {
      // ignore
    }
  }
  return null;
}

function getGoogleAuthCredentials(row = {}) {
  const email = String(
    process.env.GOOGLE_AUTH_EMAIL
    || row.google_auth_email
    || row.google_email
    || ""
  ).trim();
  const password = String(
    process.env.GOOGLE_AUTH_PASSWORD
    || row.google_auth_password
    || row.google_password
    || ""
  ).trim();
  return { email, password };
}

async function findGoogleAccessEntry(page) {
  const textSelectors = [
    "button:has-text('Sign in with Google')",
    "a:has-text('Sign in with Google')",
    "button:has-text('Continue with Google')",
    "a:has-text('Continue with Google')",
    "button:has-text('Login with Google')",
    "a:has-text('Login with Google')",
  ];
  for (const selector of textSelectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
    if (visible) return { kind: "button", selector, locator };
  }

  const logoSelectors = [
    "button:has(img[alt*='google' i])",
    "a:has(img[alt*='google' i])",
    "button:has([class*='google' i])",
    "a:has([class*='google' i])",
    "[role='button']:has(img[alt*='google' i])",
  ];
  for (const selector of logoSelectors) {
    const locator = page.locator(selector).first();
    const visible = await locator.isVisible({ timeout: 500 }).catch(() => false);
    if (visible) return { kind: "button", selector, locator };
  }

  const iframeSelector = "iframe[src*='accounts.google.com'], iframe[src*='google.com/accounts']";
  const iframe = page.locator(iframeSelector).first();
  const iframeVisible = await iframe.isVisible({ timeout: 500 }).catch(() => false);
  if (iframeVisible) return { kind: "iframe", selector: iframeSelector, locator: iframe };

  return null;
}

async function clickNaturally(page, locator, humanSimulator = null) {
  const box = await locator.boundingBox().catch(() => null);
  if (box) {
    const x = box.x + box.width * (0.45 + Math.random() * 0.1);
    const y = box.y + box.height * (0.45 + Math.random() * 0.1);
    if (humanSimulator) {
      await humanSimulator.naturalMouseMove(x, y);
      await humanSimulator.naturalDelay(350, 900);
      await page.mouse.click(x, y, { delay: 70 + Math.floor(Math.random() * 90) }).catch(() => {});
    } else {
      await smoothMouseMove(page, x, y).catch(() => {});
      await sleep(300 + Math.floor(Math.random() * 500));
      await page.mouse.click(x, y, { delay: 70 + Math.floor(Math.random() * 90) }).catch(() => {});
    }
    return;
  }
  await locator.click({ delay: 80 + Math.floor(Math.random() * 120), timeout: 5000 }).catch(() => {});
}

function isGoogleAuthUrl(url = "") {
  const u = String(url || "").toLowerCase();
  return u.includes("accounts.google.com") || u.includes("google.com/signin") || u.includes("google.com/accounts");
}

async function waitForPopupOrRedirect(context, page, beforeUrl) {
  const popupFromPage = page.waitForEvent("popup", { timeout: 8000 }).catch(() => null);
  const popupFromContext = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);
  const popup = await Promise.race([popupFromPage, popupFromContext]).catch(() => null);
  if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    return { authPage: popup, viaPopup: true };
  }

  const started = Date.now();
  while (Date.now() - started < 10000) {
    const currentUrl = String(page.url() || "");
    if (currentUrl !== String(beforeUrl || "") || isGoogleAuthUrl(currentUrl)) {
      return { authPage: page, viaPopup: false };
    }
    await sleep(250);
  }
  return { authPage: null, viaPopup: false };
}

async function continueGoogleAuthFlow({ authPage, mainPage, humanSimulator, credentials }) {
  if (!authPage) {
    return { status: "needs_manual_verification", reason: "google_auth_popup_or_redirect_not_detected" };
  }

  const quickBody = async () => authPage.evaluate(() => String(document.body?.innerText || "").toLowerCase()).catch(() => "");
  const hasManualChallenge = async () => {
    const body = await quickBody();
    return (
      body.includes("verify it's you")
      || body.includes("verify its you")
      || body.includes("try another way")
      || body.includes("confirm it’s you")
      || body.includes("2-step verification")
      || body.includes("2 step verification")
      || body.includes("security challenge")
    );
  };
  const hasDenied = async () => {
    const body = await quickBody();
    return (
      body.includes("couldn’t sign you in")
      || body.includes("couldn't sign you in")
      || body.includes("wrong password")
      || body.includes("account disabled")
      || body.includes("access denied")
    );
  };

  if (await hasManualChallenge()) {
    return { status: "needs_manual_verification", reason: "google_verify_its_you" };
  }

  const { email, password } = credentials;
  if (!email || !password) {
    return { status: "needs_manual_verification", reason: "google_credentials_missing" };
  }

  const emailInput = authPage.locator("input[type='email'], input[name='identifier'], input[autocomplete='username']").first();
  if (await emailInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    const box = await emailInput.boundingBox().catch(() => null);
    if (box && humanSimulator) {
      await humanSimulator.naturalMouseMove(box.x + box.width / 2, box.y + box.height / 2);
      await humanSimulator.naturalDelay(250, 700);
    }
    await emailInput.click({ delay: 90 + Math.floor(Math.random() * 90), timeout: 5000 }).catch(() => {});
    await realisticTyping(authPage, "input[type='email'], input[name='identifier'], input[autocomplete='username']", email);
    const nextBtn = authPage.locator("#identifierNext button, button:has-text('Next'), div[role='button']:has-text('Next')").first();
    if (await nextBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await clickNaturally(authPage, nextBtn, humanSimulator);
      await sleep(1200 + Math.floor(Math.random() * 1200));
    }
  }

  if (await hasManualChallenge()) {
    return { status: "needs_manual_verification", reason: "google_verify_its_you" };
  }
  if (await hasDenied()) {
    return { status: "access_denied", reason: "google_auth_denied" };
  }

  const passInput = authPage.locator("input[type='password'], input[name='Passwd']").first();
  if (await passInput.isVisible({ timeout: 6000 }).catch(() => false)) {
    const box = await passInput.boundingBox().catch(() => null);
    if (box && humanSimulator) {
      await humanSimulator.naturalMouseMove(box.x + box.width / 2, box.y + box.height / 2);
      await humanSimulator.naturalDelay(250, 700);
    }
    await passInput.click({ delay: 90 + Math.floor(Math.random() * 90), timeout: 5000 }).catch(() => {});
    await realisticTyping(authPage, "input[type='password'], input[name='Passwd']", password);
    const nextPass = authPage.locator("#passwordNext button, button:has-text('Next'), div[role='button']:has-text('Next')").first();
    if (await nextPass.isVisible({ timeout: 2000 }).catch(() => false)) {
      await clickNaturally(authPage, nextPass, humanSimulator);
      await sleep(2000 + Math.floor(Math.random() * 1500));
    }
  }

  if (await hasManualChallenge()) {
    return { status: "needs_manual_verification", reason: "google_verify_its_you" };
  }
  if (await hasDenied()) {
    return { status: "access_denied", reason: "google_auth_denied" };
  }

  const postAuthUrl = String(authPage.url() || "");
  if (isGoogleAuthUrl(postAuthUrl)) {
    return { status: "needs_manual_verification", reason: "google_auth_still_open" };
  }

  try {
    await mainPage.bringToFront();
  } catch (_) {
    // noop
  }
  return { status: "access_granted", reason: "google_auth_success" };
}

async function continuePlatformAccess({
  context,
  page,
  row,
  humanSimulator = null,
  rowKey = "",
  siteName = "",
}) {
  const entry = await findGoogleAccessEntry(page);
  const hasGoogleAuthIframe = await page
    .locator("iframe[src*='accounts.google.com'], iframe[src*='google.com/accounts']")
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);

  if (!entry && !hasGoogleAuthIframe) {
    return { status: "access_denied", reason: "google_auth_entry_not_found" };
  }

  const beforeUrl = String(page.url() || "");

  if (entry?.locator) {
    await clickNaturally(page, entry.locator, humanSimulator).catch(() => {});
  }

  const transition = await waitForPopupOrRedirect(context, page, beforeUrl);
  const result = await continueGoogleAuthFlow({
    authPage: transition.authPage,
    mainPage: page,
    humanSimulator,
    credentials: getGoogleAuthCredentials(row),
  });

  logger.log({
    row_key: rowKey,
    site_name: siteName,
    action: "platform_access_continuation",
    status: result.status,
    error_message: `${result.reason || "n/a"} | entry=${entry?.selector || "iframe_only"}`,
  });
  return result;
}

function cleanSentence(value, max = 220) {
  const text = String(value || "")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}.`;
}

async function readCommentContext(page) {
  try {
    return await page.evaluate(() => {
      const firstText = (selectorList) => {
        for (const selector of selectorList) {
          const el = document.querySelector(selector);
          const text = (el?.textContent || "").replace(/\s+/g, " ").trim();
          if (text) return text;
        }
        return "";
      };
      return {
        title: (document.title || "").replace(/\s+/g, " ").trim(),
        heading: firstText(["article h1", "main h1", "h1", "article h2", "main h2"]),
        snippet: firstText(["article p", "main p", ".entry-content p", "p"]),
      };
    });
  } catch (_) {
    return { title: "", heading: "", snippet: "" };
  }
}

async function composeBlogComment(page, row, targetLink) {
  const pageContext = await readCommentContext(page);
  const heading = cleanSentence(pageContext.heading || pageContext.title, 110);
  const snippet = cleanSentence(pageContext.snippet, 160);
  const noteHint = cleanSentence(row.notes || row.company_description, 160);
  const authorName = cleanSentence(row.company_name || row.site_name || row.username, 60);

  const lines = [];
  if (heading) {
    lines.push(`Helpful insights on "${heading}".`);
  } else {
    lines.push("Helpful and practical write-up.");
  }

  if (snippet) {
    lines.push(`The point on ${snippet.toLowerCase()} is especially useful.`);
  }

  if (noteHint) {
    lines.push(`A related perspective: ${noteHint}`);
  }

  if (targetLink) {
    lines.push(`Reference: ${targetLink}`);
  } else if (row.default_website_url) {
    lines.push(`Reference: ${row.default_website_url}`);
  }

  if (authorName) {
    lines.push(`Thanks, ${authorName}.`);
  } else {
    lines.push("Thanks for sharing.");
  }

  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  if (text.length <= 520) return text;
  return `${text.slice(0, 519).trimEnd()}.`;
}

async function fillBlogCommentFields(page, row, detectedForm, targetLink, humanSimulator = null) {
  const commentText = await composeBlogComment(page, row, targetLink);

  const fillVisibleCommentEditor = async (value) => {
    const editorSelectors = [
      "#comment-form-comment [contenteditable='true']",
      "#comment-form-comment .block-editor-block-list__layout",
      "#comment-form-comment .editor__main",
      "#respond .comment-form__verbum .block-editor",
      "#respond .comment-form__verbum p:has-text('Write a comment')",
    ];

    for (const selector of editorSelectors) {
      const editor = page.locator(selector).first();
      const visible = await editor.isVisible().catch(() => false);
      if (!visible) continue;
      try {
        await editor.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        await editor.click({ timeout: 3000 }).catch(() => {});
        await page.keyboard.type(value, { delay: 25 });
        await sleep(250);
        return true;
      } catch (_) {
        // try next candidate
      }
    }
    return false;
  };
  
  const readLocatorValue = async (locator) => {
    try {
      return await locator.evaluate((node) => {
        if (!node) return "";
        const value = typeof node.value === "string" ? node.value : "";
        if (value && value.trim()) return value.trim();
        const text = typeof node.innerText === "string" ? node.innerText : (node.textContent || "");
        return String(text || "").trim();
      });
    } catch (_) {
      return "";
    }
  };

  const safeFill = async (locator, value) => {
    for (let i = 0; i < 3; i += 1) {
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
        
        // Human-like interaction
        if (humanSimulator) {
          const box = await locator.boundingBox();
          if (box) {
            await humanSimulator.naturalMouseMove(box.x + box.width / 2, box.y + box.height / 2);
            await humanSimulator.naturalDelay(300, 800);
          }
        }
        
        await locator.click({ timeout: 2000 }).catch(() => {});
        
        // Human-like typing
        if (humanSimulator && HUMAN_BEHAVIOR_ENABLED) {
          await humanSimulator.humanLikeTyping(locator, value);
        } else {
          const filled = await locator.fill(value, { timeout: 5000 }).then(() => true).catch(() => false);
          if (!filled) {
            await locator.type(value, { delay: 35 }).catch(() => {});
          }
        }
        
        let actual = await readLocatorValue(locator);
        if (!actual) {
          await locator.evaluate((node, val) => {
            if (!node) return;
            const text = String(val || "");
            if (typeof node.value === "string") {
              node.value = text;
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
              return;
            }
            if (node.isContentEditable) {
              node.focus();
              node.textContent = text;
              node.dispatchEvent(new Event("input", { bubbles: true }));
              node.dispatchEvent(new Event("change", { bubbles: true }));
            }
          }, value).catch(() => {});
          actual = await readLocatorValue(locator);
        }
        if (String(actual || "").trim()) return true;
      } catch (_) {
        // retry
      }
      await sleep(200);
    }
    return false;
  };

  const ensureCheckboxChecked = async (inputLocator, labelLocator = null) => {
    const isCheckedSafe = async () => {
      const checked = await inputLocator.isChecked().catch(() => null);
      if (typeof checked === "boolean") return checked;
      return await inputLocator.evaluate((node) => {
        if (!node) return false;
        if (typeof node.checked === "boolean") return node.checked;
        return node.getAttribute("aria-checked") === "true";
      }).catch(() => false);
    };

    const clickLikeHuman = async (x, y) => {
      const detourCount = 2 + Math.floor(Math.random() * 2); // 2-3 detours
      for (let i = 0; i < detourCount; i += 1) {
        const dx = x + (Math.random() - 0.5) * 220;
        const dy = y + (Math.random() - 0.5) * 140;
        await smoothMouseMove(page, dx, dy);
        await sleep(70 + Math.floor(Math.random() * 140));
      }
      await smoothMouseMove(page, x, y);
      await sleep(120 + Math.floor(Math.random() * 240));
      await page.mouse.click(x, y, { delay: 70 + Math.floor(Math.random() * 120) });
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await isCheckedSafe()) return true;

      await inputLocator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      const box = await inputLocator.boundingBox();
      if (box) {
        const clickX = box.x + box.width * (0.35 + Math.random() * 0.3);
        const clickY = box.y + box.height * (0.35 + Math.random() * 0.3);
        await clickLikeHuman(clickX, clickY);
      } else if (labelLocator) {
        const lb = await labelLocator.boundingBox();
        if (lb) {
          const lx = lb.x + Math.min(24, Math.max(10, lb.width * 0.08));
          const ly = lb.y + lb.height * (0.45 + Math.random() * 0.2);
          await clickLikeHuman(lx, ly);
        } else {
          await labelLocator.click({ timeout: 1500 }).catch(() => {});
        }
      }

      await sleep(150 + Math.floor(Math.random() * 220));
      if (await isCheckedSafe()) return true;
    }

    return false;
  };

  let commentFilled = await safeFill(detectedForm.textarea, commentText);
  if (!commentFilled) {
    const editorFilled = await fillVisibleCommentEditor(commentText);
    if (editorFilled) {
      await detectedForm.textarea.evaluate((node, val) => {
        if (!node) return;
        const text = String(val || "");
        if (typeof node.value === "string") {
          node.value = text;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }, commentText).catch(() => {});
      commentFilled = await safeFill(detectedForm.textarea, commentText);
    }
  }

  const nameValue = String(row.username || row.company_name || row.site_name || "").trim();
  const emailValue = String(row.email || "").trim();
  const websiteValue = String(row.default_website_url || targetLink || "").trim();

  const optionalFieldSelectors = [
    { value: nameValue, selectors: ["input#author", "input[name='author']", "input[name*='name' i]", "input#comment_name"] },
    { value: emailValue, selectors: ["input#email", "input[name='email']", "input[type='email']", "input#comment_email"] },
    { value: websiteValue, selectors: ["input#url", "input[name='url']", "input[name*='website' i]", "input[name*='site' i]"] },
  ];

  for (const field of optionalFieldSelectors) {
    if (!field.value) continue;
    for (const selector of field.selectors) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) {
        await safeFill(loc, field.value);
        break;
      }
    }
  }

  const rememberSelectors = [
    "input#wp-comment-cookies-consent",
    "input[name='wp-comment-cookies-consent']",
    "input[type='checkbox'][name*='cookie' i]",
    "input[type='checkbox'][id*='cookie' i]",
    "input[type='checkbox'][name*='remember' i]",
    "input[type='checkbox'][id*='remember' i]",
  ];
  const rememberLabel = page.locator("label:has-text('Save my name')").first();
  for (const selector of rememberSelectors) {
    const checkbox = page.locator(selector).first();
    const visible = await checkbox.isVisible().catch(() => false);
    if (!visible) continue;
    await ensureCheckboxChecked(checkbox, rememberLabel);
    break;
  }
}

async function clickSubmitRobust(page, submitLocator, submitSelector = "", humanSimulator = null) {
  const fallbackSubmitSelectors = [
    submitSelector,
    "button:has-text('Comment')",
    "button:has-text('Post Comment')",
    "button:has-text('Submit Comment')",
    "input[value*='Comment' i]",
    "input[value*='Post Comment' i]",
    "form:has(textarea) button[type='submit']",
    "form:has(textarea) input[type='submit']",
    "section:has(textarea) button[type='submit']",
    "article:has(textarea) button[type='submit']",
    "form:has([contenteditable='true']) button[type='submit']",
    "form:has([contenteditable='true']) input[type='submit']",
    "section:has([contenteditable='true']) button:has-text('Comment')",
    "article:has([contenteditable='true']) button:has-text('Comment')",
    "button[type='submit']",
    "input[type='submit']",
    "button[id*='submit' i]",
    "button[class*='submit' i]",
  ].map((v) => String(v || "").trim()).filter(Boolean);

  const resolveCandidate = async () => {
    if (submitLocator) {
      const visible = await submitLocator.isVisible().catch(() => false);
      if (visible) return submitLocator;
    }
    for (const selector of fallbackSubmitSelectors) {
      const loc = page.locator(selector).first();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    return null;
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (page.isClosed()) {
      throw new Error("Target page closed before submit.");
    }
    try {
      const candidate = await resolveCandidate();
      if (!candidate) {
        throw new Error("Submit button not found.");
      }
      
      await candidate.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

      const disabled = await candidate.isDisabled().catch(() => false);
      if (disabled) {
        await sleep(1200);
        const stillDisabled = await candidate.isDisabled().catch(() => false);
        if (stillDisabled) {
          throw new Error("Submit button is disabled after form fill.");
        }
      }
      
      // Human-like click
      if (humanSimulator) {
        const box = await candidate.boundingBox();
        if (box) {
          await humanSimulator.naturalMouseMove(box.x + box.width / 2, box.y + box.height / 2);
          await humanSimulator.naturalDelay(500, 1500);
        }
      }
      
      await candidate.click({ timeout: 12000 });
      await page.waitForLoadState("domcontentloaded", { timeout: 12000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
      return;
    } catch (err) {
      lastErr = err;
      const errText = String(err?.message || err || "").toLowerCase();
      if (errText.includes("target page") && errText.includes("closed")) {
        return;
      }
      if (page.isClosed()) {
        throw new Error("Target page/context closed during submit.");
      }
      await sleep(600);
    }
  }
  throw lastErr || new Error("Submit click failed.");
}

async function captureSubmitEvidence(page, timeoutMs = 18000) {
  const isSubmitEndpoint = (url = "") => {
    const lower = String(url || "").toLowerCase();
    return (
      lower.includes("wp-comments-post.php") ||
      lower.includes("/wp-json/") && lower.includes("comment") ||
      lower.includes("admin-ajax.php")
    );
  };

  const requestPromise = page
    .waitForRequest((req) => req.method().toUpperCase() === "POST" && isSubmitEndpoint(req.url()), { timeout: timeoutMs })
    .then((req) => ({
      request_url: String(req.url() || ""),
      request_method: String(req.method() || ""),
      request_post_data: String(req.postData() || ""),
    }))
    .catch(() => null);

  const responsePromise = page
    .waitForResponse((res) => res.request().method().toUpperCase() === "POST" && isSubmitEndpoint(res.url()), { timeout: timeoutMs })
    .then(async (res) => {
      let bodySnippet = "";
      let json = null;
      try {
        const contentType = String(res.headers()["content-type"] || "").toLowerCase();
        if (contentType.includes("application/json")) {
          json = await res.json().catch(() => null);
        } else {
          bodySnippet = String(await res.text().catch(() => "")).slice(0, 1200);
        }
      } catch (_) {
        // best effort
      }
      return {
        response_url: String(res.url() || ""),
        response_status: Number(res.status() || 0),
        response_headers: res.headers() || {},
        response_json: json,
        response_body_snippet: bodySnippet,
      };
    })
    .catch(() => null);

  const [requestInfo, responseInfo] = await Promise.all([requestPromise, responsePromise]);
  const redirectUrl = String(responseInfo?.response_headers?.location || "").trim();
  const combined = [
    JSON.stringify(responseInfo?.response_json || {}),
    String(responseInfo?.response_body_snippet || ""),
    redirectUrl,
  ].join("\n");
  const idMatch = combined.match(/#comment-(\d{2,})/i)
    || combined.match(/[?&](?:unapproved|comment_id)=([0-9]{2,})/i)
    || combined.match(/comment[_-]?id["'\s:=]+([0-9]{2,})/i);

  return {
    request: requestInfo || null,
    response: responseInfo || null,
    redirect_url: redirectUrl,
    comment_id: idMatch ? String(idMatch[1]) : "",
  };
}

async function mapMissingSelectorsInteractive({ row, target, rowKey, siteName }) {
  const tempBrowser = await chromium.launch(resolveBrowserLaunchOptions(false));
  const context = await tempBrowser.newContext();
  const page = await context.newPage();
  
  // Inject stealth
  const humanSimulator = new HumanBehaviorSimulator(page);
  const captchaEvasion = new CaptchaEvasion(page, humanSimulator);
  await captchaEvasion.injectStealth();
  const sourceUrl = extractPrimaryUrl(row.directory_url || row.site_url || "");
  
  try {
    await safeGoto(page, sourceUrl, rowKey, siteName, humanSimulator);
    logger.log({ row_key: rowKey, site_name: siteName, action: "selector_mapping_open", status: "running" });

    const fields = [
      { key: "comment_box", label: "Comment Box" },
      { key: "name", label: "Name" },
      { key: "email", label: "Email" },
      { key: "website", label: "Website URL" },
      { key: "submit", label: "Submit Button" },
    ];

    const mapped = await runInteractiveSelectorMapper(page, fields);
    if (!Object.keys(mapped).length) {
      return { ok: false, message: "No selectors selected in overlay." };
    }

    const selectorPatch = {
      ...mapped,
      description: mapped.comment_box || target?.selectors?.description || "",
      website_name: mapped.name || target?.selectors?.website_name || "",
      target_link: mapped.website || target?.selectors?.target_link || "",
      submit_button: mapped.submit || target?.selectors?.submit_button || "",
    };

    const savedTarget = upsertTargetSelectors(TARGETS_PATH, sourceUrl, selectorPatch);
    target.selectors = savedTarget.selectors || {};

    logger.log({
      row_key: rowKey,
      site_name: siteName,
      action: "selector_mapping_saved",
      status: "ok",
      error_message: Object.keys(mapped).join(", "),
    });
    return { ok: true, selectors: mapped };
  } finally {
    await context.close();
    await tempBrowser.close();
  }
}

async function processTargetLink({ browser, row, preparedRow, target, workflow, rowKey, siteName, siteSlug, targetLink, targetIndex }) {
  const artifactBase = `pre_submit_${targetIndex + 1}`;
  const siteDir = path.join(RUNS_ROOT, RUN_ID, siteSlug);

  if (!workflow.uses_playwright) {
    return makeResult(
      targetLink,
      "pending_verification",
      "Outreach email workflow: draft + CRM tracking only (no Playwright submit).",
      { result_title: "Outreach Draft Prepared" }
    );
  }

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    locale: 'en-US',
    timezoneId: 'America/New_York',
  });
  
  const page = await context.newPage();
  
  // Initialize human behavior simulator
  const humanSimulator = new HumanBehaviorSimulator(page);
  const captchaEvasion = new CaptchaEvasion(page, humanSimulator);
  const sourceUrl = extractPrimaryUrl(row.directory_url || row.site_url || "");
  
  try {
    // Inject stealth scripts
    await captchaEvasion.injectStealth();
    
    await safeGoto(page, sourceUrl, rowKey, siteName, humanSimulator);
    logger.log({ row_key: rowKey, site_name: siteName, action: "navigate", status: "ok", error_message: targetLink });

    // Pre-flight human behavior
    if (HUMAN_BEHAVIOR_ENABLED) {
      await captchaEvasion.preFlightCheck();
    }

    if (workflow.type === "blog_commenting") {
      const adaptiveResult = await runAdaptiveBlogCommenting({
        page,
        row: preparedRow,
        target,
        targetLink,
        runDir: RUNS_ROOT,
        runId: RUN_ID,
        siteSlug,
        siteName,
        rowKey,
        approvalMode: APPROVAL_MODE,
        captureArtifacts: capturePageArtifacts,
        logger,
      });
      return makeResult(
        targetLink,
        adaptiveResult.status || "failed",
        adaptiveResult.status_reason || "",
        {
          created_link: adaptiveResult.created_link || "",
          result_title: adaptiveResult.result_title || "",
          artifacts: Array.isArray(adaptiveResult.artifacts) ? adaptiveResult.artifacts : [],
        }
      );
    }

    let detectedCommentForm = null;
    let useCommentFlow = workflow.type === "blog_commenting";
    if (useCommentFlow) {
      detectedCommentForm = await detectCommentForm(page, 10000);
      if (!detectedCommentForm.ok) {
        const artifacts = await capturePageArtifacts({
          page,
          siteDir,
          baseName: `${artifactBase}_no_comment_form`,
          rowKey,
          siteName,
          action: "no_comment_form_detected",
          status: "skipped",
          errorMessage: "Skipped: no comment form detected (not a blog commenting target)",
          targetLink,
        });
        return makeResult(targetLink, "skipped", "Skipped: no comment form detected (not a blog commenting target)", {
          artifacts,
        });
      }

      await scrollToCommentForm(page, detectedCommentForm.textarea);

      // Check for captcha with evasion
      const verificationGate = await detectVerificationGate(page);
      if (verificationGate?.kind === "auth") {
        const continuation = await continuePlatformAccess({
          context,
          page,
          row: preparedRow,
          humanSimulator,
          rowKey,
          siteName,
        });

        if (continuation.status === "access_granted") {
          await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
          detectedCommentForm = await detectCommentForm(page, 10000);
          if (detectedCommentForm?.ok) {
            await scrollToCommentForm(page, detectedCommentForm.textarea).catch(() => {});
            logger.log({
              row_key: rowKey,
              site_name: siteName,
              action: "platform_access_continue",
              status: "ok",
              error_message: "Google access continuation completed; comment form rediscovered.",
            });
          } else {
            const artifacts = await capturePageArtifacts({
              page,
              siteDir,
              baseName: `${artifactBase}_auth_continued_no_form`,
              rowKey,
              siteName,
              action: "needs_manual_mapping",
              status: "needs_manual_mapping",
              errorMessage: "access_granted but comment form not found after auth continuation",
              targetLink,
            });
            return makeResult(targetLink, "needs_manual_mapping", "Access granted but comment form not found after sign-in.", {
              artifacts,
            });
          }
        } else {
          const mappedStatus = continuation.status === "access_denied" ? "failed" : "pending_verification";
          const artifacts = await capturePageArtifacts({
            page,
            siteDir,
            baseName: `${artifactBase}_auth_required`,
            rowKey,
            siteName,
            action: "auth_required",
            status: mappedStatus,
            errorMessage: `Login/signup required before comment submit: ${verificationGate.selector} | ${continuation.status}:${continuation.reason || "unknown"}`,
            targetLink,
          });
          return makeResult(
            targetLink,
            mappedStatus,
            continuation.status === "access_denied"
              ? "Login/signup continuation failed."
              : "Login/signup continuation needs manual verification.",
            { artifacts }
          );
        }
      }

      if (verificationGate?.kind === "auth" && !detectedCommentForm?.ok) {
        const artifacts = await capturePageArtifacts({
          page,
          siteDir,
          baseName: `${artifactBase}_auth_required`,
          rowKey,
          siteName,
          action: "auth_required",
          status: "pending_verification",
          errorMessage: `Login/signup required before comment submit: ${verificationGate.selector}`,
          targetLink,
        });
        return makeResult(targetLink, "pending_verification", "Login/signup required before comment submission.", {
          artifacts,
        });
      }

      if (verificationGate?.kind === "captcha") {
        const captchaDetected = await captchaEvasion.evadeCaptcha();
        
        if (captchaDetected) {
          const artifacts = await capturePageArtifacts({
            page,
            siteDir,
            baseName: `${artifactBase}_captcha_encountered`,
            rowKey,
            siteName,
            action: "captcha_encountered",
            status: "pending_verification",
            errorMessage: `Captcha detected and attempted bypass: ${verificationGate.selector}`,
            targetLink,
          });
          return makeResult(targetLink, "pending_verification", `Captcha encountered: ${verificationGate.selector}`, {
            artifacts,
          });
        }
      }
    } else if (workflow.uses_playwright) {
      const autoDetected = await detectCommentForm(page, 2500);
      if (autoDetected.ok) {
        useCommentFlow = true;
        detectedCommentForm = autoDetected;
        await scrollToCommentForm(page, detectedCommentForm.textarea);
        logger.log({
          row_key: rowKey,
          site_name: siteName,
          action: "auto_switch_comment_flow",
          status: "ok",
          error_message: "Detected comment form on page; using blog commenting flow.",
        });
      }
    }

    if (useCommentFlow) {
      await fillBlogCommentFields(page, preparedRow, detectedCommentForm, targetLink, humanSimulator);
    } else {
      const rowForTarget = {
        ...preparedRow,
        target_link: targetLink,
        target_links: [targetLink],
      };

      const mapperResult = await applyGenericMapper(page, rowForTarget, target);
      if (mapperResult.missingSelectors.length || mapperResult.failed.length) {
        const artifacts = await capturePageArtifacts({
          page,
          siteDir,
          baseName: `${artifactBase}_needs_mapping`,
          rowKey,
          siteName,
          action: "needs_manual_mapping",
          status: "needs_manual_mapping",
          errorMessage: `Mapper issues. Missing selectors: [${mapperResult.missingSelectors.join(", ")}], failed fields: [${mapperResult.failed.map((f) => f.row_field).join(", ")}]`,
          targetLink,
        });
        return makeResult(
          targetLink,
          "needs_manual_mapping",
          `Mapper issues. Missing selectors: [${mapperResult.missingSelectors.join(", ")}], failed fields: [${mapperResult.failed.map((f) => f.row_field).join(", ")}]`,
          { artifacts }
        );
      }
    }

    const approval = await requestHumanApproval({
      page,
      runDir: RUNS_ROOT,
      runId: RUN_ID,
      siteSlug,
      siteName,
      rowKey,
      mode: APPROVAL_MODE,
      artifactNameBase: artifactBase,
    });

    logger.log({
      row_key: rowKey,
      site_name: siteName,
      action: "approval_checkpoint",
      status: approval.approved ? "approved" : "denied",
      screenshot_path: approval.screenshotPath,
      error_message: targetLink,
    });

    if (!approval.approved) {
      return makeResult(targetLink, "skipped", "Operator declined submission.", {
        artifacts: [approval.screenshotPath, approval.htmlPath],
      });
    }

    let submitLocator = null;
    const submitSelector = resolveSelectorValue(target.selectors || {}, "submit_button")
      || resolveSelectorValue(target.selectors || {}, "submit");
    if (useCommentFlow && detectedCommentForm?.submit) {
      submitLocator = detectedCommentForm.submit;
    } else if (submitSelector) {
      submitLocator = page.locator(submitSelector).first();
    }
    if (!submitLocator) {
      const artifacts = await capturePageArtifacts({
        page,
        siteDir,
        baseName: `${artifactBase}_missing_submit`,
        rowKey,
        siteName,
        action: "needs_manual_mapping",
        status: "needs_manual_mapping",
        errorMessage: "Missing submit selector.",
        targetLink,
      });
      return makeResult(targetLink, "needs_manual_mapping", "Missing submit selector.", { artifacts });
    }
    
    const beforeSubmitUrl = page.isClosed() ? "" : String(page.url() || "");
    const submitEvidencePromise = captureSubmitEvidence(page, 22000);
    await clickSubmitRobust(page, submitLocator, submitSelector || detectedCommentForm?.submitSelector || "", humanSimulator);
    const submitEvidence = await submitEvidencePromise.catch(() => null);

    let extracted = {
      created_link: "",
      result_title: "",
      status_hint: "unknown",
      evidence: "",
      submission_detected: false,
      pending_verification: false,
      error_detected: false,
    };
    if (!page.isClosed()) {
      extracted = await extractSubmissionResult(page, { beforeSubmitUrl, submitEvidence });
    }

    const postSubmitArtifacts = page.isClosed()
      ? []
      : await capturePageArtifacts({
          page,
          siteDir,
          baseName: `${artifactBase}_post_submit`,
          rowKey,
          siteName,
          action: "post_submit_state",
          status: extracted.status_hint || "unknown",
          errorMessage: extracted.evidence || "",
          targetLink,
        });

    if (extracted.error_detected) {
      return makeResult(targetLink, "failed", extracted.evidence || "Submission failed on target page.", {
        created_link: "",
        result_title: extracted.result_title || "",
        artifacts: [approval.screenshotPath, approval.htmlPath, ...postSubmitArtifacts],
      });
    }

    if (!extracted.submission_detected) {
      return makeResult(targetLink, "failed", extracted.evidence || "Submit clicked, but no confirmation/evidence was detected.", {
        created_link: "",
        result_title: extracted.result_title || "",
        artifacts: [approval.screenshotPath, approval.htmlPath, ...postSubmitArtifacts],
      });
    }

    const finalCreatedLink = String(extracted.created_link || "").trim();
    const finalStatus = finalCreatedLink ? "success" : "submitted";
    const finalReason = extracted.pending_verification
      ? (extracted.evidence || "Submitted and awaiting moderation/verification.")
      : (finalCreatedLink ? "" : (extracted.evidence || "Submitted successfully. Public URL not visible yet."));

    return makeResult(targetLink, finalStatus, finalReason, {
      created_link: finalCreatedLink,
      result_title: extracted.result_title || "",
      artifacts: [approval.screenshotPath, approval.htmlPath, ...postSubmitArtifacts],
    });
  } catch (err) {
    const artifacts = await capturePageArtifacts({
      page,
      siteDir,
      baseName: `${artifactBase}_failed`,
      rowKey,
      siteName,
      action: "target_failed",
      status: "failed",
      errorMessage: String(err.message || err),
      targetLink,
    });
    return makeResult(targetLink, "failed", String(err.message || err), { artifacts });
  } finally {
    await context.close();
  }
}

async function processRow(browser, row, targets) {
  const startedAt = nowIso();
  const rowKey = String(row.__rowKey || row.row_key || "");
  const directoryUrl = extractPrimaryUrl(row.directory_url || row.site_url || "");
  const siteName = row.site_name || directoryUrl || `row-${rowKey}`;
  const siteSlug = `${slugify(siteName)}-${slugify(rowKey)}`;
  const workflow = getWorkflow(row.backlink_type);

  const initialResults = parseResults(row.results);
  const targetLinks = normalizeTargetLinks(row.target_links || row.target_link);
  const resultMap = getResultMap(initialResults);

  const output = {
    results: [...resultMap.values()],
    result_title: row.result_title || "",
    created_link: row.created_link || "",
    status: "running",
    status_reason: "",
    run_id: RUN_ID,
    started_at: row.started_at || startedAt,
    completed_at: "",
    screenshot_url: row.screenshot_url || "",
  };

  async function persistPartialFromMap(resultMapInput, extra = {}) {
    const partial = aggregateOutput([...resultMapInput.values()]);
    const payload = {
      ...partial,
      run_id: RUN_ID,
      started_at: output.started_at,
      completed_at: "",
      ...extra,
    };
    await persistRowOutput(row, payload);
    rowState.output = { ...rowState.output, ...payload };
    snapshotRow(RUN_ID, siteSlug, rowState);
  }

  await persistRowOutput(row, output);
  logger.log({ row_key: rowKey, site_name: siteName, action: "start", status: "running" });

  const rowState = {
    row_key: rowKey,
    site_slug: siteSlug,
    run_id: RUN_ID,
    workflow_type: workflow.type,
    input: {
      ...row,
      directory_url: directoryUrl,
      site_url: directoryUrl,
      target_links: targetLinks,
    },
    output: { ...output },
  };
  snapshotRow(RUN_ID, siteSlug, rowState);

  if (!targetLinks.length) {
    const failOutput = {
      ...output,
      status: "failed",
      status_reason: "No target_links provided.",
      completed_at: nowIso(),
    };
    await persistRowOutput(row, failOutput);
    rowState.output = failOutput;
    snapshotRow(RUN_ID, siteSlug, rowState);
    return;
  }

  const target = findAllowlistedTarget(targets, directoryUrl);
  if (!target || !target.allowed) {
    const blockedResults = targetLinks.map((link) => makeResult(link, "blocked", "directory_url is not allowlisted in targets.json"));
    const aggregated = aggregateOutput(blockedResults);
    const blockedOutput = {
      ...output,
      ...aggregated,
      completed_at: nowIso(),
    };
    await persistRowOutput(row, blockedOutput);
    logger.log({ row_key: rowKey, site_name: siteName, action: "allowlist", status: "blocked" });
    rowState.output = blockedOutput;
    snapshotRow(RUN_ID, siteSlug, rowState);
    return;
  }

  const aiEnriched = await enrichRowWithAi(row, target);
  const preparedRow = aiEnriched.row || row;
  logger.log({
    row_key: rowKey,
    site_name: siteName,
    action: "ai_profile_fill",
    status: aiEnriched.usedAi ? "ai_used" : "ai_fallback",
    error_message: aiEnriched.reason || "",
  });

  let mappingCheck = validateTargetMapping(preparedRow, target, workflow.required_fields, workflow.required_selectors || []);
  if (!mappingCheck.ok && workflow.uses_playwright && workflow.type !== "blog_commenting") {
    if (mappingCheck.missingSelectors.length) {
      const mapped = await mapMissingSelectorsInteractive({ row, target, rowKey, siteName });
      if (mapped.ok) {
        mappingCheck = validateTargetMapping(preparedRow, target, workflow.required_fields, workflow.required_selectors || []);
      }
    }
  }

  if (!mappingCheck.ok && workflow.uses_playwright && mappingCheck.missingSheetFields.length) {
    let artifacts = [];
    let context = null;
    try {
      context = await browser.newContext();
      const page = await context.newPage();
      
      const humanSimulator = new HumanBehaviorSimulator(page);
      const captchaEvasion = new CaptchaEvasion(page, humanSimulator);
      await captchaEvasion.injectStealth();
      
      await safeGoto(page, directoryUrl, rowKey, siteName, humanSimulator);
      artifacts = await capturePageArtifacts({
        page,
        siteDir: path.join(RUNS_ROOT, RUN_ID, siteSlug),
        baseName: "pre_submit_missing_fields",
        rowKey,
        siteName,
        action: "needs_manual_mapping",
        status: "needs_manual_mapping",
        errorMessage: `Missing fields: [${mappingCheck.missingSheetFields.join(", ")}], selectors: [${mappingCheck.missingSelectors.join(", ")}]`,
      });
    } catch (_) {
      // best-effort artifact capture
    } finally {
      if (context) {
        await context.close().catch(() => {});
      }
    }
    const manualResults = targetLinks.map((link) => makeResult(
      link,
      "needs_manual_mapping",
      `Missing fields: [${mappingCheck.missingSheetFields.join(", ")}], selectors: [${mappingCheck.missingSelectors.join(", ")}]`,
      { artifacts }
    ));
    const aggregated = aggregateOutput(manualResults);
    const manualOutput = {
      ...output,
      ...aggregated,
      completed_at: nowIso(),
    };
    await persistRowOutput(row, manualOutput);
    logger.log({
      row_key: rowKey,
      site_name: siteName,
      action: "mapping_check",
      status: "needs_manual_mapping",
      error_message: manualOutput.status_reason,
    });
    rowState.output = manualOutput;
    snapshotRow(RUN_ID, siteSlug, rowState);
    return;
  }

  const blogCommentDomainSeen = new Set();
  for (let i = 0; i < targetLinks.length; i += 1) {
    const targetLink = targetLinks[i];
    if (workflow.type === "blog_commenting") {
      const host = normalizeHost(targetLink);
      if (host && blogCommentDomainSeen.has(host)) {
        resultMap.set(targetLink, makeResult(targetLink, "skipped", "Skipped: max 1 comment per domain per run."));
        await persistPartialFromMap(resultMap, { status_reason: "skipped:1 | Max 1 comment per domain in current run." });
        continue;
      }
      if (host) blogCommentDomainSeen.add(host);
    }
    const existing = resultMap.get(targetLink);

    if (!FORCE && existing && (existing.status === "success" || existing.created_link)) {
      logger.log({
        row_key: rowKey,
        site_name: siteName,
        action: "target_skip_idempotent",
        status: "skipped",
        error_message: targetLink,
      });
      continue;
    }

    resultMap.set(targetLink, makeResult(targetLink, "running", "Processing target link..."));
    await persistPartialFromMap(resultMap, { status_reason: "running:1 | Processing target link..." });

    try {
      const result = await Promise.race([
        processTargetLink({
          browser,
          row,
          preparedRow,
          target,
          workflow,
          rowKey,
          siteName,
          siteSlug,
          targetLink,
          targetIndex: i,
        }),
        sleep(TARGET_PROCESS_TIMEOUT_MS).then(() => {
          throw new Error(`Target processing timeout after ${TARGET_PROCESS_TIMEOUT_MS}ms`);
        }),
      ]);
      resultMap.set(targetLink, result);
      await persistPartialFromMap(resultMap, {
        screenshot_url: (result.artifacts && result.artifacts[0]) || output.screenshot_url || "",
      });
      logger.log({
        row_key: rowKey,
        site_name: siteName,
        action: "target_processed",
        status: result.status,
        error_message: `${targetLink} :: ${result.status_reason || "ok"}`,
      });
    } catch (err) {
      const failed = makeResult(targetLink, "failed", String(err.message || err));
      resultMap.set(targetLink, failed);
      logger.log({
        row_key: rowKey,
        site_name: siteName,
        action: "error",
        status: "failed",
        error_message: `${targetLink} :: ${failed.status_reason}`,
      });
    }
  }

  const finalAggregate = aggregateOutput([...resultMap.values()]);
  const finalOutput = {
    ...output,
    ...finalAggregate,
    run_id: RUN_ID,
    completed_at: nowIso(),
    screenshot_url: finalAggregate.results.find((item) => item.artifacts?.length)?.artifacts?.[0] || output.screenshot_url || "",
  };
  await persistRowOutput(row, finalOutput);
  rowState.output = finalOutput;
  snapshotRow(RUN_ID, siteSlug, rowState);
}

async function main() {
  logger.log({ action: "run_start", status: "running" });
  await ensureDataSourceReady();
  const targets = loadTargets(TARGETS_PATH);
  const queue = await loadQueueRows();
  logger.log({ action: "queue_loaded", status: "ok", error_message: `items=${queue.length}` });
  if (!queue.length) {
    logger.log({ action: "run_end", status: "noop", error_message: "No rows in queue." });
    return;
  }

  const browser = await chromium.launch(resolveBrowserLaunchOptions());
  try {
    for (let i = 0; i < queue.length; i += 1) {
      const row = queue[i];
      await processRow(browser, row, targets);
      if (i < queue.length - 1 && !SKIP_DELAY) {
        const delayMs = randomInt(MIN_DELAY_MIN * 60000, MAX_DELAY_MIN * 60000);
        logger.log({ row_key: String(row.__rowKey), site_name: row.site_name, action: "rate_limit_wait", status: "sleeping", error_message: `${delayMs}ms` });
        await sleep(delayMs);
      }
    }
  } finally {
    await browser.close();
  }
  logger.log({ action: "run_end", status: "completed" });
}

main().catch((err) => {
  logger.log({ action: "fatal", status: "failed", error_message: String(err.message || err) });
  process.exit(1);
});
