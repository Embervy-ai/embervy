#!/bin/bash
# Stops the runtime after allowing its signal handler to write the bridge and archive.

set -u

. "$(dirname "$0")/brain-env.sh"
. "$(dirname "$0")/house-owner.sh"

mkdir -p "$BRAIN_STATE_DIR" "$BRAIN_LOG_DIR"
# Wait for tee at exit so callers can read the complete log immediately.
exec 3>&1
exec > >(tee -a "$BRAIN_LOG_DIR/brain-cutoff.log" >&3) 2>&1
LOG_PID=$!
trap 'exec 1>&- 2>&-; wait "$LOG_PID"; exec 3>&-' EXIT
RESULT="$BRAIN_STATE_DIR/last-cut-result"
WAIT_S="${BRAIN_CUT_WAIT_S:-180}"
PATTERN="${BRAIN_PROCESS_PATTERN:-brain\.ts}"

# Unreaped zombies still answer kill -0.
alive() {
  kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != "Z" ]
}

echo "=== brain-cutoff start $(date -Iseconds) ==="
echo RUNNING > "$RESULT"

PID=$(python3 -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("pid") or 0))' "$BRAIN_CONTEXT_STATE_FILE" 2>/dev/null || echo 0)
if [ -z "$PID" ] || [ "$PID" -le 0 ] 2>/dev/null || ! alive "$PID" \
   || ! embervy_owns_pid "$PID" \
   || ! tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null | grep -qE "$PATTERN"; then
  # A success marker without a process would let the watchdog repeat a failed cut.
  echo "  ALARM: no live Brain process (pid='$PID', pattern '$PATTERN'). No marker written."
  echo NO_PROCESS > "$RESULT"
  exit 2
fi
echo "  Brain pid=$PID"
START_TS=$(date +%s)

if [ "${BRAIN_QUICK_CUT:-off}" = "on" ]; then
  echo "[1/3] SIGTERM → Brain archives itself (bridge + archive; the next start uploads it)"
  # The opt-in cut delegates the upload to the next session to shorten shutdown.
  echo "$PID" > "$BRAIN_STATE_DIR/cut-respawn"
else
  echo "[1/3] SIGTERM → Brain archives and uploads before exiting (bridge + archive + RAG)"
fi
kill -TERM "$PID" 2>/dev/null || true

echo "[2/3] waiting up to ${WAIT_S}s for a clean exit"
OUTCOME=KILLED
for _ in $(seq 1 "$WAIT_S"); do
  if ! alive "$PID"; then OUTCOME=TERMINATED; break; fi
  sleep 1
done
if [ "$OUTCOME" = KILLED ]; then
  echo "[3/3] still alive after ${WAIT_S}s — SIGKILL (bridge/export of this session may be missing)"
  embervy_owns_pid "$PID" && kill -KILL "$PID" 2>/dev/null || true
else
  echo "[3/3] clean exit"
fi
rm -f "$BRAIN_STATE_DIR/cut-respawn"

if [ -f "$BRAIN_BRIDGE_FILE" ] && [ "$(stat -c %Y "$BRAIN_BRIDGE_FILE" 2>/dev/null || echo 0)" -ge "$START_TS" ]; then
  echo "  bridge OK ($(stat -c %s "$BRAIN_BRIDGE_FILE") bytes)"
else
  echo "  WARNING: no fresh bridge at $BRAIN_BRIDGE_FILE"
fi

date +%s > "$BRAIN_STATE_DIR/last_cutover_ts"
echo "$OUTCOME" > "$RESULT"
echo "  respawn delegated to brain-loop.sh"
echo "=== brain-cutoff done $(date -Iseconds) ($OUTCOME) ==="
[ "$OUTCOME" = TERMINATED ] && exit 0 || exit 3
