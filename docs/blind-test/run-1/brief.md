You are testing installation instructions. Your workplace is a fresh, disposable Debian 13 server. Reach it with `ssh root@<test-server>` (the key is already set up) and run every command of the installation there; you are root on it. Nothing on that server matters except your report. Do not install or change anything on the machine you are starting from.

The repository is unpacked at /root/embervy-src. Its README.md and INSTALL.md describe how to set up "Embervy" by hand: a home for a long-lived AI agent, with Cloudflare workers for memory and an archive, an app, and a harness that runs the agent.

Your job: follow INSTALL.md exactly as a careful newcomer would, for the **Brain** path (step 6b), and write down every place where the guide is wrong, unclear, incomplete, or where a command fails. Do not use knowledge from outside the repository to silently fix things. If you have to work around something, do it, but record precisely what you did and why the guide did not tell you.

What you have:
- Cloudflare: an empty account. `/root/blindtest.env` holds `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. There is no domain in the account; skip anything that needs a zone or a public hostname and note it.
- The agent's head: use Brain's `api` head (OpenAI-compatible endpoint) with OpenRouter. `/root/blindtest.env` holds `OPENROUTER_API_KEY`. Use the model `qwen/qwen3.5-9b` for the agent head unless the guide requires something else; keep costs low.
- No Claude or ChatGPT subscription. If a step only works with one of them, note it and continue with the api head.
- Install EMBERVY_HOME at /opt/embervy, as the guide says.

Rules:
- Work only on this server and in that Cloudflare account. Never delete anything you did not create. Never print secret values; refer to them by name.
- Never spend money: no purchases, no domain registration, no plan or subscription change (for example Workers Paid), no billing settings. If the guide requires a paid plan, note it and continue without it, or stop at that point.
- Run every `Check:` block in the guide and record its real output (shortened, without secrets).
- If a step fails and you cannot continue at all, stop there and write the report.

Report: write /root/blindtest-report.md on the disposable server in English with
1. a table: step, result (ok / fixed by me / failed / skipped), one line each;
2. for every problem: the exact INSTALL.md section and line, what happened (command and short error), what you did instead, and what the guide should say;
3. at the end: did the agent answer a message through the app channel, did a memory write and recall work, did a cut produce an archive file that can be found again; and how long the whole run took.
