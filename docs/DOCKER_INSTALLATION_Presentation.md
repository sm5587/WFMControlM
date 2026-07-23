# WFM Control-M / WFM Watch
## Docker Installation on Windows

**Workforce Management | Zebra Technologies**

Step-by-step guide: build images, run containers, manage SQLite data.

*Detailed runbook: [DOCKER_INSTALLATION.md](DOCKER_INSTALLATION.md)*

---

## Slide 1: Why Docker?

| Before (native Windows) | After (Docker) |
| ----------------------- | -------------- |
| `start.ps1` every morning via Task Scheduler | Containers auto-restart (`unless-stopped`) |
| Node + Vite in separate PowerShell windows | Single `docker compose up -d` |
| Manual dependency installs | Immutable prod images |
| DB2/Java tied to host PATH | OpenJDK 8 + `jjs` baked into backend image |

> **Result:** App stays up at http://localhost:3005 without a daily scheduled task.

---

## Slide 2: What Runs in Docker

| Container | Image | Host port | Purpose |
| --------- | ----- | --------- | ------- |
| `wfm-controlm-api` | `wfm-controlm-backend:prod` | **4005** | Express API, SQLite, Prisma, DB2/jjs |
| `wfm-controlm-ui` | `wfm-controlm-frontend:prod` | **3005** | Nginx → React build |

**URLs**

- Frontend: http://localhost:3005  
- Backend: http://localhost:4005  
- Health: http://localhost:4005/health  

---

## Slide 3: Architecture

```
Host (Windows + Docker Desktop)
├── wfm-controlm-api
│   ├── /app/prisma/dev.db    ← SQLite (volume: backend_prisma)
│   ├── /app/lib/             ← bind mount ./lib (DB2 jars)
│   └── /app/logs/            ← volume: backend_logs
└── wfm-controlm-ui
    └── /api, /socket.io  →  backend:4005
```

**Backend image includes:** Node 18 Alpine · OpenSSL (Prisma) · OpenJDK 8 + `jjs` (DB2 JDBC)

---

## Slide 4: Prerequisites

1. **Docker Desktop for Windows** — running (whale icon in tray)
2. **Repo checkout** — `WFMControlM/`
3. **DB2 connector files** in `lib/`:
   - `DB2Connector.js`
   - `db2jcc4.jar`
4. **Optional:** WSL — for `scripts/build-docker-wsl.sh`

---

## Slide 5: Step 1 — Bootstrap `.env`

```powershell
cd "...\WFMControlM"
Copy-Item .env.example .env
```

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `DATABASE_URL` | Yes | `file:./dev.db` (→ `/app/prisma/dev.db` in container) |
| `CONFIG_ENCRYPTION_KEY` | Yes | 64-char hex — encrypts secrets in AppConfig |

Generate key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> SMTP, ports, CORS, DB2 paths → **Admin → Config** (stored in SQLite, not `.env`).

---

## Slide 6: Step 2 — Build Images

### Option A — WSL (used on build machine)

```bash
cd /mnt/c/.../WFMControlM
bash scripts/build-docker-wsl.sh
```

Tags: `wfmwatch/wfm-controlm-backend:local-YYYYMMDD`

### Option B — PowerShell

```powershell
docker compose -f docker-compose.prod.yml build
```

Or individually:

```powershell
docker build -f backend/Dockerfile.prod -t wfm-controlm-backend:prod ./backend
docker build -f frontend/Dockerfile.prod -t wfm-controlm-frontend:prod ./frontend
```

---

## Slide 7: Step 3 — Compose Overview

**File:** `docker-compose.prod.yml`

| Setting | Value |
| ------- | ----- |
| Backend port | `4005:4005` |
| Frontend port | `3005:8080` |
| SQLite volume | `backend_prisma` → `/app/prisma` |
| DB2 lib mount | `./lib` → `/app/lib:ro` |
| Migrations | `RUN_MIGRATIONS=true` on backend start |

**Not in prod:** Mailpit (use corporate SMTP via Admin → Config)

---

## Slide 8: Step 4 — Start the Stack

**Production:**

```powershell
docker compose -f docker-compose.prod.yml up -d
```

**First-time Windows smoke test** (if `.env` has a Windows DB path):

```powershell
docker compose -f docker-compose.prod.yml -f docker-compose.smoke.override.yml up -d
```

**Check:**

```powershell
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend
```

---

## Slide 9: Step 5 — Database Bootstrap (First Install)

Backend auto-runs **Prisma migrations** on start. You still need **seed data** once:

| Option | Command / action |
| ------ | ---------------- |
| **A — SQL files** | Mount `database/`, run `apply-sql.js` for `ddl.sql` + `dml.sql` |
| **B — Prisma seed** | `docker compose exec backend npx prisma db seed` |
| **C — Copy existing DB** | `docker cp backend\prisma\dev.db wfm-controlm-api:/app/prisma/dev.db` |

Example (Option A):

```powershell
docker compose -f docker-compose.prod.yml run --rm `
  -v "${PWD}/database:/app/database:ro" `
  backend node scripts/apply-sql.js database/dml.sql
```

---

## Slide 10: Step 6 — Verify

```powershell
curl http://localhost:4005/health
curl -I http://localhost:3005
```

Open http://localhost:3005 → log in.

Expected:

```json
{"status":"ok","service":"WFM Watch", ...}
```

---

## Slide 11: Step 7 — Disable Old Scheduler

Native dev used Task Scheduler job **`\WFMControlM - Daily Start`** (10:00 AM → `start.ps1`).

**Disable** (Docker handles uptime):

```powershell
schtasks /Change /TN "\WFMControlM - Daily Start" /DISABLE
```

**Re-enable** only if returning to `start.ps1`:

```powershell
schtasks /Change /TN "\WFMControlM - Daily Start" /ENABLE
```

---

## Slide 12: Day-to-Day Operations

| Task | Command |
| ---- | ------- |
| Start | `docker compose -f docker-compose.prod.yml up -d` |
| Stop | `docker compose -f docker-compose.prod.yml down` |
| Rebuild | `docker compose -f docker-compose.prod.yml up -d --build` |
| Logs | `docker compose -f docker-compose.prod.yml logs -f backend` |
| Restart backend | `docker compose -f docker-compose.prod.yml restart backend` |

⚠ `down -v` **deletes** the SQLite volume.

---

## Slide 13: Where Is the Database?

| Location | Path |
| -------- | ---- |
| Inside container | `/app/prisma/dev.db` |
| Docker volume | `backend_prisma` |

```powershell
docker volume inspect wfmcontrolm_backend_prisma
```

Survives `docker compose down` — removed only with `down -v`.

---

## Slide 14: Modifying SQL Data — Overview

Four approaches (simplest → most direct):

| # | Method | Best for |
| - | ------ | -------- |
| 1 | **Admin UI** | AppConfig, users, clients |
| 2 | **`apply-sql.js` in container** | Repo `.sql` files |
| 3 | **Copy DB out → edit → copy back** | Ad-hoc queries (DB Browser) |
| 4 | **Bind-mount `backend/prisma`** | Dev: edit `dev.db` on host |

---

## Slide 15: SQL Method 1 — Admin UI

No SQL required.

- **Admin → Config** — SMTP, ports, CORS, feature flags, secrets  
- **Clients / Users / Profiles** — where the UI supports CRUD  

Changes write to SQLite immediately.

---

## Slide 16: SQL Method 2 — Run `.sql` Files

Mount `database/` and use `apply-sql.js`:

```powershell
docker compose -f docker-compose.prod.yml run --rm `
  -v "${PWD}/database:/app/database:ro" `
  backend node scripts/apply-sql.js database/fix-client-datetimes.sql
```

Or copy file in:

```powershell
docker cp database\fix-client-datetimes.sql wfm-controlm-api:/tmp/fix.sql
docker compose -f docker-compose.prod.yml exec backend node scripts/apply-sql.js /tmp/fix.sql
```

> Production image does **not** include `database/` — mount or `docker cp`.

---

## Slide 17: SQL Method 3 — Copy Out / Edit / Copy Back

```powershell
docker compose -f docker-compose.prod.yml stop backend
docker cp wfm-controlm-api:/app/prisma/dev.db .\dev.db.docker
# Edit with DB Browser for SQLite or sqlite3
docker cp .\dev.db.docker wfm-controlm-api:/app/prisma/dev.db
docker compose -f docker-compose.prod.yml start backend
```

**Optional dev override** — bind-mount host folder:

```yaml
# docker-compose.local-db.override.yml
services:
  backend:
    volumes:
      - ./backend/prisma:/app/prisma
```

---

## Slide 18: Common SQL Maintenance

| Goal | How |
| ---- | --- |
| Change SMTP / ports | Admin → Config |
| Import clients | `database/clients-dml.sql` via apply-sql |
| Fix DateTime-as-TEXT | `database/fix-client-datetimes.sql` |
| Regenerate ddl/dml | `npm run db:extract` (see dbextract.md) |
| Fresh schema + defaults | `ddl.sql` then `dml.sql` (new DB only) |

---

## Slide 19: Troubleshooting

| Symptom | Fix |
| ------- | --- |
| `spawn jjs ENOENT` | Current `Dockerfile.prod` + `./lib` mounted |
| DB2 fails | Check `lib/DB2Connector.js` + `db2jcc4.jar` |
| Empty clients | Run bootstrap (Slide 9) or copy `dev.db` |
| Port 4005/3005 in use | `.\start.ps1 stop` or change compose ports |
| SQL file not found | Mount `database/` or `docker cp` |
| Windows DB path in `.env` | Use `docker-compose.smoke.override.yml` |

---

## Slide 20: Key Files

| File | Role |
| ---- | ---- |
| `backend/Dockerfile.prod` | Prod backend build |
| `frontend/Dockerfile.prod` | Prod frontend (Nginx) |
| `docker-compose.prod.yml` | Main stack |
| `docker-compose.smoke.override.yml` | Local `DATABASE_URL` override |
| `scripts/build-docker-wsl.sh` | Build from WSL |
| `backend/scripts/apply-sql.js` | Apply SQL to SQLite |
| `database/ddl.sql`, `dml.sql` | Schema + seed |

---

## Slide 21: Related Documentation

| Document | Purpose |
| -------- | ------- |
| [DOCKER_INSTALLATION.md](DOCKER_INSTALLATION.md) | Full runbook (this deck expanded) |
| [DEPLOYMENT_UNIX.md](DEPLOYMENT_UNIX.md) | Linux server deploy |
| [docker_install_steps.md](../docker_install_steps.md) | Build → registry → Unix |
| [dbextract.md](dbextract.md) | Regenerate SQL exports |

---

## Slide 22: Summary

1. Create `.env` (`DATABASE_URL`, `CONFIG_ENCRYPTION_KEY`)
2. Build images (`build-docker-wsl.sh` or `docker compose build`)
3. Start stack (`docker compose -f docker-compose.prod.yml up -d`)
4. Bootstrap DB once (ddl/dml, seed, or copy `dev.db`)
5. Verify http://localhost:3005
6. Disable Windows Task Scheduler daily start
7. Change data via **Admin UI**, **apply-sql**, or **copy DB out/in**

**WFM Watch in Docker — always on, no morning script.**

---

*Presentation: Docker Installation on Windows*  
*Team: Workforce Management, Zebra Technologies*  
*Companion doc: [DOCKER_INSTALLATION.md](DOCKER_INSTALLATION.md)*
