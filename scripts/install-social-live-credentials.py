#!/usr/bin/env python3
"""Install only live-provider credentials supplied as JSON on stdin. Never log values."""
import argparse
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

PROVIDERS = {"X_BEARER_TOKEN", "YOUTUBE_API_KEY"}


def install(path, payload):
    if not isinstance(payload, dict) or set(payload) - PROVIDERS:
        raise ValueError("Only social live provider settings are accepted")
    updates = {}
    for key, value in payload.items():
        if value in ("", None):
            continue
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_%+=/.-]{20,8192}", value):
            raise ValueError("Provider credential format is invalid")
        updates[key] = value
    if not updates:
        raise ValueError("No provider credential supplied")
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError("Environment path must be a regular file")
    lines, seen = [], set()
    for line in path.read_text().splitlines():
        match = re.match(r"^\s*([A-Z_]+)\s*=", line)
        key = match.group(1) if match else None
        if key not in updates:
            lines.append(line)
        elif key not in seen:
            lines.append(key + "=" + updates[key])
            seen.add(key)
    for key in sorted(set(updates) - seen):
        lines.append(key + "=" + updates[key])
    fd, pending = tempfile.mkstemp(prefix=".social-live-env-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            os.fchown(stream.fileno(), metadata.st_uid, metadata.st_gid)
            stream.write("\n".join(lines) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        # Refuse to overwrite if another administrator replaced the file meanwhile.
        current = path.lstat()
        if (current.st_ino, current.st_mtime_ns) != (metadata.st_ino, metadata.st_mtime_ns):
            raise ValueError("Environment changed during credential installation")
        os.replace(pending, path)
    finally:
        if os.path.exists(pending):
            os.unlink(pending)
    return sorted(updates)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", default="/etc/yubit-academy/production.env")
    args = parser.parse_args()
    try:
        changed = install(Path(args.env_file), json.load(sys.stdin))
        print(json.dumps({"ok": True, "updatedKeys": changed}))
    except Exception:
        # Input and environment contents may contain credentials; never echo them.
        print("Provider credential installation failed; environment preserved unless replacement completed.", file=sys.stderr)
        sys.exit(1)
