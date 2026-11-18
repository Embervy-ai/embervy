# Embervy Dream Worker

The missing writer for the dream slot. `wake` displays the latest dream
note and `health` tracks `dream_last_run` — this small worker is the organ
that actually produces them: once per night it reads a few fragments from
the agent's chronicle (RAG), free-associates over them with a cheap model,
and writes one note into `dream_notes`.

It is deliberately a **separate worker**, not part of the housekeeping
daemon: it runs an hour after the daemon on purpose, so it dreams over the
day *after* the ranking pass, with its own failure domain and its own key.

## Attempt trace

Every due run (and every authenticated manual run) records its start time and
outcome in `dream_runs`, in the same D1 database as `dream_notes` and the memory
daemon's `daemon_runs`. Memory `health` adds `dream_last_attempt`,
`dream_last_result` (`ok`, `failed`, or `empty` for a successful no-write run), and
`dream_last_error` (`{ class, status }` or `null`). `dream_last_run` still means
the newest saved dream note, not the newest attempt. The current dream path
writes a note or fails; an empty/unusable provider response is a failure, not
`empty`. Archive context is optional: a missing binding, failed search or
unusable response uses the existing placeholders (`RAG unreachable.`,
`RAG search failed.` or `No RAG results.`), as does a search with no hits.
The dream continues and records `ok` if the model and note write succeed.
Error classes are `provider_http`, `provider_unreachable`, `provider_response`,
`write_failed`, and `unexpected`, with at most an HTTP status code: no provider error text,
conversation fragments, keys, or URLs are kept in the trace. If saving the trace
also fails, the worker only logs that storage failure; it does not replace the
original outcome. The doctor explains the latest failure when the dream is
overdue. Without a trace it keeps the older warning wording.

The dream worker ensures the `dream_runs` table and index exist before storing
each attempt, including in existing houses. No manual migration is required
after deploying the workers. The definitions match `schema.sql` and the optional
`shared/memory/migrations/003_dream_runs.sql` migration, which remains available
for houses that run migrations. It is additive, safe to apply twice, and changes
no existing notes or daemon runs. For example, from `shared/memory`, use
`bunx wrangler d1 execute <memory-database-name> --remote --file=migrations/003_dream_runs.sql`
with the actual house database name and the human's permission. Before the first
attempt creates the table, `health` returns all existing fields with `null`
trace fields.
Worker changes take effect only after deploying the worker, and that deploy
requires the human's explicit approval. Both the dream worker (writer) and the
memory worker (health reader) need their respective deploys; changing local files
or updating the doctor alone does not change the deployed workers.

## Deploy

```sh
cd shared/memory/dream-worker
cp wrangler.toml.example wrangler.toml   # fill in D1 id, rag service name, AGENT_NAME
bunx wrangler deploy
bunx wrangler secret put OPENROUTER_API_KEY
bunx wrangler secret put DREAM_AUTH_TOKEN
bunx wrangler secret put RAG_AUTH_TOKEN   # if your rag worker requires auth
```

Test without waiting for the night:

```sh
curl -s -X POST https://<worker-url>/dream -H "Authorization: Bearer $DREAM_AUTH_TOKEN"
```

## Notes

- An empty dream slot at wake means this worker isn't deployed or failed —
  treat emptiness as a health signal, never as a fact about the night.
- The first dreams after a migration read strange: a freshly moved store
  has unusual heat patterns for a few nights. Diagnose from dream five,
  not dream one.
