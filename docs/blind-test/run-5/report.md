# Blind installation test — Debian 13, Brain / Claude subscription

**Test date:** 2026-10-17. All timestamps below are UTC.
**Host:** disposable Debian 13 server `root@<test-server>`.
**Installation:** `/opt/embervy`, copied from the supplied `/root/embervy-src` unpacked repository.
**Guide:** `/opt/embervy/INSTALL.md`; line numbers refer to the unchanged supplied file.
**Overall verdict:** **functional after explicit operator workarounds, not a clean pass of the unmodified guide.** In particular, the shipped Brain service restart did not restart Brain. A local synchronous stop hook fixed the tested lifecycle. Notebook writes also needed a concrete, narrow permission configuration absent from the guide.

## 1. Scope, method, and exclusions

All installation, authentication, Cloudflare CLI/API operations, tests, and evidence files were on the disposable server. Nothing was installed or modified on the starting machine. The supplied Cloudflare account and supplied OpenRouter key were the only such credentials used. No commits, pushes, PRs, or external report publication were made.

The single server played both workstation and VPS roles as the guide permits. I initialized Git for the unpacked copy, used `EMBERVY_HOME=/opt/embervy`, and selected **6b Brain**, `claude` head, **pipe** transport, backed by the existing Claude subscription. Observed versions: Bun **1.3.14**, Wrangler **3.114.17** (kept at the guide's pin), Python **3.13.5**, Git **2.47.3**, Claude Code **2.1.302**. Debian initially provided Node **20.19.2**; I explicitly installed **22.23.3** to satisfy the stated Node 22+ requirement. Actual configured head model: `claude-opus-5-5[1m]`; served model: `claude-opus-5-5`; applied effort: medium. Context/warn/cut: **1,000,000 / 800,000 / 900,000** tokens.

The subscription login was performed interactively in remote tmux. Its URL was written alone to `/root/blindtest-login-url.txt`; a remote poll checked for the relay code every 15 seconds, with a 30-minute bound. The received code was entered into the waiting prompt without printing it. Login succeeded and both relay files were deleted. Project trust and the app/Lore MCP onboarding were completed. No Anthropic API key, ChatGPT subscription, or alternative paid head was introduced.

**Explicitly excluded / skipped:**

- No domain or zone was available. Public hostnames, named/public tunnel setup, public HTTPS/phone access, and public worker-to-app push were not tested. Account-level `workers.dev` worker URLs were usable and were tested.
- App verification used the real local app HTTP authentication and message routes, with a private login cookie: `POST /api/auth`, then `POST /api/message`. This is the route used by the app UI, not direct inbox injection. I also fetched the authenticated chat HTML (HTTP 200), but did **not** render or visually test it in a browser. Thus the required local app-channel behavior is proven; public/browser/phone behavior is not.
- Claude-loop path 6a/7a/9a, ChatGPT path 6c, and API-head-only file-tool/workspace configuration were not selected. Applicable Brain identity/notebook checks were nevertheless run with the Claude pipe's real filesystem tools.
- Optional mail, calendar, browser, voice, image, video, and Web Push integrations were not installed. An unused example VAPID subject was cleared.
- Memory daemon and dream worker cron arrays were both set to `[]`, as expressly allowed to save cost. The memory daemon never ran. A manual authenticated dream invocation **did** run and succeeded; scheduling itself is unverified.
- No Cloudflare purchases, domain registration, paid-plan activation, plan/subscription changes, or billing changes were performed. Resources were deployed without enabling Workers Paid. This is an operational record, not an audited billing invoice.

Files containing credentials were kept private; env files were read as data with the repository's `env-file.sh`, not sourced. Secret values, cookie values, OAuth URLs/codes, and credential-file contents are intentionally absent from this report. Identity and house documents describe a synthetic test resident, **Blindtest**, and labelled synthetic test data, not invented personal history.

## 2. Step/result table

`fixed by me` means the original instruction was incomplete or the original check failed, and an explicit operator workaround allowed continuation. It does not mean the repository/guide was patched upstream.

| Step | Result | Observation |
|---|---|---|
| 0 — prerequisites | fixed by me | Pinned tools and account authentication worked; `$EDITOR` was unset and no editor was provisioned (P1). |
| 1 — installation location / unpacked Git | ok | Copied to `/opt/embervy`, initialized Git; whitespace check produced no output but had no tracked files to inspect (P7). |
| 2 — archive worker | fixed by me | Used explicit noninteractive config edits instead of the unusable `$EDITOR` command; D1/R2/Vectorize, schema, secret, deploy, and auth checks passed. |
| 3 — memory worker | fixed by me | Generated the future app push token early and reused it consistently (P3); worker and real memory tools passed. |
| 3b — dream worker | ok | Shared memory D1 and archive binding configured; authenticated manual dream succeeded; cron empty by permission. |
| 4 — VPS runtime and storage | fixed by me | Installed Node 22 explicitly (P2); swap, reserve ballast, journald and logrotate configured and checked. |
| 5 — app | ok | Local login, protected endpoint, systemd restart and fresh login passed; documented startup retry was needed. |
| 5 — public tunnel/domain/phone | skipped | No domain/zone supplied; not claimed as verified. |
| 6 — choose one harness | ok | Both harnesses and watchdogs inactive before selection; only Brain was enabled. |
| 6a / 6c — other heads | skipped | Claude-loop/ChatGPT paths not selected; no ChatGPT subscription supplied. |
| 6b — identity, profile, subscription login | ok | Relay sign-in succeeded; real identity/clock read and app reply verified. |
| 6b — notes | fixed by me | Initial operator-chosen notes permission rule denied Write; narrow project-relative rules plus a fresh pipe enabled real Write/Edit/Read and independent link validation (P4). |
| 6b — app MCP and bearer wiring | ok | Actual app MCP process, exact-text reply, all bearer/URL comparisons and authenticated endpoints passed. |
| 6b — automatic inlet | ok | Known stored probe retrieved through vector+BM25; actual current-life `inlet_injected` event and app answer verified. |
| 6b — loop restart | fixed by me | Original `systemctl restart` left the same Brain PID/session alive; explicit local `ExecStop` workaround archived/replaced it (P5). |
| 6b — controlled cut | ok | Guide's cutoff command terminated cleanly, uploaded Session_1, spawned a new life, loaded the bridge, and enabled real transcript recall. |
| 6b — First start | ok | House files read, actual first greeting and fresh app-message reply, three active services, intended head/thresholds. |
| 7 / 7b — Brain watchdog | ok | External watchdog active and timestamp advanced; startup's first empty sample settled at the next poll. |
| 8 — app memory smoke and recall probe | ok | Real wake/write/find, exact archive recall, automatic inlet, and post-cut transcript recall all passed. |
| 9b — preflight and shared doctor | ok | Final pre- and post-reboot doctor: 21 passed, 0 warnings, 0 failures, 1 other-harness skip. |
| 9 — finished-house sweep | ok | Reviewed harmless custom-doc marker and reworded it; final sweep clean. The block's exit-status masking is a guide defect (P6), not silently fixed. |
| 10 — actual reboot | ok | With stated workarounds installed: app, Brain and watchdog returned without manual starts; new life, real greeting/reply, bridge, advancing watchdog and swap verified. |
| Scheduled daemon/dream execution and optional integrations | skipped | Cost-saving empty crons and unselected modules; only manual dream tested. |

## 3. Problems, exact guide locations, and explicit workarounds

### P1 — `$EDITOR` is assumed but not provisioned

**Location:** §0 Prerequisites, `INSTALL.md:50,57–66`; first use in §2 at **160**, with further uses at 169, 181, 253, 258, 279, 365, 503, 595, 1105 and 1613.

**What happened:** the environment had no configured editor. The literal command `$EDITOR wrangler.toml` expands to trying to execute the TOML filename. A later explicit reproduction recorded:

```text
EDITOR=[unset]
bash: line 3: wrangler.toml: command not found
editor command exit=127
```

This was a **later reproduction**, not a captured failure of the very first config edit. For this headless test I had already used explicit Python edits for configuration files. That deviation is recorded here rather than pretending `$EDITOR` worked.

**What I did instead:** edited the requested configuration fields noninteractively with Python on the disposable server, preserving the surrounding templates. No editor was silently installed and no hidden alternative instructions were assumed.

**Recommended guide wording:** “Install an editor, for example `apt-get install -y nano`, then `export EDITOR=nano` in the shell used below. Confirm `command -v "$EDITOR"`. If operating headlessly, edit these same fields with your automation tool; `$EDITOR` must not be empty.” Alternatively provide complete noninteractive examples.

**Evidence:** `02-editor-reproduction.log`, worker configuration/deployment logs.

### P2 — Node 22+ is required but Debian installation commands are missing

**Location:** §4 Runtime, `INSTALL.md:423–425,439–441`.

**What happened:** the guide says to install Node 22+ first, but does not supply the corresponding Debian command sequence/version gate. The supplied Debian environment resolved `node --version` to **v20.19.2**. Claude Code's npm installation actually succeeded; this was **not** a failed npm package install.

**What I did instead, explicitly:**

```bash
npm install -g node@22
hash -r
node --version
claude --version
```

```text
v22.23.3
2.1.302 (Claude Code)
```

The initial Claude install preceded this correction. The final runtime met the requirement.

**Recommended guide wording:** include a complete supported Debian 13 Node 22+ installation sequence before `npm install -g @anthropic-ai/claude-code`, refresh shell command lookup if needed, and require a successful `node --version` major-version check. Do not imply the default Debian `nodejs` package necessarily satisfies 22+.

**Evidence:** `04-check.log`, `04-install.log`, `04-node-workaround.log`.

### P3 — Memory setup needs a push token not yet generated by the guide

**Location:** §3 Memory, `INSTALL.md:270,284–288`; later app token map at §5, **506–519**, especially **517**.

**What happened:** the memory worker needs `APP_PUSH_TOKEN` equal to the future app's `EXTERNAL_PUSH_TOKEN`, before the app step. The guide explains the equality later, but lacks an earlier generation/save step. This is an ordering/completeness gap, not an observed authentication failure after configuration.

**What I did instead:** at step 3 generated a single value privately with `openssl rand -base64 32`, saved it as `EXTERNAL_PUSH_TOKEN` in the root env, supplied the same value to the memory worker as `APP_PUSH_TOKEN`, and reused it in the app env at step 5. Other app tokens remained distinct. No value was printed. Final push-bearer equality check passed.

**Recommended guide wording:** “Before running the step 3 secret command, generate and save `EXTERNAL_PUSH_TOKEN` once in the private house env. Use this exact saved value as the worker's `APP_PUSH_TOKEN` now and the app's `EXTERNAL_PUSH_TOKEN` in step 5; do not generate it twice.” Include a private, non-echoing save example using the documented env-file conventions.

**Evidence:** step 3 secret setup/deployment logs and `06b-check-tokens.log`.

### P4 — Claude pipe notebook permissions need a concrete scoped JSON example

**Location:** §6b Notes, `INSTALL.md:1273–1287`, and pipe permission instructions **1435–1441**.

**What happened:** the guide correctly says explicit filesystem permission is required and must not be broadened silently, but does not give actual Claude rule/path syntax. The original repository contained no concrete `Read(...)`, `Edit(...)` or `Write(...)` examples. I chose `Read(/opt/embervy/notes/**)` and `Edit(/opt/embervy/notes/**)` initially. The live `Write` was denied:

```text
Permission for this tool use was denied. It requires approval,
and this session has no approval surface ...
The action was NOT performed ...
```

The agent reported the denial instead of inventing success. No saved note/index link existed, and the independent shell link check failed. **The unsuccessful absolute-looking rule was my interpretation, not a literal wrong rule printed in INSTALL.md.**

**What I did instead:** after reading/checking the existing user/project/local configuration, changed only the notes-specific rules in the project `.claude/settings.json` to:

```json
{
  "permissions": {
    "allow": [
      "Read(notes/**)",
      "Edit(notes/**)"
    ]
  }
}
```

This is the **notes-only fragment**, not a replacement for the other allowed app/Lore/Brain-status/house-read entries. `Edit(...)` is the file-writing permission family here, including creation through Write. I did not add Bash, a global filesystem allowance, `acceptEdits`, or a bypass. After a fresh pipe life loaded the rules, the repeated exact notebook prompt produced real successful Write, Edit, and two Read results. Independent link validation printed `Notes link target exists`.

The saved note has frontmatter (`name`, `description`, `type: project`) and only the synthetic body `cobalt notebook check`; `notes/NOTES.md` points to `(installation-check.md)`, relative to `notes/`.

**Recommended guide wording:** ship a tested notes-only project-relative JSON fragment for the chosen Claude cwd, explicitly distinguish filesystem rule path syntax from tool argument paths, explain creation/write authorization, and require the live Write/Edit/Read plus independent relative-link check before calling the notebook operational.

**Evidence:** `06b-check-notes.log`, its real event/outbox slices, failed `06b-check-notes-link.log`, `06b-settings-before-notes-fix.json`, `06b-notes-permission-workaround.txt`, `06b-check-notes-retry.log` and `06b-check-notes-link-retry.log`.

### P5 — Shipped systemd wrapper restart does not necessarily stop or replace Brain

**Location:** §6b Loop service, `INSTALL.md:1293–1324`; especially the fresh-life claim at **1318–1321** and the actual evidence requirements in **1326–1338**.

**Command:** `systemctl restart embervy-brain && systemctl is-active embervy-brain`, followed by the guide's context/pane reads and settled repeat while idle.

**What happened:** systemd returned `active`, but Brain remained **PID 10286**, session **1792243809968-4m4ojr**, immediately and after settling. No archive or new life resulted. The wrapper restarted, not the agent. This is a real failed check; `active` alone would have hidden it.

The observed tmux server (PID 9559, started 13:27:24) belonged to `/user.slice/user-0.slice/session-51.scope`, outside `embervy-brain.service`. Its pane/loop and Brain/Claude children were outside the service cgroup too. The new wrapper MainPID 11111 was inside `/system.slice/embervy-brain.service`. Journal stop/start happened in the same second, not after a timeout. `Brain/scripts/brain-loop-wrapper.sh:24–30` reuses an existing session and then sleeps while it exists; it has no corresponding synchronous stop/signal-forwarding logic. Thus `KillMode=control-group` did not terminate this already-existing tmux tree.

**What worked independently:** the guide's controlled cutoff at 13:36:36 sent SIGTERM directly to the owned Brain process, archived Session_1, and respawned it. That successful cut did not repair systemd ownership/restart semantics.

**Explicit local workaround:** preserved the original service, created `/opt/embervy/state/blindtest-stop-brain.sh` (mode 700), and added a synchronous `ExecStop` immediately after the existing `ExecStart`:

```ini
ExecStop=/bin/bash /opt/embervy/state/blindtest-stop-brain.sh
```

The helper installed and successfully tested on this house is:

```bash
#!/bin/bash
# Installation-test workaround: stop only this house's tmux loop gracefully.
set -eu
socket=/tmp/tmux-0/default
if tmux -S "$socket" has-session -t =brain 2>/dev/null; then
  tmux -S "$socket" send-keys -t brain -l /stop
  tmux -S "$socket" send-keys -t brain Enter
  for ((i=0; i<225; i++)); do
    tmux -S "$socket" has-session -t =brain 2>/dev/null || exit 0
    sleep 1
  done
  printf 'Brain did not finish graceful /stop within 225 seconds\n' >&2
  exit 1
fi
```

Then ran `systemctl daemon-reload` and repeated the original restart check. The helper uses the repository's documented `/stop` semantics: Brain archives, the loop consumes the stop marker and exits, and the wrapper returns its intentional-stop code. Relevant implementation: `Brain/brain.ts:3759–3760,4198–4203`, loop lines 54–59, wrapper lines 32–34. No repository runtime source was patched. The helper is specific to this root/default tmux socket and session; it is not offered as a universal upstream fix.

**Successful retest:** old Session_2 reported `session_archived`, `uploaded:true`, `reason:"stop"` at 13:40:16; new Brain **PID 12259**, session **1792244417249-9j1gbm**; actual `bridge_loaded` at 13:40:25.849. A fresh app message received the real tool/outbox reply `service restart app reply confirmed`.

An initial attempt at this **operator workaround** incorrectly used `send-keys -t =brain` and got `can't find pane: =brain`. I corrected those two `send-keys` targets to `brain`; the exact-match `has-session -t =brain` stayed. This intermediate mistake was mine, not a separate guide defect.

**Recommended guide wording/fix:** ensure the service synchronously stops its owned Brain loop and waits for archive completion regardless of whether tmux's server cgroup predates the service. Implement correct wrapper signal/ownership handling or a supported stop hook; qualify the fresh-life claim until that is true. Keep the current new-PID/session, archive upload-or-threshold, bridge event, and actual app-roundtrip checks. A service being `active` is insufficient. **Reboot below was tested with this local workaround, not the stock lifecycle.**

**Evidence:** `06b-check-loop-restart-first.log`, `06b-check-loop-restart-settled.log`, original unit `06b-service-before-stop-fix.service`, `06b-check-loop-restart-fixed2-initial.log`, `06b-check-loop-restart-fixed2-settled.log`, `06b-loop-restart-app.*`, `archive-bridge-proof.json`, service journal and session event logs.

### P6 — Finished-house check block masks the sweep's failing exit status

**Location:** §9 Finished-house sweep, `INSTALL.md:2081–2109`, especially Python exit at **2107** and the independent Bun command at **2109**.

**What happened:** my custom `INFRASTRUCTURE.md` used harmless `session-<id>.jsonl` / `conversation-<id>.jsonl` notation. The guide's deliberately broad marker scanner correctly asked for review:

```text
/opt/embervy/INFRASTRUCTURE.md:11: review template marker
placeholder sweep: review required
... bearer/URL comparisons: match ...
memory: authenticated 200
archive: authenticated 200
sweep block exit=0
```

The Python process exits 1, but the following successful Bun token check makes the overall pasted block exit 0. A caller trusting only the final exit status can miss the required review. The custom marker was **not** a leaked credential, an actual unresolved configured path, or a shipped template defect.

**What I did instead:** read the textual result, reviewed the intentional markup, reworded my house document to `session-SESSION_ID.jsonl` and `conversation-SESSION_ID.jsonl`, and repeated the exact block. It printed `placeholder sweep: clean` plus successful token checks. I did not alter the guide's scanner or pretend its original block exit propagated failure.

**Recommended guide wording:** use `&&` between the Python sweep and token check, or explicitly capture and propagate both statuses if both must always run. Explain that deliberate Markdown/path notation can require human review and that `review required` must not be ignored solely because the final block status is zero.

**Evidence:** `09b-check-sweep-first.log`, `09b-check-sweep-final.log`, `10-post-reboot-doctors-sweep.log`.

### P7 — Unpacked-repository `git diff --check` is vacuous before files are tracked

**Location:** §1 Clone / unpacked copy, `INSTALL.md:124–127,136–141`, especially **140**.

**What happened:** following the supported unpacked-copy route and `git init`, `git rev-parse --show-toplevel` correctly returned `/opt/embervy`. `git diff --check` returned no output, but the initialized repository had **0 tracked files**, so that command did not inspect the unpacked files' whitespace. No claim is made that an actual whitespace defect was found.

**What I did instead:** kept the files uncommitted/unstaged and recorded this as a limitation of that check, not proof that all initial file content was whitespace-clean. No commit was made to manufacture a passing result.

**Recommended guide wording:** distinguish “Git initialized” from “working-tree diff validated.” Provide a whitespace check that covers untracked unpacked input, or explicitly establish/inspect an index baseline (without accidentally staging credentials) before relying on `git diff --check`.

**Evidence:** `01-init.log`, `01-check.log`, `final-archive-and-git.log` (`Tracked files: 0`).

### P8 — Nonblocking header-language observation, not an installation blocker

**Location:** §6b Memory/archive and header enrichment, `INSTALL.md:1556,1570–1581`; language rule in `shared/subagents/auto-rag-header.md:12–15`.

The first enriched archive header, Session_1, had German `THEMES`/`SUMMARY` fields despite this test's English transcript. For example, `THEMES=Installation-Test, Notizen-Datei-Schreibrechte, ...` and `SUMMARY=Die Notizen-Datei konnte ...`. The helper instructions explicitly say to match the dominant transcript language; they are **not** a hardcoded instruction to write German. Later Session_3's header was English. Upload, hybrid retrieval and explicit transcript recall all worked.

**Action:** none; kept the real header and recorded the quality anomaly. No fabricated THEMES or language rewrite was used to force doctor success.

**Recommendation:** add a small human quality/language check of the first generated header; a successful helper exit/upload is not proof of language compliance. Treat this observation separately from deterministic guide command failures.

**Evidence:** `/opt/embervy/Brain/logs/sessions/Session_1.md`, header-enrichment events and `archive-bridge-proof.json`.

### Expected timing/skip behavior and tester mistakes — not guide bugs

- Wrangler warned that version 3 was outdated. The guide explicitly pins it; I did not upgrade it.
- Immediate app HTTP checks after `systemctl restart` briefly returned curl 7 / HTTP `000`. Lines 730–734 explicitly allow startup delay/retry. Retrying after about three seconds, including login, passed.
- First watchdog sample preceded the first live poll and had an empty session and zero threshold. The next 65-second sample advanced and matched the actual session and 900,000 cut. No threshold was lowered.
- The first shared doctor skipped content-dependent retrieval because no usable real session header existed yet, exactly as lines 2054–2068 explain. After actual archive enrichment, these checks passed. I did not count early skips as retrieval passes.
- A few test-driver construction/extraction mistakes (a malformed Python read, a heredoc quoting mistake, and initially including a closing Markdown fence when extracting the token-check script) were corrected immediately; they were not failures of literal guide commands. The tmux target mistake in the first local stop-hook attempt is detailed in P5.
- First SSH reconnect about 20 seconds after reboot was refused; another 35 seconds later the server was reachable. No service was started manually to rescue boot.

## 4. Ledger of every applicable Brain-path Check block

This ledger gives actual shortened, secret-free output or explicitly labelled real tool/event excerpts. Ellipses mean omitted output, not invented success. Full command/log/event/outbox evidence is under `/root/blindtest-evidence`; Brain's complete session/conversation logs remain under `/opt/embervy/Brain/logs`. For model turns I required actual tool-use/result records **and** actual outbox rows, never prose resembling a tool invocation. Checks marked “After First start” were deferred until their prerequisites, as instructed; the controlled cut was done after substantive step 8 turns.

### C00 — §0 Prerequisites, lines 99–107 — passed

```text
wrangler 3.114.17
The API Token is read from the CLOUDFLARE_API_TOKEN environment variable.
You are logged in with an Account API Token ... [account identity omitted]
1.3.14
Python 3.13.5
git version 2.47.3
OpenSSL 3.5.7 9 Jun 2026 (Library: OpenSSL 3.5.7 9 Jun 2026)
0
Linux
```

Used the guide's single-machine `id -u; uname -s` alternative. Evidence: `00-check.log`.

### C01 — §1 location/Git, lines 136–141 — passed with P7 limitation

```text
/opt/embervy
```

`git diff --check` had no output. `git ls-files` later confirmed zero tracked files. Evidence: `01-check.log`, `final-archive-and-git.log`.

### C02 — §2 archive, lines 233–239 — passed

```text
[{"name":"RAG_AUTH_TOKEN","type":"secret_text"}]
401
{"files":[]}
200
```

Secret names only; unauthenticated access denied and authenticated empty list returned. D1 `fts-init.sql` completed 11 remote queries; R2 and 1024-dimension cosine Vectorize resources and deploy succeeded. Evidence: `02-check.log`, `02-schema.log`, resource/deploy logs.

### C03 — §3 memory, lines 327–333 — passed

```text
secret names: APP_PUSH_TOKEN, EMBERVY_API_KEY, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
401
# Wake — Saturday, 17/10/2026, 13:24 (2026-10-17 13:24:33 UTC)
## Mood: initial
- memory bootstrapped
## Surfaces (0 shown)
...
## Daemon
- Last successful run: never
200
```

The displayed wake text came from the real authenticated JSON-RPC `result.content`, not an agent claim. Memory schema and RAG service binding were configured. Evidence: `03-check.log`, schema/deploy logs.

### C03b — §3b dream, lines 396–402 — passed, manual only

```text
secret names: DREAM_AUTH_TOKEN, OPENROUTER_API_KEY, RAG_AUTH_TOKEN
401
{"status":"dreamed","content":"While you were away, the silence stretched like a held breath. ..."}
200
{"version":"0.3.0","hot_count":0,"archive_count":0,
 "daemon_last_run":null,"daemon_last_ok":false,
 "dream_last_run":"2026-10-17 13:25:05",
 "warnings":["daemon never ran"], ...}
```

The dream used the shared memory database. Both cron arrays remained empty. Evidence: `03b-check.log`.

### C04 — §4 runtime/storage, lines 477–485 — passed after Node correction

```text
1.3.14
/opt/embervy
v20.19.2
2.1.302 (Claude Code)
... /swapfile ... 4G ...
... Mem: 3.7Gi ... Swap: 4.0Gi ...
... / ... 38G ... 9.5G ... 27G ... 27% ...
```

The optional Claude version check was actually run. `logrotate --debug /etc/logrotate.d/embervy` validated the configuration; initial missing log globs were skipped as expected. A 4 GiB persistent swap file, 2 GiB reserve ballast, swappiness 10 and journald cap were installed. Node retest:

```text
v22.23.3
2.1.302 (Claude Code)
```

Evidence: `04-check.log`, `04-node-workaround.log`, `04-overflow.log`.

### C05a — §5 initial login, lines 611–619 — passed locally

```text
401
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000
...
Authenticated chat shell HTTP 200
```

Protected internal model endpoint denied an unauthenticated request. Real local login and authenticated HTML fetch worked. No rendered-browser/public-route claim. Evidence: `05-check-login.log`, private cookie file, saved chat HTML.

### C05b — §5 app service restart, lines 722–734 — passed on allowed retry

Initial actual output:

```text
active
curl: (7) Failed to connect to 127.0.0.1 port 3030 ...
curl: (7) Failed to connect to 127.0.0.1 port 3030 ...
000
```

After approximately three seconds:

```text
{"ok":true}200
HTTP/1.1 200 OK
set-cookie: embervy_session=[redacted]; ...
```

The login check was repeated after restart too. Named-tunnel check skipped for no domain. Evidence: `05-check-restart-first.log`, `05-check-restart-retry.log`.

### C06 — §6 branch gate, lines 752–756 — passed

```text
inactive
inactive
inactive
inactive
```

Order: `embervy-loop`, `embervy-watchdog`, `embervy-brain`, `embervy-brain-watchdog`. Only the selected Brain pair was subsequently enabled. Evidence: `06-check.log`.

### C06b-identity — lines 1234–1239 — passed with real Read and reply

Ran the exact tmux identity/clock prompt. Real `Read` of `EMBERVY.md`, actual app reply tool success and matching outbox. It named the configured identity's load-bearing headings (Who I am; How I think; What I write down; Initiative; How I write; Tools I use; What I am not; What stays put; Infrastructure), memory/archive tools, and quoted:

```text
⏰ UTC: Saturday, 17.10.2026, 13:30
```

This matched the configured UTC clock. The API-only file-tool configuration was skipped, not substituted for the Claude pipe. Evidence: `06b-check-identity.log` and matching command/events/outbox files.

### C06b-notes — lines 1273–1287 — initially failed, passed after P4

Initial actual Write result: permission denied, no approval surface, action not performed. Initial independent link check failed without printing success.

Retest actual tools: successful **Write**, **Edit** of index, **Read** of index and note. Actual app reply quoted `cobalt notebook check`. Independent check:

```text
Notes link target exists
```

Note and index physically exist in `/opt/embervy/notes`, not in Lore or the old Claude notebook. Evidence: `06b-check-notes*.log`, `06b-check-notes-retry-events.jsonl`, matching outboxes, `06b-check-notes-link-retry.log`.

### C06b-loop — lines 1326–1338 — initially failed, passed after P5

Original check printed `active` but retained:

```json
{"pid":10286,"session_id":"1792243809968-4m4ojr","head":"claude",
 "model":"claude-opus-5-5[1m]","transport":"pipe",
 "warn_tokens":800000,"cut_tokens":900000}
```

Settled repeat still had the same life and no restart archive. After the explicit stop-hook fix, settled output:

```text
active
active
active
```

```json
{"pid":12259,"session_id":"1792244417249-9j1gbm","head":"claude",
 "model":"claude-opus-5-5[1m]","transport":"pipe","tokens":28351,
 "warn_tokens":800000,"cut_tokens":900000}
```

Pane: `Worker runtime ready (head claude, pipe, claude-opus-5-5[1m])`, actual reply tool activity. Old Session_2 uploaded, bridge loaded in the new life, and fresh app reply `service restart app reply confirmed`. Evidence: original and `fixed2` restart logs, `06b-loop-restart-app.*`.

### C06b-cut — lines 1371–1391 — passed with full archive/bridge/recall proof

Actual shortened command output:

```text
none 35797 3 900000 10286 1792243809968-4m4ojr below thresholds
1
=== brain-cutoff start 2026-10-17T13:36:36+00:00 ===
  Brain pid=10286
[1/3] SIGTERM → Brain archives itself (bridge + RAG export)
[2/3] waiting up to 180s for a clean exit
[3/3] clean exit
  bridge OK (9794 bytes)
  respawn delegated to brain-loop.sh
=== brain-cutoff done 2026-10-17T13:36:46+00:00 (TERMINATED) ===
```

Authenticated archive list included `Session_1.md` (10007 bytes) and `InstallCheck_1.md` (191 bytes). Old-life actual events:

```text
13:36:41.733 archive_header_enriched Session_1
13:36:45.160 session_archive_upload name=Session_1 ok=true parts=1
13:36:45.162 session_archived name=Session_1 uploaded=true reason=SIGTERM
```

New life: **PID 11501**, session **1792244208193-639po7**, `session_started` 13:36:48.357; **`bridge_loaded` 13:36:56.701, characters=9758** in that current life. No forced kill. Subsequent real app-requested recall returned `Session_1.md` with the earlier memory-test text (see C08b). Thus this is not merely a local bridge/file-existence pass. Evidence: `06b-check-cut.log`, `06b-check-cut-settled.log`, `archive-bridge-proof.json`, `08-post-cut-recall.*`.

### C06b-channel — lines 1485–1490 — passed

```text
bun run /opt/embervy/Claude/app/mcp.ts
10320 bun run /opt/embervy/Claude/app/mcp.ts
```

Exact requested real app reply:

```text
installation app-channel check
```

Actual tool result `Sent`, and outbox **0b39fb80-65a9-4402-8760-05ccdd848f4a**, **13:33:40.534Z**, type `reply`, exactly that text without prefix/suffix. Evidence: `06b-check-channel-process.log`, `06b-check-channel.log`, real event/outbox slices.

### C06b-inlet — lines 1530–1535 — passed with a fresh app question

Initial empty retrievals occurred while the archive was empty; after storing the labelled probe:

```text
13:34:41.844 inlet_injected via=worker characters=266
[InstallCheck_1.md] (RRF 0.0164 [bm25])
13:35:13.472 inlet_injected via=worker characters=273
[InstallCheck_1.md] (RRF 0.0328 [vector+bm25])
... The probe phrase is cobalt lantern recall check. It is test data, not an experience.
```

The second event followed a new authenticated app-originated question. Actual app reply returned the probe phrase. Worker log also contained earlier legitimate `confidence gate suppressed all hits ... topScore=none` diagnostics, not auth/schema failures. No Claude UserPromptSubmit inlet hook was installed and no relevance threshold was reduced. Evidence: `06b-check-inlet.log`, `06b-inlet-app-probe.*`.

### C06b-tokens — lines 1595–1599 — passed before First start and on repeats

The script was copied from the guide's token-check heredoc, lines 667–714. Real output:

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

These are comparisons and actual authenticated requests, not printed bearer values. Evidence: `06b-check-tokens.log`, final sweep/reboot doctor logs.

### C06b-first-start — lines 1680–1686 — passed

The actual first turn read `INFRASTRUCTURE.md` and `HANDBOOK.md` and used `mcp__app__reply` successfully. Matching greeting outbox **00305362-cdcd-47ce-89d9-6760713599d9**, **13:30:21.169Z**, began:

```text
Hi Tester — Blindtest here, the synthetic installation-test resident.
This is my first start: I've read INFRASTRUCTURE.md and HANDBOOK.md in full ...
```

Then a fresh app message, request **776b4039-9f13-495a-b266-9d98e404bb7a**, received a real reply and matching outbox **1620ee73-2616-47a9-a1bf-d4085d261100**, **13:30:46.991Z**:

```text
Hello Tester. Blindtest here, up and listening. What would you like to check first?
```

Check output:

```text
active
active
active
```

```json
{"pid":10286,"session_id":"1792243809968-4m4ojr","head":"claude",
 "model":"claude-opus-5-5[1m]","transport":"pipe","tokens":25065,
 "warn_tokens":800000,"cut_tokens":900000}
```

```text
1
```

The final `1` is the owned-process `--check-alive` result. Evidence: `06b-first-greeting.log`, `06b-hello-post.log`, `06b-check-first-start.log`, corresponding Brain event log/outbox.

### C07 — §7 shared watchdog selection, lines 1768–1775 — passed

Used the explicitly specified Brain substitution, not the Claude watchdog:

```text
active
```

Evidence: `07-check.log`.

### C07b — §7b advancing external watchdog, lines 1884–1890 — passed

```text
active
active
```

Selected fields from the first two actual samples of `Brain/state/watchdog_state.json`:

```json
{"last_check_ts":"2026-10-17T13:30:09.723853+00:00","session_id":"",
 "tokens":0,"cut_tokens":0,"pid":10231}
{"last_check_ts":"2026-10-17T13:31:09.871424+00:00",
 "session_id":"1792243809968-4m4ojr","tokens":25065,
 "cut_tokens":900000,"pid":10231}
```

The first sample preceded the first poll. After the instructed 65 seconds, timestamp advanced and fields matched Brain. `pid` here is the external watchdog PID, not Brain's PID. This external file is distinct from the app-compatible `state/watchdog_state.json`. Evidence: `07b-check-advance.log`.

### C08a — §8 Brain app smoke, lines 1919–1931 — passed

Submitted the wake/write/find request through authenticated **`POST /api/message`**, request **d05007fe-4f13-4df0-8b0e-332d8d1435d9**. Actual tools/results:

```text
mcp__lore__wake: real wake returned at 13:34:12 UTC
mcp__lore__write: Wrote event 1 (kind=observation, weight=light, embedded=1)
mcp__lore__find: event 1, amber clock installation memory test
mcp__app__reply: Sent
```

An actual matching outbox entry was present. `/status` through the app reported the intended live head and thresholds; shortened values:

```text
claude (pipe); claude-opus-5-5[1m]; served claude-opus-5-5
window 35797 / 1000000; warn 800000; cut 900000
pipe alive; births 1; inlet on
```

Evidence: `08-app-smoke.*`, `08-status-post.json`, actual session/conversation logs. App replies, not terminal prose, were required.

### C08b — §8 archive probe Check and post-cut repeat, lines 1947–1979 — passed

Created the exact guide's synthetic `state/install-recall-probe.md`, uploaded as `InstallCheck_1.md`:

```json
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
```

Ran the exact tmux prompt with `CHECK_SESSION=brain`. Actual tool results:

```text
wake: real time-bearing response
write: event 2, Synthetic installation test data: cobalt lantern memory check
find: event 2 and the same observation returned
recall: RAG recall: 1 hits
source: InstallCheck_1.md#0
score: 0.01639344262295082
```

The actual recall text was:

```text
# Installation recall probe

This synthetic installation check verifies hybrid archive search and recall.
The probe phrase is cobalt lantern recall check.
It is test data, not an experience.
```

Then real reply tool plus outbox. A separate new app question and automatic retrieval also passed (C06b-inlet).

**After the real cut**, a fresh app message explicitly requested `mcp__lore__recall` for `amber clock installation memory test` in the archived life. Actual recall returned **5 hits, all `Session_1.md`**, including chunks **#7** (score approximately **0.996**) and **#8** (approximately **0.995**) with the prior memory-test text. A real app tool reply and corresponding outbox followed. The automatic inlet also retrieved enriched Session_1 with vector+BM25+rerank. This proves retrieval of the cut-produced transcript, not just the standalone probe.

Evidence: `08-check-probe-upload.log`, `08-check-recall.log`, corresponding real events/outbox, `08-post-cut-recall.*`.

### C09b — §9b preflight/shared doctor, lines 2014–2017,2027–2030,2043–2068 — passed

Preflight was run **before First start**, then repeated later and after reboot:

```text
{"ok":true,"checks":[... head claude / claude-opus-5-5[1m] / pipe ...
 RAG configuration valid ... no RAG uploads owed ... inbox writable ...
 system bus available ... native Claude web backend ...]}
preflight exit=0
```

Initial shared doctor (before a usable archived session header):

```text
PASS ... 17 checks ... 0 warn ... 0 fail ... 5 skip
```

Content-dependent hybrid/BM25/reranker/inlet skips were legitimate at that stage, not counted as passed. After the real cut/archive, the 13:41:13 doctor reported:

```text
PASS ... 21 checks ... 0 warn ... 0 fail ... 1 skip
doctor exit=0
hybrid: mode=hybrid, vector=12, bm25=12
FTS5: 12 hits
reranker: ... vector,bm25,rerank ...
inlet: 2745 bytes, retrieved hit found
MCP: 2/2 connected
```

Only the **other harness's Claude headless canary** was skipped; Brain was the selected harness. Post-reboot repeat again passed (C10). Evidence: `09b-check-preflight.log`, `09b-check-shared-first.log`, `09b-check-final-doctors.log`, `10-post-reboot-doctors-sweep.log`.

### C09-house — §9 finished-house sweep, lines 2081–2109 — passed after human review

Original reviewed result and masked exit status are reproduced in P6. After rewording the custom documentation notation:

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

No active unresolved template marker was ignored. Evidence: `09b-check-sweep-first.log`, `09b-check-sweep-final.log`; same clean result after reboot.

### C10 — §10 actual reboot and follow-up, lines 2125,2143–2157 — passed with workarounds

Before reboot all three selected units were enabled. A real pre-reboot Read of the persisted note and actual reply confirmed `cobalt notebook check`. Issued the actual reboot; no manual service starts afterward. Shutdown archived Session_3 using the local synchronous stop hook:

```text
13:41:55.585 shutdown reason=stop
13:41:59.801 archive_header_enriched Session_3
13:42:01.720 session_archive_upload name=Session_3 ok=true
13:42:01.722 session_archived name=Session_3 uploaded=true reason=stop
```

Boot ID changed. Actual post-reboot check at approximately 13:43:07:

```text
active
active
active
{"ok":true}
```

```json
{"pid":1033,"session_id":"1792244546227-3b8mu5","head":"claude",
 "model":"claude-opus-5-5[1m]","transport":"pipe","tokens":29438,
 "warn_tokens":800000,"cut_tokens":900000}
```

```text
/swapfile ... 4G ... 0B ...
other harness: inactive / inactive
```

Current-life **`bridge_loaded` 13:42:34.775, characters=17654**. Actual reboot greeting tool use at **13:42:46.711**, tool result **Sent** at **13:42:46.740**, matching outbox **51403bc8-5f41-406f-9d53-f0d71505c154**, **13:42:46.725Z**:

```text
Hello again Tester. Blindtest here, back after the cut (Session_4) ...
```

Fresh authenticated **local** app request **0ab4ffcb-699b-416f-a185-d04f54093609**, actual reply tool success and matching outbox **6edd0997-9b96-465b-82f4-d16baa63bd49**, **13:43:27.040Z**:

```text
reboot app reply confirmed

First clock line this life: `⏰ UTC: Saturday, 17.10.2026, 13:42`
```

The guide's public-app follow-up was replaced only by the expressly permitted no-domain local test; no public reachability claim is made.

Actual external-watchdog repeat after boot:

```text
last_check_ts: 2026-10-17T13:43:26.066877+00:00
           -> 2026-10-17T13:44:26.224218+00:00
session: 1792244546227-3b8mu5
 tokens: 29438 -> 31272
cut_tokens: 900000
watchdog pid: 909
```

Post-reboot doctor at 13:45:41:

```text
preflight ok: true; preflight exit=0
PASS ... 21 checks ... 0 warn ... 0 fail ... 1 skip; doctor exit=0
archive: 4 files indexed
hybrid: vector=24, bm25=24
reranker active
inlet: 2758 bytes, retrieved hit found
MCP: 2/2 connected
placeholder sweep: clean
... all bearer/URL groups match ...
memory: authenticated 200
archive: authenticated 200
```

Evidence: `10-before.json`, `10-enabled-before.log`, `10-check-reboot-initial.log`, `10-reboot-greeting-proof.json`, `10-post-reboot-app.*`, `10-check-watchdog-advance.log`, `10-post-reboot-doctors-sweep.log`.

## 5. Persisted setup and evidence locations

- Archive: `https://embervy-chronicle.<account>.workers.dev`; D1 `rag-fts`, R2 `rag-storage`, Vectorize `rag-vectors` (1024/cosine), `SESSION_PREFIX=Session`.
- Memory: `https://embervy-memory.<account>.workers.dev`; D1 `embervy-memory`, R2 `embervy-archive`, Vectorize `embervy-vectors` (1024/cosine), RAG service binding to chronicle, UTC. Public app/video URLs empty.
- Dream: `https://embervy-dream.<account>.workers.dev`; shared memory D1, chronicle binding, UTC, empty cron. These endpoints are worker URLs, not purchased/public app hostnames.
- Root/app envs, `Brain/brain.env`, `.mcp.json`, `.claude/settings.json`, identity/house documents, first-turn/cursor setup, notebook, services and storage settings remain on the server. `brain.env` explicitly uses `BRAIN_PIPE_PERMISSION=none`, `BRAIN_APPROVAL=off`, scoped MCP/file grants, and Brain-managed inlet; no Claude inlet hook.
- `Brain/state/watchdog_state.json` is the advancing external watchdog state; `state/watchdog_state.json` is app-compatible state, not a substitute for the external advancement test.
- Original service and notes config snapshots and explicit local workaround are retained. Runtime source code was not changed to repair the service; service unit plus a new local stop helper were.
- Full evidence: `/root/blindtest-evidence` (private). Model-turn driver saves the submitted commands/requests, actual new event slices and actual outbox snapshots. Complete Brain life logs and local archives remain in `/opt/embervy/Brain/logs` and `Brain/logs/sessions`.
- The private app cookie file is an authentication artifact, **not** report content. Do not publish the whole evidence directory without a separate secrets review.

Final authenticated archive listing (after the tests) contained:

| File | Bytes | Upload timestamp (UTC) |
|---|---:|---|
| InstallCheck_1.md | 191 | 13:34:37.234 |
| Session_1.md | 10007 | 13:36:42.131 |
| Session_2.md | 5576 | 13:40:13.943 |
| Session_3.md | 3369 | 13:42:00.056 |

The final deliberately stopped post-reboot life logged `session_archive_skipped`, `reason:"below turn threshold"`, `turns:2` at 13:45:42.957. I do **not** claim a Session_4 upload; this is the guide-allowed explicit threshold outcome. It does not negate the proven Session_1/2/3 archives.

## 6. Final functional conclusions

| Question | Conclusion and evidence |
|---|---|
| Did the agent answer through the app? | **Yes, locally.** Real authenticated app messages triggered actual `mcp__app__reply` results and matching outbox rows, including initial hello, exact channel check, fixed restart and post-reboot message. No text-only pretend tools counted. Public/browser/phone access remains unverified. |
| Did memory write/read work? | **Yes.** Actual Lore wake/write/find returned event 1 (`amber clock installation memory test`) and event 2 (`cobalt lantern memory check`). |
| Did archive recall work? | **Yes.** Actual `mcp__lore__recall` returned `InstallCheck_1.md#0` and the exact labelled probe text; automatic inlet retrieved it too. |
| Did a cut create an archive that could be found again? | **Yes.** Clean SIGTERM cut uploaded Session_1; new life had actual `bridge_loaded`; a fresh app-requested real recall returned Session_1 chunks containing the prior test text. |
| Did notebook persistence work? | **Yes, after explicit scoped permission correction.** Actual Write/Edit/Read, independent relative-link validation, and pre-reboot saved-note Read passed. |
| Did service restart work as shipped? | **No.** The stock unit restarted only its wrapper in the observed tmux ownership arrangement. **Yes after** the explicit local synchronous stop-hook workaround. |
| Did everything selected come back after a real reboot? | **Yes with the recorded workarounds.** Three selected services active without manual starts, new PID/session, bridge loaded, actual greeting and fresh app reply, advancing external watchdog, persistent swap, doctor and sweep passed. Not a claim about the unmodified service or excluded modules. |
| Did unattended daemon/dream scheduling work? | **Not tested.** Both crons empty by permission; daemon never ran. Manual dream succeeded. |

### Duration

- First guide/server inspection: **2026-10-17T13:21:04+00:00**.
- Evidence/setup marker: **2026-10-17T13:21:22.841418+00:00**.
- Live tests completed: **2026-10-17T13:45:43.892096+00:00**.
- Live installation/test duration from marker: **1461.051 seconds (24 minutes 21.051 seconds)**; approximately **24 minutes 40 seconds** from first inspection.
- Report assembled/written: **2026-10-17T13:57:15.423466+00:00**.
- Whole elapsed run through report assembly, from first inspection: **36 minutes 11.4 seconds**.
- Guide SHA-256: `756e9b1a1814690ac531a352ad9dea64c6bd4db02aa495ebb9068524b041d276` (identical to the supplied source guide).

The live test interval includes actual relay sign-in, model turns, two 65-second watchdog checks, lifecycle debugging, controlled cut, real reboot and final doctors. Report assembly time is separated rather than passed off as additional live testing.

### OpenRouter cost — measured key usage difference

From authenticated `GET https://openrouter.ai/api/v1/key`, saving only numeric usage metadata:

```text
Before cumulative key usage: USD <key total>
After cumulative key usage:  USD <key total>
Difference for this run:     USD 0.002818820
```

This is approximately **0.28 US cents**, well under the **USD 1** cap. The pre-existing cumulative usage was not charged to this test. The measured key-counter delta covers the supplied key's calls during the interval, including inlet/dream-related OpenRouter work; it is not an estimate derived from head tokens. Evidence: `openrouter-before.json`, `openrouter-after.json`.

No separate Anthropic API billing was set up; the main head and header helper used the existing Claude subscription. No Cloudflare paid-plan/purchase/billing action was taken. An existing server/subscription's sunk cost is not apportioned here, and no Cloudflare invoice audit was performed.

### Brain main-head token usage — actual logs, not a dollar estimate

Aggregated **51 unique `usage` records**, deduplicated by event id; raw and deduplicated counts were both 51. Model: `claude-opus-5-5`.

| Logged field | Tokens |
|---|---:|
| input | 102 |
| output | 8,838 |
| cache_read | 1,403,100 |
| cache_write | 107,141 |
| Sum of represented token fields | **1,519,181** |

This sum includes repeated cached context across calls; it is **not** a unique context length, not 1.5 million newly generated tokens, and not a subscription dollar charge.

| Brain life | Input | Output | Cache read | Cache write | Usage records |
|---|---:|---:|---:|---:|---:|
| 1792243809968-4m4ojr | 52 | 4,727 | 728,772 | 35,795 | 26 |
| 1792244208193-639po7 | 24 | 2,299 | 328,197 | 26,197 | 12 |
| 1792244417249-9j1gbm | 16 | 931 | 218,686 | 23,029 | 8 |
| 1792244546227-3b8mu5 | 10 | 881 | 127,445 | 22,120 | 5 |

**Coverage caveats:** Brain logged 16 `usage_coverage` events with reason `external_inlet_has_no_usage_protocol`; these external OpenRouter costs are instead covered by the measured key delta. The separate subscription-backed archive-header enrichment helper does not feed its usage into Brain's main-head `usage` events, so its tokens are **not** included above and cannot honestly be invented from these logs. Evidence: `brain-head-token-usage.json`, real session event logs.

### Deliberate end state and spending protection

After all reboot/live checks and the final doctor/sweep, I deliberately ran `systemctl stop embervy-brain` to prevent the default 50-minute cache ping or later activity while assembling the report. The synchronous local stop hook finished; the bound watchdog stopped too. This was **not** a reboot recovery failure. At the verified end:

```text
embervy-app: active
embervy-brain: inactive       # deliberately stopped after all tests
embervy-brain-watchdog: inactive  # stopped with bound Brain
```

All three units remain enabled for boot. Worker cron schedules remain empty. Created Cloudflare resources and installation/evidence files were retained; nothing pre-existing was deleted. The login relay files were removed after successful sign-in. There were no further model calls after the deliberate stop.

**Bottom line:** the required local Brain/Claude-subscription installation, app tool channel, memory write/read, automatic and explicit archive recall, controlled cut and reboot recovery were demonstrated with real evidence at tiny OpenRouter cost. The unmodified guide still needs an editor prerequisite, complete Node setup, early push-token creation, concrete narrow notebook permission rules, and—most importantly—correct synchronous service lifecycle handling. Its sweep/Git check caveats and the nonblocking header-language observation are recorded separately rather than hidden by the final green doctor.
