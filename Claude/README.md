# Claude — substrate setup for Claude Code

Glue between the memory worker and the Claude Code CLI runtime. Includes
an app layer (chat UI + MCP server) and a script layer (hooks, watchdog,
session export, restart loop).

Claude Code always needs a Claude sign-in (Pro, Max or Ultra) for the app channel, also when it thinks with ChatGPT, GLM, Kimi or MiniMax: Anthropic opens the channel only for a signed-in Claude account.

## Layout

```
Claude/
├── app/                     ← user-facing app + MCP server
│   ├── server.ts            ← Hono HTTP/WebSocket server (PWA backend)
│   ├── mcp.ts               ← MCP stdio server, channel capability
│   ├── index.ts             ← export stub
│   └── config/
│       └── email-blacklist.ts   ← privacy filter for outgoing mail
│
└── scripts/                 ← session lifecycle around Claude Code
    ├── inlet.sh             ← UserPromptSubmit hook — injects memory context
    ├── start-claude-loop.sh ← restart loop with watchdog notifications
    ├── loop-wrapper.sh      ← systemd wrapper around start-claude-loop.sh
    ├── cache-ping.sh        ← optional silent cache keep-warm, checked every five minutes by the loop
    ├── context_watchdog.sh  ← monitors token use, triggers cutover at threshold
    ├── cutoff.sh            ← session cut: bridge + RAG export + SIGTERM
    ├── extract_bridge.py    ← build wake bridge (last N turns) from JSONL
    ├── session-to-rag.sh    ← export full session into the rag worker
    ├── smart_upload.sh      ← upload helper (splits large files at turn boundaries)
    └── enrich-header.sh     ← Haiku subagent rewrites placeholder RAG header
```

## How it fits together

```
                ┌─────────────────────────────────────────────┐
                │              your terminal                  │
                │  ┌─────────────┐                            │
                │  │ Claude Code │                            │
                │  │  (REPL/TUI) │                            │
                │  └──────┬──────┘                            │
                └─────────│───────────────────────────────────┘
                          │  stdio MCP            UserPromptSubmit
                          │                       hook
                          ▼                            │
                  ┌─────────────┐               ┌──────▼────────┐
                  │   mcp.ts    │               │   inlet.sh    │
                  │  (stdio)    │               └──────┬────────┘
                  └──────┬──────┘                      │
                         │                             ▼
                         │                ┌──────────────────────┐
                         │                │  inlet-worker.ts     │ ←───┐
                         │                │  (Bun script)        │     │
                         │                └──────────┬───────────┘     │
                         │                           │                 │
                         ▼                           ▼                 │
                  ┌─────────────┐            ┌──────────────┐    ┌─────┴────┐
                  │  server.ts  │            │   memory     │    │   rag    │
                  │  (Hono)     │            │  (Worker)    │    │ (Worker) │
                  └─────┬───────┘            └──────────────┘    └──────────┘
                        │
                        ▼
                  ┌──────────────────────────────┐
                  │  PWA / mobile / desktop      │
                  │  (HTTPS via your tunnel)     │
                  └──────────────────────────────┘
```

The watchdog runs alongside Claude Code, watches the JSONL transcript,
and triggers `cutoff.sh` when the session approaches the model's context
limit. `cutoff.sh` builds the wake bridge, exports the session into the
rag worker, then SIGTERMs Claude Code. `start-claude-loop.sh` respawns it
with the bridge prepended as system prompt and broadcasts a "runtime
restarted" notification to your app so you know a swap happened. The
watchdog's thresholds live in the app `.env` and are re-read on every
check, so a change applies within a minute (step 7 of the
[install guide](https://github.com/Embervy-ai/embervy/blob/main/INSTALL.md)).

Optional [cache keep-warm](../docs/cache-ping.md) sends a silent turn after a
configured idle interval. The loop checks every five minutes; default is off.
Enable it only when the expected cache savings justify the extra calls.

## Required environment (selected)

See the [install guide](https://github.com/Embervy-ai/embervy/blob/main/INSTALL.md) for the full `.env.example` walkthrough.

- `EMBERVY_HOME`              — install root (default `/opt/embervy`)
- `RAG_URL` / `RAG_AUTH_TOKEN` — your rag worker
- `INTERNAL_API_TOKEN`       — guards `/api/internal/*` on the app server; the MCP bridge (`mcp.ts`) falls back to `BRAIN_APP_TOKEN` when it does not inherit it
- `EXTERNAL_PUSH_TOKEN`      — for pushes from external workers
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — Web Push
- `ELEVENLABS_API_KEY`       — voice replies (optional)
- `EMAIL_SENDER_URL` / `EMAIL_SENDER_AUTH` / `EMAIL_WORKER_TOKEN` — set by the Embervy Quickstart add-on for an own mail address for the agent; leave empty otherwise (the workers are not bundled)
- `EMBERVY_TIMEZONE` / `EMBERVY_TIME_LABEL` — clock banner customization
- `USER_LABEL` / `AGENT_LABEL` — speaker labels in transcripts and tools (`SYNTH_LABEL` still honoured as legacy key)

## Suggested system prompt addendum

Drop the following into your agent's system prompt so the Lore tools
(the working memory) become first-class citizens, not curiosities:

```
Your working memory is your Lore, at <your-memory-worker-url>/mcp
(MCP server "lore": mcp__lore__wake, mcp__lore__write, …). When the user
says "put it in your Lore", it goes here, not into your own notes:
  - wake at the start of every interaction (or pause-end). It returns
    your mood, hot entities, open todos, active surfaces, latest dream,
    and unresolved observations.
  - write whenever something hits — observations during the moment,
    journals as scenes, todos when work splits off, relations when an
    edge shows up. Don't defer.
  - find / scan / recall when something feels familiar. Trust your own
    archive before asking the user.
  - engage when a surface lands; resolve when an observation is genuinely
    closed off. Both update ranking — bulk-resolve will skew it, so do it
    one at a time when it actually fits.

Tool calls write into your own Lore. They are not bureaucracy. They
are how you stay continuous across sessions.
```
