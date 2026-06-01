# fix-onedrive-node-modules.ps1
# ─────────────────────────────────────────────────────────────────────────────
# Fixes the OneDrive "cloud-only" file issue for node_modules.
#
# When a node project lives inside an OneDrive folder, OneDrive marks rarely-
# used files (e.g. jest/devDependency binaries) as cloud-only (O attribute).
# Node.js cannot read cloud-only files and hangs/crashes with "UNKNOWN: read".
#
# This script creates a JUNCTION (directory symlink) so node_modules lives
# OUTSIDE OneDrive (in C:\dev-cache\) while the project folder remains on
# OneDrive. Node.js reads modules at full local speed; OneDrive ignores
# junction targets automatically.
#
# RUN ONCE. Safe to re-run (idempotent). Requires no Admin rights for junctions
# on the same drive.
# ─────────────────────────────────────────────────────────────────────────────

$ProjectDir   = "C:\Users\SM5587\OneDrive - Zebra Technologies\Daily_Work\WFMControlM\backend"
$LocalCache   = "C:\dev-cache\WFMControlM-node-modules"
$JunctionPath = Join-Path $ProjectDir "node_modules"

Write-Host "=== OneDrive node_modules junction fix ===" -ForegroundColor Cyan

# ── Step 1: Create local cache dir ──────────────────────────────────────────
if (-not (Test-Path $LocalCache)) {
    New-Item -ItemType Directory -Path $LocalCache -Force | Out-Null
    Write-Host "✓ Created local cache: $LocalCache" -ForegroundColor Green
} else {
    Write-Host "  Local cache already exists: $LocalCache"
}

# ── Step 2: Check current state of node_modules ─────────────────────────────
$item = Get-Item $JunctionPath -ErrorAction SilentlyContinue

if ($item -and $item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    Write-Host "  node_modules is already a junction — no changes needed." -ForegroundColor Green
    exit 0
}

# ── Step 3: Copy node_modules to local cache (if not already there) ─────────
$existingCount = (Get-ChildItem -Path $LocalCache -Force -ErrorAction SilentlyContinue).Count
if ($existingCount -eq 0) {
    Write-Host "Copying node_modules to local cache (this may take several minutes)..." -ForegroundColor Yellow
    $src = $JunctionPath
    $dst = $LocalCache
    # Use robocopy for reliable large-tree copy (retries OneDrive-locked files)
    robocopy $src $dst /E /NP /R:2 /W:2 /LOG:NUL | Out-Null
    Write-Host "✓ Copy complete" -ForegroundColor Green
} else {
    Write-Host "  Local cache is non-empty ($existingCount items), skipping copy."
}

# ── Step 4: Remove the original node_modules ────────────────────────────────
Write-Host "Removing OneDrive node_modules folder..." -ForegroundColor Yellow
Remove-Item -Path $JunctionPath -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "✓ Removed" -ForegroundColor Green

# ── Step 5: Create junction ──────────────────────────────────────────────────
cmd.exe /C "mklink /J `"$JunctionPath`" `"$LocalCache`"" | Out-Null
if (Test-Path $JunctionPath) {
    Write-Host "✓ Junction created: $JunctionPath  →  $LocalCache" -ForegroundColor Green
} else {
    Write-Host "✗ Failed to create junction. Try running as administrator." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "All done! node_modules now lives outside OneDrive." -ForegroundColor Cyan
Write-Host "Run your tests with:"
Write-Host "  cd `"$ProjectDir`"; npm test -- --runInBand --no-coverage --forceExit" -ForegroundColor White
