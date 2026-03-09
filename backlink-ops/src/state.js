import fs from "node:fs";
import path from "node:path";
import { readJson } from "./utils.js";

export function getRunsRoot(projectRoot) {
  return path.join(projectRoot, "runs");
}

export function listRunIds(projectRoot) {
  const runsRoot = getRunsRoot(projectRoot);
  if (!fs.existsSync(runsRoot)) return [];
  return fs
    .readdirSync(runsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => (a > b ? -1 : 1));
}

function listRowArtifactsForRun(projectRoot, runId) {
  const runDir = path.join(getRunsRoot(projectRoot), runId);
  if (!fs.existsSync(runDir)) return [];
  const siteDirs = fs.readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const rows = [];
  for (const sd of siteDirs) {
    const rowPath = path.join(runDir, sd.name, "row.json");
    if (fs.existsSync(rowPath)) {
      const row = readJson(rowPath, null);
      if (row) rows.push({ ...row, run_id: runId, site_slug: sd.name, row_path: rowPath });
    }
  }
  return rows;
}

export function listRows(projectRoot, { statusIn = [] } = {}) {
  const runIds = listRunIds(projectRoot);
  const latestByRowKey = new Map();

  for (const runId of runIds) {
    const rows = listRowArtifactsForRun(projectRoot, runId);
    for (const row of rows) {
      const key = String(row.row_key || "");
      if (!key) continue;
      if (!latestByRowKey.has(key)) {
        latestByRowKey.set(key, row);
      }
    }
  }

  let list = [...latestByRowKey.values()];
  if (statusIn.length) {
    const wanted = new Set(statusIn.map((s) => String(s).toLowerCase()));
    list = list.filter((r) => wanted.has(String(r.output?.status || "").toLowerCase()));
  }
  return list.sort((a, b) => String(b.output?.started_at || "").localeCompare(String(a.output?.started_at || "")));
}

export function listRunsSummary(projectRoot) {
  const runIds = listRunIds(projectRoot);
  return runIds.map((runId) => {
    const rows = listRowArtifactsForRun(projectRoot, runId);
    const counts = rows.reduce((acc, r) => {
      const status = String(r.output?.status || "unknown");
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    const targetCounts = rows.reduce((acc, r) => {
      const results = Array.isArray(r.output?.results) ? r.output.results : [];
      acc.total = (acc.total || 0) + results.length;
      for (const item of results) {
        const status = String(item?.status || "unknown");
        acc[status] = (acc[status] || 0) + 1;
      }
      return acc;
    }, { total: 0 });
    return {
      run_id: runId,
      total: rows.length,
      counts,
      target_counts: targetCounts,
    };
  });
}

export function getRunEvents(projectRoot, runId) {
  const eventsPath = path.join(getRunsRoot(projectRoot), runId, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
  return lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (_) {
      return null;
    }
  }).filter(Boolean);
}

export function getRowDetail(projectRoot, rowKey) {
  const rows = listRows(projectRoot);
  const row = rows.find((r) => String(r.row_key) === String(rowKey));
  if (!row) return null;

  const events = getRunEvents(projectRoot, row.run_id).filter((e) => String(e.row_key || "") === String(rowKey));
  const siteDir = path.join(getRunsRoot(projectRoot), row.run_id, row.site_slug);
  const artifacts = {
    screenshots: fs.existsSync(siteDir)
      ? fs.readdirSync(siteDir).filter((name) => /^pre_submit(_\d+)?\.png$/i.test(name))
      : [],
    html_files: fs.existsSync(siteDir)
      ? fs.readdirSync(siteDir).filter((name) => /^pre_submit(_\d+)?\.html$/i.test(name))
      : [],
    approval_request: readJson(path.join(siteDir, "approval_request.json"), null),
    approval_decision: readJson(path.join(siteDir, "approval_decision.json"), null),
  };

  return { ...row, events, artifacts };
}
