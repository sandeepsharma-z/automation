import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ensureDir, nowIso, sleep, writeJson } from "./utils.js";

async function withTimeout(promise, timeoutMs, fallbackValue = null) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function cliApprovalPrompt(siteName) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`Approve submission for ${siteName}? (yes/no): `);
  rl.close();
  return ["y", "yes"].includes(String(answer || "").trim().toLowerCase());
}

async function uiApprovalWait(siteDir, metadata) {
  const requestPath = path.join(siteDir, "approval_request.json");
  const decisionPath = path.join(siteDir, "approval_decision.json");
  writeJson(requestPath, {
    status: "pending",
    requested_at: nowIso(),
    ...metadata,
  });

  const timeoutMs = Number(process.env.APPROVAL_TIMEOUT_MS || 8 * 60 * 1000);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(decisionPath)) {
      const raw = fs.readFileSync(decisionPath, "utf8");
      const decision = JSON.parse(raw);
      return {
        approved: Boolean(decision.approved),
        decision,
      };
    }
    await sleep(2000);
  }
  return {
    approved: false,
    decision: {
      approved: false,
      reason: "approval_timeout",
      timed_out: true,
      timeout_ms: timeoutMs,
      decided_at: nowIso(),
    },
  };
}

export async function requestHumanApproval({
  page,
  runDir,
  runId,
  siteSlug,
  siteName,
  rowKey,
  mode = "cli",
  artifactNameBase = "pre_submit",
  forceManual = false,
  requestPayload = {},
  prefillOnly = false,
}) {
  const siteDir = ensureDir(path.join(runDir, runId, siteSlug));
  const safeBase = String(artifactNameBase || "pre_submit").replace(/[^a-z0-9_-]+/gi, "_");
  const screenshotPath = path.join(siteDir, `${safeBase}.png`);
  const htmlPath = path.join(siteDir, `${safeBase}.html`);
  const requestPath = path.join(siteDir, "approval_request.json");
  const decisionPath = path.join(siteDir, "approval_decision.json");

  const screenshotSaved = await withTimeout(
    page.screenshot({ path: screenshotPath, fullPage: true }).then(() => true).catch(() => false),
    12000,
    false
  );
  if (!screenshotSaved) {
    await withTimeout(
      page.screenshot({ path: screenshotPath, fullPage: false }).then(() => true).catch(() => false),
      7000,
      false
    );
  }

  const html = await withTimeout(page.content().catch(() => ""), 10000, "");
  if (typeof html === "string" && html.length) {
    fs.writeFileSync(htmlPath, html, "utf8");
  }

  const baseRequest = {
    status: "pending",
    requested_at: nowIso(),
    run_id: runId,
    row_key: rowKey,
    site_name: siteName,
    site_slug: siteSlug,
    screenshot_path: fs.existsSync(screenshotPath) ? screenshotPath : "",
    html_path: fs.existsSync(htmlPath) ? htmlPath : "",
    ...requestPayload,
  };

  if (prefillOnly) {
    writeJson(requestPath, baseRequest);
    return {
      approved: false,
      pending: true,
      screenshotPath,
      htmlPath,
      siteDir,
      requestPath,
      decisionPath,
    };
  }

  const autoApprove = !forceManual && String(process.env.AUTO_APPROVE_SUBMIT || "1").trim() === "1";
  if (autoApprove) {
    writeJson(requestPath, {
      ...baseRequest,
      status: "auto_approved",
      auto_approved: true,
    });
    writeJson(decisionPath, {
      approved: true,
      reason: "auto_approved_submit",
      decided_at: nowIso(),
      auto_approved: true,
    });
    return {
      approved: true,
      decision: {
        approved: true,
        reason: "auto_approved_submit",
        decided_at: nowIso(),
        auto_approved: true,
      },
      screenshotPath,
      htmlPath,
      siteDir,
    };
  }

  const effectiveMode =
    mode === "cli" && !input.isTTY
      ? "ui"
      : mode;

  const outcome =
    effectiveMode === "ui"
      ? await uiApprovalWait(siteDir, baseRequest)
      : { approved: await cliApprovalPrompt(siteName), decision: null };

  return {
    approved: Boolean(outcome?.approved),
    decision: outcome?.decision || null,
    screenshotPath,
    htmlPath,
    siteDir,
  };
}
