#!/usr/bin/env bash
set -euo pipefail

# Build a Linux offline deployment zip (source + node_modules + dist).
# Use this from WSL or any Unix host — equivalent to prepare-unix-offline-bundle.ps1.
#
# Usage:
#   ./scripts/prepare-unix-offline-bundle.sh
#   ./scripts/prepare-unix-offline-bundle.sh -o ~/my-bundle.zip
#   ./scripts/prepare-unix-offline-bundle.sh --skip-install --skip-build
#
# Options:
#   -o, --output PATH   Output zip path (default: /tmp/<repo>-unix-offline-bundle-<stamp>.zip)
#   --skip-install      Skip npm run install:all
#   --skip-build        Skip npm run build
#   -h, --help          Show help

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_NAME="$(basename "$REPO_ROOT")"
STAMP="$(date +%Y%m%d-%H%M%S)"

OUTPUT_ZIP=""
SKIP_INSTALL=false
SKIP_BUILD=false

log() {
  printf '[offline-bundle] %s\n' "$*"
}

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[offline-bundle] Missing required command: $1" >&2
    exit 1
  }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output)
      OUTPUT_ZIP="${2:-}"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=true
      shift
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[offline-bundle] Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$OUTPUT_ZIP" ]]; then
  OUTPUT_ZIP="${TMPDIR:-/tmp}/${REPO_NAME}-unix-offline-bundle-${STAMP}.zip"
fi
mkdir -p "$(dirname "$OUTPUT_ZIP")"
OUTPUT_ZIP="$(cd "$(dirname "$OUTPUT_ZIP")" && pwd)/$(basename "$OUTPUT_ZIP")"

require_cmd node
require_cmd npm
require_cmd rsync
require_cmd zip

log "Repo root: $REPO_ROOT"
log "Output zip: $OUTPUT_ZIP"

cd "$REPO_ROOT"

if [[ "$SKIP_INSTALL" == "true" ]]; then
  log "Skipping dependency install (--skip-install)"
else
  log "Installing dependencies (root/backend/frontend)"
  npm run install:all
fi

if [[ "$SKIP_BUILD" == "true" ]]; then
  log "Skipping build (--skip-build)"
else
  log "Building backend/frontend artifacts"
  npm run build
fi

if [[ -f "$OUTPUT_ZIP" ]]; then
  log "Removing existing zip at $OUTPUT_ZIP"
  rm -f "$OUTPUT_ZIP"
fi

STAGING_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/wfm-offline-bundle.XXXXXX")"
STAGING_REPO="$STAGING_ROOT/$REPO_NAME"
mkdir -p "$STAGING_REPO"

cleanup() {
  rm -rf "$STAGING_ROOT"
}
trap cleanup EXIT

log "Collecting files for offline bundle (this can take a while)..."
rsync -a \
  --exclude '.git/' \
  --exclude '.cursor/' \
  --exclude 'deprecated/' \
  --exclude 'coverage/' \
  --exclude '.nyc_output/' \
  --exclude 'backend/prisma/dev.db' \
  --exclude 'backend/combined*.log' \
  --exclude 'backend/error.log' \
  --exclude 'frontend/combined*.log' \
  --exclude 'frontend/error.log' \
  --exclude '*.log' \
  --exclude '*.tmp' \
  --exclude '*.swp' \
  --exclude '.DS_Store' \
  --exclude '.saved_credentials.json' \
  --exclude '.env' \
  "$REPO_ROOT/" "$STAGING_REPO/"

cat > "$STAGING_REPO/OFFLINE_DEPLOY_README.txt" <<EOF
WFM Control-M Offline Bundle
Generated: $(date -Iseconds)

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
EOF

log "Compressing bundle..."
mkdir -p "$(dirname "$OUTPUT_ZIP")"
(
  cd "$STAGING_ROOT"
  zip -rq "$OUTPUT_ZIP" "$REPO_NAME"
)

SIZE_MB="$(du -m "$OUTPUT_ZIP" | awk '{print $1}')"
log "Offline bundle ready: $OUTPUT_ZIP (${SIZE_MB} MB)"
echo ""
echo "Transfer this zip to sandbox and extract under /application/wfmwatch"
