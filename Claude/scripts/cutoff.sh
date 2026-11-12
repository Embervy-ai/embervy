#!/bin/bash
# cutoff.sh — the session cut, triggered by the context watchdog: build the
# bridge, export the session to the archive, SIGTERM Claude, and the loop
# respawns with the new bridge. The bridge comes first, so it is on disk even
# if the upload or the kill fails.

set -u

ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME
LOG="$EMBERVY_HOME/logs/cutoff.log"
mkdir -p "$EMBERVY_HOME/logs" "$EMBERVY_HOME/state"

# The watchdog already redirects to this file; tee would duplicate each line.
if [ "$LOG" -ef /proc/self/fd/1 ]; then
  exec >> "$LOG" 2>&1
else
  exec > >(tee -a "$LOG") 2>&1
  LOG_PID=$!
  # Flush the log before returning, including on an early failure.
  trap 'status=$?; exec 1>&- 2>&-; wait "$LOG_PID"; exit "$status"' EXIT
fi

# Serialize cut preparation/termination with cache-ping prompt injection.
# Hold until exit, including failure paths; never allow a ping mid-export.
exec 9>"$EMBERVY_HOME/state/claude-input.lock"
flock -x 9 || exit 1

SESSION_DIR="${CLAUDE_PROJECT_DIR:-$HOME/.claude/projects/$(echo "$EMBERVY_HOME" | tr / -)}"
CLAUDE_PROCESS_PATTERN="${CLAUDE_PROCESS_PATTERN:-claude.*server:}"

echo "=== cutoff.sh start $(date -Iseconds) ==="

# Determine the session file ONCE so bridge and export agree, even if a newer
# JSONL appears between the two invocations. Both scripts honor SESSION_FILE.
# Newest MAIN session (latest_main_session.py), not newest file.
SESSION_FILE=$(python3 "$EMBERVY_HOME/Claude/scripts/latest_main_session.py" "$SESSION_DIR" 2>/dev/null)
if [ -z "$SESSION_FILE" ] || [ ! -f "$SESSION_FILE" ]; then
  echo "  No session file found — aborting, NO kill."
  exit 1
fi
export SESSION_FILE
echo "  Session: $SESSION_FILE"

echo "[1/4] Building wake bridge..."
if python3 "$EMBERVY_HOME/Claude/scripts/extract_bridge.py" --output "$EMBERVY_HOME/state/wake_bridge.md"; then
  echo "  Bridge OK"
else
  echo "  Bridge FAILED — aborting, NO kill."
  exit 1
fi

echo "[2/4] Exporting session to RAG..."
if "$EMBERVY_HOME/Claude/scripts/session-to-rag.sh"; then
  echo "  Export OK"
else
  echo "  Export FAILED — bridge is on disk, but NO kill (manual recovery needed)."
  exit 1
fi

echo "[3/4] Terminating claude process..."
CLAUDE_PIDS=$(embervy_house_pids -f "$CLAUDE_PROCESS_PATTERN" || true)
if [ -n "$CLAUDE_PIDS" ]; then
  CUT_MARKED=0
  for pid in $CLAUDE_PIDS; do
    embervy_owns_pid "$pid" || continue
    # Publish before termination because the loop can finalize immediately.
    if [ "$CUT_MARKED" -eq 0 ]; then
      basename "$SESSION_FILE" > "$EMBERVY_HOME/state/last_cut_session"
      date +%s > "$EMBERVY_HOME/state/last_cutover_ts"
      CUT_MARKED=1
    fi
    echo "  SIGTERM -> pid=$pid"
    kill -TERM "$pid" 2>/dev/null || true
  done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! embervy_house_pids -f "$CLAUDE_PROCESS_PATTERN" > /dev/null; then
      echo "  Clean exit after ${i}s"
      break
    fi
    sleep 1
  done
  for pid in $CLAUDE_PIDS; do
    if embervy_owns_pid "$pid"; then
      echo "  Timeout — SIGKILL -> pid=$pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
else
  # Zero matches means the pattern no longer describes the running session
  # (a CLI update, an edited start command). Writing the success marker here
  # would let the watchdog re-fire this script every 30 seconds against a
  # process it can never find. Alarm instead, loudly, and leave no marker.
  echo "  ALARM: no process matched CLAUDE_PROCESS_PATTERN ('$CLAUDE_PROCESS_PATTERN')."
  echo "  The pattern is stale or the session is gone. No success marker written."
  exit 2
fi

echo "[4/4] Respawn delegated to start-claude-loop.sh / systemd."

echo "=== cutoff.sh done $(date -Iseconds) ==="
