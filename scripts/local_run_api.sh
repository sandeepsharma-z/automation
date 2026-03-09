#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$REPO_ROOT/.venv"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "Missing .venv. Run ./scripts/local_setup.sh first."
  exit 1
fi

source "$VENV_DIR/bin/activate"

if [[ -f "$REPO_ROOT/.env" ]]; then
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

export PYTHONPATH="$REPO_ROOT:$REPO_ROOT/apps/api:$REPO_ROOT/apps/worker"
cd "$REPO_ROOT"
API_PORT="${API_PORT:-8000}"
python -m uvicorn apps.api.app.main:app --reload --port "$API_PORT"
