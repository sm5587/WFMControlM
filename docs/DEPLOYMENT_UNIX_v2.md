# WFM Control-M - Unix Deployment Guide (v2)

**Version:** v2  
**Date:** 2026-06-11  
**Scope:** Clean deployment workflow for Linux/Unix hosts (production-first).

This version keeps the existing `DEPLOYMENT_UNIX.md` intact and provides a clearer, safer path for fresh environments.

---

## 1) Core principles

1. **Deploy from Git clone, not workspace copy**
   - Do **not** `scp -r` your Windows dev folder.
   - Rebuild dependencies on Unix (`npm install` / image build).

2. **Use bootstrap (`ddl.sql` + `dml.sql`) only when intended**
   - `dml.sql` seeds defaults and may reset config values if used carelessly.
   - Use bootstrap for fresh environment setup, not routine restarts.

3. **Runtime config lives in AppConfig**
   - SMTP, SSH, JWT, polling, DB2 paths are loaded from DB.
   - After bootstrap, update secrets/config in **Admin -> Config**.

---

## 2) Prerequisites (Unix host)

- Git
- Node.js 18 LTS+
- npm
- Build tools (`gcc`, `g++`, `make`, `python3`) for native modules
- Optional for production process management: `pm2` or `systemd`
- Optional for reverse proxy/TLS: `nginx`

For full DB2/SSH feature coverage:
- Java 8 with `jjs` (Nashorn)
- `lib/DB2Connector.js` + `lib/db2jcc4.jar`
- Client DB connection files under `dbconnections/Production`

---

## 3) Complete installation steps (end-to-end)

Use this as the primary checklist for a fresh Unix setup.

### Step 1 - Prepare host packages

```bash
# RHEL/CentOS/Amazon Linux
sudo yum install -y git curl sqlite
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3
```

Verify:

```bash
node -v
npm -v
git --version
```

### Step 2 - Get source code (Git preferred)

```bash
sudo mkdir -p /opt/wfm-controlm
sudo chown "$USER":"$USER" /opt/wfm-controlm
git clone <repo-url> /opt/wfm-controlm
cd /opt/wfm-controlm
```

If git is unavailable, copy a prepared source zip from Windows and extract:

```bash
mkdir -p /opt/wfm-controlm
unzip /path/to/WFMControlM-unix-bundle-*.zip -d /opt
cd /opt/wfm-controlm
```

### Step 3 - Configure bootstrap environment

```bash
cp .env.example .env
```

Set at minimum in `.env`:

```env
DATABASE_URL=file:./dev.db
CONFIG_ENCRYPTION_KEY=<64-char-hex>
```

Generate key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4 - Install app dependencies and build

```bash
npm run install:all
npm run build
```

### Step 5 - Initialize database

```bash
npm run db:deploy
npm run db:bootstrap   # fresh setup only
```

### Step 6 - Start backend service

```bash
cd /opt/wfm-controlm/backend
npm install -g pm2
pm2 start dist/index.js --name wfm-backend
pm2 save
```

### Step 7 - Verify app health

```bash
curl http://localhost:4000/health
```

### Step 8 - First login and mandatory config

After login in UI:

1. Change bootstrap admin password.
2. Configure production SMTP in **Admin -> Config** (`secrets.smtp*`).
3. Configure SSH in AppConfig (`secrets.ssh*`).
4. Configure JWT/CORS (`secrets.jwtSecret`, `infra.corsOrigins`).
5. If master user enabled, rotate default credentials immediately.

---

## 4) Database installation (SQLite)

This project uses **SQLite** (file-based), so you do not install a separate DB server by default.

### Install SQLite CLI tools (optional, recommended)

```bash
# RHEL/CentOS/Amazon Linux
sudo yum install -y sqlite
```

### Configure DB path

```bash
cd /opt/wfm-controlm
cp .env.example .env
```

Set in `.env`:

```env
DATABASE_URL=file:./dev.db
```

### Initialize schema and seed data

```bash
# schema migrations
npm run db:deploy

# first-time reference/config bootstrap only
npm run db:bootstrap
```

Quick helper scripts (recommended on sandbox):

```bash
# schema only (create DB + prisma migrations)
npm run db:create:unix

# full fresh setup (create DB + migrations + DDL/DML + verify)
npm run db:setup:unix
```

### Verify DB file

```bash
ls -l backend/prisma/dev.db
sqlite3 backend/prisma/dev.db "SELECT key, value FROM AppConfig LIMIT 10;"
```

> Do **not** run `db:bootstrap` for every restart. Use it for fresh setup (or intentional reseed) only.

---

## 5) Fresh install (recommended sequence)

```bash
# 1) Get source
sudo mkdir -p /opt/wfm-controlm
sudo chown "$USER":"$USER" /opt/wfm-controlm
git clone <repo-url> /opt/wfm-controlm
cd /opt/wfm-controlm

# 2) Env bootstrap
cp .env.example .env
# edit .env:
#   DATABASE_URL=file:./dev.db
#   CONFIG_ENCRYPTION_KEY=<64-char-hex>

# 3) Install deps and build
npm run install:all
npm run build

# 4) Schema migrations
npm run db:deploy

# 5) First-time bootstrap data (one-time for fresh DB)
npm run db:bootstrap
```

> If this is not a new environment and DB already has production config/secrets, do **not** run `db:bootstrap` unless you explicitly want to reseed.

---

## 6) Start backend/frontend on Unix

### Option A: Bare metal (common)

```bash
# backend
cd /opt/wfm-controlm/backend
pm2 start dist/index.js --name wfm-backend
pm2 save

# frontend (served via nginx recommended)
# configure nginx to serve frontend/dist and proxy /api -> localhost:4000
```

Health checks:

```bash
curl http://localhost:4000/health
curl -I http://localhost:3000
```

### Option B: Docker Compose

```bash
cd /opt/wfm-controlm
docker compose up -d --build
docker compose ps
```

---

## 7) Post-deploy mandatory configuration

After first login:

1. Change bootstrap admin credentials.
2. Set production SMTP in **Admin -> Config**:
   - `secrets.smtpHost`, `secrets.smtpPort`, `secrets.smtpUser`, `secrets.smtpPass`, `secrets.smtpFromEmail`
3. Set SSH credentials in AppConfig:
   - `secrets.sshUsername`, `secrets.sshPassword`, `secrets.sshTotpSecret` (if required)
4. Set JWT/CORS:
   - `secrets.jwtSecret`, `infra.corsOrigins`
5. If using master account, immediately rotate default values.

---

## 8) Safe runbook (important)

### Routine update (existing prod/stage DB)

```bash
cd /opt/wfm-controlm
git pull --rebase
npm run install:all
npm run build
npm run db:deploy
pm2 restart wfm-backend
```

### Fresh environment only

```bash
npm run db:bootstrap
```

Do **not** include `db:bootstrap` in routine restart/update scripts unless explicitly required.

---

## 9) Troubleshooting quick map

- **`No SSH credentials configured`**
  - Verify AppConfig `secrets.ssh*` values are present (not blank).
  - Confirm bootstrap did not overwrite secrets.

- **Cron sync timeouts / odd `cat` behavior**
  - Verify `infra.sshCronEntryPath` and `infra.sshWfmPathPrefix` in AppConfig.

- **Mail not sending in production**
  - Ensure SMTP is real relay, not Mailpit defaults (`127.0.0.1:1025`).

- **Frontend unreachable on expected port**
  - Default frontend is `3000`, backend API is `4000`.

---

## 10) Versioning note

This file is **versioned as v2** and does not overwrite the original guide.
Future updates should create:

- `DEPLOYMENT_UNIX_v3.md`
- `DEPLOYMENT_UNIX_v4.md`

...while preserving earlier deployment revisions for traceability.

