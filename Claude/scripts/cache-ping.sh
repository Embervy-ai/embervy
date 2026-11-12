#!/bin/bash
# Keeps the prompt cache warm during idle sessions.
set -uo pipefail
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME
ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
tmux() { embervy_tmux "$@"; }
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
SCRIPT_DIR=$(cd -- "$(dirname -- "$0")" && pwd)

# The file is authoritative, including removal of either setting at runtime.
EMBERVY_CACHE_PING=0
EMBERVY_CACHE_PING_MINUTES=""
# Read configuration as data, not shell code; app settings take precedence over root settings.
embervy_env_load "$EMBERVY_HOME/.env" "$EMBERVY_HOME/Claude/app/.env"
LOG="$EMBERVY_HOME/logs/cache-ping.log"
log() { mkdir -p "$EMBERVY_HOME/logs"; printf '%s %s\n' "$(date -Iseconds)" "$*" >> "$LOG"; }
DISABLED_REASON=""
if [ "$EMBERVY_CACHE_PING" != 1 ]; then
  DISABLED_REASON="EMBERVY_CACHE_PING is not 1"
elif ! [[ "$EMBERVY_CACHE_PING_MINUTES" =~ ^[1-9][0-9]{0,5}$ ]]; then
  DISABLED_REASON="EMBERVY_CACHE_PING_MINUTES is empty or invalid (positive integer required)"
fi

if [ "${1:-}" = --watch ]; then
  if [ -n "$DISABLED_REASON" ]; then log "disabled: $DISABLED_REASON";
  else log "enabled, threshold ${EMBERVY_CACHE_PING_MINUTES}m"; fi
  CHILD=""
  trap '[ -z "$CHILD" ] || { kill "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; }; exit 0' TERM INT
  while true; do
    sleep 300 & CHILD=$!
    wait "$CHILD" || exit 0
    # Do not detach: the loop stops this watcher before finalizing/respawning.
    bash "$0" --tick & CHILD=$!
    wait "$CHILD"
    CHILD=""
  done
fi
[ "$EMBERVY_CACHE_PING" = 1 ] || exit 0
if [ -n "$DISABLED_REASON" ]; then
  [ "${1:-}" = --tick ] || log "skip: $DISABLED_REASON"
  exit 0
fi

mkdir -p "$EMBERVY_HOME/state"
# Typing must not overlap export, termination or another ping.
exec 9>"$EMBERVY_HOME/state/claude-input.lock"
flock -n 9 || { log "skip: cut or another cache ping in progress"; exit 0; }
SESSION_DIR="${CLAUDE_PROJECT_DIR:-$HOME/.claude/projects/$(echo "$EMBERVY_HOME" | tr / -)}"
SESSION_FILE=$(python3 "$SCRIPT_DIR/latest_main_session.py" "$SESSION_DIR" 2>/dev/null) || exit 0

eligible() {
  # The marker also covers the gap before the replacement transcript appears.
  if [ -f "$EMBERVY_HOME/state/last_cut_session" ] &&
     [ "$(cat "$EMBERVY_HOME/state/last_cut_session")" = "$(basename "$SESSION_FILE")" ]; then
    log "skip: cut/respawn pending for this session"
    return 1
  fi
  [ "$(python3 "$SCRIPT_DIR/latest_main_session.py" "$SESSION_DIR" 2>/dev/null)" = "$SESSION_FILE" ] || return 1
  if python3 "$SCRIPT_DIR/cache_ping_state.py" idle "$SESSION_FILE" "$EMBERVY_CACHE_PING_MINUTES"; then return 0; fi
  local now last=0 idle
  now=$(date +%s)
  last=$(cat -- "$EMBERVY_HOME/state/cache-ping-idle-log" 2>/dev/null) || last=0
  [[ "$last" =~ ^[0-9]{1,12}$ ]] || last=0
  if (( now - 10#$last >= 3600 )); then
    idle=$(python3 -B - "$SCRIPT_DIR" "$SESSION_FILE" 2>/dev/null <<'PY'
import json, os, sys, time
sys.path.insert(0, sys.argv[1])
from cache_ping_state import idle, timestamp
path = sys.argv[2]
if not idle(path, 0):
    sys.exit(1)
last = None
with open(path, encoding="utf-8", errors="replace") as source:
    for line in source:
        try:
            event = json.loads(line)
            if isinstance(event, dict) and not event.get("isSidechain") and event.get("type") == "assistant":
                last = event.get("timestamp")
        except (ValueError, TypeError):
            pass
try:
    previous = timestamp(last)
except (ValueError, TypeError, OverflowError):
    previous = os.path.getmtime(path)
print(max(0, int((time.time() - previous) / 60)))
PY
    ) || return 1
    if (( idle < EMBERVY_CACHE_PING_MINUTES )); then
      log "idle ${idle}m < ${EMBERVY_CACHE_PING_MINUTES}m"
      printf '%s\n' "$now" > "$EMBERVY_HOME/state/cache-ping-idle-log"
    fi
  fi
  return 1
}
eligible || exit 0

# Quota comes only from a local status snapshot, never a network lookup; missing or stale data does not block a ping.
if python3 "$SCRIPT_DIR/cache_ping_state.py" limited "${EMBERVY_CACHE_PING_STATUS_FILE:-$EMBERVY_HOME/state/claude-statusline.json}"; then
  log "skip: fresh statusline reports exhausted rate limit"
  exit 0
fi

# Pin the pane so changing the selected window cannot redirect input.
TARGET="${EMBERVY_CACHE_PING_PANE:-${EMBERVY_TMUX_SESSION:-embervy}}"
PANE_ID=$(tmux display-message -p -t "$TARGET" '#{pane_id}' 2>/dev/null) || exit 0
[ -n "$PANE_ID" ] || exit 0
pane_safe() {
  local pane
  embervy_pane_has_claude "$PANE_ID" || {
    log "skip: Claude is not foreground (respawn or stopped)"
    return 1
  }
  pane=$(tmux capture-pane -p -t "$PANE_ID" 2>/dev/null) || return 1
  printf '%s\n' "$pane" | python3 "$SCRIPT_DIR/cache_ping_state.py" pane "${1:-}" || {
    log "skip: approval dialog, busy pane, or nonempty/unknown prompt"
    return 1
  }
}
pane_safe || exit 0
# Cancelling copy mode must not send keys to an approval dialog.
if [ "$(tmux display-message -p -t "$PANE_ID" '#{pane_in_mode}' 2>/dev/null)" = 1 ]; then
  tmux send-keys -X -t "$PANE_ID" cancel 2>/dev/null || exit 0
fi
pane_safe || exit 0
eligible || exit 0
PROMPT='[silent] [gateway:silent] Cache keep-warm: no task, no occasion. This turn only refreshes the prompt cache. Answer with one short terminal line, no app reply, no tools. If something urgent stands out, you may act.'
tmux send-keys -t "$PANE_ID" -l "$PROMPT" 2>/dev/null || { log "skip: prompt injection failed"; exit 0; }
sleep 1
# A cut, user turn or dialog can appear during the delay; Enter could confirm the wrong input.
eligible && pane_safe "$PROMPT" || { log "skip: changed during injection; Enter withheld"; exit 0; }
tmux send-keys -t "$PANE_ID" Enter 2>/dev/null || { log "skip: Enter failed"; exit 0; }
log "sent: cache keep-warm ($(basename "$SESSION_FILE"), threshold=${EMBERVY_CACHE_PING_MINUTES}m)"
