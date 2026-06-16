#!/usr/bin/env bash
set -euo pipefail

# Full SQLite setup for fresh sandbox:
# - creates DB file
# - applies Prisma migrations
# - applies DDL + DML bootstrap
# - verifies AppConfig rows

APP_DIR="${APP_DIR:-/application/wfmwatch}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"

log() {
  printf "\n[setup-db] %s\n" "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[setup-db] Missing required command: $1" >&2
    exit 1
  }
}

require_cmd node
require_cmd npm
require_cmd sqlite3

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[setup-db] Missing $ENV_FILE in $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

DB_URL_LINE="$(grep -E '^DATABASE_URL=' "$ENV_FILE" || true)"
DB_URL_VALUE="${DB_URL_LINE#DATABASE_URL=}"
DB_URL_VALUE="${DB_URL_VALUE%\"}"
DB_URL_VALUE="${DB_URL_VALUE#\"}"

if [[ -z "$DB_URL_VALUE" || "$DB_URL_VALUE" != file:* ]]; then
  echo "[setup-db] DATABASE_URL must be SQLite file URL (example: file:./dev.db)" >&2
  exit 1
fi

REL_DB_PATH="${DB_URL_VALUE#file:}"
if [[ "$REL_DB_PATH" == /* ]]; then
  DB_PATH="$REL_DB_PATH"
else
  # Prisma resolves relative SQLite paths from backend/.
  DB_PATH="$APP_DIR/backend/${REL_DB_PATH#./}"
fi
DB_DIR="$(dirname "$DB_PATH")"

mkdir -p "$DB_DIR"
touch "$DB_PATH"
chmod 664 "$DB_PATH" || true
chmod 775 "$DB_DIR" || true

log "Applying Prisma migrations"
npm run db:deploy

log "Applying SQL bootstrap (DDL + DML)"
npm run db:bootstrap

log "Verifying DB file"
ls -l "$DB_PATH"

log "Verifying tables"
sqlite3 "$DB_PATH" ".tables"

log "Verifying AppConfig count"
sqlite3 "$DB_PATH" "SELECT COUNT(*) AS appConfigCount FROM AppConfig;"

log "Done. Fresh DB setup complete."
