#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/infra/docker-compose.yml"

MYSQL_USER="${MYSQL_USER:-contentops}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-contentops}"
MYSQL_DB="${MYSQL_DB:-contentops}"

run_sql() {
  local sql="$1"
  docker compose -f "$COMPOSE_FILE" exec -T mysql \
    mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -e "$sql"
}

show_help() {
  cat <<EOF
Usage: ./scripts/mysql_cli.sh <command>

Commands:
  shell      Open interactive mysql shell in container
  showdb     Show databases
  tables     Use configured DB and show tables
  describe   Describe each table in configured DB
  rowcounts  Show row counts for core tables
  tail       Show latest rows from pipeline_events, pipeline_runs, drafts, publish_records
  all        Run showdb, tables, describe, rowcounts, tail
  help       Show this help

Defaults:
  MYSQL_USER=$MYSQL_USER
  MYSQL_DB=$MYSQL_DB
EOF
}

describe_all() {
  local tables
  tables=$(docker compose -f "$COMPOSE_FILE" exec -T mysql \
    mysql -N -B -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" -e "USE \`$MYSQL_DB\`; SHOW TABLES;")

  if [[ -z "${tables// }" ]]; then
    echo "No tables found in database '$MYSQL_DB'."
    return 0
  fi

  while IFS= read -r table; do
    [[ -z "$table" ]] && continue
    echo
    echo "=== DESCRIBE $table ==="
    run_sql "USE \`$MYSQL_DB\`; DESCRIBE \`$table\`;"
  done <<< "$tables"
}

show_row_counts() {
  run_sql "USE \`$MYSQL_DB\`;
SELECT 'projects' AS table_name, COUNT(*) AS row_count FROM projects
UNION ALL SELECT 'content_library_items', COUNT(*) FROM content_library_items
UNION ALL SELECT 'topics', COUNT(*) FROM topics
UNION ALL SELECT 'pipeline_runs', COUNT(*) FROM pipeline_runs
UNION ALL SELECT 'pipeline_events', COUNT(*) FROM pipeline_events
UNION ALL SELECT 'drafts', COUNT(*) FROM drafts
UNION ALL SELECT 'publish_records', COUNT(*) FROM publish_records
UNION ALL SELECT 'content_patterns', COUNT(*) FROM content_patterns
ORDER BY table_name;"
}

tail_latest() {
  run_sql "USE \`$MYSQL_DB\`;
SELECT * FROM pipeline_events ORDER BY id DESC LIMIT 10;
SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT 10;
SELECT * FROM drafts ORDER BY id DESC LIMIT 10;
SELECT * FROM publish_records ORDER BY id DESC LIMIT 10;"
}

command="${1:-help}"

case "$command" in
  shell)
    docker compose -f "$COMPOSE_FILE" exec mysql \
      mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD"
    ;;
  showdb)
    run_sql "SHOW DATABASES;"
    ;;
  tables)
    run_sql "USE \`$MYSQL_DB\`; SHOW TABLES;"
    ;;
  describe)
    describe_all
    ;;
  rowcounts)
    show_row_counts
    ;;
  tail)
    tail_latest
    ;;
  all)
    run_sql "SHOW DATABASES;"
    run_sql "USE \`$MYSQL_DB\`; SHOW TABLES;"
    describe_all
    show_row_counts
    tail_latest
    ;;
  help|--help|-h)
    show_help
    ;;
  *)
    echo "Unknown command: $command"
    show_help
    exit 1
    ;;
esac
