$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$venvPython = Join-Path $repoRoot '.venv/Scripts/python.exe'

if (-not (Test-Path $venvPython)) {
    throw 'Missing .venv. Run ./scripts/local_setup.ps1 first.'
}

$envFile = Join-Path $repoRoot '.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $parts = $line.Split('=', 2)
            [System.Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
        }
    }
}

$databaseUrl = $env:DATABASE_URL
if (-not $databaseUrl) {
    throw 'DATABASE_URL must be set in .env'
}

if ($env:CELERY_BROKER_URL) {
    $broker = $env:CELERY_BROKER_URL
} elseif ($env:REDIS_URL) {
    $broker = $env:REDIS_URL
} else {
    $broker = "sqla+$databaseUrl"
}

if ($env:CELERY_RESULT_BACKEND) {
    $backend = $env:CELERY_RESULT_BACKEND
} elseif ($env:REDIS_URL) {
    $backend = $env:REDIS_URL
} else {
    $backend = "db+$databaseUrl"
}

$env:CELERY_BROKER_URL = $broker
$env:CELERY_RESULT_BACKEND = $backend
$env:PYTHONPATH = "$repoRoot;$repoRoot/apps/api;$repoRoot/apps/worker"
$workerQueues = if ($env:CELERY_WORKER_QUEUES -and $env:CELERY_WORKER_QUEUES.Trim()) { $env:CELERY_WORKER_QUEUES.Trim() } else { 'celery' }
$env:CELERY_WORKER_QUEUES = $workerQueues

Write-Host "Broker:  $broker"
Write-Host "Backend: $backend"
Write-Host "Queues:  $workerQueues"

Push-Location $repoRoot
try {
    # Ensure only one worker is active to avoid duplicate task claims/status races.
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq 'python.exe' -and
            $_.CommandLine -match 'celery' -and
            $_.CommandLine -match 'apps\.worker\.app\.celery_app\.celery_app'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 700

    & $venvPython -m celery -A apps.worker.app.celery_app.celery_app worker --loglevel=INFO --pool=solo -Q $workerQueues
}
finally {
    Pop-Location
}
