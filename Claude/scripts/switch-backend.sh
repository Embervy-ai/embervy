#!/bin/bash
# switch-backend.sh --to=<claude|glm|kimi|minimax|gpt> — switches the engine
# behind Claude Code (only the Anthropic-compatible endpoint changes).
#
# Sets EMBERVY_BACKEND in Claude/app/.env and restarts the loop cleanly; the
# loop's TERM trap finalizes the session first, so nothing is lost.
#
# Keys per engine (in Claude/app/.env): glm GLM_CODE_KEY, kimi KIMI_CODE_KEY
# (256K window; the loop lowers the watchdog's thresholds), minimax
# MINIMAX_CODE_KEY, claude none, gpt the ChatGPT login file (CHATGPT_AUTH_FILE,
# default ~/.codex/auth.json).
set -u

HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME
ENV_LIB="$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/env-file.sh"
[ -f "$ENV_LIB" ] || ENV_LIB="${EMBERVY_HOME:-/opt/embervy}/shared/scripts/env-file.sh"
. "$ENV_LIB"
. "$(dirname -- "$ENV_LIB")/house-runtime.sh"
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
ENV_FILE="$EMBERVY_HOME/Claude/app/.env"
embervy_env_load -x "$ENV_FILE"
LOG="$EMBERVY_HOME/logs/switch-backend.log"
LOOP_SERVICE="${EMBERVY_LOOP_SERVICE:-$(embervy_unit_name loop)}"
mkdir -p "$(dirname "$LOG")"
log(){ echo "$(date -Iseconds) $*" | tee -a "$LOG"; }

TO=""
for arg in "$@"; do
  case "$arg" in --to=*) TO="${arg#--to=}" ;; esac
done
case "$TO" in
  claude|glm|kimi|minimax|gpt) ;;
  *) echo "usage: $0 --to=claude|glm|kimi|minimax|gpt"; exit 1 ;;
esac

# Gate: the target engine must have its key before we restart anything.
key_for() {
  case "$1" in
    glm) echo GLM_CODE_KEY ;;
    kimi) echo KIMI_CODE_KEY ;;
    minimax) echo MINIMAX_CODE_KEY ;;
    *) echo "" ;;
  esac
}
KEYVAR="$(key_for "$TO")"
if [ -n "$KEYVAR" ] && ! grep -qE "^${KEYVAR}=.+" "$ENV_FILE" 2>/dev/null; then
  log "ABORT: $TO needs $KEYVAR in $ENV_FILE — nothing changed."
  exit 1
fi
# gpt has no key: it needs the subscription login file the adapter reads
# (same default as start-claude-loop.sh).
if [ "$TO" = gpt ]; then
  AUTH_FILE="$(HOME="$HOME" embervy_chatgpt_auth)"
  if [ ! -s "$AUTH_FILE" ]; then
    log "ABORT: gpt needs the ChatGPT subscription login ($AUTH_FILE missing) — run the login first; nothing changed."
    exit 1
  fi
fi

cp "$ENV_FILE" "$ENV_FILE.bak-switch" 2>/dev/null || true
if grep -qE "^EMBERVY_BACKEND=" "$ENV_FILE" 2>/dev/null; then
  sed -i "s/^EMBERVY_BACKEND=.*/EMBERVY_BACKEND=$TO/" "$ENV_FILE"
else
  printf '\nEMBERVY_BACKEND=%s\n' "$TO" >> "$ENV_FILE"
fi
log "EMBERVY_BACKEND=$TO set"

# Clean restart: TERM trap finalizes (bridge + RAG), loop respawns fresh
# and picks up the new engine from .env.
log "restarting $LOOP_SERVICE (TERM trap finalizes the running session)"
systemctl restart "$LOOP_SERVICE"
log "done — new session comes up on '$TO'"
