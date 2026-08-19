# WFM Watch — Security Review Response: Audit Log Scrubbing (Question 24)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 17 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Medium — No global Winston redaction filter; session tokens and debug connection metadata could appear in log files

---

## Executive summary

| Control | Status | Notes |
|---------|--------|-------|
| **Global Winston redaction filter** | **Implemented** | All console/file log output passes through `redactFormat` before write |
| **Structured meta scrubbing** | **Implemented** | Sensitive object keys (`password`, `token`, `db2Password`, etc.) → `[redacted]` |
| **Pattern-based string scrubbing** | **Implemented** | JWT, Bearer, JDBC creds, env secrets, `password=` patterns |
| **Client update log redaction** | **Already in place** | `db2Password` redacted in client PATCH audit logs |
| **Admin UI secret masking** | **Already in place** | Secret AppConfig values masked in UI |
| **Remote log tail scrubbing** | **Implemented** | API response lines scrubbed before send to browser |
| **Remote log files at source** | **Not modified** | Client app-server logs unchanged; scrubbing on WFM Watch egress only |

**Conclusion:** Application audit logs now **systematically strip** passwords, session tokens, API keys, and common secret patterns before they are written to `combined.log`, `error.log`, or console. Remote log tail content is scrubbed before display. **Finding closed.**

---

## Security question (original)

> Are the audit logs scrubbed to ensure no sensitive data (passwords, session tokens, API keys) is accidentally written to log files?

---

## 1. Risk identified (pre-remediation)

WFM Watch uses **Winston** for application logging (`backend/src/utils/logger.ts`) to rotating local files and stdout. Before August 2026:

- Some call sites manually redacted fields (e.g. `db2Password` in client update logs).
- Admin UI masked secret config values.
- **No global filter** — debug logs could include JDBC URLs, env var names near secrets, or JWT/Bearer values if accidentally logged in message/meta.
- Remote log tail (`GET /api/jobs/:id/log-tail`) returned raw SSH `tail` output without scrubbing.

---

## 2. Remediation implemented

### 2.1 Global redaction module

**File:** `backend/src/utils/log-redaction.ts`

| Function | Purpose |
|----------|---------|
| `redactString()` | Pattern-based scrubbing on free-form log text |
| `redactValue()` | Deep redaction for Winston meta / JSON objects |
| `scrubRemoteLogLines()` | Line-by-line scrub for remote batch log tail API |

**Sensitive object keys** (case-insensitive): `password`, `token`, `secret`, `db2Password`, `smtpPass`, `jwtSecret`, `authorization`, `apiKey`, `DB2_PASS_OVERRIDE`, etc.

**String patterns redacted:**

| Pattern | Example |
|---------|---------|
| JWT | `eyJhbGci...` |
| Bearer token | `Authorization: Bearer ...` |
| JDBC with creds | `jdbc:db2://user:pass@host:50030/DB` |
| Env secrets | `DB2_PASS_OVERRIDE=...`, `CONFIG_ENCRYPTION_KEY=...` |
| Key=value | `password=...`, `token: ...` |
| Encrypted blobs | `enc:v1:...` (defence in depth) |

### 2.2 Winston integration

**File:** `backend/src/utils/logger.ts`

All log transports (Console, `error.log`, `combined.log`) use `redactFormat()` **before** formatting and write. Every `logger.info/warn/error/debug` call site is covered without per-call changes.

### 2.3 Remote log tail API

**File:** `backend/src/routes/jobs.ts`

SSH `tail` output is passed through `scrubRemoteLogLines()` before JSON response. Operators still see useful batch log context; credential-like substrings are masked.

### 2.4 Existing controls retained

- Client PATCH logs: `logFields.db2Password = '[redacted]'` (`clients.ts`)
- Config API never returns decrypted secrets by default; reveal is admin-audited
- Login routes log username/IP only — never the password field

---

## 3. Limitations (accepted)

| Item | Notes |
|------|-------|
| **Client-side log files** | WFM Watch does not modify logs on remote app servers |
| **Novel secret formats** | Unknown patterns may slip through until added to redaction rules |
| **SIEM forwarding** | Log shipper receives already-scrubbed WFM Watch logs; SIEM config is infra-owned (#22) |
| **Over-redaction** | Operational strings that resemble JWTs are rare; trade-off accepted for safety |

---

## 4. Response to security team

**Current state:** **Global Winston redaction is implemented.** Passwords, JWTs, Bearer tokens, API keys, JDBC credentials, and sensitive JSON keys are stripped from all application log output. Remote log tail responses are scrubbed on egress.

**Risk level:** **Closed** — was Medium (inconsistent scrubbing); mitigated by global filter + log-tail scrubbing.

**Status:** **Implemented — August 2026**

**Verification:** Unit tests in `backend/tests/unit/log-redaction.test.ts`.

---

## 5. Summary table for security questionnaire

| Item | Enforced today? | Evidence |
|------|-----------------|----------|
| Global log redaction | **Yes** | `backend/src/utils/logger.ts`, `log-redaction.ts` |
| Password fields in audit logs | **Yes** | Global filter + client update redaction |
| JWT / session tokens in logs | **Yes** | JWT and Bearer patterns |
| Remote log tail scrubbing | **Yes** | `jobs.ts` log-tail route |
| Admin UI secret masking | **Yes** | Existing Admin → Config UI |

**Overall status:** **Closed.**

---

## 6. References

- Redaction module: `backend/src/utils/log-redaction.ts`
- Logger: `backend/src/utils/logger.ts`
- Log tail: `backend/src/routes/jobs.ts`
- Tests: `backend/tests/unit/log-redaction.test.ts`
- Security review tracker: `scripts/generate-security-review-excel.py` (item #24)

**Contact:** WFM Watch Development Team
