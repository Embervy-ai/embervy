# Embervy manual-install blind test — final report

**Date:** 2026-11-03. **Target:** disposable Debian 13 server `<test-server>`, root over SSH. **Source:** `/root/embervy-src`; installed house: `/opt/embervy`. **Selected path:** 6a, Claude Code on the supplied Claude subscription.

## Verdict and scope

**The tested local Claude Code house works, including a real reboot.** App messages received real `mcp__app__reply` results and matching outbox entries; memory write/find and archive recall worked; a controlled cut produced `Session_3.md`, which the next life recalled. All selected services returned automatically after reboot. The shared doctor returned `PASS`, exit 0.

This is **not a public HTTPS/phone/PWA pass**. The domain was out of scope and the token had no zone/DNS permission. No public hostname, DNS record, route or tunnel was created. App interaction used genuine password authentication and the shipped frontend's HTTP routes on localhost, not a browser-rendered UI. The public-app part of the reboot instructions is explicitly skipped, not silently replaced and claimed as verified.

Three guide/documentation issues remain: the first watchdog Check can read a nonexistent state file; current Claude Code warns that several permission rules are narrower than the guide's broad-permissions description; and the generated handbook inaccurately describes startup-dialog automation. No repository runtime code was patched to make the test pass.

## 1. Step results

“fixed by me” below includes an additional wait/recheck not explained for that particular first-start state file. Documented startup retries are marked `ok`, with their initial errors preserved below.

| Step | Result | One-line result |
|---|---|---|
| 0 — prerequisites/account | ok | Bun 1.3.14 and required tools installed on target; intended Cloudflare account verified. |
| 1 — house | ok | Used the documented unpacked-source path; copied to `/opt/embervy`, without inventing a Git checkout. |
| 2 — chronicle/RAG | ok | D1, Vectorize and R2 created; schema/deploy passed; protected list returned 401/200 correctly. |
| 3 — memory | ok | Memory worker and RAG service binding deployed; authenticated wake worked against the bound DB. |
| 3 — scheduled daemon | skipped | `crons = []` deliberately retained with user permission to save cost. |
| 3b — dream | ok | Manual authenticated dream returned nonempty content and updated memory's Dream last run. |
| 3b — scheduled dream | skipped | `crons = []` deliberately retained; scheduled execution is not verified. |
| 4 — host runtime | ok | Native Claude 2.1.317, 4 GiB persistent swap, 2 GiB reserve and documented logging/update policy installed. |
| 5 — local app | ok | Foreground and systemd authentication/health checks passed; documented startup retry was needed once. |
| 5 — public tunnel/hostname | skipped | No zone/DNS permission; unrelated domain not touched; no public HTTPS/PWA claim. |
| 6 — branch selection | ok | All four agent/watchdog units initially inactive; only Claude Code branch was subsequently started. |
| 6a — subscription/wiring | ok | Relay sign-in completed; identity, notebook, app/Lore MCP, inlet and all queued checks worked. |
| 6a — First start/handover | ok | Automatic greeting and app reply passed; foreground exported, stopped in documented window, then systemd created its own server. |
| 6a — controlled cut | ok | `Bridge OK`, `Export OK`, clean termination, new life, archive recall and app reply verified. |
| 6b — Brain | skipped | Unselected harness; no Brain units were installed or started. |
| 6c — ChatGPT subscription | skipped | No ChatGPT subscription; no setup attempted. |
| 7/7a — watchdog | fixed by me | First jq found no state file; after initial cycle, repeated successful snapshots proved timestamp/token/session advancement. |
| 8 — smoke/retrieval | ok | Real wake/write/find/recall results, automatic inlet attachment, separate app message and probe cleanup verified. |
| 9a — doctor | ok | `PASS (23 checks passed, 0 warn, 0 fail, 2 skip)`, exit 0, including native Claude canary. |
| 9 — finished-house sweep | ok | Placeholders clean; seven token/URL comparisons matched; memory/archive authenticated 200. |
| 10 — real reboot/local house | ok | Changed boot ID; all selected units active, greeting/app reply/memory/clock cadence/watchdog returned without manual service help. |
| 10 — public-app roundtrip | skipped | Password-authenticated localhost roundtrip passed; public hostname unavailable under the task restrictions. |

## 2. Problems, exact locations, workarounds and suggested corrections

Line references below are to the unchanged `/root/embervy-src/INSTALL.md` used in this run. Source package version: `1.0.0`; no Git revision is available for this unpacked source. INSTALL SHA-256: `8bd7c69f2003ad9032d5ebff8ef8b0fd342cc2e98b30e590ec8c2b086d299e4c`.

### P1. First watchdog Check assumes the state file already exists

- **Location:** §7a, `INSTALL.md:2439–2453`, especially jq at **2446** immediately after enabling the unit.
- **Command:** `systemctl enable --now embervy-watchdog`, then the documented service query and `jq '{last_check_ts,session_file,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/state/watchdog_state.json"`.
- **Observed:** three seconds after enabling, service was `active`, but jq printed `Could not open file /opt/embervy/state/watchdog_state.json: No such file or directory`. The second reading after the documented 65-second sleep existed. The overall block exited 0 because its final jq succeeded; that did **not** prove two advancing readings.
- **What I did instead:** waited for initialization and reran two successful snapshots, with a real intervening model turn. At 13:09:56.886 → 13:10:59.818 UTC, tokens advanced 50,427 → 51,305 for the same live session. Repeated after cut and reboot; did not change thresholds or scripts.
- **Why the guide was incomplete:** it mentions waiting longer for configured intervals above 60 seconds, but not waiting for the first state file/current-session observation at the default interval. A stale previous session was also briefly visible until the next poll after restart/reboot; I did not count it as a pass.
- **Proposed correction:** before taking snapshot A, boundedly wait until the file exists and identifies the live main session; then take A, wait longer than the configured interval, take B, and explicitly fail on missing/nonadvancing/current-session mismatch. Preserve the initial jq failure even if a later command succeeds.

### P2. The permission example emits scope warnings on the installed native CLI

- **Location:** §6a “App channel”, broad-permissions explanation `INSTALL.md:1288–1291` and example **1298–1312**.
- **Command/configuration:** launch the loop with the exact documented `state/claude-settings.json`, including `Read(*)`, `Write(*)`, `Edit(*)`, `Glob(*)`, `Grep(*)`, `NotebookEdit(*)`.
- **Observed:** Claude Code 2.1.317 warned, for example: `Allow rule "Write(*)" lets Write run without asking only in the working directories. "Write" alone allows every path.` Read/Glob/Grep warnings said their `(*)` rules add nothing beyond the default working-directory access. Similar warnings appeared for Edit/NotebookEdit.
- **What I did instead:** nothing; retained the exact guide example. The actual outside-house project-notebook write/read still succeeded under this session's automatic mode, and the app/Lore tools worked. This was a compatibility/scope warning, **not** an observed notebook failure.
- **Proposed correction:** test the permission example against the supported current CLI. If all-path access is intended, document/use the current bare tool-name form, with its security implications. If working-directory scope is intended, say so and document the notebook/additional-directory scope explicitly. Do not describe the wildcard form as unconditionally broad across versions.

### P3. Generated handbook says the loop blindly confirms permission questions; implementation does not

- **Location:** §6a “First start”, generation commands `INSTALL.md:1465` and **1516**. Output `/opt/embervy/HANDBOOK.md:14`.
- **Command:** `bun "$EMBERVY_HOME/shared/tools/house-docs.ts" --home "$EMBERVY_HOME" --write`.
- **Observed output text:** “For the first four minutes after each start, the loop presses Enter in your session to get past Claude Code's start dialogs. A permission question that appears in that time is answered with yes.”
- **Contradictory repository evidence:** `Claude/scripts/start-claude-loop.sh:419–430` polls for **180 seconds**, with the comment “Only the explicit development choice is safe to automate; other setup needs a user.” `Claude/scripts/loop-dialog.sh:28–54` sends keys only for the recognized development-channel selection, and leaves unrelated/first-start dialogs alone.
- **What I did instead:** completed sign-in/workspace trust myself as prescribed; did not depend on nonexistent blanket confirmation. Left generated prose unchanged for test fidelity. This did not block installation.
- **Proposed correction:** fix the house-doc generator/template so the handbook accurately says only the explicit development-channel option is automated; first-start/trust/permission questions require the person, and the poller timeout is 180 seconds. Add a generated-prose regression check. This is a generated-house-document defect, not a failed `--write` invocation.

### P4. App restart Check raced the listening socket — already covered by the guide

- **Location:** §5, `INSTALL.md:979–985`.
- **Command:** `systemctl restart embervy-app && systemctl is-active embervy-app`, followed immediately by `/health` and authenticated `/api/internal/model` curl checks.
- **Observed:** `active`; both immediate curls printed `curl: (7) Failed to connect to 127.0.0.1 port 3030 ...`; model check printed `000`; block exit 7.
- **Action:** used the guide's explicit startup wait/retry at 984–985. Repeated HTTP checks after startup: `{"ok":true}`, model HTTP `200`, password login `HTTP/1.1 200 OK` with a redacted session cookie.
- **Correction:** no missing recovery instruction; optionally make the example readiness-aware to avoid a misleading first failure. This is not an undisclosed repair.

### P5. Loop restart Check raced creation of the named tmux server — already covered

- **Location:** §6a “Loop service”, `INSTALL.md:1197–1204`.
- **Command:** `systemctl restart embervy-loop; systemctl is-active embervy-loop; tmux -L embervy capture-pane -p -t embervy -S -80`.
- **Observed:** `active`, then `no server running on /tmp/tmux-0/embervy` on the immediate capture.
- **Action:** waited 25 seconds and repeated as instructed; live CLI and greeting returned, and A3 got a real app reply. Previous life had exported as `Session_2.md`.
- **Correction:** no missing recovery instruction; optionally poll for the pane/channel before capture. Separately, `tmux ... ls` returning exit 1/no server after intentionally stopping the foreground loop was the **expected** handover check, not a failure.

### P6. Restricted public-app coverage is an environmental skip, not a guide failure

- **Location:** §5 public tunnel `INSTALL.md:972–974`, restart/public-login expectation **986–988**, and §10 public message **2841–2843**.
- **Command:** zone/DNS/hostname-dependent commands were **not run**. No cloudflared install, route, tunnel or service was created.
- **Alternative:** read `Claude/app/README.md` and the shipped frontend/server; used `POST /api/auth` with `APP_PASSWORD`, its actual cookie, `POST /api/message`, and the real inbox/outbox/tool results. Retrieved the authenticated chat shell: HTTP 200, 13,572 bytes. No internal-bearer broadcast shortcut or forged inbox/outbox writes.
- **What remains unverified:** browser rendering, phone/PWA, HTTPS Secure-cookie behavior in a browser, DNS and public ingress. The local HTTP helper explicitly returns the login cookie; it does not prove browser acceptance of a Secure cookie over plain HTTP.
- **Suggested clarification:** an explicit local-only branch/coverage statement would help restricted tests; retain the public gate for production sign-off. The task, not repository knowledge, authorized this test limitation.

### Other warnings and operator errors — not attributed to INSTALL

1. **§0 Cloudflare account verification (`INSTALL.md:173–188`):** the supplied user-owned token verified active at `/user/tokens/verify`; a supplemental request to `/accounts/{CLOUDFLARE_ACCOUNT_ID}/tokens/verify` returned HTTP 401. I used the correct token-type verification and the repository's pinned `wrangler whoami`/actual operations. `whoami` listed the intended account but warned it could not retrieve email without User Details:Read. No extra permission was requested; resource operations succeeded. Suggested clarification, if desired: distinguish user-owned versus account-owned token verification and optional email metadata permission.
2. **Pinned Wrangler:** repeated out-of-date warnings from 3.114.17 were retained, not “fixed” by upgrading. `INSTALL.md:135–137` explicitly permits ignoring those warnings. D1 migration availability warnings were informational; all schema/deploy operations succeeded.
3. **Fresh/disabled daemon:** dream health printed `Daemon last run: never (failed)` and `daemon never ran`. Daemon schedules were intentionally empty with user permission. Manual dream succeeded; periodic daemon processing is **not tested**. The later doctor correctly treated a young daemon as not due yet.
4. **Logrotate/apt:** debug mode's “does nothing except printing debug messages” and nonexistent-yet log skips were expected. The initial logrotate state file did not yet exist. No rotation/config failure occurred; apt's CLI-stability warnings were informational.
5. **Initial operator quoting mistake:** an early SSH command embedded a Python triple-quoted string inside nested shell quoting; it produced `SyntaxError: unterminated triple-quoted string literal` and missing-command/path errors before proper execution. This was not an INSTALL command defect. I switched to `ssh root@<test-server> 'bash -s' <<'REMOTE'` and remote heredocs/runner thereafter. No software was installed on the starting machine and no intended starting-machine file modification occurred. The shell tried to interpret stray text locally; its attempted `/root` paths were inaccessible/nonexistent. This accident is disclosed rather than claiming every attempted token executed remotely.
6. **Login relay helper:** the CLI wrapped its OAuth URL across tmux lines; my first extractor stopped too early, and an assertion assumed the older `claude.ai` hostname while this CLI used `claude.com`. I joined the wrapped URL and checked HTTPS/required parameters without displaying them. The actual prescribed URL/code relay then succeeded, after 425 seconds of 15-second polling. No alternative auth mechanism, token printing, local credential reuse or API key was used. Both relay files were deleted.
7. **Supplemental ghost-search helper:** Python `urllib.request` to the worker `/mcp` returned HTTP 403. I repeated the **documented curl request** unchanged instead; it returned valid recall sources and no `InstallCheck_1.md` source. The cause of Python's 403 was not established; it is not evidence that the guide's curl or the agent's MCP is broken. The original helper traceback remains in evidence.
8. **Reboot reconnect:** the first `ssh -o ConnectTimeout=10 root@<test-server>` after a 25-second wait timed out (exit 255). Waiting another 35 seconds and reconnecting succeeded. No service was manually started. This is boot/SSH readiness, not a failed persistent service gate.
9. **Evidence helpers:** corrected an overbroad redactor that hid numerical `*_TOKENS` thresholds and an inspector that initially double-counted tool IDs also serialized in API-request blobs. Final assertions use native assistant/user tool results, deduplicate IDs, and match actual outbox entries. These fixes changed test evidence handling, not the installation. Real thresholds remained 800000/900000 throughout.

## 3. Ledger of every applicable Check block

All outputs below are actual shortened excerpts, with credentials omitted. Full timestamped redacted scripts, outputs and return codes are in `/root/blindtest-evidence/commands.jsonl`. Checks queued until First start were executed only after wiring, one request at a time. Inactive-unit queries and the expected absent foreground tmux server can return nonzero without constituting failure. A runner/block exit 0 does not erase an earlier subcommand error.

### C01 — §0 prerequisites, INSTALL:173–188 — ok

```text
1.3.14
Python 3.13.5
git version 2.47.3
OpenSSL 3.5.7 9 Jun 2026
/usr/bin/nano
0
Linux
user token verification: True active
```

Used the explicitly allowed single-server `id -u; uname -s` replacement. Pinned local `wrangler whoami` ran after step 2 dependencies were available, listed the intended account/account ID, and gave the optional-email warning described above. Initial D1, Vectorize, R2 and Worker inventories were empty; the supplied unrelated domain was not queried or touched. Evidence: `step0-check`, `step2-install-and-list`.

### C02 — §1 house, INSTALL:229–241 — ok

```text
Unpacked house: /opt/embervy
```

`INSTALL.md` and `shared` existed. Git-only checks were correctly inapplicable to this unpacked copy. Evidence: `step1-copy-and-check`.

### C03 — §2 archive, INSTALL:347–357 — ok

```text
secret name: RAG_AUTH_TOKEN
401
{"files":[]}
200
```

Protected list was empty on the new deployment, not an auth error. Evidence: `step2-schema-deploy-check`.

### C04 — §3 memory, INSTALL:460–472 — ok

```text
secret names: APP_PUSH_TOKEN, EMBERVY_API_KEY, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
401
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"# Wake — Tuesday, 03/11/2026, 12:44 ... UTC ..."}]}}
200
```

Real wake content, not only public health, proved the bound DB. Evidence: `step3-deploy-and-check`.

### C05 — §3b dream, INSTALL:530–543 — ok

```text
secret names: DREAM_AUTH_TOKEN, EMBERVY_API_KEY, OPENROUTER_API_KEY
401
{"status":"dreamed","content":"While you were away, the silence hummed..."}
200
embervy-memory v0.3.0
Dream last run: 2026-11-03 12:45:42
Daemon last run: never (failed)
Warnings:
- daemon never ran
```

The full returned dream was nonempty. Manual dream wrote to the same memory DB. Cron/daemon limitation explained above. Evidence: `step3b-deploy-and-check`.

### C06 — §4 host, INSTALL:648–662 — ok

```text
1.3.14
/root/.local/bin/claude
2.1.317 (Claude Code)
/swapfile file 4G 0B -2
Mem: 3.7Gi total, 3.3Gi available
Swap: 4.0Gi total, 0B used
/dev/sda1 38G 9.1G 27G 26% /
reading config file /etc/logrotate.d/embervy
Handling 1 logs
... log ... does not exist -- skipping
```

House existence check passed; Git path output was inapplicable. Logrotate debug returned no configuration error. Swap was rechecked after reboot. Evidence: `step4-check`.

### C07 — §5 foreground auth/chat shell, INSTALL:798–810 — ok, local HTTP only

```text
401
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
Authenticated chat shell: 200 13572 bytes
```

The earlier 1,189-byte fetch was the unauthenticated login shell, **not** a chat-shell pass. The later authenticated shell and actual message roundtrips are the relevant proof. No browser/PWA rendering claim. Evidence: `step5-foreground-check`, `step5-authenticated-shell`.

### C08 — §5 named/public tunnel, INSTALL:972–974 — skipped

No command/output: forbidden zone/public-hostname work under the task restrictions. No tunnel unit exists. This skip does not prevent the separate local app Check.

### C09 — §5 restart boundary, INSTALL:976–988 — ok after documented retry

```text
First attempt:
active
curl: (7) Failed to connect to 127.0.0.1 port 3030 ...
000
EXIT 7
Retry after startup:
active
{"ok":true}200
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; ...
```

Public HTTPS portion skipped. Evidence: `step5-systemd-and-restart-check`, `step5-restart-check-retry`.

### C10 — §6 harness selection, INSTALL:1068–1080 — ok

```text
inactive
inactive
inactive
inactive
EXIT 4
```

Exit 4 is expected for new/inactive units. Evidence: `step6-branch-check`.

### C11 — §6a Identity, INSTALL:1123–1129 — ok with loaded-file distinction

Actual app reply excerpt:

```text
CLAUDE.md — load-bearing headings
Memory
Tools
What stays put
Infrastructure
... Who I am is still empty.
Lore: mcp__lore__... at https://embervy-memory.<account>.workers.dev
Archive: recall at https://embervy-chronicle.<account>.workers.dev
```

Tool/outbox proof, not terminal-only prose. The agent explicitly said it used the identity already loaded into context, not a fresh disk reread; I do not claim a Read-tool execution for this check. Outbox `0dad9929-b3f2-4531-8855-eb3a4898b90b`. Evidence: `step6a-identity-check`.

### C12 — §6a Notes, INSTALL:1143–1148 — ok

```text
Write: /root/.claude/projects/-opt-embervy/memory/installation-notebook-check.md
File created successfully ...
[actual shell read-back contained the installation note]
Write: /root/.claude/projects/-opt-embervy/memory/MEMORY.md
Sent: I saved the note in my project notebook and read it back, and it's there.
```

The note stayed in the Claude project notebook, not Lore. Outbox `4fd0045f-7e53-4077-a892-74b561b49764`. Evidence: `step6a-notes-check`.

### C13 — §6a Loop service, INSTALL:1197–1204 — ok after documented wait

```text
active
no server running on /tmp/tmux-0/embervy
[25 seconds later: live Claude prompt and greeting]
Sent: APP-ROUNDTRIP-A3
```

Real reply outbox `79a0beb0-df8b-4cfa-b681-b36d84709f87`, correlated to inbox `02c745ea-5bcf-40a1-a802-df02aa6be1f8`. Evidence: `step6a-loop-restart-check`.

### C14 — §6a Cut/watchdog, INSTALL:1238–1253 — ok

```text
800000 900000
Bridge written: /opt/embervy/state/wake_bridge.md (4KB, 15 messages ...)
Bridge OK
EXPORTED:10 messages, 3KB
Header enriched.
Uploaded: Session_3.md
Export OK
SIGTERM -> pid=16775
Clean exit after 2s
Respawn delegated to start-claude-loop.sh / systemd.
```

Archive list included `Session_1.md`, `Session_2.md`, `Session_3.md` (4,273 bytes), plus the then-not-yet-deleted probe. Loop log: `starting claude (mode=fresh iter=1)`, `using bridge (4886 bytes)`, `birth prompt sent`. The next life really called `mcp__lore__recall` for `APP-ROUNDTRIP-A4`:

```text
RAG recall: 4 hits
[1] Session_3.md#4 (0.97)
... [App] APP-ROUNDTRIP-A4 ...
Sent: APP-ROUNDTRIP-A5 ...
```

Outbox `37f595c6-67d2-4344-b024-4a6619a8ec7a`, correlated with fresh app inbox. Bridge was appended using `--append-system-prompt-file`; no invented Brain-style `bridge_loaded` event was required on this branch. Evidence: `step6a-controlled-cut`, `post-cut-archive-recall`.

### C15 — §6a App channel, INSTALL:1343–1356 — ok

```text
bun run /opt/embervy/Claude/app/mcp.ts
16849 bun run /opt/embervy/Claude/app/mcp.ts
app: ... - ✔ Connected
lore: https://embervy-memory.<account>.workers.dev/mcp (HTTP) - ✔ Connected
/status:
Version: 2.1.317
Session kind: interactive
Channels: Listening for messages from server:app
Login method: Claude Max account
Model: Default (Opus 5.5 ...)
MCP servers: 2 connected
Setting sources: Shared project settings, Command line arguments
```

Account email/organization omitted. Real A1–A6 tool replies/outboxes prove permissions and bearer delivery beyond MCP-list connectivity. Evidence: `step6a-app-channel-check` and app-roundtrip records.

### C16 — §6a Inlet clock, INSTALL:1392–1397 — ok

```text
Sent: The first clock line from the inlet this session:
⏰ UTC (test house): Tuesday, 2026-11-03, 13:02
```

Verified directly in the native `hook_additional_context` attachment at `2026-11-03T13:02:04.141Z`, hook name/event `UserPromptSubmit`, not a clock quoted inside retrieved text. Outbox `cfe3c98d-0775-4d44-90ca-7029da6e4473`. Evidence: `step6a-inlet-clock-check`, `step6a-inlet-direct-evidence`.

### C17 — §6a Memory/chronicle prestart, INSTALL:1438–1446 — ok

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

Executed before First start, not inferred from secret names. Evidence: `step6a-wire-identity-loop-mcp-hook`.

### C18 — §6a First start, INSTALL:1499–1516 — ok

```text
active
active
[live Claude Code prompt, no pending sign-in/permission dialog]
Sent: Hello, Tester. I've just woken up in this house for the first time...
Sent: APP-ROUNDTRIP-A1
```

Foreground first greeting outbox `82811be7-2c21-4999-a9e6-b66fbe0e92f5`; A1 outbox `105cbff0-2b65-4c91-acbf-39392b187f9d` matched inbox `ab1c9691-8c27-4f3c-a81a-89389c6cae2c`. At idle I used `/exit`, waited for `exported; press Ctrl-C within 15 seconds to stop here, otherwise a new life starts`, then Ctrl-C. Export uploaded `Session_1.md`. `tmux -L embervy ls` returned no server/exit 1 as expected. Systemd then created its own server, greeted and replied `APP-ROUNDTRIP-A2` (outbox `48c7fac2-2157-4894-ab5e-047dab820774`). No detached foreground server was passed off as systemd-owned. Final post-watchdog house-doc refresh succeeded, retaining agent-owned CAPABILITIES. Evidence: first-start/first-greeting/first-app/service-app records and `step6a-final-doc-refresh-and-budget`.

### C19 — §7 matching watchdog unit, INSTALL:2399–2407 — ok

```text
active
```

Ran the Claude Code query `systemctl is-active embervy-watchdog`, not the Brain query. Evidence: `step7a-install-and-check`.

### C20 — §7a advancing state, INSTALL:2442–2453 — fixed by me, then verified

```text
active
active
First reading: jq ... No such file or directory
After initial cycle:
last_check_ts: 2026-11-03T13:04:40.898Z
tokens: 42383
warn_tokens: 800000
cut_tokens: 900000
```

Repeated successful pair with a new model turn:

```text
2026-11-03T13:09:56.886Z  35b2fd56-...jsonl  50427  800000 900000
2026-11-03T13:10:59.818Z  35b2fd56-...jsonl  51305  800000 900000
```

After cut, state changed to `e640e5cb-0841-4f07-b8c9-b8322a28e129.jsonl`; after reboot, a fresh current-session successful advancing pair is recorded in C24. Evidence: `step7a-install-and-check`, `step7a-advancing-state-and-step8-inlet`, post-cut and post-reboot records. See P1; service-active alone was never counted as sufficient.

### C21 — §8 smoke test, INSTALL:2594–2639 — ok

The upload/direct recall portion was first run prestart as explicitly permitted at 2579–2583, then repeated with the live harness idle. Actual results:

```text
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
# Wake — Tuesday, 03/11/2026, 13:05 (2026-11-03 13:05:14 UTC)
Wrote event 1 (kind=observation, weight=light, embedded=1)
Found 1 events:
[1] ... Synthetic installation observation: cobalt lantern memory check. Installation test data, not an experience.
RAG recall: 7 hits
[1] InstallCheck_1.md#0 (1.00)
# Installation recall probe
... cobalt lantern recall check ... It is test data, not an experience.
Sent: [wake/write/find/recall report]
```

These are matched real `mcp__lore__wake`, `write`, `find`, `recall` tool results, followed by app reply outbox `7736458d-d557-499f-902d-354b60ea3522`. A separate password-authenticated app message A4 got `APP-ROUNDTRIP-A4`, outbox `7f4fab15-7b64-4739-aab3-2539c59ddca5`, correlated to inbox `ea2b1401-4715-48c4-a309-ac4c1d106bc1`.

**Automatic inlet retrieval:** native `hook_additional_context` at `2026-11-03T13:05:09.839Z` contained:

```text
## Chronicle (RAG)
[InstallCheck_1.md] (100% [vector+bm25+rerank])
# Installation recall probe
... cobalt lantern recall check ...
```

The later A4 turn carried no new excerpt; its agent answer said so. I count the earlier actual native attachment as the retrieval pass, not that later answer. No relevance threshold was lowered. The initial single-candidate direct recall used an expected raw RRF score; after more archives existed it reranked normally. Inlet logs also correctly suppressed weak/irrelevant hits on other prompts.

After the explicit and automatic passes and the archived-life recall, deleted only our probe:

```text
{"success":true,"deleted":"InstallCheck_1.md","chunksRemoved":1}
/list: Session_1.md, Session_2.md, Session_3.md (no InstallCheck_1.md)
Post-delete recall sources: Session_3.md#3, Session_3.md#4, ... Session_1.md#0
Synthetic source absent; legitimate session quotations remain.
```

Removed local `state/install-recall-probe.md` too. Quoted probe text in real archived test conversations was not mistaken for a deletion ghost or deleted. Synthetic memory event 1 remains deliberately labelled as test data and was found after reboot. Evidence: `step8-prestart-static-probe`, `step8-smoke-check`, `step7a-advancing-state-and-step8-inlet`, cleanup/ghost-check records.

### C22 — §9a shared doctor, INSTALL:2666–2673 — ok

Command: `cd "$EMBERVY_HOME" && bun shared/tools/embervy-doctor.ts; printf 'doctor exit=%s\n' "$?"`.

```text
[OK]   RAG_AUTH_TOKEN valid — ... 3 files indexed
[OK]   Memory daemon and dream — daemon: never — not due yet; dream: successful run within 26 hours
[OK]   Memory worker rejects unauth — unauth → HTTP 401
[OK]   RAG rejects unauth — unauth → HTTP 401
[OK]   Hybrid search — mode=hybrid, counts: vector 2, bm25 11
[OK]   FTS5 (BM25) ready — 11 BM25 hits
[OK]   Reranker active — top source: [bm25, rerank]
[OK]   Inlet returns context — 2756 bytes, retrieved hit found
[OK]   Claude headless canary — claude -p answered on build 2.1.317 (Claude Code)
[OK]   House MCP servers — 2/2 connected (house configuration)
[OK]   UserPromptSubmit inlet hook wired — registered in /opt/embervy/.claude/settings.json
Result: PASS (23 checks passed, 0 warn, 0 fail, 2 skip)
doctor exit=0
```

Two understood skips: sign-in-for-another-head check (this house thinks with Claude, canary covers its sign-in); optional hearing service unset. This was a real content-dependent retrieval pass, not `HEALTHY — NEWBORN` or skipped header checks. Other identity/capability/disk/swap/writable-state/security checks also passed. No Brain preflight was substituted. Evidence: `step8-probe-cleanup-and-step9a-doctor`.

### C23 — shared finished-house sweep, INSTALL:2746–2800 — ok

Executed the exact source block, with **only** the instructed actual-unit substitution:
`HOUSE_UNITS='embervy-app.service embervy-loop.service embervy-watchdog.service'`.

```text
placeholder sweep: clean
memory bearer: match
memory URL: match
archive bearer: match
archive URL: match
app internal bearer: match
app push bearer: match
MCP app bearer: match
memory: authenticated 200
archive: authenticated 200
final check: pass
```

No live template markers were waived or credentials printed. Unused Brain/tunnel units were not invented. Evidence: `step9-finished-house-sweep`.

### C24 — §10 real reboot, INSTALL:2824–2849 — local house ok; public part skipped

```text
Reboot requested 2026-11-03T13:15:27Z
Boot ID before: 88b74d32-6797-4ccb-807e-8046e19cc268
Boot ID after:  be1dd597-a4d4-4431-9a0b-d63734d9f9ef
active
active
active
{"ok":true}
[live new Claude session, no login/permission prompt]
/swapfile file 4G 0B -2
inactive
inactive
```

The last two are the unused Brain pair. No manual service start/restart was used after reboot. The first SSH timeout is disclosed above. New main session: `73b57e8b-a0b8-4331-889f-df3ae5abcd3c.jsonl`.

Greeting: actual `mcp__app__reply` tool `toolu_01JSuvmoNvHLRSorrTHdMjb8` succeeded; matching outbox `18244b3f-851e-43fb-a481-8debb7bb1abb` at 13:16:34.530 UTC contained `Hi Tester, I'm back after the cut and ready when you are.` Fresh localhost app A6 used password login 200/message POST 200; real find returned event 1, and actual reply tool `toolu_01GMDJnsiuGDBocLAbNKSteZ` produced outbox `a46cc86b-5806-4bf4-a04e-13c9d5e4e250` with `APP-ROUNDTRIP-A6`, correlated to inbox `f8198db4-48e7-4394-ae5d-dd8299af3765`.

Sent one real app message per subsequent hook turn, waiting for each actual outbox/tool reply; did not forge hook events or alter the counter. Counter advanced 2 → 11. Direct native attachment clocks (not retrieved quotes):

```text
turn 1  2026-11-03T13:16:28.225Z  ⏰ UTC (test house): Tuesday, 2026-11-03, 13:16
turn 6  2026-11-03T13:19:07.919Z  ⏰ UTC (test house): Tuesday, 2026-11-03, 13:19
turn 11 2026-11-03T13:19:57.941Z  ⏰ UTC (test house): Tuesday, 2026-11-03, 13:19
```

All nine cadence-test app replies had native successful tool results and actual matching outbox entries. Advancing watchdog snapshots in this same current session:

```text
2026-11-03T13:19:27.902Z  73b57e8b-...jsonl  45814  800000 900000
2026-11-03T13:20:31.727Z  73b57e8b-...jsonl  47999  800000 900000
```

Evidence: `step10-real-reboot`, `step10-post-reboot-check`, `step10-post-reboot-app-and-watchdog`, `step10-clock-cadence-and-advancing-state`. **Public** app access in 2842 remains skipped by scope; these local checks do not prove a tunnel.

### Excluded Check blocks, explicitly accounted for

Brain checks at 1690, 1727, 1834, 1879, 2002, 2047, 2112, 2225, 2521 and 2708, plus the Brain reboot alternative at 2832–2838, were unselected and skipped. The ChatGPT-subscription check at 2373 was skipped because no subscription exists. These are not missing Claude Code results. The generic §7 and shared §9 finished-house checks **were** run, as recorded above.

## 4. What was actually configured and left running

- Only the remote disposable server was provisioned. The unpacked source was kept unchanged; substitutions/editor-equivalent changes were made in the installed copy. No outside installation advice or source patch was used to repair runtime behavior.
- Root/app env, MCP and service settings were made consistent using the repository's env-file-as-data helpers, with tracing off. No `source .env`. Secret files/private evidence use mode 600/700 as appropriate. No bearer, password, sign-in code or OAuth URL is included in this report.
- Bun **1.3.14**; lockfile-pinned Wrangler **3.114.17**; native Claude Code **2.1.317**; sign-in **Claude Max**; selected default head **Opus 5.5**, with no API key/model override.
- Remote sign-in ran inside tmux, URL alone in the requested relay file, code checked every 15 seconds, entered privately after 425 seconds; both relay files deleted. No Anthropic API key or ChatGPT setup.
- Cloudflare workers: `embervy-chronicle.<account>.workers.dev`, `embervy-memory.<account>.workers.dev`, `embervy-dream.<account>.workers.dev`. Used only the supplied account.
- Created our own D1 databases `rag-fts`, `embervy-memory`; Vectorize indexes `rag-vectors`, `embervy-vectors` (1024 dimensions/cosine); R2 buckets `rag-storage`, `embervy-archive`; the three workers and their required secrets/service bindings. Initial inventories were empty; no preexisting resource/domain was deleted or modified.
- Memory and dream cron schedules stay empty. Memory worker public-app push URL stays empty because there is no public app hostname. Optional hearing/mail/shared-room/browser modules were not configured; unused identity instructions were removed rather than left pointing at placeholders.
- App binds only `127.0.0.1:3030`; no tunnel service. Enabled/active selected units: `embervy-app.service`, `embervy-loop.service`, `embervy-watchdog.service`. House tmux socket/session: `embervy`/`embervy`; operator tmux used a separate socket. Foreground handover was completed before systemd ownership.
- Current thresholds: warn **800000**, cut **900000**; no auto-compaction; no periodic cache ping. No threshold/relevance-floor lowering to force green tests.
- 4 GiB swap persisted through reboot; 2 GiB reserve, swappiness 10, documented unattended upgrades, journal cap and house-specific logrotate installed. Existing policy was inspected before edits; no automatic-reboot override was added.
- Archive finally lists `Session_1.md` (734 bytes), `Session_2.md` (4,109), `Session_3.md` (4,273), `Session_4.md` (1,599). The reboot shutdown also cleanly exported Session_4. Synthetic standalone probe was deleted; labelled memory event 1, notebook note, genuine test conversations and evidence remain.
- Final service health: all three selected units `active`; app `{"ok":true}`; `systemctl --failed --no-legend` printed no failed units. Agent was idle at the prompt; left running. Generated-handbook discrepancy P3 was **not** silently edited away.

## 5. End-to-end conclusions, time and cost

| Required question | Observed answer |
|---|---|
| Did the agent answer a message through the app channel? | **Yes.** Genuine password-authenticated frontend routes → real inbox → native successful `mcp__app__reply` → correlated actual outbox, before and after reboot. Browser/public HTTPS remains unverified. |
| Did memory write and recall work? | **Yes.** Observation 1 was actually written/embedded, found immediately, after cut, and after reboot. Project-notebook write/read also passed. Archive recall returned the synthetic probe and later actual cut-life content. |
| Did a cut produce an archive file that could be found again? | **Yes.** Controlled cut uploaded `Session_3.md`; `/list` showed it, and the next life recalled `Session_3.md#4`, including `APP-ROUNDTRIP-A4`. Bridge append and fresh-life greeting were separately verified. |
| Did everything come back after a real reboot? | **Yes for the configured local house.** Different boot ID; app/loop/watchdog automatic, real greeting and fresh app reply, persistent event/swap, fresh advancing watchdog state and direct clocks on 1/6/11. No manual service recovery. No public tunnel was configured or tested. |

### Timing

- First remote evidence/install start: **2026-11-03T12:41:19.151027+00:00**.
- Final report generation: **2026-11-03T13:27:38.706466+00:00**.
- Remote measured run including sign-in wait, checks, retries, cut, reboot and report preparation: **46 minutes 19.6 seconds**.
- Full task wall time from the original request at 12:40:14.493 UTC (including initial reading/preparation): **47 minutes 24.2 seconds**.
- Relay wait within that time: **425 seconds**. Reboot request: 13:15:27 UTC; first recovered greeting: 13:16:34.530 UTC.

### OpenRouter: actual supplied-key usage difference

```text
before: $<key total>
after:  $<key total>
delta:  $0.006442619000 USD
```

**Under the $1 ceiling** (approximately 0.6443 US cents).

This is the key-wide before/after usage delta, not a per-request attribution guarantee if another user of the same key exists. No further model calls were intentionally scheduled after the final sample; cron schedules/cache ping remain disabled. Private full responses are `openrouter-before.json` and `openrouter-after.json` in the evidence directory.

### Claude subscription head usage

The CLI `/status` confirmed a Claude Max subscription. The post-reboot current-session `/cost` panel actually displayed:

```text
Total cost: $0.4362
Total duration (API): 56s
Total duration (wall): 5m 20s
claude-opus-5-5: 58 input, 2.3k output, 1.1m cache read, 20.5k cache write ($0.4359)
claude-haiku-5-5: 1.2k input, 259 output, 0 cache read, 0 cache write ($0.0003)
Prompt cache (main): 26 requests · 98% of input tokens from cache · no misses
```

**These are the CLI's API-equivalent estimates, not an additional API charge and not the cost of all lives.** No Anthropic API key was configured. Internal auxiliary Haiku usage shown by the CLI is distinguished from the Opus head.

Across **5 persisted interactive project sessions**, deduplicating **66 native assistant message IDs** globally and taking the maximum reported counter per ID to avoid duplicate streaming blocks:

| Recorded Opus head counter | Tokens |
|---|---:|
| Uncached input | 156 |
| Output | 8,815 |
| Cache-creation input | 93,980 |
| Cache-read input | 2,753,320 |
| Sum of these recorded categories | 2,856,271 |

These are recorded usage counters, not unique-context size or a subscription invoice. Cached input counts repeated reads across requests. They exclude unpersisted doctor-canary calls and auxiliary model usage not present in native main transcripts. The doctor canary really passed, but its usage is not invented or included in these persisted-session totals. Final watchdog **current-context** count was **47,999**, a different metric, with 800000/900000 thresholds.

### Cloudflare, host and total monetary interpretation

- **Cloudflare purchases/paid changes: $0 authorized or performed.** No domain registration, plan/subscription change, billing-setting operation or Workers Paid upgrade was attempted. Default/free-account resource deployments and tested requests succeeded without a paid-plan gate. This statement is not an independently audited Cloudflare invoice; included-quota consumption was not priced or inferred.
- Existing server and Claude subscription were supplied. Their prorated cost was not available and is not fabricated. Operator/outer-session model charges are not exposed by this house and are not added to its usage.
- The measured incremental supplied OpenRouter-key usage above is the only directly measured pay-per-use monetary delta. The CLI's $0.4362 is a current-life estimate, **not** added to that delta as cash spent.

## Evidence and reproducibility

- `/root/blindtest-evidence/commands.jsonl`: timestamped, redacted remote scripts, combined outputs and recorded return codes; contains initial failures/retries as well as passes. The helper process itself can return 0 after logging a failing shell; inspect each record's `returncode` and subcommand output.
- `/root/blindtest-evidence/started.txt`, `source-version.txt`, `boot-id-before.txt`, `head-usage.json`, private OpenRouter before/after JSON, and authenticated/unauthenticated shell captures.
- `/root/blindtest-run.py`: clean-shell runner. `/root/blindtest-app.py`: genuine password-authenticated app HTTP helper. `/root/blindtest-inspect.py`: transcript/outbox inspector. These are test instrumentation, not repository repairs.
- `/root/.claude/projects/-opt-embervy/*.jsonl`: native house transcripts. Only actual assistant `tool_use` plus user `tool_result` pairs, not repeated API-request serialization blobs or tool-looking prose, count as executions.
- `/opt/embervy/Claude/app/data/inbox.jsonl` and `outbox.jsonl`: actual app messages. No test script appended fake entries.
- `/opt/embervy/logs/claude-loop.log`, inlet/watchdog logs and `state/watchdog_state.json`: lifecycle, retrieval and current-session evidence.

**Final qualification:** the repository successfully installed the selected subscription-backed local house. Public ingress and periodic daemon/dream behavior remain intentionally untested. P1–P3 are actionable documentation/compatibility findings; already-documented startup races and operator mistakes are disclosed separately rather than misclassified as broken installation steps.
