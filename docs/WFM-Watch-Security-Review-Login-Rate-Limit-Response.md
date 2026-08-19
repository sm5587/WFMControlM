# WFM Watch — Security Review Response: Login Rate Limiting (Question 8)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 18 August 2026  
**Related finding:** Medium — No rate-limiting on login endpoint

---

## Implementation

**Module:** `backend/src/middleware/login-rate-limit.ts`  
**Applied to:** `POST /api/auth/login`

| Setting | Value |
|---------|-------|
| Window | 15 minutes per IP |
| Max failed attempts | 10 per IP per window |
| Successful logins | Not counted (`skipSuccessfulRequests`) |
| Response when exceeded | HTTP 429 with generic error message |

Failed attempts continue to be logged with IP address.

**Tests:** `backend/tests/unit/login-rate-limit.test.ts`

---

## Response to security team

**Current state:** Login endpoint is **rate-limited** to block brute-force and credential-stuffing attacks.

**Status:** **Implemented — August 2026**
