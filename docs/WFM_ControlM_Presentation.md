# WFM Control-M
## Job Scheduling & Orchestration Platform

**Workforce Management | Zebra Technologies**

---

## Slide 1: Introduction

**What is WFM Control-M?**

An enterprise-grade **job scheduling and orchestration platform** built for Workforce Management (WFM) products. It monitors and manages batch jobs across **75+ client environments** with:

- Real-time DB2 database monitoring
- Cron job discovery from remote application servers
- DAG-based workflow orchestration
- SLA tracking & multi-channel alerting
- Live dashboards with WebSocket updates

> Built to replace manual monitoring with a unified, automated platform.

---

## Slide 2: Problem Statement

| Before | After (WFM Control-M) |
|--------|----------------------|
| Manual SSH into 75+ servers to check jobs | Centralized dashboard for all clients |
| No visibility into batch job failures | Real-time alerts via Email, Slack, SMS |
| Cron jobs scattered across app servers | Auto-discovery and sync of cron entries |
| No SLA tracking | Automated SLA monitoring with breach detection |
| DB2 status checked client-by-client | Single-pane DB2 batch status across all clients |

---

## Slide 3: Tech Stack Overview

```
┌─────────────────────────────────────────┐
│      Frontend (React 18 + Vite)         │
│   TailwindCSS · ReactFlow · Recharts    │
└─────────────────┬───────────────────────┘
                  │  HTTP / WebSocket
┌─────────────────▼───────────────────────┐
│     Backend (Express + TypeScript)       │
│  Prisma ORM · Socket.io · node-cron     │
│  Winston · Zod · JWT · In-Memory Cache  │
└───────┬─────────────────┬───────────────┘
        │                 │
  ┌─────▼─────┐    ┌──────────────────┐
  │  SQLite    │    │ In-Memory Cache  │
  │ (16 Models)│    │ (Map + TTL)      │
  └────────────┘    └──────────────────┘
        │
  ┌─────▼──────────────────────────┐
  │ DB2 Databases (JDBC via Java)  │
  │ 75+ Client Environments        │
  └────────────────────────────────┘
```

---

## Slide 4: Backend — Core Technologies

| Component        | Technology          | Purpose                                           |
|------------------|---------------------|---------------------------------------------------|
| **Runtime**      | Node.js 18+         | Server-side JavaScript engine                      |
| **Language**     | TypeScript 5.3      | Type-safe development                              |
| **Framework**    | Express.js 4.18     | REST API server                                    |
| **ORM**          | Prisma 5.10         | Database access & migrations                       |
| **Database**     | SQLite              | Lightweight embedded data store (16 models)        |
| **Caching**      | In-Memory Maps      | Backend state cache (connections, credentials, tasks) |
| **Real-time**    | Socket.io 4.7       | WebSocket for live dashboard updates               |
| **Scheduling**   | node-cron 3.0 + cron-parser 4.9 | Cron-based job scheduling & expression parsing |
| **Auth**         | JWT (jsonwebtoken)   | Token-based authentication                        |
| **Logging**      | Winston 3.11 + Morgan 1.10 | Structured logging & HTTP request logging     |
| **Validation**   | Zod 3.22            | Runtime schema validation                          |
| **Security**     | Helmet 7.1 + CORS   | HTTP security headers & cross-origin control       |
| **Email**        | Nodemailer 6.9      | SMTP-based alert notifications                     |
| **SSH**          | ssh2 + otplib        | Remote server access with TOTP 2FA               |
| **DB2**          | SSH + db2 CLI / Java Nashorn (jjs) | DB2 queries via SSH commands & JDBC connector |
| **Date/Time**    | dayjs 1.11          | Timezone-aware date handling (UTC, TZ plugin)      |
| **Config**       | dotenv 16.4         | Environment variable management                    |

---

## Slide 5: Backend — Architecture

### Engine Layer (Brain of the System)

| Module                  | What It Does                                             |
|-------------------------|----------------------------------------------------------|
| **Scheduler**           | Cron-based job triggering, timezone-aware, pending tracking |
| **Executor**            | Runs 9 job types (COMMAND, SCRIPT, HTTP, SQL, etc.)      |
| **Workflow Engine**     | DAG orchestration with parallel step execution            |
| **Dependency Resolver** | Topological sort (Kahn's algorithm), cycle detection      |

### Service Layer

| Service              | What It Does                                              |
|----------------------|-----------------------------------------------------------|
| **Alert Service**    | Multi-channel notifications with cooldown throttling       |
| **SLA Service**      | Deadline tracking: ON_TRACK → WARNING → CRITICAL → BREACHED |
| **DB2 Direct Service** | Queries DB2 via Java Nashorn; batch status retrieval     |
| **DB2 Pool**         | Manages 75+ SSH+DB2 connections with idle timeout          |
| **Sync Service**     | SSH TOTP 2FA, cron discovery from remote servers           |
| **Monitoring Service** | Dashboard KPIs, trends, execution analytics              |
| **Keeper Service**   | Keeper Secrets Manager for DB2 credential rotation         |

---

## Slide 6: Backend — API Routes

| Endpoint         | Purpose                                        |
|------------------|------------------------------------------------|
| `/api/jobs`      | CRUD jobs, trigger execution, retry, upcoming   |
| `/api/workflows` | CRUD workflows, DAG visualization, execute      |
| `/api/monitoring`| Dashboard stats, analytics, execution logs      |
| `/api/sla`       | SLA definitions, tracking, compliance dashboard |
| `/api/alerts`    | Alert rules, events, channels, acknowledgment   |
| `/api/clients`   | Client registry, app servers, sync history      |
| `/api/db-monitor`| DB2 batch status, job groups, health checks     |

**Middleware:** JWT Auth · Request Logging · Error Handling · Rate Limiting

---

## Slide 7: Database Design (Prisma — 16 Models)

### Core Entities

- **Client** — 75+ client environments (code, name, cluster, timezone, DB2 config)
- **AppServer** — Per-client WAS servers with SSH connectivity
- **Job** — 9 job types, cron scheduling, retry policies, priority (1-10)
- **JobExecution** — Runtime tracking (status, duration, exit code, logs, resources)
- **JobDependency** — Job-to-job dependency chains with conditions

### Workflow Entities

- **Workflow** — DAG workflows with failure strategies
- **WorkflowStep** — Jobs in workflow with visual positioning (X, Y)
- **WorkflowStepDependency** — Step-to-step DAG edges
- **WorkflowRun** — Workflow execution instances

### Operations

- **SLADefinition** — 4 types: Completion By, Start By, Duration, Success Rate
- **SLATracking** — Per-execution SLA status with breach minutes
- **AlertRule** — 9 trigger types × 5 channels with cooldown
- **AlertEvent** — Alert instances with severity & acknowledgment
- **AuditLog** — Entity change tracking (who, what, when, from where)

---

## Slide 8: DB2 Integration

### How We Connect to 75+ Client Databases

```
Backend (Node.js)
     │
     ├─ Reads dbconnections/Production/{CLIENT}_DBString.txt
     │   (JDBC URL, username, password, driver class)
     │
     ├─ Spawns Java/Nashorn process
     │   └─ jjs -cp db2jcc4.jar DB2Connector.js -- <action> <client>
     │
     ├─ JDBC connects to DB2 database
     │   └─ Queries: BATCH_STATUS, job statuses, schedules
     │
     └─ Returns JSON → Backend → WebSocket → Live Dashboard
```

**Features:**
- Connection pooling with idle timeout & max concurrency
- SSH tunneling with TOTP 2-Factor Authentication
- Keeper Secrets Manager for credential rotation
- Batch status monitoring across all environments

---

## Slide 9: Real-Time Features (WebSocket)

### Socket.io Event System

| Event Category | Events |
|---------------|--------|
| **Execution** | `execution:started`, `execution:progress`, `execution:completed`, `execution:failed` |
| **Dashboard** | `dashboard:update` (live KPI refresh) |
| **Logs**      | `execution:follow` (live log streaming) |
| **Alerts**    | `alert:triggered` (instant notification) |
| **SLA**       | `sla:breached`, `sla:warning` |
| **Health**    | `heartbeat` (system health pulse) |

> Every job execution, SLA breach, and alert is pushed to the UI in real-time — no polling required.

---

## Slide 10: Frontend Highlights

| Feature | Technology |
|---------|-----------|
| **UI Framework** | React 18 + TypeScript |
| **Build Tool** | Vite 5 (fast HMR) |
| **Styling** | TailwindCSS with Zebra branding |
| **DAG Designer** | ReactFlow (visual workflow editor) |
| **Charts** | Recharts (execution trends, success rates) |
| **State** | @tanstack/react-query (server cache) |
| **Real-time** | Socket.io-client |
| **Routing** | React Router v6 |

### UI Modules
Dashboard · Jobs · Workflows · Monitor · SLA · Alerts · Clients · DB Monitor

---

## Slide 11: Job Types Supported

| # | Job Type          | Description                          |
|---|-------------------|--------------------------------------|
| 1 | **COMMAND**       | Shell/system command execution        |
| 2 | **SCRIPT**        | Script file execution (bash, python)  |
| 3 | **HTTP**          | REST API calls with configurable methods |
| 4 | **SQL**           | Database query execution              |
| 5 | **DATA_PIPELINE** | Data transformation workflows         |
| 6 | **FORECAST**      | WFM forecast generation jobs          |
| 7 | **SCHEDULE_GEN**  | WFM schedule generation jobs          |
| 8 | **FILE_TRANSFER** | File transfer operations              |
| 9 | **CUSTOM**        | User-defined custom job logic         |

---

## Slide 12: Security & Reliability

### Security
- **JWT Authentication** — Token-based API access control
- **Helmet** — HTTP security headers (XSS, clickjacking, MIME sniff)
- **Rate Limiting** — API throttling to prevent abuse
- **CORS** — Whitelisted origins only
- **TOTP 2FA** — Two-factor auth for SSH connections
- **Keeper Secrets Manager** — Secure credential storage & rotation

### Reliability
- **Retry with Exponential Backoff** — Configurable per job
- **Failure Strategies** — STOP_ALL, CONTINUE_OTHERS, SKIP_DEPENDENTS
- **Priority Queue** — 10 priority levels for job scheduling
- **Connection Pooling** — Managed DB2 pools with health checks
- **Audit Logging** — Full traceability of all changes

---

## Slide 13: Deployment

### Current Setup (Local Development)
```
npm run install:all        # Install all dependencies
npx prisma migrate dev     # Setup SQLite database
npm run dev                # Start backend (4000) + frontend (3000)
```

Or via PowerShell:
```
.\start.ps1               # Start both services
.\start.ps1 backend       # Backend only
.\start.ps1 frontend      # Frontend only
.\start.ps1 stop          # Stop all
```

| Service      | Port  | How It Runs               |
|-------------|-------|---------------------------|
| **Backend**  | 4000  | ts-node-dev (Express)     |
| **Frontend** | 3000  | Vite dev server           |
| **Database** | —     | SQLite (file-based)       |

> Docker Compose config exists for future containerized deployment but is not currently in use.

---

## Slide 14: Key Metrics

| Metric | Value |
|--------|-------|
| Client Environments | **75+** |
| DB2 Database Connections | **65+** |
| Job Types Supported | **9** |
| Database Models | **16** |
| API Route Groups | **7** |
| Backend Services | **8** |
| Alert Channels | **5** (Email, Slack, Webhook, SMS, In-App) |
| SLA Types | **4** |
| WebSocket Event Types | **8+** |

---

## Slide 15: Future Enhancements

<!-- FILL IN YOUR OWN ITEMS BELOW -->

| # | Enhancement | Description | Priority | Target |
|---|------------|-------------|----------|--------|
| 1 |            |             |          |        |
| 2 |            |             |          |        |
| 3 |            |             |          |        |
| 4 |            |             |          |        |
| 5 |            |             |          |        |

### Potential Areas (Template Suggestions — edit/replace as needed)
- [ ] Mobile-responsive monitoring app
- [ ] AI-powered anomaly detection for job failures
- [ ] Role-based access control (RBAC) with team management
- [ ] Historical trend analysis & predictive SLA forecasting
- [ ] Integration with ServiceNow / PagerDuty
- [ ] Self-service client onboarding portal
- [ ] Automated runbook execution on failure
- [ ] Multi-region HA deployment

---

## Slide 16: Thank You

**WFM Control-M**
Job Scheduling & Orchestration Platform

Built with Node.js · TypeScript · React · SQLite · DB2

Questions?

---

*Presentation by: [Your Name]*
*Date: [Presentation Date]*
*Team: Workforce Management, Zebra Technologies*
