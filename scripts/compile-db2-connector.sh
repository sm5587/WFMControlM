#!/usr/bin/env sh
# Compile lib/DB2Connector.java → lib/DB2Connector.class (requires JDK 11+).
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$ROOT/lib"
JAR="$LIB/db2jcc4.jar"
SRC="$LIB/DB2Connector.java"

if [ ! -f "$JAR" ]; then
  echo "ERROR: $JAR not found" >&2
  exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "ERROR: $SRC not found" >&2
  exit 1
fi
if ! command -v javac >/dev/null 2>&1; then
  echo "ERROR: javac not found — install JDK 17+" >&2
  exit 1
fi

javac --release 17 -cp "$JAR" -d "$LIB" "$SRC"
echo "Compiled $LIB/DB2Connector.class"
