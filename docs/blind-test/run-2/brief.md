You are testing installation instructions. Your workplace is a fresh, disposable Debian 13 server. Reach it with `ssh root@<test-server>` (the key is already set up) and run every command of the installation there; you are root on it. Nothing on that server matters except your report. Do not install or change anything on the machine you are starting from.

The repository is unpacked at /root/embervy-src. Its README.md and INSTALL.md describe how to set up "Embervy" by hand: a home for a long-lived AI agent, with Cloudflare workers for memory and an archive, an app, and a harness that runs the agent.

Your job: follow INSTALL.md exactly as a careful newcomer would, for the **Brain** path (step 6b), from step 0 to the end, and write down every place where the guide is wrong, unclear, incomplete, or where a command fails. Do not use knowledge from outside the repository to silently fix things. If you have to work around something, do it, but record precisely what you did and why the guide did not tell you.

What you have:
- Cloudflare: an empty account. `/root/blindtest.env` holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. There is no domain in the account; skip anything that needs a zone or a public hostname and note it.
- The agent's head: use Brain's `api` head (OpenAI-compatible endpoint) with OpenRouter. `/root/blindtest.env` holds `OPENROUTER_API_KEY`. Use the model `qwen/qwen3.5-9b` for the agent head unless the guide requires something else.
- No Claude or ChatGPT subscription. If a step only works with one of them, note it and continue with the api head.
- Install EMBERVY_HOME at /opt/embervy, as the guide says.

Money:
- Model calls through the supplied OpenRouter key are allowed and expected; that is what the key is for. Keep them small: stay under 1 US dollar in total for the whole run. Measure the key's usage before you start and at the end, and report the difference.
- Never spend money in Cloudflare: no purchases, no domain registration, no plan or subscription change (for example Workers Paid), no billing settings. If the guide requires a paid plan, note it and continue without it, or stop at that point.
- The memory daemon and dream cron schedules may stay empty to save cost; note it if you do.

Rules:
- Work only on this server and in that Cloudflare account. Never delete anything you did not create. Never print secret values; refer to them by name.
- Run every `Check:` block on the Brain path and record its real output (shortened, without secrets): step 0 to 6b including First start, 7b, the step 8 smoke test including the recall probe, a controlled cut, 9b including the shared doctor and the finished-house sweep, and the step 10 reboot check.
- The app channel: send the agent a message through the app the way the guide describes and check that it answers. Count only real tool results and outbox entries, never text that only looks like a tool call.
- If a step fails and you cannot continue at all, stop there and write the report.

Report: write /root/blindtest-report.md on the disposable server in English with
1. a table: step, result (ok / fixed by me / failed / skipped), one line each;
2. for every problem: the exact INSTALL.md section and line, what happened (command and short error), what you did instead, and what the guide should say;
3. a ledger of every Check block with its real output;
4. at the end: did the agent answer a message through the app channel, did a memory write and recall work, did a cut produce an archive file that can be found again, did everything come back after a reboot; how long the whole run took and what it cost.
