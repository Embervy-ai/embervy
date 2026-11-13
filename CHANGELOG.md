# Changelog

Embervy uses [semantic versioning](https://semver.org/). The current version is in `VERSION`. Installed houses receive updates as letters, and every letter names the changes it carries.

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
