#!/bin/bash
# Generates metadata for an archived transcript.

set -uo pipefail

# Headless calls silently use inherited API credentials instead of the subscription.
# Remove them to prevent unintended API billing.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN 2>/dev/null || true

MDFILE="${1:-}"
if [ -z "$MDFILE" ] || [ ! -f "$MDFILE" ]; then
  echo "Usage: $0 <markdown-file>" >&2
  exit 1
fi

# Resolve the archive before changing cwd; callers may pass a relative path.
MDFILE="$(cd -- "$(dirname -- "$MDFILE")" && pwd)/$(basename -- "$MDFILE")"
EMBERVY_HOME="${EMBERVY_HOME:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)}"
export EMBERVY_HOME ENABLE_CLAUDEAI_MCP_SERVERS=false
cd -- "$EMBERVY_HOME" || { echo "Header enrichment: cannot enter EMBERVY_HOME; keeping original." >&2; exit 2; }

# Inline agents keep this invocation independent of the account's agent directory.
AGENTS_JSON=$(python3 - "$EMBERVY_HOME/shared/subagents/auto-rag-header.md" <<'PY'
import json, pathlib, sys
try:
    text = pathlib.Path(sys.argv[1]).read_text()
    front, prompt = text.split('---', 2)[1:]
    meta = dict(line.split(':', 1) for line in front.strip().splitlines())
    print(json.dumps({'auto-rag-header': {
        'description': meta['description'].strip(),
        'model': meta['model'].strip(), 'prompt': prompt.strip(), 'tools': []
    }}))
except Exception as e:
    print('Header enrichment: cannot read house agent definition; keeping original: ' + str(e), file=sys.stderr)
    sys.exit(2)
PY
) || exit 2

HEADER_LINE=$(grep -m1 '^# \[' "$MDFILE" || true)
# The template may change the session type and name, so preserve the archive's SESSION line.
SESSION_LINE=$(head -n 8 "$MDFILE" | grep -m1 '^SESSION=' || true)
if [ -z "$HEADER_LINE" ]; then
  echo "No header line found; aborting." >&2
  exit 1
fi

# Keep the backup until the caller confirms the replacement, so a bad header remains recoverable.
cp "$MDFILE" "${MDFILE}.bak" || exit 1

# CLI versions without inline agents must fail before any transcript is sent.
CLI_HELP=$(claude --help </dev/null) || {
  echo "Header enrichment: cannot read Claude CLI help; keeping original." >&2
  exit 2
}
if ! grep -q -- '--agents' <<< "$CLI_HELP"; then
  echo "Header enrichment: Claude CLI lacks --agents; keeping original." >&2
  exit 2
fi

CONTENT=$(tail -n +9 "$MDFILE") || exit 1

TRUNCATED=$(echo "$CONTENT" | head -c 150000)

PROMPT=$(cat <<EOF
First header line (echo it back unchanged as the first line of your output):
$HEADER_LINE

The session transcript follows. Read it, then return exactly the header block
described in the auto-rag-header agent prompt — nothing before, nothing after.

Transcript:
---
$TRUNCATED
---
EOF
)

# CLI output may arrive as result, assistant or delta events.
NEW_HEADER=$(printf '%s' "$PROMPT" | claude -p \
  --setting-sources project,local \
  --no-session-persistence \
  --agents "$AGENTS_JSON" --agent auto-rag-header \
  --tools "" \
  --strict-mcp-config \
  --mcp-config '{"mcpServers":{}}' \
  --disable-slash-commands \
  --output-format stream-json --include-partial-messages --verbose \
  | python3 -c '
import json, sys
result = ""
deltas = []
for line in sys.stdin:
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") == "result" and isinstance(d.get("result"), str):
        result = d["result"]
    elif d.get("type") == "stream_event":
        ev = d.get("event") or {}
        delta = ev.get("delta") or {}
        if ev.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
            deltas.append(delta.get("text", ""))
    elif d.get("type") == "assistant":
        for b in (d.get("message") or {}).get("content", []):
            if isinstance(b, dict) and b.get("type") == "text" and b.get("text"):
                result = result or b["text"]
print(result if result.strip() else "".join(deltas))
' | sed -e 's/^```markdown$//' -e 's/^```$//') || {
  echo "Header enrichment: Claude invocation failed; keeping original." >&2
  exit 2
}

NEW_HEADER=$(echo "$NEW_HEADER" | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac)

if ! echo "$NEW_HEADER" | grep -q '^# \['; then
  echo "Subagent output missing '# [...]' header; keeping original." >&2
  echo "Raw output (first 500 chars):" >&2
  echo "$NEW_HEADER" | head -c 500 >&2
  exit 2
fi
if ! echo "$NEW_HEADER" | grep -q '^THEMES='; then
  echo "Subagent output missing 'THEMES=' line; keeping original." >&2
  exit 2
fi

# Model output can contain stray lines; select only the permitted fields.
FIELDS=$(printf '%s\n' "$NEW_HEADER" | awk -F= '/^(THEMES|SUMMARY|EMOTIONAL_ARC|KEY_MOMENTS|DYNAMIC)=/ && !seen[$1]++ { line[$1] = $0 } END { n = split("THEMES SUMMARY EMOTIONAL_ARC KEY_MOMENTS DYNAMIC", k, " "); for (i = 1; i <= n; i++) if (k[i] in line) print line[k[i]] }')
[ -n "$SESSION_LINE" ] || SESSION_LINE=$(printf '%s\n' "$NEW_HEADER" | grep -m1 '^SESSION=' || true)

# A single checked write prevents a partial replacement from reaching the original.
printf '%s\n' "$HEADER_LINE" "" "$SESSION_LINE" "$FIELDS" "" "$CONTENT" > "${MDFILE}.new" || exit 1

mv "${MDFILE}.new" "$MDFILE" || exit 1
echo "Header enriched for $MDFILE"
