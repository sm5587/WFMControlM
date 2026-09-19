#!/usr/bin/env python3
"""Replace Confluence Deployment steps page with tar-based Docker deploy runbook."""
import json
import os
import sys
import urllib.error
import urllib.request

PAGE_ID = "1231556522"
TITLE = "Deployment steps"


def get_token() -> str:
    token = os.environ.get("CONFLUENCE_TOKEN", "")
    if token:
        return token
    script_path = os.path.join(os.path.dirname(__file__), "upload-confluence-page.py")
    with open(script_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.startswith("CONFLUENCE_TOKEN"):
                return line.split('"')[1]
    return ""


def fetch_page(token: str) -> dict:
    req = urllib.request.Request(
        f"https://confluence.zebra.com/rest/api/content/{PAGE_ID}?expand=version",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def main() -> int:
    token = get_token()
    if not token:
        print("Missing CONFLUENCE_TOKEN", file=sys.stderr)
        return 1

    content_path = os.path.join(
        os.path.dirname(__file__), "..", "docs", "confluence-deployment-steps-image-copy.html"
    )
    with open(content_path, "r", encoding="utf-8") as f:
        html = f.read().strip()

    page = fetch_page(token)
    version = page["version"]["number"]

    payload = {
        "id": PAGE_ID,
        "type": "page",
        "title": TITLE,
        "body": {"storage": {"value": html, "representation": "storage"}},
        "version": {
            "number": version + 1,
            "message": "FQDN laptop access, DNS/firewall/SSH tunnel, CORS + verify URLs",
        },
    }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"https://confluence.zebra.com/rest/api/content/{PAGE_ID}",
        data=data,
        method="PUT",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "Accept": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(e.read().decode(), file=sys.stderr)
        return 1

    print("Updated version:", result["version"]["number"])
    print("URL: https://confluence.zebra.com" + result["_links"]["webui"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
