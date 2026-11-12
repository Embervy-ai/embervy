# Embervy Doctor — portable

A single-file health check for an Embervy-based agent stack.
Drop into your agent's directory, set a few env vars, run.

## Quick start

```bash
# from your agent's home directory:
bun embervy-doctor.ts
```

Or explicitly:

```bash
EMBERVY_HOME=/path/to/agent bun embervy-doctor.ts
```

A house installed under the product's previous name keeps the doctor's old
command name next to this file (it forwards to `embervy-doctor.ts`), and the
old setting names are read when the current ones are not set.

## What it checks

| Group | Check | What it tells you |
|---|---|---|
| Core | `EMBERVY_URL` reachable | memory worker responds to /health |
| Core | `EMBERVY_API_KEY` valid | memory worker `/mcp tools/list` accepts the token |
| Core | `RAG_URL` reachable | rag worker responds |
| Core | `RAG_AUTH_TOKEN` valid | rag `/list` accepts the token |
| Security | Memory worker rejects unauth | worker is not fail-open without a token |
| Security | RAG rejects unauth | worker is not fail-open without a token |
| Retrieval | Hybrid search | `/search` returns `mode=hybrid` with vector + bm25 counts |
| Retrieval | FTS5 (BM25) ready | BM25 returns hits for a probe query |
| Retrieval | Reranker active | response includes `reranked: true` |
| Inlet | OpenRouter key accepted | optional `OPENROUTER_API_KEY` is checked with `GET https://openrouter.ai/api/v1/key` (3-second timeout), independently of archive content; 401/403 warns that automatic context is unavailable and names the configuration file and variable, never the value; unset, offline, network errors, timeouts and other HTTP statuses skip |
| Inlet | Inlet returns context | inlet script outputs a context block |
| MCP | MCP servers connected | `claude mcp list` shows servers up (Claude-first; see note) |
| Adapter | Identity doc present (on Brain: loaded once) | Brain's `EMBERVY.md` / `CLAUDE.md` / `AGENTS.md` / your config |
| Adapter | UserPromptSubmit hook wired | inlet hook registered in settings.json |
| Health | State dir writable | bridge / wake-state directory exists & writable |
| Health | Watchdog logging | (optional) watchdog log file present |
| Health | Disk space | used % on `/` and `$EMBERVY_HOME` — `WARN` from 80 %, `FAIL` from 92 %; the fix names the disk reserve `/var/lib/embervy/reserve.img` first when it exists |
| Health | Swap | some swap is active (`WARN` when none — a memory spike then kills processes) |
| Health | No dangerous defaults | no trivial passwords, no `YOUR_` placeholders |

**Status levels:** `OK` (passed), `WARN` (passed but worth a look), `FAIL` (broken),
`SKIP` (intentionally not run, e.g. `--offline` or feature not configured).

**Substrate scope:** the MCP check uses `claude mcp list`. On Brain the
Adapter check reads Brain's own prompt file (`BRAIN_SYSTEM` in brain.env,
`EMBERVY.md` in an Embervy house) and warns when a `CLAUDE.md` or
`AGENTS.md` lies beside it: a pipe head is a `claude` process and would read
both. Otherwise it looks for `CLAUDE.md` and falls back to `AGENTS.md` /
`brain-config.md` if present. Set `ADAPTER_DOC` explicitly for other
substrates.
Alongside the `EMBERVY.md` check, Brain houses get a `BRAIN_NOTES_DIR` directory check, a non-error notice for a missing `NOTES.md` or unset switch, and a warning about Claude Code notes that no head reads anymore and that belong in `notes/`.

**Offline mode & `SKIP`:** `--offline` skips every network check and
records them as `SKIP`. A run with only `SKIP`s and no `WARN`/`FAIL`
returns exit code `0` (PASS) — meaning *the local pieces look healthy*,
not that everything was verified. Read the `skip` count in the summary
line for the full picture.

## Configuration

All via env. Loaded in order:

1. `$EMBERVY_HOME/.env`
2. `$EMBERVY_HOME/app/.env`
3. `$APP_ENV_FILE` (if set)
4. `process.env` (fallback)

**Earlier-loaded `.env` values win** — once a key is set, later sources
do not override it. `APP_ENV_FILE` therefore *adds* substrate-specific
values for keys not already present in the main `.env`. For temporary
overrides during a single run, edit the `.env` or wrap the call in a
one-off shell scope.

**Required for online checks:**

- `EMBERVY_URL` — your memory worker URL
- `EMBERVY_API_KEY` — bearer token (must match worker secret)
- `RAG_URL` — your rag worker URL
- `RAG_AUTH_TOKEN` — bearer token (must match worker secret)

**Optional:**

- `EMBERVY_HOME` — your stack root (default: current dir)
- `APP_ENV_FILE` — extra .env to load (e.g. `Claude/app/.env`)
- `OPENROUTER_API_KEY` — optional inlet classifier key; when set, the full and
  startup checks validate it without generating a completion or printing its value
- `INLET_SCRIPT` — path to your inlet worker (default:
  `$EMBERVY_HOME/Claude/scripts/inlet-worker.ts`)
- `ADAPTER_DOC` — identity doc path (default on Brain: its `BRAIN_SYSTEM`;
  otherwise tries `CLAUDE.md`, `AGENTS.md`, `brain-config.md` in `$EMBERVY_HOME`)
- `INLET_HOOK_SETTINGS` — path to settings.json holding the inlet hook
  (default: tries `$EMBERVY_HOME/.claude/settings.json` and
  `$EMBERVY_HOME/.claude/settings.local.json`; shared user hooks do not count)
- `STATE_DIR` — your bridge/state directory (default: `$EMBERVY_HOME/state`)
- `WATCHDOG_LOG` — optional watchdog log path (silent if unset)
- `DOCTOR_PROBE_QUERY` — search term used for the hybrid-search test
  (default: `"the"` — present in any populated archive). Set to a
  stack-specific term (e.g. a agent's name) to test for a known
  expected hit.
- `DOCTOR_STATUS_FILE` — if set, the run writes a JSON status snapshot
  to this path (handy for app/cron integration with a background heartbeat)

## Startup house check

`bun shared/tools/embervy-doctor.ts --startup --json` always emits JSON and has
an overall 20-second budget (the worker is stopped after 19 seconds). It checks
core memory and chronicle endpoints and credentials, bridge directory access,
adapter and inlet wiring, the optional OpenRouter key, MCP configuration, identity
and hearing. The OpenRouter check only validates the key and makes no model call.
Startup does not spend a model turn or launch a retrieval probe; the full doctor tests those.
Every non-OK startup entry includes `id`, `label`, `detail` and `fix`, including
intentional skips. Existing status names stay `OK`, `WARN`, `FAIL`, `SKIP`.

`identity` fails when the house's identity/system file is missing, empty or only
whitespace. It uses `ADAPTER_DOC`, then Brain's `BRAIN_SYSTEM` on Brain, otherwise
the existing `CLAUDE.md` / `AGENTS.md` / `brain-config.md` resolution.
`hear` skips when `EMBERVY_HEAR_URL` is unset or offline. Otherwise it probes that
address with HEAD (2xx or 405 proves it answers), without sending audio;
transcription itself is not tested. Unreachable or failing services get a fix.

## Weather freshness

Claude Code's inlet uses `weather.ts` on demand, with a 15-minute result cache;
that is not a timer that fetches weather every 15 minutes. Brain refreshes its
weather cache every 30 minutes. Both need weather enabled and a location; on
failure they retain the existing fallback behavior, not a guaranteed fresh line.

## Modes

```bash
bun embervy-doctor.ts            # full online check
bun embervy-doctor.ts --offline  # local checks only (no network)
bun embervy-doctor.ts --verbose  # split rollup checks into one line each
bun embervy-doctor.ts --json     # machine-readable for CI/automation
```

Exit codes: `0` PASS, `1` PASS WITH WARNINGS, `2` FAIL.

## Background heartbeat + status badge (optional)

If you run an app/chat layer alongside your agent, you can wire the
doctor into it as a passive health indicator — a small coloured dot that
turns green/yellow/red based on the last automatic check.

The doctor writes its result to a JSON status file when invoked with
`DOCTOR_STATUS_FILE` set:

```bash
DOCTOR_STATUS_FILE=/path/to/state/doctor-status.json \
  bun embervy-doctor.ts --json --verbose
```

Status file shape:

```json
{
  "state": "ok",                          // "ok" | "warn" | "fail"
  "summary": { "pass": 16, "warn": 0, "fail": 0, "skip": 0 },
  "result": "PASS",
  "checks": [ ... ],
  "checked_at": "2026-05-19T15:30:00Z"
}
```

**Cron / systemd timer (run every 6 hours):**

```cron
0 */6 * * * DOCTOR_STATUS_FILE=/path/state/doctor-status.json \
  bun /path/tools/embervy-doctor.ts --json --verbose >/dev/null
```

Or as a systemd timer pair (`embervy-doctor.service` + `embervy-doctor.timer`
with `OnUnitActiveSec=6h`).

**App integration:** in your chat/app UI, read the status file (or expose
it via an internal API endpoint), then render a small dot on a "doctor"
button:

- `state: "ok"` → green dot (everything is fine)
- `state: "warn"` → yellow dot (something to look at)
- `state: "fail"` → red dot (something is broken)
- file missing / older than expected → gray / "unknown"

Optional: on a manual click, run the doctor live (`--json`) and push
the new state to the UI via WebSocket; on degradation (`ok → warn` or
`ok → fail`), trigger a push notification so the user sees it without
having to open the app.

The dot turns the doctor from "tool you remember to run" into "passive
heartbeat that warns you when something drifts." Especially useful when
the agent runs unattended overnight.

## What it does NOT do

- Log or echo secret values — only `present (length N)` / `missing`
- Touch foreign agents' material (no cross-stack reads)
- Read memory D1 data directly (use the memory tools for that)
- Trigger writes / uploads / deletes — read-only health check

## Requires

- [Bun](https://bun.sh) (any recent version)
- An Embervy stack (memory worker + rag worker + inlet)
- `claude` CLI on PATH if you want the MCP check to run (otherwise it
  reports as WARN — non-blocking)
