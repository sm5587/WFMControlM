# ============================================================
# WFM Control-M - Scriptable Startup
# Usage:
#   .\start.ps1                     # daily dev: start backend + frontend only (DB unchanged)
#   .\start.ps1 all|start           # same as default - start services only
#   .\start.ps1 prepare             # first-time / prod: install, migrate, DDL/DML bootstrap
#   .\start.ps1 up                  # prepare + start (fresh machine or after schema change)
#   .\start.ps1 backend|frontend    # start one service
#   .\start.ps1 stop                # kill all node processes
#
# Flags:
#   -SkipInstall   skip npm install steps during prepare/up
#   -SkipDb        skip Prisma/DDL/DML steps during prepare/up
#   -Build         run npm run build during prepare/up
#   -LdapDevMock   simulate LDAP login locally (default: on). Use -LdapDevMock:$false when AD is reachable.
# ============================================================

param(
    [string]$Mode = "all",
    [switch]$SkipInstall,
    [switch]$SkipDb,
    [switch]$Build,
    [switch]$LdapDevMock = $true
)

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    Write-Host "`n[WFM] $Name" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Name (exit code $LASTEXITCODE)"
    }
}

function Initialize-Environment {
    if (-not $SkipInstall) {
        Invoke-Step "Installing root/backend/frontend dependencies" {
            Push-Location $Root
            try {
                npm run install:all
            }
            finally {
                Pop-Location
            }
        }
    }

    if (-not $SkipDb) {
        Invoke-Step "Generating Prisma client" {
            Push-Location $Backend
            try {
                npm run prisma:generate
            }
            finally {
                Pop-Location
            }
        }

        Invoke-Step "Applying Prisma migrations (deploy)" {
            Push-Location $Backend
            try {
                node node_modules\prisma\build\index.js migrate deploy
            }
            finally {
                Pop-Location
            }
        }

        Invoke-Step "Applying database DDL bootstrap" {
            Push-Location $Backend
            try {
                node scripts\apply-sql.js ..\database\ddl.sql
            }
            finally {
                Pop-Location
            }
        }

        Invoke-Step "Applying database DML bootstrap" {
            Push-Location $Backend
            try {
                node scripts\apply-sql.js ..\database\dml.sql
            }
            finally {
                Pop-Location
            }
        }
    }

    if ($Build) {
        Invoke-Step "Building backend and frontend" {
            Push-Location $Root
            try {
                npm run build
            }
            finally {
                Pop-Location
            }
        }
    }

    Write-Host "`n[WFM] Prepare complete." -ForegroundColor Green
}

function Start-DevShell {
    param(
        [string]$WorkingDir,
        [string[]]$EnvLines = @(),
        [string]$RunCommand
    )

    $escapedDir = $WorkingDir.Replace("'", "''")
    $script = "Set-Location -LiteralPath '$escapedDir'`n"
    if ($EnvLines.Count -gt 0) {
        $script += ($EnvLines -join "`n") + "`n"
    }
    $script += $RunCommand

    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $encoded -WindowStyle Normal
}

function Start-Backend {
    if ($LdapDevMock) {
        Write-Host "[WFM] LDAP dev mock enabled - any username/password accepted as AD login" -ForegroundColor Yellow
    }
    Write-Host "`n[WFM] Starting backend on http://localhost:4005 (Local) ..." -ForegroundColor Cyan

    $envLines = @(
        "`$env:SSH_CREDENTIALS_FILE = '$($Root.Replace("'", "''"))\.saved_credentials.json'",
        "`$env:DEPLOYMENT_LABEL = 'Local'"
    )
    if ($LdapDevMock) {
        $envLines += "`$env:LDAP_DEV_MOCK = 'true'"
    }

    Start-DevShell -WorkingDir $Backend -EnvLines $envLines -RunCommand "npm run dev"
}

function Start-Frontend {
    # Pre-warm all source files so OneDrive downloads them before Vite reads them
    Write-Host "[WFM] Pre-warming frontend source files (OneDrive sync)..." -ForegroundColor Gray
    Get-ChildItem -Path "$Frontend\src" -Recurse -Include "*.tsx","*.ts","*.css","*.json" -ErrorAction SilentlyContinue | ForEach-Object {
        try { $stream = [System.IO.File]::OpenRead($_.FullName); $stream.Close() } catch {}
    }
    Write-Host "[WFM] Starting frontend on http://localhost:3005 ..." -ForegroundColor Green
    Start-DevShell -WorkingDir $Frontend -RunCommand "npm start -- --port 3005"
}

function Stop-All {
    Write-Host "[WFM] Stopping all node processes..." -ForegroundColor Yellow
    Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "[WFM] All services stopped." -ForegroundColor Yellow
}

function Start-All {
    Start-Backend
    Start-Frontend
    Write-Host "`n[WFM] All services starting!" -ForegroundColor Magenta
    Write-Host "  Backend:  http://localhost:4005  (Local)" -ForegroundColor Cyan
    Write-Host "  Frontend: http://localhost:3005  (Local)" -ForegroundColor Green
    Write-Host "  Docker:   http://localhost:3015  (use when compose is running)" -ForegroundColor DarkGray
    Write-Host "  Run '.\start.ps1 stop' to shut down.`n" -ForegroundColor Gray
}

try {
    switch ($Mode.ToLower()) {
        "prepare"  { Initialize-Environment }
        "up"       { Initialize-Environment; Start-All }
        "start"    { Start-All }   # alias for daily start - use "up" for DDL/DML bootstrap
        "backend"  { Start-Backend }
        "frontend" { Start-Frontend }
        "stop"     { Stop-All }
        default     { Start-All }
    }
}
catch {
    Write-Host "`n[WFM] ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
