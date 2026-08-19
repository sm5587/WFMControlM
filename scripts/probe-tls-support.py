#!/usr/bin/env python3
"""
Probe remote DB2, app-server (SSH), and SMTP endpoints for TLS/SSL support.

Usage:
  python scripts/probe-tls-support.py
  python scripts/probe-tls-support.py --smtp-host mail.example.com
  python scripts/probe-tls-support.py --sample 5   # probe first N of each type (quick test)
"""
from __future__ import annotations

import argparse
import re
import socket
import ssl
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

ROOT = Path(__file__).resolve().parents[1]
CLIENTS_SQL = ROOT / "database" / "clients-dml.sql"
TIMEOUT = 8


@dataclass
class Db2Target:
    host: str
    port: int
    clients: list[str] = field(default_factory=list)


@dataclass
class AppServerTarget:
    host: str
    port: int = 22
    clients: list[str] = field(default_factory=list)


def _sql_tokens(line: str) -> list[str]:
    return [p.strip() for p in re.findall(r"'(?:\\.|[^'\\])*'|\d+|NULL", line)]


def _unquote(token: str) -> str:
    if token.startswith("'") and token.endswith("'"):
        return token[1:-1]
    return token


def parse_clients_sql(path: Path) -> tuple[list[Db2Target], list[AppServerTarget]]:
    text = path.read_text(encoding="utf-8")
    db2_map: dict[tuple[str, int], list[str]] = {}
    app_map: dict[str, list[str]] = {}

    for line in text.splitlines():
        if not line.strip().startswith("('"):
            continue
        parts = _sql_tokens(line)

        # Client row: uuid, clientId, name, isActive, db2Host, db2Port, ... (>= 18 fields)
        if len(parts) >= 18 and re.fullmatch(r"[A-Z0-9]{2,10}", _unquote(parts[1])):
            client_id = _unquote(parts[1])
            db2_host = _unquote(parts[4]) if parts[4] != "NULL" else ""
            db2_port = int(parts[5]) if parts[5] != "NULL" else 50000
            if db2_host:
                key = (db2_host.lower(), db2_port)
                db2_map.setdefault(key, []).append(client_id)
            continue

        # AppServer row: uuid, clientUuid, environment, serverNum, dns, isActive, sshPort, ...
        if len(parts) >= 8 and _unquote(parts[2]) in ("Prod", "PP", "Dev", "UAT", "QA"):
            dns = _unquote(parts[4])
            port = int(parts[6]) if parts[6].isdigit() else 22
            if dns and "rfx.zebra.com" in dns.lower() and "was" in dns.lower():
                app_map.setdefault(dns.lower(), []).append(_unquote(parts[2]))

    db2_targets = [Db2Target(host=h, port=p, clients=sorted(set(c))) for (h, p), c in sorted(db2_map.items())]
    app_targets = [AppServerTarget(host=h, port=22, clients=sorted(set(c))) for h, c in sorted(app_map.items())]
    return db2_targets, app_targets


def tcp_reachable(host: str, port: int) -> tuple[bool, str]:
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT):
            return True, "open"
    except socket.timeout:
        return False, "timeout"
    except ConnectionRefusedError:
        return False, "refused"
    except OSError as e:
        return False, str(e)[:80]


def probe_tls_native(host: str, port: int) -> tuple[bool, str]:
    """True if port speaks TLS immediately (e.g. SMTPS 465 or DB2 dedicated SSL port)."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as ssock:
                cert = ssock.getpeercert()
                subj = dict(x[0] for x in cert.get("subject", ())) if cert else {}
                cn = subj.get("commonName", "")
                proto = ssock.version() or "TLS"
                return True, f"{proto}, CN={cn or 'n/a'}"
    except ssl.SSLError as e:
        return False, f"no-immediate-tls ({str(e)[:60]})"
    except OSError as e:
        return False, str(e)[:80]


def probe_db2_drda_plaintext(host: str, port: int) -> tuple[bool, str]:
    """DB2 DRDA often responds to a connect with no TLS wrapper."""
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as sock:
            sock.settimeout(3)
            try:
                data = sock.recv(64)
            except socket.timeout:
                return True, "connected-no-banner (typical DB2 DRDA)"
            if data:
                hex_preview = data[:8].hex()
                return True, f"connected, first-bytes={hex_preview}"
            return True, "connected-empty"
    except OSError as e:
        return False, str(e)[:80]


def probe_ssh(host: str, port: int = 22) -> tuple[bool, str]:
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as sock:
            sock.settimeout(4)
            banner = sock.recv(256).decode("utf-8", errors="replace").strip()
            if banner.startswith("SSH-"):
                return True, banner[:60]
            return True, f"open-non-ssh: {banner[:40] or 'no banner'}"
    except OSError as e:
        return False, str(e)[:80]


def probe_smtp_starttls(host: str, port: int) -> dict:
    result = {"host": host, "port": port, "tcp": False, "starttls": False, "detail": ""}
    try:
        with socket.create_connection((host, port), timeout=TIMEOUT) as sock:
            sock.settimeout(6)
            result["tcp"] = True
            banner = sock.recv(512).decode("utf-8", errors="replace")
            sock.sendall(b"EHLO wfmwatch-probe.local\r\n")
            ehlo = b""
            while True:
                chunk = sock.recv(1024)
                if not chunk:
                    break
                ehlo += chunk
                if b"\r\n" in chunk and (b"250 " in ehlo or b"250-" not in chunk[-20:]):
                    # crude end detection
                    if ehlo.rstrip().endswith(b"250 ") or b"250 " in ehlo.split(b"\r\n")[-2:]:
                        break
                if len(ehlo) > 4096:
                    break

            ehlo_text = ehlo.decode("utf-8", errors="replace")
            if "STARTTLS" in ehlo_text.upper():
                result["starttls"] = True
                sock.sendall(b"STARTTLS\r\n")
                tls_reply = sock.recv(256).decode("utf-8", errors="replace")
                if "220" in tls_reply:
                    ctx = ssl.create_default_context()
                    ctx.check_hostname = False
                    ctx.verify_mode = ssl.CERT_NONE
                    tls_sock = ctx.wrap_socket(sock, server_hostname=host)
                    cert = tls_sock.getpeercert()
                    subj = dict(x[0] for x in cert.get("subject", ())) if cert else {}
                    result["detail"] = f"STARTTLS ok, {tls_sock.version()}, CN={subj.get('commonName','n/a')}"
                else:
                    result["detail"] = f"STARTTLS advertised but failed: {tls_reply.strip()[:80]}"
            else:
                result["detail"] = f"no STARTTLS in EHLO; banner={banner.strip()[:60]}"
    except OSError as e:
        result["detail"] = str(e)[:100]
    return result


def probe_db2(target: Db2Target) -> dict:
    alt_ports = sorted(set([target.port, 50000, 50001, 50030, 50031, target.port + 1]))
    out = {
        "host": target.host,
        "configured_port": target.port,
        "clients": target.clients[:3],
        "client_count": len(target.clients),
        "configured_tcp": False,
        "configured_plaintext_drda": False,
        "configured_native_tls": False,
        "ssl_port_candidates": [],
        "notes": [],
    }

    tcp_ok, tcp_msg = tcp_reachable(target.host, target.port)
    out["configured_tcp"] = tcp_ok
    if not tcp_ok:
        out["notes"].append(f"configured port {target.port}: {tcp_msg}")
        return out

    tls_ok, tls_msg = probe_tls_native(target.host, target.port)
    if tls_ok:
        out["configured_native_tls"] = True
        out["notes"].append(f"port {target.port} native TLS: {tls_msg}")
    else:
        drda_ok, drda_msg = probe_db2_drda_plaintext(target.host, target.port)
        out["configured_plaintext_drda"] = drda_ok
        out["notes"].append(f"port {target.port} plaintext DRDA likely: {drda_msg}")

    for p in alt_ports:
        if p == target.port:
            continue
        ok, _ = tcp_reachable(target.host, p)
        if not ok:
            continue
        tls_ok, tls_msg = probe_tls_native(target.host, p)
        if tls_ok:
            out["ssl_port_candidates"].append({"port": p, "detail": tls_msg})

    return out


def run_probes(
    db2_targets: list[Db2Target],
    app_targets: list[AppServerTarget],
    smtp_hosts: list[str],
    workers: int,
) -> None:
    print("=" * 72)
    print("WFM Watch — TLS / connectivity probe")
    print(f"Source: {CLIENTS_SQL.name}")
    print(f"DB2 hosts: {len(db2_targets)} | App servers: {len(app_targets)} | SMTP hosts: {len(smtp_hosts)}")
    print("=" * 72)

    # DB2
    print("\n## DB2 servers\n")
    db2_results: list[dict] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe_db2, t): t for t in db2_targets}
        for fut in as_completed(futs):
            db2_results.append(fut.result())
    db2_results.sort(key=lambda r: r["host"])

    tls_on_configured = sum(1 for r in db2_results if r["configured_native_tls"])
    plain_on_configured = sum(1 for r in db2_results if r["configured_tcp"] and r["configured_plaintext_drda"])
    unreachable = sum(1 for r in db2_results if not r["configured_tcp"])
    ssl_alt = sum(1 for r in db2_results if r["ssl_port_candidates"])

    for r in db2_results:
        status = []
        if not r["configured_tcp"]:
            status.append("UNREACHABLE")
        elif r["configured_native_tls"]:
            status.append("TLS-on-configured-port")
        elif r["configured_plaintext_drda"]:
            status.append("PLAINTEXT-DRDA")
        if r["ssl_port_candidates"]:
            ports = ", ".join(str(c["port"]) for c in r["ssl_port_candidates"])
            status.append(f"alt-TLS-port({ports})")
        print(f"  {r['host']}:{r['configured_port']}  [{', '.join(status) or '?'}]  clients={r['client_count']}")
        for n in r["notes"][:2]:
            print(f"      {n}")

    print(f"\nDB2 summary: reachable={len(db2_results)-unreachable}, plaintext_DRDA={plain_on_configured}, "
          f"native_TLS_on_configured={tls_on_configured}, alt_SSL_port_found={ssl_alt}, unreachable={unreachable}")

    # App servers (SSH)
    print("\n## App servers (SSH port 22)\n")
    ssh_ok = ssh_fail = 0
    ssh_results: list[tuple[str, bool, str]] = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(probe_ssh, t.host, t.port): t for t in app_targets}
        for fut in as_completed(futs):
            t = futs[fut]
            ok, msg = fut.result()
            ssh_results.append((t.host, ok, msg))
            if ok and msg.startswith("SSH-"):
                ssh_ok += 1
            else:
                ssh_fail += 1
    ssh_results.sort(key=lambda x: x[0])
    for host, ok, msg in ssh_results[:15]:
        mark = "SSH" if ok and msg.startswith("SSH-") else ("OPEN" if ok else "FAIL")
        print(f"  {host}:22  [{mark}]  {msg}")
    if len(ssh_results) > 15:
        print(f"  ... and {len(ssh_results) - 15} more app servers")
    print(f"\nSSH summary: ssh_banner={ssh_ok}, other/fail={ssh_fail} (SSH encrypts all traffic when used)")

    # SMTP
    print("\n## SMTP relays\n")
    if not smtp_hosts:
        print("  No SMTP host provided. Use --smtp-host <relay> to probe corporate relay.")
        print("  (Production value is in AppConfig secrets.smtpHost — not stored in repo.)")
    else:
        smtp_ports = [25, 587, 465]
        for host in smtp_hosts:
            print(f"  Host: {host}")
            for port in smtp_ports:
                if port == 465:
                    tcp_ok, _ = tcp_reachable(host, port)
                    if not tcp_ok:
                        print(f"    :465  [closed/unreachable]")
                        continue
                    tls_ok, msg = probe_tls_native(host, port)
                    print(f"    :465  [{'SMTPS-TLS' if tls_ok else 'FAIL'}]  {msg}")
                else:
                    r = probe_smtp_starttls(host, port)
                    mark = "STARTTLS" if r["starttls"] else ("OPEN" if r["tcp"] else "FAIL")
                    print(f"    :{port}  [{mark}]  {r['detail']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe DB2/AppServer/SMTP TLS support")
    parser.add_argument("--smtp-host", action="append", default=[], help="SMTP relay hostname (repeatable)")
    parser.add_argument("--sample", type=int, default=0, help="Limit to first N DB2 + N app servers (0=all)")
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()

    if not CLIENTS_SQL.exists():
        print(f"Missing {CLIENTS_SQL}", file=sys.stderr)
        return 1

    db2_targets, app_targets = parse_clients_sql(CLIENTS_SQL)
    if args.sample:
        db2_targets = db2_targets[: args.sample]
        app_targets = app_targets[: args.sample]

    smtp_hosts = args.smtp_host or []
    run_probes(db2_targets, app_targets, smtp_hosts, args.workers)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
