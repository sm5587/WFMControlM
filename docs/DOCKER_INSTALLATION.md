# Docker Installation Guide (Windows)

Step-by-step record of how WFM Control-M / WFM Watch was installed with **Docker Desktop on Windows**, plus how to change SQLite data after the app is running in containers.

For Unix server deployment (registry pull, bare metal), see [DEPLOYMENT_UNIX.md](DEPLOYMENT_UNIX.md). For build-once / push-to-registry workflow, see [docker_install_steps.md](../docker_install_steps.md) at the repo root.

**Slide-style version:** [DOCKER_INSTALLATION_Presentation.md](DOCKER_INSTALLATION_Presentation.md)

---

## What runs in Docker

| Container | Image | Host port | Purpose |
| --------- | ----- | --------- | ------- |
| `wfm-controlm-api` | `wfm-controlm-backend:prod` | **4015** | Express API, SQLite, Prisma, DB2/jjs bridge |
| `wfm-controlm-ui` | `wfm-controlm-frontend:prod` | **3015** | Nginx serving the React build |

- **Backend URL:** http://localhost:4015  
- **Frontend URL:** http://localhost:3015  
- **Health check:** http://localhost:4015/health  

Local dev (non-Docker) stays on **3005** / **4005** so both can run side by side.

Containers use `restart: unless-stopped`, so they come back after a reboot (no Windows Task Scheduler needed).

---

## Architecture (quick view)

```
Host (Windows)
├── Docker Desktop
│   ├── wfm-controlm-api
│   │   ├── /app/prisma/dev.db     ← SQLite (named volume backend_prisma)
│   │   ├── /app/lib/              ← bind mount from repo ./lib (DB2 jars)
│   │   └── /app/logs/             ← named volume backend_logs
│   └── wfm-controlm-ui
│       └── proxies /api and /socket.io → backend:4005
└── Repo: WFMControlM/
    ├── .env
    ├── lib/DB2Connector.js, db2jcc4.jar
    └── docker-compose.prod.yml
```

**Production backend image includes:** Node 18 Alpine, OpenSSL (Prisma), OpenJDK 8 + `jjs` (DB2 JDBC bridge), compiled backend in `/app/dist`.

---

## Prerequisites

1. **Docker Desktop for Windows** — installed and running (whale icon in system tray).
2. **Repo checkout** — e.g. `C:\Users\...\WFMControlM`
3. **DB2 connector files** in repo `lib/`:
   - `lib/DB2Connector.js`
   - `lib/db2jcc4.jar`
4. **Optional:** WSL (Ubuntu) — used by `scripts/build-docker-wsl.sh` when building from WSL against Docker Desktop.

---

## Step 1 — Create bootstrap `.env`

From the repo root:

```powershell
cd "C:\Users\SM5587\OneDrive - Zebra Technologies\Daily_Work\WFMControlM"
Copy-Item .env.example .env
```

Edit `.env` and set at minimum:

| Variable | Example | Notes |
| -------- | ------- | ----- |
| `DATABASE_URL` | `file:./dev.db` | Relative to `backend/prisma/` (inside container: `/app/prisma/dev.db`) |
| `CONFIG_ENCRYPTION_KEY` | 64-char hex | Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Other runtime settings (SMTP, JWT, ports, DB2 paths) live in **AppConfig** in the database and are edited via **Admin → Config** after first login.

> **Windows path note:** If your `.env` uses a full Windows path for `DATABASE_URL`, use the smoke override when starting (Step 4) so the container uses `file:./dev.db` inside the volume instead.

---

## Step 2 — Build production images

### Option A — WSL build script (what we used on this machine)

From WSL, in the repo:

```bash
cd /mnt/c/Users/SM5587/OneDrive\ -\ Zebra\ Technologies/Daily_Work/WFMControlM
bash scripts/build-docker-wsl.sh
```

This builds:

- `wfmwatch/wfm-controlm-backend:local-YYYYMMDD`
- `wfmwatch/wfm-controlm-frontend:local-YYYYMMDD`

The script uses Docker Desktop’s `docker.exe` from WSL when WSL integration is not enabled for the distro.

### Option B — PowerShell / Docker Desktop directly

```powershell
cd "C:\Users\SM5587\OneDrive - Zebra Technologies\Daily_Work\WFMControlM"

docker build -f backend/Dockerfile.prod -t wfm-controlm-backend:prod ./backend
docker build -f frontend/Dockerfile.prod -t wfm-controlm-frontend:prod ./frontend
```

Or let Compose build:

```powershell
docker compose -f docker-compose.prod.yml build
```

---

## Step 3 — Review compose file

`docker-compose.prod.yml` defines:

- **Backend** — host port `4015` → container `4005`, env from `.env`, `DEPLOYMENT_LABEL=Docker`, volumes:
  - `backend_prisma` → `/app/prisma` (SQLite persistence)
  - `backend_logs` → `/app/logs`
  - `./lib` → `/app/lib:ro` (DB2 connector)
- **Frontend** — host port `3015` → container `8080`, waits for backend health
- **Migrations** — `RUN_MIGRATIONS=true` runs `prisma migrate deploy` on backend start

Mailpit is **not** in production compose. For local email testing only:

```powershell
docker compose -f docker-compose.prod.yml -f docker-compose.mailpit.yml up -d
```

---

## Step 4 — Start the stack

### Standard start (production compose)

```powershell
docker compose -f docker-compose.prod.yml up -d
```

### Local smoke test on Windows (recommended first time)

If `.env` has a Windows-style `DATABASE_URL`, add the override so SQLite uses the container volume:

```powershell
docker compose -f docker-compose.prod.yml -f docker-compose.smoke.override.yml up -d
```

Check status:

```powershell
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend
```

---

## Step 5 — First-time database bootstrap

On **first install**, the backend creates an empty SQLite file in the `backend_prisma` volume and applies Prisma migrations automatically.

You still need **seed / reference data** (RBAC, AppConfig defaults, admin user) once.

### Option A — Apply SQL files from the repo (recommended for prod-style bootstrap)

The production image does **not** include the `database/` folder. Mount it for one-off bootstrap:

```powershell
# One-time: add to compose or run with an extra mount (PowerShell, repo root)
docker compose -f docker-compose.prod.yml run --rm `
  -v "${PWD}/database:/app/database:ro" `
  backend node scripts/apply-sql.js database/ddl.sql

docker compose -f docker-compose.prod.yml run --rm `
  -v "${PWD}/database:/app/database:ro" `
  backend node scripts/apply-sql.js database/dml.sql
```

### Option B — Prisma seed (dev-style, may include sample data)

```powershell
docker compose -f docker-compose.prod.yml exec backend npx prisma db seed
```

Requires `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` for the seed script.

### Option C — Reuse an existing Windows `dev.db`

If you already have data in `backend\prisma\dev.db` from native dev:

```powershell
# Start backend once so the volume exists, then stop it
docker compose -f docker-compose.prod.yml up -d backend
docker compose -f docker-compose.prod.yml stop backend

# Copy your existing database into the container volume
docker cp backend\prisma\dev.db wfm-controlm-api:/app/prisma/dev.db

# Start everything
docker compose -f docker-compose.prod.yml up -d
```

---

## Step 6 — Verify

```powershell
curl http://localhost:4015/health
curl -I http://localhost:3015
```

Open http://localhost:3015 in a browser and log in (sidebar shows a **Docker** badge; local dev uses http://localhost:3005 with a **Local** badge).

Expected health response shape:

```json
{"status":"ok","service":"WFM Watch", ...}
```

---

## Step 7 — Disable the old Windows daily scheduler (optional)

When the app ran natively via `start.ps1`, a Task Scheduler job started it each morning. With Docker handling uptime, disable that task:

```powershell
schtasks /Change /TN "\WFMControlM - Daily Start" /DISABLE
```

Re-enable only if you switch back to native `start.ps1`:

```powershell
schtasks /Change /TN "\WFMControlM - Daily Start" /ENABLE
```

---

## Step 8 — Routine operations

| Task | Command |
| ---- | ------- |
| Stop | `docker compose -f docker-compose.prod.yml down` |
| Start | `docker compose -f docker-compose.prod.yml up -d` |
| Rebuild after code change | `docker compose -f docker-compose.prod.yml up -d --build` |
| Backend logs | `docker compose -f docker-compose.prod.yml logs -f backend` |
| Restart backend only | `docker compose -f docker-compose.prod.yml restart backend` |

---

## Where is the SQLite database?

| Location | Path |
| -------- | ---- |
| **Inside container** | `/app/prisma/dev.db` |
| **Docker named volume** | `backend_prisma` (managed by Docker Desktop) |

Inspect the volume:

```powershell
docker volume inspect wfmcontrolm_backend_prisma
```

The DB survives `docker compose down`. It is removed only if you delete the volume:

```powershell
docker compose -f docker-compose.prod.yml down -v   # ⚠ destroys DB
```

---

## Modifying SQL data in Docker

There are four practical approaches, from simplest to most direct.

### 1. Use the Admin UI (no SQL)

Best for:

- AppConfig keys (SMTP, ports, CORS, feature flags)
- Users, profiles, permissions
- Clients and app servers (where the UI supports it)

Go to **Admin → Config** or the relevant module in the web UI. Changes are written to SQLite immediately.

---

### 2. Run a SQL file inside the backend container (recommended for `.sql` scripts)

Use `backend/scripts/apply-sql.js` — it runs statements through Prisma against `DATABASE_URL`.

**Mount `database/` read-only** (same pattern as bootstrap):

```powershell
# Example: fix Client DateTime columns stored as TEXT
docker compose -f docker-compose.prod.yml run --rm `
  -v "${PWD}/database:/app/database:ro" `
  backend node scripts/apply-sql.js database/fix-client-datetimes.sql

# Example: apply client DML export
docker compose -f docker-compose.prod.yml run --rm `
  -v "${PWD}/database:/app/database:ro" `
  backend node scripts/apply-sql.js database/clients-dml.sql
```

Paths are relative to `/app` (container working directory).

**While the stack is already running** (no `run --rm`):

```powershell
docker compose -f docker-compose.prod.yml exec backend `
  sh -c "test -f database/fix-client-datetimes.sql || echo 'Mount database/ first'"
```

If `database/` is not mounted in the running container, use `docker compose run --rm -v ...` as above, or copy the file in:

```powershell
docker cp database\fix-client-datetimes.sql wfm-controlm-api:/tmp/fix.sql
docker compose -f docker-compose.prod.yml exec backend node scripts/apply-sql.js /tmp/fix.sql
```

---

### 3. Edit the database file on the host (best for ad-hoc queries)

**A. Copy out → edit → copy back**

```powershell
# Stop backend for a consistent snapshot (recommended)
docker compose -f docker-compose.prod.yml stop backend

docker cp wfm-controlm-api:/app/prisma/dev.db .\dev.db.docker

# Edit with DB Browser for SQLite, or sqlite3 if installed:
# sqlite3 dev.db.docker "SELECT key, value FROM AppConfig LIMIT 5;"
# sqlite3 dev.db.docker "UPDATE AppConfig SET value='true' WHERE key='display.maintenanceAdHocWindows';"

docker cp .\dev.db.docker wfm-controlm-api:/app/prisma/dev.db
docker compose -f docker-compose.prod.yml start backend
```

**B. Bind-mount `backend/prisma` for local dev** (optional compose override)

Create `docker-compose.local-db.override.yml`:

```yaml
services:
  backend:
    volumes:
      - ./backend/prisma:/app/prisma
```

Then:

```powershell
docker compose -f docker-compose.prod.yml -f docker-compose.local-db.override.yml up -d
```

Edit `backend\prisma\dev.db` directly on Windows with any SQLite GUI. Restart backend after changes if the app cached values at startup.

---

### 4. Interactive SQL shell inside the container

The Alpine image does **not** include `sqlite3`. Options:

- Install on the host and use copy-out/copy-back (method 3A).
- One-off container with sqlite3 and the volume mounted:

```powershell
docker run --rm -it `
  -v wfmcontrolm_backend_prisma:/data `
  alpine sh -c "apk add sqlite && sqlite3 /data/dev.db"
```

Replace `wfmcontrolm_backend_prisma` with the actual volume name from `docker volume ls`.

---

## Common SQL maintenance tasks

| Goal | Approach |
| ---- | -------- |
| Change SMTP / secrets / ports | Admin → Config, or `UPDATE AppConfig SET value=... WHERE key=...` |
| Import client rows | `database/clients-dml.sql` via apply-sql (Step 5 pattern) |
| Fix DateTime-as-TEXT on Linux/Docker | `database/fix-client-datetimes.sql` |
| Regenerate ddl/dml from schema | On dev machine: `npm run db:extract` — see [dbextract.md](dbextract.md) |
| Full schema + defaults refresh | `ddl.sql` then `dml.sql` (fresh DB only; `dml.sql` uses `INSERT OR REPLACE`) |

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `spawn jjs ENOENT` | Java/jjs not in image or wrong path | Use current `Dockerfile.prod` (includes OpenJDK 8); ensure `./lib` is mounted |
| DB2 queries fail | Missing jars in `/app/lib` | Verify `lib/DB2Connector.js` and `lib/db2jcc4.jar` on host |
| Empty clients / config | Fresh volume, no bootstrap | Run Step 5 (ddl/dml or copy existing dev.db) |
| Port conflict on 3015/4015 | Local dev already on 3005/4005, or another app | Stop the other stack or change compose port mapping |
| `apply-sql.js` file not found | `database/` not in image | Mount `./database:/app/database:ro` or `docker cp` the file |
| Windows `.env` DB path breaks container | Host path not visible in Linux container | Use `docker-compose.smoke.override.yml` or `file:./dev.db` |

---

## Files reference

| File | Role |
| ---- | ---- |
| `backend/Dockerfile.prod` | Production backend multi-stage build |
| `frontend/Dockerfile.prod` | Production frontend (Nginx) |
| `docker-compose.prod.yml` | Main production stack |
| `docker-compose.smoke.override.yml` | Forces `DATABASE_URL=file:./dev.db` for local smoke test |
| `docker-compose.mailpit.yml` | Optional local SMTP catcher |
| `scripts/build-docker-wsl.sh` | Build images from WSL |
| `backend/scripts/apply-sql.js` | Apply `.sql` files to SQLite via Prisma |
| `database/ddl.sql`, `database/dml.sql` | Schema + seed SQL |
| `.env` | Bootstrap only (`DATABASE_URL`, `CONFIG_ENCRYPTION_KEY`) |

---

## Related docs

- [DEPLOYMENT_UNIX.md](DEPLOYMENT_UNIX.md) — Linux server deployment
- [docker_install_steps.md](../docker_install_steps.md) — Build here, push to registry, deploy on Unix
- [dbextract.md](dbextract.md) — Regenerate SQL exports from the live schema
