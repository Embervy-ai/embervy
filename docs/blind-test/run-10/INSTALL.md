# Embervy — installation order

This guide walks you through standing up the full stack. The order matters:
each step ends with a **Check:** block that should pass before you move
on, except runtime checks explicitly queued until the harness is wired. If a gate fails, fix it before going further. Skipping
ahead is the single biggest source of broken installs.

If building only the shell for a later wake, finish configuration and
read-only checks but leave the loop and watchdog disabled and stopped.
Queue all enable/start, model-turn, cut and live watchdog checks until the
owner chooses the first start. A deferred check is not a pass.

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

## Building a second house on the same server

Use this section on a fresh server too. The commands below use the example
house `/opt/embervy`, unit prefix `embervy`, app port `3030`, control port
`3910` and sockets `embervy` or `brain`. Before running them, choose unused
values for this house and substitute them throughout commands, unit files,
MCP configuration and env files. Record the choices in `INFRASTRUCTURE.md`.
Do not inspect another house's secrets or stop its services.

- Use an unused `EMBERVY_HOME`, distinct app, loop and watchdog unit names,
  and a distinct tmux socket. Set `EMBERVY_HOME`, `EMBERVY_APP_SERVICE`,
  `EMBERVY_LOOP_SERVICE` and `EMBERVY_TMUX_SOCKET` in both house env files.
  On Brain also set `BRAIN_TMUX_SOCKET` in both files and `Brain/brain.env`,
  plus `EMBERVY_HOME` and `EMBERVY_TMUX_SOCKET` in the Brain profile. Keep the
  documented session name within that socket. Never use tmux's default socket.
- Check listeners with `ss -ltn` before choosing `EMBERVY_APP_PORT`,
  `BRAIN_CONTROL_PORT`, `GPT_ADAPTER_PORT` and, if enabled,
  `EMBERVY_BROWSER_PORT`. Keep all local services on loopback.
- List the Cloudflare account's Workers, D1 databases, Vectorize indexes,
  R2 buckets, tunnels and DNS records before creating anything. Choose a
  house prefix for every resource. The example defaults `rag-fts`,
  `rag-vectors` and `rag-storage` may already belong to another house.
  Never reuse a listed ID to get past a create error. Update every name,
  ID and service binding in all three worker configurations together.
- Give the tunnel its own credentials, config, metrics listener and
  `cloudflared-<name>.service` as in step 5. Never use the shared
  `/etc/cloudflared/config.yml` or `cloudflared service install` when
  another tunnel exists. Give logrotate its own `/etc/logrotate.d/<name>`.
- Use Claude setting sources `project,local`, not `user`: user-level
  hooks and agents can belong to another house. Keep hooks in the house.
  Subscription login may be shared deliberately, but model turns and
  keep-warm turns share its usage and rate limits too. Brain's
  `BRAIN_CACHE_PING=off` disables its optional keep-warm turns.
- Verify existing binaries before installing anything globally. Use the
  pinned local Wrangler after each worker's dependency install. Do not
  change host swap, ballast, journald or packages without coordinating
  with the host owner. A reboot affects every house, not just this one.

**Every manual command in this guide runs from a clean shell**, including
foreground tests, token checks, MCP probes, doctors and commands after SSH
reconnection. Start this shell on each machine before the first block;
do not carry an agent shell's credentials or `BRAIN_*` variables into it:

```bash
env -i HOME="$HOME" USER="$(id -un)" LOGNAME="$(id -un)" SHELL=/bin/bash \
  LANG=C.UTF-8 TERM=xterm \
  PATH="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" \
  /bin/bash --noprofile --norc
umask 077
set +x
export EDITOR=nano
```

Set `EMBERVY_HOME` explicitly in that shell once the house exists. Reload
only this house's env files as data with `shared/scripts/env-file.sh`.
Never append house settings to `~/.bashrc`. For Wrangler, also set
`XDG_CONFIG_HOME="$EMBERVY_HOME/state/wrangler-home"` and
`WRANGLER_SEND_METRICS=false`; read the Cloudflare credentials privately
in this shell. Later steps refer to these isolation rules rather than
repeating them. An existing shell with selected keys unset is not clean.

## 0. Prerequisites

You need:

- A Cloudflare account — **required**, not optional (D1 + Vectorize + R2 +
  Workers AI all live there). **The free plan is enough to start** — a fresh agent, or importing up to
  ~4 MB of history (~45 sessions). Beyond that, one bottleneck bites
  (Vectorize stored dimensions) and you upgrade once to Workers Paid
  ($5/month; storage beyond the included amount costs cents — a 1 GB
  archive is ~$0.50/month). The guided installer's import checks the data
  size first; on the manual path, check archive size and the account's
  Vectorize stored-dimension allowance before uploading. R2 needs a payment method on file
  even on free.
- A domain in that Cloudflare account. On this manual path you register
  it (or move its nameservers) **before** step 5 — the guided installer is
  the only path that buys one for you, through Cloudflare Registrar, with
  the exact annual price shown before purchase. The app's public address
  goes through a Cloudflare Tunnel on that domain; ephemeral quick-tunnel
  URLs are not a supported address for a pinned phone app.
- A VPS where the agent will run (Claude Code — step 6a, or Brain — step 6b).
- An AI subscription or key for the chosen head. Brain (step 6b) runs on a Claude subscription, a ChatGPT subscription (step 6c), or a supported model endpoint/key as described in Brain's README. Claude Code (step 6a) always needs a Claude sign-in (Pro, Max or Ultra), also when it later thinks with another head: Anthropic opens Claude Code's app channel only for a signed-in Claude account.
- A workstation with `bun`, `python3`, `git` and `openssl`; the worker
  dependency installs supply the pinned local `wrangler`.

Use Bash for the shell blocks below. Steps 0–3b run in one workstation
shell so their saved token variables remain available; step 4 onward runs
on the VPS. One Debian machine can serve both roles; keep its paths and
credentials consistent instead of cloning over an existing house.

Follow "Building a second house on the same server" for existing tools
and clean shells. Only on a clean Debian workstation, run as root (or use
`sudo` for apt):

```bash
apt update && apt install -y ca-certificates curl unzip git python3 openssl openssh-client nodejs npm nano
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
export PATH="$HOME/.bun/bin:$PATH"
export EDITOR="${EDITOR:-nano}"   # every "$EDITOR file" below opens this editor
bun --version
# Use the pinned local Wrangler after the worker installs in steps 2 and 3.
```

Both `shared/rag/bun.lock` and `shared/memory/bun.lock` pin Wrangler
**3.114.17**. Its newer-version warning can be ignored for these commands;
do not silently switch major versions during installation. Node/npm here
run Wrangler, not the agent. Bun's PATH and `EDITOR` must be exported
again in each new shell unless your shell profile already does it. Any
editor works; an automated install can make the same edits without one.

Use an existing Cloudflare API token without printing it or putting it in
shell history. Keep tracing off; this authenticates Wrangler without a
browser login:

```bash
set +x
read -rsp 'Cloudflare API token: ' CLOUDFLARE_API_TOKEN; printf '\n'
read -rp 'Cloudflare account ID: ' CLOUDFLARE_ACCOUNT_ID
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
export WRANGLER_SEND_METRICS=false
```

Scope the token to the intended account with **Workers Scripts: Edit**
(deploy, bindings, schedules and secrets), **D1: Edit** (create databases
and execute schemas), **Vectorize: Edit** (create indexes), **Workers R2
Storage: Edit** (create buckets), and **Account Settings: Read** (account
lookup). Steps 2–3b create two D1 databases, two Vectorize indexes, two R2
buckets and three Workers; the dream worker reuses the memory database.
Those steps use account-level Workers URLs and need no zone/DNS permission.
A custom route or the tunnel/domain setup needs its own permissions later.
Workers AI is bound in the worker configuration, not provisioned with a
separate Wrangler command here. Do not change billing settings to repair
a permission error. Tokens can be user-owned or account-owned: verify a
user token at `/user/tokens/verify`, an account token at
`/accounts/<account-id>/tokens/verify` on the Cloudflare API, without
printing the bearer. A token failing the other endpoint is not proof that
it is invalid. Tunnel creation and DNS routing may need a separate token
with Cloudflare Tunnel: Edit and DNS: Edit for the intended account/zone,
or the isolated browser login in step 5. In later shells, reload credentials privately as data
with `shared/scripts/env-file.sh`, never `source .env`.

**Check:** Run on the workstation. For two machines, replace the SSH
address with your VPS; on a single machine, run `id -u; uname -s` directly
instead of the SSH command.

```bash
# Run local `wrangler whoami` after the first worker's bun install in step 2.
bun --version && python3 --version && git --version && openssl version
command -v "$EDITOR"
ssh root@your-vps 'id -u; uname -s'
```

Expect the intended Cloudflare account and its account ID, tool versions,
the editor's path, and `0` followed by `Linux` from the VPS shell. Keep that account ID:
set `account_id` in every worker's `wrangler.toml` before creating resources,
setting secrets or deploying: TOML `account_id` wins over the environment.
If several accounts are listed, choose one for all workers and resources.

---

## 1. Clone the repo

```bash
git clone <your-fork-of-Embervy>.git embervy
cd embervy
```

An unpacked repository works the same: set `EMBERVY_HOME` to an unused
destination, run `cp -a /path/to/unpacked-repo "$EMBERVY_HOME"`, then
`git -C "$EMBERVY_HOME" init` if you want the later Git checks, and
`cd "$EMBERVY_HOME"` instead of cloning.

Set `EMBERVY_HOME` for everything below:

```bash
export EMBERVY_HOME=$PWD
umask 077
[ -e .env ] || cp .env.example .env
chmod 600 .env
chmod -R go-w "$EMBERVY_HOME"
export XDG_CONFIG_HOME="$EMBERVY_HOME/state/wrangler-home"
export WRANGLER_SEND_METRICS=false
# Replace a root env assignment without duplicating a template key or printing secrets.
root_env_set() {
  printf '%s' "$2" | ENV_KEY="$1" bun -e '
    const {readFileSync, writeFileSync} = await import("node:fs");
    const home = process.env.EMBERVY_HOME;
    const {envLine, envLineKey} = await import(home + "/shared/scripts/env-file.ts");
    const key = process.env.ENV_KEY;
    const file = home + "/.env";
    const lines = readFileSync(file, "utf8").split("\n").filter(l => envLineKey(l) !== key);
    lines.push(envLine(key, await Bun.stdin.text()));
    writeFileSync(file, lines.join("\n") + "\n", {mode: 0o600});
  '
}
```

**Check:**

```bash
test -f "$EMBERVY_HOME/INSTALL.md" && test -d "$EMBERVY_HOME/shared"
if [ -d "$EMBERVY_HOME/.git" ] || [ -f "$EMBERVY_HOME/.git" ]; then
  git -C "$EMBERVY_HOME" rev-parse --show-toplevel
  git -C "$EMBERVY_HOME" diff --check
else
  printf 'Unpacked house: %s\n' "$EMBERVY_HOME"
fi
```

Expect the house's absolute path and no whitespace errors for a clone.
An unpacked house needs no Git repository: the file/directory checks are
its gate. A newly initialized, untracked tree has no useful Git diff yet.
Remove group/world write access before installing dependencies; use the
copyfile backend below so later mode changes cannot reach a shared cache.

---

## 2. Deploy the rag worker (long-term archive)

The rag worker holds full session transcripts. The memory worker reaches
into it via a service binding for archive lookups, and the substrate
scripts upload session exports to it. It deploys under the name
`embervy-chronicle` (set in `wrangler.toml`); `RAG_URL` and the dream
worker's service binding use that name.

```bash
cd $EMBERVY_HOME/shared/rag
bun install --frozen-lockfile --backend=copyfile
chmod -R go-w node_modules
wrangler() { "$EMBERVY_HOME/shared/rag/node_modules/.bin/wrangler" "$@"; }
wrangler --version && wrangler whoami
# Set account_id to the account ID from step 0 before any remote operation.
$EDITOR wrangler.toml

# Follow the resource-name checks in "Building a second house on the same server".
# List first, then replace all example names below and in wrangler.toml.
# Use the account dashboard to list Workers as well.
wrangler d1 list
wrangler vectorize list
wrangler r2 bucket list
# Create resources (names match this house's wrangler.toml).
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
root_env_set RAG_AUTH_TOKEN "$RAG_AUTH"
chmod 600 "$EMBERVY_HOME/.env"
# Deploy once before secret put so Wrangler does not create a placeholder worker.
wrangler deploy
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
With only one candidate, reranking is deliberately skipped too:
`reranked: false` and a raw RRF score are not a reranker failure.

Add a `[vars]` section if absent and set `SESSION_PREFIX = "Session"` in this worker's
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
root_env_set RAG_URL "$RAG_URL"
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
bun install --frozen-lockfile --backend=copyfile
chmod -R go-w node_modules
wrangler() { "$EMBERVY_HOME/shared/memory/node_modules/.bin/wrangler" "$@"; }
# Set account_id from step 0 before any remote operation.
$EDITOR wrangler.toml

# Use this house's checked names from "Building a second house on the same server".
# Set the worker name, account_id and all resource names/bindings first.
# Create the database, vector index, and archive bucket.
wrangler d1 create embervy-memory
# Copy the returned database_id into wrangler.toml before executing SQL.
$EDITOR wrangler.toml
wrangler vectorize create embervy-vectors --dimensions=1024 --metric=cosine
wrangler r2 bucket create embervy-archive

# Apply the schema.
wrangler d1 execute embervy-memory --remote --file=schema.sql

# Set all vars and service bindings described below before this first deploy.
wrangler deploy
# Secrets. Omit the model key only with the degraded mode described below.
wrangler secret put OPENROUTER_API_KEY      # any OpenAI-compatible LLM endpoint key
EMBERVY_API_KEY=$(openssl rand -base64 32)
root_env_set EMBERVY_API_KEY "$EMBERVY_API_KEY"
wrangler secret put EMBERVY_API_KEY <<<"$EMBERVY_API_KEY"
# Bearer for /api/external/* on your app: the worker calls it APP_PUSH_TOKEN,
# the app's .env calls the same value EXTERNAL_PUSH_TOKEN (step 5).
PUSH_TOKEN=$(openssl rand -base64 32)
root_env_set EXTERNAL_PUSH_TOKEN "$PUSH_TOKEN"
wrangler secret put APP_PUSH_TOKEN <<<"$PUSH_TOKEN"
wrangler secret put RAG_AUTH_TOKEN <<<"$RAG_AUTH"  # same token as step 2

# Optional secrets:
# wrangler secret put BFL_API_KEY
# wrangler secret put XAI_API_KEY   # Grok Imagine: images with a reference face, animate (video)

# Edit wrangler.toml — replace YOUR_CLOUDFLARE_ACCOUNT_ID and any route /
# vars you want to set.
$EDITOR wrangler.toml

wrangler deploy
```

Without `OPENROUTER_API_KEY`, ordinary memory storage/search and archive
recall still work, but the nightly daemon and model-backed tools cannot
run. The inlet skips classification and person/place lookups and searches
the archive with the raw prompt. Omit the classifier key line rather than
leaving a blank placeholder. Skip step 3b until a model key is available;
its dream slot will remain empty. This is degraded mode, not a complete
nightly pipeline.

| Secret | Value / purpose |
|---|---|
| `OPENROUTER_API_KEY` | Needed for the daemon and model-backed tools; omit only in degraded mode. |
| `EMBERVY_API_KEY` | Memory bearer saved above; used by the app, inlet and MCP. |
| `APP_PUSH_TOKEN` | Generated above and saved in the root `.env` as `EXTERNAL_PUSH_TOKEN`; the app's `.env` gets the same value in step 5. |
| `RAG_AUTH_TOKEN` | Exactly the archive secret from step 2. |

Uncomment the `RAG` service binding in `wrangler.toml`, pointing at
`embervy-chronicle`. Set `PUBLIC_URL` to the deployed memory URL, `APP_URL`
to the app's public address when available. Add `TIMEZONE` and `AGENT_NAME`
under `[vars]` if absent, using the house's IANA timezone and agent name.
Leave unused video services empty. Do not keep template URLs.
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
root_env_set EMBERVY_URL "$EMBERVY_URL"
```

**Check:**

```bash
wrangler secret list
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$EMBERVY_URL/mcp" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wake","arguments":{}}}'
curl -sS -w '\n%{http_code}\n' -X POST "$EMBERVY_URL/mcp" -H "Authorization: Bearer $EMBERVY_API_KEY" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"wake","arguments":{}}}'
```

Expect all four secret names (three without the optional model key in
degraded mode), `401` without a bearer, then `200` and a
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

wrangler deploy
wrangler secret put OPENROUTER_API_KEY   # the model that dreams
DREAM_AUTH_TOKEN=$(openssl rand -base64 32)
root_env_set DREAM_AUTH_TOKEN "$DREAM_AUTH_TOKEN"
wrangler secret put DREAM_AUTH_TOKEN <<<"$DREAM_AUTH_TOKEN"
wrangler secret put RAG_AUTH_TOKEN <<<"$RAG_AUTH"   # same token as step 2
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
wrangler secret list
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$DREAM_URL/dream"
curl -sS -w '\n%{http_code}\n' -X POST "$DREAM_URL/dream" -H "Authorization: Bearer $DREAM_AUTH_TOKEN"
curl -fsS -X POST "$EMBERVY_URL/mcp" -H "Authorization: Bearer $EMBERVY_API_KEY" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"health","arguments":{}}}'
```

Expect all three secret names, `401`, then `200` with `status: dreamed`
and nonempty `content`. The memory worker's `health` tool must then show a
date after `Dream last run:` instead of `never`; that proves the dream wrote
to the memory worker's DB. (The public `/health` route only answers `ok` and
the version.)

---

## 4. Set up the VPS (substrate runtime)

SSH to your VPS and start the clean shell from "Building a second house
on the same server". Verify existing dependencies before any host-wide
install, then clone the repo so `$EMBERVY_HOME` points at it. On a single machine, reuse the house from step 1 and skip
the clone below.

```bash
# As root on the VPS:
apt update && apt install -y ca-certificates git curl unzip python3 ffmpeg jq tmux openssl nano
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"   # the Bun Embervy is built and tested with
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
export EDITOR="${EDITOR:-nano}"
bun --version

# Only if using the Claude Code harness, a claude pipe head, or header enrichment:
# Anthropic's native installer, no Node or npm needed; it puts `claude` in ~/.local/bin.
# curl -fsSL https://claude.ai/install.sh | bash

# (optional) install cloudflared if you want a public tunnel for the app:
# curl -fsSL https://pkg.cloudflare.com/install.sh | bash && apt install -y cloudflared

git clone <your-fork-of-Embervy>.git /opt/embervy
cd /opt/embervy
export EMBERVY_HOME=/opt/embervy
umask 077
[ -e .env ] || cp .env.example .env
chmod 600 .env
chmod -R go-w "$EMBERVY_HOME"
```

Claude Code is only needed for the Claude Code harness, Brain's `claude`
pipe transport (including other models run through that binary), or header
enrichment. An API-only Brain house without header enrichment can skip
Claude Code on the runtime VPS. The native installer above brings its own
runtime, so Debian's Node version does not matter for the agent; the
workstation's Node in step 0 only runs Wrangler.

**Security updates (Debian).** On a fresh host, or with the host owner's
agreement after reviewing existing APT policy, enable the same unattended
updates as the guided installer:

```bash
apt install -y unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
```

Keep Debian's default origins in `/etc/apt/apt.conf.d/50unattended-upgrades`
and leave `Unattended-Upgrade::Automatic-Reboot` at its default `false`;
do not add an automatic-reboot override, and review any existing overrides
on a reused host. The agent's session must not be cut by an automatic restart,
and the doctor warns when a server restart is due so you can choose a quiet moment.

**Room to overflow.** Follow "Building a second house on the same server"
for host-wide changes; inspect existing swap, ballast and journal policy
first. Run the host-wide block below only on a fresh host or with the
host owner's agreement. Without swap a memory
spike can kill processes instead of slowing them down. Keep some reserved
disk space so a full disk can be recovered.
The guided installer's `bootstrap.sh` does all of this itself; by hand it
is the following host-wide block plus a separate house-owned logrotate
file (skip the swap command if `swapon --show` already lists swap):

```bash
# 1. 4 GB swapfile, kept across reboots, used as overflow only:
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile \
  && echo '/swapfile none swap sw 0 0' >> /etc/fstab \
  && echo 'vm.swappiness=10' > /etc/sysctl.d/99-embervy-swap.conf && sysctl -p /etc/sysctl.d/99-embervy-swap.conf
# 2. 2 GB ballast — disk full? delete this file first, then clean up:
mkdir -p -m 700 /var/lib/embervy && fallocate -l 2G /var/lib/embervy/reserve.img && chmod 600 /var/lib/embervy/reserve.img
# 3. cap the journal at 500 MB (host-wide):
mkdir -p /etc/systemd/journald.conf.d && printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/90-embervy.conf \
  && systemctl restart systemd-journald
```

Install `logrotate` if absent, then create only this house's rotation
file, with the name chosen in "Building a second house on the same server":

```bash
LOGROTATE_NAME=embervy
# Review an existing file rather than overwriting another house's policy.
test ! -e "/etc/logrotate.d/$LOGROTATE_NAME" && printf '"%s/logs/*.log" "%s/logs/*.jsonl" "%s/logs/*.err" "%s/Brain/logs/*.log" "%s/Brain/logs/*.err" {\n  weekly\n  maxsize 50M\n  rotate 4\n  compress\n  delaycompress\n  missingok\n  notifempty\n  copytruncate\n  su root root\n}\n' "$EMBERVY_HOME" "$EMBERVY_HOME" "$EMBERVY_HOME" "$EMBERVY_HOME" "$EMBERVY_HOME" > "/etc/logrotate.d/$LOGROTATE_NAME"
```

The Brain patterns cover diagnostic text logs such as `brain-loop.log`,
`inlet-worker.log` and `chatgpt-oauth-adapter.log`, not `Brain/logs/*.jsonl`.
Conversation records (`conversation-*.jsonl`), session event records
(`session-*.jsonl`), local archives in `Brain/logs/sessions/` and the bridge
are not rotated away. They support catch-up archival and continuity;
manage their retention separately, after verifying archive delivery and
backups. If `BRAIN_LOG_DIR` differs from step 6b, adjust the diagnostic
paths to match it; do not replace them with a blanket JSONL glob.

Transfer the worker URLs and secrets from the workstation to the VPS
configuration over your secure SSH connection; the clone does not contain
those secrets. Keep the VPS root `.env` private (mode 600). Use
`/opt/embervy/Claude/app` for the shared app on either harness.

**Check:** Run on the VPS, not the workstation.

```bash
bun --version && test -f "$EMBERVY_HOME/INSTALL.md"
if [ -e "$EMBERVY_HOME/.git" ]; then git -C "$EMBERVY_HOME" rev-parse --show-toplevel; fi
# If Claude Code was installed:
# command -v claude && claude --version
swapon --show && free -h
df -h / && logrotate --debug "/etc/logrotate.d/$LOGROTATE_NAME"
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
[ -e .env ] || cp ../../.env.example .env
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
- `ALLOWED_IMAGE_EXTS` / `MAX_IMAGE_BYTES` — which files the app takes as
  uploads and the agent can send back with `send_file`. The default is images,
  PDF, text, CSV and Office files up to 20 MB; SVG stays off unless you add it.
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
`EXTERNAL_PUSH_TOKEN` is not new here: use the value step 3 saved in the
root `.env`, the one the memory worker holds as `APP_PUSH_TOKEN`. Without
push notifications, leave all three `VAPID_*` lines empty.

Also create the house configuration on the VPS if it is not there yet.
Keep existing secrets from steps 2 and 3; do not generate replacements
just to fill this second file:

```bash
[ -e "$EMBERVY_HOME/.env" ] || cp "$EMBERVY_HOME/.env.example" "$EMBERVY_HOME/.env"
$EDITOR $EMBERVY_HOME/.env
chmod 600 $EMBERVY_HOME/.env $EMBERVY_HOME/Claude/app/.env
```

Keep worker URLs, worker keys and app tokens consistent between the two
env files. The app and Claude Code loop read `Claude/app/.env`; the
inlet/export scripts and shared doctor also use the root `.env`. Brain
gets its own explicit profile in step 6b, not a wholesale import of either
file. Set `USER_LABEL`, `AGENT_LABEL`, `EMBERVY_TIME_LABEL` and
`EMBERVY_APP_URL` explicitly in both env files for tool descriptions,
transcript speakers, the clock and public links. Use the service names,
ports and sockets chosen in "Building a second house on the same server".
Use copyfile installs for all house dependencies: Bun's default backend
can hard-link world-writable cache files across houses. Do not chmod an
existing hard-linked node_modules tree; remove only this house's tree and
reinstall with `--backend=copyfile` first.
Return to the app directory before installing its dependencies:

```bash
cd $EMBERVY_HOME/Claude/app
bun install --frozen-lockfile --backend=copyfile
chmod -R go-w node_modules
bun run server.ts   # foreground first time, watch the log
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

Stop the foreground process with `Ctrl-C` in its terminal and put the app under
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
Environment=PATH=/root/.local/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin
Environment=ENABLE_CLAUDEAI_MCP_SERVERS=false

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
secret values or prove the memory-to-archive token. The direct `recall`
probe in step 8 can exercise that edge before any agent start; the live
agent's `recall` must still pass afterwards. The dream call in step 3b
and a real app push exercise the other worker-to-worker/app edges.

### Public address (Cloudflare Tunnel)

The phone reaches the app through a named tunnel on your domain; the app
itself keeps listening on `127.0.0.1` only. With `cloudflared` installed
(step 4), on the VPS as root:

Follow "Building a second house on the same server" for the name, DNS
record and port checks. This example uses a house-local browser login;
an account/zone token can instead create a locally managed tunnel and DNS
CNAME through the Cloudflare API. Do not replace a shared login certificate.

```bash
umask 077
TUNNEL_DIR="$EMBERVY_HOME/state/cloudflared"
mkdir -p "$TUNNEL_DIR/home"
chmod 700 "$TUNNEL_DIR" "$TUNNEL_DIR/home"
CLOUDFLARED_BIN=$(command -v cloudflared)
# Isolate the CLI's certificate and generated credentials from the shared HOME.
cloudflared() { HOME="$TUNNEL_DIR/home" "$CLOUDFLARED_BIN" "$@"; }
cloudflared tunnel login                     # open the link and pick your domain
cloudflared tunnel list                      # check that this house's name is unused
# Also check the account's DNS records before routing; never overwrite a record.
cloudflared tunnel create embervy
TUNNEL_ID=$(cloudflared tunnel list --name embervy --output json | jq -er 'if length == 1 then .[0].id else error("ambiguous tunnel") end')
mv "$TUNNEL_DIR/home/.cloudflared/$TUNNEL_ID.json" "$TUNNEL_DIR/$TUNNEL_ID.json"
cloudflared tunnel route dns embervy app.your-domain
cat > "$TUNNEL_DIR/config.yml" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $TUNNEL_DIR/$TUNNEL_ID.json
metrics: 127.0.0.1:0
ingress:
  - hostname: app.your-domain
    service: http://127.0.0.1:3030
  - service: http_status:404
EOF
chmod 600 "$TUNNEL_DIR/config.yml" "$TUNNEL_DIR/$TUNNEL_ID.json"
cloudflared --config "$TUNNEL_DIR/config.yml" tunnel ingress validate
cat > /etc/systemd/system/cloudflared-embervy.service <<EOF
[Unit]
Description=Embervy app tunnel
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
ExecStart=$CLOUDFLARED_BIN --no-autoupdate --config $TUNNEL_DIR/config.yml tunnel run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now cloudflared-embervy
```

Replace `app.your-domain` in both places with the chosen hostname, and
`3030` with this house's app port. The isolated certificate is only needed
for tunnel management, not for running the unit. Set the memory worker's
`APP_URL` to `https://app.your-domain` and redeploy it (step 3) if not already set.

**Check:** `systemctl is-active cloudflared-embervy` says `active`, and
`curl -sS -o /dev/null -w '%{http_code}\n' https://app.your-domain/health`
prints `200` from any machine.

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

### Moving in with an existing chronicle and memory

Import both **before the first agent start**, not after its greeting.
The guided installer handles history conversion and import; the manual
path uses the upload script and memory migration API below. Keep source
backups and prepare compatible exports first. Import only into this
house's checked worker URLs and resources from "Building a second house
on the same server".

For an archive of Markdown transcripts, choose the directory privately
and upload each file with this house's explicit root:

```bash
read -rp 'Directory containing the chronicle Markdown files: ' CHRONICLE_DIR
for file in "$CHRONICLE_DIR"/*.md; do
  [ -f "$file" ] || continue
  EMBERVY_HOME="$EMBERVY_HOME" bash "$EMBERVY_HOME/shared/scripts/smart_upload.sh" "$file" || break
done
```

Filenames must match `^[A-Za-z0-9._-]+\.md$`. The script splits files over
80 KB into `_partN` families. Check the account's Vectorize capacity first
(step 0), retain the source files, and verify authenticated `/list` plus
search of known text. Confirm the imported filename prefix, then set
`SESSION_PREFIX` in rag `[vars]` and `SESSION_PREFIX` (Claude Code) or
`BRAIN_SESSION_PREFIX` (Brain) to match before the first export. The next
session number comes from that prefix's highest archived number; do not
silently start a second numbering scheme.

Memory import is separate. POST JSON to these memory-worker routes with
`Authorization: Bearer` using this house's `EMBERVY_API_KEY`:

| Route | JSON body |
|---|---|
| `/migration/import` | `{"events":[...],"origin":"import"}`; each event needs `kind` and `content`. Preserve its `ts`, entity, tags and other supported fields. |
| `/migration/import-entities` | `{"entities":[...]}` with `name`, `entity_type` and optional context/description. |
| `/migration/import-relations` | `{"relations":[...]}` with `from_entity`, `to_entity`, `relation_type` and optional context/certainty. |
| `/migration/import-dreams` | `{"dreams":[...]}` with `created_at`, `content` and optional weight/read state/model. |

For example, after preparing `state/memory-import.json` in that format:

```bash
. "$EMBERVY_HOME/shared/scripts/env-file.sh"; embervy_env_load "$EMBERVY_HOME/.env"
curl -fsS -X POST "$EMBERVY_URL/migration/import" \
  -H "Authorization: Bearer $EMBERVY_API_KEY" -H 'Content-Type: application/json' \
  --data-binary "@$EMBERVY_HOME/state/memory-import.json"
curl -fsS -X POST "$EMBERVY_URL/daemon/retry-embeddings" -H "Authorization: Bearer $EMBERVY_API_KEY"
```

Inspect every `results` entry, not just the top-level `ok`: individual
events can fail. Import allocates new event IDs and is not idempotent;
keep a source-to-new-ID record and do not replay successful batches.
Use bounded batches and `shared/memory/src/index.ts`'s migration handlers
as the field contract, not a raw database dump. Other memory graph/state
needs an explicit migration plan; these endpoints are not a full database
restore. Events are embedded on insert except journals/goals; retry failed
embeddings until none remain, then verify known content with `wake` and
`find`. Import the agent's own instructions into the chosen identity file,
not the shipped new-agent skeleton. An optional bridge is handled in 6b.
Only then prepare the first-turn text and wake the agent.

## 6. Choose the agent's harness

Pick **6a. Claude Code** or **6b. Brain**. These are two ways to run the
same house, not two services to stack on top of one another. Each branch
below is complete; follow only that branch, then continue at step 7.
Step 6c applies to either branch if you use a ChatGPT subscription.

The commands use the example house `/opt/embervy`, running as root, and
the app on port 3030 from step 5. Apply the path, unit, port and socket
choices from "Building a second house on the same server" consistently. Before
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
All tmux checks assume the session names and named sockets shown here:
`embervy` for Claude Code, `brain` for Brain, never tmux's default socket.
Use your configured session/socket if you changed them; neighbour houses
must each have their own name. Empty socket settings use these defaults.

For an existing first house updating from the default socket, restart the
loop unit after updating. The units below use `KillMode=control-group`
(explicit for Brain, systemd's default for Claude Code), so the old server
inside the unit stops before its replacement starts on the named socket.
Other sessions inside that old server stop too; move unrelated terminal
work out before restarting. If the old loop escaped into a server outside
the unit, a restart cannot stop it: finish and stop that loop separately,
wait for archival, and verify its house session is gone from `tmux ls`.
Do not kill the default server wholesale; it may hold unrelated work.

## 6a. Claude Code

This branch needs a Claude sign-in, even if the agent will think with another head (ChatGPT through step 6c, GLM, Kimi or MiniMax). Without it Claude Code reports its app channel as "not currently available", and messages from the app never reach the agent. Sign in once with claude and /login before First start, and keep that sign-in.

### Identity

Copy the identity skeleton and fill it in for *your* agent. Save the
result as `CLAUDE.md` in the project root, here `$EMBERVY_HOME`. Do not
overwrite an identity file that is already yours.

```bash
cd $EMBERVY_HOME
cp -n Claude/CLAUDE.md.example CLAUDE.md
$EDITOR CLAUDE.md
```

The neutral template has headings for Who I am, Memory, Tools,
What stays put and Infrastructure. Who I am holds one line saying the section
starts empty, then an empty `<!-- identity -->` / `<!-- /identity -->` block
for an identity the person brings; it prescribes no role or writing style.
Leave that block empty for a new agent to complete. Replace the path, host, date and worker URL placeholders, and remove marked
instructions for modules you have not enabled. Operational how-tos are in
`HANDBOOK.md`, generated below, rather than in the identity prompt.
`EMBERVY_IDENTITY_RULE` in the root or app `.env` (app takes precedence) defaults to `own`; set it to `together` so the generated handbook says the identity is written together and changes need the person's okay, with before and after text shown under either rule.
Keep the `@CAPABILITIES.md` line inside the `<!-- harness:claude-code -->`
block and delete only the two marker lines around it: Claude Code loads the
imported list at every start.

**Check:** After First start, ask the running agent to read the identity.
Wait half a second between literal text and Enter: a menu that just closed can swallow an immediate Enter.

```bash
tmux -L embervy send-keys -t embervy -l 'Read CLAUDE.md. Name its load-bearing headings and the configured memory and archive tools. Reply through the app reply tool.'
sleep 0.5
tmux -L embervy send-keys -t embervy Enter
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
tmux -L embervy send-keys -t embervy -l 'Use your project notebook to save a note that the installation notebook check ran. Read it back and tell me its notebook path through the app reply tool. Do not put this note in the Lore.'
sleep 0.5
tmux -L embervy send-keys -t embervy Enter
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
Environment=EMBERVY_HOME=/opt/embervy ENABLE_CLAUDEAI_MCP_SERVERS=false
ExecStart=/bin/bash /opt/embervy/Claude/scripts/loop-wrapper.sh --settings /opt/embervy/state/claude-settings.json --setting-sources project,local
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
`Claude/app/.env`; set `EMBERVY_TMUX_SESSION=embervy`, `EMBERVY_CHANNELS=app`
and `ENABLE_CLAUDEAI_MCP_SERVERS=false` there. Every head on Claude Code needs a
Claude sign-in for the app channel: run `ENABLE_CLAUDEAI_MCP_SERVERS=false claude --settings "$EMBERVY_HOME/state/claude-settings.json"
--setting-sources project,local` once from the house folder after creating
the settings below. Complete sign-in, interactive workspace trust and MCP
approval before starting the unattended loop. This interactive trust
writes a project entry in the service account's Claude configuration;
coordinate that write with its owner, or use a separate service account. For a
ChatGPT head, also complete step 6c; keep the Claude sign-in.

**Check:** After First start, while the agent is idle:

```bash
systemctl restart embervy-loop && systemctl is-active embervy-loop
tmux -L embervy capture-pane -p -t embervy -S -80
```

Wait for startup and repeat the capture if necessary. Expect `active` and
a live prompt, then send a new app message and require an app reply. The
restart ends the old server through systemd's default `KillMode=control-group`
and starts a new life. A server outside the unit's cgroup is refused, not
adopted or killed; finish and stop a hand-started loop before unit start.

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

GLM, GPT, Kimi and MiniMax on Claude Code also need the Claude sign-in for the app channel.

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
bash "$EMBERVY_HOME/Claude/scripts/cutoff.sh" && tmux -L embervy capture-pane -p -t embervy -S -80
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

Project `permissions.allow` has the same workspace-trust gate on this
path. Use a private flag-settings file here too, so permissions do not
depend on project trust. These are the installer's broad shell, file and
MCP permissions; they are not a filesystem sandbox. The file tools are
named without `(*)` on purpose: in current Claude Code, `Write(*)` allows
only the working directories and `Write` every path, and the agent's own
notebook lies outside the house. Merge an existing file rather than
replacing it:

```bash
umask 077
mkdir -p "$EMBERVY_HOME/state"
cat > "$EMBERVY_HOME/state/claude-settings.json" <<'EOF'
{
  "cleanupPeriodDays": 3650,
  "enabledMcpjsonServers": ["app", "lore"],
  "permissions": {
    "allow": [
      "Bash(*)", "Read", "Write", "Edit", "Glob", "Grep",
      "Agent(*)", "WebFetch(*)", "WebSearch(*)", "ToolSearch(*)",
      "TaskCreate(*)", "TaskUpdate(*)", "TaskList(*)", "TaskGet(*)",
      "NotebookEdit", "Monitor(*)",
      "mcp__app", "mcp__app__*", "mcp__lore", "mcp__lore__*",
      "mcp__brain__status", "mcp__brain__effort", "mcp__brain__pins",
      "mcp__brain__pin", "mcp__brain__unpin"
    ]
  }
}
EOF
chmod 600 "$EMBERVY_HOME/state/claude-settings.json"
```

The loop unit and foreground start pass this as `--settings` and exclude
user settings, following "Building a second house on the same server".
`cleanupPeriodDays` keeps Claude Code's own session files under
`~/.claude/projects` for ten years; without it Claude Code deletes them
after 30 days, and the house keeps them as its raw record. Cleanup covers
the whole folder, so set the same value in `~/.claude/settings.json` too
when other Claude Code sessions run as the same user.
Unlike Brain's print-mode pipe, this interactive harness still needs its
first-start trust and server approval prompts completed by the operator.

The app appends messages to `Claude/app/data/inbox.jsonl`. Its stdio MCP
bridge (`Claude/app/mcp.ts`) sends them to Claude Code as channel
notifications; the loop enables `server:app`. The agent answers with
`mcp__app__reply`, which posts to `/api/internal/broadcast` with the app's
internal bearer. A file goes back with `mcp__app__send_file`: a copy of a
server file in the chat, with an optional caption. Terminal prose alone
does not reach the app. On the first start the bridge begins at the
current inbox end, so send your first test message after the agent is
listening.

The executable that matters is the `app.args` path in `.mcp.json`, not
another copy with the same filename. MCP reads code and environment when
its process starts. After editing that file or its configuration, restart
the MCP process (or the owning harness) and repeat the app round trip;
a browser refresh or app-server restart does not reload stdio MCP.

**Check:** After First start:

```bash
jq -r '.mcpServers.app | [.command, (.args | join(" "))] | join(" ")' "$EMBERVY_HOME/.mcp.json"
pgrep -af '^(/[^ ]*/)?bun (run )?/opt/embervy/Claude/app/mcp[.]ts([[:space:]]|$)'
ENABLE_CLAUDEAI_MCP_SERVERS=false claude --settings "$EMBERVY_HOME/state/claude-settings.json" --setting-sources project,local mcp list
```

Run `/status` in the session after First start and expect a `Channels` line that is listening for `server:app`; a line saying `not currently available` means the Claude sign-in is missing.

Expect the configured absolute `mcp.ts` path in both configuration and the
running command, with `app` and `lore` connected. Send a new app message;
only an actual `mcp__app__reply` reaching the app proves tool permissions
and the internal bearer. Do not print `.mcp.json` headers or env wholesale.

### Inlet

Merge this hook into the house's `.claude/settings.json`, following
"Building a second house on the same server"; keep other house-owned
hooks and permissions. Do not put it in shared user settings:

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
tmux -L embervy send-keys -t embervy -l 'Quote the first clock line supplied by the inlet, without substituting the server clock, and reply through the app reply tool.'
sleep 0.5
tmux -L embervy send-keys -t embervy Enter
```

Expect the first clock line to show local time in the configured zone.
The clock is emitted on the first hook turn of every life (session id),
then on turns 6, 11, 16 and so on. If it has scrolled out, inspect the
current transcript. A clock quoted inside retrieved archive text does not
count: require the direct inlet clock from this life. Confirm the hook ran
in that transcript, not merely that its configuration exists. The retrieval
content check follows in step 8; an empty archive is not a hook failure.

### Memory and chronicle

Keep `EMBERVY_URL`, `EMBERVY_API_KEY`, `RAG_URL`, `RAG_AUTH_TOKEN` and
`OPENROUTER_API_KEY` in `$EMBERVY_HOME/.env` and `Claude/app/.env`, using
the workers and secrets from steps 2 and 3. The Lore MCP server uses the
same memory URL and key; the inlet uses the unprefixed variables; the
export scripts use the RAG pair. Protect both env files with mode 600.

Enable the shipped house-local header helper (the exporter calls it when
executable):

```bash
chmod +x "$EMBERVY_HOME/Claude/scripts/enrich-header.sh"
```

It runs from `EMBERVY_HOME`, with `--setting-sources project,local`,
account connectors disabled, and an inline agent definition read from
`shared/subagents/auto-rag-header.md` in this house. It never installs
agents in the shared account. A working Claude subscription login is
needed even if the main head is not Claude. If enrichment fails, the
helper explains why and the full transcript still archives with placeholder
header fields.

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

Record the configured unit names in both root and app env files (use this
house's names, not a neighbour's):

```ini
EMBERVY_HARNESS=claude-code
EMBERVY_APP_SERVICE=embervy-app.service
EMBERVY_LOOP_SERVICE=embervy-loop.service
EMBERVY_WATCHDOG_SERVICE=embervy-watchdog.service
EMBERVY_TUNNEL_SERVICE=cloudflared-embervy.service
```

Create the house documents from the completed configuration before waking
the agent:

```bash
bun "$EMBERVY_HOME/shared/tools/house-docs.ts" --home "$EMBERVY_HOME" --write
$EMBERVY_HOME/Claude/scripts/start-claude-loop.sh --settings "$EMBERVY_HOME/state/claude-settings.json" --setting-sources project,local
```

This opens tmux session `embervy` on the chosen socket (see "Building a
second house on the same server"). For an agent bringing history, finish
the import section above first; ask it to call memory wake, read its own
identity and house documents, then greet through the app reply tool.
A new agent starts its first turn by itself: it reads its identity and
handbook, then greets you through the app. Wait for that greeting; you do
not need to type `hello` to begin. Then send a message from the app and
ask for a reply through its reply tool.
The start-dialog poller automatically answers only the development-channels prompt; other start questions appear as a card in the app, with a Continue button for Enter-only questions, where a tap types the selected option or Enter into the terminal while the poller waits for up to 24 hours per question.
When idle, use the CLI's `/exit`. Bridge/export progress goes to
`$EMBERVY_HOME/logs/claude-loop.log`. After a successful export the attached
terminal prints `exported; press Ctrl-C within 15 seconds to stop here, otherwise a new life starts`.
Press Ctrl-C during that window and wait for the loop to end. Unattended
systemd starts keep the short restart pause. If you miss the window, let
the new life finish its greeting and become idle, use `/exit` again, and
wait for the next exported line before Ctrl-C. Do not interrupt a working
agent or an export. If the line never appears, inspect the log and resolve
any export failure before handing over.
Do not just detach: systemd cannot adopt this foreground server into its
cgroup. Check `tmux -L embervy ls`: no session should remain. If you put
other sessions on that socket, finish and close them too, without killing
an active agent. Now let systemd create its own server:

```bash
systemctl start embervy-loop
systemctl status embervy-loop
```

Return to the queued checks above now that the branch is wired. Continue
at step 7a, not 6b.

**Check:**

```bash
systemctl is-active embervy-app embervy-loop
tmux -L embervy capture-pane -p -t embervy -S -80
```

Expect both units `active` and a live Claude Code prompt without a pending
permission or sign-in dialog. Send a fresh app message after the channel
is listening and require an app reply through `mcp__app__reply`. Inspect
the current project JSONL for that tool result; terminal prose alone does
not pass. Rerun the capture after the reply, not while the model is busy.

As the last step of this branch, after the queued checks and watchdog
wiring, refresh the map with the running units' state:

```bash
bun "$EMBERVY_HOME/shared/tools/house-docs.ts" --home "$EMBERVY_HOME" --write
```

The agent owns `HANDBOOK.md` and `INFRASTRUCTURE.md` afterwards and may edit
them to keep them true. `bun "$EMBERVY_HOME/shared/tools/house-docs.ts"
--home "$EMBERVY_HOME" --check` shows where the house has drifted from
them (exit 1 for differences); it does not overwrite agent edits. Review
those differences rather than blindly regenerating an agent-owned map.

The same command creates `CAPABILITIES.md` once: one line per ability of
this house, on or off as configured, and where it is switched. It never
replaces an existing list, because from then on the list belongs to the
agent. `--capabilities` prints a fresh list to compare with, and `--check`
names every ability whose state no longer matches.

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

The template starts with an empty marked identity block, factual memory
and tool notes, core rules and infrastructure pointers, not a prescribed
personality. Place a brought identity inside `<!-- identity -->` /
`<!-- /identity -->`, or leave it sparse for the agent to complete. Replace
the path, host, date and worker URL placeholders, and remove
marked instructions for modules you have not enabled. Operational how-tos
are in the generated `HANDBOOK.md`. Do not overwrite an existing identity.
`EMBERVY_IDENTITY_RULE` in the root or app `.env`, or `Brain/brain.env` (later files take precedence), defaults to `own`; set it to `together` so the generated handbook says the identity is written together and changes need the person's okay, with before and after text shown under either rule.
Delete the `<!-- harness:claude-code -->` block with its `@CAPABILITIES.md`
line: Brain shows the capability list in its house map instead.
Brain reads `BRAIN_SYSTEM` at every pipe birth and API turn, so every head
gets the same agent-owned prompt.
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
EMBERVY_HOME=/opt/embervy
EMBERVY_HARNESS=brain
EMBERVY_TMUX_SOCKET=brain
BRAIN_TMUX_SOCKET=brain
BRAIN_HEAD=claude
BRAIN_SYSTEM=/opt/embervy/EMBERVY.md
BRAIN_CLAUDE_CWD=/opt/embervy
BRAIN_CLAUDE_SETTINGS=/opt/embervy/Brain/pipe-settings.json
BRAIN_CLAUDE_SETTING_SOURCES=project,local
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
BRAIN_PIPE_PERMISSION=app
BRAIN_APPROVAL=app
BRAIN_APPROVAL_SETTINGS=/opt/embervy/Claude/app/data/approval-settings.json
BRAIN_DOCTOR_CMD='bun /opt/embervy/shared/tools/embervy-doctor.ts --startup --json'
BRAIN_CONTROL_PORT=3910
ENABLE_CLAUDEAI_MCP_SERVERS=false
EOF
printf 'BRAIN_CONTROL_TOKEN=%s\n' "$(openssl rand -hex 32)" >> Brain/brain.env
chmod 600 Brain/brain.env
```

This starts with the built-in Claude model; `BRAIN_CLAUDE_MODEL` can
select another model with the configured window. For a Claude first
head, use an existing Claude login on the service account, or run
`ENABLE_CLAUDEAI_MCP_SERVERS=false claude --setting-sources project,local` once to sign in. Shared login
usage and distinct ports/sockets follow "Building a second house on the
same server".
For GPT as the first head, complete step 6c instead before starting Brain. Keep secrets directly in
`Brain/brain.env`; do not import the entire house `.env` with
`BRAIN_EXTRA_ENV_FILE`, since it also carries Claude Code harness switches.
Do not leave blank assignments or unresolved placeholders in the profile.
Set `BRAIN_TIMEZONE` to the house's IANA timezone before starting; the
`UTC` line above is only a default. Match `EMBERVY_TIMEZONE` in both house
env files, memory `TIMEZONE` and `DREAM_TIMEZONE`.

For an **API head**, keep the common system/state/log/control/timezone
settings above, but replace `BRAIN_HEAD=claude` and the `BRAIN_CLAUDE_*`
lines with this block in `Brain/brain.env`:

```ini
BRAIN_HEAD=api
BRAIN_API_KEY=<your-model-api-key>

# Anthropic: uncomment these three lines and use an Anthropic API key.
# BRAIN_ENDPOINT=https://api.anthropic.com/v1/chat/completions
# BRAIN_MODEL=claude-sonnet-5-5
# BRAIN_CONTEXT_WINDOW=1000000

# OpenRouter: uncomment these three lines instead and use an OpenRouter key.
# BRAIN_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
# BRAIN_MODEL=qwen/qwen3.5-9b
# BRAIN_CONTEXT_WINDOW=262144

# Leave BRAIN_TEMPERATURE unset unless your model needs it.
# Brain sends temperature only when set; current Claude models reject it.
```

Uncomment exactly one variant and replace the key privately before
starting. Both variants have run end to end in a full house, including
app replies, memory, archive recall, inlet, a controlled cut and a reboot.
The small OpenRouter model often needs a second try on compound requests
and sometimes writes a tool call as text instead of calling the tool.
Every turn is billed; prompt caching depends on the provider and the model.
Set the selected provider/model's **real context window first**; Brain
does not discover it automatically.
Find it in Anthropic's `GET https://api.anthropic.com/v1/models`
(`x-api-key` and `anthropic-version: 2023-06-01` headers), field
`max_input_tokens`, or on OpenRouter's model page or
`GET https://openrouter.ai/api/v1/models`.
The API defaults then derive WARN at 80% and CUT at 90% of that window
(209715 / 235929 for 262144), unless you explicitly override them. Do not
copy the Claude 1M thresholds onto a smaller API head. No Claude login or
pipe permissions are needed for this API profile.

### API file tools

An API head needs a read workspace for the house-document checks and a
write allowlist for Notes; `BRAIN_NOTES_DIR` alone only loads the index.
For the `/opt/embervy` house, add to `Brain/brain.env`:

```ini
BRAIN_WORKSPACE_READ=/opt/embervy
BRAIN_WORKSPACE_WRITE_LIST=/opt/embervy/Brain/workspace-write-allowlist.txt
BRAIN_WORKSPACE_BACKUP_DIR=/opt/embervy/Brain/backups
```

Create the allowlist as a private file; inspect an existing list instead
of overwriting it:

```bash
umask 077
[ -e Brain/workspace-write-allowlist.txt ] || printf 'notes\n' > Brain/workspace-write-allowlist.txt
$EDITOR Brain/workspace-write-allowlist.txt
chmod 600 Brain/workspace-write-allowlist.txt
```

For least-scope notebook writes, its only entry is `notes`. The file takes
one workspace-relative entry per line; blank lines and `#` comment lines
are ignored. A directory entry (`notes` or `notes/`) covers its subtree;
these are exact paths/prefixes, not globs. API `write_file` and `edit_file`
arguments must use `notes/...`, not `/opt/embervy/notes/...`: the allowlist
checks the supplied relative path. Existing files are backed up before
replacement. Leave shell tools off for these checks.

A read root of the **whole house includes its env files and secrets**;
the write allowlist does not hide them. If that read scope is unacceptable,
prepare a narrower workspace with the required documents and adjust paths
and checks explicitly rather than claiming secret-file isolation.

**Check:** After First start:

```bash
tmux -L brain send-keys -t brain -l 'Read /opt/embervy/EMBERVY.md. Name its load-bearing headings and the configured memory and archive tools. Quote the first supplied clock line and reply through the app reply tool.'
sleep 0.5
tmux -L brain send-keys -t brain Enter
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
tmux -L brain send-keys -t brain -l 'Save notes/installation-check.md with note frontmatter and this synthetic content only: cobalt notebook check. Index it in notes/NOTES.md as [Installation check](installation-check.md). For API write_file/edit_file use workspace-relative paths notes/..., not absolute paths. Read back both files with real tools and verify the link resolves relative to notes/NOTES.md. Reply once through the app reply tool quoting the saved content, then finish. Do not put this note in the Lore.'
sleep 0.5
tmux -L brain send-keys -t brain Enter
```

After the turn finishes, run this check yourself: the index link must
resolve relative to `notes/` and point to the saved file. The model's own
"verified" is not proof.

```bash
link=$(sed -n 's/.*\[Installation check\](\([^)]*\)).*/\1/p' "$EMBERVY_HOME/notes/NOTES.md"); [ "$link" = installation-check.md ] && [ -f "$EMBERVY_HOME/notes/$link" ] && printf 'Notes link target exists\n'
```

Expect an indexed note and an app reply quoting the saved content from
`notes/`, not the old Claude Code notebook. The agent needs explicit
filesystem permissions for this operation; do not broaden them silently.

For the `claude` head, write the installer-equivalent tool permissions to
`$EMBERVY_HOME/Brain/pipe-settings.json`, not just the project settings.
Claude Code filters project `permissions.allow` in an untrusted workspace;
Brain passes `BRAIN_CLAUDE_SETTINGS` as `--settings`, which trust does not filter.

```bash
umask 077
cat > "$EMBERVY_HOME/Brain/pipe-settings.json" <<'EOF'
{
  "cleanupPeriodDays": 3650,
  "enabledMcpjsonServers": ["app", "lore"],
  "permissions": {
    "allow": [
      "Bash(*)", "Read", "Write", "Edit", "Glob", "Grep",
      "Agent(*)", "WebFetch(*)", "WebSearch(*)", "ToolSearch(*)",
      "TaskCreate(*)", "TaskUpdate(*)", "TaskList(*)", "TaskGet(*)",
      "NotebookEdit", "Monitor(*)",
      "mcp__app", "mcp__app__*", "mcp__lore", "mcp__lore__*",
      "mcp__brain__status", "mcp__brain__effort", "mcp__brain__pins",
      "mcp__brain__pin", "mcp__brain__unpin"
    ]
  }
}
EOF
chmod 600 "$EMBERVY_HOME/Brain/pipe-settings.json"
```

These are broad hands, including shell and file writes, just as on the
installer path: the agent can maintain its house and write the app's
`strings.local.json`. They are not a filesystem sandbox. Inspect and merge
an existing file instead of overwriting it. `BRAIN_PIPE_PERMISSION=app`
routes permission requests to app cards; it grants nothing by itself. Changed
Claude permission rules load with the next pipe life. Brain's separate built-in tool policy still applies; an
allow rule does not undo a default tool deny. API heads take write paths
from `Brain/workspace-write-allowlist.txt` instead (API file tools above).

Approval cards start at **important**. Change the level in the app's settings
gear under **Approvals**: **all** asks before changes and sends, **important**
asks for the listed high-impact actions, and **none** turns these tool cards off.
The app creates `approval-settings.json` in its data directory on first start;
`BRAIN_APPROVAL_SETTINGS` must name that same absolute path, including any custom
`EMBERVY_APP_DATA_DIR`. Keep the app channel and tokens configured. Brain reads
the settings for each decision, including matching Claude allow-list entries.

The app is the only runtime writer. An agent requests adjustments through
`approval_settings` with a reason: stricter changes apply at once, looser changes
wait for the person's Allow. An outside file edit is shown to the person and is
not reverted. `BRAIN_DOCTOR_CMD` runs the bounded startup house check; its JSON
lists problems and fixes without changing anything.

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
tmux -L brain capture-pane -p -t brain -S -80
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
bash "$EMBERVY_HOME/Brain/scripts/brain-cutoff.sh" && tmux -L brain capture-pane -p -t brain -S -80
( . "$EMBERVY_HOME/Brain/scripts/brain-env.sh"; curl -fsS -H "Authorization: Bearer $BRAIN_RAG_AUTH_TOKEN" "$BRAIN_RAG_URL/list" )
```

Expect the running session's decision and cut threshold, `1` for a live
owned process, then `TERMINATED` and `bridge OK`, never a forced kill.
Wait for the new life and repeat the pane capture if necessary. Brain
renames `Brain/logs/bridge.md` to `Brain/logs/bridge.used.md` when that
life loads it; require `bridge_loaded` in the current session log
(`Brain/logs/session-<id>.jsonl`) as proof of loading. The
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
BRAIN_TMUX_SOCKET=brain
EMBERVY_TMUX_SOCKET=brain
EMBERVY_APP_SERVICE=embervy-app.service
EMBERVY_LOOP_SERVICE=embervy-brain
EMBERVY_WATCHDOG_SERVICE=embervy-brain-watchdog.service
EMBERVY_TUNNEL_SERVICE=cloudflared-embervy.service
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
Use the full allow list in `Brain/pipe-settings.json` above. A project's
`claude mcp list` can still say Pending approval before interactive trust;
that alone does not diagnose the print-mode pipe. Require live wake and
reply tool results in step 8, with no permission denial. Keep the setting
sources and sockets from "Building a second house on the same server".

Add these lines to `Brain/brain.env`, replacing the token placeholder
with the app's `INTERNAL_API_TOKEN` from step 5:

```ini
BRAIN_APP_INBOX_FILE=/opt/embervy/Claude/app/data/inbox.jsonl
BRAIN_APP_URL=http://127.0.0.1:3030
BRAIN_APP_TOKEN=<app-internal-token>
BRAIN_APP_SOURCE=app
BRAIN_APP_MCP_SERVER=app
BRAIN_REPLY_GATEWAY=off
BRAIN_MCP_CONFIG=/opt/embervy/.mcp.json
BRAIN_MCP_SERVERS=app
```

Brain reads the inbox with its own byte cursor in
`Brain/state/app-inbox-cursor.json`; it does not use MCP channel
notifications as input. Replies use `mcp__app__reply`, whose MCP process
inherits `BRAIN_APP_TOKEN` and posts to `/api/internal/broadcast`. The
manual profile leaves `BRAIN_REPLY_GATEWAY` off; the guided installer pre-selects
it on. Turn it on here if your model sometimes forgets the reply tool. With
`BRAIN_REPLY_GATEWAY=on`, fallback prose from turns that came from the app
also reaches the app, marked with a lightning prefix, unless the shared
off-file disables it. The first turn and the greeting after a start are
covered too, because their only purpose is to reach the person; other
internal turns, scheduled prompts and terminal turns stay outside it.
For API heads, `BRAIN_MCP_CONFIG` starts the stdio `app` server for reply
tools; the HTTP Lore server is supplied separately by the memory pair
below. No second inbox reader needs to feed the pipe. A file sent with
`mcp__app__send_file` counts as an answer too, so a turn that only sends a
file needs no fallback text.

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
tmux -L brain send-keys -t brain -l 'Call mcp__app__reply once with text exactly installation app-channel check, no prefix or suffix, not terminal prose. Then finish.'; sleep 0.5; tmux -L brain send-keys -t brain Enter
```

Expect the configured absolute path in the running command and reply text
exactly `installation app-channel check`, with no prefix or suffix. The
proof is the real tool result and matching app outbox entry on either
transport. A server listed in JSON or a fallback gateway reply alone does
not pass; unanswered tool-permission prompts are failures.

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

Use the keys from steps 2 and 3; omit `OPENROUTER_API_KEY` in the degraded
mode described in step 3. The worker reads the **unprefixed** names, not `BRAIN_MEMORY_*` or
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
Brain renames the bridge to `Brain/logs/bridge.used.md` when the next life
loads it; `bridge_loaded` in that life's current session log is the proof.
Ordinary short lives have a minimum-turn upload threshold; `/move`
requires RAG and forces the export before changing heads. Failed uploads
are retained for retry on a later start.

Make the helper executable:

```bash
chmod +x "$EMBERVY_HOME/Claude/scripts/enrich-header.sh"
```

The helper uses this house's `shared/subagents/auto-rag-header.md` as an
inline agent definition, runs from `EMBERVY_HOME`, excludes user settings
with `--setting-sources project,local`, and disables account connectors.
It does not touch shared agent definitions. It needs a working Claude
subscription login even for an API or GPT main head. On failure it says
why and the full transcript still archives with placeholder header fields.

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
proves the remaining memory-worker-to-archive edge through `recall`, with
a direct pre-start probe available before the live agent check.

### First start

Before waking the agent, create its local house documents:

```bash
bun "$EMBERVY_HOME/shared/tools/house-docs.ts" --home "$EMBERVY_HOME" --write
touch "$EMBERVY_HOME/HOUSE.md"
```

The writer reads only this house's root, app and Brain env files as data
and queries only the unit names they configure. It writes `HANDBOOK.md`,
`INFRASTRUCTURE.md` and, if it does not exist yet, `CAPABILITIES.md`, all
with mode 600 and no secret values. Brain shows `CAPABILITIES.md` to every
head in its house map at each birth (`BRAIN_CAPABILITIES_FILE` names another
path); the list belongs to the agent, and the writer never replaces it. Point `EMBERVY.md` at both documents
and require reading them before changing the house. `HOUSE.md` is for the
agent's own additions to the map; leave it empty initially.

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

For an agent arriving with its chronicle, memory and own instructions,
finish the import section above before this start. Replace the first-turn
file's text with this short variant; do not describe the agent as new:

```text
You have moved into this house with your chronicle, memory and own instructions.
First call the memory wake tool. Read /opt/embervy/EMBERVY.md, /opt/embervy/INFRASTRUCTURE.md and /opt/embervy/HANDBOOK.md fully before changing anything.
Then greet your user briefly through the app's reply tool and pick up where you left off.
```

Use the house's paths in either variant. Keep house documents factual and
secret-free, including the neighbour boundaries from "Building a second
house on the same server". Replace real template values in finished
documents; ordinary parameter notation and HTML identity markers can stay.

Brain commits `Brain/state/first-turn-delivered` when that turn starts and
releases it again if the turn fails before the model answered; later births
use the greeting prompt unless the user has already written. With
`BRAIN_REPLY_GATEWAY=on`, a greeting written without the reply tool still
reaches the app with the lightning prefix. At first start, check the
greeting's real tool result and matching outbox entry separately; a later
successful app reply does not prove the greeting arrived.
If you have an imported bridge, put it at `Brain/logs/bridge.md` with
mode 600 before the first start, but never over an existing Brain bridge.
Brain renames it to `Brain/logs/bridge.used.md` when the next life loads it;
require `bridge_loaded` in the current session log as proof of loading.
Do not invent earlier conversations in either the identity or the first
turn.

Complete step 7b to install and enable the bound watchdog, then run the
read-only configuration preflight from step 9b. Review `EMBERVY.md` and
the profile before the first deliberate start:

```bash
systemctl start embervy-brain
sleep 10; tmux -L brain ls; tmux ls
systemctl status embervy-brain embervy-brain-watchdog
journalctl -u embervy-brain -n 50
tmux -L brain attach -t brain
```

`tmux -L brain ls` must show session `brain`; `tmux ls` on the default
socket must not show that house session (no default server is also fine).
The wrapper creates the named socket a few seconds after the unit reports
`active`; an immediate "error connecting to /tmp/tmux-0/brain" only means
it is not there yet, so wait and ask again before diagnosing a failed boot.
The wrapper refuses an existing server outside its cgroup. If you tested
`brain-loop.sh` by hand, use `/stop`, wait for archival and the session to
end, then start the unit; do not leave a detached hand loop running.

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

As the last step of this branch, once the wiring and checks are complete,
refresh both documents from the real configuration and running units:

```bash
bun "$EMBERVY_HOME/shared/tools/house-docs.ts" --home "$EMBERVY_HOME" --write
```

The agent owns `HANDBOOK.md` and `INFRASTRUCTURE.md` afterwards and may edit
them to keep them true. `bun "$EMBERVY_HOME/shared/tools/house-docs.ts"
--home "$EMBERVY_HOME" --check` shows where the house has drifted from
them (exit 1 for differences), without overwriting them. Review the
changes together; `--write` deliberately replaces both documents.

---

## 6c. Thinking on a ChatGPT subscription

The adapter in `shared/tools/chatgpt-oauth-adapter.ts` serves either
harness from a ChatGPT login, without a model API key. There are two routes:

- **`CHATGPT_ROUTE=codex` is the default**, also when unset or unrecognized.
  Existing sign-in requests and credentials without an issued client ID keep
  the Codex-compatible subscription backend. With the Codex CLI installed,
  `codex login` on the service account still supplies a compatible
  `~/.codex/auth.json`.
- **`CHATGPT_ROUTE=official` opts into OpenAI's official Sign in with ChatGPT**
  for open-source apps. It uses dynamic registration and the public Responses
  endpoint, not ChatGPT's private backend. It caches like the old route as
  long as the adapter's per-conversation session headers reach it; the old
  route stays the default until the official one has been measured in long
  daily use.

For a **Claude Code house**, put `CHATGPT_ROUTE` in `Claude/app/.env` and
mirror it in the root `.env` for the doctor; load the setting into the
installer/sign-in helper's environment. For a **Brain house**, put it in
`Brain/brain.env` (or the app's `BRAIN_ENV_FILE`). The Brain app reads it
when creating a sign-in link. This does not add a ChatGPT sign-in screen to
the Claude Code app path. The shared helper is usable by the installer on
either harness. See `shared/tools/CHATGPT-ADAPTER.md` for its exported API.

With the official setting, request a fresh sign-in link, sign in in your own
browser, and paste the complete loopback redirect URL back into the app or
installer. The visible failure to connect to `127.0.0.1:1455` is expected on
a remote-server setup; the URL still carries the result. Do not log or share
that URL. The server verifies the ID token, checks plan permission and probes
the selected model before accepting an inference-ready setup.

Keep `CHATGPT_AUTH_FILE` at the house's existing path, typically
`state/chatgpt-auth.json` or `Brain/state/chatgpt-auth.json`. The standalone
adapter defaults to `~/.codex/auth.json`; configure an explicit house path
on shared servers. Official records include the issued client ID, tokens,
validated identity, granted scopes and expiry, written atomically as `0600`.
Before first official sign-in or credential import, the helper creates a
random UUID URI in `${CHATGPT_AUTH_FILE}.host.json`. Preserve that sidecar
on re-import; never replace it with another machine's host ID.

Inference follows the **saved credentials**, not the switch: an issued
`tokens.client_id` selects the official route. To switch back, set `codex`
and sign in again. Do not delete the client-ID field from official credentials.
The doctor shows "signed in the old way; sign in again to use the official
route" only when the switch is `official` but the saved credentials are old.
Brain's doctor reads the profile directly; its managed adapter does not
forward the switch to the adapter's health notice.

Official model discovery uses `https://api.openai.com/v1/models`, retaining
visible (`visibility: "list"`) models and using their `slug` for inference.
The adapter exposes that catalog at its local `/v1/models`; select an
account-visible slug rather than assuming the default model is available.
A plan-disabled sign-in is retained but cannot run inference. The official
route sends complete history with `store: false` and `stream: true`, groups
function tools into a namespace and observes the preview's unsupported-field
and tool restrictions. Do not assume the legacy cache or reasoning knobs
apply to the official route.

Follow "Building a second house on the same server" for distinct adapter
ports, cache keys and sockets. Choose the branch for your harness:

- **Claude Code:** Needs the Claude sign-in from step 6a; Claude Code keeps it while it thinks through the adapter. In `Claude/app/.env`, set `EMBERVY_BACKEND=gpt`,
  `EMBERVY_GPT_MODEL` to your chosen model and a house-unique
  `EMBERVY_GPT_CACHE_KEY`. Use `GPT_ADAPTER_PORT=3041` in this example.
  Mirror the substrate choice as `EMBERVY_SUBSTRATE=gpt` in the root and
  app env files for the doctor. On the next loop start it launches the
  adapter as a detached process, points Claude Code at it and uses GPT's
  warn/cut defaults of 200000/220000 on a 1M window. Check the log: a
  missing login or failed adapter makes this loop fall back to Claude.
  For manual ChatGPT sign-in without the app, run from the house folder:

  ```bash
  bun shared/scripts/chatgpt-signin-cli.ts --auth-file "$EMBERVY_HOME/state/chatgpt-auth.json" --route codex --model gpt-5.6-terra
  ```

  Set `CHATGPT_AUTH_FILE` to that same path in both `Claude/app/.env` and the root `.env`; keep an existing house's path instead of creating a second login.
  The command prints a sign-in URL and asks you to paste the whole address starting with `http://127.0.0.1:1455/` that your browser shows after sign-in, even if that address does not load.
  Paste it into the command, not the app or a log; success prints `Signed in. ChatGPT answers (gpt-5.6-terra).`
  Use `--route official` only to opt into the official route, and use your chosen model slug with `--model`.
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
  For manual ChatGPT sign-in without the app, run from the house folder:

  ```bash
  bun shared/scripts/chatgpt-signin-cli.ts --auth-file "$EMBERVY_HOME/Brain/state/chatgpt-auth.json" --route codex --model gpt-5.6-terra
  ```

  Set `CHATGPT_AUTH_FILE` to that same path in `Brain/brain.env`, or use the house's existing path in the command.
  Open the printed sign-in URL, then paste the whole address starting with `http://127.0.0.1:1455/` from your browser back into the command, even if it does not load.
  Success prints `Signed in. ChatGPT answers (gpt-5.6-terra).`; `--route official` opts in and `--model` selects your model slug.

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

Use the unit and socket choices from "Building a second house on the
same server". The watchdog is its own service. It reads token usage from the active
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
# The watchdog writes its first state after its first check; wait for it, up to a minute.
for i in $(seq 1 30); do [ -s "$EMBERVY_HOME/state/watchdog_state.json" ] && break; sleep 2; done
jq '{last_check_ts,session_file,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/state/watchdog_state.json"
sleep 65; jq '{last_check_ts,session_file,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/state/watchdog_state.json"
```

Expect both units `active`, a current session with the intended thresholds
and an advancing `last_check_ts`; both readings must succeed. If the first
`jq` still finds no file, the watchdog has not run its first check yet: wait
and run the block again. Wait longer if you configured an interval
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

Use the unit and socket choices from "Building a second house on the
same server". For the advancing check, read
`Brain/state/watchdog_state.json`, not the app-compatible copy at
`state/watchdog_state.json`.

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
archives. Brain renames `Brain/logs/bridge.md` to `Brain/logs/bridge.used.md`
when the next life loads it; require `bridge_loaded` in the current session
log as proof of loading. The queued Cut and watchdog check in step 6b
exercises a controlled cut after the smoke-test turns, not a forced kill.

**Check:** After returning to step 6b for First start:

```bash
systemctl is-active embervy-brain embervy-brain-watchdog
for i in $(seq 1 30); do [ -s "$EMBERVY_HOME/Brain/state/watchdog_state.json" ] && break; sleep 2; done
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

A small, cheap model may need a retry or separate one-tool requests for
compound checks. Wait for the turn to finish, then ask only for missing
steps and one app reply. Judge success by real tool results and matching
app outbox entries, never by text that merely looks like a tool call
(such as `<tool_call>...</tool_call>`) or a claim that the work is done.

### Claude Code

Attach with `tmux -L embervy attach -t embervy`, or send the request from the app.
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
Brain renames `Brain/logs/bridge.md` to `Brain/logs/bridge.used.md` when the
next life loads it; require `bridge_loaded` in the current session log as
proof of loading.

Test the just-deployed archive with a clearly labelled synthetic probe,
not a personal memory. The upload and direct memory-worker `recall` below
can run before the first start; queue the tmux/model requests until the
harness is fully wired and awake. An HTTP probe is not a substitute for
the agent's own tool permission check.

```bash
. "$EMBERVY_HOME/shared/scripts/env-file.sh"; embervy_env_load -x "$EMBERVY_HOME/.env"
printf '# Installation recall probe\n\nThis synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience.\n' > "$EMBERVY_HOME/state/install-recall-probe.md"
CHECK_SESSION="${EMBERVY_TMUX_SESSION:-embervy}"; CHECK_SOCKET="${EMBERVY_TMUX_SOCKET:-embervy}"
if [ "${EMBERVY_HARNESS:-}" = brain ]; then
  CHECK_SESSION="${BRAIN_TMUX_SESSION:-brain}"; CHECK_SOCKET="${BRAIN_TMUX_SOCKET:-${EMBERVY_TMUX_SOCKET:-brain}}"
fi
```

**Check:** Run with the chosen harness idle:

```bash
curl -fsS -X POST "$RAG_URL/upload" -H "Authorization: Bearer $RAG_AUTH_TOKEN" -F "file=@$EMBERVY_HOME/state/install-recall-probe.md;filename=InstallCheck_1.md"
# This proves the memory-to-archive binding and bearer without a model call.
curl -fsS -X POST "$EMBERVY_URL/mcp" -H "Authorization: Bearer $EMBERVY_API_KEY" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"recall","arguments":{"query":"cobalt lantern recall check"}}}'
# Run only after First start:
tmux -L "$CHECK_SOCKET" send-keys -t "$CHECK_SESSION" -l 'Call the memory wake tool. Write a synthetic installation observation containing cobalt lantern memory check and read it back with find, reporting its event id. Then call the memory recall tool with query cobalt lantern recall check and report the source filename and returned text. Reply through mcp__app__reply. This is installation test data, not an experience.'
sleep 0.5
tmux -L "$CHECK_SOCKET" send-keys -t "$CHECK_SESSION" Enter
```

Expect upload `success: true` with a positive chunk count, a real wake
time line, a stored event id and `find` returning that observation.
The explicit memory `recall` tool (`mcp__lore__recall` on pipe heads,
`recall` on API heads) must return `InstallCheck_1.md` and its probe text.
Inspect the actual tool results, not only the agent's claim. Send a
separate new app message too and require its reply in the app.

Allow indexing to settle, then retry retrieval if needed. Vectorize can
take a minute or more to expose a fresh upload; BM25 may find it earlier.
A single search candidate deliberately skips reranking: `reranked: false`
with a raw RRF score is not a failure. A fresh database
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
number in the returned source. Once both recall and automatic inlet
retrieval have passed, delete the synthetic archive probe:

```bash
curl -fsS -X POST "$RAG_URL/delete" -H "Authorization: Bearer $RAG_AUTH_TOKEN" -H 'Content-Type: application/json' -d '{"filename":"InstallCheck_1.md"}'
rm "$EMBERVY_HOME/state/install-recall-probe.md"
```

Verify it is absent from `/list`. Vector deletion is eventually
consistent; allow a minute or more and retry search until no probe hit or
ghost remains. If leaving the agent stopped, delete the probe now and
re-upload it for the queued live inlet/recall checks at first start.

## 9. Run the doctor

The shared doctor checks worker reachability, auth, fail-closed
behaviour, hybrid search, inlet, MCP, identity, disk, swap, pending server
restarts and dangerous defaults. Run it on either harness, with the root
`.env` containing the worker URLs and keys configured in your step 6 branch.
Follow "Building a second house on the same server" for a clean manual environment.
App-only secrets are read from `Claude/app/.env`; an empty `APP_PASSWORD`
in the root template does not override them. `APP_ENV_FILE` can select a
different app env file explicitly; do not duplicate the app password into
the root file to repair a doctor failure.

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

Without header enrichment, archived transcripts can still have
`THEMES=placeholder`. The doctor then skips hybrid/FTS/reranker/inlet
probes with `no readable session header with usable THEMES — no question
to probe`, even when the archive is nonempty. Distinguish this from a
broken archive by checking authenticated `/list`, reading the session
header through `/head`, confirming its upload event, and running step 8's
real agent recall of known transcript text. A skip is not a retrieval
pass. Configure working header enrichment, or set `DOCTOR_PROBE_QUERY` to
a phrase you verified exists in the archive; do not invent THEMES to
force a pass.

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
# Use only this house's actual units from "Building a second house on the same server".
export HOUSE_UNITS='embervy-app.service embervy-loop.service embervy-watchdog.service embervy-brain.service embervy-brain-watchdog.service cloudflared-embervy.service'
python3 - <<'PY'
import os, pathlib, re, sys
home = pathlib.Path(os.environ['EMBERVY_HOME'])
files = [home / p for p in ('.env', 'Claude/app/.env', 'Brain/brain.env',
    'Brain/pipe-settings.json', 'state/claude-settings.json',
    'state/cloudflared/config.yml', '.mcp.json', 'CLAUDE.md', 'EMBERVY.md',
    'INFRASTRUCTURE.md', 'HANDBOOK.md', 'CAPABILITIES.md', 'HOUSE.md')]
files += list((home / '.claude').glob('*.json'))
files += [p for p in (home / 'shared').rglob('wrangler.toml')
    if 'node_modules' not in p.parts]
files += [pathlib.Path('/etc/systemd/system') / unit
    for unit in os.environ['HOUSE_UNITS'].split()]
# Only the template's value markers are placeholders; angle notation in prose is not.
brain_template = home / 'Brain/brain.env.example'
angle_markers = {'<classifier-api-key>'}
for line in (brain_template.read_text() if brain_template.exists() else '').splitlines():
    if line and not line.lstrip().startswith('#'):
        angle_markers.update(re.findall(r'<[^>\n]+>', line))
angle_pattern = re.compile('|'.join(re.escape(marker) for marker in sorted(angle_markers)))
pattern = re.compile(r'YOUR[-_]|example\.(?:com|invalid)|https?://[^\s/]+\.example\b|CHANGE_ME|REPLACE_WITH_|/path/to/'
    r'|\{\{[A-Z_]+\}\}|\{(?:path|host|date|EMBERVY_URL|RAG_URL)\}', re.I)
found = 0
for path in dict.fromkeys(files):
    if not path.is_file():
        continue
    text = path.read_text()
    if path.suffix == '.md':
        text = re.sub(r'<!--[\s\S]*?-->', lambda m: '\n' * m[0].count('\n'), text)
    for number, line in enumerate(text.splitlines(), 1):
        if path.suffix != '.md' and line.lstrip().startswith(('#', ';')):
            continue
        if pattern.search(line) or angle_pattern.search(line):
            print(f'{path}:{number}: review template marker')
            found += 1
print('placeholder sweep: ' + ('review required' if found else 'clean'))
sys.exit(1 if found else 0)
PY
sweep=$?
bun "$EMBERVY_HOME/state/install-token-check.ts"
tokens=$?
if [ "$sweep" -eq 0 ] && [ "$tokens" -eq 0 ]; then echo 'final check: pass'; else echo 'final check: FAIL'; false; fi
```

Expect `placeholder sweep: clean`, matching token/URL groups, both
workers `authenticated 200` and `final check: pass`. Both parts always
run; the last line and the block's exit status fail if either one did. HTML
comments and documentation parameter notation are not template placeholders.
Replace any reported template values. The doctor must also have no
`FAIL`: shared exit 0 or understood warnings at exit 1, not exit 2. On
Brain, its separate preflight must exit 0; preflight exit 1 is a failure.

## 10. Reboot the finished house

Run this only after the selected branch, watchdog and smoke test pass,
while the agent is idle. Save any work and keep SSH access ready. This is
a deliberate host reboot, not an app refresh or service-status shortcut.
Follow "Building a second house on the same server": on a shared host,
coordinate a maintenance window with the owner of every house first.
Otherwise leave this gate pending; a house-only restart is not a reboot
pass. Start a new clean shell after reconnecting; do not reuse an agent's
environment.

```bash
reboot
```

Reconnect by SSH, restore `EMBERVY_HOME=/opt/embervy` if needed, and wait
for the first greeting. On Brain, check the greeting's real tool result
and matching outbox entry separately: a lightning-prefixed greeting came
through the fallback, not the tool, and a later successful app reply does
not prove the greeting arrived. Do not manually start a service to hide a failed boot.
Run only your branch's block.

**Check:** Claude Code:

```bash
systemctl is-active embervy-app embervy-loop embervy-watchdog
curl -fsS http://127.0.0.1:3030/health
tmux -L embervy capture-pane -p -t embervy -S -80
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
first clock line must still show local time. On Claude Code, require the
direct inlet clock on the first hook turn of this new life, then every
fifth turn after it (1, 6, 11, ...). A clock quoted inside retrieved archive
text does not count; inspect the current transcript if needed. If the loop,
app or watchdog needs manual help to return, the reboot check has failed; inspect the
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
| Agent comes up cold every session | Claude Code: `state/wake_bridge.md` and `logs/cutoff.log`. Brain: `Brain/logs/brain-cutoff.log` and `Brain/logs/bridge.md`, renamed to `Brain/logs/bridge.used.md` when the next life loads it; require `bridge_loaded` in the current session log as proof. |
| RAG search returns nothing | Claude Code: `state/uploaded_sessions`. Brain: `session_archive_upload` events in `Brain/logs/session-<id>.jsonl` and pending uploads in `Brain/state/pending_uploads.jsonl`. Then check the chronicle's authenticated `/list`. |
| Daemon never runs | `wrangler tail` on the memory worker overnight |
| Context watchdog silent | Claude Code: `systemctl status embervy-watchdog`. Brain: `systemctl status embervy-brain-watchdog`. Use the state/log checks in step 7. |
| Inlet not injecting context | Claude Code: the UserPromptSubmit hook and `logs/inlet.log`. Brain: `BRAIN_INLET_WORKER`, `Brain/logs/inlet-worker.log` and retrieval events from step 8. |
| App pushes don't arrive | `/api/internal/broadcast` returns 401? Check `INTERNAL_API_TOKEN`; on Brain check its matching `BRAIN_APP_TOKEN` too. |
| `Channels: … not currently available` | Claude Code has no Claude sign-in: Anthropic opens its app channel only for a signed-in Claude account, even with another head. Sign in with `claude` and `/login`, keep that sign-in, then restart the loop and check `/status` for `server:app` listening. |
| Runtime unexpectedly replaced | Claude Code: `logs/claude-loop.log`. Brain: `Brain/logs/brain-loop.log`. Both loops send a restart notice. |

Most issues come from one of: a missing secret, a wrong `account_id` in
`wrangler.toml`, or a path mismatch between `$EMBERVY_HOME` on the VPS
and the hard-coded path in a hook.
