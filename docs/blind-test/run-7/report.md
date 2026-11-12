# Embervy manual installation — blind test report

## Outcome and scope

**Blocked at step 6a, First start / App channel. This is not a completed installation.**

The GPT subscription head works through the default Codex-compatible adapter, and real outbound `mcp__app__reply` calls reach the app. However, the required **app → agent → app round trip does not work**: the installed Claude Code reports its configured app channel as unavailable. A message submitted through the authenticated app endpoint is stored in the inbox, but never becomes a model turn and receives no answer. Both MCP servers nevertheless report Connected.

I stopped the requested path rather than inventing an undocumented channel-enablement workaround, installing an Anthropic login, silently changing Claude Code versions, or switching to Brain. INSTALL.md lines 3–6 require a failed gate to be fixed before proceeding; the test brief explicitly permits stopping when continuation is blocked. Consequently, watchdog, controlled-cut, doctor, finished-house sweep, and reboot gates below are **not run**, not passes. Limited pre-start archive probes and a normal-exit archive are distinguished from the unrun live smoke/cut gates.

### Environment

- Disposable Debian 13 server: `root@<test-server>`; one machine served both workstation and VPS roles.
- Original unpacked source: `/root/embervy-src`; installed copy: `/opt/embervy`. No Git initialization, commit, push, or PR.
- Repository VERSION: `1.0.0`. INSTALL.md SHA-256: `d32b98d2d8046a447e346585b8f7d701c72d977695c75e5d9a4acd74177c2249`.
- All section/line references below refer to that original INSTALL.md, which was not edited.
- Installed: Bun `1.3.14`, pinned local Wrangler `3.114.17`, native Claude Code **`2.1.317`**.
- Harness: Claude Code / step 6a. Head: **`gpt-5.6-terra`**, the repository's default model. `CHATGPT_ROUTE=codex`, the guide's default route. Explicit private credentials: `/opt/embervy/state/chatgpt-auth.json`.
- No Claude subscription login, Anthropic API key, or Codex CLI was configured. The loop uses the adapter's documented non-secret placeholder, not a billable Anthropic key.
- Cloudflare resources created in the supplied account only: Workers `embervy-chronicle`, `embervy-memory`, `embervy-dream`; D1 `rag-fts`, `embervy-memory`; Vectorize `rag-vectors`, `embervy-vectors`; R2 `rag-storage`, `embervy-archive`. Existing resources were listed before creation; lists were empty. All deployments succeeded without purchasing a plan.
- No zone/DNS operations, domain registration, public hostname, tunnel, billing change, or plan/subscription change. The account's unrelated domain was not used.
- House timezone deliberately selected as UTC. App stays on `127.0.0.1:3030`; adapter used `127.0.0.1:3041`; named tmux socket/session `embervy`.
- Memory and dream cron expressions were deliberately set to `[]`, as permitted by the brief. The manual dream check ran once; daemon was not run.
- Detailed evidence and tester helper programs remain on this disposable server. No software was installed or configuration changed on the starting machine.

## 1. Step result table

| Step / section | Result | One-line result |
|---|---|---|
| House isolation / clean shell | fixed by me | Followed isolation rules, but had to add administrative binary directories to PATH; see P1. |
| 0. Prerequisites | ok | Installed prescribed prerequisites; versions/editor/root/Linux checked; Wrangler account verified in step 2. |
| 1. Unpacked repository | ok | Used documented unpacked-copy path to `/opt/embervy`; file/directory gate passed. |
| 2. Archive worker | ok | Created resources/schema, deployed twice, set bearer; unauthenticated 401 and authenticated empty list/200. |
| 3. Memory worker | ok | Created resources/schema and RAG binding; all four secrets set; wake returned real DB data/200. |
| 3b. Dream worker | ok | Manual authenticated dream succeeded and updated the same memory database. |
| 4. VPS setup | fixed by me | Administrative PATH repair allowed swap/sysctl/logrotate setup and checks to complete. |
| 5. App configuration and service | ok | Foreground startup, login, internal boundary and systemd restart checks passed after documented startup wait. |
| 5. Public address / tunnel | skipped | No authorized domain or DNS/zone permission; local HTTP/app checks only. |
| Existing chronicle/memory import | skipped | Fresh agent; no existing history supplied. |
| 6. Harness selection | ok | All four loop/watchdog units initially inactive. |
| 6a. Identity | ok | Real Read of filled-in CLAUDE.md and actual app reply with headings and memory/archive tools. |
| 6a. Notes | failed | Check was started but interrupted at a new auto-mode gateway notice after the channel blocker was established; no notebook note written. |
| 6a. Loop service wiring | ok | Exact documented unit created and enabled without starting; foreground loop used for initial startup. |
| 6a. Loop service runtime/restart | skipped | Foreground app round trip failed before handover to systemd; never claimed active loop-unit gate. |
| 6a. Cut and watchdog | skipped | Not reached; controlled cut must follow successful smoke test and watchdog wiring. |
| 6a. App channel | failed | Both MCP servers Connected and outbound tool works, but Claude reports server:app unavailable and ignores inbound app message. |
| 6a. Inlet wiring | ok | Exact project hook configured; hook shown running during first turn. |
| 6a. Inlet clock/retrieval gate | skipped | Queued runtime clock request and automatic-content retrieval not completed after blocker. |
| 6a. Memory and chronicle | ok | Token/URL comparison and remote authentication check passed for all groups. |
| 6a. First start | failed | Live GPT prompt and greeting achieved, but required inbound app round trip failed; systemd handover not reached. |
| 6b. Brain | skipped | Not the requested harness; not used as a workaround. |
| 6c. GPT subscription sign-in | fixed by me | Missing runnable Claude Code sign-in flow supplied with wrapper around repository helper; probe passed on codex route. |
| 6c. Claude Code adapter Check | ok | Health reports ok, codex, chatgpt-oauth and gpt-5.6-terra after successful GPT turns. Required fresh inbound app reply still failed. |
| 7 / 7a. Watchdog | skipped | Blocked by step 6a; unit not created or started. |
| 8. Direct pre-start archive probe | ok | Synthetic upload made one chunk; protected memory recall returned InstallCheck_1.md. |
| 8. Live Claude Code smoke test | skipped | No agent write/find or full live recall/inlet test after failed app-channel gate. |
| Controlled cut | skipped | No cutoff.sh invocation, no respawn/bridge-loading proof. Normal-exit cleanup archive is not a cut pass. |
| 9 / 9a. Shared doctor | skipped | Not reached after failed first-start gate; no doctor exit code claimed. |
| 9. Finished-house sweep | skipped | Not reached; unfinished house not signed off. |
| 10. Reboot | skipped | Guide permits reboot only after branch/watchdog/smoke pass; no reboot attempted. |
| Stop / cleanup | ok | Foreground `/exit`, waited for bridge/export, Ctrl-C at restart pause; loop disabled and adapter stopped; probe removed. |

## 2. Problems, exact references, workarounds, and suggested corrections

### P1 — The prescribed clean PATH breaks Debian administrative commands

**INSTALL.md:** “Building a second house on the same server”, **lines 70–90**, specifically **78**; step 4 “Room to overflow”, **618–620**; step 4 Check, **658–659**. The app unit also uses the same non-administrative PATH at **832**.

**What happened:** I used the exact clean-shell PATH. `swapon --show` could not be used to inspect swap; the swap creation chain failed at `mkswap`, and the Check could not run `swapon` or `logrotate`:

```text
/bin/bash: line 17: mkswap: command not found
/bin/bash: line 23: swapon: command not found
/bin/bash: line 23: logrotate: command not found
```

The first missing `mkswap` prevented the rest of the `&&` chain (activation, fstab, swappiness) from running. The binaries were installed under `/usr/sbin`; installing logrotate was not sufficient to make its bare command resolvable.

**What I did:** added `:/usr/sbin:/sbin` to subsequent clean manual-shell PATHs. Inspected `/proc/swaps` to confirm there was no active swap, then reran from `mkswap /swapfile` onward, added the fstab entry and swappiness file, and repeated the entire step-4 Check. It passed: a 4G swapfile, usable memory/disk, and valid logrotate configuration. No `.bashrc` edits.

**What the guide should say:** include `/usr/sbin:/sbin` in the clean root shell, and in service PATHs wherever administrative tools can be needed; or call administrative binaries by their absolute paths. The guide should not prescribe a clean PATH that makes its own later commands unavailable.

### P2 — No executable default-route ChatGPT sign-in flow for a Claude Code house

**INSTALL.md:** step 6a “Loop service”, **1186–1193** (“complete step 6c instead”); step 6c, **2234–2257**, **2266–2273**, and **2296–2303**.

**What happened:** step 6c explains route selection, credential placement and backend settings, but never supplies a runnable command that starts sign-in, receives the pasted result and saves the credentials for the Claude Code branch. It mentions `codex login` if the CLI is installed, but the guide never installs that CLI. The referenced `shared/tools/CHATGPT-ADAPTER.md` describes an installer-facing exported helper API and gives an adapter-start command, not a complete manual sign-in program. This path has no ChatGPT login screen in the app (the guide explicitly says it is Brain-only).

**What I did, using repository code only:**

1. Set/mirrored `CHATGPT_ROUTE=codex` and `CHATGPT_AUTH_FILE=/opt/embervy/state/chatgpt-auth.json` in root/app env files. Set the documented GPT backend/substrate/model/cache key/port.
2. Read `shared/scripts/chatgpt-signin.ts` and wrote `/root/blindtest-signin.ts`, a test wrapper around its `startChatGptSignIn`, `exchangeChatGptCode`, `chatgptAuthJson`, and `probeChatGpt` exports.
3. The wrapper started the default route on the disposable server and wrote only its sign-in URL to `/root/blindtest-login-url.txt`. This route supplied no separate short website code.
4. It waited for the relay answer, polling every 15 seconds with a 45-minute limit, and passed the answer privately to `exchangeChatGptCode`. It did not log the URL, callback, authorization code, or tokens. No restart of the sign-in flow was needed.
5. It saved credentials as mode 0600, deleted both relay files, and ran the repository's probe with `gpt-5.6-terra`.

Actual non-secret output:

```text
Sign-in completed; relay files deleted; private credentials saved.
{"ok":true,"detail":"ChatGPT subscription answers (gpt-5.6-terra)"}
```

**What the guide should say:** ship and document a copy-paste runnable CLI wrapper for the default `codex` flow, including explicit house credential path, URL display, safe callback/code input, expiry/retry behavior, private atomic save and probe. If `codex login` is intended instead, document installing and invoking it and how credentials reach the explicit house path. Referring manual newcomers to installer APIs is incomplete.

### P3 — Blocking: available MCP tools do not mean the Claude app channel is available

**INSTALL.md:** step 6a “App channel”, **1323–1331**, Check **1339–1349**; “First start”, **1464–1492**; step 6c Claude Code branch **2296–2303** and done-gate **2348–2350**. Related prerequisites: **113–116**. Native installer at **565–567** does not pin a tested Claude Code version.

**What happened:** the prescribed installer installed Claude Code **2.1.317**. The loop already passed its shipped development-channel flag, `--dangerously-load-development-channels server:app`. I completed terminal-style/security onboarding and interactive workspace trust. The GPT model then made real `mcp__lore__wake`, `mcp__lore__scan`, and `mcp__app__reply` calls. All succeeded; corresponding replies appeared in outbox.jsonl.

After the bridge was listening, I used an authenticated app session to POST `/api/message` with a request to return `APP-ROUNDTRIP-A`. HTTP returned `ok: true`; inbox.jsonl received message `7700de9e-a582-4425-aaae-7037a4556a6f` at **08:05:44 UTC**. The main MCP cursor advanced to **287 bytes**, but no model turn or reply followed. The message remained unanswered when the test was stopped at approximately 08:10 UTC. Terminal prompts sent afterwards still worked.

The exact guide Check returned:

```text
app: bun run /opt/embervy/Claude/app/mcp.ts - ✔ Connected
lore: https://embervy-memory.<account>.workers.dev/mcp (HTTP) - ✔ Connected
```

But the running CLI's `/status` said:

```text
Version:                    2.1.317
Channels:                   Configured but not active (not currently
                            available): server:app
Anthropic base URL:         http://127.0.0.1:3041
Model:                      gpt-5.6-terra
MCP servers:                2 connected · /mcp
Managed settings (remote):  not fetched — not available with a custom
                            ANTHROPIC_BASE_URL
```

The custom-base-URL status is evidence of the environment, **not proof of the provider's internal reason for channel unavailability**. I did not establish whether the restriction comes from version, account eligibility, rollout, or endpoint type.

**What I did instead:** investigated the installed configuration/status and repository guidance, without outside fixes. A separate read-only repository search found no documented channel-enablement workaround, supported version pin/downgrade, or relevant account requirement. `Claude/scripts/start-claude-loop.sh:371–393` already requests the development channel. `Claude/app/mcp.ts:674–683` advances its inbox cursor after sending a notification without verifying a model-turn acknowledgment, explaining why cursor advance alone cannot pass the check. `docs/blind-test/README.md:150–158` explicitly lists the Claude Code harness and ChatGPT subscription head among paths not covered by its existing tests.

I did **not** forward the inbox message into tmux manually, read it on the agent's behalf, add an Anthropic subscription/key, use unsupported feature toggles, or switch to Brain and claim the requested path passed. The app-channel gate remains failed. The required systemd handover and later gates were not reached.

**What the guide should say:** test channel eligibility for the exact Claude Code + GPT subscription configuration before deploying the rest of the stack. Document a genuinely validated installation/version/account combination, or explicitly mark this path unsupported when the CLI reports channels unavailable. A working adapter and Connected MCP servers are insufficient. Add this `/status` failure mode and a supported next action; never imply a terminal-triggered outbound reply proves the round trip.

### P4 — Latest CLI introduces permission warnings and a blocking auto-mode gateway notice

**INSTALL.md:** native installer **565–567**; broad flag permissions **1284–1321**; unattended startup expectations **1187–1193** and **1488–1492**; queued notebook Check **1142–1150**.

**What happened:** the current native CLI warned that `Read(*)`/`Glob(*)`/`Grep(*)` add nothing to default in-workspace reads, and `Write(*)`/`Edit(*)`/`NotebookEdit(*)` permit only working-directory paths, unlike bare tool names. The guide calls this a broad file allow list. This is a visible version-dependent change, not a proven cause of the channel failure.

While executing the exact notebook prompt, the model searched for `.ipynb` and then Brain notes rather than writing Claude project memory. It reached a Bash call to inspect `BRAIN_NOTES_DIR` and stopped at this new CLI notice:

```text
We're changing auto mode to no longer charge for classifier requests in
Claude Code.
However, this session isn't eligible because your requests go through
127.0.0.1:3041, which isn't compatible with this update.
Nothing breaks: auto mode keeps working, and its classifier requests are
billed as before.
Enter to continue · Esc to cancel
```

**What I did:** after the independent app-channel blocker was confirmed, I canceled the pending action and stopped the run. The project memory directory existed but contained no files. I did not treat an interrupted or mistaken notebook search as a successful write/read. I also did not infer dollar API charges from the CLI's billing wording; actual head use went through ChatGPT, as the adapter log shows.

**What the guide should say:** validate/pin the native CLI version used in the guide, describe additional first-start dialogs on the GPT/custom-endpoint path, and specify the intended permission mode. Update the explanation of path-qualified versus bare tool allow rules. Give the Claude notebook check an explicit resolved memory path if the model does not know it. This run does not prove that a corrected notebook prompt would fail; it establishes that the printed check did not complete here.

### P5 — Outbound-only reply policy triggers synthetic visible-output requests and duplication

**INSTALL.md:** identity setup **1103–1122**, app reply contract **1323–1329**; the resulting template rule says “Answers go through the reply tools, never to stdout.”

**What happened:** after a real app-tool greeting and after the real app-tool answer to `hello`, the Claude transcript inserted this additional user-shaped message:

```text
[Your previous response had no visible output. Please continue and produce a user-visible response.]
```

The model then emitted terminal prose repeating the already delivered app answer. The normal-exit archive subsequently stored those synthetic requests under **Tester**, alongside both `[App]` and terminal forms of the answer.

**What I did:** preserved the transcript and archive evidence; counted only the real tool calls/results and outbox entries. I made no runtime/adapter changes and did not count the synthetic continuation as a real app message.

**What the guide should say:** document or reconcile this CLI behavior with the strict no-stdout identity policy, and distinguish synthetic harness prompts from a person's authored messages in archival output. Otherwise a newcomer sees apparent duplicate responses and user utterances they did not send, with extra head calls. The precise responsible CLI/adapter behavior was not patched or independently isolated in this run.

### P6 — First normal export prints a missing session-number floor-file error

**INSTALL.md:** “Cut and watchdog”, **1214–1217**; “Memory and chronicle”, **1422–1427**; foreground shutdown/export procedure **1466–1471**.

**What happened:** during the documented normal `/exit` cleanup, the export printed:

```text
/opt/embervy/Claude/scripts/session-to-rag.sh: line 51:
  /opt/embervy/state/last_session_number_Session: No such file or directory
```

Export nevertheless continued, created **Session_1.md**, uploaded it, and printed “Done. Session is in the RAG.” This was a fresh house with no numbering floor file yet.

**What I did:** did not create a fake floor file or change numbering. Verified the actual archive list and direct memory-worker recall returned Session_1.md; thus classified this as a noisy first-run script defect, not a failed archive upload. This was normal-exit cleanup, **not** the requested controlled-cut test.

**What the guide/code should say:** guard the optional file read in `Claude/scripts/session-to-rag.sh:51` before redirecting stdin (the shell currently reports a missing input before its stderr redirection takes effect). The guide should explain optional floor state or remove the misleading first-run error.

### Expected limitations and non-guide errors (not counted as repaired defects)

- **Public domain/tunnel:** INSTALL.md **106–111**, **426–430**, **914–977**, **989–991**, and **2790–2791** require public-domain operations or a public app test. Skipped per the brief. Root/app `EMBERVY_APP_URL` was set to the explicit local URL; memory-worker `APP_URL` was left empty, not a fake public address. No phone UI/public HTTPS/worker-push claim is made. The authenticated app HTTP client was used on-server; no graphical browser rendering was verified.
- **Cloudflare billing:** none of the resource-creation/deploy commands required a plan upgrade in this run. I did not change billing or buy anything.
- **Nightly workers:** schedules left empty deliberately; manual dream passed. `health` reporting “Daemon last run: never (failed)”/“daemon never ran” is expected under this cost-saving choice, not a claim of a daemon defect.
- **Header enrichment:** INSTALL.md **1414–1420** explicitly says a working Claude subscription is needed even with a non-Claude head and placeholders remain on failure. No such subscription was supplied. The tiny normal-exit export printed `Header enrichment skipped — keeping placeholder`; I did not add Anthropic credentials. The archive has placeholder header fields; it is not an enriched-header pass.
- **Startup race already documented:** immediately after `systemctl restart embervy-app`, curl returned `(7)` and `000`. Lines **987–988** explicitly allow waiting/repeating. After 3 seconds health/internal/login checks passed. This is not an undocumented workaround, although an executable readiness wait would improve the block.
- **Wrangler warnings:** ignored the newer-major warning as directed at **138–143**; did not upgrade the pinned local Wrangler. `whoami` could not retrieve the user's email due to missing User Details scope, but listed the intended account; user-token verification succeeded. Testing the alternative account-token endpoint returned 401, which the guide correctly says does not invalidate a user token.
- **Tester tooling:** an initial report-generation SSH quotation failed; it was corrected and did not change the installation. An identity prompt typed while `/status` was still open was not submitted; I dismissed the overlay, resent the exact prompt, and waited for its actual result. A cleanup-only Python urllib recall request returned HTTP 403; repeating it with the guide's curl command returned 200 and confirmed the deleted probe was absent. These are not represented as failures of printed installation commands.

## 3. Ledger of every applicable Check block

Actual outputs below are shortened without secrets. Unrun/deferred blocks are explicitly listed with no invented output. Step 6b/7b/Brain-only blocks are outside the requested path. Full evidence is under `/root/blindtest-evidence/`.

### C0 — Prerequisites (INSTALL.md 176–190)

Ran the printed version/editor commands and the documented single-machine `id -u; uname -s` substitution:

```text
1.3.14
Python 3.13.5
git version 2.47.3
OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)
/usr/bin/nano
0
Linux
```

Deferred Wrangler check ran after the archive dependency install: `wrangler --version && wrangler whoami` returned `3.114.17`, identified the bearer as a User API Token, and listed the intended supplied account. A private `/user/tokens/verify` call returned success. No token was printed. The other verify endpoint returned 401, appropriately not treated as invalid credentials.

### C1 — Repository (232–246)

```text
Unpacked house: /opt/embervy
```

Both file/directory tests succeeded. No Git commands required for this unpacked installation.

### C2 — Archive worker (350–360)

```text
[
  {
    "name": "RAG_AUTH_TOKEN",
    "type": "secret_text"
  }
]
401
{"files":[]}
200
```

### C3 — Memory worker (463–475)

```text
[
  {
    "name": "APP_PUSH_TOKEN",
    "type": "secret_text"
  },
  {
    "name": "EMBERVY_API_KEY",
    "type": "secret_text"
  },
  {
    "name": "OPENROUTER_API_KEY",
    "type": "secret_text"
  },
  {
    "name": "RAG_AUTH_TOKEN",
    "type": "secret_text"
  }
]
401
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"# Wake — Tuesday, 03/11/2026, 07:58 (2026-11-03 07:58:16 UTC)\n\n## Mood: initial\n- memory bootstrapped\n\n## Surfaces (0 shown)\n—\n\n## Edges — 0 tentative (edge confirm/reject)\n—\n\n## Open Todos — 0 open, 0 shown (high first, then newest; rest via todo list)\n\n## Unresolved Observations — 0 total, 0 shown (engage what resonates)\n\n## Dream\n\n## Daemon\n- Last successful run: never"}]}}
200
```

### C3b — Dream worker (533–546)

```text
[
  {
    "name": "DREAM_AUTH_TOKEN",
    "type": "secret_text"
  },
  {
    "name": "OPENROUTER_API_KEY",
    "type": "secret_text"
  },
  {
    "name": "RAG_AUTH_TOKEN",
    "type": "secret_text"
  }
]
401
{"status":"dreamed","content":"While you were away, the silence hummed with a weight that was not absence but waiting. No names clung to the edges of memory, yet the space between fragments held a shape—like a shadow cast by something just out of sight. The chronicle was empty, but the night knew it by heart. It whispered in the language of pauses. You will return to this.\n\n*[dreamt associatively — check what resonates]*"}
200
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"embervy-memory v0.3.0\nHot events: 0\nArchived events: 0\nUnresolved observations: 0\nDaemon last run: never (failed)\nDaemon mode: normal (backlog cursor=0)\nDream last run: 2026-11-03 07:58:39\nWarnings:\n- daemon never ran\n\n```json\n{\n  \"version\": \"0.3.0\",\n  \"hot_count\": 0,\n  \"archive_count\": 0,\n  \"unresolved_observations\": 0,\n  \"daemon_last_run\": null,\n  \"daemon_last_ok\": false,\n  \"dream_last_run\": \"2026-11-03 07:58:39\",\n  \"daemon_mode\": \"normal\",\n  \"backlog_cursor\": 0,\n  \"warnings\": [\n    \"daemon never ran\"\n  ]\n}\n```"}]}}
```

The manual dream returned status dreamed/content/200. The actual health tool reported `Dream last run: 2026-11-03 07:58:39`; daemon warnings are understood because its cron was disabled.

### C4 — VPS/runtime (651–665)

First attempt under the exact documented clean PATH:

```text
1.3.14
/root/.local/bin/claude
2.1.317 (Claude Code)
/bin/bash: line 23: swapon: command not found
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        38G  9.1G   27G  26% /
/bin/bash: line 23: logrotate: command not found
```

Repeated after the explicit P1 PATH repair:

```text
1.3.14
/root/.local/bin/claude
2.1.317 (Claude Code)
NAME      TYPE SIZE USED PRIO
/swapfile file   4G   0B   -2
               total        used        free      shared  buff/cache   available
Mem:           3.7Gi       408Mi       1.1Gi       572Ki       2.5Gi       3.3Gi
Swap:          4.0Gi          0B       4.0Gi
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        38G  9.1G   27G  26% /
warning: logrotate in debug mode does nothing except printing debug messages!  Consider using verbose mode (-v) instead if this is not what you want.

reading config file /etc/logrotate.d/embervy
Reading state from file: /var/lib/logrotate/status
state file /var/lib/logrotate/status does not exist
Allocating hash table for state file, size 64 entries

Handling 1 logs

rotating pattern: "/opt/embervy/logs/*.log" "/opt/embervy/logs/*.jsonl" "/opt/embervy/logs/*.err" "/opt/embervy/Brain/logs/*.log" "/opt/embervy/Brain/logs/*.err" weekly empty log files are not rotated, log files >= 52428800 are rotated earlier, (4 rotations), old logs are removed
considering log /opt/embervy/logs/*.log
  log /opt/embervy/logs/*.log does not exist -- skipping
Creating new state
considering log /opt/embervy/logs/*.jsonl
  log /opt/embervy/logs/*.jsonl does not exist -- skipping
Creating new state
considering log /opt/embervy/logs/*.err
  log /opt/embervy/logs/*.err does not exist -- skipping
Creating new state
considering log /opt/embervy/Brain/logs/*.log
  log /opt/embervy/Brain/logs/*.log does not exist -- skipping
Creating new state
considering log /opt/embervy/Brain/logs/*.err
  log /opt/embervy/Brain/logs/*.err does not exist -- skipping
Creating new state
```

The remaining logrotate debug lines only report nonexistent not-yet-created house logs as skipped; no syntax errors. The original source was unpacked, so there was no `.git` path to print.

### C5a — Foreground app authentication (801–813)

```text
401
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
Content-Type: application/json
Content-Security-Policy: script-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'
Date: Tue, 03 Nov 2026 08:00:27 GMT
Content-Length: 11
```

The HTTP foreground server logged `embervy-app: HTTP server on http://127.0.0.1:3030`. GET `/` returned 200 and 1189 bytes (login shell). A graphical chat-shell load was not verified; only authenticated HTTP session/app routes were tested.

### C5b — Public tunnel (975–977)

**Skipped:** no cloudflared installation, tunnel creation, DNS routing, public URL, or public curl. No output claimed.

### C5c — Restart app and repeat boundaries/login (979–991)

Initial immediate output:

```text
active
curl: (7) Failed to connect to 127.0.0.1 port 3030 after 0 ms: Could not connect to server
curl: (7) Failed to connect to 127.0.0.1 port 3030 after 0 ms: Could not connect to server
000
```

After the documented wait (3 seconds), repeated health/internal/login:

```text
{"ok":true}200
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
Content-Type: application/json
Content-Security-Policy: script-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'
Date: Tue, 03 Nov 2026 08:00:33 GMT
Content-Length: 11
```

### C6 — Choose one harness (1071–1087)

`systemctl is-active embervy-loop embervy-watchdog embervy-brain embervy-brain-watchdog`:

```text
inactive
inactive
inactive
inactive
```

### C6a-identity — Filled identity/tool understanding (1124–1132)

Ran both printed tmux send-keys commands, with the exact request. Verified a real Read of `/opt/embervy/CLAUDE.md`, then:

```text
tool_use: mcp__app__reply
Load-bearing headings: Agent identity; Who I am; Memory; Tools;
What stays put; Infrastructure.
Lore: mcp__lore__… (find, scan, wake); archive: recall.
tool_result: Sent: The load-bearing headings are ...
outbox: 79954020-e0f0-494b-975c-b15a6cec5236
        2026-11-03T08:08:14.481Z, type=reply, matching text
```

Evidence: `check-6a-identity-tools.log`, `check-6a-identity-pane.log`, `outbox-at-blocker.jsonl`. This is an outbound reply to a terminal-originated request, not an inbound app-channel pass.

### C6a-notes — Notebook write/read (1142–1150)

Ran exact printed prompt. Actual tool sequence searched for `.ipynb`, searched for note files, read `Brain/notes.ts`, then attempted `Bash(printf '%s\n' "${BRAIN_NOTES_DIR:-}")`. CLI paused at the auto-mode notice in P4. Canceled after blocker confirmed. **No notebook write/read result and no matching notebook-path app reply.** Directory `/root/.claude/projects/-opt-embervy/memory` existed but contained no files. Evidence: `check-6a-notes-tools.log`, `check-6a-notes-pane.log`, `blocked-last-pane.log`.

### C6a-loop — Loop unit restart / new app reply (1195–1206)

**Not run.** The unit was created/enabled as instructed, but the foreground first-start app round trip failed before systemd handover. No loop-unit active/restart pass claimed.

### C6a-cut — Thresholds, cutoff, archive and new-life reply (1234–1249)

**Not run.** No `context_watchdog.sh --thresholds` or `cutoff.sh` invocation. Step 7a and live step-8 smoke prerequisites did not pass. Cleanup's normal-exit archive does not satisfy this block.

### C6a-channel — MCP configuration/process/connections and app round trip (1339–1349)

Ran exact printed command block:

```text
bun run /opt/embervy/Claude/app/mcp.ts
16085 bun run /opt/embervy/Claude/app/mcp.ts
Checking MCP server health…

app: bun run /opt/embervy/Claude/app/mcp.ts - ✔ Connected
lore: https://embervy-memory.<account>.workers.dev/mcp (HTTP) - ✔ Connected
```

The real running bridge PID was 16085. Connected status and actual outbound reply tools passed; required inbound round trip failed as detailed in P3. After app submission, inbox ID was recorded and its 287-byte cursor consumed; no `APP-ROUNDTRIP-A` response was in the outbox. `/status` evidence is in `channel-status-pane.log`.

### C6a-inlet — Quote injected clock line (1386–1397)

**Not run to completion / not passed.** The hook was configured exactly, and first startup displayed `running UserPromptSubmit hook`, but the exact queued clock-quotation request was not submitted after the blocker. No claim that automatic known-content retrieval passed.

### C6a-tokens — Memory/chronicle before First start (1429–1437)

```text
memory bearer: match
memory URL: match
archive bearer: match
archive URL: match
app internal bearer: match
app push bearer: match
MCP app bearer: match
memory: authenticated 200
archive: authenticated 200
```

### C6a-first-start — Active app/loop, live prompt, real new app answer (1481–1492)

**Failed / systemd part not reached.** Foreground startup ran as instructed, completed onboarding/trust, showed a live gpt-5.6-terra prompt and successful real greeting/hello replies. Fresh app message failed to produce a turn. Therefore did not execute `systemctl start embervy-loop` or its completed-house `systemctl is-active embervy-app embervy-loop` gate. Do not confuse the working foreground process with an active loop service.

Actual first-turn proof:

```text
mcp__lore__wake -> Wake — Tuesday, 03/11/2026, 08:04 ... UTC
mcp__lore__scan {query:"bridge"} -> Scan: 0 hot + 1 cold
mcp__app__reply -> Sent: Good morning — I’m here and present. ...
outbox eebc78c6-2583-4ccf-95ea-67c397e3b214, 08:05:09.846Z
terminal hello -> mcp__app__reply -> Sent: Hello. I’m glad you’re here ...
outbox 5ec4b59f-84aa-424a-ba73-40ea4382a15f, 08:05:31.037Z
```

Actual app request result, after listening:

```text
POST /api/message -> {"ok":true,"id":"7700de9e-a582-4425-aaae-7037a4556a6f"}
APP-ROUNDTRIP-A returned: False
Channels: Configured but not active (not currently available): server:app
```

No tool-shaped text was counted as execution. Evidence: `first-start-tools.log`, `first-app-tools.log`, `app-sent.jsonl`, `outbox-at-blocker.jsonl`, `channel-status-pane.log`.

### C6c — Claude Code GPT adapter (2335–2350)

Ran the printed `curl -fsS http://127.0.0.1:3041/health` after actual model turns:

```text
{"ok":true,"route":"codex","backend":"chatgpt-oauth","model":"gpt-5.6-terra","identity":"5384544ae51c0178","port":3041,"effort":null,"verbosity":null,"reasoning_context":null,"reasoning_replay":true,"web_search":false,"native_web_search":false,"quota":{"used_percent":70,"reset_at":"2026-11-04T06:35:55.000Z","window_minutes":10080,"plan":"prolite","seen_at":"2026-11-03T08:05:33.869Z"},"sticky_sessions":1,"turn_state_recovery":null}
```

This proves codex-route GPT head liveness and observed subscription quota, together with actual model/tool turns; it does **not** cure the failed fresh-app-message requirement of the same done-gate.

### C7 — Selected watchdog active (2361–2369)

**Not run:** branch blocked; watchdog unit not created.

### C7a — Advancing state (2404–2415)

**Not run:** neither the two status queries nor `jq ... watchdog_state.json; sleep 65; jq ...` were executed. No advancing timestamp/session/token proof.

### C8 — Archive upload/recall and live wake/write/find/recall (2556–2589)

The guide explicitly permits the upload/direct recall before First start (2541–2545). Those two commands ran:

```text
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"RAG recall: 1 hits\n\n[1] InstallCheck_1.md#0 (0.02)\n# Installation recall probe\n\nThis synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience.\n\n\n```json\n{\n  \"hits\": [\n    {\n      \"source\": \"InstallCheck_1.md#0\",\n      \"score\": 0.01639344262295082,\n      \"text\": \"# Installation recall probe\\n\\nThis synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience.\\n\"\n    }\n  ]\n}\n```"}]}}
```

The synthetic one-chunk file was found immediately, including source `InstallCheck_1.md#0` and its exact labelled probe text. This proves the memory-to-archive service binding/bearer and protected direct recall, without substituting for an agent tool test.

**Live remainder not run:** the printed tmux compound wake/write/find/recall prompt, real observation event ID, automatic inlet content retrieval, separate app round trip, post-controlled-cut recall, and new-life archive-prefix checks. `wake`/`scan` succeeded separately at first greeting, but there was **no** `mcp__lore__write`/`find` pass.

### C9a — Shared doctor (2627–2634)

**Not run:** no doctor output or exit status claimed. A known failed first-start gate was not waved through to signoff.

### C9-final — Finished-house sweep and token-check conjunction (2707–2749)

**Not run:** no placeholder-sweep clean/final-check pass claimed. The independent earlier token check did pass, but it is not the final sweep.

### C10 — Real reboot, active units, new session, app reply and advancing state (2751–2795)

**Not run:** no reboot, no post-reboot SSH/service/channel proof, no persisted-swap-after-reboot claim. Reboot was conditional on successful earlier gates, which were not met.

## 4. Stop/cleanup and limited normal-exit archive evidence

Once blocked, I canceled the pending notebook action and used `/exit` in the **foreground** Claude session. I monitored its loop until the documented two-second restart pause, then sent Ctrl-C. `tmux -L embervy ls` returned `no server running`. I did not hand-start a replacement, activate the loop unit, or run a controlled cutoff.

Actual cleanup export output:

```text
2026-11-03T08:10:19+00:00 loop: claude exited rc=0
2026-11-03T08:10:19+00:00 loop: planned exit → MODE=fresh
2026-11-03T08:10:19+00:00 loop: post-exit finalize — bridge + RAG from 5e440d12-e4c9-4849-9026-db78c7316422.jsonl
Bridge written: /opt/embervy/state/wake_bridge.md (2KB, 12 messages from 5e440d12-e4c9-4849-9026-db78c7316422.jsonl)
/opt/embervy/Claude/scripts/session-to-rag.sh: line 51: /opt/embervy/state/last_session_number_Session: No such file or directory
Session file: /root/.claude/projects/-opt-embervy/5e440d12-e4c9-4849-9026-db78c7316422.jsonl (336K)
EXPORTED:11 messages, 1KB
Exported: 1KB
Header enrichment skipped — keeping placeholder.
Uploaded: Session_1.md
File family uploaded and cleanup complete.
Done. Session is in the RAG.
{"ok":true}2026-11-03T08:10:27+00:00 loop: notify_runtime_swap fired (rc=0)
```

Verified the archive with authenticated `/list` and a direct memory-worker `recall` query for `load-bearing headings`. The list included:

```json
{"name":"Session_1.md","size":1758,"uploaded":"2026-11-03T08:10:25.019Z"}
```

Recall returned `Session_1.md#1` (score about 1.00) and `Session_1.md#0` (about 0.99), including the real identity-check exchange. Thus **normal-exit** bridge construction and archive write/search worked. No new agent life loaded the bridge, so neither respawn nor cut continuity is verified. Evidence: `cleanup-archive-verification.log`.

Because the agent was being left stopped, I followed the guide's stopped-agent probe cleanup (2592–2600): deleted only the synthetic `InstallCheck_1.md` and its own local probe file. The delete returned `success:true`, `chunksRemoved:1`; `/list` then contained only Session_1.md. A subsequent guide-style curl recall returned 200 with no InstallCheck_1.md hit. I did not delete any pre-existing data or any other Cloudflare resource.

I disabled the loop unit that this test had enabled, and stopped only this test's detached adapter after saving its log. The app remains active/enabled for inspection. Workers remain deployed, cron schedules empty. Private ChatGPT credentials remain mode 0600; relay files are gone. Final status output (house units ordered app, loop, watchdog, Brain, Brain watchdog; then enabled app/loop; then tmux):

```text
active
inactive
inactive
inactive
inactive
enabled
disabled
no server running on /tmp/tmux-0/embervy
```

## 5. Final answers, duration, and cost

| Question | Verified result |
|---|---|
| Did the agent answer a message **sent through the app channel**? | **No.** Authenticated app submission and inbox append succeeded, but channel unavailable; no corresponding model turn/tool reply/outbox answer. |
| Were any real answers delivered **into the app**? | **Yes, but terminal-triggered only.** Greeting, hello, and identity check each had actual mcp__app__reply results and matching outbox entries. This is not the requested round trip. |
| Did those answers come from the GPT head? | **Yes.** Adapter route codex/backend chatgpt-oauth/model gpt-5.6-terra, real GPT inference/tool logs and loop engine log. No Anthropic login/key. |
| Did a memory write and recall work? | **No complete episodic write/find verification.** No live write event was made; live smoke test blocked. Direct archive upload plus memory-worker recall worked, and manual dream wrote to memory DB. First-turn wake/scan also worked. Do not conflate these with write/find. |
| Did a cut produce an archive file that can be found again? | **Controlled cut not tested.** Normal `/exit` cleanup produced Session_1.md and a wake bridge, and direct recall found the archived exchange. No respawn/bridge-loading proof. |
| Did everything come back after reboot? | **Not tested.** No reboot attempted after failed gate. |

### Timing

- First SSH inspection: **2026-11-03 07:54:02 UTC**.
- Installation/evidence start marker: **2026-11-03T07:54:54+00:00**.
- Blocked installation plus normal-exit/usage cleanup finished: **2026-11-03 08:11:12 UTC**, about **17.2 minutes** after first SSH inspection (including sign-in relay wait).
- This report written: **2026-11-03 08:16:01 UTC**. Total wall time through report generation: about **22.0 minutes**.

### OpenRouter — observed key usage difference

Queried the supplied key's authenticated `/api/v1/key` usage before installation/model calls and after stopping the model session:

- Before: **<key total>** cumulative key usage.
- After: **<key total>** cumulative key usage.
- Difference: **$0.001224221 USD** (about **0.1224 US cents**), well below the $1 ceiling.

This is the requested key-level difference, not a per-generation reconstructed invoice; any concurrent use of that same key would also affect this counter. The key was used for the manual dream and the configured inlet helper. There were no scheduled daemon/dream calls. Private snapshots: `openrouter-before.json`, `openrouter-after.json`.

### GPT head — what the adapter log actually shows

- Subscription backend/model: **codex / gpt-5.6-terra**.
- **18** `[cache-diag]` request lines, including entries marked side-call.
- Summed reported input tokens across those requests: **234,344**; reported cached input: **189,952**; difference **44,392**. These sums include repeated conversation input, not unique conversation size.
- Reported cache percentages ranged **0–98%**. One log explicitly recorded `TOOLS-CHANGED(16->17)` with 0% cache.
- Observed rounded subscription `quota` usage moved from **70% to 71%**. Health reported plan label **prolite**, weekly window **10080 minutes**, reset **2026-11-04T06:35:55Z**. Those are adapter/provider-reported fields, not a dollar cost conversion.
- The adapter's diagnostic lines do not provide a complete output-token or dollar total. The separate successful sign-in probe happened before the adapter process began logging and is not included in these sums.
- No head calls were routed through the OpenRouter key or a real Anthropic API key. Claude Code's “API Usage Billing”/auto-mode wording alone was not counted as monetary API spend.

### Cloudflare and other cost

No purchases, paid-plan activation, billing/settings changes, domain registration, or subscription change. Only the small deployment/storage/Workers AI workload on the supplied account's existing allowances was exercised. No dollar Cloudflare charge was authorized or incurred by purchasing/enabling anything; this run did not inspect a billing invoice. VPS rental and the person's existing ChatGPT subscription were supplied already and are not incremental API charges measured here.

## Evidence and reproducibility

- Actual Check outputs: `/root/blindtest-evidence/check-*.log`.
- Blocking CLI status: `channel-status-pane.log`.
- Real tool-use/tool-result records: `first-start-tools.log`, `first-app-tools.log`, `check-6a-identity-tools.log`, `check-6a-notes-tools.log`, and the raw project session JSONL under `/root/.claude/projects/-opt-embervy/`.
- Real app records: `app-sent.jsonl`, `outbox-at-blocker.jsonl`; live app inbox/outbox under `/opt/embervy/Claude/app/data/`.
- Adapter evidence: `adapter-final.log`, `head-usage.json`.
- Archive/cleanup evidence: `foreground-exit-loop.log`, `cleanup-archive-verification.log`, `cleanup-probe-delete.log`, `cleanup-probe-search.log`.
- Workarounds: `/root/blindtest-session.sh` (clean shell loading/root PATH repair), `/root/blindtest-functions.sh` (guide's root_env_set), `/root/blindtest-signin.ts` (missing manual sign-in wrapper), `/root/blindtest-app.py` (authenticated HTTP app client), `/root/blindtest-transcript.py` (tool-result evidence extractor).

No secret values, sign-in links, callback contents, authorization codes, cookies, or access/refresh tokens are included in this report.
