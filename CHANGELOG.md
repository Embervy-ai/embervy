# Changelog

Embervy uses [semantic versioning](https://semver.org/). The current version is in `VERSION`. Installed houses receive updates as letters, and every letter names the changes it carries.

## 1.0.6 (2026-11-27)

### App

- On iPhone, copying text that began with a word and a colon, such as `Subject: a b`, could paste percent-encoded text into Mail or Notes. Copy boxes, message actions and kept messages now copy from a selected read-only field first, preserving plain text and returning focus to the previous control. The clipboard API is used only if copying from the field fails.

### Brain

- Brain takes a leading `[Room/Speaker]` prefix as a speaker name only for the house's configured rooms (`EMBERVY_ROOM_NAME`, `ROOM_NAME`, `EMBERVY_ROOMS`) and for `Direct`, the same rule as in Claude Code houses. Before, any message that began with bracketed text containing a slash, such as `[Draft/2]`, was filed in the bridge and the archive under a speaker called `2`. Brain reads room names from the house settings and the app's own settings file, including the room list, with its own environment taking precedence, including the app's default `Room` for unnamed configured rooms.
- Brain counts a model step correctly when the engine opens a streamed message with a provisional prompt count and reports the final split between new and cached input at the end. Before, the provisional count stayed next to the final cached count: the context watchdog counted the prompt twice and would cut at about half the window, and the status line showed every step as uncached. Seen with the Kimi model `k3`; `kimi-for-coding` and `k3.1-pro` report the split from the start and were not affected.

### Doctor

- A new check, "Push subscriptions", counts the stored push subscriptions the app skips because their host is neither a browser push service nor named in `EMBERVY_PUSH_RELAY_HOSTS`, and warns when there are any. Before, such a subscription was skipped at every message with no log line and a green doctor, so a house could go silent for its person unnoticed. The check and the app's new log line (once per start) give counts only, never an address or a host.

## 1.0.5 (2026-11-25)

### App

- A house that runs its own push relay can name its host in `EMBERVY_PUSH_RELAY_HOSTS` (comma-separated, exact host names, HTTPS only). Since 1.0.0 the app accepts push subscriptions only from the browser push services of Apple, Google, Mozilla and Microsoft and skips stored subscriptions to any other host, so a self-run relay was refused with 400 and went silent. Without the setting nothing changes. IP addresses, localhost and wildcards are ignored. The app needs a restart after the setting changes.

## 1.0.4 (2026-11-25)

### Inlet

- The inlet's query step survives a provider that ignores its settings. The step asks a small model through OpenRouter for the search queries of a turn. One of the providers behind the default model spent the whole answer on reasoning and returned empty content, so the turn ran "without its query step" and searched with the raw message only. An empty or non-JSON answer, or an answer without a usable query, is now asked once more within the same 15-second budget, with the provider of the first answer excluded. `INLET_PROVIDER_IGNORE` (comma-separated, empty by default) excludes providers from the first request onward.
- Every line the inlet worker writes to its log carries a UTC time after its bracketed prefix. An unusable answer names its provider, finish reason and kind (`empty` or `no_queries`), never content.

## 1.0.3 (2026-11-20)

### Brain

- A head attached directly to Brain (`BRAIN_GPT_TRANSPORT=api` and the other API heads) now receives pictures sent in the app; this is tested with ChatGPT. The picture travels with the turn in which it was sent, stays through that turn's tool calls, and is not kept in the next turn, the bridge or the archive. On by default; `BRAIN_APP_IMAGES=off` turns it off. With it on, a picture sent in the app goes to the model provider of that head. A failed picture turn reports a fixed code, phase and HTTP status, never provider text.
- The ChatGPT adapter passes picture parts on both of its routes and answers a refused picture with fixed codes. A house that runs ChatGPT directly on Brain updates Brain and the adapter together and restarts the adapter.
- A house without the approval card system (`BRAIN_PIPE_PERMISSION=none`, no approval settings file) may write its own skills under `.claude/skills`; everything else that would ask is still refused. A house that has the card system and runs it at level `none` could already do this through the ordinary path.
- The heads menu says when each provider's model list was last fetched, names the class of a failed fetch, and warns when the selected model is no longer offered. The model is never changed for you.
- A Kimi head without a key can be set up from the Brain menu of the app.

### Memory

- Model, output budget and timeout of the nightly memory worker and of the dream worker are settings (`DAEMON_LLM_MODEL`, `DAEMON_MAX_TOKENS`, `DAEMON_TIMEOUT_MS`, `DREAM_LLM_MODEL`, `DREAM_MAX_TOKENS`, `DREAM_TIMEOUT_MS`), described in one place in `shared/memory/README.md` under “Changing the night model”. Memory health shows the nightly worker's values in effect and the product version the worker was built from; the dream worker's values are not shown there yet.
- A failed nightly run stores and shows a fixed class and status instead of provider text. Rows recorded before this version are shown as withheld. Health warns when the last dream run failed.
- The doctor names the setting to change when the configured model is rejected, times out or answers unusably.
- Both workers need a fresh deploy to take this version.

### Handbook

- A new paragraph says that the house is the agent's to build on, with a copy and a way back, and how household wishes are handled.

### App

- Name, title font and background image settings now belong to the house and follow the user across devices. Colors and opacity remain device-local; “Use the house look” resets those colors without deleting shared appearance. Existing device choices migrate only into a house with no saved version. Private server storage keeps the image separately from metadata and commits updates atomically.
- Chat, terminal logs, Kept and doctor hints now use one two-digit 24-hour clock in the house time zone. Date parts and number formatting still follow the interface language.
- Claude Code houses: an answered permission card no longer sticks below the newest message after every reload. A closed card keeps the time it was closed and sits at that place in the conversation; closed cards without a time are not shown, and the history keeps the latest 50 for at most 14 days.

## 1.0.2 (2026-11-18)

### Repairs

- Memory workers: Mistral retired Mistral Medium 3.1, the default model of the nightly memory worker and the dream worker. From the night of 18 November both failed with `400 invalid model`. The default is now `mistralai/mistral-medium-3-5`, its direct successor. The dream worker's model can be set with `DREAM_LLM_MODEL`, as the nightly worker's already could with `DAEMON_LLM_MODEL`. **Both workers must be deployed again for this to take effect.** Nothing was lost in between: memory kept working, only the nightly sorting and the dream were skipped.
- Claude Code houses: the inlet worker's repeat window works (a turn counter and a cache folder per session), so the same passage is not brought again turn after turn.
- Settings: a Brain house no longer shows a leftover Model card.
- The message actions button takes focus only when the menu is opened from the keyboard.

### Security

- `@hono/node-server` moves to 2.1.8 through the app's package override. Versions from 1.19.10 up to 2.1.3 decode a static request path twice (GHSA-rmxm-3fg6-px4f); the last version had moved to 1.19.19, which the advisory includes. The app serves its files with Hono's own `serveStatic` for Bun and does not call the affected function; the package is in the tree through the tool server's SDK.

### App

- A Markdown table in a message is shown as a table that stays readable at phone width; a wide table scrolls sideways inside its bubble.
- A swipe that starts inside a part of a message that scrolls sideways no longer opens the terminal panel.
- The terminal view loads older output on its own when the text is shorter than the panel.
- On a permission card, Yes and No are the only buttons. The answer that adds a lasting rule to the agent's settings stands below them as a line of text with a note that says so.
- The Brain menu recognises the running model with or without its window suffix and keeps the large window on a model change.

### Inlet

- Opt-in: with `INLET_THOUGHTS=1` the inlet adds the agent's own earlier observations on the turn's subject as a block of thoughts, between people and places and the chronicle. Off by default; a house that does not set it gets the same inlet as before. See `docs/inlet.md`. The score threshold is still being calibrated in our own houses.

### Calendar

- Recurring entries: the `calendar` tool adds a series in one call (weekdays, an end date, single days left out) and removes it by its series id, whole or from a given day on.

### Runtime

- Brain: an approval waits as long as its card instead of ending after about five minutes. A card that ends without an answer is closed in the app, a poll the app cannot answer is not a decision, and the message tells an unreachable endpoint from an unanswered card.
- Brain: a turn that ends with an error names its kind, status code and error text in the session log.
- Brain: the subscription state the Claude head reports with every turn is kept per account and shown as one line in `/status`.
- Claude Code houses: the restart notice is sent after the loop has reloaded itself, once, and never holds the restart back.
- The update hint for houses with their own look names `settings.html`.
- Dream worker: every due run leaves its outcome (attempt, result, error class and status, never the provider's text) in the memory worker's `health` and in the doctor. Takes effect after the dream worker and the memory worker are deployed.
- Claude Code houses: the status line records the subscription windows, and `Claude/scripts/setup-statusline.py` writes the status line into the settings file this house's Claude Code really reads.
- Claude Code houses: a Kimi head defaults to `kimi-for-coding` with its 1M window.
- Claude Code's reminder about silent turns is off by default on both runtimes.

### Docs

- `docs/room.md` says in its first sentence that the room itself is not included.

## 1.0.1 (2026-11-13)

### Security

- The app's web framework moves to its repaired versions (`hono` 4.13.18, `@hono/node-server` 1.19.19) after six advisories for the versions before. One concerns the app as built: the default router could skip a wildcard middleware for some route sets (GHSA-h7mg-cq63-vhpq).

### App

- Messages can be kept. A long press on a message offers a bookmark; kept messages are copies in a list that belongs to the person, opened from a bookmark button in the header. The agent's tool `add_to_kept` can add a passage the person asks for and can neither read the list nor remove from it.
- Claude Code houses: when Claude Code stops and asks for permission in the terminal, the question reaches the app as a card for the whole session, with the command, the reason, the remaining time and the answers word for word. An unanswered card stays in the chat, closed.
- The message actions button takes no room and shows only on keyboard focus.

### Runtime

- Brain: a head on the plain API transport sees the house's skills as a list of names and descriptions.
- Claude Code houses: the restart notice names the real thinking level and the house's MCP servers.

### Tests

- Tests read the offline cache name and the asset stamps through one helper that knows a house suffix.

## 1.0.0 (2026-11-11)

The first public version. Before it, the same code ran for months in our own houses and in a few pilot houses, kept current by letters.

### Runtime

- Two runtimes, chosen at install time: Claude Code in a long-running session (`Claude/`), or Brain, Embervy's own runtime (`Brain/`).
- Heads: Claude on both runtimes, as Anthropic's own Claude Code on the person's plan. ChatGPT on the person's own ChatGPT plan, with OpenAI's official Sign in with ChatGPT built in as an opt-in route. Further heads under Brain, some of them beta.
- The head can be changed later without losing the house.

### Memory

- Lore, the working memory, and the archive, which keeps every session word for word. Both live in the person's own Cloudflare account.
- Cuts instead of compaction: when the context window is full, the session is archived verbatim and the next head wakes with the recent conversation.
- Nightly consolidation and a nightly reflection.

### App

- A private web app for phone and desktop with push notifications, voice notes, photos, files and a live view of what the agent is doing.
- Approval cards under Brain. On both runtimes, mail drafts in the person's name wait for an Allow card.
- A refused upload says why: too large, a type that is not allowed, or failed.

### Updates and security

- Updates as letters: only files the house has not changed itself are replaced, merges happen where possible, and every letter has a way back.
- Before every letter, the dependencies are checked against known vulnerabilities (OSV).
- Claude Code keeps its own session files for ten years instead of 30 days.

### Quickstart installer

- Servers set up by the installer install operating-system security updates on their own, without automatic restarts.
- The app password needs at least twelve characters, and the installer can suggest a random one.

### Tests

- The test suites for Brain, the app, the Claude Code scripts and the shared parts run on every push (`.github/workflows/tests.yml`).
