# shellcheck shell=bash
# Isolates process and hook operations by installation.
# Shared socket selection keeps nested calls from reaching another installation's server.
embervy_tmux_socket() { printf '%s\n' "${EMBERVY_TMUX_SOCKET:-embervy}"; }
embervy_tmux() {
  command tmux -L "$(embervy_tmux_socket)" "$@"
}

# Without job control, the waiting shell can remain the foreground group leader.
# Search the pane's session because the displayed command may not name the agent.
embervy_pane_has_claude() {
  local pid
  pid=$(embervy_tmux display-message -p -t "$1" '#{pane_pid}' 2>/dev/null) || return 1
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  pgrep -s "$pid" -x 'claude|node' >/dev/null 2>&1
}

# Service membership survives cwd changes, so unit paths take precedence for ownership.
# Match path components so similarly prefixed installations cannot claim each other's processes.
embervy_unit_of_pid() {
  sed -n 's#^0::.*/\([^/]*\.service\)$#\1#p' "/proc/$1/cgroup" 2>/dev/null | head -n 1
}

embervy_owns_pid() {
  local pid="$1" cwd root arg unit paths
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  root=$(readlink -f -- "${EMBERVY_HOME:-}") || return 1
  [ -n "$root" ] && [ "$root" != / ] || return 1
  unit=$(embervy_unit_of_pid "$pid")
  if [ -n "$unit" ]; then
    paths=$(systemctl show -p WorkingDirectory -p ExecStart --value -- "$unit" 2>/dev/null)
    local h
    for h in "$root" "${EMBERVY_HOME%/}"; do
      [ -n "$h" ] && [ "$h" != / ] || continue
      case "$paths" in *"$h"/*|*"$h"$'\n'*|*"$h") return 0;; esac
    done
    case "$paths" in */opt/embervy*|*/opt/*/Brain/*|*/opt/*/Claude/*|*/opt/*/shared/*) return 1;; esac
  fi
  cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)
  case "$cwd" in "$root"|"$root"/*) return 0;; esac
  # Redirect stderr before opening procfs: the process may have just exited.
  while IFS= read -r -d '' arg; do
    case "$arg" in "$root"/*) return 0;; esac
  done 2>/dev/null < "/proc/$pid/cmdline"
  return 1
}

embervy_house_pids() {
  local pid found=1
  for pid in $(pgrep "$@" 2>/dev/null); do
    if embervy_owns_pid "$pid"; then printf '%s\n' "$pid"; found=0; fi
  done
  return "$found"
}

embervy_chatgpt_auth() {
  if [ -n "${CHATGPT_AUTH_FILE:-}" ]; then printf '%s\n' "$CHATGPT_AUTH_FILE"
  elif [ -n "${EMBERVY_TMUX_SOCKET:-}" ]; then printf '%s/state/chatgpt-auth.json\n' "$EMBERVY_HOME"
  else printf '%s/.codex/auth.json\n' "$HOME"; fi
}

# Shared CLI settings can run an installation's hooks in unrelated sessions.
embervy_project_dir_name() { printf '%s' "$1" | sed 's#[^A-Za-z0-9]#-#g'; }

embervy_hook_owns_input() {
  local input="$1" home="$2" transcript dir resolved
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  [ -n "$transcript" ] || return 0
  [ -n "$home" ] || return 0
  # Without a recognized project path, there is no installation identity to compare; allow the hook.
  case "$transcript" in */projects/*/*) ;; *) return 0;; esac
  dir=${transcript##*/projects/}; dir=${dir%%/*}
  [ "$dir" = "$(embervy_project_dir_name "$home")" ] && return 0
  resolved=$(readlink -f -- "$home" 2>/dev/null) || resolved=""
  [ -n "$resolved" ] && [ "$dir" = "$(embervy_project_dir_name "$resolved")" ]
}
