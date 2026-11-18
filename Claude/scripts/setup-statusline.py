#!/usr/bin/env python3
"""Opt-in statusline setup after inspecting this house's actual Claude launch."""
import argparse
import json
import os
from pathlib import Path
import shlex
import sys
import tempfile
from statusline_settings import discover, no_symlinks

MAX_SETTINGS = 1024 * 1024


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def parse(raw):
    def invalid(_value):
        raise ValueError("non-JSON number")
    data = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid)
    if not isinstance(data, dict):
        raise ValueError("settings must be a JSON object")
    return data


def read(path):
    path = no_symlinks(path)
    try:
        with path.open("rb") as source:
            raw = source.read(MAX_SETTINGS + 1)
    except FileNotFoundError:
        return None, {}
    if len(raw) > MAX_SETTINGS:
        raise ValueError("settings too large")
    return raw, parse(raw)


def stage(parent, prefix, raw):
    fd, name = tempfile.mkstemp(dir=parent, prefix=prefix)
    try:
        with os.fdopen(fd, "wb") as target:
            os.fchmod(target.fileno(), 0o600)
            target.write(raw)
            target.flush()
            os.fsync(target.fileno())
    except BaseException:
        os.unlink(name)
        raise
    return name


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="0: already configured/preserved, 1: setup needed, 2: unsafe/error")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--home", default=os.environ.get("EMBERVY_HOME") or str(Path(__file__).resolve().parents[2]))
    parser.add_argument("--settings", help="assert discovered target equals PATH; never overrides discovery")
    parser.add_argument("--unit", help="loop service to inspect (default: EMBERVY_LOOP_SERVICE or embervy-loop.service)")
    parser.add_argument("--systemd-scope", choices=("system", "user"), help="scope of the loop unit")
    parser.add_argument("--respect-settings", action="append", default=[], help="additional settings source to inspect, never modify")
    args = parser.parse_args()
    temporary = None
    try:
        home = no_symlinks(Path(args.home))
        settings, config = discover(home, args.settings, args.unit, args.systemd_scope)
        sources = [settings, home / "state/claude-settings.json", home / ".claude/settings.json",
                   home / ".claude/settings.local.json", config / "settings.json",
                   *[Path(p) if Path(p).is_absolute() else home / p for p in args.respect_settings]]
        # Validate ALL sources first. Even a null/disabled statusLine is the house's choice.
        loaded = [(path, *read(path)) for path in dict.fromkeys(sources)]
        existing = [str(path) for path, _raw, data in loaded if "statusLine" in data]
        if existing:
            print("Preserved statusLine: " + ", ".join(existing))
            return 0
        raw, data = loaded[0][1:]
        script = home / "Claude/scripts/statusline.sh"
        if not script.is_file():
            raise ValueError(f"install the statusline scripts first: {script}")
        command = "env " + shlex.quote("EMBERVY_HOME=" + str(home)) + " bash " + shlex.quote(str(script))
        updated = {**data, "statusLine": {"type": "command", "command": command}}
        encoded = (json.dumps(updated, indent=2, ensure_ascii=True, allow_nan=False) + "\n").encode()
        if parse(encoded) != updated:
            raise ValueError("JSON validation failed")
        if args.check:
            print(f"Setup needed: {settings}")
            return 1
        settings.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = stage(settings.parent, ".statusline-settings-", encoded)
        # Do not clobber edits made while setup was preparing the new JSON.
        for path, before, _data in loaded:
            if read(path)[0] != before:
                raise ValueError(f"settings changed during setup: {path}")
        if raw is not None:
            backup = stage(settings.parent, settings.name + ".statusline-backup-", raw)
            print(f"Backup: {backup}")
        os.replace(temporary, settings)
        temporary = None
        if read(settings)[1] != updated:
            raise ValueError("installed JSON verification failed")
        print(f"Installed statusLine: {settings}")
        print("Takes effect on the next start of Claude Code (no running session changed).")
        print(f"Verify after the first turn: {home / 'state/claude-statusline.json'} is created.")
        return 0
    except (OSError, ValueError, TypeError, RecursionError) as error:
        print(f"Statusline setup refused: {error}", file=sys.stderr)
        return 2
    finally:
        if temporary is not None:
            os.unlink(temporary)


if __name__ == "__main__":
    sys.exit(main())
