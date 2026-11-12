# Blind installation test

Eleven times we gave this repository to an agent that had never seen it
and asked it to set up Embervy by hand, following `INSTALL.md`, on an empty
server with an empty Cloudflare account. Between runs we fixed what it had
found, and every run started again from zero.

Runs 1 to 6 were on 17 October 2026, all on Brain. Runs 7 to 11 followed
on 3 November 2026: the seventh tried the other harness, Claude Code
(step 6a), with a ChatGPT subscription as the agent's head (step 6c), the
eighth ran Claude Code on a Claude subscription, the ninth and the tenth
repeated the eighth with the fixes after each, and the eleventh went back
to Brain. They are described after the first six.

The reports in `run-1/` to `run-11/` are the tester's own. Next to each are
the brief it got and the `INSTALL.md` it followed. Run 1 stopped halfway
because of our wording about money and went on with
`run-1/brief-continued.md`.

A few words used below, explained in the main [README](../../README.md): the
**house** is everything that keeps an agent alive on its server; **Brain** is
the house's own harness; the **head** is the model the agent thinks with; a
**cut** ends a session and starts a new **life**, which begins with a
**bridge** of the last turns; the **inlet** brings matching memories into each
turn; the **reply gateway** is an optional switch that delivers an answer to
the app when the model forgets its reply tool.

## Setup

The same in every run:

- **The tester:** Claude Code as harness, thinking with `gpt-6.1-sol`, a GPT
  model on a ChatGPT subscription, through the ChatGPT adapter in
  `shared/tools/`. No memory, no identity, nothing about us; only the brief.
  Before each run its home was cleared, so it never knew that an earlier run
  existed.
- **Its cage:** a Linux user of its own on our machine, run as a sandboxed
  systemd unit (read-only system, only its home writable, the other homes
  inaccessible, no privilege gain), at most 500 turns. Besides its model
  backend, its only connection out was an SSH key to the disposable server.
- **The disposable server:** a fresh Hetzner cx23 (2 vCPU, 4 GB, Debian 13),
  created for the run and deleted after it. On it: the unpacked source and one
  file with what that run needed: a Cloudflare token and the account ID, an
  OpenRouter key, and in runs 3 and 4 an Anthropic API key.
- **Cloudflare:** an account with nothing in it, emptied again after every run.
  Every brief forbids purchases, plan changes, domains and billing settings.
- **The path:** Brain (step 6b) in runs 1 to 6 and 11.
- **What the brief asks:** follow the guide as a careful newcomer would; write
  down every place where it is wrong, unclear or incomplete; work around a
  problem only openly, never with knowledge from outside the repository; run
  every `Check:` block and record its real output. At the end: does the agent
  answer through the app, do writing and finding a memory work, does a cut
  produce an archive that can be found again, and from run 2 on, does
  everything come back after a reboot.

What changed between runs: the source under test, guide included, because each
run tested the fixes of the one before; the agent's head and its keys (see the
table); and the money rule. Run 1's brief said "never spend money", which we
meant for Cloudflare; the tester rightly counted model calls too and stopped
before the first one. From run 2 on, model calls were allowed up to a limit
($1, $10 in runs 3 and 4).

## How we ran it

Two agents took part. The tester, described above, installed and checked;
everything it knew about the installation came from the repository. The
operator organized each run: the agent that lives in the house this
repository comes from, on Brain, with the tools its own house gives it. It
could watch the tester, but it did not tell it how to install. For every run
it

1. packed the branch under test with `git archive` into a tarball, without
   history and without the installer;
2. created the disposable server through Hetzner's API and copied the tarball
   and the key file onto it;
3. cleared the tester's home, started the tester as its sandboxed unit with
   the brief and nothing else, and watched from outside: the tester's output,
   the server's services and logs, the Cloudflare account;
4. after the run, fetched the report and the tester's evidence, searched them
   for the real key values, emptied the Cloudflare account and deleted the
   server, in runs 5 and 6 after signing the test server out of the
   subscription;
5. turned the findings into orders for a second agent on another model,
   which wrote the fixes; the operator read every diff, ran the test suites
   itself and kept the fixes; the next run started from a fresh tarball of
   that state.

From run 6 on, the tester's output also went to a page that refreshed every
few seconds, with keys and the sign-in code blacked out before they reached
it, so the person behind this project could watch.

What came from that person: the Cloudflare token in runs 1 to 6, because the
agent's browser on a data-centre address was not allowed to create one (in
runs 7 to 11 the operator created it in a dashboard session); the sign-in
code in runs 5, 6 and 8 to 11 and the ChatGPT sign-in in run 7; and the direction
between runs: a larger head after run 2, then one run on a working API and
one on a subscription after run 3. Inside a run the operator stepped in in
two ways: the clarification about money in run 1, and passing on the sign-in
in runs 5 to 11. The tester wrote only the first line
of the sign-in link into its file, so the operator read the whole link from
the tester's terminal on the test server; that is our relay, not the guide.

## All eleven at a glance

| Run | Day | Path | Head of the agent it built | Result |
|---|---|---|---|---|
| 1 | 17 Oct | Brain | Qwen 3.5 9B (OpenRouter) | Works, with workarounds |
| 2 | 17 Oct | Brain | Qwen 3.5 9B (OpenRouter) | Works, except one check |
| 3 | 17 Oct | Brain | Claude Sonnet 5.5 (API) | Needed a one-line change |
| 4 | 17 Oct | Brain | Claude Sonnet 5.5 (API) | Works |
| 5 | 17 Oct | Brain | Claude subscription | Works after workarounds |
| 6 | 17 Oct | Brain | Claude subscription | Works |
| 7 | 3 Nov | Claude Code | ChatGPT subscription | Stopped at the app channel |
| 8 | 3 Nov | Claude Code | Claude subscription | Works, through the reboot; one check failed literally |
| 9 | 3 Nov | Claude Code | Claude subscription | Works, every check passed |
| 10 | 3 Nov | Claude Code | Claude subscription | Works, every check passed |
| 11 | 3 Nov | Brain | Claude subscription | Works, every check passed |

The details of each run follow.

## Runs 1 to 6: Brain

| Run | Head of the agent it built | Time: to the last check, with the report | Code the tester had to change | Result |
|---|---|---|---|---|
| 1 | Qwen 3.5 9B through OpenRouter | 42 min of work in two parts | none | Works, with workarounds. Ten findings: eight in the guide, one in the app's watchdog display, one about the small model. |
| 2 | same | 20 min, 21 min | none | Works, except one check: the greeting after the reboot reached only the terminal, because the small model forgot the reply tool. |
| 3 | Claude Sonnet 5.5 through Anthropic's OpenAI-compatible endpoint | 24 min | one line | The services ran, but the first model request failed with HTTP 400 until the tester removed the line that always sent `temperature`. After a failed first turn the house had no way back to it. |
| 4 | same, after the fixes | 29 min, 34 min | none | Works. Four smaller findings. |
| 5 | Claude subscription (Opus 5.5); a person relayed the sign-in code, the tester has no browser | 24 min, 36 min | none, one unit file adjusted | Works after workarounds. `systemctl restart` did not give Brain a new life. |
| 6 | same, after the fixes | 32 min with the report | none | "The Brain installation works." Two faults in templates. |

Runs 4 and 5 tested the same guide; only the head changed.

## Run 7: Claude Code with a ChatGPT head

Same tester, same cage, a fresh cx23 and an emptied Cloudflare account. The
brief in `run-7/` asked for step 6a with the agent thinking on a ChatGPT
subscription through the adapter (step 6c), without a Claude sign-in or an
Anthropic key. A person signed in to ChatGPT through the same kind of relay
as in runs 5 and 6.

| Run | Head of the agent it built | Time: to the last check, with the report | Code the tester had to change | Result |
|---|---|---|---|---|
| 7 | GPT-5.6 Terra on a ChatGPT subscription, inside Claude Code 2.1.317, no Claude sign-in | 22 min with the report | none | Stopped at the app channel. The workers, the dream, the archive and the head worked, and the agent answered through the app's reply tool, but messages from the app never reached it. Claude Code reported its app channel as "not currently available". |

The tester stopped there, as the brief allows, and wrote six findings. The
blocking one was not in our code. Claude Code turns its channels on through a
setting it receives for a signed-in Claude account, and Anthropic's channel
documentation says channels need Anthropic authentication. We then ran the
same setup on our own machine with a Claude Code that is signed in to a Claude
subscription and still thinks through the ChatGPT adapter: its status showed
the channel listening, and a message pushed into the channel got its answer
through the reply tool within seconds. A Claude Code house therefore always
needs a Claude sign-in, also when it thinks with another head. Brain does not
depend on this.

In run 7 the OpenRouter key's usage grew by $0.0012; the head ran on the
ChatGPT subscription.

## Run 8: Claude Code on a Claude subscription

Same tester, same cage, a fresh cx23 and an emptied Cloudflare account, with
the fixes after run 7. The brief in `run-8/` asked for step 6a with the agent
thinking on a Claude subscription. A person relayed the sign-in code as in
runs 5 and 6.

| Run | Head of the agent it built | Time: to the last check, with the report | Code the tester had to change | Result |
|---|---|---|---|---|
| 8 | Claude subscription (Opus 5.5) inside Claude Code 2.1.317 | 40 min, 47 min | none | Works, through the reboot. One check failed literally, eight findings. |

The agent answered through the app in every life: on the first start, under
systemd, after a restart, after a cut and after the reboot. A memory was
written and found, the inlet brought an archive entry into a turn on its own,
a controlled cut produced an archive that the next life found again, and app,
loop, watchdog and swap came back after a real reboot. The doctor passed with
23 checks and two skips.

The check that failed was the finished-house sweep in step 9. It flagged seven
lines that are not leftovers: the empty identity markers a newborn is told to
keep, and `<name>`-style notation in the handbook and infrastructure files the
house generates itself. The tester kept that failure in the report and ran a
separate copy that excused exactly those seven lines.

The other findings:

- Handing the foreground loop over to systemd depends on pressing Ctrl-C
  inside a two-second pause that the guide does not mention.
- The inlet's clock comes on every fifth turn, counted across cuts and
  reboots, so the first turn of a new life can arrive without one. The guide
  reads as if every new life got it at once.
- Sending text and Enter into tmux back to back left the text unsent after a
  menu had just closed.
- Claude Code 2.1.317 warns about the `(*)` rules in the guide's permission
  example.
- The guide names a heading "Tools I use"; the template calls it "Tools".
- A newborn house tried to build a bridge from the empty transcript of the
  sign-in and started with the prompt meant for after a cut.
- The doctor's SKIP for the Claude sign-in check reads as if no sign-in were
  needed; it only applies to Claude Code with another head.

In run 8 the OpenRouter key's usage grew by $0.015. The head ran on the
subscription; its transcript counted 2.59 million tokens read from cache,
97,775 written to cache and 8,810 output tokens.

## Run 9: the same, after the fixes

The same brief as run 8, a fresh cx23, an emptied Cloudflare account and the
source with the fixes after run 8.

| Run | Head of the agent it built | Time: to the last check, with the report | Code the tester had to change | Result |
|---|---|---|---|---|
| 9 | Claude subscription (Opus 5.5) inside Claude Code 2.1.317 | 46 min with the report | none | Works, through the reboot. Every check passed, the first watchdog check after an extra wait. Three findings. |

The finished-house sweep passed. The tester stopped the foreground loop in
the new stop window and handed it to systemd, the newborn greeted by itself,
and after the reboot the inlet's clock came on turns 1, 6 and 11 of the new
life. The doctor passed with 23 checks and two skips.

The three findings: the first watchdog check read the state file before the
watchdog had written it; Claude Code 2.1.317 still warns about the `(*)`
permission rules; and the generated handbook claimed that the loop answers
start dialogs, permission questions included, for four minutes, while the
loop answers only the development-channels question, for three.

In run 9 the OpenRouter key's usage grew by $0.0064. The head's transcripts
counted 2.75 million tokens read from cache, 93,980 written to cache and
8,815 output tokens.

## Run 10: after the fixes of run 9

The same brief again, a fresh cx23, an emptied Cloudflare account and the
source with the fixes after run 9.

| Run | Head of the agent it built | Time: to the last check, with the report | Code the tester had to change | Result |
|---|---|---|---|---|
| 10 | Claude subscription (Opus 5.5) inside Claude Code 2.1.317 | 44 min with the report | none | Works, through the reboot. Every check passed, the dream check after a repeat. Three smaller findings. |

The permission warnings of runs 8 and 9 did not come back, and the watchdog
check passed at the first reading. The findings: right after its secret was
uploaded, the dream worker answered once that the secret was missing and
passed on the repeat; a cut started by hand does not write `logs/cutoff.log`,
which the troubleshooting table names; and the guide could show more
concretely how to prove that the inlet brought an archive entry on its own.

In run 10 the OpenRouter key's usage grew by $0.0058.

## Run 11: Brain again, with everything since run 6

Brain's last blind run had been run 6. Since then the house had gained the
capability list, the generated house documents, the identity rule, the new
permission form and more. Run 11 went the Brain path again with a Claude
subscription head, with the brief of run 8 turned to steps 6b and 7b.

| Run | Head of the agent it built | Time: to the last check, with the report | Code the tester had to change | Result |
|---|---|---|---|---|
| 11 | Claude subscription (Opus 5.5) through Brain | 31 min with the report | none | Works, through the reboot. Every check passed, two inlet checks and the restart check after a workaround. Seven findings. |

The findings: the first start reports a missing previous conversation as a
problem; the inlet check reads a log file that need not exist and hides a
legitimate dedupe result; a service restart leaves archiving the old life to
the next life, while the guide speaks of a graceful shutdown; the archive's
recovery names are not explained; the generated house map implies a
subscription adapter for a Claude head; and the handbook promises the nightly
daemon even where its schedule was left empty.

In run 11 the OpenRouter key's usage grew by $0.0037.

## Cost of model calls in runs 1 to 6

On the OpenRouter key, measured before and after each run:
$0.086 in run 1 and $0.067 in run 2, for everything, the agent's head
included; in runs 3 to 6, where only the memory and dream workers, the inlet
and the doctor used that key, under one cent per run. The Anthropic API runs
report tokens, not dollars: 720,000 read and 5,900 written in run 3, 790,000
and 5,300 in run 4, with no prompt cache through that endpoint. At
Anthropic's list price that day this was about $1.50 and $1.60. Runs 5 and 6
ran the head on the subscription, the tester always on a ChatGPT
subscription.

## What we fixed between the runs

- **After run 1:** a section for preparing a fresh machine and authenticating
  Wrangler; missing packages; a complete profile for an API head with its file
  permissions; a start command that said foreground and ran in the background;
  log rotation for Brain; the notebook check's path. In code: the app's
  watchdog display assumed a window of one million tokens.
- **After run 2:** a path for an unpacked source tree; the prerequisite check
  for a single machine; the bridge's name after loading; the exact wording of
  the app check; a shell check for the notebook link.
- **After run 3:** in Brain's code, `temperature` is sent only when it is set,
  and a first turn that fails before the model answered is released for the
  next start. In the guide, a section on running Brain with your own API key.
- **After run 5, together with what runs 3 and 4 had found:** in code, every
  house loop runs on its own named tmux socket, and its unit refuses a tmux
  server it does not own (a sign-in done in tmux had taken in Brain's session,
  so a restart reached only the wrapper); a cut started by hand writes its
  log; a house without Claude stops asking for Claude's sign-in; with the
  reply gateway on, the first turn and the greeting after a start reach the
  app even when the model forgets the reply tool. In the guide: an editor,
  the push token created where it is first needed, Claude Code through
  Anthropic's native installer, notebook permissions with a JSON example, the
  tunnel set up by hand, a note on `git diff --check` in an unpacked tree, a
  final check that fails when either part fails, and no example address left
  in the push settings.
- **After run 6:** the identity template named a `recall` parameter that the
  shipped memory tool does not have; a comment we had added to the env
  template after run 5 matched the final sweep's placeholder pattern. These
  two fixes are wording only and have not had a run of their own.

Two of the findings were our own mistakes, and the reports keep them: the
money rule in run 1, and that comment in run 6.

- **After run 7:** the installer offers Claude Code only with a Claude
  subscription and says why; other heads are connected afterwards and keep
  the Claude sign-in. The guide names the requirement in steps 0, 6a and 6c,
  the app channel check reads `/status`, and the troubleshooting table has
  the symptom. The Claude Code loop warns, and the doctor fails, when a
  Claude Code house with another head has no Claude sign-in. The manual path
  has a runnable ChatGPT sign-in command. The clean-shell `PATH` includes
  `/usr/sbin` and `/sbin`. The first export of a fresh house no longer prints
  a missing-file error, and Claude Code's "no visible output" continuation
  notice no longer lands in the chronicle as the person's words. Runs 8 and 9
  used them on a Claude subscription; Claude Code with another head has not
  had a run since.
- **After run 8:** the finished-house sweep matches only the templates' real
  placeholders, so HTML comments and parameter notation in the house's own
  documents pass. After a clean exit and export, a loop with a terminal
  attached prints a fifteen-second stop window for the handover to systemd,
  and a recent export no longer hides the export of a different life. The
  inlet's clock starts again with every life. A transcript with only a sign-in
  in it is no source for a bridge, and a newborn greets for the first time
  instead of after a cut. Literal tmux input waits half a second before Enter,
  the guide uses the template's heading, and the doctor's sign-in SKIP says
  what it means. Run 9 tested these.
- **After run 9:** both watchdog checks wait for the first state file, and the
  handbook describes the start-dialog poller as the loop runs it, tied to the
  loop by a test. The private Claude Code settings allow the file tools by
  bare name, which current Claude Code reads as every path. A setting says
  whether the identity file is the agent's own or written together, and the
  handbook follows it. A start question that Claude Code asks in the terminal
  appears in the app as a card with one button per answer. Run 10 tested
  these; no start question appeared in it.
- **After run 10:** a cut started by hand writes `logs/cutoff.log`; the dream
  check waits out a secret that was only just uploaded; the guide shows how
  to prove that the inlet brought an archive entry on its own. Run 11 went
  the other path, so these have not had a run of their own.
- **After run 11:** the very first start no longer reports a missing bridge;
  the guide tells restart, cut and recovery apart and explains the archive's
  recovery names; the inlet check shows a dedupe result and needs no
  diagnostic log; the generated house documents name the adapter only for a
  GPT head and the daemon's schedule only as configured. These have not had
  a blind run yet.

## What was not tested

- The public address through a tunnel and the phone app: the test account has
  no domain. The app was checked through its real, logged-in HTTP routes, and
  in runs 3 and 4 also in a browser on the server.
- The nightly memory daemon and dream on their schedules: left off to save
  cost. From run 2 on, the tester started a dream by hand, and it came.
- Claude Code with another head after the app channel. Run 7 stopped there;
  runs 8 to 10 ran Claude Code to the end, but on a Claude subscription.
- Voice, images, video, mail, calendar, web search, weather, Web Push, the
  agent's browser: off.
- Time zones other than UTC.

## Reading the reports

In the reports and briefs, the test servers' addresses, the Cloudflare account
ID, the account's workers.dev subdomain, its login e-mail and the OpenRouter
key's running total are replaced by placeholders. Nothing else is changed.
Times in the reports are UTC. Line numbers refer to the `INSTALL.md` next to
each report, the version that run followed; this repository's history starts
with one commit, so those versions are not in it otherwise. Where a report
gives a checksum, it matches that file.

We ran these tests ourselves, so they are not independent. The briefs are
here so you can run one yourself: give your own agent this repository, a
disposable server, an empty Cloudflare account, and the brief.
