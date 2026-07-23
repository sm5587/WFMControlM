#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/dotenv.sh
source "$SCRIPT_DIR/lib/dotenv.sh"

# Preflight checks for WFM Control-M Unix deployment.
# Usage:
#   ./scripts/preflight-unix.sh
#
# Optional env vars:
#   APP_DIR=...              # override; default is APP_DIR from .env
#   CHECK_DB2=true|false              # Java8/jjs + DB2 assets (default false)
#   CHECK_FRONTEND=true|false         # nginx/rsync for frontend serving (default true)
#   CHECK_RUNTIME=true|false          # DB content, SSH creds, AppConfig paths (default true)
#   REQUIRE_CONFIG_ENCRYPTION_KEY=true|false  # default false for sandbox install checks
#
# Install hints (Ubuntu/WSL):
#   sudo apt install -y nodejs npm sqlite3 nginx rsync curl build-essential
#   sudo apt install -y java-1.8.0-openjdk   # DB2 bridge (when CHECK_DB2=true)
#   npm install -g pm2

APP_DIR="$(resolve_app_dir "$SCRIPT_DIR")"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
CHECK_DB2="${CHECK_DB2:-false}"
CHECK_FRONTEND="${CHECK_FRONTEND:-true}"
CHECK_RUNTIME="${CHECK_RUNTIME:-true}"
REQUIRE_CONFIG_ENCRYPTION_KEY="${REQUIRE_CONFIG_ENCRYPTION_KEY:-false}"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf "[PASS] %s\n" "$*"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf "[FAIL] %s\n" "$*"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf "[WARN] %s\n" "$*"
}

section() {
  printf "\n=== %s ===\n" "$*"
}

cmd_exists() {
  command -v "$1" >/dev/null 2>&1
}

section "Host Context"
echo "Host: $(hostname)"
echo "User: $(whoami)"
echo "PWD : $(pwd)"

section "Repo Unix Compatibility Guard"
if [[ -f "$APP_DIR/scripts/validate-unix-compat.js" ]]; then
  if node "$APP_DIR/scripts/validate-unix-compat.js"; then
    pass "Unix compatibility validation passed"
  else
    fail "Unix compatibility validation failed (paths/scripts drift detected)"
  fi
else
  warn "validate-unix-compat.js not found; skipping compatibility guard"
fi

section "Required Toolchain"
for c in node npm python3 gcc g++ make unzip sqlite3 curl; do
  if cmd_exists "$c"; then
    pass "$c is installed"
  else
    fail "$c is missing (Ubuntu/WSL: sudo apt install -y $c)"
  fi
done

if [[ "$CHECK_FRONTEND" == "true" ]]; then
  for c in nginx rsync; do
    if cmd_exists "$c"; then
      pass "$c is installed (frontend serving)"
    else
      fail "$c is missing — required for nginx frontend mode (sudo apt install -y $c)"
    fi
  done
fi

if cmd_exists node; then
  NODE_V="$(node -v 2>/dev/null || true)"
  echo "node version: $NODE_V"
  if [[ "$NODE_V" =~ ^v18\. ]]; then
    pass "Node.js 18.x detected (recommended)"
  else
    warn "Node.js is not 18.x (current: $NODE_V)"
  fi
fi

if cmd_exists npm; then
  echo "npm version: $(npm -v 2>/dev/null || true)"
fi

section "Network Reachability"
if cmd_exists curl; then
  if curl -I --max-time 20 https://registry.npmjs.org/lodash >/dev/null 2>&1; then
    pass "Can reach npm registry"
  else
    fail "Cannot reach npm registry (https://registry.npmjs.org)"
  fi

  if curl -I --max-time 20 https://binaries.prisma.sh >/dev/null 2>&1; then
    pass "Can reach Prisma binaries host"
  else
    fail "Cannot reach Prisma binaries host (https://binaries.prisma.sh)"
  fi
else
  fail "curl not found (required for registry checks and health probes)"
fi

section "Application Path"
echo "APP_DIR: $APP_DIR"
if [[ -d "$APP_DIR" ]]; then
  pass "Application directory exists"
else
  fail "Application directory does not exist"
fi

if [[ -d "$APP_DIR" && -w "$APP_DIR" ]]; then
  pass "Application directory is writable"
else
  fail "Application directory is not writable"
fi

section "Environment File"
if [[ -f "$APP_DIR/.env" ]]; then
  pass ".env exists"
  if grep -q $'\r' "$APP_DIR/.env" 2>/dev/null; then
    fail ".env has Windows CRLF line endings (run: sed -i 's/\\r$//' .env)"
  else
    pass ".env uses Unix (LF) line endings"
  fi
  DB_URL="$(dotenv_read_database_url "$ENV_FILE" || true)"
  ENC_KEY="$(grep -E '^CONFIG_ENCRYPTION_KEY=' "$APP_DIR/.env" | head -n1 | cut -d'=' -f2- || true)"
  ENC_KEY="$(dotenv_clean "$ENC_KEY")"
  APP_DIR_CFG="$(dotenv_read_key "$ENV_FILE" APP_DIR || true)"

  if [[ -n "$APP_DIR_CFG" ]]; then
    pass "APP_DIR is set in .env ($APP_DIR_CFG)"
  else
    warn "APP_DIR not set in .env (resolved to: $APP_DIR)"
  fi

  if [[ -n "$DB_URL" ]]; then
    pass "DATABASE_URL is set ($DB_URL)"
    if [[ "$DB_URL" == file:* ]]; then
      REL_CHECK="${DB_URL#file:}"
      if [[ "$REL_CHECK" =~ ^[A-Za-z]:[/\\] || "$REL_CHECK" == *'\'* ]]; then
        fail "DATABASE_URL uses a Windows path ($REL_CHECK) — use file:./dev.db (relative to backend/prisma/) on WSL/Unix"
      fi
    fi
  else
    fail "DATABASE_URL missing in .env"
  fi

  if [[ -n "$ENC_KEY" ]]; then
    pass "CONFIG_ENCRYPTION_KEY is set"
  else
    if [[ "$REQUIRE_CONFIG_ENCRYPTION_KEY" == "true" ]]; then
      fail "CONFIG_ENCRYPTION_KEY missing in .env (required by REQUIRE_CONFIG_ENCRYPTION_KEY=true)"
    else
      warn "CONFIG_ENCRYPTION_KEY missing in .env (allowed for sandbox install check)"
    fi
  fi
else
  fail ".env missing in APP_DIR"
fi

section "Database Path & Readiness"
if [[ -n "${DB_URL:-}" ]]; then
  if [[ "$DB_URL" == file:* ]]; then
    REL_DB_PATH="${DB_URL#file:}"
    if [[ "$REL_DB_PATH" == /* ]]; then
      DB_PATH="$REL_DB_PATH"
    else
      DB_PATH="$(resolve_sqlite_db_path "$APP_DIR" "$DB_URL")"
    fi

    echo "Resolved DB path: $DB_PATH"
    if [[ -f "$DB_PATH" ]]; then
      pass "SQLite DB file exists"
      DB_SIZE_BYTES="$(wc -c < "$DB_PATH" 2>/dev/null || echo 0)"
      if [[ "${DB_SIZE_BYTES:-0}" -gt 0 ]]; then
        pass "SQLite DB file is non-empty (${DB_SIZE_BYTES} bytes)"
      else
        fail "SQLite DB file is empty (${DB_SIZE_BYTES} bytes)"
      fi

      if cmd_exists sqlite3; then
        APP_CONFIG_COUNT="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM AppConfig;" 2>/dev/null || true)"
        if [[ "$APP_CONFIG_COUNT" =~ ^[0-9]+$ ]]; then
          pass "AppConfig table present (rows: $APP_CONFIG_COUNT)"
        else
          fail "AppConfig table missing (DB bootstrap likely not applied — run: npm run db:bootstrap)"
        fi
      else
        fail "sqlite3 not found (required for DB validation — sudo apt install -y sqlite3)"
      fi
    else
      fail "SQLite DB file not found at resolved path"
    fi
  else
    warn "DATABASE_URL is non-sqlite ($DB_URL); sqlite file checks skipped"
  fi
fi

section "Backend Runtime Readiness"
if [[ -f "$APP_DIR/backend/dist/index.js" ]]; then
  pass "Backend build artifact exists (backend/dist/index.js)"
else
  fail "Backend build artifact missing (run npm run build)"
fi

if [[ -d "$APP_DIR/backend/node_modules/.prisma/client" ]]; then
  pass "Prisma client generated (backend/node_modules/.prisma/client)"
else
  warn "Prisma client not generated (run: npm --prefix backend run prisma:generate)"
fi

if [[ -f "$APP_DIR/backend/package.json" ]] && grep -q '"@noble/hashes"' "$APP_DIR/backend/package.json" 2>/dev/null; then
  pass "backend/package.json pins @noble/hashes override (otplib Linux compat)"
else
  warn "backend/package.json missing @noble/hashes override — backend may fail on Linux with ERR_REQUIRE_ESM"
fi

if cmd_exists pm2; then
  pass "pm2 is installed"
else
  warn "pm2 not found (install with: npm install -g pm2, or use systemd)"
fi

section "Frontend Runtime Readiness"
if [[ -d "$APP_DIR/frontend" ]]; then
  pass "Frontend directory exists"
else
  fail "Frontend directory missing"
fi

if [[ -f "$APP_DIR/frontend/package.json" ]]; then
  pass "frontend/package.json exists"
else
  fail "frontend/package.json missing"
fi

if [[ -d "$APP_DIR/frontend/node_modules" ]]; then
  pass "Frontend dependencies directory exists (frontend/node_modules)"
else
  warn "frontend/node_modules missing (run npm --prefix \"$APP_DIR/frontend\" install)"
fi

if [[ -f "$APP_DIR/frontend/dist/index.html" ]]; then
  pass "Frontend build artifact exists (frontend/dist/index.html)"
else
  warn "Frontend build artifact missing (run npm run build:frontend)"
fi

section "Frontend Serving (nginx mode)"
if [[ "$CHECK_FRONTEND" == "true" ]]; then
  if cmd_exists nginx; then
    if nginx -t >/dev/null 2>&1; then
      pass "nginx configuration test passed (nginx -t)"
    else
      warn "nginx -t failed — fix /etc/nginx config before reload"
    fi
    if cmd_exists systemctl && systemctl is-active nginx >/dev/null 2>&1; then
      pass "nginx service is active"
    elif cmd_exists service && service nginx status >/dev/null 2>&1; then
      pass "nginx service is running"
    else
      warn "nginx installed but service may not be running (sudo systemctl start nginx)"
    fi
  fi

  NGINX_WEB_ROOT="${NGINX_WEB_ROOT:-/var/www/wfmwatch}"
  echo "NGINX_WEB_ROOT: $NGINX_WEB_ROOT"
  if [[ -d "$NGINX_WEB_ROOT" ]]; then
    pass "NGINX_WEB_ROOT directory exists"
    if [[ -w "$NGINX_WEB_ROOT" ]]; then
      pass "NGINX_WEB_ROOT is writable by current user"
    else
      warn "NGINX_WEB_ROOT not writable — start-frontend-unix.sh uses sudo rsync (expected on WSL/production)"
    fi
  else
    warn "NGINX_WEB_ROOT missing — start-frontend-unix.sh will create via sudo (sudo mkdir -p $NGINX_WEB_ROOT)"
  fi

  if grep -qi microsoft /proc/version 2>/dev/null; then
    warn "WSL detected: nginx serves from $NGINX_WEB_ROOT, not ~/... (www-data cannot read home dirs)"
  fi
else
  echo "(skipped — CHECK_FRONTEND=false)"
fi

if cmd_exists docker; then
  pass "docker is installed (optional docker frontend mode)"
else
  echo "(docker not installed — optional for docker frontend mode)"
fi

section "Database Seeds & Client Inventory"
if [[ -f "$APP_DIR/database/clients-dml.sql" ]]; then
  pass "database/clients-dml.sql present"
else
  fail "database/clients-dml.sql missing (client list will be empty after bootstrap)"
fi

if [[ -f "$APP_DIR/database/fix-client-datetimes.sql" ]]; then
  pass "database/fix-client-datetimes.sql present (Linux DateTime repair)"
else
  warn "database/fix-client-datetimes.sql missing"
fi

if [[ "$CHECK_RUNTIME" == "true" && -n "${DB_PATH:-}" && -f "${DB_PATH:-}" ]] && cmd_exists sqlite3; then
  CLIENT_COUNT="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Client;" 2>/dev/null || echo "")"
  ACTIVE_CLIENT_COUNT="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Client WHERE isActive=1;" 2>/dev/null || echo "")"
  if [[ "$CLIENT_COUNT" =~ ^[0-9]+$ && "$CLIENT_COUNT" -gt 0 ]]; then
    pass "Client inventory loaded ($CLIENT_COUNT total, ${ACTIVE_CLIENT_COUNT:-?} active)"
  else
    fail "No clients in DB — run: npm run db:bootstrap:clients  (or sqlite3 ... < database/clients-dml.sql)"
  fi

  TEXT_DT_COUNT="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM Client WHERE typeof(updatedAt)='text';" 2>/dev/null || echo "")"
  if [[ "$TEXT_DT_COUNT" =~ ^[0-9]+$ && "$TEXT_DT_COUNT" -eq 0 ]]; then
    pass "Client DateTime columns use integer ms (Prisma Linux compatible)"
  elif [[ "$TEXT_DT_COUNT" =~ ^[0-9]+$ && "$TEXT_DT_COUNT" -gt 0 ]]; then
    fail "Client DateTime stored as TEXT ($TEXT_DT_COUNT rows) — Clients page/API will 500 on Linux; run: sqlite3 \"$DB_PATH\" < database/fix-client-datetimes.sql"
  else
    warn "Could not verify Client DateTime column types"
  fi
else
  echo "(skipped — no DB file or CHECK_RUNTIME=false)"
fi

section "SSH Credentials (cron sync / appserver)"
if [[ "$CHECK_RUNTIME" == "true" && -n "${DB_PATH:-}" && -f "${DB_PATH:-}" ]] && cmd_exists sqlite3; then
  SSH_USER_LEN="$(sqlite3 "$DB_PATH" "SELECT length(COALESCE(value,'')) FROM AppConfig WHERE key='secrets.sshUsername';" 2>/dev/null || echo 0)"
  SSH_PASS_LEN="$(sqlite3 "$DB_PATH" "SELECT length(COALESCE(value,'')) FROM AppConfig WHERE key='secrets.sshPassword';" 2>/dev/null || echo 0)"

  if [[ "$SSH_USER_LEN" =~ ^[0-9]+$ && "$SSH_PASS_LEN" =~ ^[0-9]+$ && "$SSH_USER_LEN" -gt 0 && "$SSH_PASS_LEN" -gt 0 ]]; then
    pass "SSH credentials configured in AppConfig (secrets.sshUsername + secrets.sshPassword)"
  elif [[ -f "$APP_DIR/.saved_credentials.json" ]]; then
    export APP_DIR
    if python3 - <<'PY' >/dev/null 2>&1
import json, os, sys
p = os.path.join(os.environ["APP_DIR"], ".saved_credentials.json")
with open(p, encoding="utf-8-sig") as f:
    raw = json.load(f)
mode = (raw.get("credential_mode") or "service").lower()
if mode == "personal" and raw.get("personal_username"):
    ok = bool(raw.get("personal_password"))
else:
    ok = bool(raw.get("password"))
sys.exit(0 if ok else 1)
PY
    then
      pass ".saved_credentials.json has a password field (fallback SSH creds)"
    else
      fail "SSH credentials missing — set Admin → Config (SSH Username/Password) or add password to .saved_credentials.json (cron sync will fail)"
    fi
  else
    fail "SSH credentials not configured — set secrets.sshUsername + secrets.sshPassword in Admin → Config (required for cron sync from appservers)"
  fi
else
  echo "(skipped — no DB file or CHECK_RUNTIME=false)"
fi

section "AppConfig Unix Infra Paths"
if [[ "$CHECK_RUNTIME" == "true" && -n "${DB_PATH:-}" && -f "${DB_PATH:-}" ]] && cmd_exists sqlite3; then
  for key in infra.db2JjsPath infra.db2LibDir infra.db2ConnDir; do
    VAL="$(sqlite3 "$DB_PATH" "SELECT COALESCE(value,'') FROM AppConfig WHERE key='${key}';" 2>/dev/null || true)"
    if [[ -z "$VAL" ]]; then
      warn "$key is empty (configure via Admin → Config or setup-db.sh)"
      continue
    fi
    if [[ "$VAL" == *'\'* || "$VAL" =~ ^[A-Za-z]: ]]; then
      fail "$key contains a Windows path ($VAL) — use Unix paths on WSL/Linux"
    elif [[ "$key" == "infra.db2JjsPath" && ! -x "$VAL" && "$VAL" != "jjs" ]]; then
      warn "$key points to missing/non-executable path: $VAL"
    elif [[ "$key" == "infra.db2LibDir" && ! -d "$VAL" ]]; then
      warn "$key directory not found: $VAL"
    else
      pass "$key looks valid ($VAL)"
    fi
  done

  CORS_ORIGINS="$(sqlite3 "$DB_PATH" "SELECT COALESCE(value,'') FROM AppConfig WHERE key='infra.corsOrigins';" 2>/dev/null || true)"
  if [[ -n "$CORS_ORIGINS" ]]; then
    pass "infra.corsOrigins is set ($CORS_ORIGINS)"
  else
    warn "infra.corsOrigins empty — run start-frontend-unix.sh to set CORS for your frontend URL"
  fi
else
  echo "(skipped — no DB file or CHECK_RUNTIME=false)"
fi

section "Ports"
if cmd_exists ss; then
  LISTEN="$(ss -ltnp 2>/dev/null | egrep ':3005|:4005' || true)"
  if [[ -n "$LISTEN" ]]; then
    warn "Ports 3005/4005 currently in use:"
    echo "$LISTEN"
  else
    pass "Ports 3005 and 4005 are not currently listening"
  fi
else
  warn "'ss' command not available; skipped port check"
fi

if [[ "$CHECK_DB2" == "true" ]]; then
  section "DB2 Optional Checks (CHECK_DB2=true)"
  if cmd_exists java; then
    JAVA_VER="$(java -version 2>&1 | head -n1)"
    echo "java: $JAVA_VER"
    if echo "$JAVA_VER" | grep -E '1\.8|\"8' >/dev/null 2>&1; then
      pass "Java 8 detected"
    else
      warn "Java 8 not detected (DB2 bridge expects Java 8/jjs)"
    fi
  else
    fail "java not found (required for DB2 features)"
  fi

  if cmd_exists jjs; then
    pass "jjs found"
  else
    fail "jjs not found (required for DB2 features)"
  fi

  if [[ -f "$APP_DIR/lib/DB2Connector.js" ]]; then
    pass "lib/DB2Connector.js found"
  else
    fail "lib/DB2Connector.js missing"
  fi

  if [[ -f "$APP_DIR/lib/db2jcc4.jar" ]]; then
    pass "lib/db2jcc4.jar found"
  else
    fail "lib/db2jcc4.jar missing"
  fi

  if [[ -d "$APP_DIR/dbconnections/Production" ]]; then
    pass "dbconnections/Production directory exists"
  else
    fail "dbconnections/Production directory missing"
  fi

  if [[ -n "${DB_PATH:-}" && -f "${DB_PATH:-}" ]] && cmd_exists sqlite3; then
    CFG_JJS="$(sqlite3 "$DB_PATH" "SELECT COALESCE(value,'') FROM AppConfig WHERE key='infra.db2JjsPath';" 2>/dev/null || true)"
    if [[ -n "$CFG_JJS" && ( -x "$CFG_JJS" || "$CFG_JJS" == "jjs" ) ]]; then
      pass "AppConfig infra.db2JjsPath resolves for DB2 ($CFG_JJS)"
    elif [[ -n "$CFG_JJS" ]]; then
      fail "AppConfig infra.db2JjsPath not executable: $CFG_JJS (cron/DB2 will fail — set to: $(command -v jjs 2>/dev/null || echo /usr/bin/jjs))"
    fi
  fi
fi

section "Summary"
echo "PASS: $PASS_COUNT"
echo "WARN: $WARN_COUNT"
echo "FAIL: $FAIL_COUNT"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "[preflight] FAILED — fix failed checks before deploy."
  echo ""
  echo "Common fixes:"
  echo "  sudo apt install -y nodejs npm sqlite3 nginx rsync curl build-essential java-1.8.0-openjdk"
  echo "  npm run install:all && npm run build && npm --prefix backend run prisma:generate"
  echo "  npm run db:bootstrap          # schema + config + clients"
  echo "  bash ./scripts/start-app-unix.sh && bash ./scripts/start-frontend-unix.sh"
  exit 1
fi

echo "[preflight] OK — ready for deploy-unix.sh"
exit 0

