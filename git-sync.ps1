param(
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [string]$Remote = "origin",
    [string]$Branch = "master"
)

$ErrorActionPreference = "Stop"

function Step($text) {
    Write-Host "`n[git-sync] $text" -ForegroundColor Cyan
}

function RunGit([string[]]$GitArgs) {
    Write-Host "[git-sync] > git $($GitArgs -join ' ')" -ForegroundColor DarkGray
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

Step "Validating repository"
RunGit @("rev-parse", "--is-inside-work-tree")

Step "Fetching latest from $Remote"
RunGit @("fetch", $Remote)

$remoteRef = "$Remote/$Branch"
RunGit @("rev-parse", "--verify", $remoteRef)

Step "Checking out $Branch (tracking $remoteRef)"
RunGit @("checkout", "-B", $Branch, $remoteRef)
RunGit @("branch", "--set-upstream-to=$remoteRef", $Branch)

Step "Pulling latest changes from $remoteRef"
RunGit @("pull", "--rebase", "--autostash", $Remote, $Branch)

Step "Staging all changes"
RunGit @("add", "-A")

$statusShort = (& git status --porcelain)
if ($LASTEXITCODE -ne 0) {
    throw "Failed to read git status."
}

if (-not $statusShort) {
    Write-Host "[git-sync] No changes to commit. Working tree is clean." -ForegroundColor Yellow
    exit 0
}

Step "Committing changes"
RunGit @("commit", "-m", $Message)

Step "Pushing to $remoteRef"
RunGit @("push", $Remote, $Branch)

Write-Host "`n[git-sync] Done. $Branch is synced with $remoteRef." -ForegroundColor Green
