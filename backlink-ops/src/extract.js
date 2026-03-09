function pickFirst(text = "", candidates = []) {
  const hay = String(text || "").toLowerCase();
  for (const item of candidates) {
    const token = String(item || "").toLowerCase();
    if (token && hay.includes(token)) return token;
  }
  return "";
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw).toString();
  } catch (_) {
    return raw;
  }
}

function resolveUrl(baseUrl, maybeRelative) {
  const raw = String(maybeRelative || "").trim();
  if (!raw) return "";
  try {
    return new URL(raw, baseUrl || undefined).toString();
  } catch (_) {
    return raw;
  }
}

function isTransientSubmitUrl(urlLike) {
  const lower = String(urlLike || "").toLowerCase();
  return (
    lower.includes("wp-comments-post.php")
    || lower.includes("admin-ajax.php")
    || (lower.includes("/wp-json/") && lower.includes("comment"))
  );
}

export async function extractSubmissionResult(page, { beforeSubmitUrl = "", submitEvidence = null } = {}) {
  let title = "";
  let currentUrl = "";
  let bodyText = "";

  try {
    title = (await page.title()) || "";
  } catch (_) {
    title = "";
  }

  try {
    currentUrl = String(page.url() || "").trim();
  } catch (_) {
    currentUrl = "";
  }

  if (!title) {
    const heading = await page.locator("h1, h2, .success, .alert-success").first().textContent().catch(() => "");
    title = String(heading || "").trim();
  }

  bodyText = await page.locator("body").innerText().catch(() => "");
  const lower = String(bodyText || "").toLowerCase();
  const lowerTitle = String(title || "").toLowerCase();

  const successTokens = [
    "comment submitted",
    "comment posted",
    "thanks for your comment",
    "thank you for your comment",
    "your comment has been posted",
    "submission successful",
    "successfully submitted",
  ];
  const pendingTokens = [
    "awaiting moderation",
    "pending moderation",
    "awaiting approval",
    "comment is awaiting",
    "pending review",
    "verification required",
  ];
  const errorTokens = [
    "there was an error posting your comment",
    "duplicate comment detected",
    "duplicate comment",
    "you are posting comments too quickly",
    "comment failed",
    "invalid captcha",
    "captcha verification failed",
    "anti-spam answer is incorrect",
  ];

  const hasSuccessToken = Boolean(pickFirst(lower, successTokens));
  const hasPendingToken = Boolean(pickFirst(lower, pendingTokens));
  const formErrorText = await page.evaluate(() => {
    const roots = [
      document.querySelector("#respond"),
      document.querySelector(".comment-respond"),
      document.querySelector("form#commentform"),
      document.querySelector("form[action*='comment']"),
    ].filter(Boolean);
    const root = roots[0] || document.body;
    const candidates = Array.from(
      root.querySelectorAll(".error, .errors, .comment-error, .woocommerce-error, .alert-danger, .text-danger, .wpcf7-not-valid-tip, [aria-invalid='true']")
    );
    const visible = candidates.filter((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    });
    return visible.map((node) => String(node.textContent || "").trim()).join(" ").toLowerCase();
  }).catch(() => "");

  const hasErrorToken = Boolean(pickFirst(formErrorText, errorTokens));

  const hasCommentTextarea = await page
    .locator("textarea#comment, textarea[name*='comment' i], .comment-form textarea, form[action*='comment' i] textarea")
    .first()
    .isVisible()
    .catch(() => false);
  const hasBusyCommentSubmit = await page
    .locator("#comment-submit.is-busy, #comment-submit[aria-disabled='true'][disabled]")
    .first()
    .isVisible()
    .catch(() => false);

  const normalizedBefore = normalizeUrl(beforeSubmitUrl);
  const normalizedCurrent = normalizeUrl(currentUrl);
  const urlChanged = Boolean(normalizedBefore && normalizedCurrent && normalizedBefore !== normalizedCurrent);
  const movedToSubmitEndpoint = isTransientSubmitUrl(normalizedCurrent);
  const hasFailureTitle = /comment submission failure|submission failure|error/i.test(lowerTitle);

  let createdLink = "";
  const canonical = await page.locator("link[rel='canonical']").first().getAttribute("href").catch(() => "");
  if (canonical) {
    createdLink = normalizeUrl(canonical);
  } else if (urlChanged && !movedToSubmitEndpoint) {
    createdLink = normalizedCurrent;
  }

  const redirectUrl = resolveUrl(normalizedCurrent || normalizedBefore || "", submitEvidence?.redirect_url || "");
  const evidenceCommentId = String(submitEvidence?.comment_id || "").trim();
  const evidenceStatus = Number(submitEvidence?.response?.response_status || 0);
  const hasSubmitHttpEvidence = Boolean(
    submitEvidence?.request?.request_url
    || submitEvidence?.response?.response_url
  );
  const hasSubmitHttpSuccess = hasSubmitHttpEvidence && evidenceStatus >= 200 && evidenceStatus < 400;
  if (redirectUrl && !isTransientSubmitUrl(redirectUrl)) {
    createdLink = normalizeUrl(redirectUrl);
  } else if (evidenceCommentId && canonical) {
    createdLink = `${normalizeUrl(canonical)}#comment-${evidenceCommentId}`;
  }
  if (isTransientSubmitUrl(createdLink)) {
    createdLink = canonical ? normalizeUrl(canonical) : normalizeUrl(normalizedBefore);
  }

  let status_hint = "unknown";
  let submission_detected = false;
  let pending_verification = false;
  let error_detected = false;
  let evidence = "";

  if (hasFailureTitle) {
    status_hint = "failed";
    error_detected = true;
    evidence = "Post-submit page indicates comment submission failure.";
  } else if (hasErrorToken && !hasSuccessToken && !hasPendingToken) {
    status_hint = "failed";
    error_detected = true;
    evidence = "Submission appears failed (error/invalid/captcha indication found on page).";
  } else if (hasPendingToken) {
    status_hint = "pending_verification";
    submission_detected = true;
    pending_verification = true;
    if (!createdLink) createdLink = normalizedCurrent;
    evidence = "Submission accepted but awaiting moderation/verification.";
  } else if (hasSuccessToken || urlChanged) {
    status_hint = "submitted";
    submission_detected = true;
    if (!createdLink) createdLink = normalizedCurrent;
    evidence = urlChanged
      ? "Post-submit URL changed, likely submission completed."
      : "Success confirmation text found on page.";
  } else if (hasBusyCommentSubmit) {
    status_hint = "submitted";
    submission_detected = true;
    if (!createdLink) createdLink = normalizedCurrent;
    evidence = "Comment submit appears in-progress (AJAX busy state); likely awaiting processing/moderation.";
  } else if (hasSubmitHttpSuccess) {
    status_hint = "submitted";
    submission_detected = true;
    if (!createdLink) createdLink = normalizedCurrent;
    evidence = "Comment submit HTTP request succeeded.";
  } else if (hasCommentTextarea) {
    status_hint = "unknown";
    evidence = "Comment form is still visible and no confirmation text found.";
  } else {
    status_hint = "unknown";
    evidence = "No clear submit confirmation detected.";
  }

  return {
    result_title: title || "",
    created_link: createdLink || "",
    status_hint,
    evidence,
    submission_detected,
    pending_verification,
    error_detected,
  };
}
