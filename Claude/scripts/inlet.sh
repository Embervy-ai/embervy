#!/bin/bash
# The inlet: a UserPromptSubmit hook for Claude Code. Asks the inlet worker
# which context fits the message and returns it as additionalContext; also
# counts turns, suppresses repeated blocks, adds the clock (and optional weather
# and calendar lines) and passes the watchdog's warning on.

set -e

ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"

# Under the Brain harness Brain injects its own context on every turn; this
# hook stays silent there so there is no second block.
if embervy_is_subturn; then
  exit 0
fi

# Read as data: a value is never expanded or run.
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
embervy_env_load -x "$EMBERVY_HOME/.env" 2>/dev/null

INPUT=$(cat)
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
embervy_hook_owns_input "$INPUT" "${EMBERVY_HOOK_HOME:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}" || exit 0

PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)

if [ -z "$PROMPT" ]; then
  echo '{}'
  exit 0
fi

# Call the inlet worker (Bun script that talks to the memory worker + rag)
# `|| true`: a crashing worker must fail OPEN (no context injected), not kill
# the whole hook under `set -e` — a broken inlet must never block the agent.
mkdir -p "$EMBERVY_HOME/logs" || true
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)
RESULT=$(timeout 25s bash -s -- "$PROMPT" "$TRANSCRIPT" 2>>"$EMBERVY_HOME/logs/inlet.log" <<'WORKER' || true
RECENT=$(timeout 1s python3 -B - "$2" "$1" "$EMBERVY_HOME/Claude/scripts" 2>/dev/null <<'PY' || true
from collections import deque
import json
import sys

sys.path.insert(0, sys.argv[3])
from transcript_speech import TranscriptSpeech, blocks, is_channel_message, is_peer_tool, is_room_tool, real_user, user_speech

try:
    with open(sys.argv[1], "rb") as source:
        source.seek(0, 2)
        start = max(0, source.tell() - 1048576)
        source.seek(start)
        if start:
            source.readline()
        lines = source.read(1048576).decode("utf-8").splitlines()
    turns = deque(maxlen=4)
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict) or entry.get("isSidechain"):
            continue
        # Claude Code marks channel messages as meta too; only meta without a channel is noise.
        if entry.get("isMeta") and not is_channel_message((entry.get("message") or {}).get("content")):
            continue
        if real_user(entry):
            turns.append([entry])
        elif turns:
            turns[-1].append(entry)

    def user_text(entry):
        content = (entry.get("message") or {}).get("content")
        return content if isinstance(content, str) else "\n".join(
            block.get("text", "") for block in blocks(entry) if block.get("type") == "text"
        )

    # Some hook versions have already appended the submitted message.
    if turns and len(turns[-1]) == 1 and user_text(turns[-1][0]) == sys.argv[2]:
        turns.pop()
    speech = TranscriptSpeech()
    output = []
    for turn in list(turns)[-3:]:
        # What was said, without channel wrappers or the house's own prompts.
        for speaker, said in user_speech(turn[0], "User"):
            said = " ".join(said.split())
            if said:
                output.append(f"{speaker}: {said}")
        results = {block.get("tool_use_id"): block for entry in turn for block in blocks(entry)
                   if block.get("type") == "tool_result"}
        delivered = speech.delivered_plain(turn)
        for entry in turn[1:]:
            # Failed or unconfirmed sends are not speech received by the person.
            selected = [block for block in blocks(entry)
                        if block.get("type") == "text" or (
                            block.get("type") == "tool_use" and (block.get("name") in speech.reply_tools or is_room_tool(str(block.get("name", ""))) or is_peer_tool(str(block.get("name", ""))))
                            and block.get("id") in results and not results[block["id"]].get("is_error"))]
            filtered = {**entry, "message": {**(entry.get("message") or {}), "content": selected}}
            reply = speech.render(filtered, delivered, results)
            if reply:
                output.append("Agent: " + reply)
    # Share the budget between the lines, so one long letter cannot push the others out.
    budget, lines = 1500, [" ".join(line.split()) for line in output]
    while lines and len("\n".join(lines)) > budget:
        share = max(80, budget // len(lines) - 1)
        trimmed = [line if len(line) <= share else line[:share - 1] + "…" for line in lines]
        if trimmed == lines:
            lines = lines[1:]
        else:
            lines = trimmed
    print("\n".join(lines), end="")
except Exception:
    pass
PY
)
if [ -n "$RECENT" ]; then
  exec bun "$EMBERVY_HOME/Claude/scripts/inlet-worker.ts" "$1" "$RECENT"
else
  exec bun "$EMBERVY_HOME/Claude/scripts/inlet-worker.ts" "$1"
fi
WORKER
)

# Bypass marker or empty result -> drop the RAG part. The watchdog warning
# below can still pass through. Exact match (not substring) — otherwise any
# legitimate occurrence of the word "BYPASS" inside an injected snippet would
# discard the whole context block.
if [ -z "$RESULT" ] || [ "$RESULT" = "BYPASS" ]; then
  RESULT=""
fi

# Increment the turn counter first (before dedupe), so other hooks can read it.
# flock + atomic temp+rename: concurrent hook invocations (double-trigger)
# must not clobber each other's counter value.
COUNTER_FILE="$EMBERVY_HOME/state/inlet-turn-counter"
TURN_SESSION_FILE="$EMBERVY_HOME/state/inlet-turn-session"
HOOK_SESSION=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
mkdir -p "$EMBERVY_HOME/state"
exec 7>"$EMBERVY_HOME/state/inlet-turn-counter.lock"
flock 7
TURN=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
[[ "$TURN" =~ ^[0-9]{1,9}$ ]] || TURN=0
LAST_SESSION=$(cat "$TURN_SESSION_FILE" 2>/dev/null || true)
if [ -n "$HOOK_SESSION" ] && [ "$HOOK_SESSION" != "$LAST_SESSION" ]; then
  TURN=0
fi
if [ -n "$HOOK_SESSION" ]; then
  SESSION_TMP=$(mktemp "${TURN_SESSION_FILE}.XXXXXX")
  printf '%s\n' "$HOOK_SESSION" > "$SESSION_TMP"
  mv -f "$SESSION_TMP" "$TURN_SESSION_FILE"
fi
TURN=$((10#$TURN + 1))
COUNTER_TMP=$(mktemp "${COUNTER_FILE}.XXXXXX")
echo "$TURN" > "$COUNTER_TMP"
mv -f "$COUNTER_TMP" "$COUNTER_FILE"
flock -u 7

# An identical block is suppressed if it was injected within the last N turns
# (default 300: a 1M context holds roughly 200 to 400 turns).
DEBUG_LOG="$EMBERVY_HOME/logs/inlet-fired.log"
mkdir -p "$EMBERVY_HOME/logs"
if [ -n "$RESULT" ]; then
  CACHE_DIR="$EMBERVY_HOME/state/inlet-cache"
  mkdir -p "$CACHE_DIR"
  HASH=$(printf "%s" "$RESULT" | sha256sum | awk '{print $1}')
  CACHE_FILE="$CACHE_DIR/$HASH"
  TURN_TTL="${INLET_DEDUPE_TURN_TTL:-300}"
  if [ -f "$CACHE_FILE" ]; then
    LAST_TURN=$(cat "$CACHE_FILE" 2>/dev/null || echo 0)
    DIFF=$((TURN - LAST_TURN))
    if [ "$DIFF" -ge 0 ] && [ "$DIFF" -lt "$TURN_TTL" ]; then
      echo "$(date -Iseconds) dedupe suppress hash=$HASH turn-diff=$DIFF (TTL=$TURN_TTL)" \
        >> "$DEBUG_LOG" 2>/dev/null
      # A repeated retrieval block must not hide a degraded turn.
      case "$RESULT" in
        '(Memory search ran without its query step this turn;'*) RESULT=${RESULT%%$'\n'*} ;;
        *) RESULT="" ;;
      esac
    else
      echo "$TURN" > "$CACHE_FILE"
    fi
  else
    echo "$TURN" > "$CACHE_FILE"
  fi

  find "$CACHE_DIR" -type f -mmin +240 -delete 2>/dev/null || true
fi

# EMBERVY_TIMEZONE (IANA) and EMBERVY_TIME_LABEL localize the clock line.
TZ_NAME="${EMBERVY_TIMEZONE:-UTC}"
TZ_LABEL="${EMBERVY_TIME_LABEL:-$TZ_NAME}"

# Calendar lines carry their own channel envelope for subscription content.
# Keep it intact when adding the once-per-session/day block.
CALENDAR=""
if [ "${EMBERVY_HOOK_CALENDAR:-0}" = "1" ]; then
  CALENDAR=$(timeout 5 bun "$EMBERVY_HOME/shared/calendar/day-line.ts" "$HOOK_SESSION" \
    --data-dir "${EMBERVY_APP_DATA_DIR:-$EMBERVY_HOME/Claude/app/data}" 2>/dev/null || true)
fi

if [ $((TURN % 5)) -eq 1 ] || [ -n "$CALENDAR" ]; then
  WEEKDAY=$(TZ="$TZ_NAME" date "+%A")
  CLOCK=$(TZ="$TZ_NAME" date "+⏰ $TZ_LABEL: $WEEKDAY, %Y-%m-%d, %H:%M")

  # One weather line under the clock, when EMBERVY_HOOK_WEATHER=1.
  if [ "${EMBERVY_HOOK_WEATHER:-0}" = "1" ] || jq -e '.weather == true' "$EMBERVY_HOME/config/features.json" >/dev/null 2>&1; then
    # Remote place names and cached weather are data, just like other channel content.
    WEATHER=$(timeout 8 bun "$EMBERVY_HOME/shared/tools/weather.ts" 2>/dev/null | \
      bun "$EMBERVY_HOME/shared/scripts/context-text.ts" 2>/dev/null || true)
    if [ -n "$WEATHER" ]; then
      CLOCK="${CLOCK}
${WEATHER}"
    fi
  fi
  if [ -n "$CALENDAR" ]; then
    CLOCK="${CLOCK}
${CALENDAR}"
  fi
  if [ -n "$RESULT" ]; then
    RESULT="${CLOCK}

---

${RESULT}"
  else
    RESULT="$CLOCK"
  fi
fi

WARNING_FILE="$EMBERVY_HOME/state/context_warning"
if [ -f "$WARNING_FILE" ]; then
  WARNING=$(cat "$WARNING_FILE")
  if [ -n "$RESULT" ]; then
    RESULT="${WARNING}

---

${RESULT}"
  else
    RESULT="$WARNING"
  fi
fi

if [ -z "$RESULT" ]; then
  echo '{}'
  exit 0
fi

ESCAPED=$(echo "$RESULT" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": $ESCAPED
  }
}
EOF
exit 0
