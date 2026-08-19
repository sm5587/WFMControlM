# WFM Watch — Security Review Response: TLS/SSL (Questions 5 & 6)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 13 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Critical — DB2 (port 50000/50030) and SMTP (port 25) TLS/SSL enforcement

---

## Executive summary

| Connection | TLS enforceable by app today? | Status | Primary mitigation |
|------------|-------------------------------|--------|--------------------|
| **Operator browser → WFM Watch** | **Yes** | Implemented (config flags) | HTTPS at nginx/load balancer + `infra.requireHttps` |
| **WFM Watch → DB2 (JDBC)** | **No** (server does not support TLS) | Assessed & documented | Private network / egress firewall; DBA enables DB2 TLS when available |
| **WFM Watch → SMTP relay** | **Yes** (when relay supports STARTTLS) | Implemented (config flags) | `secrets.smtpTlsEnabled` + port 587 in production |
| **WFM Watch → App servers (SSH)** | **Yes** (SSH transport) | Already encrypted | OpenSSH 2.0 on port 22 |

**Conclusion:** The critical DB2 JDBC finding cannot be closed by application configuration alone because client DB2 instances do not expose TLS on the configured JDBC ports. We have removed non-functional DB2 JDBC SSL settings, implemented **application-layer HTTPS** for operator access, and retained **opt-in SMTP TLS** for production mail relays.

---

## Security question (original)

> Are the DB2 connections (port 50000) and SMTP connections (port 25) strictly enforcing TLS/SSL to prevent credentials and job data traversing the network in plaintext?

---

## 1. DB2 connections (JDBC, ports 50000 / 50030)

### 1.1 Current architecture

- WFM Watch backend initiates **outbound JDBC** connections to client DB2 hosts using IBM JCC (`db2jcc4.jar`) via a Java 8 Nashorn bridge (`lib/DB2Connector.js`).
- Connection details are stored per client in SQLite (`Client.db2Host`, `db2Port`, credentials encrypted at rest).
- Typical production port in our inventory: **50030** (not 50000); both are plain DRDA, not native TLS listeners.

### 1.2 Assessment performed (August 2026)

We ran connectivity and JDBC tests from the WFM Watch deployment network:

| Test | Result |
|------|--------|
| Wire-level TLS probe on port 50030 (64 client DB2 hosts) | **0/62** reachable hosts offered native TLS; all responded as **plain DB2 DRDA** |
| JDBC with `sslConnection=true` | **Connection timeout / failure** (60–120s) |
| JDBC without SSL (`sslConnection` not set) | **Success** (~1.5s); IBM security mechanism **3** (clear-text password at auth layer) |
| Alternate SSL ports (50001, 50031, etc.) | **None open** |

**Representative client (AAP):** `z182sp-aaprwsprdbs04.rfx.zebra.com:50030/RWS4`

### 1.3 Decision: remove DB2 JDBC SSL application flags

We initially added optional AppConfig keys (`infra.db2SslEnabled`, truststore path) to enable IBM `sslConnection=true`. Testing proved:

- Enabling the flag **breaks** DB2 connectivity (timeout) because **DB2 servers do not have TLS enabled** on these ports.
- Application code **cannot** encrypt JDBC traffic without server-side DB2 TLS or a network tunnel.

**Action taken:** Removed DB2 JDBC SSL configuration from application code. Connections use standard JDBC URLs; no `sslConnection` property is sent.

### 1.4 Compensating controls (accepted risk mitigation)

Until DBA enables DB2 TLS on client instances, we rely on **defence in depth outside the JDBC layer**:

| Control | Owner | Description |
|---------|-------|-------------|
| **Private network / VPC** | Infra / Network | Deploy WFM Watch in a restricted subnet; no public ingress except HTTPS reverse proxy |
| **Egress firewall allowlist** | Infra / Network | Restrict outbound connections to registered client IPs on ports **22**, **50030** (DB2), **587** (SMTP) only |
| **SSH path for cron/log ops** | Already in use | SSH (port 22) to app servers is encrypted (OpenSSH 2.0); DB2 CLI auth occurs on the remote host |
| **Credentials at rest** | Application | Client DB2 passwords encrypted with AES-256-GCM (`CONFIG_ENCRYPTION_KEY`); never returned via API |
| **Future DB2 TLS** | DBA + Development | When client DB2 instances support TLS, re-introduce JDBC SSL with truststore — tracked as infrastructure dependency |

### 1.5 Response to security team (DB2)

**Current state:** DB2 JDBC connections traverse the internal network without transport-layer TLS because **client DB2 servers do not support SSL on the configured ports**. This was verified by live connection testing, not assumed.

**Risk acceptance basis:** Traffic is confined to the corporate/private RFX network between WFM Watch and client DB2 hosts; egress is limited to known client endpoints. Plaintext JDBC is an **infrastructure limitation**, not an application misconfiguration.

**Required for full closure:** DBA to enable DB2 instance SSL/TLS and provide SSL port + truststore; then application JDBC SSL can be re-enabled.

---

## 2. SMTP connections (ports 25 / 587 / 465)

### 2.1 Current architecture

- Alert and escalation emails are sent via **Nodemailer** from the backend to a corporate SMTP relay.
- Configuration: AppConfig keys `secrets.smtpHost`, `secrets.smtpPort`, `secrets.smtpUser`, `secrets.smtpPass`.
- Local development uses Mailpit on `127.0.0.1:1025` (no TLS — dev only).

### 2.2 Application controls implemented

| AppConfig key | Default | Production guidance |
|---------------|---------|---------------------|
| `secrets.smtpTlsEnabled` | `false` | Set **`true`** for production relay |
| `secrets.smtpTlsRejectUnauthorized` | `true` | Keep **`true`** unless internal CA requires custom trust store |
| `secrets.smtpPort` | `1025` (dev) | Use **`587`** (STARTTLS) or **`465`** (SMTPS) — avoid plain **25** where possible |

When `secrets.smtpTlsEnabled=true`:

- Port **587:** `requireTLS: true` (STARTTLS enforced)
- Port **465:** implicit TLS (`secure: true`)
- Certificate validation per `secrets.smtpTlsRejectUnauthorized`
- **Mailpit / localhost** (`127.0.0.1:1025`) is exempt — TLS flags ignored for local dev

When `secrets.smtpTlsEnabled=false` (legacy/dev):

- Unauthenticated relays may use `ignoreTLS: true`
- Certificate validation disabled — **not acceptable for production**

### 2.3 Response to security team (SMTP)

**Current state:** Application supports strict SMTP TLS via Admin → Config. Production deployment must set `secrets.smtpTlsEnabled=true` and use port **587** or **465** with the corporate relay hostname (not port 25 plaintext).

**Action required (Ops):** Provide production SMTP relay hostname and confirm STARTTLS on 587 before go-live. Test via **Admin → Escalations → Test Email**.

---

## 3. Application HTTPS (operator access)

DB2 TLS cannot substitute for securing **operator access** to WFM Watch. Application-layer HTTPS protects:

- Login credentials and JWT tokens
- Admin configuration changes
- Alert data viewed in the browser
- API traffic between frontend and backend

### 3.1 Implementation

TLS terminates at **nginx** or an upstream load balancer. New AppConfig flags:

| Key | Default | Production |
|-----|---------|------------|
| `infra.trustProxy` | `false` | **`true`** when behind nginx/LB |
| `infra.requireHttps` | `false` | **`true`** in production |

When enabled, the backend:

- Trusts `X-Forwarded-Proto` / `X-Forwarded-For` from the reverse proxy
- Redirects HTTP → HTTPS (except `/health`)
- Sends **HSTS** headers via Helmet

Nginx production config (`frontend/nginx.prod.conf`) already forwards `X-Forwarded-Proto`. Example TLS server block is documented in comments for the ops team.

### 3.2 Response to security team (app HTTPS)

**Current state:** HTTPS enforcement is configurable and ready for production. TLS certificates are managed at the **infrastructure layer** (nginx/LB), which is standard practice for Node.js deployments.

**Action required (Ops):** Install TLS certificate on nginx/load balancer; set `infra.trustProxy=true` and `infra.requireHttps=true` in AppConfig.

---

## 4. Related question: egress filtering (Question 5)

> Is there strict egress firewall filtering on the App Server?

**Application role:** WFM Watch maintains a **client IP registry** (DB2 hosts, app server DNS) in the database but does **not** enforce firewall rules.

**Infra action required:** Configure host/VPC egress allowlist:

| Destination | Port | Purpose |
|-------------|------|---------|
| Client app servers | 22 | SSH (cron sync, log tail) |
| Client DB2 hosts | 50030 (typical) | JDBC batch/payroll queries |
| Corporate SMTP relay | 587 / 465 | Alert email |

---

## 5. Production checklist (security sign-off)

### Application team (Development)

- [ ] Set `infra.db2SslEnabled` to **`false`** (or remove legacy row) — DB2 JDBC SSL not supported by servers
- [ ] Set `secrets.smtpTlsEnabled` to **`true`**
- [ ] Set `secrets.smtpPort` to **`587`** (or `465`)
- [ ] Configure production SMTP relay host/credentials
- [ ] Set `infra.trustProxy` to **`true`**
- [ ] Set `infra.requireHttps` to **`true`**
- [ ] Verify test email and login over **HTTPS** only

### Infrastructure / Network team

- [ ] Deploy WFM Watch API in **private subnet**; expose only HTTPS reverse proxy
- [ ] Configure **egress firewall** allowlist to registered client IPs
- [ ] Install TLS certificate on nginx / load balancer
- [ ] Confirm SMTP relay supports STARTTLS on 587

### DBA team (future — DB2 TLS closure)

- [ ] Enable SSL/TLS on client DB2 instances (or confirm network encryption alternative)
- [ ] Provide SSL JDBC port and JKS truststore for WFM Watch server
- [ ] Re-test JDBC with `sslConnection=true` before re-enabling app-side DB2 SSL

---

## 6. Summary table for security questionnaire (Question 6)

| Item | Strict TLS enforced? | Evidence / notes |
|------|----------------------|----------------|
| DB2 JDBC (50030) | **No** — server limitation | Live test: `sslConnection=true` fails; plain JDBC succeeds. Mitigated by private network + egress controls. |
| SMTP (production) | **Yes** — when configured | Set `secrets.smtpTlsEnabled=true`, port 587. Dev Mailpit exempt. |
| Web UI / API | **Yes** — when configured | HTTPS at nginx + `infra.requireHttps=true`. |
| SSH to app servers | **Yes** | SSH-2.0 transport encryption. |

**Overall status:** **Partially mitigated.** Full closure of DB2 transport encryption depends on **DBA/infrastructure**, not application configuration alone. SMTP and operator HTTPS are **application-configurable** and must be enabled at production go-live.

---

## 7. References

- Application config: Admin → Config (`AppConfig` table)
- SMTP TLS: `backend/src/services/alert-service.ts`
- HTTPS enforcement: `backend/src/index.ts`, keys `infra.trustProxy`, `infra.requireHttps`
- Nginx TLS template: `frontend/nginx.prod.conf`
- DB2 connector: `lib/DB2Connector.js` (plain JDBC — no SSL parameters)
- Connectivity probe script: `scripts/probe-tls-support.py`

**Contact:** WFM Watch Development Team
