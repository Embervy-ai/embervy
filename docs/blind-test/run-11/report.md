# Embervy manual installation blind test

**Path:** Brain, step 6b, Claude head on a Claude subscription.  
**Verdict:** The local house works end to end, including a real reboot. The guide has non-blocking check/documentation defects and an overstated graceful-shutdown guarantee; these are detailed below. Public hostname/tunnel/phone access was deliberately **not tested**, not passed.

## Scope and method

- Disposable Debian 13 server: `<test-server>`; supplied unpacked source: `/root/embervy-src`; installed house: `/opt/embervy`. INSTALL.md line numbers refer to the original 2,911-line supplied file, which was not edited.
- All installation/provisioning commands ran on that server. No package, tool or configuration was installed/changed on the originating machine. SSH command transport and read-only source investigation were the only local operations.
- Followed the manual order, deferring the explicitly queued runtime checks until First start, and doing 7b and the Brain preflight before that start as 6b requires. The supplied unpacked-repository alternative was used; no git repository/commit was invented.
- Installed pinned Bun **1.3.14** and local Wrangler **3.114.17** without upgrading Wrangler. Native installer supplied Claude Code **2.1.317**. The actual ordered head was `claude-opus-5-5[1m]`, served as `claude-opus-5-5`, transport `pipe`, Claude subscription; context 1,000,000; warn 800,000; cut 900,000. No Anthropic API key or ChatGPT subscription/adapter was set up.
- Used clean Bash shells, private env parsing through the repository helper, copyfile dependency installations, separate house paths/sockets, private token files, loopback app/control listeners, and separate random tokens for the documented boundaries. No secret values are reproduced here.
- **No purchases, domain registration, plan/subscription upgrade or billing-setting operation.** Existing account resources were listed before creation; Workers, D1, Vectorize, R2 and tunnels were empty. Created only this installation's three Workers, two databases, two vector indexes and two buckets. No pre-existing object was deleted.
- The account domain was not owned by the tester and the token has no zone/DNS permission. DNS listing/routing, custom routes, domain acquisition, named/public tunnel, HTTPS phone/PWA access and its public post-reboot message were skipped. Account-level `workers.dev` worker endpoints were usable without zone changes.
- Memory daemon and dream worker `crons = []`, deliberately allowed by the test to avoid recurring spend. The manual dream Check still ran. Brain cache ping was explicitly off. Optional browser, hearing/voice, email, mailbox, calendar, rooms and peers were not enabled; no history was imported.
- The subscription sign-in ran in a named tmux session on the server. Its wrapped authorization URL was assembled into one complete URL and written alone to the requested relay file. The code file was checked every 15 seconds (45-minute ceiling), consumed privately, and both relay files were deleted after successful sign-in. Completed theme, subscription selection, security, workspace trust and MCP-enable prompts. No model turn was sent through the interactive login session.
- The guide calls the Brain doctor section **9b** (lines 2686–2728); **9a is Claude Code**. The requested shared doctor command is the same and was run, but the wrong harness was not configured merely to match the question's “9a” label.

## 1. Step result table

“Fixed by me” means a check/procedure needed the recorded interpretation or workaround; it does not mean source code was patched. All core runtime gates ultimately passed.

| Step | Result | One-line outcome |
|---|---|---|
| 0 — prerequisites/account isolation | ok | Tool/version, local-root/Linux and intended account checks passed; account token-verification endpoint was wrong for this user-owned token, as the guide anticipates. |
| 1 — unpacked repository | ok | Copied to unused `/opt/embervy`; file/directory gate passed; no Git initialization needed. |
| 2 — archive worker | ok | Schema, bindings, secret and both authenticated/unauthenticated gates passed. |
| 3 — memory worker | ok | Schema, four secrets, real wake and protected memory path passed; cron intentionally empty. |
| 3b — dream worker | fixed by me | Full manual dream check passed after correcting the tester's own env-loading mistake, not a guide defect; cron empty. |
| 4 — VPS runtime | ok | Runtime tools, 4 GiB swap, 2 GiB reserve, journal cap, unattended updates and house logrotate set up. |
| 5 — local app | ok | Foreground and systemd login, health and internal-auth checks passed; used authenticated app HTTP protocol for chat. |
| 5 — domain/tunnel/public app | skipped | No owned hostname or zone/DNS authority; no tunnel or public-phone claim. |
| 6 — harness selection | ok | Both harness pairs inactive before wiring; only Brain pair enabled afterward. |
| 6b — profile/identity/notes/permissions/MCP | ok | Preflight, tool permissions, identity, notebook read-back/link, tokens, actual greeting and exact app reply passed. |
| 6b — inlet diagnostic check | fixed by me | Original unconditional `tail` failed on absent stderr-only log; used current-life events and guarded log read. |
| 6b — service restart | fixed by me | New life and app reply worked; old life archived by next-life catch-up, not completed pre-exit archival. |
| 6b — controlled cut | ok | Clean SIGTERM, bridge OK, no forced kill, real upload of `Session_1.md`, new bridge-loaded event and successful tool recall. |
| 7b — external watchdog | ok | Bound service starts automatically; external timestamps advance before and after reboot. |
| 8 — Brain smoke/cleanup | ok | Real app-sourced wake/write/find, real archive recall, automatic inlet injection and separate app replies; owned probe removed without ghost source. |
| 9 — Brain preflight/shared doctor | ok | Final preflight exit 0; shared doctor exit 0, 24 passed / 0 warn / 0 fail / 3 legitimate skips. |
| 9 — finished-house sweep | ok | Placeholder scan clean, all token/URL groups match, workers authenticate, final check pass, also after reboot. |
| 10 — actual reboot | ok | Boot ID changed; all three services, greeting, fresh app tool reply, memory, swap and advancing watchdog returned unaided. |

## 2. Problems, precise locations, workarounds and proposed guide changes

### P1. First-ever start reports a nonexistent previous conversation as a problem

**INSTALL.md:** `6b. Brain / Identity`, lines **1568–1600**, especially `BRAIN_DOCTOR_CMD` at **1600**; `First start`, optional imported bridge at **2192–2197**.

**Command/symptom:** `systemctl start embervy-brain` on this new house produced a `house_check` event at 18:03:58 and this app outbox text:

```text
The house check found a problem.
- Conversation bridge is unavailable: The agent cannot see the end of its previous conversation at this start.
```

The associated fix advised restoring a previous bridge, although there was no previous life and the guide explicitly forbids inventing earlier conversations. The agent's real first greeting nevertheless succeeded.

**Cause verified in repository:** `Brain/brain.ts:1692` unconditionally adds a bridge fallback when bridge text is empty. With the recommended doctor command, its fallback is merged/published (`Brain/brain.ts:408–429`). Newborn recovery otherwise correctly recognizes that there is no previous life (`Brain/wake-bridge.ts:680–687`). This is not the shared doctor failing its directory-writability test.

**What I did:** Did not manufacture a bridge or disable the doctor. Recorded the newborn false alarm, verified the greeting's real reply-tool receipt, and continued. After the first real cut, the new session logged `bridge_loaded`, so the warning did not represent lost history.

**Guide should say:** A fresh house has no imported bridge and must not restore a fictional prior conversation. Until fixed, explicitly identify this first-start-only false positive. The runtime should suppress it when no prior session exists; a missing bridge on a house with prior history must remain an error.

### P2. The inlet Check tails a file that successful operation need not create

**INSTALL.md:** `6b / Inlet`, log setting **2037**, Check commands **2057–2058**, interpretation **2061–2064**.

**Command/error:** After eight completed model turns, including successful `inlet_injected` events:

```text
tail -n 30 /opt/embervy/Brain/logs/inlet-worker.log
tail: cannot open '/opt/embervy/Brain/logs/inlet-worker.log' for reading: No such file or directory
```

The variable is correctly named. Brain only creates that file when the worker emits **stderr** (`Brain/brain.ts:1805–1821`); successful retrieval is stdout (`Claude/scripts/inlet-worker.ts:488–496`). `Brain/brain.env.example:353–356` documents the stderr-only behavior, but this Check does not.

**What I did instead:** Did not create a dummy log or change log variables. Read the exact current-life `session-<id>.jsonl`, including injection/empty/failure/**dedupe-suppressed** outcomes. Tailed the diagnostic file only if it existed; otherwise reported `no worker stderr captured (diagnostic file is created lazily)`. Later current-life app requests had genuine relevant `inlet_injected` events, independently of the missing file.

**Guide should say:** Guard the tail with `test -f`; absence means no stderr captured, not failed retrieval. Make the Check succeed based on real current-life retrieval events, not the existence of a diagnostic log.

### P3. The inlet Check hides a legitimate dedupe outcome

**INSTALL.md:** `6b / Inlet`, **2053–2064**, especially grep at **2057** and the expected new injection at **2061**; step 8 retrieval interpretation **2624–2639**.

**Command/symptom:** The prescribed new app question about the retained probe got a correct app answer, but no new injection event appeared in the displayed grep results. The actual event was `inlet_dedupe_suppressed`: the same returned block had already been injected in this life. The model first incorrectly claimed it had a fresh block, then used a second real reply call to correct that claim. I did **not** count its first claim as proof.

**Cause verified:** Brain hashes the full returned block, not the new question, and suppresses repeats within its default 300-turn TTL (`Brain/brain.ts:1707–1709,1877–1884`). The guide's grep omits that event, so it conceals a healthy but deliberately non-injected result.

**What I did:** Kept thresholds, TTL and caches unchanged; did not add a Claude inlet hook. Following the controlled cut, sent an app request about the archived notebook fact. At **18:11:12.868**, after that app submission and before explicit recall, current session `1793729394541-u2osz0` logged real `inlet_injected`, `via: worker`, containing `Session_1.md#5–6` and `cobalt notebook check`. Explicit recall was separately verified afterward. Subsequent post-reboot app injection also succeeded.

**Guide should say:** Include `inlet_dedupe_suppressed` in the filter and explain that a new question may retrieve an already-seen block. A dedupe event is not a new injection and must not be presented as one. Choose a genuinely different archived fact or a naturally new life to demonstrate fresh automatic injection; do not lower thresholds or clear caches just to get green output.

### P4. The service-stop timeout does not guarantee pre-exit archival

**INSTALL.md:** `6b / Loop service`, **1822–1823** (`KillMode=control-group`, stop timeout), **1833–1837** (“long stop timeout leaves room for archival”), and restart Check **1843–1852**. Reboot implications at **2813–2832**.

**Command/symptom:** Ran the literal `systemctl restart embervy-brain` while idle after three completed turns. It returned `active`; the immediate state still described the old life and tmux briefly said `no server running on /tmp/tmux-0/brain`. Waiting/repeating is already documented and fixed that readiness race. More importantly, the old session log ended at `bridge_written` at 18:12:02.599, with **no** completed archive/upload receipt. The new life later logged:

```json
{"type":"catch_up_archived","session":"1793729394541-u2osz0","name":"Session_1.1","uploaded":true}
```

The same recovery pattern occurred across the actual reboot for `Session_1.2`.

**Cause/limit:** The unit signals the entire process group, including wrapper, tmux and runtime/helpers, together. The wrapper has no coordinated archive-wait TERM path (`Brain/scripts/brain-loop-wrapper.sh:11–45`). Brain writes the bridge before awaited numbering/enrichment/upload (`Brain/brain.ts:2325–2371`). Source and observed logs show interrupted pre-exit archival followed by recovery; they do **not** prove a specific final kill signal, so I do not claim SIGKILL. In contrast, the prescribed controlled-cut script signals only the owned Brain process and successfully awaited normal archival.

**What I did:** Did not patch the unit, shorten timeouts, manually start replacement services or assume an exit code meant upload. Waited for the automatically started next life and required `catch_up_archived uploaded:true`, the old session ID, and the actual remote archive entry. Both recovered uploads were confirmed. Controlled cut was separately proved with an old-life upload receipt.

**Guide should say:** The timeout alone is not a graceful archive guarantee. Distinguish controlled cut, service-group restart and automatic catch-up. Require the next-life recovery receipt when normal pre-exit receipt is absent, and fix/describe stop coordination if graceful archive before service exit is intended.

### P5. Recovery archive names and receipt locations are not explained by the normal-life Check

**INSTALL.md:** `6b / Loop service`, **1850–1852**; `Cut and watchdog`, **1901–1904**; `Memory and chronicle`, **2089–2091** and **2114–2116**.

**Observed:** First clean cut produced `Session_1.md`. Service restart and reboot recovery produced **`Session_1.1.md`** and **`Session_1.2.md`**, with successful receipts in the **new** sessions' logs, not the old session's log. Looking only for an integer next file or old-life `session_archived` would incorrectly suggest failure.

**Repository contract:** Decimal late-arrival names are intentional (`Brain/archive-ledger.ts:13–43`); a reserved name is reused, otherwise recovery is placed beside its chronological predecessor. Normal integer numbering is separate (`Brain/brain.ts:1992–2003`). Catch-up records the old session and actual uploaded flag (`Brain/brain.ts:2455–2484`).

**What I did:** Correlated old session IDs with new-life `catch_up_archived` receipts and the authenticated `/list`; did not rename or re-upload these files by hand.

**Guide should say:** Explain decimal recovery suffixes and exactly which current/new event log to inspect. “Next unused number” is adequate for a normal cut but incomplete for recovery. `upload_pending` alone is neither a completed upload nor a failure receipt.

### P6. Generated house map incorrectly implies an active subscription adapter for Claude

**INSTALL.md:** `6b / First start`, **2136**, **2140–2147**, refresh **2248** and factual-document requirement **2180–2183**.

**Command/output:** The required `bun shared/tools/house-docs.ts --home /opt/embervy --write` generated:

```text
HANDBOOK.md: The subscription adapter uses port 3042 and the control endpoint uses port 3910.
INFRASTRUCTURE.md: - Subscription adapter port: 3042
```

This house runs the native Claude **pipe**, not a ChatGPT adapter; none was installed or needed. The generator defaults a port for every Brain house (`shared/tools/house-docs.ts:286,653`; handbook template `shared/tools/house-docs/HANDBOOK.md:27–28`) instead of qualifying it by head.

**What I did:** Did not install an unwanted ChatGPT adapter to satisfy the map. Recorded the inaccurate generated statements and relied on the real head/transport, preflight and live MCP results. Left generated documents unpatched so this output remains reproducible.

**Guide should say:** For a Claude-only house, omit the adapter component or explicitly label that number as an unused future GPT setting. The required generator should produce factual selected-head documentation.

### P7. Generated nightly-daemon promise is unconditional even when cron is intentionally disabled

**INSTALL.md:** worker cron/configuration **383–405**, dream schedule explanation **509–514**; generated handbook instructions **2136–2147**. This is an allowed-test-configuration documentation mismatch, not a failure to follow a required schedule.

**Observed:** Both deployed configs deliberately have `crons = []`, but the required generated `HANDBOOK.md` says “When memory is enabled, the memory daemon runs nightly.” The static template (`shared/tools/house-docs/HANDBOOK.md:31`) does not derive that claim from a schedule. Health correctly reports `Daemon last run: never`; shared doctor currently says `not due yet`.

**What I did:** Kept schedules empty as authorized, noted no nightly daemon/dream guarantee, and ran the manual dream Check. Did not spend on unnecessary nightly calls merely to match generated prose.

**Guide/generator should say:** An enabled memory worker is not an enabled schedule. Record whether cron is configured or state that the operator must check it; do not assert nightly execution from memory availability alone.

### Environment adaptations and expected transients — not concealed guide defects

1. **Browserless app testing:** Sections 5 **808–810**, 6b **2220–2223**, 8 **2569–2573**, and 10 **2851–2854** describe opening/sending from the app. With no public hostname, I used the repository browser's own protocol: authenticated `POST /api/auth`, then cookie-authenticated `POST /api/message` with `{"text":"..."}`, and `GET /api/messages`. Source: `Claude/app/public/app.js:1695–1700`, `Claude/app/server.ts:1049–1070,1191–1249,1785–1802`. A private server-side HTTP client holds the cookie in memory and replays it only on server loopback through SSH; it does not enable `EMBERVY_TRUST_SAME_HOST`, use an internal-broadcast shortcut as user input, append directly to inbox, or bypass auth. This tests the **real app channel**, not browser rendering, public HTTPS, installation on a phone or push notifications. Instrumentation: `blindtest-evidence/app-client.py`.
2. **App restart readiness:** Check **979–985** immediately gave connection refused / HTTP 000 after `systemctl restart`. Waited 3 seconds and repeated, exactly as the guide permits: health `{"ok":true}`, internal model 200, login 200. No fix needed.
3. **Brain restart readiness:** Immediate old context/no socket settled after startup and a completed greeting, as **1848–1852** and **2211–2218** require. Not itself a failed restart; P4 concerns the separately observed archive path.
4. **Wrangler warnings:** Kept pinned 3.114.17. Its update warning is explicitly allowed at **135–140**. `whoami` could not retrieve user email without User Details permission, but returned the correct account. Account-token verification gave HTTP 401 because this is a user-owned token; `/user/tokens/verify` subsequently returned success true/status active, consistent with **164–168**. No new permission or billing change was attempted.
5. **Optional host setup:** Verified Bun already installed before step 4 and did not reinstall it unnecessarily; single-machine clone was skipped as **549–552** directs. Installing unattended-upgrades itself created exactly the stated `20auto-upgrades` contents; reviewed and kept it rather than overwriting unnecessarily. Inspected absent swap/reserve/journal/logrotate targets before creating them.

6. **tmux driving:** Queued prompts were sent one at a time with the guide’s send-keys commands; readiness and results were inspected with capture-pane rather than leaving an interactive attach blocking the automation. The literal `tmux -L brain attach -t brain` was also exercised on a server-side pseudo-terminal after reboot and cleanly detached with Ctrl-B d (client exit 0), without sending a model prompt. Evidence: `check6b-tmux-attach.txt`.

### Tester mistakes, separately attributed

- The tester split the prescribed one workstation shell across clean SSH invocations and initially reloaded the root template after `/root/blindtest.env`. The template's empty `OPENROUTER_API_KEY` shadowed the supplied key. The first manual dream call returned **502 `{"error":"dream failed"}`**, health `Dream last run: never`. This was **not a guide defect**: the guide says retain variables in one shell. Corrected the private loading order, saved the supplied key using `root_env_set`, re-put only `OPENROUTER_API_KEY` into both model workers and repeated the entire dream Check successfully. Auxiliary urllib diagnostics hit Cloudflare 403/error 1010; guide curl requests worked. No token value was printed.
- The relay URL was wrapped across two terminal lines. The first extraction was incomplete; it was immediately replaced by the assembled complete 465-character URL before successful code use. No alternate auth method was used.
- A first attempt to write this report draft had a shell-quoting error and created no report. Reissued it through SSH stdin, then replaced the known draft with this final report. This did not change installation behavior.

## 3. Complete Check ledger

Outputs below are real, shortened excerpts. Secret values, login URL/code and session cookie are omitted. Evidence paths are under `/root/blindtest-evidence/` unless an original runtime path is shown. Non-applicable 6a, 6c, 7a and Claude-specific 9a checks were intentionally not executed as a second harness.

| INSTALL.md Check | Real output / observation | Evidence |
|---|---|---|
| 0, **173–188** | `1.3.14`; `Python 3.13.5`; `git version 2.47.3`; `OpenSSL 3.5.7 9 Jun 2026`; `/usr/bin/nano`; `0`; `Linux`. Local Wrangler deferred until install: `3.114.17`, intended account returned, email-permission warning only. | `check0.txt`, `check0-wrangler.txt`; user token verification success/active. |
| 1, **229–245** | `Unpacked house: /opt/embervy`; both file/directory tests passed. No git tree, so no pretend git-diff result. | `check1.txt` |
| 2, **347–357** | Secret names: `RAG_AUTH_TOKEN`; unauth `401`; authenticated `{"files":[]}` then `200`. | `check2.txt` |
| 3, **460–472** | `APP_PUSH_TOKEN`, `EMBERVY_API_KEY`, `OPENROUTER_API_KEY`, `RAG_AUTH_TOKEN`; unauth `401`; authenticated `200`, `# Wake — Tuesday, 03/11/2026, 17:56 (... UTC)`, mood initial, empty events. | `check3.txt` |
| 3b, **530–543**, original | Three expected secret names; `401`; `{"error":"dream failed"}` / `502`; `Dream last run: never`. Tester key-shadowing mistake, corrected as above. | `check3b.txt` |
| 3b, **530–543**, corrected | Same three names; `401`; `{"status":"dreamed","content":"While you were away, the silence deepened..."}` / `200`; memory health `Dream last run: 2026-11-03 17:58:56`. Daemon never-ran warning expected with cron off. | `check3b-corrected.txt` |
| 4, **648–662** | Bun `1.3.14`; `/root/.local/bin/claude`, `2.1.317`; `/swapfile file 4G 0B`; RAM 3.7Gi; disk 38G/9.1G used/27G available; logrotate parses config and skips not-yet-existing house logs, no config error. | `check4.txt` |
| 5 foreground/login, **798–810** | Internal endpoint without bearer `401`; login `HTTP/1.1 200 OK`, `set-cookie: embervy_session=[redacted]; ... HttpOnly; Secure; SameSite=Strict`; chat shell GET `200`. Browser JS/rendering not tested. | `check5-login.txt`, `check5-restart.txt` |
| 5 tunnel, **972–974** | **Skipped**, no named tunnel/unit/public app. No fabricated `active`/HTTPS result. | Scope limitation above. |
| 5 restart, **976–988** | `active`; immediate curl refused / `000`. After documented wait: `{"ok":true}`, internal bearer `200`; repeated login `HTTP/1.1 200 OK`, redacted cookie. | `check5-restart-immediate.txt`, `check5-restart.txt` |
| 6 branch choice, **1068–1084** | `inactive` four times for `embervy-loop`, `embervy-watchdog`, `embervy-brain`, `embervy-brain-watchdog` before wiring. | `check6-choice.txt` |
| 6b identity/clock, **1696–1707** | Actual `Read` of `/opt/embervy/EMBERVY.md`, success; app reply lists Who I am / Memory / Tools / What stays put / Infrastructure and Lore/archive tools; quotes `⏰ UTC: Tuesday, 03.11.2026, 18:03`, matching start minute. Empty identity intentionally retained, not an imported persona. | `check6b-identity.txt`; outbox `82148551-5499-4b29-bf4e-5df4856827cc`. |
| 6b Notes, **1733–1751**, including **1745–1746** | Real Read/Write/Edit/Bash results; saved frontmatter + `cobalt notebook check`; read-back output contains note and index; shell prints `RESOLVES`. Independent prescribed check prints `Notes link target exists`. Real app reply matches. | `check6b-notes.txt`, `check6b-notes-link.txt`; outbox `263317d5-53c4-45a0-878e-6ee06be0d795`. |
| 6b loop service, **1840–1852** | `active`; immediate old pid 16716 and no tmux server. Repeated: new pid 17355/session `1793729523337-e8krp4`, Claude pipe/800000/900000; completed greeting then fresh app tool reply. Old life recovered as `Session_1.1`, uploaded true in new log. | `check6b-looprestart-immediate.txt`, `check6b-looprestart-settled.txt`, `check6b-postrestart-app.txt`; P4/P5. |
| 6b controlled cut, **1885–1905** | `none 41907 4 900000 15331 1793729033403-oguxtw below thresholds`; alive `1`; cutoff `clean exit`, `bridge OK (10846 bytes)`, `TERMINATED`; `/list` includes `Session_1.md`. New life has `bridge_loaded` (10820 characters). Old-life `session_archive_upload ok:true`, `session_archived uploaded:true reason:SIGTERM`. | `check6b-controlled-cut.txt`; first/second session logs; `check6b-postcut-recall.txt`. |
| 6b app channel, **2008–2020** | `bun run /opt/embervy/Claude/app/mcp.ts`; process `15393 bun run .../mcp.ts`; actual reply-tool result `Sent: installation app-channel check`; exact same outbox text, no prefix/suffix. | `check6b-appchannel.txt`; outbox `e855e08c-7bb3-4e38-8dac-6ee1523430c7`. |
| 6b inlet, **2053–2065**, original | Grep returned actual first/current-life injection blocks including probe; unguarded tail returned `No such file or directory`. New probe question's repeat block was deduped, not a new injection; no worker failure event. | `check6b-inlet-ledger.txt`, `check6b-inlet-app.txt`; P2/P3. |
| 6b inlet, corrected verification | Current-life **post-app-submission** injection at 18:11:12.868 contains `Session_1.md#5–6` / `cobalt notebook check`; separate real recall result afterward. Guarded diagnostic read: `no worker stderr captured (diagnostic file is created lazily)`. | `check6b-postcut-recall.txt`, `check6b-inlet-corrected.txt` |
| 6b memory/chronicle tokens, **2118–2129** | `memory bearer/URL`, `archive bearer/URL`, `app internal/push bearer`, `Brain memory/archive bearer/URL`, `Brain app bearer`: all `match`; `memory: authenticated 200`; `archive: authenticated 200`. | `check6b-tokens.txt` |
| 6b first start commands, **2204–2226** | Named socket: `brain: 1 windows`; default `tmux ls`: no default server (expected). Brain/watchdog active. Real first greeting `mcp__app__reply` succeeded and matched outbox; app `hello` then separately answered through reply tool. | `step6b-first-start.txt`; first-life session/conversation; proof IDs below. |
| 6b first-start Check, **2231–2242** | `active` ×3; pid 15331, session `1793729033403-oguxtw`, head Claude, pipe, ordered model `[1m]`, tokens `29783`, warn `800000`, cut `900000`; alive `1`. Tokens rose 29238 after greeting → 29783 after app hello → 41907 by cut. | `check6b-firststart.txt`; first-life context/usage events. |
| 7 common query, **2405–2412** | Brain matching query: `systemctl is-active embervy-brain-watchdog` → `active`. Did not start/test other harness watchdog. | `check7b-status.txt` |
| 7b diagnostic block, **2512–2529** | Both units active; log records watching each life and correctly suppresses stale/dead old pid during transitions. Context shows live intended Claude head and thresholds. External state exists; old session in an immediate transition sample subsequently updates. | `check7b-status.txt` |
| 7b advancing-state Check, **2531–2545** | `active` ×2; `last_check_ts` **18:06:53.589855 → 18:07:53.773774** UTC across 65-second wait; same first session and cut 900000. Tokens 34638→37775 while smoke ran. | `check7b-advance.txt` |
| 8 Brain app smoke, **2567–2588** | User input came via app `/api/message`. Real wake time 18:07:01 UTC; write `event_id:1`, `embedded:true`; find returned event 1, exact `cobalt lantern app memory check`; successful app reply with matching reply_to. `/status` replied in app with Claude pipe, model, 41907/1000000, warn/cut 800000/900000. | `check8-app-smoke.txt`, `check8-app-messages.json` |
| 8 Check direct HTTP, **2605–2610** | Upload `{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}`; memory recall returns probe text and source `InstallCheck_1.md#0`; live repeat score 0.03278688524590164. | `check8-prestart-http.txt`, `check8-http-live.txt` |
| 8 Check exact tmux/model, **2612–2622** | Real wake; write `event_id:2`, embedded; find returns event 2 with exact `Synthetic installation observation: cobalt lantern memory check`; actual recall returns `InstallCheck_1.md#0` and probe quotation; actual reply tool/outbox both confirm. | `check8-exact-agent.txt`; outbox `1406c6fa-31e2-431c-a1f9-26b63df59408`. |
| 8 post-cut recall, **2637–2639** | App request triggered actual `mcp__lore__recall {query:"cobalt notebook check"}`; result `RAG recall: 10 hits`, top `Session_1.md#5 (1.00)` with notebook text. Real app reply quotes source and returned content. | `check6b-postcut-recall.txt`; outbox `75ce6172-e519-413e-9285-46b0417c801e`. |
| 8 cleanup, **2642–2649** | `{"success":true,"deleted":"InstallCheck_1.md","chunksRemoved":1}`; owned local probe removed. Final `/list` lacks probe; later search sources are real Session files, no filename `InstallCheck_1.md`. Quoted probe text remains naturally inside archived test conversations and is not a vector ghost. | `check8-probe-cleanup.txt`, `final-archive-list.json`, `final-probe-absence-search.json` |
| 9b preflight, **2688–2699 / 2719–2728** | Before relay completion `ok:false`, head `Claude is not logged in on this server`, exit 1 (expected pending login). After relay and before first start: `ok:true`, six checks true, exit 0. Repeated before/after reboot: same success. | `check9b-preflight-beforestart.txt`, `check9-postboot-final.txt` |
| 9 shared doctor, common command in **2677–2684** / Brain **2701–2728** | First live, preboot and postboot executions exit 0. Final: `PASS (24 checks passed, 0 warn, 0 fail, 3 skip)`; hybrid vector18/bm253; FTS5 3 hits; reranker active; inlet 2485 bytes; MCP 2/2 connected. Skips: other-head sign-in, hearing unset, other-harness canary. | `check9b-shared-initial.txt`, `check9-final-beforeboot.txt`, `check9-postboot-final.txt` |
| 9 finished-house sweep, **2757–2811** | `placeholder sweep: clean`; eleven comparison groups `match`; memory/archive `authenticated 200`; `final check: pass`. Executed before start (preliminary), before reboot and after reboot. Actual HOUSE_UNITS limited to this house's three installed units. | `sweep-prestart.txt`, `check9-finished-sweep.txt`, `check9-sweep-postboot.txt` |
| 10 actual reboot/Brain Check, **2824–2854** | `reboot` executed at 18:14:06; new boot began 18:14:17; boot ID changed. `active` ×3; health `{"ok":true}`; new pid 1022/session `1793729674239-o1ifev`, tokens 25587 after greeting/28608 after fresh app turn; alive `1`; other harness pair inactive; swap 4G returned. No manual start/repair command after reboot. | `reboot-before.json`, `check10-reboot.txt`, `check10-settled.txt` |
| 10 separate boot greeting proof, **2828–2832** | `bridge_loaded` 18:14:42.793; actual reply tool `toolu_01AypRETifMiWPo9v3B8Bd5D`, result `is_error:false`; matching outbox `22e3e09e-1555-4004-ba5a-c7838f54e434` at 18:14:57.978. Not gateway/fallback. | `check10-greeting-proof.json` |
| 10 fresh app message/clock, **2851–2858** | App submission `7447699b-f41b-41a0-b555-d86933b09063`; real Lore find returns event 1; successful reply starts `reboot app channel works`, matching outbox `a5eb0090-0caa-4d0a-8673-11c4be51a1ff`. Agent quotes first clock 18:14 UTC. Independently, direct current-life system FACTS contain **18:14:47 UTC** with current session ID. Public-hostname leg skipped. | `check10-postboot-app.txt`, `check10-direct-clock-facts.txt` |
| 10 repeat 7b advancing state, **2853–2854** | `active` ×2; external `last_check_ts` **18:14:33.921725 → 18:15:34.129763** UTC. First sample legitimately had persisted preboot session, second has current postboot session/cut900000. | `check10-watchdog-advance.txt` |

**Clock evidence limitation:** The current pipe's actual system prompt export says `Time: 11/3/2026, 6:14:47 PM (UTC) · Brain session 1793729674239-o1ifev` under `FACTS (refreshed at every pipe birth)`. That independently proves fresh supplied time, not just a model claim. The exact per-turn emoji-clock line is generated/prepended to stdin but not kept in canonical user-message logs; its exact bytes were not independently recovered. Old 18:03 clock quotations inside bridge/archive content were explicitly excluded from current-life proof. The chosen timezone was UTC, so no claim about a non-UTC conversion was tested.

## 4. Real tool and delivery proof

The following are paired tool-use/result events (`is_error:false`) and matching outbox entries, not text that resembles tool calls:

- **First greeting:** tool `toolu_012xmFNE192nVDKreQTXigfp`, result `Sent: Hello Tester ...`; outbox `205071ee-52cf-4a33-bb5a-b0e4217ed53f`.
- **First real app input:** `/api/message` returned ID `bb040e1c-3bad-4c95-addc-b474737c4d52` for `hello`; canonical user envelope contains that message ID; reply tool `toolu_01EAHrN8H84NXkwgxXo7YSM4` succeeded with reply_to matching that input.
- **Exact app-channel Check:** tool `toolu_01RuLbDSirduYpLnifEVEpMA`; exact outbox `installation app-channel check`.
- **App-sourced memory smoke:** wake `toolu_01P8s7nQLwQkRniHC5Fj7Pbr`; write `toolu_01FQCLHcBYP9PCYGfNGGEhc7` → event1/embedded; find `toolu_017JAoVaAmah9ai16nyEqWLq` → exact stored content; reply outbox `c4989513-a21c-4d41-be65-a0e5212646ea`.
- **Cut transcript recall:** `toolu_01KFch53kcwyndA7rat9eUN5` → top source `Session_1.md#5` plus text, followed by a successful real app reply.
- **Boot greeting** and **fresh postboot app reply** are separately proved in the ledger; neither is inferred from the other.

Across all four Brain lives, the event ledger contains **16 successful `mcp__app__reply` calls**, **2 real wake**, **2 write**, **3 find** and **2 recall** calls. There were **no recorded tool-result errors**. These counts exclude harness-generated status/restart notices, which are not model tool calls.

## 5. Final outcomes, elapsed time and cost

| Required outcome | Answer |
|---|---|
| Did the agent answer through the app channel? | **Yes.** Actual authenticated app submissions, real successful reply tools and matching outbox/reply_to evidence, including after reboot. Browser rendering/public phone access remains untested. |
| Did a memory write and recall work? | **Yes.** Lore writes event1/event2 and actual finds succeeded; event1 survived reboot. The separate archive recall tool returned the uploaded probe and later the real cut transcript. |
| Did a cut produce an archive that can be found again? | **Yes.** Clean controlled cut uploaded `Session_1.md` (10,264 bytes), logged uploaded true, loaded a bridge in the new life, and real recall recovered its notebook-check content. |
| Did everything come back after reboot? | **Yes for the configured local stack.** App, Brain and watchdog started unaided; new boot/session, actual greeting, fresh app tool reply, memory, swap and advancing external state verified. No public hostname/tunnel was configured. |
| Is the nightly pipeline proven? | **No, intentionally not claimed.** Manual dream write passed, but daemon/dream schedules remain empty. |

Final authenticated archive list:

```text
Session_1.md      10264 bytes   clean controlled-cut export
Session_1.1.md     3486 bytes   recovered after service restart
Session_1.2.md     1623 bytes   recovered after reboot
```

No `InstallCheck_1.md` remains in the archive list or as a search-result source. Synthetic notebook note and the two labelled Lore observations remain as test artifacts. Both sign-in relay files are absent. Services remain running and enabled; no periodic model-cost jobs were enabled.

### OpenRouter

The same key's `/api/v1/key` usage counter was privately sampled before any model request and after the final model/doctor checks:

```text
Before:     <key total>
After:      <key total>
Difference:  $0.003666945  (about 0.367 US cents; well below $1)
```

This is the observed **key-level usage difference**, not an estimate based on token prices. No further OpenRouter model calls were made after the final sample. The measurement endpoint itself is not a completion. Evidence: `openrouter-before.json`, `openrouter-after.json`, `final-measurements.json`.

### Claude subscription usage shown by the house

Summed **50 unique message-usage events**, de-duplicating the house's event IDs across the four session logs:

| Token field | Tokens |
|---|---:|
| Non-cached input | 138 |
| Cache-write input | 93,650 |
| Cache-read input | 1,468,762 |
| Output | 8,165 |

These are the token fields exposed by the house, **not** 1.47M unique conversation words or a claim about the subscription quota percentage. The current context after the post-reboot test is 28,608 tokens. First-life context reached 41,907 before cut. The house reports external inlet helpers as `external_inlet_has_no_usage_protocol`; transient header-enrichment helper usage is not separately established by this aggregate. Therefore this is the observed runtime ledger, not a full subscription-account audit. No dollar cost is imputed to the existing subscription and no extra API-key head was provisioned.

### Cloudflare and host

No Cloudflare purchase, plan/subscription/billing change or paid-plan enablement was performed. This tiny test used existing free-allowance services; no Cloudflare charge was intentionally incurred. Invoice/billing-account charges were not queried, so this is **not** an independently audited invoice total. No new server was purchased; the provided disposable server was used.

### Duration

First SSH inspection: **2026-11-03T17:52:51+00:00**. Final model/cost evidence captured at **2026-11-03T18:17:49.747877+00:00**. Report finalized: **2026-11-03T18:23:35.839145+00:00**. Whole run through report: **30 minutes 44 seconds**, including sign-in relay and reboot. The prerequisite evidence clock starts 19 seconds after the initial SSH inspection; this duration includes that initial inspection.

**No installation source code was patched.** Workarounds were private env correction, browserless driving of the repository app protocol, waiting for documented readiness/indexing/catch-up, conditional diagnostics and truthful interpretation of newborn/recovery behavior. The remaining defects above should be corrected in the guide/runtime rather than hidden by fake log files, altered thresholds or invented history.
