#!/usr/bin/env bun
// Checks the mailbox once and delivers new mail notices to the app.

import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { fetchSinceUid, type MailAccount, type UidCursor } from "../../shared/mail/imap";
import { fetchSinceCursor, type GraphAccount, type GraphCursor } from "../../shared/mail/graph";
import { envValue, houseHome } from "../../shared/scripts/legacy-names";
import { contextLine } from "../../shared/scripts/context-text";

const PROVIDER = (process.env.MAILBOX_PROVIDER || "").toLowerCase();
const IS_GRAPH = PROVIDER === "graph" || PROVIDER === "outlook";

const HOST = process.env.MAILBOX_HOST || "";
const PORT = Number(process.env.MAILBOX_PORT || "993");
const SECURE = process.env.MAILBOX_SECURE !== "false";
const USER = process.env.MAILBOX_USER || "";
const APP_PASSWORD = process.env.MAILBOX_APP_PASSWORD || "";

const GRAPH_CLIENT_ID = process.env.MAILBOX_GRAPH_CLIENT_ID || "";

const EMBERVY_HOME = houseHome(process.env, existsSync);
const APP_HOST = envValue("EMBERVY_APP_HOST") || "127.0.0.1";
const APP_PORT = envValue("EMBERVY_APP_PORT") || "3030";
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || "";

const STATE_PATH = `${EMBERVY_HOME}/state/mail-poll-state.json`;
const GRAPH_TOKEN_CACHE_PATH = `${EMBERVY_HOME}/state/mail-graph-token.json`;

const ACCOUNT = IS_GRAPH ? `graph:${GRAPH_CLIENT_ID}:${USER}` : `imap:${HOST}:${USER}`;

interface PollState {
  account?: string;
  recovery?: boolean;
  uid_cursor?: UidCursor;
  graph_cursor?: GraphCursor;
}

async function loadState(): Promise<PollState> {
  try {
    const state = JSON.parse(await Bun.file(STATE_PATH).text());
    if (!state || (state.account !== undefined && state.account !== ACCOUNT)) throw new Error("cursor account changed");
    const cursor = IS_GRAPH ? state.graph_cursor : state.uid_cursor;
    const valid = IS_GRAPH
      ? cursor && typeof cursor.since === "string" && Number.isFinite(Date.parse(cursor.since)) && Array.isArray(cursor.seenIdsAtSince) && cursor.seenIdsAtSince.every((id: unknown) => typeof id === "string") && (cursor.nextLink === undefined || typeof cursor.nextLink === "string")
      : cursor && typeof cursor.uidValidity === "string" && /^\d+$/.test(cursor.uidValidity) && Number.isSafeInteger(cursor.lastUid) && cursor.lastUid >= 0;
    if (!valid) throw new Error("invalid mailbox cursor");
    return state;
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    console.error(`mail-poll: cursor recovery required: ${error?.message || error}`);
    return { recovery: true };
  }
}

// Atomic replacement prevents crashes or concurrent reads from exposing a partial cursor.
async function saveState(s: PollState): Promise<void> {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  const tmpPath = `${STATE_PATH}.${process.pid}.tmp`;
  await Bun.write(tmpPath, JSON.stringify(s, null, 2));
  await rename(tmpPath, STATE_PATH);
}

async function notifyApp(text: string, id: string, mails: { mailKey: string; subject: string; from: string }[]): Promise<boolean> {
  const payload = {
    id,
    mailKeys: mails.map((mail) => mail.mailKey),
    mails,
    text,
    ts: new Date().toISOString(),
    from: USER || "mailbox",
    source: "email",
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (INTERNAL_TOKEN) headers.authorization = `Bearer ${INTERNAL_TOKEN}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`http://${APP_HOST}:${APP_PORT}/api/internal/mail-inbox`, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
      console.error(`mail-poll: notify_app got HTTP ${res.status}`);
    } catch (e: any) {
      console.error(`mail-poll: notify_app attempt ${attempt} failed: ${e?.message || e}`);
    }
    if (attempt === 0) await Bun.sleep(2000);
  }
  console.error(`mail-poll: notify_app failed after retry`);
  return false;
}

async function main() {
  if (IS_GRAPH) {
    await pollGraph();
  } else {
    await pollImap();
  }
}

async function pollImap() {
  if (!HOST || !USER || !APP_PASSWORD) {
    console.log("mail-poll: MAILBOX_* env not set, skipping");
    return;
  }

  const state = await loadState();
  const account: MailAccount = { host: HOST, port: PORT, secure: SECURE, user: USER, appPassword: APP_PASSWORD };

  let result;
  try {
    // Socket timeouts alone may not bound a stalled handshake or silent server.
    result = await withTimeout(fetchSinceUid(account, state.recovery ? { uidValidity: "recovery", lastUid: 0 } : state.uid_cursor ?? null), 30_000, "fetchSinceUid");
  } catch (e: any) {
    console.error(`mail-poll: fetch failed: ${e?.message || e}`);
    return; 
  }

  const { messages, cursor } = result;
  await deliverAndAdvance(messages, () => saveState({ account: ACCOUNT, uid_cursor: cursor }), `${ACCOUNT}:${cursor.uidValidity}`, ACCOUNT);
}

async function pollGraph() {
  if (!GRAPH_CLIENT_ID) {
    console.log("mail-poll: MAILBOX_GRAPH_CLIENT_ID not set, skipping");
    return;
  }

  const state = await loadState();
  const account: GraphAccount = { clientId: GRAPH_CLIENT_ID, tokenCachePath: GRAPH_TOKEN_CACHE_PATH };
  if (!state.graph_cursor) {
    // Persist the initial boundary before fetching so a failed first delivery remains retryable.
    state.graph_cursor = { since: new Date(Date.now() - (state.recovery ? 86400000 : 0)).toISOString(), seenIdsAtSince: [] };
    await saveState({ account: ACCOUNT, graph_cursor: state.graph_cursor });
  }

  let result;
  try {
    result = await withTimeout(fetchSinceCursor(account, state.graph_cursor), 30_000, "fetchSinceCursor");
  } catch (e: any) {
    console.error(`mail-poll: graph fetch failed: ${e?.message || e}`);
    return; 
  }

  const { messages, cursor } = result;
  await deliverAndAdvance(messages, () => saveState({ account: ACCOUNT, graph_cursor: cursor }), ACCOUNT);
}

// Advancing before confirmed delivery would permanently skip mail during an app outage.
async function deliverAndAdvance(messages: { subject: string; from: string; uid?: number; id?: string; messageId?: string; date?: Date | null }[], commit: () => Promise<void>, namespace = "mailbox", overlapAccount?: string) {
  // A 192-bit digest leaves room for prefixes within the app's ID length limit.
  const hash = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
  const mails = await Promise.all(messages.map(async (message) => ({
    mailKey: `mail-key-${await hash(overlapAccount
      ? [overlapAccount, message.messageId || [message.from, message.date, message.subject]]
      : [namespace, message.id ?? message.uid ?? [message.from, message.subject]])}`,
    subject: contextLine(message.subject),
    from: contextLine(message.from, 200),
  })));
  if (mails.length) {
    const text = `[Mailbox] ${mails.length} new:\n` + mails.slice(0, 10).map((mail) => `- ${mail.subject} (from ${mail.from})`).join("\n")
      + (mails.length > 10 ? `\n…and ${mails.length - 10} more` : "");
    const id = `mail-${await hash(mails.map((mail) => mail.mailKey).sort())}`;
    if (!await notifyApp(text, id, mails)) {
      console.error("mail-poll: delivery failed, cursor not advanced — will retry this window next tick");
      return;
    }
  }
  await commit();
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

main();
