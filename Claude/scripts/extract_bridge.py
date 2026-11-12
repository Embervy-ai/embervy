#!/usr/bin/env python3
"""extract_bridge.py — build a wake-bridge from the last N turns of a session.

The bridge is a small Markdown file that the next Claude Code session reads
via --append-system-prompt. It carries the most recent conversation turns so
the new session does not start cold after a cut/crash.

Usage:
    extract_bridge.py [N] [OUTPUT]
    extract_bridge.py --output OUTPUT
        N:      optional turns override (otherwise EMBERVY_BRIDGE_TURNS, default 40)
        OUTPUT: output path (default $EMBERVY_HOME/state/wake_bridge.md)

EMBERVY_BRIDGE_MODE selects turns (default) or sessions. Sessions mode uses
EMBERVY_BRIDGE_SESSIONS (default 2) and EMBERVY_BRIDGE_MIN_USER_TURNS (default 8).
It reads at most the requested count plus two main transcripts, newest first by
modification time; headless runs in the same folder are skipped and do not
count. Earlier files must precede the pinned file. Headings use each
transcript's first timestamp. A sessions-mode byte budget includes headings
and always keeps the newest turn.
Bridge settings come from the process environment, then the house .env,
then Claude/app/.env, with later files taking precedence.

A second, independent knob caps the bridge in BYTES — OFF by default:
set EMBERVY_BRIDGE_BYTE_BUDGET to a positive number and it becomes a
guarantee. Bridge size is dominated by turn LENGTH, not turn count —
measured in the field, forty long turns can weigh double what forty short
ones do. With a budget set, the oldest user turns are dropped one at a
time (the cut always falls on a user-turn boundary) until the bridge
fits. Nobody's forty turns are trimmed unless they asked for it: if your
turns run long, that is how you talk — size the budget yourself.

A "turn" here is a user message plus the assistant reply that follows.
The script extracts user text (including <channel>-wrapped app messages),
delivered app text, and outreach tool calls. Terminal prose, thinking,
system reminders, command output, and tool chains are stripped.

Environment:
    EMBERVY_HOME     install root (default /opt/embervy)
    SESSION_FILE     pin a specific JSONL (cutoff.sh sets this so bridge and
                     RAG export read the same session)
    USER_LABEL       speaker label for the user (default "User")
    AGENT_LABEL      speaker label for the agent (default "Agent"; SYNTH_LABEL is honoured as legacy key)
    REPLY_TOOL_NAMES comma-separated MCP tool names treated as user-facing
                     replies (default mcp__app__reply,mcp__app__send; the
                     loop and cutoff.sh export the list with the names an
                     older house used as well — shared/scripts/legacy-names.sh)

The room tool (room, or any MCP name ending in __room: the app's room door)
is kept as "[Room] <text>", so the agent's words in a room never read as
words to the user.
"""

import json
import os
import re
import sys
import subprocess
from pathlib import Path
from transcript_speech import TranscriptSpeech, strip_transcript_tags, user_speech

EMBERVY_HOME = Path(os.environ.get("EMBERVY_HOME", "/opt/embervy"))
# Use the shared data reader so a standalone bridge sees the same room as the exporter.
_env_lib = Path(__file__).resolve().parents[2] / "shared" / "scripts" / "env-file.sh"
# A missing reader or .env must never cost the bridge: then only the process env names rooms.
try:
    _room_env = subprocess.run([
        "bash", "-c", '. "$1"; embervy_env_load "$2/.env"; printf "%s\\0%s" "${EMBERVY_ROOM_NAME:-}" "${ROOM_NAME:-}"',
        "bridge-room", str(_env_lib), str(EMBERVY_HOME),
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10).stdout.decode('utf-8')
except (OSError, subprocess.SubprocessError):
    _room_env = "\0".join(os.environ.get(k, "") for k in ("EMBERVY_ROOM_NAME", "ROOM_NAME"))
ROOM_NAMES = set(filter(None, (name.strip() for name in _room_env.split('\0'))))
# Resolve bridge settings here so every writer uses the same files and defaults.
BRIDGE_KEYS = (
    "EMBERVY_BRIDGE_MODE", "EMBERVY_BRIDGE_TURNS", "EMBERVY_BRIDGE_SESSIONS",
    "EMBERVY_BRIDGE_MIN_USER_TURNS", "EMBERVY_BRIDGE_BYTE_BUDGET", "EMBERVY_TIMEZONE",
)
bridge_env = dict(os.environ)
try:
    settings = subprocess.run([
        "bash", "-c",
        '. "$1"; embervy_env_load -x "$2/.env" "$2/Claude/app/.env"; '
        'shift 2; for key; do printf "%s\\0" "${!key-}"; done',
        "bridge-settings", str(_env_lib), str(EMBERVY_HOME), *BRIDGE_KEYS,
    ], check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=10).stdout.decode("utf-8")
    bridge_env.update(zip(BRIDGE_KEYS, settings.split("\0")))
except (OSError, subprocess.SubprocessError):
    pass


def positive_setting(key, default):
    raw = bridge_env.get(key, "").strip().lstrip("0") or "0"
    return int(raw) if re.fullmatch(r"[0-9]{1,16}", raw) and 0 < int(raw) <= 9007199254740991 else default


BRIDGE_MODE = "sessions" if bridge_env.get("EMBERVY_BRIDGE_MODE", "").strip().lower() == "sessions" else "turns"
USER_LABEL = os.environ.get("USER_LABEL", "User")
AGENT_LABEL = os.environ.get("AGENT_LABEL") or os.environ.get("SYNTH_LABEL") or "Agent"  # SYNTH_LABEL: legacy key
SPEECH = TranscriptSpeech()

CHECK_MESSAGES = "--has-messages" in sys.argv[1:]
if CHECK_MESSAGES:
    sys.argv.remove("--has-messages")
args = sys.argv[1:]
OUTPUT = str(EMBERVY_HOME / "state" / "wake_bridge.md")
if "--output" in args:
    output_index = args.index("--output")
    OUTPUT = args[output_index + 1]
    del args[output_index:output_index + 2]
N_TURNS = int(args[0]) if args else positive_setting("EMBERVY_BRIDGE_TURNS", 40)
if len(args) > 1:
    OUTPUT = args[1]

# Claude Code maps each project root to a fs-safe name for its session dir.
SESSION_DIR = Path(os.environ.get(
    "CLAUDE_PROJECT_DIR",
    Path.home() / ".claude" / "projects" / str(EMBERVY_HOME).replace("/", "-"),
))

N_SESSIONS = positive_setting("EMBERVY_BRIDGE_SESSIONS", 2)
MIN_USER_TURNS = positive_setting("EMBERVY_BRIDGE_MIN_USER_TURNS", 8)
CLASSIFY_LIMIT = 200
env_session = os.environ.get("SESSION_FILE", "").strip()
session_file = Path(env_session) if env_session else None
if BRIDGE_MODE == "sessions" or session_file is None:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from latest_main_session import is_main_session, latest_main_session
if session_file and not session_file.is_file():
    print(f"SESSION_FILE does not exist: {env_session}", file=sys.stderr)
    sys.exit(1)


def session_candidates():
    folder = session_file.parent if session_file else SESSION_DIR
    ceiling = session_file.stat().st_mtime_ns if session_file else None
    candidates = []
    try:
        for path in folder.glob("*.jsonl"):
            try:
                modified = path.stat().st_mtime_ns
                if path.is_file() and (ceiling is None or modified < ceiling):
                    candidates.append((modified, path))
            except OSError:
                continue
    except OSError:
        pass
    candidates.sort(key=lambda item: (item[0], item[1].name), reverse=True)
    paths = ([session_file] if session_file else []) + [path for _, path in candidates]
    # Headless runs (cache pings, headers) land here between main sessions; telling
    # them apart reads only a file's first lines, and the bound keeps a long archive unwalked.
    return paths[:CLASSIFY_LIMIT]


candidates = session_candidates() if BRIDGE_MODE == "sessions" else []
if CHECK_MESSAGES and session_file:
    candidates = [session_file]
if BRIDGE_MODE != "sessions" and session_file is None:
    found = latest_main_session(str(SESSION_DIR))
    session_file = Path(found) if found else None
    if session_file is None:
        print(f"No session file found in {SESSION_DIR}", file=sys.stderr)
        sys.exit(1)


def inbound(message):
    """A turn someone else started: the person, a room member or a direct line, not the agent or a harness notice."""
    return message[0] not in (AGENT_LABEL, "System")


def extract_messages(path, strict=False):
    messages = []
    started = ""

    def entries(lines):
        nonlocal started
        for line in lines:
            try:
                entry = json.loads(line.strip())
            except json.JSONDecodeError:
                if strict:
                    raise
                continue
            if not isinstance(entry, dict):
                if strict:
                    raise ValueError("Invalid transcript entry")
                continue
            ts = entry.get("timestamp", "")
            if not started and isinstance(ts, str) and ts:
                started = ts
            yield entry

    with open(path, 'r') as f:
        for entry, speech in SPEECH.entries(entries(f)):
            ts = entry.get("timestamp", "")
            messages.extend((speaker, text, ts) for speaker, text in user_speech(entry, USER_LABEL, ROOM_NAMES))
            if speech:
                text = strip_transcript_tags(speech)
                if text:
                    messages.append((AGENT_LABEL, text, ts))
    return messages, started or "start time unavailable"


sessions = []
if BRIDGE_MODE == "sessions":
    substantial = 0
    main_read = 0
    for path in candidates:
        # Thin main sessions ride along, but at most two beyond the requested count.
        if main_read >= N_SESSIONS + 2:
            break
        if not is_main_session(str(path)):
            continue
        main_read += 1
        if session_file is None:
            session_file = path
        try:
            extracted, started = extract_messages(path, strict=path != session_file)
        except (OSError, UnicodeError, ValueError, TypeError, AttributeError):
            if CHECK_MESSAGES or path == session_file:
                sys.exit(1)
            continue
        if CHECK_MESSAGES:
            sys.exit(0 if extracted else 1)
        if extracted:
            sessions.append((path, started, extracted))
            substantial += sum(inbound(m) for m in extracted) >= MIN_USER_TURNS
        if substantial >= N_SESSIONS:
            break
    sessions.reverse()
    messages = [message for _, _, extracted in sessions for message in extracted]
    if sessions:
        session_file = sessions[-1][0]
else:
    messages, _ = extract_messages(session_file)

# Startup uses the same extraction rules without writing a bridge or warning on an empty login.
if CHECK_MESSAGES:
    sys.exit(0 if messages else 1)

if not messages:
    print("No messages extracted", file=sys.stderr)
    sys.exit(1)

# Walk backwards: take the last N user turns and everything after them.
# Strategy: collect indices of user messages, slice from the N-th from the end.
user_indices = [i for i, m in enumerate(messages) if inbound(m)]

if BRIDGE_MODE == "sessions" or len(user_indices) <= N_TURNS:
    start_idx = 0
else:
    start_idx = user_indices[-N_TURNS]

selected = messages[start_idx:]

# Byte budget — opt-in. Unset/0 means: the forty turns you asked for are
# the forty turns you get, however long you talk. Set a positive budget
# and it becomes a guarantee, trimming whole user turns from the front.
BYTE_BUDGET = positive_setting("EMBERVY_BRIDGE_BYTE_BUDGET", 0)

def local_clock(ts):
    """(day line, HH:MM) in the house's time zone, or None.
    The time comes only from the transcript, never from the text; unknown stays unknown."""
    if not isinstance(ts, str) or not ts.strip():
        return None
    try:
        from datetime import datetime
        moment = datetime.fromisoformat(ts.strip().replace("Z", "+00:00"))
        if moment.tzinfo is None:
            return None
        # The house names its zone EMBERVY_TIMEZONE (as the inlet reads it); servers often run on UTC.
        zone = bridge_env.get("EMBERVY_TIMEZONE") or bridge_env.get("EMBERVY_TZ") or bridge_env.get("TZ")
        if zone:
            from zoneinfo import ZoneInfo
            local = moment.astimezone(ZoneInfo(zone))
        else:
            local = moment.astimezone()
    except (ValueError, KeyError, ImportError, OSError):
        return None
    return f"{local:%A}, {local.day} {local:%B} {local.year}", f"{local:%H:%M}"


def render_message(message, state=None):
    speaker, content, ts = message
    clock = local_clock(ts)
    if clock is None:
        return f"\n**{speaker}**\n\n{content}\n\n---\n"
    # A day line before the first turn of each new day, so the agent never guesses how long ago a turn was.
    day_line = ""
    if state is not None and state.get("day") != clock[0]:
        day_line = f"\n## {clock[0]}\n"
        state["day"] = clock[0]
    return f"{day_line}\n**{speaker}** · {clock[1]}\n\n{content}\n\n---\n"


def rendered_size(msgs):
    state = {}
    return sum(len(render_message(m, state).encode("utf-8")) for m in msgs)

if BRIDGE_MODE == "turns" and BYTE_BUDGET > 0:
    while rendered_size(selected) > BYTE_BUDGET:
        remaining_user = [i for i, m in enumerate(selected) if inbound(m)]
        if len(remaining_user) <= 1:
            break  # never trim below one full turn
        selected = selected[remaining_user[1]:]  # drop oldest user turn (boundary cut)

header = f"""# Wake Bridge — last {N_TURNS} turns

Source: {session_file.name}
Messages extracted: {len(selected)}

---
"""

day_state = {}
output = header + "".join(render_message(message, day_state) for message in selected)
if BRIDGE_MODE == "sessions":
    turns = []
    for index, (_, _, extracted) in enumerate(sessions):
        for message in extracted:
            if not turns or turns[-1][0] != index or inbound(message):
                turns.append((index, []))
            turns[-1][1].append(message)

    def render_sessions(remaining):
        if not remaining:
            return ""
        parts = [f"# Wake Bridge — last {N_SESSIONS} substantial sessions\n"]
        previous = None
        state = {}
        for index, turn in remaining:
            if index != previous:
                path, started, _ = sessions[index]
                parts.append(f"\n## Session — {started}\n\nSource: {path.name}\n")
                previous = index
            parts.extend(render_message(message, state) for message in turn)
        return "".join(parts)

    output = render_sessions(turns)
    # Like turns mode, the newest turn always stays, even over budget.
    while BYTE_BUDGET > 0 and len(turns) > 1 and len(output.encode("utf-8")) > BYTE_BUDGET:
        turns = turns[1:]
        output = render_sessions(turns)
    selected = [message for _, turn in turns for message in turn]

out_path = Path(OUTPUT)
out_path.parent.mkdir(parents=True, exist_ok=True)
# Write beside the bridge, then swap it in with one rename: a cut that kills
# us mid-write leaves the previous bridge (or none) — never half a bridge that
# the loop would load into the next session. The pid keeps two runs at once
# (cut and loop finalize) from writing into the same temp file.
tmp_path = out_path.with_name(f".{out_path.name}.{os.getpid()}.tmp")
try:
    tmp_path.write_text(output, encoding='utf-8')
    if out_path.exists():
        # The in-place write kept the old file's mode; so does the swap.
        os.chmod(tmp_path, out_path.stat().st_mode & 0o7777)
    os.replace(tmp_path, out_path)
except BaseException:
    tmp_path.unlink(missing_ok=True)
    raise

size_kb = len(output.encode('utf-8')) // 1024
source_label = f"{len(sessions)} sessions" if BRIDGE_MODE == "sessions" else session_file.name
print(f"Bridge written: {OUTPUT} ({size_kb}KB, {len(selected)} messages from {source_label})")
