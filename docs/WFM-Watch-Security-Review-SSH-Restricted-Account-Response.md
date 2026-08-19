# WFM Watch — Security Review Response: SSH Restricted Service Account (Question 17)

**Application:** WFM Watch (WFM Control-M)  
**Document date:** 18 August 2026  
**Prepared for:** Information Security / Architecture Review  
**Related finding:** Medium — SSH service account not restricted with ForceCommand; password auth

---

## Executive summary

| Control | Status | Notes |
|---------|--------|-------|
| **Read-only by design** | **Yes** | Monitoring commands only — no writes, no interactive shell from app |
| **App command allowlist** | **Implemented** | `validateRemoteCommand()` blocks non-monitoring commands before SSH exec |
| **Path allowlists (#11)** | **Implemented** | Remote log/cron paths validated before use |
| **ForceCommand / restricted shell** | **Client ops (documented)** | Requires sshd config on each client app server |
| **Password auth** | **Current** | Service account password in AppConfig; optional TOTP MFA |

**Conclusion:** Application-side command guardrail **implemented**. Client infrastructure must deploy ForceCommand wrapper per deployment guide. **Finding mitigated (shared control).**

---

## Security question (original)

> Are the SSH accounts used by WFM Watch restricted with a forced command or restricted shell so they can ONLY read specific files and cannot be used for interactive login or writing files?

---

## Application-side remediation (Aug 2026)

### Command allowlist (defense in depth)

**Module:** `backend/src/utils/ssh-client.ts`

Before any remote exec, the app validates commands against a read-only allowlist:

`cat`, `tail`, `stat`, `find`, `pgrep`, `grep`, `journalctl`, `db2`, timezone helpers, `bash -lc find …`

Destructive or interactive commands (e.g. `rm`, `bash -i`) are rejected in application code.

### Client infrastructure (required)

**Guide:** `docs/SSH-Account-Hardening-Client-Servers.md`  
**Sample wrapper:** `scripts/client-server/wfm-watch-ssh-wrapper.sh`

Client ops configure `Match User` + `ForceCommand` + filesystem ACLs on each app server.

---

## Response to security team

**Current state:** WFM Watch enforces an **in-app read-only command allowlist** and path validation. SSH uses password auth (+ optional TOTP). ForceCommand/restricted-shell enforcement is documented for client ops and must be applied on each app server at deployment.

**Status:** **Mitigated (shared control) — August 2026**

---

## References

- `backend/src/utils/ssh-client.ts`
- `backend/tests/unit/ssh-client.test.ts`
- `docs/SSH-Account-Hardening-Client-Servers.md`
- Security review tracker: item #17

**Contact:** WFM Watch Development Team
