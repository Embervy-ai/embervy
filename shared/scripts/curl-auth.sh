# shellcheck shell=bash
# A function argument stays inside Bash; curl receives only an anonymous pipe path.
# Keep stdin available for request bodies and avoid secret-bearing temporary files.
embervy_curl_bearer() {
  local token="$1"
  shift
  case "$token" in *$'\r'*|*$'\n'*) printf '%s\n' 'Invalid bearer header' >&2; return 2;; esac
  if [ -n "$token" ]; then
    curl --header @<(printf 'Authorization: Bearer %s\n' "$token") "$@"
  else
    curl "$@"
  fi
}
