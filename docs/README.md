# WFM Control-M — Job Orchestration Platform

A **Control-M-like** job scheduling and orchestration platform built for **Workforce Management (WFM)** products. Provides enterprise-grade job scheduling, DAG-based workflow orchestration, real-time monitoring, SLA management, and multi-channel alerting.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    Frontend (React)                   │
│  Dashboard │ Jobs │ Workflows │ Monitor │ SLA │ Alerts │
│  React Flow (DAG) │ Recharts │ WebSocket (live)      │
└──────────────────────┬───────────────────────────────┘
                       │ HTTP / WebSocket
┌──────────────────────▼───────────────────────────────┐
│                  Backend (Express + TS)               │
│  ┌─────────┐ ┌──────────┐ ┌────────────────────┐    │
│  │Scheduler│→│ Executor  │→│  Workflow Engine    │    │
│  │(cron)   │ │(run jobs) │ │(DAG orchestration) │    │
│  └─────────┘ └──────────┘ └────────────────────┘    │
│  ┌───────────┐ ┌────────────┐ ┌──────────────┐      │
│  │SLA Service│ │Alert Service│ │Monitoring Svc│      │
│  └───────────┘ └────────────┘ └──────────────┘      │
│                REST API + Socket.io                   │
└──────────┬──────────────────────┬────────────────────┘
           │                      │
    ┌──────▼──────┐       ┌──────▼──────┐
    │ PostgreSQL  │       │    Redis    │
    │ (Prisma ORM)│       │  (BullMQ)  │
    └─────────────┘       └─────────────┘
```

---

## Features

### Job Management
- **9 Job Types**: Command, Script, HTTP, SQL, Data Pipeline, Forecast, Schedule Generation, File Transfer, Custom
- **Cron Scheduling**: Any cron expression with timezone support
- **Priority Queue**: Jobs prioritized 1-10, processed by priority
- **Retry Policy**: Configurable retries with exponential backoff
- **Concurrency Control**: Max concurrent executions per job
- **Manual Trigger**: Run any job on demand

### Workflow Orchestration
- **Visual DAG Designer**: Drag-and-drop workflow builder using React Flow
- **Dependency Resolution**: Topological sort (Kahn's algorithm) for execution ordering
- **Parallel Execution**: Configurable max parallel steps per workflow
- **Failure Strategies**: STOP_ALL, CONTINUE_OTHERS, SKIP_DEPENDENTS
- **Per-Step Failure Handling**: fail, continue, or skip dependents

### Real-Time Monitoring
- **Live Dashboard**: KPI cards, success rate trends, duration trends
- **Execution Tracking**: Real-time status updates via WebSocket
- **Log Viewer**: Stream execution logs in real-time
- **Job Analytics**: Per-job statistics over configurable time periods

### SLA Management
- **4 SLA Types**: Completion Time, Start Time, Duration, Success Rate
- **Status Progression**: ON_TRACK → WARNING → CRITICAL → BREACHED
- **Configurable Thresholds**: Warning and critical threshold percentages
- **Compliance Dashboard**: Daily compliance rate tracking

### Alerting
- **9 Trigger Types**: Job/Workflow failures, timeouts, SLA breaches, consecutive failures, resource exhaustion
- **5 Notification Channels**: In-App, Email (SMTP), Slack, Webhook, SMS
- **Alert Rules**: Configurable rules with cooldown periods
- **Acknowledge System**: Individual and bulk acknowledgment

### WFM-Specific
- **Forecast Job Type**: Integration point for WFM forecast generation
- **Schedule Generation**: Integration point for WFM schedule generation
- **Data Pipeline**: ETL/data processing job support
- **WFM API Integration**: Configurable WFM system endpoint

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, TypeScript, Vite, TailwindCSS |
| Visualization | React Flow (DAG), Recharts (charts) |
| State | @tanstack/react-query, Socket.io-client |
| Backend | Express.js, TypeScript, Node.js |
| Database | PostgreSQL 15 with Prisma ORM |
| Queue | Redis 7 with BullMQ |
| Real-time | Socket.io (WebSocket) |
| Scheduling | node-cron |
| Auth | JWT |
| Logging | Winston |
| Validation | Zod |
| Container | Docker + Docker Compose |

---

## Quick Start

### Prerequisites
- **Node.js** 18+
- **PostgreSQL** 15+
- **Redis** 7+
- **Docker** (optional, for containerized setup)

### Option 1: Docker Compose (Recommended)

```bash
# Clone and navigate to project
cd WFMControlM

# Copy bootstrap env (DATABASE_URL + CONFIG_ENCRYPTION_KEY)
cp .env.example .env

# Start all services
docker compose up -d

# Access the UI
open http://localhost:3000
```

### Option 2: Local Development

```bash
# 1. Install dependencies
npm run install:all

# 2. Configure bootstrap environment
cp .env.example .env
# Set DATABASE_URL and CONFIG_ENCRYPTION_KEY — see .env.example

# 3. Set up database
cd backend
npx prisma migrate dev --name init
npx prisma generate
cd ..

# 4. Start development servers (backend + frontend concurrently)
npm run dev
```

The backend runs on **http://localhost:4000** and the frontend on **http://localhost:3000** (with API proxy).

---

## Project Structure

```
WFMControlM/
├── package.json              # Root monorepo scripts
├── docker-compose.yml        # Full stack deployment
├── .env.example              # Environment template
│
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   ├── tsconfig.json
│   ├── prisma/
│   │   └── schema.prisma     # Database schema (13 models)
│   └── src/
│       ├── index.ts           # Server bootstrap & wiring
│       ├── config/            # Centralized configuration
│       ├── models/types.ts    # TypeScript type definitions
│       ├── database/          # Prisma client singleton
│       ├── engine/
│       │   ├── scheduler.ts        # Cron-based job scheduling
│       │   ├── executor.ts         # Job execution (9 types)
│       │   ├── workflow-engine.ts   # DAG workflow orchestration
│       │   └── dependency-resolver.ts # Topological sort & DAG utils
│       ├── services/
│       │   ├── sla-service.ts      # SLA tracking & compliance
│       │   ├── alert-service.ts    # Multi-channel alerting
│       │   └── monitoring-service.ts # Dashboard & analytics
│       ├── routes/
│       │   ├── jobs.ts        # Job CRUD + trigger/toggle
│       │   ├── workflows.ts   # Workflow CRUD + DAG validation
│       │   ├── monitoring.ts  # Dashboard, live, history, health
│       │   ├── sla.ts         # SLA definitions & tracking
│       │   └── alerts.ts      # Alert rules & events
│       ├── middleware/        # Auth, error handling, logging
│       ├── websocket/         # Socket.io real-time events
│       └── utils/logger.ts    # Winston logging
│
└── frontend/
    ├── Dockerfile
    ├── nginx.conf             # Production reverse proxy
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── src/
        ├── main.tsx           # React entry point
        ├── App.tsx            # Router setup
        ├── types/             # TypeScript interfaces
        ├── services/api.ts    # Axios API client
        ├── hooks/             # useWebSocket hook
        └── components/
            ├── Layout.tsx          # Sidebar navigation
            ├── Dashboard/          # KPI cards, charts, live feed
            ├── Jobs/               # Job list, detail, create modal
            ├── Workflows/          # Workflow list, DAG designer
            ├── Monitor/            # Real-time execution monitor
            ├── SLA/                # SLA compliance dashboard
            └── Alerts/             # Alert events & rule management
```

---

## API Endpoints

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/jobs` | List jobs (search, filter, paginate) |
| GET | `/api/jobs/:id` | Get job details with relations |
| POST | `/api/jobs` | Create a new job |
| PUT | `/api/jobs/:id` | Update a job |
| DELETE | `/api/jobs/:id` | Delete a job |
| POST | `/api/jobs/:id/trigger` | Manually trigger a job run |
| POST | `/api/jobs/:id/toggle` | Enable/disable a job |
| GET | `/api/jobs/:id/executions` | Get execution history for a job |
| POST | `/api/jobs/executions/:id/cancel` | Cancel a running execution |

### Workflows
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/workflows` | List workflows |
| GET | `/api/workflows/:id` | Get workflow with full DAG |
| POST | `/api/workflows` | Create workflow with steps & dependencies |
| POST | `/api/workflows/:id/trigger` | Trigger a workflow run |
| POST | `/api/workflows/runs/:id/cancel` | Cancel a workflow run |
| DELETE | `/api/workflows/:id` | Delete a workflow |
| POST | `/api/workflows/validate-dag` | Validate DAG structure |

### Monitoring
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/monitoring/dashboard` | Dashboard KPIs & trends |
| GET | `/api/monitoring/live` | Currently active executions |
| GET | `/api/monitoring/history` | Execution history (paginated) |
| GET | `/api/monitoring/analytics/:jobId` | Per-job analytics |
| GET | `/api/monitoring/health` | System health check |

### SLA
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/sla/dashboard` | SLA compliance summary |
| GET | `/api/sla/definitions` | List SLA definitions |
| POST | `/api/sla/definitions` | Create SLA definition |
| GET | `/api/sla/tracking` | Active SLA tracking records |

### Alerts
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/alerts/rules` | List alert rules |
| POST | `/api/alerts/rules` | Create alert rule |
| DELETE | `/api/alerts/rules/:id` | Delete alert rule |
| GET | `/api/alerts/events` | Alert event history |
| POST | `/api/alerts/events/:id/acknowledge` | Acknowledge an alert |
| POST | `/api/alerts/events/acknowledge-all` | Acknowledge all alerts |
| GET | `/api/alerts/summary` | Alert summary by severity |

---

## WebSocket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `execution:started` | Server → Client | Job execution began |
| `execution:progress` | Server → Client | Execution log output |
| `execution:completed` | Server → Client | Execution finished successfully |
| `execution:failed` | Server → Client | Execution failed |
| `workflow:started` | Server → Client | Workflow run started |
| `workflow:completed` | Server → Client | Workflow run completed |
| `sla:warning` | Server → Client | SLA entering warning state |
| `sla:breached` | Server → Client | SLA breached |
| `alert:new` | Server → Client | New alert event created |
| `dashboard:update` | Server → Client | Dashboard stats refreshed |
| `subscribe` | Client → Server | Subscribe to a room/topic |
| `execution:follow` | Client → Server | Follow specific execution logs |

---

## Database Models

| Model | Description |
|-------|-------------|
| Job | Job definitions with scheduling, config, retry policies |
| JobExecution | Individual job run records with status, duration, logs |
| Workflow | DAG workflow definitions |
| WorkflowStep | Steps within a workflow (linked to jobs) |
| WorkflowStepDependency | Step-to-step dependency edges |
| WorkflowRun | Workflow execution instances |
| JobDependency | Inter-job dependencies |
| SLADefinition | SLA rule definitions |
| SLATracking | Runtime SLA tracking records |
| AlertRule | Alert rule configurations |
| AlertEvent | Alert event history |
| AuditLog | Audit trail for all operations |
| ResourcePool | Resource pool management |
| Calendar | Business calendar definitions |

---

## Configuration

**Bootstrap (`.env`)** — only what must exist before the database loads. See `.env.example`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | SQLite path (e.g. `file:./dev.db`) |
| `CONFIG_ENCRYPTION_KEY` | Yes | AES key for encrypting AppConfig secrets |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seed only | One-time `prisma db seed` bootstrap user |
| `KEEPER_CONFIG_FILE` | Optional | Keeper `ksm-config.json` path on disk |

**Runtime (AppConfig / Admin → Config)** — SMTP, JWT, port, CORS, SSH, DB2 paths, thresholds, polling, and engine settings. Seeded by `database/dml.sql` or `npm run db:seed`; editable in the UI after login.

---

## Development

```bash
# Run in development mode (hot reload)
npm run dev

# Run backend only
cd backend && npm run dev

# Run frontend only
cd frontend && npm start

# Run database migrations
npm run db:migrate

# Open Prisma Studio (database GUI)
cd backend && npx prisma studio

# Build for production
npm run build
```

---

## Comparison with Control-M

| Feature | Control-M | WFM Control-M |
|---------|-----------|---------------|
| Job Scheduling | ✅ | ✅ Cron-based with priority queue |
| Workflow DAGs | ✅ | ✅ Visual React Flow designer |
| Dependency Management | ✅ | ✅ Topological sort + conditions |
| SLA Monitoring | ✅ | ✅ 4 SLA types with thresholds |
| Multi-channel Alerts | ✅ | ✅ Email, Slack, Webhook, In-App |
| Real-time Monitoring | ✅ | ✅ WebSocket-based live dashboard |
| WFM Integration | ❌ | ✅ Forecast & Schedule Gen jobs |
| Open Source | ❌ | ✅ |
| Self-hosted | Enterprise | ✅ Docker Compose |

---

## License

Internal use — Zebra Technologies Workforce Management
