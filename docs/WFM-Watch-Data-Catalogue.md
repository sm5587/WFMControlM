# WFM Watch — Data Catalogue & PII Assessment

**Application:** WFM Watch (WFM Control-M)  
**Version / date:** August 2026  
**Prepared for:** Security team — multi-region, single-server deployment approval  
**Repository:** `WFMControlM`

---

## 1. Executive Summary

WFM Watch is an **internal operations monitoring console** used by Zebra WFM support engineers to observe batch jobs, cron schedules, DB2 queues, unprocessed punch counts, and maintenance windows across ~77 Workforce Management (WFM) client environments globally.

| Question | Answer |
|----------|--------|
| Does the app store or expose **customer/employee PII** (names, SSN, bank accounts, phone, home address)? | **No** — by design. Queries are limited to operational WFM metadata. |
| Does the app access **banking/financial account data**? | **No** — it monitors WFM job infrastructure, not banking systems or account records. |
| What sensitive data **does** exist? | **Operator identity** (Zebra staff emails), **infrastructure credentials** (DB2/SSH, encrypted), and **client business identifiers** (company codes, hostnames). |
| Deployment model | **Single central server** aggregates read-only status from client app servers (SSH) and client DB2 databases (JDBC) across regions. |
| Data residency | Client workforce data **remains at source** (client DB2 / app servers). Only aggregates, caches, and ops metadata are stored on the WFM Watch server. |

---

## 2. Application Purpose & Scope

### 2.1 What the application does

- Monitors **cron jobs** on remote Linux app servers via SSH (read-only)
- Queries **DB2 batch/queue tables** for job status, stale pending counts, and queue health
- Reports **unprocessed punch counts** (aggregate only — no individual punch records)
- Manages **maintenance windows**, **alerting**, and **escalation** for WFM operations staff
- Provides **RBAC** for Zebra operators (Admin, Monitor, Read Only profiles)

### 2.2 What the application does NOT do

- Does not process payroll, issue payments, or access bank accounts
- Does not query employee master data, HR records, or time-clock punch detail
- Does not store or transmit SSN, national ID, credit card, or bank account numbers
- Does not serve end-customers or client employees — **operators only** (Zebra/internal staff)

### 2.3 Client context (including banking-sector clients)

Some WFM clients may operate in regulated industries (retail, pharmacy, financial services). WFM Watch connects only to each client's **WFM application infrastructure** (app servers + WFM DB2 schema). It does **not** integrate with core banking, CRM, or customer identity systems.

---

## 3. Deployment & Multi-Region Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  WFM Watch Server (single deployment)                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ React UI     │  │ Express API  │  │ SQLite (local cache) │  │
│  │ (operators)  │  │ + Scheduler  │  │ users, clients,    │  │
│  └──────────────┘  └──────────────┘  │ job caches, audit    │  │
│                                       └──────────────────────┘  │
└────────────┬───────────────────────────────┬────────────────────┘
             │ SSH (port 22)                 │ JDBC (port 50000/50030)
             ▼                               ▼
   ┌─────────────────────┐         ┌─────────────────────┐
   │ Client App Servers  │         │ Client DB2 (WFM)    │
   │ US / UK / AU / DE…  │         │ per-tenant database │
   │ (cron, log paths)   │         │ RWSUSER schema      │
   └─────────────────────┘         └─────────────────────┘
```

| Aspect | Detail |
|--------|--------|
| **Tenancy** | Logical isolation by `Client.clientId` (~77 tenants). Single SQLite database; no per-region app instances. |
| **Cluster field** | Groups clients geographically (e.g. CL12 US, CL52 UK, CL15 AU) for maintenance filtering — **not** a residency enforcement mechanism. |
| **Cross-region access** | Any authenticated operator with network reach can view any client's status. Access is controlled by **login + RBAC**, not geo-fencing. |
| **Data at rest (central)** | SQLite on WFM Watch host: ops metadata, encrypted credentials, caches, audit logs. |
| **Data at source (client)** | Full WFM datasets remain on client app servers and client DB2; most queries are live/read-through. |

**Security implication for single-server deployment:** The central server holds **infrastructure connection metadata** for all regions and **operational aggregates**. It does **not** consolidate employee or customer personal records.

---

## 4. Data Source Inventory

| # | Source | Protocol | Data Retrieved | Persisted Locally? | PII Risk |
|---|--------|----------|----------------|-------------------|----------|
| 1 | **SQLite** (app DB) | Local file | Users, clients, jobs, caches, config, audit | Yes — primary store | Operator PII only (see §6) |
| 2 | **Client DB2** (~77) | JDBC | Batch status, queue jobs, punch counts | Partial — queue cache only | **No employee PII in queries** |
| 3 | **Client app servers** | SSH | Cron entries, log file tails, file monitor paths | Cron cache; log excerpts transient | Low — ops metadata; log content uncontrolled |
| 4 | **SMTP / Mailpit** | SMTP | Alert/escalation email bodies | No | Operator email addresses in recipients |
| 5 | **Slack** | Webhook | Alert notifications | No | Channel metadata |
| 6 | **Load balancer (SSO)** | HTTP header | `X-Forwarded-Email` for corporate SSO | Access request record | Operator email |
| 7 | **Excel import** | HTTP upload | Maintenance calendar entries | Yes | No PII — schedule data |

---

## 5. External Data — Client DB2 Queries

All production queries are defined in `database/client-db2-queries.sql` and invoked via `db2DirectService`.

### 5.1 Tables queried and columns used

| DB2 Table | Purpose | Columns / Projection | Employee/Customer PII? |
|-----------|---------|---------------------|------------------------|
| `RWSUSER.BATCH_STATUS` | Batch job health | `JOB_TYPE`, `PLAN_TYPE`, `STATUS`, timestamps, `DESCRIPTION`, counts, `UNIT_SKEY` | **No** — job metadata |
| `RWSUSER.RFX_QUEUE` | Running queue jobs | `JOB_TYPE`, `EXEC_CRON`, `PARAM_2`, `LAST_JOB_TIME`, `JOBS_PENDING`, `QUEUE_STATUS` | **No** — scheduler metadata |
| `RWSUSER.RFX_QUEUE_JOB` | Batch detail subquery | `JOB_ESTATUS` counts by `BATCH_STATUS_ID` | **No** |
| `RWSUSER.TA_UNPROC_PUNCH` | Unprocessed punches | **`COUNT(1)` and `MIN(LAST_UPDATE_TIME)` only** | **No** — aggregate count; underlying table may hold employee data but **app never selects row-level punch data** |
| `RWSUSER.PRODUCT_FEATURE` | Feature flags | `FEATURE_VALUE` for `RTA_INTEGRATION` | **No** |
| `SYSIBM.SYSDUMMY1` | Connection test | `CURRENT TIMESTAMP` | **No** |
| `SYSCAT.TABLES` | Schema discovery | Table names, row counts | **No** |

### 5.2 PII categories NOT present in any coded query

| Category | Present in app? |
|----------|-----------------|
| Employee name (first/last) | **No** |
| SSN / national ID | **No** |
| Bank account / routing numbers | **No** |
| Credit/debit card numbers | **No** |
| Phone number | **No** |
| Home/mailing address | **No** |
| Email (client employees) | **No** |
| Date of birth | **No** |
| Individual time-clock punch records | **No** (count only) |

---

## 6. Local Data Store — SQLite Schema (PII Classification)

### 6.1 No customer/employee PII stored

The Prisma schema (`backend/prisma/schema.prisma`) contains **no models** for employees, customers, bank accounts, or identity documents.

### 6.2 Operator / internal identity data (PII — Zebra staff)

| Model | Fields | Classification |
|-------|--------|----------------|
| `User` | `username`, `email`, `displayName`, `passwordHash`, `timezone` | **Internal operator PII** |
| `AccessRequest` | `email`, `displayName`, `sourceIp` | **Internal operator PII + IP** |
| `NotificationRecipient` | `name`, `email` | **Internal/on-call contact PII** |
| `AuditLog` | `userName`, `ipAddress`, change details | **Audit trail — operator identifiers** |
| `AlertRule` / `EscalatedAlert` | `recipients`, `emailRecipients` (JSON) | **Email addresses** |

### 6.3 Business / infrastructure data (not personal PII)

| Model | Fields | Classification |
|-------|--------|----------------|
| `Client` | `clientId`, `name`, `cluster`, `timezone`, `db2Host`, `db2Port`, `db2Database`, `db2Username`, `db2Password` (encrypted) | **Client org identifier + infra credentials** |
| `AppServer` | `dns`, `environment`, `serverNum`, `sshPort` | **Infrastructure metadata** |
| `CachedCronJob` | `cronExpression`, `command`, `owner`, `logPath`, `serverDns` | **Operational — may contain service account names in paths** |
| `CachedQueueJob` | `jobData` (JSON from `RFX_QUEUE`) | **Operational batch metadata** |
| `Job` / `JobExecution` | job definitions, log excerpts, exit codes | **Operational** |
| `MaintenanceWindow` / `MaintenanceCalendar` | outage schedules | **Operational** |

### 6.4 Credentials & secrets (high sensitivity, not PII)

**Production approach:** Client DB2 passwords and application secrets (SMTP, SSH, JWT) are entered by authorised operators via **Admin → Config** and **Client** settings after deployment. Values are **AES-256-GCM encrypted at rest** using `CONFIG_ENCRYPTION_KEY` from the server environment. Bootstrap SQL seeds schema, RBAC, and non-secret defaults only — **client connection credentials are not deployed from seed files**.

| Location | How set | Protection |
|----------|---------|------------|
| `Client.db2Password` | Admin → Client edit (per client) | AES-256-GCM at rest |
| `AppConfig` secrets (JWT, SMTP, SSH) | Admin → Config | Encrypted at rest when `isSecret=true` |
| JWT session cookie (`wfm_session`) | Runtime | HttpOnly, HS256 signed |
| Operator login passwords | Admin → Users | bcrypt one-way hash |

---

## 7. API Data Exposure Summary

### 7.1 Authentication

- Username/password (bcrypt), break-glass master account, or SSO via load-balancer email header
- JWT in HttpOnly cookie; token revocation supported
- RBAC via profiles and 30+ permission functions

### 7.2 What authenticated APIs return

| Endpoint area | Data returned | Customer/employee PII? |
|---------------|---------------|------------------------|
| `/api/clients` | Client codes, names, DB2 host/port (password stripped) | **No** |
| `/api/db-monitor/*` | Batch summaries, connection status | **No** |
| `/api/db-jobs/*` | Queue job metadata (cached) | **No** |
| `/api/unprocessed-punch/*` | Punch **counts** per client | **No** |
| `/api/jobs/:id/log-tail` | Remote log lines (scrubbed) | **Uncontrolled content risk** — not designed for PII |
| `/api/admin/users` | Operator emails, display names | **Internal operator PII only** |
| `POST /api/db-monitor/:id/query` | Ad-hoc SELECT results | **Risk** — SELECT-only guard; not used in normal ops flows |

### 7.3 What APIs never return

- DB2 passwords (stripped; `db2PasswordSet` flag only)
- AppConfig secrets (masked; admin reveal endpoint audited separately)
- Row-level punch/employee records from `TA_UNPROC_PUNCH`

---

## 8. Frontend — Data Displayed to Operators

| Screen | Permission | Data shown | Customer/employee PII? |
|--------|------------|------------|------------------------|
| Dashboard | Authenticated | Job KPIs, execution status | **No** |
| Clients | `CLIENTS_VIEW` | Client code, name, cluster, DB2 host, server DNS | **No** |
| DB Monitor | `DBMONITOR_VIEW` | Batch status, stale pending alerts | **No** |
| DB Jobs | `DBJOBS_VIEW` | Queue jobs, critical flags | **No** |
| Unprocessed Punch | `UNPROC_PUNCH_VIEW` | Count per client | **No** |
| Jobs / Monitor | `JOBS_VIEW` / `MONITOR_VIEW` | Cron commands, log paths, status | **No** |
| File Monitor | `FILE_MONITOR_VIEW` | Pending/rejected **file names** on servers | **No** — filenames only |
| Admin Users | `USERS_VIEW` | Operator emails, names, access request IPs | **Internal PII** |
| Admin Config | `PERMISSIONS_EDIT` | Tunables; secrets masked | **No client PII** |

---

## 9. Logging & Data in Transit

### 9.1 Log redaction

`backend/src/utils/log-redaction.ts` scrubs: passwords, secrets, tokens, JWT, DB2 passwords, SMTP creds, authorization headers, encrypted blobs.

### 9.2 What may appear in logs

| Event | Fields | PII type |
|-------|--------|----------|
| Login / SSO | `username`, `email`, client IP | Operator + IP |
| DB2/SSH ops | `clientId`, timing, errors | Infra metadata |
| Access requests | `email`, IP | Operator PII |

Log files: `{infra.logDir}/combined.log`, `error.log` — rotated (10 MB × 5–10).

### 9.3 Retention (default purge config)

| Data type | Default retention |
|-----------|-------------------|
| Sync history | 30 days |
| Job executions | 30 days |
| Alert events | 60 days |
| Escalated alerts | 90 days |
| Audit log | 90 days |
| Cached cron jobs | 30 days |

---

## 10. PII Assessment — Formal Statement

### 10.1 Customer / employee PII — NOT exposed

WFM Watch is scoped to **WFM operational monitoring**. All coded DB2 queries access batch, queue, and aggregate punch status tables only. No query retrieves employee names, government IDs, financial account numbers, contact details, or individual time records.

**Evidence:**
- Query definitions: `database/client-db2-queries.sql`
- Punch service returns count only: `backend/src/services/unprocessed-punch-service.ts`
- No employee/customer models in schema: `backend/prisma/schema.prisma`

### 10.2 Internal operator PII — present (expected)

Zebra operator accounts (`email`, `displayName`), audit IPs, and notification recipient emails are stored for authentication, authorization, and alerting. This is **internal staff data**, not client banking customer data.

### 10.3 Residual risks (not PII exposure by design)

| Risk | Mitigation / note |
|------|-------------------|
| Ad-hoc DB2 SELECT (`POST /api/db-monitor/:id/query`) | SELECT-only keyword blocklist; restrict to trusted admin profiles in production |
| Remote log tail content | Log scrubbing before API return; content originates from client servers |
| Source DB2 tables may contain PII | App does not query employee master or punch detail tables |

---

## 11. Configuration & Environment Variables

Production `.env` is **bootstrap-only** — see `.env.example`. Runtime secrets and tunables live in **AppConfig** (SQLite), managed via Admin → Config after startup.

| Variable | Purpose | Contains secrets? |
|----------|---------|-------------------|
| `DATABASE_URL` | SQLite file path | No |
| `CONFIG_ENCRYPTION_KEY` | Master key for encrypting secrets at rest | **Yes** |
| `CONFIG_ENCRYPTION_KEY_PREVIOUS` | Key rotation (optional) | **Yes** |
| `DEPLOYMENT_LABEL` | UI environment badge | No |

AppConfig categories: SECRETS, INFRA, POLLING, THRESHOLDS, ENGINE, DISPLAY.

---

## 12. Controls Supporting Multi-Region Single-Server Deployment

| Control | Implementation |
|---------|------------------|
| Authentication | JWT (HttpOnly cookie), bcrypt passwords, optional SSO |
| Authorization | RBAC profiles + per-function permissions |
| Credential encryption | AES-256-GCM at rest for DB2 passwords and AppConfig secrets |
| Log scrubbing | Automatic redaction of secrets and tokens |
| Rate limiting | Login attempts (10 / 15 min / IP) |
| Token revocation | Logout, password change, admin revoke |
| HTTPS | Configurable via `infra.requireHttps` + reverse proxy |
| Data minimization | Punch count only; password stripping in API |
| Retention / purge | Configurable nightly purge per table |
| Audit trail | `AuditLog` for admin actions |

**Infrastructure controls (ops responsibility, documented in security review responses):**
- Private subnet deployment
- Egress firewall allowlist to registered client IPs (ports 22, 50000/50030, 587)
- TLS on operator-facing traffic (nginx/LB)
- DB2 transport TLS (requires DBA enablement on client DB2 servers)

---

## 13. Data Flow Summary by Category

| Data category | Origin | Stored on WFM Watch? | Exposed in UI/API? | Customer/employee PII? |
|---------------|--------|---------------------|-------------------|------------------------|
| Batch job status | Client DB2 | Transient / API only | Yes | **No** |
| Queue job metadata | Client DB2 | Cached in SQLite | Yes | **No** |
| Unprocessed punch count | Client DB2 | Transient / API only | Yes (count) | **No** |
| Cron schedules | Client SSH | Cached in SQLite | Yes | **No** |
| Client infra metadata | App config | SQLite | Yes (no passwords) | **No** |
| DB2/SSH credentials | Admin config | SQLite (encrypted) | No (masked) | N/A |
| Operator identity | Login/SSO | SQLite | Admin screens | **Internal PII** |
| Alert recipients | Admin config | SQLite | Admin/alert config | **Internal PII** |

---

## 14. References

| Document | Path |
|----------|------|
| Architecture & data flow | `docs/WFM_ControlM.md` |
| Prisma schema | `backend/prisma/schema.prisma` |
| DB2 query manifest | `database/client-db2-queries.sql` |
| Security review responses | `docs/WFM-Watch-Security-Review-*.md` |
| Security Q&A workbook | `docs/WFM-Watch-Security-Review-Response.xlsx` |
| Production checklist | `docs/production-readiness-checklist.md` |
| Bootstrap env template | `.env.example` |

---

## 15. Approval Checklist (for Security Team)

- [ ] Confirm WFM Watch scope is **operational monitoring only** — no banking core integration
- [ ] Accept that **client employee PII is not queried or stored** by application code paths
- [ ] Accept **internal operator PII** (Zebra staff emails) is required for auth/alerting
- [ ] Review residual risks: ad-hoc DB2 query, remote log content
- [ ] Confirm infra controls: private subnet, egress allowlist, TLS, credential management
- [ ] Approve single-server aggregation of **operational metadata** across regions

---

*Document generated from codebase analysis. For questions, contact the WFM Watch development team.*
