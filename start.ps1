# ============================================================
# WFM Control-M - Start All Services
# Usage: Right-click -> Run with PowerShell, or from terminal:
#   .\start.ps1           — start both backend + frontend
#   .\start.ps1 backend   — start backend only
#   .\start.ps1 frontend  — start frontend only
#   .\start.ps1 stop      — kill all node processes
# ============================================================

param(
    [string]$Mode = "all"
)

Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $Root "backend"
$Frontend = Join-Path $Root "frontend"

function Start-Backend {
    Write-Host "`n[WFM] Starting backend on http://localhost:4000 ..." -ForegroundColor Cyan
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "`$env:SSH_CREDENTIALS_FILE = '$Root\.saved_credentials.json'; Set-Location '$Backend'; node node_modules\ts-node-dev\lib\bin.js --respawn --transpile-only src/index.ts" -WindowStyle Normal
}

function Start-Frontend {
    Write-Host "[WFM] Starting frontend on http://localhost:3000 ..." -ForegroundColor Green
    Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "Set-Location '$Frontend'; node node_modules\vite\bin\vite.js --port 3000" -WindowStyle Normal
}

function Stop-All {
    Write-Host "[WFM] Stopping all node processes..." -ForegroundColor Yellow
    Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force
    Write-Host "[WFM] All services stopped." -ForegroundColor Yellow
}

switch ($Mode.ToLower()) {
    "backend"  { Start-Backend }
    "frontend" { Start-Frontend }
    "stop"     { Stop-All }
    default {
        Start-Backend
        Start-Sleep -Seconds 3
        Start-Frontend
        Write-Host "`n[WFM] All services starting!" -ForegroundColor Magenta
        Write-Host "  Backend:  http://localhost:4000" -ForegroundColor Cyan
        Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Green
        Write-Host "  Run '.\start.ps1 stop' to shut down.`n" -ForegroundColor Gray
    }
}
