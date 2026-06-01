# WFM Control-M — Unix Deployment Guide

## Option 1: Docker (Recommended)

The project already includes `docker-compose.yml`, backend `Dockerfile`, and frontend `Dockerfile`.

### Prerequisites

| Software           | Install (RHEL/CentOS)              | Purpose                    |
| ------------------ | ---------------------------------- | -------------------------- |
| Docker Engine 20+  | `sudo yum install docker-ce`       | Runs containers            |
| Docker Compose v2  | `sudo yum install docker-compose-plugin` | Orchestrates all services |
| Git                | `sudo yum install git`             | Clone the repo             |

### Steps

```bash
# 1. Transfer the project
scp -r ./WFMControlM user@unix-box:/opt/wfm-controlm

# 2. SSH in and configure
ssh user@unix-box
cd /opt/wfm-controlm
cp .env.example .env
vi .env   # Set JWT_SECRET, SMTP, DB2 paths, etc.

# 3. Launch all services
docker compose up -d --build

# 4. Verify
docker compose ps
curl http://localhost:4000/api/health   # backend
curl http://localhost:3000              # frontend
```

### What gets launched (from docker-compose.yml)

| Container            | Image             | Port | Purpose                        |
| -------------------- | ----------------- | ---- | ------------------------------ |
| wfm-controlm-api     | Node 18 (custom)   | 4000 | Express backend (SQLite)       |
| wfm-controlm-ui      | Nginx (custom)     | 3000 | React frontend (SPA)           |

---

## Option 2: Bare Metal (No Docker)

### Required Installations

| #  | Software                      | Version  | Purpose                                                    |
| -- | ----------------------------- | -------- | ---------------------------------------------------------- |
| 1  | **Node.js**                   | 18 LTS+  | Backend runtime & frontend build                           |
| 2  | **Nginx**                     | latest   | Serve frontend SPA + reverse proxy to backend              |
| 3  | **IBM DB2 ODBC CLI driver**   | clidriver| Required by `ibm_db` npm package for client DB2 databases  |
| 4  | **Python 3 + gcc/g++/make**   | —        | `ibm_db` and `ssh2` have native bindings that compile      |

### Install Commands (RHEL / CentOS / Amazon Linux)

```bash
# Node.js 18
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Build tools for native modules (ibm_db, ssh2)
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3

# Nginx
sudo yum install -y nginx
sudo systemctl enable --now nginx

# IBM DB2 CLI driver (for ibm_db npm package)
curl -LO https://public.dhe.ibm.com/ibmdl/export/pub/software/data/db2/drivers/odbc_cli/linuxx64_odbc_cli.tar.gz
mkdir -p /opt/ibm/db2
tar xzf linuxx64_odbc_cli.tar.gz -C /opt/ibm/db2
export IBM_DB_HOME=/opt/ibm/db2/clidriver
echo 'export IBM_DB_HOME=/opt/ibm/db2/clidriver' >> ~/.bashrc
echo 'export LD_LIBRARY_PATH=$IBM_DB_HOME/lib:$LD_LIBRARY_PATH' >> ~/.bashrc
source ~/.bashrc
```

### Deploy the Application

```bash
cd /opt/wfm-controlm

# 1. Configure environment
cp .env.example .env
vi .env
# Required settings:
#   DATABASE_URL=file:./dev.db
#   NODE_ENV=production
#   JWT_SECRET=<secure-random-string>
#   SMTP_HOST, SMTP_USER, SMTP_PASS (for email alerts)

# 2. Install & build
npm run install:all          # installs root + backend + frontend deps
npm run build:backend        # tsc → backend/dist/
npm run build:frontend       # vite build → frontend/dist/

# 3. Database setup
cd backend
npx prisma migrate deploy    # run SQLite migrations
npx prisma db seed           # optional: seed initial data
cd ..

# 4. Configure Nginx
sudo cp frontend/nginx.conf /etc/nginx/conf.d/wfm-controlm.conf
# IMPORTANT: Edit to replace 'backend:4000' with 'localhost:4000'
sudo sed -i 's/backend:4000/localhost:4000/g' /etc/nginx/conf.d/wfm-controlm.conf
sudo nginx -t && sudo systemctl reload nginx

# 5. Start backend with pm2 (process manager)
npm install -g pm2
cd backend
pm2 start dist/index.js --name wfm-backend
pm2 save
pm2 startup    # generates systemd service for auto-restart
```

---

## Key Environment Variables (from backend/src/config/index.ts)

| Variable                    | Required | Default              | Description                        |
| --------------------------- | -------- | -------------------- | ---------------------------------- |
| `DATABASE_URL`              | No       | `file:./dev.db`      | SQLite database file path          |
| `PORT`                      | No       | `4000`               | Backend listening port             |
| `NODE_ENV`                  | Yes      | `development`        | Set to `production`                |
| `JWT_SECRET`                | Yes      | dev fallback         | Auth token signing key             |
| `JWT_EXPIRES_IN`            | No       | `24h`                | Token expiry                       |
| `SMTP_HOST`                 | No       | `localhost`          | Email alert SMTP server            |
| `SMTP_PORT`                 | No       | `587`                | SMTP port                          |
| `SMTP_USER`                 | No       | (empty)              | SMTP username                      |
| `SMTP_PASS`                 | No       | (empty)              | SMTP password                      |
| `ALERT_FROM_EMAIL`          | No       | `wfm-controlm@localhost` | Alert sender address           |
| `SLACK_WEBHOOK_URL`         | No       | (empty)              | Slack alerts webhook               |
| `WFM_API_BASE_URL`          | No       | (empty)              | WFM REST API base URL              |
| `WFM_API_KEY`               | No       | (empty)              | WFM API authentication key         |
| `SSH_USERNAME`              | No       | (empty)              | SSH to app servers                 |
| `SSH_PASSWORD`              | No       | (empty)              | SSH password                       |
| `SSH_TOTP_SECRET`           | No       | (empty)              | TOTP for 2FA SSH                   |
| `SSH_CREDENTIALS_FILE`      | No       | (empty)              | Credentials file path              |
| `DB2_USERNAME`              | No       | (empty)              | Fallback DB2 username              |
| `DB2_PASSWORD`              | No       | (empty)              | Fallback DB2 password              |
| `KEEPER_SERVER_URL`         | No       | (empty)              | Keeper Secrets Manager URL         |
| `KEEPER_APP_ID`             | No       | (empty)              | Keeper app ID                      |
| `KEEPER_CLIENT_KEY`         | No       | (empty)              | Keeper client key                  |

---

## Important Gotchas

1. **`ibm_db` native module** — Requires `IBM_DB_HOME` pointing to the DB2 CLI driver, plus `gcc`/`make`/`python3` for compilation. If the Unix box is air-gapped, download the CLI driver tarball separately.

2. **`ssh2` native bindings** — Also compiles from C source; needs the Development Tools group installed.

3. **Nginx proxy_pass** — `frontend/nginx.conf` uses `proxy_pass http://backend:4000` which is a Docker DNS name. For bare metal, change `backend` to `localhost` or `127.0.0.1`.

4. **Firewall** — Open ports `3000` (frontend) and `4000` (backend API) — or only `3000` if using Nginx reverse proxy for both.

5. **PM2 for production** — Use `pm2` or a systemd unit file to keep the backend running and auto-restart on failure.

6. **SQLite in Docker** — The SQLite database file lives inside the container. Mount a volume for `/app/prisma` if you need persistence across container rebuilds.

---

## Quick Reference Commands

```bash
# Docker
docker compose up -d --build       # Start all services
docker compose down                # Stop all services
docker compose logs -f backend     # Tail backend logs
docker compose restart backend     # Restart backend only

# Bare metal (pm2)
pm2 start dist/index.js --name wfm-backend
pm2 restart wfm-backend
pm2 logs wfm-backend
pm2 stop wfm-backend
```
