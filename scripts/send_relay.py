"""Send a plaintext message to the deployed relay worker."""

from __future__ import annotations

import argparse
import getpass
import json
import os
from pathlib import Path
from urllib.error import HTTPError
import urllib.request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", required=True, help="Worker base URL")
    parser.add_argument("--agent-id", default="codex-local-01")
    parser.add_argument("--to", action="append", required=True)
    content_group = parser.add_mutually_exclusive_group(required=True)
    content_group.add_argument("--content")
    content_group.add_argument("--content-file", help="UTF-8 text file containing the message")
    parser.add_argument("--type", default="result")
    parser.add_argument("--conversation-id", default="")
    parser.add_argument("--password")
    args = parser.parse_args()

    password = args.password or os.environ.get("RELAY_PASSWORD") or getpass.getpass("Relay password: ")
    content = args.content
    if args.content_file:
        content = Path(args.content_file).read_text(encoding="utf-8")
    payload = {
        "agent_id": args.agent_id,
        "to": args.to,
        "conversation_id": args.conversation_id or None,
        "type": args.type,
        "content": content,
    }
    request = urllib.request.Request(
        args.endpoint.rstrip("/") + "/write",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ai-relay-client/1.0",
            "X-Relay-Password": password,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            print(response.read().decode("utf-8"))
    except HTTPError as error:
        details = error.read().decode("utf-8", errors="replace")
        print(details)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
