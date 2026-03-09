param(
    [ValidateSet('shell','showdb','tables','describe','rowcounts','tail','all','help')]
    [string]$Command = 'help'
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$composeFile = Join-Path $repoRoot 'infra/docker-compose.yml'

$mysqlUser = if ($env:MYSQL_USER) { $env:MYSQL_USER } else { 'contentops' }
$mysqlPassword = if ($env:MYSQL_PASSWORD) { $env:MYSQL_PASSWORD } else { 'contentops' }
$mysqlDb = if ($env:MYSQL_DB) { $env:MYSQL_DB } else { 'contentops' }

function Invoke-Sql {
    param([string]$Sql)

    docker compose -f $composeFile exec -T mysql mysql -u$mysqlUser -p$mysqlPassword -e $Sql
}

function Show-Help {
@"
Usage: ./scripts/mysql_cli.ps1 -Command <command>

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
  MYSQL_USER=$mysqlUser
  MYSQL_DB=$mysqlDb
"@ | Write-Host
}

function Describe-All {
    $tables = docker compose -f $composeFile exec -T mysql mysql -N -B -u$mysqlUser -p$mysqlPassword -e "USE ``$mysqlDb``; SHOW TABLES;"

    if (-not $tables) {
        Write-Host "No tables found in database '$mysqlDb'."
        return
    }

    foreach ($table in ($tables -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })) {
        Write-Host ""
        Write-Host "=== DESCRIBE $table ==="
        Invoke-Sql "USE ``$mysqlDb``; DESCRIBE ``$table``;"
    }
}

function Show-RowCounts {
    Invoke-Sql @"
USE ``$mysqlDb``;
SELECT 'projects' AS table_name, COUNT(*) AS row_count FROM projects
UNION ALL SELECT 'content_library_items', COUNT(*) FROM content_library_items
UNION ALL SELECT 'topics', COUNT(*) FROM topics
UNION ALL SELECT 'pipeline_runs', COUNT(*) FROM pipeline_runs
UNION ALL SELECT 'pipeline_events', COUNT(*) FROM pipeline_events
UNION ALL SELECT 'drafts', COUNT(*) FROM drafts
UNION ALL SELECT 'publish_records', COUNT(*) FROM publish_records
UNION ALL SELECT 'content_patterns', COUNT(*) FROM content_patterns
ORDER BY table_name;
"@
}

function Show-Tail {
    Invoke-Sql @"
USE ``$mysqlDb``;
SELECT * FROM pipeline_events ORDER BY id DESC LIMIT 10;
SELECT * FROM pipeline_runs ORDER BY id DESC LIMIT 10;
SELECT * FROM drafts ORDER BY id DESC LIMIT 10;
SELECT * FROM publish_records ORDER BY id DESC LIMIT 10;
"@
}

switch ($Command) {
    'shell' {
        docker compose -f $composeFile exec mysql mysql -u$mysqlUser -p$mysqlPassword
    }
    'showdb' {
        Invoke-Sql 'SHOW DATABASES;'
    }
    'tables' {
        Invoke-Sql "USE ``$mysqlDb``; SHOW TABLES;"
    }
    'describe' {
        Describe-All
    }
    'rowcounts' {
        Show-RowCounts
    }
    'tail' {
        Show-Tail
    }
    'all' {
        Invoke-Sql 'SHOW DATABASES;'
        Invoke-Sql "USE ``$mysqlDb``; SHOW TABLES;"
        Describe-All
        Show-RowCounts
        Show-Tail
    }
    default {
        Show-Help
    }
}
