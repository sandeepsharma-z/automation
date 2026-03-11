$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$logsDir = Join-Path $repoRoot 'logs'
New-Item -ItemType Directory -Force -Path $logsDir | Out-Null

function Stop-ListeningPortProcess {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    try {
        $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        foreach ($listener in $listeners) {
            if ($listener.OwningProcess) {
                Stop-Process -Id $listener.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
        # Port cleanup is best-effort.
    }
}

function Start-RepoScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath,
        [Parameter(Mandatory = $true)]
        [string]$StdOutLog,
        [Parameter(Mandatory = $true)]
        [string]$StdErrLog
    )

    $fullScript = Join-Path $repoRoot $ScriptPath
    if (-not (Test-Path $fullScript)) {
        throw "Missing script: $fullScript"
    }

    $proc = Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $fullScript `
        -WorkingDirectory $repoRoot `
        -RedirectStandardOutput (Join-Path $logsDir $StdOutLog) `
        -RedirectStandardError (Join-Path $logsDir $StdErrLog) `
        -PassThru

    Write-Host "$Label started (PID $($proc.Id))"
    return $proc
}

function Start-NpmCommand {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory,
        [Parameter(Mandatory = $true)]
        [string]$StdOutLog,
        [Parameter(Mandatory = $true)]
        [string]$StdErrLog
    )

    if (-not (Test-Path $WorkingDirectory)) {
        throw "Missing directory: $WorkingDirectory"
    }

    $proc = Start-Process `
        -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-Command', 'npm run dev' `
        -WorkingDirectory $WorkingDirectory `
        -RedirectStandardOutput (Join-Path $logsDir $StdOutLog) `
        -RedirectStandardError (Join-Path $logsDir $StdErrLog) `
        -PassThru

    Write-Host "$Label started (PID $($proc.Id))"
    return $proc
}

function Wait-Http {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [int]$TimeoutSeconds = 90
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                Write-Host "$Label ready at $Url"
                return $true
            }
        }
        catch {
        }

        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    Write-Warning "$Label did not become ready within $TimeoutSeconds seconds: $Url"
    return $false
}

Set-Location $repoRoot

Stop-ListeningPortProcess -Port 8010
Stop-ListeningPortProcess -Port 3000
Stop-ListeningPortProcess -Port 3015

$apiProc = Start-RepoScript -Label 'API' -ScriptPath 'scripts/local_run_api.ps1' -StdOutLog 'api.out.log' -StdErrLog 'api.err.log'
Start-Sleep -Seconds 4
$workerProc = Start-RepoScript -Label 'Worker' -ScriptPath 'scripts/local_run_worker.ps1' -StdOutLog 'worker.out.log' -StdErrLog 'worker.err.log'
Start-Sleep -Seconds 4
$adminProc = Start-RepoScript -Label 'Admin' -ScriptPath 'scripts/local_run_admin.ps1' -StdOutLog 'admin.out.log' -StdErrLog 'admin.err.log'
Start-Sleep -Seconds 4
$backlinkProc = Start-NpmCommand -Label 'Backlink UI' -WorkingDirectory (Join-Path $repoRoot 'backlink-ops\ui') -StdOutLog 'backlink-ui.out.log' -StdErrLog 'backlink-ui.err.log'

$null = Wait-Http -Label 'API' -Url 'http://127.0.0.1:8010/healthz' -TimeoutSeconds 60
$null = Wait-Http -Label 'Admin' -Url 'http://127.0.0.1:3000' -TimeoutSeconds 120
$null = Wait-Http -Label 'Backlink UI' -Url 'http://127.0.0.1:3015' -TimeoutSeconds 120

Write-Host ''
Write-Host 'Endpoints:'
Write-Host 'API        http://127.0.0.1:8010/docs'
Write-Host 'Admin      http://127.0.0.1:3000'
Write-Host 'Backlink   http://127.0.0.1:3015'
Write-Host ''
Write-Host 'Logs:'
Write-Host (Join-Path $logsDir 'api.out.log')
Write-Host (Join-Path $logsDir 'worker.out.log')
Write-Host (Join-Path $logsDir 'admin.out.log')
Write-Host (Join-Path $logsDir 'backlink-ui.out.log')
