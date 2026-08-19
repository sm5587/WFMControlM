# WFM Watch — Security Review Response: WebSocket Authentication & CSWSH (Question 26)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 17 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Medium — No JWT authentication on Socket.IO handshakes; unauthenticated clients can subscribe to live monitoring streams

---

## Executive summary

| Control | Status | Notes |
|---------|--------|-------|
| **Origin validation (CSWSH mitigation)** | **Implemented** | Socket.IO CORS restricted to `infra.corsOrigins` (same allowlist as REST API) |
| **JWT on WebSocket handshake** | **Implemented** | Validates `auth.token` or Bearer header; rejects unauthenticated handshakes |
| **Room / subscription authorization** | **Implemented** | Permission-scoped stream rooms; `execution:follow` requires MONITOR_VIEW |
| **Transport encryption (HTTPS/WSS)** | **Configurable** | TLS at nginx + `infra.requireHttps=true` in production |
| **Network exposure** | **Compensating control** | Internal operators on corporate network/VPN only |

**Conclusion:** Cross-Site WebSocket Hijacking (CSWSH) risk is **low** because origins are allowlisted and the application is not exposed to the public internet. **JWT authentication on the Socket.IO handshake is implemented** (August 2026). Unauthenticated connections are rejected; broadcast streams are scoped to permission-based rooms. **Finding closed.**

---

## Security question (original)

> If WebSockets are used for the live monitor, are their connections authenticated and are origins strictly validated to prevent Cross-Site WebSocket Hijacking (CSWSH)?

---

## 1. Current architecture

WFM Watch uses **Socket.IO 4.x** for real-time updates to the Job Monitor and dashboard:

| Component | Location |
|-----------|----------|
| Server | `backend/src/websocket/index.ts` |
| Client hook | `frontend/src/hooks/useWebSocket.ts` |
| Reverse proxy | `frontend/nginx.prod.conf` (`/socket.io/` → backend) |

### 1.1 Events broadcast over WebSocket

| Event | Scope | Data sensitivity |
|-------|-------|------------------|
| `execution:started` | All connected clients | Operational — client codes, job names, execution IDs |
| `execution:progress` | Room `execution:{id}` | Operational — progress messages |
| `execution:completed` / `execution:failed` | All + room | Operational — status, durations, error summaries |
| `alert:triggered` | All connected clients | Operational — alert type, client, counts |
| `dashboard:update` | All connected clients | Aggregated stats (success rates, pending counts) |

These streams mirror data already available via authenticated REST endpoints (`/api/jobs`, `/api/alerts`, etc.) but are pushed in real time without an auth gate on the socket layer.

### 1.2 REST API vs WebSocket auth (gap)

| Layer | Authentication |
|-------|----------------|
| **REST `/api/*`** | JWT required — `authMiddleware` validates `Authorization: Bearer <token>` on every request |
| **Socket.IO handshake** | **None** — any client that passes CORS origin check is accepted |
| **Socket.IO events** | **None** — `subscribe`, `execution:follow`, `dashboard:refresh` require no credentials |

The frontend stores the JWT in `localStorage` (`wfm_token`) and attaches it to HTTP requests via `frontend/src/services/api.ts`, but **`useWebSocket.ts` does not pass the token** to Socket.IO:

```typescript
const socket = io(window.location.origin, {
  transports: ['websocket', 'polling'],
  // no auth: { token } — not sent today
});
```

---

## 2. Origin validation (CSWSH)

### 2.1 What is implemented

Socket.IO is initialized with a CORS allowlist from AppConfig:

**Key:** `infra.corsOrigins` (comma-separated, e.g. `http://localhost:3005,http://localhost:5173`)

```typescript
// backend/src/websocket/index.ts
io = new SocketServer(httpServer, {
  cors: {
    origin: corsOrigins.length > 0 ? corsOrigins : ['http://localhost:3005'],
    methods: ['GET', 'POST'],
  },
});
```

The Express REST layer uses the **same** `infra.corsOrigins` list (`backend/src/index.ts`). This means:

- Browser-based CSWSH from an arbitrary external site is **blocked** — the victim's browser will not include a permitted `Origin` header for cross-origin WebSocket upgrade requests from attacker-controlled pages.
- Socket.IO polling transport is likewise origin-restricted.

### 2.2 CSWSH risk assessment

| Scenario | Risk |
|----------|------|
| Malicious page on `evil.com` hijacks operator's browser session | **Low** — origin not in allowlist; handshake rejected |
| Non-browser client on corporate VPN connects directly to backend | **Medium** — no JWT required; full stream accessible |
| Compromised internal host scripts polling `/socket.io/` | **Medium** — same as above |

**CSWSH specifically** is mitigated by origin allowlisting. The **primary gap** is missing **authentication**, not missing origin checks.

---

## 3. Compensating controls (current deployment)

Until Phase 2 JWT enforcement is deployed:

| Control | Owner | Description |
|---------|-------|-------------|
| **Private network / VPN** | Infra | WFM Watch not internet-facing; operators on corporate RFX network |
| **HTTPS / WSS** | Infra + App | TLS at nginx; `infra.requireHttps=true` redirects HTTP |
| **CORS allowlist** | App (Ops config) | `infra.corsOrigins` limited to known frontend URLs |
| **REST API auth** | App | Sensitive actions (config, job trigger, log tail) require JWT + permissions |
| **No PII on WebSocket stream** | App design | Streams carry job/alert operational metadata, not employee PII |

**Risk acceptance basis (interim):** Exposure is limited to actors who already have network reachability to the WFM Watch backend — the same population that could attempt unauthenticated health checks or port scanning. Operational data on the socket is comparable to authenticated read-only API responses.

---

## 4. Remediation implemented (August 2026)

### 4.1 Backend — JWT on handshake

**File:** `backend/src/websocket/auth.ts`

Socket.IO middleware runs before `connection`:

- Token from `socket.handshake.auth.token` (primary) or `Authorization: Bearer` header
- Validated with the same `jwt.verify` / `secrets.jwtSecret` as REST API
- Unauthenticated or invalid tokens → handshake rejected (`Authentication required` / `Invalid or expired token`)

### 4.2 Frontend — pass token on connect

**File:** `frontend/src/hooks/useWebSocket.ts`

- Connects only when user is logged in
- Sends JWT via `auth: { token }` from `localStorage` (`wfm_token`)
- Disconnects on logout; reconnects on login
- Auth failures stop reconnection attempts for invalid/expired tokens

### 4.3 Permission-scoped broadcast streams

On connect, each socket joins rooms based on JWT permissions:

| Room | Permission | Events |
|------|------------|--------|
| `stream:dashboard` | Any authenticated user | `dashboard:update` |
| `stream:execution` | `MONITOR_VIEW` read | `execution:started`, `execution:completed`, `execution:failed` |
| `stream:alerts` | `ALERTS_VIEW` read | `alert:triggered` |
| `execution:{id}` | `MONITOR_VIEW` + valid ID | `execution:progress` (via `execution:follow`) |

Global `io.emit` to all clients was removed for sensitive events.

### 4.4 Verification

- [x] Unauthenticated Socket.IO handshake rejected
- [x] Authenticated UI connects after login
- [x] CORS still restricted to `infra.corsOrigins`
- [x] Unit tests: `backend/tests/unit/websocket-auth.test.ts`

---

## 5. Response to security team

**Current state:** Socket.IO uses **strict origin validation** (`infra.corsOrigins`) and **JWT authentication on handshake**. Unauthenticated clients cannot connect. Live streams are delivered only to authenticated users in permission-scoped rooms.

**Risk level:** **Closed** — was Medium (unauthenticated internal access); mitigated by JWT + permission rooms.

**Status:** **Implemented — August 2026**

**Production note:** Ensure WSS via nginx TLS and `infra.requireHttps=true`; keep `infra.corsOrigins` minimal.

---

## 6. Summary table for security questionnaire

| Item | Enforced today? | Evidence / notes |
|------|-----------------|------------------|
| Origin allowlist (CSWSH) | **Yes** | `infra.corsOrigins` on Socket.IO and Express CORS |
| JWT on WebSocket handshake | **Yes** | `backend/src/websocket/auth.ts` — same secret as REST |
| Permission on room subscribe | **Yes** | Stream rooms joined by JWT permissions on connect |
| WSS in production | **When configured** | nginx TLS + `infra.requireHttps` |
| Internal-only deployment | **Yes (ops)** | Not public internet-facing |

**Overall status:** **Closed.** Origin validation addresses CSWSH; JWT authentication and permission-scoped streams address unauthenticated internal access.

---

## 7. References

- WebSocket server: `backend/src/websocket/index.ts`
- WebSocket client: `frontend/src/hooks/useWebSocket.ts`
- JWT middleware (REST): `backend/src/middleware/index.ts`
- CORS config: `infra.corsOrigins` in AppConfig / `backend/src/index.ts`
- Nginx WebSocket proxy: `frontend/nginx.prod.conf`
- Security review tracker: `scripts/generate-security-review-excel.py` (item #26)

**Contact:** WFM Watch Development Team
