# Docker Install Steps (Build Here, Deploy on Unix)

This runbook is for your exact workflow:
- Build production images on this machine
- Push to container registry
- Pull and run on Unix host

---

## 1) Files used

- `backend/Dockerfile.prod`
- `frontend/Dockerfile.prod`
- `docker-compose.prod.yml` (build-capable production compose)
- `docker-compose.registry.yml` (registry-ready override: pull prebuilt images, no local build)

---

## 2) One-time prerequisites

### Build machine

- Docker Desktop/Engine with Compose v2
- Access to your registry (Docker Hub / ECR / ACR / GCR / Harbor)
- Repo checked out at root:

```bash
cd /path/to/WFMControlM
```

### Unix deployment host

- Docker Engine + Compose plugin
- `.env` file present in deploy folder
- Open ports:
  - `3000` for frontend
  - `4000` for backend (if directly reachable)

---

## 3) Prepare release tag (important)

Use immutable image tags. Avoid reusing `latest` in production.

```bash
# Example release tag format
export RELEASE_TAG="1.0.0-20260619-1"
export REGISTRY="your-registry.example.com/your-namespace"
```

Examples:
- Docker Hub: `REGISTRY=docker.io/youruser`
- ACR: `REGISTRY=<name>.azurecr.io`
- ECR: `REGISTRY=<acct>.dkr.ecr.<region>.amazonaws.com`

---

## 4) Build production images on this machine

```bash
# Backend
docker build -f backend/Dockerfile.prod -t "$REGISTRY/wfm-controlm-backend:$RELEASE_TAG" ./backend

# Frontend
docker build -f frontend/Dockerfile.prod -t "$REGISTRY/wfm-controlm-frontend:$RELEASE_TAG" ./frontend
```

Optional local smoke test:

```bash
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml ps
curl http://localhost:4000/health
curl -I http://localhost:3000
docker compose -f docker-compose.prod.yml down
```

---

## 5) Push images to registry

```bash
docker login <your-registry-host>

docker push "$REGISTRY/wfm-controlm-backend:$RELEASE_TAG"
docker push "$REGISTRY/wfm-controlm-frontend:$RELEASE_TAG"
```

Record digests (recommended for audit/rollback):

```bash
docker inspect --format='{{index .RepoDigests 0}}' "$REGISTRY/wfm-controlm-backend:$RELEASE_TAG"
docker inspect --format='{{index .RepoDigests 0}}' "$REGISTRY/wfm-controlm-frontend:$RELEASE_TAG"
```

---

## 6) Deploy on Unix host (registry-based)

### 6.1 Get source and set environment

```bash
sudo mkdir -p /application/wfmwatch
sudo chown "$USER":"$USER" /application/wfmwatch
cd /application/wfmwatch

# pull latest compose/docs/scripts
git pull --rebase

# create .env once (if missing)
cp -n .env.example .env
vi .env
```

Required in `.env`:
- `DATABASE_URL=file:./dev.db`
- `CONFIG_ENCRYPTION_KEY=<64-char-hex>`
- `REGISTRY=...`
- `RELEASE_TAG=...`

### 6.2 Pull and run images

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml pull
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml up -d
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml ps
```

### 6.3 First-time DB bootstrap only

Run once for fresh environment:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml exec backend node scripts/apply-sql.js ../database/ddl.sql
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml exec backend node scripts/apply-sql.js ../database/dml.sql
```

---

## 7) Verification checks

```bash
curl http://localhost:4000/health
curl -I http://localhost:3000
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml logs --tail=200 backend
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml logs --tail=200 frontend
```

---

## 8) Routine upgrade flow

On build machine:
1. Build new tag
2. Push new tag

On Unix host:

```bash
cd /application/wfmwatch
# update RELEASE_TAG in .env to new value
vi .env

docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml pull
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml up -d
```

---

## 9) Rollback flow

1. Edit `.env` and set previous known-good `RELEASE_TAG`
2. Re-pull and restart:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml pull
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml up -d
```

This is why immutable tags are critical: rollback becomes a 1-line tag change.

---

## 10) Why registry-ready compose override helps

`docker-compose.registry.yml` helps because it:

1. **Removes local build dependency on Unix host**
   - Unix host only pulls and runs already-tested images.
2. **Makes deployments deterministic**
   - Same immutable tag across all environments.
3. **Enables simple rollback**
   - Change `RELEASE_TAG` back and redeploy.
4. **Improves security and ops control**
   - Build environment and runtime environment are separated.
5. **Speeds up production deploys**
   - No compile/build step on server.

Use pattern:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.registry.yml up -d
```

Base file keeps runtime settings, volumes, healthchecks.
Override file switches service images to registry tags and disables local build.
