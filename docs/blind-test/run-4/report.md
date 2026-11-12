# Embervy manual installation blind test — Brain / API head

## Scope and verdict

**The Brain house was installed successfully and survived a real host reboot.** The selected API head answered human messages through the app, wrote and retrieved memory, recalled both the synthetic archive probe and a transcript produced by a controlled cut, and delivered a live reply in the actual browser UI after reboot. No implementation/source-code patch was needed. There are non-blocking documentation/configuration rough edges below; this is not a claim that every optional feature was tested.

- Server: disposable Debian 13 VPS, accessed as `root@<test-server>`. All installation, HTTP requests, browser installation/driving, evidence collection and report writing happened **on this server**. No packages or project files were installed/changed on the starting machine.
- Unpacked source: `/root/embervy-src`; installed house: `/opt/embervy`. Used the unpacked-repository alternative in INSTALL.md: `cp -a`, then `git init`. No commits or pushes.
- Reference: original `INSTALL.md`, 2,207 lines. All line numbers below refer to that unchanged file. SHA-256: `756e9b1a1814690ac531a352ad9dea64c6bd4db02aa495ebb9068524b041d276`.
- Harness: Brain, `BRAIN_HEAD=api`; endpoint `https://api.anthropic.com/v1/chat/completions`; model `claude-sonnet-5-5`; supplied `ANTHROPIC_API_KEY` copied privately into `BRAIN_API_KEY`. The authenticated model-list request returned **`max_input_tokens: 1000000`**, which was set as `BRAIN_CONTEXT_WINDOW`. Observed warn/cut: **800000 / 900000**. No temperature override.
- OpenRouter supplied the memory/dream and inlet key. Wrangler stayed at **3.114.17**, Bun at **1.3.14**. The newer-Wrangler warning was intentionally ignored as instructed.
- All three workers use the supplied Cloudflare account and account-level `workers.dev` URLs. R2, D1, Vectorize and Workers deployment succeeded without purchases or plan/billing changes. No resources were deleted.
- No domain/zone, public app hostname, tunnel or phone/PWA pinning: **skipped under the task's explicit exception**, not presented as a public deployment. App testing used `http://127.0.0.1:3030` inside the server.
- No Claude/ChatGPT subscription: Claude pipe setup, step 6a, step 6c and subscription-only header enrichment were skipped. API transcripts retained placeholder header fields as the guide predicts.
- Memory daemon and dream schedules were deliberately `crons = []` for cost control. A **manual dream was run successfully**. The daemon itself was not exercised; `daemon_last_run: null` is expected for this test.
- UTC was the configured house timezone everywhere. The clock was compared against the actual UTC clock. A non-UTC/DST timezone was not tested.

## 1. Step result table

`fixed by me` means a concrete adjustment/workaround is identified below; it does not mean an implementation patch was made.

| Step | Result | One-line outcome |
|---|---|---|
| 0 — prerequisites | ok | Debian packages, pinned Bun/Wrangler, Cloudflare authentication and root/Linux check passed. |
| 0 — domain prerequisite | skipped | No zone/domain supplied; no registration, tunnel or public hostname attempted. |
| 1 — unpacked repository | ok | Copied to unused `/opt/embervy`, initialized Git, both Git checks passed. |
| 2 — archive worker | ok | Bucket/index/D1/schema/secret/deploy passed; unauth 401, authenticated empty list 200. |
| 3 — memory worker | ok | All bindings/secrets deployed; real protected `wake` passed; push token generated ahead of step 5. |
| 3b — dream worker | ok | Same memory D1 and archive service binding; manual dream 200 and non-null `dream_last_run`. |
| 3/3b — scheduled daemon/dream | skipped | Cron arrays intentionally empty, as allowed by the task. |
| 4 — VPS runtime | ok | Runtime dependencies, 4 GiB persistent swap, 2 GiB ballast and log rotation passed. |
| 5 — app | ok | Foreground start, login boundary and systemd restart checks passed after the documented startup wait. |
| 5 — public HTTPS / phone | skipped | Local app was tested; no claim about tunnel, public HTTPS or pinned phone operation. |
| 6 — harness exclusion | ok | Both harness pairs initially inactive; Claude pair remained inactive after reboot. |
| 6b — identity / API files | ok | Real read of customized EMBERVY.md, correct headings/tools and clock, with app tool reply. |
| 6b — notes | ok | Real write/edit/readback, correct index-relative link and on-disk file; app reply matched. |
| 6b — loop service | ok | Restart produced a new PID/life, archived prior life by catch-up and answered a fresh app message. |
| 6b — app channel | ok | Running absolute MCP path; genuine `mcp__app__reply` result and exact outbox entry. |
| 6b — inlet | ok | Current-life injection included the actual probe; fresh app answer used it. |
| 6b — memory/chronicle wiring | ok | Every root/app/MCP/Brain comparison matched; both workers authenticated 200. |
| 6b — First start | ok | Real document reads and greeting, then fresh app hello/tool reply; state tokens increased. |
| 6b — subscription header enrichment | skipped | Omitted `BRAIN_HEADER_ENRICH_CMD` and the Claude subagent link; no subscription login available. |
| 6b — controlled cut | ok | `TERMINATED`, fresh bridge, next-life `bridge_loaded`, `Session_2.md` upload and real recall passed. |
| 6a / 6c / 7a / 9a | skipped | Other harness and unavailable subscription branches, not part of the selected Brain/API path. |
| 7 / 7b — watchdog | ok | Bound service started with Brain and external `last_check_ts` advanced while idle. |
| 8 — smoke and recall probe | ok | App-origin wake/write/find, exact guide probe upload, explicit agent recall and separate app message passed. |
| 9b — Brain preflight | ok | Before first start and after runtime wiring: `ok:true`, exit 0. |
| 9b — shared doctor | ok | Initial documented header-dependent skips; known-query rerun and post-reboot rerun passed all applicable checks. |
| 9 — finished-house sweep | fixed by me | Removed unused VAPID subject template; sweep became clean and token check still passed. |
| 10 — actual reboot | ok | New host boot and Brain session, services/swap returned automatically, greeting and live browser answer verified. |
| API-only UI optional sign-in probe | failed | `/api/claude-auth` repeatedly returns 503 without a Claude sign-in helper; non-blocking for API chat. |

## 2. Problems, exact locations, and recommendations

### P1. An unused optional Web Push default fails the required final sweep

**INSTALL.md sections/lines:** step 5, lines **500–503**, **524–527**, and final finished-house Check, lines **2081–2116** (especially the marker regex at **2095**).

**What happened:** I copied the app template, filled the required values, and skipped optional Web Push as lines 525–527 permit. The copied template still had `VAPID_SUBJECT=mailto:agent@example.com`. The exact final sweep printed:

```text
/opt/embervy/Claude/app/.env:54: review template marker
placeholder sweep: review required
sweep exit=1
```

This was a real failed check, not a worker/app authentication failure. The guide does generally say to remove unused placeholders in step 9; the rough edge is that the earlier instruction to skip this optional feature leaves a default that is guaranteed to require that cleanup.

**What I did:** replaced that one unused line with a comment, `# VAPID_SUBJECT omitted: Web Push not enabled`. No VAPID keys were generated and browser push remained disabled. Re-ran the exact sweep and token checker: `placeholder sweep: clean`; all comparisons matched and both remote checks returned authenticated 200. The app had already started successfully with push disabled; no service repair was needed.

**What the guide should say:** next to “Skip if you don't need browser push notifications”, explicitly say to remove/comment `VAPID_SUBJECT` too, or ship the optional subject commented/empty in the template. Keep the final sweep.

### P2. The manual controlled-cut command does not produce the cutoff log named in step 7b

**INSTALL.md sections/lines:** 6b “Cut and watchdog”, command at **1377**; 7b diagnostic prose at **1878–1882**.

**What happened:** I ran exactly `bash "$EMBERVY_HOME/Brain/scripts/brain-cutoff.sh"`. The cut itself passed: clean termination and bridge, with successful remote upload. But the guide's next diagnostic location, `Brain/logs/brain-cutoff.log`, did not exist. My attempt to read that named path with Python `Path(...).read_text()` raised:

```text
FileNotFoundError: [Errno 2] No such file or directory:
'/opt/embervy/Brain/logs/brain-cutoff.log'
```

**Why:** `Brain/scripts/brain-cutoff.sh:35–76` writes its diagnostics to stdout and never opens this log. Only the external watchdog caller redirects into it (`Brain/scripts/brain-watchdog.sh:157`). Thus an automatic watchdog cut would have the file, but the prescribed manual controlled cut need not.

**What I did:** retained the actual stdout in `/root/blindtest-evidence/commands.log`; verified `Brain/state/last-cut-result`, current-life events, the bridge load, local archive and authenticated remote list/recall instead. I did not create a fake cutoff log or patch either script.

**What the guide should say:** distinguish automatic-cut logging from manual invocation. For a retained manual log, show `bash .../brain-cutoff.sh 2>&1 | tee -a "$EMBERVY_HOME/Brain/logs/brain-cutoff.log"` with pipeline exit handling, or tell the reader to use its terminal output and `last-cut-result`. Do not imply this file always exists after the manual Check.

### P3. API-only UI makes repeated unavailable Claude sign-in probes

**INSTALL.md sections/lines:** step 4 permits API-only operation without Claude Code at **436–441**; step 5 asks the reader to open/login to the chat shell at **621–623**; 6b API profile says no Claude login is needed at **1194–1197**.

**What happened:** the actual logged-in browser UI loaded the chat shell and worked, but repeatedly requested `GET /api/claude-auth`, yielding:

```text
503 {"error":"The Claude sign-in state is unavailable."}
```

This also appeared as repeated HTTP 503 resource errors in browser console/network observations. The client calls `pollClaudeAuth()` and schedules it every three seconds (`Claude/app/public/app.js:3194–3195`); the request is at line 3136. No Claude helper/CLI/subscription was configured on this deliberately API-only house.

**What I did:** did not install Claude Code, sign in, or change the head just to remove this error. Continued with the configured API head, proved actual tool results/outbox delivery, and ultimately proved a live browser answer. Left this optional-endpoint diagnostic unfixed.

**What the guide should say:** explain that this optional sign-in endpoint may be unavailable on an API-only house and is not a failure of the selected head, or preferably make the client skip polling it unless applicable. A newcomer otherwise sees apparently failing requests in an installation the guide explicitly supports.

### P4. Minor forward-reference friction: app-push bearer is requested before app secrets exist

**INSTALL.md sections/lines:** memory secret entry at **270**, explanation at **288**; app token map at **512–522** and house-file preservation at **589–602**.

**What happened:** `wrangler secret put APP_PUSH_TOKEN` in step 3 needs the exact later `EXTERNAL_PUSH_TOKEN`, but this first value has not been generated/saved by any preceding command. The comment correctly states the later equality, so this is **not a broken command or missing token map**, just an avoidable planning step for a careful newcomer following the order.

**What I did:** generated one strong value in step 3, saved it privately as `EXTERNAL_PUSH_TOKEN` in root `.env`, sent it to the worker as `APP_PUSH_TOKEN`, and reused it in the app env in step 5. Never printed it. No replacement token was generated later. All local token checks passed.

**What the guide should say:** add a generate/save/secret-put snippet at step 3 for this pair, analogous to the adjacent memory/archive bearer snippets. This removes the need to plan step 5 before finishing step 3.

### Expected/documented conditions, not defects

- Immediate HTTP requests after `systemctl restart embervy-app` returned connection refused/`000`; after the explicitly permitted three-second wait they returned the expected values. Likewise the immediate Brain restart pane capture saw no tmux server, then the documented wait produced the new life. These are recorded below, not called undocumented blockers.
- Default shared doctor skipped retrieval with unenriched session headers. Lines 2059–2068 explicitly explain this and provide `DOCTOR_PROBE_QUERY`; using the known, actually stored phrase made the probes pass. No invented THEMES, threshold lowering or subscription workaround was used.
- The initial house had no daemon run. That was deliberately allowed by the task; manual dream success does not prove daemon operation.
- No content-bearing personal memories were imported. All observations/probe fixtures were explicitly synthetic.

## 3. Automation, deviations and omissions

These distinguish test instrumentation from repairs to the installation.

1. Used the one-machine role allowed by lines 52–55 and unpacked-source alternative at 124–127. All commands ran over SSH on the server. `id -u; uname -s` replaced the example SSH-to-VPS check as expressly permitted.
2. Supplied credentials were read privately from `/root/blindtest.env` as data for the SSH-run shell, instead of interactive `read` prompts. Subsequent house/app/profile loads used the supplied env-file helpers; never `source .env`, never shell tracing. `$EDITOR` operations were performed through explicit remote file edits, preserving matching secrets. The original source tree was not patched.
3. Ran the app's first foreground process in a remote tmux terminal, checked its log, then sent Ctrl-C and installed the exact systemd service. For non-interactive SSH, captured the Brain tmux pane rather than leaving an attached terminal blocking the audit. This does not replace model/tool checks.
4. Used authenticated `/api/auth` → session cookie → `/api/message` for app-origin HTTP messages, with the request format verified in repository `Claude/app/server.ts:1053–1102,1130–1179`. Did not inject a fake inbox/outbox entry. Cookies were held privately, not printed. POST acknowledgement alone was not counted as an answer.
5. To satisfy the actual UI check, installed the **repository-provided** optional browser tooling using `EMBERVY_BROWSER_HOME=/root/blindtest-evidence/browser bash shared/tools/browser/install.sh`. This was test instrumentation outside the house, not enabling the agent browser module: `EMBERVY_BROWSER=0` and the API write allowlist remained notes-only. Installer reported Playwright 1.64.0, Chromium 156.0.8078.4, `browser_available=1`. Logged in through the actual password form and clicked the Send button. Screenshot artifacts remain on the server.
6. Preliminary browser automation attempts (including pressing Enter instead of clicking Send, and insufficient/inconclusive live-observation waits) were not counted as successful sends/replies or as installation defects. Subsequent actual button submissions have HTTP acknowledgement plus genuine Brain tool/outbox records. The final exact-text locator observed a new answer arrive live in **4.93 seconds**, with its WebSocket message frame; no reload was needed for that final pass. Previously persisted replies also appeared after login/reload.
7. Domain, public HTTPS, tunnel, phone pinning, subscription paths/header enrichment, optional mail/media/voice/weather/calendar/web-search features were not enabled. No claim is made about them. The optional public-hostname part of step 10 was replaced only for this expressly domainless test by browser UI on server loopback.
8. Preserved synthetic archive fixtures and all created resources. No cleanup deletes. Brain, app and watchdog are left enabled/running; cron schedules and cache ping are off. The final idle house should not make further head turns without input.

## 4. Ledger of every applicable Check block

Outputs below are real, shortened excerpts. Empty successful output is explicitly marked. Full collected stdout/stderr is in `/root/blindtest-evidence/commands.log`, with additional apt/browser logs beside it. Secret values are not included. Checks were run at their prescribed readiness gates, not all in numerical reading order.

### C00 — Step 0, Check lines 99–113

```text
wrangler whoami:
  logged in with an Account API Token
  account: <cloudflare-login-email>'s Account (the supplied account)
bun --version: 1.3.14
python3 --version: Python 3.13.5
git --version: git version 2.47.3
openssl version: OpenSSL 3.5.7 9 Jun 2026
id -u: 0
uname -s: Linux
```

Pinned Wrangler version command printed `3.114.17`; install succeeded. Wrangler's upgrade warning was expected.

### C01 — Step 1, Check lines 136–144

```text
git -C "$EMBERVY_HOME" rev-parse --show-toplevel:
/opt/embervy
git -C "$EMBERVY_HOME" diff --check:
[no output; success]
```

This is a newly initialized unpacked tree, not a clone with committed history; the guide explicitly allows this alternative.

### C02 — Step 2, Check lines 233–243

```text
wrangler secret list: RAG_AUTH_TOKEN (secret_text)
unauthenticated GET /list: 401
authenticated GET /list:
{"files":[]}
200
```

### C03 — Step 3, Check lines 327–338

```text
wrangler secret list:
APP_PUSH_TOKEN, EMBERVY_API_KEY, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
unauthenticated POST /mcp (wake): 401
authenticated POST /mcp (wake):
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"# Wake — Saturday, 17/10/2026, 12:47 (2026-10-17 12:47:04 UTC) ..."}]}}
200
```

The actual text included `Mood: initial`, `memory bootstrapped`, empty surfaces/todos/observations and `Last successful run: never`. It was a real bound-D1 result, not health-only.

### C03b — Step 3b, Check lines 396–406

```text
wrangler secret list: DREAM_AUTH_TOKEN, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
unauthenticated POST /dream: 401
authenticated POST /dream:
{"status":"dreamed","content":"While you were away, the silence hummed like an unopened door. ... [dreamt associatively — check what resonates]"}
200
memory /health:
{"version":"0.3.0","hot_count":0,"archive_count":0,"unresolved_observations":0,
 "daemon_last_run":null,"daemon_last_ok":false,
 "dream_last_run":"2026-10-17 12:47:36","daemon_mode":"normal",
 "backlog_cursor":0,"warnings":["daemon never ran"]}
```

Manual model call and D1 write succeeded despite empty schedules. Dream prose is generated content, not evidence of real experiences.

### C04 — Step 4, Check lines 477–490

```text
1.3.14
/opt/embervy
NAME      TYPE SIZE USED PRIO
/swapfile file   4G   0B   -2
Mem: 3.7Gi total, 425Mi used, 3.3Gi available
Swap: 4.0Gi total, 0B used
/dev/sda1 38G 8.7G 28G 25% /
logrotate --debug:
reading config file /etc/logrotate.d/embervy
Handling 1 logs
... missing log files ... does not exist -- skipping
```

No logrotate configuration error. Fresh `/var/lib/logrotate/status` absent was diagnostic, not a failure. Swap persisted after reboot (C10).

### C05a — Step 5, initial app Check lines 611–623

```text
GET /api/internal/model without bearer: 401
POST /api/auth with configured password:
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
Content-Type: application/json
GET /: 200
first foreground log: embervy-app: HTTP server on http://127.0.0.1:3030
```

Actual browser login and chat shell were also exercised later; title `Embervy App`, password form, chat history and `textarea#input` loaded. Public HTTPS was skipped.

### C05b — Step 5, restart Check lines 722–734

```text
systemctl restart embervy-app && systemctl is-active embervy-app:
active
immediate GET /health:
curl: (7) Failed to connect to 127.0.0.1 port 3030 ...
immediate authenticated model request: 000

repeat after 3 seconds, as instructed:
{"ok":true}
200
repeat login: HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; ...
```

### C06 — Step 6, exclusion Check lines 752–766

```text
systemctl is-active embervy-loop embervy-watchdog embervy-brain embervy-brain-watchdog:
inactive
inactive
inactive
inactive
exit=4
```

Nonzero status is expected here per the guide. After reboot, the two Claude units were still inactive.

### C06-file — 6b API file tools Check lines 1234–1244

Ran the exact tmux prompt. Real conversation tool records:

```text
read_file /opt/embervy/EMBERVY.md -> actual customized identity (46 lines)
mcp__app__reply -> Sent: I read EMBERVY.md in full. ...
```

Matching outbox id `7401a33c-3464-4682-9779-02f96d387f9a`. Reply listed all nine retained headings, unprefixed API memory tools and archive `recall`. It quoted `⏰ UTC: Saturday, 17.10.2026, 12:51`; comparison `TZ=UTC date` was `2026-10-17 12:51:45 UTC`. No template identity was claimed.

### C06-notes — 6b Notes Check lines 1270–1287

Ran the exact tmux prompt, then the exact index-link shell check.

```text
write_file -> wrote notes/installation-check.md
read_file -> # Notes
edit_file -> edited notes/NOTES.md
read_file notes/NOTES.md -> [Installation check](installation-check.md)
read_file notes/installation-check.md -> frontmatter + cobalt notebook check
list_dir -> NOTES.md, installation-check.md
Notes link target exists
mcp__app__reply -> Sent: Saved and verified. ... Saved content: "cobalt notebook check"
```

Frontmatter actually had `name`, `description`, `type`. File and index were read on disk by the tester too. Matching outbox id `6b6a8921-c008-4338-a30b-9404185d45b7`. No Lore write occurred in this turn.

### C06-loop — 6b Loop service Check lines 1326–1338

```text
systemctl restart embervy-brain && systemctl is-active embervy-brain:
active
immediate state still old: pid 9457 / session 1792241468631-dkbfyt
immediate pane: no server running on /tmp/tmux-0/default

after instructed wait:
{"pid":10017,"session_id":"1792241666520-fxjdhi","head":"api",
 "model":"claude-sonnet-5-5","transport":"api","tokens":15193,
 "warn_tokens":800000,"cut_tokens":900000}
```

Fresh app request acknowledged as id `4918f3e6-ccda-4c47-a6af-7844f2201a5d`; genuine app tool/outbox reply: `restart app roundtrip passed`, outbox id `178160c4-1325-4e2a-a1a4-e7ee3665cc32`.

Prior life delivery was not inferred from restart status:

```text
catch_up_archived: session 1792241468631-dkbfyt, name Session_1, uploaded:true
bridge_loaded: characters 4571
/list: Session_1.md, size 3907
```

### C06-app — 6b App channel Check lines 1485–1497

```text
configured command: bun run /opt/embervy/Claude/app/mcp.ts
running process: 9465 bun run /opt/embervy/Claude/app/mcp.ts
actual role=tool, name=mcp__app__reply:
Sent: installation app-channel check
outbox text: installation app-channel check
```

Tool call id `toolu_01CjnsqPoKN9ikDD2oF1ZrJx`; matching outbox id `d96a791c-5cfb-47dd-ac59-ace6f8c770c0`. This is exact text, with no gateway/lightning prefix. The queued terminal test is supplemented by real human app submissions elsewhere in this ledger.

### C06-inlet — 6b Inlet Check lines 1530–1542

After the step 8 probe, sent a **new app message** asking the actual phrase in `InstallCheck_1.md`, then ran the exact grep/tail commands. Relevant current-life output:

```text
{"ts":"2026-10-17T12:56:12.495Z","type":"inlet_injected","via":"worker",
 "characters":1372,"block":"<inlet>\n## Chronicle (RAG)\n[InstallCheck_1.md] (100% [vector+bm25+rerank]) ... cobalt lantern recall check ..."}
```

New app tool reply/outbox id `afefabf7-5e95-4b64-8bae-439de7f377a8` gave the correct phrase and explicitly identified synthetic test data. Earlier empty-archive log lines were also visible:

```text
[inlet/rag] confidence gate suppressed all hits; turnFloor=0.25 topScore=none queries=...
```

Those earlier empties were legitimate on an empty archive. No `inlet_worker_failed` was counted as a pass; no retrieval thresholds were lowered.

### C06-token — 6b Memory and chronicle Check lines 1595–1605

Before first start, `bun state/install-token-check.ts` printed:

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

Same output passed again at the finished sweep and after reboot. This is not a claim of reading Cloudflare secret values; actual worker requests test remote authentication.

### C06-first — 6b First start Check lines 1680–1691

First-start real tool results read INFRASTRUCTURE.md and HANDBOOK.md fully, then:

```text
2026-10-17T12:51:15.060Z role=tool name=mcp__app__reply
Sent: Hello, I'm Ember. This is my first start in this house. I've read INFRASTRUCTURE.md and HANDBOOK.md in full and changed nothing. ...
```

Matching greeting outbox id `46de1ad2-6a57-4388-a530-d27441b448c2` was checked separately. After listening, human app message `hello` was acknowledged as `d31eb097-616a-4b70-a6cf-3a1aef466527`; real reply `Hello, Tester. I'm here and ready for the next check.` matched outbox `8dc3936b-80e9-4bfa-a467-0f13fa5eb2bb` (with reply-to linkage).

```text
systemctl is-active embervy-app embervy-brain embervy-brain-watchdog:
active
active
active
{"pid":9457,"session_id":"1792241468631-dkbfyt","head":"api",
 "model":"claude-sonnet-5-5","transport":"api","tokens":18536,
 "warn_tokens":800000,"cut_tokens":900000}
brain-watchdog.sh --check-alive 9457: 1
```

The state rose from 18219 tokens before the hello to 18536 after it. No login/permission prompt.

### C07-common — Step 7 common Check lines 1768–1775

Ran the explicitly specified Brain substitution:

```text
systemctl is-active embervy-brain-watchdog:
active
```

### C07b — Step 7b Check lines 1884–1897 and diagnostic commands at 1865–1869

```text
systemctl is-active embervy-brain embervy-brain-watchdog:
active
active
first read:
{"last_check_ts":"2026-10-17T12:52:08.580725+00:00",
 "session_id":"1792241468631-dkbfyt","tokens":17915,"cut_tokens":900000,"pid":9402}
after sleep 65:
{"last_check_ts":"2026-10-17T12:53:08.739945+00:00",
 "session_id":"1792241468631-dkbfyt","tokens":18219,"cut_tokens":900000,"pid":9402}
```

Diagnostic `systemctl status` showed both services running; watchdog log showed startup interval 60 seconds and `now watching session 1792241468631-dkbfyt`. Brain context had live Brain PID 9457, model/api transport and window 1000000. **External watchdog state `pid` is the watchdog's own PID**, not Brain's PID; the session and thresholds matched Brain state. These readings came from `Brain/state/watchdog_state.json`, not just the separate app-compatible file.

### C08 — Step 8 app smoke and Check lines 1952–1979

First sent an app-origin wake/write/find request after listening. Actual tools returned:

```text
wake -> # Wake — Saturday, 17/10/2026, 12:55 ...
write -> Wrote event 1 (kind=observation, weight=light, embedded=1)
find -> Found 1 events:
[1] ... SYNTHETIC INSTALLATION-TEST DATA, not an experience: cobalt lantern app memory check
mcp__app__reply -> Sent: Memory check done. ...
```

Human request id `8015ee12-4919-4fa8-ba83-1a8c0eada948`, matching tool-backed outbox id `89e85623-6637-4d61-a236-14ef30c870d8`.

Then created the guide's exact labelled fixture and ran the exact upload/tmux Check:

```text
POST /upload, filename InstallCheck_1.md:
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
wake -> real 12:55:37 UTC time line
write -> Wrote event 2 (kind=observation, weight=light, embedded=1)
find -> Found 2 events:
[2] ... cobalt lantern memory check
[1] ... cobalt lantern app memory check
recall -> RAG recall: 6 hits
[1] InstallCheck_1.md#0 (1.00)
# Installation recall probe
This synthetic installation check verifies hybrid archive search and recall.
The probe phrase is cobalt lantern recall check. It is test data, not an experience.
```

The full real recall result's numeric score was `0.9988126754760742`. Its tool call id was `toolu_016YD2ZyrsbRBvAJU8asEaBB`. The actual app reply matched outbox id `374d50da-0608-41b1-b067-b81aa7f43724`. This exercised memory-worker-to-archive authentication/service binding, not only direct archive HTTP.

The separate new app question is C06-inlet. An app `/status` then returned actual selected head/model/api transport, `window: 27011/1000000`, warn 800000/cut 900000. It is a local command response, **not** counted as a model tool-backed reply. Current conversation/session files were inspected. The model's commentary about an approximately 0.5 find score was not treated as an installation problem: the actual requested observation was returned.

### C06-cut — Deferred 6b Cut and watchdog Check lines 1371–1391

Run idle after the smoke tests and at least three substantive turns:

```text
brain-watchdog.sh --decide ...:
none 27011 3 900000 10017 1792241666520-fxjdhi below thresholds
brain-watchdog.sh --check-alive ...:
1
brain-cutoff.sh:
=== brain-cutoff start 2026-10-17T12:56:33+00:00 ===
  Brain pid=10017
[1/3] SIGTERM → Brain archives itself (bridge + RAG export)
[2/3] waiting up to 180s for a clean exit
[3/3] clean exit
  bridge OK (9658 bytes)
  respawn delegated to brain-loop.sh
=== brain-cutoff done 2026-10-17T12:56:37+00:00 (TERMINATED) ===
```

Authenticated remote list, not just exit status:

```text
InstallCheck_1.md (191 bytes)
Session_1.md (3907 bytes)
Session_2.md (5188 bytes, uploaded 2026-10-17T12:56:34.470Z)
```

Real event proof:

```text
old life 1792241666520-fxjdhi:
  session_archive_upload: name Session_2, ok:true, parts:1
new life 1792241798920-sxuskp, pid 10454:
  bridge_loaded: characters 9634, jump_unit:false
```

Local `Brain/logs/sessions/Session_2.md` existed at 5188 bytes. Bridge was consumed/renamed as documented. No SIGKILL. See P2 for the absent manual-cut diagnostic file; the cut itself passed.

After the cut sent a **new app request** for explicit recall of real transcript content, `restart app roundtrip passed`. Actual `recall` returned `Session_2.md#0` and `Session_2.md#1` with that phrase and surrounding tester/agent exchange; scores were about 0.9990 and 0.9943. Matching real app reply/outbox id `55c7c5ed-7e7b-4b3e-affb-0d1fdd4102f5`. This was not just the bridge or the uploaded synthetic file.

### C09b — Step 9b Check lines 2043–2068

Preflight was run before the first deliberate start as required, and repeated after wiring:

```text
{"ok":true,"checks":[
 {"name":"head","ok":true,"detail":"api / claude-sonnet-5-5 / api (environment)"},
 {"name":"rag","ok":true,...},
 {"name":"rag-uploads","ok":true,"detail":"no RAG uploads owed"},
 {"name":"inbox","ok":true,...},
 {"name":"system-bus","ok":true,...},
 {"name":"web-backend","ok":true,"detail":"Warning: no usable search backend for this head — no web_search ... · web_fetch"}]}
preflight exit=0
```

Optional search backend warning was understood; no search provider requested for this install.

Initial shared doctor after runtime tests:

```text
Core/auth/security/adapter/notebook/disk/swap: [OK]
[SKIP] Hybrid search — no readable session header with usable THEMES — no question to probe
[SKIP] FTS5 (BM25) ready — same reason
[SKIP] Reranker active — same reason
[SKIP] Inlet returns context — same reason
[SKIP] Claude headless canary — active substrate is brain; this install has its own canary
Result: PASS (17 checks passed, 0 warn, 0 fail, 5 skip)
doctor exit=0
```

Then used the guide's documented `DOCTOR_PROBE_QUERY='cobalt lantern recall check'`, known to be in the archive:

```text
[OK] Hybrid search — mode=hybrid, counts: vector 12, bm25 11
[OK] FTS5 (BM25) ready — 11 BM25 hits
[OK] Reranker active — top source: [vector, bm25, rerank]
[OK] Inlet returns context — 2762 bytes, retrieved hit found
Result: PASS (21 checks passed, 0 warn, 0 fail, 1 skip)
doctor explicit query exit=0
```

The sole remaining skip is the other harness's canary. The same 21/0/0/1 result was obtained after reboot (`final doctor exit=0`). Static MCP checks were not substituted for actual tool round trips.

### C09-sweep — Finished-house Check lines 2081–2116

Executed the exact Python sweep copied from this block, plus its token checker:

```text
first sweep:
/opt/embervy/Claude/app/.env:54: review template marker
placeholder sweep: review required
sweep exit=1

after the P1 one-line optional-default cleanup:
placeholder sweep: clean
[all eleven token/URL groups: match]
memory: authenticated 200
archive: authenticated 200
```

Rechecked clean after reboot too. No secrets were printed by this sweep.

### C10 — Step 10 Brain Check lines 2143–2157, plus required greeting/message/watchdog checks

Issued **`reboot`**, SSH disconnected/unreachable during reboot, then reconnected. No manual service start. New kernel boot ID was verified against the saved old ID.

Initial post-reconnect output, before first model completion:

```text
systemctl is-active embervy-app embervy-brain embervy-brain-watchdog:
active
active
active
{"ok":true}
{"pid":1028,"session_id":"1792241925126-9zu2oc","head":"api",
 "model":"claude-sonnet-5-5","transport":"api","tokens":0,
 "warn_tokens":800000,"cut_tokens":900000}
Boot id changed: True
/swapfile file 4G 0B -2
other harness: inactive, inactive
```

Waited for the boot greeting rather than hiding initial zero tokens. Current-life proof:

```text
2026-10-17T12:58:54.278Z bridge_loaded, characters 11579
2026-10-17T12:58:59.805Z real mcp__app__reply tool result:
Sent: Hello, Tester. I'm back after the cut. Wake and the bridge both loaded. ...
```

Matching boot-greeting outbox id `ff6b850a-a381-4188-be0d-b50bc7fb5e1f`. No subscription login/permission prompt.

Then logged into the actual browser app and clicked Send. Human POST id `640a99a0-2e5d-4f29-b517-40b0c5bb7e7f`, actual reply tool result and outbox id `6a3d895c-2dac-49a5-abb9-c385855cf457`:

```text
Sent: cold boot browser roundtrip passed

⏰ UTC: Saturday, 17.10.2026, 13:06
```

This confirms a real postboot app-origin model turn and correct local UTC clock. Its persisted answer was seen in browser history too. To positively test **live** display, a final browser button submission, id `ea978188-a474-4ba9-9563-5ff778386277`, requested an answer token not already present in history. Actual browser evidence:

```text
Browser submit: 200 {'ok': True, 'id': 'ea978188-a474-4ba9-9563-5ff778386277'}
REAL LIVE UI ANSWER VISIBLE WITHOUT RELOAD: YES; wait seconds: 4.93
WebSocket message: {"type":"message","data":{"id":"0ffde567-60bf-42a6-9cef-46fb1d2d1f60",
 "text":"live delivery ack C8", ... "type":"reply"}}
```

The exact visible DOM text was `live delivery ack C8`. Real tool call id `toolu_013mAraDysaf6PzMrz3zPMBd` returned `Sent: live delivery ack C8`; matching outbox id is the same WebSocket message id above. No gateway fallback counted.

External advancing-state check after reboot:

```text
{"last_check_ts":"2026-10-17T13:05:45.633577+00:00",
 "session_id":"1792241925126-9zu2oc","tokens":17875,"cut_tokens":900000,"pid":903}
after sleep 65:
{"last_check_ts":"2026-10-17T13:07:45.999138+00:00",
 "session_id":"1792241925126-9zu2oc","tokens":19359,"cut_tokens":900000,"pid":903}
```

The script also called Brain liveness after reboot: `1`. Final state after all completed browser turns: live PID 1028, same new session, `tokens:22214`, model/api/thresholds unchanged. All three services active and health `{"ok":true}`. Swap still 4 GiB. The public hostname portion of this Check is explicitly untested because no domain was supplied.

## 5. Final outcomes, duration and cost

### Required end-to-end answers

| Question | Answer and evidence |
|---|---|
| Did the agent answer through the app channel? | **Yes.** Authenticated app-origin messages produced actual `mcp__app__reply` results and matching durable outbox entries; final postboot browser answer arrived live over WebSocket. |
| Did memory write and retrieval work? | **Yes.** Observation ids **1** and **2** were written and returned by real `find`; not inferred from model prose. |
| Did archive recall work? | **Yes.** Agent `recall` returned `InstallCheck_1.md#0` with the synthetic phrase, then `Session_2.md#0/#1` with real cut-life transcript text. |
| Did a cut produce a findable archive? | **Yes.** Controlled clean cut uploaded **Session_2.md**, confirmed in event log and authenticated remote list; explicit recall in the next life found it. Local archive and next-life `bridge_loaded` verified too. |
| Did everything selected come back after reboot? | **Yes.** App, Brain and bound watchdog started automatically, swap persisted, new session greeted through a real tool, then answered fresh browser messages; external watchdog advanced. Unselected modules/public access remain untested. |
| Were the cron services tested? | **Manual dream only.** Scheduled dream and daemon stayed disabled; daemon success is not claimed. |

### Time

- First server inspection: **2026-10-17 12:43:09 UTC**.
- Usage reconciliation after the final runtime checks: **2026-10-17 13:12:23.962879 UTC** — about **29 minutes 15 seconds** after first inspection.
- Report completed: **2026-10-17 13:16:46 UTC**; whole run including report preparation: **33 minutes 37 seconds**.

### Measured OpenRouter cost

Queried authenticated `GET https://openrouter.ai/api/v1/key` before prerequisite installation/model activity and after all runtime/doctor/browser tests. Used the cumulative `data.usage` field, not a rounded daily counter:

```text
before: $<key total>
 after: $<key total>
 delta: $0.003543980 USD
```

This key-wide delta includes dream/inlet/doctor classifier activity during the run. As with any cumulative shared-key meter, unrelated concurrent use of the same key would be included; I cannot separate activity outside this test. Raw responses are saved privately in `openrouter-before.json` / `openrouter-after.json` on the server.

### Anthropic head usage — every visible response/hop

Summed unique `type:"usage"` records with `head:"api"` across **all four Brain session logs**, deduplicated by usage record id. Counted every successful API response, including tool-loop hops, not just human turns. No missing/null head-usage fields and no failed-head-request usage gaps were found.

| Brain life | Responses | Input tokens | Output tokens | Cache read | Cache write |
|---|---:|---:|---:|---:|---:|
| `1792241468631-dkbfyt` | 15 | 246,832 | 1,956 | 0 | 0 |
| `1792241666520-fxjdhi` | 14 | 280,827 | 2,079 | 0 | 0 |
| `1792241798920-sxuskp` | 5 | 101,994 | 775 | 0 | 0 |
| `1792241925126-9zu2oc` | 8 | 159,984 | 531 | 0 | 0 |
| **Total** | **42** | **789,637** | **5,341** | **0** | **0** |

The input total is the logged normalized uncached input; cache categories were zero, so it also equals the visible total prompt input. There were 16 `external_inlet_has_no_usage_protocol` coverage notices for external helper invocations; those are not missing Anthropic head responses. Their OpenRouter charges are captured by the measured key delta.

**Dollar-accounting limitation:** Brain logs expose head token usage, not a billed USD amount, and the provider's model-list response exposed window/capabilities, not prices. An attempt to retrieve the provider's public pricing markdown returned **HTTP 403**. I therefore do **not** invent a `claude-sonnet-5-5` rate or claim an independently verified combined-dollar total / invoice-level proof of the $10 cap. The exact measured model-cost evidence is **$0.003543980 OpenRouter plus 789,637 Anthropic input / 5,341 output tokens**. The head workload was deliberately bounded to 42 responses and no optional image/video/enrichment calls. No further test model calls were made after this meter snapshot. This limitation is explicit rather than disguising an estimated head cost as a measurement.

**Cloudflare:** no purchases, domain registrations, plan/subscription upgrades or billing-setting changes were performed. Resource/API operations were small and succeeded on the existing account configuration; no Workers Paid activation was requested. This is not an invoice audit. No Cloudflare spend was authorized or intentionally incurred.

### Retained evidence and final state

- `/root/blindtest-report.md` — this report.
- `/root/blindtest-evidence/commands.log` — timestamped real stdout/stderr, including failed first reads/checks.
- `/root/blindtest-evidence/summary.json` — machine-readable counters, per-life head totals, timestamps, final state and original guide hash.
- `/root/blindtest-evidence/anthropic-models.json` — authenticated provider model list confirming the real input window.
- `/root/blindtest-evidence/openrouter-before.json`, `openrouter-after.json` — private accounting snapshots; not secret values in this report.
- `/root/blindtest-evidence/app-first-start.log`, `step4-apt.log`, `browser-install.log`, `app-submissions.jsonl`, `pre-cut-context.json`, `pre-reboot-context.json` and saved boot-id evidence.
- Browser screenshots: `app-live-final.png` (live final answer), `app-reloaded-answer.png`, and earlier diagnostic screenshots, all under `/root/blindtest-evidence/`.
- Canonical actual tool and usage records: `/opt/embervy/Brain/logs/conversation-*.jsonl` and `session-*.jsonl`; app inbox/outbox in `/opt/embervy/Claude/app/data/`.
- Local archives: `/opt/embervy/Brain/logs/sessions/Session_1.md`, `Session_2.md`; consumed bridge at `/opt/embervy/Brain/logs/bridge.used.md`. Remote list still contains these two sessions and the labelled synthetic probe.
- The house remains running with the selected API head and bound watchdog, no alternate harness, no public tunnel, empty daemon/dream schedules and no cache ping. No resources or pre-existing files were deleted.
