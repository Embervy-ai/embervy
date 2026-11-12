#!/bin/bash
# Monitors runtime context usage and requests a cut at the configured threshold.

set -u

. "$(dirname "$0")/brain-env.sh"
. "$(dirname "$0")/house-owner.sh"

LOG="$BRAIN_LOG_DIR/brain-watchdog.log"
STATE_DIR="$BRAIN_STATE_DIR"
WARNING_FILE="$BRAIN_CONTEXT_WARNING_FILE"
WATCH_STATE_FILE="$STATE_DIR/watchdog_state.json"
CHECK_INTERVAL="${WATCHDOG_CHECK_INTERVAL:-60}"
CONTEXT_LIMIT_MARKERS="${WATCHDOG_CONTEXT_LIMIT_MARKERS:-prompt is too long|context_length_exceeded|maximum context length|exceeds.*context}"

decide_action() {
  local state_json="$1" stale="${2:-0}"
  python3 - "$state_json" "$stale" "${WATCHDOG_WARN_TOKENS:-}" "${WATCHDOG_CUT_TOKENS:-}" "$BRAIN_LOG_DIR" "$CONTEXT_LIMIT_MARKERS" <<'PY'
import json, os, re, sys
path, stale, warn_env, cut_env, log_dir, markers = sys.argv[1:7]
try:
    s = json.load(open(path))
except Exception:
    print("none 0 0 0 0 - no state file"); raise SystemExit(0)
tokens = int(s.get("tokens") or 0)
cut = int(cut_env or s.get("cut_tokens") or 900000)
warn = int(warn_env or s.get("warn_tokens") or 800000)
pid = int(s.get("pid") or 0)
sid = str(s.get("session_id") or "-")
pct = tokens * 100 // cut if cut else 0
# Only a failed turn's own error text counts. The log also carries the inlet,
# the bridge, tool input and output, and messages, and any of them may quote
# the phrase without indicating a current context-limit error.
ERROR_EVENTS = {"turn_error", "self_turn_failed"}
def limit_hit():
    log = os.path.join(log_dir, f"session-{sid}.jsonl")
    try:
        with open(log, "rb") as fh:
            fh.seek(0, 2); size = fh.tell(); fh.seek(max(0, size - 200000))
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return False
    for line in tail.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue  # the cut-off first line of the tail
        if isinstance(event, dict) and event.get("type") in ERROR_EVENTS \
                and re.search(markers, str(event.get("error") or ""), re.I):
            return True
    return False
if limit_hit():
    print(f"cut {tokens} {pct} {cut} {pid} {sid} context-limit error in event log"); raise SystemExit(0)
if stale == "1":
    print(f"stale {tokens} {pct} {cut} {pid} {sid} process not alive"); raise SystemExit(0)
if tokens >= cut:
    print(f"cut {tokens} {pct} {cut} {pid} {sid} token threshold")
elif tokens >= warn:
    print(f"warn {tokens} {pct} {cut} {pid} {sid} token threshold")
else:
    print(f"none {tokens} {pct} {cut} {pid} {sid} below thresholds")
PY
}

state_pid() {
  python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("pid") or 0))' "$1" 2>/dev/null || echo 0
}

# Unreaped zombies still answer kill -0.
brain_alive() {
  local pid="$1"
  [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null \
    && [ "$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)" != "Z" ] && embervy_owns_pid "$pid"
}

if [ "${1:-}" = "--decide" ]; then
  decide_action "${2:-}" "${3:-0}"
  exit 0
fi
if [ "${1:-}" = "--check-alive" ]; then
  if brain_alive "${2:-0}"; then echo 1; else echo 0; fi
  exit 0
fi

mkdir -p "$STATE_DIR" "$BRAIN_LOG_DIR"
log() { echo "$(date -Iseconds) $*" >> "$LOG"; }

LAST_WARN_TS=""
LAST_CUT_TS=""
LAST_SESSION=""

write_state() {
  python3 - "$WATCH_STATE_FILE" "${TOKENS:-0}" "${CUT:-0}" "${SESSION:-}" "$LAST_WARN_TS" "$LAST_CUT_TS" "$$" "$WARNING_FILE" "$BRAIN_CONTEXT_STATE_FILE" <<'PY'
import json, math, os, sys, datetime
path, tokens, cut, sid, lw, lc, pid, warning, context = sys.argv[1:10]
try:
    window = json.load(open(context)).get("window")
except (OSError, ValueError, AttributeError):
    window = None
if type(window) not in (int, float) or not math.isfinite(window) or window <= 0:
    window = None
# The compatibility record measures capacity, not distance to the cut threshold.
pct = math.floor(int(tokens) * 100 / window) if window else None
state = {"last_check_ts": datetime.datetime.now(datetime.timezone.utc).isoformat(), "tokens": int(tokens), "window": window, "percent": pct,
         "cut_tokens": int(cut), "session_id": sid, "warn_active": os.path.exists(warning), "last_warn_ts": lw,
         "last_cut_ts": lc, "pid": int(pid)}
tmp = path + ".tmp"
with open(tmp, "w") as f: json.dump(state, f, indent=2)
os.replace(tmp, path)
PY
}

log "=== brain-watchdog start (interval=${CHECK_INTERVAL}s, state=$BRAIN_CONTEXT_STATE_FILE) ==="

while true; do
  if [ ! -f "$BRAIN_CONTEXT_STATE_FILE" ]; then
    TOKENS=0; PERCENT=0; CUT=0; SESSION=""
    write_state
    sleep "$CHECK_INTERVAL"; continue
  fi
  PID=$(state_pid "$BRAIN_CONTEXT_STATE_FILE")
  STALE=0
  brain_alive "$PID" || STALE=1
  read -r ACTION TOKENS PERCENT CUT PID SESSION REASON <<< "$(decide_action "$BRAIN_CONTEXT_STATE_FILE" "$STALE")"

  if [ "$SESSION" != "$LAST_SESSION" ]; then
    if [ -f "$WARNING_FILE" ]; then rm -f "$WARNING_FILE"; log "new session $SESSION — cleared warning file"; else log "now watching session $SESSION"; fi
    LAST_SESSION="$SESSION"
  fi

  case "$ACTION" in
    stale)
      log "stale ($SESSION, $REASON, ${PERCENT}%) — warn/cut suppressed"
      ;;
    cut)
      # Session-based suppression prevents duplicate cuts regardless of shutdown duration.
      if [ -f "$STATE_DIR/last_cut_session" ] && [ "$(cat "$STATE_DIR/last_cut_session" 2>/dev/null)" = "$SESSION" ]; then
        log "post-cut grace: $SESSION already cut — waiting for the new session"
      else
        log "CUT: ${TOKENS} tokens (${PERCENT}% of ${CUT}) — ${REASON}. Running brain-cutoff.sh"
        printf '%s' "$SESSION" > "$STATE_DIR/last_cut_session"
        LAST_CUT_TS=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
        if [ "${BRAIN_QUICK_CUT:-off}" != "on" ]; then
          brain_notify_app "$(brain_text watch.cut "$PERCENT")"
        fi
        setsid "$(dirname "$0")/brain-cutoff.sh" > /dev/null 2>&1 < /dev/null &
      fi
      ;;
    warn)
      if [ ! -f "$WARNING_FILE" ]; then
        LAST_WARN_TS=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
        # Atomic replacement prevents readers from seeing an incomplete warning.
        brain_text watch.warning "$PERCENT" "$TOKENS" "$CUT" > "$WARNING_FILE.tmp.$$" && mv -f "$WARNING_FILE.tmp.$$" "$WARNING_FILE"
        brain_notify_app "$(brain_text watch.notice "$PERCENT" "$CUT")"
        log "WARN: ${TOKENS} tokens (${PERCENT}%) — warning file written"
      fi
      ;;
    none) : ;;
  esac
  write_state
  sleep "$CHECK_INTERVAL"
done
