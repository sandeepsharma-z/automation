#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$REPO_ROOT/.env" ]]; then
  cp "$REPO_ROOT/.env.example" "$REPO_ROOT/.env"
  echo "Created .env from .env.example"
fi

cd "$REPO_ROOT/infra"
docker compose up --build -d

echo
echo "API docs: http://localhost:8000/docs"
echo "Admin:    http://localhost:3000"
echo
docker compose ps
