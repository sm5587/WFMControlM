#!/usr/bin/env bash
set -euo pipefail

# One-shot Unix deployment helper for WFM Control-M.
# Default behavior prepares DB completely (migrations + DDL + DML).
#
# Assumes source ZIP has already been extracted on Unix.
#
# Optional env vars:
#   APP_DIR=/opt/wfm-controlm
#   BOOTSTRAP_DB=true|false         # default true (runs DDL/DML bootstrap)
#   INSTALL_DEPS=true|false
#   BUILD_APP=true|false
#
# Notes:
# - BOOTSTRAP_DB=true applies database/ddl.sql and database/dml.sql (fresh setup mode).
# - For existing environments where you must preserve DB/AppConfig values, set BOOTSTRAP_DB=false.
# - Ensure .env is configured (DATABASE_URL, CONFIG_ENCRYPTION_KEY) before first run.
# - Pass -h or --help to print this help.

APP_DIR="${APP_DIR:-/opt/wfm-controlm}"
BOOTSTRAP_DB="${BOOTSTRAP_DB:-true}"
INSTALL_DEPS="${INSTALL_DEPS:-true}"
BUILD_APP="${BUILD_APP:-true}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '1,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

log() {
  printf "\n[deploy-unix] %s\n" "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[deploy-unix] Missing required command: $1" >&2
    exit 1
  }
}

require_cmd node
require_cmd npm

if [[ ! -d "$APP_DIR" ]]; then
  echo "[deploy-unix] APP_DIR does not exist: $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"
log "Using extracted source at: $APP_DIR"

if [[ ! -f ".env" ]]; then
  if [[ -f ".env.example" ]]; then
    log "Creating .env from .env.example"
    cp .env.example .env
    cat <<'EOF'
[deploy-unix] IMPORTANT: Edit .env before first full startup:
  - DATABASE_URL=file:./dev.db
  - CONFIG_ENCRYPTION_KEY=<64-char-hex>
Generate key:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
EOF
  else
    echo "[deploy-unix] Missing .env and .env.example." >&2
    exit 1
  fi
fi

# Parse DATABASE_URL from .env (supports DATABASE_URL=file:./dev.db pattern).
DB_URL_LINE="$(grep -E '^DATABASE_URL=' .env || true)"
DB_URL_VALUE="${DB_URL_LINE#DATABASE_URL=}"
DB_URL_VALUE="${DB_URL_VALUE%\"}"
DB_URL_VALUE="${DB_URL_VALUE#\"}"
if [[ -z "$DB_URL_VALUE" ]]; then
  echo "[deploy-unix] DATABASE_URL is missing in .env" >&2
  exit 1
fi

if [[ "$DB_URL_VALUE" == file:* ]]; then
  # Prisma SQLite path is relative to backend/ in this repo.
  REL_DB_PATH="${DB_URL_VALUE#file:}"
  DB_PATH="$APP_DIR/backend/${REL_DB_PATH#./}"
else
  DB_PATH="(non-sqlite-url)"
fi

if [[ "$INSTALL_DEPS" == "true" ]]; then
  log "Installing dependencies (root + backend + frontend)"
  npm run install:all
else
  log "Skipping dependency install (INSTALL_DEPS=false)"
fi

if [[ "$BUILD_APP" == "true" ]]; then
  log "Building backend + frontend"
  npm run build
else
  log "Skipping build (BUILD_APP=false)"
fi

log "Preparing database schema via Prisma migrations"
npm run db:deploy

if [[ "$BOOTSTRAP_DB" == "true" ]]; then
  log "Applying DDL/DML bootstrap (database/ddl.sql + database/dml.sql)"
  npm run db:bootstrap
else
  log "Skipping DDL/DML bootstrap (BOOTSTRAP_DB=false)"
fi

if [[ "$DB_PATH" != "(non-sqlite-url)" ]]; then
  if [[ -f "$DB_PATH" ]]; then
    log "SQLite DB file present: $DB_PATH"
  else
    echo "[deploy-unix] Expected SQLite DB file not found at: $DB_PATH" >&2
    exit 1
  fi
fi

if command -v sqlite3 >/dev/null 2>&1 && [[ "$DB_PATH" != "(non-sqlite-url)" ]]; then
  log "Verifying AppConfig rows via sqlite3"
  sqlite3 "$DB_PATH" "SELECT COUNT(*) AS appConfigCount FROM AppConfig;"
else
  log "sqlite3 CLI not found (skipping SQL verification step)"
fi

cat <<'EOF'

[deploy-unix] Deployment steps complete.

Next:
  1) Start backend (example):
       cd backend && npm install -g pm2 && pm2 start dist/index.js --name wfm-backend
  2) Verify:
       curl http://localhost:4000/health
  3) Configure runtime secrets in Admin -> Config (SMTP/SSH/JWT/etc.).

EOF
