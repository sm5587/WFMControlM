# WFM Watch — Security Review Response: JWT Session Revocation (Question 14)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 17 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Medium — No server-side JWT revocation; logout client-only; stolen tokens valid until expiry (up to 24h)

---

## Executive summary

| Control | Status | Notes |
|---------|--------|-------|
| **Server logout / denylist** | **Implemented** | `POST /api/auth/logout` adds JWT `jti` to `RevokedToken` table |
| **Middleware revocation check** | **Implemented** | REST + WebSocket reject revoked or stale sessions |
| **Revoke all sessions (user)** | **Implemented** | `tokenVersion` bump + admin `POST /api/admin/users/:id/revoke-sessions` |
| **Revoke master sessions** | **Implemented** | `auth.masterTokenVersion` + `POST /api/admin/revoke-master-sessions` |
| **Auto-revoke on compromise signals** | **Implemented** | Password change, deactivation bump `tokenVersion` |
| **HttpOnly cookies (#15)** | **Planned separately** | Token still in `localStorage`; revocation closes server-side gap |

**Conclusion:** WFM Watch now **actively revokes JWT sessions** before natural expiry. Logout invalidates the current token on the server. Admins can invalidate all tokens for a user or for the master account. **Finding closed** for server-side revocation.

---

## Security question (original)

> How does the application actively revoke a JWT session token if a user's account is compromised or they log out, before natural expiry?

---

## 1. Architecture (implemented)

Each JWT issued at login includes:

| Claim | Purpose |
|-------|---------|
| `jti` | Unique token ID (UUID) — used for per-session denylist on logout |
| `tv` | Token version — must match user's `User.tokenVersion` (or `auth.masterTokenVersion` for master) |

**RevokedToken table** (SQLite): `jti`, `userId`, `expiresAt`, `revokedAt`, `reason`

### Revocation paths

| Event | Mechanism |
|-------|-----------|
| User clicks **Sign out** | Frontend calls `POST /api/auth/logout` → current `jti` denylisted |
| Admin **revoke user sessions** | `POST /api/admin/users/:id/revoke-sessions` → `tokenVersion++` |
| User **password change** / **deactivated** | `tokenVersion++` automatically |
| Admin **revoke master sessions** | `POST /api/admin/revoke-master-sessions` → `auth.masterTokenVersion++` |
| Permission refresh | Old `jti` denylisted; new token issued |

### Validation

- **REST:** `authMiddleware` verifies signature, then `isSessionActive()`
- **WebSocket:** Same check on handshake
- Expired denylist rows purged on startup

---

## 2. Deployment note

**Existing sessions without `jti`/`tv` are rejected** after upgrade — users must log in once to receive revocable tokens. This is intentional for security rollout.

Run migration: `npx prisma migrate deploy` (or apply `20260817130000_add_token_revocation`).

---

## 3. Response to security team

**Current state:** Server-side JWT revocation is **implemented**. Logout and admin actions invalidate sessions immediately; stolen tokens can be voided without waiting for 24h expiry.

**Status:** **Closed — August 2026**

**Remaining (separate item #15):** Move token storage from `localStorage` to HttpOnly cookie to reduce XSS theft risk — does not affect revocation capability.

---

## 4. References

- Service: `backend/src/services/token-revocation-service.ts`
- Auth routes: `backend/src/routes/auth.ts` (`/logout`)
- Admin routes: `backend/src/routes/admin.ts` (`/users/:id/revoke-sessions`, `/revoke-master-sessions`)
- Middleware: `backend/src/middleware/index.ts`
- Frontend logout: `frontend/src/context/AuthContext.tsx`
- Tests: `backend/tests/unit/token-revocation.test.ts`

**Contact:** WFM Watch Development Team
