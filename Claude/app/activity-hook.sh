#!/bin/sh
# Records activity without affecting the harness.
set +e
umask 077
APP_DIR=${EMBERVY_APP_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)}
DIR="$APP_DIR/data/activity"
FILE="$DIR/events.jsonl"
INPUT=$(cat 2>/dev/null)
# Shared hook settings must not record another project's activity.
HOUSE=${EMBERVY_HOME:-$(CDPATH= cd -- "$APP_DIR/../.." 2>/dev/null && pwd)}
HOOK_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
RESOLVED_CWD=$(readlink -f -- "${HOOK_CWD:-$PWD}" 2>/dev/null) || exit 0
RESOLVED_HOUSE=$(readlink -f -- "$HOUSE" 2>/dev/null) || exit 0
[ -n "$RESOLVED_CWD" ] && [ -n "$RESOLVED_HOUSE" ] || exit 0
case "$RESOLVED_CWD" in
  "$RESOLVED_HOUSE"|"${RESOLVED_HOUSE%/}"/*) ;;
  *) exit 0 ;;
esac
EVENT=$(printf '%s' "$INPUT" | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)
case "$EVENT" in
  UserPromptSubmit) KIND=turn_start ;;
  PreToolUse) KIND=tool_start ;;
  PostToolUse) KIND=tool_end ;;
  Stop) KIND=turn_end ;;
  *) exit 0 ;;
esac
mkdir -p "$DIR" 2>/dev/null || exit 0
if [ -f "$FILE" ] && [ "$(wc -c < "$FILE" 2>/dev/null)" -gt 1048576 ]; then
  mv -f "$FILE" "$FILE.old" 2>/dev/null
fi
TS=$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null)
if [ "$KIND" = tool_start ]; then
  TOOL=$(printf '%s' "$INPUT" | sed -n 's/.*"tool_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"ts":"%s","event":"%s","tool":"%s"}\n' "$TS" "$KIND" "$TOOL" >> "$FILE" 2>/dev/null
else
  printf '{"ts":"%s","event":"%s"}\n' "$TS" "$KIND" >> "$FILE" 2>/dev/null
fi
exit 0
