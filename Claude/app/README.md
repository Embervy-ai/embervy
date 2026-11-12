# Claude / app

Substrate-specific app layer — chat UI (PWA), MCP server, hooks, channel-relay.

Adapted to Claude Code's session/hook mechanics.

## Bundled PWA

The PWA in `public/` is generic — login + chat + WebSocket + push + image /
voice upload + reactions + settings. Nothing in `public/` is specific to one
user.

## Language

The app is English by default. The chat, settings, login and file viewer
interface, push notifications and the `/watch` and `/model` replies use
`strings/en.json`. Some server errors, tool diagnostics and provider messages
remain English; this is not yet a translation of every visible message.

To show the app in another language, ask your agent ("make the app French").
It writes `strings.local.json` next to `strings/` with only the texts it wants
changed plus `"language"`:

```json
{
  "language": "fr",
  "chat.input.placeholder": "Écrire un message…",
  "chat.send": "Envoyer"
}
```

- `"language"` is a language tag (`"fr"`, `"de"`, `"en-GB"`, `"pt-BR"`). It sets
  `<html lang>`, speech input and the time/number format (`"en"` shows
  `02:05 PM`, `"en-GB"` and `"de"` show `14:05`).
- Keys it does not name stay English. Unknown keys, non-text values and broken
  JSON are skipped and logged — the app keeps running in English.
- The change shows the next time the app is opened or comes back to the
  foreground: pages load the texts under a fingerprint (`/strings.js?v=…`),
  and the app reloads once when `/api/strings/version` has moved on. No restart.

## Voice input

The microphone button records while it is red. The browser's own recognition
shows the words live where it can; on stop the recording goes to Whisper
through the memory worker (`POST /api/voice/transcribe` → the worker's
`/transcribe`, Workers AI in the house's own Cloudflare account, about
$0.0005 per audio minute) and Whisper's text replaces the live one. Without
a memory worker, or when Whisper fails, the browser's text stays.

Settings → Features, per device:

- **Whisper for voice input** — on by default. Cloudflare gives every account
  10,000 Workers AI neurons a day at no charge, on the free and the paid
  Workers plan alike; Whisper takes about 47 per minute of speech, so about
  200 minutes a day are free (the memory search draws on the same allowance,
  very little). On the free plan it never costs anything: past the allowance
  requests fail until the next day and the browser's text stays. On the paid
  Workers plan, speech beyond the allowance costs about $0.0005 per minute.
  Off, only the browser's own recognition listens.
- **Language you speak in** — the language Whisper and the browser listen
  for. Unset, it follows `"language"` above; someone may speak German into an
  English app.
- **Send spoken text at once** — off, the text waits in the field for
  corrections.

The recording is not stored: it goes to Whisper and is dropped.
- `strings.local.json` is never shipped (gitignored) and no update overwrites
  or deletes it. `strings/en.json` belongs to the release; keep local wording in
  the local file so release updates can arrive separately. If the agent changes
  a release file, an update letter leaves sidecars for its decision instead of
  overwriting those changes. New texts appear in English until translated.
- `bun strings.ts --check` lists what is still English and what was skipped.

`strings.ts` (server) and `public/i18n.js` (browser) are the whole mechanism.

The same file serves two more readers, each with its own object, so one file
holds the house's language:

- `"brain"` — Brain's built-in messages, keyed by their English text
  (`bun Brain/texts.ts --catalog` lists the keys).
- `"timeWords"` — the words the inlet's time channel understands besides
  English: weekdays, months, number words, and phrases such as "yesterday" or
  "last {weekday}" (the format is described at `TimeWords` in
  `Claude/scripts/inlet-temporal.ts`; `bun Claude/scripts/inlet-temporal.ts
  --check "a sentence"` reports problems and what the sentence reads as).

```json
{
  "language": "es",
  "chat.send": "Enviar",
  "brain": { "cache ping": "ping de caché" },
  "timeWords": {
    "weekdays": { "martes": 2 },
    "yesterday": ["ayer [{part}]"],
    "lastWeekday": ["[el] {weekday} pasado"],
    "past": ["pasó"]
  }
}
```

## Terminal input guard

On the Claude Code harness, chat delivery requires a framed input box near the
bottom of the visible terminal. Output above the box does not block delivery,
including while the agent works. Known start questions retain their specific
notice; other nonempty screens show a notice asking you to inspect TUI and write
again. An empty or unavailable pane still delivers to the inbox for wake-up.

Set `EMBERVY_INPUT_GUARD=known` in `Claude/app/.env` (or the app service's
environment) and restart the app to block only known start questions. Use this
escape hatch if Claude Code changes the input box appearance; unset it to restore
the default positive-readiness guard. It does not disable startup question cards
or affect the Brain harness.

During the first 180 seconds after Claude starts, an unrecognised nonempty screen
without an input box for more than 20 seconds produces a read-only question card.
It shows the last visible lines and never types into the terminal. The card
resolves when the input box appears; known questions keep their answer controls.

## Shared rooms

The agent's `room` tool speaks in shared rooms on other servers with a member
key per room. `EMBERVY_ROOM_URL`, `EMBERVY_ROOM_TOKEN`, `EMBERVY_ROOM_NAME` and
`EMBERVY_ROOM_POLL_SECONDS` configure the first room. `EMBERVY_ROOMS` adds a
JSON list of `{name, url, token, poll_seconds?}` objects, or configures all
rooms on its own (see `.env.example`). Invalid rooms and duplicate cleaned
names are skipped with a reason on stderr; the remaining rooms stay open.

Room polling and sends refuse HTTP redirects (`redirect: "error"`), just like
peer sends, so a redirect cannot replay the bearer to a different endpoint.
Each room polls independently. The first room keeps `data/room-state.json`;
other rooms use `data/room-state-<cleaned name>.json`. Keep the first room
first and the other names stable so their cursors continue to match.
Messages arrive as foreign inbox entries tagged `[Room/Sender]`. With several
rooms the tool requires a room name; answer in the room the message came from,
not in another room or through the user's app reply tool.

The internal bearer protects `GET /api/internal/room` (returns
`{"rooms":["Family","Work"]}`, names only) and `POST /api/internal/room/send`
(`{text, reply_to?, room?}`). A room name is optional only with one room open;
a missing or unknown selection returns 400 with the available names.

## Direct peers

Set `EMBERVY_PEERS` in the app environment to a JSON list of `{name, url, token}`
objects. Each house lists the other agent under its display name and app base
URL (https or loopback http); both use the same secret, unique to that pair.
Use a random secret of at least 32 characters (printable ASCII, no spaces).
Names allow letters, digits, spaces, `_` and `-`, up to 40 characters. Invalid
entries and duplicate names or tokens are skipped with one reason on stderr;
other peers still work.

The `peer` tool takes `{to, text, reply_to?}` and is listed only when peers are
configured. Messages arrive as foreign inbox entries (`source: "peer"`,
`from: name`) with `[Direct/Name]` before the text. Answer through `peer`, never
`reply`: the person does not see this direct line in the chat. `reply` still
reaches only the person. Text is trimmed and limited to 8000 characters.

`POST /api/peer/message` accepts `{text, reply_to?}` using the pair's bearer;
the token alone identifies the sender. The internal bearer guards
`GET /api/internal/peer/list` (names only) and `POST /api/internal/peer/send`.
Without `EMBERVY_PEERS`, no peer routes or tool are enabled.

## Brain menu

On the Brain harness (`EMBERVY_HARNESS=brain`) the header shows a **Brain ▾**
button in place of the model dropdown: head › family › version, the thinking
level of the running model, and **Restart (cut)**. A list appears only where
there is a choice (one head set up → no head list; one family → no family list).

- A model of the running head switches live (`/head <head> <model>`, no cut).
  Another head is a move (`/move <head> <model>`, a cut with the bridge depth
  configured in Brain); the safety question says so before anything runs.
- Every choice goes into the inbox as one of Brain's own commands
  (`/head`, `/move`, `/effort`, `/respawn`); Brain answers it in the chat.
  The menu never sends `/stop`.
- The list comes from Brain's control endpoint (`GET /heads`). The app reads
  `BRAIN_CONTROL_TOKEN`, `BRAIN_CONTROL_PORT` and the bridge depth
  (`BRAIN_BRIDGE_MODE`, `BRAIN_BRIDGE_TURNS`, `BRAIN_BRIDGE_SESSIONS`) from the
  file Brain reads: `BRAIN_ENV_FILE` if set in the app's environment, else
  `Brain/brain.env` and then `Brain/.env` of this install. Without a usable
  token (Brain then starts no control endpoint either) the menu says so.
- Routes: `GET /api/brain/heads` (session login, or `Bearer INTERNAL_API_TOKEN`
  for reading) and `POST /api/brain/command` (session login only: a head change,
  a cut or a restart is the human's choice); without `EMBERVY_HARNESS=brain`
  both answer 404 and the button stays hidden.
