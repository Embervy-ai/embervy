# Embervy manual-install blind test — Claude Code subscription path

**Test date:** 2026-11-03.  
**Server:** disposable Debian 13, `root@<test-server>`.  
**Guide tested:** `/root/embervy-src/INSTALL.md`, installed unchanged at `/opt/embervy/INSTALL.md`. All guide line numbers below refer to that copy.  
**House:** `EMBERVY_HOME=/opt/embervy`.  
**Report written:** 2026-11-03T10:34:14+00:00.

## 1. Verdict

**The house is operational, including a real subscription-backed Claude head, authenticated app replies, working memory, automatic inlet retrieval, archive export/rediscovery, and automatic recovery after a real reboot. This was not a clean, literal all-checks-pass installation.**

The main reproducible guide problems are:

1. The finished-house sweep rejects seven legitimate lines produced or explicitly retained by the guide itself. Its **unmodified result remains `final check: FAIL`, exit 1**. A separately saved, narrowly reviewed version passes; the original failure is not erased.
2. The foreground-to-systemd handoff requires catching an unannounced two-second restart pause, while bridge/export progress is in a log the guide does not identify there. My first attempt missed that window and the loop respawned.
3. The inlet clock cadence is persistent and house-wide, not reset for each new session/reboot. The new reboot session initially received no current clock; a timestamp quoted inside retrieved archive material did not count. Further real prompts reached turn 26 and delivered the current configured UTC clock.

There are also smaller documentation/CLI-version mismatches and one terminal-submission timing workaround, detailed in section 4. Two initial app-check failures were my test-environment/startup timing issues, not undisclosed guide defects.

**Public-app ingress, DNS, zone operations, custom hostname, browser rendering, phone/PWA behavior, and public HTTPS cookie behavior were not tested.** The account's existing unrelated domain was not touched. Worker `workers.dev` endpoints were exercised; no custom app hostname or tunnel was created.

## 2. Scope, method, and resulting installation

- All installation commands, test instrumentation, services, files, and model calls ran on the disposable server or the supplied Cloudflare account. I did not install software or intentionally edit files on the starting machine.
- I followed steps 0–10 on the **6a Claude Code** branch. Brain/other-head branches were not selected. The other harness stayed inactive.
- I used the unpacked-repository option; no Git initialization, commit, PR, or push was needed.
- Shell work used clean environments and the repository's `shared/scripts/env-file.sh` to read env files as data. I did not execute `.env` contents as shell code.
- Login ran interactively in tmux on the server. The complete login URL was written alone to the prescribed relay file; the code file was polled every 15 seconds, the received code was entered into the waiting CLI, and both relay files were deleted. No code/token is reproduced here. No Anthropic API key or ChatGPT subscription was configured.
- CLI `/status` confirmed **Claude Max**, default **Opus 5.5**, app channel listening, and two MCP servers connected. Account-identifying details are omitted.
- The app test used password-authenticated HTTP requests matching the repository frontend: `/api/auth`, `/api/message`, and `/api/messages`. I checked actual app history/outbox entries and actual Claude JSONL `tool_use`/`tool_result` pairs. I did not write fake inbox/outbox entries or count prose resembling tool calls. This verifies the real app server/channel, not browser UI rendering.
- Root and app env files and private Claude configuration were populated, with secrets generated/mirrored privately. Root/app env files are mode 0600. Token/URL consistency and authenticated worker access passed repeatedly.
- I chose **UTC intentionally** for this test house, consistently across the house, inlet label, memory, and dream configuration. UTC in the clock results is therefore the configured local zone, not an accidentally retained placeholder.
- Memory daemon and dream cron lists are deliberately **empty**, as authorized to save cost. The dream worker was invoked manually once and its health timestamp verified. The memory daemon was not exercised; its `daemon never ran` warning is real and expected here.
- Runtime/service source and `INSTALL.md` were not patched to hide failures. Generated house docs and identity were configured as instructed. Test-only helpers and evidence are under `/root/blindtest-*` and `/root/blindtest-evidence/`.

### Installed versions

| Component | Observed version |
|---|---|
| OS | Debian 13, Linux |
| Bun | 1.3.14 |
| Python | 3.13.5 |
| Git | 2.47.3 |
| OpenSSL | 3.5.7, 9 Jun 2026 |
| Wrangler | Locally pinned 3.114.17; upgrade warnings not followed |
| Claude Code | Native installer yielded 2.1.317 |
| Actual recorded main-head model | `claude-opus-5-5` |

### Resources and durability created

- Chronicle worker `embervy-chronicle`: R2 `rag-storage`, D1 `rag-fts` with FTS schema, 1024-dimension cosine Vectorize `rag-vectors`, Workers AI binding.
- Memory worker `embervy-memory`: D1 schema, R2 `embervy-archive`, 1024-dimension cosine Vectorize `embervy-vectors`, chronicle service binding, four required secret names.
- Dream worker `embervy-dream`: shared memory D1 and chronicle binding, three required secret names, no scheduled cron.
- Bun app on `127.0.0.1:3030`; no public tunnel service.
- Enabled services: `embervy-app.service`, `embervy-loop.service`, `embervy-watchdog.service`. All three returned automatically after reboot.
- Claude app stdio MCP, memory/Lore HTTP MCP, project UserPromptSubmit inlet, named `embervy` tmux socket/session, private settings with `project,local` sources, generated house docs.
- Persistent 4 GiB `/swapfile`, swappiness 10, 2 GiB reserve ballast, journald cap, guide logrotate configuration, unattended upgrades. Existing identical unattended-upgrade settings were inspected and retained rather than needlessly replaced.
- `EMBERVY_CACHE_PING=0`; no optional recurring model work was enabled to run up costs.

## 3. Step-by-step result table

`fixed by me` means an explicitly recorded operator/test-procedure workaround, not an unreported source-code repair. A failed literal gate is still identified as failed.

| Step | Status | One-line result |
|---|---|---|
| 0 — prerequisites | ok | Required tools/root/Linux checked; intended Cloudflare account verified once local Wrangler existed. |
| 1 — house directory | ok | Supported unpacked source installed at `/opt/embervy`. |
| 2 — chronicle | ok | Resources/schema/deploy/secrets worked; unauthenticated 401 and authenticated empty list 200. |
| 3 — memory | ok | Resources/schema/service binding worked; real authenticated MCP wake; daemon schedule intentionally empty. |
| 3b — dream | ok | Separate deployment, unauthorized 401, manual dream 200 and health timestamp; schedule intentionally empty. |
| 4 — runtime and durability | ok | Bun/native Claude/swap/logrotate/disk checks passed and swap survived reboot. |
| 5 — app | ok | Loopback auth, health, restart, chat shell and real message path passed after recorded retries; public ingress excluded. |
| 5 — tunnel/public hostname | skipped | Required zone/public app hostname path prohibited by the supplied account restrictions. |
| 6 — harness exclusivity | ok | Brain/other competing services inactive; Claude Code selected. |
| 6a — Claude subscription head | fixed by me | Login, identity, notebook, app MCP and token checks passed; handoff and terminal submission needed recorded timing workarounds. |
| 6b / alternative heads | skipped | Not the requested head; no ChatGPT/API-key alternative was set up. |
| 7 / 7a — watchdog | ok | Active, timestamps advanced, fresh-turn tokens changed, new session tracked after cut and reboot. |
| 8 — smoke and controlled cut | ok | Real Lore write/find, explicit and automatic archive retrieval, app reply, cut/export/respawn/rediscovery, probe cleanup. |
| 9 / 9a — doctor and final sweep | failed | Doctor passed; literal sweep falsely rejected valid markup and remains exit 1; separate reviewed sweep passed. |
| 10 — actual reboot | fixed by me | All three services/app/head recovered unaided; clock check needed extra real prompts because cadence survives reboot; public-app portion skipped. |

No failure prevented continuing at all: the sweep's hits were inspectable false positives, and the reboot clock eventually arrived without service repair or counter manipulation.

## 4. Problems, exact locations, workarounds, and proposed guide changes

### P1. Finished-house sweep rejects its own legitimate Markdown — definite check defect

**Guide:** step 9, finished-house sweep, `INSTALL.md:2729–2771`, especially regex **2746**, exit/gate **2758–2763**, expected result/review instruction **2766–2769**.

**Command:** the exact Python sweep and token-check block was saved as `/root/blindtest-evidence/finished-sweep.sh` and run with only this house's actual three units, as the guide instructs. The broad `<[^>\n]+>` alternative matches ordinary HTML comments and parameter notation.

**Actual output:**

```text
/opt/embervy/CLAUDE.md:14: review template marker
/opt/embervy/CLAUDE.md:15: review template marker
/opt/embervy/INFRASTRUCTURE.md:33: review template marker
/opt/embervy/HANDBOOK.md:27: review template marker
/opt/embervy/HANDBOOK.md:79: review template marker
/opt/embervy/HANDBOOK.md:105: review template marker
/opt/embervy/HANDBOOK.md:116: review template marker
placeholder sweep: review required
... all seven token/URL comparisons match ...
memory: authenticated 200
archive: authenticated 200
final check: FAIL
finished sweep exit=1
```

These were not unfilled operational secrets or URLs:

| File:line | Legitimate retained/generated content |
|---|---|
| `CLAUDE.md:14` | `<!-- identity -->` |
| `CLAUDE.md:15` | `<!-- /identity -->` |
| `INFRASTRUCTURE.md:33` | `WATCHDOG_WARN_TOKENS_<ENGINE>` / `WATCHDOG_CUT_TOKENS_<ENGINE>` notation |
| `HANDBOOK.md:27` | `mcp__lore__<name>` notation |
| `HANDBOOK.md:79` | `<Prefix>_<N>.md` notation |
| `HANDBOOK.md:105` | `<path>.embervy-merged`, `<path>.embervy-new`, `<path>.embervy-base`, `update.sh take <path>` |
| `HANDBOOK.md:116` | `journalctl -u <service>` |

The guide explicitly asks a newborn's identity block to stay empty; the other lines come from its own house-docs generator.

**Workaround:** I inspected all seven lines, did not mutilate the house docs, and saved a **separate test-only** `/root/blindtest-evidence/finished-sweep-reviewed.sh`. It exempts exactly the seven reviewed file/line/content combinations, still checks everything else, and runs the same token/authentication checks. It prints each reviewed exception and passes exit 0. The original script/log is retained unchanged and still fails.

**Proposed correction:** distinguish recognized Markdown comments/parameter notation from actual installation placeholders; add a documented narrow reviewed-exception mechanism, with changed/new content still failing. Do not promise that reviewing a hit alone changes the current script's exit status, and do not recommend deleting valid identity markers. Add a regression test using freshly generated house docs and an empty newborn identity.

**Evidence:** `check-9-sweep-first.log`, `finished-sweep.sh`, `finished-sweep-reviewed.sh`, `check-9-sweep-reviewed.log`.

### P2. Foreground-to-systemd handoff has an undocumented, very short stop window

**Guide:** 6a, **First start**, `INSTALL.md:1467–1478`, particularly **1469–1472**.

**Commands/action:** start the foreground loop as line 1460, send CLI `/exit`, wait for bridge/export, then Ctrl-C at the restart pause before `systemctl start embervy-loop`.

**Observed failure/ambiguity:** bridge/export progress appeared in `logs/claude-loop.log`, not as a clear foreground countdown. The loop's only pause is `sleep 2` at `Claude/scripts/start-claude-loop.sh:495`, after `notify_runtime_swap` at 493. My first inspection missed it:

```text
09:59:39 loop: claude exited rc=0
09:59:39 loop: post-exit finalize — bridge + RAG ...
Uploaded: Session_1.md
Done. Session is in the RAG.
09:59:53 loop: notify_runtime_swap fired (rc=0)
09:59:55 loop: starting claude (mode=fresh iter=1)
```

**Workaround:** waited for that new short life to become idle, sent `/exit` again, polled newly appended `claude-loop.log` every 0.1 second, and sent Ctrl-C when `notify_runtime_swap fired` appeared, inside the two-second window. `tmux -L embervy ls` then reported no server/session. Only then did I start the systemd loop. I did not kill an active agent or change loop source.

**Proposed correction:** identify the exact progress log and provide a reliable safe stop/handoff procedure, or make the pause explicit and long enough for a careful human. A newcomer should not have to infer a log marker or catch a silent two-second race.

**Evidence:** `step6a-foreground-handoff.log`, `check-6a-firststart.log`, first-start app evidence.

### P3. Clock is on a persistent house-wide cadence, not necessarily the first turn of a new life

**Guide:** 6a inlet clock check, `INSTALL.md:1389–1400`, especially **1396–1399**; reboot acceptance **2811–2817**, especially **2815**.

**Commands:** the guide's `tmux ... -l 'Quote the first clock line supplied by the inlet ...'` followed by Enter; after reboot, a real app request and further console prompt submissions through the same live CLI. No direct hook invocation was substituted for a user turn.

**Observed:** the original pre-reboot life supplied `⏰ UTC: Tuesday, 2026-11-03, 10:01`, so the initial clock check passed. The new reboot life initially supplied no current ambient clock:

```text
10:19 app reply: reboot app channel verified
I can't quote an inlet clock line: none has arrived in this new session...
10:20 app reply: No clock yet. ... its hook brought only archive excerpts.
10:22:58 app reply: None. This prompt came with no direct inlet clock line.
10:23:12 app reply: ⏰ UTC: Tuesday, 2026-11-03, 10:23
```

**Cause verified in repository source:** `Claude/scripts/inlet.sh:51,55–59` reads/increments persistent `state/inlet-turn-counter`. Line 101 emits a clock when `TURN % 5 == 1` or calendar output is present. This counter is not keyed/reset by session ID. Calendar was deliberately off. With counter 24, the next prompt was 25 with no clock; prompt 26 supplied the clock. Reboot does not reset this file.

**Important evidence distinction:** current-session hook context at `10:19:02.098Z` began `## Chronicle (RAG)` and included an **old 10:01 clock quoted in archive material**. That is not a newly injected current clock. Another hook at `10:20:47.322Z` also began with retrieval only. The hook at **10:23:09.778Z** contained a direct leading `⏰ UTC: Tuesday, 2026-11-03, 10:23`, followed by the real app reply. I checked the actual current-session attachment, not merely a configuration file or any occurrence of the clock symbol.

**Workaround:** bounded further real prompt submissions until the next normal due turn. I did not reset the counter, fake time, enable calendar to force a clock, manually run the hook, or repair any service. UTC was explicitly intended for this house.

**Proposed correction:** say that native Claude's counter is persistent across lives, list turns 1,6,11,..., and permit up to five genuine prompt hooks to observe the first direct clock when no other session advances it. Explicitly exclude archive-quoted clocks. Alternatively implement a session-scoped first-clock guarantee and test reboot/new-life behavior. The present text is too easy to read as a guarantee for each fresh session.

**Evidence:** `check-6a-clock-outbox.jsonl`, `check-10-postreboot-app.log`, `check-10-clock-retry.log`, `check-10-clock-cadence-1-outbox.jsonl`, `check-10-clock-cadence-2-outbox.jsonl`, `check-10-direct-clock-contexts.json`, current session `14bbe460-0fde-4983-ad88-76299723f211.jsonl`.

### P4. Back-to-back tmux text/Enter submission was timing-sensitive

**Guide:** 6a identity check, `INSTALL.md:1123–1131`, commands **1126–1127**; same submission pattern recurs in queued checks.

**Command pattern:**

```sh
tmux -L embervy send-keys -t embervy -l 'Read CLAUDE.md. ...'
tmux -L embervy send-keys -t embervy Enter
```

**Observed:** after dismissing `/status`, the immediate command pair left the prompt visibly buffered in the input area. There was no model turn or outbox reply during a 240-second wait. Another Enter submitted it and a real app reply followed.

**Workaround:** confirmed the text was unsent rather than blindly repeating it, sent one extra Enter, and thereafter used a 0.5-second pause between literal text and Enter in the remote console test helper.

**Proposed correction:** mention UI-settling/submission verification, particularly after menus, and a short inter-command pause or controlled retry only if input remains buffered. This is an observed terminal automation issue, not proof that every immediate pair fails, and not evidence of a broken app channel.

**Evidence:** working notes, actual identity outbox, `/root/blindtest-console.py`.

### P5. Latest native Claude emits scope warnings for the supplied permission examples

**Guide:** 6a private settings, `INSTALL.md:1294–1311`, especially **1300–1303**. The native installer was not version-pinned and installed Claude Code 2.1.317.

**Commands:** create the guide's exact `state/claude-settings.json` and launch with `--settings ... --setting-sources project,local`.

**Observed:** six warnings for `Read(*)`, `Write(*)`, `Edit(*)`, `Glob(*)`, `Grep(*)`, `NotebookEdit(*)`. Example real text:

```text
Allow rule "NotebookEdit(*)" lets NotebookEdit run without asking only in the
working directories. "NotebookEdit" alone allows every path. Older versions of
Claude Code treat "NotebookEdit(*)" as "NotebookEdit" ...
```

**Workaround:** no rule broadening or permission bypass was added merely to silence warnings. I left the guide's settings in place and verified the requested notebook with actual successful tools. There was no observed permission blocker on this path.

**Proposed correction:** document/test the intended scope against the installed Claude version, and either pin a tested version or revise rules deliberately. Do not imply that all old `(*)` examples necessarily mean unrestricted filesystem access on the current CLI. Verify the external project notebook path with a real write/read check.

**Evidence:** first-start/reboot captures and `check-6a-notebook-identity-real-tools.jsonl`.

### P6. Identity heading wording has drifted

**Guide:** 6a identity description, `INSTALL.md:1112–1113`.

**Observed:** the guide names a heading “Tools I use”; the current neutral `Claude/CLAUDE.md.example` has `## Tools`. The identity check returned the actual heading. No command failed.

**Workaround:** used the template's real heading, left its newborn identity block empty as instructed, and configured its paths/URLs.

**Proposed correction:** change “Tools I use” to “Tools”, or rename the template consistently. This is cosmetic but needlessly confusing in a newcomer check that asks the agent to name its headings.

### P7. Newborn startup already injects a greeting and may log a failed bridge build from the empty login transcript

**Guide:** 6a **First start**, `INSTALL.md:1457–1468`, especially **1467**.

**Command:** the line-1460 foreground loop start immediately after the prescribed interactive subscription sign-in.

**Observed:** the sign-in session left an empty project JSONL. Startup tried to build a bridge from it:

```text
loop: no bridge but JSONL exists — building on-demand ...
No messages extracted
loop: on-demand bridge build failed
loop: no bridge — starting bare
loop: birth prompt sent
```

The automatic prompt said `Fresh session after a cut. Read your lore and the bridge, then greet your person...`, even for this newborn. The guide then asks the operator to type `hello`; startup had already initiated a greeting. The agent correctly treated the house as new and continued; there was no observed data loss or blocker.

**Workaround:** observed the initial turn, waited for idle, and still performed the guide's hello/app checks. I did not delete arbitrary prior history or invent a bridge.

**Proposed correction:** distinguish bare newborn startup from post-cut startup in the prompt/logs, ignore empty login-only JSONL for bridge generation, and explain the automatic initial turn so the newcomer knows when to type hello.

**Evidence:** `step6a-foreground-handoff.log`, foreground app evidence.

### P8. Doctor's native-Claude sign-in SKIP wording is misleading without context

**Guide:** 9a/shared doctor explanation and check, `INSTALL.md:2643–2656`.

**Command:** `cd "$EMBERVY_HOME" && bun shared/tools/embervy-doctor.ts`.

**Observed:** on the requested native Claude subscription path the doctor printed:

```text
[SKIP] Claude app channel sign-in check not needed for this head
```

This did **not** mean subscription sign-in was unnecessary or that the live app-channel test could be omitted. Source verification found the separate credentials-presence check at `shared/tools/embervy-doctor.ts:1203–1209` is for an explicit alternative substrate/backend; native Claude defaults to `claude` and is intentionally skipped there. A separate real Claude canary and MCP checks did pass.

**Workaround:** no false alternative-head variable was set to force a doctor checkbox green. I retained the correct native configuration and separately verified interactive sign-in, `/status`, and real app tool replies.

**Proposed correction:** clarify that the substrate defaults to native Claude and this narrow extra sign-in check is alternative-head-only; its SKIP does not replace login or the step-8 app test. Improve the diagnostic label accordingly.

**Evidence:** `check-9a-doctor-first.log`; repository doctor/sign-in checks and their native-Claude skip test.

### N1. First foreground app failure was my stale exported environment, not a guide defect

**Related guide location:** step 5, env setup/foreground app and check, `INSTALL.md:666–810`, especially **798–810**.

My helper had read/exported blank template values before I completed the env files. A later foreground Bun process inherited an empty `APP_PASSWORD`, overriding the completed file:

```text
embervy-app: FATAL — APP_PASSWORD is empty.
Set APP_PASSWORD (and APP_SESSION_SECRET) in your .env before starting.
```

The first curls consequently returned connection errors/HTTP `000`. I started in a fresh clean shell after env completion; unauthorized internal access returned 401, password login 200, and authenticated chat shell 200. No extra guide repair was required. The failed attempt is preserved, not relabeled as success.

**Evidence:** `step5-foreground.log`, `check-5-foreground.log`, retry logs.

### N2. Immediate restart curls raced the listener; the guide already tells the operator to retry

**Guide:** step 5 restart check, `INSTALL.md:976–988`, including retry instruction **984**.

Immediately after `systemctl restart embervy-app`, the unit was active but curls returned connection refused/`000`. Repeating after three seconds produced health `{"ok":true}`, internal 200 and login 200. This followed the documented retry, so it is not a new guide defect.

**Evidence:** `check-5-restart-first.log`, `check-5-restart-retry.log`.

### N3. Expected warnings and explicit omissions, not hidden fixes

- Wrangler's out-of-date notice was left alone; the repository-pinned version was used. `whoami` lacked user-email details with this token's scope but still identified the intended account. No extra token permissions were requested or added.
- A user-token verification succeeded; an account-owned-token verification mismatch was not treated as evidence that a working user token was invalid.
- No DNS/zone/tunnel/custom-public-hostname step was attempted; no paid-plan workaround was enabled. This is the user's explicit scope restriction, not a deployment pass for public ingress.
- Optional hearing/mail/browser/shared-room modules and historical import were not configured; newborn identity stayed empty. No browser/phone UI claim is made.
- Memory health truthfully says the daemon never ran. Empty authorized cron schedules are not a tested scheduled-memory pipeline.
- Some readiness checks initially saw no tmux server or an old watchdog session while the new JSONL was being created. Repeated settled checks and actual replies proved the current life; an initial stale state file alone was not accepted as recovery.
- One helper-assembly attempt had a shell/Python quoting error before creating its file; it was retried with a clean SSH Python heredoc. This was test instrumentation, not an installation-command defect.

## 5. Complete Check-block ledger

This is the full applicable Check inventory: **24 blocks**, including the conditional dream check and the public-tunnel block marked skipped. Queued 6a checks were performed after First start as instructed. Output below is **real, shortened, and secret-free**; `...` means omitted output, not an invented success. Cookie values and account details are intentionally absent. All evidence filenames below are under `/root/blindtest-evidence/` unless stated otherwise.

### C01 — step 0 prerequisites (`INSTALL.md:173–188`) — ok

Commands: tool versions, editor lookup, root UID, kernel, and local Wrangler account verification once installed in step 2.

```text
1.3.14
Python 3.13.5
git version 2.47.3
OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)
/usr/bin/nano
0
Linux
```

Local Wrangler `whoami` succeeded for the intended account; its user-email-detail warning is described above. Evidence: `check-0.log`, `step2-whoami.log`.

### C02 — step 1 house (`229–245`) — ok

```text
Unpacked house: /opt/embervy
```

Supported unpacked option; no Git status was fabricated. Evidence: `check-1.log`.

### C03 — step 2 chronicle (`347–357`) — ok

Commands: local Wrangler secret list; unauthenticated and authenticated archive-list curls.

```text
[{"name":"RAG_AUTH_TOKEN","type":"secret_text"}]
401
{"files":[]}
200
```

Evidence: `check-2.log`.

### C04 — step 3 memory (`460–472`) — ok

Commands: secret list, unauthorized call, authenticated MCP wake.

```text
secret names: APP_PUSH_TOKEN, EMBERVY_API_KEY, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
401
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"# Wake — Tuesday, 03/11/2026, 09:51 ..."}]}}
200
```

Real wake contained `Mood: initial`, `memory bootstrapped`, zero surfaces/open todos, and daemon last successful run `never`; no JSON-RPC error or `isError`. Evidence: `check-3.log`.

### C05 — step 3b manual dream (`530–543`) — ok

```text
secret names: DREAM_AUTH_TOKEN, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
401
{"status":"dreamed","content":"While you were away... the silence hummed ..."}
200
Dream last run: 2026-11-03 09:52:21
Warnings:
- daemon never ran
```

Schedules stayed empty; this proves a manual dream run, not cron execution. Evidence: `check-3b-first.log`.

### C06 — step 4 runtime/host (`648–662`) — ok

```text
1.3.14
/root/.local/bin/claude
2.1.317 (Claude Code)
/swapfile file 4G 0B -2
Swap: 4.0Gi 0B 4.0Gi
/dev/sda1 38G 9.1G 27G 26% /
reading config file /etc/logrotate.d/embervy
Handling 1 logs
... initial missing log globs: does not exist -- skipping ...
```

Logrotate debug parsed the guide configuration; no actual rotation was claimed. Evidence: `check-4.log`.

### C07 — step 5 foreground auth/chat (`798–810`) — ok after test-environment correction

Initial attempt: app fatal empty inherited password, curls `000` (N1). Fresh-shell retry:

```text
401
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
chat shell HTTP: 200
```

Later authenticated test helper fetched the real chat shell (13,542 bytes). No visual rendering check. Evidence: `check-5-foreground.log`, `check-5-foreground-retry.log`.

### C08 — step 5 public tunnel (`972–974`) — skipped

No command result claimed: no permitted zone/public app hostname, so no DNS records, tunnel unit, public curl or browser/PWA check. This is a scope skip, not a passing public endpoint.

### C09 — step 5 restart (`976–988`) — ok after documented retry

Initial: service `active`, listener not yet ready, curl connection refused/`000`. Three-second retry:

```text
{"ok":true}
200
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
```

Public login subcheck skipped. Evidence: `check-5-restart-first.log`, `check-5-restart-retry.log`.

### C10 — step 6 exclusive harness (`1068–1084`) — ok

```text
inactive
inactive
inactive
inactive
```

Inactive-unit query exit 4 was expected, not an installation failure. No other head was started. Evidence: `check-6-exclusive.log`.

### C11 — step 6a identity (`1123–1131`) — ok after submission timing workaround

Actual app reply excerpt:

```text
CLAUDE.md, the load-bearing headings:
- Memory
- Tools
- What stays put
- Infrastructure
```

The reply identified Who I am as intentionally empty and named the configured Lore/chronicle endpoints and tools (`find`, `scan`, `wake`, `recall`). It used the CLAUDE.md already loaded in the session; I do **not** claim a separate Read call reopened that file. P4 records the initial unsent terminal prompt. Evidence: `check-6a-identity-outbox.jsonl`, actual session tool results.

### C12 — step 6a notebook (`1141–1149`) — ok, real write and read

Actual tool evidence, not merely the reply's assertion:

```text
Write -> File created successfully at:
/root/.claude/projects/-opt-embervy/memory/installation-notebook-check.md
Bash -> created MEMORY.md index and read both files back successfully
The installation notebook check ran on 2026-11-03.
```

Actual app reply named the note and `/root/.claude/projects/-opt-embervy/memory/MEMORY.md`. The Bash result contains the index link and saved note text. This note did not become the separate Lore test event. Evidence: `check-6a-notebook-outbox.jsonl`, `check-6a-notebook-identity-real-tools.jsonl`.

### C13 — step 6a systemd loop restart (`1194–1205`) — ok

```text
active
... initial tmux startup not yet ready ...
... repeated after 20 seconds: live Claude session ...
Actual authenticated app reply: restart app channel verified
```

The new reply had the matching real inbound message linkage. No interactive login/permission request was needed. Evidence: `check-6a-loop-restart-first.log`, `check-6a-loop-restart-ready.log`, `check-6a-restart-app.log`, sent/replies JSON.

### C14 — step 6a controlled cut (`1235–1250`) — ok

Performed later after smoke, with a real running life; command was the guide's `Claude/scripts/cutoff.sh`, not an uncontrolled kill. Shortened real output:

```text
800000 900000
=== cutoff.sh start 2026-11-03T10:12:06+00:00 ===
Session: ...9080deec-7ccd-4c4f-9e23-538ac82a8820...
Bridge written ... (5KB, 18 messages)
Bridge OK
EXPORTED:11 messages, 3KB
Header enriched.
Uploaded: Session_3.md
Done. Session is in the RAG.
Export OK
SIGTERM -> pid ...
Clean exit after 2s
Respawn delegated ...
... done 10:12:20 ...
```

The local bridge was 5,325 bytes. New life `7a722616-580e-4469-9d23-8282682dcd1e` replied `cut app channel verified`; a real `mcp__lore__recall` result retrieved `Session_3.md#0/#1` (scores about .99/.98) and the earlier `[App] watchdog fresh turn verified`. This proves archival rediscovery, not just bridge reading. Evidence: `check-6a-controlled-cut.log`, `check-6a-cut-respawn.log`, `check-6a-postcut-app.log`, transcript tool results.

### C15 — step 6a app MCP/channel (`1340–1353`) — ok

```text
bun run /opt/embervy/Claude/app/mcp.ts
16341 bun run /opt/embervy/Claude/app/mcp.ts
app: bun run /opt/embervy/Claude/app/mcp.ts - ✔ Connected
lore: https://embervy-memory.<account>.workers.dev/mcp (HTTP) - ✔ Connected
/status: Channels — Listening for messages from server:app
```

Real app-message/tool-result/outbox checks also passed; connection text alone was not counted as a reply. Evidence: `check-6a-channel.log`, `check-6a-channel-status.log`, app reply logs. Account details from `/status` are omitted.

### C16 — step 6a inlet clock (`1389–1400`) — initial check ok; reboot cadence caveat

Actual app reply quoted:

```text
⏰ UTC: Tuesday, 2026-11-03, 10:01
```

The original transcript contains the actual hook clock, not just a configured hook. P3 and C24 separately record absence after reboot and later direct-clock recovery. Evidence: `check-6a-clock-outbox.jsonl`, transcript hook attachment.

### C17 — step 6a prestart token/URL check (`1432–1440`) — ok

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
exit: 0
```

The checker was extracted from the guide without printing token values. Evidence: `check-6a-token.log`.

### C18 — step 6a First start (`1484–1495`) — ok after handoff workaround

```text
Actual foreground app reply: foreground channel verified
... foreground loop fully stopped; tmux socket had no server/session ...
active
active
Actual systemd-life app reply: systemd app channel verified
```

The initial foreground hello and app request were both performed. Actual `mcp__app__reply`/non-error tool results and outbox entries verified both lives. P2 records the missed first handoff pause and safe retry. Evidence: `check-6a-foreground-app.log`, `step6a-foreground-handoff.log`, `check-6a-firststart.log`, `check-6a-firststart-app.log`.

### C19 — step 7 common watchdog active (`2383–2391`) — ok

```text
active
```

Evidence: `check-7-active.log`.

### C20 — step 7a advancing state (`2426–2437`) — ok

```text
active
active
10:08:22.093Z session=9080deec... tokens=41291 warn=800000 cut=900000
10:09:25.119Z session=9080deec... tokens=41291 warn=800000 cut=900000
Actual app reply: watchdog fresh turn verified
10:10:27.952Z session=9080deec... tokens=41577 warn=800000 cut=900000
```

Timestamp progression was checked even with unchanged idle tokens; a fresh turn then changed tokens. After cut, state tracked new life `7a722616...`, timestamp advanced again, thresholds stayed 800k/900k. Evidence: `check-7a-advancing.log`, `check-7a-new-turn.log`, `check-7a-after-turn.log`, `check-7a-after-cut.log`.

### C21 — step 8 smoke, automatic inlet, and cleanup (`2578–2622`) — ok

A synthetic file (explicitly marked test data, not an experience) was uploaded with phrase `cobalt lantern recall check`:

```text
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
RAG recall: ...
[1] InstallCheck_1.md#0 (1.00)
# Installation recall probe
... The probe phrase is cobalt lantern recall check. It is test data, not an experience.
```

Actual agent tools, each with real successful results:

```text
mcp__lore__wake -> real wake result
mcp__lore__write -> Wrote event 1 (kind=observation, weight=light, embedded=1)
mcp__lore__find -> event 1, synthetic cobalt lantern memory check content
mcp__lore__recall -> InstallCheck_1.md and actual probe text
mcp__app__reply -> real sent reply
Separate authenticated app request -> smoke app channel verified
```

The Lore write was explicitly `Synthetic installation test data (not an experience): cobalt lantern memory check.`, tagged synthetic/installation-test, external source. For the automatic inlet-only test, the prompt prohibited explicit recall/find/Bash retrieval; the actual hook attachment supplied:

```text
## Chronicle (RAG)
[InstallCheck_1.md] (71% [bm25+rerank])
# Installation recall probe
...
```

That answer used only the real app reply tool, so it was not a disguised manual retrieval. Cleanup:

```text
{"success":true,"deleted":"InstallCheck_1.md","chunksRemoved":1}
{"files":[{"name":"Session_1.md",...},{"name":"Session_2.md",...},{"name":"Session_3.md",...}]}
```

A search after 65 seconds had reranking enabled and returned session sources, **not** deleted `InstallCheck_1.md`. The phrase legitimately remains quoted in archived `Session_3.md`; that is not a stale deleted-file hit. The synthetic Lore event/test notebook are intentionally retained and labeled test data.

Evidence: `check-8-upload-direct-recall.log`, `check-8-agent.log`, `check-8-agent-outbox.jsonl`, `check-8-separate-app.log`, `check-8-auto-inlet.log`, `check-8-auto-inlet-outbox.jsonl`, `check-8-real-transcript-tools.log`, `check-8-probe-cleanup.log`, `check-8-after-delete-search.json`.

### C22 — step 9a/shared doctor (`2649–2656`) — ok

Command: `cd "$EMBERVY_HOME" && bun shared/tools/embervy-doctor.ts; printf 'doctor exit=%s\n' "$?"`.

```text
[SKIP] Claude app channel sign-in check not needed for this head
[SKIP] Hearing service answers — EMBERVY_HEAR_URL is unset
[OK] Memory daemon and dream — daemon: never — not due yet; dream: successful run within 26 hours
[OK] Memory worker rejects unauth — unauth → HTTP 401
[OK] RAG rejects unauth — unauth → HTTP 401
[OK] Hybrid search — mode=hybrid, counts: vector 13, bm25 13
[OK] Reranker active — top source: [vector, bm25, rerank]
[OK] Inlet returns context — 2759 bytes, retrieved hit found
[OK] Claude headless canary — claude -p answered on build 2.1.317 (Claude Code)
[OK] House MCP servers — 2/2 connected (house configuration)
Result: PASS (23 checks passed, 0 warn, 0 fail, 2 skip)
doctor exit=0
```

Other successful checks covered identity/hook, worker authentication, capability consistency, state/logs, disk/swap, no pending reboot, filled configs. P8 explains the native-Claude skip. The temporary isolated canary did not replace the interactive head or live step-8 tools. Evidence: `check-9a-doctor-first.log`.

### C23 — step 9 finished-house sweep (`2729–2771`) — literal FAILED; reviewed variant passed

```text
... seven legitimate-markup hits listed in P1 ...
placeholder sweep: review required
... token/URL groups: match ...
memory: authenticated 200
archive: authenticated 200
final check: FAIL
finished sweep exit=1
```

Separate reviewed test-only run:

```text
... seven exact lines: reviewed legitimate markup/parameter notation ...
placeholder sweep: clean
... token/URL groups: match ...
memory: authenticated 200
archive: authenticated 200
final check: pass
reviewed sweep exit=0
```

The second result is **not** the result of the unmodified guide check. Evidence: both sweep scripts/logs, detailed P1.

### C24 — step 10 actual reboot (`2795–2817`) — core recovery ok; clock-check workaround; public part skipped

A real OS reboot was requested, SSH temporarily became unavailable, and the kernel boot ID changed (`reboot-proof.json`: `"changed": true`). Boot uptime began `2026-11-03 10:18:19`; SSH returned by `10:18:40`.

```text
active
active
active
{"ok":true}
/swapfile file 4G 0B -2
inactive
inactive
other harness status exit=4 (expected inactive)
Actual authenticated app reply: reboot app channel verified
```

The loop started new live Claude session `14bbe460-0fde-4983-ad88-76299723f211` with no new login or permission prompt. No manual service start/repair was used. Settled watchdog state:

```text
10:20:45.439Z session=14bbe460... tokens=40652 warn=800000 cut=900000
10:21:48.335Z session=14bbe460... tokens=41707 warn=800000 cut=900000
```

It initially pointed to the old session during startup, which was not accepted as the settled result. Later current-life sample at `10:28:03.730Z`: 42,250 tokens, same thresholds. The first reboot app turn and a retry had no direct ambient clock; additional real prompts reached normal cadence:

```text
10:22:58.558Z: None. This prompt came with no direct inlet clock line.
10:23:09.778Z hook context: ⏰ UTC: Tuesday, 2026-11-03, 10:23
10:23:12.601Z real app reply: ⏰ UTC: Tuesday, 2026-11-03, 10:23
```

The request was sent through the loopback-authenticated app rather than the public app, which was unavailable by scope. Thus **automatic core reboot recovery is demonstrated; public-app reachability and a first-prompt clock guarantee are not**.

Evidence: `reboot-requested.txt`, `pre-reboot-boot-id.txt`, `reboot-proof.json`, `check-10-reboot.log`, `check-10-postreboot-app.log`, `check-10-watchdog.log`, `check-10-reboot-settled.log`, clock retry/cadence outbox and direct-context evidence.

## 6. Final required answers

| Question | Answer and evidence boundary |
|---|---|
| Did the agent answer through the app channel? | **Yes.** Password-authenticated app requests yielded real Claude app tool calls/results and actual outbox/history replies in foreground, systemd, restart, smoke, post-cut and post-reboot lives. Browser UI and public ingress were not tested. |
| Did memory write and recall work? | **Yes.** Real Lore `write` returned embedded event 1, `find` returned its synthetic content, and `recall` returned the separate archive probe. Automatic inlet retrieval also supplied the probe without a retrieval tool call by the answering agent. The Claude project notebook independently had a real write/index/readback. |
| Did controlled cut/archive rediscovery work? | **Yes.** Bridge completed, Session_3 uploaded, process exited cleanly, loop respawned, new life actually recalled Session_3 and quoted an earlier app event. This was not inferred from a claimed cut or from bridge text alone. |
| Did reboot recovery work without manual starts? | **Yes for the configured core.** App/Claude loop/watchdog and swap returned automatically; a new live session replied and watchdog state advanced. Public-app check was excluded; current clock required extra due-cadence prompts, not a service repair. |
| Did every literal applicable check pass? | **No.** The unmodified finished-house sweep fails on seven legitimate lines. Its separate reviewed variant passes. The first-clock interpretation also required the recorded cadence workaround. |
| How long? | First SSH contact: **09:47:23 UTC**; explicit run-start evidence file: **09:47:58 UTC**. Final test/usage snapshot: **10:27:54 UTC**, about **40 min 31 sec from first contact** (39 min 56 sec from the start file), including relay wait, smoke, controlled cut, reboot and follow-ups. Report written at 2026-11-03T10:34:14+00:00; elapsed including report preparation: **46 min 51 sec** from first contact. |
| What was not demonstrated? | Public DNS/tunnel/HTTPS app, visual UI/phone/PWA, scheduled daemon/dream execution, long-duration operation or exhaustive failure recovery. Empty crons and optional disabled modules were deliberate. |

## 7. Cost and subscription token usage

### OpenRouter — actual supplied key usage difference

Measured with the key-authenticated `/api/v1/auth/key` endpoint, without printing authorization values. The baseline is pre-existing key usage, not this test's cost.

| Measurement | USD |
|---|---:|
| Before | <key total> |
| Final | <key total> |
| **Usage difference** | **0.015261153** |
| User's test ceiling | 1.00 |

That is about **1.53 US cents**, comfortably below $1. The final sample followed the last inlet prompt/model test; no further model calls were needed to prepare the report. This is the measured key-wide delta for the window, not a claimed per-request invoice allocation if anyone else used the same key concurrently. Evidence: `openrouter-before.json`, `openrouter-final.json`.

### Claude subscription head

`/status` identified Claude Max; main project JSONL usage records identify `claude-opus-5-5`. Deduplicating assistant message IDs and taking the maximum numeric usage fields across repeated records gave:

| Recorded field | Tokens |
|---|---:|
| Input, excluding cache fields | 149 |
| Cache creation input | 97,775 |
| Cache read input | 2,592,538 |
| Output | 8,810 |

There were **64 unique recorded assistant messages**, all for that model. These are main/project transcript counters over multiple lives, **not** the current context-window size and **not** a subscription billing statement. Helper/header-enrichment and isolated no-session-persistence doctor canary usage may not be covered by this aggregate. I have not invented a subscription dollar charge or assumed those calls are fully represented. The watchdog's later live-window estimate was 42,250 tokens, distinct from lifetime cached-input traffic.

The selected verified transcript tool ledger contains 20 app replies, 1 app send, 7 Lore wakes, 2 Lore recalls, 1 Lore write, 1 Lore find and 1 selected notebook Write, all with successful real results. Other notebook operations were additionally verified from actual Bash results. Evidence: `final-transcript.json`, `final-transcript-summary.log`, `check-6a-notebook-identity-real-tools.jsonl`.

### Cloudflare and other spending

No domain purchase/registration, paid Workers activation, plan/subscription change, or billing-setting change was made. No unrelated domain/resource was deleted or modified. Only the test's new resources were created and exercised at small test volume. I did not query a final Cloudflare invoice and do not claim an independently verified billed amount; no paid-plan workaround or purchase was initiated. The only metered-dollar measurement reported above is the authorized OpenRouter key delta. No Anthropic API billing was set up.

## 8. Evidence, retained state, and handoff

- Final deliverable: **`/root/blindtest-report.md`** on the disposable server.
- Evidence directory: **`/root/blindtest-evidence/`**, including chronological `run-notes.md`, original failed outputs and successful retries, exact and reviewed sweep scripts, app sent/replies records, real tool summaries, boot proof, and usage snapshots.
- Main test helpers: `/root/blindtest-common.sh`, `/root/blindtest-app.py`, `/root/blindtest-console.py`, `/root/blindtest-transcript-summary.py`. These are test-only remote instrumentation, not product changes.
- Current installed house remains at `/opt/embervy`; the three selected services are enabled/active, optional recurring model calls remain off, and both memory/dream schedules remain empty.
- Chronicle retains `Session_1.md`, `Session_2.md`, `Session_3.md`. The synthetic uploaded probe was deleted and its absence checked. Synthetic labeled Lore/notebook test data remains for inspection.
- Login relay files were removed after successful sign-in. Secrets and login code are not included in this report. Raw evidence may include private CLI/account metadata; do not publish it wholesale without review.

**Bottom line:** the requested subscription-backed core was installed and genuinely exercised through reboot. The guide needs fixes for the literal sweep, safe handoff instructions, and first-clock wording, plus the smaller clarifications above. It would be inaccurate to call this an untouched all-green installation or a verified public/browser deployment.
