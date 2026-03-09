#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VENV_DIR="$REPO_ROOT/.venv"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE="$REPO_ROOT/.env.example"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE" "$ENV_FILE"
  echo "Created .env from .env.example"
fi

if [[ ! -d "$VENV_DIR" ]]; then
  python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
python -m pip install --upgrade pip
python -m pip install -r "$REPO_ROOT/apps/api/requirements.txt"
python -m pip install -r "$REPO_ROOT/apps/worker/requirements.txt"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

(
  cd "$REPO_ROOT/apps/api"
  "$VENV_DIR/bin/alembic" -c alembic.ini upgrade head
)

echo "Local setup complete."
echo "Run API:    ./scripts/local_run_api.sh"
echo "Run Worker: ./scripts/local_run_worker.sh"
echo "Run Admin:  ./scripts/local_run_admin.sh"
