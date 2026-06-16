#!/usr/bin/env bash
set -u

# Preflight checks for WFM Control-M Unix deployment.
# Usage:
#   ./scripts/preflight-unix.sh
#   APP_DIR=/application/wfmwatch ./scripts/preflight-unix.sh
#
# Optional env vars:
#   APP_DIR=/application/wfmwatch
#   CHECK_DB2=true|false   # when true, enforce Java8/jjs + DB2 assets checks
#   REQUIRE_CONFIG_ENCRYPTION_KEY=true|false  # default false for sandbox install checks

APP_DIR="${APP_DIR:-/application/wfmwatch}"
CHECK_DB2="${CHECK_DB2:-false}"
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

section "Required Toolchain"
for c in node npm python3 gcc g++ make unzip; do
  if cmd_exists "$c"; then
    pass "$c is installed"
  else
    fail "$c is missing"
  fi
done

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
else
  warn "curl not found; cannot verify npm registry reachability"
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
  DB_URL="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env" | head -n1 | cut -d'=' -f2- || true)"
  ENC_KEY="$(grep -E '^CONFIG_ENCRYPTION_KEY=' "$APP_DIR/.env" | head -n1 | cut -d'=' -f2- || true)"
  DB_URL="${DB_URL%\"}"; DB_URL="${DB_URL#\"}"
  ENC_KEY="${ENC_KEY%\"}"; ENC_KEY="${ENC_KEY#\"}"

  if [[ -n "$DB_URL" ]]; then
    pass "DATABASE_URL is set ($DB_URL)"
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

section "Ports"
if cmd_exists ss; then
  LISTEN="$(ss -ltnp 2>/dev/null | egrep ':3000|:4000' || true)"
  if [[ -n "$LISTEN" ]]; then
    warn "Ports 3000/4000 currently in use:"
    echo "$LISTEN"
  else
    pass "Ports 3000 and 4000 are not currently listening"
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
fi

section "Summary"
echo "PASS: $PASS_COUNT"
echo "WARN: $WARN_COUNT"
echo "FAIL: $FAIL_COUNT"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  echo "[preflight] FAILED — fix failed checks before deploy."
  exit 1
fi

echo "[preflight] OK — ready for deploy-unix.sh"
exit 0

