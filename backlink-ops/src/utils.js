import fs from "node:fs";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

export function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return fallback;
  }
}

export function appendJsonl(filePath, event) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf8");
}

export function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [k, v] = raw.slice(2).split("=");
    out[k] = v ?? true;
  }
  return out;
}

export function colToLetter(colNum) {
  let col = Number(colNum);
  let out = "";
  while (col > 0) {
    const rem = (col - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    col = Math.floor((col - 1) / 26);
  }
  return out || "A";
}

