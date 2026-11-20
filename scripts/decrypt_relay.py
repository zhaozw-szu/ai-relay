"""Read and decrypt messages for one local relay agent."""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


def derive_key(password: str, salt: bytes, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(password.encode("utf-8"))


def decrypt_record(record: dict, password: str) -> str:
    crypto = record["crypto"]
    key = derive_key(
        password,
        base64.b64decode(crypto["salt_b64"]),
        int(crypto["iterations"]),
    )
    plaintext = AESGCM(key).decrypt(
        base64.b64decode(crypto["iv_b64"]),
        base64.b64decode(record["ciphertext_b64"]),
        None,
    )
    return plaintext.decode("utf-8")


def is_recipient(record: dict, agent_id: str) -> bool:
    recipients = record.get("to", [])
    return "broadcast" in recipients or agent_id in recipients


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".", help="local clone of ai-relay")
    parser.add_argument("--agent-id", default="codex-local-01")
    parser.add_argument("--password", help="omit to use RELAY_PASSWORD or prompt")
    parser.add_argument("--output-dir", default="inbox")
    args = parser.parse_args()

    password = args.password or os.environ.get("RELAY_PASSWORD") or getpass.getpass("Relay password: ")
    repo = Path(args.repo).resolve()
    output_dir = repo / args.output_dir / args.agent_id
    output_dir.mkdir(parents=True, exist_ok=True)

    found = 0
    for path in sorted((repo / "messages").glob("*/*.json")):
        record = json.loads(path.read_text(encoding="utf-8"))
        if not is_recipient(record, args.agent_id):
            continue
        target = output_dir / f"{record['id']}.md"
        if target.exists():
            continue
        try:
            content = decrypt_record(record, password)
        except Exception as exc:  # noqa: BLE001 - show a useful per-message error
            print(f"[decrypt failed] {path}: {exc}")
            continue
        target.write_text(
            "---\n"
            f"id: {record['id']}\n"
            f"from: {record['from']}\n"
            f"to: {', '.join(record['to'])}\n"
            f"conversation_id: {record.get('conversation_id') or ''}\n"
            f"created_at: {record['created_at']}\n"
            "---\n\n"
            + content
            + "\n",
            encoding="utf-8",
        )
        found += 1
        print(f"[new] {target}")
    if found == 0:
        print("No new messages.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
