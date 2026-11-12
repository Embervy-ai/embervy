# ChatGPT subscription adapter

`chatgpt-oauth-adapter.ts` lets an agent think on a **ChatGPT subscription**
(Plus / Pro) instead of a metered API key. It is a single Bun file with no
dependencies. It listens on localhost, speaks two dialects towards the
agent and one towards the subscription backend:

| Front | Path | Who uses it |
|---|---|---|
| A — chat completions | `POST /v1/chat/completions` | the Brain runtime (`Brain/brain.ts`) and anything OpenAI-compatible |
| B — Anthropic messages | `POST /v1/messages` (+ `/count_tokens`) | Claude Code, pointed here via `ANTHROPIC_BASE_URL` |
| health | `GET /health` | loops and doctors |

Both fronts use OAuth credentials from a ChatGPT subscription. The saved
credentials select the upstream route: an issued `tokens.client_id` uses
OpenAI's official Sign in with ChatGPT route at
`https://api.openai.com/v1/responses`; credentials without an issued client
ID keep the Codex-compatible `https://chatgpt.com/backend-api/codex/responses`
route. No model API key is sent. Usage counts against the ChatGPT plan and
its app-specific limits; the adapter never falls back to another billing path.

**The old Codex-compatible route remains the default** until the official
route has been measured in long daily use. Both routes cache stable prefixes,
and on both the cache depends on the same thing: the adapter sends stable
`session-id` and `thread-id` headers per conversation, which keep the
conversation on the machine that holds its cache. Without them almost every
official request arrives cold and its input counts in full against the plan.
Official sign-in is an explicit opt-in, not an automatic migration.

> Claude Code will show "API Usage Billing" in its status line as soon as
> it talks to a custom base URL. That label describes what Claude Code
> assumes, not what happens. With this adapter no paid key is ever sent:
> the token it forwards is the placeholder `subscription-via-adapter`,
> which the adapter ignores.

## Prerequisite: the subscription login

Set **`CHATGPT_ROUTE=codex`** (the default, including an unset or unknown
value) or **`CHATGPT_ROUTE=official`** before starting sign-in. This setting
selects the sign-in flow, not the route of already saved credentials.

- **Claude Code house:** keep the Claude sign-in for the app channel even when the head is ChatGPT. Set `CHATGPT_ROUTE` in `Claude/app/.env`, alongside
  `CHATGPT_AUTH_FILE`, and mirror it in the house root `.env` for the doctor.
  Load those settings into the environment of the installer/sign-in helper.
  The Brain-menu sign-in HTTP route remains Brain-only; it is not a new
  Claude Code login screen.
- **Brain house:** set it in `Brain/brain.env` (or the app's configured
  `BRAIN_ENV_FILE`), alongside `CHATGPT_AUTH_FILE`. The app reads that file
  when a sign-in link is requested. The doctor reads it independently.
- **Standalone adapter or installer:** export it in that process's
  environment. The adapter's `/health` includes a migration notice only
  when its environment says `official` and its credentials are old.
  Brain's managed adapter does not currently forward this setting; the
  doctor provides that notice for a Brain house instead.

With `codex`, the existing authorization and token requests are unchanged;
`codex login` credentials also continue to work. With `official`, Embervy
uses the documented dynamic registration, app name `Embervy`, PKCE, fresh
state and nonce, identity and ChatGPT plan-usage scopes. The person signs
in in their own browser and pastes the **complete** loopback redirect URL
back. A visible connection failure at `127.0.0.1:1455` is expected: it is the
browser's computer, not the server. No callback listener runs on the server.
Treat the pasted URL as a secret and never include it in logs or reports.

The issued client ID is read from that callback, not guessed and not replaced
with `dynamic_agent_client`. Bun WebCrypto verifies the ID token's RS256
signature, issuer, issued-client audience, expiry and nonce using OpenAI's
pinned discovery/JWKS URLs. Keys are cached and reloaded for an unknown `kid`.
Returning sign-in reuses the saved client and checks the verified subject.
The retained ID token is stored privately; this app leaves account selection
visible rather than returning an `id_token_hint` in its UI's sign-in URL.

The adapter reads `CHATGPT_AUTH_FILE` (standalone default
`~/.codex/auth.json`). Keep the house's existing path: typically
`state/chatgpt-auth.json`, or `Brain/state/chatgpt-auth.json` for Brain's app
sign-in. Official records retain `tokens.client_id`, validated identity,
tokens including the ID token, scopes, expiry and receive time. Files are
written atomically with mode `0600`. A sign-in without the direct plan scope
is retained as plan-disabled and cannot perform inference.

`ensureChatGptHostId(authFile)` from `shared/scripts/chatgpt-signin.ts`
creates a private `${authFile}.host.json` sidecar once, holding a random
`urn:uuid:<UUIDv4>`. Installers can call it on the target server and pass
its result as `hostId` to `startChatGptSignIn({ route, authFile, hostId })`.
Keep that sidecar when importing replacement credentials; do not copy a
laptop's host-ID sidecar onto the server. The next authorization always uses
the server's retained host ID.

Official access tokens refresh near expiry or once after a 401, with the
issued client ID, the documented token endpoint and no scope narrowing.
Refreshes are locked across processes; replacement tokens, granted scopes
and expiry are saved together. Temporary failures preserve credentials;
terminal refresh failures clear unusable tokens but retain the registration
and host ID for signing in again. Old credentials retain their existing
Codex refresh request and recent-refresh guard.

**Changing routes requires signing in again.** Set `official` and complete
sign-in to opt in. To return to the default, set `codex` (or remove the
setting), then complete sign-in again. Changing the setting alone does not
reroute an existing official token set. The doctor warns only for
`official` plus old credentials: "signed in the old way; sign in again to
use the official route".

## Start

```sh
ADAPTER_PORT=3041 \
ADAPTER_MODEL=gpt-5.6-terra \
ADAPTER_CACHE_KEY=my-agent \
bun shared/tools/chatgpt-oauth-adapter.ts
```

| Variable | Default | Purpose |
|---|---|---|
| `ADAPTER_PORT` | `3041` | Listen port (localhost only). One adapter per agent is the simple setup. |
| `CHATGPT_AUTH_FILE` | `~/.codex/auth.json` | Token file of the subscription login. |
| `CHATGPT_ROUTE` | `codex` | Sign-in selection: `official` opts in; other values use `codex`. Existing credentials select inference independently. |
| `ADAPTER_MODEL` | `gpt-5.6-terra` | Backend model for **every** request; the model name the client sends is ignored. |
| `ADAPTER_EFFORT` | unset | Reasoning effort: `low`, `medium`, `high`, `xhigh`. The adapter's value wins over whatever the client displays. |
| `ADAPTER_CACHE_KEY` | `embervy-<model>` | Stable cache key and session seed. **Give every agent its own.** |
| `ADAPTER_REASONING_REPLAY` | on | `0` disables replay of encrypted reasoning items (see below). |
| `ADAPTER_WEB_SEARCH` | off | `1` gives Front A the backend's built-in web search. Front B needs no switch. |

Done-gate: `curl -s localhost:3041/health` answers `{"ok":true,…}`.

## Use with Claude Code (Front B)

The Claude loop does this for you when `EMBERVY_BACKEND=gpt` is set in the
agent's `.env` (see `Claude/scripts/start-claude-loop.sh`): it starts the
adapter if it is not running, points `ANTHROPIC_BASE_URL` at it, sets the
context window to what the subscription carries (1M) and the watchdog to the
GPT presets (warn 200K, cut 220K), and falls back to Claude if the token file
or the adapter is missing.

Claude Code still needs the Claude sign-in from step 6a for the app channel while it thinks through the ChatGPT adapter: Anthropic opens that channel only for a signed-in Claude account.

Relevant `.env` keys: `EMBERVY_BACKEND=gpt`, `EMBERVY_GPT_MODEL`,
`EMBERVY_GPT_EFFORT`, `EMBERVY_GPT_CACHE_KEY`, `GPT_ADAPTER_PORT`,
`EMBERVY_GPT_CONTEXT`, `WATCHDOG_WARN_TOKENS_GPT`, `WATCHDOG_CUT_TOKENS_GPT`.
A backend switch needs a respawn; the base URL is read at session start.
The two watchdog keys do not: the watchdog re-reads them every minute, so
a change applies within a minute.

What works through Front B: tool loops, images (in messages and in tool
results), **WebSearch** and WebFetch, cache figures in the status line.

## Use with Brain (Front A)

```sh
BRAIN_ENDPOINT=http://127.0.0.1:3041/v1/chat/completions \
BRAIN_API_KEY=unused \
BRAIN_MODEL=gpt-5.6-terra \
bun Brain/brain.ts
```

`BRAIN_API_KEY` can be any placeholder; the adapter does not read it.
Start the adapter yourself (or from your own loop script) — Brain does not
start it. With `ADAPTER_WEB_SEARCH=1` the model can search the web on its
own and answers with source links; Brain needs no search tool and no search
key for that. If Brain is configured with its own `web_search` tool
(`BRAIN_WEB_SEARCH_*`), the adapter leaves that tool alone and adds nothing.

## Official-route preview behavior

The official route always sends `store: false`, `stream: true` and the full
input history. It omits every unsupported field listed in the supplied
preview documentation, including `previous_response_id`. System messages
become instructions or developer messages. Only documented request fields
are forwarded; the legacy cache/session headers and optional reasoning,
verbosity and cache-key knobs are not sent on this route.

Function tools are grouped into one `house` namespace. Finished calls are
collected from `response.output_item.done`, since `response.completed` can
have empty output. Tool replay retains the namespace and original call item
while available, followed by its `function_call_output`. The namespace is
also restored for reconstructed history after an adapter restart. Web search
remains subject to the selected model and account policy; unsupported hosted
tools are not forwarded.

`GET /v1/models` on the adapter fetches the official account catalog from
`https://api.openai.com/v1/models`, keeps `visibility: "list"` in server order,
and exposes each `slug` as the model ID and `display_name` as its label.
The official sign-in probe consults that catalog and checks the configured
model with a real Responses request. Select a visible slug; it does not
silently substitute a different model. Neither the catalog nor HTTP 200
alone proves inference: the probe requires `response.completed` and rejects
failed, incomplete or interrupted streams.

Official errors retain HTTP status, machine-readable code, parameter and
request ID in the existing client error envelopes. The upstream envelope
shape is retained with string values redacted; free-form upstream bodies
are not echoed, because they can contain credentials. A plan-limit error
returns 429 and points to ChatGPT Settings → Usage; permission failures are
not retried as reasoning failures. Temporary 503 failures preserve credentials
and leave bounded backoff to the caller. There is no automatic billing fallback.

## What we measured on the default Codex route

These cache observations were made on the old route. On the official route the session headers matter in the same way; the other points have not been measured there yet.

**Prompt cache.** The subscription backend caches stable prefixes, and
cached input counts far cheaper against the subscription's limits. Two
things decide whether the cache holds in an agentic tool loop:

1. *Cache affinity follows a session header, not the cache key in the
   body.* With only `prompt_cache_key`, byte-identical prefixes bounced
   between 0 % and 90 % cached from one call to the next. The adapter
   therefore sends a stable `session_id` / `conversation_id` per
   conversation. After that change: 94–100 % cached on consecutive calls.
2. *Reasoning models want their own reasoning items back.* The adapter
   requests `reasoning.encrypted_content`, keeps the items in memory and
   re-inserts them before the matching tool call or assistant message.
   If the backend ever rejects that (HTTP 400), the adapter switches the
   replay off for the rest of the process and the turn still succeeds.
   Consequence: the first request after an adapter restart misses once.

Every request logs one line, hashes only, never content:

```
[cache-diag] in=71000 cached=70400 (99%) items=41 reasoning=6 tools=69 t=10:27:58
```

If the rate drops, the same line names what changed since the previous
request: `INSTRUCTIONS-CHANGED`, `TOOLS-CHANGED(a->b)` or
`HISTORY-REWRITTEN at #n`.

**Keep-alive.** A keep-alive ping only pays when the agent has a large
window and frequent traffic. With a working cache a ping costs roughly a
tenth of the window; a cold start costs the window once. Ten pings equal
one cold start, so cap a keep-alive at about eight in a row and let the
agent sleep through the night. Check the first ping: if it reports 0 %
cached, switch the keep-alive off — it would burn the whole window every
time. Measured retention on this path is about thirty minutes, so ping
every 25.

**Web search.** Claude Code's WebSearch is an Anthropic *server tool*: the
API executes it, the client never does. Forwarded as a plain function,
nobody runs it and the search silently returns nothing. The adapter maps
it to the backend's built-in `web_search` tool and returns the hits in the
block shape Claude Code expects (`server_tool_use` +
`web_search_tool_result`).

**Context window.** The window is what the model can do: the subscription
carries 1M. Warn and cut are presets for cost: the watchdog warns at 200K and
cuts at 220K. A later cut uses more of the subscription with every message, and
GPT currently adds a long-context surcharge on long input: check the provider's
current terms before you raise them. Raise them at any time without a cut, up to
the window. The Claude loop
sets all of this when `EMBERVY_BACKEND=gpt`; keep the Claude sign-in too, because Claude Code needs it for the app channel.

**Reasoning effort is the big tap.** High effort is affordable once the
cache holds (it then costs output tokens only), but it remains the fastest
way to drain a subscription's limits.

## Operating notes

- **Restarting the adapter is not restarting the agent.** A cut, a respawn
  or a new session leave the adapter running. Restart it only when you
  change its settings; the next request then misses the cache once.
- **One file, not copies.** Point every loop at this file instead of
  copying it into the agent's directory. A hand-merged copy is how you end
  up with a call to a function that is not there, and an adapter that
  answers every request with a 502.
- **Change it on a test port.** `ADAPTER_PORT=3099 … bun …` next to the
  live one, prove the change there, then let the live adapter pick it up
  at its next natural restart.
- Answers arrive in one piece after the model has finished thinking; long
  high-effort turns can be silent for minutes. The adapter has no idle
  timeout for that reason.

## Limits

The default Codex-compatible route is an unofficial client of a subscription
backend. It identifies itself the way the CLI does and may change without
notice. The opt-in route uses OpenAI's official Sign in with ChatGPT flow
for open-source apps and follows its preview limitations. Both use your own
subscription for your own agent, subject to the provider's terms and limits.
