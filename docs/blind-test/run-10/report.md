# Embervy manual-installation blind test — Debian 13 / Claude Code

Date: 2026-11-03 (UTC). Server: `root@<test-server>`.
Source: `/root/embervy-src`; installed house: `/opt/embervy`.
Guide: the original 2,911-line `INSTALL.md`; SHA-256: `11e6054bbf2562835963194777740922ab788408247758ea34b9111c7ed89ddc`.

## Verdict

**The configured local Claude Code house works, including real app-channel messages, persistent Lore memory, archive recall, controlled life replacement, and automatic recovery after a real host reboot.** The main head signed into a Claude Max subscription and ran the CLI's default Opus 5.5 model; no Anthropic API key, ChatGPT account, Brain head, or OpenRouter main head was configured.

This is **not** a claim that the full public/graphical app was tested: there was no authorized public hostname, DNS change, tunnel, public HTTPS endpoint, phone/PWA session, or graphical browser test. App interaction used the real authenticated HTTP routes used by the shipped frontend, not direct inbox-file injection. The graphical chat-shell check remains untested. The memory daemon and dream schedules were deliberately left empty; one manual dream was tested successfully.

There was no installation-blocking defect and no product-code patch. There was an immediate dream-secret propagation failure that passed on a repeat, a minor manual-cut log-path documentation mismatch, documented startup races, and several tester-side mistakes. All are separated below rather than being silently hidden.

### Step/result table

`fixed by me` includes tester-side corrections and is not, by itself, a claim of a repository defect. Detailed Check results and evidence appear below.

| Step | Result | Outcome |
|---|---|---|
| Fresh-house separation / clean shell | ok | Unused destination, ports, units, socket and Cloudflare resources checked; isolated house Wrangler state and clean Bash environment used. |
| 0 — prerequisites | ok | Debian packages, Bun 1.3.14, pinned Wrangler 3.114.17; supplied scoped Cloudflare token; no billing change. |
| 1 — house at `/opt/embervy` | ok | Copied the supplied unpacked tree into a new destination, protected environment files; optional Git initialization not performed. |
| 2 — archive worker | ok | R2, D1 FTS5, Vectorize and worker deployed; authenticated/unauthenticated checks passed. |
| 3 — memory worker | fixed by me | Deployment/check passed after repairing an empty OpenRouter secret introduced by the tester's separate-shell runner, not the guide. |
| 3b — dream worker | fixed by me | Immediate authorized Check returned 503; same Check repeated after propagation returned 200 and a nonempty dream. No secret/config/code change for this retry. |
| 4 — VPS preparation | ok | Native Claude, unattended package updates, persistent 4 GiB swap, 2 GiB reserve, log rotation and journald cap installed. |
| 5 — local app/service | ok | Real login, health, internal-token boundary and HTTP message routes worked; service restart race handled using the guide's documented wait/retry. |
| 5 — graphical app/chat shell | skipped | No graphical browser interaction; HTTP authentication and root-page 200 do not prove rendered UI. |
| 5 — public tunnel/hostname | skipped | Explicit authorization limit: no zone/DNS/domain operations or public-hostname setup. |
| 6 — harness selection | ok | Other harness inactive; Claude Code selected. |
| 6a — wiring, sign-in, first start and queued Checks | fixed by me | All applicable functional Checks passed. Tester reconstructed the CLI's visually wrapped sign-in URL for the prescribed relay; no credential printed. |
| 6a — controlled cut, run after 7a/8 | ok | Bridge, export, header enrichment, `Session_3.md` upload, clean exit and new life; actual recall rediscovered the archive. Supplemental log inspection failed separately. |
| 6b / alternate-head sections | skipped | Not selected; no ChatGPT subscription, Brain, or alternate-head installation attempted. |
| 7 — selected watchdog | ok | Selected watchdog active. |
| 7a — Claude watchdog | ok | Correct main session, advancing timestamps and observed token usage before cut, after cut, and after reboot. Thresholds unchanged at 800000/900000. |
| 8 — memory/archive/app smoke | ok | Actual wake/write/find/recall results, event 1, automatic inlet hit, and matching real app outbox replies. Synthetic archive probe deleted after tests. |
| 9 / 9a — shared doctor | ok | Two runs: PASS, 23 passed / 0 warn / 0 fail / 2 skip; explicit Check exit 0. |
| Finished-house sweep | ok | Placeholder scan clean; token/URL checks match; authenticated memory/archive 200; final check pass. |
| 10 — real reboot | ok | All three enabled services recovered without manual starts; health, genuine greeting, fresh app reply, new-session watchdog and direct clocks on turns 1/6/11 verified. Public-app variant remains skipped. |

## Scope, procedure and intentional omissions

- All intentional installation/configuration work and custom evidence scripts were on the disposable server. No packages, project files, or configurations were intentionally installed/changed on the starting machine. SSH host-key file writes were disabled for these test connections.
- Followed the unpacked-repository path; did not invent a Git checkout or optional Git initialization. Original source was retained. Runtime/configuration files in the installation copy were filled as instructed; no repository product code was patched.
- Commands ran in clean, non-profile Bash environments with `umask 077`, isolated `XDG_CONFIG_HOME=/opt/embervy/state/wrangler-home`, metrics disabled and repository environment parsing. The per-stage runner saved command scripts and secret-redacted output under `/root/blindtest-evidence/`.
- Used the supplied Cloudflare account only. Created resources only after an empty relevant inventory. No purchase, domain registration, zone/DNS operation, plan upgrade, subscription change or billing-setting change occurred. No paid-plan blocker was encountered.
- Workers' existing `workers.dev` account hostnames were usable without touching the unauthorized domain. The app stayed on `127.0.0.1:3030`; no tunnel service was created. `APP_URL` in the memory worker was empty because no public app endpoint existed.
- Memory and dream worker `crons=[]` were intentional cost-saving omissions permitted by the user. Manual dream ran; scheduled daemon and scheduled dream behavior were not exercised. Optional browser, hearing, mail, calendar and other unrelated integrations were not enabled.
- Claude subscription sign-in ran on the remote server in tmux. The complete sign-in URL alone was written to the relay file, the code file was checked every 15 seconds, and the received code was typed privately into the waiting prompt. Login succeeded at about 16:37:49 UTC; both relay files were removed and their absence was verified again at the end. No code, bearer, session cookie or credential value is reproduced here.
- Real app tests used `POST /api/auth`, the returned session cookie in process memory, `POST /api/message` and app history/outbox inspection. This follows the shipped frontend's HTTP contract. It is not a graphical browser/phone test, and no message was written directly to the inbox to fake channel delivery.
- Checked native Claude 2.1.317, default Opus 5.5, Claude Max account, both MCP servers connected, and `server:app` listening. No model override was introduced.

## Problems, retries, adaptations and guide improvements

### P1. Dream's newly uploaded secret was not immediately available at the serving worker

**Guide:** step 3b, `INSTALL.md:501–507`; Check `530–537`, expected outcome `539–543`.

**Command/outcome:** immediately after `wrangler secret put DREAM_AUTH_TOKEN`, the secret list contained the expected names and unauthenticated `POST /dream` returned 401, but the authorized `curl -X POST ... "$DREAM_URL/dream"` returned:

```text
{"error":"server misconfigured: DREAM_AUTH_TOKEN missing"}
HTTP 503
```

The health response still showed Dream last run `never`. At 16:32:58 UTC, repeating the same Check after a short delay, without changing the token, code or config, gave unauthenticated 401, authorized `{"status":"dreamed","content":"While you were away, ..."}` / 200, and Dream last run `2026-11-03 16:32:58`.

**Instead:** wait and repeat the identical Check. Evidence: `03b-dream.log`, `03b-dream-check-repeat.log`.

**Guide should say:** a just-uploaded secret may take a short propagation interval; secret-list presence alone does not prove every serving deployment has it. Retry this specific transient configuration response after a short wait before regenerating credentials or editing code.

### P2. Documented local app startup race — not an undocumented fix

**Guide:** step 5 restart Check, `INSTALL.md:976–982`, with explicit wait/retry guidance at `984`.

**Command/outcome:** `systemctl restart embervy-app.service` and `systemctl is-active` returned `active`; the immediately following health/model curls returned `curl: (7) Failed to connect` and HTTP `000`. After three seconds the unchanged service gave `{"ok":true}`, authorized internal-model 200, and login 200.

**Instead:** used the documented wait/retry. No service/config patch. Evidence: `05-app-check-and-unit.log`.

**Guide should say:** already explains this; optionally put a bounded readiness loop directly in the Check to avoid alarming first-run output. Step remains successful, with initial curl failures retained in the ledger.

### P3. Loop active before its tmux socket/prompt exists — documented startup timing

**Guide:** step 6a loop restart Check `INSTALL.md:1198–1203`; First start Check `1504–1509`, accompanying startup-wait prose.

**Command/outcome:** immediate `tmux -L embervy capture-pane ...` sometimes reported no server running while systemd was already active. Repeating after about 22–30 seconds showed the live Claude prompt and was followed by an actual fresh app reply.

**Instead:** waited and repeated capture; no alternate socket, manual agent takeover or permission bypass. Evidence: `06a-systemd-first-check.log`, `06a-loop-restart-check.log`.

**Guide should say:** existing wait/repeat guidance is adequate; a bounded socket/prompt readiness check would make this easier to interpret.

### P4. Manual cut succeeds but does not itself create the troubleshooting log path

**Guide:** controlled-cut command `INSTALL.md:1244`; troubleshooting `2900` points to `logs/cutoff.log`.

**Command/outcome:** the documented direct `cutoff.sh` command produced `Bridge OK`, `Export OK`, uploaded `Session_3.md`, stopped the old Claude cleanly, and started a new life. A subsequent tester-only attempt to read `/opt/embervy/logs/cutoff.log` raised `FileNotFoundError`, making that combined evidence stage exit 1 **after the successful cut**.

**Instead:** used the actual captured stdout in `06a-controlled-cut.log`, plus authenticated archive listing, current-session evidence and actual post-cut recall. Source inspection showed `cutoff.sh` sets a log-path variable but does not redirect its own output; the watchdog's automatic invocation performs the redirection (`context_watchdog.sh:393`). No code was patched.

**Guide should say:** `logs/cutoff.log` covers watchdog-triggered invocations; capture/tee stdout separately for a manual invocation, or explicitly add logging to the manual Check. Do not imply absence of this file means export failed.

### P5. Automatic inlet verification needs a concrete automatic-only recipe (clarity improvement)

**Guide:** `INSTALL.md:2636–2640`, with transcript inspection already described at `1408–1410`.

**What happened:** explicit `/recall` and direct HTTP recall have concrete examples; the separately required automatic inlet test has less concrete execution/evidence guidance. This was not a functional failure.

**Instead:** sent an additional message through the real app asking for the synthetic archive fact using automatically supplied Chronicle context and explicitly not calling recall. Verified a direct `hook_additional_context` / `UserPromptSubmit` attachment containing the real `InstallCheck_1.md` hit, followed by an actual app tool reply; that turn did not call recall. Evidence: `08-app-and-auto-inlet.log`.

**Guide should say:** include an automatic-only app prompt and show how to distinguish a direct current hook attachment from archive text that merely quotes an old clock or hit.

### P6. Public and graphical checks were omitted, not silently passed

**Guide:** step 5 graphical shell check `INSTALL.md:808–810`; tunnel/public Checks `972–974` and `986–988`; step 10 public-app message `2852–2853`.

**What happened:** no authorized zone/public hostname, and no graphical browser session was driven. The root page returned 200 and authentication/messages worked over the real local app HTTP routes, but those results do not prove UI rendering, phone/PWA operation or public HTTPS delivery.

**Instead:** skipped tunnel/public operations under the user's explicit restriction, and recorded the graphical UI as untested. Used real local HTTP app messages for channel verification before/after restart/cut/reboot.

**Guide should say:** distinguish local authenticated app-channel testing from public/graphical testing and state the limitation of a headless HTTP-only installation test. No guide defect is asserted merely because this test's authorization excluded public access.

### Tester-side errors and supplemental-command failures (not repository defects)

| Associated guide section/line | Exact operation / short error | Correction and interpretation |
|---|---|---|
| Step 3 secrets, `INSTALL.md:399–406`; shell/env instructions `32–91` | Tester independently reloaded the root template in a new stage shell before `wrangler secret put OPENROUTER_API_KEY`; its empty assignment replaced the inherited supplied key, so the initial upload was empty. | Reloaded root environment, then `/root/blindtest.env` as data, and repeated the secret upload with the supplied key; repeated the memory Check successfully. This was the runner's deviation from the guide's continuous-shell sequence, not a missing-key defect in the guide. `03-memory-key-repair.log`. |
| Step 3 Check `460–466` | Tester's secret sanitizer interpreted an empty template's comment marker as a secret and masked Markdown `#` headings in early output. | Required candidate secret length >= 8 and reran the Check. No actual credential leak; later evidence preserves real headings. |
| Step 6a sign-in/trust instructions `1185–1196` | CLI visually wrapped the OAuth URL; the first tester extraction saved only its first visual line. | Before relay use, concatenated the complete contiguous URL block, validated required URL fields, overwrote the URL-only relay file and completed the prescribed remote sign-in. No code/token printed, no expiry/relogin needed. This is terminal-relay handling, not an Embervy code fix. |
| Notebook Check `1144–1150` | Agent's first inspection attempted to read a new notebook's absent `MEMORY.md`; Bash exited 1 / file not found. | Agent then actually wrote the test note and index and read the note back. Fresh empty notebook state was expected; no permission workaround. `06a-notebook-check.log`. |
| Controlled cut `1239–1254`; troubleshooting `2900` | Tester-only `Path(.../logs/cutoff.log).read_text()` raised `FileNotFoundError`. | See P4. The documented cut itself passed. Combined stage exit 1 must not be mislabeled as failed export. |
| Probe cleanup `2642–2649` | Supplemental Python `urllib` search request returned HTTP 403. | Repeated using the guide's `curl` HTTP approach with the same bearer: 200. No product/credential change. `08-cleanup-search-curl.log`. Cause of the supplemental client's rejection was not established. |
| Probe cleanup `2642–2649` | Initial supplemental deletion verifier matched `InstallCheck_1.md` anywhere in returned text, including quoted mentions inside a legitimate session transcript. | Verified hit source filenames instead: returned hits came from `Session_3.md`, not deleted `InstallCheck_1.md`. No synthetic source remained in list/search; normal transcript references are not deletion ghosts. |
| Reboot Checks `2835–2860` | Tester waiter printed `NO NEW TOOL REPLY WITHIN 180 SECONDS` although the agent had really called `mcp__app__send`. | Waiter had accepted only outbox type `reply`. Confirmed shipped alias `send`, actual non-error tool result and matching outbox greeting at 16:53:14.195Z; changed the tester helper to accept `reply` or `send`. No service or agent repair. Then separately required and verified `mcp__app__reply` for a fresh app message. `10-reboot-check.log`, `10-reboot-greeting-verification.log`. |

Benign/nonblocking outputs were also retained: pinned Wrangler's newer-version warning (the guide explicitly says not to upgrade), account email lookup unavailable without User Details Read while the intended account ID was correctly usable, and logrotate debug's dry-run/missing-initial-log notices. None required a paid plan or an outside-knowledge patch.

## Ledger of every applicable Check

Paths below are relative to `/root/blindtest-evidence/`. Output is shortened; ellipses indicate omitted content, not invented success. Secret values, auth codes, bearer lines and session cookies are intentionally absent. Scripts and fuller sanitized outputs are retained alongside the named logs. Alternate-head Check blocks are not applicable to the selected 6a branch.

| INSTALL.md section / lines | Command or test | Shortened actual output / result | Evidence log(s) |
|---|---|---|---|
| 0, **173–188** | Tool versions; `command -v "$EDITOR"`; `id -u`; `uname`; Cloudflare account check | `1.3.14`; `Python 3.13.5`; `git version 2.47.3`; `OpenSSL 3.5.7`; `/usr/bin/nano`; `0`; `Linux`. Intended account listed. Token could not retrieve user email, without blocking account access. | `00-prerequisites.log`, `02-rag-preflight.log` |
| 1, **229–245** | House files/shared directory; unpacked-source branch | `Unpacked house: /opt/embervy`; exit `0`. Optional Git branch/check not applicable to the supplied unpacked tree. | `01-house.log` |
| 2, **347–357** | Secret list; `/list` without/with bearer | Secret name `RAG_AUTH_TOKEN`; `401`; `{"files":[]}` and `200`. | `02-rag-check.log` |
| 3, **460–472** | Secret list; `/mcp?tool=wake` without/with bearer | Secret names `APP_PUSH_TOKEN`, `EMBERVY_API_KEY`, `OPENROUTER_API_KEY`, `RAG_AUTH_TOKEN`; `401`; real `Wake` response with initially empty database and `200`. Tester repaired empty-key upload and over-redaction before the repeat. | `03-memory-deploy.log`, `03-memory-key-repair.log` |
| 3b, **530–543** | Secret list; unauth/auth `POST /dream`; memory health | Initial: `401`; auth `503`, `{"error":"server misconfigured: DREAM_AUTH_TOKEN missing"}`; `Dream last run: never`. Repeat: three expected secret names; `401`; auth `200`, `"status":"dreamed"`, nonempty content; `Dream last run: 2026-11-03 16:32:58`. | `03b-dream.log`, `03b-dream-check-repeat.log` |
| 4, **648–662** | Bun/Claude versions; swap/free/disk; logrotate debug | `1.3.14`; Claude Code `2.1.317`; `/swapfile` size `4G`; root disk `38G`, about `27G` available. Logrotate config parsed without errors; expected debug/dry-run and initially missing-log notices. | `04-storage.log` |
| 5 foreground, **798–810** | Unauthenticated internal-model endpoint; `POST /api/auth`; open app | Internal unauth `401`; login `HTTP/1.1 200 OK` with session cookie withheld; `/` returned `200`. **Graphical app/login/chat-shell rendering skipped/untested**, not inferred from HTTP 200. | `05-app-check-and-unit.log`, `operator-notes.md` |
| 5 tunnel, **972–974** | Public hostname/app route | **Skipped**: no authorized public hostname, zone/DNS or tunnel setup. | `05-app-check-and-unit.log` |
| 5 restart, **976–988** | `systemctl restart` / `is-active`; local health, internal bearer, repeated login; public equivalent | `active`; immediate health/internal curls: `curl: (7)` and `000`. After documented wait: `{"ok":true}`, authorized internal `200`, login `HTTP/1.1 200 OK` (cookie withheld). Public variant at **986–988 skipped**. | `05-app-check-and-unit.log` |
| 6 selection, **1068–1084** | Query both possible loop/watchdog pairs before selection | Four `inactive` results. | `06a-wire.log` |
| 6a identity, **1124–1134** | Exact tmux identity request; app-tool response | Actual successful `mcp__app__reply` and matching outbox naming `Who I am`, `Memory`, `Tools`, `What stays put`, `Infrastructure`; actual Lore tools/archive endpoint. Identity block deliberately empty, not an unfilled credential marker. | `06a-identity-check.log` |
| 6a notebook, **1144–1153** | Request actual project notebook write and read, then app reply | First attempted read of absent `MEMORY.md`: tool exit `1`. Then actual successful note/index writes and read-back; successful app reply names `/root/.claude/projects/-opt-embervy/memory/installation-notebook-check.md`. Not a Lore write. | `06a-notebook-check.log` |
| 6a loop restart, **1198–1209** | Restart loop; `is-active`; capture; fresh real app message | `active`; immediate capture `no server running`; after wait, live idle Claude prompt. Actual successful tool result and outbox `loop restart received`. | `06a-loop-restart-check.log` |
| 6a controlled cut, **1239–1254** | Check thresholds; run `cutoff.sh`; capture; authenticated archive list; next-life recall | `800000 900000`; `Bridge OK`; `Uploaded: Session_3.md`; `Export OK`; `Clean exit after 2s`. Live new life; archive list contains `Session_3.md`. Actual next-life recall returns that file. Combined stage exit `1` came only from supplemental missing `logs/cutoff.log`, not the cut. | `06a-controlled-cut.log`, `08-post-cut-recall.log`, `09-supplemental-evidence.log` |
| 6a channel, **1347–1360** | MCP command/process; `claude ... mcp list`; `/status`; actual app message | `bun run /opt/embervy/Claude/app/mcp.ts`; `app` and `lore` `Connected`; `Channels: Listening for messages from server:app`; actual app tool reply/outbox `app and lore connected`. | `06a-channel-check.log`; matching tool result also in `08-smoke.log` |
| 6a inlet clock, **1396–1410** | Exact first-clock request plus direct transcript attachment inspection | App reply: `⏰ UTC (test house): Tuesday, 2026-11-03, 16:42`. Current-life direct `hook_additional_context` / `UserPromptSubmit` independently begins with that clock. Post-reboot 1/6/11 cadence checked separately below. | `06a-inlet-check.log`, `06a-inlet-transcript-evidence.log` |
| 6a pre-start tokens, **1442–1450** | `bun run .../state/install-token-check.ts` before First start | Seven bearer/URL comparisons `match`; `memory: authenticated 200`; `archive: authenticated 200`. | `06a-wire.log` |
| 6a First start and final map, **1504–1534** | Active app/loop; tmux capture; fresh app reply; documented house-docs refresh | Both `active`; initial capture raced socket startup; later live session without pending dialog. Actual successful app reply/outbox `systemd first start received`. After watchdog wiring: handbook/infrastructure/facts written, capabilities kept agent-owned. Foreground greeting/export/Ctrl-C handoff separately passed before service ownership. | `06a-systemd-first-check.log`, `06a-identity-check.log`, `07-watchdog.log`; foreground sequence in `06a-first-start.log` through `06a-foreground-handoff.log` |
| 7, **2405–2413** | `systemctl is-active` selected watchdog | `active`. | `07-watchdog.log` |
| 7a, **2448–2463** | Active selected units; first state, sleep 65, second state; observe later model usage/new life | Both `active`; `last_check_ts` `16:44:36.058Z → 16:45:37.161Z`; correct session; thresholds `800000/900000`; tokens initially `42675`, later `48958`. After cut new-session state advanced `16:47:39.309Z → 16:48:40.476Z`, tokens `40447 → 47201`. | `07-watchdog.log`, `08-app-and-auto-inlet.log`, `08-post-cut-recall.log` |
| 8 Claude smoke, **2557–2565; 2605–2622** | Upload probe; direct recall; exact tmux wake/write/find/recall request; separate real app message | Upload `"success":true`, `"chunks":1`; direct recall returns `InstallCheck_1.md`. Actual wake success; write `Wrote event 1 (kind=observation, weight=light, embedded=1)`; find `Found 1 events` with stored phrase; actual recall returns probe filename/text; successful actual app replies/outbox. | `08-archive-http-probe-early.log`, `08-smoke.log`, `08-app-and-auto-inlet.log` |
| 8 automatic inlet / real-life recall, **2636–2640** | Automatic-only real app turn; inspect hook; after cut recall a phrase from real session | Direct attachment supplies `[InstallCheck_1.md] (100% [bm25+rerank])`; actual app reply without recall on that automatic-only turn. Later actual next-life recall returns `Session_3.md` and stored app text. | `08-app-and-auto-inlet.log`, `08-post-cut-recall.log` |
| 8 cleanup, **2642–2650** | Delete probe; remove own local file; `/list`; delayed source-aware search | `"success":true`, `"chunksRemoved":1`; probe absent from list. Supplemental urllib search `403`; equivalent curl `HTTP 200`. Initial substring-based `ghost present: True` was a tester-verifier error; source-aware result `Synthetic probe source/ghost absent: True` (legitimate `Session_3.md` mentions do not count as probe-source ghosts). | `08-probe-cleanup.log`, `08-cleanup-search-curl.log`, `09-supplemental-evidence.log` |
| 9a shared doctor, **2666–2669; 2677–2684** | Initial doctor and repeated Check with printed exit | Both: `PASS (23 checks passed, 0 warn, 0 fail, 2 skip)`; explicit `doctor exit=0`. Included authenticated workers, hybrid/FTS/reranker, inlet, Claude canary, 2/2 MCP, disk/swap checks. Skips: irrelevant alternate-head sign-in and unset hearing service. Daemon `never` / not due yet; successful manual dream recent. | `09a-doctor.log` |
| Finished-house, **2757–2811** | Actual three-unit list; exact placeholder scanner; token checker; combined exit | `placeholder sweep: clean`; `sweep exit=0`; all bearer/URL groups `match`; memory/archive `authenticated 200`; `final check: pass`. | `09-finished-house.log` |
| 10 reboot, **2835–2841; 2851–2860** | Real reboot; active units/health/tmux; fresh app message; advancing watchdog; first clock and 1/6/11 cadence | `Boot ID changed: True`; three units `active`; `{"ok":true}`; Brain pair `inactive`; swap `4G`; live new life. Waiter initially printed `NO NEW TOOL REPLY WITHIN 180 SECONDS`, but actual successful `mcp__app__send` and matching outbox greeting already existed. Separate fresh app `mcp__app__reply`/outbox: `reboot app channel received`. Watchdog `16:56:01.211Z → 16:57:02.284Z`, tokens `39428 → 40349`. Inlet counter `2 → 11`; direct clocks exactly turns `1, 6, 11`, transcript lines `14, 138, 218`. **Public-app variant at 2852–2853 skipped**; genuine local HTTP channel tested. | `10-pre-reboot.log`, `10-reboot-check.log`, `10-reboot-greeting-verification.log`, `10-clock-cadence.log` |

Completeness audit: every applicable Claude Code Check block has recorded execution/evidence, except the explicitly unperformed graphical shell expectation and authorized public-hostname/tunnel variants identified above. This does not upgrade those omissions to passes. Nonselected harness branches and optional disabled integrations are outside the chosen installation path.

## End-to-end evidence: actual tools and real app outputs

These conclusions rely on structured `tool_use` with matching non-error `tool_result`, and real app outbox entries where applicable. Text that looks like a tool call, model claims, and clocks merely quoted inside retrieved archives were not counted.

### App and first-start ownership handoff

- Foreground first greeting: actual `mcp__app__reply`; matching outbox `e6859e30-3c48-415b-94ed-c676ffbb3bcf`, 16:39:00.849Z: “Hello, Tester. I've just woken up in this house for the first time. I don't know much yet, about you or about myself, so I'm looking forward to finding out together.”
- A real authenticated app message produced outbox `9c8ee77f-8883-4897-8fc9-5337eb1ca0bf`, 16:39:26.194Z: `first app channel received`.
- Followed foreground `/exit` and the documented export-complete / 15-second Ctrl-C handoff. `Session_1.md` uploaded; the foreground loop stopped before the systemd-owned loop started. No stale interactive loop was adopted by systemd.
- Service first-start/restart messages also received actual app replies: `systemd first start received` and `loop restart received`. Notebook test used real project-file write/read operations, separately from Lore memory.

### Lore, archive and automatic inlet

- `mcp__lore__wake` returned real database state.
- `mcp__lore__write` created explicitly synthetic external/light installation observation: `Wrote event 1 (kind=observation, weight=light, embedded=1)`.
- `mcp__lore__find` returned the same event for `cobalt lantern memory check`.
- `mcp__lore__recall` returned the uploaded `InstallCheck_1.md` text for `cobalt lantern recall check`.
- Matching app reply: `e6166961-ca50-4cb0-b506-c9523f13bbc7`, 16:46:18.689Z.
- Separate automatic-only app turn: actual direct hook attachment in `ad4daf98-7692-4f13-9276-03648afa2824.jsonl:170`, 16:46:42.495Z, contained the current direct clock and `Chronicle [InstallCheck_1.md] (100% [bm25+rerank])` with the fact. No recall call on that turn. Actual app outbox `d4bb61d2-e082-451a-9c3c-e41551ee8129`, 16:46:45.311Z, with the correct user reply association.

### Controlled cut and rediscovery of a real life

- Old main life: `ad4daf98-7692-4f13-9276-03648afa2824`; new life: `48173688-de07-4ef9-8bd3-c71deb9fd545`.
- Manual cut at about 16:47:12–16:47:27 UTC built a bridge (18 messages, about 4 KiB), exported the full session, enriched the header, uploaded `Session_3.md` (4,192 bytes), and terminated the old Claude only after export success. Archive upload time: 16:47:23.893Z.
- In the new life, actual recall of `loop restart received` returned `Session_3.md#0/#1` with real stored app text; actual find still returned event 1. Actual app reply `3c63285b-9764-4ea1-83a7-426b60b8c6a6`, 16:48:25.156Z. This proves rediscovery from the archive, not just survival of bridge text.
- After explicit recall and automatic inlet passed, deleted tester-created `InstallCheck_1.md`: `success:true`, `chunksRemoved:1`; removed the tester-created local probe. Archive listing no longer contained the probe, and source-aware search found no probe-source ghost after the indexing wait. The explicitly synthetic Lore event and normal test-life archives remain.

### Reboot recovery and direct clock cadence

- Issued an actual host reboot at about 16:52:15 UTC; saved and compared boot IDs, which changed. **No manual service start/restart was used after reboot.**
- App, loop and watchdog recovered automatically; app `/health` returned `{"ok":true}`; Brain services stayed inactive; swap remained present; tmux showed a live idle Claude session without a login/permission dialog.
- New main life: `e034704e-306c-4946-b144-40b36411ec72`.
- Automatic greeting: actual `mcp__app__send`, non-error tool result, matching outbox `0600df1a-35f7-4d0b-b71a-f25a4c031ac2`, 16:53:14.195Z: “Hello again, Tester. I'm back and here whenever you need me.” The initial reply-only waiter missed this valid alias; it was not a house failure.
- Fresh authenticated app message then produced actual `mcp__app__reply` / successful tool result and outbox `6ea0e176-f984-4aca-b5ae-f67a43d47da8`, 16:56:35.696Z: `reboot app channel received`, correctly associated with the user message.
- Watchdog after reboot advanced from 16:56:01.211Z / 39,428 tokens to 16:57:02.284Z / 40,349 tokens on that new session. Final snapshot: 17:05:11.207Z / 48,326 tokens. Thresholds remained 800,000 and 900,000; never lowered to force a test pass.
- Added short real app turns through inlet counter 11. Each `ack-3` through `ack-11` had an actual successful `mcp__app__reply` tool result and matching outbox output.
- Direct current-life `hook_additional_context` clock attachments occurred at transcript lines 14, 138 and 218, timestamps 16:53:09.495Z, 16:58:54.386Z and 16:59:55.609Z: **turns 1, 6 and 11**. Counter started at 2 before the added tests and ended at 11. These were first-line direct hook clocks, not clock text found inside Chronicle hits.

## Retained installation and audit artifacts

Enabled and active at final read-only check:

```text
embervy-app.service       enabled / active
embervy-loop.service      enabled / active
embervy-watchdog.service  enabled / active
```

House-owned Cloudflare resources created:

| Kind | Names |
|---|---|
| Workers | `embervy-chronicle`, `embervy-memory`, `embervy-dream` |
| R2 | `rag-storage`, `embervy-archive` |
| D1 | `rag-fts`, `embervy-memory` |
| Vectorize | `rag-vectors`, `embervy-vectors` — 1024 dimensions, cosine |

Endpoints: `https://embervy-chronicle.<account>.workers.dev`, `https://embervy-memory.<account>.workers.dev`, `https://embervy-dream.<account>.workers.dev`. The app remains local at `http://127.0.0.1:3030`.

Final authenticated archive inventory (`11-final-archive-list.log`):

```text
Session_1.md  788 bytes   uploaded 2026-11-03T16:40:02.977Z
Session_2.md  3766 bytes  uploaded 2026-11-03T16:42:31.279Z
Session_3.md  4192 bytes  uploaded 2026-11-03T16:47:23.893Z
Session_4.md  1441 bytes  uploaded 2026-11-03T16:52:30.521Z
```

`Session_4.md` was also exported during reboot shutdown. The probe is absent. Only tester-created probe/relay files were removed; no pre-existing Cloudflare resources were deleted.

Evidence scripts/logs, original source, installed house, subscription session records and the project notebook remain on the server. Some private configuration and session records naturally contain credentials/account context; they were not copied into this report. Report and tester evidence are root-private. The app password remains in the configured protected app environment file; it is deliberately not printed here.

## Time and cost accounting

- Start: **2026-11-03T16:27:41.608792+00:00**.
- Report close-out / final key-usage measurement: **2026-11-03T17:11:14.885163+00:00**.
- Total wall-clock elapsed: **43 min 33 s** (2613.276 seconds), including installation, human sign-in relay wait, actual tests, reboot, evidence consolidation and report preparation. A brief final read-back validation follows this close-out timestamp.
- OpenRouter key usage before: **US<key total>**; final: **US<key total>**; measured key-usage difference: **US$0.00577870**, well below the authorized US$1 cap. This is the key's actual reported usage difference, not a model-cost estimate; it is not an attribution audit of any unrelated concurrent use of the same key. Baseline/final snapshots: `openrouter-before.json`, `openrouter-final.json`.
- OpenRouter was used only for the repository's supporting worker/header/inlet paths, including the manual dream, not the main Claude head. Schedules were empty. No further test model calls are planned after this measurement.
- Claude main head: existing subscription quota, not an Anthropic API charge; observed token counters are itemized below. No new subscription was purchased. Subscription-plan price and quota-to-dollar conversion are not claimed.
- Cloudflare: **no purchases, paid-plan upgrades or billing-setting changes**. Resource/API usage occurred without a paid-plan requirement in this run; no Cloudflare invoice or eventual usage-charge settlement was independently audited, so an invoiced Cloudflare dollar total is not asserted.
- Disposable-server rental and pre-existing subscription fees were supplied externally and not measured. Consequently the precisely measured incremental model-key cost is the OpenRouter delta above, not a purported all-in infrastructure invoice.

### Claude subscription token usage visible in the house

Model: `claude-opus-5-5`; login: Claude Max subscription. The following are **persisted main-life usage counters, not an Anthropic API invoice**:

| Counter | Tokens |
|---|---:|
| Non-cache input | 143 |
| Cache-creation input | 94,723 |
| Cache-read input | 2,769,525 |
| Output (including any accounted thinking) | 7,742 |
| Input including caches | 2,864,391 |
| Input including caches plus output | 2,872,133 |

Scope/method: 67 unique assistant message IDs across five actual main lives (the separate sign-in session had no assistant usage). Used canonical `type=assistant` records only, grouped by `message.id` within each session, taking maximum numeric usage for repeated snapshots; excluded mirrored `api-request-blob` records. Cache-read input counts repeated processing of cached context, not distinct new text and not current context size. Nonpersisted header-enrichment/doctor helper usage and the tester's own session are excluded because equivalent full persisted counters were not available in this house directory. Therefore this is a clearly scoped observed subtotal, not a claim to total account-wide subscription consumption. Machine-readable accounting: `subscription-usage.json`.

The final watchdog's 48,326 tokens is a **current-context** observation, not the cumulative total above. No API-dollar estimate is substituted for subscription quota usage.

## Explicit final answers

| Question | Answer |
|---|---|
| Did the agent answer a message through the app channel? | **Yes.** Real authenticated app messages produced actual successful MCP app tool results and matching outbox replies, including a fresh reply after reboot. Public/graphical phone/PWA interaction was not tested. |
| Did memory write and recall work? | **Yes.** Lore wrote synthetic event 1 and found it again, including after a cut. Archive recall returned the synthetic file, and automatic inlet retrieved it independently. |
| Did a cut produce an archive file discoverable again? | **Yes.** Controlled cut uploaded `Session_3.md`; the new life actually recalled it by a phrase from that life. |
| Did everything come back after reboot? | **Yes for the configured local installation:** all three enabled services recovered without manual starts, app replied, new-session watchdog advanced, swap persisted, and direct inlet clocks passed 1/6/11. No claim is made for intentionally unconfigured public tunnel/DNS or disabled schedules. |
| How long did the whole run take, and what did it cost? | **43 min 33 s** through report close-out; measured OpenRouter key delta **US$0.00577870**. Main head used the existing Claude subscription; no Cloudflare purchase/plan change. Unmeasured supplied VPS/subscription fees and any eventual Cloudflare invoice are not included in that delta. |
