#!/usr/bin/env bash
# Build WFM Watch (WFM Control-M) production Docker images from WSL.
# Works with Docker Desktop when WSL integration is enabled, or via docker.exe on PATH.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Use docker.exe from Docker Desktop (works from WSL even before distro integration).
DOCKER="${DOCKER:-/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe}"
COMPOSE="${COMPOSE:-/mnt/c/Program Files/Docker/Docker/resources/bin/docker-compose.exe}"

if [[ ! -x "$DOCKER" ]]; then
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    DOCKER=docker
  else
    echo "ERROR: Docker not found."
    echo "Start Docker Desktop, or enable Settings → Resources → WSL Integration → Ubuntu"
    exit 1
  fi
fi

if ! "$DOCKER" info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon not running. Start Docker Desktop and retry."
  exit 1
fi

RELEASE_TAG="${RELEASE_TAG:-local-$(date +%Y%m%d)}"
REGISTRY="${REGISTRY:-wfmwatch}"

echo "==> Building backend: ${REGISTRY}/wfm-controlm-backend:${RELEASE_TAG}"
"$DOCKER" build -f backend/Dockerfile.prod \
  -t "${REGISTRY}/wfm-controlm-backend:${RELEASE_TAG}" \
  ./backend

echo "==> Building frontend: ${REGISTRY}/wfm-controlm-frontend:${RELEASE_TAG}"
"$DOCKER" build -f frontend/Dockerfile.prod \
  -t "${REGISTRY}/wfm-controlm-frontend:${RELEASE_TAG}" \
  ./frontend

echo ""
echo "==> Images built:"
"$DOCKER" images --format '  {{.Repository}}:{{.Tag}}  ({{.Size}})' \
  | grep -E "${REGISTRY}/wfm-controlm-(backend|frontend)" || true

echo ""
echo "Optional smoke test:"
echo "  $COMPOSE -f docker-compose.prod.yml up -d"
echo "  curl http://localhost:4005/health"
echo "  curl -I http://localhost:3005"
