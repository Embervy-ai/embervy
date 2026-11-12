#!/bin/bash
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME

claude_signin_present() {
  [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && return 0
  python3 - "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json" 2>/dev/null <<'PY'
import json
import sys

try:
    with open(sys.argv[1]) as handle:
        credentials = json.load(handle)
    present = isinstance(credentials, dict) and "claudeAiOauth" in credentials
except (OSError, ValueError):
    present = False
sys.exit(0 if present else 1)
PY
}

claude_signin_warning() {
  case "$1" in
    gpt|glm|kimi|minimax)
      if ! claude_signin_present; then
        printf '%s\n' "Warning: this house thinks with $1 but Claude Code has no Claude sign-in. Anthropic opens Claude Code's app channel only for a signed-in Claude account, so messages from the app will not reach the agent. Sign in once with claude and /login, then restart the loop."
      fi
      ;;
  esac
  return 0
}
