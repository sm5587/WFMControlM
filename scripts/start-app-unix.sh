#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/dotenv.sh
source "$SCRIPT_DIR/lib/dotenv.sh"

# Start WFM Control-M backend on Unix with PM2.
#
# Usage:
#   bash ./scripts/start-app-unix.sh
#
# Optional env vars:
#   APP_DIR=...              # override; default is APP_DIR from .env
#   PROCESS_NAME=wfm-backend
#   INSTALL_PM2=true|false     # default true (installs pm2 locally in backend/ if missing)
#   BUILD_BACKEND=true|false   # default false
#   START_FRONTEND=true|false  # default false
#   FRONTEND_MODE=nginx|docker # used only when START_FRONTEND=true (default nginx)
#
# Notes:
# - This script only starts/restarts the backend process.
# - Run DB setup first (setup-db.sh or deploy-unix.sh).

APP_DIR="$(resolve_app_dir "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
PROCESS_NAME="${PROCESS_NAME:-wfm-backend}"
INSTALL_PM2="${INSTALL_PM2:-true}"
BUILD_BACKEND="${BUILD_BACKEND:-false}"
START_FRONTEND="${START_FRONTEND:-false}"
FRONTEND_MODE="${FRONTEND_MODE:-nginx}"

log() {
  printf "\n[start-app-unix] %s\n" "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[start-app-unix] Missing required command: $1" >&2
    exit 1
  }
}

ensure_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    PM2_BIN="$(command -v pm2)"
    return
  fi

  if [[ "$INSTALL_PM2" != "true" ]]; then
    echo "[start-app-unix] pm2 not found. Install it or rerun with INSTALL_PM2=true." >&2
    echo "[start-app-unix] Options:" >&2
    echo "  npm install -g pm2   # may require sudo on shared Unix hosts" >&2
    echo "  bash ./scripts/start-app-unix.sh   # auto-installs pm2 locally in backend/" >&2
    exit 1
  fi

  log "pm2 not found; installing locally in backend/node_modules (no sudo required)"
  if ! npm install --no-fund --no-audit pm2; then
    echo "[start-app-unix] Failed to install pm2 locally." >&2
    exit 1
  fi

  PM2_BIN="$PWD/node_modules/.bin/pm2"
  if [[ ! -x "$PM2_BIN" ]]; then
    echo "[start-app-unix] pm2 install succeeded but binary not found at $PM2_BIN" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '1,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

require_cmd node
require_cmd npm

if [[ ! -d "$APP_DIR/backend" ]]; then
  echo "[start-app-unix] backend directory not found under APP_DIR: $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR/backend"
log "Using backend directory: $PWD"

ensure_pm2
log "Using pm2: $PM2_BIN"

if [[ "$BUILD_BACKEND" == "true" ]]; then
  log "Building backend"
  npm run build
fi

if [[ ! -f "dist/index.js" ]]; then
  echo "[start-app-unix] dist/index.js not found. Run npm run build first." >&2
  exit 1
fi

if "$PM2_BIN" describe "$PROCESS_NAME" >/dev/null 2>&1; then
  log "Process exists; restarting: $PROCESS_NAME"
  "$PM2_BIN" restart "$PROCESS_NAME"
else
  log "Starting process: $PROCESS_NAME"
  "$PM2_BIN" start dist/index.js --name "$PROCESS_NAME"
fi

"$PM2_BIN" save

# Resolve backend port from AppConfig (if available); default 4000.
BACKEND_PORT="4000"
DB_URL_VALUE="$(dotenv_read_database_url "$ENV_FILE" || true)"
if [[ -n "$DB_URL_VALUE" && "$DB_URL_VALUE" == file:* ]] && command -v sqlite3 >/dev/null 2>&1; then
  REL_DB_PATH="${DB_URL_VALUE#file:}"
  if [[ "$REL_DB_PATH" == /* ]]; then
    DB_PATH="$REL_DB_PATH"
  else
    DB_PATH="$(resolve_sqlite_db_path "$APP_DIR" "$DB_URL_VALUE")"
  fi

  if [[ -f "$DB_PATH" ]]; then
    CFG_PORT="$(sqlite3 "$DB_PATH" "SELECT value FROM AppConfig WHERE key='infra.port' LIMIT 1;" 2>/dev/null || true)"
    if [[ "$CFG_PORT" =~ ^[0-9]+$ ]]; then
      BACKEND_PORT="$CFG_PORT"
    fi
  fi
fi

log "Backend process status"
"$PM2_BIN" status "$PROCESS_NAME"

log "Health check (waiting for backend to finish boot — DB load, scheduler, etc.)"
HEALTH_OK=false
for attempt in $(seq 1 30); do
  if curl -fsS "http://localhost:${BACKEND_PORT}/health" >/dev/null 2>&1; then
    HEALTH_OK=true
    break
  fi
  sleep 2
done

if [[ "$HEALTH_OK" == "true" ]]; then
  echo "[start-app-unix] Health check passed on port ${BACKEND_PORT}"
else
  echo "[start-app-unix] Health check failed on port ${BACKEND_PORT} after 60s. Check logs:" >&2
  echo "  $PM2_BIN logs ${PROCESS_NAME} --lines 100" >&2
  exit 1
fi

log "Done"
echo "Next useful commands:"
echo "  $PM2_BIN logs ${PROCESS_NAME} --lines 100"
echo "  $PM2_BIN status"
echo "  bash $APP_DIR/scripts/start-frontend-unix.sh"

if [[ "$START_FRONTEND" == "true" ]]; then
  log "START_FRONTEND=true, invoking frontend startup helper (mode: ${FRONTEND_MODE})"
  bash "$APP_DIR/scripts/start-frontend-unix.sh" --mode "$FRONTEND_MODE"
fi
