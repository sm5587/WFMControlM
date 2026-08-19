#!/usr/bin/env python3
"""Generate Phase 1 Confluence page content — clients arranged cluster-wise."""

import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL_PATH = ROOT / "database" / "clients-dml.sql"
SOURCE_HTML = ROOT / "docs" / "phase1-source.html"
OUTPUT_HTML = ROOT / "docs" / "phase1-cluster-wise.html"

PARENT_PAGE_ID = "1202360838"
NEW_TITLE = "Phase 1 - 31/12/2025 (Cluster-wise)"

# Original Phase 1 page client label -> WFM Watch clientId
CLIENT_ALIASES = {
    "AAP": "AAP",
    "AZ": "AZO",
    "AZO": "AZO",
    "BCF": "BCF",
    "BELK": "BLK",
    "Belk": "BLK",
    "BLK": "BLK",
    "BMR": "BMR",
    "BOA": "BAC",
    "BAC": "BAC",
    "BP": "BPG",
    "BPG": "BPG",
    "BPANZ": "BPANZ",
    "BPUS": "BPUS",
    "BSP": "BAS",
    "BAS": "BAS",
    "CCSD": "CNCD",
    "CNCD": "CNCD",
    "CITI": "CITI",
    "COPPEL": "COP",
    "COP": "COP",
    "CVS": "CVSH",
    "CVSDC": "CVSDC",
    "CVSH": "CVSH",
    "DIX": "DIX",
    "DJ": "DJ",
    "DT": "DST",
    "DST": "DST",
    "ELROSADO": "ELROSA",
    "ELROSA": "ELROSA",
    "FHB": "FHB",
    "FNBT": "FNBT",
    "FTFCU": "FTFCU",
    "HNM": "HNMG",
    "HNMG": "HNMG",
    "HNM China": "HMC",
    "HMC": "HMC",
    "HOLT": "HOLT",
    "IKI": "IKI",
    "INSP": "INSP",
    "JLP": "JLP",
    "JPMC": "JPMC",
    "KEY": "KEY",
    "MBR": "MB",
    "MB": "MB",
    "MCDDE": "MCDDE",
    "MOR": "MRW",
    "MRW": "MRW",
    "MCDPL": "MCDPL",
    "ODP": "ODP41",
    "ODP41": "ODP41",
    "OXXO": "OXXO",
    "RKH": "RKH",
    "RLY": "RLY",
    "SB": "SBH",
    "SBH": "SBH",
    "SCO": "SCO",
    "SEG": "SEG",
    "SFC": "SFC",
    "SIGNET": "SIG",
    "SIG": "SIG",
    "SMLC": "SMLC",
    "SSI": "SSN",
    "SSN": "SSN",
    "STS": "STS",
    "TAG": "TAG",
    "TB": "TLB",
    "TLB": "TLB",
    "TWG": "TWG",
    "TWN": "TTW",
    "TTW": "TTW",
    "VEYR": "VEYR",
    "WAG": "WAL",
    "WAL": "WAL",
    "WAWA": "WAW",
    "WAW": "WAW",
    "WBST": "WBST",
    "SMU": "SMU",
    "QCK": "QCK",
    "WAW": "WAW",
}


def parse_clients_from_sql() -> list[dict]:
    text = SQL_PATH.read_text(encoding="utf-8")
    clients = []
    for line in text.splitlines():
        if not line.strip().startswith("('"):
            continue
        parts = [p.strip() for p in re.findall(r"'(?:\\.|[^'\\])*'|\d+|NULL", line)]
        if len(parts) < 18:
            continue
        clients.append(
            {
                "clientId": parts[1].strip("'"),
                "name": parts[2].strip("'"),
                "active": parts[3] == "1",
                "cluster": parts[16].strip("'"),
            }
        )
    return clients


def normalize_cluster(raw: str) -> str:
    raw = (raw or "").strip()
    if not raw:
        return ""
    if raw.upper().startswith("CL"):
        return raw.upper()
    if raw.isdigit():
        return f"CL{raw.zfill(2)}" if len(raw) <= 2 else f"CL{raw}"
    return raw.upper()


def parse_jira_from_source() -> dict[str, dict[str, str]]:
    """Return clientId -> {delete_until, preprod, production} cell HTML."""
    if not SOURCE_HTML.exists():
        return {}

    html_text = SOURCE_HTML.read_text(encoding="utf-8")
    rows = re.findall(r"<tr>(.*?)</tr>", html_text, re.DOTALL)
    tickets: dict[str, dict[str, str]] = defaultdict(dict)

    for row in rows:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.DOTALL)
        if len(cells) < 6:
            continue
        cluster_raw = re.sub(r"<[^>]+>", "", cells[1]).strip()
        client_raw = re.sub(r"<[^>]+>", "", cells[2]).strip()
        if client_raw.lower() in ("client", ""):
            continue

        client_id = CLIENT_ALIASES.get(client_raw, client_raw.upper())
        cluster = normalize_cluster(cluster_raw)

        def cell_html(idx: int) -> str:
            content = cells[idx].strip()
            if not content or content in ("<br />", "<br/>", "<p><br /></p>"):
                return ""
            return content

        entry = tickets[client_id]
        for key, idx in (("delete_until", 3), ("preprod", 4), ("production", 5)):
            val = cell_html(idx)
            if val and not entry.get(key):
                entry[key] = val
        if cluster and not entry.get("_cluster_hint"):
            entry["_cluster_hint"] = cluster

    return tickets


def cluster_sort_key(cl: str) -> tuple:
    m = re.match(r"CL(\d+)", cl or "")
    return (int(m.group(1)) if m else 9999, cl or "")


def jira_link_html(cell: str) -> str:
    if not cell:
        return ""
    return cell


def build_table(clients: list[dict], jira_map: dict[str, dict[str, str]]) -> str:
    by_cluster: dict[str, list[dict]] = defaultdict(list)
    for c in clients:
        by_cluster[c["cluster"]].append(c)

    rows = []
    row_num = 0
    for cluster in sorted(by_cluster.keys(), key=cluster_sort_key):
        cluster_clients = sorted(by_cluster[cluster], key=lambda x: x["clientId"])
        for c in cluster_clients:
            row_num += 1
            cid = c["clientId"]
            jira = jira_map.get(cid, {})
            status = "" if c["active"] else " (inactive)"
            client_label = f"{html.escape(cid)} — {html.escape(c['name'])}{status}"
            cluster_num = re.sub(r"^CL", "", cluster)

            rows.append(
                "<tr>"
                f'<td class="numberingColumn" contenteditable="false" data-mce-resize="false">{row_num}</td>'
                f"<td>{html.escape(cluster_num)}</td>"
                f"<td>{client_label}</td>"
                f"<td>{jira_link_html(jira.get('delete_until', ''))}</td>"
                f"<td>{jira_link_html(jira.get('preprod', ''))}</td>"
                f"<td>{jira_link_html(jira.get('production', ''))}</td>"
                "</tr>"
            )

    intro = (
        "<p>This page is a cluster-wise view of Phase 1 clients, aligned with WFM Watch client inventory. "
        "Jira ticket references are copied from the original "
        '<a href="https://confluence.zebra.com/spaces/SUPW/pages/1202360838/Phase+1+-+31+12+2025">'
        "Phase 1 page</a> where available.</p>"
    )

    table = (
        '<table class="wrapped" data-snooker-col-series="numbers" data-snooker-locked-cols="0">'
        "<tbody>"
        "<tr>"
        '<th class="numberingColumn" contenteditable="false" data-mce-resize="false" scope="col"><br /></th>'
        "<th scope=\"col\">Cluster</th>"
        "<th scope=\"col\">Client</th>"
        "<th scope=\"col\"><h6>Delete until</h6></th>"
        "<th scope=\"col\"><h6>PreProd</h6></th>"
        "<th scope=\"col\">Production</th>"
        "</tr>"
        + "".join(rows)
        + "</tbody></table>"
    )
    return intro + table


def publish(html_body: str) -> dict:
    token = os.environ.get("CONFLUENCE_TOKEN")
    if not token:
        raise RuntimeError("CONFLUENCE_TOKEN not set")

    # Check if page already exists under parent
    search_url = (
        "https://confluence.zebra.com/rest/api/content"
        f"?spaceKey=SUPW&title={urllib.parse.quote(NEW_TITLE)}&expand=version"
    )
    req = urllib.request.Request(
        search_url,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        results = json.loads(resp.read().decode()).get("results", [])

    payload_base = {
        "type": "page",
        "title": NEW_TITLE,
        "space": {"key": "SUPW"},
        "ancestors": [{"id": PARENT_PAGE_ID}],
        "body": {"storage": {"value": html_body, "representation": "storage"}},
    }

    if results:
        page = results[0]
        page_id = page["id"]
        version = page["version"]["number"] + 1
        payload = {
            "id": page_id,
            "type": "page",
            "title": NEW_TITLE,
            "body": payload_base["body"],
            "version": {
                "number": version,
                "message": "Updated cluster-wise client list with Jira references",
            },
        }
        method = "PUT"
        url = f"https://confluence.zebra.com/rest/api/content/{page_id}"
    else:
        payload = payload_base
        method = "POST"
        url = "https://confluence.zebra.com/rest/api/content"

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    clients = parse_clients_from_sql()
    jira_map = parse_jira_from_source()
    body = build_table(clients, jira_map)
    OUTPUT_HTML.write_text(body, encoding="utf-8")
    print(f"Wrote {OUTPUT_HTML} ({len(clients)} clients, {len(jira_map)} Jira mappings)")

    matched = [cid for cid in jira_map if any(jira_map[cid].get(k) for k in ("delete_until", "preprod", "production"))]
    print("Jira tickets mapped to:", ", ".join(sorted(matched)))

    if "--publish" in sys.argv:
        try:
            result = publish(body)
            print("Published version:", result["version"]["number"])
            print("URL: https://confluence.zebra.com" + result["_links"]["webui"])
        except urllib.error.HTTPError as e:
            print(e.read().decode(), file=sys.stderr)
            return 1
    else:
        print("Run with --publish to create/update Confluence page")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
