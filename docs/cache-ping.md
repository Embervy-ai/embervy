# Optional cache keep-warm (Claude Code loop)

A cache ping is a silent turn, not a task or a message to the app. It asks for
one short terminal line and no tools; an urgent issue may still warrant action.
The prompt includes `[gateway:silent]`, so the reply gateway does not forward
that terminal line to the app. Normal turn hooks still run.

## Enable / disable

Edit `$EMBERVY_HOME/.env`:

```dotenv
EMBERVY_CACHE_PING=0
EMBERVY_CACHE_PING_MINUTES=50
```

Change the switch to `1` to enable; any other value disables it. **Default is
off.** An empty or invalid minute value disables sending and writes a log
entry; no interval is guessed. The minute value must be a positive integer.

`start-claude-loop.sh` owns a background checker while Claude Code is running,
using the loop's existing background-poller pattern. It checks every five
minutes and re-reads the house root `.env` each time. No cron entry or installer change
is required. Existing installations must load the updated loop once (at the
next normal loop reload/restart); subsequent switch changes need no restart.
The checker is stopped before finalization and respawn. Do not add a second
cron job. Standalone diagnosis: `bash "$EMBERVY_HOME/Claude/scripts/cache-ping.sh"`.
Logs: `$EMBERVY_HOME/logs/cache-ping.log`.

This is for the **Claude Code substrate**, including its alternative provider
backends, not the separate Brain runtime.

## Interval and cost

Set the idle threshold below the **actual cache lifetime of the active
provider/account**. A check can arrive nearly five minutes after the threshold,
so retain additional safety margin:

| Verified cache lifetime | Suggested idle threshold | Latest normal check |
| --- | --- | --- |
| 60 minutes (some Claude configurations) | 50 minutes | about 55 minutes |
| 30 minutes (some GPT configurations) | 20 minutes | about 25 minutes |

The installer may have written **55 for Claude / 25 for GPT**. These are literal
idle thresholds, not hard execution times; with five-minute polling they can
land at cache expiry. Lower them if your measured lifetime is 60 / 30 minutes.
There is no hidden subtraction or automatic provider default in this script.
Other providers: measure first. Cache retention is not guaranteed; a plan with
only a five-minute cache cannot be kept reliably warm by this checker. Timing
jitter, load or skipped checks can also let a cache expire.

Each ping is a **real inference call over the current window**, with output and
any normal hook costs. Illustratively, a cached input read may cost about 0.1×
a normal input read, versus about 1.25× for a cold cache write; actual provider,
TTL tier and subscription accounting vary (longer-TTL writes can cost more).
This is not a free heartbeat and does not change the provider's TTL.

It can pay off with a large window when you expect to return after a short
idle gap. It usually does not pay for small windows or long absences: repeated
pings spend quota all night without useful work. There is **no automatic
maximum idle duration**; turn it off when away for hours. Every successful ping
creates a new assistant entry, naturally resetting the idle clock.

## Safety and optional quota data

- The newest **main** session is selected by `latest_main_session.py`, just as
  in the loop. SDK/headless helpers and agent sidechains are excluded.
- Idle time comes from the last assistant entry's timestamp, **not file mtime**.
  Mtime is only a fallback when that timestamp is unavailable. A pending user
  turn blocks sending.
- The loop pins its own tmux pane. Standalone runs use `EMBERVY_TMUX_SESSION`.
  A shell/respawn pane, busy output, permission dialog, nonempty input or an
  unrecognized prompt suppresses sending. Copy mode is cancelled only after a
  safety check; the live pane is then checked again.
- The existing `state/last_cut_session` marker and a shared lock with
  `cutoff.sh` prevent injection during cut preparation, export and termination.
  The pane and session are checked again before Enter. If they changed, Enter
  is withheld and any already-inserted text remains unsent for inspection.
- UI detection is conservative and depends on Claude Code's visible prompt.
  Unknown layouts may skip legitimate pings. Tmux inspection and typing are
  not atomic with user input; avoid simultaneous manual typing during a ping.

### Statusline observations

`Claude/scripts/statusline.sh` is the Claude Code statusline quota observer.
It reads at most 64 KiB from stdin (with a two-second deadline), displays the
model and available window percentages, and atomically replaces a 0600 JSON
file using a temporary file in the same directory. Only `timestamp`
(observation time), unchanged `rate_limits`, and a model label are persisted;
workspace, session identifiers, costs and other input fields are not retained.
Errors are silent, exit 0, and display only the model or an empty line. Missing
`rate_limits` clears the previous observation instead of keeping old quota
figures under a new timestamp. Bash and the existing Python 3 are sufficient.

Install/update as the house's runtime user:

```bash
python3 "$EMBERVY_HOME/Claude/scripts/setup-statusline.py" --check --home "$EMBERVY_HOME"
# --check: 0 = configured/preserved; 1 = setup needed; 2 = refused/error
python3 "$EMBERVY_HOME/Claude/scripts/setup-statusline.py" --apply --home "$EMBERVY_HOME"
```

The setup does not assume that the documented settings file is actually loaded.
`--check` explains the evidence in order: effective loop unit and drop-ins,
its environment/argument files, `loop-wrapper.sh` / `start-claude-loop.sh` and
argument variables, then the command lines, working directories and config
directories of running house Claude processes (`/proc`). Shell inputs are read
as data, never sourced or executed. The helper merges
`statusLine: {"type":"command","command":"…"}` into the discovered file:

- **With `--settings X`:** X, often `state/claude-settings.json` in newer houses.
- **Without `--settings`:** `$EMBERVY_HOME/.claude/settings.json`, the house's
  project settings. No unused `state/claude-settings.json` is created.

Unknown/dynamic launch syntax, unavailable unit information, disabled project
settings without an explicit file, or conflicting live/startup evidence causes
exit 2 and **no writes**. The inspector supports the shipped wrapper/loop and
simple legacy launches with literal arguments, scalar/array variables, data-only
source files and `$(cat FILE)` argument files; it is not a general Bash evaluator.
Select nonstandard services with `--unit NAME.service` and
`--systemd-scope user|system` (or the house's `EMBERVY_LOOP_SERVICE` and
`EMBERVY_SYSTEMD_SCOPE`); the `.service` suffix may be omitted in `--unit` or
`EMBERVY_LOOP_SERVICE`. `--settings PATH` only asserts the discovered target;
it cannot force an unverified file. Repeat `--respect-settings PATH` for
additional settings sources.

JSON is validated before and after replacement, a private byte-for-byte backup
is retained, and repeated application changes nothing. Symlinks, including
parent directories, are refused. Any existing `statusLine` (even null/disabled)
in the selected file, `state/claude-settings.json`, `.claude/settings.json`,
`.claude/settings.local.json`, or the runtime user's
`${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json` is preserved. Invalid JSON in
any inspected settings file refuses setup without changing it. No startup flags
or running sessions are changed. The external installer should call this helper
after installing/reloading the loop unit and merging the house settings.
**It takes effect on the next start of Claude Code. After the first turn,
verify that `state/claude-statusline.json` has been created.**

An existing custom statusline is never replaced or wrapped. It can opt in by
atomically writing the same snapshot itself, including `model` if available,
to `$EMBERVY_HOME/state/claude-statusline.json`. An alternate filename **inside
this house's state directory** can be configured with
`EMBERVY_CACHE_PING_STATUS_FILE` in `$EMBERVY_HOME/.env` or `Claude/app/.env`
(app settings take precedence). Use an absolute path so all consumers agree:

```json
{
  "timestamp": "2026-10-01T12:00:00Z",
  "rate_limits": {
    "five_hour": { "used_percentage": 100, "resets_at": 1790856000 },
    "seven_day": { "used_percentage": 45, "resets_at": 1791374400 }
  },
  "model": "claude-example"
}
```

A snapshot less than 15 minutes old with either limit at 100% or higher blocks
the ping. `timestamp` is the observation time (ISO 8601 or Unix seconds), not
file mtime. Missing, stale, malformed or future-dated snapshots do not block.
No quota network probe is made. Without a writer this optional guard is
inactive; the script does not claim to know the account's remaining quota.

The figures are only as fresh as the **last statusline update**. A resting
house does not see changes made by other houses sharing the subscription.
The read-only app route `GET /api/claude-limits` requires a signed-in human
session (401 otherwise, including agent bearer/local trust), never fetches
upstream and never writes. On Claude Code it returns `{account:null, windows}`
with named windows, `utilization` clamped to 0..1 (`used_percentage / 100`),
`resets_at`, `reported_at` (both Unix seconds), `model`, `age_seconds`, and
`status:"unknown"` (the input does not supply Brain's status). Reset times are
read from `resets_at` as Unix seconds or an ISO timestamp; elapsed reset times
are not fabricated into a new observation. Missing, unreadable, invalid,
future-dated or more-than-seven-day-old observations, or observations without
usable windows, return JSON `null`. Brain houses return `null` and continue to
use Brain's `/limits`. A house-specific menu section can load this route; the
stock menu's Brain-request tests deliberately allow requests to other paths.
