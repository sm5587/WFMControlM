# WFM Control-M — Unix Deployment Guide

Install and run WFM Control-M on Linux from a **git clone**. The app uses **SQLite** (via Prisma), **Node.js 18+**, and a React frontend. Full WFM monitoring (DB2 batch status, RFX queue, SSH cron sync) additionally requires **Java 8 with Nashorn (`jjs`)** and client connection assets.

See also:

- [production-readiness-checklist.md](production-readiness-checklist.md) — go-live checklist
- [dbextract.md](dbextract.md) — regenerate `database/ddl.sql` / `dml.sql`

---

## Getting the code (git — recommended)

**Do not copy the entire Windows workspace** (e.g. `scp -r` of a dev folder with `node_modules`). That folder can contain **25k+ files**, mostly generated artifacts you should recreate on Unix.

| Source | Typical size | Use on Unix? |
| ------ | ------------ | ------------ |
| **Git clone** | ~few hundred tracked source files | **Yes — preferred** |
| **`npm install`** | ~15k–25k files in `node_modules/` | **Yes — run on the server** |
| Windows `node_modules/`, `*.log`, local `dev.db` | large, machine-specific | **No — exclude** |

```bash
# On the Unix host
sudo mkdir -p /opt/wfm-controlm
sudo chown $USER:$USER /opt/wfm-controlm
git clone <your-repo-url> /opt/wfm-controlm
cd /opt/wfm-controlm
```

If git is unavailable, transfer **source only** (exclude `node_modules/`, `dist/`, `*.log`, `backend/prisma/dev.db`):

```bash
rsync -av --exclude node_modules --exclude dist --exclude '*.log' \
  --exclude backend/prisma/dev.db \
  ./WFMControlM/ user@unix-box:/opt/wfm-controlm/
```

---

## What to install on Unix

### Tier 1 — App UI + API (minimum)

| Software | Version | Purpose |
| -------- | ------- | ------- |
| **Git** | recent | Clone repository |
| **Node.js** | **18 LTS+** | Backend runtime + frontend build |

### Tier 2 — Docker deployment (recommended)

| Software | Version | Purpose |
| -------- | ------- | ------- |
| **Docker Engine** | 20+ | Run containers |
| **Docker Compose** | v2 | Orchestrate API + UI (+ Mailpit) |

### Tier 3 — Bare metal (no Docker)

| Software | Version | Purpose |
| -------- | ------- | ------- |
| **Node.js** | 18 LTS+ | Backend + build |
| **Nginx** | latest | Serve frontend SPA + reverse proxy to API |
| **gcc, g++, make, python3** | — | Native npm modules (`ssh2`, etc.) compile on install |
| **PM2** or **systemd** | — | Keep backend running in production |

### Tier 4 — Full WFM features (DB Monitor, DB Jobs, cron sync)

Required **on the host** (or mounted into a custom image). The stock Dockerfiles do **not** include Java.

| Software / asset | Purpose |
| ---------------- | ------- |
| **Java 8 JRE** with **`jjs`** (Nashorn) | DB2 queries via `lib/DB2Connector.js` — **not** Java 11+ (Nashorn removed) |
| **`lib/DB2Connector.js`** + **`lib/db2jcc4.jar`** | JDBC bridge to client DB2 databases |
| **`dbconnections/Production/*_DBString.txt`** | Per-client DB2 connection files |
| **Network access** | Reach client DB2 hosts and app servers (SSH port 22) |
| **AppConfig** (Admin → Config) | Set `infra.db2LibDir`, `infra.db2JjsPath`, `infra.db2ConnDir`, SSH/SMTP secrets |

> **Note:** DB2 access in this project uses the **Java/jjs bridge**, not the `ibm_db` npm package. You do **not** need the IBM DB2 ODBC CLI driver unless you add separate tooling.

Example Java 8 on RHEL/CentOS (adjust for your distro):

```bash
# OpenJDK 8 — verify jjs exists: /usr/lib/jvm/java-1.8.0-openjdk/bin/jjs
sudo yum install -y java-1.8.0-openjdk
jjs -version   # must succeed
```

Then set in **Admin → Config** (or `AppConfig` rows after bootstrap):

| Key | Example (Unix) |
| --- | -------------- |
| `infra.db2LibDir` | `/opt/wfm-controlm/lib` |
| `infra.db2JjsPath` | `/usr/lib/jvm/java-1.8.0-openjdk/bin/jjs` |
| `infra.db2ConnDir` | `/opt/wfm-controlm/dbconnections/Production` |

---

## Option 1: Docker (recommended for UI + API)

Includes `docker-compose.yml`, backend `Dockerfile`, and frontend `Dockerfile`.

### Prerequisites (RHEL / CentOS / Amazon Linux)

```bash
sudo yum install -y git
# Docker — use your distro's Docker CE / podman-compose docs
sudo yum install -y docker-ce docker-compose-plugin
sudo systemctl enable --now docker
```

### Deploy

```bash
cd /opt/wfm-controlm

# 1. Bootstrap environment
cp .env.example .env
vi .env
# Required:
#   DATABASE_URL=file:./dev.db
#   CONFIG_ENCRYPTION_KEY=<64-char hex>
# Generate key:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. Build and start
docker compose up -d --build

# 3. Verify
docker compose ps
curl http://localhost:4000/health     # backend health
curl -I http://localhost:3000         # frontend
```

### What gets launched

| Container | Port | Purpose |
| --------- | ---- | ------- |
| `wfm-controlm-api` | 4000 | Express backend (SQLite) |
| `wfm-controlm-ui` | 3000 | React frontend (Nginx) |
| `wfm-mailpit` | 1025 / 8025 | Local SMTP catcher (optional, for email testing) |

### Database bootstrap (first install)

The backend container runs `prisma migrate deploy` on startup. For reference data (RBAC, AppConfig defaults), run **once**:

```bash
# Option A — consolidated SQL (production-style)
docker compose exec backend node scripts/apply-sql.js ../database/ddl.sql
docker compose exec backend node scripts/apply-sql.js ../database/dml.sql

# Option B — Prisma seed (dev-style, includes sample clients if seed data present)
docker compose exec backend npx prisma db seed
```

Regenerate SQL from schema/DB before packaging a release: see [dbextract.md](dbextract.md) (`npm run db:extract`).

### SQLite persistence in Docker

The SQLite file lives inside the container by default. Mount a volume on `/app/prisma` (or your `DATABASE_URL` path) if you need the DB to survive image rebuilds.

### DB2 / SSH in Docker

The stock backend image is **Node 18 Alpine only** — no Java, no `jjs`. For DB Monitor and DB Jobs:

- Install Java 8 + mount `lib/` and `dbconnections/` into the container, **or**
- Run **bare metal** for the backend on a host that has Java and network access to client systems.

---

## Option 2: Bare metal (no Docker)

### Install system packages (RHEL / CentOS / Amazon Linux)

```bash
# Node.js 18
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Build tools for native npm modules (ssh2)
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3 git

# Nginx
sudo yum install -y nginx
sudo systemctl enable --now nginx

# Java 8 + jjs (required for DB2 features — see Tier 4 above)
sudo yum install -y java-1.8.0-openjdk
```

### Build and deploy

```bash
cd /opt/wfm-controlm

# 1. Bootstrap environment
cp .env.example .env
vi .env
# Required:
#   DATABASE_URL=file:./dev.db
#   CONFIG_ENCRYPTION_KEY=<64-char hex>
# Runtime settings (SMTP, JWT, DB2 paths, etc.) → AppConfig in DB after bootstrap.

# 2. Install dependencies and build
npm run install:all          # root + backend + frontend (creates node_modules — normal)
npm run build                # backend/dist + frontend/dist

# 3. Database
cd backend
npx prisma migrate deploy
cd ..
npm run db:bootstrap         # database/ddl.sql + dml.sql (RBAC, AppConfig, pools)
# OR: npm run db:seed        # dev seed with sample clients (optional)

# 4. Nginx — serve frontend, proxy API to backend
sudo cp frontend/nginx.conf /etc/nginx/conf.d/wfm-controlm.conf
# Replace Docker hostname with localhost for bare metal:
sudo sed -i 's/backend:4000/localhost:4000/g' /etc/nginx/conf.d/wfm-controlm.conf
sudo nginx -t && sudo systemctl reload nginx

# 5. Start backend (PM2)
npm install -g pm2
cd backend
pm2 start dist/index.js --name wfm-backend
pm2 save
pm2 startup    # follow printed instructions for systemd auto-start
```

---

## Bootstrap environment (`.env`)

Only variables required **before** the database loads. See `.env.example`.

| Variable | Required | Description |
| -------- | -------- | ----------- |
| `DATABASE_URL` | Yes | SQLite path (e.g. `file:./dev.db`, relative to `backend/` when run locally) |
| `CONFIG_ENCRYPTION_KEY` | Yes | AES-256 key for AppConfig secrets at rest |
| `ADMIN_USERNAME` | Seed only | Bootstrap admin (`npm run db:seed`) |
| `ADMIN_PASSWORD` | Seed only | Bootstrap admin password (seed only) |
| `KEEPER_CONFIG_FILE` | Optional | Path to `ksm-config.json` |
| `KEEPER_ONE_TIME_TOKEN` | Optional | One-time Keeper bind; remove after first start |
| `SSH_CREDENTIALS_FILE` | Optional | Local SSH credential cache path |

Generate encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Application configuration (AppConfig / Admin → Config)

SMTP, JWT, port, CORS, SSH credentials, DB2 paths, thresholds, polling, and engine tuning live in the **`AppConfig`** table. Defaults come from `database/dml.sql` or `npm run db:seed`. The backend loads them at startup via `configService.load()` — **not** from `.env`.

After first login:

1. Change the bootstrap admin password.
2. Set production secrets in **Admin → Config** (`secrets.jwtSecret`, `secrets.smtp*`, etc.).
3. Set `infra.db2LibDir`, `infra.db2JjsPath`, `infra.db2ConnDir` if using DB2 features.
4. Set CORS origins to production hostnames only.

Client/AppServer inventory is **environment-specific** — load via Admin or import scripts, not from `dml.sql`.

---

## Important gotchas

1. **25k files is normal after `npm install`** — that is `node_modules/`. Clone git source; do not copy a Windows dev tree wholesale.

2. **Java 8 + `jjs` for DB2** — DB Monitor, DB Jobs, and batch queries use `lib/DB2Connector.js` via Nashorn. Java 11+ does not include `jjs`. Configure paths in AppConfig.

3. **`ssh2` native bindings** — Compiles during `npm install`; requires gcc/make/python3 on bare metal.

4. **Nginx `proxy_pass`** — `frontend/nginx.conf` uses `http://backend:4000` (Docker DNS). On bare metal, change to `localhost:4000`.

5. **Health check** — Backend health is `GET /health` (not under `/api`).

6. **Firewall** — Open port **3000** (UI via Nginx) or only **443** if TLS terminates at Nginx. Port **4000** if the API is reached directly.

7. **PM2 / systemd** — Use a process manager in production; do not rely on a foreground `node` session.

8. **SQLite backups** — Put the DB file on persistent disk and include it in backup/restore drills before go-live.

9. **README vs this guide** — Some top-level README sections still mention PostgreSQL/Redis; the **current codebase uses SQLite** and in-process scheduling. This file reflects the actual deployment model.

---

## Quick reference

```bash
# --- From git (first time) ---
git clone <repo-url> /opt/wfm-controlm && cd /opt/wfm-controlm
cp .env.example .env && vi .env
npm run install:all && npm run build
npm run db:deploy && npm run db:bootstrap

# --- Docker ---
docker compose up -d --build
docker compose down
docker compose logs -f backend
docker compose restart backend

# --- Bare metal (PM2) ---
cd backend && pm2 start dist/index.js --name wfm-backend
pm2 restart wfm-backend
pm2 logs wfm-backend
pm2 stop wfm-backend

# --- SQL export (dev/release prep) ---
npm run db:extract          # regenerate database/ddl.sql + dml.sql
```

---

## Decision guide

| Goal | Path |
| ---- | ---- |
| Fastest install, UI + API | **Docker Compose** |
| Production on Unix with Nginx + PM2 | **Bare metal build** |
| DB Monitor / DB Jobs / SSH cron sync | **Bare metal (or custom Docker) + Java 8 jjs + lib/ + dbconnections** |
| Regenerate bootstrap SQL | `npm run db:extract` — [dbextract.md](dbextract.md) |
| Pre-go-live validation | [production-readiness-checklist.md](production-readiness-checklist.md) |
