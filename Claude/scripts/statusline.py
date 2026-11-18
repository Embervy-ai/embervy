#!/usr/bin/env python3
"""Bounded, best-effort statusline observer; never retain the input payload."""
import json
import math
import os
from pathlib import Path
import re
import signal
import sys
import tempfile
import time

MAX_INPUT = 64 * 1024


def label(value):
    if not isinstance(value, str):
        return ""
    # No terminal escapes, line breaks or formatting controls from stdin.
    return "".join(c for c in value if c.isprintable())[:160]


def reject_constant(value):
    raise ValueError("non-JSON number")


def atomic_snapshot(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".claude-statusline-", suffix=".tmp", dir=path.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as target:
            os.fchmod(target.fileno(), 0o600)
            json.dump(data, target, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def expired(_signal, _frame):
    raise TimeoutError("statusline input deadline")


def main():
    model = display = ""
    line = ""
    try:
        signal.signal(signal.SIGALRM, expired)
        signal.alarm(2)
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("oversize input")
        data = json.loads(raw, parse_constant=reject_constant)
        if not isinstance(data, dict):
            raise ValueError("expected object")
        supplied = data.get("model")
        if isinstance(supplied, dict):
            model = label(supplied.get("id")) or label(supplied.get("display_name"))
            display = label(supplied.get("display_name")) or model
        else:
            model = display = label(supplied)
        limits = data.get("rate_limits")
        if limits is not None and not isinstance(limits, dict):
            raise ValueError("expected rate_limits object or null")
        home = Path(os.environ["EMBERVY_HOME"]).resolve()
        state = (home / "state").resolve()
        path = Path(os.environ.get("EMBERVY_CACHE_PING_STATUS_FILE") or state / "claude-statusline.json")
        if not path.is_absolute():
            path = home / path
        # Overrides must still belong to this house's state folder.
        if state not in path.parent.resolve().parents and path.parent.resolve() != state:
            raise ValueError("status file must be in house state")
        atomic_snapshot(path, {"timestamp": time.time(), "rate_limits": limits, "model": model})
        parts = [display] if display else []
        for name, window in (limits or {}).items():
            if not re.fullmatch(r"[a-z0-9_]{1,40}", name) or not isinstance(window, dict):
                continue
            used = window.get("used_percentage")
            if type(used) not in (int, float) or not math.isfinite(used):
                continue
            parts.append(f"{name} {used:.0f}%")
            if len(parts) >= 4:
                break
        line = " | ".join(parts)
    except Exception:
        line = display or model
    finally:
        signal.alarm(0)
    try:
        print(line)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
