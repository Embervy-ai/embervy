# Embervy memory worker — episodic memory

The memory worker is the substrate-independent memory layer. It speaks MCP (so any
agent running in any substrate can use it as a tool surface) and is
deployed as a Cloudflare Worker backed by D1 (relational), Vectorize
(embeddings), and R2 (cold archive, generated videos).

Worker version: `0.3.0` (reported by `health`).

## Tools exposed (MCP)

The worker exposes an opinionated set of 22 tools — enough to live in,
not enough to drown in.

| Tool | Purpose |
|---|---|
| `wake` | Full wake-up snapshot: time, goals, mood, surfaces, tentative edges, open todos, due reminders, unresolved observations, latest dream, daemon status. One call, replaces orient + ground + identity + observation round. |
| `write` | Universal insert — observation, relation, entity, journal, todo, goal. Discriminator is `kind`. Journals and goals are never embedded. Tag `canon:<key>` + entity turns an observation into a canon fact: a new stamp with the same (entity, key) replaces the old one (upsert). A todo may carry `due_at` (see Due reminders). |
| `edit` / `delete` | Lifecycle on existing events. `edit` patches content, weight, emotion, tags (and `status` for goals); a content change re-embeds by default and stamps goals as `checked`. |
| `find` | Hybrid (vector + keyword) search across hot memory and optional archive. Score threshold 0.5, recency-boosted (21-day half-life, 365 days with an entity filter). Hits count as a touch unless `touch: false`. |
| `scan` | Hot memory + chronicle (RAG) in parallel, sorted chronologically. |
| `recall` | Long-term chronicle lookup (hits the rag worker via service binding or `RAG_URL`). |
| `journal` | Browse the inner space: read own journals in full, chronologically. Deliberately no search — journals are a shelf, not a database. Reading leaves no ranking traces. |
| `engage` | Acknowledge a surface — creates a meta-observation, boosts the source events. |
| `resolve` | Mark an observation/surface as processed; writes a resolution note. |
| `todo` | List / touch / resolve / update todos. Create via `write(kind='todo')`. `resolve` deletes the row. |
| `collide` | Associative spark — throw 2–5 seeds, get resonant events from hot memory. |
| `edge` | Graph layer. Causal edges between events (`led_to`, `caused_by`, `emotional_consequence_of`): add (always tentative), confirm / reject, list. Also maintenance of the static person graph: `rel-list`, `rel-delete`, `entity-delete`. |
| `trace` | Walk confirmed causal edges from an event, back (causes) or forward (consequences), up to 6 hops. `deep: true` attaches the matching chronicle scene per hop, confidence-gated. |
| `imagine` | Image generation. Provider `grok` (Grok Imagine, needs `XAI_API_KEY`; keeps a face when given a reference) or `flux` (BFL Flux Pro / Flux Kontext Pro, needs `BFL_API_KEY`). `auto` picks grok when configured. Without those keys, or when they fail, it paints over OpenRouter with `OPENROUTER_API_KEY` (Flux 3 by default, `OPENROUTER_IMAGE_MODEL`), charged to that key. With no key at all imagine answers that no image service is set up. Stored as `kind=image` and pushed into the app by itself. |
| `animate` | Short video (1–15 s) with Grok Imagine Video (needs `XAI_API_KEY`) from a memory image, an image URL, or text. Async with `request_id`; result stored as `kind=video` in R2 and served via `/videos/<id>`. |
| `keep` / `see` | Store an image the user shares; retrieve stored images. |
| `watch` / `listen` / `see_video` | Video with frames + transcript, audio only, frames only (delegates to `VIDEO_BACKEND_URL`; not listed without it). |
| `health` | Diagnostic snapshot — counts, daemon status, Vectorize size, warnings. |

### Goals

`goal` — long-horizon goals the agent sets for itself; no decay, no
resolve, reviewed monthly (`edit` with status/content stamps `checked`).
Shown at the top of `wake`.

Status values: `open` (default), `closer`, `fulfilled`, `changed`. The
worker records `since` (last content change) and `checked` (last review)
in the event meta; `wake` prints both so a stale list is visible as a
date, not as a feeling.

### Due reminders

A todo written with `due_at` (local wall time `YYYY-MM-DD HH:MM` in
`TIMEZONE`, or ISO with offset) is a reminder **for the agent itself**,
not a task for the user. The worker stores `due_epoch` and exposes:

- `GET /due?until=<epoch ms>&limit=<n>` — due, unacknowledged todos.
  A short-interval cron in the agent's house polls this and delivers the
  hits into the agent's inbox (or the next prompt).
- `POST /due/ack {ids:[…]}` — marks `reminded_at` so nothing rings twice.

`wake` lists today's and overdue reminders in its own section.

## Architecture

- **`events_hot`** (D1) — every active event in one stream-centric table.
  Discriminator: `kind` (observation, relation, journal, todo, goal,
  surface, image, video, entity_card).
- **`events_archive`** (D1 + R2) — passive full-text archive after decay
  evicts an event. The summary stays in D1, the body lives in R2.
- **`event_edges`** (D1) — causal edges between events for `edge` /
  `trace` (from_event, to_event, relation, strength, status
  tentative/confirmed/rejected, proposed_by agent/daemon, reason). Only
  confirmed edges are traversed. Also created lazily by the worker.
- **`relations`** (D1) — directed, deduplicated edges between entities
  (the static person graph).
- **`entity_cards`** (D1) — base record per entity (name, type, primary
  context). A card follows its event on `edit`.
- **`dream_notes`** (D1) — nightly meta-cognition output, separate
  lifecycle from observations (written by the dream worker in
  `dream-worker/`).
- **`mood_state`** (D1, singleton) — inner-weather snapshot, updated
  nightly with two-night smoothing.
- **`daemon_runs`** (D1) — audit log and run lock of nightly daemon runs.
- **`resolution_proposals`** (D1) — resolutions the daemon proposed once;
  applied only when proposed again the next night.
- **`images_data`** (D1) — base64 image storage; videos go to R2 under
  `videos/<event_id>.mp4`.

Vectorize holds embeddings for every chunked event (400-char pieces with
80-char overlap for long texts; chunk ids `event-<id>-<n>`). Failed
embeddings are marked and retried by the nightly run or via
`POST /daemon/retry-embeddings`.

### Salience and touch counters

Every hot event carries counters that feed a nightly salience score:

| Column | Meaning |
|---|---|
| `last_searched_at` | updated on `find` / `scan` / `collide` / `recall` hits with score ≥ 0.5 |
| `last_engaged_at` | updated on `engage` or a substantive resolution |
| `access_count` | +1 per retrieval touch (find/recall/engage/see), damped nightly ×0.97 |
| `used_count` / `last_used_at` | +1 per "used" verdict of a context-injection membrane (`POST /touch source=membrane-used`), damped nightly ×0.99 — a separate counter from access |
| `injected_count` / `last_injected_at` | +1 per injection (`source=membrane-injected`); pure counter, no ranking effect |
| `distracting_count` | +1 per "distracting" verdict (`source=membrane-distracting`); pure counter |
| `salience` | computed nightly: weight × (1+0.3×emotion) × certainty × recency × (1+ln(1+access)) × (1+2·ln(1+used)) |

`wake` orders unresolved observations by salience. Missing columns are
added lazily by the worker (`ensureUsedColumns`), so an older database
keeps working after an upgrade; `schema.sql` carries them for fresh
installs.

## Eviction

Hot memory prunes itself by stagnation, not by inherent class. The
nightly daemon evicts to the cold archive when **both** `last_searched_at`
and `last_engaged_at` are stale (~21–28 days, depending on whether the
event has ever been touched). Evicted events keep their summary in D1 and
move their full body to R2 (insert and delete run in one transaction);
they remain reachable via `recall`.

The effect: anything you keep reaching for stays hot indefinitely;
anything you stop touching for a few weeks moves to the archive without
being lost. Goals and journals never decay.

## Daemon

`src/daemon.ts` runs nightly (cron 01 UTC by default, run lock 30 min).
It reads the last seven days, calls an OpenAI-compatible chat endpoint
(`DAEMON_LLM_URL` / `DAEMON_LLM_MODEL`, default OpenRouter + Mistral
Medium), validates the JSON, and proposes:

- **Surfaces** — recurring patterns the agent should see in the morning.
  Template-shaped surfaces ("X in various situations") are rejected.
- **Mood updates** — inner-weather snapshot, two-night smoothing.
- **Resolution proposals** — old unresolved observations that newer
  events have visibly closed off. Applied only when proposed on two
  consecutive nights (`resolution_proposals`).
- **Causal edges** (max 5) — `led_to` / `caused_by` /
  `emotional_consequence_of` between events, written as tentative
  `event_edges` after a time-direction check; the agent confirms via
  `edge`.
- **Consolidations** — only true duplicates, never thematic
  summarization. Removes the whole chunk range of the duplicate.
- **Mechanical decay** — weight-dependent decay, counter damping
  (`access_count` ×0.97, `used_count` ×0.99), salience recompute,
  archive eviction, embedding retry.

The daemon proposes; the worker code executes. The LLM has no direct DB
access. The prompt names the agent via `AGENT_NAME` (default "the
agent").

## HTTP endpoints

Everything except `/`, `/health` and (optionally) `/images/<id>` requires
`Authorization: Bearer ${EMBERVY_API_KEY}`; `/mcp/<token>` accepts the
token in the path for clients that cannot set headers. Prefer the header:
in the path form the key is part of every request URL. The worker is
deployed with Workers Logs off (they would store those URLs); turn them on
only while debugging, and rotate the key afterwards if a path-form client
was in use.

| Route | Purpose |
|---|---|
| `POST /mcp` | MCP JSON-RPC (tools/list, tools/call). |
| `GET /health` | Public liveness only: `{ok, version}`, without database reads. Counts and nightly diagnostics require the authenticated MCP `health` tool. |
| `GET /lookup?name=` | Entity card + relations + canon facts (`canon` field) for context injection. |
| `GET /events?entity=&kind=&days=&limit=&unresolved=` | Read-only list for nightly jobs — a list, not a search. |
| `GET /graph` | Entities, relations and causal edges in one JSON. |
| `POST /touch {ids, source}` | Report a touch: `membrane-used`, `membrane-injected`, `membrane-distracting`, or any other source (counts as retrieval). |
| `GET /due`, `POST /due/ack` | Due reminders (see above). |
| `GET /images/<id>` | Image bytes (auth-gated unless `PUBLIC_IMAGES=true`). |
| `GET /videos/<id>` | Video bytes from R2. |
| `POST /transcribe?language=<tag>` | Voice input from the app: the recording's bytes (webm/opus or mp4/aac, up to 20 MB) in, `{text}` out. Whisper large-v3-turbo on Workers AI in this account, about $0.0005 per audio minute. `language` is a hint (`de-DE` → `de`). |
| `POST /daemon/run`, `/daemon/decay`, `/daemon/retry-embeddings`, `/daemon/mode?mode=normal|backlog` | Manual daemon triggers. |
| `POST /migration/import`, `/import-entities`, `/import-relations`, `/import-dreams` | One-time import of an existing memory (`origin` in the body labels the rows). |

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `DB`, `VECTORS`, `AI`, `ARCHIVE` | yes | Bindings: D1, Vectorize, Workers AI, R2. |
| `EMBERVY_API_KEY` | yes | Bearer for every non-public route. |
| `RAG` (service binding) or `RAG_URL` + `RAG_AUTH_TOKEN` | for recall/scan/trace | The rag worker. |
| `OPENROUTER_API_KEY` | for the daemon | Key for the default daemon endpoint. |
| `DAEMON_LLM_URL`, `DAEMON_LLM_MODEL` | no | Any OpenAI-compatible endpoint/model for the daemon. |
| `AGENT_NAME` | no | The agent's name — prompt wording and entity on self-generated media. |
| `TIMEZONE` | no | IANA zone for `wake` display and `due_at` input: the house's zone, the same as `EMBERVY_TIMEZONE` (default `UTC`; the installer sets it). |
| `PUBLIC_URL` | no | This worker's public URL (used in returned media URLs). |
| `APP_URL`, `APP_PUSH_TOKEN` | no | App broadcast target for generated media. |
| `BFL_API_KEY` | no | Flux image provider (BFL). Without it (and without `XAI_API_KEY`) `imagine` paints over OpenRouter. |
| `OPENROUTER_IMAGE_MODEL` | no | Image model for `imagine` over OpenRouter (default `black-forest-labs/flux-3-image`). |
| `XAI_API_KEY` | no | Grok Imagine (images with reference face, `animate`). |
| `VIDEO_BACKEND_URL` | no | Backend for `watch` / `listen` / `see_video`. Empty or unset: the three tools are not listed (a call by name gets a clear error). |
| `PUBLIC_IMAGES` | no | `"true"` opens `/images/<id>` without auth (ids are enumerable — off by default). |

## Deploy

```bash
cd shared/memory
wrangler d1 create embervy-memory
wrangler d1 execute embervy-memory --remote --file=schema.sql
wrangler vectorize create embervy-vectors --dimensions=1024 --metric=cosine
wrangler r2 bucket create embervy-archive
wrangler secret put OPENROUTER_API_KEY
wrangler secret put EMBERVY_API_KEY     # bearer required by /mcp + everything else
wrangler deploy
```

Then point your substrate's MCP config at `https://embervy-memory.<your-account>.workers.dev/mcp`
(the installer registers it as the MCP server `memory`).

Upgrading an existing database: `schema.sql` is idempotent
(`CREATE ... IF NOT EXISTS`), but it does not add columns to an existing
`events_hot`. The worker adds the salience/touch columns lazily on first
use and creates `event_edges` on first access, so a deploy over an older
database needs no manual migration.
