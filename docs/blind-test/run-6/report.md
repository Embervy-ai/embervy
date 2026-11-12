# Embervy newcomer installation test — Brain / Claude subscription head

## Scope and verdict

Test date: **2026-10-17 (UTC)**. Disposable Debian 13 host: `<test-server>`, user `root`. Source: `/root/embervy-src`; installed home: `/opt/embervy`. The starting machine was used only as an SSH/tool terminal: no packages, repository, app configuration, or report were installed or written there. Installation, worker deployment, app interaction, configuration, evidence, and this report were performed on the disposable server and in the supplied Cloudflare account.

**Verdict: the Brain installation works, including real app tool replies, episodic write/find, archive recall, automatic inlet retrieval, controlled-cut continuity, and automatic recovery after a real host reboot. Two documentation/template defects required local corrections. Public hostname/tunnel/phone/browser checks were skipped because the account has no domain; no rendered browser UI claim is made.**

The original `/root/embervy-src/INSTALL.md` was not edited. Its SHA256 is:
`193386c83edf5c2ca91f51160b582a7bf142a1cefe7a390b8c9228993fdb863c`.
All guide line references below are to that unchanged file. No source-code fixes, commits, pushes, or PRs were made. Only the installed configuration, filled house documents, permissions, and explicitly described workarounds were changed.

### Final answers

| Question | Result and concrete proof |
|---|---|
| Did an app message receive a real tool reply? | **Yes.** Real `mcp__app__reply` invocation, corresponding `is_error:false` / `Sent:` result, and matching durable `type:reply` outbox were inspected. First app hello, post-restart, smoke, post-cut, and post-reboot app messages all succeeded. Input acknowledgment alone and prose resembling tool calls were not accepted. |
| Did memory write/find/recall work? | **Yes.** App-origin synthetic event 1 (`amber kite app memory check`) and exact-guide event 2 (`cobalt lantern memory check`) were written and found through Lore tools. `recall(query="cobalt lantern recall check")` returned `InstallCheck_1.md#0` and its actual synthetic probe text. |
| Did a controlled cut create an archive file that could be found again? | **Yes.** Clean SIGTERM cut produced `Session_2.md`; upload events and authenticated remote `/list` independently confirmed it. A fresh post-cut app request called real Lore recall and returned `Session_2.md#5` containing the just-cut amber-kite transcript. The new life logged `bridge_loaded`. |
| Did everything return after a reboot? | **Yes, for the configured local Brain house.** New boot ID; app, Brain and external watchdog automatically active; no manual starts, login or permission intervention. Boot greeting and separate fresh app message each have real reply-tool/result/outbox proof. Swap persisted, other harness stayed inactive, correct named tmux returned, first UTC clock remained correct, and external watchdog state advanced while idle. Domain-dependent public access was not tested. |

## 1. Step-by-step result table

Results use the requested vocabulary. “fixed by me” includes documented local corrections, not a claim that source was patched. Individual failed attempts and skipped subchecks are preserved below rather than hidden by eventual success.

| Step | Result | Outcome |
|---|---|---|
| 0 — prerequisites, credentials and single-machine checks | ok | Required packages, Bun, pinned Wrangler and editor present; supplied Cloudflare identity works; root/Linux checks passed. |
| 1 — install source and home | ok | Used documented unpacked-repository alternative, `cp -a` into `/opt/embervy`, `git init`; correct Git root; `git diff --check` silent. |
| 2 — chronicle/archive worker | ok | R2, Vectorize, D1 and schema created; worker deployed; unauthenticated 401/authenticated 200, initially empty archive. |
| 3 — episodic memory worker | ok | Storage, schema, service binding and secrets deployed; corrected full Check gives unauthenticated 401/authenticated wake 200. Initial runner-scoping failure is documented separately. |
| 3b — dream worker | ok | Deployed, manual dream 200 and persisted `dream_last_run`; cron deliberately empty. Initial runner-scoping failure is documented separately. |
| 4 — substrate/runtime protections | ok | Native Claude Code, swap, ballast, journald/logrotate setup completed; runtime Check passed. |
| 5 — app/local service | ok | Foreground start then systemd; protected route, private login cookie, health and internal authenticated route pass after documented startup retry. |
| 5 — tunnel, public hostname, phone/PWA | skipped | No domain/zone supplied. No tunnel/DNS/public-hostname setup or public browser/phone test. |
| 6 — choose harness | ok | All four harness units initially inactive; selected only Brain. |
| 6a / other alternative harness or API-head branches | skipped | Mutually exclusive paths; no alternate head, Anthropic API key or ChatGPT subscription configured. |
| 6b — identity and head/profile/login | fixed by me | Subscription relay login succeeded; intended Claude pipe head. Corrected copied identity’s unsupported recall guidance after actual schema/probe exposed mismatch. |
| 6b — notebook | ok | Running head wrote and read note and index; shell independently verified relative link target. |
| 6b — loop/service queued check | ok | Restart produced new pid/life, real greeting and app round-trip, consumed bridge and uploaded `Session_1.md` through catch-up. Documented waits used. |
| 6b — app channel queued check | ok | Real MCP process; exact `installation app-channel check` delivered through reply tool with matching outbox. |
| 6b — inlet queued check | ok | Fresh app archive question caused relevant current-life `inlet_injected` including exact probe. No threshold weakening or hook substitution. |
| 6b — memory/runtime token check | ok | Root/app/MCP/Brain values match; workers authenticated 200. |
| 6b — First start | ok | Separate greeting and app-message tool successes; all units active, liveness 1, tokens increased 24,685 → 27,658. |
| 7b — external watchdog | ok | Both active; advancing timestamps during an idle repeat, session and 900,000 cut matched; repeated after reboot. |
| 7a / other-harness watchdog | skipped | Not the selected harness. Shared selected-service check was run. |
| 8 — app-origin memory smoke | ok | Real wake/write/find, embedded event 1 and successful app tool reply. |
| 8 — archive upload and exact recall probe | ok | Upload success with 1 chunk; real wake, event 2 write/find, recall of `InstallCheck_1.md#0`; separate app message and reply. |
| Queued 6b — controlled cut after smoke | ok | TERMINATED, clean exit, bridge OK, confirmed archive upload, new life, bridge loaded, post-cut transcript recall and fresh app reply. |
| 9b — Brain configuration preflight | ok | `ok:true`, exit 0; no owed uploads. |
| 9 — shared doctor | ok | PASS: 21 passed, 0 warn, 0 fail, 1 understood other-harness skip; exit 0. |
| 9 — finished-house sweep | fixed by me | Initial FAIL was a shipped inline-comment false positive. Removed only optional comment in both live env files; unchanged sweep and token check then pass. |
| 9a — other-harness doctor | skipped | Not selected; shared doctor and Brain preflight performed. |
| 10 — actual reboot | ok | Automatic recovery and separate real greeting/app reply proved; correct clock/swap/tmux, other harness inactive, advancing idle external watchdog. Public-app access portion skipped for no domain. |

## 2. Problems, exact references, workarounds and guide recommendations

### D1 — copied identity teaches a nonexistent recall parameter

- **Guide section:** 6b → Identity, `INSTALL.md:1168–1177`, especially the copy command at **1170**. It directs the newcomer to copy and retain the skeleton in `Claude/CLAUDE.md.example`.
- **Defective source text:** `Claude/CLAUDE.md.example:53–58` teaches recall as fetching a specific Lore event, and teaches **`recall(from_rag=true)`** for archive access.
- **What happened:** the erroneous guidance propagated into the filled `EMBERVY.md` and the identity-check answer. In the exact step 8 probe the running agent explicitly reported: “the recall tool only takes query and limit. It has no from_rag parameter, even though EMBERVY.md says recall(from_rag=true).”
- **Actual interface:** `shared/memory/src/index.ts:253–263` defines required `query` and optional `limit`; implementation at `1557–1574` always searches the chronicle. No `from_rag` property exists.
- **Command/check involved:** the exact step 8 tmux prompt at `INSTALL.md:2051–2052`, followed by real `mcp__lore__recall(query="cobalt lantern recall check")`. It returned `InstallCheck_1.md#0` (1.00), with the probe text. **No recall request failed:** the model followed the actual tool schema despite the misleading identity. This is a confirmed documentation/prompt defect, not broken retrieval.
- **Workaround:** corrected only the installed filled `/opt/embervy/EMBERVY.md` and my own `/opt/embervy/HANDBOOK.md` to `recall(query=...)`. Original source, shipped skeleton and guide remain unchanged.
- **What the guide/template should say:** use `find` for episodic memory search; use `recall(query, optional limit)` for long-term chronicle/session search. Remove the unsupported `from_rag` example and stale single-event description from the copied skeleton.
- **Evidence:** `check6b-identity.log`, `check8-recall-probe.log` and deployed/schema source.

### D2 — final sweep falsely rejects an untouched optional inline comment

- **Guide sections:** step 5 optional push configuration at `INSTALL.md:597–601` says to leave all VAPID settings empty without push. Finished-house sweep at `2176–2207`, specifically regex **2190** and full-line-comment skip **2196**, scans complete remaining lines.
- **Trigger, in both templates/live copies at line 54:**
  ```text
  VAPID_SUBJECT=               # a mailto: address of yours, e.g. mailto:you@your-domain; leave empty without push
  ```
  The assignment parses as empty, as requested. The **comment** contains `your-domain`, which matches case-insensitive `YOUR[-_]`. Whole-line comments are skipped but inline comments are not. The repository env parser explicitly supports this inline-comment form (`shared/scripts/env-file.sh:10–12,79`).
- **Command:** exact finished-house sweep plus token checker from `INSTALL.md:2176–2207`.
- **Actual initial output:**
  ```text
  /opt/embervy/.env:54: review template marker
  /opt/embervy/Claude/app/.env:54: review template marker
  placeholder sweep: review required
  [all token/URL groups match; memory/archive authenticated 200]
  final check: FAIL
  ```
- **Workaround:** removed only the illustrative inline comment from both installed env copies, leaving `VAPID_SUBJECT=`. Did not enable push, invent a domain, or modify source.
- **Exact unchanged rerun:** `placeholder sweep: clean`, all match groups, memory/authenticated 200, archive/authenticated 200, `final check: pass`.
- **What the guide should say/do:** ignore inline env comments using the existing parser (rather than treating a comment as a live value), or remove placeholder-looking language from the optional `.env.example` comment. A correct empty optional setting should not fail the finished-house gate.
- **Evidence:** `check9b-finished-sweep.log` and `check9b-finished-sweep-fixed.log`.

### U1 — local-only, browserless app testing needs an explicit recipe (adaptation)

- **Guide references:** 6b First start `INSTALL.md:1761–1767`, smoke `2011–2023`, and reboot **2251–2254** ask for app/public-app messages. Step 5 `635–637` expects browser shell use; tunnel/public checks are `736–768`.
- **Limitation:** there is no domain in the supplied account, and I did not open a browser. Public-hostname steps must be skipped under the user’s instructions. This is not evidence that the normal public installation is broken.
- **What was unclear:** neither these steps nor the app README supplies a localhost command-line message recipe for this constrained test. I inspected app implementation/public app JS instead of silently inventing an internal test path.
- **Explicit workaround, performed on the server:** `POST http://127.0.0.1:3030/api/auth` with JSON password, privately retain only the session cookie, then `POST /api/message` with JSON `text`, cookie and matching localhost `Origin`; use `GET /api/messages` for app history. These are the native app routes used by the frontend, not `/api/internal/broadcast`. The cookie is Secure; the programmatic client explicitly sends it over server loopback. Password and cookie were never printed. The helper is `/root/blindtest-drive.py`.
- **Proof standard:** inspect actual current-life tool use/result and durable `Claude/app/data/outbox.jsonl`. No fake reply or outbox injection; HTTP message acknowledgment was not counted as a reply. App shell was HTTP 200 / 1,189 bytes, but not visually rendered.
- **Recommendation:** document a safe optional local/SSH-forward or authenticated localhost smoke recipe, and distinguish transport/tool delivery from rendered UI and public-phone verification. `/run-skill-generator` could capture the tested local driver for repeat runs; no such skill was created during this test.

### Timing observations — resolved with waits, not persistent installation failures

1. **App restart:** exact `INSTALL.md:770–776` Check immediately after restart gave `active`, then `curl: (7) Failed to connect to 127.0.0.1 port 3030`, HTTP `000`. The guide already permits waiting and retrying at **778–779**. After 3 seconds, health `{"ok":true}`, internal auth 200 and login 200. No config change needed. Evidence: `check5-service.log`, `check5-service-retry.log`.
2. **Brain first-start socket:** `INSTALL.md:1748–1753` immediate tmux query gave `error connecting to /tmp/tmux-0/brain (No such file or directory)` while units were active. After 8 seconds the named session existed and the real greeting completed. During queued restart (`1408–1419`), immediate state still had the previous pid/life and tmux had no server; after the prescribed wait/re-read, new life/pid and reply succeeded. The first-start block could explicitly mention the same socket-creation delay; do not diagnose a boot failure from an immediate tmux probe alone.
3. **Reboot reconnect:** first SSH attempt about 15 seconds after `reboot` gave `ssh: connect to host <test-server> port 22: Connection refused` (exit 255). Waiting another 20 seconds restored access; services had started themselves. This was ordinary reboot timing, not manual recovery.
4. **Pinned Wrangler warning:** 3.114.17 warns that 4.151.1 is available. I retained the guide’s pin; deployment and checks succeeded. Not treated as a guide failure.
5. **Logrotate debug:** warns that debug mode makes no changes and skips not-yet-created log globs. This is expected for the prescribed dry run, not a failed logrotate configuration.

### Test-runner mistakes / expected temporary state — not attributed to the guide

- **Pipeline subshell scoping:** my evidence wrapper `{ generated-variable work; ...; } | tee ...` kept newly generated shell variables in the pipeline subshell. Correct values had already been persisted in env files, but later checks in the parent shell sent an empty bearer. Initial memory authenticated leg returned `error code: 1042`, HTTP 404; initial dream authenticated leg returned `{"error":"unauthorized"}`, HTTP 401. Reloading the saved files using the repository’s data parser and repeating the *entire* Check yielded expected unauthenticated 401/authenticated 200. No secret regeneration or worker fix. Evidence includes `check3.log`, `check3-retry.log`, `check3-corrected-runner.log`, `check3b.log`, `check3b-corrected-runner.log`.
- **Login-pending preflight:** preflight while relay sign-in was incomplete correctly returned `ok:false` / “Claude is not logged in on this server”. After login it returned `ok:true`, exit 0. Expected gating, not a broken installer.
- **Postboot watchdog capture mistake:** my first postboot capture read app-compatible `/opt/embervy/state/watchdog_state.json` with invented `session`/`cut` keys, resulting in nulls. That is not the required external-watchdog check and is not counted as such. Reran exact step 7b on **`/opt/embervy/Brain/state/watchdog_state.json`**, with `session_id` and `cut_tokens`, separated by 65 idle seconds; both values match current context and timestamp advances. Evidence retains both `check10-watchdog-idle.log` and `check10-watchdog-idle-corrected.log`.

## 3. Every required Check: shortened actual-output ledger

All evidence paths in this section are under `/root/blindtest-evidence/` unless absolute. Secret values are omitted; secret names are not secret. Queued checks were executed after First start and after smoke where the guide requires that ordering. Alternatives are marked skipped, not passed. The step 7 idle check was repeated without model work during the wait; the cut was performed while idle after sufficient substantive turns.

| Guide section / lines | Shortened actual output and interpretation | Evidence |
|---|---|---|
| 0 — 101–110 | `wrangler whoami`: logged in with supplied Account API Token, correct supplied account; Bun `1.3.14`; Python `3.13.5`; Git `2.47.3`; OpenSSL `3.5.7`; editor `/usr/bin/nano`; `id -u` → `0`; `uname -s` → `Linux`. | `check0.log`, `step0-bootstrap.log` |
| 1 — 139–144 | Git root `/opt/embervy`; `git diff --check` no output. Unpacked source initialized as documented; silence does not validate untracked files, as guide warns. | `check1.log` |
| 2 archive — 239–245 | Secret list: `RAG_AUTH_TOKEN`; unauth `/list` **401**; auth `{"files":[]}` / **200**. | `check2.log` |
| 3 memory — 337–343 | Secrets: `APP_PUSH_TOKEN`, `EMBERVY_API_KEY`, `OPENROUTER_API_KEY`, `RAG_AUTH_TOKEN`; unauth **401**; auth JSON-RPC real `# Wake — Saturday, 17/10/2026, 17:11 (... UTC)`, initial mood, zero todos/observations, daemon never; **200**. | `check3-corrected-runner.log` (earlier failed runner attempts retained) |
| 3b dream — 406–412 | Secrets: `DREAM_AUTH_TOKEN`, `OPENROUTER_API_KEY`, `RAG_AUTH_TOKEN`; unauth **401**; auth `status:"dreamed"`, content present, **200**; memory health `dream_last_run:"2026-10-17 17:11:58"`, daemon null/never warning deliberately understood. | `check3b-corrected-runner.log`, `step3-health.log` |
| 4 runtime — 488–496 | Bun `1.3.14`, home `/opt/embervy`, native CLI `/root/.local/bin/claude`, `2.1.302`; swapfile **4G**; RAM **3.7Gi**, swap **4.0Gi**; disk **38G**, **25%** used; logrotate debug parses stanza, missing new log globs skipped. | `check4.log` |
| 5 login — 625–633 | Unauthenticated internal-model request **401**. Login `HTTP/1.1 200 OK`; `set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`. | `check5-login.log` |
| 5 public/tunnel — 736–768 | **Skipped:** no zone/domain/public hostname. No public phone/PWA claim. | Scope constraint; no tunnel was created |
| 5 service restart — 770–782 | First `active` then curl (7)/000; documented retry: health `{"ok":true}`, internal bearer **200**, login **200**, chat shell HTTP **200**, bytes **1189**. | `check5-service.log`, `check5-service-retry.log`, `app-shell.html` |
| 6 branch choice — 800–804 | `embervy-loop`, `embervy-watchdog`, `embervy-brain`, `embervy-brain-watchdog`: all **inactive** before selection; selected Brain only. | `check6-choice.log` |
| 6b identity/clock — 1300–1305 | Actual `Read` of `/opt/embervy/EMBERVY.md`, headings listed; clock `⏰ UTC: Saturday, 17.10.2026, 17:17`; actual reply tool/result/outbox. Identity initially reflected bad recall template; see D1. | `check6b-identity.log` |
| 6b notes — 1336–1349 | Real Write/Read of `notes/installation-check.md`, frontmatter name/description/type intact, body **cobalt notebook check**; `notes/NOTES.md` has relative link. Independent check: **Notes link target exists**. | `check6b-notes.log`, `check6b-notes-link.log` |
| 6b loop queued restart — 1408–1420 | `active`; immediate stale pid/no tmux server, then settled new pid **10763**, session **1792257538934-7mn3sx**, intended Claude/pipe/thresholds; new real greeting and fresh app round-trip. `catch_up_archived ... Session_1 ... uploaded:true`; remote `Session_1.md` **5558 bytes**. | `check6b-loop-restart.log`, `check6b-loop-restart-settled.log`, `check6b-after-restart-message.log`; current session events |
| 6b cut/watchdog queued — 1453–1473 | Decision `none 42524 4 900000 10763 1792257538934-7mn3sx below thresholds`; alive **1**; `SIGTERM`, `clean exit`, **bridge OK (13137 bytes)**, **TERMINATED** in 11s, never SIGKILL. Upload and post-cut recall proof below. | `check6b-controlled-cut.log` |
| 6b app process / exact text — 1568–1580 | Config `bun run /opt/embervy/Claude/app/mcp.ts`; running processes found (second was own still-open native-login CLI, later closed). Actual `mcp__app__reply` text exactly **installation app-channel check**, result **Sent: installation app-channel check**, exact matching outbox. | `check6b-app-process.log`, `check6b-app-exact.log` |
| 6b automatic inlet queued — 1613–1625 | Fresh app archive question; same-life `inlet_injected` includes **[InstallCheck_1.md] (100% [bm25+rerank])** and exact probe. Real reply names cobalt-lantern phrase. No `inlet_worker_failed`. Early empty-archive gated results were expected. | `check6b-inlet-archive-question.log`, `check6b-inlet.log` |
| 6b prestart token consistency — 1678–1684 | memory bearer/URL, archive bearer/URL, app internal/push bearer, Brain memory/archive bearer/URL, Brain app bearer: all **match**; memory and archive **authenticated 200**. | `check6b-tokens.log` |
| 6b First start — 1748–1759, 1772–1783 | All three **active**; pid **10366**, life **1792257424714-bhsa8e**, head **claude**, model **claude-opus-5-5[1m]**, **pipe**, warn **800000**, cut **900000**; alive **1**. Separate greeting and fresh app tool successes; context tokens **24685 → 27658**. Named `brain` socket/session, not house session on default socket. | `step6b-start.log`, `check6b-first-before-message.log`, `check6b-first-app-message.log`, `check6b-first-after-message.log`; first-life session log |
| 7 selected watchdog shared check — 1860–1867 | Selected `embervy-brain-watchdog` active (with app/Brain active). Other-harness units remain inactive. | `check7b-live.log`, repeated in `check10-reboot-initial.log` |
| 7b — 1957–1962 diagnostics; 1976–1989 idle Check | Both **active**; idle repeat external timestamp **17:22:59.523013 → 17:24:59.887343 UTC**; session **1792257748872-2ye6ux**, cut **900000**, watcher pid **10694**. First sample still reflected prior model state (28461 tokens), next 34415; no model turn during this repeat. Diagnostic journal/context/logs inspected. | `check7b-live.log`, `check7b-idle-repeat.log` |
| 8 Brain app-origin smoke — 2011–2023 | Real wake; real write **event 1**, observation/light, embedded **1**; find **1 event**, id **1**, exact **amber kite app memory check** synthetic text; real app reply `Sent:` and outbox. | `check8-app-wake-write-find.log` |
| 8 status/context — 2011–2023 | App `/status` delivered: head **claude (pipe)**, requested **claude-opus-5-5[1m]**, served **claude-opus-5-5**, CLI effort **medium**, window **42524/1000000**, warn **800000**, cut **900000**, pipe alive, inlet on. Context record matches. Native slash-command response is not counted as model-tool proof. | `check8-status.log`, `check8-context.log` |
| 8 synthetic archive probe — 2034–2053 | Multipart upload `{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}`. Exact tmux prompt used, no paraphrased substitute. | `check8-probe-upload.log`, `check8-recall-probe.log` |
| 8 tool verification — 2055–2074 | Real wake, write **event 2**, embedded; find **1 event**, id **2**, **cobalt lantern memory check**. Real recall **8 hits**, top **InstallCheck_1.md#0 (1.00)**: “The probe phrase is **cobalt lantern recall check**. It is test data, not an experience.” Real app reply/result/outbox. Separate app question and relevant inlet verified; later separate app message read saved notebook and replied “ready for reboot check”. | `check8-recall-probe.log`, `check6b-inlet-archive-question.log`, `check8-separate-app-reply.log` |
| Controlled-cut upload / next life — 1463–1473 and 2062–2074 | Old log: `session_archive_upload ... Session_2 ... ok:true parts:1`, `session_archived ... uploaded:true reason:SIGTERM`; remote **Session_2.md**, **7950 bytes**, upload **17:22:22.633Z**. New life **1792257748872-2ye6ux**, pid **11497**, `bridge_loaded` **17:22:37.294Z** (13101 chars); `bridge.used.md` exists. | `check6b-cut-archive-proof.log`, `check6b-postcut-life.log`, controlled-cut old-life log |
| Post-cut explicit transcript recall | Fresh app message → real `mcp__lore__recall(query="amber kite app memory check", limit=5)` → top **Session_2.md#5**, approximately **0.993**, exact synthetic observation from cut transcript; four other Session_2 chunks. Real reply begins **post-cut app received.** | `check6b-postcut-transcript-recall.log` |
| 9b config / shared doctor — 2110–2112, 2123–2125, 2138–2143 | Preflight **ok:true**, **exit=0**, no uploads owed. Shared doctor **PASS (21 checks passed, 0 warn, 0 fail, 1 skip)**, **exit=0**. Only skip: active substrate Brain, so other-harness headless canary not applicable. | `check9b-preflight.log`, `check9b-doctors.log` |
| 9 finished-house sweep — 2176–2207 | Initial two line-54 template-marker flags / **FAIL**; after comment-only workaround exact rerun **placeholder sweep: clean**, all token/URL groups **match**, memory/archive **authenticated 200**, **final check: pass**. | `check9b-finished-sweep.log`, `check9b-finished-sweep-fixed.log` |
| 10 actual reboot / selected Brain Check — 2223–2231, 2242–2248 | `reboot` executed; boot ID changed **36e8b6fb-d920-4fbc-a477-3a5a9a2fa5cc → 407623cf-f3a9-41ef-8b52-c9102312ff03**; boot time **17:26:15**. Three selected units **active**, health `{"ok":true}`, new pid **1023**, life **1792257992935-r7iver**, intended Claude/pipe/model/thresholds; alive **1**. No manual starts. | `reboot-requested.txt`, `pre-reboot-boot-id.txt`, `check10-reboot-initial.log`, `check10-reboot-final.log` |
| 10 boot greeting separate proof — 2227–2231 | At **17:26:56.959Z**, actual reply tool **toolu_012YQW2JyP3Xb9iPVZYo8C3W**; result **17:26:57.013Z**, `is_error:false`, `Sent: Hello again, I'm back after the reboot...`; distinct matching outbox **570c7f37-1df0-457f-aa2e-078cd91aa9e9**. | `check10-greeting-proof.log` |
| 10 fresh app message / clock — 2250–2256 | App input **85858870-66e4-418e-837f-c29340a997a9**; actual reply **toolu_01V6DwdrW3Pr2nXUpbGmpTn7**, `Sent:` / non-error; outbox **c93cddaf-ba6b-47ec-bfd6-9ec492c9a098**, reply_to matches input. Text **reboot app round-trip received**; first-life clock **⏰ UTC: Saturday, 17.10.2026, 17:26**, timezone UTC, matching boot clock. | `check10-fresh-app-message.log` |
| 10 repeat exact external-watchdog idle Check — 2252–2256 / 1979–1981 | Both **active**; external timestamp **17:33:33.925393 → 17:34:34.114327 UTC** across 65 seconds; same current session **1792257992935-r7iver**, tokens **31461** both, cut **900000**, external watcher pid **894**. Brain context pid **1023** is distinct, as expected. | `check10-watchdog-idle-corrected.log` |
| 10 other recovery checks | `/swapfile` **4G** present; other harness **inactive/inactive**; `tmux -L brain ls` has **brain: 1 windows** created **17:26:32**; default tmux server absent, acceptable. Current log `bridge_loaded` **17:26:41.371Z**, `catch_up_archived ... Session_3 ... uploaded:true` **17:26:45.530Z**. Final remote list also includes Session_3; selected services enabled. | `check10-reboot-initial.log`, current-life log, `final-persistence.log` |

### First-start and exact-channel outbox cross-checks

For traceability beyond model prose:

- Initial greeting: actual successful `mcp__app__reply` **17:17:18**, outbox **f8cab8c8-8021-4202-836d-2164675cef2d**. The first life really read `INFRASTRUCTURE.md` and `HANDBOOK.md` and called Lore wake before replying. Session log: `/opt/embervy/Brain/logs/session-1792257424714-bhsa8e.jsonl` (greeting tool/result around lines 25–32).
- First fresh app message **1c34daac-487b-4c40-90dc-45a4564f4abf** → reply **“Hello Tester! first app hello received.”**, outbox **9ce6e03b-c3b1-4d79-b545-c29341779c3c**, reply_to matches input.
- Exact terminal app-channel text: outbox **72843b5a-ba42-4485-8ca7-2953d6636919**, exactly **installation app-channel check**. Native MCP tool result `Sent:` was checked, not gateway fallback.
- Post-cut app message **d9ee90cc-b556-44ea-9470-0c625d96ff86** → actual recall and real reply, outbox **17f04151-d8d5-48e4-9e33-6113dbd94a52**.
- Preboot app message **78e55926-9468-4f23-b50f-6cccc3cab69d** → actual notebook `Read`, real reply, outbox **730c09ac-d120-4b74-865e-16f207deebee**. This was separate from the boot greeting and from the fresh postboot message.

### Shared doctor details

The doctor independently verified memory/archive reachability and bearer validity; both unauthenticated routes reject with 401; hybrid retrieval `vector 8 / bm25 16`, FTS5 16 hits, reranker `[bm25, rerank]`; inlet 2,735 bytes with retrieved hit; house MCP 2/2 connected in latest pipe initialization; identity loaded once, Brain inlet wired, notes/index present; writable state, disk 26% used / 26.7GB free, swap 4GB, no dangerous defaults. `daemon never — not due yet` is understood because schedules were intentionally disabled; the manual dream had succeeded recently. Header enrichment was configured with a working subscription login and actual archive events, not treated as proven solely by the doctor.

## 4. Configuration and authorization record

- Installed **Bun 1.3.14**, **Wrangler 3.114.17** (guide pin), **native Claude Code 2.1.302**, Python 3.13.5, Git 2.47.3, OpenSSL 3.5.7.
- Head: **Brain `claude` pipe on the existing Claude subscription**, not the alternative Claude harness. Repository default requested `claude-opus-5-5[1m]`, served `claude-opus-5-5`; no model substitution. Context 1,000,000; warn 800,000; cut 900,000. Profile is `Brain/brain.env`, identity is `EMBERVY.md`; no `CLAUDE.md`/`AGENTS.md` beside it.
- **Relay login only:** ran native `claude` onboarding inside server tmux `blindtest-login`; selected subscription sign-in; wrote the URL alone to `/root/blindtest-login-url.txt`; polled for `/root/blindtest-login-code.txt` every 15 seconds (30-minute limit); privately typed the supplied code into the waiting prompt; successful sign-in, then deleted both files. Continued native security/project-trust prompts and explicitly approved project app/Lore MCP servers. No browser opened, no code/token printed, no alternative authentication route. Closed only my own login session afterward. Final check confirms both relay files absent.
- Created selected `embervy-app`, `embervy-brain`, `embervy-brain-watchdog` units exactly from the guide; watchdog enabled as Brain dependency/BindsTo. Other harness remains inactive. No manual postboot service start.
- Native MCP app uses `bun run /opt/embervy/Claude/app/mcp.ts`; Lore HTTP MCP points to the memory worker with private bearer. Local root/app/Brain/MCP token equality checker passed. Narrow documented permissions only; no shell permission granted to installed head, no UserPromptSubmit inlet hook. Brain owns inbox, session/bridge/archive/watchdog state; automatic inlet runs through Brain’s configured worker.
- House docs were filled with actual infrastructure/module/secret-location information, never secret values. New identity has no invented biography. The notebook was written by the running head, not prepopulated by the operator to fake tool evidence.
- Used the repository `shared/scripts/env-file.sh` to load env as **data**. Did not `source` secret env files. Root/app env and MCP configuration are private mode 600. Secret names, not values, appear in this report.
- Protection: 4GiB persistent swap with swappiness 10; 2GiB reserve ballast; journald cap 500MB; diagnostic-only logrotate stanza excluding Brain conversation/session JSONL.
- Cloudflare resources created successfully with documented commands: workers **embervy-chronicle**, **embervy-memory**, **embervy-dream**; D1 **rag-fts / embervy-memory**; Vectorize **rag-vectors / embervy-vectors** (1024 cosine); R2 **rag-storage / embervy-archive**. Worker hosts are `*.<account>.workers.dev`. No zone/domain was added.
- **No Cloudflare purchases, domain registration, plan/subscription/billing changes, or paid-plan enablement.** All deployments succeeded without such a change. No Anthropic API key or ChatGPT subscription was set up. No preexisting resource was deleted.
- **Memory daemon and dream cron arrays deliberately left empty**, as permitted to conserve cost; one manual dream Check did run. No automatic daemon run or scheduled dream behavior is claimed. Brain status showed its default auto cache ping at 50 minutes; no 50-minute ping fired within the measured run.
- Optional push/VAPID, mail, calendar, voice/images, video, and public-domain modules remained disabled/unconfigured. No browser UI visual/phone/PWA test. These are understood scope skips, not unreported passes.

## 5. Time and cost accounting

- Whole-run start (first source/SSH read): **2026-10-17 17:07:03 UTC**. Bootstrap timestamp in `start.txt`: 17:07:20 UTC.
- Final functional checks completed by 17:34:34 UTC; accounting/report timestamp: **2026-10-17 17:38:42 UTC**. Elapsed wall time including relay, deployment, prescribed idle waits, reboot/reconnect and report preparation: **31 minutes 39 seconds**. This is not pure unattended install time or human effort time.
- OpenRouter key usage baseline at **2026-10-17 17:08:51.943753 UTC**: **$<key total>**. Final at **17:38:42 UTC**: **$<key total>**. **Measured key usage difference: $0.008329520**, far below the authorized **$1** limit. This is the key’s actual usage-counter difference, not a model-price estimate; it includes the test’s OpenRouter dream/memory/inlet calls and doctor retrieval. It assumes no unrelated simultaneous user of this key. Some initial bootstrap time predates the baseline, but no OpenRouter model call was made before it.
- Evidence: `openrouter-before.json`, `openrouter-after.json`, `usage-summary.json` (metadata only, no key).
- Cloudflare: **no purchases or paid-plan changes; no authorized monetary spend**. Resources deployed within the account’s available free capabilities. No invoice/billing screen was inspected, so this is not an invoice audit or a guarantee about later platform accounting.
- Claude head: existing subscription, **no Anthropic API key/API billing configured**. No new subscription purchase. Monetary value of subscription token usage is not fabricated; the token counts below are the requested actual Brain-log measurement.

### Subscription head token usage from Brain logs

Summed `type:"usage", head:"claude"` records in `/opt/embervy/Brain/logs/session-*.jsonl`, deduplicating by event `id` (none duplicated). **51 usage events**: 16 `internal`, 35 `turn`, all served model `claude-opus-5-5`.

| Brain life | Uncached input | Output | Cache read | Cache write |
|---|---:|---:|---:|---:|
| `1792257424714-bhsa8e` | 28 | 2,604 | 338,088 | 29,280 |
| `1792257538934-7mn3sx` | 40 | 3,473 | 605,248 | 33,372 |
| `1792257748872-2ye6ux` | 22 | 1,985 | 321,425 | 27,458 |
| `1792257992935-r7iver` | 12 | 891 | 156,565 | 22,309 |
| **Total** | **102** | **8,953** | **1,421,326** | **112,419** |

These are cumulative usage counters across tool-loop model calls, not one context-window size. The small `input` column excludes cached input: prompt processing totals **1,533,847 tokens** when uncached input + cache read + cache write are combined; output is **8,953 tokens**. No API-dollar conversion is applied to subscription tokens.

**Coverage caveat:** standalone archive-header helper `Claude/scripts/enrich-header.sh` calls a separate `claude -p --agent auto-rag-header`, unsets inherited API credentials, and extracts only header text from its stream. Its token usage is **not represented by these main-head Brain usage records** and is not guessed here. External inlet helpers have no Brain usage protocol; their cash use is covered by the OpenRouter key difference instead. Thus the table is precisely “head token usage from Brain’s logs,” not a claim to meter every subscription helper independently.

## 6. Evidence and handoff

- Requested deliverable: **`/root/blindtest-report.md` on the disposable server** (this file).
- Evidence: **`/root/blindtest-evidence/`**. Check files preserve early failures and successful full retries; deployment/bootstrap logs are retained separately. Working observations: `/root/blindtest-observations.md`.
- Helpers created for this test: `/root/blindtest-prelude.sh` (safe data-parser env loading), `/root/blindtest-drive.py` (native localhost app/terminal driver and redacted actual-tool evidence), `/root/blindtest-final-sweep.sh` (exact extracted guide sweep), installed `state/install-token-check.ts` (exact guide checker). These are not alternative application implementations.
- Services are left running and enabled; workers/storage and synthetic test notes/events/archives are retained for inspection. No source or unrelated resource was deleted. Cron schedules remain empty. No final reboot/cut was issued after the verified reboot.
- An independent read-only coverage audit inspected the guide, Check evidence and relevant tool/schema source. It found no additional pre-reboot functional gap and independently confirmed D1/D2. Postboot validation and accounting were completed separately as recorded above; the audit did not send messages, modify files, install anything or make model calls.

### Recommended guide changes, in priority order

1. Correct the copied identity’s `find`/`recall` semantics and remove `from_rag=true`.
2. Make the finished-house env sweep understand inline comments, or remove the trigger from the shipped optional VAPID comment.
3. Add a documented optional localhost/SSH-forward app smoke route for installs without a public hostname, with explicit tool-result/outbox proof and no claim of visual UI verification.
4. Mention the short named-tmux creation delay beside the first-start probe, consistent with the existing restart wait/re-read guidance.

**Bottom line:** the newcomer Brain path reached a working, reboot-resilient house. The main blocking final-gate false positive and the misleading identity API instruction are reproducible documentation issues. Public-domain/UI and intentionally disabled scheduled/optional modules remain explicitly unverified; all required applicable Brain Check blocks have actual recorded output, including the queued checks, recall probe, controlled cut, doctor/sweep and reboot.
