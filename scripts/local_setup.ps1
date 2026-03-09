$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$venvPath = Join-Path $repoRoot '.venv'
$venvPython = Join-Path $venvPath 'Scripts/python.exe'
$venvAlembic = Join-Path $venvPath 'Scripts/alembic.exe'
$envFile = Join-Path $repoRoot '.env'
$envExample = Join-Path $repoRoot '.env.example'

if (-not (Test-Path $envFile)) {
    Copy-Item $envExample $envFile
    Write-Host 'Created .env from .env.example'
}

if (-not (Test-Path $venvPython)) {
    python -m venv $venvPath
}

& $venvPython -m pip install --upgrade pip
& $venvPython -m pip install -r (Join-Path $repoRoot 'apps/api/requirements.txt')
& $venvPython -m pip install -r (Join-Path $repoRoot 'apps/worker/requirements.txt')
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
            $parts = $line.Split('=', 2)
            [System.Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
        }
    }
}

Push-Location (Join-Path $repoRoot 'apps/api')
try {
    & $venvAlembic -c alembic.ini upgrade head
}
finally {
    Pop-Location
}

Write-Host 'Local setup complete.'
Write-Host 'Run API:    ./scripts/local_run_api.ps1'
Write-Host 'Run Worker: ./scripts/local_run_worker.ps1'
Write-Host 'Run Admin:  ./scripts/local_run_admin.ps1'
