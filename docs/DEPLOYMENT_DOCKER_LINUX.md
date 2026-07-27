# WFM Control-M — Docker Deployment on Linux (Runbook)

Step-by-step guide to deploy WFM Control-M on a **Linux server using Docker Compose**, based on the production deployment performed on **RHEL 9.7** (`pnqpilot02`).

Use this document when cloning the repo onto **any new server** and running the same Docker setup we validated locally (Windows Docker Desktop) and on the remote Linux host.

**Repository:** https://github.com/sm5587/WFMControlM.git

---

## What gets deployed

Two separate Docker containers:

| Container | Image tag | Host port | Purpose |
|-----------|-----------|-----------|---------|
| `wfm-controlm-api` | `wfm-controlm-backend:prod` | **4005** | Express API, SQLite, Prisma, DB2 bridge |
| `wfm-controlm-ui` | `wfm-controlm-frontend:prod` | **3005** | Nginx serving React build |

**Compose file:** `docker-compose.prod.yml`  
**Standard deploy path:** `/application/wfmwatch` (set the same path in `.env` as `APP_DIR`)

---

## Architecture (quick view)

```
Linux server
├── Docker Engine
│   ├── wfm-controlm-api
│   │   ├── /app/prisma/dev.db     ← SQLite (Docker volume: *_backend_prisma)
│   │   ├── /app/lib/              ← bind mount from repo ./lib (DB2 jars)
│   │   └── /app/logs/             ← Docker volume: *_backend_logs
│   └── wfm-controlm-ui
│       └── proxies /api and /socket.io → backend:4005
└── Repo checkout (/application/wfmwatch)
    ├── .env
    ├── lib/DB2Connector.js, db2jcc4.jar
    └── docker-compose.prod.yml
```

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Linux** | Tested on **RHEL 9.7**; should work on similar RHEL/CentOS/Alma/Rocky |
| **Git** | To clone the repository |
| **Docker Engine 20+** | Install steps below if missing |
| **Docker Compose v2** | `docker compose` plugin (installed with Docker CE) |
| **Disk space** | At least **5 GB free** on `/` before building images |
| **Ports free** | **3005** and **4005** must not be used by another app |
| **User in `docker` group** | Or use `sudo docker` (group preferred) |

**Do NOT copy from Windows:** `node_modules/`, `dist/`, `backend/prisma/dev.db`, log files.

---

## Part 1 — Server preparation

### 1.1 Check OS, disk, and ports

```bash
cat /etc/os-release
df -h /
id
sudo ss -tlnp | grep -E ':3005|:4005' || echo "Ports 3005 and 4005 are free"
```

**What it does:** Confirms OS version, available disk, your user/group, and that required ports are free.

### 1.2 Free disk if needed (only if `df -h /` shows &lt; 5 GB free)

We reclaimed space on RHEL with:

```bash
# Remove unused Podman images (safe if you use Docker, not Podman)
podman system prune -a -f

# Remove old rotated system logs (keep current /var/log/messages)
sudo rm -f /var/log/messages-20260705
sudo rm -f /var/log/messages-20260712
sudo rm -f /var/log/messages-20260719
sudo rm -f /var/log/messages-20260726

df -h /
```

**What it does:** Frees several GB so `docker build` has room for backend (~1 GB) and frontend images plus build cache.

**Do NOT delete:** `/usr`, `/opt`, `/home` contents, or active log files without IT approval.

---

## Part 2 — Install Docker (RHEL 9)

Skip this section if `docker --version` and `docker compose version` already work.

### 2.1 Remove Podman Docker shim (required on RHEL)

RHEL ships `podman-docker` which conflicts with real Docker CE:

```bash
sudo dnf remove -y podman-docker
```

**What it does:** Removes the fake `docker` → Podman compatibility package so Docker CE can install.

### 2.2 Install Docker CE + Compose plugin

```bash
sudo dnf -y install dnf-plugins-core
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
```

**What it does:** Installs Docker Engine, Compose v2 plugin, starts the daemon on boot, and adds your user to the `docker` group.

**Log out and SSH back in**, then verify:

```bash
docker --version
docker compose version
docker run --rm hello-world
sudo systemctl status docker --no-pager
```

**What it does:** Confirms Docker CLI, Compose, daemon, and that your user can run containers.

### 2.3 Fix `DOCKER_HOST` pointing to Podman (if needed)

If `docker run hello-world` fails with `podman.sock`:

```bash
unset DOCKER_HOST
export DOCKER_HOST=unix:///var/run/docker.sock
docker run --rm hello-world
```

**What it does:** Points the Docker CLI at the real Docker daemon instead of Podman.

Remove any `export DOCKER_HOST=...podman...` line from `~/.bashrc` or `~/.bash_profile`.

---

## Part 3 — First-time deployment

### 3.1 Create deploy directory

Standard path on the server: **`/application/wfmwatch`**

#### Step A — Check your username and group on **this** server

Every server may use a different primary group. **Do not guess** `username:username` — on our RHEL host the user was `appadmin` but the group was `rflxadmins`, not `appadmin`.

```bash
whoami
id
id -gn
groups
```

**How to read the output:**

```text
uid=501(appadmin) gid=501(rflxadmins) groups=501(rflxadmins),499(docker),...
```

| Field | Meaning | Example |
|-------|---------|---------|
| `whoami` | Login user | `appadmin` |
| `id -gn` | **Primary group** (use this for `chown`) | `rflxadmins` |
| `groups` | All groups the user belongs to | `rflxadmins docker ...` |

Use **primary group** from `id -gn` in the `chown` command below.

#### Step B — Create folder and set ownership

**Recommended (works on any server — uses your current login):**

```bash
sudo mkdir -p /application/wfmwatch
sudo chown $USER:$(id -gn) /application/wfmwatch
cd /application/wfmwatch
pwd
ls -ld /application/wfmwatch
```

**What it does:**
- `$USER` → your login name (e.g. `appadmin`)
- `$(id -gn)` → your primary group (e.g. `rflxadmins`)
- `ls -ld` → confirms owner and group look correct

**Example (explicit — pnqpilot02):**

```bash
sudo mkdir -p /application/wfmwatch
sudo chown appadmin:rflxadmins /application/wfmwatch
cd /application/wfmwatch
```

**Verify ownership:**

```bash
ls -ld /application/wfmwatch
# Expected: drwxr-xr-x ... appadmin rflxadmins ... /application/wfmwatch
```

#### Common mistake

```bash
sudo chown appadmin:appadmin /application/wfmwatch   # WRONG if group appadmin does not exist
# Error: chown: invalid group: 'appadmin:appadmin'
```

**Fix:** Run `id -gn` and use that group name, or use `sudo chown $USER:$(id -gn) ...`.

**Do NOT use** `appadmin:appadmin` unless `id` shows a group literally named `appadmin`.

### 3.2 Clone repository

```bash
cd /application/wfmwatch
git clone https://github.com/sm5587/WFMControlM.git .
```

Verify required files:

```bash
ls backend/Dockerfile.prod frontend/Dockerfile.prod docker-compose.prod.yml lib/
```

**What it does:** Clones source into the deploy folder. Do not copy `node_modules` from Windows.

### 3.3 Create `.env`

```bash
cd /application/wfmwatch
cp .env.example .env
openssl rand -hex 32
vi .env
```

Set at minimum:

```env
APP_DIR=/application/wfmwatch
DATABASE_URL="file:./dev.db"
CONFIG_ENCRYPTION_KEY=<paste 64-char hex from openssl rand -hex 32>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-me-before-seed
```

**What each var does:**

| Variable | Purpose |
|----------|---------|
| `APP_DIR` | Absolute path to this checkout on the server |
| `DATABASE_URL` | SQLite file inside container volume (`file:./dev.db`) |
| `CONFIG_ENCRYPTION_KEY` | Encrypts secrets in AppConfig — **keep safe, do not change** after go-live |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Used only for first-time seed (see dml.sql) |

**Do NOT commit `.env` to Git.**

### 3.4 Build images

```bash
cd /application/wfmwatch

docker build -f backend/Dockerfile.prod -t wfm-controlm-backend:prod ./backend
docker build -f frontend/Dockerfile.prod -t wfm-controlm-frontend:prod ./frontend
```

**What it does:** Builds two local images tagged `wfm-controlm-backend:prod` and `wfm-controlm-frontend:prod`. First build takes ~10–20 minutes.

### 3.5 Start backend only (first time)

```bash
cd /application/wfmwatch
docker compose -f docker-compose.prod.yml up -d backend
sleep 30
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs backend --tail 30
```

**What it does:** Starts only the API container, runs Prisma migrations, and creates the SQLite volume on first boot.

**Expected on first start:** Backend may log `Missing critical AppConfig values` until you seed the database (next step). That is normal.

### 3.6 Seed database — **FIRST TIME ONLY**

This loads AppConfig defaults, RBAC, admin user, and sets `infra.port` to **4005**.

```bash
cd /application/wfmwatch
docker compose -f docker-compose.prod.yml run --rm \
  -v "$(pwd)/database:/app/database:ro" \
  backend node scripts/apply-sql.js database/dml.sql
```

**What it does:** Runs `database/dml.sql` against SQLite in the `backend_prisma` Docker volume via Prisma.

You should see:

```text
[SQL] Applied statement ...
[SQL] Completed: /app/database/dml.sql
```

**Do NOT run `dml.sql` again** on routine updates — it uses `INSERT OR REPLACE` and can overwrite config you changed in Admin → Config.

Optional: for a completely fresh schema + seed on empty DB, run `ddl.sql` before `dml.sql` (usually migrations already created schema):

```bash
docker compose -f docker-compose.prod.yml run --rm \
  -v "$(pwd)/database:/app/database:ro" \
  backend node scripts/apply-sql.js database/ddl.sql
```

### 3.7 Restart backend and start frontend

```bash
cd /application/wfmwatch
docker compose -f docker-compose.prod.yml restart backend
sleep 40
docker compose -f docker-compose.prod.yml up -d frontend
sleep 20
docker compose -f docker-compose.prod.yml ps
```

**What it does:** Backend picks up seeded AppConfig (port 4005); frontend starts after backend passes health check.

Both containers should show **Up (healthy)**.

### 3.8 Verify on the server

```bash
curl http://localhost:4005/health
curl -I http://localhost:3005
```

Expected health response:

```json
{"status":"ok","service":"WFM Watch",...}
```

Frontend should return `HTTP/1.1 200 OK`.

**Login (after seed):**

- URL: `http://<server-ip>:3005` (or SSH tunnel — see Part 5)
- Username: `admin`
- Password: value from `ADMIN_PASSWORD` in `.env` (default `change-me-before-seed`)

---

## Part 4 — Daily operations (start / stop / status)

All commands run from the repo root:

```bash
cd /application/wfmwatch
```

### Check if containers are running

```bash
docker compose -f docker-compose.prod.yml ps
```

**What it does:** Shows both containers, status (healthy/unhealthy), and port mappings.

### Start both containers (after stop or server reboot)

```bash
docker compose -f docker-compose.prod.yml up -d
```

**What it does:** Starts backend + frontend. Data in Docker volumes is preserved. **No seed needed.**

### Stop containers (keep data)

```bash
docker compose -f docker-compose.prod.yml down
```

**What it does:** Stops and removes containers and network. **Keeps** volumes (`backend_prisma`, `backend_logs`) — your SQLite DB survives.

### View logs

```bash
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f frontend
```

Press `Ctrl+C` to stop following logs (containers keep running).

### Restart one service

```bash
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml restart frontend
```

**What it does:** Restarts a single container without touching the other or the database volume.

---

## Part 5 — Access from your laptop

The app listens on server ports **3005** (UI) and **4005** (API). Corporate/GCP firewalls often block these from the internet.

### On the server (SSH session)

Works directly:

- http://localhost:3005
- http://localhost:4005/health

### From your laptop — SSH tunnel (recommended)

**PowerShell:**

```powershell
ssh -L 3005:localhost:3005 -L 4005:localhost:4005 appadmin@<ssh-host-ip>
```

**PuTTY:** Connection → SSH → Tunnels → add `3005 → localhost:3005` and `4005 → localhost:4005`, then connect.

Keep SSH open, then open in browser:

- http://localhost:3005
- http://localhost:4005/health

**Note:** `localhost:3005` on your laptop is **not** the server becoming your laptop — it is a secure tunnel to the server app.

---

## Part 6 — Deploy code updates (GitHub → server)

Use this when new code is pushed to GitHub and the server already has a working deployment with **existing data**.

### Do this

```bash
cd /application/wfmwatch

# 1. Pull latest code
git pull

# 2. Rebuild images with new code
docker build -f backend/Dockerfile.prod -t wfm-controlm-backend:prod ./backend
docker build -f frontend/Dockerfile.prod -t wfm-controlm-frontend:prod ./frontend

# 3. Recreate containers with new images (data volumes preserved)
docker compose -f docker-compose.prod.yml up -d --force-recreate

# 4. Verify
docker compose -f docker-compose.prod.yml ps
curl http://localhost:4005/health
```

**What `--force-recreate` does:** Stops old containers and starts new ones from rebuilt images. **Does not delete** `backend_prisma` volume — **your SQLite data is kept**.

Migrations run automatically on backend start (`RUN_MIGRATIONS=true` in compose).

### Optional — remove old unused images (safe cleanup)

After a successful deploy:

```bash
docker image prune -f
```

**What it does:** Removes dangling/unused image layers. **Does not remove** running containers or named volumes.

To see images:

```bash
docker images | grep wfm-controlm
```

You do **not** need to manually delete `wfm-controlm-backend:prod` before rebuild — `docker build -t same-tag` replaces the tag; `docker compose up --force-recreate` uses the new image.

### Do NOT do on routine code updates

| Command | Why |
|---------|-----|
| `docker compose down -v` | **Deletes SQLite volume — destroys all data** |
| Re-run `database/dml.sql` | Overwrites AppConfig / seed data |
| Change `CONFIG_ENCRYPTION_KEY` in `.env` | Breaks decryption of existing secrets |
| Delete `backend_prisma` volume | Destroys database |

---

## Part 7 — Do's and Don'ts

### DO

| Action | Command / note |
|--------|----------------|
| Clone from Git | `git clone https://github.com/sm5587/WFMControlM.git .` |
| Use `docker-compose.prod.yml` | Production stack with health checks |
| Seed **once** on first install | `apply-sql.js database/dml.sql` |
| Keep `.env` on server only | Never commit secrets |
| Use `docker compose down` | Stops app, **keeps data** |
| Use `up -d` after reboot | Brings app back |
| Rebuild + `--force-recreate` for updates | Preserves DB volume |
| Check status | `docker compose -f docker-compose.prod.yml ps` |
| Ensure `lib/db2jcc4.jar` exists | Required for DB2 features |
| Check `id -gn` before `chown` | Avoid invalid group errors |

### DON'T

| Action | Risk |
|--------|------|
| `docker compose down -v` | **Wipes database volume** |
| Copy Windows `node_modules/` or `dev.db` | Wrong platform / wrong port config |
| Run `dml.sql` after go-live | Overwrites live AppConfig |
| Change `CONFIG_ENCRYPTION_KEY` after data exists | Secrets unreadable |
| Delete `/application/wfmwatch/.env` casually | App won't start correctly |
| Assume public IP works without firewall rules | UI unreachable from laptop |
| Use `username:username` in `chown` without checking `id` | `invalid group` error |

---

## Part 8 — Troubleshooting

### Backend unhealthy / `Missing critical AppConfig values`

**Cause:** Database not seeded.

**Fix:**

```bash
cd /application/wfmwatch
docker compose -f docker-compose.prod.yml run --rm \
  -v "$(pwd)/database:/app/database:ro" \
  backend node scripts/apply-sql.js database/dml.sql
docker compose -f docker-compose.prod.yml restart backend
```

### Backend on port 4000 instead of 4005

**Cause:** Old `dev.db` baked into image or wrong AppConfig `infra.port`.

**Fix:** Ensure `backend/.dockerignore` includes `dev.db`, rebuild, and/or run `dml.sql` (sets `infra.port` to 4005), then restart backend.

### Frontend not starting — waits for backend healthy

**Cause:** Backend failed health check.

**Fix:** Fix backend first (`logs backend`), then `docker compose up -d frontend`.

### UI not loading from laptop but works on server

**Cause:** Network/firewall — not an app bug.

**Fix:** Use SSH tunnel (Part 5) or ask IT to open TCP **3005** and **4005**.

### `permission denied` on docker.sock

**Fix:** Log out/in after `usermod -aG docker $USER`, or use `newgrp docker`.

### Docker install conflict with `podman-docker`

**Fix:** `sudo dnf remove -y podman-docker` then install Docker CE (Part 2).

### `hello-world` fails with `podman.sock`

**Fix:** Unset `DOCKER_HOST`, remove Podman line from `~/.bashrc`, use Part 2.3.

---

## Part 9 — Windows Docker Desktop (local dev reference)

Same project on a Windows laptop:

```powershell
cd "C:\Users\<you>\Desktop\Tools\WFMControlM"
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml -f docker-compose.smoke.override.yml up -d
# First time seed:
docker compose -f docker-compose.prod.yml run --rm -v "${PWD}/database:/app/database:ro" backend node scripts/apply-sql.js database/dml.sql
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml up -d frontend
```

**Linux servers do NOT need** `docker-compose.smoke.override.yml` — use plain `docker-compose.prod.yml`.

See also: [DOCKER_INSTALLATION.md](DOCKER_INSTALLATION.md)

---

## Quick reference — command cheat sheet

```bash
# --- First install ---
cd /application/wfmwatch
git clone https://github.com/sm5587/WFMControlM.git .
cp .env.example .env && vi .env
docker build -f backend/Dockerfile.prod -t wfm-controlm-backend:prod ./backend
docker build -f frontend/Dockerfile.prod -t wfm-controlm-frontend:prod ./frontend
docker compose -f docker-compose.prod.yml up -d backend
docker compose -f docker-compose.prod.yml run --rm -v "$(pwd)/database:/app/database:ro" backend node scripts/apply-sql.js database/dml.sql
docker compose -f docker-compose.prod.yml restart backend
docker compose -f docker-compose.prod.yml up -d frontend

# --- Status ---
docker compose -f docker-compose.prod.yml ps
curl http://localhost:4005/health

# --- Stop (keep data) ---
docker compose -f docker-compose.prod.yml down

# --- Start again ---
docker compose -f docker-compose.prod.yml up -d

# --- Code update (keep data, no re-seed) ---
git pull
docker build -f backend/Dockerfile.prod -t wfm-controlm-backend:prod ./backend
docker build -f frontend/Dockerfile.prod -t wfm-controlm-frontend:prod ./frontend
docker compose -f docker-compose.prod.yml up -d --force-recreate
docker image prune -f
```

---

## Related docs

| Document | Description |
|----------|-------------|
| [DOCKER_INSTALLATION.md](DOCKER_INSTALLATION.md) | Windows Docker Desktop |
| [docker_install_steps.md](../docker_install_steps.md) | Build locally, push to registry |
| [production-readiness-checklist.md](production-readiness-checklist.md) | Go-live checklist |

---

**Validated on:** RHEL 9.7 (`pnqpilot02`), Docker 29.6.2, Compose v5.3.1, deploy path `/application/wfmwatch`.
