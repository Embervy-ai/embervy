# rag — transcript archive

Long-term archive for full chat transcripts (the installer names it
`embervy-chronicle`). Sits next to the memory worker (episodic memory) and serves as the cold layer: every full session
ends up here as a Markdown file, chunked, embedded, and searchable — and,
since the retrieval graph, walkable: every chunk knows its neighbours,
its session, and any correction that overrides it.

## What goes in

Markdown files (one per session, optionally split into `_partNN` fragments
for ones that exceed the chunk threshold), named `<Prefix>_<N>.md` or
`<Prefix>_<N>_partNN.md`. Each substrate's export pipeline produces these
automatically — `Claude/scripts/session-to-rag.sh` and Brain's own archive step
(`Brain/brain.ts`, at every cut). The head of each file carries the
session header block (THEMES / SUMMARY / EMOTIONAL_ARC / DATE …); the
worker reads the date from it.

## Search pipeline

Three stages, all in the worker:

1. **Vector + BM25 in parallel.** Vectorize (`EMBED_MODEL`, default
   bge-m3) for semantic recall, FTS5 on D1 for exact lexical matches
   (names, code tokens, IDs that pure vector search misses). The
   candidate pool (`fetchK`) is capped at 50 — Vectorize rejects larger
   queries with full metadata.
2. **RRF merge.** Reciprocal Rank Fusion (k=60) combines the two ranked
   lists into one.
3. **Cross-encoder rerank.** `RERANK_MODEL` (default bge-reranker-base,
   Workers AI) re-scores the top merged candidates against the query
   directly, then trims to topK. Falls back to RRF order if the rerank
   call fails.

`POST /search` takes `query`, `topK` (1–20, `limit` accepted as a legacy
alias), and an optional `mode` (`"hybrid"` default, or `"vector"` /
`"bm25"` to isolate one path). The response carries `reranked:
true/false`, per hit `date` and `session` (from the `files` table), and
`session_filter` when the query named a session explicitly
("<Prefix> 12", "session 12"): then only that session's chunks are
returned — strictly, with no fallback to unrelated hits. Vectors whose
chunk text is missing from R2 are repaired lazily and reported as
`ghosts_repaired`. The FTS query builder is deliberately broad
(OR-joined tokens) — RRF + the reranker reel that back in; `mode:
"bm25"` alone will be noisier.

Optional `dateFrom` + `dateTo` (both `YYYY-MM-DD`, inclusive, sent
together) restrict the search to files whose header date lies in that
range: BM25 is filtered in SQL through the `files` table, vector hits are
filtered afterwards (no Vectorize metadata index needed). The response
echoes the range as `date_filter` (`null` without it); an invalid or half
range is refused with 400. The inlet's time channel uses this
(`docs/inlet.md`); callers that do not send the fields get the same
answers as before.

Uploads also write the header date and the session number into each
vector's metadata (`date`, `session`). Nothing filters on them yet.

## Retrieval graph

Two D1 tables next to the FTS index (`fts-init.sql`; the worker also
creates them lazily on first use):

- **`files`** — one row per uploaded file: prefix, session number, part,
  header date, chunk count. Defines the **episode** of a chunk: its
  session plus the direct neighbour session on the same or an adjacent
  day (`episodeSpan`).
- **`chunk_edges`** — typed edges between chunk ids (`dst` may also be
  `memory:<event_id>`). Ingest writes `NEXT` (chunk i → i+1, also across
  `_partNN` boundaries) with `origin=ingest`, `confirmed=1`. Typed edges
  (`CORRECTED_BY`, `SUPERSEDED_BY`, `SUPPORTS`, `ABOUT`) carry their own
  origin and `confirmed` 0 = proposal, 1 = in effect, −1 = rejected (kept
  so the same wrong edge is not proposed twice). `note` snapshots the
  correcting text for edges that point at a memory event.

Confirmed `CORRECTED_BY` / `SUPERSEDED_BY` edges are **vetoes**: `/expand`
returns them alongside hits so a context injector can mark a passage as
overridden instead of serving it as current truth.

## Endpoints

All endpoints require `Authorization: Bearer ${RAG_AUTH_TOKEN}`. The
worker fails closed: requests are refused with 500 if `RAG_AUTH_TOKEN`
is not configured (you can't accidentally expose `/upload` or `/delete`
to the public internet by forgetting to set the secret).

| Route | Purpose |
|---|---|
| `POST /upload` | Multipart upload of a Markdown file. Splits into chunks (empty or substance-free chunks are skipped), embeds via Workers AI, indexes into Vectorize **and** FTS5, stores the original in R2, writes the `files` row and `NEXT` edges. Re-upload of the same filename writes the new chunks first and deletes surplus old ones last; graph writes are fail-open. Response includes chunk counts, `skipped`, `edges`. |
| `POST /search` | See pipeline above. |
| `POST /expand` | Body `{anchors:[{filename, chunkIndex}] (max 5), query?, neighbors? 0..2, episodeTopK? 0..10, episodeSpan? 0..3, exclude?, veto_for?}`. Returns NEXT/PREV neighbours of the anchors, with a query the best chunks from the anchors' episode that are neither anchors nor excluded, plus confirmed vetoes for the `veto_for` chunks (default: the anchors). |
| `GET /chunk?filename=&index=` | One chunk with its predecessor and successor ids (via edges, not guessed) and the `files` row of its file. |
| `POST /edge` | Body `{src, dst, type, confirmed? 0|1|-1, origin?, note?}`. Upsert on (src, dst, type): a second call confirms or rejects the same proposal; origin stays from the first writer, note is replaced when given. |
| `GET /edges?src=|dst=|pending=1&type=&confirmed=&limit=&offset=` | Review lists and veto rendering. |
| `GET /head?filename=&bytes=` | The head of an original (the session header block), up to 4000 bytes; falls back to `_part01` when the session was split. |
| `GET /original?filename=` | The full original from R2 (read-only) — for header backfills: fetch → regenerate header → re-upload. |
| `GET /list` | All files in the bucket (used by the export scripts to compute the next session number). Paginated. |
| `GET /files?from=&to=&order=&facts=&limit=` | Read-only. The `files` rows whose header date lies in `from`..`to` (`YYYY-MM-DD`, at most 366 days; month-only dates never match), ordered by date, session, part (`order=asc` default, or `desc`). The first `facts` sessions (0–12, default 6) carry `themes`, `summary`, `key_moments` from an 800-byte read of their first part's header; `limit` 1–500 (default 200), `truncated` when more exist. Index `files_by_date`. Used by the inlet's time channel. |
| `POST /delete` | Delete a file by name from R2, Vectorize, FTS5, `files`, and its graph edges. |
| `POST /fts-backfill` | Index existing R2 chunks into FTS5. Needed once after adding the D1 layer to an archive that already has content. Body `{"limit": 500, "cursor": "<from previous response>"}`. **Pass the returned `cursor` back on each call** — without it you re-scan page 1 forever. Repeat until `truncated: false`. |
| `POST /graph-backfill` | Body `{cursor?, limit? 1..50, force?}`. Walks the originals in R2 and writes the `files` row + `NEXT` edges per file. Idempotent (files with the right chunk count are skipped unless `force`); cursor to resume. Needed once for an archive uploaded before the graph existed. |

Numeric query parameters must be safe integers within their route's range; empty,
non-finite, fractional, negative and out-of-range values receive HTTP 400.
`offset` allows 0 through `Number.MAX_SAFE_INTEGER`; chunk `index` allows 0 through
999999. The signed `confirmed` enum remains -1, 0 or 1. Omitted values keep their
defaults. Uploads accept a file up to 10 MiB inside a body capped at 10 MiB + 64 KiB
for multipart framing; oversized declared or streamed bodies receive HTTP 413
before multipart parsing.

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `R2`, `VECTORIZE`, `AI`, `FTS` | yes | Bindings: R2 bucket, Vectorize index, Workers AI, D1 (FTS5 + graph tables). |
| `RAG_AUTH_TOKEN` | yes | Bearer for every route; the worker refuses to serve without it. |
| `SESSION_PREFIX` | no | Prefix used when a query names a session ("Journal 12"). Default `Session`; must match the filename prefix of your exports. |
| `EMBED_MODEL` | no | Workers AI embedding model id (default `@cf/baai/bge-m3`). |
| `RERANK_MODEL` | no | Workers AI reranker model id (default `@cf/baai/bge-reranker-base`). |

## Deploy

1. Create the resources referenced in `wrangler.toml`:
   - R2 bucket + Vectorize index
   - D1 database for FTS5 and the graph: `wrangler d1 create rag-fts`,
     then `wrangler d1 execute rag-fts --remote --file=fts-init.sql`
2. Fill in `account_id`, the D1 `database_id`, and any route you want to
   expose.
3. `wrangler secret put RAG_AUTH_TOKEN` and store the same token in your
   `$EMBERVY_HOME/.env` so the substrate scripts can authenticate.
4. `wrangler deploy`.
5. If the archive already had content before the D1 layer existed,
   backfill once: `POST /fts-backfill` in a cursor loop until
   `truncated: false`, then `POST /graph-backfill` the same way.

Offline tests (fake bindings, no Cloudflare account): `bun test shared/rag/test/`.

## Why a separate worker

The memory worker is hot — episodic, ranked, decayed. The `rag` worker is cold —
the full record. Keeping them separate lets the hot path stay small and
fast while the archive scales independently. The memory worker reaches into the
archive on demand via a service binding (`env.RAG.fetch(...)`) or
`RAG_URL`, for `recall`, `scan`, and the deep mode of `trace`.
