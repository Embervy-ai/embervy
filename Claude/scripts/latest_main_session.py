#!/usr/bin/env python3
"""latest_main_session.py — pick the running agent's own session transcript.

Claude Code writes every run started from the home dir into the same project
folder: the interactive main session, but also headless `claude -p` runs
(header enrichment, the doctor's canary, your own automation) and, on older
builds, subagent sidechains as top-level agent-*.jsonl files. "Newest *.jsonl
by mtime" therefore is not "the session": a headless run touched last wins,
and the watchdog measures the wrong file (no warn, no cut), the bridge wakes
the agent into an old or foreign transcript, and the export ships a header
prompt as if it were conversation.

This helper is the one place that decides. It skips files that identify
themselves as non-main (sdk entrypoint, sdk prompt source, agent-setting,
sidechain) and returns the newest remaining one. Files without any marker
count as main, so builds that write no entrypoint field behave exactly as
before (fail-open to the old rule, never to "no session at all").

Usage:
    latest_main_session.py <project-dir>   print the newest main session path
    latest_main_session.py --check <file>  exit 0 if main, 1 if not

Import:
    from latest_main_session import is_main_session, latest_main_session
"""
import os
import re
import sys

HEAD_LINES = 60

NON_MAIN = re.compile(
    r'"entrypoint"\s*:\s*"sdk-[a-z]+"'
    r'|"promptSource"\s*:\s*"sdk"'
    r'|"type"\s*:\s*"agent-setting"'
    r'|"isSidechain"\s*:\s*true'
)
MAIN = re.compile(r'"entrypoint"\s*:\s*"cli"')


def is_main_session(path, head_lines=HEAD_LINES):
    """True unless the transcript identifies itself as a non-main run."""
    if os.path.basename(path).startswith("agent-"):
        return False
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if NON_MAIN.search(line):
                    return False
                if MAIN.search(line):
                    return True
                if i + 1 >= head_lines:
                    break
    except OSError:
        return False
    return True


def latest_main_session(project_dir):
    """Newest main-session JSONL in project_dir, or None."""
    try:
        names = [n for n in os.listdir(project_dir) if n.endswith(".jsonl")]
    except OSError:
        return None
    paths = [os.path.join(project_dir, n) for n in names]
    paths = [p for p in paths if os.path.isfile(p)]
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for p in paths:
        if is_main_session(p):
            return p
    return None


def main(argv):
    if len(argv) == 3 and argv[1] == "--check":
        return 0 if is_main_session(argv[2]) else 1
    if len(argv) != 2:
        print("usage: latest_main_session.py <project-dir> | --check <file>",
              file=sys.stderr)
        return 2
    found = latest_main_session(argv[1])
    if not found:
        return 1
    print(found)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
