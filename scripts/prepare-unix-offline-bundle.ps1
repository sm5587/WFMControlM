# Windows / PowerShell offline bundle builder.
# On WSL or Linux, use the bash equivalent instead:
#   bash ./scripts/prepare-unix-offline-bundle.sh

param(
    [string]$OutputZip = "",
    [switch]$SkipInstall,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Log([string]$Message) {
    Write-Host "[offline-bundle] $Message" -ForegroundColor Cyan
}

function RunStep([string]$Name, [scriptblock]$Action) {
    Log $Name
    & $Action
    if ($LASTEXITCODE -ne 0) {
        throw "Step failed: $Name (exit code $LASTEXITCODE)"
    }
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RepoName = Split-Path $RepoRoot -Leaf
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$DefaultOutDir = "C:\Temp"

if ([string]::IsNullOrWhiteSpace($OutputZip)) {
    if (-not (Test-Path $DefaultOutDir)) {
        New-Item -ItemType Directory -Path $DefaultOutDir -Force | Out-Null
    }
    $OutputZip = Join-Path $DefaultOutDir "$RepoName-unix-offline-bundle-$Stamp.zip"
}
$OutputZip = [System.IO.Path]::GetFullPath($OutputZip)

Log "Repo root: $RepoRoot"
Log "Output zip: $OutputZip"

Push-Location $RepoRoot
try {
    if (-not $SkipInstall) {
        RunStep "Installing dependencies (root/backend/frontend)" {
            npm run install:all
        }
    } else {
        Log "Skipping dependency install (-SkipInstall)"
    }

    if (-not $SkipBuild) {
        RunStep "Building backend/frontend artifacts" {
            npm run build
        }
    } else {
        Log "Skipping build (-SkipBuild)"
    }

    if (Test-Path $OutputZip) {
        Log "Removing existing zip at $OutputZip"
        Remove-Item $OutputZip -Force
    }

    $stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wfm-offline-bundle-" + [guid]::NewGuid().ToString("N"))
    $stagingRepo = Join-Path $stagingRoot $RepoName
    New-Item -ItemType Directory -Path $stagingRepo -Force | Out-Null

    # For offline bundle, include node_modules + dist outputs.
    # Exclude only machine-local/secrets/noise.
    $excludedPathFragments = @(
        "\.git\",
        "\.cursor\",
        "\deprecated\",
        "\coverage\",
        "\.nyc_output\",
        "\backend\prisma\dev.db",
        "\backend\combined.log",
        "\backend\error.log",
        "\frontend\combined.log",
        "\frontend\error.log"
    )
    $excludedFilePatterns = @(
        "*.log",
        "*.tmp",
        "*.swp",
        ".DS_Store",
        ".saved_credentials.json",
        ".env"
    )

    function Test-IsExcluded([string]$fullPath) {
        $normalized = $fullPath.ToLowerInvariant().Replace("/", "\")
        foreach ($frag in $excludedPathFragments) {
            if ($normalized.Contains($frag.ToLowerInvariant())) { return $true }
        }
        $name = Split-Path $fullPath -Leaf
        foreach ($pat in $excludedFilePatterns) {
            if ($name -like $pat) { return $true }
        }
        return $false
    }

    Log "Collecting files for offline bundle (this can take a while)..."
    $files = Get-ChildItem -Path $RepoRoot -Recurse -File -Force
    $copied = 0
    foreach ($f in $files) {
        if (Test-IsExcluded $f.FullName) { continue }
        $relative = $f.FullName.Substring($RepoRoot.Length).TrimStart("\")
        $target = Join-Path $stagingRepo $relative
        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
        }
        Copy-Item -Path $f.FullName -Destination $target -Force
        $copied++
    }

    # Add a deploy note into bundle root for operators
    $notePath = Join-Path $stagingRepo "OFFLINE_DEPLOY_README.txt"
    @"
WFM Control-M Offline Bundle
Generated: $((Get-Date).ToString("s"))

What is included:
- Source code
- node_modules (root/backend/frontend)
- Build artifacts (backend/dist, frontend/dist)
- Deploy scripts under scripts/

What is intentionally excluded:
- .env (create from .env.example on target)
- Local SQLite DB (backend/prisma/dev.db)
- Logs and machine-local cache files

Suggested target steps:
1) Unzip on Unix host under your app path (e.g. /application/wfmwatch)
2) cp .env.example .env and set DATABASE_URL + CONFIG_ENCRYPTION_KEY
3) Run preflight:
   APP_DIR=<path> ./scripts/preflight-unix.sh
4) Run deploy:
   APP_DIR=<path> BOOTSTRAP_DB=true INSTALL_DEPS=false BUILD_APP=false ./scripts/deploy-unix.sh
"@ | Set-Content -Path $notePath -Encoding UTF8

    Log "Compressing bundle..."
    Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $OutputZip -CompressionLevel Optimal

    $sizeMB = [math]::Round((Get-Item $OutputZip).Length / 1MB, 2)
    Log "Offline bundle ready: $OutputZip ($sizeMB MB)"
}
finally {
    Pop-Location
}

