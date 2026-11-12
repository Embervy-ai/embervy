#!/bin/bash
# Exports a session transcript to the archive with a generated header.

ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/curl-auth.sh"
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME
SESSION_PREFIX="${SESSION_PREFIX:-Session}"
USER_LABEL="${USER_LABEL:-User}"
AGENT_LABEL="${AGENT_LABEL:-${SYNTH_LABEL:-Agent}}"
SPLIT_THRESHOLD="${SPLIT_THRESHOLD:-81920}"

embervy_env_load "$EMBERVY_HOME/.env"

if [ -z "${RAG_URL:-}" ]; then
  echo "RAG_URL is not set" >&2
  exit 1
fi

SESSION_DIR="${CLAUDE_PROJECT_DIR:-$HOME/.claude/projects/$(echo "$EMBERVY_HOME" | tr / -)}"


export SESSION_PREFIX

# Require a successful file list to avoid overwriting an existing session.
# The local number floor prevents reuse of a number already assigned.
NUMBER_FLOOR_FILE="$EMBERVY_HOME/state/last_session_number_${SESSION_PREFIX}"
AUTO_NUMBER=""
if [ -z "$1" ]; then
  HIGHEST=$(embervy_curl_bearer "${RAG_AUTH_TOKEN:-}" -s --connect-timeout 10 --max-time 30 -w '\n%{http_code}' "$RAG_URL/list" | python3 -c "
import sys, json, re, os
prefix = os.environ.get('SESSION_PREFIX', 'Session')
body, _, status = sys.stdin.read().rpartition('\n')
try:
    d = json.loads(body) if status.strip() == '200' else None
except ValueError:
    d = None
files = d.get('files') if isinstance(d, dict) else None
if not isinstance(files, list):
    sys.exit(1)
nums = [0]
for f in files:
    m = re.match(rf'{re.escape(prefix)}_(\d+)(?:_part\d+)?\.md', str(f.get('name', '')) if isinstance(f, dict) else '')
    if m:
        nums.append(int(m.group(1)))
print(max(nums))
" 2>/dev/null) || { echo "RAG /list gave no file list — not guessing a session number; the next run catches up" >&2; exit 1; }
  FLOOR=""
  if [ -f "$NUMBER_FLOOR_FILE" ]; then
    FLOOR=$(tr -dc 0-9 2>/dev/null < "$NUMBER_FLOOR_FILE")
  fi
  if [ -n "$FLOOR" ] && [ "$FLOOR" -gt "$HIGHEST" ]; then HIGHEST="$FLOOR"; fi
  AUTO_NUMBER=$((HIGHEST+1))
  NAME="${SESSION_PREFIX}_${AUTO_NUMBER}"
else
  NAME="$1"
fi

if [ -z "$2" ]; then
  SESSION_NUM=$(echo "$NAME" | grep -oE '[0-9]+' | head -1)
  SESSION_NUM="${SESSION_NUM:-0}"
else
  SESSION_NUM="$2"
fi

SESSION_FILE="${SESSION_FILE:-$(python3 "$EMBERVY_HOME/Claude/scripts/latest_main_session.py" "$SESSION_DIR" 2>/dev/null)}"

if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
  echo "No session file found in $SESSION_DIR" >&2
  exit 1
fi

echo "Session file: $SESSION_FILE ($(du -h "$SESSION_FILE" | cut -f1))"

# The fingerprint prevents repeated triggers from uploading an unchanged transcript twice.
UPLOAD_LOG="$EMBERVY_HOME/state/uploaded_sessions"
mkdir -p "$EMBERVY_HOME/state"
touch "$UPLOAD_LOG"
SESSION_BASENAME=$(basename "$SESSION_FILE")
SESSION_SIZE=$(stat -c%s "$SESSION_FILE" 2>/dev/null || stat -f%z "$SESSION_FILE")
SESSION_MTIME=$(stat -c%Y "$SESSION_FILE" 2>/dev/null || stat -f%m "$SESSION_FILE")
SESSION_FPR="${SESSION_BASENAME}:${SESSION_SIZE}:${SESSION_MTIME}"
if grep -qF "$SESSION_FPR" "$UPLOAD_LOG"; then
  echo "Session $SESSION_BASENAME (size=$SESSION_SIZE mtime=$SESSION_MTIME) already uploaded — skipping"
  exit 0
fi

# A reserved automatic name lets a retry reach the same persistent family cleanup plan.
RESERVATION=""
if [ -n "$AUTO_NUMBER" ] && [ -z "${DRY_RUN:-}" ]; then
  RESERVATION="$EMBERVY_HOME/state/pending_session_$(printf '%s\n%s' "$SESSION_FILE" "$SESSION_PREFIX" | sha256sum | cut -d' ' -f1)"
  AUTO_NUMBER=$(python3 - "$RESERVATION" "$AUTO_NUMBER" <<'PY'
import os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
if path.exists():
    number = int(path.read_text())
else:
    number = int(sys.argv[2])
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as out:
        out.write(str(number))
        out.flush()
        os.fsync(out.fileno())
    os.replace(out.name, path)
print(number)
PY
  ) || exit 1
  NAME="${SESSION_PREFIX}_${AUTO_NUMBER}"
  SESSION_NUM="$AUTO_NUMBER"
  FLOOR=$(cat "$NUMBER_FLOOR_FILE" 2>/dev/null || echo 0)
  if [ "$AUTO_NUMBER" -gt "${FLOOR:-0}" ]; then
    printf '%s\n' "$AUTO_NUMBER" > "$NUMBER_FLOOR_FILE" || exit 1
  fi
fi

TMPDIR=$(mktemp -d) || exit 1
trap 'rm -rf -- "$TMPDIR"' EXIT

export SESSION_FILE NAME SESSION_NUM TMPDIR USER_LABEL AGENT_LABEL
export EMBERVY_ROOM_NAME ROOM_NAME
export BRAIN_TIMEZONE EMBERVY_TIMEZONE

python3 - "$(dirname -- "${BASH_SOURCE[0]}")" << 'PYEOF'
import json
import sys
import os
import re
from datetime import datetime
sys.path.insert(0, sys.argv[1])
from transcript_speech import TranscriptSpeech, strip_transcript_tags, user_speech

session_file = os.environ.get("SESSION_FILE", "")
name = os.environ.get("NAME", "Session")
session_num = os.environ.get("SESSION_NUM", "0")
tmpdir = os.environ.get("TMPDIR", "/tmp")
user_label = os.environ.get("USER_LABEL", "User")
agent_label = os.environ.get("AGENT_LABEL", "Agent")

def entries(lines):
    for line in lines:
        try:
            entry = json.loads(line.strip())
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict):
            yield entry


messages = []
with open(session_file, 'r') as f:
    for entry, speech in TranscriptSpeech().entries(entries(f)):
        ts = entry.get("timestamp", "")
        messages.extend((speaker, text, ts) for speaker, text in user_speech(entry, user_label))
        if speech:
            text = strip_transcript_tags(speech, reminders_only=True)
            if text:
                messages.append((agent_label, text, ts))

if not messages:
    print("NO_MESSAGES")
    sys.exit(1)

def env_word(value):
    """First word of an env value; .env lines may carry inline comments."""
    value = (value or "").strip()
    m = re.match(r'^([\'"])(.*)\1$', value)
    if m:
        value = m.group(2)
    words = value.split()
    return words[0] if words else ""

def house_zone():
    """BRAIN_TIMEZONE, then EMBERVY_TIMEZONE (the first valid one), else None."""
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        return None
    for key in ("BRAIN_TIMEZONE", "EMBERVY_TIMEZONE"):
        zone_name = env_word(os.environ.get(key))
        if not zone_name:
            continue
        try:
            return ZoneInfo(zone_name)
        except Exception:
            continue
    return None

def archive_date(ts, zone):
    """Header DATE: the calendar day of the first message in the house zone.
    A session that starts at 00:30 local time gets that day, not the UTC day
    before; one that runs past midnight keeps its start day. Without a
    configured zone: the UTC day, as before."""
    if not ts:
        return (datetime.now(zone) if zone else datetime.now()).strftime("%Y-%m-%d")
    if zone is None:
        return ts[:10]
    try:
        from datetime import timezone as _tz
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=_tz.utc)
        return dt.astimezone(zone).strftime("%Y-%m-%d")
    except ValueError:
        return ts[:10]

first_ts = messages[0][2] if messages else ""
date_str = archive_date(first_ts, house_zone())

# Placeholder header; enrich-header.sh replaces it.
header = f"""# [{name}] [DATE: {date_str}]

SESSION={session_num} | TYPE=CHAT | DATE={date_str}
THEMES=—
SUMMARY=—
EMOTIONAL_ARC=—
KEY_MOMENTS=—
DYNAMIC=—"""

output = header + "\n"
for speaker, content, ts in messages:
    output += f"\n---\n\n**{speaker}**\n\n{content}\n"

outpath = os.path.join(tmpdir, f"{name}.md")
with open(outpath, 'w', encoding='utf-8') as f:
    f.write(output)

size_kb = len(output) // 1024
print(f"EXPORTED:{len(messages)} messages, {size_kb}KB")
PYEOF

MDFILE="$TMPDIR/${NAME}.md"
if [ ! -f "$MDFILE" ]; then
  echo "Export failed" >&2
  exit 1
fi

FILESIZE=$(stat -c%s "$MDFILE" 2>/dev/null || stat -f%z "$MDFILE" 2>/dev/null)
SIZE_KB=$((FILESIZE / 1024))
echo "Exported: ${SIZE_KB}KB"

if [ -x "$EMBERVY_HOME/Claude/scripts/enrich-header.sh" ]; then
  "$EMBERVY_HOME/Claude/scripts/enrich-header.sh" "$MDFILE" >/dev/null 2>&1
  HEADER_STATUS=$?
  if [ "$HEADER_STATUS" -eq 0 ]; then
    echo "Header enriched."
    rm -f "${MDFILE}.bak" || exit 1
  elif [ "$HEADER_STATUS" -eq 2 ]; then
    echo "Header enrichment skipped — keeping placeholder."
  else
    # A failed replacement keeps its original and backup for recovery instead of uploading partial data.
    trap - EXIT
    echo "Header replacement failed; recovery files remain in $TMPDIR" >&2
    exit 1
  fi
fi

FILESIZE=$(stat -c%s "$MDFILE" 2>/dev/null || stat -f%z "$MDFILE" 2>/dev/null)

if [ -n "${DRY_RUN:-}" ]; then
  DRY_OUT="${DRY_OUT:-/tmp/${NAME}.md}"
  cp "$MDFILE" "$DRY_OUT"
  echo "DRY_RUN — wrote $DRY_OUT (${SIZE_KB}KB), skipping upload"
  exit 0
fi

# Every size uses the family plan so shrinking to an unsplit file removes old parts too.
SMART_UPLOAD="$EMBERVY_HOME/shared/scripts/smart_upload.sh"
[ -f "$SMART_UPLOAD" ] || SMART_UPLOAD="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/smart_upload.sh"
export SPLIT_THRESHOLD
if ! bash "$SMART_UPLOAD" "$MDFILE"; then
  echo "Family upload or cleanup failed — fingerprint will NOT be written" >&2
  exit 1
fi

echo "$SESSION_FPR" >> "$UPLOAD_LOG" || exit 1
[ -z "$RESERVATION" ] || rm -f "$RESERVATION" || exit 1
echo "Done. Session is in the RAG."
