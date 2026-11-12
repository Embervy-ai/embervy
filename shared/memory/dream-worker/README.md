# Embervy Dream Worker

The missing writer for the dream slot. `wake` displays the latest dream
note and `health` tracks `dream_last_run` — this small worker is the organ
that actually produces them: once per night it reads a few fragments from
the agent's chronicle (RAG), free-associates over them with a cheap model,
and writes one note into `dream_notes`.

It is deliberately a **separate worker**, not part of the housekeeping
daemon: it runs an hour after the daemon on purpose, so it dreams over the
day *after* the ranking pass, with its own failure domain and its own key.

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
