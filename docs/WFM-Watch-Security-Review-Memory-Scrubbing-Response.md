# WFM Watch — Security Review Response: Password Memory Scrubbing (Question 3)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 17 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Passwords are not explicitly scrubbed/zeroed from the Node.js heap, leaving them vulnerable to local memory dumps.

---

## Executive summary

| Area | Full heap zeroing achievable? | Status | Mitigation |
|------|-------------------------------|--------|------------|
| **Decrypted DB2 passwords in Node.js** | **No** (immutable V8 strings) | Partially mitigated | Short-lived use; env cleanup after jjs exit; Buffer wipe in crypto |
| **DB2_PASS_OVERRIDE in child env** | **Yes** (object property delete) | **Implemented** | Cleared in `finally` after each connector run |
| **Keeper password cache** | **Partial** | **Implemented** | Passwords no longer cached; usernames still cached |
| **AppConfig secrets (SSH/SMTP)** | **No** | Accepted limitation | Encrypted at rest; never returned via API; server access controls |

**Conclusion:** Node.js cannot guarantee that decrypted password strings are removed from the V8 heap before garbage collection. We have implemented **defence-in-depth measures** to minimize credential lifetime and mutable-buffer exposure. Residual risk is accepted with compensating server-hardening controls (private subnet, restricted OS access, no core dumps in production).

---

## Security question (original)

> How does the application handle decrypted client DB2 passwords in memory? Are they immediately scrubbed or zeroed out after a connection is established?

---

## 1. Current architecture

1. Client DB2 passwords are stored **encrypted at rest** (AES-256-GCM via `CONFIG_ENCRYPTION_KEY`) in SQLite.
2. When a DB Monitor / Payroll / Unprocessed Punch query runs, the backend:
   - Decrypts the password in Node.js (or fetches from Keeper Secrets Manager).
   - Passes it to a **short-lived** Java Nashorn child process (`jjs`) via `DB2_PASS_OVERRIDE`.
   - The child opens a JDBC connection, runs the SQL, returns JSON, and exits.
3. Passwords are **never returned** in API responses (`db2PasswordSet: true/false` only).

---

## 2. Node.js limitation (why full scrubbing is not possible)

JavaScript **strings are immutable**. Once `decryptSecret()` returns a string, that value exists as a V8 heap object until garbage collection. There is no API to zero-fill string memory (unlike `SecureString` in .NET or explicit `memset` in C).

**Implication:** A local attacker with permission to attach a debugger or dump process memory *may* find password strings until GC runs. This is a **platform constraint**, not a WFM Watch-specific gap.

---

## 3. Actions implemented (August 2026)

### 3.1 Clear child-process env after each DB2 connector run

`DB2_PASS_OVERRIDE` is deleted from the connector env object in a `finally` block as soon as the `jjs` child exits (success or failure).

**File:** `backend/src/services/db2-direct-service.ts`  
**Utility:** `backend/src/utils/secure-memory.ts` → `clearSensitiveEnvVars()`

This prevents the password from remaining in the in-memory env object reused across connector invocations.

### 3.2 Wipe mutable crypto Buffers after encrypt/decrypt

Intermediate `Buffer` objects used in AES-256-GCM operations are zero-filled in `finally` blocks after the UTF-8 string result is produced.

**File:** `backend/src/utils/crypto.ts`  
**Utility:** `wipeBuffer()`

This reduces exposure of ciphertext/plaintext in mutable Buffer allocations (distinct from the immutable result string).

### 3.3 Do not cache Keeper passwords

Keeper `login` fields remain cached (TTL configurable via `engine.keeperCacheTtlMins`). **Password fields are fetched on each use** and are not stored in the in-memory Keeper cache.

**File:** `backend/src/services/keeper-service.ts`

### 3.4 Existing controls (unchanged)

| Control | Description |
|---------|-------------|
| Encryption at rest | AES-256-GCM for `Client.db2Password` and `AppConfig` secrets |
| API redaction | Password fields never serialized to clients; update logs redact `db2Password` |
| Short-lived JDBC | Child `jjs` process exits after each query; no long-lived DB2 pool holding passwords in Node |
| Optional Keeper | Production can source passwords from Keeper vault instead of DB storage |

---

## 4. Residual risk & compensating controls

| Residual risk | Compensating control | Owner |
|---------------|---------------------|-------|
| Decrypted password strings in V8 heap until GC | Run backend on hardened hosts; disable core dumps; restrict shell/debug access | Infra / Ops |
| AppConfig secrets (SSH password, SMTP) held in config cache after startup | Secrets encrypted at DB; config API masks values; server RBAC | Application + Infra |
| Child JVM may briefly hold password in its heap | Process exits immediately after query; same OS hardening as above | Infra / Ops |

---

## 5. Response to security team

**Current state:** WFM Watch minimizes password lifetime in memory but **cannot guarantee heap scrubbing** of JavaScript strings. This is consistent with Node.js security guidance and industry practice for interpreted runtimes.

**Implemented mitigations:** Env cleanup after connector exit, Buffer wiping in crypto, no Keeper password caching, no credential logging, no API exposure.

**Accepted risk basis:** Application runs in a **private subnet** with restricted operator and OS access. Memory-dump attacks require **prior compromise** of the application host. Credentials are encrypted at rest and used only for outbound DB2 connections to known client hosts.

**Not planned:** Attempting to hold all secrets exclusively in native `Buffer` objects — would require rewriting JDBC integration and third-party SDK usage; marginal benefit given V8 string copies at API boundaries.

---

## 6. Verification

Unit tests:

- `backend/tests/unit/secure-memory.test.ts` — Buffer wipe and env cleanup
- `backend/tests/unit/crypto.test.ts` — encrypt/decrypt round-trip (unchanged behaviour)
- `backend/tests/unit/db2-keeper.test.ts` — `DB2_PASS_OVERRIDE` cleared after connector mock exit

Run:

```bash
cd backend && npm test -- --testPathPattern="secure-memory|crypto|db2-keeper"
```

---

## 7. References

- `backend/src/utils/secure-memory.ts`
- `backend/src/utils/crypto.ts`
- `backend/src/services/db2-direct-service.ts`
- `backend/src/services/keeper-service.ts`
- `scripts/generate-security-review-excel.py` (finding #3)
