#!/usr/bin/env python3
"""Parse clients-dml.sql and print cluster groupings."""
import re
from collections import defaultdict

SQL = r"c:\Users\SM5587\OneDrive - Zebra Technologies\Daily_Work\WFMControlM\database\clients-dml.sql"
text = open(SQL, encoding="utf-8").read()

clients = []
for line in text.splitlines():
    if not line.strip().startswith("('"):
        continue
    parts = [p.strip() for p in re.findall(r"'(?:\\.|[^'\\])*'|\d+|NULL", line)]
    if len(parts) < 18:
        continue
    client_id = parts[1].strip("'")
    name = parts[2].strip("'")
    active = parts[3] == "1"
    cluster = parts[16].strip("'")
    clients.append({"clientId": client_id, "name": name, "active": active, "cluster": cluster})

by_cluster = defaultdict(list)
for c in clients:
    by_cluster[c["cluster"]].append(c)

def cluster_sort_key(cl: str):
    m = re.match(r"CL(\d+)", cl)
    return (int(m.group(1)) if m else 9999, cl)

for cl in sorted(by_cluster.keys(), key=cluster_sort_key):
    items = sorted(by_cluster[cl], key=lambda x: x["clientId"])
    print(f"{cl} ({len(items)})")
    for c in items:
        status = "active" if c["active"] else "inactive"
        print(f"  {c['clientId']:8} {c['name'][:40]:40} {status}")

print(f"\nTOTAL: {len(clients)} clients, {len(by_cluster)} clusters")
