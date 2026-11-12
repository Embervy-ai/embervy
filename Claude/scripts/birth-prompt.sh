#!/bin/bash
# Sends the first prompt only to a fresh session; resuming must not add another first turn.
ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
BIRTH_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
. "$BIRTH_SCRIPT_DIR/loop-dialog.sh"

birth_prompt_ready() {
  local pane
  pane=$(cat)
  [ "$(loop_dialog_kind "$pane")" = none ] || return 1
  printf '%s\n' "$pane" | python3 -c '
import re, runpy, sys
state = runpy.run_path(sys.argv[1])
text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", sys.stdin.read())
blocked = re.search(r"update (?:available|notice|required)|new version|restart to update|updating|choose the text style|new MCP servers|enter to continue", text, re.I)
sys.exit(0 if not blocked and state["pane"](text.replace("›", "❯"), sys.argv[2].replace("›", "❯")) else 1)
' "$BIRTH_SCRIPT_DIR/cache_ping_state.py" "${1:-}"
}

birth_prompt_main() {
  case "${1:-fresh}" in fresh|respawn) ;; *) return 0 ;; esac
  EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"
  local default_prompt='[gateway:silent] Fresh session after a cut. Read your lore and the bridge, then greet your person in the app in one or two sentences; no report of what you did before the cut.'
  if [ ! -s "$EMBERVY_HOME/state/wake_bridge.md" ] && [ ! -s "$EMBERVY_HOME/state/uploaded_sessions" ]; then
    default_prompt='[gateway:silent] First start. Read your identity and HANDBOOK.md, then greet your person for the first time in the app in one or two sentences.'
  fi
  EMBERVY_BIRTH_PROMPT="${EMBERVY_BIRTH_PROMPT-$default_prompt}"
  embervy_env_load "$EMBERVY_HOME/.env" "$EMBERVY_HOME/Claude/app/.env"
  [ -n "$EMBERVY_BIRTH_PROMPT" ] || return 0
  # Literal input must stay a single line, even with an inherited environment value.
  [[ "$EMBERVY_BIRTH_PROMPT" != *$'\n'* && "$EMBERVY_BIRTH_PROMPT" != *$'\r'* ]] || return 0
  local target="${EMBERVY_CACHE_PING_PANE:-${EMBERVY_TMUX_SESSION:-embervy}}"
  local log="$EMBERVY_HOME/logs/claude-loop.log" pane kind child="" seen_claude=""
  mkdir -p "$EMBERVY_HOME/logs" "$EMBERVY_HOME/state"
  trap '[ -z "$child" ] || { kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; }; exit 0' TERM INT
  loop_startup_clock_start "${2:-300}"
  while [ "$LOOP_STARTUP_REMAINING" -gt 0 ]; do
    sleep 0.5 & child=$!
    wait "$child" || return 0
    child=""
    pane=""
    if embervy_pane_has_claude "$target"; then
      seen_claude=1
      pane=$(embervy_tmux capture-pane -p -t "$target" 2>/dev/null) || pane=""
    elif [ -n "$seen_claude" ]; then
      # An exited process must not leave a paused worker watching its old screen.
      return 0
    fi
    kind=$(loop_dialog_kind "$pane")
    loop_startup_clock_tick "$kind" || break
    [ "$kind" = none ] || continue
    [ -n "$seen_claude" ] || continue
    printf '%s\n' "$pane" | birth_prompt_ready || continue
    # Share the cut/cache-ping lock only while typing, not during startup dialogs.
    exec 9>"$EMBERVY_HOME/state/claude-input.lock"
    flock -n 9 || { exec 9>&-; continue; }
    embervy_pane_has_claude "$target" || { exec 9>&-; continue; }
    pane=$(embervy_tmux capture-pane -p -t "$target" 2>/dev/null) || { exec 9>&-; continue; }
    printf '%s\n' "$pane" | birth_prompt_ready || { exec 9>&-; continue; }
    embervy_tmux send-keys -t "$target" -l "$EMBERVY_BIRTH_PROMPT" 2>/dev/null || return 0
    sleep 1 & child=$!
    wait "$child" || return 0
    child=""
    # A new dialog must not receive the Enter meant for the birth line.
    embervy_pane_has_claude "$target" || return 0
    pane=$(embervy_tmux capture-pane -p -t "$target" 2>/dev/null) || return 0
    printf '%s\n' "$pane" | birth_prompt_ready "$EMBERVY_BIRTH_PROMPT" || return 0
    embervy_tmux send-keys -t "$target" Enter 2>/dev/null || return 0
    printf '%s loop: birth prompt sent\n' "$(date -Iseconds)" >> "$log"
    return 0
  done
  printf '%s loop: birth prompt timed out after 300s\n' "$(date -Iseconds)" >> "$log"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  birth_prompt_main "$@"
fi
