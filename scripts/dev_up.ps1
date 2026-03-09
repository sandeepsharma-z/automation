$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$envFile = Join-Path $repoRoot '.env'
$envExample = Join-Path $repoRoot '.env.example'

if (-not (Test-Path $envFile)) {
    Copy-Item $envExample $envFile
    Write-Host 'Created .env from .env.example'
}

Push-Location (Join-Path $repoRoot 'infra')
try {
    docker compose up --build -d

    Write-Host ''
    Write-Host 'API docs: http://localhost:8000/docs'
    Write-Host 'Admin:    http://localhost:3000'
    Write-Host ''

    docker compose ps
}
finally {
    Pop-Location
}
