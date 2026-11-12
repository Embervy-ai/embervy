# shellcheck shell=bash
# Keep shell consumers on the same configuration and tool names as TypeScript.

# Preserve the sourced interface without creating additional environment keys.
embervy_env_bridge() { return 0; }
embervy_env_legacy_key() { return 1; }

embervy_home_default() {
  printf '%s\n' /opt/embervy
}

embervy_app_server_name() {
  printf '%s\n' app
}

embervy_is_subturn() {
  [[ "${EMBERVY_BRAIN_SUBTURN:-}" == 1 ]]
}

embervy_app_tool_names() {
  local __embervy_tool __embervy_out=()
  for __embervy_tool in "$@"; do __embervy_out+=("mcp__app__${__embervy_tool}"); done
  printf '%s\n' "${__embervy_out[*]}"
}

embervy_unit_name() {
  printf '%s\n' "embervy-$1.service"
}

embervy_tool_name_defaults() {
  if [[ -z ${REPLY_TOOL_NAMES:-} ]]; then
    REPLY_TOOL_NAMES="$(embervy_app_tool_names reply send)"
    REPLY_TOOL_NAMES="${REPLY_TOOL_NAMES// /,}"
    export REPLY_TOOL_NAMES
  fi
  if [[ -z ${EMAIL_TOOL_NAMES:-} ]]; then
    EMAIL_TOOL_NAMES="$(embervy_app_tool_names email)"
    EMAIL_TOOL_NAMES="${EMAIL_TOOL_NAMES// /,}"
    export EMAIL_TOOL_NAMES
  fi
  return 0
}
