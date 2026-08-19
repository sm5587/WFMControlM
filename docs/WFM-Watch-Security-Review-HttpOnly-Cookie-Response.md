# WFM Watch — Security Review Response: HttpOnly Session Cookie (Question 15)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 17 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Medium — JWT stored in `localStorage`; vulnerable to XSS token theft

---

## Executive summary

| Control | Status | Notes |
|---------|--------|-------|
| **HttpOnly session cookie** | **Implemented** | JWT in `wfm_session` cookie — not readable by JavaScript |
| **Secure flag** | **Configurable** | Set when `infra.requireHttps=true` or production |
| **SameSite** | **Strict** | CSRF mitigation for cookie-based auth |
| **CORS credentials** | **Already enabled** | `credentials: true` + explicit origins |
| **Frontend token storage** | **Removed** | No `localStorage` JWT; session restored via `GET /api/auth/me` |
| **WebSocket auth** | **Cookie-based** | Socket.IO `withCredentials: true`; server reads cookie on handshake |
| **Bearer header fallback** | **Retained** | For scripted/API clients only; browser UI uses cookie |

**Conclusion:** Browser sessions no longer expose the JWT to JavaScript. XSS cannot exfiltrate the session token from `localStorage`. **Finding closed.**

---

## Security question (original)

> How is the session token stored in the user's browser? Is it in a secure, HttpOnly cookie to prevent theft via XSS?

---

## 1. Implementation

### Backend (`backend/src/utils/session-cookie.ts`)

| Setting | Value |
|---------|-------|
| Cookie name | `wfm_session` |
| `httpOnly` | `true` |
| `sameSite` | `strict` |
| `secure` | `true` when HTTPS enforced / production |
| `path` | `/` |
| `maxAge` | Matches `secrets.jwtExpiresIn` |

Set on: `POST /api/auth/login`, `POST /api/auth/refresh-permissions`  
Cleared on: `POST /api/auth/logout`

Token is **not returned** in login JSON response body (browser clients).

### Frontend

- Axios: `withCredentials: true`
- `fetch` streaming: `credentials: 'include'`
- Socket.IO: `withCredentials: true`
- Auth bootstrap: `GET /api/auth/me` on app load (cookie sent automatically)
- Legacy `localStorage.wfm_token` cleared on startup

### Auth middleware

Reads token from cookie first, then optional `Authorization: Bearer` header.

---

## 2. Deployment notes

- Production: enable `infra.requireHttps=true` and TLS at nginx so `Secure` cookie flag is set.
- Dev: cookie works over HTTP on localhost (Secure=false when HTTPS not required).
- Users with old `localStorage` tokens must log in once after deploy.

---

## 3. Response to security team

**Current state:** Session JWT is stored in an **HttpOnly, SameSite=Strict** cookie. JavaScript cannot access the token. Combined with server-side revocation (#14), compromised XSS cannot steal the active session token from browser storage.

**Status:** **Closed — August 2026**

---

## 4. References

- Cookie helper: `backend/src/utils/session-cookie.ts`
- Auth routes: `backend/src/routes/auth.ts`
- Frontend: `frontend/src/context/AuthContext.tsx`, `frontend/src/services/api.ts`
- WebSocket: `frontend/src/hooks/useWebSocket.ts`, `backend/src/websocket/auth.ts`
- Tests: `backend/tests/unit/session-cookie.test.ts`

**Contact:** WFM Watch Development Team
