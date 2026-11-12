#!/usr/bin/env python3
"""Read-only guards for cache-ping.sh. Exit 0 means the named condition holds."""
import datetime
import json
import math
import os
import re
import sys
import time


def timestamp(value):
    if isinstance(value, (int, float)):
        result = float(value)
    else:
        dt = datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        result = dt.replace(tzinfo=dt.tzinfo or datetime.timezone.utc).timestamp()
    if not math.isfinite(result):
        raise ValueError("non-finite timestamp")
    return result


def idle(path, minutes):
    # Last assistant EVENT, not maximum timestamp and not transcript mtime.
    # Stream the file: bounded memory even for large main sessions.
    last = None
    pending_user = False
    with open(path, encoding="utf-8", errors="replace") as transcript:
        for line in transcript:
            try:
                event = json.loads(line)
                if not isinstance(event, dict) or event.get("isSidechain"):
                    continue
                if event.get("type") == "assistant":
                    last = event.get("timestamp")
                    pending_user = False
                elif event.get("type") == "user":
                    pending_user = True
            except (ValueError, TypeError):
                continue  # includes an incomplete final write
    if pending_user:
        return False
    try:
        previous = timestamp(last)
    except (ValueError, TypeError, OverflowError):
        previous = os.path.getmtime(path)
    return time.time() - previous >= int(minutes) * 60


def limited(path):
    # Optional persisted Claude statusline payload plus its observation time.
    # mtime is deliberately NOT a freshness proxy (copy/touch is not a probe).
    try:
        with open(path, encoding="utf-8") as source:
            data = json.load(source)
        age = time.time() - timestamp(data["timestamp"])
        if not 0 <= age < 15 * 60:
            return False
        limits = data["rate_limits"]
        return any(float(limits.get(window, {}).get("used_percentage", 0)) >= 100
                   for window in ("five_hour", "seven_day"))
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return False


DIALOG_OR_BUSY = re.compile(
    r"enter to (?:confirm|select)|(?:do you want|would you like) to|"
    r"yes,? (?:proceed|allow)|allow (?:once|always)|approve|approval|"
    r"esc(?:ape)? to (?:cancel|interrupt)|loading development channels|"
    r"trust (?:this|the)|continue\?|\by/n\b|permission (?:required|request)",
    re.IGNORECASE,
)
PROMPT = re.compile(r"^\s*[❯>]\s?(.*)$")


def pane(text, expected=""):
    # Positive readiness check: unknown UI shapes fail closed. Never rely
    # solely on a list of dialog phrases that a future CLI can change.
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    if DIALOG_OR_BUSY.search(text):
        return False
    lines = text.splitlines()
    prompts = [(i, PROMPT.match(line)) for i, line in enumerate(lines) if PROMPT.match(line)]
    if not prompts:
        return False
    index, match = prompts[-1]
    entered = match.group(1).strip()
    if not expected:
        return not entered
    # tmux capture-pane wraps long literal input. Reconstruct only as far as
    # our expected prompt; reject extra typing on any consumed input line.
    normalize = lambda value: "".join(value.split())
    wanted = normalize(expected)
    actual = normalize(entered)
    for line in lines[index + 1:]:
        if len(actual) >= len(wanted):
            break
        actual += normalize(line)
    return actual == wanted


def main(argv):
    try:
        if argv[1] == "idle":
            ok = idle(argv[2], argv[3])
        elif argv[1] == "limited":
            ok = limited(argv[2])
        elif argv[1] == "pane":
            ok = pane(sys.stdin.read(), argv[2] if len(argv) > 2 else "")
        else:
            return 1
        return 0 if ok else 1
    except (OSError, ValueError, TypeError, IndexError, OverflowError):
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
