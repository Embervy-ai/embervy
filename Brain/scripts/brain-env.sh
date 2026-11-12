#!/bin/bash
# Loads shared environment settings and paths for the runtime scripts.
# File values override inherited values so reloads cannot retain stale settings.
# BRAIN_ENV_KEEP preserves explicit process overrides.

# Track file-owned keys so reloads can distinguish them from explicit process overrides.
# Removing a file-owned key restores its default rather than retaining an inherited value.

# Logs and archives contain private conversations and must be owner-readable only.
umask 077
brain_load_env_file() {
  local file="$1" line key value previous="${BRAIN_ENV_FILE_KEYS:-}" taken=" "
  # A removed file releases its keys just like removing all its assignments.
  [ -f "$file" ] || file=/dev/null
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*([A-Z_][A-Z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" && ${#value} -ge 2 ]]; then value="${value:1:${#value}-2}"; fi
    if [[ "$value" == \'*\' && ${#value} -ge 2 ]]; then value="${value:1:${#value}-2}"; fi
    if [ -z "${!key:-}" ] || [[ " ${BRAIN_ENV_KEEP:-} " != *" $key "* ]]; then
      export "$key=$value"
      [[ "$taken" == *" $key "* ]] || taken+="$key "
    fi
  done < "$file"
  for key in $previous; do
    [[ "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || continue
    [[ "$taken" == *" $key "* || " ${BRAIN_ENV_KEEP:-} " == *" $key "* ]] || unset "$key"
  done
  taken="${taken# }"
  export BRAIN_ENV_FILE_KEYS="${taken% }"
}

BRAIN_HOME="${BRAIN_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export BRAIN_HOME
if [ "${BRAIN_NO_ENV_FILE:-}" != "1" ]; then
  brain_load_env_file "$BRAIN_HOME/brain.env"
fi
BRAIN_STATE_DIR="${BRAIN_STATE_DIR:-$BRAIN_HOME/state}"
BRAIN_LOG_DIR="${BRAIN_LOG_DIR:-$BRAIN_HOME/logs}"
BRAIN_CONTEXT_STATE_FILE="${BRAIN_CONTEXT_STATE_FILE:-$BRAIN_STATE_DIR/brain_context.json}"
BRAIN_CONTEXT_WARNING_FILE="${BRAIN_CONTEXT_WARNING_FILE:-$BRAIN_STATE_DIR/context_warning}"
BRAIN_BRIDGE_FILE="${BRAIN_BRIDGE_FILE:-$BRAIN_LOG_DIR/bridge.md}"
export BRAIN_STATE_DIR BRAIN_LOG_DIR BRAIN_CONTEXT_STATE_FILE BRAIN_CONTEXT_WARNING_FILE BRAIN_BRIDGE_FILE

brain_tmux_socket() { printf '%s\n' "${BRAIN_TMUX_SOCKET:-brain}"; }

# Resolve beside this script because BRAIN_HOME may select a separate state directory.
BRAIN_TEXTS_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export BRAIN_TEXTS_DIR
brain_text() {
  "${BUN_BIN:-bun}" "$BRAIN_TEXTS_DIR/../texts.ts" "$@"
}

brain_notify_app() {
  local text="$1" auth=()
  [ -n "${BRAIN_APP_URL:-}" ] || return 0
  [ "${BRAIN_NOTIFY:-on}" = "off" ] && return 0
  local token="${BRAIN_APP_TOKEN:-${INTERNAL_API_TOKEN:-}}"
  [ -n "$token" ] && auth=(-H "Authorization: Bearer ${token}")
  curl -s -m 5 -o /dev/null -X POST "${BRAIN_APP_URL%/}/api/internal/broadcast" \
    "${auth[@]}" -H "Content-Type: application/json" \
    -d "$(python3 -c 'import json,sys,uuid,datetime; print(json.dumps({"id":str(uuid.uuid4()),"text":sys.argv[1],"ts":datetime.datetime.now(datetime.timezone.utc).isoformat(),"type":"send"}))' "$text")" \
    2>/dev/null || true
}
