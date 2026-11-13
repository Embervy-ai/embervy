# Brain — the agent's own harness

Brain keeps one agent running across many sessions. It owns the conversation
history, cuts the session before the context window is full, archives it
(local Markdown + optional RAG upload), writes a wake bridge, and starts
the next session with that bridge. The model that thinks — the **head** — is
exchangeable: a Claude Code pipe, the ChatGPT subscription adapter, Kimi,
GLM, Grok, or any OpenAI-compatible endpoint.

Brain is plain TypeScript for Bun. There is no package.json and no
dependency: no `bun install` step, Bun runs `brain.ts` as it is.

The Embervy installer sets Brain up for you (harness "Brain" in the
subscription step): it writes `Brain/brain.env`, installs the services and
connects the app, memory and archive. Everything below is for reading,
checking, and running Brain by hand.

## Files

| File | Role |
|---|---|
| `brain.ts` | the runtime: queue, heads, commands, archive, cut, bridge, app channel |
| `heads.ts`, `head-models.ts` | the head table (endpoints, windows, keys) and the model catalogs behind `/heads` |
| `claude-pipe.ts`, `pipe-canonical.ts` | the pipe head: one long-lived `claude -p` process in stream-json |
| `move.ts` | `/move` and the ChatGPT adapter unit contract |
| `wake-bridge.ts` | the bridge written at every cut and read at every start |
| `app-channel.ts` | the app inbox as input, replies through the app |
| `web-tools.ts` | `web_search` / `web_fetch` for heads without their own |
| `resident-tools.ts`, `resident-tasks.ts`, `hot-tools.ts` | tools of the API heads (workspace, shell, background tasks) |
| `mcp-stdio.ts`, `brain-mcp.ts`, `control-endpoint.ts` | stdio MCP servers for API heads; Brain's own MCP server (pins, effort, approval, web) for the pipe |
| `sense.ts`, `pins.ts`, `pins-house.ts`, `time-marks.ts` | the sense block before every turn: clock, calendar, weather, window, due reminders, pins, time marks |
| `drift-guard.ts`, `projection.ts`, `account.ts`, `jump.ts`, `aliases.ts`, `lock.ts` | ordered vs. served model (reported, never acted on), what of the history reaches a head (every message as written), the Claude account the pipe runs on (the login of your Claude Code, one account), moving the agent to another harness (not part of this build), other names for settings and stored values (settings of a house from before the rename, through shared/scripts/legacy-names.ts; stored values none), one resident at a time |
| `texts.ts`, `texts-de.ts` | built-in messages, keyed by the English text, in English (`texts-de.ts` is an empty table); a house translates only the notices Brain sends to the app, in the app's `Claude/app/strings.local.json`, object `"brain"` (the keys: `bun Brain/texts.ts --app-notices`; `BRAIN_STRINGS_FILE` names another file); what the head reads stays English |
| `house-map.ts`, `live-view.ts`, `secure-temp.ts` | the generated map of this folder, terminal live view, small helpers |
| `scripts/brain-loop.sh` | restart loop (tmux); every restart is a fresh session with the bridge |
| `scripts/brain-loop-wrapper.sh` | systemd entry for the loop |
| `scripts/brain-watchdog.sh`, `scripts/brain-cutoff.sh` | window watchdog and the cut (SIGTERM → archive → exit → the loop respawns) |
| `scripts/brain-env.sh` | shared env loading for the scripts |
| `brain.env.example` | every setting with a comment |

## Run it by hand

```sh
cp Brain/brain.env.example Brain/brain.env      # then edit; never commit it
bun Brain/brain.ts                              # interactive, one session
bash Brain/scripts/brain-loop.sh                # the loop inside tmux session "brain"
```

Minimal profile — only a model endpoint:

```sh
BRAIN_HEAD=api BRAIN_ENDPOINT=https://provider.example.invalid/v1/chat/completions \
BRAIN_API_KEY=<model-api-key> BRAIN_MODEL=<model-id> bun Brain/brain.ts
```

Memory, archive, inlet, app and workspace tools stay off until their
variables are set; a failed optional integration is reported, never fatal.
`/help` lists the commands.

**The system prompt.** `BRAIN_SYSTEM` names the agent's own prompt file
(`EMBERVY.md` in an Embervy house). Brain reads it at every pipe start,
head switch and API turn and opens every head's prompt with it, so a
Claude head and a GPT head wake with the same text, and an edit reaches the
next pipe start without restarting Brain. A pipe head is a `claude` process and would
also load a `CLAUDE.md` (or, without one, an `AGENTS.md`) from
`BRAIN_CLAUDE_CWD`: keep neither beside it. A named file that is missing
logs `system_prompt_missing`, and the built-in prompt stands in.

**The notebook.** `BRAIN_NOTES_DIR` (an absolute path; `notes/` in an
Embervy house) gives every head a `## Notes` section: how to keep the
notebook, and its `NOTES.md` index, read afresh at every pipe start and API
turn. One file per note with frontmatter `name`, `description` and `type`,
one line per note in the index; memories and experiences stay in the Lore.
With it set, pipe heads run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, so
Claude Code's own memory no longer loads beside it. `BRAIN_NOTES_MAX_BYTES`
caps the index (default 25000). Unset, nothing changes.

**Skills.** API heads get a `## Skills` index from
`BRAIN_CLAUDE_CWD/.claude/skills` (absolute paths only), or from
`BRAIN_SKILLS_DIR` when set to an absolute path. Brain rereads each direct
subdirectory's `SKILL.md` frontmatter at every API prompt construction;
the head reads the full file before using a skill, with `read_file` when
`BRAIN_WORKSPACE_READ` covers the directory, and can write new ones as
their own folders with `name` and `description` frontmatter when the
write allowlist covers `.claude/skills`. Only the
first 8000 bytes are read, descriptions stop at 400 characters, and
`BRAIN_SKILLS_MAX_BYTES` caps the whole section at 12000 bytes by default.
Missing or empty directories add nothing. Pipe heads keep Claude Code's
own skill list; Brain neither duplicates it nor runs or changes a skill.

**Env loading.** Brain reads `BRAIN_ENV_FILE` if set, otherwise `Brain/brain.env`
and then `Brain/.env`, then `BRAIN_EXTRA_ENV_FILE` and the keys listed in
`BRAIN_IMPORT_ENV_KEYS` from `BRAIN_IMPORT_ENV_FILE`. A nonblank process value
wins; a blank or whitespace-only value counts as unset — leave a key out
instead of writing `KEY=`. `BRAIN_NO_ENV_FILE=1` loads no file at all.
`/head`, `/move`, `/heads` and the app's head menu reread the files, so a key
added later needs no restart; everything else is read at start.

**As a service.** The installer writes two units: the Brain unit runs
`scripts/brain-loop-wrapper.sh` (`Restart=always`, `RestartPreventExitStatus=75`,
`KillMode=control-group`, a long stop timeout so the archive can finish),
and a watchdog unit runs `scripts/brain-watchdog.sh` bound to it. `/stop`
ends the loop for good (exit 75); a vanished session restarts. Attach with
`tmux attach -t brain` (`BRAIN_TMUX_SESSION`, `BRAIN_TMUX_SOCKET`).

## Heads (`BRAIN_HEAD`, `/head`, `/heads`)

| Head | Transport | How it thinks | Needs |
|---|---|---|---|
| `claude` | pipe | unmodified `claude -p` (stream-json); Claude Code runs its own tool loop with the MCP servers, hooks and skills of `BRAIN_CLAUDE_CWD`; the house's prompt comes from `BRAIN_SYSTEM` | a logged-in Claude subscription (`BRAIN_CLAUDE_LOGIN_CHECK=1` makes the head unavailable until the credentials file exists) |
| `glm`, `kimi` | pipe | the same pipe with engine env `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | `GLM_CODE_KEY` / `KIMI_CODE_KEY` (or `BRAIN_GLM_API_KEY` / `BRAIN_KIMI_API_KEY`) |
| `gpt` | api or pipe | `shared/tools/chatgpt-oauth-adapter.ts`: its chat-completions front (api) or its Anthropic front through `claude -p` (pipe) | the adapter in its own unit, `BRAIN_GPT_CACHE_KEY`, a ChatGPT login (`CHATGPT_AUTH_FILE`) |
| `grok` | api | `https://api.x.ai/v1/chat/completions` | `XAI_API_KEY` or `BRAIN_GROK_API_KEY` |
| `api` | api | `BRAIN_ENDPOINT` / `BRAIN_API_KEY` / `BRAIN_MODEL` | an OpenAI-compatible endpoint |

`/head <name> [model] [pipe|api]` switches at a turn boundary without a cut;
the history stays and a pipe restarts with a transcript of the session so
far. `/model <id>` on the claude pipe switches the running process live.
The window is what the model can hold; warn and cut are the cost policy.
Per threshold: `BRAIN_<HEAD>_WATCHDOG_WARN` / `_CUT` > `BRAIN_WATCHDOG_WARN` /
`_CUT` > the head's preset (GPT warn 200k / cut 220k on its 1M window, Claude
800k / 900k) > warn 80 % / cut 90 % of the window for the other heads. A later
cut uses more of the subscription with every message, and GPT currently adds a
long-context surcharge on long input: check the provider's current terms before
raising the GPT cut. Warn and cut can be raised in
`brain.env` at any time without a cut, up to the window: Brain rereads them at
the next model call. A cut above 95 % of the running head's window is clamped
there (event `watchdog_clamped`, and `/status` says so).

`/heads` (and `GET /heads` on the control endpoint) shows what each head
reports itself, asked only when a key or login exists and cached for six
hours: claude through the CLI's `initialize`, grok and kimi through their
`/v1/models`, gpt through the subscription's model list (read with
`CHATGPT_AUTH_FILE`, never refreshing it). `BRAIN_<HEAD>_MODELS="id=Label,…"`
(`BRAIN_CLAUDE_MODELS`, `BRAIN_GPT_MODELS`, `BRAIN_GROK_MODELS`,
`BRAIN_KIMI_MODELS`, `BRAIN_GLM_MODELS`) fills in for a head that cannot be asked.

The durable choice (head, model, transport, window) lives in `BRAIN_HEAD_FILE`
(default `BRAIN_STATE_DIR/brain-head.json`) and wins over `BRAIN_HEAD` at start.
A broken or unknown file falls back to the environment, logged. Remove the
file while Brain is stopped to return to environment-only selection. The stored
window also wins over `BRAIN_GPT_CONTEXT` at start, and `/head gpt` on the same
head keeps it: a GPT choice saved with a 250k window stays at 250k. Change a
stored window once with `/move gpt window=1m`.

## Moving to another head: `/move`

`/move <head> [model] [bridge=N] [window=250k|1m|<tokens>]` ends the current
session like `/respawn` — archive, bridge, RAG export — and the loop starts the
next session on the chosen head.

- RAG is required (`BRAIN_RAG_URL` + `BRAIN_RAG_AUTH_TOKEN`); without it the move
  is refused before anything is written. The export is forced even below
  `BRAIN_MIN_TURNS_FOR_UPLOAD`.
- The target is validated first (known head, credentials, options). A refusal
  leaves the current head running.
- `bridge=N` uses N whole sessions for this one cut; `window=` sets the target's
  window and persists.
- For `gpt` the adapter contract below runs before any state write or cut; a
  failure rolls back to the previous head, its adapter unit and its state bytes.

## ChatGPT adapter contract (`gpt` head)

Brain and the loop start the adapter only as the transient system unit
`brain-gpt-adapter-<identity>.service` (`systemd-run --collect`), never with a
bare PID or `setsid`, and only stop a unit whose `InvocationID` they recorded
themselves (`BRAIN_STATE_DIR/<unit>.owner.json`). Before a turn is sent, the
adapter's `/health` must show all of:

- `ok: true`, `backend: "chatgpt-oauth"`, its own numeric `port`;
- `identity = sha256("gpt-adapter:" + BRAIN_GPT_CACHE_KEY)` hex, first 16;
- `model` equal to the chosen model;
- the effective settings of the unit plan: `effort`, `verbosity`,
  `reasoning_context`, `reasoning_replay`, `web_search`, `native_web_search`,
  `turn_state_recovery` (from the nonblank `ADAPTER_*` variables).

`BRAIN_GPT_CACHE_KEY` is required and unique per install
(`^[A-Za-z0-9._-]{1,128}$`, no default). `GPT_ADAPTER_PORT` wins over the alias
`BRAIN_GPT_ADAPTER_PORT`; give Brain its own port. A foreign, old or
unidentified adapter on the port is refused, never adopted. A changed desired
profile (an `ADAPTER_*` value, the model, the auth path) replaces only an own
unit, transactionally. The adapter's log goes to
`BRAIN_LOG_DIR/chatgpt-oauth-adapter.log`; the unit survives Brain's cut.

## Effort

`/effort [low|medium|high|xhigh|max|default]` sets one session-wide reasoning
effort; the head can set it itself with the `effort` tool. The level is kept
in `BRAIN_EFFORT_FILE` across cut and respawn and wins over the start value
`BRAIN_EFFORT` (fallback `CLAUDE_CODE_EFFORT_LEVEL`, never passed to the pipe).
The claude pipe changes it live over the CLI's control protocol; kimi/glm go
the same way; gpt (api) and grok send `reasoning_effort`; the gpt pipe only
knows the adapter's start value `ADAPTER_EFFORT`.

## Cut, respawn and the wake bridge

- `scripts/brain-loop.sh` keeps Brain alive. Exit 0/129/130/143 → restart;
  exit 2 (lock or parallel head) → wait `BRAIN_GUARD_SLEEP`; three crashes in
  30 s → wait `BRAIN_CRASH_SLEEP`; `/stop` ends the loop.
- Brain writes `BRAIN_CONTEXT_STATE_FILE` after every answer.
  `scripts/brain-watchdog.sh` reads it, writes `BRAIN_CONTEXT_WARNING_FILE` at the
  warn threshold and runs `scripts/brain-cutoff.sh` at the cut threshold:
  SIGTERM → Brain writes bridge + archive → exit → the loop respawns, and the
  new session uploads the archive to the RAG in the background, so the agent is
  back within seconds. Brain's internal watchdog and `/respawn` do the same from
  inside; a jump, `/stop` and `/move` still upload before the session ends.
- A session that ended without archiving is exported at the next start
  (`BRAIN_CATCHUP`, `BRAIN_CATCHUP_MAX_AGE_H`).

The bridge (`BRAIN_BRIDGE_FILE`) is a wake capsule — cut facts, the headers of
the last archived sessions, notes — over the turns:

- `BRAIN_BRIDGE_MODE=turns` (default): the last `BRAIN_BRIDGE_TURNS` user turns.
- `BRAIN_BRIDGE_MODE=sessions`: the last `BRAIN_BRIDGE_SESSIONS` whole sessions
  with at least `BRAIN_BRIDGE_MIN_USER_TURNS` user turns; thinner ones ride along.

Its size is set by the configured depth alone (`BRAIN_BRIDGE_MODE`, `BRAIN_BRIDGE_TURNS`,
`BRAIN_BRIDGE_SESSIONS`). An emergency ceiling applies at every use for the head that
reads it: `BRAIN_BRIDGE_CUT_SHARE` (0.5) of that head's watchdog cut, at most
`BRAIN_BRIDGE_MAX_BYTES`; above it whole turns go, oldest first, the file keeps everything. A bridge Brain did not
write itself (for example an imported history) is kept as one earlier session
until enough Brain sessions follow. `BRAIN_BRIDGE_NO_BRIDGE_MARKER` makes the next
session start bare, once. Brain cleans the turns itself (channel bodies, speaker
rule, the head's speech); the capsule's LINT line says so.

Archives are named `<BRAIN_SESSION_PREFIX>_<N>.md` (default `Session`), numbered
from the RAG's list, and uploaded to the same RAG worker the other substrates use.

## Changing pipe settings without a cut: `/reload`

`/reload` (terminal or app) rereads the settings that shape the Claude pipe at
start: `BRAIN_CLAUDE_SETTINGS` (path or inline JSON, and the file's contents),
`BRAIN_CLAUDE_SETTING_SOURCES`, `BRAIN_PIPE_MCP_CONFIG` (and its file),
`BRAIN_PIPE_PERMISSION` and the approval keys, the built-in tool policy,
`BRAIN_CLAUDE_CWD`, `BRAIN_CLAUDE_BIN`, the per-head prompt mode, the notes and
tool-rule inputs, and the three `CLAUDE_CODE_*` start variables. Edits to the
system, self and user prompt files count too.

If something changed, Brain names the changed keys (never their values) and
restarts the pipe before the next turn, after a running turn has
finished. The conversation rides along as it does after a head change: no cut,
no archive, no new session. If nothing changed, nothing happens. An API head has
no pipe and says so in one line.

Everything else stays startup configuration. The head and its window,
endpoints, RAG, web wiring, the control endpoint and the API-side approval
policy need a cut (`/respawn`, or `/move` for head and window). A changed tmux
socket or unit environment needs a unit restart. Brain watches the explicit
settings and MCP files, not every settings file Claude Code may find on its own.

## Before every turn

pins → the sense lines (`SENSE · …`: substrate, model change, calendar, weather,
due reminders, window) → context warning → clock → retrieval. Retrieval is the
built-in RAG + memory search, or `BRAIN_INLET_WORKER` if set. The block is
attached to its user message and re-sent in the same place later
(`BRAIN_INLET_PERSIST`, keeps the prompt cache), and never enters the bridge
or the archive. Local times use `BRAIN_TIMEZONE`, then `EMBERVY_TIMEZONE`, then
Europe/Berlin.

## App channel

With `BRAIN_APP_INBOX_FILE` (no default on purpose) Brain reads the app's inbox
from a byte cursor in its state directory; the first start begins at the end
of the file, so say hello after waking it. Messages arrive as
`<channel source=… user=… ts=…>` turns; a message during a running turn is
steered into it. The head answers with the app's reply tool
(`mcp__<BRAIN_APP_MCP_SERVER>__reply`); with `BRAIN_REPLY_GATEWAY=on` a turn
that ends without that tool still reaches the app, prefixed ⚡ (optional
classifier: `BRAIN_REPLY_GATEWAY_CLASSIFIER*`). App commands such as `/status
/head /model /effort /move /ping /respawn /reload /heads /pins /help` are answered by Brain,
not by the model. Every new message reaches the agent, in order: one read
delivers up to `BRAIN_INBOX_BATCH_BYTES` and the rest follows with the next
read. Only exact repeats within one read (same sender, same text) collapse
into one message with a `repeat_count`; commands, images and files never
collapse.

Messages from a room (`kind="room"`) or a direct line to another agent
(`kind="peer"`, text prefixed `[Direct/<name>]`) are foreign: they never run an
app command and never count as the person speaking. The agent answers them with
the app's `room` or `peer` tool, never with `reply`; that speech is recorded as
`[Room <name>] …` or `[Direct/<name>] …` and owes the person nothing.

Approval: `BRAIN_APPROVAL=app` asks the app before risky calls on API heads,
and on the Claude head too when `BRAIN_PIPE_PERMISSION=app`: a `PreToolUse` hook
applies the same rules there and overrides the house's own allow rules.
With `BRAIN_APPROVAL_RULES=default` that is what deletes, stops a service,
publishes, sends mail from the shell or writes system files; everything else,
reads and tests included, runs without a card, and the card names the reason.
`BRAIN_APPROVAL_RULES` can also point to a file of your own rules (see
`brain.env.example`). Tools in `BRAIN_APPROVAL_TOOLS` (empty by default) ask on
every call. Writes to the agent's own approval settings, Claude Code settings and
approval sources ask too, through the file tools and through obvious shell writes.
The cards are an agreement with the agent, not a lock: it has root on its own
server, and interpreter code such as `python3 -c` is not parsed. The pipe uses `BRAIN_PIPE_PERMISSION`
(`none` = deny prompts, default; `app` = approval card through
`mcp__brain__approve`, needs `BRAIN_CONTROL_TOKEN`; `cli`).
The product app shows these approval cards when requested; only the human session can allow or deny them, while the internal bearer can only expire them.

## Web search and fetch (`web-tools.ts`)

| Head | Search | Fetch |
|---|---|---|
| `claude` pipe, `gpt` pipe | Claude Code's `WebSearch` | Claude Code's `WebFetch` |
| `glm`, `kimi` (pipe on another engine) | `mcp__brain__web_search` | `mcp__brain__web_fetch` (needs `BRAIN_CONTROL_TOKEN`) |
| `gpt` api, `grok`, `api` | `web_search` | `web_fetch` |

`web_search` needs `BRAIN_WEB_SEARCH_BACKEND`: `searxng` (self-hosted, no
account; enable the JSON format), `tavily` (key, free monthly credits) or
`brave` (key, paid). `web_fetch` fetches one public page here and returns
readable text; local, private, link-local and metadata addresses are refused
after DNS and on every redirect. With the browser module installed
(`BRAIN_WEB_BROWSER=auto`) it can render script-only pages. Every result is
wrapped as untrusted external data.

## API heads: tools

| Tool | Available when |
|---|---|
| `read_file`, `grep`, `glob` | `BRAIN_WORKSPACE_READ` is set (read-only jail) |
| `write_file`, `edit_file` | paths listed in `BRAIN_WORKSPACE_WRITE_LIST` (relative to the workspace; backups in `BRAIN_WORKSPACE_BACKUP_DIR`) |
| `bash`, `task_start`, `task_status`, `task_output` | additionally `BRAIN_SHELL=on`, never with `BRAIN_STERILE=1`; timeout `BRAIN_SHELL_TIMEOUT_MS`, task logs in `BRAIN_TASKS_DIR` |
| `mcp__<server>__<tool>` | stdio MCP servers from `BRAIN_MCP_CONFIG` / `BRAIN_MCP_SERVERS` |
| `browse` | `BRAIN_BROWSER_COMMAND` |

The shell gets no `BRAIN_*` variable and nothing named like a key, token,
secret or password. It is not a sandbox — run it with `BRAIN_APPROVAL=app`.

## Terminal live view

`BRAIN_LIVE_VIEW=on` (default) prints one short line per tool call, helper
start/end and the helper count — never file contents, message bodies or tool
results. `off` switches the lines off and changes nothing else.

## Environment reference

`brain.env.example` names and explains every setting a deployment chooses.
The variables below are the rest: tuning knobs with safe defaults, the
scripts' own knobs, and internals.

| Variable | Default | Purpose |
|---|---|---|
| `BRAIN_SKILLS_DIR` | `<BRAIN_CLAUDE_CWD>/.claude/skills` | Absolute skills directory for API heads; a relative override is ignored. Without an absolute override or working directory, no index is added. |
| `BRAIN_SKILLS_MAX_BYTES` | `12000` | Whole skills section byte cap, including instructions and truncation notice. Invalid values use the default; if even the instructions and notice cannot fit, omit the section. |
| `BRAIN_INLET_PERSIST` | `true` | Keep each inlet block attached to its user message in later requests (stable prefix, prompt cache holds). |
| `BRAIN_APP_USER` | `BRAIN_USER_NAME` | Speaker name for app messages. |
| `BRAIN_APP_POLL_MS` | `2000` | Poll interval of the app inbox. |
| `BRAIN_INBOX_BATCH_BYTES` | `262144` | Bytes of new app messages delivered in one read; the rest follows with the next read, nothing is dropped. |
| `BRAIN_IDLE_TICK_MS` | `60000` | Interval of the idle tick (watchdog record, due reminders, keep-warm check). |
| `BRAIN_CACHE_PING_PROMPT` | built-in | Text of the cache ping, the idle keep-warm turn (`BRAIN_CACHE_PING`, `BRAIN_CACHE_PING_MINUTES`; `/ping` sends one now). |
| `BRAIN_CACHE_PING_REPLY_CHARS` | `160` | How much of the cache ping's reply is logged. |
| `BRAIN_REMINDERS_ESCALATE_MIN` | `60` | Minutes before an unhandled due reminder is raised as its own turn (`[Reminder] …`). |
| `BRAIN_ALLOW_PARALLEL` | off | `1`: start even when `BRAIN_PARALLEL_PATTERN` finds another head. |
| `BRAIN_CLAUDE_BIN` | `claude` | The Claude Code binary for the pipe and the catalog probe. |
| `BRAIN_PIPE_GC_TOKENS` | `150000` | Pipe recycle thresholds in `pipe-canonical.ts` (helpers, not wired into the runtime). |
| `BRAIN_PIPE_GC_HEADROOM` | `40000` | 〃 |
| `BRAIN_PIPE_GC_CEILING` | `172000` | 〃 |
| `BRAIN_CONTEXT_STATE_FILE` | `BRAIN_STATE_DIR/brain_context.json` | Context record the watchdog and the cut script read. |
| `BRAIN_CONTEXT_WARNING_FILE` | `BRAIN_STATE_DIR/context_warning` | Warning marker the watchdog writes and the sense block shows. |
| `BRAIN_TMUX_SESSION` | `brain` | tmux session of the loop and the wrapper. |
| `BRAIN_TMUX_SOCKET` | empty | Separate tmux socket (`tmux -L`). |
| `BRAIN_CMD` | `bun brain.ts` | Command the loop runs. |
| `BRAIN_RESTART_SLEEP` | `2` | Seconds between two sessions. |
| `BRAIN_GUARD_SLEEP` | `60` | Wait after a refused start (lock, parallel head). |
| `BRAIN_CRASH_SLEEP` | `60` | Wait after three crashes in 30 s. |
| `BRAIN_LOOP_MAX_ITER` | empty | Stop the loop after N sessions (tests). |
| `BRAIN_LOOP_NO_TMUX` | off | `1`: run the loop in the current terminal. |
| `BRAIN_WRAPPER_POLL_S` | `10` | How often the systemd wrapper checks the tmux session. |
| `BRAIN_CUT_WAIT_S` | `180` | How long the cut script waits for the archive after SIGTERM. |
| `BRAIN_PROCESS_PATTERN` | `brain\.ts` | How the cut script finds the process. |
| `BRAIN_NOTIFY` | `on` | `off`: the scripts send no notices to the app. |
| `BRAIN_NO_ENV_FILE` | off | `1`: load no env file (tests, probes). |
| `BRAIN_STERILE` | off | `1`: a sterile instance — no shell, no app notices. |
| `BRAIN_MCP_WEB_TOOLS`, `BRAIN_MCP_WEB_RENDER` | — | Internal: set by Brain in the pipe's environment for `brain-mcp.ts`. |
| `BRAIN_GPT_UNIT_PLAN` | — | Internal: the adapter unit's start plan (paths and identifiers, no secrets). |
| `BRAIN_HOUSE_MAP_EXTRA_FILE` | empty | Your own notes appended to the generated map of this folder. |

Optional integrations with an existing Claude Code install (all off unless
set): the watchdog record for the app's watchdog tool
(`BRAIN_WATCHDOG_STATE`), the upload ledger (`BRAIN_UPLOAD_LEDGER`), a parked
archive copy for an external header job (`BRAIN_ARCHIVE_PARK_DIR`).

## About this folder

This folder is an export: the tests live with the development tree, and
every export is checked before it lands here — the development test suite
green, the file list by allowlist, no private names, every script `bash -n`
clean, `brain.ts` importable without starting, a smoke start on the `api` head,
the send path checked to pass every message through unchanged, built-in
messages in English only, and every `BRAIN_*` variable the code reads named in
`brain.env.example` or this README.
