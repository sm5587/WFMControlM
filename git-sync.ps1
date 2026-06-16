param(
    [Parameter(Mandatory = $true)]
    [string]$Message,
    [string]$Remote = "origin"
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

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch) -or $branch -eq "HEAD") {
    throw "Unable to determine current branch (detached HEAD?)."
}

Step "Pulling latest changes from $Remote/$branch"
RunGit @("pull", "--rebase", "--autostash", $Remote, $branch)

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

Step "Pushing to $Remote/$branch"
RunGit @("push", $Remote, $branch)

Write-Host "`n[git-sync] Done. Pull, commit, and push completed." -ForegroundColor Green
