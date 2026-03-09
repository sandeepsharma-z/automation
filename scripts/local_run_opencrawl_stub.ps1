$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$venvPython = Join-Path $repoRoot '.venv/Scripts/python.exe'

if (-not (Test-Path $venvPython)) {
    throw 'Missing .venv. Run ./scripts/local_setup.ps1 first.'
}

Push-Location $repoRoot
try {
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq 'python.exe' -and
            $_.CommandLine -match 'uvicorn' -and
            $_.CommandLine -match 'scripts\.local_opencrawl_stub:app'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 500
    & $venvPython -m uvicorn scripts.local_opencrawl_stub:app --host 127.0.0.1 --port 11235
}
finally {
    Pop-Location
}

