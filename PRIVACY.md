# Privacy

Embervy stores the entire conversational history of an agent. That data
is sensitive. This document describes where it goes, who can see it,
and what the defaults assume.

## Where the data lives

A reference deployment uses these stores:

| Store | Purpose | Access |
|---|---|---|
| Cloudflare D1 (memory worker) | Hot memory: observations, journals, todos, relations, mood, daemon runs. | The memory worker only. Bearer-auth required. |
| Cloudflare Vectorize | Embeddings for hot + archive. | Worker-only. |
| Cloudflare R2 (`embervy-archive`) | Decayed events as JSON blobs. | Worker-only. |
| Cloudflare R2 (`rag-storage`) | Full session transcripts (Markdown). | Worker-only via the rag worker. Bearer-auth required. |
| App server `data/inbox.jsonl` / `data/outbox.jsonl` | Live message stream. | Local to the VPS; readable only via authenticated app endpoints. |
| App server `data/images/` | Uploaded images, documents and voice messages, and copies sent with `send_file`. | Local to the VPS; served via `/api/images/<filename>` behind the auth middleware. |
| App server `data/email-{inbox,outbox}.jsonl` | Email pipeline. | Local to the VPS; behind auth. |
| App server `data/calendar.json` | The agent's calendar. | Local to the VPS; behind auth — except the read-only feed `/calendar.ics` (title + time of non-private entries) for whoever holds the feed token, while the calendar module is on. |
| App server `data/calendar-external.json` | Next 30 days of your own calendars (titles, times), if you added their secret ICS links. The links themselves stay in `.env`. | Local to the VPS; shown to the agent only. |
| App server `data/shared/` | One-off public files served via `/share/<obscure-filename>`. | On the VPS, but **public** to anyone who knows the filename. |

Files the agent sends with `send_file` are copies in `data/images/`,
inside the authenticated chat. They get no `/share/` link and go to no
other service.

**`data/shared/` is the only deliberately public path.** Treat it as
you would a static folder you'd put on `example.com/files/`. Anything
in it can be retrieved by anyone with the filename.

## Where the data goes

The default flow sends data to a small number of external services.
The first three are part of every house; the rest are opt-in via env
config:

| Service | What it sees | When |
|---|---|---|
| Your AI provider (Anthropic for Claude, OpenAI for ChatGPT, or the GLM / Kimi / MiniMax / xAI endpoint you choose) | The whole context window: the conversation, the memories and chronicle passages the inlet adds, tool results. | Every turn. |
| Your server host (Hetzner, when you use the installer) | Everything on the app server: message stream, images, voice messages, mail, calendar, the runtime's session files, and `.env` with every key. The server is yours, but it runs in their data centre. | Always. |
| Cloudflare Tunnel | Every request to the app passes through Cloudflare's network on its way to your server. | Whenever the app is used. |
| OpenRouter (`OPENROUTER_API_KEY`) | Last-7-days observation summaries; a few passages from the chronicle for the dream note; the current user prompt at classification time. | Nightly daemon run (~01 UTC); nightly dream worker; every UserPromptSubmit hook fire. |
| Cloudflare Workers AI | Embedding requests (one chunk at a time) and the same content via `env.AI`. | Every event write; every search. |
| ElevenLabs (`ELEVENLABS_API_KEY`) | Whatever text you pass to `voice_reply`. | Per `voice_reply` call. |
| BFL / xAI / OpenRouter (`BFL_API_KEY` / `XAI_API_KEY` / `OPENROUTER_API_KEY`) | Image-generation prompts (and a reference image, when given), to the first of them that is set up. | Per `imagine` call. |
| Resend, through the email-sender worker (`EMAIL_SENDER_URL`) (only with the own-mail-address add-on) | Outbound mail headers + body. | Per `email` call (default: only after user approval). |
| Cloudflare Email Routing (email worker) (only with the own-mail-address add-on) | Inbound mail to the agent's address. | Per incoming mail. |
| The web search you configure (Brave or Tavily; none with your own SearXNG) | The search queries your agent sends. | Per `web_search` call under Brain. |
| The websites your agent opens | The request and your server's address, as with any browser. | Per `web_fetch` call and per page the browser tool opens. |
| Open-Meteo (weather module) | The place name once, to find its coordinates; after that only the coordinates. | When the weather line is refreshed (weather module on). |
| Your mail provider (IMAP and SMTP, or Microsoft Graph for Outlook; only when you connect a mailbox) | The sign-in to the mailbox and the mail requests themselves; the mail already lives there. | Per mail read, draft or send through that mailbox. |
| Cloudflare push (web-push library + VAPID) | Push title + ~200-char body preview. | Per outgoing reply when no client is currently connected. |
| The calendar service you subscribe with (Google, Outlook, Apple, …) | Title + time of the agent's non-private calendar entries. | Whenever it refreshes the feed (calendar module on, after you subscribe). Google and Outlook fetch from their servers. |

The memory worker's daemon prompt is the largest single chunk that leaves your
infrastructure. It contains the last 7 days of `observation` + `surface`
events — without journals or todos. Choose your OpenRouter model with
that in mind.

## What's in the database

Whatever the agent writes via the memory tool `write`. The defaults include:

- **Observations** — small factual notes the agent records about the
  user, the world, and itself.
- **Journals** — first-person scenes. **Not** embedded into Vectorize;
  retrievable only by direct DB read.
- **Relations** — directed edges between entities (who knows whom, who
  belongs to whom).
- **Todos** — actionable items.
- **Entity cards** — base records per named entity.
- **Dream notes** — nightly meta-cognition output.
- **Mood state** — current "inner weather" snapshot.

Anything the agent transcribes from a conversation can land in
observations or journals. There is no retroactive redaction layer; if
the agent learns and writes something private, it stays in the DB
until you delete it manually.

## Email blacklist

The Claude/app layer ships a `config/email-blacklist.ts` template. Edit
it before going public with the email pipeline. The default deployment
also makes every outbound mail require explicit user approval
(`EMAIL_AUTO_SEND_CLEAN=false`).

## Multi-user

There is no multi-user model. This stack is designed for one user with
one agent. If you adapt it for multiple people, reconsider every
"single-user assumption" mentioned in `SECURITY.md`.

## Deleting data

- The memory tool `delete <event_id>` removes one event from D1 + Vectorize.
- **Full wipe is a coordinated operation across stores, not one SQL command.**
  Stop agents, app writers, workers and scheduled jobs, imports, archive uploads,
  backfills and retries first. Inventory the actual resource names and local
  paths before removing anything; older installations keep their original names.
  Keep that checklist until every store is verified empty, and retry failed
  steps rather than treating a partial wipe as complete.
  - Memory: clear the memory D1, including hot and archive rows, images,
    edges, relations, entity cards, proposals, dreams, mood, daemon runs and
    their raw responses, and deletion plans. Remove its R2 archive and media
    objects and its Vectorize contents. Keep pending deletion IDs until their
    objects and vectors are gone.
  - Chronicle: remove RAG originals and chunks from R2, the RAG Vectorize
    contents, and the RAG D1 data, including FTS, `chunk_map`, `files`,
    `chunk_edges` and deletion plans. Deleting transcripts alone leaves indexes.
  - App server: remove message and email inboxes/outboxes, approvals, uploaded
    images, voice originals and converted files, public shares, calendars and
    external-calendar caches, push subscriptions, and activity/diagnostic logs
    and rotations. Include configured data directories outside the default path.
  - Local agent state: remove Brain conversation and task logs, session archives,
    parked and pending uploads, bridges and manifests, used bridges and jump
    copies, inlet caches, pins, self/user blocks and temporary exports. Include
    Claude session logs and exports and any browser profiles, traces, screenshots
    or storage exports that hold copies.
  - Backups: include file-edit backups, import sources and staging, migration
    backups, server snapshots, log rotations and system journals. Any archive
    or backup intentionally retained is an exception to the wipe, not deleted
    data; record its location and retention separately.
  - Phones and other clients: clear the app's site data on every device,
    including service-worker Cache Storage, HTTP caches, local/session storage
    and restored pages. Remove downloaded exports separately and refresh or
    remove external calendar subscriptions and their cached entries.
  Verify each database, bucket, vector index and local path independently before
  restarting anything; old imports and restore jobs must not repopulate them.
  Provider backups, D1 recovery history, model-provider retention, mail-provider
  archives and copies saved by recipients are separate boundaries. Follow the
  relevant provider's deletion process; an API success does not establish that
  those copies are physically erased.
- The repo deliberately does not ship a one-button purge endpoint.
