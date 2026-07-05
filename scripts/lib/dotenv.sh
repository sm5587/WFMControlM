#!/usr/bin/env bash
# Shared helpers for parsing .env values in Unix deploy scripts.

# Remove quotes and Windows CRLF artifacts (common when .env is edited on Windows).
dotenv_clean() {
  local val="$1"
  val="${val%\"}"
  val="${val#\"}"
  val="${val//$'\r'/}"
  printf '%s' "$val"
}

# Expand ~ in paths (e.g. ~/projects/wfmwatch).
dotenv_expand_path() {
  local p
  p="$(dotenv_clean "$1")"
  if [[ "$p" == "~" ]]; then
    printf '%s' "$HOME"
  elif [[ "$p" == "~/"* ]]; then
    printf '%s' "$HOME/${p#~/}"
  else
    printf '%s' "$p"
  fi
}

# Read any KEY=value from a .env file. Prints cleaned value to stdout.
dotenv_read_key() {
  local env_file="$1"
  local key="$2"
  local line
  line="$(grep -E "^${key}=" "$env_file" 2>/dev/null | head -n1 || true)"
  if [[ -z "$line" ]]; then
    return 1
  fi
  dotenv_clean "${line#${key}=}"
}

# Parse DATABASE_URL from a .env file path. Prints cleaned value to stdout.
dotenv_read_database_url() {
  dotenv_read_key "$1" DATABASE_URL
}

# Find repo root (directory containing package.json and backend/).
find_repo_root() {
  local dir="${1:-}"
  [[ -z "$dir" ]] && return 1
  dir="$(cd "$dir" 2>/dev/null && pwd)" || return 1
  while [[ "$dir" != "/" ]]; do
    if [[ -f "$dir/package.json" && -d "$dir/backend" ]]; then
      printf '%s' "$dir"
      return 0
    fi
    dir="$(dirname "$dir")"
  done
  return 1
}

# Resolve APP_DIR — single source of truth for Unix scripts.
#
# Priority:
#   1. APP_DIR exported in the shell (override)
#   2. APP_DIR in repo .env (canonical; set once per host)
#   3. Repo root when .env exists but APP_DIR is unset
#   4. /application/wfmwatch when that directory exists
#   5. Repo root discovered from cwd or scripts_dir/..
#
# Usage: APP_DIR="$(resolve_app_dir "$SCRIPT_DIR")"
resolve_app_dir() {
  local scripts_dir="${1:-}"
  local repo_root candidate env_file app_dir_from_file

  if [[ -n "${APP_DIR:-}" ]]; then
    dotenv_expand_path "$APP_DIR"
    return 0
  fi

  for candidate in "$(find_repo_root "$(pwd)")" "$(find_repo_root "${scripts_dir}/..")"; do
    [[ -z "$candidate" ]] && continue
    env_file="$candidate/.env"
    if [[ -f "$env_file" ]]; then
      app_dir_from_file="$(dotenv_read_key "$env_file" APP_DIR || true)"
      if [[ -n "$app_dir_from_file" ]]; then
        dotenv_expand_path "$app_dir_from_file"
        return 0
      fi
      printf '%s' "$candidate"
      return 0
    fi
  done

  if [[ -d "/application/wfmwatch" ]]; then
    printf '%s' "/application/wfmwatch"
    return 0
  fi

  repo_root="$(find_repo_root "$(pwd)")"
  [[ -z "$repo_root" ]] && repo_root="$(find_repo_root "${scripts_dir}/..")"
  if [[ -n "$repo_root" ]]; then
    printf '%s' "$repo_root"
    return 0
  fi

  echo "[dotenv] Cannot resolve APP_DIR. Set APP_DIR in .env or export APP_DIR." >&2
  return 1
}

# Resolve SQLite file path the same way Prisma does (relative to backend/prisma/schema.prisma).
resolve_sqlite_db_path() {
  local app_dir="$1"
  local db_url_value="$2"
  local rel="${db_url_value#file:}"

  if [[ "$rel" == /* ]]; then
    printf '%s' "$rel"
    return
  fi

  printf '%s' "$app_dir/backend/prisma/${rel#./}"
}

# Apply client inventory SQL (database/clients-dml.sql).
apply_clients_dml_sql() {
  local app_dir="$1"
  local db_path="$2"
  local clients_sql="$app_dir/database/clients-dml.sql"

  if [[ -f "$clients_sql" ]]; then
    sqlite3 "$db_path" < "$clients_sql"
    printf '[db-bootstrap] Applied client inventory: %s\n' "$clients_sql"
    local fix_sql="$app_dir/database/fix-client-datetimes.sql"
    if [[ -f "$fix_sql" ]]; then
      sqlite3 "$db_path" < "$fix_sql"
      printf '[db-bootstrap] Normalized Client/AppServer DateTime columns to integer ms\n'
    fi
  else
    printf '[db-bootstrap] WARNING: %s not found; skipping client inventory\n' "$clients_sql" >&2
  fi
}

# Set Unix infra paths in AppConfig when values are still empty.
configure_unix_infra_paths() {
  local app_dir="$1"
  local db_path="$2"
  local lib_dir jjs_path conn_dir

  lib_dir="$app_dir/lib"
  if [[ -d "$lib_dir" ]]; then
    sqlite3 "$db_path" "UPDATE AppConfig SET value='${lib_dir}', updatedAt=CURRENT_TIMESTAMP WHERE key='infra.db2LibDir' AND (COALESCE(value,'')='' OR value LIKE 'C:%' OR value LIKE 'c:%' OR value LIKE '%\\\\%');"
  fi

  conn_dir="$app_dir/dbconnections/Production"
  if [[ -d "$conn_dir" ]]; then
    sqlite3 "$db_path" "UPDATE AppConfig SET value='${conn_dir}', updatedAt=CURRENT_TIMESTAMP WHERE key='infra.db2ConnDir' AND (COALESCE(value,'')='' OR value LIKE 'C:%' OR value LIKE 'c:%' OR value LIKE '%\\\\%');"
  fi

  if command -v jjs >/dev/null 2>&1; then
    jjs_path="$(command -v jjs)"
    sqlite3 "$db_path" "UPDATE AppConfig SET value='${jjs_path}', updatedAt=CURRENT_TIMESTAMP WHERE key='infra.db2JjsPath' AND (COALESCE(value,'')='' OR value LIKE 'C:%' OR value LIKE 'c:%' OR value LIKE '%\\\\%');"
    printf '[db-bootstrap] Set infra.db2JjsPath=%s\n' "$jjs_path"
  else
    printf '[db-bootstrap] WARNING: jjs not found on PATH — install Java 8 OpenJDK (DB2 bridge requires jjs)\n' >&2
  fi
}
