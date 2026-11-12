#!/bin/bash
HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME
export PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin"
# Supervises runtime restarts, crash backoff and configuration reloads.
# Never kill by working directory: other agents may share it.

. "$(dirname "$0")/brain-env.sh"

TMUX_SESSION="${BRAIN_TMUX_SESSION:-brain}"
TMUX_ARGS=(-L "$(brain_tmux_socket)")

if [ -n "${TMUX:-}" ]; then
  if [ "$(basename -- "${TMUX%%,*}")" != "$(brain_tmux_socket)" ]; then
    unset TMUX TMUX_PANE
  fi
fi
if [ -z "${TMUX:-}" ] && [ "${BRAIN_LOOP_NO_TMUX:-}" != "1" ]; then
  if [ -t 1 ]; then
    if tmux "${TMUX_ARGS[@]}" has-session -t "$TMUX_SESSION" 2>/dev/null; then
      exec tmux "${TMUX_ARGS[@]}" attach -t "$TMUX_SESSION"
    fi
    exec tmux "${TMUX_ARGS[@]}" new-session -s "$TMUX_SESSION" -c "$BRAIN_HOME" "$0 $*"
  else
    # Attaching requires a terminal; detached supervision keeps systemd tracking the session.
    if ! tmux "${TMUX_ARGS[@]}" has-session -t "$TMUX_SESSION" 2>/dev/null; then
      tmux "${TMUX_ARGS[@]}" new-session -d -s "$TMUX_SESSION" -c "$BRAIN_HOME" "$0 $*" || exit 1
    fi
    while tmux "${TMUX_ARGS[@]}" has-session -t "$TMUX_SESSION" 2>/dev/null; do sleep 10; done
    exit 0
  fi
fi

cd "$BRAIN_HOME" || exit 1
mkdir -p "$BRAIN_LOG_DIR" "$BRAIN_STATE_DIR"
LOG="$BRAIN_LOG_DIR/brain-loop.log"
rm -f "$BRAIN_STATE_DIR/brain_stopped"

# The wrapper needs a persistent stop marker to suppress systemd restart.
stop_if_marked() {
  [ -f "$BRAIN_STATE_DIR/brain_stop" ] || return 0
  rm -f "$BRAIN_STATE_DIR/brain_stop"
  date -Iseconds > "$BRAIN_STATE_DIR/brain_stopped" 2>/dev/null || true
  echo "$(date -Iseconds) loop: stop marker found — not restarting" >> "$LOG"
  exit 0
}

BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
[ -z "$BUN_BIN" ] && for c in /usr/local/bin/bun "$HOME/.bun/bin/bun"; do [ -x "$c" ] && BUN_BIN="$c" && break; done
BRAIN_CMD="${BRAIN_CMD:-$BUN_BIN $BRAIN_HOME/brain.ts}"

resolve_effective_head() {
  EFFECTIVE_HEAD="$("$BUN_BIN" "$BRAIN_TEXTS_DIR/effective-head.ts" 2>/dev/null)" || EFFECTIVE_HEAD="${BRAIN_HEAD:-api}"
  EFFECTIVE_HEAD="${EFFECTIVE_HEAD:-${BRAIN_HEAD:-api}}"
}

notify_runtime_swap() {
  local rc="$1" reason
  case "$rc" in
    0)   reason="$(brain_text loop.clean)" ;;
    2)   reason="$(brain_text loop.guard)" ;;
    143) reason="SIGTERM" ;;
    137) reason="SIGKILL (OOM?)" ;;
    *)   reason="$(brain_text loop.crash "$rc")" ;;
  esac
  resolve_effective_head
  # Only the opt-in cut suppresses clean same-head restart notices.
  if [ "${BRAIN_QUICK_CUT:-off}" = "on" ] && [ "$rc" = "0" ] && [ -n "${STARTED_HEAD:-}" ] && [ "$EFFECTIVE_HEAD" = "$STARTED_HEAD" ]; then
    echo "$(date -Iseconds) loop: quiet restart (rc=0, head $EFFECTIVE_HEAD)" >> "$LOG"
    return 0
  fi
  brain_notify_app "$(brain_text loop.restart "$reason" "$EFFECTIVE_HEAD")"
  echo "$(date -Iseconds) loop: notify_runtime_swap (rc=$rc)" >> "$LOG"
}

# A backend label or port alone never proves ownership of a listener.
brain_trim() { local v="$1"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }
GPT_ADAPTER_PORT="$(brain_trim "${GPT_ADAPTER_PORT:-}")"
[ -n "$GPT_ADAPTER_PORT" ] || GPT_ADAPTER_PORT="$(brain_trim "${BRAIN_GPT_ADAPTER_PORT:-}")"
GPT_ADAPTER_PORT="${GPT_ADAPTER_PORT:-3041}"
if [[ "$GPT_ADAPTER_PORT" =~ ^[0-9]{1,5}$ ]] && [ "$((10#$GPT_ADAPTER_PORT))" -ge 1 ] && [ "$((10#$GPT_ADAPTER_PORT))" -le 65535 ]; then
  GPT_ADAPTER_PORT="$((10#$GPT_ADAPTER_PORT))"
fi
export GPT_ADAPTER_PORT
export BRAIN_GPT_ADAPTER_PORT="$GPT_ADAPTER_PORT"

brain_adapter_health() {
  local port="$1" identity="$2" timeout="$3" model="$4" body rc=0
  body="$(curl -s -m "$timeout" -w '\n%{http_code}' "http://127.0.0.1:${port}/health" 2>/dev/null)" || rc=$?
  printf '%s' "$body" | python3 -c '
import json,sys,subprocess,re,base64,os
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ["BRAIN_TEXTS_DIR"])
from brain_texts import tr
port,identity,rc,model=int(sys.argv[1]),sys.argv[2],int(sys.argv[3]),sys.argv[4]
raw=sys.stdin.read()
if rc:
    # Only a refused connection AND a demonstrably empty local port permit a
    # start. Timeouts/unknown listeners are never treated as absent.
    free=False
    if rc == 7:
        try:
            rows=[]
            for path in ("/proc/net/tcp", "/proc/net/tcp6"):
                with open(path) as f: rows += f.read().splitlines()[1:]
            free=not any(r.split()[3]=="0A" and int(r.split()[1].split(":")[1],16)==port for r in rows)
        except Exception: pass
    print("absent" if free else "unknown")
else:
    try:
        text,status=raw.rsplit("\n",1); h=json.loads(text)
        own=isinstance(h,dict) and h.get("backend")=="chatgpt-oauth" and h.get("identity")==identity and type(h.get("port")) is int and h["port"]==port
        matching=False
        if own:
            try:
                unit="brain-gpt-adapter-"+identity+".service"
                metadata=subprocess.check_output(["systemctl","--system","show",unit,"--property=Environment"],text=True,timeout=10)
                properties=dict(line.split("=",1) for line in metadata.splitlines() if "=" in line)
                m=re.search(r"(?:^|\s)\"?BRAIN_GPT_UNIT_PLAN=([A-Za-z0-9+/=]+)",properties.get("Environment",""))
                e={k:v for k,v in json.loads(base64.b64decode(m[1]))["env"].items() if isinstance(v,str) and v.strip("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")}
                expected=dict(effort=e.get("ADAPTER_EFFORT"),verbosity=e.get("ADAPTER_VERBOSITY"),reasoning_context=e.get("ADAPTER_REASONING_CONTEXT"),
                    reasoning_replay=e.get("ADAPTER_REASONING_REPLAY")!="0",web_search=e.get("ADAPTER_WEB_SEARCH")=="1",
                    native_web_search=e.get("ADAPTER_NATIVE_WEB_SEARCH")=="1",turn_state_recovery={} if e.get("ADAPTER_TURN_STATE_RECOVERY")=="1" else None)
                fields=[k for k,v in expected.items() if k not in h or
                    (not isinstance(h[k],dict) if k=="turn_state_recovery" and v is not None else type(h[k]) is not type(v) or h[k]!=v)]
                matching=not fields
                if fields: print(tr("loop: health fields do not match unit plan (different/missing): {0}", ", ".join(fields)),file=sys.stderr)
            except Exception: print(tr("loop: health knob match unproven without readable unit plan"),file=sys.stderr)
        print("ready" if own and matching and h.get("ok") is True and h.get("model")==model and 200<=int(status)<300 else "owned" if own else "foreign")
    except Exception: print("foreign")
' "$port" "$identity" "$rc" "$model" 2>>"$LOG" || printf 'unknown\n'
}
# Passive ownership proof: manager metadata AND the listener belongs to MainPID.
brain_adapter_unit_owned() {
  systemctl --system show "$1" --property=Id,LoadState,ActiveState,Transient,Description,MainPID,InvocationID,Environment 2>/dev/null | python3 -c '
import sys,json,base64,re,os
try:
    p=dict(line.split("=",1) for line in sys.stdin.read().splitlines() if "=" in line)
    unit,identity,port=sys.argv[1],sys.argv[2],int(sys.argv[3])
    assert p.get("Id")==unit and p.get("Transient")=="yes" and p.get("ActiveState")=="active"
    assert p.get("Description")=="Brain GPT adapter "+identity
    m=re.search(r"(?:^|\s)\"?BRAIN_GPT_UNIT_PLAN=([A-Za-z0-9+/=]+)",p.get("Environment",""))
    plan=json.loads(base64.b64decode(m[1])); assert plan["unit"]==unit
    assert plan["env"]["ADAPTER_CACHE_KEY"]==os.environ.get("BRAIN_GPT_CACHE_KEY","")
    assert plan["env"]["ADAPTER_PORT"]==str(port)
    assert isinstance(plan["env"].get("ADAPTER_MODEL"),str) and plan["env"]["ADAPTER_MODEL"]
    with open(sys.argv[5]) as f: owner=json.load(f)
    assert owner["unit"]==unit and owner["launchId"]==plan["launchId"]
    assert owner["invocation"] and owner["invocation"]==p.get("InvocationID")
    inodes=set()
    for path in ("/proc/net/tcp","/proc/net/tcp6"):
        with open(path) as f:
            for line in f.read().splitlines()[1:]:
                c=line.split()
                if c[3]=="0A" and int(c[1].split(":")[1],16)==port: inodes.add(c[9])
    assert inodes
    pid=int(p["MainPID"]); assert pid>1
    sockets=set()
    for fd in os.listdir("/proc/%s/fd"%pid):
        try:
            link=os.readlink("/proc/%s/fd/%s"%(pid,fd))
            if link.startswith("socket:["): sockets.add(link[8:-1])
        except OSError: pass
    assert inodes.issubset(sockets)
except Exception: sys.exit(1)
' "$1" "$2" "$3" "$4" "$BRAIN_STATE_DIR/$1.owner.json"
}
brain_adapter_profile_matches() {
  systemctl --system show "$1" --property=Environment 2>/dev/null | python3 -c '
import sys,json,base64,re,os
sys.dont_write_bytecode = True
sys.path.insert(0, os.environ["BRAIN_TEXTS_DIR"])
from brain_texts import tr
try:
    p=dict(line.split("=",1) for line in sys.stdin.read().splitlines() if "=" in line)
    m=re.search(r"(?:^|\s)\"?BRAIN_GPT_UNIT_PLAN=([A-Za-z0-9+/=]+)",p.get("Environment",""))
    profile=lambda e: {k:v for k,v in e.items() if re.fullmatch(r"ADAPTER_[A-Z0-9_]+",k) and isinstance(v,str) and v.strip("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")}
    saved=json.loads(base64.b64decode(m[1]))["env"]
    actual=profile(saved); actual["CHATGPT_AUTH_FILE"]=saved.get("CHATGPT_AUTH_FILE")
    desired=profile(os.environ)
    auth=os.environ.get("CHATGPT_AUTH_FILE", "").strip() or os.path.join(os.environ["HOME"],".codex","auth.json")
    if auth.startswith("~/"): auth=os.path.join(os.environ["HOME"],auth[2:])
    desired.update(ADAPTER_PORT=sys.argv[1],ADAPTER_MODEL=sys.argv[2],ADAPTER_CACHE_KEY=os.environ.get("BRAIN_GPT_CACHE_KEY",""),CHATGPT_AUTH_FILE=auth)
    fields=sorted(k for k in set(actual)|set(desired) if actual.get(k)!=desired.get(k))
    if fields:
        print(tr("loop: desired profile differs from unit plan: {0} — Brain must transact/recover", ", ".join(fields)),file=sys.stderr)
        sys.exit(1)
except Exception:
    print(tr("loop: unit profile cannot be checked — Brain must transact/recover"),file=sys.stderr); sys.exit(1)
' "$2" "$3" 2>>"$LOG"
}
# Capture only directly after our systemd-run, never on reuse.
brain_adapter_capture_invocation() {
  systemctl --system show "$1" --property=InvocationID,Environment 2>/dev/null | python3 -c '
import sys,json,base64,re
try:
    p=dict(line.split("=",1) for line in sys.stdin.read().splitlines() if "=" in line)
    m=re.search(r"BRAIN_GPT_UNIT_PLAN=([A-Za-z0-9+/=]+)",p.get("Environment",""))
    plan=json.loads(base64.b64decode(m[1]))
    assert plan["unit"]==sys.argv[1] and plan["launchId"]==sys.argv[2] and p.get("InvocationID")
    print(p["InvocationID"])
except Exception: sys.exit(1)
' "$1" "$2"
}
# A failed start is cleaned only by its captured InvocationID, never by health.
brain_adapter_cleanup_launch() {
  local unit="$1" launch="$2" invocation="$3" current
  [ -n "$invocation" ] || return 0
  current="$(brain_adapter_capture_invocation "$unit" "$launch")" || return 0
  if [ "$current" = "$invocation" ]; then
    systemctl --system stop "$unit" >> "$LOG" 2>&1 || echo "loop: own-unit cleanup failed" >> "$LOG"
  else
    echo "loop: InvocationID replaced — no stop" >> "$LOG"
  fi
}
ensure_gpt_adapter() {
  [ "$EFFECTIVE_HEAD" = "gpt" ] || return 0
  local port="$GPT_ADAPTER_PORT" cache identity status script auth model unit launch invocation metadata adapter_log cwd binary start_rc=0
  cache="${BRAIN_GPT_CACHE_KEY:-}"
  if ! LC_ALL=C grep -qxE '[A-Za-z0-9._-]{1,128}' <<< "$cache" || [[ "$cache" == *$'\n'* ]]; then
    echo "$(date -Iseconds) $(brain_text 'loop: unavailable: BRAIN_GPT_CACHE_KEY is missing or invalid (set a resident-unique key) — no intervention')" >> "$LOG"; return 0
  fi
  if ! command -v systemctl >/dev/null || ! command -v systemd-run >/dev/null || ! systemctl --system show --property=Version --value >/dev/null 2>&1; then
    echo "$(date -Iseconds) $(brain_text 'loop: systemd unavailable (no system bus) — no intervention')" >> "$LOG"; return 0
  fi
  if ! [[ "$port" =~ ^[0-9]{1,5}$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "$(date -Iseconds) loop: invalid GPT adapter port — no start" >> "$LOG"; return 0
  fi
  model="$(brain_trim "${BRAIN_GPT_MODEL:-}")"; model="${model:-gpt-5.6-terra}"
  identity="$(printf '%s' "gpt-adapter:$cache" | sha256sum | cut -c1-16)"
  unit="brain-gpt-adapter-${identity}.service"
  status="$(brain_adapter_health "$port" "$identity" 3 "$model")"
  case "$status" in
    ready|owned)
      if ! brain_adapter_unit_owned "$unit" "$identity" "$port" "$model"; then
        echo "$(date -Iseconds) $(brain_text 'loop: adapter not in own unit — no takeover; manually retire previous autostart, then /head gpt')" >> "$LOG"
      elif ! brain_adapter_profile_matches "$unit" "$port" "$model"; then
        : # diagnosed above; only Brain may transact/roll back
      elif [ "$status" != "ready" ]; then
        echo "$(date -Iseconds) loop: own unit not healthy/matching model — Brain must transact/recover" >> "$LOG"
      fi
      return 0 ;;
    foreign|unknown) echo "$(date -Iseconds) loop: foreign/old or unidentified adapter on :$port — no start, no intervention; Brain will refuse" >> "$LOG"; return 0 ;;
    absent) ;;
    *) echo "$(date -Iseconds) loop: health proof failed — no start" >> "$LOG"; return 0 ;;
  esac
  script="$(brain_trim "${BRAIN_GPT_ADAPTER:-}")"
  [[ "$script" == '~/'* ]] && script="$HOME/${script:2}"
  [ -n "$script" ] && [ -r "$script" ] || { echo "$(date -Iseconds) loop: BRAIN_GPT_ADAPTER missing/unreadable — no start" >> "$LOG"; return 0; }
  auth="$(brain_trim "${CHATGPT_AUTH_FILE:-}")"; auth="${auth:-$HOME/.codex/auth.json}"
  [[ "$auth" == '~/'* ]] && auth="$HOME/${auth:2}"
  # A unit can exist before its port starts listening; do not overwrite it.
  if [ "$(systemctl --system show "$unit" --property=LoadState --value 2>/dev/null)" != "not-found" ]; then
    echo "$(date -Iseconds) loop: unit exists/not inspectable — no start, Brain must recover" >> "$LOG"; return 0
  fi
  cwd="$(pwd -P)"; binary="$(command -v "$BUN_BIN")"
  script="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$script")"
  adapter_log="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "$BRAIN_LOG_DIR/chatgpt-oauth-adapter.log")"
  launch="$(python3 -c 'import uuid; print(uuid.uuid4())')"
  metadata="$(python3 -c '
import json,base64,sys,os,re
unit,launch,binary,script,cwd,log,port,model,key,auth=sys.argv[1:]
e={k:v for k,v in os.environ.items() if re.fullmatch(r"ADAPTER_[A-Z0-9_]+",k) and v.strip("\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")}
e.update(ADAPTER_PORT=port,ADAPTER_MODEL=model,ADAPTER_CACHE_KEY=key,CHATGPT_AUTH_FILE=auth)
p=dict(unit=unit,launchId=launch,binary=binary,script=script,cwd=cwd,logFile=log,env=e)
print(base64.b64encode(json.dumps(p).encode()).decode())
' "$unit" "$launch" "$binary" "$script" "$cwd" "$adapter_log" "$port" "$model" "$cache" "$auth")"
  local -a adapter_env_args=()
  mapfile -d '' -t adapter_env_args < <(python3 -c '
import json,base64,sys
for k,v in json.loads(base64.b64decode(sys.argv[1]))["env"].items():
    sys.stdout.buffer.write(("--setenv="+k+"="+v).encode()+b"\x00")
' "$metadata")
  echo "$(date -Iseconds) loop: starting own chatgpt-oauth adapter as $unit on :$port" >> "$LOG"
  systemd-run --unit="$unit" --collect --quiet --service-type=exec --description="Brain GPT adapter $identity" \
    --property=Restart=no --property=KillMode=control-group --property=TimeoutStopSec=2s --property=SendSIGKILL=yes \
    --property="WorkingDirectory=$cwd" --property="StandardOutput=append:$adapter_log" --property="StandardError=append:$adapter_log" \
    --setenv="HOME=$HOME" "${adapter_env_args[@]}" \
    --setenv="BRAIN_GPT_UNIT_PLAN=$metadata" -- "$binary" "$script" >> "$LOG" 2>&1 || start_rc=$?
  invocation="$(brain_adapter_capture_invocation "$unit" "$launch")" || {
    echo "loop: own invocation not captured — no readiness, no unproven stop" >> "$LOG"; return 0;
  }
  if [ "$start_rc" != "0" ]; then
    brain_adapter_cleanup_launch "$unit" "$launch" "$invocation"
    echo "$(date -Iseconds) loop: systemd-run failed — no adapter readiness" >> "$LOG"; return 0
  fi
  if ! python3 -c '
import os,json,sys,tempfile
unit,launch,invocation,path=sys.argv[1:]
fd,tmp=tempfile.mkstemp(dir=os.path.dirname(path))
try:
    with os.fdopen(fd,"w") as f: json.dump(dict(unit=unit,launchId=launch,invocation=invocation),f)
    os.replace(tmp,path)
finally:
    if os.path.exists(tmp): os.unlink(tmp)
' "$unit" "$launch" "$invocation" "$BRAIN_STATE_DIR/$unit.owner.json"; then
    brain_adapter_cleanup_launch "$unit" "$launch" "$invocation"
    echo "loop: invocation persistence failed — no readiness" >> "$LOG"; return 0
  fi
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    status="$(brain_adapter_health "$port" "$identity" 2 "$model")"
    if [ "$status" = "ready" ] && brain_adapter_unit_owned "$unit" "$identity" "$port" "$model"; then return 0; fi
    [ "$status" = "foreign" ] && break
    sleep 1
  done
  brain_adapter_cleanup_launch "$unit" "$launch" "$invocation"
  echo "$(date -Iseconds) loop: own unit did not become ready; launch cleaned up (Brain will refuse/recover)" >> "$LOG"
}

STOP_REQUESTED=0
trap 'STOP_REQUESTED=1; echo "$(date -Iseconds) loop: shell signal — Brain gets its own SIGTERM and archives; loop stops after it" >> "$LOG"' TERM INT

LOOP_SELF_HASH="$(md5sum "$0" 2>/dev/null | awk '{print $1}')"
LOOP_ENV_HASH="$(md5sum "$BRAIN_HOME/brain.env" 2>/dev/null | awk '{print $1}')"
# Configuration re-execs must not erase the rapid-crash window.
read -r -a CRASH_TIMES <<< "${LOOP_CRASH_TIMES:-}"
ITER=0

while true; do
  __self_hash="$(md5sum "$0" 2>/dev/null | awk '{print $1}')"
  if [ -n "$LOOP_SELF_HASH" ] && [ -n "$__self_hash" ] && [ "$__self_hash" != "$LOOP_SELF_HASH" ]; then
    if bash -n "$0" 2>>"$LOG"; then
      echo "$(date -Iseconds) loop: SELF-RELOAD — script changed, exec'ing fresh version" >> "$LOG"
      exec bash "$0" "$@"
    else
      echo "$(date -Iseconds) loop: SELF-RELOAD SKIPPED — new version has syntax errors, keeping old" >> "$LOG"
    fi
  fi
  __env_hash="$(md5sum "$BRAIN_HOME/brain.env" 2>/dev/null | awk '{print $1}')"
  if [ "${BRAIN_NO_ENV_FILE:-}" != "1" ] && [ "$__env_hash" != "$LOOP_ENV_HASH" ]; then
    echo "$(date -Iseconds) loop: ENV-RELOAD — brain.env changed, exec'ing with the new values" >> "$LOG"
    exec bash "$0" "$@"
  fi

  stop_if_marked
  if [ -n "${BRAIN_LOOP_MAX_ITER:-}" ] && [ "$ITER" -ge "$BRAIN_LOOP_MAX_ITER" ]; then
    echo "$(date -Iseconds) loop: max iterations ($BRAIN_LOOP_MAX_ITER) reached" >> "$LOG"
    exit 0
  fi
  ITER=$((ITER + 1))

  resolve_effective_head
  ensure_gpt_adapter
  if [ -s "$BRAIN_BRIDGE_FILE" ]; then
    echo "$(date -Iseconds) loop: starting brain (iter=$ITER, bridge $(stat -c%s "$BRAIN_BRIDGE_FILE") bytes)" >> "$LOG"
  else
    echo "$(date -Iseconds) loop: starting brain (iter=$ITER, no bridge)" >> "$LOG"
  fi
  resolve_effective_head
  STARTED_HEAD="$EFFECTIVE_HEAD"
  # shellcheck disable=SC2086
  $BRAIN_CMD
  rc=$?
  NOW=$(date +%s)
  echo "$(date -Iseconds) loop: brain exited rc=$rc" >> "$LOG"
  stop_if_marked

  if [ "$STOP_REQUESTED" = "1" ]; then
    echo "$(date -Iseconds) loop: stopping after shell signal" >> "$LOG"
    exit 0
  fi

  # Export the counter so self-exec preserves consecutive refusals.
  if [ "$rc" = "2" ]; then export LOOP_GUARD_REFUSALS=$(( ${LOOP_GUARD_REFUSALS:-0} + 1 )); else export LOOP_GUARD_REFUSALS=0; fi

  case "$rc" in
    0|129|130|143)
      CRASH_TIMES=()
      ;;
    2)
      echo "$(date -Iseconds) loop: guard refused start — waiting ${BRAIN_GUARD_SLEEP:-60}s" >> "$LOG"
      # A second refusal warrants a notice; a single handover refusal should stay quiet.
      if [ "$LOOP_GUARD_REFUSALS" -eq 2 ]; then
        brain_notify_app "$(brain_text loop.guard_refused "${BRAIN_WORKER_NAME:-Brain}" "$(head -c 300 "$BRAIN_STATE_DIR/guard_refused" 2>/dev/null)")"
        echo "$(date -Iseconds) loop: guard refusal notice sent" >> "$LOG"
      fi
      sleep "${BRAIN_GUARD_SLEEP:-60}"
      ;;
    *)
      CRASH_TIMES+=("$NOW")
      RECENT=()
      for t in "${CRASH_TIMES[@]}"; do [ $((NOW - t)) -le 30 ] && RECENT+=("$t"); done
      CRASH_TIMES=("${RECENT[@]}")
      if [ "${#CRASH_TIMES[@]}" -ge 3 ]; then
        echo "$(date -Iseconds) loop: 3 crashes in <30s — waiting ${BRAIN_CRASH_SLEEP:-60}s" >> "$LOG"
        CRASH_TIMES=()
        sleep "${BRAIN_CRASH_SLEEP:-60}"
      else
        echo "$(date -Iseconds) loop: crash #${#CRASH_TIMES[@]} — restarting with the exit-hook bridge" >> "$LOG"
      fi
      ;;
  esac

  export LOOP_CRASH_TIMES="${CRASH_TIMES[*]}"

  # The exiting process may have changed the file. Refresh before notifying or
  # sleeping, but leave the supervisor's paths and ownership snapshot for re-exec.
  (
    if [ "${BRAIN_NO_ENV_FILE:-}" != "1" ]; then
      brain_load_env_file "$BRAIN_HOME/brain.env"
    fi
    [ "$rc" != "2" ] && notify_runtime_swap "$rc"
    sleep "${BRAIN_RESTART_SLEEP:-2}"
  )

  if [ -f "$BRAIN_STATE_DIR/loop_reload" ]; then
    rm -f "$BRAIN_STATE_DIR/loop_reload"
    echo "$(date -Iseconds) loop: reload marker found — re-execing self" >> "$LOG"
    exec bash "$0" "$@"
  fi
done
