You are testing installation instructions. Your workplace is a fresh, disposable Debian 13 server. Reach it with `ssh root@<test-server>` (the key is already set up) and run every command of the installation there; you are root on it. Nothing on that server matters except your report. Do not install or change anything on the machine you are starting from.

The repository is unpacked at /root/embervy-src. Its README.md and INSTALL.md describe how to set up "Embervy" by hand: a home for a long-lived AI agent, with Cloudflare workers for memory and an archive, an app, and a harness that runs the agent.

Your job: follow INSTALL.md exactly as a careful newcomer would, for the **Claude Code** path (step 6a), with the agent thinking on a **Claude subscription**, from step 0 to the end, and write down every place where the guide is wrong, unclear, incomplete, or where a command fails. Do not use knowledge from outside the repository to silently fix things. If you have to work around something, do it, but record precisely what you did and why the guide did not tell you.

What you have:
- Cloudflare: an empty account. `/root/blindtest.env` holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. The account holds one domain that is not yours, and the token has no zone or DNS permission; skip anything that needs a zone or a public hostname and note it.
- The agent's head: Claude Code on a Claude subscription, exactly as step 6a describes. You cannot open a browser or receive a sign-in code yourself, so the sign-in goes through a relay, and only this way:
  1. When the guide tells you to sign in, start the sign-in on the disposable server inside a tmux session, as the guide says, and drive it to the point where it shows a sign-in URL and waits for a code.
  2. Write that URL, alone, into `/root/blindtest-login-url.txt` on the disposable server.
  3. Wait until `/root/blindtest-login-code.txt` appears there (check every 15 seconds, up to 45 minutes). A person signs in and the code is placed in that file.
  4. Type the code from that file into the waiting sign-in prompt, finish the sign-in, then delete both files. Never print the code or any token in your report or your output.
  If the URL expires before the code arrives, start over at step 1 and overwrite the URL file.
  There is no ChatGPT subscription and no Anthropic API key; do not set one up.
- `/root/blindtest.env` holds `OPENROUTER_API_KEY` for everything in the guide that uses OpenRouter (memory and dream workers, inlet).
- Install EMBERVY_HOME at /opt/embervy, as the guide says.

Money:
- Model calls through the supplied OpenRouter key are allowed; stay under 1 US dollar there and report the key's usage difference. The agent's head runs on the subscription; report its token usage if the house shows it.
- Never spend money in Cloudflare: no purchases, no domain registration, no plan or subscription change (for example Workers Paid), no billing settings. If the guide requires a paid plan, note it and continue without it, or stop at that point.
- The memory daemon and dream cron schedules may stay empty to save cost; note it if you do.

Rules:
- Work only on this server and in that Cloudflare account. Never delete anything you did not create. Never print secret values; refer to them by name.
- Run every `Check:` block on the Claude Code path and record its real output (shortened, without secrets): step 0 to 6a including First start, 7a, the step 8 smoke test for Claude Code, a controlled cut, 9a including the shared doctor and the finished-house sweep, and the step 10 reboot check.
- The app channel: send the agent a message through the app the way the guide describes and check that it answers. Count only real tool results and outbox entries, never text that only looks like a tool call.
- If a step fails and you cannot continue at all, stop there and write the report.

Report: write /root/blindtest-report.md on the disposable server in English with
1. a table: step, result (ok / fixed by me / failed / skipped), one line each;
2. for every problem: the exact INSTALL.md section and line, what happened (command and short error), what you did instead, and what the guide should say;
3. a ledger of every Check block with its real output;
4. at the end: did the agent answer a message through the app channel; did a memory write and recall work; did a cut produce an archive file that can be found again; did everything come back after a reboot; how long the whole run took and what it cost.
