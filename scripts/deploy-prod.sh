#!/usr/bin/env bash
set -euo pipefail

# Safe production deploy for Docker — backs up SQLite, rebuilds images, recreates containers.
# Never runs `docker compose down -v` or first-time bootstrap SQL on an existing database.
#
# Usage:
#   ./scripts/deploy-prod.sh
#   FIRST_TIME_DEPLOY=true ./scripts/deploy-prod.sh   # fresh server only
#
# Env (optional):
#   APP_DIR                 Project root
#   WFM_SQLITE_HOST_DIR     Host SQLite bind mount (default: ./data/sqlite)
#   BACKUP_DIR              Backup destination (default: ./data/backups/sqlite)
#   SKIP_BACKUP=true        Skip pre-deploy backup
#   SKIP_BUILD=true         Skip image rebuild
#   FIRST_TIME_DEPLOY=true  Run first-time bootstrap SQL (empty DB only)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
COMPOSE_FILES=(-f docker-compose.prod.yml -f docker-compose.prod-hostdb.yml)
CONTAINER_NAME="${CONTAINER_NAME:-wfm-controlm-api}"
SKIP_BACKUP="${SKIP_BACKUP:-false}"
SKIP_BUILD="${SKIP_BUILD:-false}"
FIRST_TIME_DEPLOY="${FIRST_TIME_DEPLOY:-false}"

log() {
  printf "\n[deploy-prod] %s\n" "$*"
}

die() {
  echo "[deploy-prod] ERROR: $*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

require_cmd docker

cd "$APP_DIR"

if [[ ! -f ".env" ]]; then
  die "Missing .env in $APP_DIR (copy from .env.example and configure CONFIG_ENCRYPTION_KEY)"
fi

# shellcheck source=lib/dotenv.sh
source "$SCRIPT_DIR/lib/dotenv.sh"

if [[ -z "${WFM_SQLITE_HOST_DIR:-}" ]] && [[ -f ".env" ]]; then
  WFM_SQLITE_HOST_DIR="$(dotenv_read_key .env WFM_SQLITE_HOST_DIR 2>/dev/null || true)"
fi
export WFM_SQLITE_HOST_DIR="${WFM_SQLITE_HOST_DIR:-./data/sqlite}"
HOST_DB_DIR="$APP_DIR/$WFM_SQLITE_HOST_DIR/prisma"
mkdir -p "$HOST_DB_DIR"

log "Using APP_DIR=$APP_DIR"
log "SQLite host path: $HOST_DB_DIR/dev.db"

if [[ "$SKIP_BACKUP" != "true" ]]; then
  log "Pre-deploy SQLite backup"
  APP_DIR="$APP_DIR" WFM_SQLITE_HOST_DIR="$WFM_SQLITE_HOST_DIR" bash "$SCRIPT_DIR/backup-sqlite.sh"
else
  log "Skipping backup (SKIP_BACKUP=true)"
fi

if [[ "$SKIP_BUILD" != "true" ]]; then
  log "Building production images"
  docker compose "${COMPOSE_FILES[@]}" build
else
  log "Skipping build (SKIP_BUILD=true)"
fi

log "Starting / recreating containers (data preserved on host bind mount)"
docker compose "${COMPOSE_FILES[@]}" up -d --force-recreate

log "Waiting for backend health"
deadline=$((SECONDS + 120))
until docker compose "${COMPOSE_FILES[@]}" ps --status running | grep -q "$CONTAINER_NAME"; do
  sleep 2
  (( SECONDS >= deadline )) && die "Backend container did not start in time"
done

health_ok=false
while (( SECONDS < deadline )); do
  if docker compose "${COMPOSE_FILES[@]}" exec -T backend wget -qO- http://127.0.0.1:4005/health >/dev/null 2>&1; then
    health_ok=true
    break
  fi
  sleep 3
done
[[ "$health_ok" == "true" ]] || die "Backend health check failed"

if [[ "$FIRST_TIME_DEPLOY" == "true" ]]; then
  if [[ -f "$HOST_DB_DIR/dev.db" ]] && [[ "$(wc -c < "$HOST_DB_DIR/dev.db" | tr -d ' ')" -gt 8192 ]]; then
    die "FIRST_TIME_DEPLOY=true but $HOST_DB_DIR/dev.db already exists and looks populated. Refusing to bootstrap."
  fi
  log "First-time deployment: applying bootstrap SQL (fresh DB only)"
  docker compose "${COMPOSE_FILES[@]}" run --rm \
    -v "${APP_DIR}/database:/app/database:ro" \
    backend node scripts/apply-sql.js database/first-time-deployment-ddl.sql
  docker compose "${COMPOSE_FILES[@]}" run --rm \
    -v "${APP_DIR}/database:/app/database:ro" \
    backend node scripts/apply-sql.js database/first-time-deployment-dml.sql
  log "Optional: load clients with database/clients-dml.sql if needed"
fi

log "Deploy complete"
docker compose "${COMPOSE_FILES[@]}" ps

cat <<'EOF'

[deploy-prod] Reminders:
  - Do NOT run: docker compose down -v
  - Do NOT re-run database/first-time-deployment-dml.sql on live production
  - Routine deploys: ./scripts/deploy-prod.sh only

EOF
