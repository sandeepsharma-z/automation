$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
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

$apiPort = $null
foreach ($candidate in @('8010', '8000', '8011', '8020')) {
    try {
        $ok = Invoke-WebRequest -Uri "http://localhost:$candidate/healthz" -UseBasicParsing -TimeoutSec 4 -ErrorAction Stop
        if ($ok.StatusCode -ge 200 -and $ok.StatusCode -lt 500) {
            $apiPort = $candidate
            break
        }
    }
    catch {
        # probe next candidate
    }
}
if (-not $apiPort) {
    $apiPort = '8010'
}
$env:NEXT_PUBLIC_API_URL = "http://localhost:$apiPort"
if ($apiPort -eq '8010') {
    $env:NEXT_PUBLIC_API_FALLBACK_URL = "http://localhost:8000"
}
else {
    $env:NEXT_PUBLIC_API_FALLBACK_URL = "http://localhost:8010"
}
Write-Host "Starting Admin with API URL $($env:NEXT_PUBLIC_API_URL)"

Push-Location (Join-Path $repoRoot 'apps/admin')
try {
    try {
        Get-CimInstance Win32_Process |
            Where-Object {
                $_.Name -eq 'node.exe' -and
                $_.CommandLine -match 'apps\\admin' -and
                $_.CommandLine -match 'next'
            } |
            ForEach-Object {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            }

        Start-Sleep -Milliseconds 700

        $conn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn -and $conn.OwningProcess) {
            Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }
    catch {
        # no-op
    }

    if (Test-Path '.next') {
        Remove-Item '.next' -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path 'node_modules/.cache') {
        Remove-Item 'node_modules/.cache' -Recurse -Force -ErrorAction SilentlyContinue
    }

    if (Test-Path 'package-lock.json') {
        npm ci
    }
    else {
        npm install
    }

    # Always run stable mode on Windows to avoid intermittent Next.js
    # dev chunk corruption errors (e.g. missing ./641.js in .next/server).
    npm run dev:stable
}
finally {
    Pop-Location
}
