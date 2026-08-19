# WFM Watch — Security Review Response: Path Traversal on Cron Log Paths (Question 11)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 13 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** High — Path traversal via cron log paths passed to remote SSH commands

---

## Executive summary

| Control | Status | Notes |
|---------|--------|-------|
| **Log path allowlist** | **Implemented** | Paths must be under `infra.sshWfmPathPrefix` (default `/mount/RWS4/`) or `/mount/backup` |
| **Traversal / injection rejection** | **Implemented** | Rejects `..`, non-absolute paths, and shell metacharacters |
| **File type restriction** | **Implemented** | Log paths must end in `.log`, `.txt`, or `.out` |
| **Defense in depth at use** | **Implemented** | Re-validated before `stat`/`tail`; API returns 400 for invalid stored paths |
| **Safe SSH quoting** | **Implemented** | Shared `shellQuote()` for all remote file operations |
| **Related Q13 (command injection)** | **Partially addressed** | `pgrep`/`grep` search terms sanitized in sync-service; full SSH audit remains Phase 2 |

**Conclusion:** The path traversal finding on cron log paths is **closed for Phase 1 go-live**. Malicious or out-of-scope paths (e.g. `>> /etc/shadow`) are rejected at ingest and cannot reach remote `stat`/`tail` commands.

---

## Security question (original)

> How does the application validate the log path from client cron files to prevent Path Traversal attacks (e.g., reading /etc/shadow)?

---

## 1. Risk identified (pre-remediation)

WFM Watch discovers batch jobs by reading a cron entries file from client app servers over SSH (`/mount/backup/cronEntry`). Log output paths were extracted from cron commands using regex and passed directly into remote shell commands:

```bash
stat --format='%s %Y' '<logPath>'
tail -300 '<logPath>'
tail -n N "<logPath>"   # via GET /api/jobs/:id/log-tail
```

Because there was **no allowlist or sanitization**, a crafted cron redirect (e.g. `>> /etc/shadow 2>&1`) could theoretically cause the application to read sensitive files on the remote host.

**Scope:** This affects remote files on **client app servers** accessed via authenticated SSH — not the WFM Watch server filesystem. The risk is **unauthorized remote file read** via the application's SSH session, not local path traversal on the WFM Watch host.

---

## 2. Remediation implemented

### 2.1 Central validation module

**File:** `backend/src/utils/remote-path.ts`

| Function | Purpose |
|----------|---------|
| `validateRemoteLogPath()` | Allowlist + normalization; returns `null` if invalid |
| `validateRemoteCronFilePath()` | Validates the cron entry file path before `cat` |
| `shellQuote()` | POSIX-safe single-quote escaping for SSH arguments |
| `sanitizePgrepSearchTerm()` | Restricts `pgrep -f` to safe script basenames |
| `sanitizeGrepKey()` | Restricts `grep` keys to paths under the WFM prefix |

### 2.2 Validation rules (log paths)

A path is **accepted** only if **all** of the following hold:

1. Absolute path (starts with `/`)
2. No `..` segments (before or after normalization)
3. No shell metacharacters: `; | & \` $ ( ) < >` or newlines
4. Under an allowed prefix:
   - `infra.sshWfmPathPrefix` (AppConfig, default `/mount/RWS4`)
   - `/mount/backup`
5. Filename ends with `.log`, `.txt`, or `.out`

**Examples:**

| Cron redirect | Result |
|---------------|--------|
| `>> /mount/RWS4/logs/batch/RunPayroll.log 2>&1` | **Accepted** |
| `>> /mount/backup/cronEntry.out` | **Accepted** |
| `>> /etc/shadow 2>&1` | **Rejected** — outside allowlist |
| `>> /mount/RWS4/logs/../../etc/passwd.log` | **Rejected** — traversal |
| `>> /mount/RWS4/logs/a;id.log` | **Rejected** — shell metacharacter |

### 2.3 Where validation is enforced

| Layer | Location | Behaviour |
|-------|----------|-----------|
| **Ingest** | `sync-service.ts` → `extractLogPath()` | Invalid paths stored as `null`; warning logged; log check not enabled |
| **Cron file read** | `sync-service.ts` | `infra.sshCronEntryPath` validated before `cat` |
| **Log monitoring** | `sync-service.ts` → `checkSingleJobLog()` | Re-validates DB-stored path; blocks SSH if invalid |
| **Operator API** | `GET /api/jobs/:id/log-tail` | Returns HTTP 400 if path fails validation |
| **SSH quoting** | sync-service, jobs route, file-monitor-service | All paths passed through `shellQuote()` |

### 2.4 Unit tests

**File:** `backend/tests/unit/remote-path.test.ts` — 12 tests covering valid paths, traversal, metacharacters, allowlist boundaries, and quoting.

---

## 3. Response to security team (Question 11)

**Current state:** Log paths extracted from client cron files are validated against a **fixed allowlist** before storage and again before any remote file operation. Paths outside `/mount/RWS4/` (configurable) and `/mount/backup`, paths containing traversal sequences or shell metacharacters, and paths without approved extensions are **rejected**. Remote `stat` and `tail` commands use **shell-safe quoting**.

**Residual risk:** Low for log-path traversal. Cron **command text** is still stored and parsed locally; related command-injection hardening (Question 13) is partially complete (`pgrep`/`grep` sanitized) with a broader SSH audit planned for Phase 2.

**Configuration:** If a client uses a non-standard WFM mount, set `infra.sshWfmPathPrefix` in AppConfig — the allowlist follows this value.

**Status:** **Implemented** — ready for Phase 1 go-live.

---

## 4. One-paragraph summary (for questionnaire / email)

WFM Watch now validates every cron log path before it is stored or passed to SSH. Paths must be absolute, stay under the configured WFM prefix (`infra.sshWfmPathPrefix`, default `/mount/RWS4/`) or `/mount/backup`, end in `.log`/`.txt`/`.out`, and must not contain `..` or shell metacharacters. Invalid paths are dropped at job sync (with a server log warning) and are blocked again at log-check time and on the operator log-tail API (HTTP 400). Remote `stat`/`tail` commands use POSIX-safe quoting via a shared `shellQuote()` helper. Implementation is in `backend/src/utils/remote-path.ts` with unit tests in `backend/tests/unit/remote-path.test.ts`. This closes the path traversal finding for go-live; related cron command-injection controls (Q13) are partially addressed and tracked separately.

---

## 5. Summary table for security questionnaire (Question 11)

| Item | Path traversal prevented? | Evidence / notes |
|------|---------------------------|------------------|
| Cron log path ingest | **Yes** | `validateRemoteLogPath()` in `extractLogPath()` |
| Remote `stat` / `tail` | **Yes** | Re-validation + `shellQuote()` in sync-service and jobs API |
| Cron entry file `cat` | **Yes** | `validateRemoteCronFilePath()` before SSH |
| Arbitrary file read (e.g. `/etc/shadow`) | **Blocked** | Outside allowlist; rejected at ingest and use |
| Unit test coverage | **Yes** | 12 tests, all passing |

**Overall status:** **Implemented** for Phase 1 go-live.

---

## 6. References

- Validation module: `backend/src/utils/remote-path.ts`
- Cron sync / log check: `backend/src/services/sync-service.ts`
- Log-tail API: `backend/src/routes/jobs.ts` (`GET /api/jobs/:id/log-tail`)
- File monitor (shared quoting): `backend/src/services/file-monitor-service.ts`
- AppConfig keys: `infra.sshWfmPathPrefix`, `infra.sshCronEntryPath`
- Unit tests: `backend/tests/unit/remote-path.test.ts`
- Questionnaire workbook: `docs/WFM-Watch-Security-Review-Response.xlsx` (Q11 status: Implemented)

**Contact:** WFM Watch Development Team
