param(
    [string]$OutputZip = "",
    [switch]$IncludeDocs
)

$ErrorActionPreference = "Stop"

function Log($msg) {
    Write-Host "[bundle] $msg" -ForegroundColor Cyan
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$RepoName = Split-Path $RepoRoot -Leaf

if ([string]::IsNullOrWhiteSpace($OutputZip)) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $OutputZip = Join-Path $RepoRoot "$RepoName-unix-bundle-$stamp.zip"
}

$OutputZip = [System.IO.Path]::GetFullPath($OutputZip)
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("wfm-bundle-" + [guid]::NewGuid().ToString("N"))
$stagingRepo = Join-Path $stagingRoot $RepoName

# Path fragments to exclude from the bundle
$excludedPathFragments = @(
    "\.git\",
    "\.cursor\",
    "\deprecated\",
    "\node_modules\",
    "\dist\",
    "\build\",
    "\coverage\",
    "\.nyc_output\",
    "\.sfdx\",
    "\backend\prisma\dev.db",
    "\frontend\dist\",
    "\backend\dist\"
)

# File-name patterns to exclude
$excludedFilePatterns = @(
    "*.log",
    "*.tmp",
    "*.swp",
    ".DS_Store",
    ".saved_credentials.json"
)

if ($IncludeDocs) {
    # Re-allow docs by removing deprecated/docs exclusion side-effect.
    $excludedPathFragments = $excludedPathFragments | Where-Object { $_ -ne "\deprecated\" }
}

function Test-IsExcluded([string]$fullPath) {
    $normalized = $fullPath.ToLowerInvariant().Replace("/", "\")
    foreach ($frag in $excludedPathFragments) {
        if ($normalized.Contains($frag.ToLowerInvariant())) {
            return $true
        }
    }

    $name = Split-Path $fullPath -Leaf
    foreach ($pat in $excludedFilePatterns) {
        if ($name -like $pat) {
            return $true
        }
    }
    return $false
}

try {
    if (Test-Path $OutputZip) {
        Log "Removing existing output zip: $OutputZip"
        Remove-Item $OutputZip -Force
    }

    Log "Creating staging folder: $stagingRepo"
    New-Item -ItemType Directory -Path $stagingRepo -Force | Out-Null

    Log "Collecting source files from: $RepoRoot"
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

    Log "Copied $copied files. Creating zip..."
    Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $OutputZip -CompressionLevel Optimal

    $sizeMB = [math]::Round((Get-Item $OutputZip).Length / 1MB, 2)
    Log "Bundle ready: $OutputZip ($sizeMB MB)"
    Write-Host ""
    Write-Host "Transfer this zip to Unix and extract under /opt (or your target path)." -ForegroundColor Green
}
finally {
    if (Test-Path $stagingRoot) {
        Remove-Item -Path $stagingRoot -Recurse -Force
    }
}

