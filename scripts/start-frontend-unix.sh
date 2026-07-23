#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/dotenv.sh
source "$SCRIPT_DIR/lib/dotenv.sh"

# Build and serve WFM Control-M frontend on Unix (nginx or Docker).
#
# Usage:
#   bash ./scripts/start-frontend-unix.sh
#   bash ./scripts/start-frontend-unix.sh --mode nginx
#   APP_HOST=z182st-bmrrwssbwas01 FRONTEND_PORT=5555 bash ./scripts/start-frontend-unix.sh
#
# Optional env vars:
#   APP_DIR=...                       # override; default is APP_DIR from .env
#   MODE=nginx|docker                 # default nginx (bare metal)
#   BUILD_FRONTEND=true|false         # default true
#   INSTALL_FRONTEND_DEPS=true|false  # default false (npm --prefix frontend install)
#   APPLY_NGINX=true|false            # default true in nginx mode
#   RELOAD_NGINX=true|false           # default true in nginx mode
#   NGINX_CONF_DEST=/etc/nginx/conf.d/wfm-controlm.conf
#   NGINX_WEB_ROOT=/var/www/wfmwatch   # publish build here (nginx cannot read ~/... on WSL)
#   DISABLE_DEFAULT_NGINX=true|false  # default true (removes sites-enabled/default)
#   FRONTEND_PORT=80                  # nginx listen port
#   APP_HOST=<hostname-or-ip>         # for CORS + URL (WSL default: localhost)
#   APP_URL=http://host:port          # overrides APP_HOST/FRONTEND_PORT for CORS
#   UPDATE_CORS=true|false            # default true (updates infra.corsOrigins in SQLite)
#   RESTART_BACKEND=true|false        # default true after CORS update (pm2 restart)
#   BACKEND_PORT=                     # auto-read from AppConfig infra.port when empty
#
# Prerequisites (nginx mode):
#   - backend running (bash ./scripts/start-app-unix.sh)
#   - nginx installed (Ubuntu/WSL: sudo apt install nginx)
#   - sudo for publishing to /var/www, copying config, and reload
#
# WSL note: nginx runs as www-data and cannot read ~/projects/... — the script
# rsyncs frontend/dist to NGINX_WEB_ROOT (default /var/www/wfmwatch) automatically.

APP_DIR="$(resolve_app_dir "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
MODE="${MODE:-nginx}"
BUILD_FRONTEND="${BUILD_FRONTEND:-true}"
INSTALL_FRONTEND_DEPS="${INSTALL_FRONTEND_DEPS:-false}"
APPLY_NGINX="${APPLY_NGINX:-true}"
RELOAD_NGINX="${RELOAD_NGINX:-true}"
NGINX_CONF_DEST="${NGINX_CONF_DEST:-/etc/nginx/conf.d/wfm-controlm.conf}"
NGINX_WEB_ROOT="${NGINX_WEB_ROOT:-/var/www/wfmwatch}"
DISABLE_DEFAULT_NGINX="${DISABLE_DEFAULT_NGINX:-true}"
FRONTEND_PORT="${FRONTEND_PORT:-}"
APP_HOST="${APP_HOST:-}"
APP_URL="${APP_URL:-}"
UPDATE_CORS="${UPDATE_CORS:-true}"
RESTART_BACKEND="${RESTART_BACKEND:-true}"
BACKEND_PORT="${BACKEND_PORT:-}"
PROCESS_NAME="${PROCESS_NAME:-wfm-backend}"

log() {
  printf "\n[start-frontend-unix] %s\n" "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[start-frontend-unix] Missing required command: $1" >&2
    exit 1
  }
}

resolve_backend_port() {
  if [[ -n "$BACKEND_PORT" ]]; then
    return
  fi

  BACKEND_PORT="4000"
  local db_url_value
  db_url_value="$(dotenv_read_database_url "$ENV_FILE" || true)"
  if [[ -n "$db_url_value" && "$db_url_value" == file:* ]] && command -v sqlite3 >/dev/null 2>&1; then
    local rel_db_path db_path cfg_port
    rel_db_path="${db_url_value#file:}"
    if [[ "$rel_db_path" == /* ]]; then
      db_path="$rel_db_path"
    else
      db_path="$(resolve_sqlite_db_path "$APP_DIR" "$db_url_value")"
    fi
    if [[ -f "$db_path" ]]; then
      cfg_port="$(sqlite3 "$db_path" "SELECT value FROM AppConfig WHERE key='infra.port' LIMIT 1;" 2>/dev/null || true)"
      if [[ "$cfg_port" =~ ^[0-9]+$ ]]; then
        BACKEND_PORT="$cfg_port"
      fi
    fi
  fi
}

is_wsl() {
  grep -qi microsoft /proc/version 2>/dev/null
}

resolve_frontend_url() {
  if [[ -n "$APP_URL" ]]; then
    return
  fi
  if [[ -z "$APP_HOST" ]]; then
    if is_wsl; then
      APP_HOST="localhost"
    else
      APP_HOST="$(hostname -f 2>/dev/null || hostname)"
    fi
  fi
  if [[ "$FRONTEND_PORT" == "80" ]]; then
    APP_URL="http://${APP_HOST}"
  else
    APP_URL="http://${APP_HOST}:${FRONTEND_PORT}"
  fi
}

find_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    command -v pm2
    return
  fi
  if [[ -x "$APP_DIR/backend/node_modules/.bin/pm2" ]]; then
    printf '%s' "$APP_DIR/backend/node_modules/.bin/pm2"
    return
  fi
  return 1
}

update_cors_origins() {
  if [[ "$UPDATE_CORS" != "true" ]]; then
    log "Skipping CORS update (UPDATE_CORS=false)"
    return
  fi

  require_cmd sqlite3
  local db_url_value db_path rel_db_path existing merged
  db_url_value="$(dotenv_read_database_url "$ENV_FILE" || true)"
  if [[ -z "$db_url_value" || "$db_url_value" != file:* ]]; then
    echo "[start-frontend-unix] Cannot update CORS: DATABASE_URL missing or not SQLite" >&2
    return
  fi

  rel_db_path="${db_url_value#file:}"
  if [[ "$rel_db_path" == /* ]]; then
    db_path="$rel_db_path"
  else
    db_path="$(resolve_sqlite_db_path "$APP_DIR" "$db_url_value")"
  fi

  if [[ ! -f "$db_path" ]]; then
    echo "[start-frontend-unix] Cannot update CORS: DB not found at $db_path" >&2
    return
  fi

  local cors_value="$APP_URL"
  if [[ "$APP_HOST" == "localhost" || "$APP_HOST" == "127.0.0.1" ]]; then
    if [[ "$FRONTEND_PORT" == "80" ]]; then
      cors_value="http://localhost,http://127.0.0.1"
    else
      cors_value="http://localhost:${FRONTEND_PORT},http://127.0.0.1:${FRONTEND_PORT}"
    fi
  fi

  existing="$(sqlite3 "$db_path" "SELECT value FROM AppConfig WHERE key='infra.corsOrigins' LIMIT 1;" 2>/dev/null || true)"
  if [[ -n "$existing" && "$existing" == *"${APP_URL}"* ]]; then
    log "CORS already includes $APP_URL"
  elif [[ -n "$existing" ]]; then
    merged="${existing},${cors_value}"
    sqlite3 "$db_path" "UPDATE AppConfig SET value='${merged}' WHERE key='infra.corsOrigins';"
    log "Appended CORS origins: $cors_value"
  else
    sqlite3 "$db_path" "UPDATE AppConfig SET value='${cors_value}' WHERE key='infra.corsOrigins';"
    log "Set CORS origins: $cors_value"
  fi

  if [[ "$RESTART_BACKEND" == "true" ]]; then
    local pm2_bin
    if pm2_bin="$(find_pm2)"; then
      log "Restarting backend so CORS change takes effect"
      "$pm2_bin" restart "$PROCESS_NAME" >/dev/null 2>&1 || true
    else
      echo "[start-frontend-unix] pm2 not found; restart backend manually after CORS update" >&2
    fi
  fi
}

disable_default_nginx_site() {
  if [[ "$DISABLE_DEFAULT_NGINX" != "true" ]]; then
    return
  fi

  local default_site="/etc/nginx/sites-enabled/default"
  if [[ -L "$default_site" || -f "$default_site" ]]; then
    log "Disabling default nginx site ($default_site)"
    sudo rm -f "$default_site"
  fi
}

reload_nginx() {
  sudo nginx -t
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active nginx >/dev/null 2>&1; then
    sudo systemctl reload nginx
  elif command -v service >/dev/null 2>&1; then
    sudo service nginx reload
  else
    sudo nginx -s reload
  fi
}

publish_frontend_build() {
  local build_root="$APP_DIR/frontend/dist"
  local serve_root="$NGINX_WEB_ROOT"

  if [[ ! -f "$build_root/index.html" ]]; then
    echo "[start-frontend-unix] Missing frontend build: $build_root/index.html" >&2
    exit 1
  fi

  require_cmd sudo
  log "Publishing frontend build -> $serve_root"
  sudo mkdir -p "$serve_root"
  if command -v rsync >/dev/null 2>&1; then
    sudo rsync -a --delete "${build_root}/" "${serve_root}/"
  else
    sudo rm -rf "${serve_root:?}/"*
    sudo cp -a "${build_root}/." "$serve_root/"
  fi
}

configure_nginx() {
  local src_conf="$APP_DIR/frontend/nginx.conf"
  local build_root="$APP_DIR/frontend/dist"
  local serve_root="$NGINX_WEB_ROOT"
  local backend_upstream="http://localhost:${BACKEND_PORT}"

  if [[ ! -f "$src_conf" ]]; then
    echo "[start-frontend-unix] Missing nginx template: $src_conf" >&2
    exit 1
  fi

  publish_frontend_build

  if [[ "$APPLY_NGINX" != "true" ]]; then
    log "Skipping nginx config copy (APPLY_NGINX=false)"
    return
  fi

  log "Installing nginx site config -> $NGINX_CONF_DEST"
  sudo cp "$src_conf" "$NGINX_CONF_DEST"

  sudo sed -i "s|http://backend:4000|${backend_upstream}|g" "$NGINX_CONF_DEST"
  sudo sed -i "s|root /usr/share/nginx/html;|root ${serve_root};|" "$NGINX_CONF_DEST"
  if [[ "$FRONTEND_PORT" != "80" ]]; then
    sudo sed -i "s/listen 80;/listen ${FRONTEND_PORT};/" "$NGINX_CONF_DEST"
  fi

  disable_default_nginx_site

  log "Nginx root: $serve_root (source build: $build_root)"
  log "API proxy:  ${backend_upstream}"

  if [[ "$RELOAD_NGINX" == "true" ]]; then
    log "Testing and reloading nginx"
    reload_nginx
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  sed -n '1,45p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [[ "${1:-}" == "--mode" ]]; then
  MODE="${2:-$MODE}"
fi

if [[ ! -d "$APP_DIR" ]]; then
  echo "[start-frontend-unix] APP_DIR does not exist: $APP_DIR" >&2
  echo "[start-frontend-unix] Set APP_DIR in .env (see .env.example)" >&2
  exit 1
fi

if [[ ! -d "$APP_DIR/frontend" ]]; then
  echo "[start-frontend-unix] frontend directory not found under APP_DIR: $APP_DIR" >&2
  exit 1
fi

cd "$APP_DIR"
log "Using APP_DIR: $APP_DIR"
resolve_backend_port

case "$MODE" in
  nginx)
    FRONTEND_PORT="${FRONTEND_PORT:-80}"
    resolve_frontend_url
    require_cmd npm
    if ! command -v nginx >/dev/null 2>&1; then
      echo "[start-frontend-unix] nginx binary not found. Install nginx first." >&2
      exit 1
    fi

    if [[ "$INSTALL_FRONTEND_DEPS" == "true" ]]; then
      log "Installing frontend dependencies"
      npm --prefix frontend install --no-fund --no-audit
    fi

    if [[ "$BUILD_FRONTEND" == "true" ]]; then
      log "Building frontend static assets"
      npm run build:frontend
    fi

    if [[ ! -f "$APP_DIR/frontend/dist/index.html" ]]; then
      echo "[start-frontend-unix] frontend/dist/index.html not found. Run BUILD_FRONTEND=true." >&2
      exit 1
    fi

    configure_nginx
    update_cors_origins

    log "Frontend checks"
    if command -v curl >/dev/null 2>&1; then
      if curl -fsSI "$APP_URL" >/dev/null 2>&1; then
        echo "[start-frontend-unix] HTTP check passed: $APP_URL"
      else
        echo "[start-frontend-unix] HTTP check failed for $APP_URL (UI may still work from another host)" >&2
      fi
      if curl -fsS "http://localhost:${BACKEND_PORT}/health" >/dev/null 2>&1; then
        echo "[start-frontend-unix] Backend health OK on port ${BACKEND_PORT}"
      else
        echo "[start-frontend-unix] Backend health failed on port ${BACKEND_PORT}" >&2
      fi
    fi

    echo "[start-frontend-unix] Frontend URL: $APP_URL"
    echo "[start-frontend-unix] Default login (seed): WFMADMIN / WFMADMIN"
    ;;

  docker)
    FRONTEND_PORT="${FRONTEND_PORT:-3000}"
    resolve_frontend_url
    require_cmd docker
    log "Starting frontend via Docker Compose"
    docker compose up -d frontend
    docker compose ps frontend
    if command -v curl >/dev/null 2>&1; then
      curl -I "$APP_URL" || true
    fi
    echo "[start-frontend-unix] Frontend URL: $APP_URL"
    ;;

  *)
    echo "[start-frontend-unix] Unsupported mode: $MODE (use nginx|docker)" >&2
    exit 1
    ;;
esac

log "Done"
