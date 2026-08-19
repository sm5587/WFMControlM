# WFM Watch — Security Review Response: JWT Algorithm Allowlist (Question 16)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 17 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Medium — No explicit JWT `algorithms` allowlist; potential algorithm-switching / `none` attacks

---

## Executive summary

| Control | Status | Notes |
|---------|--------|-------|
| **Signing algorithm** | **HS256** | Symmetric HMAC; explicit on sign and verify |
| **Verification allowlist** | **Implemented** | `jwt.verify(..., { algorithms: ['HS256'] })` |
| **`none` algorithm blocked** | **Implemented** | Forged alg=none tokens rejected |
| **RS256** | **Not used** | Optional future enhancement if asymmetric keys required |
| **Secret at rest** | **Separate item (#1)** | `secrets.jwtSecret` encryption tracked elsewhere |

**Conclusion:** Application is **protected from JWT algorithm-switching attacks** including the `none` algorithm. **Finding closed** for verification allowlist.

---

## Security question (original)

> What algorithm is used to sign JWTs? Is it a strong algorithm (e.g., RS256), and is the application protected from signature-stripping (`none` algorithm) attacks?

---

## Implementation

**Module:** `backend/src/utils/jwt-config.ts`

- `signSessionToken()` — always signs with `algorithm: 'HS256'`
- `verifySessionToken()` — always verifies with `algorithms: ['HS256']`

Used by:

- `backend/src/middleware/index.ts` (`verifyJwtToken`)
- `backend/src/services/token-revocation-service.ts` (session token creation)

**Tests:** `backend/tests/unit/jwt-config.test.ts` — rejects `none` and HS384 tokens.

---

## Response to security team

**Current state:** JWTs use **HS256** with an **explicit verification allowlist**. Algorithm-switching and `none`-algorithm attacks are blocked.

**RS256:** Not implemented — acceptable for internal operator tool with shared secret; RS256 can be evaluated if asymmetric signing is required.

**Status:** **Closed — August 2026**

---

## References

- `backend/src/utils/jwt-config.ts`
- `backend/tests/unit/jwt-config.test.ts`
- Security review tracker: item #16

**Contact:** WFM Watch Development Team
