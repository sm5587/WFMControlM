# WFM Watch — SSH Account Hardening (Client App Servers)

**Audience:** Client infrastructure / operations teams  
**Document date:** 17 August 2026  
**Related security review:** Item #17 — restricted SSH service account

---

## Purpose

WFM Watch connects to each client app server over SSH to read cron entries, tail log files, run read-only `find` scans, and execute `db2` SELECT queries. The application is **read-only by design** and validates remote paths before use (#11), but **account-level restriction** (ForceCommand, no interactive login, filesystem ACLs) must be configured on **each client app server** by client ops.

This guide documents the required hardening so the WFM Watch service account cannot be used for interactive sessions or arbitrary commands.

---

## 1. Service account requirements

| Requirement | Detail |
|-------------|--------|
| **Dedicated account** | One non-personal service account per client (e.g. `wfmwatch`) — not a shared admin login |
| **Read-only filesystem** | Read access only to `/mount/RWS4/`, `/mount/backup/`, configured upload monitor paths, and DB2 client install |
| **No write** | No write permission outside `/tmp` (DB2 query scratch file only) |
| **No interactive login** | `PermitTTY no` + ForceCommand wrapper — no shell access for operators |
| **No port forwarding** | `AllowTcpForwarding no`, `PermitOpen none` |
| **Authentication** | Password (+ optional TOTP on keyboard-interactive) as configured in WFM Watch Admin → Config |

---

## 2. Commands WFM Watch executes

The application only issues these command families (all read-only):

| Command | Purpose |
|---------|---------|
| `cat` | Read cron entry file (`/mount/backup/cronEntry`) |
| `tail` | Read last lines of batch log files |
| `stat` | File size / mtime for log freshness |
| `find` | File monitor — pending/rejected upload folders |
| `pgrep`, `grep`, `journalctl` | Cron exit-code lookup in system logs |
| `timedatectl`, `readlink`, `date`, `cat /etc/timezone` | Server timezone detection |
| `db2 connect`, `db2 -t`, `db2 -x`, `db2 connect reset`, `SET SCHEMA` | Read-only DB2 monitoring |

Log paths are allowlisted under `infra.sshWfmPathPrefix` (default `/mount/RWS4`) and `/mount/backup` before any SSH call.

---

## 3. Recommended sshd configuration

On each client app server, add to `/etc/ssh/sshd_config` (adjust username and wrapper path):

```sshconfig
Match User wfmwatch
    ForceCommand /usr/local/bin/wfm-watch-ssh-wrapper.sh
    PermitTTY no
    X11Forwarding no
    AllowTcpForwarding no
    PermitOpen none
    PasswordAuthentication yes
    KbdInteractiveAuthentication yes
```

Reload sshd after validation: `sshd -t && systemctl reload sshd`

---

## 4. ForceCommand wrapper script

A reference wrapper is provided at:

`scripts/client-server/wfm-watch-ssh-wrapper.sh`

**Install steps (client ops):**

```bash
sudo install -m 0755 -o root -g root \
  wfm-watch-ssh-wrapper.sh /usr/local/bin/wfm-watch-ssh-wrapper.sh
```

The wrapper:

- Rejects empty commands (blocks interactive login)
- Allows only the read-only command prefixes listed above
- Rejects shell metacharacters (`; | & \` $ ( ) < >`)

---

## 5. Filesystem ACLs (recommended)

Example (adjust paths to client layout):

```bash
# Read-only on WFM logs and cron
setfacl -m u:wfmwatch:rx /mount/RWS4 /mount/backup
setfacl -R -m u:wfmwatch:rX /mount/RWS4/logs /mount/backup

# DB2 client read + execute only
setfacl -m u:wfmwatch:rx /opt/ibm/db2

# Scratch file for db2 -x output only
setfacl -m u:wfmwatch:rwx /tmp
```

Do **not** grant write access to application data, home directories, or `/etc`.

---

## 6. Verification checklist

After deployment, confirm from the WFM Watch host:

1. WFM Watch sync and log-tail succeed for the client
2. Manual `ssh wfmwatch@appserver` from an operator workstation is **rejected** (no TTY / ForceCommand)
3. Attempting `ssh wfmwatch@appserver 'rm -rf /'` returns **Command not permitted**
4. Service account cannot `sudo` or switch user

---

## 7. Shared responsibility

| Layer | Owner | Control |
|-------|-------|---------|
| Application | WFM Watch development | Path allowlists, safe quoting, read-only SQL, sanitized pgrep/grep |
| Client app server | Client ops / infra | ForceCommand, account ACLs, sshd Match block, dedicated service account |

**Contact:** WFM Watch Development Team
