#!/usr/bin/env bash
set -euo pipefail

# Backup WFM Watch SQLite database to a dated file on the host.
#
# Usage:
#   ./scripts/backup-sqlite.sh
#   BACKUP_DIR=/backup/wfmwatch ./scripts/backup-sqlite.sh
#
# Env (optional):
#   APP_DIR              Project root (default: parent of scripts/)
#   WFM_SQLITE_HOST_DIR  Host SQLite dir (default: ./data/sqlite)
#   BACKUP_DIR           Backup destination (default: ./data/backups/sqlite)
#   CONTAINER_NAME       Backend container (default: wfm-controlm-api)
#   DB_FILENAME          SQLite file name (default: dev.db)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
WFM_SQLITE_HOST_DIR="${WFM_SQLITE_HOST_DIR:-./data/sqlite}"
BACKUP_DIR="${BACKUP_DIR:-./data/backups/sqlite}"
CONTAINER_NAME="${CONTAINER_NAME:-wfm-controlm-api}"
DB_FILENAME="${DB_FILENAME:-dev.db}"

resolve_path() {
  local base="$1"
  local rel="$2"
  if [[ "$rel" == /* ]]; then
    printf '%s' "$rel"
  else
    printf '%s/%s' "$base" "$rel"
  fi
}

HOST_DB_DIR="$(resolve_path "$APP_DIR" "$WFM_SQLITE_HOST_DIR/prisma")"
HOST_DB_PATH="$HOST_DB_DIR/$DB_FILENAME"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$(resolve_path "$APP_DIR" "$BACKUP_DIR")"
BACKUP_PATH="$BACKUP_ROOT/${DB_FILENAME%.db}-$STAMP.db"

mkdir -p "$BACKUP_ROOT"

if [[ -f "$HOST_DB_PATH" ]]; then
  cp "$HOST_DB_PATH" "$BACKUP_PATH"
  echo "[backup-sqlite] Copied host DB: $HOST_DB_PATH -> $BACKUP_PATH"
elif docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker cp "$CONTAINER_NAME:/app/prisma/$DB_FILENAME" "$BACKUP_PATH"
  echo "[backup-sqlite] Copied from container: $CONTAINER_NAME:/app/prisma/$DB_FILENAME -> $BACKUP_PATH"
else
  echo "[backup-sqlite] ERROR: No DB at $HOST_DB_PATH and container '$CONTAINER_NAME' is not running." >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$BACKUP_PATH" 'PRAGMA integrity_check;' | head -n 1
fi

echo "[backup-sqlite] Backup complete: $BACKUP_PATH"
