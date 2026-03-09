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
            $existing = [System.Environment]::GetEnvironmentVariable($parts[0], 'Process')
            if ([string]::IsNullOrWhiteSpace($existing)) {
                [System.Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
            }
        }
    }
}

$env:PYTHONPATH = "$repoRoot;$repoRoot/apps/api;$repoRoot/apps/worker"
$apiPort = '8010'
[System.Environment]::SetEnvironmentVariable('API_PORT', $apiPort, 'Process')
Write-Host "Starting API on port $apiPort"

Push-Location $repoRoot
try {
    # Keep local schema aligned with current backend models before serving requests.
    Push-Location (Join-Path $repoRoot 'apps/api')
    try {
        & $venvPython -m alembic -c alembic.ini upgrade head
    }
    finally {
        Pop-Location
    }

    # Prevent split-brain API state by stopping any previous uvicorn process first.
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq 'python.exe' -and
            $_.CommandLine -match 'uvicorn' -and
            $_.CommandLine -match 'apps\.api\.app\.main:app'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 700

    $uvicornArgs = @('-m', 'uvicorn', 'apps.api.app.main:app', '--port', $apiPort)
    if (($env:API_RELOAD -and $env:API_RELOAD.Trim().ToLower() -eq 'true')) {
        $uvicornArgs += '--reload'
    }
    & $venvPython @uvicornArgs
}
finally {
    Pop-Location
}
