#!/bin/bash
# Monitors session context size and triggers warnings or cutovers.
# Tool results can fill the window before usage is reported, so errors and byte counts provide fallbacks.
# A transcript frozen at the context limit must not be mistaken for a dead process.

set -u

HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME

ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/curl-auth.sh"
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
LOG="$EMBERVY_HOME/logs/context_watchdog.log"
STATE_DIR="$EMBERVY_HOME/state"
WARNING_FILE="$STATE_DIR/context_warning"
STATE_FILE="$STATE_DIR/watchdog_state.json"
SESSION_DIR="${CLAUDE_PROJECT_DIR:-$HOME/.claude/projects/$(echo "$EMBERVY_HOME" | tr / -)}"
APP_HOST="${EMBERVY_APP_HOST:-127.0.0.1}"
APP_PORT="${EMBERVY_APP_PORT:-3030}"
CLAUDE_PROCESS_PATTERN="${CLAUDE_PROCESS_PATTERN:-claude.*server:}"

WARN_TOKENS="${WATCHDOG_WARN_TOKENS:-800000}"
CUT_TOKENS="${WATCHDOG_CUT_TOKENS:-900000}"
CHECK_INTERVAL="${WATCHDOG_CHECK_INTERVAL:-60}"

CONTEXT_LIMIT_MARKERS="${WATCHDOG_CONTEXT_LIMIT_MARKERS:-prompt is too long|context_length_exceeded|maximum context length|exceeds.*context}"

BYTE_FALLBACK_BYTES_PER_TOKEN="${WATCHDOG_BYTE_FALLBACK_BYTES_PER_TOKEN:-6}"

# Smaller context windows must not inherit generic thresholds intended for larger windows.
# Each threshold prefers engine-specific configuration, then eligible generic configuration, the engine file, the service environment and the default.
HOUSE_CONFIG_FILE="$EMBERVY_HOME/.env"
[ -f "$HOUSE_CONFIG_FILE" ] || HOUSE_CONFIG_FILE="$EMBERVY_HOME/Claude/app/.env"
ENGINE_THRESHOLDS_FILE="$STATE_DIR/watchdog_engine_thresholds"
ENV_WARN_TOKENS="${WATCHDOG_WARN_TOKENS:-}"
ENV_CUT_TOKENS="${WATCHDOG_CUT_TOKENS:-}"
THRESHOLD_ENGINE=""
THRESHOLD_SOURCES=""

valid_tokens() { [[ "${1:-}" =~ ^[1-9][0-9]{0,9}$ ]]; }

declare -A HOUSE_CONFIG=()
load_house_config() {
  local line key val
  HOUSE_CONFIG=()
  [ -r "$HOUSE_CONFIG_FILE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?(WATCHDOG_[A-Z0-9_]+)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    val="${BASH_REMATCH[3]}"
    val="${val%%[[:space:]]#*}"
    val="${val#"${val%%[![:space:]]*}"}"
    val="${val%"${val##*[![:space:]]}"}"
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then
      val="${BASH_REMATCH[1]}"
    fi
    HOUSE_CONFIG[$key]="$val"
  done < "$HOUSE_CONFIG_FILE"
}

pick_threshold() {
  local kind="$1" engine="$2" generic="$3" file_value="$4" env_value="$5" default="$6" key
  if [ -n "$engine" ]; then
    key="WATCHDOG_${kind}_TOKENS_${engine^^}"
    if valid_tokens "${HOUSE_CONFIG[$key]:-}"; then PICKED="${HOUSE_CONFIG[$key]}"; PICKED_FROM="$key"; return; fi
  fi
  if [ "$generic" = 1 ]; then
    key="WATCHDOG_${kind}_TOKENS"
    if valid_tokens "${HOUSE_CONFIG[$key]:-}"; then PICKED="${HOUSE_CONFIG[$key]}"; PICKED_FROM="$key"; return; fi
  fi
  if valid_tokens "$file_value"; then PICKED="$file_value"; PICKED_FROM="engine file"; return; fi
  if valid_tokens "$env_value"; then PICKED="$env_value"; PICKED_FROM="service environment"; return; fi
  PICKED="$default"; PICKED_FROM="default"
}

resolve_thresholds() {
  local fw="" fc="" engine="" window="" window_tokens="" rest="" generic=0 w c w_from
  THRESHOLD_WINDOW=null
  load_house_config
  if [ -f "$ENGINE_THRESHOLDS_FILE" ]; then
    { read -r fw fc rest; read -r engine window window_tokens rest; } < "$ENGINE_THRESHOLDS_FILE" 2>/dev/null
    [[ "$window_tokens" =~ ^[1-9][0-9]*$ ]] && THRESHOLD_WINDOW="$window_tokens"
    [[ "$engine" =~ ^[A-Za-z0-9_]+$ ]] || engine=""
    [ -n "$engine" ] && [ "$window" = generic ] && generic=1
  else
    generic=1
  fi
  pick_threshold WARN "$engine" "$generic" "$fw" "$ENV_WARN_TOKENS" 800000
  w="$PICKED"; w_from="$PICKED_FROM"
  pick_threshold CUT "$engine" "$generic" "$fc" "$ENV_CUT_TOKENS" 900000
  c="$PICKED"
  CUT_TOKENS="$c"
  WARN_TOKENS=$(( w < c ? w : c ))
  THRESHOLD_ENGINE="${engine:-unknown}"
  THRESHOLD_SOURCES="warn from $w_from, cut from $PICKED_FROM"
}

# Is the claude process for this loop still alive?
claude_process_alive() {
  embervy_house_pids -f "$CLAUDE_PROCESS_PATTERN" >/dev/null 2>&1
}

# Quoted errors in messages or tool output must not trigger a cut.
context_limit_hit() {
  local jsonl="$1"
  [ -f "$jsonl" ] || return 1
  tail -500 "$jsonl" 2>/dev/null | python3 -c '
import json, re, sys
markers = re.compile(sys.argv[1], re.I)
def texts(e):
    if e.get("type") == "assistant" and e.get("isApiErrorMessage"):
        content = (e.get("message") or {}).get("content")
        if isinstance(content, str):
            yield content
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict):
                yield str(block.get("text") or "")
    elif e.get("type") == "system" and e.get("subtype") in ("api_error", "error"):
        yield json.dumps(e.get("error")) if e.get("error") is not None else ""
        yield str(e.get("message") or "")
for line in sys.stdin:
    try:
        e = json.loads(line)
    except ValueError:
        continue
    if isinstance(e, dict) and any(markers.search(t) for t in texts(e)):
        sys.exit(0)
sys.exit(1)
' "$CONTEXT_LIMIT_MARKERS"
}

decide_action() {
  local jsonl="$1" stale="${2:-0}"
  local bytes tokens percent byte_bound tail_bytes

  bytes=$(stat -c%s "$jsonl" 2>/dev/null || echo 0)
  read -r tokens tail_bytes < <(python3 - "$jsonl" "${USAGE_OFFSET_FILE:-}" <<'PY'
import hashlib, json, os, sys, tempfile
path, cache = sys.argv[1:]
last, offset, usage_offset = 0, 0, 0
with open(path, 'rb') as source:
    stat = os.fstat(source.fileno())
    identity = [os.path.realpath(path), stat.st_dev, stat.st_ino]
    def anchor(at):
        source.seek(max(0, at - 256))
        return hashlib.sha256(source.read(min(256, at))).hexdigest()
    try:
        with open(cache) as state:
            saved = json.load(state)
        at = saved['offset']
        if (saved['identity'] == identity and isinstance(at, int) and 0 <= at <= stat.st_size
                and isinstance(saved['tokens'], (int, float)) and saved['tokens'] >= 0
                and isinstance(saved['usage_offset'], int) and 0 <= saved['usage_offset'] <= stat.st_size
                and saved['size'] <= stat.st_size
                and (stat.st_size > saved['size'] or saved['mtime_ns'] == stat.st_mtime_ns)
                and saved['anchor'] == anchor(at)):
            offset, usage_offset, last = at, saved['usage_offset'], saved['tokens']
    except (OSError, ValueError, KeyError, TypeError):
        pass
    source.seek(offset)
    scanned = 0
    while True:
        line = source.readline()
        if not line:
            break
        scanned += len(line)
        # Re-read an unfinished record next time, while preserving the full reader's current verdict.
        complete = line.endswith(b'\n')
        if complete:
            offset = source.tell()
        try:
            e = json.loads(line)
            if e.get('type') == 'assistant':
                u = e.get('message', {}).get('usage')
                if isinstance(u, dict):
                    last = sum(u.get(k, 0) or 0 for k in ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'))
                    usage_offset = source.tell()
        except (ValueError, AttributeError, TypeError):
            pass
        if not complete:
            break
    source.seek(0, os.SEEK_END)
    size = source.tell()
    if cache:
        state = dict(identity=identity, offset=offset, usage_offset=usage_offset, tokens=last,
                     size=size, mtime_ns=stat.st_mtime_ns, anchor=anchor(offset), scanned_bytes=scanned)
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', dir=os.path.dirname(cache), delete=False) as out:
                temp = out.name
                json.dump(state, out)
            os.replace(temp, cache)
        except OSError:
            pass
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)
print(last, size - usage_offset)
PY
  )
  tokens=${tokens:-0}
  percent=$((tokens * 100 / CUT_TOKENS))

  if context_limit_hit "$jsonl"; then
    echo "cut $tokens $percent $bytes context-limit error line in JSONL"
    return 0
  fi

  if [ "$stale" = "1" ]; then
    echo "stale $tokens $percent $bytes process not alive"
    return 0
  fi

  # Counting bytes already reflected in usage would inflate the estimate with images and history.
  byte_bound=$(((CUT_TOKENS - tokens) * BYTE_FALLBACK_BYTES_PER_TOKEN))
  if [ "${tail_bytes:-0}" -ge "$byte_bound" ] && [ "$tokens" -lt "$CUT_TOKENS" ]; then
    echo "cut $tokens $percent $bytes byte-size fallback (token count under-read)"
    return 0
  fi

  if [ "$tokens" -ge "$CUT_TOKENS" ]; then
    echo "cut $tokens $percent $bytes token threshold"
  elif [ "$tokens" -ge "$WARN_TOKENS" ]; then
    echo "warn $tokens $percent $bytes token threshold"
  else
    echo "none $tokens $percent $bytes below thresholds"
  fi
}

if [ "${1:-}" = "--decide" ]; then
  decide_action "${2:-}" "${3:-0}"
  exit 0
fi
if [ "${1:-}" = "--decide-cached" ]; then
  USAGE_OFFSET_FILE="${4:?cache path required}"
  decide_action "${2:-}" "${3:-0}"
  exit 0
fi
if [ "${1:-}" = "--check-alive" ]; then
  if claude_process_alive; then echo 1; else echo 0; fi
  exit 0
fi
if [ "${1:-}" = "--thresholds" ]; then
  resolve_thresholds
  echo "$WARN_TOKENS $CUT_TOKENS"
  exit 0
fi

LAST_WARN_TS=""
LAST_CUT_TS=""

mkdir -p "$STATE_DIR" "$EMBERVY_HOME/logs"
USAGE_OFFSET_FILE="$STATE_DIR/watchdog_usage_offset.json"

# Parsing configuration as data prevents shell execution and failures on unset variables.
embervy_env_load "$EMBERVY_HOME/.env" "$EMBERVY_HOME/Claude/app/.env"


LAST_SESSION=""
CUT_RETRY_SECONDS="${WATCHDOG_CUT_RETRY_SECONDS:-300}"
FAILED_CUT_SESSION=""
CUT_RETRY_AT=0

log() {
  echo "$(date -Iseconds) $*" >> "$LOG"
}

notify_app() {
  local text="$1"
  local id ts payload code
  id=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || date +%s%N)
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
  payload=$(printf '{"id":"%s","text":%s,"ts":"%s","type":"send"}' \
    "$id" \
    "$(printf '%s' "$text" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
    "$ts")
  code=$(embervy_curl_bearer "${INTERNAL_API_TOKEN:-}" -s -m 5 -o /dev/null -w "%{http_code}" \
    -X POST "http://${APP_HOST}:${APP_PORT}/api/internal/broadcast" \
    -H "Content-Type: application/json" -d "$payload" 2>/dev/null || echo "ERR")
  if [ "$code" != "200" ]; then
    log "notify_app FAILED (code=$code) — retrying in 2s"
    sleep 2
    code=$(embervy_curl_bearer "${INTERNAL_API_TOKEN:-}" -s -m 5 -o /dev/null -w "%{http_code}" \
      -X POST "http://${APP_HOST}:${APP_PORT}/api/internal/broadcast" \
      -H "Content-Type: application/json" -d "$payload" 2>/dev/null || echo "ERR")
    if [ "$code" != "200" ]; then
      log "notify_app retry FAILED (code=$code)"
      return 1
    fi
    log "notify_app retry OK"
  else
    log "notify_app OK — text=$(printf '%s' "$text" | head -c 80)"
  fi
  return 0
}

resolve_thresholds
log "=== context_watchdog start (warn=$WARN_TOKENS cut=$CUT_TOKENS interval=${CHECK_INTERVAL}s; engine $THRESHOLD_ENGINE, $THRESHOLD_SOURCES) ==="

write_state() {
  python3 - <<PY
import json, os
state = {
    "last_check_ts": "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)",
    "tokens": ${TOKENS:-0},
    "percent": ${PERCENT:-0},
    "window": json.loads("${THRESHOLD_WINDOW:-null}"),
    "warn_tokens": ${WARN_TOKENS},
    "cut_tokens": ${CUT_TOKENS},
    "session_file": "$(basename "${SESSION_FILE:-}")",
    "warn_active": $( [ -f "$WARNING_FILE" ] && echo "True" || echo "False" ),
    "last_warn_ts": "${LAST_WARN_TS}",
    "last_cut_ts": "${LAST_CUT_TS}",
    "pid": $$,
}
tmp = "$STATE_FILE.tmp"
with open(tmp, "w") as f:
    json.dump(state, f, indent=2)
os.replace(tmp, "$STATE_FILE")
PY
}

while true; do
  PREV_THRESHOLDS="warn=$WARN_TOKENS cut=$CUT_TOKENS"
  resolve_thresholds
  if [ "$PREV_THRESHOLDS" != "warn=$WARN_TOKENS cut=$CUT_TOKENS" ]; then
    log "thresholds changed: $PREV_THRESHOLDS → warn=$WARN_TOKENS cut=$CUT_TOKENS (engine $THRESHOLD_ENGINE, $THRESHOLD_SOURCES)"
  fi

  # Headless runs share this folder and must not replace the live session being measured.
  SESSION_FILE=$(python3 "$EMBERVY_HOME/Claude/scripts/latest_main_session.py" "$SESSION_DIR" 2>/dev/null)

  if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
    SESSION_FILE=""
    TOKENS=0
    PERCENT=0
    write_state
    sleep "$CHECK_INTERVAL"
    continue
  fi

  if [ "$SESSION_FILE" != "$LAST_SESSION" ]; then
    if [ -f "$WARNING_FILE" ]; then
      rm -f "$WARNING_FILE"
      log "New session detected — cleared warning file. Now watching: $(basename "$SESSION_FILE")"
    else
      log "Now watching: $(basename "$SESSION_FILE")"
    fi
    LAST_SESSION="$SESSION_FILE"
  fi

  STALE=0
  claude_process_alive || STALE=1

  DECISION=$(decide_action "$SESSION_FILE" "$STALE")
  read -r ACTION TOKENS PERCENT BYTES REASON <<< "$DECISION"

  case "$ACTION" in
    stale)
      log "stale session ($(basename "$SESSION_FILE"), ${REASON}, ${PERCENT}%) — warn/cut suppressed"
      write_state
      sleep "$CHECK_INTERVAL"
      continue
      ;;
    cut)
      # Stale usage must not trigger another cut before the replacement session is measured.
      LAST_CUT_SESSION_FILE="$STATE_DIR/last_cut_session"
      if [ -f "$LAST_CUT_SESSION_FILE" ] \
         && [ "$(cat "$LAST_CUT_SESSION_FILE" 2>/dev/null)" = "$(basename "$SESSION_FILE")" ]; then
        log "post-cut grace: $(basename "$SESSION_FILE") already cut — waiting for the new session"
        write_state
        sleep "$CHECK_INTERVAL"
        continue
      fi
      # Failed cuts must release the grace marker so retries remain possible without repeating every notice.
      CUT_BASE="$(basename "$SESSION_FILE")"
      if [ "$CUT_BASE" = "$FAILED_CUT_SESSION" ] && [ "$(date +%s)" -lt "$CUT_RETRY_AT" ]; then
        log "cut failed before for $CUT_BASE — next try at $(date -d "@$CUT_RETRY_AT" +%H:%M:%S)"
        write_state
        sleep "$CHECK_INTERVAL"
        continue
      fi
      log "CUT threshold hit: ${TOKENS} tokens (${PERCENT}% of cut threshold, ${BYTES} bytes) — ${REASON}. Triggering cutoff.sh"
      printf '%s' "$CUT_BASE" > "$LAST_CUT_SESSION_FILE"
      LAST_CUT_TS=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
      [ "$CUT_BASE" = "$FAILED_CUT_SESSION" ] || notify_app "Cutover starting: ${PERCENT}% context. Bridge + RAG + respawn. ~1 min downtime."
      write_state
      # A separate session lets the cutover survive a watchdog service stop.
      setsid "$EMBERVY_HOME/Claude/scripts/cutoff.sh" >> "$EMBERVY_HOME/logs/cutoff.log" 2>&1 < /dev/null &
      CUT_PID=$!
      wait "$CUT_PID"; CUT_RC=$?
      if [ "$CUT_RC" -ne 0 ]; then
        [ "$(cat "$LAST_CUT_SESSION_FILE" 2>/dev/null)" = "$CUT_BASE" ] && rm -f "$LAST_CUT_SESSION_FILE"
        CUT_RETRY_AT=$(( $(date +%s) + CUT_RETRY_SECONDS ))
        log "CUT FAILED (cutoff.sh rc=$CUT_RC) for $CUT_BASE — grace lifted, next try in ${CUT_RETRY_SECONDS}s (see logs/cutoff.log)"
        if [ "$CUT_BASE" != "$FAILED_CUT_SESSION" ]; then
          notify_app "Cutover failed (code $CUT_RC): the session keeps running. Trying again every $((CUT_RETRY_SECONDS / 60)) minutes; details in logs/cutoff.log."
          FAILED_CUT_SESSION="$CUT_BASE"
        fi
      else
        sleep 30
      fi
      ;;
    warn)
      if [ ! -f "$WARNING_FILE" ]; then
        LAST_WARN_TS=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
        notify_app "Context at ${PERCENT}%. Auto-cutover at ${CUT_TOKENS} tokens. Time to flush anything important to memory."
        cat > "$WARNING_FILE" <<EOF
⚠️ Context at ${PERCENT}% (${TOKENS} tokens / ~${BYTES} bytes)

The session is approaching the cut threshold. The watchdog will trigger a
cutover automatically — bridge + RAG export + clean restart.

If you have anything important to persist into memory (or any other
substrate-independent store), now is the moment. After the cut the live
context is gone; only the bridge (last 40 turns) and the RAG chunks remain.
EOF
        log "WARN threshold hit: ${TOKENS} tokens (${PERCENT}%). Warning file written."
      fi
      ;;
    none) : ;;
  esac

  write_state
  sleep "$CHECK_INTERVAL"
done
