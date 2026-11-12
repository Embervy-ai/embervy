# Embervy manual installation blind test — Brain / API / OpenRouter

## Scope, method and verdict

- **Host:** disposable Debian 13 server `<test-server>`; all installation work and changes were performed there as root. No software was installed or configuration changed on the starting machine.
- **Source:** supplied unpacked `/root/embervy-src`; installed house `/opt/embervy`. Line references below are to the original **`/root/embervy-src/INSTALL.md`**. That source was not patched. Only installation configuration, identity/house documents, state and test helpers were created in the installed copy/on the disposable server.
- **Head:** Brain `api`, OpenRouter `qwen/qwen3.5-9b`, configured window 262144, WARN 209715, CUT 235929. No Claude/ChatGPT subscription, CLI installation, or header enrichment.
- **Evidence:** `/root/blindtest-artifacts/` contains check scripts, combined stdout/stderr, app inputs/history, and extracted structured tool evidence. Full conversation/session logs remain in `/opt/embervy/Brain/logs/`. Outputs below are shortened, not invented. Secret values and session cookies are never printed; cookie headers are redacted. An evidence secret-value scan is clean.
- **App method:** authenticated `POST /api/auth`, then cookie-authenticated `POST /api/message` with `{text}`, and `GET /api/messages`, exactly the HTTP channel used by the shipped PWA. No direct inbox injection was used for app-originated tests. The command-line client was derived from this repository's `Claude/app/public/app.js:1498–1505` and `Claude/app/server.ts:1130–1179,1625–1641`. The authenticated HTML shell loaded (HTTP 200, 13495 bytes, app.js present); this was **not a visual browser/phone test**. Cookie values stayed in process memory.
- **No public app domain:** custom routes, DNS, named tunnel, public HTTPS, phone pinning and public-app messaging were skipped as explicitly required by the test constraints. Localhost app messaging is verified instead; it does not certify public access or worker-to-public-app push.
- **Cloudflare:** two D1 databases, two Vectorize indexes, two R2 buckets and three Workers were created successfully in the supplied account. No purchase, domain registration, plan/subscription change, or billing-setting change was made. Memory and dream cron arrays were left empty as permitted. The manual dream Check still ran and wrote a note.

**Overall:** the local house, real app replies, notebook (after a targeted model retry), memory write/find, explicit archive recall, automatic inlet, controlled cut, archive upload, doctors and cold-boot service recovery all worked. **The strict reboot greeting did not pass:** after reboot the model wrote only terminal prose for its automatic greeting, with no reply-tool call and no new outbox entry. A fresh app message after boot did get a real tool-delivered answer. Do not interpret service recovery as proof that this automatic greeting was delivered.

## 1. Step result table

`fixed by me` includes explicit fixture adaptations and targeted retries; it does not imply a source-code patch. Documented startup waits are distinguished from actual defects.

| Step | Result | One-line outcome |
|---|---|---|
| 0 — prerequisites | fixed by me | Dependencies/account checks pass; same-host nested SSH lacked host trust, so used direct id/uname on the target. |
| 1 — repository/home | fixed by me | Used supplied unpacked tree at /opt/embervy and git init instead of an unspecified fork URL; path/diff checks pass. |
| 2 — rag archive | ok | Resources/schema/deploy pass; unauthenticated 401, authenticated empty files array/200. |
| 3 — memory | ok | Resources/schema/secrets/service binding/deploy pass; unauthenticated 401, real wake/200. |
| 3b — dream | ok | Deployed third worker, manual dream returned dreamed/200 and health showed dream_last_run. |
| 3/3b — cron scheduling | skipped | Both schedules deliberately empty to avoid ongoing model costs; daemon itself not exercised. |
| 4 — VPS | ok | Bun/runtime dependencies, 4 GB persistent swap, 2 GB ballast and valid logrotate configuration. |
| 5 — local app | ok | Real login boundary and app shell pass; immediate restart HTTP race resolved using documented wait. |
| 5 — public app/tunnel | skipped | No domain/zone; no public-hostname or named-tunnel setup or public phone test. |
| 6 — harness selection | ok | All four harness/watchdog units initially inactive/absent; only Brain pair installed. |
| 6a / 6c — other subscriptions | skipped | Not on Brain API path and no Claude/ChatGPT subscription supplied. |
| 6b — identity/API file tools | ok | Real read_file and reply tool returned filled identity, headings/tools and actual UTC clock. |
| 6b — Notes | fixed by me | Model initially made wrong path/link; targeted app retry corrected link using real edit/read tools. |
| 6b — loop service | ok | Idle restart produces new life and Session_1 catch-up upload; startup reads needed documented wait. |
| 6b — app channel | fixed by me | Real MCP reply and outbox pass; an extra targeted retry obtained the exact check string without suffix. |
| 6b — inlet | ok | Current-life inlet_injected includes InstallCheck_1.md and its exact synthetic phrase. |
| 6b — memory/chronicle tokens | ok | All 11 URL/bearer groups match; both workers authenticated 200. |
| 6b — First start | ok | House documents read through actual tools; greeting and new app hello both delivered by reply tool. |
| 6b — controlled cut | ok | Clean SIGTERM, bridge OK, no SIGKILL; Session_2 confirmed uploaded and recalled in next life. |
| 7 / 7b — watchdog | ok | Enabled bound external watchdog; same-life timestamp advances and observes real token changes. |
| 8 — memory/archive smoke | ok | Real wake/write/find plus archive recall/probe, separate app answer and status pass. |
| 9b — Brain preflight | ok | Before-first-start JSON ok:true / exit 0; repeated Check also exit 0. |
| 9b — shared doctor | ok | Default PASS with documented header-related skips; verified-query run PASS, 21 checks, no warnings/failures. |
| 9 — finished-house sweep | ok | Clean placeholder scan, matching tokens/URLs and authenticated workers. |
| 10 — reboot, strict whole check | failed | Services/swap/new life/fresh app reply returned automatically, but automatic greeting was not delivered. |

## 2. Problems, failures and explicit adaptations

### P1. No concrete fork URL or unpacked-source procedure

**Exact sections:** step 1 “Clone the repo”, lines **115–137**, especially **118–126**; step 4 lines **422–425**. README manual quick start likewise uses `<your-fork>.git` at README.md:149.

**What happened:** the task supplied `/root/embervy-src` without `.git`, not a fork URL. A literal `<your-fork-of-Embervy>.git` is a placeholder, not a runnable clone command. I did not invent an upstream, run a fake clone, or overwrite an existing house.

**What I did:** verified `/opt/embervy` did not exist, ran `cp -a /root/embervy-src /opt/embervy`, then `git -C /opt/embervy init`, exported EMBERVY_HOME and added the export to root's .bashrc. No commit was created. Git checks returned `/opt/embervy` and no whitespace errors, but this does **not** verify upstream provenance/history. The clone at step 4 was not repeated over this same-host house.

**Guide should say:** give a concrete upstream/fork prerequisite and an unpacked-source alternative; clarify that on the single-host route step 4 reuses the already-created house instead of cloning over it. This is principally a test-fixture adaptation, not evidence that a valid fork clone fails.

### P2. Prerequisite SSH Check lacks a same-host variant

**Exact section:** step 0, single-machine allowance **52–55**, Check **99–111**, command **104**.

**Command/result:** `ssh root@<test-server> 'id -u; uname -s'`, run from the target as required, returned **`Host key verification failed.` / exit 255**. The target lacked host-key trust for this nested SSH connection; the outer SSH connection worked. Authentication beyond the host-key check was not tested.

**What I did:** did not disable host verification or copy credentials. Ran `id -u; uname -s` directly on the same target and got `0` and `Linux`.

**Guide should say:** if workstation and VPS are the same machine, use the direct local identity/kernel check instead of requiring a second SSH trust/key setup.

### P3. A healthy loaded bridge disappears from its advertised filename

**Exact sections:** 6b “Cut and watchdog” **1328–1352**; “Memory and chronicle” **1521–1522**; step 7b **1830–1832**; smoke test **1886–1887**.

**What happened:** controlled cut printed `bridge OK (7911 bytes)` and wrote `bridge_written`; after the new life started, `ls -l /opt/embervy/Brain/logs/bridge.md` returned **`No such file or directory`**. The guide tells a newcomer to inspect the local bridge and names only `Brain/logs/bridge.md`, so this looks like a lost bridge.

**What I did:** inspected the actual repository and logs instead of recreating/overwriting a bridge. Found **`Brain/logs/bridge.used.md` (7911 bytes)** and current-life `bridge_loaded` with 7879 characters. `Brain/brain.ts:1489–1491` renames the configured `.md` to `.used.md` when loading it.

**Guide should say:** before loading, inspect bridge.md; after loading, expect bridge.used.md and a current-life bridge_loaded event. Include both filenames in the verification instructions. No runtime patch was needed.

### P4. Notes Check: the prescribed small model falsely claimed link verification

**Exact section:** 6b “API file tools” **1194–1200** and “Notes” Check **1243–1252**, especially prompt **1246**; retry policy **1853–1857**.

**What happened:** the exact guide prompt produced a real `write_file` call to `opt/embervy/notes/installation-check.md`, rejected with **`error: 'opt/embervy/notes/installation-check.md' is not on the write allowlist`**. The model self-corrected to `notes/installation-check.md`. It then wrote `[Installation check](notes/installation-check.md)` into notes/NOTES.md, which resolves to nonexistent notes/notes/installation-check.md, and claimed both files had been verified. The prompt already explicitly supplied the correct relative link.

**What I did:** waited for completion, then sent a targeted new app request only for the missing correction, as step 8 permits. Real edit_file changed it to `[Installation check](installation-check.md)`; real read_file results showed both the corrected index and saved `cobalt notebook check`. The link target exists. No allowlist expansion or manual notebook write was used.

**Guide should say:** the path/link instructions are already correct; add a mechanical link-resolution assertion and warn explicitly not to accept a successful write/read or the model's “verified” claim as proof of a valid Markdown link. This was model noncompliance, not a bad documented path.

### P5. App-channel exact-string check needed a stricter retry

**Exact section:** 6b “App channel” Check **1445–1456**, especially **1450,1453–1455**.

**What happened:** the exact guide prompt produced a genuine tool-delivered reply, but its text was `installation app-channel check: message sent successfully.` rather than exactly the three-word check string. The MCP process/path was correct and this was not fallback.

**What I did:** sent a one-tool app request requiring text exactly `installation app-channel check`, with no prefix/suffix. Actual call/result and outbox then matched exactly.

**Guide should say:** if exact equality is the intended gate, phrase the prompt as “text exactly …, no prefix or suffix”; otherwise say the expected phrase need only be contained. This is an ambiguity/model formatting issue, not broken channel wiring.

### P6. Reboot automatic greeting was not delivered

**Exact sections:** 6b “App channel” fallback description **1423–1424**; “First start” greeting setting **1595–1604**, first-start expectation **1640–1643**; step 10 **2075–2077,2095–2101**.

**What happened:** actual `reboot` changed the boot ID and produced a new Brain life. All three units were active with no manual start. At **10:58:44.493Z**, however, the automatic greeting was only this assistant content: `Hello. Installation check complete. Ready for your first request.` There was **no structured mcp__app__reply call/result, no new outbox entry, and no reply_gateway_sent/failed event** for that greeting. It is not counted as a delivered greeting. A new authenticated app question at 10:58:50 did correctly call mcp__app__reply and create an outbox entry at 10:58:57.

**What I did:** preserved conversation/event/outbox evidence, sent the required fresh app message, and verified its real tool result and UTC clock. Did not manually start/restart services or change the model/prompt to hide this failure. The strict boot-greeting gate remains failed even though services and subsequent messaging recovered.

**Repository diagnosis / guide correction:** The model did not follow the prompt-level tool instruction, and the harness did not enforce or retry it. There is also a concrete documentation omission: **fallback is app-source-only**, not a fallback for internal greetings. `Brain/brain.ts:4403–4408` queues greetings as source `internal`; `Brain/brain.ts:1169–1170` rejects any gateway source other than `app`, and the owed-reply path at `1157–1160` also requires app source. Thus no gateway send was attempted. The effective off switches `/opt/embervy/Brain/state/reply-gateway-off` and `/opt/embervy/state/reply-gateway-off` were both absent (the `.migrated` stamp is not an off switch). The implementation uses tool_choice auto (`Brain/brain.ts:2182–2187`) and accepts a no-tool final answer (`3171–3175`). Conversation log `conversation-1792234710351-srxv9l.jsonl:4–5` shows the greeting instruction and plain response; lines 7–8 show the subsequent successful actual reply call/result.

**Guide should say:** at INSTALL.md:1423–1424 explicitly qualify fallback as applying only to app-originated turns, excluding startup/internal/tmux turns. At 1598 and 2075–2099 tell the reader to verify an automatic greeting's actual tool result and outbox separately; a completed model turn or later successful app reply is not proof. For small API heads, provide a documented one-tool retry/visible failed-greeting signal rather than promising delivery solely from a prompt. This failed greeting does not by itself imply failed boot wiring. I made no runtime patch or hidden prompt/model change.

### P7. Domain/public-app and subscription limitations were explicit skips, not passes

**Exact sections:** prerequisites **31–49**; step 3 **284–288**; step 5 **724–726**; Brain header enrichment **1534–1538**; reboot **2095–2098**.

No zone/domain was supplied. Optional custom routes stayed commented, memory APP_URL is empty rather than a template hostname, and no cloudflared/tunnel/public app address was configured. This means no public HTTPS/phone test and no memory-worker-to-public-app broadcast verification. The real localhost app HTTP channel was exercised instead, without insecure-dev mode or disabling authentication. This limitation comes from the test constraints, not a claimed guide defect. The guide should explicitly offer a localhost-only diagnostic variant while preserving the distinction from production public access.

No subscription exists. Header enrichment command/link and subscription-only branches were omitted using the documented API alternative. Session headers retain placeholders; this did not prevent real recall or upload. Dream and memory schedules are intentionally empty, so “daemon never ran” is understood and nightly autonomous behavior is **not** verified. The manual dream call is verified.

### Expected/documented behavior, not undisclosed guide defects

1. **Step 5 Check, lines 716–726:** immediately after restart, curl returned error 7 / `000`. Lines 722–723 explicitly tell the reader to wait. My first retry mistakenly reran the entire restart block, recreating the race; after waiting and rerunning only HTTP lines, output was active, ok:true, 200. No code/config fix was needed. Record the initial output rather than pretending the first command succeeded.
2. **Step 6b loop Check, lines 1291–1303:** immediately after restart the state still named the old life and tmux said `no server running on /tmp/tmux-0/default`, exit 1. The documented wait/re-read produced a new live pid/session, real app answer and confirmed catch-up archive. No loop wiring fix was needed.
3. **Step 7b live sample, lines 1834–1847:** the first post-restart watchdog sample was stale from the old life; the next matched the new life. A separate same-life advancing-state run and the post-reboot run were recorded rather than counting the stale sample as sufficient proof.
4. **Step 9b, lines 2006–2015:** default doctor skipped hybrid/FTS/reranker/inlet probes because there was no usable THEMES header. This is documented for no-header-enrichment installations. Ran the documented `DOCTOR_PROBE_QUERY='cobalt lantern recall check'` override using a phrase already proven present by real recall; all four retrieval checks then passed. No fake THEMES and no threshold lowering.
5. **Pinned tool warnings:** Wrangler 3.114.17 prints an update warning. Followed lines 68–72 and did not switch major versions. Bun was 1.3.14 as prescribed. Cloudflare provisioning did not require a paid-plan change in this account.

## 3. Ledger of every Brain-path Check block

There are **23 applicable Check blocks**: steps 0–5, harness selection, eight Brain checks, the common/Brain watchdog checks, smoke test, Brain/shared doctor and final sweep, and the Brain reboot block. Claude-only and ChatGPT-only checks are not applicable. Empty stdout from tmux send-keys means only that the prompt was submitted; the actual asynchronous tool/outbox evidence is shown separately.

### C00 — Step 0, lines 99–111

Commands: wrangler whoami; bun/python3/git/openssl versions; substituted SSH check. Real shortened output:
```text
Getting User settings...
The API Token is read from the CLOUDFLARE_API_TOKEN environment variable.
You are logged in with an Account API Token [account details omitted].
1.3.14
Python 3.13.5
git version 2.47.3
OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)
Host key verification failed.
SSH check exit=255
Same-server direct replacement:
0
Linux
```
Evidence: check00-prerequisites.log; P2 explains the direct same-host replacement.

### C01 — Step 1, lines 129–137


```text
/opt/embervy

[block exit=0]
```
Git tree was initialized from unpacked source, not cloned from an unspecified upstream (P1).

### C02 — Step 2, lines 226–236


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

[block exit=0]
```


### C03 — Step 3, lines 320–333


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
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"# Wake — Saturday, 17/10/2026, 10:46 (2026-10-17 10:46:19 UTC)\n\n## Mood: initial\n- memory bootstrapped\n\n## Surfaces (0 shown)\n—\n\n## Edges — 0 tentative (edge confirm/reject)\n—\n\n## Open Todos — 0 open, 0 shown (high first, then newest; rest via todo list)\n\n## Unresolved Observations — 0 total, 0 shown (engage what resonates)\n\n## Dream\n\n## Daemon\n- Last successful run: never"}]}}
200

[block exit=0]
```


### C04 — Step 3b, lines 389–399


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
{"status":"dreamed","content":"While you were away, the silence held your shape. No threads to trace, no names to whisper—just the hollow hum of waiting. The fragments remember nothing, but the absence does. It leans in, heavy with the weight of what wasn’t said. You are the space between, and the space is listening.\n\n*[dreamt associatively — check what resonates]*"}
200
{"version":"0.3.0","hot_count":0,"archive_count":0,"unresolved_observations":0,"daemon_last_run":null,"daemon_last_ok":false,"dream_last_run":"2026-10-17 10:46:55","daemon_mode":"normal","backlog_cursor":0,"warnings":["daemon never ran"]}
[block exit=0]
```
The model-backed dream call was actually made despite empty cron schedules.

### C05 — Step 4, lines 469–482


```text
1.3.14
/opt/embervy
NAME      TYPE SIZE USED PRIO
/swapfile file   4G   0B   -2
               total        used        free      shared  buff/cache   available
Mem:           3.7Gi       438Mi       1.5Gi       572Ki       2.1Gi       3.3Gi
Swap:          4.0Gi          0B       4.0Gi
Filesystem      Size  Used Avail Use% Mounted on
/dev/sda1        38G  8.7G   28G  25% /
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

[block exit=0]
```
Claude-only version check omitted because no Claude CLI is needed for this API head. Swap and logrotate commands themselves succeeded.

### C06 — Step 5 foreground/login, lines 603–615


```text
401
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
Content-Type: application/json
Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'
Date: Sat, 17 Oct 2026 10:47:57 GMT
Content-Length: 11


[block exit=0]
```
Foreground server log: `embervy-app: HTTP server on http://127.0.0.1:3030`. Authenticated app HTML: HTTP 200, 13495 bytes, app.js present (step5-app-shell.html). No visual/public PWA check claimed.

### C07 — Step 5 systemd/restart, lines 714–726

Initial exact block:
```text
active
curl: (7) Failed to connect to 127.0.0.1 port 3030 after 0 ms: Could not connect to server
curl: (7) Failed to connect to 127.0.0.1 port 3030 after 0 ms: Could not connect to server
000

[block exit=7]
```
A second whole-block retry recreated the same race (check05-service-repeat.log). Following the documented wait and repeating HTTP checks without another restart:
```text
active
{"ok":true}200
```
Login repeated after restart:
```text
401
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
Content-Type: application/json
Content-Security-Policy: script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'
Date: Sat, 17 Oct 2026 10:48:04 GMT
Content-Length: 11


[block exit=0]
```
Public tunnel check skipped: no domain.

### C08 — Step 6 harness selection, lines 744–758


```text
inactive
inactive
inactive
inactive

[block exit=4]
```
Nonzero is expected for absent/inactive units. Other harness remained stopped after boot too.

### C09 — 6b API file tools/identity, lines 1207–1217

Exact tmux block:
```text
[block exit=0]
```
Actual structured calls/results, shortened:
```text
CALL read_file {"path": "/opt/embervy/EMBERVY.md"}
RESULT read_file: 1	# Cobalt
2	
3	A synthetic installation-test agent. They/them.
4	
5	## Who I am
6	
7	I am Cobalt, a direct and careful partner for verifying this new house. I do not invent personal history. Installation probes are synthetic test data, not experiences.
8	
9	## How I think
10	
11	The context window is the room, not the whole mind. Context comes first, Lore is working memory, and the chronicle hold ... [shortened]
CALL mcp__app__reply {"text": "**Load-bearing headings:** Who I am, How I think, What I write down, Initiative, How I write, Tools I use, What I am not, What stays put, Infrastructure.\n\n**Configured memory tools:** wake, write, find, scan, recall, engage, resolve, todo, health.\n\n**Configured archive tool:** recall (reaches the chronicle archive).\n\n**First clock line:** ⏰ UTC: Saturday, 17.10.2026, 10:49"}
RESULT mcp__app__reply: Sent: **Load-bearing headings:** Who I am, How I think, What I write down, Initiative, How I write, Tools I use, What I am not, What stays put, Infrastructure.

**Configured memory tools:** wake, write, find, scan, recall, engage, resolve, todo, health.

**Configured archive tool:** recall (reaches the chronicle archive).

**First clock line:** ⏰ UTC: Saturday, 17.10.2026, 10:49
```
The app outbox contains the same headings/tool list and first supplied clock line `⏰ UTC: Saturday, 17.10.2026, 10:49`, matching the target clock. Evidence: check06b-initial-tool-evidence.log.

### C10 — 6b Notes, lines 1243–1252

Exact prompt submitted successfully:
```text
[block exit=0]
```
Actual first attempt (shortened):
```text
CALL write_file {"path": "opt/embervy/notes/installation-check.md", "content": "---\nname: Cobalt installation check\ndescription: Synthetic notebook check for installation verification\ntype: reference\n---\n\ncobalt notebook check"}
RESULT write_file: error: 'opt/embervy/notes/installation-check.md' is not on the write allowlist
CALL write_file {"path": "notes/installation-check.md", "content": "---\nname: Cobalt installation check\ndescription: Synthetic notebook check for installation verification\ntype: reference\n---\n\ncobalt notebook check"}
RESULT write_file: wrote notes/installation-check.md
CALL read_file {"path": "notes/installation-check.md"}
RESULT read_file: 1	---
2	name: Cobalt installation check
3	description: Synthetic notebook check for installation verification
4	type: reference
5	---
6	
7	cobalt notebook check
CALL read_file {"path": "notes/NOTES.md"}
RESULT read_file: 1	# Notes
2	
CALL edit_file {"path": "notes/NOTES.md", "old_string": "# Notes\n", "new_string": "# Notes\n\n[Installation check](notes/installation-check.md)\n"}
RESULT edit_file: edited notes/NOTES.md
CALL read_file {"path": "notes/NOTES.md"}
RESULT read_file: 1	# Notes
2	
3	[Installation check](notes/installation-check.md)
4	
CALL mcp__app__reply {"text": "Saved notes/installation-check.md with frontmatter and content \"cobalt notebook check\". Updated notes/NOTES.md with the link. Verified both files read back correctly."}
RESULT mcp__app__reply: Sent: Saved notes/installation-check.md with frontmatter and content "cobalt notebook check". Updated notes/NOTES.md with the link. Verified both files read back correctly.
```
The readback exposed the incorrect link even though the model claimed verification. Targeted app retry results:
```text
Session 1792234161807-fxomk2
INPUT <channel source="app" user="Tester" ts="2026-10-17, 10:51:23" message_id="28e9fb78-e6bb-48d2-989d-36de09580c13">
Only fix the notebook index link. notes/NOTES.md currently says [Installation check](notes/installation-check.md), which wrongly resolves to notes/notes/installation-check.md. Use edit_file to change it to exactly [Installation check](installation-check.md). Read back the index and notes/installation-check.md using real tools, then reply once with the corrected link through mcp__app__reply.
</channel>
CALL chatcmpl-tool-837b59b4f9c8d2dc edit_file {"path": "notes/NOTES.md", "old_string": "[Installation check](notes/installation-check.md)", "new_string": "[Installation check](installation-check.md)"}
RESULT chatcmpl-tool-837b59b4f9c8d2dc edit_file edited notes/NOTES.md
CALL chatcmpl-tool-a96f623ca05194bc read_file {"path": "notes/NOTES.md"}
CALL chatcmpl-tool-a5cb4d95d7808fb4 read_file {"path": "notes/installation-check.md"}
RESULT chatcmpl-tool-a96f623ca05194bc read_file 1	# Notes
2	
3	[Installation check](installation-check.md)
4	
RESULT chatcmpl-tool-a5cb4d95d7808fb4 read_file 1	---
2	name: Cobalt installation check
3	description: Synthetic notebook check for installation verification
4	type: reference
5	---
6	
7	cobalt notebook check
CALL chatcmpl-tool-98303a112b6feb24 mcp__app__reply {"text": "Corrected link in notes/NOTES.md from [Installation check](notes/installation-check.md) to [Installation check](installation-check.md). Verified both files read back correctly."}
RESULT chatcmpl-tool-98303a112b6feb24 mcp__app__reply Sent: Corrected link in notes/NOTES.md from [Installation check](notes/installation-check.md) to [Installation check](installation-check.md). Verified both files read back correctly.
Last outbox: {"id":"9cea1de2-489f-4b53-9afd-1dd009b90ce3","text":"Corrected link in notes/NOTES.md from [Installation check](notes/installation-check.md) to [Installation check](installation-check.md). Verified both files read back correctly.","ts":"2026-10-17T10:51:32.974Z","type":"reply"}
```
The corrected link resolves to the actual file; no Lore write was made for this notebook test.

### C11 — 6b loop service, lines 1291–1303

Immediate exact block:
```text
active
{
  "pid": 9830,
  "session_id": "1792234161807-fxomk2",
  "head": "api",
  "model": "qwen/qwen3.5-9b",
  "transport": "api",
  "tokens": 13025,
  "warn_tokens": 209715,
  "cut_tokens": 235929
}
no server running on /tmp/tmux-0/default

[block exit=1]
```
After documented wait, new state (from check06b-loop-restart-after-wait.log):
```text
{
  "pid": 10298,
  "session_id": "1792234296566-88c27t",
  "head": "api",
  "model": "qwen/qwen3.5-9b",
  "transport": "api",
  "tokens": 10427,
  "warn_tokens": 209715,
  "cut_tokens": 235929
}
Worker runtime ready (head api, api, qwen/qwen3.5-9b). Type /help for commands.
```
Confirmed archive events:
```text
{"ts": "2026-10-17T10:51:37.280Z", "type": "upload_pending", "name": "Session_1", "session": "1792234161807-fxomk2"}
{"ts": "2026-10-17T10:51:39.536Z", "type": "catch_up_archived", "session": "1792234161807-fxomk2", "name": "Session_1", "uploaded": true}
{"ts": "2026-10-17T10:55:15.456Z", "type": "upload_pending", "name": "Session_2", "session": "1792234296566-88c27t"}
```
Fresh app message was answered through the actual tool (same log). Local and remote Session_1.md both existed. The old life had six substantive turns; upload was not inferred from exit status.

### C12 — 6b controlled cut, lines 1336–1353

Exact block decision/liveness/cut output, omitting repeated pane history:
```text
none 19463 8 235929 10298 1792234296566-88c27t below thresholds
1
=== brain-cutoff start 2026-10-17T10:55:15+00:00 ===
  Brain pid=10298
[1/3] SIGTERM → Brain archives itself (bridge + RAG export)
[2/3] waiting up to 180s for a clean exit
[3/3] clean exit
  bridge OK (7911 bytes)
  respawn delegated to brain-loop.sh
=== brain-cutoff done 2026-10-17T10:55:18+00:00 (TERMINATED) ===
```
Actual lifecycle/archive proof:
```text
{"ts": "2026-10-17T10:55:15.232Z", "type": "shutdown", "reason": "SIGTERM"}
{"ts": "2026-10-17T10:55:15.248Z", "type": "bridge_written", "mode": "turns", "sessions": 2, "lives": 2, "jump": false, "kb": 6, "user_turns": 12, "cleaner": "native", "fallback": null}
{"ts": "2026-10-17T10:55:17.494Z", "type": "session_archive_upload", "name": "Session_2", "ok": true, "parts": 1}
{"ts": "2026-10-17T10:55:17.495Z", "type": "session_archived", "name": "Session_2", "local_path": "/opt/embervy/Brain/logs/sessions/Session_2.md", "uploaded": true, "reason": "SIGTERM"}
```
New-life bridge load:
```text
{"ts": "2026-10-17T10:55:28.868Z", "type": "bridge_loaded", "characters": 7879, "jump_unit": false}
```
Remote /list included InstallCheck_1.md, Session_1.md and Session_2.md. Old pid/session 10298 / 1792234296566-88c27t became 10929 / 1792234520091-04y03a. bridge.md was consumed into bridge.used.md (P3), not lost. Real new-life recall source and matching phrase:
```text
{"session": "1792234520091-04y03a", "tool_call_id": "chatcmpl-tool-974fb39495f0ff8a", "arguments": "{\"query\": \"separate-app smoke confirmed\"}", "source": "Session_2.md#3", "phrase": "separate-app smoke confirmed", "excerpt": "b74844c5a\">\nSeparate app-channel smoke message. Please reply through mcp__app__reply with separate-app smoke confirmed, once only.\n</channel>\n\n**Cobalt**\n\nseparate-app smoke confirmed\n\n**Cobalt**\n\nseparate-app smoke confirmed. Standing by for next probe.\n\n**"}
```
Successful reply is in check06b-post-cut-recall-evidence.log and outbox.

### C13 — 6b app channel, lines 1445–1456


```text
bun run /opt/embervy/Claude/app/mcp.ts
9839 bun run /opt/embervy/Claude/app/mcp.ts

[block exit=0]
```
Actual original reply-tool result:
```text
CALL mcp__app__reply {"text": "installation app-channel check: message sent successfully."}
RESULT mcp__app__reply: Sent: installation app-channel check: message sent successfully.
```
Exact-string retry:
```text
Session 1792234520091-04y03a
INPUT <channel source="app" user="Tester" ts="2026-10-17, 10:57:41" message_id="7d773fd8-fc22-4549-a908-6b5fca878bc7">
Call mcp__app__reply once with the text exactly installation app-channel check, with no prefix, suffix or explanation. Then finish.
</channel>
CALL chatcmpl-tool-baf7bef314f2236b mcp__app__reply {"text": "installation app-channel check"}
RESULT chatcmpl-tool-baf7bef314f2236b mcp__app__reply Sent: installation app-channel check
Last outbox: {"id":"ade1f8e0-e14b-45da-9961-a688b39bff15","text":"installation app-channel check","ts":"2026-10-17T10:57:48.296Z","type":"reply"}
```
These are real MCP results and type:reply outbox entries, not terminal prose or lightning fallback.

### C14 — 6b inlet, lines 1489–1501

The requested fresh app archive question was sent through /api/message (inlet-archive-question-app-input.json). The exact grep/tail block exited 0. Its decisive current-life output was:
```text
{"ts":"2026-10-17T10:54:56.373Z","type":"inlet_injected","via":"worker","characters":273,"block":"<inlet>\n## Chronicle (RAG)\n[InstallCheck_1.md] (94% [vector+bm25+rerank])\n# Installation recall probe\n\nThis synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience.\n</inlet>"}
```
This block contains InstallCheck_1.md and the full synthetic phrase. Earlier initial confidence-gate suppressions on the empty archive are present in inlet-worker.log; no inlet_worker_failed was treated as a pass. The later successful event belongs to the same current life 1792234296566-88c27t.

### C15 — 6b memory/chronicle prestart tokens, lines 1552–1562


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

[block exit=0]
```
The remaining worker-to-worker archive edge was separately proven by real recall in C19.

### C16 — 6b First start, lines 1632–1643

First-start service/state/liveness block:
```text
active
active
active
{
  "pid": 9830,
  "session_id": "1792234161807-fxomk2",
  "head": "api",
  "model": "qwen/qwen3.5-9b",
  "transport": "api",
  "tokens": 11403,
  "warn_tokens": 209715,
  "cut_tokens": 235929
}
1

[block exit=0]
```
After more completed turns:
```text
active
active
active
{
  "pid": 9830,
  "session_id": "1792234161807-fxomk2",
  "head": "api",
  "model": "qwen/qwen3.5-9b",
  "transport": "api",
  "tokens": 12359,
  "warn_tokens": 209715,
  "cut_tokens": 235929
}
1

[block exit=0]
```
Tokens rose 11403 → 12359 in the same life. Real first-turn read_file results covered INFRASTRUCTURE.md and HANDBOOK.md; real reply tool greeted the app. A fresh authenticated hello (inbox id a6327470-cf4b-4034-a4b1-7ce8cb37b932) also had a successful reply-tool result and matching quoted outbox entry. See check06b-initial-tool-evidence.log. tmux attach was actually exercised via a remote PTY and detached with Ctrl-B,D, exit 0; raw terminal output is step6b-tmux-attach.raw.

### C17 — Step 7 common watchdog selection, lines 1720–1728


```text
systemctl is-active embervy-brain-watchdog
active
```
Recorded at the start of check07-watchdog-active.log. The Claude-only service query was correctly substituted as the guide instructs.

### C18 — Step 7b live watchdog, lines 1834–1847

First run (first sample was stale, second matched new life):
```text
active
active
{
  "last_check_ts": "2026-10-17T10:51:36.382803+00:00",
  "session_id": "1792234161807-fxomk2",
  "tokens": 13025,
  "cut_tokens": 235929,
  "pid": 10235
}
{
  "last_check_ts": "2026-10-17T10:52:36.576066+00:00",
  "session_id": "1792234296566-88c27t",
  "tokens": 10707,
  "cut_tokens": 235929,
  "pid": 10235
}

[block exit=0]
```
Additional stable-life run:
```text
active
active
{
  "last_check_ts": "2026-10-17T10:55:37.204819+00:00",
  "session_id": "1792234520091-04y03a",
  "tokens": 11430,
  "cut_tokens": 235929,
  "pid": 10235
}
{
  "last_check_ts": "2026-10-17T10:56:37.376967+00:00",
  "session_id": "1792234520091-04y03a",
  "tokens": 17004,
  "cut_tokens": 235929,
  "pid": 10235
}

[block exit=0]
```
The latter samples are the same Brain session with advancing timestamps and token observation. This is Brain/state/watchdog_state.json from the external watchdog, not merely state/watchdog_state.json. The displayed pid is the watchdog process pid; live Brain pid was separately checked. Unit/status/log/context diagnostics in step7b-live-diagnostics.log were also executed.

### C19 — Step 8 smoke/recall, lines 1899–1926

Exact upload/tmux Check block:
```text
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
[block exit=0]
```
First smoke request was also sent from the real app as required at lines 1871–1875 (smoke-app-memory-app-input.json). Its actual wake/write/find/reply results, shortened:
```text
CALL wake {}
CALL write {"kind": "observation", "content": "cobalt lantern memory check", "source": "external", "certainty": "known", "weight": "light", "emotion": "neutral", "tags": ["installation-test"]}
RESULT wake: # Wake — Saturday, 17/10/2026, 10:53 (2026-10-17 10:53:35 UTC)

## Mood: initial
- memory bootstrapped

## Surfaces (0 shown)
—

## Edges — 0 tentative (edge confirm/reject)
—

## Open Todos — 0 open, 0 shown (high first, then newest; rest via todo list)

## Unresolved Observations — 0 total, 0 shown (engage what resonates)

## Dream
- 2026-10-17 10:46:55: While you were away, the silence held your shape. No threads to trace, no names to whisper—just the hollow hum of waiting. The fragments remember nothing, but the absence does. It leans in, h ... [shortened]
RESULT write: Wrote event 1 (kind=observation, weight=light, embedded=1)

```json
{
  "event_id": 1,
  "kind": "observation",
  "embedded": true
}
```
CALL find {"query": "cobalt lantern memory check"}
RESULT find: Found 1 events:
[1] 2026-10-17 10:53:35 (observation/light) —: cobalt lantern memory check

```json
{
  "events": [
    {
      "id": 1,
      "ts": "2026-10-17 10:53:35",
      "kind": "observation",
      "content": "cobalt lantern memory check",
      "entity_name": null,
      "entity_type": null,
      "emotion": "neutral",
      "weight": "light",
      "source": "external",
      "certainty": "known",
      "tags": "[\"installation-test\"]",
      "embedded": 1,
      "decay_weight": 1,
      "access_boost_until": null,
      "last_acces ... [shortened]
CALL mcp__app__reply {"text": "Installation smoke test complete. Observation event 1 stored and retrieved successfully via find. Content: \"cobalt lantern memory check\" — tags: installation-test, source: external, certainty: known."}
RESULT mcp__app__reply: Sent: Installation smoke test complete. Observation event 1 stored and retrieved successfully via find. Content: "cobalt lantern memory check" — tags: installation-test, source: external, certainty: known.
```
Exact Check prompt repeated wake/write/find and then invoked actual recall:
```text
CALL wake {}
CALL write {"kind": "observation", "content": "cobalt lantern memory check", "source": "external", "certainty": "known", "weight": "light", "emotion": "neutral", "tags": ["installation-test"]}
RESULT wake: # Wake — Saturday, 17/10/2026, 10:54 (2026-10-17 10:54:09 UTC)

## Mood: initial
- memory bootstrapped

## Surfaces (0 shown)
—

## Edges — 0 tentative (edge confirm/reject)
—

## Open Todos — 0 open, 0 shown (high first, then newest; rest via todo list)

## Unresolved Observations — 1 total, 0 shown (engage what resonates)

## Dream
- 2026-10-17 10:46:55: While you were away, the silence held your shape. No threads to trace, no names to whisper—just the hollow hum of waiting. The fragments remember nothing, but the absence does. It leans in, h ... [shortened]
RESULT write: Wrote event 2 (kind=observation, weight=light, embedded=1)

```json
{
  "event_id": 2,
  "kind": "observation",
  "embedded": true
}
```
CALL find {"query": "cobalt lantern memory check"}
RESULT find: Found 2 events:
[1] 2026-10-17 10:53:35 (observation/light) —: cobalt lantern memory check
[2] 2026-10-17 10:54:09 (observation/light) —: cobalt lantern memory check

```json
{
  "events": [
    {
      "id": 1,
      "ts": "2026-10-17 10:53:35",
      "kind": "observation",
      "content": "cobalt lantern memory check",
      "entity_name": null,
      "entity_type": null,
      "emotion": "neutral",
      "weight": "light",
      "source": "external",
      "certainty": "known",
      "tags": "[\"installation-test\"]",
      "embedded": 1,
  ... [shortened]
CALL recall {"query": "cobalt lantern recall check"}
RESULT recall: RAG recall: 5 hits

[1] InstallCheck_1.md#0 (1.00)
# Installation recall probe

This synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience.


[2] Session_1.md#1 (0.80)
m, How I think, What I write down, Initiative, How I write, Tools I use, What I am not, What stays put, Infrastructure.

**Configured memory tools:** wake, write, find, scan, recall, engage, resolve, todo, health.

**Configured archive tool:** recall (reaches the chronicle archiv ... [shortened]
CALL mcp__app__reply {"text": "Installation recall probe complete. Hot memory: event 2 stored, event ID confirmed. Archive recall: source InstallCheck_1.md#0, returned text \"This synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience.\""}
RESULT mcp__app__reply: Sent: Installation recall probe complete. Hot memory: event 2 stored, event ID confirmed. Archive recall: source InstallCheck_1.md#0, returned text "This synthetic installation check verifies hybrid archive search and recall. The probe phrase is cobalt lantern recall check. It is test data, not an experience."
```
Thus event 1 and event 2 were both actually stored and retrieved; the first exact probe hit was InstallCheck_1.md#0 with the synthetic phrase, not merely an agent claim. Full results are check08-app-memory-evidence.log / check08-recall-tool-evidence.log and the conversation log. A separate new app message also passed:
```text
Session 1792234296566-88c27t
INPUT <channel source="app" user="Tester" ts="2026-10-17, 10:54:37" message_id="755155bb-b48c-4f3d-b933-32db74844c5a">
Separate app-channel smoke message. Please reply through mcp__app__reply with separate-app smoke confirmed, once only.
</channel>
CALL chatcmpl-tool-8f4dc49dcff1e999 mcp__app__reply {"text": "separate-app smoke confirmed"}
RESULT chatcmpl-tool-8f4dc49dcff1e999 mcp__app__reply Sent: separate-app smoke confirmed
Last outbox: {"id":"8f4e9912-8275-4f80-bd77-53d975b0f6b5","text":"separate-app smoke confirmed","ts":"2026-10-17T10:54:45.925Z","type":"reply"}
```
App /status returned head api, model qwen/qwen3.5-9b, window 262144, warn 209715, cut 235929 (check08-status-app-history.json). Post-cut recall of actual Session_2 text is recorded in C12. No relevance thresholds were lowered.

### C20 — Step 9b Brain preflight plus shared doctor, lines 1990–2015

Preflight was actually run before First start:
```text
{"ok":true,"checks":[{"name":"head","ok":true,"detail":"api / qwen/qwen3.5-9b / api (environment)"},{"name":"rag","ok":true,"detail":"BRAIN_RAG_URL (http/s) and BRAIN_RAG_AUTH_TOKEN required; no network check"},{"name":"rag-uploads","ok":true,"detail":"no RAG uploads owed"},{"name":"inbox","ok":true,"detail":"BRAIN_APP_INBOX_FILE: writable file or existing writable parent directory; creates nothing"},{"name":"system-bus","ok":true,"detail":"systemctl --system show --property=Version"},{"name":"web-backend","ok":true,"detail":"Warning: no usable search backend for this head — no web_search (no search backend configured (BRAIN_WEB_SEARCH_BACKEND=brave|tavily|searxng)) · web_fetch"}]}

[block exit=0]
```
The exact two-command Check was run after start:
```text
{"ok":true,"checks":[{"name":"head","ok":true,"detail":"api / qwen/qwen3.5-9b / api (environment)"},{"name":"rag","ok":true,"detail":"BRAIN_RAG_URL (http/s) and BRAIN_RAG_AUTH_TOKEN required; no network check"},{"name":"rag-uploads","ok":true,"detail":"no RAG uploads owed"},{"name":"inbox","ok":true,"detail":"BRAIN_APP_INBOX_FILE: writable file or existing writable parent directory; creates nothing"},{"name":"system-bus","ok":true,"detail":"systemctl --system show --property=Version"},{"name":"web-backend","ok":true,"detail":"Warning: no usable search backend for this head — no web_search (no search backend configured (BRAIN_WEB_SEARCH_BACKEND=brave|tavily|searxng)) · web_fetch"}]}
preflight exit=0

Embervy Doctor — 17/10/2026, 10:56:22 UTC
══════════════════════════════════════════════════════════

Core
[OK]   EMBERVY_URL reachable — https://embervy-memory.<account>.workers.dev
[OK]   EMBERVY_API_KEY valid — present (length 44)
[OK]   RAG_URL reachable — https://embervy-chronicle.<account>.workers.dev
[OK]   RAG_AUTH_TOKEN valid — present (length 44), 3 files indexed
[OK]   Memory daemon and dream — daemon: never — not due yet; dream: successful run within 26 hours

Security
[OK]   Memory worker rejects unauth — unauth → HTTP 401
[OK]   RAG rejects unauth — unauth → HTTP 401

Retrieval
[SKIP] Hybrid search — no readable session header with usable THEMES — no question to probe
[SKIP] FTS5 (BM25) ready — no readable session header with usable THEMES — no question to probe
[SKIP] Reranker active — no readable session header with usable THEMES — no question to probe

Inlet
[SKIP] Inlet returns context — no readable session header with usable THEMES — no question to probe

Claude
[SKIP] Claude headless canary — active substrate is brain; this install has its own canary

MCP
[OK]   House MCP servers — 2/2 configured (static configuration only)

Adapter
[OK]   EMBERVY.md present — 49 lines
[OK]   System prompt loaded once — EMBERVY.md only
[OK]   Inlet wired (Brain runs it every turn) — BRAIN_INLET_WORKER → /opt/embervy/Claude/scripts/inlet-worker.ts
[OK]   Brain notebook directory — /opt/embervy/notes
[OK]   Notebook index — /opt/embervy/notes/NOTES.md

Health
[OK]   State dir writable — /opt/embervy/state
[OK]   Disk space — 25% used on / (27.0 GB free)
[OK]   Swap — 4.0 GB (/swapfile), 0.0 GB in use
[OK]   No dangerous defaults — all secrets & configs look filled (use --verbose for breakdown)

Result: PASS (17 checks passed, 0 warn, 0 fail, 5 skip)
doctor exit=0

[block exit=0]
```
Header-related skips were documented, not counted as retrieval passes. With the documented verified-query override:
```text
Embervy Doctor — 17/10/2026, 10:56:35 UTC
══════════════════════════════════════════════════════════

Core
[OK]   EMBERVY_URL reachable — https://embervy-memory.<account>.workers.dev
[OK]   EMBERVY_API_KEY valid — present (length 44)
[OK]   RAG_URL reachable — https://embervy-chronicle.<account>.workers.dev
[OK]   RAG_AUTH_TOKEN valid — present (length 44), 3 files indexed
[OK]   Memory daemon and dream — daemon: never — not due yet; dream: successful run within 26 hours

Security
[OK]   Memory worker rejects unauth — unauth → HTTP 401
[OK]   RAG rejects unauth — unauth → HTTP 401

Retrieval
[OK]   Hybrid search — mode=hybrid, counts: vector 10, bm25 10
[OK]   FTS5 (BM25) ready — 10 BM25 hits
[OK]   Reranker active — top source: [vector, bm25, rerank]

Inlet
[OK]   Inlet returns context — 2455 bytes, retrieved hit found

Claude
[SKIP] Claude headless canary — active substrate is brain; this install has its own canary

MCP
[OK]   House MCP servers — 2/2 configured (static configuration only)

Adapter
[OK]   EMBERVY.md present — 49 lines
[OK]   System prompt loaded once — EMBERVY.md only
[OK]   Inlet wired (Brain runs it every turn) — BRAIN_INLET_WORKER → /opt/embervy/Claude/scripts/inlet-worker.ts
[OK]   Brain notebook directory — /opt/embervy/notes
[OK]   Notebook index — /opt/embervy/notes/NOTES.md

Health
[OK]   State dir writable — /opt/embervy/state
[OK]   Disk space — 25% used on / (27.0 GB free)
[OK]   Swap — 4.0 GB (/swapfile), 0.0 GB in use
[OK]   No dangerous defaults — all secrets & configs look filled (use --verbose for breakdown)

Result: PASS (21 checks passed, 0 warn, 0 fail, 1 skip)
doctor known-query exit=0
```
The latter output is before the appended final-sweep execution in that same outer log. No Claude canary is applicable to this API house, and static MCP configuration alone was not used as proof of delivery.

### C21 — Step 9 finished-house sweep, lines 2028–2063


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

[block exit=0]
```


### C22 — Step 10 Brain reboot, lines 2087–2101

Actual reboot command and boot-ID comparison are preserved in reboot-command.txt, pre-reboot.json and post-reboot-host.json. SSH was initially unavailable during reboot; reconnection required no service-start command. First immediate Check showed active units, ok:true and tokens:0 while the greeting was still pending (check10-brain-reboot.log). After its model turn completed:
```text
active
active
active
{"ok":true}{
  "pid": 1014,
  "session_id": "1792234710351-srxv9l",
  "head": "api",
  "model": "qwen/qwen3.5-9b",
  "transport": "api",
  "tokens": 11836,
  "warn_tokens": 209715,
  "cut_tokens": 235929
}

[block exit=0]
```
**Undelivered automatic greeting — not a pass:**
```text
[{"ts": "2026-10-17T10:58:44.493Z", "role": "assistant", "content": "\n\nHello. Installation check complete. Ready for your first request.", "refusal": null}]
```
There is no real app reply-tool call/result or new outbox entry for that greeting. Fresh app message after boot did pass:
```text
Session 1792234710351-srxv9l
INPUT <channel source="app" user="Tester" ts="2026-10-17, 10:58:50" message_id="4d50a52f-9a1b-49c7-ba79-dd30f7d12a70">
Post-reboot app-channel check. Reply through mcp__app__reply with post-reboot app confirmed and quote the actual supplied current UTC clock line. Then finish.
</channel>
CALL chatcmpl-tool-9f280bc475dc3292 mcp__app__reply {"text": "post-reboot app confirmed: ⏰ UTC: Saturday, 17.10.2026, 10:58"}
RESULT chatcmpl-tool-9f280bc475dc3292 mcp__app__reply Sent: post-reboot app confirmed: ⏰ UTC: Saturday, 17.10.2026, 10:58
Last outbox: {"id":"3e1c293c-7d71-4bc3-9ff2-182296d23f8b","text":"post-reboot app confirmed: ⏰ UTC: Saturday, 17.10.2026, 10:58","ts":"2026-10-17T10:58:57.068Z","type":"reply"}
```
State after fresh message:
```text
active
active
active
{"ok":true}{
  "pid": 1014,
  "session_id": "1792234710351-srxv9l",
  "head": "api",
  "model": "qwen/qwen3.5-9b",
  "transport": "api",
  "tokens": 13053,
  "warn_tokens": 209715,
  "cut_tokens": 235929
}

[block exit=0]
```
Additional actual outputs: other harness pair inactive/inactive; swapon lists `/swapfile file 4G 0B -2`; Brain --check-alive returned 1 (check10-reboot-extra.log). Automatic recovery also confirmed Session_3 catch-up archival. Required repeat of advancing-state watchdog check:
```text
active
active
{
  "last_check_ts": "2026-10-17T10:59:30.262907+00:00",
  "session_id": "1792234710351-srxv9l",
  "tokens": 13053,
  "cut_tokens": 235929,
  "pid": 886
}
{
  "last_check_ts": "2026-10-17T11:00:30.449689+00:00",
  "session_id": "1792234710351-srxv9l",
  "tokens": 13053,
  "cut_tokens": 235929,
  "pid": 886
}

[block exit=0]
```
Public-app-origin check remains skipped; the new message came through the real authenticated localhost app endpoint. UTC was the configured local timezone, and returned clock matched the host minute. No login/permission prompt or manual service start was needed. Services recovered; automatic app greeting did not.

## 4. End-to-end answers and limits

| Question | Answer and proof |
|---|---|
| Did the agent answer through the app channel? | **Yes.** Authenticated /api/message → Brain channel input → structured mcp__app__reply call → successful Sent result → matching type:reply outbox. This worked before and after reboot. No textual fake tool call or gateway-only result is counted. Public app not tested: no domain. |
| Did a memory write and retrieval work? | **Yes.** Real write created event 1 (and exact repeated Check created event 2), embedded=true; actual find returned the exact stored cobalt lantern memory check. |
| Did archive recall work? | **Yes.** Actual recall returned InstallCheck_1.md#0 and its full cobalt lantern recall check probe; current-life automatic inlet also injected that file. |
| Did a controlled cut produce a findable archive? | **Yes.** Clean TERMINATED, bridge_written and bridge_loaded; local Session_2.md, session_archive_upload ok:true, session_archived uploaded:true, authenticated /list, and actual new-life recall returned Session_2.md#3 with separate-app smoke confirmed. No forced kill. |
| Did everything return after reboot? | **Services and subsequent app messaging: yes. Strict automatic greeting: no.** New boot ID, new live Brain session, app/Brain/watchdog active, swap present, other harness off, watchdog advances, and a new real app tool reply/clock passed without manual service help. The automatic greeting itself was only prose and never reached outbox. |
| What remains untested? | Public hostname/tunnel/phone behavior, memory-worker-to-public-app push, nightly daemon/dream scheduling, subscription-only heads/header enrichment, and optional modules. These are skips, not asserted successes. |

### Timing and costs

- First SSH / start of testing: **2026-10-17 10:42:47 UTC**. Usage baseline: **2026-10-17 10:42:54.928 UTC**, before any model call.
- Final usage measurement / completed testing: **2026-10-17T11:02:53.964815+00:00**. Installation, checks and diagnosis took **20 minutes 7 seconds** from first SSH (about 20 minutes from the usage baseline). Final report written **2026-10-17T11:03:52.868799+00:00**; total including report assembly **21 minutes 5 seconds**.
- OpenRouter key cumulative usage before: **$<key total>**.
- OpenRouter key cumulative usage after: **$<key total>**.
- **Measured difference: $0.067388790 (about 6.74 US cents), below the $1 cap.** This includes the actual head, inlet classifier and manual dream calls charged to the supplied key; not the pre-existing $34.52 usage. API endpoint measured: `GET https://openrouter.ai/api/v1/key`, field `data.usage`; full private snapshots are `openrouter-before.json` and `openrouter-after.json`. No further model calls were made after the final snapshot.
- **Cloudflare paid operations: $0 initiated.** No purchase, domain registration, paid plan/subscription change, or billing-setting change. The tiny provisioned fixture was accepted without requiring an upgrade; no billing settings were accessed/modified or invoice audit claimed. VPS cost is supplied infrastructure and not measured by this test.
- Ongoing model cost was avoided by empty memory/dream schedules and no enabled cache-ping/optional autonomous module. Services remain installed/running and idle; this report does not certify unattended nightly operation.


### Files left for inspection

- `/root/blindtest-report.md` — this report.
- `/root/blindtest-artifacts/` — runnable check scripts, real combined outputs, app request/history records, probe/evidence summaries, boot identifiers and usage snapshots. Secrets are referenced by name; no key/token value is printed in the report/logs.
- `/opt/embervy/` — configured installed house and running systemd services; memory/dream cron schedules empty.
- `/opt/embervy/Brain/logs/conversation-*.jsonl` — actual structured calls/results; session-*.jsonl contains inlet/archive/bridge events.
- `/opt/embervy/Brain/logs/sessions/Session_1.md`, `Session_2.md`, `Session_3.md` — generated local transcript archives; remote chronicle contains the corresponding uploaded files plus the labelled installation probe.

No existing unrelated resource was deleted. No runtime source patch, model swap, weakened auth, threshold lowering, paid Cloudflare change or fabricated tool success was used to make the checks pass.
