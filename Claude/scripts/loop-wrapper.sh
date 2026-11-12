#!/bin/bash
# Hosts the restart loop in a service-managed session.
# Staying alive lets systemd restart the service when its tmux session ends.

set -u

HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME

# The service PATH omits the user-installed runtime and CLI directories.
export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin"

ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
tmux() { embervy_tmux "$@"; }
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
embervy_env_load -x "$EMBERVY_HOME/.env" "$EMBERVY_HOME/Claude/app/.env"
SESSION="${EMBERVY_TMUX_SESSION:-embervy}"
LOOP_SCRIPT="$EMBERVY_HOME/Claude/scripts/start-claude-loop.sh"

# Reusing a server outside this cgroup would evade service lifecycle control.
# Refuse rather than kill a manually started session that may still be archiving.
if SERVER_PIDS=$(tmux list-sessions -F '#{pid}' 2>/dev/null); then
  SERVER_PID="${SERVER_PIDS%%$'\n'*}"
  if ! [[ "$SERVER_PID" =~ ^[1-9][0-9]*$ ]] || ! cmp -s "/proc/$$/cgroup" "/proc/$SERVER_PID/cgroup"; then
    echo "$(date -Iseconds) wrapper: refusing tmux server outside own cgroup on socket $(embervy_tmux_socket); stop the hand-started loop and server before starting the unit" >&2
    exit 1
  fi
fi

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  printf -v LOOP_COMMAND '%q ' bash "$LOOP_SCRIPT" "$@"
  tmux new-session -d -s "$SESSION" -c "$EMBERVY_HOME" "$LOOP_COMMAND" || exit 1
fi

while tmux has-session -t "$SESSION" 2>/dev/null; do
  sleep 10
done

exit 0
