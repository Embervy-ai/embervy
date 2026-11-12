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

This checkout does not ship a statusline quota writer. If your statusline
already collects usage, it can atomically write the following snapshot to
`$EMBERVY_HOME/state/claude-statusline.json` (or the path set through
`EMBERVY_CACHE_PING_STATUS_FILE` in `$EMBERVY_HOME/.env`):

```json
{
  "timestamp": "2026-10-01T12:00:00Z",
  "rate_limits": {
    "five_hour": { "used_percentage": 100 },
    "seven_day": { "used_percentage": 45 }
  }
}
```

A snapshot less than 15 minutes old with either limit at 100% or higher blocks
the ping. `timestamp` is the observation time (ISO 8601 or Unix seconds), not
file mtime. Missing, stale, malformed or future-dated snapshots do not block.
No quota network probe is made. Without a writer this optional guard is
inactive; the script does not claim to know the account's remaining quota.
