# Embervy manual installation blind test — Brain / OpenRouter API head

> **Continuation completed:** current acceptance is in §6 and “Second part: from First start on”. The first-part summary/table/queued ledger below are historical; they describe the earlier safety stop, not the final state.

## Summary and stopping point

**Incomplete: stopped before Brain First start, INSTALL.md §6b, line 1495.** The archive, memory worker, app HTTP boundaries, configuration/token comparisons and Brain's no-model-call preflight passed. No agent life was started.

The instructions for this test say both to use `qwen/qwen3.5-9b` and keep costs low, and **never spend money**. I applied the stricter no-spend rule. A read-only, unauthenticated request to OpenRouter's model catalogue (`https://openrouter.ai/api/v1/models`) returned nonzero prices for the exact requested model: prompt **$0.0000001/token**, completion **$0.00000015/token**, context **262144**. The guide itself explicitly identifies the authenticated dream check as a paid model call at INSTALL.md:340. I asked for clarification in the conversation; no permission for metered model calls had arrived when this report was written. I did not substitute a different/free model, spend credits, buy anything, change plans, register a domain, enable billing, or agree to billing terms.

This stop is **a test-constraint conflict, not a demonstrated Brain runtime defect**. A configuration preflight cannot stand in for a model turn. All unrun checks below are marked unrun, not successful. I did not continue to the smoke test or reboot after the stop.

### Scope and reproducibility

- Target: disposable Debian GNU/Linux 13.6 VPS, accessed as root using `ssh root@<test-server>`.
- All intentional installation/configuration work and report files are on that server. Nothing was installed or configured on the starting machine. SSH and the tool harness's own transcript capture were the only local-side activity.
- Supplied source: `/root/embervy-src`, an unpacked tree without `.git`; installation home: `/opt/embervy`.
- INSTALL.md references below are **original, 1-based line numbers** in `/root/embervy-src/INSTALL.md`.
- Original INSTALL.md SHA-256: `89178174c18626c5eb6c1353a550b33e250d0b06d2a55eb2fd9224050e10f3d2`.
- Original README.md SHA-256: `2a173c258ed189222d03a196075a5fc9eb12243a0788c5ca40a2b9e4414bf576`.
- Read the repository's README/INSTALL and referenced repository documents. I did not use external installation recipes to silently repair it. The provider catalogue lookup above was an explicitly reported cost/window safety check, not an undocumented installation recipe.
- This VPS also acted as the deployment workstation for steps 0–3b, as required by the test's remote-only constraint. Each SSH shell reloaded credentials as data using the repository's `shared/scripts/env-file.sh`; no `.env` was executed and shell tracing stayed off.
- Secrets are referenced only by name. Report/log output is redacted; env files, MCP configuration, Brain profile and report are private.

## 1. Step results

`ok` means the stated work/check actually passed, not that later runtime behavior was inferred. A partially skipped step is not a passed done-gate.

| Step | Result | What actually happened |
|---|---|---|
| 0 — Prerequisites / tools | fixed by me | Initial tool gate failed; installed prerequisites on this VPS, including omitted unzip/Node/npm and explicit Wrangler; authenticated with the supplied account token. |
| 0 — Domain/public app prerequisite | skipped | No domain or zone; did not buy/register one or set up a public app hostname. Provider-assigned worker URLs remained usable. |
| 1 — Source and EMBERVY_HOME | fixed by me | Copied supplied tree to `/opt/embervy`; initialized/staged local Git metadata without a commit because the supplied tree had no `.git`; repeated guide checks passed. |
| 2 — Archive worker | ok | Created R2, Vectorize and D1 resources, applied schema, set auth secret, deployed; secret/authentication gate passed. |
| 3 — Memory worker | ok | Created resources, applied schema, set four required secrets, configured RAG service binding/UTC, deployed; protected wake gate passed. Paid-model cron intentionally disabled. |
| 3b — Dream worker | skipped | Deployed against the same memory DB and archive binding; three secret names and unauthenticated 401 verified. Paid generation/non-null dream gate not run; cron disabled. |
| 4 — VPS runtime and overflow | fixed by me | Documented apt/Bun/Claude Code commands ran after dependency repairs; 4 GiB swap, 2 GiB reserve, journal cap and generated logrotate config checked. Node engine warning remains documented. |
| 4 — Cloudflared/public tunnel | skipped | Optional and needs a domain/public app address; no zone changes or quick tunnel. |
| 5 — App HTTP/service checks | ok | Installed dependencies, ran initial server, tested 401/login cookie, installed systemd unit, restarted and retested health/internal auth/login. |
| 5 — Browser/PWA/public login | skipped | No public app hostname and no interactive browser session was used. HTTP login is verified, but rendered chat shell/phone behavior is not. |
| 6 — Harness selection | ok | All four harness/watchdog units were inactive before wiring. Claude Code branch not installed as a runtime. |
| 6a / 7a / 9a — Claude Code branch | skipped | Not the chosen harness. Installing the CLI in step 4 did not sign into a subscription or start this harness. |
| 6b — Identity/API profile/notes/channel/inlet/connections | fixed by me | Wired API-first profile and explicit workspace permissions using referenced repository docs/code; created house files, notes, MCP and service definitions. No queued model-based checks claimed. |
| 6b — Memory/chronicle token Check | ok | All local comparison groups matched; both workers authenticated with HTTP 200. |
| 6b — Subscription-based header enrichment | skipped | Omitted `BRAIN_HEADER_ENRICH_CMD` as explicitly instructed for no Claude login (1414–1418); no subscription attempt. |
| 6b — First start and queued runtime checks | skipped | Stopped before line 1495 to avoid paid OpenRouter calls. No greeting, agent read/write, app reply, inlet turn, restart or cut was executed. |
| 6c — ChatGPT subscription | skipped | No ChatGPT subscription; not needed for the configured `api` head. |
| 7b — Watchdog installation | ok | Installed exact guide unit and enabled it with Brain during wiring, without starting Brain; both later disabled for no-spend safety. Live watchdog check not passed. |
| 7 / 7b — Live watchdog checks | skipped | Require a running Brain life; none was started. |
| 8 — Agent smoke test / recall probe / cut | skipped | Requires model turns; no synthetic archive probe upload or agent memory write was performed. |
| 9b — Before-start configuration preflight | ok | `bun scripts/brain-doctor.ts` returned `ok:true`, selected `api / qwen/qwen3.5-9b / api`, exit 0. |
| 9b — Shared live doctor/final finished-house sweep | skipped | Shared doctor is prescribed after runtime; installation did not reach that gate. No live health claim inferred from preflight. |
| 10 — Reboot and cold-start verification | skipped | Smoke/runtime gates had not passed; reboot could otherwise initiate paid model work. |

## 2. Problems, exact locations, changes and suggested guide text

### P1. Fresh-machine prerequisite bootstrap and Wrangler authentication/version are unspecified

**Location:** §0 “Prerequisites”, INSTALL.md:50–68; §4 dependency block, 367–369. Step 0 assumes tools already exist and steps 0–3b assume an authenticated workstation shell.

**Observed:** the server initially had `python3`, `openssl` and `curl`, but no Wrangler, Bun, Git, Node or npm. The literal initial gate produced:

```text
$ wrangler whoami
bash: wrangler: command not found
$ bun --version && python3 --version && git --version && openssl version
bash: bun: command not found
```

The guide does state the preinstalled-tool requirement; this is **not** evidence that an installed Wrangler failed. The gap for this fresh-server/manual test is a reproducible bootstrap and authentication recipe, including supported versions. There is no explicit manual API-token loading recipe or token-scope checklist in this section; the onboarding Cloudflare consent instructions concern the separate installer.

**What I did:** ran the §4 apt/Bun bootstrap early on this VPS; installed the additional dependencies in P2/P3; explicitly ran `npm install -g wrangler@3.114.17`, matching `shared/rag/bun.lock` (and its declared Wrangler 3 dependency). Exported `/root/.bun/bin` on PATH in later SSH shells, set `WRANGLER_SEND_METRICS=false`, and used:

```bash
. /opt/embervy/shared/scripts/env-file.sh
embervy_env_load -x /root/blindtest.env /opt/embervy/.env
```

This loaded `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and `OPENROUTER_API_KEY` without printing them. `wrangler whoami` then identified the intended account via an Account API Token and exited 0. Wrangler repeatedly warned that 3.114.17 is out of date (4.151.1 advertised); I did not silently upgrade away from the repository's lockfile version.

**Guide should say:** how to prepare a clean Debian workstation/server, which Wrangler/Node versions are supported, how to authenticate or export an existing token safely, and which permissions the account token needs. Explicitly permit one host to act as workstation and VPS with data-only env reloads, if that is supported. The initial starting-machine restriction here was specific to this test, not a general guide defect.

### P2. Bun bootstrap fails because unzip is absent from the preceding apt command

**Location:** §4 “Set up the VPS”, INSTALL.md:367–368.

**Exact attempted command:**

```bash
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14"
```

**Real error:** `error: unzip is required to install bun`.

**What I did:** installed `unzip` explicitly, then reran the exact installer after apt finished. It installed Bun 1.3.14 successfully. The guide's apt list does not mention unzip.

**Guide should say:** include `unzip` in the apt prerequisites **before** invoking the Bun installer, and verify that installer command succeeded before using Bun.

### P3. npm is not installed, and a naive Debian Node/npm repair leaves a version warning

**Location:** §4, INSTALL.md:367–369; tool version gate at 409.

**Observed:** `npm --version` initially failed `bash: npm: command not found`. Line 369 requires npm but neither step 0 nor the line-367 apt command installs Node/npm. I did not run the exact Claude Code install command until npm had been added, so I am not presenting its later success as an original unmodified bootstrap success.

**What I did:** `apt install -y unzip nodejs npm` installed Node **v20.19.2** and npm **9.2.0** from Debian. The exact line-369 command then ran:

```text
$ npm install -g @anthropic-ai/claude-code
npm WARN EBADENGINE Unsupported engine
package: '@anthropic-ai/claude-code@2.1.302'
required: { node: '>=22.0.0' }
current: { node: 'v20.19.2', npm: '9.2.0' }
added 3 packages
$ claude --version
2.1.302 (Claude Code)
```

**What I did instead / remaining limitation:** explicitly installed the missing Debian packages. I left the Node engine warning visible rather than importing an external Node-upgrade recipe. The installed native CLI's version check passed; a subscription/pipe turn was not tested or required for the selected API head.

**Guide should say:** install a supported Node/npm version before invoking npm, or provide a validated non-npm installation route. A floating latest Claude Code package can outgrow Debian's default Node; a successful native version check does not resolve its declared engine requirement. Explain whether this binary can be omitted for an API-only Brain house with no header-enrichment subprocess.

### P4. API-first installation requires assembling a profile from cross-references

**Location:** §6b “Identity”, INSTALL.md:1043–1085; referenced “other heads and API workspace permissions”, 1424–1427; threshold instructions, 1192–1205.

**Observed during configuration (not a failed model call):** the supplied ready-to-paste profile selects `BRAIN_HEAD=claude` and a 1M Claude window, then discusses Claude sign-in or GPT-first setup. It is not an OpenRouter/API-first profile. The guide does explicitly refer the reader to `Brain/README.md`; therefore the API settings are **cross-referenced, not nonexistent**.

**What I did:** used `Brain/README.md:49–54,93–115` and `Brain/brain.env.example:305–306` to replace Claude-specific profile settings with:

```ini
BRAIN_HEAD=api
BRAIN_ENDPOINT=https://openrouter.ai/api/v1/chat/completions
BRAIN_API_KEY=[value of OPENROUTER_API_KEY, not printed]
BRAIN_MODEL=qwen/qwen3.5-9b
BRAIN_CONTEXT_WINDOW=262144
```

The secret placeholder above is explanatory text, not a literal value left in the actual profile. I retained the common state/log/control/timezone/app settings. The 262144 window is the requested provider catalogue's advertised value, recorded openly above. Without an explicit API window, the reference default is 1,000,000; it is not discovered from the provider by the installation profile. I did not set the 1M Claude thresholds on this API head. No actual running thresholds were measured because Brain was not started.

**Guide should say:** include an API-first profile beside the Claude/GPT instructions, with exact endpoint/key/model/window variable names and a warning to set the selected model/provider's actual window before deriving watchdog thresholds. Keep the API instructions clearly separate from subscription/login/pipe-specific settings.

### P5. Prescribed API identity/first-turn/notebook checks need filesystem tools which the profile does not enable

**Location:** §6b “Identity”, INSTALL.md:1090; “Notes”, 1101–1132; API-permissions cross-reference, 1424–1427; “First start”, 1470–1473.

**Observed during configuration, not a runtime tool failure:** the first turn must read the two house documents; the identity check asks the agent to read EMBERVY.md; the Notes check asks it to write, index and read a note. `BRAIN_NOTES_DIR` injects the index but does not enable API file tools. The inline profile does not configure an API workspace or a write allowlist. Line 1132 correctly warns against silently broadening permissions, but does not provide the needed configuration.

`Brain/README.md:261–272` and `Brain/brain.env.example:154–160` explain the variables. They do not explain the allowlist's actual newline/exact-path/directory-prefix syntax; that detail was found in repository code (`Brain/brain.ts:912–922,1069–1091`).

**What I did:** explicitly configured:

```ini
BRAIN_WORKSPACE_READ=/opt/embervy
BRAIN_WORKSPACE_WRITE_LIST=/opt/embervy/Brain/workspace-write-allowlist.txt
BRAIN_WORKSPACE_BACKUP_DIR=/opt/embervy/Brain/backups
```

The allowlist contains one line, `notes`, allowing the notebook subtree only. The filled identity names `notes/installation-check.md` for the test. There is **no shell permission**. I did not install Claude pipe `.claude/settings.json` permissions for this API-only profile. This choice was reported in the installation output. The read root also contains env files, so I documented that secret-exposure scope in the house documents; it is not a claim of secret-file isolation.

**Guide should say:** provide a least-scope, explicit API workspace/allowlist example and its file syntax before asking the API agent to read/write files. Explain workspace-relative paths, directory prefixes versus globs, and that choosing the whole house as a read root includes its secret configuration. These file tools remain **unverified at runtime** in this run.

### P6. The initial app command is backgrounded despite its “foreground” comment

**Location:** §5, INSTALL.md:535 and stop instructions 552–553.

**Command:** `bun run server.ts &   # foreground first time, watch the log`.

**What happened:** the app started correctly and both HTTP/login checks passed. The `&` backgrounds it; the comment says the opposite. In a noninteractive SSH script there is no interactive `fg` workflow. I redirected server output to `/root/blindtest-app-first-start.log`, captured the PID I created (9677), and tried `kill -INT 9677` as a Ctrl-C equivalent. The asynchronous child ignored SIGINT in this shell context, and the waiting command remained alive for approximately two minutes. I inspected the owned PID/listening port, then used `kill -TERM 9677`, which stopped it. I did not kill an unrelated process.

**Classification:** wording ambiguity plus a **test-shell adaptation**, not an app startup/authentication failure. In an interactive Bash shell, the guide's subsequent `fg`/Ctrl-C instructions could work.

**Guide should say:** either use `bun run server.ts` without `&` for an actual foreground first run, with checks in another terminal, or explicitly document background launch, PID/log handling and an appropriate stop command for a noninteractive session.

### P7. Generated logrotate policy does not cover the chosen Brain log directory

**Location:** §4 “Room to overflow”, INSTALL.md:383–398, especially 395–398; compare §6b profile `BRAIN_LOG_DIR`, line 1062, and runtime archive locations 1400–1402.

**What happened:** the literal generated config only targets `/opt/embervy/logs/*.log`, `*.jsonl` and `*.err`. The prescribed Brain runtime writes under `/opt/embervy/Brain/logs`. `logrotate --debug /etc/logrotate.d/embervy` was syntactically successful but reported only the root logs globs (not yet present); it cannot prove retention for Brain's separate logs.

**What I did instead:** left the literal generated policy unchanged and recorded this static path mismatch. No disk-growth/runtime failure was observed, since no Brain life ran. I did not blindly add/truncate all Brain JSONL files: conversation/session logs participate in archival and need a deliberate retention policy.

**Guide should say:** distinguish diagnostic log rotation from conversation/archive retention, and supply a safe Brain-specific policy for the configured directory. Do not describe the root-only glob as controlling the whole Brain stack's logs.

## 3. Environment accommodations and intentional skips — not guide defects

### Supplied source is not a Git clone

**Location:** §1, INSTALL.md:75–90, and §4:374–377. Both clone URLs are placeholders. This test instead supplied `/root/embervy-src` without `.git`.

I used `cp -a /root/embervy-src /opt/embervy`, exported EMBERVY_HOME and persisted the path in root's `.bashrc`. Initial literal Git checks returned:

```text
rev-parse --show-toplevel: fatal: not a git repository ... ; exit 128
diff --check: warning: Not a git repository ... ; exit 129
```

I initialized Git metadata and staged the supplied tree, **without a commit, push or remote**. The repeated guide checks returned `/opt/embervy`, then no output/exit 0. This does not recreate upstream history. An additional, explicitly non-guide `git diff --cached --check` returned exit 2 on pre-existing trailing whitespace/EOF blanks (e.g. `Brain/account.ts:6`, `Claude/app/server.ts:3018`, `shared/memory/src/index.ts:17`). I did not modify code or mislabel those as failure of `git diff --check` on an actual clean clone. The guide should provide a source-archive alternative if it intends to support unpacked distributions; this accommodation is caused by the test fixture.

### No domain, subscriptions or paid model work

- §0:39–44 and §5:659–661: public app/tunnel/phone address skipped as expressly required. No cloudflared installation, zone records, tunnel hostname or domain purchase. Workers deployed successfully to provider-assigned `workers.dev` URLs; no custom worker routes were enabled.
- §3:227–245: set PUBLIC_URL from the actual provider worker address, RAG service binding to `embervy-chronicle`, TIMEZONE UTC, and left APP_URL empty instead of keeping the template URL. In step 2, SESSION_PREFIX was set to `Session` **before** deploy, as lines 155–159 already permit.
- §3b:340,351: authenticated `POST /dream` deliberately not run. The separate health GET returned a null dream time, not a fictitious successful dream. This warning in the guide is accurate.
- §3 cron and §3b cron: set `crons = []` as an explicit no-spend safety deviation, preventing future OpenRouter daemon/dream calls after the test. Read-only Cloudflare schedule checks confirmed both schedule arrays were empty. No plan/subscription change was needed to create the tested resources.
- §6b:1414–1418: header enrichment needs a Claude subscription even for an API main head. The guide explicitly gives the alternative: omit `BRAIN_HEADER_ENRICH_CMD`. I did that; no header subagent symlink/login was needed. Placeholder transcript headers would be expected, but no transcript was produced to test them.
- §6c: skipped because there is no ChatGPT subscription and the `api` head does not require it.
- Optional push, mail, browser module, weather, calendar, voice and images were not enabled. No image/voice/generation request was made. The API workspace has no shell tools.

### Operator-only issues and normal startup timing

- One retry of Bun/npm was launched while the extra apt installation was still finishing; it again found missing tools. I waited for apt completion and retried successfully. This repeated failure was **my sequencing**, not a second guide defect.
- One memory deployment-result read occurred before its background command finished. I did not proceed on its partial output; after the completion notification I repeated the gate successfully. This was **my premature read**, not a deployment failure.
- §5:652–657: immediately after app restart, `systemctl is-active` returned `active` but the HTTP requests returned curl error 7 / `000`. After the guide's explicitly permitted few-second wait (3 seconds here), health/internal auth/login passed. **The guide already accounts for this race; no repair was necessary.**
- A supplemental SSH-from-the-VPS-to-itself attempt failed `Permission denied (publickey,password)` because the supplied key lives on the starting side. I did not copy a private key or change SSH access. The actual supplied external SSH connection produced `0` and `Linux`, as required. Self-SSH is not a documented requirement and is not a guide defect.
- A final evidence command initially used a relative Brain/logs path from `/root` and failed to find it. I repeated it with the absolute installation path: log file count **0**, no first-turn marker and no context state. This was an evidence-command correction, not an installation failure.

## 4. Check-block ledger — actual shortened output, with no secrets

The ledger covers every `Check:` block for the selected path and identifies excluded branches. Commands in unrun blocks were **not** executed with fake URLs, placeholder tokens, or nonexistent sessions merely to generate predictable errors.

### Executed blocks

| INSTALL.md Check location | Actual result / shortened output |
|---|---|
| §0, 56–68 | Initially `wrangler: command not found`, `bun: command not found`. After repair: Account API Token authenticated to intended account, `wrangler whoami exit=0`; `1.3.14`; `Python 3.13.5`; `git version 2.47.3`; `OpenSSL 3.5.7 ...`; external SSH `0`, `Linux`. |
| §1, 86–94 | Initially rev-parse exit 128 and diff exit 129 (unpacked source). After local metadata adaptation: `/opt/embervy`; `git diff --check` no output, exit 0. |
| §2, 183–193 | Secret list contains `RAG_AUTH_TOKEN`; unauthenticated `/list`: `401`; authenticated: `{"files":[]}`, `200`. |
| §3, 277–288 | Secrets: `APP_PUSH_TOKEN`, `EMBERVY_API_KEY`, `OPENROUTER_API_KEY`, `RAG_AUTH_TOKEN`; unauthenticated wake `401`; authenticated wake valid JSON-RPC result, `200`, no isError. |
| §3b, 346–356 — partial only | Three secret names: `DREAM_AUTH_TOKEN`, `OPENROUTER_API_KEY`, `RAG_AUTH_TOKEN`; unauthenticated `POST /dream`: `401`. Paid authenticated POST **not run**. Independent memory health GET succeeded with `dream_last_run:null`. Done-gate not passed. |
| §4, 406–417 | `2.1.302 (Claude Code)`; `1.3.14`; `/opt/embervy`; `/swapfile file 4G 0B -2`; memory total 3.7Gi, available 3.2Gi; root 38G total, 9.5G used, 27G available. logrotate debug: valid config, root globs absent/skipped, no syntax error. |
| §5, 538–550 | Unauthenticated internal endpoint: `401`; login: `HTTP/1.1 200 OK`, `set-cookie: embervy_session=[redacted]; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`. Browser chat-shell check unrun. |
| §5, 649–661 | `active`; first immediate curls error 7 / `000`; after 3 seconds: `{"ok":true}`, internal bearer `200`; repeated login `HTTP/1.1 200 OK` and redacted session cookie. Public login unrun. |
| §6, 679–693 | `inactive` four times, for embervy-loop, embervy-watchdog, embervy-brain, embervy-brain-watchdog. |
| §6b Memory and chronicle, 1432–1442 | All eleven comparison labels below `match`; `memory: authenticated 200`; `archive: authenticated 200`. Exit 0. |
| §9b preflight part, 1864–1873 (queued before First start) | `{"ok":true,...}`; head `api / qwen/qwen3.5-9b / api (environment)`; rag, rag-uploads, inbox, system-bus all ok; web-backend ok with explicit switched-off warning; `preflight exit=0`. Shared-doctor command in this block **not run**. |

Memory wake text, shortened from the real response:

```text
# Wake — Saturday, 17/10/2026, 08:57 (2026-10-17 08:57:19 UTC)
## Mood: initial
- memory bootstrapped
## Surfaces (0 shown)
## Edges — 0 tentative
## Open Todos — 0 open, 0 shown
## Unresolved Observations — 0 total, 0 shown
## Dream
## Daemon
- Last successful run: never
HTTP 200
```

Memory health after skipped dream generation, shortened:

```json
{"version":"0.3.0","hot_count":0,"archive_count":0,"unresolved_observations":0,"daemon_last_run":null,"daemon_last_ok":false,"dream_last_run":null,"warnings":["daemon never ran"]}
```

Token comparisons actually printed:

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

### Queued blocks not executed after the first-start stop

| Check location | Reason / output |
|---|---|
| §6b Identity, 1087–1097 | Requires a model read/reply; **not run, no output**. |
| §6b Notes, 1123–1132 | Requires a model file write/read and app reply; **not run, no output**. |
| §6b Loop service, 1171–1183 | Restarting an enabled Brain would start paid head work; **not run, no output**. |
| §6b Cut and watchdog, 1216–1233 | No Brain life/three substantive turns to cut; **not run, no output**. |
| §6b App channel, 1325–1336 | No running app MCP child owned by Brain and no head tool round trip; **not run, no output**. Static MCP JSON is not a pass. |
| §6b Inlet, 1369–1381 | No model/app question or inlet worker turn; **not run, no output**. |
| §6b First start, 1512–1523 | First start at 1495 was not authorized under no-spend; **not run, no output**. |
| §7 selection, 1600–1608 | Live service query is queued until a selected watchdog runs; **not run**. Final safety snapshot below is not its substitute. |
| §7b live watchdog, 1714–1728 | No running head/context/watchdog state; **not run, no output**. |
| §8 smoke test, 1773–1800 | No permitted model turns; **not run**, including probe upload, wake/write/find/recall prompt and controlled cut. |
| §9b shared doctor part, 1868 | Prescribed after Brain is running; **not run, no output**. |
| §9b finished-house sweep/token recheck, 1891–1926 | House not finished; **not run**. Earlier token gate did pass, but is not a substitute for final runtime validation. |
| §10 Brain reboot check, 1950–1964 | Required smoke/runtime gates not passed; **no reboot and no cold-start check**. |

### Other branches excluded by the guide itself

- §6a Check blocks at **716, 734, 783, 821, 890, 936, 978, 1006**: not run; Claude Code is not the selected harness.
- §6c Check at **1574**: not run; no ChatGPT subscription, using API head.
- §7a Check at **1642**, §9a Check at **1822**, and §10 Claude Code block **1942–1948**: not run; wrong harness.

## 5. Preserved state and evidence

Created only the following Cloudflare application resources, leaving them in place for inspection:

- Workers: `embervy-chronicle`, `embervy-memory`, `embervy-dream`.
- R2 buckets: `rag-storage`, `embervy-archive`.
- Vectorize indexes: `rag-vectors`, `embervy-vectors`.
- D1 databases: `rag-fts`, `embervy-memory`.
- Required worker secrets stored without printing values. No zones, domains, subscriptions or billing settings changed; no resources deleted.

Provider URLs:

- Archive: `https://embervy-chronicle.<account>.workers.dev`
- Memory: `https://embervy-memory.<account>.workers.dev`
- Dream: `https://embervy-dream.<account>.workers.dev`

Final safety state:

```text
embervy-app: active, enabled; /health -> {"ok":true}
embervy-brain: inactive, disabled
embervy-brain-watchdog: inactive, disabled
embervy-memory Cloudflare schedules: []
embervy-dream Cloudflare schedules: []
No /opt/embervy/Brain/state/first-turn-delivered
No /opt/embervy/Brain/state/brain_context.json
Files under /opt/embervy/Brain/logs: 0
```

The Brain units were enabled exactly during the guide's wiring, then explicitly disabled (only the units/symlinks created by this test) before stopping to prevent a future boot from making paid requests. Their definitions, complete profile and first-turn preparation remain on disk. Root/app/Brain env files and MCP config are mode 600. No commits or pushes were made.

Evidence files on the server (shortened outputs above come from these):

- `/root/blindtest-bootstrap.log`, `blindtest-bootstrap-extra.log`, `blindtest-tools.log`, `blindtest-tools-retry.log`: bootstrap commands/failures/repairs and tool versions.
- `/root/blindtest-step1.log`: initial and repeated Git gates, extra staged whitespace diagnostic.
- `/root/blindtest-prereq-rag-install.log`, `blindtest-rag-r2.log`, `blindtest-rag-vectorize.log`, `blindtest-rag-d1-create.log`, `blindtest-rag-deploy.log`, `blindtest-rag-check.log`: archive provisioning/auth checks.
- `/root/blindtest-memory-create.log`, `blindtest-memory-deploy.log`, `blindtest-memory-check.log`: memory provisioning/schema/auth/wake.
- `/root/blindtest-dream-deploy.log`, `blindtest-dream-check.log`: dream provisioning and partial checks, explicit paid-call skip.
- `/root/blindtest-vps.log`: documented VPS commands, Node warning, swap/disk/logrotate checks.
- `/root/blindtest-app-first-start.log`, `blindtest-app-initial-check.log`, `blindtest-app-systemd-check.log`: app startup and HTTP/session/service checks.
- `/root/blindtest-brain-token-check.log`, `blindtest-brain-preflight.log`: actual configuration done-gates.
- `/root/blindtest-stop-boundary.log`, `blindtest-final-evidence.log`: disabled Brain units, empty worker schedules, corrected absolute-path evidence.

## 6. Final acceptance and elapsed time

**Updated after the authorized second part, 2026-10-17T09:36:37.619782+00:00.** The earlier summary, step table and queued-check ledger describe the first part's historical stopping point; the continuation below supersedes their untested acceptance results.

- **Did the agent answer through the app channel? Yes, verified.** Authenticated `POST /api/message` inputs led to actual `mcp__app__reply` calls and matching assistant messages from authenticated `GET /api/messages`. The initial fresh-message answer was `hello from the Brain api head`; a separate exact `installation app-channel check`, post-restart and post-cut replies also worked. After a real host reboot the new life answered `reboot app channel OK` through the tool. Terminal prose, gateway fallback and fake textual tool calls are not counted. Public-domain/PWA rendering was not tested: there is no domain/zone, and the channel was exercised through the app's real local authenticated HTTP routes, not a rendered browser.
- **Did memory write and recall work? Yes, verified after a prompt retry.** Real `write` stored synthetic event **1**, `embedded=true`; real `find` returned that event and its `cobalt lantern memory check` text. Real agent `recall` returned **`InstallCheck_1.md#0`** and the exact `cobalt lantern recall check` probe, top score `0.9988126754760742`. A fresh app question also triggered automatic current-life inlet injection of that file. The original compound smoke prompt stopped after `wake`; its failure is retained below, not called a pass.
- **Did a controlled cut create an archive that could be found again? Yes, verified.** `brain-cutoff.sh` reported clean **`TERMINATED`**, **`bridge OK (14878 bytes)`**, no forced kill; `Session_2.md` was saved locally and uploaded. Actual `session_archive_upload` / `session_archived` events confirmed success; authenticated `/list` contained it. In the new life, real `recall("copper kite berth 47")` returned **`Session_2.md#4`**, score `0.9942740797996521`, including **“the copper kite rests at berth 47”**; the agent sent that source and fact through the app. This is not merely a bridge or list-only check.
- **Did the reboot check pass? Yes for the available local deployment.** The boot ID changed; app, Brain and Brain watchdog returned automatically, with no manual service start. Health was `{"ok":true}`, a new live API/Qwen life existed, its app tool reply worked, the external watchdog timestamp advanced after 65 seconds, the other harness stayed inactive, local time remained UTC, and the 4 GiB swap survived. Public-hostname access remains skipped by scope.
- **Did a dream get written? Not verified.** No authenticated generation was requested. Memory/dream cron schedules remain empty as expressly allowed; daemon/dream report never run. The shared doctor calls this “not due yet”, which is not evidence that generation works.

**Important qualifications:** this was not an untouched copy-and-paste success. The first-part bootstrap/profile omissions remain; the Notes check required relative write paths; Qwen needed retries and still sometimes emitted duplicate replies, empty finals or fake tool markup. The watchdog UI's hardcoded “1M” display is wrong for this 262,144-token head, although actual thresholds are correct. Shared doctor returned exit 0 with **17 passed / 0 warn / 0 fail / 5 skipped**; four retrieval/inlet skips due to unenriched placeholder headers were independently covered by real agent/inlet tests, not silently counted as doctor passes.

**Run started:** 2026-10-17T08:52:33+00:00  
**First-part report finalized:** 2026-10-17T09:06:58.561920+00:00 — 14 minutes 25 seconds (865 seconds)  
**Second part resumed:** 2026-10-17T09:08:50.238338+00:00  
**Final report finalized:** 2026-10-17T09:36:37.619782+00:00  
**Second-part elapsed:** 27 minutes 47 seconds (1667 seconds)  
**Combined measured work intervals:** 42 minutes 12 seconds (2532 seconds)  
**Whole wall-clock elapsed, including the clarification gap:** 44 minutes 4 seconds (2644 seconds); gap 1 minutes 51 seconds (111 seconds). These are elapsed intervals including reading, waits, installation/tests and report writing, not CPU time.

**OpenRouter usage-delta cost:** **US $0.08559416**, below US $1 for the whole run (first part made no model calls). Read-only key usage was `<key total>` before and `<key total>` at final verification; the supplied key's pre-existing usage is not charged to this test. All calls made with the supplied key, including helpers, are covered by this delta; if the same key were used concurrently elsewhere the delta would conservatively include that too. No Cloudflare purchase, domain registration, plan/subscription change or billing-setting change was made.

# Second part: from First start on

## S1. Authorization, method and resulting state

The user clarified that small OpenRouter calls are expected and authorized below US $1 total, and that the no-spend restriction concerns Cloudflare purchases/plans/domains/billing. Resumed at original **INSTALL.md §6b First start, line 1495**, using the same `/opt/embervy` installation and **API head / `qwen/qwen3.5-9b` / 262144-token context**. No subscription head, alternative model, paid Cloudflare plan or custom hostname was substituted.

Only the Brain/watchdog units that had been disabled for the earlier safety interpretation were re-enabled. Brain was started and the documented bound watchdog followed. Memory/dream `crons=[]` were left empty by explicit permission. The house documents' obsolete no-model-call restriction was replaced with the clarified budget allowance. The notebook write allowlist remained `notes`, read jail remained `/opt/embervy`, shell tools stayed off, and neither write permissions nor retrieval thresholds were broadened. Runtime source code was not patched.

All intentional work stayed on `root@<test-server>` and the authorized Cloudflare account; nothing was installed or intentionally changed on the starting machine. There were no deletions of other people's resources. Existing workers/resources were reused; no new purchase, plan, subscription, domain or billing setting was needed.

**App-channel method:** a private remote Python client logs in through `POST /api/auth`, retains its session cookie only in process, and sends input through authenticated `POST /api/message`, the actual UI chat-input route. Replies are verified against real conversation tool results and authenticated `GET /api/messages` outbox entries. It does not write the inbox directly or use internal broadcast to simulate a successful tool reply. No cookie, password or bearer value is included here. Authenticated `/` returned HTTP 200, 13,495 bytes, no login form and chat markup; that is an HTTP-shell check, not a rendered-browser/PWA check. With no domain/zone, the public-hostname parts of §§5/10 remain skipped; no tunnel/domain was created as a workaround.

**Cost control:** a read-only OpenRouter key-usage baseline and 20-second remote guard used a conservative US $0.80 delta stop threshold, failing closed after three accounting errors. No key limit or account setting was changed. The SSH guard ended with exit 255 on the deliberate reboot (expected), and was restarted after reconnect using the **same original baseline**, not a new budget. The temporary monitor is stopped at sign-off; Brain/app/watchdog remain enabled and active, idle, with the paid background cron schedules still empty.

## S2. Step / result table

Only `ok`, `fixed by me`, `failed`, and `skipped` are result labels. A successful retry does not erase the failed original attempt.

| Original guide step/check | Result | Actual outcome |
|---|---|---|
| §6b First start, 1495–1523 | ok | Three selected units active; API/Qwen correct; live process; growing token count; genuine first greeting and app reply. |
| §6b identity, Check 1087 | ok | Actual EMBERVY.md read; nine headings/tools and supplied local UTC clock quoted in an app tool reply. |
| §6b Notes, Check 1123 | fixed by me | Absolute write argument rejected by relative `notes` allowlist. Explicit relative-path prompts allowed real writes/reads. Later model formatting/link mistakes were corrected through the agent and read back. |
| §6b loop restart, Check 1171 | ok | Immediate snapshot was stale and tmux briefly absent; after initialization new PID/life, app round trip, bridge and catch-up `Session_1.md` upload confirmed. No service wiring change. |
| §6b app wiring, Check 1325 | fixed by me | Correct absolute stdio MCP process was live. Exact app phrase needed a narrower retry and real reply-tool call. |
| §6b inlet, Check 1369 | ok | Original grep/log commands run; a fresh app question caused current-life inlet injection of `InstallCheck_1.md`, plus actual recall and app reply. |
| §6b token comparisons, Check 1432 | ok | All 11 comparison groups match; memory/archive authenticated 200. |
| §7 branch selection, Check 1600 | ok | Chosen Brain loop/watchdog active; other harness stopped. |
| §7b advancing state, Check 1714 | ok | External timestamp advanced across each 65-second wait; correct life and cut threshold. Repeated while idle and after reboot. |
| App watchdog status display, §§6b/7b | failed | UI says “of 1M” and computes threshold percentages against 1M for a 262144-token head. Actual context/safety thresholds remain correct. No misleading display is counted as correct. |
| §8 literal smoke/probe, Check 1773 | failed | Probe uploaded successfully, but literal compound tmux prompt performed only `wake`, then ended empty: no write/find/recall/app reply in that attempt. |
| §8 smoke via explicit real app retries, 1745–1758, 1781–1800 | fixed by me | Actual write event 1, find event 1, archive recall of exact probe, actual reply tool/outbox; separate fresh app question and automatic inlet confirmed. |
| §6b controlled cut, Check 1216, after smoke | ok | Minimum substantive turns completed, agent idle; clean TERMINATED/bridge OK, `Session_2.md` upload, new life and app reply; actual agent recall from that transcript. |
| §9b preflight/shared doctor, Check 1864 | ok | Both exits 0. Shared: 17 pass, 0 warn, 0 fail, 5 skip; explicitly understood limitations below. Repeated after reboot. |
| Finished-house sweep, Check 1891 | ok | Literal placeholder sweep clean/exit 0; token checks match and both workers authenticated 200. |
| §10 real reboot, 1935; Brain Check 1953–1955 | ok | Boot ID changed, automatic services recovered, new live Qwen/API life, health/app reply/local clock/advancing watchdog/swap pass. No manual service start after boot. |
| §10 public app hostname / rendered browser | skipped | No domain/zone or authorized public-hostname setup; real local authenticated app channel tested instead. |
| Automatic memory/dream cron and authenticated dream generation | skipped | Cron schedules intentionally empty; no generation check was retroactively claimed. |

## S3. Problems, exact original locations, errors and guide changes

### P8. Relative allowlist plus absolute Notes prompt causes a real API write denial

**Original INSTALL.md:** §6b Notes Check **1123–1132**, especially the absolute `/opt/embervy/notes/NOTES.md` prompt at **1126**; API profile/filesystem setup **1043–1085**. This confirms and extends first-part P5 with a live failure.

**Actual command/tool error:** the literal Notes prompt was sent through tmux. The agent tried `write_file` with `/opt/embervy/notes/01-installation-check.md` and received:

```text
error: '/opt/embervy/notes/01-installation-check.md' is not on the write allowlist
```

A subsequent wrong read of `/workspace-write-allowlist.txt` was outside the read jail. The real allowlist contained `notes`, intentionally permitting that subtree only. The implementation compares the supplied write argument to those entries; an absolute path inside the read jail is not normalized into a matching relative allowlist path. Verified at installed `Brain/brain.ts:1069–1073` and `912–919`; `Brain/resident-tools.ts:81–87` allows in-jail absolute resolution but does not repair the allowlist comparison.

**What I changed:** no jail/allowlist expansion. I sent explicit app retries using `notes/01-installation-check.md` and `notes/NOTES.md`. Real write/read tools succeeded and the app quoted `cobalt notebook check`. The small model initially copied trailing instructions into note text and wrote an index link `notes/01-installation-check.md` relative to `notes/NOTES.md`, which resolves incorrectly. A later explicit formatting retry wrote clean note content and `[Installation check](01-installation-check.md)`; a final actual `read_file` of the index and real app reply completed the check. A local existence check confirmed the relative target exists. During that formatting retry, the model's textual fake index-read markup/fallback was explicitly rejected as proof, not counted as a real read/reply.

**Suggested correction:** include an API filesystem profile and allowlist syntax in §6b, and make its Notes prompt say: “For API `write_file`/`edit_file`, use workspace-relative paths `notes/...` when the allowlist contains `notes`. Read back both files and verify the index link resolves relative to the index file.” Provide short, clearly delimited synthetic note content; do not suggest broadening the write jail to cure this error.

### P9. Watchdog app display hardcodes a one-million-token denominator

**Original INSTALL.md:** §6b profile/watchdog file at **1065**, per-head thresholds **1195–1206**; §7b app-compatible watchdog state **1704–1709**. Those instructions wire this API head into the app's display but do not warn that its denominator is hardcoded.

**Actual app MCP `watchdog_status` output:**

```text
Watchdog alive ... pid 10841
Context: 9,144 tokens (3% of 1M)
Thresholds: WARN at 209,715 (21%), CUT at 235,929 (24%)
```

The real profile/model window is **262144**; actual WARN **209715** and CUT **235929** are approximately **80% / 90%** of that window. They are not 21% / 24% safety thresholds. The displayed context percentage also uses the cut denominator upstream rather than consistently representing model-window percentage.

**Verified source:** `Claude/app/mcp.ts:460` prints literal `of 1M`; `:461` divides thresholds by 10000. `Claude/app/server.ts:1272–1277` has the same threshold display issue. `Brain/brain.ts:2348–2355` derives the compatibility percentage from cut tokens, while `:2311–2315` writes the correct window into `brain_context.json`; `Brain/heads.ts:158–164,217–231` derives the actual API thresholds.

**Workaround:** use `Brain/state/brain_context.json` for the real window/thresholds and corroborate external live state. I did not change safety thresholds or point the app at the external watchdog's different JSON schema. No source fix was applied.

**Suggested correction:** render percentages against the actual model window, carry that window in the compatibility state, and remove the literal 1M label. Until fixed, explicitly warn API installers at the cited guide locations not to use this UI's percentages as proof of configured safety limits.

### P10. The specified small Qwen model does not reliably complete the guide's compound tool checks

**Original INSTALL.md:** first greeting/app checks **1501–1507**, Notes **1126–1130**, exact app reply **1328–1336**, compound smoke **1777–1786**, and reboot greeting/reply **1938–1962**. This is observed behavior with the requested model, **not proof of a general Brain transport defect**.

**Actual failures:** repeated successful reply calls instead of terminating, stale bridge/inlet instructions displacing the new request, a 12-model-request tool-hop limit, textual `<tool_call>...` output without structured tool execution, and an empty final. In particular, the exact smoke prompt at **1777** produced a real `wake` at `09:15:58.830Z`, then `characters:0` at `09:16:01.581Z`, with no write/find/recall/reply in that turn. The later notebook-format turn emitted fake read markup and `reply_gateway_sent`; the boot greeting also contained duplicate real replies followed by fake reply markup. Those are recorded failures, not successful tool checks.

**What I changed:** kept the head/model fixed. Added a rule to my test identity: after one successful actual `mcp__app__reply`, finish the turn with plain final `Done`, without repeating completed checks. Sent narrow app retries with explicit tool names/arguments, relative paths and clear completion conditions; waited for actual turn completion before further lifecycle actions. A separate explicit smoke retry genuinely wrote/found event 1 and recalled the probe; a fresh app question genuinely woke/recalled it again. The rule improved completion but did **not** cure every malformed or duplicate response.

**Suggested correction:** describe transport/tool prerequisites separately from model-following reliability, include short per-tool fallback probes and an explicit one-reply termination instruction, and require inspection of actual tool results/outbox messages as §8 already correctly says. Do not mark a model's textual claim, fallback broadcast or plausible XML-like markup as a pass. If listing this model as a low-cost path, state the observed need for prompt retries rather than promising hands-free compound checks.

### Observations and limitations, not additional proven guide defects

- **Restart snapshot race (1174–1176):** `systemctl restart` returned active while `brain_context.json` still named the old process; immediate tmux capture said `no server running on /tmp/tmux-0/default`. Four seconds later the new PID/life and all services existed. The guide calls for waiting for initialization; I repeated state/pane checks, without changing units or hiding boot recovery. `Session_1.md` was ultimately uploaded by the next life's catch-up path (`uploaded:true`). I do not claim its interrupted old-process upload succeeded synchronously.
- **`/status` was delayed, not broken (1501–1507,1749):** its actual built-in app response appeared at `09:10:30.504Z`, reporting API/Qwen, `14037/262144`, WARN 209715, CUT 235929 and queue 2 / busy true. Earlier apparent failure was queued work, not a missing route.
- **Doctor retrieval blind spot (no-subscription option 1414–1418; §9b 1875–1878):** exported sessions had valid transcripts but unenriched `THEMES=placeholder` headers because no subscribed enrichment CLI was configured. Doctor skipped hybrid/FTS/reranker/inlet probes with `no readable session header with usable THEMES — no question to probe`. This is five skips including the intentionally irrelevant Claude canary, despite nonempty archive (3 files before reboot, 4 after). No usable THEMES was fabricated to turn it green. Real probe recall, current-life inlet and post-cut transcript recall independently prove those exercised paths; doctor PASS alone would not. The guide could explicitly mention unenriched-header skips alongside empty/young archive skips.
- **Operator-only sequencing/helper problems:** early prompts were queued after an app reply but before the model's repeated-call turn finished. A first wait helper also missed empty final events and waited 180 seconds unnecessarily; another early post-restart read selected the old conversation before the new file existed. I corrected the helper to select the actual expected user turn/current session and recognize final events, including empty ones. These delays are included in elapsed time and are not INSTALL defects. No model-output hallucination was used as evidence.

## S4. Check-output ledger (actual, shortened, secrets omitted)

Original command references below use `/root/embervy-src/INSTALL.md`, not a modified installed guide. Original README/INSTALL hashes remain those recorded in the first part. Detailed sanitized output is retained in `/root/blindtest-second-*.log`. Output excerpts may omit repetitive text/hits but retain failures and exit codes.

### S4.1 — queued identity check

**Original Check:** §6b:1087.

```bash
tmux send-keys -t brain -l 'Read /opt/embervy/EMBERVY.md. Name its load-bearing headings and the configured memory and archive tools. Quote the first supplied clock line and reply through the app reply tool.'
tmux send-keys -t brain Enter
```

**Actual output / observation:**

```text
read_file /opt/embervy/EMBERVY.md: actual content returned
mcp__app__reply: names Who I am; How I think; What I write down;
  Initiative; How I write; Tools I use; What I am not; What stays put; Infrastructure.
Configured memory/archive tools identified (API bare wake/write/find/recall).
Quoted supplied clock: ⏰ UTC: Saturday, 17.10.2026, 09:08
Actual configured local zone and comparison date: UTC, 2026-10-17.
```

**Evidence:** `blindtest-second-identity-check.log`, `blindtest-second-notes-retry-results.log`.

### S4.2 — queued Notes check

**Original Check:** §6b:1123.

```bash
tmux send-keys -t brain -l 'Use /opt/embervy/notes/NOTES.md to save and index a short installation notebook check note, then read the note back. Reply through the app reply tool. Do not put this note in the Lore.'
tmux send-keys -t brain Enter
```

**Actual output / observation:**

```text
Initial write_file /opt/embervy/notes/01-installation-check.md:
  error: '/opt/embervy/notes/01-installation-check.md' is not on the write allowlist
Initial wrong read /workspace-write-allowlist.txt: outside read jail
Retry write_file notes/01-installation-check.md: wrote notes/01-installation-check.md
Retry write_file notes/NOTES.md: wrote notes/NOTES.md
read_file of both: real content returned; real app reply quoted cobalt notebook check
09:12:57.789Z actual app tool reply; 09:13:00.227Z final Done
Initial index target notes/01-installation-check.md relative to notes/NOTES.md: wrong
09:27:06.643Z wrote clean notes/01-installation-check.md
09:27:09.213Z wrote corrected notes/NOTES.md
09:27:17.252Z real note read: clean frontmatter and synthetic probe sentence
09:27:27.268Z fake textual index read, no real tool; gateway fallback NOT accepted
On disk: [Installation check](01-installation-check.md), target exists=True
09:29:02.653Z real index read returned that exact relative link
09:29:09.521Z real app reply quoted link and cobalt notebook check; final Done
No Lore write for this notebook test.
```

**Evidence:** `blindtest-second-notes-check.log`, `blindtest-second-notes-retry-results.log`, `blindtest-second-notebook-final-and-preboot.log`, `blindtest-second-notebook-index-readback.log`.

### S4.3 — queued loop-service restart

**Original Check:** §6b:1171.

```bash
systemctl restart embervy-brain && systemctl is-active embervy-brain
jq '{pid,session_id,head,model,transport,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/Brain/state/brain_context.json"
tmux capture-pane -p -t brain -S -80
```

**Actual output / observation:**

```text
systemctl restart embervy-brain; is-active: active
Immediate context: old pid 10841/session 1792228131405-3owko0
Immediate tmux: no server running on /tmp/tmux-0/default
After 4 seconds: app active; Brain active; Brain watchdog active
New pid 11909; session 1792228460754-zvmqlo; api / qwen/qwen3.5-9b
Old-life shutdown SIGTERM; bridge_written, 7 user turns
09:14:25.014Z catch_up_archived Session_1, uploaded:true
/list: Session_1.md, size 10675, uploaded 2026-10-17T09:14:21.702Z
First new app request was displaced by stale instructions; narrow retry:
09:15:23.797Z real reply: Sent: restart app channel OK
09:15:30.038Z final Done
```

**Evidence:** `blindtest-second-loop-restart-check.log`, `blindtest-second-loop-restart-followup.log`, `blindtest-second-smoke-check.log`.

### S4.4 — queued app-channel wiring

**Original Check:** §6b:1325.

```bash
jq -r '.mcpServers.app | [.command, (.args | join(" "))] | join(" ")' "$EMBERVY_HOME/.mcp.json"
pgrep -af '^(/[^ ]*/)?bun (run )?/opt/embervy/Claude/app/mcp[.]ts([[:space:]]|$)'
tmux send-keys -t brain -l 'Reply with installation app-channel check through mcp__app__reply, not terminal prose.'; tmux send-keys -t brain Enter
```

**Actual output / observation:**

```text
Configured app MCP command: bun run /opt/embervy/Claude/app/mcp.ts
pgrep: pid 10850, bun run /opt/embervy/Claude/app/mcp.ts
Earlier reply had extra/cased words; exact narrow retry:
09:13:52.200Z mcp__app__reply result: Sent: installation app-channel check
Matching app outbox: assistant reply, id b519ab62-6769-4271-836c-c150c93a9f2e
09:14:03.860Z final Done
Actual input POST /api/message and output GET /api/messages, not internal broadcast.
```

**Evidence:** `blindtest-second-notes-check.log`, `blindtest-second-notes-and-app-complete.log`.

### S4.5 — queued automatic inlet

**Original Check:** §6b:1369.

```bash
grep -hE '"type":"inlet_(injected|worker_empty|worker_failed)"' "$EMBERVY_HOME"/Brain/logs/session-*.jsonl | tail -n 5
tail -n 30 "$EMBERVY_HOME/Brain/logs/inlet-worker.log"
```

**Actual output / observation:**

```text
Fresh app input id 9f811803-f050-414f-9b85-3841613afd5f
Current life 1792228460754-zvmqlo, 09:20:51.064Z:
inlet_injected via worker, characters 1318
[InstallCheck_1.md] (100% [vector+bm25+rerank])
# Installation recall probe
... The probe phrase is cobalt lantern recall check. It is test data, not an experience.
Actual wake 09:20:58 UTC; recall top InstallCheck_1.md#0 (1.00)
09:21:11.748Z real app reply: filename InstallCheck_1.md;
  exact probe phrase cobalt lantern recall check
09:21:14.268Z final Done
inlet-worker.log also retains earlier empty-archive diagnostics:
[inlet/rag] confidence gate suppressed all hits; turnFloor=0.25 topScore=none ...
Those earlier empty results were before content existed, not fresh errors.
The current-life injected event with actual probe text is the positive evidence.
No relevance thresholds were lowered; labelled probe retained.
```

**Evidence:** `blindtest-second-inlet-check.log`.

### S4.6 — queued token/URL comparisons

**Original Check:** §6b:1432.

```bash
bun "$EMBERVY_HOME/state/install-token-check.ts"
```

**Actual output / observation:**

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

**Evidence:** `blindtest-second-notes-retry-results.log`; repeated in `blindtest-second-postcut-doctors-sweep.log`.

### S4.7 — First start

**Original Check:** §6b:1512.

```bash
systemctl is-active embervy-app embervy-brain embervy-brain-watchdog
jq '{pid,session_id,head,model,transport,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/Brain/state/brain_context.json"
bash "$EMBERVY_HOME/Brain/scripts/brain-watchdog.sh" --check-alive "$(jq -r .pid "$EMBERVY_HOME/Brain/state/brain_context.json")"
```

**Actual output / observation:**

```text
active
active
active
pid 10841; session_id 1792228131405-3owko0
head api; model qwen/qwen3.5-9b; transport api
context window 262144; warn_tokens 209715; cut_tokens 235929
liveness check: 1
Observed tokens 9325 -> 18343 after successful turns
09:09:05.642Z actual first greeting through mcp__app__reply
09:09:38.309Z fresh app input answered: Sent: hello from the Brain api head
Matching assistant outbox id 4604d2d5-584a-4506-a5d8-b093f70b83f5
/status actual built-in reply at 09:10:30.504Z:
  api/qwen/qwen3.5-9b; 14037/262144; WARN 209715; CUT 235929;
  queue 2; busy true (delayed behind ongoing work, not broken routing)
```

**Evidence:** `blindtest-second-firststart.log`, `blindtest-second-app-first-message.log`, `blindtest-second-firststart-check.log`, `blindtest-second-notes-retry-results.log`.

### S4.8 — branch selection and external watchdog

**Original Check:** §7:1600 and §7b:1714.

**Actual output / observation:**

```text
Chosen Brain loop/watchdog: active / active; other harness inactive
65-second check, first life:
last_check_ts 2026-10-17T09:10:51.546311+00:00, tokens 14296
last_check_ts 2026-10-17T09:11:51.704420+00:00, tokens 17264
session_id 1792228131405-3owko0; cut_tokens 235929; watchdog pid 10783
This first interval included queued model work; repeated at idle later.
Idle pre-reboot interval:
2026-10-17T09:27:22.948411+00:00 -> 2026-10-17T09:28:23.175477+00:00
session_id 1792229109419-pu4u2z; cut_tokens 235929; watchdog pid 11846
Both units active. External pid is the watchdog PID, not the agent PID.
Post-reboot advancing check is also recorded under S4.12.
```

**Evidence:** `blindtest-second-watchdog-check.log`, `blindtest-second-notes-retry.log`, `blindtest-second-notebook-final-and-preboot.log`.

**Original commands at INSTALL.md:1603–1603:**

```bash
systemctl is-active embervy-watchdog
```

**Original commands at INSTALL.md:1717–1719:**

```bash
systemctl is-active embervy-brain embervy-brain-watchdog
jq '{last_check_ts,session_id,tokens,cut_tokens,pid}' "$EMBERVY_HOME/Brain/state/watchdog_state.json"
sleep 65; jq '{last_check_ts,session_id,tokens,cut_tokens,pid}' "$EMBERVY_HOME/Brain/state/watchdog_state.json"
```

### S4.9 — smoke, memory and explicit archive recall

**Original Check:** §8:1773; app requirements 1745–1758, 1781–1800.

```bash
curl -fsS -X POST "$RAG_URL/upload" -H "Authorization: Bearer $RAG_AUTH_TOKEN" -F "file=@$EMBERVY_HOME/state/install-recall-probe.md;filename=InstallCheck_1.md"
tmux send-keys -t "$CHECK_SESSION" -l 'Call the memory wake tool. Write a synthetic installation observation containing cobalt lantern memory check and read it back with find, reporting its event id. Then call the memory recall tool with query cobalt lantern recall check and report the source filename and returned text. Reply through mcp__app__reply. This is installation test data, not an experience.'
tmux send-keys -t "$CHECK_SESSION" Enter
```

**Actual output / observation:**

```text
Exact probe upload:
{"success":true,"filename":"InstallCheck_1.md","chunks":1,"edges":0}
Literal tmux compound prompt:
09:15:58.830Z real wake result, current UTC clock
09:16:01.581Z assistant final characters:0
NO write/find/recall/app reply in that original attempt: FAILED

Explicit retry from the actual app (input 370599ea-baa3-4f46-b1a6-eddf6ce6bbf3):
09:19:55.978Z write:
Wrote event 1 (kind=observation, weight=light, embedded=1)
{"event_id":1,"kind":"observation","embedded":true}
09:20:05.265Z find:
Found 1 event, id 1, content:
Synthetic installation observation: cobalt lantern memory check. This is test data, not an experience.
source external; certainty known; embedded 1; _final_score 0.49999690504705674
09:20:09.519Z recall:
RAG recall: 10 hits
[1] InstallCheck_1.md#0, score 0.9988126754760742
# Installation recall probe
This synthetic installation check verifies hybrid archive search and recall.
The probe phrase is cobalt lantern recall check. It is test data, not an experience.
09:20:18.622Z real mcp__app__reply reported event1/find/top filename and actual probe text
Matching assistant outbox id 795c6d14-3cd3-429a-90f3-8a3ff3c3e056
09:20:22.339Z final Done
Separate fresh app input in S4.5 genuinely called wake/recall and received a tool reply.
No weak-hit scores were presented as guaranteed relevance; correct top source/text verified.
```

**Evidence:** `blindtest-second-smoke-check.log`, `blindtest-second-smoke-app-retry.log`, `blindtest-second-inlet-check.log`.

### S4.10 — controlled cut and recall of completed life

**Original Check:** §6b:1216, executed after §§7b/8.

```bash
bash "$EMBERVY_HOME/Brain/scripts/brain-watchdog.sh" --decide "$EMBERVY_HOME/Brain/state/brain_context.json" && bash "$EMBERVY_HOME/Brain/scripts/brain-watchdog.sh" --check-alive "$(jq -r .pid "$EMBERVY_HOME/Brain/state/brain_context.json")"
bash "$EMBERVY_HOME/Brain/scripts/brain-cutoff.sh" && tmux capture-pane -p -t brain -S -80
( . "$EMBERVY_HOME/Brain/scripts/brain-env.sh"; curl -fsS -H "Authorization: Bearer $BRAIN_RAG_AUTH_TOKEN" "$BRAIN_RAG_URL/list" )
```

**Actual output / observation:**

```text
Agent idle; cut-life session 1792228460754-zvmqlo, pid 11909, tokens 26065
At least six user turns in this life, including successful smoke and fresh app checks.
09:21:28.161Z real app reply acknowledged unique synthetic cut-life fact:
  the copper kite rests at berth 47
It was not written to Lore/notes; its new transcript is the archive test source.
watchdog decide:
none 26065 11 235929 11909 1792228460754-zvmqlo below thresholds
check-alive: 1; combined exit=0
=== brain-cutoff start 2026-10-17T09:25:04+00:00 ===
[1/3] SIGTERM -> Brain archives itself (bridge + RAG export)
[2/3] waiting up to 180s for a clean exit
[3/3] clean exit
  bridge OK (14878 bytes)
  respawn delegated to brain-loop.sh
=== brain-cutoff done 2026-10-17T09:25:07+00:00 (TERMINATED) ===
cut-and-capture exit=0; pane showed completed turns, no forced kill
/list files:
InstallCheck_1.md size191
Session_1.md size10675
Session_2.md size4095 uploaded 2026-10-17T09:25:04.866Z
Actual old-life events:
09:25:04.248Z bridge_written
09:25:06.907Z session_archive_upload name Session_2 ok:true parts:1
09:25:06.908Z session_archived uploaded:true reason SIGTERM
  local_path /opt/embervy/Brain/logs/sessions/Session_2.md
New pid12593; session1792229109419-pu4u2z; all3 units active
09:25:18.281Z bridge_loaded
New authenticated app input 25631870-b23e-4b36-9dc1-66ce61ef530d
09:25:47.571Z actual recall({"query":"copper kite berth 47"})
09:25:48.982Z top result Session_2.md#4, score 0.9942740797996521
Actual returned text includes: the copper kite rests at berth 47
09:25:56.759Z actual app reply names Session_2.md#4 and quotes that fact
Matching app outbox id9d1ba0cf-b6d7-4742-8960-8fc084d64e21; final Done09:26:00.054Z
Local bridge, local transcript, remote list, upload event AND agent recall all checked.
```

**Evidence:** `blindtest-second-controlled-cut.log`, `blindtest-second-postcut-doctors-sweep.log`.

### S4.11 — Brain preflight, shared doctor and finished house

**Original Check:** §9b:1864 and finished-house Check1891.

```bash
(cd "$EMBERVY_HOME/Brain" && bun scripts/brain-doctor.ts); printf 'preflight exit=%s\n' "$?"
(cd "$EMBERVY_HOME" && bun shared/tools/embervy-doctor.ts); printf 'doctor exit=%s\n' "$?"
python3 - <<'PY'
import os, pathlib, re, sys
home = pathlib.Path(os.environ['EMBERVY_HOME'])
files = [home / p for p in ('.env', 'Claude/app/.env', 'Brain/brain.env',
    '.mcp.json', 'CLAUDE.md', 'EMBERVY.md', 'INFRASTRUCTURE.md',
    'HANDBOOK.md', 'HOUSE.md')]
files += list((home / '.claude').glob('*.json'))
files += list((pathlib.Path.home() / '.claude').glob('*.json'))
files += [p for p in (home / 'shared').rglob('wrangler.toml')
    if 'node_modules' not in p.parts]
files += list(pathlib.Path('/etc/systemd/system').glob('embervy-*.service'))
pattern = re.compile(r'YOUR[-_]|example\.(?:com|invalid)|CHANGE_ME|<[^>\n]+>|/path/to/', re.I)
found = 0
for path in dict.fromkeys(files):
    if not path.is_file():
        continue
    for number, line in enumerate(path.read_text().splitlines(), 1):
        if path.suffix != '.md' and line.lstrip().startswith(('#', ';')):
            continue
        if pattern.search(line):
            print(f'{path}:{number}: review template marker')
            found += 1
print('placeholder sweep: ' + ('review required' if found else 'clean'))
sys.exit(1 if found else 0)
PY
bun "$EMBERVY_HOME/state/install-token-check.ts"
```

**Actual output / observation:**

```text
Brain preflight (also run before First start):
{"ok":true,"checks":[head ok, rag ok, rag-uploads ok, inbox ok, system-bus ok,
  web-backend ok: warning text says search/fetch intentionally switched off]}
preflight exit=0; no RAG uploads owed

Shared doctor before reboot:
Memory and archive reachable; bearers valid; archive3files
Unauth memory401; unauth archive401
Daemon never / dream never: not due yet (not a successful generation test)
SKIP Hybrid search: no readable session header with usable THEMES — no question to probe
SKIP FTS5 (BM25) ready: same reason
SKIP Reranker active: same reason
SKIP Inlet returns context: same reason
SKIP Claude headless canary: active substrate is brain
House MCP2/2 configured (static only)
EMBERVY.md45lines; single system prompt; Brain inlet wired; notebook and index present
State writable; disk27%used,26.2GBfree; swap4.0GB; no dangerous defaults
Result: PASS (17 checks passed, 0 warn, 0 fail, 5 skip)
doctor exit=0

Literal Python finished-house scan:
placeholder sweep: clean
placeholder sweep exit=0
Final token check:
all11 groups: match; memory authenticated200; archive authenticated200
token check exit=0

Repeated after reboot at09:33:03UTC:
preflight ok:true, exit0; no uploads owed
Shared doctor archive4files; same17pass/0warn/0fail/5skip; exit0
No FAIL was bypassed. No skipped retrieval or static MCP check is claimed as a live pass.
```

**Evidence:** `blindtest-second-preflight.log`, `blindtest-second-postcut-doctors-sweep.log`, `blindtest-second-report-preparation.log`.

### S4.12 — real reboot and fresh app/watchdog verification

**Original Check:** §10:1935, Brain block1953–1955; follow-through1958–1964.

```bash
systemctl is-active embervy-app embervy-brain embervy-brain-watchdog
curl -fsS http://127.0.0.1:3030/health
jq '{pid,session_id,head,model,transport,tokens,warn_tokens,cut_tokens}' "$EMBERVY_HOME/Brain/state/brain_context.json"
```

**Actual output / observation:**

```text
2026-10-17T09:29:17+00:00: reboot executed
Old boot_id a746c354-5b19-4f5d-b4de-cc20aa841f8f
New boot_id 27b93312-447e-4eb6-ae21-b58b24ab3265; changed:true
Reconnected09:29:52UTC; no service-start command issued
active
active
active
{"ok":true}
{"pid":1005,"session_id":"1792229385944-zuycie","head":"api",
 "model":"qwen/qwen3.5-9b","transport":"api","tokens":0,
 "warn_tokens":209715,"cut_tokens":235929}
Agent kill-0 exit0; tmux worker runtime ready
Boot journal09:29:44: app,Brain,Brain-watchdog started automatically
09:29:45: app HTTP server127.0.0.1:3030
Other harness: embervy-loop inactive; embervy-watchdog inactive
/swapfile file4G used0B
Waited for this life's actual greeting; real reply tool at09:30:27.033Z and09:30:36.378Z
Model also emitted duplicate/fake markup afterward; that extra output is NOT accepted as a tool call
Fresh authenticated inputd65806a8-83f8-42e5-bcca-e81b3ac9f784:
09:31:33.151Z actual mcp__app__reply:
Sent: reboot app channel OK. First clock line: ⏰ UTC: Saturday, 17.10.2026, 09:29.
Matching outbox7998c437-1ce9-4c10-81df-9d91cf4c10bd; final Done09:31:35.244Z
Timezone=Etc/UTC; NTPSynchronized=yes; comparison2026-10-17 09:31:35 UTC
65-second external-watchdog repeat:
last_check_ts2026-10-17T09:30:45.720340+00:00
 ->2026-10-17T09:31:45.873728+00:00
session1792229385944-zuycie; cut235929; watchdog pid883
Final units active/active/active; other harness inactive/inactive
Public hostname portion skipped: no domain/zone; real local authenticated app route passed.
```

**Evidence:** `blindtest-second-reboot-check.log`, `blindtest-second-postreboot-app-watchdog.log`.

## S5. Final cost, time, evidence and remaining limitations

- Final OpenRouter delta: **US $0.08559416**, measured at **2026-10-17T09:36:37.619782+00:00**, from the original baseline. The read-only accounting snapshot is `/root/blindtest-second-final-budget.json`; the guard history is `/root/blindtest-second-budget.log`. The US $1 ceiling was not reached.
- Second part: **27 minutes 47 seconds (1667 seconds)**. Combined measured work intervals: **42 minutes 12 seconds (2532 seconds)**. Whole wall-clock from original start: **44 minutes 4 seconds (2644 seconds)**, including the **1 minutes 51 seconds (111 seconds)** clarification gap. See updated §6 for exact timestamps.
- Current agent: PID **1005**, session **`1792229385944-zuycie`**, head **`api`**, model **`qwen/qwen3.5-9b`**, WARN **209715**, CUT **235929**. App/Brain/Brain-watchdog are enabled and active. Other harness stopped. No shell tools enabled.
- Test artifacts intentionally retained: labelled recall probe, memory event1, corrected note/index, bridge, local `Session_1.md`/`Session_2.md` and later reboot archive, remote indexed session files, conversation/event logs, private remote testing helpers and sanitized check logs. No unrelated resource was deleted. Original sources at `/root/embervy-src` were not modified; installed runtime source was not patched.
- The configured read jail still includes the installed configuration tree; this test does **not** claim secret-file isolation from the agent. Secrets are omitted from the report/output, and `.env`/MCP/report files remain private.
- Unverified by design: public custom-hostname/PWA rendering, authenticated dream generation, scheduled daemon/dream execution, optional web search/fetch and other subscription/head branches. The app's 1M percentage display remains wrong. The small model's repeated/malformed tool behavior remains a reliability limitation despite functional acceptance passes after retries.
- **Acceptance conclusion:** app-channel answer, stored memory with find, explicit probe recall, automatic inlet, clean controlled cut with retrievable transcript, final diagnostic gates and automatic reboot recovery were actually verified. This is a working installation **with documented workarounds**, not a clean first-try guide/model experience.
