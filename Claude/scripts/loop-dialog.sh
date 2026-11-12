#!/bin/bash
. "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/house-runtime.sh"
. "$(dirname -- "${BASH_SOURCE[0]}")/../../shared/scripts/curl-auth.sh"
tmux() { embervy_tmux "$@"; }

# Hash only the dialog, without the movable cursor or terminal surroundings.
loop_dialog_question() {
  printf '%s\n' "$1" | python3 -c '
import sys, re, json, hashlib
plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", sys.stdin.read()).replace("\r\n", "\n").replace("\r", "\n")
raw = plain.rstrip().split("\n")
lines = [x.strip() for x in raw]
# A framed input below all setup cues makes those cues conversation, not a live question.
cue = re.compile(r"Do\s+you\s+trust\s+the\s+files\s+in\s+this\s+folder|Quick\s+safety\s+check|Yes,\s+I\s+trust\s+this\s+folder|Accessing\s+workspace:|Choose\s+the\s+text\s+style|new\s+MCP\s+servers", re.I)
last_cue = -1
for match in cue.finditer(plain): last_cue = plain[:match.end()].count("\n")
ready = False
for i in range(last_cue+2, len(lines)):
    if not re.fullmatch(r"─{10,}", lines[i-1]) or not re.match(r"^[❯›>]", lines[i]): continue
    for bottom in range(i+1, min(i+5, len(lines))):
        if re.fullmatch(r"─{10,}", lines[bottom]):
            ready = len(lines)-bottom-1 <= 3
            break
    if ready: break
if sys.argv[1] == "ready":
    print("ready" if ready else "empty" if not plain.strip() else "not-ready")
    sys.exit()
if ready:
    print("null")
    sys.exit()
option = re.compile(r"^(?:(❯|>)\s*)?([1-9][0-9]*)\s*[.)]\s+(.+)$")
# Each cue can keep an incomplete or reworded trust dialog from receiving a blind Enter.
trust = re.compile(r"Do you trust the files in this folder|Quick safety check|Yes, I trust this folder|Accessing workspace:", re.I)
known = re.compile(trust.pattern + r"|Choose the text style|new MCP servers", re.I)
marker = re.compile(r"^(❯|>)\s+(.+)$")
def unnumbered(i):
    line = lines[i]
    if not line or option.match(line) or re.match(r"Enter to (confirm|continue)\b", line, re.I): return None
    selected = marker.match(line)
    if selected: return selected[2]
    # Only indented neighbouring rows belong to the cursor menu, not surrounding prose.
    if raw[i][:1].isspace(): return line
    return None
result = None
for cursor in range(len(lines)-1, -1, -1):
    selected = option.match(lines[cursor])
    arrows = not selected and marker.match(lines[cursor])
    if not arrows and (not selected or not selected[1]): continue
    first = last = cursor
    if arrows:
        while first > 0 and unnumbered(first-1): first -= 1
        while last+1 < len(lines) and unnumbered(last+1): last += 1
        if last-first < 1 or sum(bool(marker.match(x)) for x in lines[first:last+1]) != 1: continue
        options = [{"number": i-first+1, "label": unnumbered(i)} for i in range(first, last+1)]
    else:
        while first > 0 and (option.match(lines[first-1]) or not lines[first-1]): first -= 1
        while last+1 < len(lines) and (option.match(lines[last+1]) or not lines[last+1]): last += 1
        matches = [option.match(x) for x in lines[first:last+1] if x]
        options = [{"number": int(x[2]), "label": x[3]} for x in matches]
    if any(known.search(x) for x in lines[last+1:]): continue
    if not options or [x["number"] for x in options] != list(range(1, len(options)+1)): continue
    heading = first-1
    while heading >= 0 and not lines[heading]: heading -= 1
    if heading < 0: continue
    # A generic dialog starts at its question line, not an earlier output paragraph.
    start = heading
    found_heading = False
    for i in range(heading, max(-1, heading-28), -1):
        if option.match(lines[i]) or lines[i].startswith("Enter to confirm"): break
        if known.search(lines[i]) or re.search(r"\?$|^(Choose|Select|Pick)\b", lines[i], re.I):
            start = i
            found_heading = True
            break
    if arrows and not found_heading: continue
    textlines = lines[start:first] + [str(x["number"])+". "+x["label"] for x in options]
    if not textlines[0] or len(textlines) > 30: continue
    result = {"text": "\n".join(textlines), "options": options}
    if arrows:
        # Positional numbers preserve the card protocol; the terminal needs arrows instead.
        result.update(navigation="arrows", selected=cursor-first+1)
    break
if result is None:
    end = len(lines)
    while end and not lines[end-1]: end -= 1
    # Only a standalone trailing instruction can offer Enter, never prose or a selection.
    has_selection = any(option.match(x) or marker.match(x) for x in lines) or trust.search(" ".join(lines))
    if end and re.fullmatch(r"(?:press\s+)?enter\s+to\s+(?:continue|confirm)[.!…]*", lines[end-1], re.I) and not has_selection:
        start = end-1
        heading = start-1
        lower = max(0, end-30)
        while heading >= lower and not lines[heading]: heading -= 1
        if heading >= lower:
            start = heading
            while start > lower and lines[start-1]: start -= 1
        result = {"text": "\n".join(lines[start:end]), "options": [], "enter": True}
if result is None:
    for line in reversed(lines):
        if known.search(line):
            result = {"text": line, "options": []}
            break
if result is not None:
    result["id"] = hashlib.sha256(result["text"].encode()).hexdigest()
print(json.dumps(result, ensure_ascii=False))' "${2:-question}"
}

loop_input_ready() {
  [ "$(loop_dialog_question "$1" ready)" = ready ]
}

loop_dialog_kind() {
  local pane="$1" question
  if loop_input_ready "$pane"; then printf '%s\n' none; return; fi
  question=$(loop_dialog_question "$pane")
  if [[ "$pane" == *"Do you trust the files in this folder"* ||
        "$pane" == *"Quick safety check"* ||
        "$pane" == *"Yes, I trust this folder"* ||
        "$pane" == *"Accessing workspace:"* ||
        "$pane" == *"Choose the text style"* ||
        "$pane" == *"new MCP servers"* ]]; then
    printf '%s\n' first-start
  elif [ "$question" != null ] && [[ "$question" != *"1. I am using this for local development"* ||
          "$pane" != *"Loading development channels"* ]]; then
    printf '%s\n' first-start
  elif [[ "$pane" == *"Loading development channels"* &&
          "$pane" == *"I am using this for local development"* ]]; then
    printf '%s\n' development
  else
    printf '%s\n' none
  fi
}

loop_question_notify() {
  [ -n "${INTERNAL_API_TOKEN:-}" ] && [ -n "${APP_HOST:-}" ] && [ -n "${APP_PORT:-}" ] || return 0
  embervy_curl_bearer "$INTERNAL_API_TOKEN" -fsS --max-time 5 -X POST "http://${APP_HOST}:${APP_PORT}/api/internal/house-question" \
    -H 'Content-Type: application/json' \
    --data-binary "$1" >/dev/null 2>&1 || printf '%s loop: house question notification failed\n' "$(date -Iseconds)" >> "$LOG"
}

loop_question_discard() {
  if [ -n "${EMBERVY_HOME:-}" ] && [ -f "$EMBERVY_HOME/state/house-question-answer.json" ]; then
    rm -f "$EMBERVY_HOME/state/house-question-answer.json"
    printf '%s loop: house question answer discarded\n' "$(date -Iseconds)" >> "$LOG"
  fi
}

loop_question_clear() {
  loop_question_discard
  if [ -n "${LOOP_QUESTION_ID:-}" ]; then
    loop_question_notify "{\"action\":\"resolved\",\"id\":\"$LOOP_QUESTION_ID\"}"
  fi
  LOOP_QUESTION_ID=""
}

loop_question_reset() {
  loop_question_discard
  loop_question_notify '{"action":"reset"}'
}

loop_dialog_waiting() {
  [ -n "${LOOP_DIALOG_WARNED:-}" ] && return 0
  LOOP_DIALOG_WARNED=1
  printf '%s loop: house is waiting for a first-start question; open TUI and answer it. The question is also shown in the app.\n' "$(date -Iseconds)" >> "$LOG"
}

loop_question_wait() {
  local pane="$1" target="$2" question id number fresh file
  local -a keys
  question=$(loop_dialog_question "$pane")
  [ "$question" != null ] || return 1
  id=$(printf '%s' "$question" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
  [ "${LOOP_QUESTION_ANSWERED:-}" != "$id" ] || return 1
  LOOP_QUESTION_ANSWERED=""
  if [ "${LOOP_QUESTION_ID:-}" != "$id" ]; then
    LOOP_QUESTION_ID="$id"
    loop_question_notify "{\"action\":\"pending\",\"question\":$question}"
  fi
  loop_dialog_waiting
  file="${EMBERVY_HOME:-}/state/house-question-answer.json"
  [ -n "${EMBERVY_HOME:-}" ] && [ -f "$file" ] || return 1
  # Consume before touching the terminal: malformed or stale answers cannot be retried.
  number=$(python3 -c '
import json, sys, os
try:
    with open(sys.argv[1]) as f: answer = json.load(f)
    q = json.loads(sys.argv[2])
    n = answer.get("number")
    if answer.get("id") == q["id"]:
        if q.get("enter") is True and q["options"] == []:
            if set(answer) == {"id", "enter"} and answer.get("enter") is True: print("Enter")
        elif "enter" not in answer and type(n) is int and n in [o["number"] for o in q["options"]]: print(n)
except (ValueError, OSError, AttributeError): pass
finally:
    try: os.unlink(sys.argv[1])
    except FileNotFoundError: pass
' "$file" "$question")
  fresh=$(tmux capture-pane -t "$target" -p -J 2>/dev/null) || fresh=""
  fresh=$(loop_dialog_question "$fresh")
  # Recheck the menu before planning keys; cursor movement alone does not change its identity.
  mapfile -t keys < <(python3 -c '
import json, sys
try:
    question, fresh = [json.loads(x) for x in sys.argv[1:3]]
    answer = sys.argv[3]
    if not isinstance(fresh, dict): sys.exit()
    selected = fresh.get("selected")
    if {k: v for k, v in question.items() if k != "selected"} != {k: v for k, v in fresh.items() if k != "selected"}: sys.exit()
    if answer == "Enter" and fresh.get("enter") is True:
        keys = ["Enter"]
    elif answer.isdigit() and int(answer) in [o["number"] for o in fresh["options"]]:
        if fresh.get("navigation") == "arrows":
            if type(selected) is not int or not 1 <= selected <= len(fresh["options"]): sys.exit()
            delta = int(answer)-selected
            keys = ["Down" if delta > 0 else "Up"] * abs(delta) + ["Enter"]
        else:
            keys = [answer, "Enter"]
    else: sys.exit()
    print("\n".join(keys))
except (ValueError, TypeError, KeyError): pass
' "$question" "$fresh" "$number")
  if [ "${#keys[@]}" -gt 0 ]; then
    if tmux send-keys -t "$target" "${keys[@]}" 2>/dev/null; then
      printf '%s loop: house question answered\n' "$(date -Iseconds)" >> "$LOG"
      LOOP_QUESTION_ANSWERED="$id"
      loop_question_clear
      return 1
    fi
  fi
  printf '%s loop: house question answer discarded\n' "$(date -Iseconds)" >> "$LOG"
  return 1
}

# Unknown screens are informational only: no answer file can ever plan terminal keys here.
loop_unknown_watch() {
  local pane="$1" target="$2" kind="$3" now=${LOOP_STARTUP_NOW:-$SECONDS} question screen
  screen=$(loop_dialog_question "$pane" ready)
  if [ "$kind" != none ] || [ "$screen" != not-ready ] || ! embervy_pane_has_claude "$target"; then
    LOOP_UNKNOWN_SINCE=""
    if [ -n "${LOOP_UNKNOWN_CARD:-}" ]; then loop_question_clear; fi
    LOOP_UNKNOWN_CARD=""
    return 0
  fi
  # Limit discovery to the startup window, but keep watching an existing card until it resolves.
  if [ -z "${LOOP_UNKNOWN_CARD:-}" ] && [ $((now - LOOP_STARTUP_STARTED)) -ge 180 ]; then
    LOOP_UNKNOWN_SINCE=""
    return 0
  fi
  if [ -z "${LOOP_UNKNOWN_SINCE:-}" ]; then LOOP_UNKNOWN_SINCE=$now; fi
  [ $((now - LOOP_UNKNOWN_SINCE)) -gt 20 ] || return 0
  if [ -z "${LOOP_UNKNOWN_CARD:-}" ]; then
    question=$(printf '%s\n' "$pane" | python3 -c '
import sys, re, json, hashlib
plain = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", sys.stdin.read())
def bounded(line):
    line = re.sub(r"[\x00-\x1f\x7f]", "", line).strip()
    # Match the API UTF-16 limit without splitting an astral character or leaving trailing spaces.
    return line.encode("utf-16-le")[:800].decode("utf-16-le", "ignore").rstrip()
lines = [bounded(line) for line in plain.splitlines()]
while lines and not lines[-1]: lines.pop()
text = "\n".join(lines[-29:] + ["Your agent is waiting in its terminal; open TUI at the top and inspect it."])
print(json.dumps({"id": hashlib.sha256(text.encode()).hexdigest(), "text": text, "options": [], "readonly": True}, ensure_ascii=False))')
    loop_question_clear
    LOOP_QUESTION_ID=$(printf '%s' "$question" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
    LOOP_UNKNOWN_CARD=1
    loop_question_notify "{\"action\":\"pending\",\"question\":$question}"
  fi
  loop_question_discard
  KIND=unknown
}

loop_startup_clock_start() {
  LOOP_STARTUP_REMAINING=$1
  LOOP_STARTUP_LAST=${LOOP_STARTUP_NOW:-$SECONDS}
  LOOP_STARTUP_STARTED=$LOOP_STARTUP_LAST
  LOOP_STARTUP_PAUSED=""
  LOOP_UNKNOWN_SINCE=""
  LOOP_UNKNOWN_CARD=""
}

loop_startup_clock_tick() {
  local kind="$1" now=${LOOP_STARTUP_NOW:-$SECONDS}
  # Neither edge of a human question may charge its waiting time to startup.
  # Screen state, not a published card or an answer file, owns the pause.
  if [ "$kind" != first-start ] && [ "$kind" != unknown ] && [ -z "$LOOP_STARTUP_PAUSED" ]; then
    LOOP_STARTUP_REMAINING=$((LOOP_STARTUP_REMAINING - (now - LOOP_STARTUP_LAST)))
  fi
  LOOP_STARTUP_LAST=$now
  LOOP_STARTUP_PAUSED=""
  if [ "$kind" = first-start ] || [ "$kind" = unknown ]; then
    LOOP_STARTUP_PAUSED=1
    return 0
  fi
  [ "$LOOP_STARTUP_REMAINING" -gt 0 ]
}

loop_dialog_continue() {
  loop_startup_clock_tick "$1" && return 0
  printf '%s loop: dialog poller timed out after 180s (no dialog seen)\n' "$(date -Iseconds)" >> "$LOG"
  return 1
}

# Return success after handling the automatic dialog; the poller still watches for later questions.
loop_dialog_step() {
  local pane="$1" target="$2" kind
  kind=${3:-$(loop_dialog_kind "$pane")}
  case "$kind" in
    unknown) loop_question_discard; return 1 ;;
    first-start) loop_question_wait "$pane" "$target"; return 1 ;;
    none) LOOP_QUESTION_ANSWERED=""; loop_question_clear; return 1 ;;
  esac
  loop_question_clear
  [ -z "${LOOP_DEVELOPMENT_DONE:-}" ] || return 1
  # The default may be Exit, so select the numbered affirmative option first.
  tmux send-keys -t "$target" 1 2>/dev/null || return 1
  LOOP_DEVELOPMENT_DONE=1
  sleep 0.5
  pane=$(tmux capture-pane -t "$target" -p -J 2>/dev/null) || return 0
  case "$(loop_dialog_kind "$pane")" in
    first-start) loop_question_wait "$pane" "$target" ;;
    development)
      # Alternation keeps the multibyte selection marker intact in the C locale.
      if printf '%s\n' "$pane" | grep -qE '^[[:space:]]*(❯|>)[[:space:]]*1[.)][[:space:]]+I am using this for local development'; then
        tmux send-keys -t "$target" Enter 2>/dev/null || return 0
        printf '%s loop: confirmed explicitly selected development-channels option 1\n' "$(date -Iseconds)" >> "$LOG"
      else
        printf '%s loop: development-channels selection not verified; open TUI and answer it.\n' "$(date -Iseconds)" >> "$LOG"
      fi
      ;;
    none)
      printf '%s loop: selected development-channels option 1; dialog no longer visible\n' "$(date -Iseconds)" >> "$LOG"
      ;;
  esac
  return 0
}
