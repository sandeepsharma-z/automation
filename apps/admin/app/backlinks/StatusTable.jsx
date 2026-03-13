"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

const PROFILE_STORAGE_KEY = "backlink_profile_defaults_v1";

const TYPE_LABELS = {
  "all-links": "All Links",
  "directory-submission": "Directory Submission",
  "classified-ads": "Classified Ads",
  "article-submission": "Article Submission",
  "profile-creation": "Profile Creation",
  "image-submission": "Image",
  "pdf-submission": "PDF",
  "blog-commenting": "Blog Commenting",
  "social-bookmarking": "Social Bookmarking",
};

const DEBUG_BACKLINK_OPS = process.env.NEXT_PUBLIC_DEBUG_BACKLINK_OPS === "1";

function hasRunningRows(list = []) {
  const rows = Array.isArray(list) ? list : [];
  return rows.some((row) => String(row?.output?.status || "").trim().toLowerCase() === "running");
}

export default function StatusTable({ title, endpoint, showRunNow = false }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [headless, setHeadless] = useState(false);
  const [message, setMessage] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [runStatus, setRunStatus] = useState({
    running: false,
    child_alive: false,
    session_id: "",
    current_row_id: "",
    started_at: "",
    stop_requested: false,
  });
  const effectiveRunning = useMemo(
    () => (Boolean(runStatus.running) && Boolean(runStatus.child_alive)) || hasRunningRows(rows),
    [runStatus.running, runStatus.child_alive, rows]
  );
  const [clockTick, setClockTick] = useState(0);
  const [form, setForm] = useState({
    default_website_url: "",
    default_site_name: "",
    default_username: "",
    default_email: "",
    default_password: "",
    company_name: "",
    company_address: "",
    company_phone: "",
    company_description: "",
    category: "",
    notes: "",
  });
  const [bulkRows, setBulkRows] = useState([
    { directory_url: "", target_links: "", username: "", email: "", password: "", site_name: "", link_type: "" },
  ]);
  const [selectedTypeSlug, setSelectedTypeSlug] = useState("");
  const [profileSavedAt, setProfileSavedAt] = useState("");
  const [successVaultEntries, setSuccessVaultEntries] = useState([]);
  const [successVaultLoading, setSuccessVaultLoading] = useState(false);
  const [notifyOnVerification, setNotifyOnVerification] = useState(true);
  const [voiceAlertText, setVoiceAlertText] = useState("Sandeep Sharma, please do the verification.");
  const [voiceAlarmActive, setVoiceAlarmActive] = useState(false);
  const verificationSeenRef = useRef(new Set());
  const verificationAlarmRef = useRef(null);
  const verificationAlarmMessageRef = useRef("");
  const verificationAlarmCountRef = useRef(0);
  const verificationAlarmLastMessageRef = useRef("");

  function stopVerificationAlarm({ resetCycle = false } = {}) {
    if (verificationAlarmRef.current) {
      clearInterval(verificationAlarmRef.current);
      verificationAlarmRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    if (resetCycle) {
      verificationAlarmMessageRef.current = "";
      verificationAlarmLastMessageRef.current = "";
      verificationAlarmCountRef.current = 0;
    }
    setVoiceAlarmActive(false);
  }

  function speakVerificationMessage(message) {
    if (typeof window === "undefined") return;
    try {
      if (!("speechSynthesis" in window)) return;
      const text = String(message || "").trim();
      if (!text) return;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.volume = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    } catch (_) {
      // best effort
    }
  }

  function startVerificationAlarm(rowsList = []) {
    if (!notifyOnVerification) return;
    const countRows = Array.isArray(rowsList) ? rowsList.length : 0;
    if (!countRows) {
      stopVerificationAlarm();
      return;
    }
    const first = rowsList[0] || {};
    const rowKey = String(first?.row_key || "").trim();
    const reason = String(first?.output?.status_reason || "").trim();
    const baseText = String(voiceAlertText || "Please do the verification.").trim();
    const spoken = `${baseText} Row ${rowKey || "unknown"} needs verification${reason ? `. Reason: ${reason}` : ""}`;

    if (verificationAlarmLastMessageRef.current !== spoken) {
      verificationAlarmLastMessageRef.current = spoken;
      verificationAlarmCountRef.current = 0;
    }
    if (verificationAlarmCountRef.current >= 5) {
      setVoiceAlarmActive(false);
      return;
    }

    if (verificationAlarmRef.current && verificationAlarmMessageRef.current === spoken) {
      setVoiceAlarmActive(true);
      return;
    }
    stopVerificationAlarm();
    verificationAlarmMessageRef.current = spoken;
    setVoiceAlarmActive(true);
    speakVerificationMessage(spoken);
    verificationAlarmCountRef.current += 1;
    verificationAlarmRef.current = setInterval(() => {
      if (verificationAlarmCountRef.current >= 5) {
        stopVerificationAlarm();
        return;
      }
      speakVerificationMessage(spoken);
      verificationAlarmCountRef.current += 1;
    }, 7000);
  }

  function notifyVerification(rowsList = []) {
    if (typeof window === "undefined") return;
    const countRows = Array.isArray(rowsList) ? rowsList.length : 0;
    if (!countRows) return;
    const first = rowsList[0] || {};
    const rowKey = String(first?.row_key || "").trim();
    const reason = String(first?.output?.status_reason || "").trim();
    const body = countRows > 1
      ? `${countRows} rows need verification. First row #${rowKey}${reason ? ` (${reason})` : ""}`
      : `Row #${rowKey} needs verification${reason ? `: ${reason}` : ""}`;

    if (!("Notification" in window)) return;
    const showBrowserNotification = () => {
      try {
        const n = new Notification("Backlink Ops: Verification Needed", {
          body,
          tag: "backlink-verification-needed",
          renotify: true,
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
      } catch (_) {
        // beep-only fallback
      }
    };
    if (Notification.permission === "granted") {
      showBrowserNotification();
    } else if (Notification.permission === "default") {
      Notification.requestPermission().then((p) => {
        if (p === "granted") showBrowserNotification();
      }).catch(() => {});
    }
  }

  function applyDefaultsToRows(rowsInput, defaults) {
    return (rowsInput || []).map((row) => ({
      ...row,
      directory_url: row.directory_url || defaults.directory_url || "",
      username: row.username || defaults.default_username || "",
      email: row.email || defaults.default_email || "",
      password: row.password || defaults.default_password || "",
      site_name: row.site_name || defaults.default_site_name || defaults.company_name || "",
      link_type: row.link_type || defaults.category || "",
    }));
  }

  function debugLog(...args) {
    if (!DEBUG_BACKLINK_OPS) return;
    console.log("[backlink-ops]", ...args);
  }

  function getStorageKey() {
    return `${PROFILE_STORAGE_KEY}:${selectedTypeSlug || "all-links"}`;
  }

  function saveProfileDefaults() {
    try {
      const payload = {
        ...form,
        saved_at: new Date().toISOString(),
      };
      localStorage.setItem(getStorageKey(), JSON.stringify(payload));
      setProfileSavedAt(payload.saved_at);
      setBulkRows((prev) => applyDefaultsToRows(prev, payload));
      setMessage("Profile defaults saved. Ab bulk rows add kar sakte ho.");
      setError("");
      fetch("/api/backlinks/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
    } catch (err) {
      setError(`Unable to save profile defaults: ${String(err.message || err)}`);
    }
  }

  function loadProfileDefaults() {
    try {
      const raw = localStorage.getItem(getStorageKey());
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      const loaded = {
        default_website_url: String(parsed.default_website_url || parsed.default_site_url || ""),
        default_site_name: String(parsed.default_site_name || ""),
        default_username: String(parsed.default_username || ""),
        default_email: String(parsed.default_email || ""),
        default_password: String(parsed.default_password || ""),
        company_name: String(parsed.company_name || ""),
        company_address: String(parsed.company_address || ""),
        company_phone: String(parsed.company_phone || ""),
        company_description: String(parsed.company_description || ""),
        category: String(parsed.category || ""),
        notes: String(parsed.notes || ""),
      };
      setForm((prev) => ({
        ...prev,
        ...loaded,
        category: loaded.category || prev.category || "",
      }));
      setBulkRows((prev) => applyDefaultsToRows(prev, { ...loaded, category: loaded.category || form.category || "" }));
      setProfileSavedAt(String(parsed.saved_at || ""));
      return true;
    } catch (_) {
      return false;
    }
  }
  async function loadProfileDefaultsFromServer() {
    try {
      const res = await fetch("/api/backlinks/profile", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data?.profile) return false;
      const parsed = data.profile;
      const loaded = {
        default_website_url: String(parsed.default_website_url || parsed.default_site_url || ""),
        default_site_name: String(parsed.default_site_name || ""),
        default_username: String(parsed.default_username || ""),
        default_email: String(parsed.default_email || ""),
        default_password: String(parsed.default_password || ""),
        company_name: String(parsed.company_name || ""),
        company_address: String(parsed.company_address || ""),
        company_phone: String(parsed.company_phone || ""),
        company_description: String(parsed.company_description || ""),
        category: String(parsed.category || ""),
        notes: String(parsed.notes || ""),
      };
      setForm((prev) => ({
        ...prev,
        ...loaded,
        category: loaded.category || prev.category || "",
      }));
      setBulkRows((prev) => applyDefaultsToRows(prev, { ...loaded, category: loaded.category || form.category || "" }));
      setProfileSavedAt(String(parsed.saved_at || ""));
      return true;
    } catch (_) {
      return false;
    }
  }

  async function load(options = {}) {
    const silent = Boolean(options?.silent);
    if (!silent) {
      setLoading(true);
    }
    setError("");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
      const data = await res.json();
      debugLog("queue/load", data);
      const nextRows = Array.isArray(data?.rows) ? data.rows : [];
      setRows(nextRows);
    } catch (err) {
      const msg = String(err?.name === "AbortError" ? "Request timeout. Please click Refresh." : err.message || err);
      setError(msg);
    } finally {
      clearTimeout(timeout);
      if (!silent) {
        setLoading(false);
      }
    }
  }

  async function loadSuccessVault(options = {}) {
    const silent = Boolean(options?.silent);
    if (!silent) {
      setSuccessVaultLoading(true);
    }
    try {
      const res = await fetch("/api/backlinks/success-vault", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load success vault");
      setSuccessVaultEntries(Array.isArray(data.entries) ? data.entries : []);
    } catch (err) {
      debugLog("success-vault/load-error", String(err?.message || err));
    } finally {
      if (!silent) {
        setSuccessVaultLoading(false);
      }
    }
  }

  async function runNow() {
    if (effectiveRunning || isStarting || queuedCount <= 0) return;
    setIsStarting(true);
    setMessage("");
    setError("");
    setMessage("Starting run session...");
    try {
      const res = await fetch("/api/backlink-ops/run/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headless }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Run start failed");
      setRunStatus((prev) => ({
        ...prev,
        running: Boolean(data.running),
        child_alive: Boolean(data.running),
        session_id: String(data.session_id || prev.session_id || ""),
        current_row_id: String(data.current_row_id || ""),
        started_at: String(data.started_at || prev.started_at || new Date().toISOString()),
      }));
      setMessage(data.already_running ? `Run already active: ${data.session_id}` : `Run started: ${data.session_id}`);
      await Promise.all([loadRunStatus(), load({ silent: true }), loadSuccessVault({ silent: true })]);
    } catch (err) {
      setError(String(err.message || err));
    } finally {
      setIsStarting(false);
    }
  }

  async function stopNow() {
    setMessage("");
    try {
      const res = await fetch("/api/backlink-ops/run/stop", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Stop failed");
      setRunStatus((prev) => ({
        ...prev,
        running: false,
        child_alive: false,
        stop_requested: false,
        current_row_id: "",
      }));
      setMessage(`Stopped.${Number(data?.stopped_rows || 0) > 0 ? ` Rows reset: ${Number(data.stopped_rows)}.` : ""}`);
      await Promise.all([loadRunStatus(), load({ silent: true }), loadSuccessVault({ silent: true })]);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function loadRunStatus() {
    try {
      const res = await fetch("/api/backlink-ops/run/status", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Unable to fetch run status");
      setRunStatus({
        running: Boolean(data.running),
        child_alive: Boolean(data.child_alive),
        session_id: String(data.session_id || ""),
        current_row_id: String(data.current_row_id || ""),
        started_at: String(data.started_at || ""),
        stop_requested: Boolean(data.stop_requested),
      });
    } catch (err) {
      debugLog("run/status-error", String(err?.message || err));
    }
  }

  async function addRow() {
    setMessage("");
    setError("");
    const normalizedRows = bulkRows
      .map((row) => ({
        directory_url: String(row.directory_url || "").trim(),
        target_links: String(row.target_links || "").trim(),
        username: String(row.username || "").trim(),
        email: String(row.email || "").trim(),
        password: String(row.password || "").trim(),
        site_name: String(row.site_name || "").trim(),
        link_type: String(row.link_type || "").trim(),
      }))
      .filter((row) => row.directory_url || row.target_links || row.username || row.email || row.password || row.site_name || row.link_type);

    if (!normalizedRows.length) {
      setError("Please add at least one bulk row.");
      return;
    }

    function guessSiteName(siteUrl) {
      try {
        const host = new URL(siteUrl).hostname.replace(/^www\./, "");
        return host;
      } catch (_) {
        return "";
      }
    }

    try {
      const created = [];
      for (const rowItem of normalizedRows) {
        const { directory_url, target_links: target_links_raw, username, email, password, site_name, link_type } = rowItem;
        if (!directory_url || !target_links_raw) {
          throw new Error("Each bulk row requires directory_url and target_links.");
        }
        created.push({
          directory_url,
          site_url: directory_url,
          site_name: site_name || guessSiteName(directory_url),
          target_links: target_links_raw,
          username,
          email,
          password,
          link_type,
        });
      }

      const res = await fetch("/api/backlinks/queue/bulk-add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auto_run: true,
          headless,
          defaults: {
            default_website_url: form.default_website_url,
            directory_url: "",
            username: form.default_username,
            email: form.default_email,
            password: form.default_password,
            site_name: form.default_site_name,
            company_name: form.company_name,
            company_address: form.company_address,
            company_phone: form.company_phone,
            company_description: form.company_description,
            category: form.category,
            notes: form.notes,
            backlink_type: selectedTypeSlug || "business_directory",
          },
          rows: created,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Unable to add rows");
      debugLog("queue/bulk-add", data);

      const runMessage = data?.run?.session_id
        ? (data?.run?.attached_to_running
          ? ` Attached to run: ${data.run.session_id}.`
          : ` Run started: ${data.run.session_id}.`)
        : "";
      setMessage(
        `Added ${Number(data?.added || 0)} rows to queue${Array.isArray(data?.rejected) && data.rejected.length ? ` (${data.rejected.length} rejected)` : ""}.${runMessage}`
      );
      setBulkRows(
        applyDefaultsToRows(
          [{ directory_url: "", target_links: "", username: "", email: "", password: "", site_name: "", link_type: "" }],
          form
        )
      );
      await Promise.all([load(), loadRunStatus(), loadSuccessVault({ silent: true })]);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  useEffect(() => {
    load();
    loadSuccessVault();
  }, [endpoint]);

  useEffect(() => {
    if (!showRunNow) return;
    loadRunStatus();
    load({ silent: true });
    loadSuccessVault({ silent: true });
  }, [showRunNow, endpoint]);

  useEffect(() => {
    if (!showRunNow || !effectiveRunning) return;
    const timer = setInterval(() => {
      loadRunStatus();
      load({ silent: true });
      loadSuccessVault({ silent: true });
    }, 1500);
    return () => clearInterval(timer);
  }, [showRunNow, effectiveRunning]);

  useEffect(() => {
    if (!showRunNow || !effectiveRunning) return undefined;
    const timer = setInterval(() => setClockTick((v) => v + 1), 1000);
    return () => clearInterval(timer);
  }, [showRunNow, effectiveRunning]);

  const selectedTypeLabel = TYPE_LABELS[selectedTypeSlug] || "";

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search || "");
    setSelectedTypeSlug(String(params.get("type") || "").trim().toLowerCase());
  }, [endpoint]);

  useEffect(() => {
    if (!showRunNow || !selectedTypeLabel) return;
    setForm((prev) => (prev.category ? prev : { ...prev, category: selectedTypeLabel }));
  }, [showRunNow, selectedTypeLabel]);

  useEffect(() => {
    if (!showRunNow) return;
    loadProfileDefaults();
    loadProfileDefaultsFromServer();
  }, [showRunNow, selectedTypeSlug]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem("backlink_notify_verification");
      if (raw === "0") setNotifyOnVerification(false);
      const msg = window.localStorage.getItem("backlink_verify_voice_text");
      if (msg) setVoiceAlertText(String(msg));
    } catch (_) {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("backlink_notify_verification", notifyOnVerification ? "1" : "0");
      window.localStorage.setItem("backlink_verify_voice_text", String(voiceAlertText || ""));
    } catch (_) {
      // ignore
    }
  }, [notifyOnVerification, voiceAlertText]);

  const safeRows = useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);
  const count = useMemo(() => safeRows.length, [safeRows]);

  function normalizeStatus(value) {
    const raw = String(value || "queued").trim().toLowerCase();
    if (!raw) return "queued";
    return raw.replace(/\s+/g, "_");
  }

  useEffect(() => {
    const pendingRows = safeRows.filter((row) => {
      const s = normalizeStatus(row?.output?.status);
      return s === "pending_verification" || s === "manual_access_required" || s === "access_required";
    });
    const currentRow = String(runStatus.current_row_id || "").trim();
    const activePendingRows = currentRow
      ? pendingRows.filter((row) => String(row?.row_key || "") === currentRow)
      : [];
    const shouldRingNow =
      notifyOnVerification
      && activePendingRows.length > 0
      && Boolean(runStatus.running)
      && Boolean(runStatus.child_alive)
      && effectiveRunning;

    if (!shouldRingNow) {
      stopVerificationAlarm({ resetCycle: true });
      return;
    }

    const unseen = [];
    for (const row of activePendingRows) {
      const key = `${String(row?.row_key || "")}:${String(row?.output?.run_id || row?.run_id || "")}:${String(row?.output?.status_reason || "")}`;
      if (!verificationSeenRef.current.has(key)) {
        verificationSeenRef.current.add(key);
        unseen.push(row);
      }
    }
    startVerificationAlarm(activePendingRows);
    if (unseen.length) notifyVerification(unseen);
  }, [safeRows, notifyOnVerification, voiceAlertText, effectiveRunning, runStatus.running, runStatus.child_alive, runStatus.current_row_id]);

  useEffect(() => () => stopVerificationAlarm(), []);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleWindowClose = () => stopVerificationAlarm();
    window.addEventListener("beforeunload", handleWindowClose);
    return () => {
      window.removeEventListener("beforeunload", handleWindowClose);
    };
  }, []);

  function statusToneClass(value) {
    const status = normalizeStatus(value);
    if (status === "success" || status === "submitted") return "status-positive";
    if (status === "running" || status === "queued") return "status-running";
    if (status === "pending_verification" || status === "needs_manual_mapping" || status === "access_required" || status === "manual_access_required") return "status-warning";
    if (status === "skipped" || status === "stopped") return "status-muted";
    return "status-negative";
  }

  const statusCounts = useMemo(() => {
    const counts = {
      queued: 0,
      running: 0,
      success: 0,
      submitted: 0,
      pending_verification: 0,
      access_required: 0,
      manual_access_required: 0,
      needs_manual_mapping: 0,
      skipped: 0,
      failed: 0,
      stopped: 0,
      blocked: 0,
    };
    for (const row of safeRows) {
      const status = normalizeStatus(row?.output?.status || "queued");
      if (status in counts) {
        counts[status] += 1;
      } else {
        counts.failed += 1;
      }
    }
    return counts;
  }, [safeRows]);

  const queuedCount = useMemo(
    () => statusCounts.queued,
    [statusCounts]
  );

  const processedCount = useMemo(
    () =>
      statusCounts.success +
      statusCounts.submitted +
      statusCounts.pending_verification +
      statusCounts.access_required +
      statusCounts.manual_access_required +
      statusCounts.needs_manual_mapping +
      statusCounts.skipped +
      statusCounts.failed +
      statusCounts.stopped +
      statusCounts.blocked,
    [statusCounts]
  );
  const totalCount = useMemo(() => processedCount + statusCounts.queued + statusCounts.running, [processedCount, statusCounts]);
  const progressPct = useMemo(() => (totalCount > 0 ? Math.round((processedCount / totalCount) * 100) : 0), [processedCount, totalCount]);
  const runElapsedSeconds = useMemo(() => {
    if (!runStatus.started_at) return 0;
    const startedMs = new Date(runStatus.started_at).getTime();
    if (!Number.isFinite(startedMs) || startedMs <= 0) return 0;
    return Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
  }, [runStatus.started_at, clockTick]);
  function formatElapsed(seconds) {
    const s = Math.max(0, Number(seconds || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function safeText(value, fallback = "-") {
    if (value === null || value === undefined || value === "") return fallback;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }

  function updateBulkRow(index, key, value) {
    setBulkRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  }

  function addBulkRowLine() {
    setBulkRows((prev) => [
      ...prev,
      {
        directory_url: "",
        target_links: "",
        username: form.default_username || "",
        email: form.default_email || "",
        password: form.default_password || "",
        site_name: form.default_site_name || form.company_name || "",
        link_type: form.category || "",
      },
    ]);
  }

  function removeBulkRowLine(index) {
    setBulkRows((prev) => {
      if (prev.length <= 1) {
        return [{ directory_url: "", target_links: "", username: "", email: "", password: "", site_name: "", link_type: "" }];
      }
      return prev.filter((_, i) => i !== index);
    });
  }

  async function retryRow(rowKey) {
    try {
      const res = await fetch("/api/backlinks/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_key: rowKey, headless: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Retry failed");
      setRunStatus((prev) => ({
        ...prev,
        running: Boolean(data.running),
        child_alive: Boolean(data.running),
        session_id: String(data.session_id || data.run_id || prev.session_id || ""),
        current_row_id: String(rowKey || ""),
        started_at: prev.started_at || new Date().toISOString(),
      }));
      if (data.already_running) {
        setMessage(data.message || `Run already active: ${data.session_id || data.run_id}`);
      } else {
        setMessage(`Retry started for row #${rowKey}. Run: ${data.run_id}`);
      }
      await Promise.all([loadRunStatus(), load({ silent: true }), loadSuccessVault({ silent: true })]);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function removeRow(rowKey) {
    try {
      const res = await fetch(`/api/backlinks/queue?row_key=${encodeURIComponent(rowKey)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Remove failed");
      setMessage(`Row #${rowKey} removed from queue.`);
      await Promise.all([load(), loadSuccessVault({ silent: true })]);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  function isAllowlistBlocked(row) {
    const status = String(row?.output?.status || "").toLowerCase();
    const reason = String(row?.output?.status_reason || "").toLowerCase();
    return status === "blocked" && (reason.includes("allowlisted") || reason.includes("allowlist"));
  }

  function isNeedsMapping(row) {
    return normalizeStatus(row?.output?.status) === "needs_manual_mapping";
  }

  function getRowScreenshotUrl(row) {
    const direct = String(row?.output?.screenshot_url || "").trim();
    if (direct) return direct;
    const results = Array.isArray(row?.output?.results) ? row.output.results : [];
    for (const result of results) {
      const artifacts = Array.isArray(result?.artifacts) ? result.artifacts : [];
      for (const item of artifacts) {
        const text = String(item || "").trim();
        if (/^https?:\/\//i.test(text)) return text;
      }
    }
    return "";
  }

  function canApproveRow(row) {
    const runId = String(row?.run_id || row?.output?.run_id || "").trim();
    const siteSlug = String(row?.site_slug || "").trim();
    const pending = Boolean(row?.artifacts?.approval_request) && !Boolean(row?.artifacts?.approval_decision);
    return Boolean(runId && siteSlug && pending);
  }

  async function approveRow(row, approved = true) {
    const runId = String(row?.run_id || row?.output?.run_id || "").trim();
    const siteSlug = String(row?.site_slug || "").trim();
    if (!runId || !siteSlug) {
      setError("Approval data missing for this row. Open Logs once and retry.");
      return;
    }
    try {
      const res = await fetch("/api/backlinks/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: runId, site_slug: siteSlug, approved: Boolean(approved) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Approval failed");
      setMessage(approved ? `Approved row #${row?.row_key}. Runner will continue submit.` : `Rejected row #${row?.row_key}.`);
      await Promise.all([loadRunStatus(), load({ silent: true }), loadSuccessVault({ silent: true })]);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  async function addToAllowlist(row) {
    const directoryUrl = String(row?.input?.directory_url || row?.input?.site_url || "").trim();
    const type = String(row?.input?.backlink_type || selectedTypeSlug || "business_directory");
    if (!directoryUrl) {
      setError("Directory URL missing on this row.");
      return;
    }
    try {
      const res = await fetch("/api/backlink-ops/targets/allowlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory_url: directoryUrl, type }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error || "Allowlist update failed");
      }
      setMessage(`Added ${data.domain} to allowlist.`);
      await Promise.all([load(), loadSuccessVault({ silent: true })]);
    } catch (err) {
      setError(String(err.message || err));
    }
  }

  return (
    <section className="card" style={{ overflow: "visible" }}>
      <h2 style={{ marginTop: 0 }}>{title}</h2>
      <div className="muted">Total rows: {count}</div>
      {showRunNow ? (
        <>
          <div className="card" style={{ marginTop: 12, marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Fill Backlink Details Here</h3>
            <div className="muted" style={{ marginBottom: 10 }}>
              Enter your business profile once. Then paste bulk signup rows below (directory site + target link + credentials).
            </div>
            {selectedTypeLabel ? (
              <div className="muted" style={{ marginBottom: 10 }}>
                Selected backlink type: <strong>{selectedTypeLabel}</strong>
              </div>
            ) : null}
            <div className="form-grid">
              <label className="field">
                <span>Default Website URL (Our Site)</span>
                <input
                  placeholder="https://accountx.in"
                  value={form.default_website_url}
                  onChange={(e) => setForm((s) => ({ ...s, default_website_url: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Default Username (for signup/login)</span>
                <input
                  placeholder="account01"
                  value={form.default_username}
                  onChange={(e) => setForm((s) => ({ ...s, default_username: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Default Email (for signup/login)</span>
                <input
                  placeholder="name@gmail.com"
                  value={form.default_email}
                  onChange={(e) => setForm((s) => ({ ...s, default_email: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Default Password (for signup/login)</span>
                <input
                  type="password"
                  placeholder="Login password"
                  value={form.default_password}
                  onChange={(e) => setForm((s) => ({ ...s, default_password: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Default Site Name</span>
                <input
                  placeholder="Bookmark Template"
                  value={form.default_site_name}
                  onChange={(e) => setForm((s) => ({ ...s, default_site_name: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Company Name</span>
                <input
                  placeholder="Your business name"
                  value={form.company_name}
                  onChange={(e) => setForm((s) => ({ ...s, company_name: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Company Address</span>
                <input
                  placeholder="Full business address"
                  value={form.company_address}
                  onChange={(e) => setForm((s) => ({ ...s, company_address: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Company Phone</span>
                <input
                  placeholder="+91..."
                  value={form.company_phone}
                  onChange={(e) => setForm((s) => ({ ...s, company_phone: e.target.value }))}
                />
              </label>
              <label className="field">
                <span>Default Backlink Type</span>
                <input
                  placeholder="Directory Submission / Classified Ads / Article Submission / Profile Creation / Image / PDF / Blog"
                  value={form.category}
                  onChange={(e) => setForm((s) => ({ ...s, category: e.target.value }))}
                />
              </label>
              <label className="field field-wide">
                <span>Company Description</span>
                <textarea
                  rows={4}
                  placeholder="Business summary, services, and USP. This will be used in profile content."
                  value={form.company_description}
                  onChange={(e) => setForm((s) => ({ ...s, company_description: e.target.value }))}
                />
              </label>
              <label className="field field-wide">
                <span>Notes</span>
                <textarea
                  rows={4}
                  placeholder="Special instructions, preferred anchors, submission notes."
                  value={form.notes}
                  onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))}
                />
              </label>
            </div>
            <div className="stack" style={{ marginTop: 10 }}>
              <button onClick={saveProfileDefaults}>Save Profile Defaults</button>
              <button className="secondary" onClick={() => loadProfileDefaults()}>
                Load Saved Profile
              </button>
              {profileSavedAt ? (
                <span className="pill">Saved: {new Date(profileSavedAt).toLocaleString()}</span>
              ) : (
                <span className="pill muted">Profile not saved yet</span>
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12, marginBottom: 12 }}>
            <h3 style={{ marginTop: 0 }}>Bulk Backlink Targets Table</h3>
            <div className="muted" style={{ marginBottom: 10 }}>
              Add bulk target rows here. Username/email/password/site defaults upar se auto-fill ho jayenge after Save.
            </div>
            <div className="muted" style={{ marginBottom: 12 }}>
              Default Website URL = our business website. Directory URL = target site jahan browser comment/profile submit karega.
            </div>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ minWidth: 180 }}>Directory URL *</th>
                    <th style={{ minWidth: 220 }}>Target Link(s) *</th>
                    <th style={{ minWidth: 140 }}>Username</th>
                    <th style={{ minWidth: 170 }}>Email</th>
                    <th style={{ minWidth: 140 }}>Password</th>
                    <th style={{ minWidth: 160 }}>Site Name</th>
                    <th style={{ minWidth: 160 }}>Link Type</th>
                    <th style={{ minWidth: 90 }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkRows.map((row, index) => (
                    <tr key={`bulk-row-${index}`}>
                      <td>
                        <input
                          placeholder="https://directory-site.com"
                          value={row.directory_url}
                          onChange={(e) => updateBulkRow(index, "directory_url", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="https://target-1.com;https://target-2.com"
                          value={row.target_links}
                          onChange={(e) => updateBulkRow(index, "target_links", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="account01"
                          value={row.username}
                          onChange={(e) => updateBulkRow(index, "username", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="name@gmail.com"
                          value={row.email}
                          onChange={(e) => updateBulkRow(index, "email", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="password"
                          value={row.password}
                          onChange={(e) => updateBulkRow(index, "password", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="Bookmark Template"
                          value={row.site_name}
                          onChange={(e) => updateBulkRow(index, "site_name", e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          placeholder="Directory Submission"
                          value={row.link_type}
                          onChange={(e) => updateBulkRow(index, "link_type", e.target.value)}
                        />
                      </td>
                      <td>
                        <button className="secondary" onClick={() => removeBulkRowLine(index)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="secondary" onClick={addBulkRowLine}>
                Add Row
              </button>
              <button onClick={addRow}>Add Bulk Rows To Queue</button>
            </div>
          </div>

          <div className="card run-panel" style={{ marginTop: 12, marginBottom: 12 }}>
            <h3 className="run-panel-title">Run Backlink Processing</h3>
            <div className="muted run-panel-lead">
              There are currently <strong>{queuedCount}</strong> queued row(s). Running this will start automation and attempt direct submit.
            </div>
            <div className="run-metrics-grid">
              <span className="pill">Queued: {statusCounts.queued}</span>
              <span className="pill">Running: {statusCounts.running}</span>
              <span className="pill">Done: {statusCounts.success}</span>
              <span className="pill">Submitted: {statusCounts.submitted}</span>
              <span className="pill">Paused: {statusCounts.pending_verification + statusCounts.access_required + statusCounts.manual_access_required}</span>
              <span className="pill">Needs Mapping: {statusCounts.needs_manual_mapping}</span>
              <span className="pill">Skipped: {statusCounts.skipped}</span>
              <span className="pill">Failed: {statusCounts.failed + statusCounts.blocked}</span>
              <span className="pill">Stopped: {statusCounts.stopped}</span>
              <span className="pill">Processed: {processedCount}/{totalCount || 0}</span>
              <span className="pill">{progressPct}% complete</span>
            </div>
            <div className="run-progress-track">
              <div className="run-progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <div className="muted run-meta-line">
              Session: <strong>{runStatus.session_id || "-"}</strong> | Started at:{" "}
              <strong>{runStatus.started_at ? new Date(runStatus.started_at).toLocaleTimeString() : "-"}</strong> | Elapsed:{" "}
              <strong>{formatElapsed(runElapsedSeconds)}</strong> | Current row:{" "}
              <strong>{runStatus.current_row_id ? `#${runStatus.current_row_id}` : "-"}</strong>
            </div>
            <div className="muted run-state-line">
              {effectiveRunning ? `Running row: ${runStatus.current_row_id ? `#${runStatus.current_row_id}` : "starting..."}`
                : isStarting
                  ? "Starting run session..."
                  : "No active run session."}
            </div>
            <div className="muted run-note">
              Note: Actual profile/backlink creation only happens when the target is allowlisted, selectors are mapped, and any site-side verification or captcha is completed manually.
            </div>
            <div className="run-controls">
              <div className="run-buttons">
                <button onClick={runNow} disabled={effectiveRunning || isStarting || queuedCount === 0}>
                  {isStarting ? (
                    <span className="row" style={{ gap: 6 }}>
                      <span className="spinner" /> Starting...
                    </span>
                   ) : effectiveRunning ? "Running..." : queuedCount === 0 ? "No queued rows" : "Run Now"}
                </button>
                {effectiveRunning ? (
                  <button className="secondary" onClick={stopNow}>
                    Stop
                  </button>
                ) : null}
                <button className="secondary" onClick={load}>
                  Refresh
                </button>
              </div>
              <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <label className="run-headless-toggle">
                  <input type="checkbox" checked={headless} onChange={(e) => setHeadless(e.target.checked)} />
                  <span>Headless (hide browser window)</span>
                </label>
                <label className="run-headless-toggle">
                  <input
                    type="checkbox"
                    checked={notifyOnVerification}
                    onChange={(e) => setNotifyOnVerification(Boolean(e.target.checked))}
                  />
                  <span>Alert on verification needed</span>
                </label>
                <button
                  className="secondary"
                  onClick={() => notifyVerification([{ row_key: "test", output: { status_reason: "manual test" } }])}
                >
                  Test Alert
                </button>
                <button className="secondary" onClick={stopVerificationAlarm}>
                  Stop Voice Alarm
                </button>
              </div>
            </div>
            <div className="row" style={{ marginTop: 8, gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                style={{ minWidth: 340 }}
                value={voiceAlertText}
                onChange={(e) => setVoiceAlertText(e.target.value)}
                placeholder="Voice message"
              />
              <span className="pill">{voiceAlarmActive ? "Voice alarm active" : "Voice alarm idle"}</span>
            </div>
            {(effectiveRunning || isStarting) ? (
              <div className="row" style={{ marginTop: 8 }}>
                <span className="pill" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span className="spinner" /> Running
                </span>
              </div>
            ) : null}
          </div>

        </>
      ) : (
        <div className="row" style={{ marginTop: 12, marginBottom: 12 }}>
          <button className="secondary" onClick={load}>
            Refresh
          </button>
        </div>
      )}

      {showRunNow ? (
        <div className="card" style={{ marginTop: 12, marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Success Vault (Submitted Comment Links)</h3>
            <button className="secondary" onClick={() => loadSuccessVault()}>
              Refresh Vault
            </button>
          </div>
          <div className="muted" style={{ marginBottom: 10 }}>
            Successful submitted links auto-save here and also stay available in the main Success Vault page.
          </div>
          <div className="results-table-wrap">
            <table className="results-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Row</th>
                  <th>Directory URL</th>
                  <th>Target Link</th>
                  <th>Submitted Comment Link</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                {successVaultLoading ? (
                  <tr>
                    <td colSpan={6}>Loading success vault...</td>
                  </tr>
                ) : successVaultEntries.length ? (
                  successVaultEntries.slice(0, 15).map((entry, index) => {
                    const submittedLink = String(entry?.submitted_comment_link || entry?.created_link || "").trim();
                    const directory = String(entry?.site_url || entry?.site_name || "").trim();
                    return (
                      <tr key={`${entry?.run_id || "run"}-${entry?.row_key || "row"}-${index}`}>
                        <td>{safeText(entry?.timestamp)}</td>
                        <td>{safeText(entry?.row_key)}</td>
                        <td className="cell-url">
                          {directory ? (
                            <a href={directory} target="_blank" rel="noreferrer">{directory}</a>
                          ) : "-"}
                        </td>
                        <td className="cell-target">{safeText(entry?.target_link)}</td>
                        <td className="cell-url">
                          {submittedLink ? (
                            <a href={submittedLink} target="_blank" rel="noreferrer">{submittedLink}</a>
                          ) : "-"}
                        </td>
                        <td>{safeText(entry?.run_id)}</td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={6}>No successful submitted links yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {message ? <div className="card">{message}</div> : null}
      {error ? <div className="card" style={{ color: "#b91c1c" }}>{error}</div> : null}
      {loading ? (
        <div>Loading...</div>
      ) : (
        <div className="results-table-wrap">
          <table className="results-table">
            <thead>
              <tr>
                <th>Row</th>
                <th>Directory URL</th>
                <th>Target link(s)</th>
                <th>Status</th>
                <th>Reason</th>
                <th>Run</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {safeRows.map((row, index) => {
                const rowKey = safeText(row?.row_key, "");
                const screenshotUrl = getRowScreenshotUrl(row);
                const needsMapping = isNeedsMapping(row);
                const normalizedStatus = normalizeStatus(row?.output?.status || "queued");
                const directoryUrl = safeText(row?.input?.directory_url || row?.input?.site_url, "");
                return (
                  <tr key={safeText(row?.row_key, `row-${index}`)}>
                    <td className="cell-row">{safeText(row?.row_key)}</td>
                    <td className="cell-url">
                      {directoryUrl && directoryUrl !== "-" ? (
                        <a href={directoryUrl} target="_blank" rel="noreferrer">
                          {directoryUrl}
                        </a>
                      ) : (
                        safeText(row?.input?.directory_url || row?.input?.site_url)
                      )}
                    </td>
                    <td className="cell-target">
                      {safeText(Array.isArray(row?.input?.target_links) ? row.input.target_links.join(" | ") : row?.input?.target_link, "-")}
                    </td>
                    <td>
                      <span className={`pill status-pill ${statusToneClass(normalizedStatus)}`}>{safeText(row?.output?.status, "queued")}</span>
                    </td>
                    <td className="cell-reason">
                      <div>{safeText(row?.output?.status_reason)}</div>
                      {needsMapping ? (
                        <div className="muted" style={{ marginTop: 6, color: screenshotUrl ? undefined : "#b91c1c" }}>
                          {screenshotUrl ? "Selector mapping required. Use screenshot + logs to map fields." : "Artifacts missing: runner didn't save screenshot."}
                        </div>
                      ) : null}
                    </td>
                    <td className="cell-run">{safeText(row?.output?.run_id || row?.run_id)}</td>
                    <td>
                      <div className="action-stack">
                        <Link className="action-link" href={`/backlinks/rows/${rowKey}`}>Logs</Link>
                        {needsMapping && screenshotUrl ? (
                          <a className="action-link" href={screenshotUrl} target="_blank" rel="noreferrer">View Screenshot</a>
                        ) : null}
                        <button className="secondary" onClick={() => retryRow(row?.row_key)}>Retry</button>
                        {isAllowlistBlocked(row) ? (
                          <button onClick={() => addToAllowlist(row)}>Add to allowlist</button>
                        ) : null}
                        <button className="secondary" onClick={() => removeRow(row?.row_key)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

