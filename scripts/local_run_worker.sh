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

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL must be set in .env"
  exit 1
fi

if [[ -n "${CELERY_BROKER_URL:-}" ]]; then
  BROKER="$CELERY_BROKER_URL"
elif [[ -n "${REDIS_URL:-}" ]]; then
  BROKER="$REDIS_URL"
else
  BROKER="sqla+${DATABASE_URL}"
fi

if [[ -n "${CELERY_RESULT_BACKEND:-}" ]]; then
  BACKEND="$CELERY_RESULT_BACKEND"
elif [[ -n "${REDIS_URL:-}" ]]; then
  BACKEND="$REDIS_URL"
else
  BACKEND="db+${DATABASE_URL}"
fi

export CELERY_BROKER_URL="$BROKER"
export CELERY_RESULT_BACKEND="$BACKEND"
export PYTHONPATH="$REPO_ROOT:$REPO_ROOT/apps/api:$REPO_ROOT/apps/worker"

echo "Broker:  $BROKER"
echo "Backend: $BACKEND"

cd "$REPO_ROOT"
python -m celery -A apps.worker.app.celery_app.celery_app worker --loglevel=INFO --pool=solo
