#!/bin/bash
# A loop started from an existing session must not pass its marker to helpers.
unset EMBERVY_MAIN_BRIDGE_TOKEN
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME
# A systemd start lacks the interactive PATH; add where bun and claude are installed.
export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin"
# Restarts the CLI and preserves its transcript and wake bridge between sessions.
# Repeated crashes start fresh to avoid resuming broken state forever.

. "$(dirname -- "${BASH_SOURCE[0]}")/loop-dialog.sh" || exit 1
. "$(dirname -- "${BASH_SOURCE[0]}")/claude-signin-present.sh" || exit 1
ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/curl-auth.sh"
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
tmux() { embervy_tmux "$@"; }
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
embervy_env_load -x "$EMBERVY_HOME/Claude/app/.env"
unset EMBERVY_MAIN_BRIDGE_TOKEN
TMUX_SESSION="${EMBERVY_TMUX_SESSION:-embervy}"
APP_HOST="${EMBERVY_APP_HOST:-127.0.0.1}"
APP_PORT="${EMBERVY_APP_PORT:-3030}"

if [ -n "${TMUX:-}" ]; then
  if [ "$(basename -- "${TMUX%%,*}")" != "$(embervy_tmux_socket)" ]; then
    unset TMUX TMUX_PANE
  fi
fi
if [ -z "${TMUX:-}" ]; then
  if [ -t 1 ]; then
    if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      active=""
      # Check every window: a shell label can hide an agent without job control.
      panes=$(tmux list-panes -s -t "$TMUX_SESSION" -F '#{pane_id} #{pane_current_command}' 2>/dev/null) || exit 1
      while read -r pane command; do
        [ -n "$pane" ] || continue
        if embervy_pane_has_claude "$pane"; then active=1; break; fi
        case "$command" in
          ''|bash|sh|zsh|fish) ;;
          *) active=1; break ;;
        esac
      done <<< "$panes"
      if [ -n "$active" ]; then
        embervy_tmux attach -t "=$TMUX_SESSION"
        exit $?
      else
        tmux kill-session -t "$TMUX_SESSION"
      fi
    fi
    embervy_tmux new-session -s "$TMUX_SESSION" -c "$EMBERVY_HOME" "$0 $*"
    exit $?
  else
    if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      tmux new-session -d -s "$TMUX_SESSION" -c "$EMBERVY_HOME" "$0 $*" || exit 1
    fi
    while tmux has-session -t "$TMUX_SESSION" 2>/dev/null; do sleep 10; done
    exit 0
  fi
fi

cd "$EMBERVY_HOME"

# Only processes whose cwd lies under this install's EMBERVY_HOME: other agents
# on the same server must never be touched by this loop.
is_install_cwd() {
  embervy_owns_pid "$1"
}

for pid in $(pgrep -f "bun.*${EMBERVY_HOME}/app/mcp\.ts"); do
  is_install_cwd "$pid" || continue
  echo "killing orphaned MCP process (pid=$pid)"
  kill "$pid" 2>/dev/null
done

APP_SERVICE="${EMBERVY_APP_SERVICE:-$(embervy_unit_name app)}"
app_service_pid=$(systemctl show -p MainPID "$APP_SERVICE" 2>/dev/null | cut -d= -f2)
for pid in $(pgrep -f 'bun.*server\.ts'); do
  [ "$pid" = "$app_service_pid" ] && continue
  is_install_cwd "$pid" || continue
  echo "killing zombie server.ts (pid=$pid)"
  kill -9 "$pid" 2>/dev/null
done

sleep 1

for pid in $(pgrep -f 'claude.*server:'); do
  is_install_cwd "$pid" || continue
  echo "killing existing Claude session (pid=$pid) to prevent duplicates"
  kill "$pid" 2>/dev/null
done
sleep 1

BRIDGE="$EMBERVY_HOME/state/wake_bridge.md"
LOG="$EMBERVY_HOME/logs/claude-loop.log"
mkdir -p "$EMBERVY_HOME/logs" "$EMBERVY_HOME/state"

# Only the main session's bridge may carry the app inbox position across a
# restart: every start gets a fresh token, given to that one process and deleted
# when the session ends.
MAIN_BRIDGE_TOKEN_FILE="$EMBERVY_HOME/state/main-bridge-token"
clear_main_bridge_token() {
  rm -f "$MAIN_BRIDGE_TOKEN_FILE" "$MAIN_BRIDGE_TOKEN_FILE.tmp"
}
new_main_bridge_token() {
  local token
  token="$(cat /proc/sys/kernel/random/uuid 2>/dev/null)"
  [ -n "$token" ] || token="$(date +%s%N)-$$-$RANDOM$RANDOM"
  # Private whatever umask started the loop: a fresh temporary file, created 0600.
  rm -f "$MAIN_BRIDGE_TOKEN_FILE.tmp"
  ( umask 077 && printf '%s\n' "$token" > "$MAIN_BRIDGE_TOKEN_FILE.tmp" ) \
    && mv -f "$MAIN_BRIDGE_TOKEN_FILE.tmp" "$MAIN_BRIDGE_TOKEN_FILE" \
    && printf '%s' "$token"
}
clear_main_bridge_token

restart_notice_effort() {
  python3 -c 'import json, os; print(json.load(open(os.path.expanduser("~/.claude/settings.json"))).get("effortLevel", "default"))' 2>/dev/null || printf '?\n'
}

restart_notice_mcps() {
  if [ "${EMBERVY_MCP_LIST+x}" = x ]; then
    printf '%s\n' "$EMBERVY_MCP_LIST"
  else
    python3 -c 'import json, sys; print(",".join(sorted(json.load(open(sys.argv[1]))["mcpServers"].keys())))' "$EMBERVY_HOME/.mcp.json" 2>/dev/null || printf '?\n'
  fi
}

notify_runtime_swap() {
  local rc="$1" reason
  case "$rc" in
    0)   reason="Clean /exit" ;;
    143) reason="SIGTERM (Watchdog/Cutover)" ;;
    137) reason="SIGKILL (OOM?)" ;;
    *)   reason="Crash (rc=$rc)" ;;
  esac

  local build effort mcps
  build=$(claude --version 2>/dev/null | head -1 || echo "?")
  effort=$(restart_notice_effort)
  mcps=$(restart_notice_mcps)

  local text
  text=$(printf 'Runtime restarted.\nReason: %s\nBuild: %s\nEffort: %s\nMCPs: %s' \
    "$reason" "$build" "$effort" "$mcps")

  embervy_curl_bearer "${INTERNAL_API_TOKEN:-}" -s --max-time 5 -X POST "http://${APP_HOST}:${APP_PORT}/api/internal/broadcast" \
    -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"role":"system","text":sys.argv[1],"ts":sys.argv[2]}))' "$text" "$(date -Iseconds)")" \
    >> "$LOG" 2>&1 \
    && echo "$(date -Iseconds) loop: notify_runtime_swap fired (rc=$rc)" >> "$LOG" \
    || echo "$(date -Iseconds) loop: notify_runtime_swap curl failed" >> "$LOG"
}

loop_restart_pause() {
  # Detached tmux panes have a tty too; only an attached client can use the stop window.
  if [ "$1" -eq 0 ] && [ "$2" -eq 1 ] && [ -t 1 ] \
    && { [ -z "${TMUX:-}" ] || [ "$(tmux display-message -p -t "${TMUX_PANE:-$TMUX_SESSION}" '#{session_attached}' 2>/dev/null)" -gt 0 ]; }; then
    printf '%s\n' 'exported; press Ctrl-C within 15 seconds to stop here, otherwise a new session starts'
    sleep 15
  else
    sleep 2
  fi
}

LOOP_ITER=0

INITIAL_MODE="fresh"
PASS_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --continue|-c) INITIAL_MODE="continue" ;;
    *) PASS_ARGS+=("$arg") ;;
  esac
done
MODE="$INITIAL_MODE"

# Reloading the loop must preserve whether the next session resumes or starts fresh.
if [ -n "${LOOP_RESUME_MODE:-}" ]; then
  MODE="$LOOP_RESUME_MODE"
  echo "$(date -Iseconds) loop: self-reload resumed (mode=$MODE)" >> "$LOG"
  unset LOOP_RESUME_MODE
fi

LOOP_SELF_HASH="$(md5sum "$0" 2>/dev/null | awk '{print $1}')"

CRASH_TIMES=()

# Compaction is the user's choice in the installer (default off): then the
# watchdog cuts near the limit and the bridge carries the last turns verbatim.
if [ "${EMBERVY_AUTO_COMPACT:-off}" != "on" ]; then
  export DISABLE_AUTO_COMPACT=true
else
  unset DISABLE_AUTO_COMPACT
  echo "$(date -Iseconds) loop: EMBERVY_AUTO_COMPACT=on — the harness may summarize the window; the watchdog still cuts as a backstop" >> "$LOG"
fi

# The CLI's registry can impose a smaller window; its hard limit must stay beyond the watchdog cut.
export DISABLE_COMPACT=true
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000
export CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE=950000

# Prompt suggestions can auto-submit invented user prompts; this variable is
# checked before the remote flag and cannot be overridden by it.
export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false

# MCP subprocesses need the app's tokens. The .env is read as data, never run.
embervy_env_load -x "$EMBERVY_HOME/Claude/app/.env"
unset EMBERVY_MAIN_BRIDGE_TOKEN

# Headless runs share the transcript folder, so the newest file need not be the main session.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$HOME/.claude/projects/$(echo "$EMBERVY_HOME" | tr / -)}"
if [ "$INITIAL_MODE" = "fresh" ] && [ ! -s "$BRIDGE" ]; then
  LATEST_JSONL=$(python3 "$EMBERVY_HOME/Claude/scripts/latest_main_session.py" "$PROJECT_DIR" 2>/dev/null)
  if [ -n "$LATEST_JSONL" ] && [ -f "$LATEST_JSONL" ] \
    && SESSION_FILE="$LATEST_JSONL" python3 "$EMBERVY_HOME/Claude/scripts/extract_bridge.py" --has-messages 2>>"$LOG"; then
    echo "$(date -Iseconds) loop: no bridge but JSONL exists — building on-demand from $(basename "$LATEST_JSONL")" >> "$LOG"
    SESSION_FILE="$LATEST_JSONL" python3 "$EMBERVY_HOME/Claude/scripts/extract_bridge.py" --output "$BRIDGE" 2>>"$LOG" \
      || echo "$(date -Iseconds) loop: on-demand bridge build failed" >> "$LOG"
  fi
fi

claude_signin_warning "${EMBERVY_BACKEND:-claude}" | tee -a "$LOG"

BACKEND_MODEL_ARGS=()
RUNNING_ENGINE=claude
ENGINE_WINDOW=generic
case "${EMBERVY_BACKEND:-claude}" in
  glm)
    if [ -n "${GLM_CODE_KEY:-}" ]; then
      RUNNING_ENGINE=glm
      export ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
      export ANTHROPIC_AUTH_TOKEN="$GLM_CODE_KEY"
      unset ANTHROPIC_API_KEY   # Both authentication keys together cause a 401.
      export API_TIMEOUT_MS="3000000"
      BACKEND_MODEL_ARGS=(--model "${EMBERVY_GLM_MODEL:-glm-5.2[1m]}")
      echo "$(date -Iseconds) loop: engine GLM (${EMBERVY_GLM_MODEL:-glm-5.2[1m]}, z.ai)" >> "$LOG"
    else
      echo "$(date -Iseconds) loop: EMBERVY_BACKEND=glm but GLM_CODE_KEY missing — falling back to claude" >> "$LOG"
    fi
    ;;
  kimi)
    if [ -n "${KIMI_CODE_KEY:-}" ]; then
      export ANTHROPIC_BASE_URL="${EMBERVY_KIMI_BASE:-https://api.kimi.com/coding}"
      export ANTHROPIC_AUTH_TOKEN="$KIMI_CODE_KEY"
      unset ANTHROPIC_API_KEY
      export API_TIMEOUT_MS="3000000"
      # A smaller model window needs lower watchdog thresholds or it reaches its hard limit before a cut.
      export CLAUDE_CODE_MAX_CONTEXT_TOKENS=256000
      export CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144
      export WATCHDOG_WARN_TOKENS="${WATCHDOG_WARN_TOKENS_KIMI:-180000}"
      export WATCHDOG_CUT_TOKENS="${WATCHDOG_CUT_TOKENS_KIMI:-210000}"
      RUNNING_ENGINE=kimi; ENGINE_WINDOW=own
      BACKEND_MODEL_ARGS=(--model "${EMBERVY_KIMI_MODEL:-kimi-k2.7-code}")
      echo "$(date -Iseconds) loop: engine Kimi (${EMBERVY_KIMI_MODEL:-kimi-k2.7-code}, kimi.com/coding, 256K window)" >> "$LOG"
    else
      echo "$(date -Iseconds) loop: EMBERVY_BACKEND=kimi but KIMI_CODE_KEY missing — falling back to claude" >> "$LOG"
    fi
    ;;
  minimax)
    if [ -n "${MINIMAX_CODE_KEY:-}" ]; then
      export ANTHROPIC_BASE_URL="${EMBERVY_MINIMAX_BASE:-https://api.minimax.io/anthropic}"
      export ANTHROPIC_AUTH_TOKEN="$MINIMAX_CODE_KEY"
      unset ANTHROPIC_API_KEY
      export API_TIMEOUT_MS="3000000"
      export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${EMBERVY_MINIMAX_CONTEXT:-200000}"
      export WATCHDOG_WARN_TOKENS="${WATCHDOG_WARN_TOKENS_MINIMAX:-150000}"
      export WATCHDOG_CUT_TOKENS="${WATCHDOG_CUT_TOKENS_MINIMAX:-180000}"
      RUNNING_ENGINE=minimax; ENGINE_WINDOW=own
      BACKEND_MODEL_ARGS=(--model "${EMBERVY_MINIMAX_MODEL:-MiniMax-M2}")
      echo "$(date -Iseconds) loop: engine MiniMax (${EMBERVY_MINIMAX_MODEL:-MiniMax-M2})" >> "$LOG"
    else
      echo "$(date -Iseconds) loop: EMBERVY_BACKEND=minimax but MINIMAX_CODE_KEY missing — falling back to claude" >> "$LOG"
    fi
    ;;
  gpt)
    GPT_AUTH_FILE="$(embervy_chatgpt_auth)"
    if [ -f "$GPT_AUTH_FILE" ]; then
      GPT_ADAPTER_PORT="${GPT_ADAPTER_PORT:-3041}"
      # setsid keeps the adapter alive across loop respawns; the health probe prevents a second start.
      BUN_BIN="$(command -v bun || true)"
      [ -z "$BUN_BIN" ] && for c in /root/.bun/bin/bun /usr/local/bin/bun "$HOME/.bun/bin/bun"; do [ -x "$c" ] && BUN_BIN="$c" && break; done
      if [ -z "$BUN_BIN" ]; then
        echo "$(date -Iseconds) loop: EMBERVY_BACKEND=gpt but bun not found — install bun or set BUN_BIN" >> "$LOG"
      fi
      if [ -n "$BUN_BIN" ] && ! curl -s -m 3 "http://127.0.0.1:${GPT_ADAPTER_PORT}/health" 2>/dev/null | grep -q '"ok":true'; then
        setsid nohup env ADAPTER_PORT="$GPT_ADAPTER_PORT" \
          CHATGPT_AUTH_FILE="$GPT_AUTH_FILE" \
          ADAPTER_MODEL="${EMBERVY_GPT_MODEL:-gpt-5.6-terra}" \
          ADAPTER_EFFORT="${EMBERVY_GPT_EFFORT:-}" \
          ADAPTER_CACHE_KEY="${EMBERVY_GPT_CACHE_KEY:-embervy-$(basename "$EMBERVY_HOME")}" \
          "$BUN_BIN" "$EMBERVY_HOME/shared/tools/chatgpt-oauth-adapter.ts" \
          >> "$EMBERVY_HOME/logs/chatgpt-oauth-adapter.log" 2>&1 < /dev/null &
        for _ in 1 2 3 4 5 6 7 8 9 10; do
          curl -s -m 2 "http://127.0.0.1:${GPT_ADAPTER_PORT}/health" 2>/dev/null | grep -q '"ok":true' && break
          sleep 1
        done
      fi
      if curl -s -m 3 "http://127.0.0.1:${GPT_ADAPTER_PORT}/health" 2>/dev/null | grep -q '"ok":true'; then
        export ANTHROPIC_BASE_URL="http://127.0.0.1:${GPT_ADAPTER_PORT}"
        export ANTHROPIC_AUTH_TOKEN="subscription-via-adapter"
        unset ANTHROPIC_API_KEY
        export API_TIMEOUT_MS="3000000"
        # The window is what the model can hold; warn and cut are a cost decision: a
        # later cut uses more of the subscription with every message.
        GPT_WINDOW="${EMBERVY_GPT_CONTEXT:-1000000}"
        export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$GPT_WINDOW"
        export CLAUDE_CODE_AUTO_COMPACT_WINDOW="$GPT_WINDOW"
        export WATCHDOG_WARN_TOKENS="${WATCHDOG_WARN_TOKENS_GPT:-200000}"
        export WATCHDOG_CUT_TOKENS="${WATCHDOG_CUT_TOKENS_GPT:-220000}"
        RUNNING_ENGINE=gpt; ENGINE_WINDOW=own
        BACKEND_MODEL_ARGS=(--model "${EMBERVY_GPT_MODEL:-gpt-5.6-terra}")
        echo "$(date -Iseconds) loop: engine GPT (${EMBERVY_GPT_MODEL:-gpt-5.6-terra}, ChatGPT subscription via local adapter :${GPT_ADAPTER_PORT}, ${GPT_WINDOW}-token window)" >> "$LOG"
      else
        echo "$(date -Iseconds) loop: EMBERVY_BACKEND=gpt but the OAuth adapter did not come up (see logs/chatgpt-oauth-adapter.log) — falling back to claude" >> "$LOG"
      fi
    else
      echo "$(date -Iseconds) loop: EMBERVY_BACKEND=gpt but $GPT_AUTH_FILE missing — run the subscription login first; falling back to claude" >> "$LOG"
    fi
    ;;
  claude|*)
    :
    ;;
esac

# The watchdog is its own service and never sees these exports, so the
# thresholds go to it through a file it re-reads every tick.
ENGINE_THRESHOLDS_FILE="$EMBERVY_HOME/state/watchdog_engine_thresholds"
mkdir -p "$EMBERVY_HOME/state"
ENGINE_NUMBERS=""
if [[ "${WATCHDOG_WARN_TOKENS:-}" =~ ^[1-9][0-9]*$ && "${WATCHDOG_CUT_TOKENS:-}" =~ ^[1-9][0-9]*$ ]]; then
  ENGINE_NUMBERS="$WATCHDOG_WARN_TOKENS $WATCHDOG_CUT_TOKENS"
fi
case "$RUNNING_ENGINE" in
  gpt) ENGINE_WINDOW_TOKENS="${GPT_WINDOW:-}" ;;
  kimi|minimax) ENGINE_WINDOW_TOKENS="${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-}}" ;;
  *) ENGINE_WINDOW_TOKENS="${CLAUDE_CODE_MAX_CONTEXT_TOKENS:-}" ;;
esac
ENGINE_WINDOW_SUFFIX=""
if [[ "$ENGINE_WINDOW_TOKENS" =~ ^[1-9][0-9]*$ ]]; then
  ENGINE_WINDOW_SUFFIX=" $ENGINE_WINDOW_TOKENS"
fi
printf '%s\n%s %s%s\n' "$ENGINE_NUMBERS" "$RUNNING_ENGINE" "$ENGINE_WINDOW" "$ENGINE_WINDOW_SUFFIX" > "$ENGINE_THRESHOLDS_FILE.tmp" \
  && mv -f "$ENGINE_THRESHOLDS_FILE.tmp" "$ENGINE_THRESHOLDS_FILE"
echo "$(date -Iseconds) loop: watchdog engine file: engine=$RUNNING_ENGINE window=$ENGINE_WINDOW thresholds=${ENGINE_NUMBERS:-none}" >> "$LOG"

# TERM/INT: finalize before exit so stopping the service cannot lose a session.
# Skip repeats within two minutes of a cut.
finalize_on_term() {
  local now last_cut age latest marker
  marker="$EMBERVY_HOME/state/last_cutover_ts"
  now=$(date +%s)
  last_cut=0
  [ -f "$marker" ] && last_cut=$(cat "$marker" 2>/dev/null || echo 0)
  age=$((now - last_cut))
  if [ "$age" -le 120 ]; then
    echo "$(date -Iseconds) loop: SIGTERM — cutover ${age}s ago, skip finalize" >> "$LOG"
    return 0
  fi
  latest=$(python3 "$EMBERVY_HOME/Claude/scripts/latest_main_session.py" "$PROJECT_DIR" 2>/dev/null)
  if [ -n "$latest" ] && [ -f "$latest" ]; then
    echo "$(date -Iseconds) loop: SIGTERM finalize — bridge + RAG from $(basename "$latest")" >> "$LOG"
    SESSION_FILE="$latest" python3 "$EMBERVY_HOME/Claude/scripts/extract_bridge.py" --output "$BRIDGE" >>"$LOG" 2>&1 \
      || echo "$(date -Iseconds) loop: SIGTERM bridge build failed" >> "$LOG"
    SESSION_FILE="$latest" "$EMBERVY_HOME/Claude/scripts/session-to-rag.sh" >>"$LOG" 2>&1 \
      || echo "$(date -Iseconds) loop: SIGTERM RAG upload failed" >> "$LOG"
    echo "$now" > "$marker"
  fi
}
DIALOG_POLLER_PID=""
stop_dialog_poller() {
  # A poller from an exited process must never type into its replacement.
  if [ -n "$DIALOG_POLLER_PID" ]; then
    kill "$DIALOG_POLLER_PID" 2>/dev/null || true
    wait "$DIALOG_POLLER_PID" 2>/dev/null || true
    DIALOG_POLLER_PID=""
    loop_question_reset
  fi
}
BIRTH_PROMPT_PID=""
stop_birth_prompt() {
  if [ -n "$BIRTH_PROMPT_PID" ]; then
    kill "$BIRTH_PROMPT_PID" 2>/dev/null || true
    wait "$BIRTH_PROMPT_PID" 2>/dev/null || true
    BIRTH_PROMPT_PID=""
  fi
}
CACHE_PING_PID=""
stop_cache_ping() {
  stop_birth_prompt
  if [ -n "$CACHE_PING_PID" ]; then
    kill "$CACHE_PING_PID" 2>/dev/null || true
    wait "$CACHE_PING_PID" 2>/dev/null || true
    CACHE_PING_PID=""
  fi
}
trap 'stop_cache_ping; clear_main_bridge_token; stop_dialog_poller' EXIT
trap 'stop_cache_ping; clear_main_bridge_token; echo "$(date -Iseconds) loop: shell SIGTERM — finalizing running session before exit" >> "$LOG"; stop_dialog_poller; finalize_on_term; if [ -n "${LOOP_CLAUDE_PID:-}" ]; then kill "$LOOP_CLAUDE_PID" 2>/dev/null || true; wait "$LOOP_CLAUDE_PID" 2>/dev/null || true; fi; exit 0' TERM INT

CHANNELS="${EMBERVY_CHANNELS:-$(embervy_app_server_name "$EMBERVY_HOME/.mcp.json")}"
CHANNEL_ARGS=()
IFS=',' read -ra _CHANS <<< "$CHANNELS"
for c in "${_CHANS[@]}"; do
  CHANNEL_ARGS+=("server:$c")
done

while true; do
  # Keep the running loop if a script edit fails syntax validation.
  __self_hash="$(md5sum "$0" 2>/dev/null | awk '{print $1}')"
  if [ -n "$LOOP_SELF_HASH" ] && [ -n "$__self_hash" ] && [ "$__self_hash" != "$LOOP_SELF_HASH" ]; then
    if bash -n "$0" 2>>"$LOG"; then
      echo "$(date -Iseconds) loop: SELF-RELOAD — script changed, exec'ing fresh version" >> "$LOG"
      LOOP_RESUME_MODE="$MODE" exec bash "$0" ${PASS_ARGS[@]+"${PASS_ARGS[@]}"}
    else
      echo "$(date -Iseconds) loop: SELF-RELOAD SKIPPED — new version has syntax errors, keeping old" >> "$LOG"
    fi
  fi

  echo "$(date -Iseconds) loop: starting claude (mode=$MODE iter=$LOOP_ITER)" >> "$LOG"
  LOOP_ITER=$((LOOP_ITER + 1))

  CLAUDE_ARGS=(--dangerously-load-development-channels "${CHANNEL_ARGS[@]}" ${BACKEND_MODEL_ARGS[@]+"${BACKEND_MODEL_ARGS[@]}"})
  if [ "$MODE" = "continue" ]; then
    CLAUDE_ARGS+=(--continue)
  elif [ -f "$BRIDGE" ] && [ -s "$BRIDGE" ]; then
    echo "$(date -Iseconds) loop: using bridge ($(stat -c%s "$BRIDGE") bytes)" >> "$LOG"
    # Pass the bridge by path to avoid Linux's 128 KiB argument limit.
    CLAUDE_ARGS+=(--append-system-prompt-file "$BRIDGE")
  else
    echo "$(date -Iseconds) loop: no bridge — starting bare" >> "$LOG"
  fi

  new_main_bridge_token >/dev/null \
    || echo "$(date -Iseconds) loop: cannot write $MAIN_BRIDGE_TOKEN_FILE — this session's bridge keeps no inbox position; messages sent during a restart are not picked up" >> "$LOG"
  # Keep stdin and the terminal process group; undo Bash asynchronous-job signal
  # ignores before exec. The exec preserves the PID/start stamp being observed.
  # The launcher inherits no bridge token. Read the private file only for the
  # exec target environment, without putting the token in os.environ or argv.
  python3 -c '
import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
signal.signal(signal.SIGQUIT, signal.SIG_DFL)
try:
    with open(sys.argv[1]) as token_file:
        token = token_file.read().strip()
except OSError:
    token = ""
try: os.execvpe("claude", ["claude"] + sys.argv[2:], dict(os.environ, EMBERVY_MAIN_BRIDGE_TOKEN=token))
except OSError as error:
    print("loop: cannot start claude: " + str(error), file=sys.stderr)
    sys.exit(127 if isinstance(error, FileNotFoundError) else 126)
' "$MAIN_BRIDGE_TOKEN_FILE" "${CLAUDE_ARGS[@]}" "${PASS_ARGS[@]}" <&0 &
  LOOP_CLAUDE_PID=$!
  read -r _ LOOP_CLAUDE_STAMP < <(loop_dialog_process_stamp "$LOOP_CLAUDE_PID")
  LOOP_QUESTION_GENERATION=$(cat /proc/sys/kernel/random/uuid)
  DIALOG_TARGET=$(tmux display-message -p -t "${TMUX_PANE:-$TMUX_SESSION}" '#{pane_id}' 2>/dev/null)
  # Only the explicit development choice is safe to automate; other setup needs a user.
  loop_question_reset
  (
    loop_startup_clock_start 180
    # Defer termination until a foreground capture/send finishes. The parent waits
    # for this worker before launching a successor, including on signals.
    trap 'exit 0' TERM INT
    while loop_dialog_owner_alive; do
      sleep 0.5
      loop_dialog_owner_alive || break
      [ -n "$DIALOG_TARGET" ] || break
      # Join tmux soft wraps. Hard-wrapped or incomplete menus still fail closed.
      PANE=$(tmux capture-pane -J -t "$DIALOG_TARGET" -p 2>/dev/null) || PANE=""
      loop_dialog_observe "$PANE" "$DIALOG_TARGET"
    done
    loop_question_clear
  ) &
  DIALOG_POLLER_PID=$!

  INPUT_PANE="${EMBERVY_CACHE_PING_PANE:-${TMUX_PANE:-$TMUX_SESSION}}"
  EMBERVY_CACHE_PING_PANE="$INPUT_PANE" bash "$EMBERVY_HOME/Claude/scripts/cache-ping.sh" --watch >> "$LOG" 2>&1 &
  CACHE_PING_PID=$!
  if [ "$MODE" = fresh ]; then
    EMBERVY_CACHE_PING_PANE="$INPUT_PANE" bash "$EMBERVY_HOME/Claude/scripts/birth-prompt.sh" "$MODE" >> "$LOG" 2>&1 &
    BIRTH_PROMPT_PID=$!
  fi
  wait "$LOOP_CLAUDE_PID"
  rc=$?
  stop_cache_ping
  clear_main_bridge_token
  stop_dialog_poller
  NOW=$(date +%s)
  echo "$(date -Iseconds) loop: claude exited rc=$rc" >> "$LOG"
  if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    echo "$(date -Iseconds) loop: claude could not be started at all (rc=$rc: not found, not executable or argument list too long) — counted as a crash" >> "$LOG"
  fi

  POST_EXIT_EXPORTED=0
  if [ "$rc" -eq 0 ] || [ "$rc" -eq 143 ]; then
    MODE="fresh"
    CRASH_TIMES=()
    echo "$(date -Iseconds) loop: planned exit → MODE=fresh" >> "$LOG"

    # Natural exits need an export too, but a recent cut must not export twice.
    MARKER="$EMBERVY_HOME/state/last_cutover_ts"
    LAST_CUT=0
    [ -f "$MARKER" ] && LAST_CUT=$(cat "$MARKER" 2>/dev/null || echo 0)
    AGE=$((NOW - LAST_CUT))
    LATEST_JSONL=$(python3 "$EMBERVY_HOME/Claude/scripts/latest_main_session.py" "$PROJECT_DIR" 2>/dev/null)
    CUT_SESSION_MARKER="$EMBERVY_HOME/state/last_cut_session"
    CUT_SESSION=$(cat "$CUT_SESSION_MARKER" 2>/dev/null || true)
    # A new session can finish inside the previous session's export cooldown.
    if [ "$AGE" -gt 120 ] || [ "$CUT_SESSION" != "$(basename "$LATEST_JSONL")" ]; then
      CUT_SESSION_TS=$(stat -c %Y "$CUT_SESSION_MARKER" 2>/dev/null || echo 0)
      CUT_SESSION_AGE=$((NOW - CUT_SESSION_TS))
      # The session marker also covers cuts whose timestamp is not visible yet.
      if [ -n "$LATEST_JSONL" ] && [ "$CUT_SESSION" = "$(basename "$LATEST_JSONL")" ] && [ "$CUT_SESSION_AGE" -ge 0 ] && [ "$CUT_SESSION_AGE" -lt 120 ]; then
        POST_EXIT_EXPORTED=1
        echo "$(date -Iseconds) loop: last_cut_session matches (${CUT_SESSION_AGE}s old) — skipping post-exit finalize" >> "$LOG"
      elif [ -n "$LATEST_JSONL" ] && [ -f "$LATEST_JSONL" ]; then
        echo "$(date -Iseconds) loop: post-exit finalize — bridge + RAG from $(basename "$LATEST_JSONL")" >> "$LOG"
        SESSION_FILE="$LATEST_JSONL" python3 "$EMBERVY_HOME/Claude/scripts/extract_bridge.py" --output "$BRIDGE" >>"$LOG" 2>&1 \
          || echo "$(date -Iseconds) loop: post-exit bridge build failed" >> "$LOG"
        if SESSION_FILE="$LATEST_JSONL" "$EMBERVY_HOME/Claude/scripts/session-to-rag.sh" >>"$LOG" 2>&1; then
          POST_EXIT_EXPORTED=1
          basename "$LATEST_JSONL" > "$CUT_SESSION_MARKER"
        else
          echo "$(date -Iseconds) loop: post-exit RAG upload failed" >> "$LOG"
        fi
        echo "$NOW" > "$MARKER"
      fi
    else
      POST_EXIT_EXPORTED=1
      echo "$(date -Iseconds) loop: last_cutover_ts ${AGE}s ago — skipping post-exit finalize" >> "$LOG"
    fi
  else
    CRASH_TIMES+=("$NOW")
    NEW_CRASHES=()
    for t in "${CRASH_TIMES[@]}"; do
      if [ $((NOW - t)) -le 30 ]; then
        NEW_CRASHES+=("$t")
      fi
    done
    CRASH_TIMES=("${NEW_CRASHES[@]}")

    if [ "${#CRASH_TIMES[@]}" -ge 3 ]; then
      echo "$(date -Iseconds) loop: 3 crashes in <30s — fallback to fresh" >> "$LOG"
      MODE="fresh"
      CRASH_TIMES=()
    else
      MODE="continue"
      echo "$(date -Iseconds) loop: crash #${#CRASH_TIMES[@]} → MODE=continue" >> "$LOG"
    fi
  fi

  notify_runtime_swap "$rc"

  loop_restart_pause "$rc" "$POST_EXIT_EXPORTED"

  if [ -f "$EMBERVY_HOME/state/loop_reload" ]; then
    rm -f "$EMBERVY_HOME/state/loop_reload"
    echo "$(date -Iseconds) loop: reload marker found — re-execing self" >> "$LOG"
    exec "$0" "$@"
  fi
done
