# Embervy — installation order

This guide walks you through standing up the full stack. The order matters:
each step ends with a **Check:** block that should pass before you move
on, except runtime checks explicitly queued until the harness is wired. If a gate fails, fix it before going further. Skipping
ahead is the single biggest source of broken installs.

The reference setup uses a small VPS for the agent's harness (Claude Code
or Brain) plus Cloudflare for the worker layer (D1, Vectorize,
R2, Workers; Email Routing only with the own-mail-address add-on). The VPS provider is your choice — see the
"Provider suggestions" section near the bottom. **Cloudflare is not:** the
memory layer (the memory worker, `rag`, the dream worker) is written against D1,
Vectorize, R2 and Workers AI and does not run anywhere else.

> **Prefer to click through it? There is a guided installer.**
> A desktop app for Windows and Linux (macOS later), sold as Embervy
> Quickstart from embervy.ai rather than shipped in this repository.
> Everything below is the manual path, which is fully self-contained.
>
> Either way: Cloudflare sign-in instead of token copy-pasting, resource
> provisioning, a generated `INFRASTRUCTURE.md`. This manual guide remains
> the reference for what the installer does under the hood and for anyone
> substituting providers.

---

## 0. Prerequisites

You need:

- A Cloudflare account — **required**, not optional (D1 + Vectorize + R2 +
  Workers AI all live there). **The free plan is enough to start** — a fresh agent, or importing up to
  ~4 MB of history (~45 sessions). Beyond that, one bottleneck bites
  (Vectorize stored dimensions) and you upgrade once to Workers Paid
  ($5/month; storage beyond the included amount costs cents — a 1 GB
  archive is ~$0.50/month). The import tool checks your data size and
  tells you *before* anything fails. R2 needs a payment method on file
  even on free.
- A domain in that Cloudflare account. On this manual path you register
  it (or move its nameservers) **before** step 5 — the guided installer is
  the only path that buys one for you, through Cloudflare Registrar, with
  the exact annual price shown before purchase. The app's public address
  goes through a Cloudflare Tunnel on that domain; ephemeral quick-tunnel
  URLs are not a supported address for a pinned phone app.
- A VPS where the agent will run (Claude Code — step 6a, or Brain — step 6b).
- An AI subscription or key for the chosen head: a Claude subscription
  for Claude Code or Brain's Claude head, a ChatGPT subscription through
  step 6c on either harness, or a supported model endpoint/key as described
  in the chosen harness's README.
- A workstation with `wrangler`, `bun`, `python3`, `git` and `openssl` installed.

Use Bash for the shell blocks below. Keep each machine's configuration
separate: steps 0–3b run in one workstation shell so their saved token
variables remain available; step 4 onward runs on the VPS.

**Check:** Run on the workstation. Replace the SSH address with your VPS.

```bash
wrangler whoami
bun --version && python3 --version && git --version && openssl version
ssh root@your-vps 'id -u; uname -s'
```

Expect the intended Cloudflare account and its account ID, tool versions,
and `0` followed by `Linux` from the remote shell. Keep that account ID:
set `account_id` in every worker's `wrangler.toml` before creating resources,
setting secrets or deploying. If more than one account is listed, choose
one explicitly; all three workers and their resources must use it.

---

## 1. Clone the repo

```bash
git clone <your-fork-of-Embervy>.git embervy
cd embervy
```

Set `EMBERVY_HOME` for everything below:

```bash
export EMBERVY_HOME=$PWD
echo "export EMBERVY_HOME=$PWD" >> ~/.bashrc
```

**Check:**

```bash
git -C "$EMBERVY_HOME" rev-parse --show-toplevel
git -C "$EMBERVY_HOME" diff --check
```

Expect the clone's absolute path and no whitespace errors. This exercises
Git against the working tree, not just the shell variable.

---

## 2. Deploy the rag worker (long-term archive)

The rag worker holds full session transcripts. The memory worker reaches
into it via a service binding for archive lookups, and the substrate
scripts upload session exports to it. It deploys under the name
`embervy-chronicle` (set in `wrangler.toml`); `RAG_URL` and the dream
worker's service binding use that name.

```bash
cd $EMBERVY_HOME/shared/rag
bun install
# Set account_id to the account ID from step 0 before any remote operation.
$EDITOR wrangler.toml

# Create resources (names match wrangler.toml).
wrangler r2 bucket create rag-storage
wrangler vectorize create rag-vectors --dimensions=1024 --metric=cosine

# D1 database for the BM25 half of hybrid search.
wrangler d1 create rag-fts
# Set database_id to the ID just returned, before executing the schema.
$EDITOR wrangler.toml
wrangler d1 execute rag-fts --remote --file=fts-init.sql

# Generate a strong token and store it both as a worker secret and locally.
umask 077
RAG_AUTH=$(openssl rand -base64 32)
echo "RAG_AUTH_TOKEN=$RAG_AUTH" >> $EMBERVY_HOME/.env
chmod 600 "$EMBERVY_HOME/.env"
wrangler secret put RAG_AUTH_TOKEN <<<"$RAG_AUTH"

# Edit wrangler.toml — replace YOUR_CLOUDFLARE_ACCOUNT_ID with your real
# ID, and YOUR_D1_DATABASE_ID with the id printed by `d1 create` above.
$EDITOR wrangler.toml

wrangler deploy
```

The search pipeline runs vector and BM25 in parallel, merges by RRF, and
reranks with a cross-encoder — see `shared/rag/README.md` for the details and
the one-time `/fts-backfill` step if you ever import an archive that
predates the D1 layer.

The cross-encoder rerank also powers **confidence gating** in the inlet worker
(`*/scripts/inlet-worker.ts`): reranked hits carry a real 0-1 relevance score,
so the inlet can drop weak matches instead of injecting them as if they were
real memories. Without it the inlet always returns its top-N, even when nothing
truly matched — and a query about a place the agent never visited drags in
random chunks that read as fabricated recall (drift). The gate uses an adaptive
floor per query category (strict for medical/technical where precision matters,
soft for identity/casual where a middling resonant hit still has worth), takes
the strictest floor of the turn so a loose query can't soften the pool, gates
before the top-N trim, and logs when it suppresses everything (so anti-drift
never silently becomes anti-memory). Tune the `RERANK_FLOORS` map from that log.
Gating only applies to reranked hits; if the rerank ever falls back to raw RRF
scores (~0.016), the gate stands aside rather than wiping everything out.

Set `[vars]` / `SESSION_PREFIX = "Session"` in this worker's
`wrangler.toml` (or your chosen archive prefix), using the same value as
`SESSION_PREFIX` on Claude Code or `BRAIN_SESSION_PREFIX` on Brain.
This is used for session-number searches; uploaded filenames come from
the harness. Make this edit before the deploy above, or redeploy after it.

The required secrets for this worker are:

| Secret | Value |
|---|---|
| `RAG_AUTH_TOKEN` | The archive bearer saved in the root `.env`. |

For an existing archive database, `fts-init.sql` creates missing tables
and indexes, not missing columns. The worker lazily creates the retrieval
graph and adds `chunk_edges.note`; it does not migrate arbitrary schema
changes. Inspect `PRAGMA table_info(chunks)`, `PRAGMA table_info(chunk_map)`,
`PRAGMA table_info(files)` and `PRAGMA table_info(chunk_edges)` with
`wrangler d1 execute rag-fts --remote --command=...` and compare with
`fts-init.sql`. Back up before changing an existing database. Add any other
missing columns by hand using the exact definitions in that file.

Save the deployed URL for subsequent checks and the VPS configuration:

```bash
read -rp 'Deployed archive URL (no trailing slash): ' RAG_URL
printf 'RAG_URL=%s\n' "$RAG_URL" >> "$EMBERVY_HOME/.env"
```

**Check:**

```bash
wrangler secret list
curl -sS -o /dev/null -w '%{http_code}\n' "$RAG_URL/list"
curl -sS -w '\n%{http_code}\n' -H "Authorization: Bearer $RAG_AUTH" "$RAG_URL/list"
```

Expect `RAG_AUTH_TOKEN` in the secret names, then `401`, then a JSON
`files` array and `200` (`files` is empty on a new archive). A listed
secret does not prove its value: the authenticated request does.

---

## 3. Deploy the memory worker (episodic memory)

```bash
cd $EMBERVY_HOME/shared/memory
bun install
# Set account_id from step 0 before any remote operation.
$EDITOR wrangler.toml

# Create the database, vector index, and archive bucket.
wrangler d1 create embervy-memory
# Copy the returned database_id into wrangler.toml before executing SQL.
$EDITOR wrangler.toml
wrangler vectorize create embervy-vectors --dimensions=1024 --metric=cosine
wrangler r2 bucket create embervy-archive

# Apply the schema.
wrangler d1 execute embervy-memory --remote --file=schema.sql

# Secrets.
wrangler secret put OPENROUTER_API_KEY      # any OpenAI-compatible LLM endpoint key
EMBERVY_API_KEY=$(openssl rand -base64 32)
printf 'EMBERVY_API_KEY=%s\n' "$EMBERVY_API_KEY" >> "$EMBERVY_HOME/.env"
wrangler secret put EMBERVY_API_KEY <<<"$EMBERVY_API_KEY"
wrangler secret put APP_PUSH_TOKEN      # bearer for /api/external/broadcast on your app — same value you'll set as EXTERNAL_PUSH_TOKEN in the app's .env
wrangler secret put RAG_AUTH_TOKEN <<<"$RAG_AUTH"  # same token as step 2

# Optional secrets:
# wrangler secret put BFL_API_KEY
# wrangler secret put XAI_API_KEY   # Grok Imagine: images with a reference face, animate (video)

# Edit wrangler.toml — replace YOUR_CLOUDFLARE_ACCOUNT_ID and any route /
# vars you want to set.
$EDITOR wrangler.toml

wrangler deploy
```

| Required secret | Value / purpose |
|---|---|
| `OPENROUTER_API_KEY` | Model key for the daemon and model-backed tools. |
| `EMBERVY_API_KEY` | Memory bearer saved above; used by the app, inlet and MCP. |
| `APP_PUSH_TOKEN` | Same value as the app's `EXTERNAL_PUSH_TOKEN` in step 5. |
| `RAG_AUTH_TOKEN` | Exactly the archive secret from step 2. |

Uncomment the `RAG` service binding in `wrangler.toml`, pointing at
`embervy-chronicle`. Set `PUBLIC_URL` to the deployed memory URL, `APP_URL`
to the app's public address when available, and `TIMEZONE` to the house's
IANA timezone. Leave unused video services empty. Do not keep template URLs.
Redeploy after these configuration edits.

**Existing D1 after an update:** do not create a replacement database or
assume a deploy applies `schema.sql`. Check `account_id`, `database_name`
and `database_id` against the intended database first. Back it up before
migration. Inspect the remote columns and compare them with `schema.sql`:

```bash
wrangler d1 execute embervy-memory --remote --command="PRAGMA table_info(events_hot); PRAGMA table_info(events_archive); PRAGMA table_info(mood_state);"
```

The repository supplies `migrations/001_archive_r2_recency_chunking.sql`
(`r2_path`, `summary`, `last_searched_at`, `last_engaged_at`, plus a data
update) and `migrations/002_correct_last_engaged_at.sql` (a one-off counter
correction). Only on a database that still needs all of 001, apply it with
`wrangler d1 execute embervy-memory --remote --file=migrations/001_archive_r2_recency_chunking.sql`,
then apply 002 with the same command and its filename. Do not replay them
on a fresh database or one already migrated: 001's ADD COLUMN statements
are not idempotent; 002 resets existing counters. For a partly migrated
database, apply only the missing statements after reviewing the data updates.
There is no complete migration runner. Other missing columns must be added
by hand with `ALTER TABLE ... ADD COLUMN ...`, copying the exact column
definition from `schema.sql`. Rerunning its CREATE TABLE statements does
not add columns. Runtime repair covers only five usage/injection columns
in `events_hot` on selected requests or daemon execution, not the full schema.
Inspect other tables with the same PRAGMA command if they differ.

```bash
read -rp 'Deployed memory URL (no trailing slash): ' EMBERVY_URL
printf 'EMBERVY_URL=%s\n' "$EMBERVY_URL" >> "$EMBERVY_HOME/.env"
```

**Check:**

```bash
wrangler secret list
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$EMBERVY_URL/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wake","arguments":{}}}'
curl -sS -w '\n%{http_code}\n' -X POST "$EMBERVY_URL/mcp" -H "Authorization: Bearer $EMBERVY_API_KEY" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wake","arguments":{}}}'
```

Expect all four secret names, `401` without a bearer, then `200` and a
`result.content` text containing the wake time line, not a JSON-RPC error
or `isError`. This reads the actual bound database; a public `/health`
response alone would not prove the protected memory path works.

---

## 3b. Deploy the dream worker (the third worker)

`wake` shows the latest unread dream note and `health` reports
`dream_last_run` — but nothing in steps 2 and 3 *writes* a dream. That
organ is a small separate worker in `shared/memory/dream-worker/`: once
per night it reads a few fragments from the chronicle (rag), free-
associates over them with a cheap model via OpenRouter, and inserts one
note into the memory worker's `dream_notes` table. It is deliberately its own worker
with its own failure domain and its own key, and it runs an hour after
the housekeeping daemon so it dreams over the *ranked* day. Skip it and
the dream slot simply stays empty — treat that emptiness as a health
signal, never as a fact about the night.

```bash
cd $EMBERVY_HOME/shared/memory/dream-worker
cp wrangler.toml.example wrangler.toml
# Add account_id at the top level (before [triggers]), using step 0's ID.
# Fill in: the memory worker's D1 database_id from step 3 (same DB, binding DB),
# the rag worker's script name (service binding RAG, `embervy-chronicle`
# from step 2), and the vars:
#   DREAM_HOUR      local hour to dream, default "4"
#   DREAM_TIMEZONE  IANA zone the hour is read in: the house's zone, default "UTC"
#   AGENT_NAME      the agent's name for the prompt (optional)
$EDITOR wrangler.toml

bunx wrangler deploy
bunx wrangler secret put OPENROUTER_API_KEY   # the model that dreams
DREAM_AUTH_TOKEN=$(openssl rand -base64 32)
printf 'DREAM_AUTH_TOKEN=%s\n' "$DREAM_AUTH_TOKEN" >> "$EMBERVY_HOME/.env"
bunx wrangler secret put DREAM_AUTH_TOKEN <<<"$DREAM_AUTH_TOKEN"
bunx wrangler secret put RAG_AUTH_TOKEN <<<"$RAG_AUTH"   # same token as step 2
```

The cron runs **hourly** (`0 * * * *`); the worker itself only dreams in
the hour that equals `DREAM_HOUR` in `DREAM_TIMEZONE`, which keeps daylight-
saving shifts out of the cron expression. The guided installer deploys this
worker for you as the third script (`embervy-dream`), next to
`embervy-memory` and `embervy-chronicle` (the rag worker), with
`DREAM_HOUR=4`.

| Required secret | Value / purpose |
|---|---|
| `OPENROUTER_API_KEY` | Model key for generating the note. |
| `DREAM_AUTH_TOKEN` | Separate bearer for manual `POST /dream`. |
| `RAG_AUTH_TOKEN` | The archive secret from step 2, also used over the binding. |

Use the same account ID and memory database ID as step 3, not a second
memory database. Set `DREAM_TIMEZONE` to the same house zone as the other
clocks. The manual call below creates a note and makes one paid model call.

```bash
read -rp 'Deployed dream URL (no trailing slash): ' DREAM_URL
```

**Check:**

```bash
bunx wrangler secret list
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$DREAM_URL/dream"
curl -sS -w '\n%{http_code}\n' -X POST "$DREAM_URL/dream" -H "Authorization: Bearer $DREAM_AUTH_TOKEN" && curl -fsS "$EMBERVY_URL/health"
```

Expect all three secret names, `401`, then `200` with `status: dreamed`
and nonempty `content`. The memory health response must show a non-null
`dream_last_run`; that proves the dream wrote to the memory worker's DB.

---

## 4. Set up the VPS (substrate runtime)

SSH to your VPS, install dependencies, clone the repo so `$EMBERVY_HOME`
points at it.

```bash
# As root on the VPS:
apt update && apt install -y git curl python3 ffmpeg jq tmux openssl
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"   # the Bun Embervy is built and tested with
npm install -g @anthropic-ai/claude-code   # Claude Code harness and Brain pipe heads

# (optional) install cloudflared if you want a public tunnel for the app:
# curl -fsSL https://pkg.cloudflare.com/install.sh | bash && apt install -y cloudflared

git clone <your-fork-of-Embervy>.git /opt/embervy
cd /opt/embervy
echo "export EMBERVY_HOME=/opt/embervy" >> /root/.bashrc
export EMBERVY_HOME=/opt/embervy
```

**Room to overflow — do this on any small VPS.** Without swap a memory
spike can kill processes instead of slowing them down. Keep some reserved
disk space so a full disk can be recovered.
The guided installer's `bootstrap.sh` does all of this itself; by hand it
is three commands (skip the first if `swapon --show` already lists swap;
the third also rotates the stack's own `logs/`, which otherwise grow
forever):

```bash
# 1. 4 GB swapfile, kept across reboots, used as overflow only:
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' >> /etc/fstab \
  && echo 'vm.swappiness=10' > /etc/sysctl.d/99-embervy-swap.conf && sysctl -p /etc/sysctl.d/99-embervy-swap.conf
# 2. 2 GB ballast — disk full? delete this file first, then clean up:
mkdir -p -m 700 /var/lib/embervy && fallocate -l 2G /var/lib/embervy/reserve.img && chmod 600 /var/lib/embervy/reserve.img
# 3. cap the journal at 500 MB, rotate $EMBERVY_HOME/logs weekly or at 50 MB:
mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/90-embervy.conf \
  && systemctl restart systemd-journald && apt install -y logrotate \
  && printf '"%s/logs/*.log" "%s/logs/*.jsonl" "%s/logs/*.err" {\n  weekly\n  maxsize 50M\n  rotate 4\n  compress\n  delaycompress\n  missingok\n  notifempty\n  copytruncate\n  su root root\n}\n' "$EMBERVY_HOME" "$EMBERVY_HOME" "$EMBERVY_HOME" > /etc/logrotate.d/embervy
```

Transfer the worker URLs and secrets from the workstation to the VPS
configuration over your secure SSH connection; the clone does not contain
those secrets. Keep the VPS root `.env` private (mode 600). Use
`/opt/embervy/Claude/app` for the shared app on either harness.

**Check:** Run on the VPS, not the workstation.

```bash
claude --version && bun --version && git -C "$EMBERVY_HOME" rev-parse --show-toplevel
swapon --show && free -h
df -h / && logrotate --debug /etc/logrotate.d/embervy
```

Expect tool versions, `/opt/embervy`, usable swap and disk space, and a
valid logrotate configuration with no errors. Debug mode does not rotate
logs. The services are tested again after reboot; also repeat `swapon --show`
then to confirm swap survived.

---

## 5. Configure the app layer

The app layer wants its own `.env`. Copy the template, fill it in. The
app lives in `Claude/app/` — for the Claude Code path and for Brain
alike:

```bash
cd $EMBERVY_HOME/Claude/app
cp ../../.env.example .env
$EDITOR .env
```

### Token map

The shared app and workers use the six secrets below. They guard
different boundaries; do not reuse one value across those boundaries.
Brain adds a separate local control token in step 6b.

| Token | Guards | Set on |
|---|---|---|
| `APP_PASSWORD` | The login form on the app's PWA. | App `.env`. |
| `APP_SESSION_SECRET` | HMAC signing key for session cookies. Required when `APP_PASSWORD` is set. | App `.env`. |
| `INTERNAL_API_TOKEN` | `/api/internal/*` endpoints on the app server (used by the watchdog and other localhost callers). | App `.env`. |
| `EXTERNAL_PUSH_TOKEN` | `/api/external/*` endpoints (used by the memory worker to push images / status into the app). | App `.env` as `EXTERNAL_PUSH_TOKEN` AND memory worker as `APP_PUSH_TOKEN` (same value, different name on each side). |
| `EMBERVY_API_KEY` | Every non-public memory worker route (`/mcp`, `/lookup`, `/touch`, `/due`, `/events`, `/graph`, media). Used by the Lore MCP server and inlet worker; Brain also uses it as `BRAIN_MEMORY_API_KEY`. | memory worker `wrangler secret put EMBERVY_API_KEY` AND `$EMBERVY_HOME/.env`; on Brain, the two memory-key names in `Brain/brain.env` (step 6b). |
| `RAG_AUTH_TOKEN` | The rag worker's `/upload` / `/search` / `/expand` / `/files` / `/edge` / `/list` / `/delete` / backfills. The rag worker fails closed when this is missing. | rag `wrangler secret put RAG_AUTH_TOKEN`, mirrored into `$EMBERVY_HOME/.env` and the memory worker's secrets; on Brain, also `RAG_AUTH_TOKEN` and `BRAIN_RAG_AUTH_TOKEN` in `Brain/brain.env` (step 6b). |

**Required:** `INTERNAL_API_TOKEN`, `EXTERNAL_PUSH_TOKEN`, `APP_PASSWORD`,
`APP_SESSION_SECRET`, `RAG_URL`, `RAG_AUTH_TOKEN`.

**Optional:**
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` — Web Push.
  Generate with `bunx web-push generate-vapid-keys`. Skip if you don't
  need browser push notifications.
- An own mail address for the agent is an Embervy Quickstart add-on that sets `EMAIL_SENDER_URL`, `EMAIL_SENDER_AUTH` and `EMAIL_WORKER_TOKEN` itself; leave them empty otherwise.
- `ELEVENLABS_API_KEY` — TTS for `voice_reply`. Skip for text-only.
- `BFL_API_KEY` — image generation with Flux at BFL. Without it (and
  without `XAI_API_KEY`) `imagine` paints over OpenRouter with
  `OPENROUTER_API_KEY`, charged to that key; with no key at all it answers
  that no image service is set up. Skip if the agent does not generate images.
- `XAI_API_KEY` — Grok Imagine (reference-face images, short video via
  `animate`). Skip if unused.
- `AGENT_NAME` — the agent's name for the daemon prompt and self-generated
  media (default "the agent").
- `TIMEZONE` — IANA zone for wake display and `due_at` input: the house's
  zone, the same as `EMBERVY_TIMEZONE` (default `UTC`; the installer sets it).
- `EMBERVY_AUTO_COMPACT` — Claude Code harness only: `off` (default) or
  `on`. Brain owns its cuts and does not use this switch. Who rewrites the
  window when it fills. `off`: the harness never summarizes the
  conversation in its own words — the watchdog (step 7) cuts near the
  limit, the bridge carries the last turns verbatim, the chronicle keeps
  every word, the inlet brings it back. Price: after a pause the full
  window is read cold once, and a long day costs more tokens than a
  summarized one. `on`: the harness compacts when the window fills —
  cheaper per turn, and the agent's day becomes a report it did not
  write. The Claude loop derives `DISABLE_AUTO_COMPACT` from this key.
- Ground-layer hooks, all `0` (off) by default — without them the ambient
  line every fifth turn is time, window fill and model only:
  `EMBERVY_HOOK_WEATHER=1` adds one weather line under the clock
  (Open-Meteo, keyless; needs `EMBERVY_WEATHER_PLACE`, costs a few tokens
  per fifth turn).
  `EMBERVY_BROWSER=1` gives the agent its own headless browser (see
  "Browser module" below).
  `EMBERVY_HOOK_CALENDAR=1` puts today's entries of the agent's calendar
  next to the clock (once per session start and day change), serves a
  read-only phone feed at `/calendar.ics?token=<CALENDAR_FEED_TOKEN>`
  (entries marked private and all notes stay off it) and reads your own
  calendars from `CALENDAR_ICS_URLS` (secret ICS links; read-only — no
  CalDAV, nothing is written to them in this release). Set
  `EMBERVY_TIMEZONE` for it. Subscribing on iPhone, Android/Google and
  Outlook, and where to find your secret links: `docs/calendar.md`.
  `EMBERVY_CACHE_PING=1` (Claude Code loop only, not Brain) turns on a
  silent keep-warm turn: `Claude/scripts/cache-ping.sh`, which the loop
  runs in the background and which checks every five minutes. It needs
  `EMBERVY_CACHE_PING_MINUTES`, the idle threshold. Set it below the
  provider's cache lifetime with room for the five-minute check: 50 for a
  verified 60-minute cache, 20 for a 30-minute one; others: measure first.
  Each ping is a full model call over the current window, so it only pays
  with a large window and short idle gaps. Details and safety checks:
  [`docs/cache-ping.md`](docs/cache-ping.md).
- Browser module (`EMBERVY_BROWSER=1`, optional): one persistent headless
  Chromium the agent drives from Bash — pages, clicks, forms, screenshots,
  logins that survive restarts. Install it once as root:
  `bash shared/tools/browser/install.sh` (Playwright + headless Chromium
  into `state/browser/`, plus Chromium's system libraries; its last line
  reads `browser_available=1`). The agent learns the tool from the skill
  `Claude/.claude/skills/browser/SKILL.md` — copy it to
  `.claude/skills/browser/SKILL.md` in the directory Claude Code runs in
  (the installer does both). Costs about 500 MB RAM while the browser runs
  (it starts on first use) and about 600 MB disk. Details:
  `shared/tools/browser/README.md`.

Generate the session secret with `openssl rand -base64 48` (the server
refuses to start with `APP_PASSWORD` set but `APP_SESSION_SECRET` empty).

Also create the house configuration on the VPS if it is not there yet.
Keep existing secrets from steps 2 and 3; do not generate replacements
just to fill this second file:

```bash
cp -n $EMBERVY_HOME/.env.example $EMBERVY_HOME/.env
$EDITOR $EMBERVY_HOME/.env
chmod 600 $EMBERVY_HOME/.env $EMBERVY_HOME/Claude/app/.env
```

Keep worker URLs, worker keys and app tokens consistent between the two
env files. The app and Claude Code loop read `Claude/app/.env`; the
inlet/export scripts and shared doctor also use the root `.env`. Brain
gets its own explicit profile in step 6b, not a wholesale import of either
file. Return to the app directory before installing its dependencies:

```bash
cd $EMBERVY_HOME/Claude/app
bun install
bun run server.ts &   # foreground first time, watch the log
```

**Check:** Run in another VPS shell while the app is running. Read env
files as data, never with `source .env`. Keep shell tracing off for all
secret checks in this guide.

```bash
. "$EMBERVY_HOME/shared/scripts/env-file.sh"; embervy_env_load -x "$EMBERVY_HOME/Claude/app/.env"
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3030/api/internal/model
jq -nc --arg password "$APP_PASSWORD" '{password:$password}' | curl -sS -D - -o /dev/null -X POST http://127.0.0.1:3030/api/auth -H 'Content-Type: application/json' --data-binary @- | sed -E 's/(embervy_session=)[^;]+/\1[redacted]/'
```

Expect `401` without an internal bearer and `HTTP/1.1 200` with a
`Set-Cookie: embervy_session=[redacted]` header from login. Open the app
and log in too; the chat shell must load.

Stop the foreground process (`fg`, then `Ctrl-C`) and put the app under
systemd so it restarts on crash and boot. `APP_DIR` is the app's working
directory:

```bash
APP_DIR=/opt/embervy/Claude/app
cat > /etc/systemd/system/embervy-app.service <<EOF
[Unit]
Description=Embervy app server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/root/.bun/bin/bun run server.ts
Restart=always
RestartSec=3s
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now embervy-app
```

The final check below restarts this unit and repeats the HTTP boundary
checks; `active` alone is not proof that login or internal calls work.

**Language.** The app is English. For another language, ask your agent
("make the app French"): it writes `strings.local.json` in the app
directory with the texts it changes plus `"language"`. That file is yours —
it is not in the repo, and no update (git pull, a new release) overwrites
or deletes it. See `Claude/app/README.md`.

Create a small local token check for both harnesses. It compares hashes
without printing secrets, then tries the local values against the deployed
workers. Cloudflare does not return secret values; HTTP authentication is
the remote side of the comparison. Run it after the chosen branch has
created `.mcp.json` and, on Brain, `Brain/brain.env`.

```bash
mkdir -p "$EMBERVY_HOME/state"
cat > "$EMBERVY_HOME/state/install-token-check.ts" <<'EOF'
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parseEnv } from "../shared/scripts/env-file.ts";
const home = resolve(import.meta.dir, "..");
const env = (p: string) => parseEnv(readFileSync(resolve(home, p), "utf8"));
const root = env(".env"), app = env("Claude/app/.env");
const mcp = JSON.parse(readFileSync(resolve(home, ".mcp.json"), "utf8")).mcpServers;
function same(label: string, values: Array<string | undefined>) {
  const hashes = values.map(v => v ? createHash("sha256").update(v).digest("hex") : "");
  if (hashes.some(h => !h) || new Set(hashes).size !== 1) throw new Error(label + ": missing or mismatched");
  console.log(label + ": match");
}
same("memory bearer", [root.EMBERVY_API_KEY, app.EMBERVY_API_KEY,
  mcp.lore?.headers?.Authorization?.replace(/^Bearer /, "")]);
same("memory URL", [root.EMBERVY_URL + "/mcp", app.EMBERVY_URL + "/mcp", mcp.lore?.url]);
same("archive bearer", [root.RAG_AUTH_TOKEN, app.RAG_AUTH_TOKEN]);
same("archive URL", [root.RAG_URL, app.RAG_URL]);
same("app internal bearer", [root.INTERNAL_API_TOKEN, app.INTERNAL_API_TOKEN]);
same("app push bearer", [root.EXTERNAL_PUSH_TOKEN, app.EXTERNAL_PUSH_TOKEN]);
if (root.EMBERVY_HARNESS === "brain") {
  const brain = env("Brain/brain.env");
  same("Brain memory bearer", [root.EMBERVY_API_KEY, brain.EMBERVY_API_KEY, brain.BRAIN_MEMORY_API_KEY]);
  same("Brain archive bearer", [root.RAG_AUTH_TOKEN, brain.RAG_AUTH_TOKEN, brain.BRAIN_RAG_AUTH_TOKEN]);
  same("Brain memory URL", [root.EMBERVY_URL, brain.EMBERVY_URL, brain.BRAIN_MEMORY_URL]);
  same("Brain archive URL", [root.RAG_URL, brain.RAG_URL, brain.BRAIN_RAG_URL]);
  same("Brain app bearer", [app.INTERNAL_API_TOKEN, brain.BRAIN_APP_TOKEN,
    mcp.app?.env?.INTERNAL_API_TOKEN || mcp.app?.env?.BRAIN_APP_TOKEN || brain.BRAIN_APP_TOKEN]);
} else {
  same("MCP app bearer", [app.INTERNAL_API_TOKEN, mcp.app?.env?.INTERNAL_API_TOKEN]);
}
for (const [label, url, token, body] of [
  ["memory", root.EMBERVY_URL + "/mcp", root.EMBERVY_API_KEY,
    {jsonrpc:"2.0", id:1, method:"tools/list", params:{}}],
  ["archive", root.RAG_URL + "/list", root.RAG_AUTH_TOKEN, null],
] as const) {
  const response = await fetch(url, {method: body ? "POST" : "GET",
    headers: {Authorization: "Bearer " + token, "Content-Type":"application/json"},
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000)});
  const data = await response.json();
  if (response.status !== 200 || (body ? !Array.isArray(data.result?.tools) : !Array.isArray(data.files)))
    throw new Error(label + ": authentication or response failed");
  console.log(label + ": authenticated 200");
}
EOF
chmod 600 "$EMBERVY_HOME/state/install-token-check.ts"
```

Keep the URLs without trailing slashes. This check does not read worker
secret values or prove the memory-to-archive token: the agent's `recall`
check in step 8 exercises that remaining edge. The dream call in step 3b
and a real app push exercise the other worker-to-worker/app edges.

**Check:**

```bash
. "$EMBERVY_HOME/shared/scripts/env-file.sh"; embervy_env_load "$EMBERVY_HOME/Claude/app/.env"; systemctl restart embervy-app && systemctl is-active embervy-app
curl -fsS http://127.0.0.1:3030/health
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $INTERNAL_API_TOKEN" http://127.0.0.1:3030/api/internal/model
```

Allow a few seconds for startup and repeat the HTTP checks if necessary.
Expect `active`, `{"ok":true}` and `200`. Repeat the login check above
after the restart. If you have configured a named tunnel, also open the
public HTTPS address and log in there; localhost alone does not prove the
tunnel or phone address works.

---

## 6. Choose the agent's harness

Pick **6a. Claude Code** or **6b. Brain**. These are two ways to run the
same house, not two services to stack on top of one another. Each branch
below is complete; follow only that branch, then continue at step 7.
Step 6c applies to either branch if you use a ChatGPT subscription.

The commands use the example house `/opt/embervy`, running as root, and
the app on port 3030 from step 5. Use your own paths consistently. Before
starting a harness, stop and disable the other harness's loop and watchdog
if they exist. Claude Code uses `embervy-loop` and `embervy-watchdog`;
Brain uses `embervy-brain` and `embervy-brain-watchdog`. Never leave
both pairs running against the same app inbox.

**Check:** Before starting either branch:

```bash
systemctl is-active embervy-loop embervy-watchdog embervy-brain embervy-brain-watchdog
```

Expect all four inactive (or not found) for a new installation. When
switching harnesses, the other branch's pair must be inactive. A nonzero
exit here is expected for inactive or absent units. The runtime checks
inside 6a and 6b marked **after First start** are queued checks: finish
that branch's wiring before running them; do not wake a half-configured
agent just to test an identity or notebook. Run queued prompts one at a
time, waiting for the tool result and app reply before sending the next.
All tmux checks assume the session names and default socket shown here;
use your configured session/socket if you changed them.

## 6a. Claude Code

### Identity

Copy the identity skeleton and fill it in for *your* agent. Save the
result as `CLAUDE.md` in the project root, here `$EMBERVY_HOME`. Do not
overwrite an identity file that is already yours.

```bash
cd $EMBERVY_HOME
cp -n Claude/CLAUDE.md.example CLAUDE.md
$EDITOR CLAUDE.md
```

The skeleton has load-bearing headings (Who I am, How I think, What I
write down, Initiative, How I write, Tools I use, What I am not, What
stays put, Infrastructure). Keep them; rewrite the bodies. Replace the
path and worker placeholders, and remove instructions for modules you
have not enabled. Without this file the agent has tools but no sense of
who it is or how to use them.

**Check:** After First start, ask the running agent to read the identity.

```bash
tmux send-keys -t embervy -l 'Read CLAUDE.md. Name its load-bearing headings and the configured memory and archive tools. Reply through the app reply tool.'
tmux send-keys -t embervy Enter
```

Expect an app reply describing your filled-in identity and actual tools,
not template text. A readable file alone does not pass.

### Notes

Claude Code keeps its own project notebook under
`~/.claude/projects/`, in the project's `memory/` directory with a
`MEMORY.md` index. These are rules, corrections and facts, not the Lore
or the chronicle. Keep that distinction in the identity file. There is
no `BRAIN_NOTES_DIR` setting on this path.

**Check:** After First start:

```bash
tmux send-keys -t embervy -l 'Use your project notebook to save a note that the installation notebook check ran. Read it back and tell me its notebook path through the app reply tool. Do not put this note in the Lore.'
tmux send-keys -t embervy Enter
```

Expect a real notebook write/read and an app reply naming the Claude Code
project memory path, not an episodic event or a Brain notes directory.

### Loop service

Make the shipped scripts executable and create the log and state folders
before systemd opens its log files:

```bash
cd $EMBERVY_HOME
chmod +x Claude/scripts/*.sh Claude/scripts/*.py shared/scripts/*.sh
mkdir -p logs state
cat > /etc/systemd/system/embervy-loop.service <<'EOF'
[Unit]
Description=Embervy Claude Code loop (tmux session "embervy")
After=network.target

[Service]
Type=simple
Environment=EMBERVY_HOME=/opt/embervy
ExecStart=/bin/bash /opt/embervy/Claude/scripts/loop-wrapper.sh
Restart=always
RestartSec=5
StandardOutput=append:/opt/embervy/logs/embervy-loop-service.log
StandardError=append:/opt/embervy/logs/embervy-loop-service.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable embervy-loop
```

Do not start it until the channel and inlet below are wired. The wrapper
keeps the unit alive while tmux session `embervy` lives, so
`Restart=always` catches a vanished session. The loop reads
`Claude/app/.env`; keep `EMBERVY_TMUX_SESSION=embervy` and
`EMBERVY_CHANNELS=app` there for this example. A Claude head needs a
Claude login: run `claude` once from the house folder and complete sign-in
and any first-start prompts before starting the unattended loop. For a
ChatGPT head, complete step 6c instead.

**Check:** After First start, while the agent is idle:

```bash
systemctl restart embervy-loop && systemctl is-active embervy-loop
tmux capture-pane -p -t embervy -S -80
```

Wait for startup and repeat the capture if necessary. Expect `active` and
a live prompt, then send a new app message and require an app reply. The
wrapper may retain its existing tmux session; the reboot check tests a
fully cold loop start.

### Cut and watchdog

Step 7a installs the separate `embervy-watchdog.service`. It reads the
Claude Code session JSONL, warns through `state/context_warning` and the
app, then runs `Claude/scripts/cutoff.sh`. The cut builds
`state/wake_bridge.md` and exports through
`Claude/scripts/session-to-rag.sh` before sending SIGTERM. The loop starts
a fresh session with the bridge after a planned exit; `--continue` is the
crash-recovery path, not the normal cut path. Clean exits also export,
unless a cut has just done so.

| Engine | Warn tokens | Cut tokens |
|---|---:|---:|
| Claude / GLM | 800000 | 900000 |
| GPT | 200000 | 220000 |
| Kimi | 180000 | 210000 |
| MiniMax | 150000 | 180000 |

Set `WATCHDOG_WARN_TOKENS` / `WATCHDOG_CUT_TOKENS`, or the per-engine
`WATCHDOG_WARN_TOKENS_<ENGINE>` / `WATCHDOG_CUT_TOKENS_<ENGINE>` (uppercase
engine), in `$EMBERVY_HOME/.env`. The watchdog uses that file if it exists,
otherwise `Claude/app/.env`; it rereads thresholds on every check. GPT,
Kimi and MiniMax take only their engine-specific keys, not the generic
pair. Keep duplicate settings in the app file consistent. See step 7a
for the running check.

**Check:** After First start, step 7a and the step 8 smoke test, while idle.
This deliberately cuts the current life; finish the test turns first.

```bash
bash "$EMBERVY_HOME/Claude/scripts/context_watchdog.sh" --thresholds
bash "$EMBERVY_HOME/Claude/scripts/cutoff.sh" && tmux capture-pane -p -t embervy -S -80
( . "$EMBERVY_HOME/shared/scripts/env-file.sh"; embervy_env_load "$EMBERVY_HOME/.env"; curl -fsS -H "Authorization: Bearer $RAG_AUTH_TOKEN" "$RAG_URL/list" )
```

Expect the intended engine's two thresholds, `Bridge OK`, `Export OK`
and a clean termination, followed by a new Claude Code life. Wait for the
loop to respawn and repeat the capture if needed. The archive list must
include the exported session with your prefix and next unused number.
Send a fresh app message and require a tool reply; recall content from the
cut life in the new one. A failed export must not be waved through just
because the loop still runs. Also complete step 7a's advancing-state check.

### App channel

Create `$EMBERVY_HOME/.mcp.json` with the two house servers below. Merge
these entries if you already have a configuration; do not replace other
servers. Replace the example bearer with the memory key from step 3 and
the app token with `INTERNAL_API_TOKEN` from step 5.

```json
{
  "mcpServers": {
    "app": {
      "command": "bun",
      "args": ["run", "/opt/embervy/Claude/app/mcp.ts"],
      "env": {
        "EMBERVY_HOME": "/opt/embervy",
        "EMBERVY_APP_HOST": "127.0.0.1",
        "EMBERVY_APP_PORT": "3030",
        "INTERNAL_API_TOKEN": "<app-internal-token>"
      }
    },
    "lore": {
      "type": "http",
      "url": "https://embervy-memory.<your-account>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <memory-api-key>" }
    }
  }
}
```

```bash
chmod 600 $EMBERVY_HOME/.mcp.json
```

Approve these project servers in Claude Code and allow the tools the
agent needs in its settings. In particular, `mcp__app__*` and
`mcp__lore__*` must not wait on an unattended permission prompt. Grant
filesystem and shell permissions only as broadly as you intend.

The app appends messages to `Claude/app/data/inbox.jsonl`. Its stdio MCP
bridge (`Claude/app/mcp.ts`) sends them to Claude Code as channel
notifications; the loop enables `server:app`. The agent answers with
`mcp__app__reply`, which posts to `/api/internal/broadcast` with the app's
internal bearer. Terminal prose alone does not reach the app. On the
first start the bridge begins at the current inbox end, so send your
first test message after the agent is listening.

The executable that matters is the `app.args` path in `.mcp.json`, not
another copy with the same filename. MCP reads code and environment when
its process starts. After editing that file or its configuration, restart
the MCP process (or the owning harness) and repeat the app round trip;
a browser refresh or app-server restart does not reload stdio MCP.

**Check:** After First start:

```bash
jq -r '.mcpServers.app | [.command, (.args | join(" "))] | join(" ")' "$EMBERVY_HOME/.mcp.json"
pgrep -af '^(/[^ ]*/)?bun (run )?/opt/embervy/Claude/app/mcp[.]ts([[:space:]]|$)'
claude mcp list
```

Expect the configured absolute `mcp.ts` path in both configuration and the
running command, with `app` and `lore` connected. Send a new app message;
only an actual `mcp__app__reply` reaching the app proves tool permissions
and the internal bearer. Do not print `.mcp.json` headers or env wholesale.

### Inlet

Merge this hook into `~/.claude/settings.json` (or the house's
`.claude/settings.json`); keep any other hooks and permissions:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/opt/embervy/Claude/scripts/inlet.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

This runs `Claude/scripts/inlet-worker.ts` on every user prompt. The
worker classifies the prompt, looks up memory, searches the chronicle
and gates weak reranked hits. An empty archive can legitimately produce
no retrieved block.

Set `EMBERVY_TIMEZONE` to the house's IANA zone and `EMBERVY_TIME_LABEL`
to its clock label in both root and app `.env`; do not accept `UTC` just
because it is the template default. Match the memory worker's `TIMEZONE`
and the dream worker's `DREAM_TIMEZONE` to that zone.

**Check:** After First start:

```bash
tmux send-keys -t embervy -l 'Quote the first clock line supplied by the inlet, without substituting the server clock, and reply through the app reply tool.'
tmux send-keys -t embervy Enter
```

Expect the first clock line to show local time in the configured zone.
The clock is emitted on the first hook turn and every fifth turn; if it
has scrolled out, inspect the current transcript. Confirm the hook ran in
that transcript, not merely that its configuration exists. The retrieval
content check follows in step 8; an empty archive is not a hook failure.

### Memory and chronicle

Keep `EMBERVY_URL`, `EMBERVY_API_KEY`, `RAG_URL`, `RAG_AUTH_TOKEN` and
`OPENROUTER_API_KEY` in `$EMBERVY_HOME/.env` and `Claude/app/.env`, using
the workers and secrets from steps 2 and 3. The Lore MCP server uses the
same memory URL and key; the inlet uses the unprefixed variables; the
export scripts use the RAG pair. Protect both env files with mode 600.

For archive header enrichment, make the shipped subagent available
without replacing an existing agent definition:

```bash
mkdir -p ~/.claude/agents
ln -s $EMBERVY_HOME/shared/subagents/auto-rag-header.md ~/.claude/agents/auto-rag-header.md
```

Skip the link if that destination already exists. The helper
`Claude/scripts/enrich-header.sh` calls this subagent through `claude -p`;
it needs a working Claude subscription login, independently of the main
head. Without successful enrichment the archive retains placeholder
header fields; that does not replace the transcript.

Set `SESSION_PREFIX=Session` explicitly in the root `.env` for this path;
choose a different stable prefix if needed. The export script reads and
exports that setting; do not put a shell-only prefix in an unrelated
worker's vars. Keep `AGENT_LABEL` and `USER_LABEL` explicit in both env
files too. The archive check after the first normal cut must show this
prefix and the next unused number, not just a successful HTTP upload.

**Check:** Before First start:

```bash
bun "$EMBERVY_HOME/state/install-token-check.ts"
```

Expect every comparison to say `match`, followed by memory and archive
`authenticated 200`. No token or hash is printed. Resolve any mismatch
before waking the agent. Step 8 then tests its own memory and recall tools.

### First start

```bash
$EMBERVY_HOME/Claude/scripts/start-claude-loop.sh
```

This opens tmux session `embervy`. Type `hello`, then send a message from
the app and ask for a reply through its reply tool. Detach with Ctrl-B,
then D, leaving the loop alive. Now let systemd watch that session:

```bash
systemctl start embervy-loop
systemctl status embervy-loop
```

Return to the queued checks above now that the branch is wired. Continue
at step 7a, not 6b.

**Check:**

```bash
systemctl is-active embervy-app embervy-loop
tmux capture-pane -p -t embervy -S -80
```

Expect both units `active` and a live Claude Code prompt without a pending
permission or sign-in dialog. Send a fresh app message after the channel
is listening and require an app reply through `mcp__app__reply`. Inspect
the current project JSONL for that tool result; terminal prose alone does
not pass. Rerun the capture after the reply, not while the model is busy.

## 6b. Brain

Brain is the repository's own harness. It owns the history, bridge,
archive and app inbox; the model that thinks is its **head**. There is
no package.json and **no `bun install` step in `Brain/`**. The shared app
still needs the dependencies installed in step 5. A pipe head uses the
Claude Code binary as a transport, not the Claude Code harness's loop.

### Identity

```bash
cd $EMBERVY_HOME
cp -n Claude/CLAUDE.md.example EMBERVY.md
$EDITOR EMBERVY.md
```

Keep the skeleton's headings, fill in the identity and infrastructure,
and remove instructions for modules you have not enabled. Do not
overwrite an existing identity. Brain reads `BRAIN_SYSTEM` at every pipe
birth and API turn, so every head gets the same agent-owned prompt.
Keep neither `CLAUDE.md` nor `AGENTS.md` beside it in the house folder:
a pipe head would load those too. If changing harnesses, preserve the
existing identity in `EMBERVY.md` rather than creating a second copy.

Create a small profile instead of running the reference template's
unfilled placeholders. `Brain/brain.env.example` explains every setting;
only add settings you actually use. These commands are for a new house;
edit an existing `Brain/brain.env` in place instead of overwriting it.

```bash
umask 077
mkdir -p Brain/state Brain/logs state logs Claude/app/data
chmod 700 Brain/state
cat > Brain/brain.env <<'EOF'
BRAIN_HEAD=claude
BRAIN_SYSTEM=/opt/embervy/EMBERVY.md
BRAIN_CLAUDE_CWD=/opt/embervy
BRAIN_CLAUDE_SETTING_SOURCES=user,project,local
BRAIN_CLAUDE_LOGIN_CHECK=1
BRAIN_CLAUDE_CONTEXT=1000000
BRAIN_CLAUDE_WATCHDOG_WARN=800000
BRAIN_CLAUDE_WATCHDOG_CUT=900000
BRAIN_STATE_DIR=/opt/embervy/Brain/state
BRAIN_LOG_DIR=/opt/embervy/Brain/logs
BRAIN_BRIDGE_FILE=/opt/embervy/Brain/logs/bridge.md
BRAIN_TMUX_SESSION=brain
BRAIN_WATCHDOG_STATE=/opt/embervy/state/watchdog_state.json
BRAIN_TIMEZONE=UTC
BRAIN_PIPE_PERMISSION=none
BRAIN_APPROVAL=off
BRAIN_CONTROL_PORT=3910
ENABLE_CLAUDEAI_MCP_SERVERS=false
EOF
printf 'BRAIN_CONTROL_TOKEN=%s\n' "$(openssl rand -hex 32)" >> Brain/brain.env
chmod 600 Brain/brain.env
```

This starts with the built-in Claude model; `BRAIN_CLAUDE_MODEL` can
select another model with the configured window. For a Claude first
head, run `claude` once to sign in on the account this service will use.
For GPT as the first head, complete step 6c instead before starting Brain. Keep secrets directly in
`Brain/brain.env`; do not import the entire house `.env` with
`BRAIN_EXTRA_ENV_FILE`, since it also carries Claude Code harness switches.
Do not leave blank assignments or unresolved placeholders in the profile.
Set `BRAIN_TIMEZONE` to the house's IANA timezone before starting; the
`UTC` line above is only a default. Match `EMBERVY_TIMEZONE` in both house
env files, memory `TIMEZONE` and `DREAM_TIMEZONE`.

**Check:** After First start:

```bash
tmux send-keys -t brain -l 'Read /opt/embervy/EMBERVY.md. Name its load-bearing headings and the configured memory and archive tools. Quote the first supplied clock line and reply through the app reply tool.'
tmux send-keys -t brain Enter
```

Expect your own identity and tools, not template text. The first clock
line must show local time in the configured timezone, not merely a local
label on a UTC time. Compare with your local clock. This checks the
prompt and clock the running head actually receives.

### Notes

```bash
mkdir -p notes
[ -e notes/NOTES.md ] || printf '# Notes\n' > notes/NOTES.md
printf 'BRAIN_NOTES_DIR=/opt/embervy/notes\n' >> Brain/brain.env
```

This gives every head the same notebook and a fresh `NOTES.md` index at
each pipe birth or API turn. Keep one line per note in the index, and
one file per note with frontmatter `name`, `description` and `type`.
These are rules, corrections and facts; experiences belong in the Lore.
With `BRAIN_NOTES_DIR` set, Brain disables Claude Code automatic memory
for its pipes so the notebook is not loaded twice.

If switching an existing house, inspect the Claude Code project
`memory/` directories under `~/.claude/projects/` for the house and any
previous `BRAIN_CLAUDE_CWD` (also check a custom `CLAUDE_CONFIG_DIR` if
used). Back up each whole source directory under `$EMBERVY_HOME/state/`
before moving anything. Move regular note files into `notes/`, merge
`MEMORY.md` index lines into `notes/NOTES.md`, and leave filename
collisions at the source until resolved — never overwrite them. Finish
this before starting Brain: those old notes no longer load automatically.

**Check:** After First start:

```bash
tmux send-keys -t brain -l 'Use /opt/embervy/notes/NOTES.md to save and index a short installation notebook check note, then read the note back. Reply through the app reply tool. Do not put this note in the Lore.'
tmux send-keys -t brain Enter
```

Expect an indexed note and an app reply quoting the saved content from
`notes/`, not the old Claude Code notebook. The agent needs explicit
filesystem permissions for this operation; do not broaden them silently.

### Loop service

```bash
chmod +x Brain/scripts/*.sh Claude/scripts/*.sh shared/scripts/*.sh
cat > /etc/systemd/system/embervy-brain.service <<'EOF'
[Unit]
Description=Embervy Brain (tmux session brain)
After=network-online.target embervy-app.service
Wants=network-online.target

[Service]
Type=simple
Environment=HOME=/root
WorkingDirectory=/opt/embervy/Brain
ExecStart=/bin/bash /opt/embervy/Brain/scripts/brain-loop-wrapper.sh
Restart=always
RestartSec=5
RestartPreventExitStatus=75
SuccessExitStatus=75
KillMode=control-group
TimeoutStopSec=240

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable embervy-brain
```

Do not start it yet. The wrapper hosts `brain-loop.sh` in tmux session
`brain`. Every restart is a fresh Brain life with its bridge. `/stop`
ends the loop deliberately; wrapper exit 75 prevents systemd from
restarting it. The long stop timeout leaves room for archival. Brain
loads `Brain/brain.env` itself: do not add the house `.env` as this unit's
`EnvironmentFile`. The loop scripts load the profile before starting
Brain and reload a changed profile at the next life.

**Check:** After First start, while the agent is idle:

```bash
systemctl restart embervy-brain && systemctl is-active embervy-brain
jq '{pid,session_id,head,model,transport,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/Brain/state/brain_context.json"
tmux capture-pane -p -t brain -S -80
```

Wait for a completed model turn and repeat the reads. Expect `active`, a
live new pid/session and the intended head and thresholds, then a fresh
app message answered through the reply tool. Confirm the old life archived
or was explicitly below its upload threshold; do not infer RAG delivery
from an exit code. The reboot check also tests a fully cold tmux start.

### Cut and watchdog

Step 7b installs **`embervy-brain-watchdog.service`**, bound to the Brain
unit. It is not started inside `brain-loop.sh`. Brain also checks the
window internally after model answers. Both use the running head's
thresholds, recorded in `Brain/state/brain_context.json`.

| Head | Warn tokens | Cut tokens |
|---|---:|---:|
| Claude, with the 1M profile above | 800000 | 900000 |
| GPT, with a 1M window | 200000 | 220000 |
| Other heads | 80% of their window | 90% of their window |

Use `BRAIN_<HEAD>_WATCHDOG_WARN` / `BRAIN_<HEAD>_WATCHDOG_CUT` in
`Brain/brain.env` (uppercase head). They win over `BRAIN_WATCHDOG_WARN` /
`BRAIN_WATCHDOG_CUT`, then the head preset or window-derived defaults.
Prefer the per-head pair: a global GPT budget would also cut a later
Claude head early. Brain rereads these settings at the next model call;
a cut above 95% of the current window is clamped and reported in
`/status`. Do not set the Claude harness's `WATCHDOG_WARN_TOKENS` /
`WATCHDOG_CUT_TOKENS` in Brain's service environment: those would override
the external watchdog's state-file thresholds.

At warning the external watchdog writes `Brain/state/context_warning`
and notifies the app. At cut it runs `Brain/scripts/brain-cutoff.sh`:
SIGTERM first, then **Brain itself** writes the bridge, local Markdown
archive and RAG export before exiting; the loop respawns it. The cut
script waits up to 180 seconds, then reports loudly if SIGKILL was
needed. Do not substitute `Claude/scripts/cutoff.sh` or
`session-to-rag.sh` for this path.

**Check:** After First start, step 7b and step 8, while idle. Complete at
least the configured minimum substantive turns for upload first (default
three). This deliberately cuts the current life; do not run it mid-turn.

```bash
bash "$EMBERVY_HOME/Brain/scripts/brain-watchdog.sh" --decide "$EMBERVY_HOME/Brain/state/brain_context.json" && bash "$EMBERVY_HOME/Brain/scripts/brain-watchdog.sh" --check-alive "$(jq -r .pid "$EMBERVY_HOME/Brain/state/brain_context.json")"
bash "$EMBERVY_HOME/Brain/scripts/brain-cutoff.sh" && tmux capture-pane -p -t brain -S -80
( . "$EMBERVY_HOME/Brain/scripts/brain-env.sh"; curl -fsS -H "Authorization: Bearer $BRAIN_RAG_AUTH_TOKEN" "$BRAIN_RAG_URL/list" )
```

Expect the running session's decision and cut threshold, `1` for a live
owned process, then `TERMINATED` and `bridge OK`, never a forced kill.
Wait for the new life and repeat the pane capture if necessary. The
archive list must include the completed life's prefix and next unused
number. Confirm the upload in the current event log, send a new app
message and recall content from the cut life through the memory tool.
A bridge alone does not prove upload. Step 7b also proves the external
watchdog advances.

### App channel

Edit `Claude/app/.env` and `$EMBERVY_HOME/.env` to identify this as a
Brain house, replacing conflicting assignments rather than appending
duplicates:

```ini
EMBERVY_HOME=/opt/embervy
EMBERVY_HARNESS=brain
EMBERVY_SUBSTRATE=brain
EMBERVY_TMUX_SESSION=brain
BRAIN_TMUX_SESSION=brain
EMBERVY_LOOP_SERVICE=embervy-brain
```

Remove `EMBERVY_BACKEND` on this path. The first head belongs in
`Brain/brain.env`, not the app's substrate setting. Keep worker URLs and
keys in the root `.env` too, so the shared doctor sees the same house.

Create `$EMBERVY_HOME/.mcp.json` (merge if it already exists):

```json
{
  "mcpServers": {
    "app": {
      "command": "bun",
      "args": ["run", "/opt/embervy/Claude/app/mcp.ts"],
      "env": {
        "EMBERVY_HOME": "/opt/embervy",
        "EMBERVY_APP_HOST": "127.0.0.1",
        "EMBERVY_APP_PORT": "3030"
      }
    },
    "lore": {
      "type": "http",
      "url": "https://embervy-memory.<your-account>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <memory-api-key>" }
    }
  }
}
```

The pipe loads this project MCP configuration from `BRAIN_CLAUDE_CWD`.
Merge permissions for `mcp__app__*` and `mcp__lore__*` into the house's
`.claude/settings.json`; add only the filesystem and shell permissions
you intend. `BRAIN_PIPE_PERMISSION=none` denies unanswered prompts — it
does not grant permissions. Brain's control tools can be allowed as
`mcp__brain__status`, `mcp__brain__effort`, `mcp__brain__pins`,
`mcp__brain__pin` and `mcp__brain__unpin`.

Add these lines to `Brain/brain.env`, replacing the token placeholder
with the app's `INTERNAL_API_TOKEN` from step 5:

```ini
BRAIN_APP_INBOX_FILE=/opt/embervy/Claude/app/data/inbox.jsonl
BRAIN_APP_URL=http://127.0.0.1:3030
BRAIN_APP_TOKEN=<app-internal-token>
BRAIN_APP_SOURCE=app
BRAIN_APP_MCP_SERVER=app
BRAIN_REPLY_GATEWAY=on
BRAIN_MCP_CONFIG=/opt/embervy/.mcp.json
BRAIN_MCP_SERVERS=app
```

Brain reads the inbox with its own byte cursor in
`Brain/state/app-inbox-cursor.json`; it does not use MCP channel
notifications as input. Replies use `mcp__app__reply`, whose MCP process
inherits `BRAIN_APP_TOKEN` and posts to `/api/internal/broadcast`. With
`BRAIN_REPLY_GATEWAY=on`, fallback prose also reaches the app, marked
with a lightning prefix, unless the shared off-file disables it.
For API heads, `BRAIN_MCP_CONFIG` starts the stdio `app` server for reply
tools; the HTTP Lore server is supplied separately by the memory pair
below. No second inbox reader needs to feed the pipe.

The app's head menu reads the control port and token from
`Brain/brain.env`. The generated control token is a separate secret,
not the app token. Once all these edits are complete, restart the app so
it reads the Brain settings:

```bash
chmod 600 .mcp.json Brain/brain.env .env Claude/app/.env
systemctl restart embervy-app
```

For API heads and pipe heads alike, `.mcp.json` names the stdio server
that must run. Editing another `mcp.ts` copy has no effect. Changes to
that server's code or environment take effect only after its MCP process
restarts; restart the owning harness when idle, not just the app server
or browser, then repeat the tool round trip.

**Check:** After First start:

```bash
jq -r '.mcpServers.app | [.command, (.args | join(" "))] | join(" ")' "$EMBERVY_HOME/.mcp.json"
pgrep -af '^(/[^ ]*/)?bun (run )?/opt/embervy/Claude/app/mcp[.]ts([[:space:]]|$)'
tmux send-keys -t brain -l 'Reply with installation app-channel check through mcp__app__reply, not terminal prose.'; tmux send-keys -t brain Enter
```

Expect the configured absolute path in the running command and the exact
check message in the app. A server listed in JSON or a fallback gateway
reply alone does not pass. On pipe heads, inspect the tool result too;
unanswered tool-permission prompts are failures.

### Inlet

Remove the `Claude/scripts/inlet.sh` UserPromptSubmit hook from any
Claude Code settings this house loads, retaining unrelated hooks.
**Do not install that hook for Brain.** Brain invokes the worker itself
before every turn; do not wire a second retrieval path. The shipped hook
also guards Brain subturns, but that is not a substitute for configuring
the correct harness.

Add to `Brain/brain.env`:

```ini
BRAIN_INLET=true
BRAIN_INLET_WORKER=/opt/embervy/Claude/scripts/inlet-worker.ts
BRAIN_INLET_WORKER_CWD=/opt/embervy
BRAIN_INLET_WORKER_LOG=/opt/embervy/Brain/logs/inlet-worker.log
EMBERVY_URL=https://embervy-memory.<your-account>.workers.dev
EMBERVY_API_KEY=<memory-api-key>
RAG_URL=https://embervy-chronicle.<your-account>.workers.dev
RAG_AUTH_TOKEN=<rag-auth-token>
OPENROUTER_API_KEY=<classifier-api-key>
```

Use the keys from steps 2 and 3 and your classifier key. The worker
reads the **unprefixed** names above, not `BRAIN_MEMORY_*` or
`BRAIN_RAG_*`. Brain passes its environment and a per-life counter and
chunk cache. Empty output or `BYPASS` means no retrieval this turn; a
configured worker failure is logged and the turn proceeds without an
inlet, not with a second fallback search. Without a configured worker,
Brain uses its simpler built-in memory/RAG search instead.

**Check:** After First start, send a new app question about a fact actually
stored in the archive, then run:

```bash
grep -hE '"type":"inlet_(injected|worker_empty|worker_failed)"' "$EMBERVY_HOME"/Brain/logs/session-*.jsonl | tail -n 5
tail -n 30 "$EMBERVY_HOME/Brain/logs/inlet-worker.log"
```

Expect a current-life `inlet_injected` event with relevant content after
the step 8 archive probe. On a fresh archive `inlet_worker_empty` is
allowed, but `inlet_worker_failed` is not a pass. Do not treat a matching
line from an older life as proof. Step 8 drives the agent's explicit
recall tool as well as this automatic retrieval path.

### Memory and chronicle

Add the runtime's own worker connection lines to `Brain/brain.env`,
using exactly the same URLs and secrets as the inlet:

```ini
BRAIN_MEMORY_URL=https://embervy-memory.<your-account>.workers.dev
BRAIN_MEMORY_API_KEY=<memory-api-key>
BRAIN_RAG_URL=https://embervy-chronicle.<your-account>.workers.dev
BRAIN_RAG_AUTH_TOKEN=<rag-auth-token>
BRAIN_SESSION_PREFIX=Session
BRAIN_REMINDERS_COLLECT=1
BRAIN_HEADER_ENRICH_CMD=/opt/embervy/Claude/scripts/enrich-header.sh
```

The runtime uses the `BRAIN_MEMORY_*` pair for memory and the
`BRAIN_RAG_*` pair for the archive. It discovers memory tools through `/mcp` for
API heads; pipe heads use the `lore` server in `.mcp.json`. Local archives
are in `Brain/logs/sessions/`, the bridge in `Brain/logs/bridge.md`, and
confirmed uploads go to the same chronicle worker as the other harness.
Ordinary short lives have a minimum-turn upload threshold; `/move`
requires RAG and forces the export before changing heads. Failed uploads
are retained for retry on a later start.

Make the header subagent available without overwriting an existing file:

```bash
mkdir -p ~/.claude/agents
ln -s $EMBERVY_HOME/shared/subagents/auto-rag-header.md ~/.claude/agents/auto-rag-header.md
```

Skip the link if the destination already exists. Header enrichment runs
`claude -p --agent auto-rag-header`; it needs its own working Claude
subscription login even if the main head is GPT. If that login is not
available, omit `BRAIN_HEADER_ENRICH_CMD`: transcripts still archive, but
header fields stay placeholders.

If calendar was enabled in step 5, also add
`BRAIN_CALENDAR_FILE=/opt/embervy/Claude/app/data/calendar.json` and
`BRAIN_CALENDAR_EXTERNAL_FILE=/opt/embervy/Claude/app/data/calendar-external.json`.
The app creates these data files. Use the same `BRAIN_TIMEZONE` as the
house's `EMBERVY_TIMEZONE`. Optional weather and web-search settings,
other heads and API workspace permissions are documented in
`Brain/README.md` and `Brain/brain.env.example`; do not enable them with
unfilled example values. Set `BRAIN_WORKER_NAME` and `BRAIN_USER_NAME`
explicitly for transcript speakers. Keep `BRAIN_SESSION_PREFIX=Session`
explicit and stable (or choose your own prefix); check the next unused
number and prefix in the chronicle after a normal archived life.

**Check:** Before First start:

```bash
bun "$EMBERVY_HOME/state/install-token-check.ts"
```

Expect all root/app/MCP and Brain runtime/inlet comparisons to say `match`,
then memory and archive `authenticated 200`, with no secret values printed.
The runtime and inlet use different variable names for the same bearers;
matching only one pair leaves part of the house disconnected. Step 8
proves the remaining memory-worker-to-archive edge through `recall`.

### First start

Before waking the agent, create its local house documents:

```bash
touch INFRASTRUCTURE.md HANDBOOK.md HOUSE.md
$EDITOR INFRASTRUCTURE.md HANDBOOK.md
```

In `INFRASTRUCTURE.md`, record the chosen harness, local paths, worker
URLs, enabled modules, service names, ports, tmux session and where each
secret is stored — never its value. In `HANDBOOK.md`, explain the Lore
versus notes, the chronicle and bridge, the cut, app reply tools,
permissions and approval policy, and the status/log/doctor commands in
steps 7–9. Point `EMBERVY.md` at both documents and require reading them
before changing the house. `HOUSE.md` is for the agent's own additions
to the map; leave it empty initially.

Create a first-turn file only for a house that has not run yet. Save
the current inbox end if there is no cursor, so messages arriving after
this preparation are not skipped by the first wake:

```bash
if [ ! -e Brain/state/app-inbox-cursor.json ]; then
  printf '{"offset":%s,"seen":[]}\n' "$(stat -c%s Claude/app/data/inbox.jsonl 2>/dev/null || echo 0)" > Brain/state/app-inbox-cursor.json
fi
cat > Brain/state/first-turn.md <<'EOF'
This is your first start in this house.
Read /opt/embervy/INFRASTRUCTURE.md and /opt/embervy/HANDBOOK.md fully before changing anything.
Then greet your user briefly through the app's reply tool.
EOF
cat >> Brain/brain.env <<'EOF'
BRAIN_FIRST_TURN_FILE=/opt/embervy/Brain/state/first-turn.md
BRAIN_HOUSE_MAP_EXTRA_FILE=/opt/embervy/HOUSE.md
BRAIN_GREET_PROMPT=Say hello briefly through the app's reply tool and pick up where you left off.
EOF
chmod 600 Brain/state/first-turn.md Brain/brain.env
```

Brain commits `Brain/state/first-turn-delivered` when that turn starts;
later births use the greeting prompt unless the user has already written.
If you have an imported bridge, put it at `Brain/logs/bridge.md` with
mode 600 before the first start, but never over an existing Brain bridge.
Do not invent earlier conversations in either the identity or the first
turn.

Complete step 7b to install and enable the bound watchdog, then run the
read-only configuration preflight from step 9b. Review `EMBERVY.md` and
the profile before the first deliberate start:

```bash
systemctl start embervy-brain
systemctl status embervy-brain embervy-brain-watchdog
journalctl -u embervy-brain -n 50
tmux attach -t brain
```

Detach with Ctrl-B, then D. Send `hello` from the app **after** Brain is
listening: without a saved cursor, the first start begins at the inbox
end. `/status` should report the intended head, model, transport and
thresholds. `/heads` lists configured heads; `/move <head>` archives and
starts a new life on another configured head. A saved
`Brain/state/brain-head.json` wins over `BRAIN_HEAD` on later starts, so
changing that env line alone does not replace a saved choice.

Run the queued checks above now that the branch is wired, then continue
with step 7b's live checks and step 8.

**Check:** After the first greeting and a fresh app message:

```bash
systemctl is-active embervy-app embervy-brain embervy-brain-watchdog
jq '{pid,session_id,head,model,transport,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/Brain/state/brain_context.json"
bash "$EMBERVY_HOME/Brain/scripts/brain-watchdog.sh" --check-alive "$(jq -r .pid "$EMBERVY_HOME/Brain/state/brain_context.json")"
```

Expect all three units `active`, the intended head/model/transport and
thresholds, and `1` for process liveness. Repeat the state read after a
model turn: tokens must increase. Both greeting and message must get app
replies through the tool, not just terminal output or gateway fallback.

---

## 6c. Thinking on a ChatGPT subscription

The adapter in `shared/tools/chatgpt-oauth-adapter.ts` serves either
harness from a ChatGPT login, without a model API key. With the Codex CLI
installed, run `codex login` once on the service account so that
`~/.codex/auth.json` exists. `CHATGPT_AUTH_FILE` can point at another
login file; keep it private. Choose the branch for your harness:

- **Claude Code:** in `Claude/app/.env`, set `EMBERVY_BACKEND=gpt`,
  `EMBERVY_GPT_MODEL` to your chosen model and a house-unique
  `EMBERVY_GPT_CACHE_KEY`. Use `GPT_ADAPTER_PORT=3041` in this example.
  Mirror the substrate choice as `EMBERVY_SUBSTRATE=gpt` in the root and
  app env files for the doctor. On the next loop start it launches the
  adapter as a detached process, points Claude Code at it and uses GPT's
  warn/cut defaults of 200000/220000 on a 1M window. Check the log: a
  missing login or failed adapter makes this loop fall back to Claude.
- **Brain:** in `Brain/brain.env`, set `BRAIN_HEAD=gpt`,
  `BRAIN_GPT_TRANSPORT=pipe`, `BRAIN_GPT_MODEL` to your chosen model,
  `BRAIN_GPT_CONTEXT=1000000`, `BRAIN_GPT_WATCHDOG_WARN=200000` and
  `BRAIN_GPT_WATCHDOG_CUT=220000`. Give it a stable, house-unique
  `BRAIN_GPT_CACHE_KEY` (1–128 ASCII letters, digits, dots, underscores or
  hyphens), `GPT_ADAPTER_PORT=3042`,
  `BRAIN_GPT_ADAPTER=/opt/embervy/shared/tools/chatgpt-oauth-adapter.ts`
  and `ADAPTER_NATIVE_WEB_SEARCH=1`. Keep `EMBERVY_SUBSTRATE=brain` in
  the app and root env files. Brain and its loop start only the transient
  system unit `brain-gpt-adapter-<identity>.service`; they never adopt a
  foreign listener. The identity is the first 16 hex characters of
  `sha256("gpt-adapter:" + BRAIN_GPT_CACHE_KEY)`. Before a turn, health
  must match that identity, numeric port, model and adapter settings. Leave
  startup to Brain, not a second manually started adapter. For an
  existing life use `/move gpt` after configuring the head: a saved head
  choice wins over `BRAIN_HEAD`.

The adapter's pipe front maps WebSearch to subscription search without a
separate search key. On Brain's alternative API transport
(`BRAIN_GPT_TRANSPORT=api`), `ADAPTER_WEB_SEARCH=1` enables that front's
built-in search; the app stdio and memory wiring in step 6b still apply.
The model's window is capacity; a later cut consumes more subscription
usage per message. Check the provider's current limits before raising it.

Inspect
`logs/chatgpt-oauth-adapter.log` (Claude Code) or
`Brain/logs/chatgpt-oauth-adapter.log` (Brain) for `[cache-diag]` lines;
cache percentages are diagnostic, not a guaranteed startup result.
`Brain/README.md` describes the managed GPT head; the adapter's protocol
and cache notes are in `shared/tools/CHATGPT-ADAPTER.md`.

**Check:** After the selected harness has completed a model turn, run only
the command for that harness:

```bash
curl -fsS http://127.0.0.1:3041/health
```

For Brain use this instead (one subshell, with no token output):

```bash
( . "$EMBERVY_HOME/Brain/scripts/brain-env.sh"; identity=$(printf 'gpt-adapter:%s' "$BRAIN_GPT_CACHE_KEY" | sha256sum | cut -c1-16); curl -fsS "http://127.0.0.1:$GPT_ADAPTER_PORT/health" | jq -e --arg identity "$identity" --arg model "$BRAIN_GPT_MODEL" --argjson port "$GPT_ADAPTER_PORT" '.ok == true and .identity == $identity and .model == $model and .port == $port' && systemctl is-active "brain-gpt-adapter-$identity.service" )
```

Expect `ok: true` and your model on Claude Code; Brain must print `true`
and `active`. Require a fresh app reply from that head too: adapter
liveness alone does not prove subscription access or a model answer.

---

## 7. Run the context watchdog

Run only your chosen harness's watchdog. Both warn before a cut and keep
the transcript, but the cut order differs: Claude Code's cut script
exports before SIGTERM; Brain handles SIGTERM and archives itself. The
threshold tables and setting names are in your step 6 branch.

**Check:** After completing 7a or 7b, run only the matching service query:

```bash
systemctl is-active embervy-watchdog
```

For Brain use `systemctl is-active embervy-brain-watchdog` instead.
Expect `active`; also run the advancing-state check in that branch below.
An active unit alone is not the watchdog done-gate.

### 7a. Claude Code

The watchdog is its own service. It reads token usage from the active
Claude Code JSONL (with context-limit and byte-size backstops), not from
Brain's state. By default it checks once a minute. It rereads threshold
settings from `$EMBERVY_HOME/.env`, falling back to `Claude/app/.env` only
if the root file does not exist. Engine-specific keys win as described
in step 6a; the loop also writes the running engine's defaults to
`state/watchdog_engine_thresholds`.

```bash
# Context watchdog — easiest as a systemd unit:
cat > /etc/systemd/system/embervy-watchdog.service <<'EOF'
[Unit]
Description=Embervy context watchdog (Claude Code)
After=network-online.target

[Service]
Type=simple
User=root
ExecStart=/opt/embervy/Claude/scripts/context_watchdog.sh
Restart=always
RestartSec=30
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now embervy-watchdog
```

**Check:** With the Claude Code loop running:

```bash
systemctl is-active embervy-loop embervy-watchdog
jq '{last_check_ts,session_file,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/state/watchdog_state.json"
sleep 65; jq '{last_check_ts,session_file,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/state/watchdog_state.json"
```

Expect both units `active`, a current session with the intended thresholds
and an advancing `last_check_ts`. Wait longer if you configured an interval
above 60 seconds. A state file from an earlier run does not pass; after a
new model turn confirm this session's token usage is being observed.

### 7b. Brain

Install the external watchdog alongside the Brain unit from step 6b:

```bash
cat > /etc/systemd/system/embervy-brain-watchdog.service <<'EOF'
[Unit]
Description=Embervy Brain context watchdog
After=embervy-brain.service
BindsTo=embervy-brain.service

[Service]
Type=simple
Environment=HOME=/root
WorkingDirectory=/opt/embervy/Brain
ExecStart=/bin/bash /opt/embervy/Brain/scripts/brain-watchdog.sh
Environment=PATH=/root/.local/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=10
KillMode=process

[Install]
WantedBy=embervy-brain.service
EOF
systemctl daemon-reload
systemctl enable embervy-brain embervy-brain-watchdog
```

Enabling the watchdog makes it start when `embervy-brain` starts;
`BindsTo` stops it when Brain stops. If Brain is already running, run
`systemctl start embervy-brain-watchdog` once. For the first wake, return
to step 6b and start **only** `embervy-brain`: its enabled dependency
starts the watchdog. There is no watchdog subprocess inside the loop.

The external script polls `Brain/state/brain_context.json` every 60
seconds by default. This record carries the running head's warn/cut
values; `BRAIN_*_WATCHDOG_*` changes reach it through Brain at the next
model call. An old timestamp alone is not a dead process. A dead or
foreign pid suppresses threshold actions; context-limit errors from
failed turns are a separate cut trigger. The script logs warning/cut
transitions, not a token line every idle minute.

```bash
systemctl status embervy-brain embervy-brain-watchdog
tail -n 30 $EMBERVY_HOME/Brain/logs/brain-watchdog.log
cat $EMBERVY_HOME/Brain/state/brain_context.json
cat $EMBERVY_HOME/Brain/state/watchdog_state.json
```

Expect a live Brain pid, the intended head/model/transport and
`warn_tokens` / `cut_tokens` in the context record. The watchdog state
has `last_check_ts`; it should advance across checks even while no one
is talking. Brain also writes app-compatible watchdog status internally
to `state/watchdog_state.json`, as set by `BRAIN_WATCHDOG_STATE` in this
profile; that is the default path the app and its watchdog tool read.
At a cut inspect `Brain/logs/brain-cutoff.log`, the bridge and local
archives. The queued Cut and watchdog check in step 6b exercises a
controlled cut after the smoke-test turns, not a forced kill.

**Check:** After returning to step 6b for First start:

```bash
systemctl is-active embervy-brain embervy-brain-watchdog
jq '{last_check_ts,session_id,tokens,cut_tokens,pid}' "$EMBERVY_HOME/Brain/state/watchdog_state.json"
sleep 65; jq '{last_check_ts,session_id,tokens,cut_tokens,pid}' "$EMBERVY_HOME/Brain/state/watchdog_state.json"
```

Expect both units `active` and `last_check_ts` advancing even when idle.
Wait longer for a configured interval above 60 seconds. Match the session
and cut threshold to the current context record from step 6b; this is the
external watchdog's state, not just Brain's app-compatible status file.
After a real cut require a new life, a bridge and a confirmed chronicle
upload, not just a clean process exit.

---

## 8. Smoke test

### Claude Code

Attach with `tmux attach -t embervy`, or send the request from the app.
Ask the agent to call `mcp__lore__wake`, write a small test observation
with `mcp__lore__write`, then retrieve it with `mcp__lore__find`. Send a
separate app message and require an answer through `mcp__app__reply`.
Check `logs/context_watchdog.log` and the current Claude Code JSONL for
the running session. For retrieval, ask about content you actually
stored; a new empty chronicle has nothing to return yet.

### Brain

Send the same wake/write/find request **from the app** after Brain is
listening. Pipe heads use `mcp__lore__wake`, `mcp__lore__write` and
`mcp__lore__find`; API heads get the memory worker's tools as `wake`,
`write` and `find` from `BRAIN_MEMORY_URL`. Require the reply through
`mcp__app__reply` on either transport. `/status` should answer in the
app and show the intended head and thresholds; then check
`Brain/state/brain_context.json` and `Brain/logs/conversation-<id>.jsonl`
for that life. In `Brain/logs/session-<id>.jsonl`, retrieval events are
`inlet_injected`, `inlet_worker_empty` or `inlet_worker_failed`; inspect
`Brain/logs/inlet-worker.log` for worker diagnostics. Do not add a Claude
Code inlet hook to cure an empty retrieval result.

For either harness, `wake` must answer from the memory worker, `write`
must confirm storage, and `find` must return the observation.
A fixed relevance score is not an installation guarantee. After a
normal cut, also verify a local bridge and a transcript in the chronicle;
a life below the minimum upload threshold need not create an upload.

Now test the just-deployed archive through the agent's own `recall`, not
only a direct `/search` request. Create a clearly labelled synthetic
installation probe, not a personal memory:

```bash
. "$EMBERVY_HOME/shared/scripts/env-file.sh"; embervy_env_load -x "$EMBERVY_HOME/.env"
printf '# Installation recall probe\n\nThis synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience.\n' > "$EMBERVY_HOME/state/install-recall-probe.md"
CHECK_SESSION=embervy; [ "${EMBERVY_HARNESS:-}" != brain ] || CHECK_SESSION=brain
```

**Check:** Run with the chosen harness idle:

```bash
curl -fsS -X POST "$RAG_URL/upload" -H "Authorization: Bearer $RAG_AUTH_TOKEN" -F "file=@$EMBERVY_HOME/state/install-recall-probe.md;filename=InstallCheck_1.md"
tmux send-keys -t "$CHECK_SESSION" -l 'Call the memory wake tool. Write a synthetic installation observation containing cobalt lantern memory check and read it back with find, reporting its event id. Then call the memory recall tool with query cobalt lantern recall check and report the source filename and returned text. Reply through mcp__app__reply. This is installation test data, not an experience.'
tmux send-keys -t "$CHECK_SESSION" Enter
```

Expect upload `success: true` with a positive chunk count, a real wake
time line, a stored event id and `find` returning that observation.
The explicit memory `recall` tool (`mcp__lore__recall` on pipe heads,
`recall` on API heads) must return `InstallCheck_1.md` and its probe text.
Inspect the actual tool results, not only the agent's claim. Send a
separate new app message too and require its reply in the app.

Allow indexing to settle, then retry retrieval if needed. A fresh database
with very few events can return no hits because its relevance threshold
rejects a weak match; this alone does not prove a broken deployment. The
inlet's rerank floors are category-dependent; do not assume every path
uses the same numeric threshold. Use the exact stored phrase,
inspect the current tool result and inlet diagnostics, and distinguish a
legitimate empty result from authentication, schema or binding errors.
Do not lower thresholds just to make this check green. If it still returns
nothing, leave content retrieval unverified rather than claiming success.
Keep the labelled probe until automatic inlet retrieval has also been
tested on the chosen branch. After a normal archived life, repeat recall
with content from that transcript and check the configured prefix and
number in the returned source.

## 9. Run the doctor

The shared doctor checks worker reachability, auth, fail-closed
behaviour, hybrid search, inlet, MCP, identity, disk, swap and dangerous
defaults. Run it on either harness, with the root `.env` containing the
worker URLs and keys configured in your step 6 branch.

### 9a. Claude Code

```bash
cd $EMBERVY_HOME
bun shared/tools/embervy-doctor.ts
```

It checks `CLAUDE.md`, the UserPromptSubmit inlet hook and the house
servers through `claude mcp list`. With `EMBERVY_SUBSTRATE=claude` it also
runs a small headless Claude canary; with `EMBERVY_SUBSTRATE=gpt` it checks
the Claude harness's adapter. Do not set `EMBERVY_HARNESS=brain` on this
path.

**Check:**

```bash
cd "$EMBERVY_HOME" && bun shared/tools/embervy-doctor.ts; printf 'doctor exit=%s\n' "$?"
```

Expect no `FAIL`, exit 0 or understood warnings with exit 1. Exit 2 is a
broken hop. Do not substitute this for step 8's live agent tool results.

### 9b. Brain

First run Brain's **configuration preflight**, before the first start:

```bash
cd $EMBERVY_HOME/Brain
bun scripts/brain-doctor.ts
```

Expect JSON with `"ok":true` and exit 0. Exit 1 is a failed preflight.
It checks the selected head, GPT cache key/port/login file/adapter script
when applicable, RAG configuration, writable inbox location and systemd
system bus. It makes no model calls and starts no service; it does not
prove worker reachability or that the model can answer.

After Brain is running, run the shared chain check too:

```bash
cd $EMBERVY_HOME
bun shared/tools/embervy-doctor.ts
```

`EMBERVY_HARNESS=brain` in the root `.env` selects Brain-aware checks;
`EMBERVY_SUBSTRATE=brain` avoids probing the other harness's adapter or
Claude canary. The doctor reads `Brain/brain.env`, checks `BRAIN_SYSTEM`
and duplicate identity files, the notebook and unread old Claude notes,
and `BRAIN_INLET_WORKER` instead of demanding a UserPromptSubmit hook.
For a Claude head it uses MCP connection reports from the latest pipe
initialization when available; otherwise it checks static server
configuration. That static check does not prove a live MCP conversation —
the app round trip and memory calls in step 8 still matter. Use the
state and service checks in step 7b for Brain's live watchdog.

**Check:** Preflight before First start, shared doctor after it:

```bash
(cd "$EMBERVY_HOME/Brain" && bun scripts/brain-doctor.ts); printf 'preflight exit=%s\n' "$?"
(cd "$EMBERVY_HOME" && bun shared/tools/embervy-doctor.ts); printf 'doctor exit=%s\n' "$?"
```

Expect preflight `ok: true` and exit 0. The shared doctor must have no
`FAIL`, with exit 0 or understood warnings at exit 1. A static MCP pass
still needs the app and memory round trips from step 8.

On either harness, no `FAIL` should remain. An empty or young chronicle
can legitimately skip content-dependent retrieval checks; a completely
healthy empty archive may print `HEALTHY — NEWBORN` instead of `PASS`.
Inspect every warning rather than treating it as proof of success.

For a background heartbeat and JSON status output, see
[`shared/tools/README.md`](shared/tools/README.md).

Before signing off, sweep the finished house, not the shipped examples.
The scan below reports only filenames and line numbers, never matching
lines that might contain credentials. It skips commented configuration
lines and checks both Claude Code and Brain identity/configuration paths
when present. Include any custom service or MCP configuration outside
these paths in the same review. Remove unused placeholder settings rather
than sending them to a live service.

**Check:**

```bash
python3 - <<'PY'
import os, pathlib, re, sys
home = pathlib.Path(os.environ['EMBERVY_HOME'])
files = [home / p for p in ('.env', 'Claude/app/.env', 'Brain/brain.env',
    '.mcp.json', 'CLAUDE.md', 'EMBERVY.md', 'INFRASTRUCTURE.md',
    'HANDBOOK.md', 'HOUSE.md')]
files += list((home / '.claude').glob('*.json'))
files += list((pathlib.Path.home() / '.claude').glob('*.json'))
files += [p for p in (home / 'shared').rglob('wrangler.toml')
    if 'node_modules' not in p.parts]
files += list(pathlib.Path('/etc/systemd/system').glob('embervy-*.service'))
pattern = re.compile(r'YOUR[-_]|example\.(?:com|invalid)|CHANGE_ME|<[^>\n]+>|/path/to/', re.I)
found = 0
for path in dict.fromkeys(files):
    if not path.is_file():
        continue
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if path.suffix != '.md' and line.lstrip().startswith(('#', ';')):
            continue
        if pattern.search(line):
            print(f'{path}:{number}: review template marker')
            found += 1
print('placeholder sweep: ' + ('review required' if found else 'clean'))
sys.exit(1 if found else 0)
PY
bun "$EMBERVY_HOME/state/install-token-check.ts"
```

Expect `placeholder sweep: clean`, matching token/URL groups and both
workers `authenticated 200`. Review any deliberately retained markup
rather than deleting real content blindly. The doctor must also have no
`FAIL`: shared exit 0 or understood warnings at exit 1, not exit 2. On
Brain, its separate preflight must exit 0; preflight exit 1 is a failure.

## 10. Reboot the finished house

Run this only after the selected branch, watchdog and smoke test pass,
while the agent is idle. Save any work and keep SSH access ready. This is
a deliberate host reboot, not an app refresh or service-status shortcut:

```bash
reboot
```

Reconnect by SSH, restore `EMBERVY_HOME=/opt/embervy` if needed, and wait
for the first greeting. Do not manually start a service to hide a failed
boot. Run only your branch's block.

**Check:** Claude Code:

```bash
systemctl is-active embervy-app embervy-loop embervy-watchdog
curl -fsS http://127.0.0.1:3030/health
tmux capture-pane -p -t embervy -S -80
```

Brain:

```bash
systemctl is-active embervy-app embervy-brain embervy-brain-watchdog
curl -fsS http://127.0.0.1:3030/health
jq '{pid,session_id,head,model,transport,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/Brain/state/brain_context.json"
```

Expect all three selected units `active`, app `ok: true`, and a live new
agent session without a login or permission prompt. Send a fresh message
from the public app, require its tool reply there, and repeat the chosen
step 7 advancing-state check. The other harness must remain stopped. The
first clock line must still show local time. If the loop, app or watchdog
needs manual help to return, the reboot check has failed; inspect the
unit journal and fix boot wiring before calling the installation done.

---

## Provider suggestions

The reference setup runs on a single small VPS. Anything that gives you
root + a stable IPv4 works. A few options people have used successfully:

- **Hetzner Cloud** — tiny instances are cheap, the network is fast,
  pay-by-the-hour.
- **Contabo / Hostinger / IONOS** — similar pricing tier, EU-friendly.
- **A spare home server / Raspberry Pi** — works fine if you have one
  exposed via Cloudflare Tunnel. Requires more babysitting.
- **Cloudflare-only setup** — if you want zero VPS: skip the Claude/app
  layer entirely and let an agentic CLI on your own laptop talk directly
  to the memory and rag workers via HTTPS-MCP. Less rich, but the memory layer still works.

The repo is VPS-provider-agnostic. The hard requirements are that the
chosen loop can keep running (`Claude/scripts/start-claude-loop.sh` in
step 6a or `Brain/scripts/brain-loop.sh` in step 6b), that the memory and
rag workers are reachable over HTTPS — and a Cloudflare account, because
that is where they run.

---

## Runtime defaults

Read each worker's `wrangler.toml` for its compatibility setting and
bindings. Model defaults are defined by the code and env templates;
select a supported model with the window configured for your harness.
Check installed Bun, Claude Code, `wrangler` and `cloudflared` versions
rather than assuming a successful clone installed the runtime.

---

## What can go wrong (and where to look first)

| Symptom | First place to look |
|---|---|
| Agent comes up cold every session | Claude Code: `state/wake_bridge.md` and `logs/cutoff.log`. Brain: `Brain/logs/bridge.md` and `Brain/logs/brain-cutoff.log`. |
| RAG search returns nothing | Claude Code: `state/uploaded_sessions`. Brain: `session_archive_upload` events in `Brain/logs/session-<id>.jsonl` and pending uploads in `Brain/state/pending_uploads.jsonl`. Then check the chronicle's authenticated `/list`. |
| Daemon never runs | `wrangler tail` on the memory worker overnight |
| Context watchdog silent | Claude Code: `systemctl status embervy-watchdog`. Brain: `systemctl status embervy-brain-watchdog`. Use the state/log checks in step 7. |
| Inlet not injecting context | Claude Code: the UserPromptSubmit hook and `logs/inlet.log`. Brain: `BRAIN_INLET_WORKER`, `Brain/logs/inlet-worker.log` and retrieval events from step 8. |
| App pushes don't arrive | `/api/internal/broadcast` returns 401? Check `INTERNAL_API_TOKEN`; on Brain check its matching `BRAIN_APP_TOKEN` too. |
| Runtime unexpectedly replaced | Claude Code: `logs/claude-loop.log`. Brain: `Brain/logs/brain-loop.log`. Both loops send a restart notice. |

Most issues come from one of: a missing secret, a wrong `account_id` in
`wrangler.toml`, or a path mismatch between `$EMBERVY_HOME` on the VPS
and the hard-coded path in a hook.
