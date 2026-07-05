#!/usr/bin/env bash
set -euo pipefail

# Full SQLite setup for fresh Unix deployment:
# - creates DB file
# - applies Prisma migrations
# - applies DDL + DML bootstrap
# - verifies AppConfig rows
#
# Optional env vars:
#   APP_DIR=...              # override; default is APP_DIR from .env
#   ENV_FILE=...             # default: $APP_DIR/.env
#
# Run:
#   bash ./scripts/setup-db.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/dotenv.sh
source "$SCRIPT_DIR/lib/dotenv.sh"

APP_DIR="$(resolve_app_dir "$SCRIPT_DIR")"
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

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '1,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "[setup-db] APP_DIR does not exist: $APP_DIR" >&2
  echo "[setup-db] Set APP_DIR in .env (see .env.example)" >&2
  exit 1
fi

if [[ ! -w "$APP_DIR" ]]; then
  echo "[setup-db] APP_DIR is not writable: $APP_DIR" >&2
  echo "[setup-db] Fix: sudo chown -R \"\$(whoami)\" \"$APP_DIR\"" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "[setup-db] Missing $ENV_FILE in $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"

DB_URL_VALUE="$(dotenv_read_database_url "$ENV_FILE" || true)"
if [[ -z "$DB_URL_VALUE" || "$DB_URL_VALUE" != file:* ]]; then
  echo "[setup-db] DATABASE_URL must be SQLite file URL (example: file:./dev.db)" >&2
  exit 1
fi

# Prisma CLI runs from backend/ (via npm script), so export DATABASE_URL explicitly.
export DATABASE_URL="$DB_URL_VALUE"

REL_DB_PATH="${DB_URL_VALUE#file:}"
if [[ "$REL_DB_PATH" =~ ^[A-Za-z]:[/\\] ]]; then
  echo "[setup-db] DATABASE_URL uses a Windows path ($REL_DB_PATH)." >&2
  echo "[setup-db] In WSL/Unix use a path relative to backend/, e.g. file:./prisma/dev.db" >&2
  exit 1
fi
if [[ "$REL_DB_PATH" == /* ]]; then
  DB_PATH="$REL_DB_PATH"
else
  DB_PATH="$(resolve_sqlite_db_path "$APP_DIR" "$DB_URL_VALUE")"
fi
DB_DIR="$(dirname "$DB_PATH")"

log "SQLite target: $DB_PATH (Prisma resolves file: URLs relative to backend/prisma/)"

if ! mkdir -p "$DB_DIR" 2>/dev/null; then
  echo "[setup-db] mkdir: Permission denied — cannot create: $DB_DIR" >&2
  echo "[setup-db] User: $(whoami)  APP_DIR: $APP_DIR" >&2
  ls -ld "$APP_DIR" "$APP_DIR/backend" 2>/dev/null || true
  echo "[setup-db] Fix ownership: sudo chown -R \"\$(whoami)\" \"$APP_DIR\"" >&2
  echo "[setup-db] Or set DATABASE_URL=\"file:./prisma/dev.db\" in .env (relative to backend/)" >&2
  exit 1
fi
if [[ ! -w "$DB_DIR" ]]; then
  echo "[setup-db] SQLite directory is not writable: $DB_DIR" >&2
  exit 1
fi

log "Applying Prisma migrations"
log "Generating Prisma client for this host runtime"
npm --prefix backend run prisma:generate
npm run db:deploy

if [[ ! -f "$DB_PATH" || ! -s "$DB_PATH" ]]; then
  echo "[setup-db] DB file missing or empty after migrations: $DB_PATH" >&2
  echo "[setup-db] Use DATABASE_URL=\"file:./dev.db\" in .env (path is relative to backend/prisma/)" >&2
  exit 1
fi

log "Applying SQL bootstrap (DDL + DML + client inventory)"
if npm run db:bootstrap; then
  log "SQL bootstrap via Node/Prisma succeeded"
else
  log "Node/Prisma SQL bootstrap failed; applying DDL/DML/clients directly with sqlite3 fallback"
  sqlite3 "$DB_PATH" < "$APP_DIR/database/ddl.sql"
  sqlite3 "$DB_PATH" < "$APP_DIR/database/dml.sql"
  apply_clients_dml_sql "$APP_DIR" "$DB_PATH"
  log "SQL bootstrap via sqlite3 fallback succeeded"
fi

log "Configuring Unix infra paths (jjs, lib, dbconnections) when AppConfig is empty"
configure_unix_infra_paths "$APP_DIR" "$DB_PATH"

log "Verifying DB file"
ls -l "$DB_PATH"

log "Verifying tables"
sqlite3 "$DB_PATH" ".tables"

log "Verifying AppConfig count"
sqlite3 "$DB_PATH" "SELECT COUNT(*) AS appConfigCount FROM AppConfig;"

log "Verifying Client count"
sqlite3 "$DB_PATH" "SELECT COUNT(*) AS clientCount FROM Client;"

log "Done. Fresh DB setup complete."
