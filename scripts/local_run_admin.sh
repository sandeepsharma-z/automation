#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

cd "$REPO_ROOT/apps/admin"

pkill -f "apps/admin.*next" >/dev/null 2>&1 || true

if command -v lsof >/dev/null 2>&1; then
  PID_ON_3000="$(lsof -ti :3000 || true)"
if [[ -n "${PID_ON_3000}" ]]; then
    kill -9 "${PID_ON_3000}" || true
  fi
fi

if [[ -d ".next" ]]; then
  rm -rf .next || true
fi

if [[ -d "node_modules/.cache" ]]; then
  rm -rf node_modules/.cache || true
fi

if [[ -f "package-lock.json" ]]; then
  npm ci
else
  npm install
fi

MODE="${ADMIN_MODE:-stable}"
if [[ "$MODE" == "dev" ]]; then
  npm run dev
else
  npm run dev:stable
fi
