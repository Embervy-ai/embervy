#!/bin/bash
# brain-loop-wrapper.sh — systemd entry for the Brain loop.
#
# Starts the tmux session that hosts brain-loop.sh, then stays alive while
# that session lives, so systemd's Restart=always sees the unit as running.
#
# Exit 75 = a deliberate end, no restart (the unit has RestartPreventExitStatus=75):
#   /stop (brain-loop.sh leaves state/brain_stopped).
# Exit 0 = the session vanished without a deliberate end → systemd restarts.

set -u

HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME
export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin"

. "$(dirname "$0")/brain-env.sh"

SESSION="${BRAIN_TMUX_SESSION:-brain}"
TMUX_ARGS=(-L "$(brain_tmux_socket)")
LOOP_SCRIPT="$BRAIN_HOME/scripts/brain-loop.sh"
POLL_S="${BRAIN_WRAPPER_POLL_S:-10}"

# Even a server hosting another session would keep our loop outside the unit.
# Refuse rather than kill a hand-started life that may still be archiving.
if SERVER_PIDS=$(tmux "${TMUX_ARGS[@]}" list-sessions -F '#{pid}' 2>/dev/null); then
  SERVER_PID="${SERVER_PIDS%%$'\n'*}"
  if ! [[ "$SERVER_PID" =~ ^[1-9][0-9]*$ ]] || ! cmp -s "/proc/$$/cgroup" "/proc/$SERVER_PID/cgroup"; then
    echo "$(date -Iseconds) wrapper: refusing tmux server outside own cgroup on socket $(brain_tmux_socket); stop the hand-started loop and server before starting the unit" >&2
    exit 1
  fi
fi

if ! tmux "${TMUX_ARGS[@]}" has-session -t "=$SESSION" 2>/dev/null; then
  tmux "${TMUX_ARGS[@]}" new-session -d -s "$SESSION" -c "$BRAIN_HOME" "bash $LOOP_SCRIPT" || exit 1
fi

while tmux "${TMUX_ARGS[@]}" has-session -t "=$SESSION" 2>/dev/null; do
  sleep "$POLL_S"
done

if [ -f "$BRAIN_STATE_DIR/brain_stopped" ]; then
  echo "$(date -Iseconds) wrapper: loop ended by a stop marker — no restart"
  exit 75
fi
exit 0
