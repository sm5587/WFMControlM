# WFM Control-M

**Workforce Management Job Scheduling & Orchestration Platform**

A full-stack application for monitoring, managing, and orchestrating WFM batch jobs across 75+ client environments. Provides real-time DB2 batch status monitoring, cron job discovery from remote app servers, log analysis, and alerting.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS, Lucide icons |
| State Management | @tanstack/react-query (30-min cache), Socket.io-client |
| Routing | react-router-dom v6 |
| Backend | Express.js, TypeScript, Node.js |
| Database | SQLite (dev) / PostgreSQL 15 (prod), Prisma ORM |
| Real-time | Socket.io (WebSocket) |
| Scheduling | node-cron, cron-parser |
| SSH | ssh2 + otplib (TOTP 2FA keyboard-interactive auth) |
| DB2 | Java Nashorn (jjs) bridge with db2jcc4.jar JDBC driver |
| Container | Docker + Docker Compose |

---

## Project Structure

```
WFMControlM/
├── backend/
│   ├── prisma/           # Schema + seed
│   ├── src/
│   │   ├── config/       # Environment config
│   │   ├── engine/       # Scheduler, executor, workflow engine, DAG resolver
│   │   ├── middleware/    # Auth, logging, error handling
│   │   ├── routes/       # REST API routes (7 route files)
│   │   ├── services/     # Business logic (8 service files)
│   │   ├── websocket/    # Socket.io events
│   │   └── index.ts      # Express server entry point
│   └── .env
├── frontend/
│   ├── src/
│   │   ├── components/   # React components (9 feature folders)
│   │   ├── hooks/        # Custom hooks (3)
│   │   ├── services/     # API client (axios)
│   │   ├── types/        # TypeScript interfaces
│   │   └── App.tsx       # Router config
│   └── vite.config.ts
├── lib/
│   ├── DB2Connector.js   # Nashorn JDBC bridge script
│   └── db2jcc4.jar       # IBM DB2 JDBC driver
├── dbconnections/
│   └── Production/       # ~65 client DB2 connection files (JDBC URL, user, pass)
├── docker-compose.yml
├── start.ps1             # PowerShell startup script
└── .saved_credentials.json  # SSH credentials (base64-encoded)
```

---

## Getting Started

### Prerequisites

- Node.js 18+
- Java JRE 1.8 (for DB2 Nashorn connector at `C:\Program Files\Java\jre1.8.0_481\bin\jjs.exe`)

### Local Development

```powershell
# Install all dependencies
npm run install:all

# Initialize database
npm run db:migrate
npm run db:seed

# Start both services
.\start.ps1 start

# Backend:  http://localhost:4000
# Frontend: http://localhost:3000

# Stop
.\start.ps1 stop
```

### Docker

```powershell
docker compose up -d
# Services: postgres:5432, redis:6379, backend:4000, frontend:3000
```

---

## Architecture

### Data Flow

```
App Servers (SSH/TOTP)        DB2 Databases (JDBC)
       │                              │
       ▼                              ▼
   Sync Service               DB2 Direct Service
   (cron discovery)           (batch status queries)
       │                              │
       ▼                              ▼
   SQLite/Postgres  ◄────►  Express API (port 4000)
                                      │
                              ┌───────┼───────┐
                              ▼       ▼       ▼
                           REST    WebSocket  Scheduler
                              │       │       │
                              ▼       ▼       ▼
                        React SPA (port 3000)
```

### Backend Services

| Service | Purpose |
|---|---|
| `sync-service.ts` | SSH into app servers with TOTP 2FA, reads `/mount/backup/cronEntry`, filters WFM paths (`/mount/RWS4`), upserts jobs into DB. Also monitors remote log files for success/failure patterns. |
| `db2-direct-service.ts` | Connects to client DB2 databases via Java Nashorn (`jjs`), queries `BATCH_STATUS` table for batch job monitoring. Extracts `serverCode` from JDBC hostname for client matching. |
| `db2-connection-pool.ts` | Manages SSH+DB2 connection pool across ~75 clients with idle timeout and max concurrency. |
| `alert-service.ts` | Multi-channel alerting: Email, Slack, Webhook, SMS, In-App. |
| `sla-service.ts` | SLA tracking with status progression: ON_TRACK → WARNING → CRITICAL → BREACHED. |
| `keeper-service.ts` | Keeper Secrets Manager integration for DB2 credentials. |

### Engine Components

| Component | Purpose |
|---|---|
| `scheduler.ts` | Cron-based scheduling using `node-cron` + `cron-parser`, handles timezone-aware next-run computation. |
| `executor.ts` | Job execution supporting 9 job types (COMMAND, SCRIPT, HTTP, SQL, etc.), emits completion/failure events. |
| `workflow-engine.ts` | DAG-based workflow orchestration with parallel step execution. |
| `dependency-resolver.ts` | Topological sort (Kahn's algorithm) for DAG resolution and cycle detection. |

---

## Database Schema (16 Models)

### Core Models

| Model | Key Fields | Purpose |
|---|---|---|
| **Client** | `clientId` (unique code), `name`, `cluster`, `timezone`, `db2Host/Port/Database` | Multi-tenant client registry |
| **AppServer** | `clientId`, `environment` (PP/Prod), `dns`, `sshPort`, `timezone` | WAS servers per client |
| **Job** | `name` (unique), `jobType`, `clientId`, `cronExpression`, `command`, `logPath`, `lastRunStatus`, `serverTimezone` | Cron job definitions |
| **JobExecution** | `jobId`, `status` (10 states), `duration`, `exitCode`, `output` | Runtime execution instances |

### Workflow Models

| Model | Key Fields | Purpose |
|---|---|---|
| **Workflow** | `name`, `cronExpression`, `failureStrategy`, `maxParallelJobs` | DAG workflow definitions |
| **WorkflowStep** | `workflowId`, `jobId`, `stepOrder`, `onFailure` | Steps within workflow |
| **WorkflowStepDependency** | `dependentStepId`, `prerequisiteStepId` | Step-to-step edges |
| **WorkflowRun** | `workflowId`, `status`, `triggeredBy` | Workflow execution runs |

### Supporting Models

| Model | Key Fields | Purpose |
|---|---|---|
| **SyncHistory** | `clientId`, `syncType`, `jobsDiscovered/Created/Updated` | Tracks sync operations |
| **SLADefinition** | `jobId`, `slaType`, `deadlineTime`, `maxDuration` | SLA rules |
| **AlertRule** | `triggerType`, `channels`, `recipients` | Alert configuration |
| **AlertEvent** | `severity`, `title`, `acknowledged` | Alert instances |
| **ResourcePool** | `name`, `maxConcurrency`, `currentUsage` | Concurrency control |
| **AuditLog** | `entityType`, `action`, `userId` | Audit trail |

---

## API Endpoints

### Jobs (`/api/jobs`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/jobs` | List jobs (paginated, filterable by client/category/status) |
| GET | `/api/jobs/:id` | Get job detail |
| POST | `/api/jobs` | Create job |
| PUT | `/api/jobs/:id` | Update job |
| DELETE | `/api/jobs/:id` | Soft-delete job |
| POST | `/api/jobs/:id/trigger` | Trigger manual execution |
| POST | `/api/jobs/:id/toggle` | Toggle active/inactive |
| GET | `/api/jobs/:id/executions` | Get execution history |
| GET | `/api/jobs/upcoming` | Get jobs running in next N hours |

### Clients & Sync (`/api/clients`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/clients` | List all clients (enriched with DB2 connection info) |
| GET | `/api/clients/:id` | Client detail + app servers |
| PATCH | `/api/clients/:id` | Update client metadata |
| POST | `/api/clients/:id/sync` | Sync crons for one client (SSH → appserver) |
| POST | `/api/clients/sync-all-crons` | Sync crons for ALL clients (30s TOTP cooldown) |
| POST | `/api/clients/detect-timezones` | Detect server timezones via SSH |
| POST | `/api/clients/:id/check-logs` | Check remote log files for job status |

### DB Monitor (`/api/db-monitor`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/db-monitor/db-clients` | List DB2 clients from connection files |
| GET | `/api/db-monitor/db-clients/batch-status-all` | Batch status across all clients |
| GET | `/api/db-monitor/db-clients/:id/test` | Test DB2 connection |
| GET | `/api/db-monitor/db-clients/:id/batch-status` | Batch status for one client |
| POST | `/api/db-monitor/:id/query` | Execute SQL query on client DB2 |

### Alerts (`/api/alerts`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/alerts/rules` | List alert rules |
| POST | `/api/alerts/rules` | Create alert rule |
| GET | `/api/alerts/events` | List alert events |
| POST | `/api/alerts/events/:id/acknowledge` | Acknowledge alert |
| GET | `/api/alerts/summary` | Alert summary stats |

### Monitoring (`/api/monitoring`)

| Method | Path | Description |
|---|---|---|
| GET | `/api/monitoring/dashboard` | Dashboard KPI stats |
| GET | `/api/monitoring/live` | Live execution feed |
| GET | `/api/monitoring/health` | System health check |

---

## Frontend Pages

### Dashboard (`/dashboard`)
Two-column layout:
- **Left — DB2 Monitoring**: Total Clients card, Pending >30min card, Batch Summary (today's runs, errors, stale counts), Pending Job Alerts list
- **Right — Cron Jobs**: Total Jobs card, Upcoming (2h) card, Upcoming Jobs list, Recent Executions feed

### Clients (`/clients`)
Client registry with cluster grouping. Expandable rows show app server details and DB2 connection info (fetched from `dbconnections/Production/` files). DB2 column shows real database + host:port from JDBC connection strings.

### Cron Jobs (`/jobs`)
Two-panel layout:
- **Left sidebar**: Client list with job counts and DB2 connection status dots (green/red/gray). Search bar for filtering clients.
- **Right content**: Jobs table with columns: Job Name, Schedule, Command, Next Run, Last Run, Actions. Search bar.
- **Refresh icon**: Triggers SSH sync — for selected client only, or all clients with 30s TOTP cooldown.
- Job names strip client prefix when individual client is selected.

### Job Detail (`/jobs/:id`)
Individual job page showing execution history, log viewer modal, and job configuration.

### DB Monitor (`/db-monitor`)
Real-time DB2 batch status across all clients. Shows batch groups (completed/failed/active/pending/stale), per-client drill-down, and pending job alerts (>30 minutes stale).

### Alerts (`/alerts`)
Pending job alerts view. Shows affected clients and stale pending counts with severity badges (CRITICAL ≥10, WARNING ≥5).

### Monitor (`/monitor`)
Real-time job execution monitoring with WebSocket updates.

---

## Key Features

### Cron Job Discovery
- SSH into each client's production app server using keyboard-interactive auth (password + TOTP)
- Reads `/mount/backup/cronEntry` file
- Filters for WFM jobs (commands containing `/mount/RWS4`)
- Skips commented lines (`#`), `find` commands
- Extracts job name from script path, log path from output redirection
- Upserts into database with timezone-aware next-run computation

### DB2 Batch Monitoring
- Queries `BATCH_STATUS` table across 65+ client DB2 databases
- Uses Java Nashorn (`jjs`) as a bridge to JDBC (db2jcc4.jar)
- Connection files in `dbconnections/Production/{CLIENT}_DBString.txt` (JDBC URL, username, password, driver)
- Hostname pattern: `z182sp-{code}rws[m]prdbs04` — `serverCode` extracted via regex `/z182sp-(\w+?)rws/i`
- Detects stale pending jobs (>30 minutes since scheduled time)

### Log Monitoring
- Checks remote log files via SSH for failure/success patterns
- Failure keywords: ERROR, FAILED, EXCEPTION, ABORT, SEGFAULT, FATAL, CRITICAL, etc.
- Success keywords: completed successfully, SUCCESS, exit code 0, rc=0, etc.
- Compares log modification time against expected last run time

### Caching Strategy
- All jobs fetched once with `pageSize=10000`, cached 30 minutes via React Query (`jobs-all`)
- DB2 batch data cached 30 minutes (`all-batch-status`)
- DB2 client connections cached 30 minutes (`db-clients`, `db-client-connections`)
- Client list cached 30 minutes (`clients-list`)
- All filtering (client, search, cluster) done client-side

---

## Configuration

### Environment Variables (`.env`)

```env
DATABASE_URL="file:./dev.db"
PORT=4000
NODE_ENV=development
JWT_SECRET=dev-secret-change-in-production

# SSH (or use .saved_credentials.json)
SSH_USERNAME=
SSH_PASSWORD=
SSH_TOTP_SECRET=
SSH_PORT=22
SSH_TIMEOUT=15000
SSH_CREDENTIALS_FILE=

# DB2
DB2_USERNAME=
DB2_PASSWORD=

# DB2 Pool
DB2_POOL_MAX_CONNECTIONS=10
DB2_POOL_IDLE_TIMEOUT_MS=300000
DB2_POOL_ACQUIRE_TIMEOUT_MS=30000
```

### SSH Credentials File (`.saved_credentials.json`)

```json
{
  "username": "...",
  "password": "base64-encoded",
  "totp_secret": "base64-encoded"
}
```

### DB2 Connection Files (`dbconnections/Production/{CLIENT}_DBString.txt`)

```
jdbc:db2://z182sp-{code}rwsprdbs04.rfx.zebra.com:50000/{DATABASE}
username
password
com.ibm.db2.jcc.DB2Driver
```

---

## Docker Compose Services

| Service | Image | Port | Volume |
|---|---|---|---|
| `postgres` | postgres:15-alpine | 5432 | postgres_data |
| `redis` | redis:7-alpine | 6379 | redis_data |
| `backend` | Custom Dockerfile | 4000 | backend_logs |
| `frontend` | Custom Dockerfile (Nginx) | 3000→80 | — |

---

## Startup

```powershell
# Start both services
.\start.ps1 start        # or just .\start.ps1

# Start individually
.\start.ps1 backend
.\start.ps1 frontend

# Stop all
.\start.ps1 stop
```
