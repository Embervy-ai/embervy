#!/bin/bash
# Embervy reply gateway — Claude Stop hook and substrate-neutral poll mode.
# Delivery is a harness property: if a model ends a turn without calling the
# reply tool, this script classifies its text as REPLY or NOTE and broadcasts
# REPLY text to the app. Automation must mark prompts with [gateway:silent].
# Optional instance-specific markers: one literal marker per line in
# $GW_MARKER_FILE. Without OPENROUTER_API_KEY classification fails open: send.
set -uo pipefail

# Default HOME before use because systemd may omit it and set -u rejects unset variables.
HOME="${HOME:-/root}"
# Read .env as data and bridge inherited legacy settings to current names.
. "$(dirname -- "${BASH_SOURCE[0]}")/env-file.sh"
. "$(dirname -- "${BASH_SOURCE[0]}")/curl-auth.sh"
EMBERVY_HOME="${EMBERVY_HOME:-$(embervy_home_default)}"; export EMBERVY_HOME
APP_DIR="${APP_DIR:-$EMBERVY_HOME}"
STATE_DIR="${EMBERVY_GATEWAY_STATE_DIR:-$EMBERVY_HOME/state}"
LOG_DIR="${EMBERVY_GATEWAY_LOG_DIR:-$EMBERVY_HOME/logs}"
SRC="${GW_SOURCE:-hook}"
. "$(dirname -- "${BASH_SOURCE[0]}")/house-runtime.sh"
INPUT=$(cat)
if [ "$SRC" = hook ]; then embervy_hook_owns_input "$INPUT" "${EMBERVY_HOOK_HOME:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}" || exit 0; fi
MARKER_FILE="${GW_MARKER_FILE:-$STATE_DIR/gateway-automation-markers.txt}"
OFF_FILE="${GW_OFF_FILE:-$STATE_DIR/reply-gateway-off}"
mkdir -p "$STATE_DIR" "$LOG_DIR"
GWLOG="$LOG_DIR/reply-gateway.jsonl"
CACHE="$STATE_DIR/gateway-sent-hashes.log"
MARK="$STATE_DIR/gateway-sent-uuid"
UUID_LOG="$STATE_DIR/gateway-sent-uuids.log"
LOCK="$STATE_DIR/gateway.lock"
FAIL_COUNT_FILE="$STATE_DIR/gateway-consecutive-failures"
touch "$CACHE"
log(){ [ "$SRC" = poll ] && [ "$1" = skip ] && return; printf '{"ts":"%s","src":"%s","decision":"%s","detail":%s}\n' "$(date -Iseconds)" "$SRC" "$1" "$(printf %s "${2:-}" | head -c 200 | jq -Rs .)" >>"$GWLOG" 2>/dev/null || true; }
[ -f "$OFF_FILE" ] && { log skip kill-switch; exit 0; }
embervy_is_subturn && { log skip brain-subturn; exit 0; }

PROJECT_DIR="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}/$(printf '%s' "$EMBERVY_HOME" | tr / -)"
TRANSCRIPT=$(printf %s "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
if [ "$SRC" = hook ] && [ -n "$TRANSCRIPT" ]; then
  case "$(readlink -f -- "$TRANSCRIPT")" in "$(readlink -f -- "$PROJECT_DIR")"/*) ;; *) exit 0;; esac
fi
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  TRANSCRIPT=$(find "$PROJECT_DIR" -maxdepth 1 -type f -name '*.jsonl' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)
fi
[ -f "${TRANSCRIPT:-}" ] || { log skip no-transcript; exit 0; }
[ "$SRC" = hook ] && sleep 1.5

SCAN=$(python3 - "$TRANSCRIPT" "$MARKER_FILE" "$(embervy_app_tool_names reply send voice_reply)" <<'PY'
import json,re,sys
path,marker_file,tool_names=sys.argv[1:]
events=[]
for line in open(path,errors="ignore"):
 try:
  e=json.loads(line)
  if not e.get("isSidechain",False): events.append(e)
 except Exception: pass
def real_user(e):
 if e.get("type")!="user": return False
 c=(e.get("message") or {}).get("content")
 return not (isinstance(c,list) and any(isinstance(x,dict) and x.get("type")=="tool_result" for x in c))
idx=max((i for i,e in enumerate(events) if real_user(e)),default=-1)
if idx<0: print("SKIP:no-user"); raise SystemExit
c=(events[idx].get("message") or {}).get("content")
user="\n".join(x.get("text","") for x in c if isinstance(x,dict) and x.get("type")=="text") if isinstance(c,list) else (c or "")
markers=["Stop hook feedback","<<autonomous-loop","[gateway:silent]"]
try:
 markers += [x.strip() for x in open(marker_file) if x.strip() and not x.lstrip().startswith("#")]
except FileNotFoundError: pass
if any(m in user for m in markers): print("SKIP:automation"); raise SystemExit
tail=events[idx+1:]
# Share tool names with the shell defaults so delivery detection stays consistent.
tools=set(tool_names.split())
# Count each reply only after a successful tool_result so an early delivered
# reply cannot hide a later refused answer; successful retries settle that text.
ok={x.get("tool_use_id") for e in tail for x in ((e.get("message") or {}).get("content") or []) if isinstance(x,dict) and x.get("type")=="tool_result" and not x.get("is_error")}
room_turn=bool(re.search(r'<channel\b[^>]*\bkind="room"[^>]*>',user))
room_delivered=room_turn and any(
 isinstance(x,dict) and x.get("type")=="tool_use"
 and (x.get("name")=="room" or str(x.get("name","")).endswith("__room"))
 and x.get("id") and x.get("id") in ok
 for e in tail for x in ((e.get("message") or {}).get("content") or []))
delivered=[]; undelivered=[]
for e in tail:
 for x in ((e.get("message") or {}).get("content") or []):
  if isinstance(x,dict) and x.get("type")=="tool_use" and x.get("name") in tools:
   t=str((x.get("input") or {}).get("text") or "").strip()
   if x.get("id") and x.get("id") in ok:
    if t and t not in delivered: delivered.append(t)
   elif t and t not in undelivered: undelivered.append(t)
missing=[t for t in undelivered if t not in delivered]
blocks=[]; uuid=""
for e in tail:
 if e.get("type")!="assistant": continue
 uuid=e.get("uuid") or uuid
 for x in ((e.get("message") or {}).get("content") or []):
  if isinstance(x,dict) and x.get("type")=="text" and x.get("text","").strip(): blocks.append(x["text"].strip())
# The turn reached the user: only the replies that never arrived are owed,
# never the terminal text around them. Nothing reached the user: the replies
# that did not arrive go out in front of the turn's text.
if delivered or room_delivered:
 if not missing: print("SKIP:replied"); raise SystemExit
 print("OWED:"+uuid); print("\n\n".join(missing)); raise SystemExit
# [still] marks terminal text the agent keeps to itself, as Brain's gateway
# honours it; a reply that never arrived is still owed.
if any("[still]" in b for b in blocks):
 if not missing: print("SKIP:still"); raise SystemExit
 print("OWED:"+uuid); print("\n\n".join(missing)); raise SystemExit
print("SEND:"+uuid); print("\n\n".join(missing+blocks))
PY
)
VERDICT=$(printf %s "$SCAN" | head -1)
case "$VERDICT" in SKIP:*) log skip "$VERDICT"; exit 0;; esac
# OWED: reply-tool texts the user never got — meant for the user by the agent
# itself, so the REPLY/NOTE classifier does not get a say.
OWED=""; case "$VERDICT" in OWED:*) OWED=1;; esac
UUID=${VERDICT#SEND:}; UUID=${UUID#OWED:}; TEXT=$(printf %s "$SCAN" | tail -n +2)
[ -n "$TEXT" ] || { log skip empty-text; exit 0; }
[ -f "$MARK" ] && [ "$(cat "$MARK")" = "$UUID" ] && { log skip already-sent; exit 0; }
exec 9>"$LOCK"; flock -n 9 || { log skip lock-busy; exit 0; }
HASH=$(printf %s "$TEXT" | sha256sum | cut -d' ' -f1)
grep -qF "$HASH" "$CACHE" && { log skip duplicate; exit 0; }
embervy_env_load -x "$APP_DIR/.env" 2>/dev/null # data, never run (env-file.sh)
GATE=REPLY
if [ -z "$OWED" ] && [ -n "${OPENROUTER_API_KEY:-}" ]; then
 SNIP="$TEXT"; [ ${#TEXT} -gt 1600 ] && SNIP="$(printf %s "$TEXT"|head -c 700)\n[…]\n$(printf %s "$TEXT"|tail -c 800)"
 RAW=$(embervy_curl_bearer "$OPENROUTER_API_KEY" -sS --max-time 8 --fail-with-body https://openrouter.ai/api/v1/chat/completions -H 'Content-Type: application/json' -d "$(jq -n --arg t "$SNIP" '{model:"google/gemma-3-27b-it",max_tokens:5,messages:[{role:"user",content:("This is text from a complete AI-agent turn and may be in any language. If it contains any message directed at the user (addressing, reporting, asking, or instructing), answer REPLY. Only if everything is an internal work note, answer NOTE. When unsure answer REPLY. Answer only REPLY or NOTE.\n\n"+$t)}]}')" 2>>"$GWLOG.err" | jq -r '.choices[0].message.content // "REPLY"' 2>/dev/null || echo REPLY)
 case "$RAW" in *NOTE*) GATE=NOTE;; esac
fi
[ "$GATE" = NOTE ] && { log suppress gemma-note; exit 0; }
# Text and payload travel on stdin to avoid Linux's 128 KiB argument limit.
PAYLOAD=$(printf %s "$TEXT" | jq -Rs '{id:(now|tostring),text:.,ts:(now|todate),type:"send"}')
if embervy_curl_bearer "${INTERNAL_API_TOKEN:-}" -sS -o /dev/null --fail-with-body --connect-timeout 3 --max-time 10 -X POST "http://${EMBERVY_APP_HOST:-127.0.0.1}:${EMBERVY_APP_PORT:-3030}/api/internal/broadcast" -H 'Content-Type: application/json' --data-binary @- 2>>"$GWLOG.err" <<<"$PAYLOAD"; then
 echo "$HASH" >>"$CACHE"
 echo "$UUID" >"$MARK"
 if [ -n "$UUID" ]; then
  printf '%s\n' "$UUID" >>"$UUID_LOG"
  # The lock also covers compaction so concurrent sends cannot lose delivery records.
  if tail -n 5000 "$UUID_LOG" >"$UUID_LOG.tmp"; then
   mv -- "$UUID_LOG.tmp" "$UUID_LOG"
  else
   rm -f -- "$UUID_LOG.tmp"
  fi
 fi
 echo 0 >"$FAIL_COUNT_FILE"
 log sent "uuid=$UUID len=${#TEXT}"
else
 FAILURES=$(cat "$FAIL_COUNT_FILE" 2>/dev/null || echo 0)
 case "$FAILURES" in ''|*[!0-9]*) FAILURES=0;; esac
 FAILURES=$((FAILURES + 1))
 echo "$FAILURES" >"$FAIL_COUNT_FILE"
 log failed "uuid=$UUID consecutive=$FAILURES"
 if [ "$FAILURES" -ge 5 ]; then
  printf 'REPLY-GATEWAY DELIVERY FAILURE: %s consecutive POST failures; message remains retryable (uuid=%s)\n' "$FAILURES" "$UUID" >>"$GWLOG.err"
 fi
fi
