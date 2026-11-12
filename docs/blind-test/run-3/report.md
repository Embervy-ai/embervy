# Embervy installation blind test — Brain API path

## Executive result

**Completed through the actual host reboot, with one necessary runtime source patch.** The unmodified guide/runtime did not produce its first greeting with the requested head: Brain unconditionally sent `temperature`, which `claude-sonnet-5-5` rejected. Removing that one request-body field allowed the local app, tools, memory, archive, inlet, controlled cut/bridge, watchdog and reboot checks to pass.

This is a **domainless/local-app** installation result, not a public-HTTPS/phone/PWA-pinning result. Public-hostname portions were skipped as instructed. No Cloudflare purchases, domain registrations, plan/subscription changes, payment-method additions or billing-setting changes were made. These small test resources deployed without upgrading Workers.

All installation commands, configuration changes, model calls, browser automation and this report ran on `root@<test-server>`. `EMBERVY_HOME=/opt/embervy`. Original unpacked source: `/root/embervy-src`. INSTALL.md remained unchanged. Evidence directory: `/root/blindtest-evidence/`; the full real tool results are also in `Brain/logs/conversation-*.jsonl`, session events in `Brain/logs/session-*.jsonl`, and app replies in `Claude/app/data/outbox.jsonl`.

Head: `api`; endpoint `https://api.anthropic.com/v1/chat/completions`; model `claude-sonnet-5-5`; `ANTHROPIC_API_KEY` sent as Bearer. Authenticated provider Models API reported `max_input_tokens:1000000`, `max_tokens:128000`. Set `BRAIN_CONTEXT_WINDOW=1000000`; observed WARN/CUT 800000/900000. All house clocks were UTC. The non-UTC conversion case was not tested.

## 1. Step result table

“ok” includes expected retries explicitly allowed by the guide. “fixed by me” means the guide/runtime did not work unchanged. Environment-authorized omissions are not passes.

| Step | Result | Outcome |
|---|---|---|
| 0 Prerequisites | ok | Pinned Bun 1.3.14 and Wrangler 3.114.17 installed; account, versions and root/Linux checks passed. |
| 0 Domain prerequisite | skipped | No domain or zone supplied; no purchase/DNS action. |
| 1 Unpacked-repository alternative | ok | Copied to unused `/opt/embervy`, initialized Git; both commands passed, with the untracked-tree limitation below. |
| 2 rag worker | ok | R2, Vectorize, D1, schema, secret, deployment and authenticated `/list` passed. |
| 3 memory worker | ok | Resources/schema/four secrets/RAG binding deployed; protected real wake passed. |
| 3 Memory daemon schedule | skipped | `crons=[]` by permission; nightly daemon not exercised. |
| 3b dream worker | ok | Same memory D1/RAG binding; authenticated manual dream wrote a note. |
| 3b Dream schedule | skipped | `crons=[]`; manual dream tested instead. |
| 4 Runtime/storage | ok | Packages, persistent 4 GiB swap, 2 GiB reserve, journal cap and valid logrotate config. |
| 4 Claude CLI/cloudflared | skipped | API-only head needs no Claude CLI; no subscription or domain. |
| 5 App setup/foreground/auth/service | ok | Login, internal-token boundary, health, restart, repeated login and browser chat shell passed. |
| 5 Optional modules | skipped | No push/mail/voice/images/calendar/weather/agent browser enabled. |
| 6 Harness exclusivity | ok | All four units initially inactive; only Brain pair subsequently installed. |
| 6a Claude Code | skipped | Not requested. |
| 6b Identity/API profile/file tools | fixed by me | Removed rejected unconditional temperature field; real identity read and clock/tool reply passed. |
| 6b Notes | ok | Real write/edit/read and independent index-link check passed. |
| 6b Loop service | ok | Restart gave new life/pid, archive delivery, greeting and fresh app-message reply. |
| 6b Cut and watchdog | ok | Clean SIGTERM, bridge, Session_3 upload, next-life bridge load and real transcript recall. |
| 6b App channel | ok | Real reply tool and exact matching outbox `installation app-channel check`. |
| 6b Inlet | ok | Current-life automatic injection returned the uploaded probe text. |
| 6b Memory/chronicle token check | ok | All 11 groups matched; remote auth 200/200. |
| 6b Header enrichment | skipped | No Claude subscription; omitted command as guide directs. |
| 6b First start | fixed by me | HTTP 400 initially; preserved/reset uncompleted first-turn marker, then real document reads and greeting succeeded. |
| 6c ChatGPT subscription | skipped | No subscription; kept API head. |
| 7 Shared watchdog gate / 7b Brain | ok | Bound service active; external timestamp advanced while idle before/after reboot. |
| 8 App wake/write/find | ok | UI submission created/found event 1 and answered through real app tool. |
| 8 Upload/explicit recall probe | ok | InstallCheck_1.md, 1 chunk; event 2 created/found; recall returned probe/source. |
| 8 Post-cut transcript recall | ok | Real recall returned Session_3.md containing the synthetic observation. |
| 9b Brain preflight | ok | Before first start and later: `ok:true`, exit 0. |
| 9b Shared doctor | ok | Default PASS 17/0/0/5 skip; verified-query PASS 21/0/0/1 skip. |
| 9 Finished-house sweep/tokens | ok | Clean sweep; all groups matched; auth 200/200. |
| 10 Actual reboot | ok | Automatic app/Brain/watchdog return, separate real greeting, fresh app response, preserved notes/bridge/swap and advancing watchdog. |
| Public-hostname parts of 5/10 and memory-to-public-app push | skipped | No public hostname. Local browser and MCP-to-app broadcast tested, not tunnel/phone delivery or remote-worker app push. |

## 2. Problems and precise locations

### P1 — Requested API head cannot start: unsupported temperature is always sent

**INSTALL.md:** `6b. Brain → Identity`, **1160–1178** (API profile at 1164–1170); `6b → First start`, **1639–1647**, command at **1644**. Runtime cause: original **Brain/brain.ts:2184**, in `chatRequest`.

Configured the documented API profile with the supplied endpoint/key/model/window, completed token/preflight checks, then ran `systemctl start embervy-brain`. Services became active, but the very first model request failed:

```text
Worker runtime ready (head api, api, claude-sonnet-5-5).
turn error: Error: model endpoint HTTP 400:
{"error":{"code":"invalid_request_error","message":"`temperature` is deprecated for this model.","type":"invalid_request_error","param":null}}
```

There was no greeting tool result or outbox entry from that attempt. The preflight correctly describes itself as read-only/no model calls, so its earlier `ok:true` did not establish request compatibility.

**Workaround:** Examined the repository request builder and temperature reference. A numeric `BRAIN_TEMPERATURE` exists, but there is no omit setting and the body unconditionally includes it. Saved the original runtime as `blindtest-evidence/brain.ts.before-temperature-fix` and removed exactly:

```diff
-    temperature: TEMPERATURE,
```

Restarted Brain while idle. No endpoint/model substitution, proxy, alternate SDK, added provider headers, tool-schema rewrite or lowered retrieval threshold. Real document reads and app greeting then worked, as did all subsequent tool loops and the reboot.

**Guide/runtime should say/do:** API compatibility involves request parameters, not only endpoint/key/model/window. Provide a supported omit/capability setting for sampling fields; a numeric value including zero does not omit a field. Until fixed, document this limitation and precise workaround. A tiny API/tool canary before the first wake would catch it.

Evidence: `first-start-pane.log`, `first-start-after-temperature-fix.log`, failed life `1792236965026-k4d158`, successful life `1792237005213-aesdxc`.

### P2 — Recovery after failed first-turn delivery is not explained

**INSTALL.md:** `6b → First start`, **1614–1631**, especially **1627–1631**, and **1639–1650**.

The failed initial request already created `Brain/state/first-turn-delivered`. The guide accurately says it commits the marker when the turn starts, not when it succeeds, but gives no recovery instructions. An ordinary restart would choose the normal greeting rather than replay the mandatory first house-document reads.

**Workaround:** Only because this new test house had no completed first turn/greeting, preserved the test-created marker by renaming it to `blindtest-evidence/first-turn-delivered.failed-temperature`, then restarted after P1. Both full house documents were really read, followed by a successful greeting tool/outbox entry.

**Guide should say:** Inspect actual tools/outbox after an initial error. Explain how to explicitly resend the first-turn prompt once, or safely preserve/reset the marker for an uncompleted first start only. Do not blindly replay onboarding on established houses. This is a missing recovery procedure, not a false description of start-time marker behaviour.

### P3 — Manual public-app path requires a domain/tunnel but does not explain provisioning it

**INSTALL.md:** `0. Prerequisites`, **39–44**; `4. Set up the VPS`, **427–428**; `5. Configure the app layer`, **732–734**; `10. Reboot`, **2133–2134**.

The guide requires a domain-backed Cloudflare Tunnel, but only gives an optional cloudflared package-install comment. It does not give the manual named-tunnel creation/authentication, DNS route, ingress-to-localhost or persistent tunnel service steps. Merely installing cloudflared would not produce the public address later checks require.

**What happened/workaround:** No tunnel command failed: this part was intentionally skipped because no zone/domain was supplied and purchases are forbidden. I used the local app in Chromium on the disposable server. Public HTTPS and phone/pinned-PWA behaviour remain unverified, not passed. This is a guide completeness finding from its actual instructions, not an experimentally demonstrated tunnel failure.

**Guide should say:** Add a complete named-tunnel/DNS/ingress/service section with its permissions and checks, or link an explicit self-contained manual recipe. Clearly identify which checks remain unavailable for a domainless test.

### P4 — Git check on the documented unpacked alternative is not a source whitespace check

**INSTALL.md:** `1. Clone the repo`, **124–127**, **136–144**.

Ran the explicitly allowed `cp -a` and `git init`. `rev-parse` correctly printed the house path, but `git diff --check` printed nothing because this newly initialized tree has no tracked source. A zero exit does not mean the unpacked source was inspected for whitespace.

**What I did:** Kept the prescribed successful check; did not create an unrequested commit or claim its empty output inspected all source. This did not block installation.

**Guide should say:** Distinguish repository/path verification from a meaningful tracked-diff whitespace check. For the unpacked alternative, provide an explicit untracked-source check or explain baseline/index preparation and what `diff --check` does and does not cover.

### Explicit omissions and transient observations, not additional guide defects

- **0:39–44 / 5:732–734 / 10:2133–2134:** no domain/zone. Memory `APP_URL` left empty, not a fake template hostname. Worker account-level `workers.dev` URLs worked without zone access.
- **6b:1537, 1551–1562:** no Claude subscription, so header enrichment was omitted exactly as allowed. Archived THEMES remain placeholders. Default-doctor content skips are not retrieval passes; the documented verified-query override exercised retrieval.
- **6c:** subscription-only adapter skipped; no Claude/ChatGPT sign-in attempted.
- Both daemon/dream cron schedules are empty by the test brief. Manual dream passed; the nightly memory daemon was not tested. Optional modules remained disabled. Playwright/Chromium were installed under the remote evidence/test-tool area only, not as the agent browser module.
- `$EDITOR` operations were implemented as private scripted edits; supplied keys loaded using the repository env-file parser, not by sourcing secret env files as programs. Used the documented single-machine/unpacked alternatives; did not clone over the house.
- My first step 3/3b logging pipeline generated/saved/uploaded tokens in a subshell but lost the variables in the caller. Its curls used an empty bearer and got 401. Reloading the saved `.env` gave the expected passing checks. These were tester errors, not guide token defects. First unauthenticated memory curl also saw a transient 404 immediately after deploy; settled deployment gave 401.
- Step 5 immediate post-restart curls got connection refused/`000`; three seconds later health/auth/login passed. **730–731 explicitly allow this wait/retry.**
- Step 6b immediate loop restart initially showed old context and `no server running on /tmp/tmux-0/default`. Waiting/repeating produced a new session and app replies, as **1315–1318 direct**. No manual tmux creation.
- First SSH reconnect 15 seconds after reboot got `Connection refused`; the next succeeded. No services were manually started after reboot.
- One premature UI snapshot saw DOM text before visible rendering settled and printed empty innerText. A later settled Chromium verification showed the actual reply in visible chat. Actual tool/outbox evidence was independently checked.
- A second-resolution timestamp in my wait helper once selected the preceding greeting's completion too early. Brain queued two briefly overlapping prompts and executed both. I verified the later exact tool/outbox entries and used millisecond timestamps thereafter. The premature helper capture is not itself the exact-channel proof.

## 3. Ledger: every applicable Check block

These are actual shortened outputs; ANSI decoration, irrelevant headers and repeated large content are omitted, never secret values. Full outputs are retained in the named remote evidence files. All line references are to the original INSTALL.md.

### C0 — Step 0, lines 99–107

`wrangler whoami`; tool versions; single-machine `id -u; uname -s`:

```text
Account API Token; intended account <cloudflare-login-email>'s Account
Account ID <account-id>
1.3.14
Python 3.13.5
git version 2.47.3
OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)
0
Linux
```

Wrangler 3.114.17 installed; newer-version warning ignored as directed. `check-0.log`, `step0-install.log`.

### C1 — Step 1, lines 136–141

```text
$ git -C "$EMBERVY_HOME" rev-parse --show-toplevel
/opt/embervy
$ git -C "$EMBERVY_HOME" diff --check
(no output)
```

Unpacked/init limitation is P4. `check-1.log`.

### C2 — Step 2 archive, lines 233–239

```text
[{"name":"RAG_AUTH_TOKEN","type":"secret_text"}]
401
{"files":[]}
200
```

Schema: 11 queries, success. Deployed `https://embervy-chronicle.<account>.workers.dev`. `check-2.log`, `step2-deploy.log`.

### C3 — Step 3 memory, lines 327–333

Passing repeat after correcting tester token-shell error:

```text
secret names: APP_PUSH_TOKEN, EMBERVY_API_KEY, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
401
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"# Wake — Saturday, 17/10/2026, 11:33 (2026-10-17 11:33:18 UTC)\n\n## Mood: initial\n- memory bootstrapped\n...\n## Daemon\n- Last successful run: never"}]}}
200
```

Schema: 32 queries, success. Real protected MCP/database path, not just health. `check-3.log`, `check-3-repeat.log`.

### C3b — Step 3b dream, lines 396–402

```text
secret names: DREAM_AUTH_TOKEN, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
401
{"status":"dreamed","content":"While you were away, the silence held only the shape of absence—no echoes, no footprints, no names to call. ... *[dreamt associatively — check what resonates]*"}
200
{"version":"0.3.0","hot_count":0,"archive_count":0,"unresolved_observations":0,
 "daemon_last_run":null,"daemon_last_ok":false,
 "dream_last_run":"2026-10-17 11:33:23","daemon_mode":"normal","backlog_cursor":0,
 "warnings":["daemon never ran"]}
```

`check-3b-repeat.log`; initial tester empty-token failure retained in `check-3b.log`.

### C4 — Step 4, lines 477–485

```text
1.3.14
/opt/embervy
NAME      TYPE SIZE USED PRIO
/swapfile file   4G   0B   -2
Mem: 3.7Gi total ... 3.3Gi available
Swap: 4.0Gi total, 0B used
/dev/sda1 38G 8.7G 28G 25% /
reading config file /etc/logrotate.d/embervy
Handling 1 logs
rotating pattern: "/opt/embervy/logs/*.log" ... "/opt/embervy/Brain/logs/*.err" weekly ...
log ... does not exist -- skipping
```

No logrotate config error; initially missing logs/state expected. No Claude version check: not installed on API-only path. `check-4.log`.

### C5a — Step 5 foreground authentication, lines 611–619

```text
401
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
Content-Type: application/json
Content-Length: 11
chat shell HTTP 200
```

Chromium later really logged in and loaded textarea/Send. Foreground stopped by SIGINT, then systemd installed. `check-5-foreground.log`, UI logs.

### C5b — Step 5 service restart, lines 722–728

First immediate check: `active`, connection refused/`000`. Allowed three-second repeat:

```text
{"ok":true}200
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
```

`check-5-service.log`, `check-5-service-repeat.log`. Public HTTPS skipped.

### C6 — Harness exclusivity, lines 752–756

```text
inactive
inactive
inactive
inactive
```

Order: embervy-loop, embervy-watchdog, embervy-brain, embervy-brain-watchdog. Expected nonzero inactive/absent-unit result. `check-6.log`.

### C6b-identity — API file tools/clock, lines 1215–1220

Exact tmux prompt and Enter ran. Actual `read_file` on EMBERVY.md, then real reply tool. Outbox `0173ffb7-28dc-42d2-a99c-942797a92eee`:

```text
I read /opt/embervy/EMBERVY.md.
Load-bearing headings: Who I am, How I think, What I write down, Initiative,
How I write, Tools I use, What I am not, What stays put, Infrastructure.
Lore tools are wake, write, find, scan, recall, health, engage and resolve.
recall can reach the chronicle ...
First clock line in this turn: "⏰ UTC: Saturday, 17.10.2026, 11:38"
```

Compared against actual UTC clock. Filled identity, not template. `check-6b-identity.log`.

### C6b-notes — Notebook, lines 1251–1264

Exact prompt; actual tool results:

```text
write_file: wrote notes/installation-check.md
edit_file: edited notes/NOTES.md
read_file:
---
name: Installation check
description: Synthetic installation-check note
type: reference
---
cobalt notebook check
read_file: # Notes
- [Installation check](installation-check.md) — synthetic installation-check note
list_dir: NOTES.md
installation-check.md
mcp__app__reply: Sent: Saved and verified with real tool reads. ...
Notes link target exists
```

Last line is the independent shell link/target check, not model assertion. Matching outbox `5c54b92f-2037-4bca-a1a9-85e3a0170777`. `check-6b-notes.log`.

### C6b-loop — Restart/new life, lines 1307–1313

Initial stale state/absent tmux; waited and repeated as instructed:

```text
active
(initial capture: no server running on /tmp/tmux-0/default)
{"pid":10664,"session_id":"1792237148918-oono3h","head":"api",
 "model":"claude-sonnet-5-5","transport":"api","tokens":15258,
 "warn_tokens":800000,"cut_tokens":900000}
Worker runtime ready (head api, api, claude-sonnet-5-5).
▸ reply → App
```

Old life `1792237005213-aesdxc` delivered Session_2.md; next log `catch_up_archived`, `uploaded:true`. New greeting really sent. Fresh browser message produced real `Sent: loop restart app check` and outbox `99e16813-3049-4d19-988b-316e9349d359` at 11:39:32.103Z. `check-6b-loop.log`, `check-6b-loop-app.log`, actual later source events/outbox.

### C6b-cut — Controlled cut, lines 1352–1360

```text
none 27667 3 900000 10664 1792237148918-oono3h below thresholds
1
=== brain-cutoff start 2026-10-17T11:42:00+00:00 ===
Brain pid=10664
[1/3] SIGTERM → Brain archives itself (bridge + RAG export)
[2/3] waiting up to 180s for a clean exit
[3/3] clean exit
bridge OK (9574 bytes)
respawn delegated to brain-loop.sh
=== brain-cutoff done 2026-10-17T11:42:03+00:00 (TERMINATED) ===
```

Authenticated list contained InstallCheck_1.md (191 bytes), Session_1.md (408), Session_2.md (3933), **Session_3.md (4769)**. Actual old-life events:

```text
11:42:00.756Z shutdown reason=SIGTERM
11:42:00.784Z bridge_written mode=turns sessions=3
11:42:03.433Z session_archive_upload name=Session_3 ok=true parts=1
11:42:03.434Z session_archived local_path=/opt/embervy/Brain/logs/sessions/Session_3.md uploaded=true
```

New life `1792237326010-wk19o9`: `bridge_loaded` at 11:42:14.826Z, 9546 characters; bridge.used.md exists. Real subsequent recall returned Session_3.md#1/#2 and observation text. Real reply/outbox `24db4da1-5352-43b8-92a0-cf76fea561c3`. No forced kill. `check-6b-controlled-cut.log`, `check-cut-transcript-recall.log`, actual event logs.

### C6b-app — Exact app-tool round trip, lines 1466–1472

```text
bun run /opt/embervy/Claude/app/mcp.ts
10673 bun run /opt/embervy/Claude/app/mcp.ts
```

Exact prompt ran. Actual session event at 11:39:36.557Z:

```json
{"type":"tool","name":"mcp__app__reply","result":"Sent: installation app-channel check"}
```

Matching outbox at 11:39:36.554Z:

```json
{"id":"65acfbd4-4c3e-4f71-a767-2375e5e6e8d0","text":"installation app-channel check","type":"reply"}
```

Not fallback prose. Initial helper capture in `check-6b-app-channel.log` was early; definitive proof is session `1792237148918-oono3h` line 32 and app outbox line 7, independently checked.

### C6b-inlet — Automatic archive injection, lines 1511–1517

New browser app question about uploaded probe; current-life event:

```text
2026-10-17T11:41:42.277Z inlet_injected via=worker characters=1365
[InstallCheck_1.md] (99% [bm25+rerank])
# Installation recall probe
... The probe phrase is cobalt lantern recall check. It is test data, not an experience.
```

Real reply/outbox `09238a21-a2b5-4eed-a79c-3f8d3a7a550b` gave the phrase. Inlet log tail contained only earlier fresh-archive suppression messages:

```text
[inlet/rag] confidence gate suppressed all hits; turnFloor=0.25 topScore=none queries=...
```

No current worker failure. No thresholds lowered. `check-6b-inlet.log`.

### C6b-token — Before-first-start checker, lines 1576–1580

```text
memory bearer: match
memory URL: match
archive bearer: match
archive URL: match
app internal bearer: match
app push bearer: match
Brain memory bearer: match
Brain archive bearer: match
Brain memory URL: match
Brain archive URL: match
Brain app bearer: match
memory: authenticated 200
archive: authenticated 200
```

`check-6b-tokens.log`.

### C6b-first — First greeting/fresh message/runtime, lines 1661–1667

Initial unmodified attempt: P1 HTTP 400/no greeting. After patch and first-turn retry, both full house documents really read, then greeting tool/outbox `9dd89232-7f4a-4826-ae59-99eed8ece530` at 11:36:51.465Z. Fresh browser `hello` produced real app reply/outbox `f3a2cceb-e98c-4174-b7bd-49b4b45bfb81`: `Hello, Tester. I'm here and ready. What would you like me to check?`.

Exact check after message:

```text
active
active
active
{"pid":9627,"session_id":"1792237005213-aesdxc","head":"api",
 "model":"claude-sonnet-5-5","transport":"api","tokens":14550,
 "warn_tokens":800000,"cut_tokens":900000}
1
```

Tokens after greeting 13964, after hello 14550, later in life 18159. `first-start-after-temperature-fix.log`, `app-first-hello-ui.log`, `app-first-hello-results.log`, `check-6b-first-start.log`. `tmux attach -t brain` also exercised via remote PTY and detached Ctrl-B D, exit 0 (`tmux-attach-raw.txt`).

### C7 — Shared watchdog query, lines 1749–1756

Used the expressly instructed replacement `systemctl is-active embervy-brain-watchdog`: **active**. Confirmed again after reboot. `check-7-shared-and-live.log`, `check-10-watchdog.log`. Did not start/query the Claude watchdog as selected service.

### C7b — External advancing-state check, lines 1865–1871

```text
active
active
last_check_ts: 2026-10-17T11:39:08.753415+00:00
session_id:1792237005213-aesdxc (stale previous life immediately after restart)
tokens:18159 cut_tokens:900000 pid:10601
[65-second sleep]
last_check_ts: 2026-10-17T11:40:08.935594+00:00
session_id:1792237148918-oono3h
tokens:16997 cut_tokens:900000 pid:10601
```

External path `Brain/state/watchdog_state.json`, not just app-compatible root state. Watchdog log suppresses actions on stale dead life, then switches to current session. Same-session idle advancement proved again after reboot (C10). `check-7b.log`, `check-7-shared-and-live.log`.

### C8 — Smoke test and exact recall-probe block, lines 1933–1939

First required wake/write/find request **from actual app UI**:

```text
UI login: chat shell loaded
UI POST /api/message HTTP 200
wake: # Wake — ... 2026-10-17 11:40:48 UTC
write: Wrote event 1 (kind=observation, weight=light, embedded=1)
find: Found 1 events:
[1] ... SYNTHETIC installation test data: cobalt lantern app memory check
mcp__app__reply: Sent: Memory check done with real tool calls. ...
```

Matching outbox `447d9c64-7979-4b91-97e8-258fe97d9439`. App `/status` separately returned intended head/model/transport, window 1000000, warn 800000, cut 900000 in outbox `brain-1792237259507-fgt01w`.

Then exact 1928–1931 preparation and 1936–1938 commands:

```text
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
wake: # Wake — ... 2026-10-17 11:41:25 UTC
write: Wrote event 2 (kind=observation, weight=light, embedded=1)
find: Found 2 events:
[1] ... cobalt lantern app memory check
[2] ... SYNTHETIC installation test data: cobalt lantern memory check
recall: RAG recall: 7 hits
[1] InstallCheck_1.md#0 (1.00)
# Installation recall probe
This synthetic installation check verifies hybrid archive search and recall.
The probe phrase is cobalt lantern recall check. It is test data, not an experience.
mcp__app__reply: Sent: Memory and recall check done with real tool calls. ...
```

Matching outbox `6b703357-d08a-47ed-9b5c-10a2673347d3`. Separate new browser question then answered through real reply (C6b-inlet). Real cut-transcript recall also passed (C6b-cut). `check-8-app-memory.log`, `check-8-app-status.log`, `check-8-recall-probe.log`; full conversation `role:tool` results. Session events truncate long results; conversation records retain full content.

### C9b — Both doctors, lines 2024–2029

Before first start:

```text
{"ok":true,"checks":[{"name":"head","ok":true,"detail":"api / claude-sonnet-5-5 / api (environment)"}, ...]}
preflight exit=0
```

Includes RAG config/no uploads owed, writable inbox parent and system bus. Informational warning: no configured web-search backend; optional search not needed. Later preflight also passed.

Shared doctor after start/cut:

```text
[OK] EMBERVY_URL reachable
[OK] EMBERVY_API_KEY valid
[OK] RAG_URL reachable
[OK] RAG_AUTH_TOKEN valid ... 4 files indexed
[OK] Memory daemon and dream — daemon: never — not due yet; dream: successful run within 26 hours
[OK] Memory worker rejects unauth — HTTP 401
[OK] RAG rejects unauth — HTTP 401
[SKIP] Hybrid search — no readable session header with usable THEMES — no question to probe
[SKIP] FTS5 (BM25) ready — same reason
[SKIP] Reranker active — same reason
[SKIP] Inlet returns context — same reason
[SKIP] Claude headless canary — active substrate is brain
[OK] House MCP servers — 2/2 configured (static configuration only)
[OK] EMBERVY.md present — 31 lines
[OK] System prompt loaded once — EMBERVY.md only
[OK] Inlet wired (Brain runs it every turn)
[OK] Brain notebook directory
[OK] Notebook index
[OK] State dir writable
[OK] Disk space — 27% used ... 26.2 GB free
[OK] Swap — 4.0 GB (/swapfile)
[OK] No dangerous defaults
Result: PASS (17 checks passed, 0 warn, 0 fail, 5 skip)
doctor exit=0
```

Did not count skips as content passes. Used the documented 2040–2048 verified-query remedy, not invented THEMES:

```text
$ DOCTOR_PROBE_QUERY='cobalt lantern recall check' bun shared/tools/embervy-doctor.ts
[OK] Hybrid search — mode=hybrid, counts: vector 13, bm25 12
[OK] FTS5 (BM25) ready — 12 BM25 hits
[OK] Reranker active — top source: [vector, bm25, rerank]
[OK] Inlet returns context — 2444 bytes, retrieved hit found
Result: PASS (21 checks passed, 0 warn, 0 fail, 1 skip)
doctor explicit-query exit=0
```

Only irrelevant Claude canary skipped. `check-9b-preflight.log`, `check-9b.log`, `check-9b-explicit-query.log`.

### C9-sweep — Finished-house sweep, lines 2062–2091

Complete guide Python scan ran against live house/user JSON, worker TOML and systemd units, then token checker:

```text
placeholder sweep: clean
memory bearer: match
memory URL: match
archive bearer: match
archive URL: match
app internal bearer: match
app push bearer: match
Brain memory bearer: match
Brain archive bearer: match
Brain memory URL: match
Brain archive URL: match
Brain app bearer: match
memory: authenticated 200
archive: authenticated 200
```

`check-9-finished-sweep.log`. Archive-header placeholders were separately handled above; not live configuration placeholders.

### C10 — Reboot Brain block, lines 2124–2130; follow-ups 2132–2138

Issued actual `reboot`. SSH temporarily refused, then returned. No manual service starts, tmux recreation, login fix or state surgery after boot.

```text
2026-10-17T11:44:05+00:00
boot_id:27c14cda-8d75-46c0-9a97-8baedb5ce5dd
active
active
active
{"ok":true}
{"pid":994,"session_id":"1792237417071-o4zk0z","head":"api",
 "model":"claude-sonnet-5-5","transport":"api","tokens":17756,
 "warn_tokens":800000,"cut_tokens":900000}
/swapfile file 4G 0B -2
inactive
inactive
```

Active order app/Brain/Brain watchdog; inactive Claude loop/watchdog. Actual boot ID changed; old ID/state preserved in `pre-reboot.txt`.

**Independent boot-greeting proof:** new session `session_started` 11:43:37.633Z; `bridge_loaded` 11:43:45.959Z (11545 characters); real `mcp__app__reply` greeting 11:43:51.407Z; matching outbox `579738d9-1c0f-4f4d-8226-b97aa7d40134` at 11:43:51.397Z. It mentioned previous Session_3 recall and saved note. Not inferred from the later user response.

**Fresh app-message proof:** Chromium login/textarea/Send; POST 200, incoming ID `13e0ea5c-6e3c-4886-9860-92af48c665c2`. Real read_file returned persisted Notes index, list_dir showed its target, then real tool reply and matching outbox `911ed40c-a95d-4eac-a1d9-a495df184617`:

```text
reboot app check
First clock line in this life: "⏰ UTC: Saturday, 17.10.2026, 11:43".
... first one in this turn is "⏰ UTC: Saturday, 17.10.2026, 11:44".
Installation-check note index: available ... [Installation check](installation-check.md)
```

Settled Chromium check showed those words in **visible rendered chat**, not just DOM/terminal. Public-hostname access skipped.

External watchdog, idle in same boot/life:

```text
active
active
last_check_ts:2026-10-17T11:44:36.926750+00:00
session_id:1792237417071-o4zk0z tokens:19759 cut_tokens:900000 pid:870
[65-second sleep]
last_check_ts:2026-10-17T11:45:37.074073+00:00
session_id:1792237417071-o4zk0z tokens:19759 cut_tokens:900000 pid:870
```

`check-10-reboot.log`, `check-10-app-message.log`, `check-10-watchdog.log`, `rendered-ui-investigation.log`, actual current-life tool results/outbox.

## 4. Final functional answers

- **App answer? Yes, after the temperature workaround.** Real browser submission, genuine app reply tool, matching outbox and visible rendered chat. Exact no-prefix tool-channel test passed. Neither terminal prose nor fallback counted.
- **Memory write and recall? Yes.** Real write/find confirmed events 1 and 2. Real memory recall reached paired archive and returned InstallCheck_1.md/probe text. Automatic inlet independently returned it.
- **Cut archive findable again? Yes.** Controlled SIGTERM uploaded Session_3.md, retained local Markdown, wrote bridge and next-life bridge_loaded; real post-cut recall returned its text. No forced kill.
- **Everything back after reboot? The tested domainless stack, yes.** Automatic app/Brain/watchdog, independently verified startup greeting, fresh app tool reply, persisted notebook/bridge/swap and advancing watchdog; other harness inactive. Public app/tunnel, subscription heads, optional modules and nightly schedules remain untested/skipped.

## 5. Duration and cost

Started (UTC): **2026-10-17T11:29:40.701514+00:00**. Report assembly (UTC): **2026-10-17T11:52:40.429427+00:00**. Elapsed to assembly: **23.0 minutes**. Initial read-only SSH inspection began at 11:29:23 UTC. This includes package installation, all checks, cut/reboot and reporting, not only model latency.

### OpenRouter — measured whole-key usage

Before: **$<key total>**. After: **$<key total>**. Difference: **$0.003307350** (about 0.33 US cents).

Authenticated GET `/api/v1/key`, sampled before model activity and after the final model-based check. Private raw metadata: `openrouter-before.json`, `openrouter-end.json` (earlier intermediate sample retained as `openrouter-after.json`). The delta includes manual dream, inlet/classifier and explicit-query doctor. It is a whole-key delta; concurrent unrelated usage would also be included. No such use was initiated by this test.

### Anthropic head — summed visible usage

| Life | Responses | Input tokens | Output tokens |
|---|---:|---:|---:|
| `1792237005213-aesdxc` | 13 | 202,863 | 2,029 |
| `1792237148918-oono3h` | 16 | 322,721 | 2,047 |
| `1792237326010-wk19o9` | 5 | 100,939 | 794 |
| `1792237417071-o4zk0z` | 5 | 93,453 | 1,070 |
| **Total** | **39** | **719,976** | **5,940** |

All recorded cache-read/cache-write counts were zero. Every `type:usage` event in every Brain session log was summed, deduplicated by response ID; includes internal greetings and app/terminal turns. The HTTP 400 has `usage_coverage:failed_request_no_usage`, not a fabricated zero-token response; excluded because no usage was returned. Full per-response ledger: `head-usage-ledger.jsonl`; totals: `usage-summary.json`. No extra head calls were made solely to estimate cost.

**Dollar-accounting limitation:** normal supplied Anthropic key/model metadata and Brain logs do not expose billed dollar totals or prices for `claude-sonnet-5-5`. Both model-list/detail responses have no pricing fields. I report the exact requested token counts, not an invented dollar amount. At contracted rates I dollars per million input tokens and O dollars per million output tokens, measured combined model cost is **$0.003307350 + 0.719976 × I + 0.005940 × O**. An exact combined USD total, or independently verified dollar-cap assertion, cannot be obtained from these logs alone. The run used under one million input tokens and six thousand output tokens; no scheduled model activity or uncontrolled loops.

**Cloudflare:** no purchases, paid-plan changes, payment-method additions or billing edits. Only tiny test resources and checks were used; no paid feature was required/enabled by the run. This is not a billing-export audit. Supplied VPS hosting is outside model-key usage.

Both cron schedules remain empty. Installed app/Brain/watchdog remain running but idle; no further messages or jobs scheduled. Synthetic note, two observations, probe and session archives retained for inspection. Nothing pre-existing was deleted.

P4 verification: Git tracked-file count after installation = **0**.

Guide SHA-256: `1c1118ae993bc8f8cf5830b8b22a6d2d95def7a95d96dceedef609a3a38f7504`.

Final validation/end (UTC): **2026-10-17T11:53:37.599195+00:00**. Whole run through final validation: **23.9 minutes** (about 24.2 minutes including initial read-only SSH inspection). Final OpenRouter key resample: **$<key total>**, final before/after delta **$0.003307350**. This supersedes the earlier $0.002982430 interim difference. Later key totals increased slightly while reporting; the final whole-key delta includes this increase, which normal-key metadata cannot distinguish between delayed settlement and other concurrent use. There were no additional head responses: final reaggregation remains 39 / 719,976 input / 5,940 output.

Reporting-instrumentation note: the first report-generation SSH command failed from shell quoting before creating the report. It was corrected by sending Python through SSH stdin; this was not an installation-guide failure or an additional model request.
