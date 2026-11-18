#!/bin/bash
# Claude Code statusline: stdin is private; only the quota/model allowlist persists.
# Called through bash so installation does not depend on an executable file bit.
exec 2>/dev/null
line=$(
  SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd) || exit 0
  EMBERVY_HOME="${EMBERVY_HOME:-$(cd -- "$SCRIPT_DIR/../.." && pwd)}"
  # Match cache-ping's configuration precedence, without sourcing env as code.
  . "$SCRIPT_DIR/../../shared/scripts/env-file.sh" || exit 0
  embervy_env_load "$EMBERVY_HOME/.env" "$EMBERVY_HOME/Claude/app/.env"
  export EMBERVY_HOME EMBERVY_CACHE_PING_STATUS_FILE
  python3 -B "$SCRIPT_DIR/statusline.py"
) || line=""
printf '%s\n' "$line"
exit 0
