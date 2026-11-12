#!/usr/bin/env bun
/**
 * Show or rotate the phone-feed token (CALENDAR_FEED_TOKEN in .env).
 *
 *   bun shared/calendar/feed-token.ts show     # print the subscription link
 *   bun shared/calendar/feed-token.ts rotate   # new token; the old link dies
 *   … [--env /path/to/.env]                    # default $EMBERVY_HOME/.env
 *
 * After rotate: restart the app (systemctl restart embervy-app) and
 * subscribe again on the phone with the new link. The installer creates
 * the token once and keeps it across re-runs; only this command changes it.
 */

import { existsSync, readFileSync } from "node:fs";
import { refreshStoredCredential, writePrivateText } from "../scripts/credential-store";
import { join } from "node:path";
import { envLine, envLineKey, parseEnv } from "../scripts/env-file";
import { envValue, houseHome } from "../scripts/legacy-names";

export function generateFeedToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/** Read KEY=value from .env text (last one wins), the way every reader reads it (shared/scripts/env-file.ts); "" when absent.
 * Accept legacy setting names through legacy-names.ts. */
export function envGet(text: string, key: string): string {
  return envValue(key, parseEnv(text)) ?? "";
}

/** Set KEY=value in .env text: replace every existing line for KEY, else append (written in the shared format). */
export function envSet(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const line = envLine(key, value);
  let done = false;
  const out: string[] = [];
  for (const l of lines) {
    if (envLineKey(l) === key) {
      if (!done) out.push(line);
      done = true;
    } else out.push(l);
  }
  if (!done) {
    if (out.length && out[out.length - 1] === "") out.splice(out.length - 1, 0, line);
    else out.push(line);
  }
  return out.join("\n");
}

export function rotateFeedToken(envPath: string): Promise<{ text: string; token: string }> {
  const read = () => existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const previous = envGet(read(), "CALENDAR_FEED_TOKEN");
  return refreshStoredCredential(envPath, async () => {
    const text = read();
    const current = envGet(text, "CALENDAR_FEED_TOKEN");
    if (current && current !== previous) return { text, token: current };
    const token = generateFeedToken();
    const next = envSet(text, "CALENDAR_FEED_TOKEN", token);
    await writePrivateText(envPath, next);
    return { text: next, token };
  });
}

function feedUrl(envText: string, token: string): string {
  const base = envGet(envText, "EMBERVY_APP_URL").replace(/\/+$/, "");
  const path = `/calendar.ics?token=${token}`;
  return base ? `${base}${path}` : `https://<your app address>${path}`;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "show";
  const i = argv.indexOf("--env");
  const envPath = i >= 0 ? argv[i + 1] : join(houseHome(process.env, existsSync), ".env");
  const text = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  if (cmd === "show") {
    const token = envGet(text, "CALENDAR_FEED_TOKEN");
    if (!token) {
      console.log(`No CALENDAR_FEED_TOKEN in ${envPath} — run: bun ${import.meta.path} rotate`);
      process.exit(1);
    }
    if (envGet(text, "EMBERVY_HOOK_CALENDAR") !== "1") console.log("Note: EMBERVY_HOOK_CALENDAR is not 1 — the feed answers 404 until it is.");
    console.log(feedUrl(text, token));
  } else if (cmd === "rotate") {
    const { text: next, token } = await rotateFeedToken(envPath);
    console.log("New phone-feed link (the old one stops working once the app restarts):");
    console.log(feedUrl(next, token));
    console.log("Now: restart the app (systemctl restart embervy-app — or the app unit your house has) — then subscribe again on the phone with the new link.");
  } else {
    console.log("usage: feed-token.ts show | rotate [--env PATH]");
    process.exit(2);
  }
}
