# ============================================================
# WFM Control-M - Scriptable Startup
# Usage:
#   .\start.ps1 all                 # start backend + frontend
#   .\start.ps1 prepare             # install, migrate, apply DDL/DML, optional build
#   .\start.ps1 up                  # prepare + start all
#   .\start.ps1 backend|frontend    # start one service
#   .\start.ps1 stop                # kill all node processes
#
# Flags:
#   -SkipInstall   skip npm install steps during prepare/up
#   -SkipDb        skip Prisma/DDL/DML steps during prepare/up
#   -Build         run npm run build during prepare/up
# ============================================================

param(
    [string]$Mode = "all",
    [switch]$SkipInstall,
    [switch]$SkipDb,
    [switch]$Build
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

function Start-Backend {
    Write-Host "`n[WFM] Starting backend on http://localhost:4000 ..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "`$env:SSH_CREDENTIALS_FILE = '$Root\.saved_credentials.json'; Set-Location '$Backend'; node node_modules\ts-node-dev\lib\bin.js --respawn --transpile-only src/index.ts" -WindowStyle Normal
}

function Start-Frontend {
    # Pre-warm all source files so OneDrive downloads them before Vite reads them
    Write-Host "[WFM] Pre-warming frontend source files (OneDrive sync)..." -ForegroundColor Gray
    Get-ChildItem -Path "$Frontend\src" -Recurse -Include "*.tsx","*.ts","*.css","*.json" -ErrorAction SilentlyContinue | ForEach-Object {
        try { $stream = [System.IO.File]::OpenRead($_.FullName); $stream.Close() } catch {}
    }
    Write-Host "[WFM] Starting frontend on http://localhost:3000 ..." -ForegroundColor Green
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Frontend'; node node_modules\vite\bin\vite.js --port 3000" -WindowStyle Normal
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
    Write-Host "  Backend:  http://localhost:4000" -ForegroundColor Cyan
    Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Green
    Write-Host "  Run '.\start.ps1 stop' to shut down.`n" -ForegroundColor Gray
}

try {
    switch ($Mode.ToLower()) {
        "prepare"  { Initialize-Environment }
        "up"       { Initialize-Environment; Start-All }
        "start"    { Initialize-Environment; Start-All }
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
