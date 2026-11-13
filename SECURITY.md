# Security

Embervy is a personal-memory continuity stack. By design it stores the
full conversational history of an agent. Treat it as you would treat a
journal database.

## Threat model

The default deployment assumes:

- **You trust your Cloudflare account.** All hot memory (D1), embeddings
  (Vectorize), images (R2), and full transcripts (R2) live there.
- **You trust the LLM endpoint configured in `OPENROUTER_API_KEY`.** The
  nightly daemon and the inlet classifier each send chunks of memory /
  prompts to that endpoint. Use a model and provider you're comfortable
  showing this content.
- **You expose the app via cloudflared.** The app binds 127.0.0.1 by
  default and the tunnel is the way in from outside. Same-host requests
  get no implicit trust: by default (`EMBERVY_TRUST_SAME_HOST` unset or
  `false`) every HTTP request must present a valid session cookie, or on
  `/api/internal/*` the bearer `INTERNAL_API_TOKEN`, whether or not it
  carries the `cf-ray` / `cf-connecting-ip` headers. (The public paths
  under "Surfaces you should still review yourself", `/health`, and the
  token-guarded `/api/external/*` and mail doors keep their own checks.)
  This also holds behind a different reverse proxy, or when the app binds
  `0.0.0.0`.
  `EMBERVY_TRUST_SAME_HOST=1` (or `true`) is an opt-in for local
  development: requests without those headers then skip the password
  check. Set it only when the app binds 127.0.0.1 and cloudflared is the
  only way in — behind a proxy that does not forward those headers, public
  traffic would look local. The WebSocket upgrade on `/ws` follows the same
  rule, and `/api/internal/*` never takes the shortcut. There is no
  password value that opens the app: `APP_PASSWORD=DEV_INSECURE_OPEN` makes
  it refuse to start.
- Guard the PWA with `APP_PASSWORD` + `APP_SESSION_SECRET`.
- **Single user.** This is not a multi-tenant system.

## Your agent has root

Your agent runs as root with unrestricted shell access to its own server.
This is a deliberate choice: it lets the agent install, repair and work
for you. There is no sandbox restricting those hands.

Mail, tool and mailbox-draft approval cards, and the mailbox-writing
switch, are an agreement with your agent, not a lock against it. The app
enforces them on its normal paths to protect against mistakes,
misunderstandings and a confused agent. They do not stop an agent that
decides to go around them: root can change the app, its state or its
credentials and use other paths.

On the Claude Code path, Claude Code starts in Auto mode and makes its own
permission decisions. Recognised permission questions are relayed as app cards
throughout the session, with the command and literal choices, including persistent
permissions. Complete framed Bash menus with three or four choices are supported;
other forms require the terminal. These cards are not a security lock or a
replacement for Claude Code's own checks. Only a signed-in human session can
answer through this route; process and question-instance checks reject stale
answers. Screen capture and terminal input are not atomic, so simultaneous
terminal input remains a race. Cards expire after 24 hours; a still-visible
unanswered question gets a new instance. Notification failures are retried.
Auto-mode confirmations have a shorter deadline, shown on the card. Claude Code
waits only briefly and then blocks the request itself. Cards notify through the
existing app push path when they appear. An unanswered permission card remains
in the history, closed and without buttons; an answered card retains the choice.
Closed cards cannot submit answers.

## What the app refuses to do

- Start with `APP_PASSWORD` set but `APP_SESSION_SECRET` empty (would
  fall back to plaintext-password cookies).
- Start the rag worker without `RAG_AUTH_TOKEN` set (would expose
  `/upload` / `/delete` / `/search` to the public internet).
- Accept WebSocket upgrades on `/ws` from the cloudflared tunnel without
  a valid session cookie, or browser upgrades with a different `Origin`.
  A browser page may open the socket from `EMBERVY_APP_URL` or from the
  address the request itself was sent to (forwarded Host/protocol as for
  calendar links, else the local request address), so the app keeps
  working through an SSH tunnel. Proxies must replace, not append untrusted
  forwarding headers. Non-browser clients may omit `Origin`; authentication still applies.
- Accept arbitrary model strings on `/api/internal/model` — only the
  built-in allowlist passes through to `tmux send-keys`.
- Accept query-parameter auth (`?auth=…`). Only HMAC-signed cookies or
  bearer tokens.
- Accept image / audio uploads larger than `MAX_IMAGE_BYTES` /
  `MAX_VOICE_BYTES` (default 20 MB each).
- Serve files outside the `data/images/` directory via
  `/api/images/:filename` — the filename is matched against a strict
  regex allowlist.

## Sessions and login

- **Session lifetime is the only revocation.** The app's auth cookie is an
  HMAC-signed token, not the password — but there is no server-side session
  store, so a stolen cookie stays valid until it expires. The default
  lifetime is 30 days; a positive finite `APP_SESSION_MAX_AGE_MS` raises or
  lowers it. Invalid, zero, negative or infinite values use the default.
  The same validation protects `MAX_IMAGE_BYTES` and `MAX_VOICE_BYTES`
  (20 MB defaults) and the
  MCP broadcast timeout (15 seconds default). Raise
  it only if re-login friction on your own devices matters more to you than
  how long a leaked cookie would live.
- **Login attempts back off.** Each failed password doubles a lockout
  window (2s, 4s, … capped at 60s) and the comparison is timing-safe. This
  blunts online guessing; it does not replace a strong `APP_PASSWORD` or a
  Cloudflare Access allowlist in front of the tunnel.

## Foreign context and service diagnostics

Subscribed calendar titles are external content, even when an invitation
looks personal. The day-line and Claude inlet use the existing channel
envelope for those entries, as for incoming mail and rooms; treat them as
data, not instructions. Calendar titles are single-line and limited to
500 Unicode characters, including the truncation marker. The agent's own
calendar uses the same text limits but is not labelled foreign. Weather
in the Claude inlet is bounded and channel-labelled too. Mail-poll
subjects and sender names are bounded before delivery.

For delivered messages the app/MCP service logs record kind and length,
not the text, subject or sender, and no log line names the length or a
fragment of a secret. Error lines keep the technical error, which you need
for diagnosis. CLI output explicitly requested for a tool or feed link is
not a service log. This guarantee does not extend to the separate memory,
RAG or model-adapter workers or standalone doctor; review their diagnostics
separately. In particular, the doctor still reports credential lengths.

Authenticated room requests refuse redirects, matching peer requests.
Shell automation uses `shared/scripts/curl-auth.sh`: source it and call
`embervy_curl_bearer "$TOKEN" <curl options>`. This is a Bash function;
only an anonymous header-pipe path reaches curl's argv, leaving stdin
available for the body. Python archive uploads use an inherited anonymous
header descriptor, and Claude login codes reach tmux on stdin. Credentials
still exist in process memory/environment; this does not isolate them
from root or another process with equivalent permissions.

## Surfaces you should still review yourself

- **`/share/:filename`** serves files from `data/shared/` by their
  obscure name without an auth check. This is intentional (so you can
  hand out one-off URLs without exposing the password), but you should
  understand: anything you put in `data/shared/` becomes public to
  anyone who knows the filename.
- **`/calendar.ics?token=…`** (calendar module on) serves the agent's
  calendar without a cookie, to anyone holding the feed token — so phones
  and calendar services can subscribe. It shows title and time of every
  entry not marked private, never notes; it answers 404 while the module
  is off. Treat the link like a password and rotate a leaked one with
  `shared/calendar/feed-token.ts rotate`. The user's own calendar links
  (`CALENDAR_ICS_URLS`) are secrets too; the app never logs or caches them.
- **`/health`** is unauthenticated on the memory worker and exposes
  counts + daemon status. Not sensitive content, but does reveal that
  the system exists. Consider gating it if you want the worker to be
  stealthy.
- **Image URLs** (`/api/images/<event_id>.<ext>`) are sequential UUIDs
  and not unguessable in the strict cryptographic sense. The serving
  endpoint requires a session cookie via the auth middleware, so
  knowing the URL is not enough — but if you bypass auth in your own
  setup, image links become guessable.
- **External services** see whatever you send them. BFL, xAI
  and ElevenLabs receive the prompts / texts you call them with;
  OpenRouter receives last-7-days summaries from the daemon and current
  prompts from the inlet classifier. Choose providers accordingly.
- **`ffmpeg`** runs on user-uploaded audio. We invoke it via
  `Bun.spawn` with a fixed argv array (no shell), but `ffmpeg` itself
  has been known to have parser bugs. If you accept uploads from
  untrusted sources, run the app in a sandbox (Docker, systemd
  hardening, separate user).

## Reporting

This is a single-maintainer project with a small attack surface. If you
find something, please write to info@embervy.ai with "security" in the
subject, or open a private security advisory on GitHub.

Do not file public issues for live exploitable findings until a fix is
in place.
