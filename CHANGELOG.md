# Changelog

Embervy uses [semantic versioning](https://semver.org/). The current version is in `VERSION`. Installed houses receive updates as letters, and every letter names the changes it carries.

## 1.0.0 (unreleased)

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
