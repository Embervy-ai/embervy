# shellcheck shell=bash
# env-file.sh — read an Embervy .env file as DATA, never as a program.
#
# Hooks and scripts read values without expansion, substitution or execution.
#
# The format and the reading are defined once, in env-file.ts next to this
# file (the installer writes with it); this is the same reading in bash:
# systemd's EnvironmentFile grammar — '…' literal; "…" with \" \\ \` \$ as
# escapes, any other backslash kept; outside quotes a backslash takes the next
# character literally and trailing blanks are dropped — plus an optional
# leading `export `, a # after a blank outside quotes starting a comment, and
# no value spanning two lines (an unterminated quote drops that line, with a
# warning naming the key on stderr — never the value).
#
#   embervy_env_load [-x] FILE...   assign every KEY=value as a shell variable
#                                  (-x: export them too, like `set -a; source`)
#   embervy_env_each FILE FN        call FN KEY VALUE for every assignment
#
# Missing files are skipped. Keys must be plain names ([A-Za-z_][A-Za-z0-9_]*);
# the few that would reconfigure the reading shell itself (IFS, GLOBIGNORE,
# TMOUT, BASH_*, SHELLOPTS, …) are ignored with a warning, and readonly ones
# (UID, PPID, …) are left alone.

# __embervy_env_parse_line LINE
#   0: an assignment — __EMBERVY_ENV_KEY / __EMBERVY_ENV_VAL are set
#   1: nothing to assign (blank, comment, no valid KEY=)
#   2: unterminated quote — __EMBERVY_ENV_KEY names the key
__embervy_env_parse_line() {
  local LC_ALL=C
  local s=$1 rest key val="" state=pre ws=0 chomp=-1 i n c nx
  local re_export='^export[[:blank:]]+' re_key='^[A-Za-z_][A-Za-z0-9_]*$' re_bare='^[A-Za-z0-9_@%+=:,./-]*$'
  s=${s#"${s%%[![:blank:]]*}"}
  case $s in '' | '#'* | ';'*) return 1 ;; esac
  if [[ $s =~ $re_export ]]; then s=${s:${#BASH_REMATCH[0]}}; fi
  case $s in *=*) ;; *) return 1 ;; esac
  key=${s%%=*}
  rest=${s#*=}
  key=${key%"${key##*[![:blank:]]}"}
  if ! [[ $key =~ $re_key ]]; then return 1; fi
  __EMBERVY_ENV_KEY=$key
  if [[ $rest =~ $re_bare ]]; then
    __EMBERVY_ENV_VAL=$rest
    return 0
  fi
  n=${#rest}
  for ((i = 0; i < n; i++)); do
    c=${rest:i:1}
    if [[ $state == sq ]]; then
      if [[ $c == "'" ]]; then state=pre; ws=0; else val+=$c; fi
      continue
    fi
    if [[ $state == dq ]]; then
      if [[ $c == '"' ]]; then
        state=pre; ws=0
      elif [[ $c == '\' ]]; then
        if ((i + 1 >= n)); then return 2; fi
        i=$((i + 1)); nx=${rest:i:1}
        case $nx in '"' | '\' | '`' | '$') val+=$nx ;; *) val+="\\$nx" ;; esac
      else
        val+=$c
      fi
      continue
    fi
    case $c in
      $'\r') break ;;
      ' ' | $'\t')
        if [[ $state == val ]]; then
          if ((chomp < 0)); then chomp=${#val}; fi
          val+=$c
        fi
        ws=1
        continue
        ;;
    esac
    if [[ $c == '#' ]] && ((ws)); then break; fi
    ws=0
    if [[ $state == pre ]]; then
      if [[ $c == "'" ]]; then state=sq; continue; fi
      if [[ $c == '"' ]]; then state=dq; continue; fi
    fi
    if [[ $c == '\' ]]; then
      if ((i + 1 < n)); then i=$((i + 1)); val+=${rest:i:1}; fi
      state=val; chomp=-1
      continue
    fi
    state=val; val+=$c; chomp=-1
  done
  if [[ $state == sq || $state == dq ]]; then return 2; fi
  if [[ $state == val ]] && ((chomp >= 0)); then val=${val:0:chomp}; fi
  __EMBERVY_ENV_VAL=$val
  return 0
}

embervy_env_each() {
  local __embervy_env_file=$1 __embervy_env_fn=$2 __embervy_env_line __embervy_env_no=0 __embervy_env_rc
  [[ -f $__embervy_env_file && -r $__embervy_env_file ]] || return 0
  while IFS= read -r __embervy_env_line || [[ -n $__embervy_env_line ]]; do
    __embervy_env_no=$((__embervy_env_no + 1))
    __embervy_env_rc=0
    __embervy_env_parse_line "$__embervy_env_line" || __embervy_env_rc=$?
    if ((__embervy_env_rc == 0)); then
      "$__embervy_env_fn" "$__EMBERVY_ENV_KEY" "$__EMBERVY_ENV_VAL" || true
    elif ((__embervy_env_rc == 2)); then
      printf 'env-file: %s line %d: the quote of %s does not close — line ignored\n' "$__embervy_env_file" "$__embervy_env_no" "$__EMBERVY_ENV_KEY" >&2
    fi
  done <"$__embervy_env_file"
  return 0
}

__embervy_env_set() {
  local __embervy_env_name=$1
  case $__embervy_env_name in
    IFS | GLOBIGNORE | TMOUT | SHELLOPTS | BASHOPTS | BASH_ENV | ENV | PS4 | PROMPT_COMMAND | POSIXLY_CORRECT | FUNCNEST | BASH_*)
      printf 'env-file: %s is a setting of the shell itself, not configuration — ignored\n' "$__embervy_env_name" >&2
      return 0
      ;;
  esac
  # A readonly name (UID, EUID, PPID, …) would end the shell; leave it alone.
  if [[ -v $__embervy_env_name && ${!__embervy_env_name@a} == *r* ]]; then return 0; fi
  printf -v "$__embervy_env_name" '%s' "$2" 2>/dev/null || return 0
  if [[ ${__EMBERVY_ENV_EXPORT:-0} == 1 ]]; then export "$__embervy_env_name"; fi
  return 0
}

embervy_env_load() {
  local __embervy_env_x=0 __embervy_env_f
  if [[ ${1:-} == -x ]]; then __embervy_env_x=1; shift; fi
  for __embervy_env_f in "$@"; do
    __EMBERVY_ENV_EXPORT=$__embervy_env_x
    embervy_env_each "$__embervy_env_f" __embervy_env_set
  done
  __EMBERVY_ENV_EXPORT=0
  return 0
}

# Share tool defaults with transcript readers.
. "$(dirname -- "${BASH_SOURCE[0]}")/legacy-names.sh"
embervy_tool_name_defaults
