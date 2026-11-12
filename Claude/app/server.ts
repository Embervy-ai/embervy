#!/usr/bin/env bun
// Serves the web app and exchanges messages with the agent over HTTP, WebSocket and inbox files.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, watchFile, unlinkSync, renameSync, statSync, openSync, closeSync } from "node:fs";
import { deliverUnlessFirstStart } from "./first-start-guard";
import { paneHasClaude } from "./pane-claude";
import { ApprovalSettingsStore, approvalChange, proposedSettings, loosens, type ApprovalSettings } from "./approval-settings";
import { houseFeatureDefaults } from "./feature-defaults";
import { mediaPolicy } from "./send-file";
import { inQuietHours } from "./quiet-hours";
import { acceptedPushEndpoint } from "./push-endpoint";
import { tmuxCommand, tmuxSocket, brainTmuxSocket, videoBackendUrl, housePids, ownsProcess, chatgptAuthFile } from "../../shared/scripts/house-runtime";
import { join } from "node:path";
import { execSync, spawn } from "node:child_process";
import { positiveFiniteSetting } from "./security-config";
import { websocketOriginAllowed } from "./ws-origin";
import { parseEnv } from "../../shared/scripts/env-file";
import { withCredentialLock, writePrivateText } from "../../shared/scripts/credential-store";
import { createHash, timingSafeEqual as bufferTimingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { boundedRequest, REQUEST_BODY_MAX } from "./request-body";
import { JsonlHistory } from "./jsonl-history";
import { applyDoctorMutes, parseDoctorMutes, pruneDoctorMutes, rawDoctorStatus, validDoctorId, doctorRegressed, DOCTOR_MUTE_MS, type DoctorMutes } from "./doctor-mute";
import { serveStatic } from "hono/bun";
import { checkEmailBlacklist } from "./config/email-blacklist";
import { loadStrings, t as translate, clientScript, pageVersion, escapeHtml as escapeText } from "./strings";
import { claudeSignedIn, finishClaudeSignIn, localRunner, startClaudeSignIn, claudeScreenExpired, needsClaudeLogin, parseClaudeAuth, claudeProfile } from "../../shared/scripts/claude-signin";
import { chatgptAuthJson, exchangeChatGptCode, GPT_HEAD_ENV_KEYS, gptHeadEnvLines, probeChatGpt, startChatGptSignIn, type ChatGptSignInAttempt } from "../../shared/scripts/chatgpt-signin";
import { ansiToHtml } from "./ansi";
import { mapTerminalInput, terminalInputActivityDetail, type TerminalInput } from "./terminal-input";
import { brainLogEntries, claudeLogEntries, claudeProjectDir, logHistoryPage, type LogEntry, type LogLabels } from "./terminal-log";
import { classifyActivity, classifyFromEvents, classifyObservedActivity, type ActivityEvent, type ActivityState } from "./activity";
import { brokenBroadcastField, cleanReplyTo, isSafeMessageId, replyQuoteFromId } from "./message-fields";
import { fileViewer, rawFileHeaders, RAW_TEXT_TYPES, VIEWER_JS, VIEWER_SCRIPT_PATH } from "./file-viewer";
import { calendarConfigFromEnv, isCalendarFeedPath, registerCalendarRoutes, startExternalPoller } from "../../shared/calendar/routes";
import { brainControlFrom, brainDirFor, brainHeadsError, brainMenuCommand, envValues, shapeBrainHeads } from "./brain-menu";
import { parseRoomState, pollRoom, roomConfigsFromEnv, roomMessagePrefix, roomStateFileName, sendToRoom } from "./room-door";
import { peerConfigsFromEnv, registerPeerRoutes } from "./peer-door";
import { envValue, houseHome, MEMORY_IMAGE_PATH, MEMORY_VIDEO_PATH, SESSION_COOKIE } from "../../shared/scripts/legacy-names";

const EMAIL_SENDER_URL = process.env.EMAIL_SENDER_URL || "";
const EMAIL_SENDER_AUTH = process.env.EMAIL_SENDER_AUTH || "";

type MailSendResult = { ok: boolean; status: "sent" | "failed" | "unknown"; error?: string };
function readMailOutbox(): any[] {
  try { return readFileSync(EMAIL_OUTBOX, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (e: any) { if (e.code === "ENOENT") return []; throw e; }
}
function writeMailOutbox(entries: any[]) {
  const temp = `${EMAIL_OUTBOX}.${crypto.randomUUID()}.tmp`;
  writeFileSync(temp, entries.map(e => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
  renameSync(temp, EMAIL_OUTBOX);
}
// Keep the check and durable transition synchronous so competing decisions cannot both win.
function decideMail(id: string, action: "send" | "discard") {
  const entries = readMailOutbox();
  const entry = entries.find(e => e.id === id);
  if (!entry) return { accepted: false, status: "unknown", code: 404 as const };
  if (entry.status !== "pending_approval") return { accepted: false, status: entry.status, code: 409 as const };
  entry.status = action === "send" ? "ready" : "discarded";
  entry.approved_at = new Date().toISOString();
  writeMailOutbox(entries);
  broadcastToClients({ type: "email-approval", data: { id, status: entry.status } });
  return { accepted: true, status: entry.status, code: 200 as const };
}
function mailCardFields(entry: any) {
  return {
    email_status: entry?.status || "unknown",
    email_detail: entry ? [
      S("email.cardTo", { to: entry.to }),
      ...(entry.cc ? [S("email.cardCc", { cc: entry.cc })] : []),
      S("email.cardSubject", { subject: entry.subject }),
      ...(entry.hits?.length ? [S("email.cardHits", { hits: entry.hits.join(", ") })] : []),
      "", entry.body,
    ].join("\n") : "",
  };
}
const activeMailSends = new Map<string, Promise<MailSendResult>>();
function deliverMail(id: string): Promise<MailSendResult> {
  if (activeMailSends.has(id)) return activeMailSends.get(id)!;
  const run = async (): Promise<MailSendResult> => {
    const entries = readMailOutbox();
    const entry = entries.find(e => e.id === id);
    if (!entry || !["ready", "sending"].includes(entry.status)) return { ok: entry?.status === "sent", status: entry?.status === "sent" ? "sent" : "unknown", error: "Job is not ready; inspect delivery" };
    // Provider keys expire, so older attempts require inspection instead of replay.
    if (entry.attempted_at && (!Number.isFinite(Date.parse(entry.attempted_at)) || Date.now() - Date.parse(entry.attempted_at) >= 23 * 3600_000)) {
      const result: MailSendResult = { ok: false, status: "unknown", error: "Idempotency window elapsed; possibly sent; do not resend; inspect delivery" };
      await markSentOrFailed(id, result);
      return result;
    }
    entry.status = "sending";
    entry.attempted_at ||= new Date().toISOString();
    writeMailOutbox(entries);
    const result = await sendEmailViaWorker(entry.to, entry.subject, entry.body, entry.from, entry.id, entry.cc);
    await markSentOrFailed(id, result);
    return result;
  };
  const promise = run().finally(() => activeMailSends.delete(id));
  activeMailSends.set(id, promise);
  return promise;
}
async function recoverMailOutbox() {
  for (const entry of readMailOutbox()) if (["ready", "sending"].includes(entry.status)) await deliverMail(entry.id);
}
async function sendEmailViaWorker(to: string, subject: string, body: string, from: string | undefined, id: string, cc?: string): Promise<MailSendResult> {
  if (!EMAIL_SENDER_URL || !EMAIL_SENDER_AUTH) {
    return { ok: false, status: "failed", error: "EMAIL_SENDER_URL or EMAIL_SENDER_AUTH not configured" };
  }
  try {
    const res = await fetch(EMAIL_SENDER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${EMAIL_SENDER_AUTH}`,
        "Idempotency-Key": id,
      },
      body: JSON.stringify({ to, cc, subject, body, from }),
    });
    const data = await res.json() as any;
    if (res.ok && data.ok === true) return { ok: true, status: "sent" };
    return { ok: false, status: data.ok === false && data.status === "failed" ? "failed" : "unknown", error: data.error || `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: "unknown", error: String(err) };
  }
}

async function markSentOrFailed(id: string, result: MailSendResult): Promise<void> {
  const entries = readMailOutbox();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return;
  entries[idx].status = result.status;
  if (result.ok) entries[idx].sent_at = new Date().toISOString();
  if (!result.ok) entries[idx].error = result.error;
  writeMailOutbox(entries);
  broadcastToClients({ type: "email-approval", data: { id, status: result.status } });
}

const APP_DIR = import.meta.dir;
const PUBLIC_DIR = join(APP_DIR, "public");
const S = (key: string, vars?: Record<string, string | number>) => translate(loadStrings().strings, key, vars);
const DATA_DIR = envValue("EMBERVY_APP_DATA_DIR") || join(APP_DIR, "data");
const IMAGES_DIR = join(DATA_DIR, "images");
const INBOX = join(DATA_DIR, "inbox.jsonl");
const OUTBOX = join(DATA_DIR, "outbox.jsonl");
const EMAIL_INBOX = join(DATA_DIR, "email-inbox.jsonl");
const EMAIL_OUTBOX = join(DATA_DIR, "email-outbox.jsonl");
// Only the send-email handler maps approval cards to mail IDs, so untrusted
// message fields cannot authorize sending mail.
const EMAIL_APPROVAL_CARDS = join(DATA_DIR, "email-approval-cards.jsonl");
const APPROVALS = join(DATA_DIR, "approvals.jsonl");
type Approval = { id: string; title: string; detail: string; kind: string; status: "pending" | "allow" | "deny" | "expired"; ts: string; decided_at?: string; via?: string; draft?: { id: string; hash: string; account: string }; consumed?: boolean; settings?: { before: string; next: ApprovalSettings } };

// Installer capability and live consent are separate so repairs cannot grant consent.
const MAILBOX_WRITE_SETTINGS = join(DATA_DIR, "mailbox-write.json");
const mailboxWritingSetUp = () => (process.env.MAILBOX_ALLOW_SEND || "false").toLowerCase() === "true";
function mailboxWritingEnabled(): boolean {
  try { return JSON.parse(readFileSync(MAILBOX_WRITE_SETTINGS, "utf8")).enabled === true; }
  catch { return false; }
}
function requireMailboxWriting() {
  if (!mailboxWritingSetUp()) throw new Error(S("mailboxWrite.notSetUp"));
  if (!mailboxWritingEnabled()) throw new Error(S("mailboxWrite.off"));
}
async function mailboxDraftAccess() {
  requireMailboxWriting();
  const provider = (process.env.MAILBOX_PROVIDER || "").toLowerCase();
  if (provider === "graph" || provider === "outlook") {
    if (!process.env.MAILBOX_GRAPH_CLIENT_ID) throw new Error(S("mailboxWrite.providerMissing"));
    const mail = await import("../../shared/mail/graph");
    const account = { clientId: process.env.MAILBOX_GRAPH_CLIENT_ID, tokenCachePath: join(houseHome(process.env, existsSync), "state", "mail-graph-token.json") };
    return { identity: JSON.stringify([provider, account]), read: (id: string) => mail.readDraft(account, id),
      append: (opts: { to: string; subject: string; body: string; inReplyTo?: string }) => { requireMailboxWriting(); return mail.appendDraft(account, opts); },
      send: (id: string, hash: string, filingOnly = false) => { requireMailboxWriting(); return filingOnly ? Promise.resolve({ ok: false, detail: "Filing recovery is only available for IMAP" }) : mail.sendDraft(account, id, hash); } };
  }
  const mail = await import("../../shared/mail/imap");
  if ((provider && !["imap", "custom", ...Object.keys(mail.KNOWN_PROVIDERS)].includes(provider)) || !process.env.MAILBOX_HOST || !process.env.MAILBOX_USER || !process.env.MAILBOX_APP_PASSWORD) throw new Error(S("mailboxWrite.providerMissing"));
  const account = { host: process.env.MAILBOX_HOST, port: Number(process.env.MAILBOX_PORT || 993), secure: process.env.MAILBOX_SECURE !== "false", user: process.env.MAILBOX_USER, appPassword: process.env.MAILBOX_APP_PASSWORD };
  const folder = process.env.MAILBOX_DRAFTS_FOLDER || "Drafts";
  return { identity: JSON.stringify([provider, account.host, account.port, account.user, folder]), read: (id: string) => mail.readDraft(account, Number(id), folder),
    append: (opts: { to: string; subject: string; body: string; inReplyTo?: string }) => { requireMailboxWriting(); return mail.appendDraft(account, opts, folder); },
    send: (id: string, hash: string, filingOnly = false) => { requireMailboxWriting(); return mail.sendDraft(account, Number(id), folder, process.env.MAILBOX_SENT_FOLDER || "Sent", hash, filingOnly); } };
}
function readApprovals(): Approval[] {
  if (!existsSync(APPROVALS)) return [];
  return readFileSync(APPROVALS, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function decideApproval(id: string, decision: "allow" | "deny" | "expired", via: string): Approval | null {
  const list = readApprovals();
  const entry = list.find(row => row.id === id);
  if (!entry) return null;
  if (entry.status !== "pending") return entry;
  if (entry.settings && decision === "allow" && approvalSettings) {
    const current = approvalSettings.read();
    // A card cannot silently overwrite a later choice from the person or another request.
    if (entry.settings.before !== settingsFingerprint(current)) decision = "expired";
    else approvalSettings.write(entry.settings.next, "agent");
  }
  entry.status = decision;
  entry.decided_at = new Date().toISOString();
  entry.via = via;
  // Atomic replacement keeps readers from seeing a partially written decision.
  writeFileSync(`${APPROVALS}.tmp`, list.map(row => JSON.stringify(row)).join("\n") + "\n");
  renameSync(`${APPROVALS}.tmp`, APPROVALS);
  broadcastToClients({ type: "approval", data: { id, status: decision } });
  return entry;
}

function approvalCardEmailId(cardId: string): string | null {
  try {
    for (const line of readFileSync(EMAIL_APPROVAL_CARDS, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line);
      if (row?.card_id === cardId && typeof row.email_id === "string") return row.email_id;
    }
  } catch {}
  return null;
}

// Untrusted messages must not create approval cards or choose which mail they authorize.
function dropServerFields(msg: any): void {
  if (!msg || typeof msg !== "object") return;
  delete msg.email_id;
  delete msg.approval_id;
  if (msg.source === "approval") delete msg.source;
  if (msg.source === "email-approval") delete msg.source;
}
const PUSH_SUBS_FILE = join(DATA_DIR, "push-subscriptions.json");
const ACTIVITY_DIR = join(DATA_DIR, "activity");
const ACTIVITY_FLIGHT = join(ACTIVITY_DIR, "terminal-input.jsonl");
const ACTIVITY_FLIGHT_ROTATED = `${ACTIVITY_FLIGHT}.1`;
const ACTIVITY_FLIGHT_MAX_BYTES = 256 * 1024;
const ACTIVITY_FLIGHT_MAX_EVENTS = 200;
const ENV_FILE = join(APP_DIR, ".env");

mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(IMAGES_DIR, { recursive: true });

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:agent@example.com";
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const APP_SESSION_SECRET = process.env.APP_SESSION_SECRET || "";
const EXTERNAL_PUSH_TOKEN = process.env.EXTERNAL_PUSH_TOKEN || "";
const INTERNAL_API_TOKEN = process.env.INTERNAL_API_TOKEN || "";
const EMBERVY_URL = (envValue("EMBERVY_URL") || "").replace(/\/$/, "");
const EMBERVY_API_KEY = envValue("EMBERVY_API_KEY") || "";
// Off by default (fail-closed): a misconfigured proxy or an exposed port must
// never turn every request into a trusted local one.
const TRUST_SAME_HOST = ["1", "true"].includes((envValue("EMBERVY_TRUST_SAME_HOST") ?? "false").toLowerCase());
// The resident harness owns its model, adapter and commands; the app must not interfere.
const BRAIN_HARNESS = (envValue("EMBERVY_HARNESS") ?? "").trim().toLowerCase() === "brain";
const BRAIN_DIR = brainDirFor(APP_DIR, envValue("EMBERVY_HOME"), existsSync);
// Read at every request, so a token added later needs no restart.
const BRAIN_ENV_FILES = process.env.BRAIN_ENV_FILE?.trim()
  ? [process.env.BRAIN_ENV_FILE.trim()]
  : [join(BRAIN_DIR, "brain.env"), join(BRAIN_DIR, ".env")];
function readText(file: string): string {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}
function claudeAuthContext() {
  const brainEnv = envValues(BRAIN_ENV_FILES.map(readText).join("\n"), ["BRAIN_STATE_DIR", "CLAUDE_CONFIG_DIR"]);
  const stateDir = process.env.BRAIN_STATE_DIR || brainEnv.BRAIN_STATE_DIR || join(BRAIN_DIR, "state");
  const state = BRAIN_HARNESS ? parseClaudeAuth(readText(join(stateDir, "claude-auth.json"))) : null;
  const profileEnv = BRAIN_HARNESS
    ? { CLAUDE_CONFIG_DIR: brainEnv.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR }
    : readText(ENV_FILE);
  return { state, configDir: claudeProfile(BRAIN_HARNESS, state, profileEnv) };
}
const TERMINAL_PANEL_ENABLED = (envValue("EMBERVY_TERMINAL_PANEL") ?? "1") !== "0";
const TERMINAL_TMUX_SESSION = (BRAIN_HARNESS ? process.env.BRAIN_TMUX_SESSION : undefined) || envValue("EMBERVY_TMUX_SESSION") || (BRAIN_HARNESS ? "brain" : "embervy");
const TERMINAL_TMUX_SOCKET = BRAIN_HARNESS
  ? brainTmuxSocket(process.env.BRAIN_TMUX_SOCKET || envValue("EMBERVY_TMUX_SOCKET"))
  : tmuxSocket(envValue("EMBERVY_TMUX_SOCKET"));
const ACTIVITY_TOKENS_FILE = process.env.ACTIVITY_TOKENS_FILE
  || `${houseHome(process.env, existsSync)}/state/watchdog_state.json`;
const ACTIVITY_EVENTS_FILE = join(DATA_DIR, "activity", "events.jsonl");
const ACTIVITY_FLIGHT_FILE = join(DATA_DIR, "activity", "flight.jsonl");
const ACTIVITY_CACHE_MS = 1000;
const STALLED_HEAD_MS = 60_000;
function headLabel(head: string | undefined): string {
  if (!head) return "";
  const known: Record<string, string> = { claude: "Claude", gpt: "GPT", kimi: "Kimi", grok: "Grok" };
  return known[head.toLowerCase()] ?? head;
}
let activityCache: { observedAt: number; response: ActivityResponse } | null = null;
let activityPending: Promise<ActivityResponse> | null = null;
let activityState: ActivityState | null = null;
let activitySince = Date.now();
let activityPaneFingerprint: string | null = null;
let activityPaneChangedAt = 0;
type ActivityResponse = { state: ActivityState; since: string; task?: string; tokens?: number; percent?: number; turnOut?: number; turnOutEstimated?: boolean; helperOut?: number; waitingTasks?: { description: string; kind: string; since: string; tokens?: number }[]; queued?: number; stalledHead?: string };

// A signed timestamp keeps the password out of the cookie and limits a stolen cookie's lifetime.
const SESSION_MAX_AGE_MS = positiveFiniteSetting(process.env.APP_SESSION_MAX_AGE_MS, 2_592_000_000); // 30 days
// There is no server-side session store, so expiry is the only way to revoke a stolen cookie.
if (APP_PASSWORD === "DEV_INSECURE_OPEN") {
  process.stderr.write(
    "embervy-app: FATAL — APP_PASSWORD=DEV_INSECURE_OPEN is forbidden.\n" +
    "Set a real APP_PASSWORD and APP_SESSION_SECRET; for local development use EMBERVY_TRUST_SAME_HOST=1.\n",
  );
  process.exit(1);
}
if (APP_PASSWORD && !APP_SESSION_SECRET) {
  process.stderr.write(
    "embervy-app: FATAL — APP_PASSWORD is set but APP_SESSION_SECRET is empty.\n" +
    "Generate one with: openssl rand -base64 48\n" +
    "and add it to your .env. Refusing to start in legacy plaintext-cookie mode.\n",
  );
  process.exit(1);
}
if (!APP_PASSWORD) {
  process.stderr.write(
    "embervy-app: FATAL — APP_PASSWORD is empty.\n" +
    "Set APP_PASSWORD (and APP_SESSION_SECRET) in your .env before starting.\n" +
    "For local development use EMBERVY_TRUST_SAME_HOST=1 with a real password and session secret.\n",
  );
  process.exit(1);
}

async function hmacSign(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return bufferTimingSafeEqual(digest(a), digest(b));
}

/** Constant-time compare over SHA-256 hashes, so neither a matching prefix nor
 * the token's length leaks through timing. */
function bearerMatches(header: string, token: string): boolean {
  return timingSafeEqual(header, `Bearer ${token}`);
}

// HTTP requests and WebSocket upgrades must apply the same cookie bypass rules.
function trustedWithoutCookie(header: (name: string) => string | null | undefined): boolean {
  const fromCloudflare = !!header("cf-ray") || !!header("cf-connecting-ip");
  return TRUST_SAME_HOST && !fromCloudflare;
}

// Count failed logins per source (cf-connecting-ip or local), grouping IPv6
// by /64 to prevent address rotation; global limits exempt known devices
// so strangers cannot lock out the owner.
const AUTH_SOURCES_MAX = 1000;
const AUTH_GLOBAL_WINDOW_MS = 60_000;
const AUTH_GLOBAL_MAX_SOURCES = 100;
const authFails = new Map<string, { count: number; lockedUntil: number }>();
const authKnownGood = new Set<string>();
let authRecentFails: { at: number; source: string }[] = [];
function ipv6Slash64(ip: string): string {
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1); // IPv4-mapped
  const [head, tail] = ip.split("::");
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = tail === undefined ? front : [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}
function authSource(header: (name: string) => string | null | undefined): string {
  const ip = (header("cf-connecting-ip") || "").trim().toLowerCase();
  if (!ip) return "local";
  return ip.includes(":") ? ipv6Slash64(ip) : ip;
}
function authLockedFor(source: string, now: number): number {
  authRecentFails = authRecentFails.filter((f) => now - f.at < AUTH_GLOBAL_WINDOW_MS);
  const own = authFails.get(source)?.lockedUntil ?? 0;
  const wave = !authKnownGood.has(source) && new Set(authRecentFails.map((f) => f.source)).size >= AUTH_GLOBAL_MAX_SOURCES;
  const global = wave ? authRecentFails[0].at + AUTH_GLOBAL_WINDOW_MS : 0;
  return Math.max(own, global) > now ? Math.max(own, global) : 0;
}
function noteAuthFailure(source: string, now: number): void {
  const entry = authFails.get(source) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  entry.lockedUntil = now + Math.min(2 ** entry.count, 60) * 1000;
  authFails.delete(source); // re-insert: the map's order is the eviction order
  authFails.set(source, entry);
  if (authFails.size > AUTH_SOURCES_MAX) authFails.delete(authFails.keys().next().value!);
  authRecentFails.push({ at: now, source });
}
function noteAuthSuccess(source: string): void {
  authFails.delete(source);
  authKnownGood.delete(source); // re-insert: newest last, oldest evicted first
  authKnownGood.add(source);
  if (authKnownGood.size > AUTH_SOURCES_MAX) authKnownGood.delete(authKnownGood.values().next().value!);
}

async function makeSessionToken(): Promise<string> {
  const ts = Date.now();
  return `${ts}.${await hmacSign(APP_SESSION_SECRET, String(ts))}`;
}

async function verifySessionToken(token: string): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const tsStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const ts = Number(tsStr);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > SESSION_MAX_AGE_MS) return false;
  const expected = await hmacSign(APP_SESSION_SECRET, tsStr);
  return timingSafeEqual(sig, expected);
}

function readSessionCookie(cookieHeader: string): string {
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : "";
}

async function isAuthenticatedFromCookie(cookieHeader: string): Promise<boolean> {
  const token = readSessionCookie(cookieHeader);
  return verifySessionToken(token);
}
const USER_LABEL = process.env.USER_LABEL ?? "User";
const AGENT_LABEL = process.env.AGENT_LABEL ?? process.env.SYNTH_LABEL ?? "Agent";
const APP_PORT = Number(envValue("EMBERVY_APP_PORT") ?? "3030");
const APP_HOST = envValue("EMBERVY_APP_HOST") ?? "127.0.0.1";

import webpush from "web-push";
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

function loadSubscriptions(): any[] {
  try {
    return JSON.parse(readFileSync(PUSH_SUBS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveSubscriptions(subs: any[]) {
  writeFileSync(`${PUSH_SUBS_FILE}.tmp`, JSON.stringify(subs, null, 2));
  renameSync(`${PUSH_SUBS_FILE}.tmp`, PUSH_SUBS_FILE);
}

async function sendPushToAll(title: string, body: string) {
  const subs = loadSubscriptions();
  const dead = new Set<string>();

  for (let i = 0; i < subs.length; i++) {
    if (!acceptedPushEndpoint(subs[i]?.endpoint)) continue;
    try {
      await webpush.sendNotification(
        subs[i],
        JSON.stringify({ title, body: body.slice(0, 200) })
      );
    } catch (err: any) {
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        dead.add(subs[i].endpoint);
      } else {
        process.stderr.write(`embervy-app: push error: ${err}\n`);
      }
    }
  }

  if (dead.size > 0) {
    // Synchronous read and commit share the subscribe route's event-loop serialization.
    const cleaned = loadSubscriptions().filter((sub) => !dead.has(sub.endpoint));
    saveSubscriptions(cleaned);
  }
}

function generateId(): string {
  return crypto.randomUUID();
}

function appendToOutbox(msg: { id: string; text: string; ts: string; type?: string }) {
  appendFileSync(OUTBOX, JSON.stringify(msg) + "\n");
}

function readNewOutboxEntries(afterTs?: string, all = false): any[] {
  try {
    const lines = readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean);
    const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (afterTs) {
      return entries.filter((e) => e.ts > afterTs);
    }
    return all ? entries : entries.slice(-200); // History stays bounded while quotes can reach older messages.
  } catch {
    return [];
  }
}

// Repeated IDs must not create another message or push, even after a restart.
const DELIVERED_ID_MEMORY = 2000;
const deliveredIds = new Set<string>();
function rememberDeliveredId(id: string): void {
  deliveredIds.add(id);
  if (deliveredIds.size > DELIVERED_ID_MEMORY) {
    const oldest = deliveredIds.values().next().value;
    if (oldest !== undefined) deliveredIds.delete(oldest);
  }
}
try {
  const lines = readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean).slice(-DELIVERED_ID_MEMORY);
  for (const line of lines) {
    try {
      const id = JSON.parse(line)?.id;
      if (typeof id === "string" && id) rememberDeliveredId(id);
    } catch { /* a broken line holds no id */ }
  }
} catch { /* no outbox yet */ }

function readInboxEntries(all = false): any[] {
  try {
    const lines = readFileSync(INBOX, "utf8").trim().split("\n").filter(Boolean);
    const entries = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return all ? entries : entries.slice(-200);
  } catch {
    return [];
  }
}

const wsClients = new Set<any>();
let lastClientPing = 0;
const WS_SESSION_EXPIRED = 4001;
const wsExpiryTimers = new Map<any, ReturnType<typeof setTimeout>>();
function wsSessionActive(ws: any): boolean {
  if (ws.data?.sessionExpiresAt == null || Date.now() < ws.data.sessionExpiresAt) return true;
  clearTimeout(wsExpiryTimers.get(ws));
  wsExpiryTimers.delete(ws);
  wsClients.delete(ws);
  unsubscribeTerminal(ws);
  ws.close(WS_SESSION_EXPIRED, "Session expired");
  return false;
}
function sendToClient(ws: any, data: string) {
  if (wsSessionActive(ws)) ws.send(data);
}
function scheduleWsExpiry(ws: any) {
  if (ws.data?.sessionExpiresAt == null || !wsSessionActive(ws)) return;
  // Long sessions use bounded timers because JavaScript timers overflow beyond a signed 32-bit delay.
  wsExpiryTimers.set(ws, setTimeout(() => scheduleWsExpiry(ws), Math.min(2_147_483_647, ws.data.sessionExpiresAt - Date.now())));
}

function broadcastToClients(msg: any) {
  const data = JSON.stringify(msg.type === "message" && msg.data ? { ...msg, data: sanitizeMessageForClient(msg.data) } : msg);
  for (const ws of wsClients) {
    try {
      sendToClient(ws, data);
    } catch {
      wsClients.delete(ws);
    }
  }
}

const terminalSubscribers = new Set<any>();
const TERMINAL_PREFERENCES_FILE = join(DATA_DIR, "terminal-panel-settings.json");
const terminalPanelPreferences = new Map<string, boolean>();
const terminalInputPreferences = new Map<string, boolean>();
try {
  const stored = JSON.parse(readFileSync(TERMINAL_PREFERENCES_FILE, "utf8"));
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === "boolean") terminalPanelPreferences.set(key, value);
    else if (value && typeof value === "object" && "panel" in value && typeof value.panel === "boolean") {
      terminalPanelPreferences.set(key, value.panel);
      if ("input" in value && typeof value.input === "boolean") terminalInputPreferences.set(key, value.input);
    }
  }
} catch { /* defaults on until a user saves the setting */ }
let terminalTimer: ReturnType<typeof setInterval> | null = null;
let terminalInputChain: Promise<void> = Promise.resolve();
let terminalCaptureInFlight = false;
let terminalAliveAt = 0;

type TerminalView = "log" | "tui";
const terminalLastHash = new Map<TerminalView, string>();
const terminalLastFrame = new Map<TerminalView, string>();

function terminalViewOf(ws: any): TerminalView {
  return ws?.data?.terminalView === "tui" ? "tui" : "log";
}

function terminalPreferenceKey(cookieHeader: string): string {
  const token = readSessionCookie(cookieHeader);
  return token ? Bun.hash(token).toString() : "dev-open";
}

function terminalEnabledFor(key: string): boolean {
  return TERMINAL_PANEL_ENABLED && terminalPanelPreferences.get(key) !== false;
}

function terminalInputEnabledFor(key: string): boolean {
  return terminalInputPreferences.get(key) === true && terminalEnabledFor(key);
}

function saveTerminalPreferences(): void {
  const stored: Record<string, boolean | { panel: boolean; input: boolean }> = {};
  for (const [key, enabled] of terminalPanelPreferences) {
    stored[key] = terminalInputPreferences.has(key)
      ? { panel: enabled, input: terminalInputPreferences.get(key) === true }
      : enabled;
  }
  for (const [key, enabled] of terminalInputPreferences) {
    if (!(key in stored)) stored[key] = { panel: terminalPanelPreferences.get(key) !== false, input: enabled };
  }
  writeFileSync(TERMINAL_PREFERENCES_FILE, JSON.stringify(stored));
}

function terminalCommand(command: "capture-pane" | "send-keys", args: string[]): string[] {
  return tmuxCommand([command, "-t", TERMINAL_TMUX_SESSION, ...args], TERMINAL_TMUX_SOCKET);
}

async function captureTerminal(args: string[]): Promise<string> {
  // Join wrapped prose so the browser can wrap whole words, but preserve the CLI's fixed-width screen layout.
  const joinWrapped = BRAIN_HARNESS ? ["-J"] : [];
  const proc = Bun.spawn(terminalCommand("capture-pane", ["-p", "-e", ...joinWrapped, ...args]), { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error("terminal capture failed");
  return text;
}

async function sendTerminalInput(input: TerminalInput): Promise<void> {
  const proc = Bun.spawn(terminalCommand("send-keys", mapTerminalInput(input)), {
    stdout: "ignore", stderr: "pipe",
  });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 5000);
  try {
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(stderr.trim() || "terminal input failed (tmux client timed out after 5s)");
  } finally {
    clearTimeout(timer);
  }
}

function rotateActivityFile(path: string): void {
  try {
    if (statSync(path).size > ACTIVITY_FLIGHT_MAX_BYTES) {
      renameSync(path, ACTIVITY_FLIGHT_ROTATED);
    }
  } catch {}
}

function readActivityEvents(path: string): Record<string, unknown>[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((event): event is Record<string, unknown> => !!event && typeof event === "object");
  } catch {
    return [];
  }
}

function readTerminalInputActivity(): Record<string, unknown>[] {
  return [...readActivityEvents(ACTIVITY_FLIGHT_ROTATED), ...readActivityEvents(ACTIVITY_FLIGHT)]
    .slice(-ACTIVITY_FLIGHT_MAX_EVENTS);
}

function readActivityHookEvents(): ActivityEvent[] {
  try {
    return readFileSync(ACTIVITY_EVENTS_FILE, "utf8").split("\n").slice(-500).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean) as ActivityEvent[];
  } catch { return []; }
}

type SideProcess = { description: string; kind: string; since: string; tokens?: number };
function readActivityTokens(): { tokens: number; percent?: number; turnOut?: number; turnOutEstimated?: boolean; helperOut?: number; waitingTasks?: SideProcess[]; turnStartedAt?: number; brainTool?: string; queued?: number; lastEventAt?: number; head?: string } | undefined {
  if (!ACTIVITY_TOKENS_FILE) return undefined;
  try {
    const state = JSON.parse(readFileSync(ACTIVITY_TOKENS_FILE, "utf8"));
    if (!(typeof state.tokens === "number" && Number.isFinite(state.tokens))) return undefined;
    const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined);
    const turnOut = count(state.turn_output_tokens), helperOut = count(state.turn_helper_tokens);
    const windowLive = count(state.window_live_tokens), cold = count(state.turn_cold_tokens);
    const down = cold ?? turnOut;
    const waitingTasks: SideProcess[] = Array.isArray(state.pending_tasks)
      ? state.pending_tasks
          .filter((p: any) => p && typeof p.description === "string" && typeof p.since === "string")
          .slice(0, 4)
          .map((p: any) => ({ description: p.description.slice(0, 120), kind: typeof p.kind === "string" ? p.kind : "background", since: p.since,
            ...(typeof p.tokens === "number" && p.tokens > 0 ? { tokens: Math.floor(p.tokens) } : {}) }))
      : [];
    // Activity changes within a turn must not reset its elapsed time.
    const turnStartedAt = typeof state.turn_started_at === "string" ? Date.parse(state.turn_started_at) : NaN;
    const brainTool = typeof state.tool === "string" && state.tool.trim() ? state.tool.trim().slice(0, 60) : undefined;
    const queued = count(state.queued);
    const lastEventAt = typeof state.last_event_ts === "string" ? Date.parse(state.last_event_ts) : NaN;
    const head = typeof state.head === "string" && state.head.trim() ? state.head.trim().slice(0, 30) : undefined;
    const tokens = windowLive && windowLive > 0 ? windowLive : state.tokens;
    const cut = count(state.cut_tokens);
    const percent = cut && cut > 0 ? Math.floor((tokens * 100) / cut) : count(state.percent);
    return { tokens, ...(percent === undefined ? {} : { percent }), ...(Number.isFinite(turnStartedAt) ? { turnStartedAt } : {}), ...(down === undefined ? {} : { turnOut: down }), ...(state.turn_output_estimated === true ? { turnOutEstimated: true } : {}), ...(helperOut === undefined ? {} : { helperOut }), ...(waitingTasks.length ? { waitingTasks } : {}),
      ...(brainTool ? { brainTool } : {}), ...(queued ? { queued: Math.floor(queued) } : {}), ...(Number.isFinite(lastEventAt) ? { lastEventAt } : {}), ...(head ? { head } : {}) };
  } catch { return undefined; }
}

function recordActivityTransition(state: ActivityState): void {
  try {
    mkdirSync(join(DATA_DIR, "activity"), { recursive: true });
    if (existsSync(ACTIVITY_FLIGHT_FILE) && statSync(ACTIVITY_FLIGHT_FILE).size > 1_048_576) {
      try { unlinkSync(`${ACTIVITY_FLIGHT_FILE}.old`); } catch {}
      renameSync(ACTIVITY_FLIGHT_FILE, `${ACTIVITY_FLIGHT_FILE}.old`);
    }
    appendFileSync(ACTIVITY_FLIGHT_FILE, JSON.stringify({ ts: new Date().toISOString(), state }) + "\n");
  } catch {}
}

async function observeActivity(): Promise<ActivityResponse> {
  const now = Date.now();
  let paneText = "";
  let processRunning = false;
  // Brain's pane is its live view, free text: a line there that starts with a
  // dot is a sentence or a helper count, not Claude Code's spinner. Brain
  // reports an open turn and its tool itself, below.
  if (!BRAIN_HARNESS) try {
    const proc = Bun.spawn(tmuxCommand(["list-panes", "-t", TERMINAL_TMUX_SESSION, "-F", "__PROC__#{pane_current_command}", ";", "capture-pane", "-p", "-t", TERMINAL_TMUX_SESSION, "-S", "-120"], TERMINAL_TMUX_SOCKET), { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error("tmux session unavailable");
    const lines = output.split("\n");
    processRunning = lines.some((line) => line.startsWith("__PROC__") && /\b(?:claude|claude-code)\b/i.test(line));
    // The pane may report its bash wrapper; check the process table before declaring idle.
    if (!processRunning) {
      try { processRunning = housePids(["-x", "claude"], houseHome(process.env, existsSync)).length > 0; } catch {}
    }
    paneText = lines.filter((line) => !line.startsWith("__PROC__")).join("\n");
  } catch {}

  const fingerprint = paneText.slice(-4000);
  if (activityPaneFingerprint === null) activityPaneFingerprint = fingerprint;
  else if (fingerprint !== activityPaneFingerprint) {
    activityPaneFingerprint = fingerprint;
    activityPaneChangedAt = now;
  }
  const input = { paneText, processRunning, paneChangedAt: activityPaneChangedAt, now };
  const events = readActivityHookEvents();
  const state = classifyObservedActivity(events, input, now);
  const latest = events.map((event) => ({ event, at: Date.parse(event.ts) }))
    .filter(({ at }) => Number.isFinite(at) && at <= now)
    .sort((a, b) => a.at - b.at).at(-1);
  const hookState = classifyFromEvents(events, now);
  if (state !== activityState) {
    activityState = state;
    activitySince = hookState && latest ? latest.at : now;
    recordActivityTransition(state);
  }
  const hookTool = hookState === "tool" && latest?.event.event === "tool_start" ? latest.event.tool : undefined;
  const read = readActivityTokens();
  const { turnStartedAt, brainTool, lastEventAt, head, ...numbers } = read ?? {};
  const since = turnStartedAt !== undefined && turnStartedAt <= now ? turnStartedAt : activitySince;
  // An open turn can be working even when its terminal screen is still.
  const tool = brainTool ?? hookTool;
  const turnOpen = lastEventAt !== undefined;
  const shown: ActivityState = brainTool ? "tool" : turnOpen && (state === "idle" || state === "done") ? "thinking" : state;
  const stalled = shown === "thinking" && turnOpen && now - lastEventAt > STALLED_HEAD_MS;
  return {
    state: shown,
    since: new Date(since).toISOString(),
    ...(tool ? { task: tool } : {}),
    ...(read ? numbers : {}),
    ...(stalled ? { stalledHead: headLabel(head) } : {}),
  };
}

function getActivity(): Promise<ActivityResponse> {
  const now = Date.now();
  if (activityCache && now - activityCache.observedAt < ACTIVITY_CACHE_MS) return Promise.resolve(activityCache.response);
  if (activityPending) return activityPending;
  activityPending = observeActivity().then((response) => {
    activityCache = { observedAt: Date.now(), response };
    return response;
  }).finally(() => { activityPending = null; });
  return activityPending;
}

function logTerminalInput(input: TerminalInput): void {
  const event = {
    ts: new Date().toISOString(),
    state: "terminal-input",
    source: "terminal-input",
    detail: terminalInputActivityDetail(input),
  };
  try {
    // Activity events have their own bounded append-only path. The watchdog's
    // state file is foreign-owned and is deliberately never read or rewritten.
    mkdirSync(ACTIVITY_DIR, { recursive: true });
    rotateActivityFile(ACTIVITY_FLIGHT);
    appendFileSync(ACTIVITY_FLIGHT, JSON.stringify(event) + "\n");
  } catch {}
}

function brainLogDir(): string {
  let text = "";
  for (const file of BRAIN_ENV_FILES) {
    try { text += `${readFileSync(file, "utf8")}\n`; } catch { /* absent: the next file */ }
  }
  const set = envValues(text, ["BRAIN_LOG_DIR"]).BRAIN_LOG_DIR ?? process.env.BRAIN_LOG_DIR;
  return set?.trim() || join(BRAIN_DIR, "logs");
}

function terminalLogLabels(): LogLabels {
  return {
    appMessage: S("terminal.log.appMessage"),
    result: S("terminal.log.result"),
    context: S("terminal.log.context"),
    sessionBoundary: S("terminal.log.sessionBoundary"),
    error: S("terminal.log.error"),
    truncated: S("terminal.log.truncated"),
    change: S("terminal.log.change"),
    changeNumber: S("terminal.log.changeNumber"),
    unchangedLine: S("terminal.log.unchangedLine"),
    unchangedLines: S("terminal.log.unchangedLines"),
    helper: S("terminal.log.helper"),
    background: S("terminal.log.background"),
    finished: S("terminal.log.finished"),
    stopped: S("terminal.log.stopped"),
    systemNote: S("terminal.log.systemNote"),
    bridge: S("terminal.log.bridge"),
  };
}

function houseTimeZone(): string | undefined {
  const set = envValue("EMBERVY_TIMEZONE") || process.env.TZ;
  if (set?.trim()) return set.trim();
  let text = "";
  for (const file of BRAIN_ENV_FILES) {
    try { text += `${readFileSync(file, "utf8")}\n`; } catch { /* absent: the next file */ }
  }
  return envValues(text, ["BRAIN_TIMEZONE"]).BRAIN_TIMEZONE?.trim() || undefined;
}

function terminalLogEntries(): LogEntry[] {
  const options = { names: { self: AGENT_LABEL, user: USER_LABEL }, labels: terminalLogLabels(), timeZone: houseTimeZone() };
  return BRAIN_HARNESS
    ? brainLogEntries(brainLogDir(), options)
    : claudeLogEntries(claudeProjectDir(houseHome(process.env, existsSync), process.env), options);
}

function terminalLogItem(entry: LogEntry) {
  return entry.kind === "tool"
    ? { key: entry.key, summary_html: ansiToHtml(entry.summary), body_html: entry.body.split("\n").map(ansiToHtml).join("<br>"), error: entry.error }
    : { key: entry.key, html: ansiToHtml(entry.text) };
}

const TERMINAL_LOG_TAIL = 150;

async function terminalViewFrame(view: TerminalView): Promise<{ hash: string; frame: () => string }> {
  if (view === "tui") {
    const raw = await captureTerminal([]);
    return {
      hash: Bun.hash(raw).toString(),
      frame: () => JSON.stringify({ type: "terminal-frame", mode: "tui", lines: raw.replace(/\n$/, "").split("\n").map(ansiToHtml), ts: new Date().toISOString() }),
    };
  }
  const tail = terminalLogEntries().slice(-TERMINAL_LOG_TAIL);
  return {
    hash: Bun.hash(JSON.stringify(tail)).toString(),
    frame: () => JSON.stringify({ type: "terminal-frame", mode: "log", items: tail.map(terminalLogItem), tail_count: tail.length, ts: new Date().toISOString() }),
  };
}

async function pushTerminalFrame() {
  if (!TERMINAL_PANEL_ENABLED || terminalSubscribers.size === 0 || terminalCaptureInFlight) return;
  terminalCaptureInFlight = true;
  try {
    const all = [...terminalSubscribers];
    const healthy = new Set<TerminalView>();
    for (const view of ["log", "tui"] as const) {
      const subs = all.filter((ws) => terminalViewOf(ws) === view);
      if (!subs.length) continue;
      let current: { hash: string; frame: () => string };
      try { current = await terminalViewFrame(view); } catch { continue; /* the client's freshness line reports it */ }
      healthy.add(view);
      if (current.hash === terminalLastHash.get(view)) continue;
      terminalLastHash.set(view, current.hash);
      const data = current.frame();
      terminalLastFrame.set(view, data);
      for (const ws of subs) {
        try { sendToClient(ws, data); } catch { terminalSubscribers.delete(ws); }
      }
    }
    // Unchanged views need a heartbeat so the client does not mistake silence for a lost connection.
    if (Date.now() - terminalAliveAt > 2500) {
      terminalAliveAt = Date.now();
      const alive = JSON.stringify({ type: "terminal-alive", ts: new Date().toISOString() });
      for (const ws of all) {
        if (!healthy.has(terminalViewOf(ws))) continue;
        try { sendToClient(ws, alive); } catch { terminalSubscribers.delete(ws); }
      }
    }
  } finally { terminalCaptureInFlight = false; }
  if (terminalSubscribers.size === 0) stopTerminalStream();
}

function startTerminalStream() {
  if (!TERMINAL_PANEL_ENABLED || terminalTimer || terminalSubscribers.size === 0) return;
  terminalLastHash.clear();
  void pushTerminalFrame();
  terminalTimer = setInterval(pushTerminalFrame, 1000);
}

function stopTerminalStream() {
  if (terminalSubscribers.size > 0 || !terminalTimer) return;
  clearInterval(terminalTimer);
  terminalTimer = null;
  terminalLastHash.clear();
  terminalLastFrame.clear();
}

function unsubscribeTerminal(ws: any) {
  terminalSubscribers.delete(ws);
  stopTerminalStream();
}

const app = new Hono();
const PEERS = peerConfigsFromEnv(process.env);

// Restrict scripts to same-origin files so injected markup cannot run code.
// A route's stricter policy takes precedence.
const CONTENT_SECURITY_POLICY = "script-src 'self'; img-src 'self' data: blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'";
app.use("*", async (c, next) => {
  await next();
  const headers: Record<string, string> = {};
  if (!c.res.headers.has("Content-Security-Policy")) headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY;
  // A share is public to whoever holds the link, but a shared cache must not keep a copy
  // once the file is withdrawn. A route's own private or no-store answer stays as it is.
  const shareCache = c.req.path.startsWith("/share/") ? c.res.headers.get("Cache-Control") : undefined;
  if (shareCache !== undefined && !(shareCache && /(?:^|,)\s*(?:private|no-store)\b/i.test(shareCache))) {
    headers["Cache-Control"] = shareCache
      ? /(?:^|,)\s*public\b/i.test(shareCache) ? shareCache.replace(/\bpublic\b/gi, "private") : `private, ${shareCache}`
      : "private";
  }
  try {
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  } catch {
    // A proxied fetch() answer has read-only headers: copy it once.
    c.res = new Response(c.res.body, c.res);
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  }
});

// The login page's script, served without a session (the page may carry no
// inline code under the policy above).
const LOGIN_JS = `(() => {
  const pw = document.getElementById("pw");
  const err = document.getElementById("err");
  async function login() {
    const res = await fetch("/api/auth", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw.value }) });
    if (res.ok) location.reload(); else err.style.display = "block";
  }
  document.getElementById("enter").addEventListener("click", login);
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
})();
`;

app.use("*", async (c, publicNext) => {
  const path = c.req.path;
  const next = async () => {
    await publicNext();
    // Authenticated responses stay out of shared caches without changing browser freshness.
    const cache = c.res.headers.get("Cache-Control");
    if (cache && /(?:^|,)\s*(?:private|no-store)\b/i.test(cache)) return;
    const value = cache
      ? /(?:^|,)\s*public\b/i.test(cache) ? cache.replace(/\bpublic\b/gi, "private") : `private, ${cache}`
      : "private";
    try { c.res.headers.set("Cache-Control", value); }
    catch {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set("Cache-Control", value);
    }
  };

  // This preference never inherits agent, local or developer trust.
  if (path === "/api/approval-settings" || path === "/api/mailbox-write/settings") {
    if (!await isHumanSession(c)) return c.json({ error: S("email.humanRequired") }, 403);
    return next();
  }

  // Approval requests accept the internal token, but decisions require a human session unless they only expire a request.
  if (path.startsWith("/api/approval/")) {
    const human = !!APP_SESSION_SECRET && await isAuthenticatedFromCookie(c.req.header("cookie") || "").catch(() => false);
    const internal = !!INTERNAL_API_TOKEN && bearerMatches(c.req.header("authorization") || "", INTERNAL_API_TOKEN);
    if (!human && !internal) return c.json({ error: "unauthorized" }, 401);
    if (c.req.method === "POST" && /^\/api\/approval\/[^/]+\/decide$/.test(path) && !human) {
      const body = await c.req.json().catch(() => null);
      if (body?.decision !== "expired") return c.json({ error: "human session required" }, 403);
    }
    return next();
  }

  // Muting is a human decision, and so is signing the server in to a Claude
  // account: neither the agent bearer nor local/dev trust suffices.
  if (path === "/api/doctor/mute" || path.startsWith("/api/brain/claude-signin/") || path.startsWith("/api/brain/chatgpt-signin/")) {
    if (!APP_SESSION_SECRET) return c.json({ error: "unauthorized" }, 401);
    const authenticated = await isAuthenticatedFromCookie(c.req.header("cookie") || "").catch(() => false);
    if (!authenticated) return c.json({ error: "unauthorized" }, 401);
    return next();
  }

  // /api/internal/* is fail-closed: it needs the internal bearer or a valid
  // session; with neither configured, every request gets 500.
  if (path === "/api/internal/mail-inbox") {
    // Mail notifications require the internal bearer so browser sessions cannot impersonate mailbox input.
    if (!INTERNAL_API_TOKEN) return c.json({ error: "INTERNAL_API_TOKEN not configured" }, 503);
    if (!bearerMatches(c.req.header("authorization") || "", INTERNAL_API_TOKEN)) return c.json({ error: "unauthorized" }, 401);
    return next();
  }
  if (path.startsWith("/api/internal/")) {
    if (!INTERNAL_API_TOKEN) {
      return c.json({
        error: "INTERNAL_API_TOKEN not configured on the server. Set it in .env.",
      }, 500);
    }
    const auth = c.req.header("authorization") || "";
    if (bearerMatches(auth, INTERNAL_API_TOKEN)) return next();
    const cookie = c.req.header("cookie") || "";
    if (await isAuthenticatedFromCookie(cookie)) return next();
    return c.json({ error: "unauthorized" }, 401);
  }
  // The internal bearer may read model choices, but switching or restarting requires a human session.
  if (c.req.method === "GET" && path === "/api/brain/heads" && INTERNAL_API_TOKEN && bearerMatches(c.req.header("authorization") || "", INTERNAL_API_TOKEN)) {
    return next();
  }
  if (path.startsWith("/api/external/")) return publicNext();
  if (path.startsWith("/share/")) return publicNext();
  // Calendar phone feed — carries its own token (?token=…), checked in the
  // handler; phones and calendar services cannot log in with a cookie.
  if (isCalendarFeedPath(path)) return publicNext();
  if (path === "/api/email-inbox") return publicNext();
  // Peer input has its own bearer, including when it arrives through the tunnel.
  if (PEERS.length && path === "/api/peer/message") return publicNext();
  // Public liveness probe: the installer's done-gate needs {ok:true} through
  // the tunnel rather than the login page; expose no other information.
  if (path === "/health") return c.json({ ok: true });
  if (path === "/login.js") {
    return c.body(LOGIN_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
  }
  if (path === VIEWER_SCRIPT_PATH) {
    return c.body(VIEWER_JS, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
  }

  if (path !== "/api/auth" && trustedWithoutCookie((name) => c.req.header(name))) return next();


  if (APP_PASSWORD) {
    const cookie = c.req.header("cookie") || "";
    const hasAuth = await isAuthenticatedFromCookie(cookie);

    if (path === "/api/auth") {
      const source = authSource((name) => c.req.header(name));
      const lockedUntil = authLockedFor(source, Date.now());
      if (lockedUntil) {
        const waitS = Math.ceil((lockedUntil - Date.now()) / 1000);
        return c.json({ error: `too many attempts, retry in ${waitS}s` }, 429);
      }
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.password !== "string") {
        return c.json({ error: "password must be a string in a JSON object" }, 400);
      }
      // Constant-time comparison prevents password-prefix guesses through timing.
      if (timingSafeEqual(body.password, APP_PASSWORD)) {
        noteAuthSuccess(source);
        const token = await makeSessionToken();
        const maxAgeS = Math.floor(SESSION_MAX_AGE_MS / 1000);
        return c.json({ ok: true }, 200, {
          "Set-Cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeS}`,
        } as any);
      }
      noteAuthFailure(source, Date.now());
      return c.json({ error: "wrong password" }, 401);
    }

    if (!hasAuth) {
      if (path === "/" || (!path.startsWith("/api/") && !path.startsWith("/ws"))) {
        const lang = loadStrings().language;
        const L = (key: string) => escapeText(S(key));
        return c.html(`<!DOCTYPE html>
<html lang="${escapeText(lang)}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${L("login.pageTitle")}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #F5F0EB; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
  .login { background: white; padding: 32px; border-radius: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; max-width: 300px; width: 90%; }
  h1 { color: #8B7355; font-size: 24px; margin-bottom: 20px; }
  input { width: 100%; padding: 12px; border: 1px solid #E0D8D0; border-radius: 8px; font-size: 16px; box-sizing: border-box; margin-bottom: 12px; }
  button { width: 100%; padding: 12px; background: #8B7355; color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  .error { color: #D32F2F; font-size: 14px; display: none; margin-bottom: 8px; }
</style></head><body>
<div class="login"><h1>Embervy</h1>
<p class="error" id="err">${L("login.wrongPassword")}</p>
<input type="password" id="pw" placeholder="${L("login.password")}" autofocus>
<button id="enter" type="button">${L("login.enter")}</button></div>
<script src="/login.js"></script></body></html>`);
      }
      return c.json({ error: "unauthorized" }, 401);
    }
  }

  return next();
});

const EMBERVY_HOME_DIR = envValue("EMBERVY_HOME") || process.cwd().replace(/\/Claude\/app$/, "");
// House question routes keep terminal choices separate from chat input.
const HOUSE_QUESTION_FILE = join(EMBERVY_HOME_DIR, "state", "house-question.json");
const HOUSE_ANSWER_FILE = join(EMBERVY_HOME_DIR, "state", "house-question-answer.json");
type HouseQuestion = { id: string; text: string; options: { number: number; label: string }[]; enter?: true; readonly?: true; expiresAt: number };
function readHouseQuestion(): HouseQuestion | null {
  try {
    const q = JSON.parse(readFileSync(HOUSE_QUESTION_FILE, "utf8"));
    return q && q.expiresAt > Date.now() ? q : null;
  } catch { return null; }
}
function writeHouseQuestionState(file: string, data: unknown) {
  mkdirSync(join(EMBERVY_HOME_DIR, "state"), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch {}
  }
}
function clearHouseQuestion() {
  for (const file of [HOUSE_QUESTION_FILE, HOUSE_ANSWER_FILE]) {
    try { unlinkSync(file); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
}
function validHouseQuestion(q: any): boolean {
  if (!q || typeof q.text !== "string" || !q.text || q.text.length > 12000 || !Array.isArray(q.options) || q.options.length > 29) return false;
  if ("enter" in q && (q.enter !== true || q.options.length !== 0)) return false;
  if (q.enter === true && q.text.split("\n").some((line: string) => /^(?:(?:❯|>)\s*)?[1-9][0-9]*\s*[.)]\s+.+$/.test(line))) return false;
  if ("readonly" in q && (q.readonly !== true || q.options.length !== 0 || "enter" in q)) return false;
  const lines = q.text.split("\n");
  if (lines.length > 30 || lines.some((line: string) => line !== line.trim() || /[\x00-\x08\x0b-\x1f\x7f]/.test(line))) return false;
  if (q.id !== createHash("sha256").update(q.text).digest("hex")) return false;
  // Informational cards preserve visible numbered prose without turning it into choices.
  if (q.readonly === true) return true;
  const parsed = lines.flatMap((line: string) => {
    const m = /^([1-9][0-9]*)\. (.+)$/.exec(line);
    return m ? [{ number: Number(m[1]), label: m[2] }] : [];
  });
  return JSON.stringify(parsed) === JSON.stringify(q.options) && q.options.every((option: any, index: number) => option.number === index + 1);
}
app.post("/api/internal/house-question", async (c) => {
  if (!INTERNAL_API_TOKEN || !bearerMatches(c.req.header("authorization") || "", INTERNAL_API_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  if (body?.action === "reset") {
    clearHouseQuestion();
  } else if (body?.action === "resolved") {
    if (typeof body.id !== "string") return c.json({ error: "question id required" }, 400);
    if (readHouseQuestion()?.id === body.id) clearHouseQuestion();
  } else if (body?.action === "pending" && validHouseQuestion(body.question)) {
    if (readHouseQuestion()?.id !== body.question.id) {
      clearHouseQuestion();
      writeHouseQuestionState(HOUSE_QUESTION_FILE, { ...body.question, expiresAt: Date.now() + 86400000 });
    }
  } else {
    return c.json({ error: "invalid question" }, 400);
  }
  broadcastToClients({ type: "house-question" });
  return c.json({ ok: true });
});
app.get("/api/house-question", async (c) => {
  if (!await isHumanSession(c)) return c.json({ error: "unauthorized" }, 401);
  c.header("Cache-Control", "no-store");
  return c.json({ question: readHouseQuestion(), submitted: existsSync(HOUSE_ANSWER_FILE) });
});
app.post("/api/house-question/answer", async (c) => {
  if (!await isHumanSession(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json().catch(() => null);
  const q = readHouseQuestion();
  const validAnswer = q?.readonly === true ? false : q?.enter === true
    ? q.options.length === 0 && body?.enter === true && Object.keys(body).length === 2
    : body && !Object.hasOwn(body, "enter") && Number.isInteger(body.number) && q?.options.some(option => option.number === body.number);
  if (!q || body?.id !== q.id || !validAnswer || existsSync(HOUSE_ANSWER_FILE)) {
    return c.json({ error: "question or option no longer available" }, 409);
  }
  writeHouseQuestionState(HOUSE_ANSWER_FILE, q.enter === true ? { id: q.id, enter: true } : { id: q.id, number: body.number });
  broadcastToClients({ type: "house-question" });
  return c.json({ ok: true });
});

async function captureFirstStartPane(): Promise<string> {
  // Between agent sessions the shell's output must not reject messages intended for wake-up.
  if (!await paneHasClaude(TERMINAL_TMUX_SESSION, TERMINAL_TMUX_SOCKET)) return "";
  // Preserve screen rows so wrapped foreign input cannot masquerade as a one-line prompt.
  const proc = Bun.spawn(terminalCommand("capture-pane", ["-p"]), { stdout: "pipe", stderr: "ignore" });
  const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 1000);
  try {
    const text = await new Response(proc.stdout).text();
    return await proc.exited === 0 ? text : "";
  } finally {
    clearTimeout(timer);
  }
}

let lastInputGuardNotice = "";
let lastInputGuardNoticeAt = 0;
const INPUT_GUARD_NOTICE_QUIET_MS = 2 * 60_000;
async function deliverChatMessage(msg: { id: string; text: string; ts: string; type: string }): Promise<boolean> {
  const send = () => { appendFileSync(INBOX, JSON.stringify(msg) + "\n"); };
  if (BRAIN_HARNESS) { send(); return true; }
  // Keep manual terminal input available so the user can answer the question.
  const delivered = await deliverUnlessFirstStart(captureFirstStartPane, send, (text) => {
    // A burst of messages needs one hint, but a later attempt must not look like silence.
    if (lastInputGuardNotice === text && Date.now() - lastInputGuardNoticeAt < INPUT_GUARD_NOTICE_QUIET_MS) return;
    const reply = { id: generateId(), text, ts: new Date().toISOString(), type: "send" };
    appendToOutbox(reply);
    lastInputGuardNotice = text;
    lastInputGuardNoticeAt = Date.now();
    broadcastToClients({ type: "message", data: reply });
  }, envValue("EMBERVY_INPUT_GUARD"));
  if (delivered) lastInputGuardNotice = "";
  return delivered;
}

const TEXT_CLIENT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const TEXT_REPLAY_TTL_MS = 24 * 60 * 60 * 1000;
const TEXT_REPLAY_MAX = 2048;
type TextAnswer = { id: string; blocked?: string };
const textReplays = new Map<string, { expires: number; result: Promise<TextAnswer> }>();

async function acceptTextMessage(text: string, replyTo: ReturnType<typeof cleanReplyTo>, rawClientId: unknown): Promise<TextAnswer> {
  const clientId = !text.startsWith("/") && typeof rawClientId === "string"
    && rawClientId.length <= 64 && TEXT_CLIENT_ID_RE.test(rawClientId) ? rawClientId : "";
  const store = async (): Promise<TextAnswer> => {
    const msg = {
      id: generateId(), text, ts: new Date().toISOString(), type: "text",
      ...(replyTo ? { reply_to: replyTo } : {}),
    };
    const delivered = await deliverChatMessage(msg);
    return { id: msg.id, ...(delivered ? {} : { blocked: "first-start" }) };
  };
  if (!clientId) return store();

  while (true) {
    const now = Date.now();
    for (const [id, entry] of textReplays) {
      if (entry.expires <= now) textReplays.delete(id);
    }
    const known = textReplays.get(clientId);
    if (known) return known.result;
    if (textReplays.size < TEXT_REPLAY_MAX) break;
    const oldest = [...textReplays].find(([, entry]) => entry.expires !== Infinity);
    if (oldest) { textReplays.delete(oldest[0]); break; }
    // Never evict active delivery: an overlapping retry must join its answer.
    await Promise.race([...textReplays.values()].map(entry => entry.result.catch(() => {})));
  }

  // Reserve the id before delivery can yield, including the first-start check.
  const entry = { expires: Infinity, result: Promise.resolve().then(store) };
  textReplays.set(clientId, entry);
  // A blocked message was never stored, so a later retry with the same id must deliver it.
  const forget = () => { if (textReplays.get(clientId) === entry) textReplays.delete(clientId); };
  entry.result.then(answer => { if (answer.blocked) forget(); else entry.expires = Date.now() + TEXT_REPLAY_TTL_MS; }, forget);
  return entry.result;
}

app.post("/api/message", async (c) => {
  const body = await c.req.json();
  const text = body.text?.trim().replace(/^\/cut(?=\s|$)/, "/respawn");
  if (!text) return c.json({ error: "text required" }, 400);

  // Slash commands are answered here and never reach the agent.
  if (text.startsWith("/")) {
    const slashReply = await handleSlashCommand(text);
    if (slashReply !== null) {
      const reply = {
        id: generateId(),
        text: slashReply,
        ts: new Date().toISOString(),
        type: "send",
      };
      // The broadcast route writes the outbox; write here only if it fails to avoid storing the reply twice.
      let broadcasted = false;
      try {
        const r = await fetch(`http://${APP_HOST}:${APP_PORT}/api/internal/broadcast`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.INTERNAL_API_TOKEN
              ? { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` }
              : {}),
          },
          body: JSON.stringify(reply),
        });
        broadcasted = r.ok;
      } catch {}
      if (!broadcasted) appendFileSync(OUTBOX, JSON.stringify(reply) + "\n");
      return c.json({ ok: true, id: reply.id, slash: true });
    }
  }

  // The quoted id lands in an attribute on the page: only a safe one is kept.
  const replyTo = cleanReplyTo(body.reply_to);

  const answer = await acceptTextMessage(text, replyTo, body.client_id);
  return c.json({ ok: true, ...answer });
});

async function handleSlashCommand(text: string): Promise<string | null> {
  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  if (cmd === "/watch") {
    return readWatchdogStatus();
  }

  if (BRAIN_HARNESS) return null;

  if (cmd === "/respawn" && claudeCodeCutAvailable()) {
    await requestClaudeCodeCut();
    return CUT_REQUESTED;
  }

  if (cmd === "/model") {
    return handleGptModelSwitch(args);
  }

  return null;
}

// The adapter pins the model, so switching restarts the adapter with a new
// value, never the agent's session.
const GPT_MODELS: Record<string, string> = {
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
  sol: "gpt-5.6-sol",
};

async function handleGptModelSwitch(args: string): Promise<string> {
  if (BRAIN_HARNESS) return S("model.brain");
  const home = houseHome(process.env, existsSync);
  const port = process.env.GPT_ADAPTER_PORT || "3041";
  const substrate = envValue("EMBERVY_BACKEND") || envValue("EMBERVY_SUBSTRATE") || "";
  if (substrate !== "gpt") return S("model.onlyGpt");
  const current = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).then((d: any) => d.model).catch(() => "unreachable");
  const want = args.trim().toLowerCase();
  if (!want) return S("model.current", { model: current });
  const target = GPT_MODELS[want];
  if (!target) return S("model.unknown", { model: args.trim() });
  if (target === current) return S("model.already", { model: target });
  try {
    const envPath = `${home}/.env`;
    let env = readFileSync(envPath, "utf8");
    env = /^EMBERVY_GPT_MODEL=/m.test(env)
      ? env.replace(/^EMBERVY_GPT_MODEL=.*$/m, `EMBERVY_GPT_MODEL=${target}`)
      : env + `\nEMBERVY_GPT_MODEL=${target}\n`;
    writeFileSync(envPath, env);
    for (const pid of housePids(["-f", "chatgpt-oauth-adapter.ts"], home)) {
      if (ownsProcess(pid, home)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    }
    Bun.spawn(["setsid", "bun", `${home}/shared/tools/chatgpt-oauth-adapter.ts`], {
      cwd: home,
      env: { ...process.env, CHATGPT_AUTH_FILE: chatgptAuthFile(process.env), ADAPTER_MODEL: target, ADAPTER_PORT: port, ADAPTER_EFFORT: envValue("EMBERVY_GPT_EFFORT") || "" },
      stdout: Bun.file(`${home}/logs/chatgpt-oauth-adapter.log`),
      stderr: Bun.file(`${home}/logs/chatgpt-oauth-adapter.log`),
    });
    for (let i = 0; i < 12; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const ok = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).then((d: any) => d.ok && d.model === target).catch(() => false);
      if (ok) return S("model.switched", { model: target });
    }
    return S("model.unconfirmed", { model: target });
  } catch (err) {
    return S("model.failed", { error: String(err) });
  }
}

function readWatchdogStatus(): string {
  const STATE_PATH = process.env.WATCHDOG_STATE_PATH
    ?? `${houseHome(process.env, existsSync)}/state/watchdog_state.json`;
  try {
    const raw = readFileSync(STATE_PATH, "utf-8");
    const s = JSON.parse(raw) as {
      last_check_ts: string;
      tokens: number;
      percent: number | null;
      window?: number | null;
      warn_tokens?: number;
      cut_tokens: number;
      session_file?: string;
      session_id?: string;
      warn_active: boolean;
      last_warn_ts: string;
      last_cut_ts: string;
      pid: number;
    };
    const lastCheckMs = Date.parse(s.last_check_ts);
    const ageS = Number.isFinite(lastCheckMs)
      ? Math.round((Date.now() - lastCheckMs) / 1000)
      : -1;
    const stale = ageS > 120 || ageS < 0;
    const status = stale ? S("watch.stale") : S("watch.alive");
    const tokensFmt = s.tokens.toLocaleString(loadStrings().language);
    const watchText = (key: string, vars: Record<string, string | number>) => translate({
      "watch.contextTokens": "Context: {tokens} tokens",
      "watch.thresholdTokens": "Thresholds: WARN {warn} tokens, CUT {cut} tokens",
      ...loadStrings().strings,
    }, key, vars);
    // Percentages need the head's capacity; a cut threshold is not a window.
    const window = typeof s.window === "number" && Number.isFinite(s.window) && s.window > 0 ? s.window : null;
    const windowLabel = window === 1_000_000 ? "1M" : window?.toLocaleString(loadStrings().language);
    const thresholds = Number.isFinite(s.warn_tokens)
      ? window
        ? S("watch.thresholds", { warn: Math.round(s.warn_tokens! * 100 / window), cut: Math.round(s.cut_tokens * 100 / window) })
        : watchText("watch.thresholdTokens", { warn: s.warn_tokens!.toLocaleString(loadStrings().language), cut: s.cut_tokens.toLocaleString(loadStrings().language) })
      : Number.isFinite(s.cut_tokens) ? S("watch.cutTokens", { tokens: s.cut_tokens.toLocaleString(loadStrings().language) }) : "";
    const session = s.session_file || s.session_id;
    const lines = [
      S("watch.status", { status, age: ageS }),
      window
        ? `${S("watch.context", { tokens: tokensFmt, percent: Math.floor(s.tokens * 100 / window) })} / ${windowLabel} tokens`
        : watchText("watch.contextTokens", { tokens: tokensFmt }),
      thresholds,
      session ? S("watch.session", { file: session }) : "",
      s.warn_active ? (s.last_warn_ts ? S("watch.warnActiveSince", { since: s.last_warn_ts }) : S("watch.warnActive")) : "",
      s.last_cut_ts ? S("watch.lastCut", { ts: s.last_cut_ts }) : "",
    ].filter(Boolean);
    return lines.join("\n");
  } catch (err) {
    return S("watch.unreadable", { path: STATE_PATH, error: err instanceof Error ? err.message : String(err) });
  }
}

// Absolute paths reveal server layout and usernames; clients need only URLs.
function sanitizeMessageForClient(m: any) {
  const { file_path, image_path, audio_path, ...rest } = m;
  // Mail cards must reflect durable delivery state, not fallback text or browser memory.
  if (rest.source === "email-approval" && typeof rest.email_id === "string") {
    Object.assign(rest, mailCardFields(readMailOutbox().find(e => e.id === rest.email_id)));
  }
  return rest;
}

// The proxy keeps the worker's bearer token out of the browser.
const memoryMedia = (kind: "image" | "video") => async (c: any) => {
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) return c.json({ error: `invalid ${kind} id` }, 400);
  if (!EMBERVY_URL || !EMBERVY_API_KEY) return c.json({ error: `memory ${kind} proxy is not configured` }, 503);
  // Videos pass the player's byte range on (Safari on iOS needs 206 answers).
  const range = kind === "video" ? c.req.header("range") : undefined;
  let res: Response;
  try {
    res = await fetch(`${EMBERVY_URL}/${kind}s/${id}`, {
      headers: { Authorization: `Bearer ${EMBERVY_API_KEY}`, ...(range ? { Range: range } : {}) },
      signal: AbortSignal.timeout(kind === "video" ? 60_000 : 20_000),
    });
  } catch (error) {
    console.warn(`[memory-${kind}] worker unreachable: ${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: `${kind} worker unreachable` }, 502);
  }
  if (res.status === 416) {
    return new Response(null, { status: 416, headers: { "content-range": res.headers.get("content-range") || "bytes */0" } });
  }
  if (!res.ok || !res.body) return c.json({ error: `${kind} worker returned HTTP ${res.status}` }, res.status as any);
  // A fixed type per route: an image route only ever answers an image, a
  // video route a video, whatever else the worker might hand back.
  const type = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith(`${kind}/`)) {
    res.body.cancel().catch(() => {});
    return c.json({ error: `${kind} worker returned ${type || "no content type"}` }, 502);
  }
  const headers: Record<string, string> = {
    "content-type": type,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  };
  const length = res.headers.get("content-length");
  if (length) headers["content-length"] = length;
  if (kind === "video") {
    headers["accept-ranges"] = "bytes";
    const contentRange = res.headers.get("content-range");
    if (res.status === 206 && contentRange) headers["content-range"] = contentRange;
  }
  return new Response(res.body, { status: res.status === 206 ? 206 : 200, headers });
};
async function claudeAuthExpired(): Promise<boolean> {
  if (BRAIN_HARNESS) {
    const { state } = claudeAuthContext();
    if (!state) throw new Error("state-unavailable");
    return state.state === "expired";
  }
  // An agent that is working is signed in, whatever its screen quotes.
  if (activityState === "thinking" || activityState === "tool") return false;
  // Only the current screen counts: old scrollback must not keep the banner alive.
  return claudeScreenExpired(await captureTerminal([]));
}
app.get("/api/claude-auth", async (c) => {
  c.header("Cache-Control", "no-store");
  try { return c.json({ expired: await claudeAuthExpired(), kept: BRAIN_HARNESS }); }
  catch { return c.json({ error: S("claudeAuth.error.unavailable") }, 503); }
});
// Each code is named so the translation check sees every key, and an unknown code never reaches the user as a raw key.
function claudeSignInError(code: string | undefined): string {
  switch (code) {
    case "startFailed": return S("claudeAuth.error.startFailed");
    case "noLink": return S("claudeAuth.error.noLink");
    case "invalidCode": return S("claudeAuth.error.invalidCode");
    case "notWaiting": return S("claudeAuth.error.notWaiting");
    case "loginFailed": return S("claudeAuth.error.loginFailed");
    case "unconfirmed": return S("claudeAuth.error.unconfirmed");
    default: return S("claudeAuth.error.finishFailed");
  }
}
let claudeAttempt: { configDir: string | null; at: number } | null = null;
let claudeSignInBusy = false;
app.post("/api/brain/claude-signin/start", async (c) => {
  c.header("Cache-Control", "no-store");
  if (claudeSignInBusy) return c.json({ error: S("claudeAuth.error.busy") }, 409);
  claudeSignInBusy = true;
  try {
    const { configDir } = claudeAuthContext();
    const expired = await claudeAuthExpired().catch(() => false);
    const already = expired ? { signedIn: false } : await claudeSignedIn(localRunner, configDir);
    if (!needsClaudeLogin(expired, already.signedIn)) return c.json({ ok: true, already: true });
    claudeAttempt = null;
    const started = await startClaudeSignIn(localRunner, { configDir });
    if (!started.ok) return c.json({ error: claudeSignInError(started.error) }, 502);
    // Pin the profile to this login; a later head change cannot redirect the code.
    claudeAttempt = { configDir, at: Date.now() };
    return c.json({ ok: true, url: started.url });
  } catch {
    return c.json({ error: S("claudeAuth.error.startFailed") }, 502);
  } finally { claudeSignInBusy = false; }
});
app.post("/api/brain/claude-signin/code", async (c) => {
  c.header("Cache-Control", "no-store");
  if (claudeSignInBusy) return c.json({ error: S("claudeAuth.error.busy") }, 409);
  claudeSignInBusy = true;
  try {
    const waiting = claudeAttempt;
    if (!waiting || Date.now() - waiting.at > 15 * 60_000) return c.json({ error: S("claudeAuth.error.notWaiting") }, 409);
    const body = await c.req.json().catch(() => null);
    const code = typeof body?.code === "string" ? body.code : "";
    const done = await finishClaudeSignIn(localRunner, code, { configDir: waiting.configDir });
    claudeAttempt = null;
    return done.ok ? c.json({ ok: true, detail: S("claudeAuth.done") }) : c.json({ error: claudeSignInError(done.error) }, 400);
  } catch {
    // Never forward exception text: a spawn error can include the pasted code.
    claudeAttempt = null;
    return c.json({ error: S("claudeAuth.error.finishFailed") }, 502);
  } finally { claudeSignInBusy = false; }
});

let chatgptAttempt: { attempt: ChatGptSignInAttempt; at: number } | null = null;
const CHATGPT_ATTEMPT_MS = 15 * 60_000;
function chatgptHouseSettings() {
  let text = "";
  for (const file of BRAIN_ENV_FILES) {
    try { text += `${readFileSync(file, "utf8")}\n`; } catch { /* Try the next house settings file. */ }
  }
  const env = envValues(text, ["BRAIN_STATE_DIR", "CHATGPT_AUTH_FILE", "CHATGPT_ROUTE", ...GPT_HEAD_ENV_KEYS]);
  const stateDir = env.BRAIN_STATE_DIR?.trim() || join(BRAIN_DIR, "state");
  const authFile = env.CHATGPT_AUTH_FILE?.trim() || process.env.CHATGPT_AUTH_FILE || join(stateDir, "chatgpt-auth.json");
  return { env, stateDir, authFile };
}
app.post("/api/brain/chatgpt-signin/start", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!BRAIN_HARNESS) return c.json({ error: "not brain" }, 404);
  chatgptAttempt = null;
  try {
    const { env, authFile } = chatgptHouseSettings();
    const attempt = await startChatGptSignIn({ route: env.CHATGPT_ROUTE ?? process.env.CHATGPT_ROUTE, authFile });
    attempt.authFile = authFile;
    chatgptAttempt = { attempt, at: Date.now() };
    return c.json({ ok: true, url: attempt.signInUrl });
  } catch { return c.json({ error: "Could not prepare ChatGPT sign-in; check the house credential and host-ID files" }, 500); }
});
app.post("/api/brain/chatgpt-signin/code", async (c) => {
  c.header("Cache-Control", "no-store");
  if (!BRAIN_HARNESS) return c.json({ error: "not brain" }, 404);
  const waiting = chatgptAttempt && Date.now() - chatgptAttempt.at < CHATGPT_ATTEMPT_MS ? chatgptAttempt.attempt : null;
  if (!waiting) return c.json({ error: "no sign-in is waiting — ask for a new sign-in link" }, 409);
  const body = await c.req.json().catch(() => ({}));
  const pasted = String((body as { pasted?: unknown })?.pasted ?? "").trim().slice(0, 4000);
  if (!pasted) return c.json({ error: "paste the full address the browser ended on (http://127.0.0.1:1455/…)" }, 400);
  const askedAt = chatgptAttempt!.at;
  try {
    const tokens = await exchangeChatGptCode(pasted, waiting);
    const { env, stateDir, authFile: currentAuthFile } = chatgptHouseSettings();
    const authFile = waiting.authFile || currentAuthFile;
    const model = env.BRAIN_GPT_MODEL?.trim() || "gpt-5.6-sol";
    const probe = await probeChatGpt(tokens, model);
    if (!probe.ok && !(tokens.client_id && !tokens.plan_usage_enabled)) return c.json({ error: probe.detail }, 502);
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    await withCredentialLock(authFile, () => writePrivateText(authFile, chatgptAuthJson(tokens)));
    if (!probe.ok) {
      chatgptAttempt = null;
      return c.json({ error: probe.detail, signed_in: true, plan_usage_enabled: false }, 403);
    }
    const lines = gptHeadEnvLines(env, {
      home: EMBERVY_HOME_DIR, authFile, model,
      cacheKey: `embervy-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    });
    if (lines.length) appendFileSync(BRAIN_ENV_FILES[0]!, `${lines.join("\n")}\n`);
    chatgptAttempt = null;
    return c.json({ ok: true, detail: probe.detail });
  } catch (error) {
    // How long ago the link was asked for tells a stale code from a refused one.
    const minutes = Math.round((Date.now() - askedAt) / 60_000);
    return c.json({ error: `ChatGPT sign-in failed; request a new link and paste the complete redirect URL (link asked for ${minutes} min ago)` }, 400);
  }
});

const HEAR_URL = process.env.EMBERVY_HEAR_URL || "";
const HEAR_PROMPT = process.env.EMBERVY_HEAR_PROMPT || "";
const VOICE_MESSAGES = process.env.EMBERVY_VOICE_MESSAGES === "1";
const VOICE_MIN_BYTES = 2000;
function hearSetting(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}
const HEAR_WAIT_BASE = hearSetting("EMBERVY_HEAR_WAIT_BASE", 30, 0);
const HEAR_WAIT_PER_SECOND = hearSetting("EMBERVY_HEAR_WAIT_PER_SECOND", 2.5, Number.MIN_VALUE);
const HEAR_WAIT_MAX = hearSetting("EMBERVY_HEAR_WAIT_MAX", 600, 45);

function positiveDuration(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

// Probe only messages without a usable duration; dictation needs no extra process.
async function recordingDuration(path: string): Promise<number> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = Bun.spawn([
      "ffprobe", "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", path,
    ], { stdout: "pipe", stderr: "ignore" });
    timer = setTimeout(() => proc?.kill(), 3000);
    const output = new Response(proc.stdout as ReadableStream).text();
    const [code, text] = await Promise.all([proc.exited, output]);
    const duration = Number(text.trim());
    return code === 0 && positiveDuration(duration) ? duration : 0;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

async function hearVoice(path: string, message: boolean, duration = 0): Promise<string> {
  if (!HEAR_URL) return "";
  const unavailable = () => message ? S("voice.hearingUnavailable") : "";
  try {
    if (!positiveDuration(duration) && message) duration = await recordingDuration(path);
    const wait = positiveDuration(duration)
      ? Math.min(HEAR_WAIT_MAX, Math.max(45, HEAR_WAIT_BASE + HEAR_WAIT_PER_SECOND * duration))
      : 45;
    const deadline = Date.now() + Math.ceil(wait * 1000);
    for (let attempt = 0; attempt < 3; attempt++) {
      // Retries share one deadline, including their pauses and response bodies.
      const remaining = deadline - Date.now();
      if (remaining <= 0) return unavailable();
      let res: Response | undefined;
      try {
        res = await fetch(HEAR_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, ...(HEAR_PROMPT ? { prompt: HEAR_PROMPT } : {}), deadline_s: remaining / 1000 }),
          signal: AbortSignal.timeout(remaining),
        });
      } catch (error) {
        const failure = error as { code?: string; cause?: { code?: string } } | null;
        const code = failure?.code || failure?.cause?.code;
        if (code !== "ECONNREFUSED" && code !== "ConnectionRefused") throw error;
      }
      if (res?.ok) {
        const data = await res.json() as { text?: unknown; woven?: unknown } | null;
        const text = typeof data?.text === "string" ? data.text.trim() : "";
        // Without words the woven line is only tone; the caller's fallback is better.
        if (!text) return "";
        console.log(`[hear] heard ${text.split(/\s+/).length} words${message ? " (voice message)" : " (dictation)"}`);
        if (!message) return text;
        return `[Voice message, heard]\n${typeof data?.woven === "string" && data.woven.trim() ? data.woven.trim() : text}`;
      }
      if (res) {
        console.warn(`[hear] HTTP ${res.status}`);
        if (![502, 503, 504].includes(res.status)) return "";
        await res.body?.cancel().catch(() => {});
      }
      const pause = 250 * (attempt + 1);
      if (attempt === 2 || deadline - Date.now() <= pause) return unavailable();
      await new Promise(resolve => setTimeout(resolve, pause));
    }
    return unavailable();
  } catch {
    console.warn("[hear] unavailable");
    return unavailable();
  }
}

const VOICE_MAX_BYTES = 20 * 1024 * 1024;
app.post("/api/voice/transcribe", async (c) => {
  if (!HEAR_URL && (!EMBERVY_URL || !EMBERVY_API_KEY)) return c.json({ error: "voice transcription is not configured" }, 503);
  if (Number(c.req.header("content-length") || 0) > VOICE_MAX_BYTES) return c.json({ error: "recording too large" }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (!bytes.length) return c.json({ error: "empty recording" }, 400);
  if (bytes.length > VOICE_MAX_BYTES) return c.json({ error: "recording too large" }, 413);
  const language = (c.req.query("language") || "").slice(0, 35);
  const type = (c.req.header("content-type") || "application/octet-stream").split(";")[0].trim().slice(0, 100);
  if (HEAR_URL) {
    const ext = type.includes("webm") ? "webm" : /mp4|m4a|aac/.test(type) ? "m4a" : type.includes("ogg") ? "ogg" : "wav";
    const tmp = join(IMAGES_DIR, `dictation-${generateId()}.${ext}`);
    try {
      writeFileSync(tmp, bytes);
      const heard = await hearVoice(tmp, false, Number(c.req.query("duration")));
      if (heard) return c.json({ text: heard });
    } catch (error) {
      console.warn(`[hear] dictation: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
    if (!EMBERVY_URL || !EMBERVY_API_KEY) return c.json({ error: "transcription failed: ears unavailable" }, 502);
  }
  let res: Response;
  try {
    // Below the tunnel's 100 s limit, so a slow answer is ours to report.
    res = await fetch(`${EMBERVY_URL}/transcribe?language=${encodeURIComponent(language)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${EMBERVY_API_KEY}`, "Content-Type": type },
      body: bytes,
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    console.warn(`[voice] worker unreachable: ${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: "transcription worker unreachable" }, 502);
  }
  const data = (await res.json().catch(() => null)) as { text?: unknown; error?: unknown } | null;
  if (!res.ok || typeof data?.text !== "string") {
    const detail = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
    return c.json({ error: `transcription failed: ${detail}` }, res.status === 404 ? 404 : 502);
  }
  return c.json({ text: data.text });
});

app.get(`${MEMORY_IMAGE_PATH}/:id`, memoryMedia("image"));
app.get(`${MEMORY_VIDEO_PATH}/:id`, memoryMedia("video"));

app.get("/api/activity", async (c) => c.json(await getActivity()));

app.get("/api/gpt-model", async (c) => {
  if (BRAIN_HARNESS) return c.json({ substrate: "brain" });
  const substrate = envValue("EMBERVY_BACKEND") || envValue("EMBERVY_SUBSTRATE") || "claude";
  if (substrate !== "gpt") return c.json({ substrate });
  const port = process.env.GPT_ADAPTER_PORT || "3041";
  const model = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.json()).then((d: any) => d.model).catch(() => null);
  return c.json({ substrate, model });
});

app.get("/api/mailbox-write/settings", (c) => {
  c.header("Cache-Control", "private, no-store");
  return c.json({ configured: mailboxWritingSetUp(), enabled: mailboxWritingSetUp() && mailboxWritingEnabled() });
});
app.post("/api/mailbox-write/settings", async (c) => {
  c.header("Cache-Control", "private, no-store");
  if (!mailboxWritingSetUp()) return c.json({ ok: false, error: S("mailboxWrite.notSetUp") }, 403);
  const body = await c.req.json().catch(() => null);
  if (typeof body?.enabled !== "boolean") return c.json({ ok: false, error: S("mailboxWrite.invalidSetting") }, 400);
  try {
    const temp = `${MAILBOX_WRITE_SETTINGS}.${crypto.randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify({ enabled: body.enabled }) + "\n", { mode: 0o600 });
    renameSync(temp, MAILBOX_WRITE_SETTINGS);
    return c.json({ ok: true, configured: true, enabled: body.enabled });
  } catch { return c.json({ ok: false, error: S("mailboxWrite.saveFailed") }, 500); }
});
app.post("/api/internal/mailbox/draft", async (c) => {
  try { requireMailboxWriting(); }
  catch (e: any) { return c.json({ ok: false, error: e.message }, 403); }
  const body = await c.req.json().catch(() => null);
  if (!["to", "subject", "body"].every(key => typeof body?.[key] === "string" && body[key].trim())
    || (body.in_reply_to !== undefined && typeof body.in_reply_to !== "string")) return c.json({ ok: false, error: S("mailboxWrite.invalidDraft") }, 400);
  try {
    const access = await mailboxDraftAccess();
    const result = await access.append({ to: body.to, subject: body.subject, body: body.body, inReplyTo: body.in_reply_to });
    // Provider exceptions can contain credentials; expose only a fixed failure notice.
    return result.ok ? c.json(result) : c.json({ ok: false, error: S("mailboxWrite.draftFailed") }, 502);
  } catch { return c.json({ ok: false, error: S("mailboxWrite.draftFailed") }, 502); }
});

app.post("/api/approval/ask", async (c) => {
  let body = await c.req.json().catch(() => null);
  let draft: Approval["draft"];
  if (body?.draft_id !== undefined) {
    try { requireMailboxWriting(); }
    catch (e: any) { return c.json({ ok: false, error: e.message }, 403); }
    try {
      if (typeof body.draft_id !== "string" || !body.draft_id) throw new Error("draft_id required");
      const access = await mailboxDraftAccess();
      const snapshot = await access.read(body.draft_id);
      // Revocation while a provider read is in flight must not create a new send card.
      requireMailboxWriting();
      draft = { id: body.draft_id, hash: snapshot.hash, account: access.identity };
      body = { title: S("approval.mailDraftTitle"), detail: snapshot.detail, kind: "mail-draft" };
    } catch (e: any) { return c.json({ ok: false, error: e.message }, 400); }
  }
  if (!body || typeof body.title !== "string" || !body.title.trim() || body.title.length > 200
    || (body.detail !== undefined && (typeof body.detail !== "string" || body.detail.length > 2000))
    || (body.kind !== undefined && (typeof body.kind !== "string" || body.kind.length > 40))) {
    return c.json({ error: "invalid approval request" }, 400);
  }
  const entry: Approval = { id: generateId(), title: body.title.trim(), detail: body.detail || "", kind: body.kind || "", status: "pending", ts: new Date().toISOString(), ...(draft ? { draft } : {}) };
  appendFileSync(APPROVALS, JSON.stringify(entry) + "\n");
  const message = { id: entry.id, ts: entry.ts, source: "approval", approval_id: entry.id, text: entry.title, detail: entry.detail };
  appendToOutbox(message);
  broadcastToClients({ type: "message", data: message });
  if (!inQuietHours(new Date(), process.env.APPROVAL_QUIET_HOURS ?? "23-6", houseTimeZone())) {
    void sendPushToAll(S("approval.push"), entry.title).catch(() => {});
  }
  return c.json({ ok: true, id: entry.id });
});
app.post("/api/approval/:id/send-draft", async (c) => {
  try { requireMailboxWriting(); }
  catch (e: any) { return c.json({ ok: false, error: e.message }, 403); }
  try {
    const request = await c.req.json().catch(() => null);
    const access = await mailboxDraftAccess();
    const list = readApprovals();
    const entry = list.find(row => row.id === c.req.param("id"));
    if (!entry?.draft) return c.json({ ok: false, error: "Draft approval not found" }, 404);
    if (request?.draft_id !== entry.draft.id) return c.json({ ok: false, error: "Approval belongs to a different draft" }, 409);
    if (entry.consumed) {
      if (request?.retry_filing === true && entry.draft.account === access.identity) {
        const result = await access.send(entry.draft.id, entry.draft.hash, true);
        return c.json({ ...result, error: result.ok ? undefined : result.detail });
      }
      return c.json({ ok: false, error: "Approval already consumed; do not resend; use retry_filing only to recover IMAP filing" }, 409);
    }
    if (request?.retry_filing === true) return c.json({ ok: false, error: "No consumed send approval; filing recovery does not send mail" }, 409);
    if (!Number.isFinite(Date.parse(entry.ts)) || Date.now() - Date.parse(entry.ts) >= 5 * 60_000) return c.json({ ok: false, status: "expired", error: "Approval expired; not sent" });
    if (entry.status !== "allow") return c.json({ ok: false, status: entry.status, error: `Approval ${entry.status}; not sent` });
    if (!["session", "reaction"].includes(entry.via || "")) return c.json({ ok: false, error: S("email.humanRequired") }, 403);
    if (entry.draft.account !== access.identity) return c.json({ ok: false, error: "Mailbox account changed; not sent" }, 409);
    // Consumption is persisted before provider I/O so concurrent calls cannot reuse approval.
    entry.consumed = true;
    writeFileSync(`${APPROVALS}.tmp`, list.map(row => JSON.stringify(row)).join("\n") + "\n");
    renameSync(`${APPROVALS}.tmp`, APPROVALS);
    const result = await access.send(entry.draft.id, entry.draft.hash);
    return c.json({ ...result, error: result.ok ? undefined : result.detail });
  } catch (e: any) { return c.json({ ok: false, error: e.message }, 500); }
});
app.get("/api/approval/:id", (c) => {
  const entry = readApprovals().find(row => row.id === c.req.param("id"));
  return entry ? c.json(entry) : c.json({ error: "not found" }, 404);
});
app.post("/api/approval/:id/decide", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!["allow", "deny", "expired"].includes(body?.decision)) return c.json({ error: "invalid decision" }, 400);
  const human = !!APP_SESSION_SECRET && await isAuthenticatedFromCookie(c.req.header("cookie") || "").catch(() => false);
  const entry = decideApproval(c.req.param("id"), body.decision, human ? "session" : "internal");
  return entry ? c.json(entry) : c.json({ error: "not found" }, 404);
});

// Filter before bounding the window so menu controls and foreign traffic cannot hide the person's messages.
const inboxHistory = new JsonlHistory(INBOX, 200, m => m.type !== "reaction" && m.ui_origin !== "brain-menu" && !["room", "peer", "scheduled"].includes(m.source));
const outboxHistory = new JsonlHistory(OUTBOX);
app.get("/api/messages", (c) => {
  const inbox = inboxHistory.read()
    .map((m) => sanitizeMessageForClient({ ...m, role: m.source === "email" ? "email" : "user" }));
  const outbox = outboxHistory.read().map((m) => {
    if (m.type === "voice" && !m.audio_url && m.id && isSafeMessageId(m.id)) {
      const mp3 = `/api/images/${m.id}.mp3`;
      const mp3Path = join(IMAGES_DIR, `${m.id}.mp3`);
      if (existsSync(mp3Path)) {
        m.audio_url = mp3;
      }
    }
    return sanitizeMessageForClient({ ...m, role: "assistant" });
  });
  const all = [...inbox, ...outbox].sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  return c.json(all);
});

app.post("/api/push/subscribe", async (c) => {
  const sub = await c.req.json().catch(() => null);
  if (typeof sub?.endpoint !== "string" || !acceptedPushEndpoint(sub.endpoint)) {
    return c.json({ error: "unsupported push endpoint" }, 400);
  }
  const subs = loadSubscriptions();

  const exists = subs.some((s: any) => s.endpoint === sub.endpoint);
  if (!exists) {
    subs.push(sub);
    saveSubscriptions(subs);
  }

  return c.json({ ok: true });
});

const calendarConfig = calendarConfigFromEnv(process.env, { dataDir: DATA_DIR, agentLabel: AGENT_LABEL, userLabel: USER_LABEL });
registerCalendarRoutes(app, calendarConfig);
startExternalPoller(calendarConfig);

app.get("/api/push/vapid-key", (c) => {
  return c.json({ key: VAPID_PUBLIC });
});

// Two doors, one handler. The agent's door always records the reaction as the
// agent's own, so the agent can never approve its own drafts.
app.post("/api/react", async (c) => {
  const body = await c.req.json().catch(() => null);
  // Only a verified session turns a reaction into a tool approval, even when local trust is enabled.
  const human = !!APP_SESSION_SECRET && await isAuthenticatedFromCookie(c.req.header("cookie") || "").catch(() => false);
  if (human && typeof body?.message_id === "string") {
    if (["❤️", "❤"].includes(body.emoji)) decideApproval(body.message_id, "allow", "reaction");
    else if (["👎", "😢"].includes(body.emoji)) decideApproval(body.message_id, "deny", "reaction");
  }
  return recordReaction(c, body, { byAgent: false, human });
});

app.post("/api/internal/react", async (c) => {
  const body = await c.req.json().catch(() => null);
  return recordReaction(c, body, { byAgent: true });
});

function recordReaction(c: any, body: any, opts: { byAgent: boolean; human?: boolean }) {
  const message_id = body?.message_id;
  const emoji = body?.emoji;
  const from = opts.byAgent ? AGENT_LABEL : body?.from;
  if (!message_id || !emoji) return c.json({ error: "message_id and emoji required" }, 400);

  const reaction = {
    message_id,
    emoji,
    from: from || process.env.USER_LABEL || "User",
    ts: new Date().toISOString(),
  };

  const reactionsFile = join(DATA_DIR, "reactions.jsonl");
  appendFileSync(reactionsFile, JSON.stringify(reaction) + "\n");

  broadcastToClients({ type: "reaction", data: reaction });

  if (!opts.byAgent && from !== AGENT_LABEL) {
    const reactInbox = join(DATA_DIR, "reactions-inbox.jsonl");
    const ts = new Date().toISOString();
    appendFileSync(reactInbox, JSON.stringify({
      message_id,
      emoji,
      from,
      ts,
    }) + "\n");
    let snippet = "";
    try {
      const allInbox = readInboxEntries();
      const allOutbox = readNewOutboxEntries();
      const original = [...allInbox, ...allOutbox].find((m: any) => m.id === message_id);
      if (original?.text) {
        snippet = original.text.slice(0, 80).replace(/\n/g, " ");
      }
    } catch {}
    const emojiNames: Record<string, string> = {
      "\u2764\uFE0F": "heart", "\uD83D\uDD25": "fire", "\uD83D\uDE02": "laugh",
      "\uD83D\uDE2E": "Wow", "\uD83D\uDC4D": "thumbsup", "\uD83E\uDD2D": "giggle",
      "\uD83D\uDE48": "shy", "\uD83D\uDE22": "sad",
    };
    const emojiLabel = emojiNames[emoji] || "reaction";
    const reactionText = snippet
      ? `[${emojiLabel}] on: "${snippet}${snippet.length >= 80 ? "..." : ""}"`
      : `[${emojiLabel}]`;
    appendFileSync(INBOX, JSON.stringify({
      id: crypto.randomUUID(),
      text: reactionText,
      ts,
      type: "reaction",
    }) + "\n");

    try {
      const emailId = approvalCardEmailId(String(message_id));
      // Mail decisions require a verified human session even when local trust permits reactions.
      if (emailId && opts.human) {
        const heartLike = ["\u2764\uFE0F", "\uD83D\uDD25", "\uD83D\uDC4D"]; // heart, fire, thumbsup
        const discardLike = ["\uD83D\uDE22"]; // sad
        let action: "send" | "discard" | null = null;
        if (heartLike.includes(emoji)) action = "send";
        else if (discardLike.includes(emoji)) action = "discard";

        if (action) {
          const decision = decideMail(emailId, action);
          if (decision.accepted && action === "send") deliverMail(emailId)
            .catch(err => process.stderr.write(`embervy-app: async send failed: ${err}\n`));
        }
      }
    } catch (err) {
      process.stderr.write(`embervy-app: email-approval relay failed: ${err}\n`);
    }
  }

  return c.json({ ok: true });
}

app.get("/api/reactions", (c) => {
  const reactionsFile = join(DATA_DIR, "reactions.jsonl");
  try {
    const lines = readFileSync(reactionsFile, "utf8").trim().split("\n").filter(Boolean);
    const reactions = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    return c.json(reactions);
  } catch {
    return c.json([]);
  }
});

const { maxBytes: MAX_IMAGE_BYTES, extensions: ALLOWED_IMAGE_EXTS } = mediaPolicy();
const MAX_VOICE_BYTES = positiveFiniteSetting(process.env.MAX_VOICE_BYTES, 20 * 1024 * 1024); // 20 MB
const SERVE_FILENAME_RE = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]{1,8}$/;
// Active file types must download instead of running scripts on the app's origin.
const INLINE_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "heic",
  "pdf", "txt", "md", "json",
  "mp3", "m4a", "ogg", "wav", "mp4", "webm",
]);
function servedInline(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  return dot !== -1 && INLINE_EXTS.has(filename.slice(dot + 1).toLowerCase());
}
// An explicit type, so the file's own (e.g. text/html) never reaches the browser.
const DOWNLOAD_HEADERS = { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment" };

app.post("/api/image", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  const caption = ((formData.get("caption") as string) || "").trim();
  if (!file) return c.json({ error: "file required" }, 400);
  if (file.size > MAX_IMAGE_BYTES) {
    return c.json({ error: `file too large (max ${MAX_IMAGE_BYTES} bytes)` }, 413);
  }

  const id = generateId();
  const originalName = file.name || "upload";
  const rawExt = (originalName.split(".").pop() || "bin").toLowerCase();
  const ext = rawExt;
  if (!/^[a-z0-9]{1,8}$/.test(ext) || !ALLOWED_IMAGE_EXTS.has(ext)) {
    return c.json({ error: `extension .${rawExt} not allowed` }, 415);
  }
  const filename = `${id}.${ext}`;
  const filepath = join(IMAGES_DIR, filename);

  const buffer = await file.arrayBuffer();
  writeFileSync(filepath, Buffer.from(buffer));

  const isImage = /^(jpg|jpeg|png|gif|webp|heic)$/.test(ext);
  const fallbackLabel = isImage ? "[Image]" : `[File: ${originalName}]`;
  const displayText = caption || fallbackLabel;

  const msg: Record<string, any> = {
    id,
    text: displayText,
    file_path: filepath,
    file_name: originalName,
    ts: new Date().toISOString(),
    type: isImage ? "image" : "file",
  };

  if (isImage) {
    msg.image_path = filepath;
    msg.image_url = `/api/images/${filename}`;
  } else {
    msg.file_url = `/api/images/${filename}`;
  }

  appendFileSync(INBOX, JSON.stringify(msg) + "\n");

  return c.json({ ok: true, id, image_url: msg.image_url || msg.file_url });
});

// Recording retries share one promise while running and one persisted ID after restart, so lost answers cannot duplicate delivery.
const RECORDING_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const voiceInFlight = new Map<string, Promise<{ id: string; audio_url: string }>>();
function voiceAlreadyDelivered(voiceId: string): { id: string; audio_url: string } | null {
  if (!existsSync(INBOX)) return null;
  const needle = `"voice_id":"${voiceId}"`;
  const lines = readFileSync(INBOX, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(needle)) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.voice_id === voiceId && entry.id && entry.audio_url) return { id: entry.id, audio_url: entry.audio_url };
    } catch { /* a broken line is not this recording */ }
  }
  return null;
}

app.post("/api/voice", async (c) => {
  const formData = await c.req.formData();
  const audio = formData.get("audio") as File | null;
  const transcript = (formData.get("transcript") as string) || "";
  const rawVoiceId = (formData.get("voice_id") as string) || "";
  const voiceId = RECORDING_ID_RE.test(rawVoiceId) ? rawVoiceId : "";
  console.log(`[voice] upload: ${audio ? `${audio.size} bytes, ${audio.type || "no type"}` : "no audio field"}${voiceId ? `, voice_id ${voiceId}` : ""}`);
  if (!audio) return c.json({ error: "audio required" }, 400);
  // A tap is not a message: nothing silent lands in the history or the archive.
  if (audio.size < VOICE_MIN_BYTES) return c.json({ error: "recording empty" }, 400);
  if (audio.size > MAX_VOICE_BYTES) {
    return c.json({ error: `audio too large (max ${MAX_VOICE_BYTES} bytes)` }, 413);
  }
  if (voiceId) {
    const pending = voiceInFlight.get(voiceId);
    const known = pending ? await pending.catch(() => null) : voiceAlreadyDelivered(voiceId);
    if (known) {
      console.log(`[voice] repeat of ${voiceId}: answered with ${known.id}, not delivered again`);
      return c.json({ ok: true, id: known.id, audio_url: known.audio_url, repeat: true });
    }
  }
  const work = storeAndHearVoice(audio, transcript, formData, voiceId);
  if (voiceId) {
    voiceInFlight.set(voiceId, work);
    work.finally(() => voiceInFlight.delete(voiceId)).catch(() => {});
  }
  const done = await work;
  return c.json({ ok: true, id: done.id, audio_url: done.audio_url });
});

async function storeAndHearVoice(audio: File, transcript: string, formData: FormData, voiceId: string): Promise<{ id: string; audio_url: string }> {
  const id = generateId();
  const ext = audio.type?.includes("webm") ? "webm" : audio.type?.includes("mp4") ? "m4a" : "ogg";
  const filename = `${id}.${ext}`;
  const filepath = join(IMAGES_DIR, filename);

  const buffer = await audio.arrayBuffer();
  writeFileSync(filepath, Buffer.from(buffer));

  // mp3 for iOS Safari. Spawned with an argv array: no shell, no injection.
  const mp3Filename = `${id}.mp3`;
  const mp3Path = join(IMAGES_DIR, mp3Filename);
  try {
    const proc = Bun.spawn(
      ["ffmpeg", "-i", filepath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3Path, "-y"],
      { stdout: "ignore", stderr: "ignore" },
    );
    await proc.exited;
  } catch (err) {
    console.error("ffmpeg conversion failed:", err);
  }
  const serveFilename = existsSync(mp3Path) ? mp3Filename : filename;

  const duration = parseFloat((formData.get("duration") as string) || "0");
  const heard = await hearVoice(existsSync(mp3Path) ? mp3Path : filepath, true, duration);
  // Unheard audio still passes on the device's words, labelled as such.
  const unheard = heard === S("voice.hearingUnavailable");
  const agentText = unheard && transcript ? `${S("voice.unheardTranscript")}\n${transcript}` : heard || transcript || "[Voice message]";

  const msg = {
    id,
    text: agentText, // for the agent; the person's bubble shows only the player
    ts: new Date().toISOString(),
    type: "voice" as const,
    audio_url: `/api/images/${serveFilename}`,
    audio_path: existsSync(mp3Path) ? mp3Path : filepath,
    duration,
    ...(voiceId ? { voice_id: voiceId } : {}),
  };

  appendFileSync(INBOX, JSON.stringify(msg) + "\n");

  return { id, audio_url: msg.audio_url };
}

// Public: no login, the hard-to-guess file name is the only key.
app.get("/share/:filename", async (c) => {
  let filename = c.req.param("filename");
  // Mail clients drag trailing markdown or punctuation into links; none of
  // these characters is legal in our file names.
  filename = filename.replace(/[*_)>\]"'.,]+$/, "");
  // Reject traversal and control characters before file access to avoid exposing filesystem errors.
  if (filename.includes("/") || filename.includes("..") || filename.startsWith(".") || /[\u0000-\u001f\u007f-\u009f]/.test(filename)) {
    return c.json({ error: "bad filename" }, 400);
  }
  const filepath = join(DATA_DIR, "shared", filename);
  const file = Bun.file(filepath);
  // Bun.file is lazy — check existence here so a missing file returns a clean
  // 404 instead of an ENOENT crash page that leaks the absolute server path.
  if (!(await file.exists())) {
    return c.json({ error: "not found" }, 404);
  }
  const raw = c.req.query("raw");
  const viewer = await fileViewer(c.req.header("accept"), raw, filename, file, `/share/${encodeURIComponent(filename)}?raw=1`);
  if (viewer) return viewer;
  // nosniff: the browser keeps to the type named here and never guesses one.
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff", ...rawFileHeaders(filename, raw) };
  if (!servedInline(filename)) {
    return new Response(file, { headers: { ...headers, ...DOWNLOAD_HEADERS } });
  }
  // Public files get a sandbox on top of the app-wide policy. Not PDFs: browser
  // PDF viewers refuse to open in a sandbox.
  if (!filename.toLowerCase().endsWith(".pdf")) headers["Content-Security-Policy"] = `${CONTENT_SECURITY_POLICY}; sandbox`;
  if (filename.endsWith(".md")) headers["Content-Type"] = "text/markdown; charset=utf-8";
  else if (filename.endsWith(".txt")) headers["Content-Type"] = "text/plain; charset=utf-8";
  else if (filename.endsWith(".pdf")) headers["Content-Type"] = "application/pdf";
  else if (filename.endsWith(".json")) headers["Content-Type"] = "application/json; charset=utf-8";
  return new Response(file, { headers });
});

app.get("/api/images/:filename", async (c) => {
  const filename = c.req.param("filename");
  // Strict allowlist on the filename: prevents path traversal (../) and any
  // non-uploaded path the worker code never created.
  if (!SERVE_FILENAME_RE.test(filename)) {
    return c.json({ error: "bad filename" }, 400);
  }
  const filepath = join(IMAGES_DIR, filename);
  try {
    const file = Bun.file(filepath);
    if (!(await file.exists())) return c.json({ error: "not found" }, 404);
    const raw = c.req.query("raw");
    const viewer = await fileViewer(c.req.header("accept"), raw, filename, file, `/api/images/${encodeURIComponent(filename)}?raw=1`);
    if (viewer) return viewer;
    const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff", ...rawFileHeaders(filename, raw) };
    if (!servedInline(filename)) return new Response(file, { headers: { ...headers, ...DOWNLOAD_HEADERS } });
    const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
    if (filename.endsWith(".mp3")) headers["Content-Type"] = "audio/mpeg";
    else if (filename.endsWith(".webm")) headers["Content-Type"] = "audio/webm";
    else if (filename.endsWith(".pdf")) headers["Content-Type"] = "application/pdf";
    else if (RAW_TEXT_TYPES[ext]) headers["Content-Type"] = RAW_TEXT_TYPES[ext];
    return new Response(file, { headers });
  } catch {
    return c.json({ error: "not found" }, 404);
  }
});

app.post("/api/ping", (c) => {
  lastClientPing = Date.now();
  return c.json({ ok: true });
});

app.post("/api/internal/mail-inbox", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !isSafeMessageId(body.id) || typeof body.from !== "string" || !body.from.trim() || typeof body.text !== "string" || !body.text.startsWith("[Mailbox] ")) {
    return c.json({ error: "id, from and mailbox text required" }, 400);
  }
  try {
    // Store receipts with the summary in one append: no keys are acknowledged
    // before their notification is durable. Read all entries, including after restart.
    const entries = readInboxEntries(true);
    const mailKey = isSafeMessageId(body.mailKey) ? body.mailKey : undefined;
    let text = body.text;
    let mailKeys: string[] | undefined;
    if (body.mails !== undefined || body.mailKeys !== undefined) {
      if (!Array.isArray(body.mails) || !body.mails.length || !Array.isArray(body.mailKeys)
        || body.mailKeys.length !== body.mails.length
        || body.mails.some((mail: any, i: number) => !mail || !isSafeMessageId(mail.mailKey)
          || body.mailKeys[i] !== mail.mailKey || typeof mail.subject !== "string" || typeof mail.from !== "string")) {
        return c.json({ error: "mail keys and matching sender/subject entries required" }, 400);
      }
      const seen = new Set(entries.flatMap((entry) => [...(Array.isArray(entry.mailKeys) ? entry.mailKeys : []), ...(entry.mailKey ? [entry.mailKey] : [])]));
      const fresh = body.mails.filter((mail: any) => {
        if (seen.has(mail.mailKey)) return false;
        seen.add(mail.mailKey);
        return true;
      });
      if (!fresh.length) return c.json({ ok: true, duplicate: true });
      mailKeys = fresh.map((mail: any) => mail.mailKey);
      const line = (value: string) => value.replace(/[\r\n]+/g, " ");
      text = `[Mailbox] ${fresh.length} new:\n` + fresh.slice(0, 10).map((mail: any) => `- ${line(mail.subject)} (from ${line(mail.from)})`).join("\n")
        + (fresh.length > 10 ? `\n…and ${fresh.length - 10} more` : "");
    } else if (entries.some((entry) => entry.id === body.id || (mailKey && entry.mailKey === mailKey))) {
      return c.json({ ok: true, duplicate: true });
    }
    const entry = { id: body.id, mailKey, mailKeys, from: body.from, text, ts: new Date().toISOString(), source: "email" };
    appendFileSync(INBOX, JSON.stringify(entry) + "\n");
    return c.json({ ok: true, id: entry.id });
  } catch {
    return c.json({ ok: false, error: "Failed to store mailbox notification" }, 500);
  }
});

// The worker bearer prevents unauthenticated callers from injecting email input.
app.post("/api/email-inbox", async (c) => {
  try {
    const token = process.env.EMAIL_WORKER_TOKEN || "";
    if (!token) {
      return c.json({ error: "EMAIL_WORKER_TOKEN not configured" }, 503);
    }
    const auth = c.req.header("authorization") || "";
    if (!bearerMatches(auth, token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const email = await c.req.json();
    // Derive missing IDs from content so sender retries keep the same delivery identity.
    if (email && typeof email === "object" && !Array.isArray(email) && email.id === undefined) {
      email.id = `email-${new Bun.CryptoHasher("sha256").update(JSON.stringify([
        email.from || "unknown", email.to || "", email.timestamp || "", email.subject || "(no subject)", email.body || "",
      ])).digest("hex").slice(0, 48)}`;
    }
    if (!email || !isSafeMessageId(email.id)) return c.json({ error: "stable delivery id required" }, 400);
    const stored = existsSync(EMAIL_INBOX)
      ? readFileSync(EMAIL_INBOX, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((item) => item.id === email.id)
      : undefined;
    const entry = stored || {
      id: email.id,
      from: email.from || "unknown",
      subject: email.subject || "(no subject)",
      body: email.body || "",
      ts: email.timestamp || new Date().toISOString(),
    };
    if (!stored) appendFileSync(EMAIL_INBOX, JSON.stringify(entry) + "\n");

    // Marked as mail from its sender, never as the user speaking.
    const inboxEntry = {
      id: entry.id,
      from: entry.from,
      text: `[Email from ${entry.from}]\nSubject: ${entry.subject}\n\n${entry.body}`,
      ts: entry.ts,
      source: "email",
    };
    // Independent receipt checks let retries complete a partially stored delivery.
    const delivered = readInboxEntries(true).some((item) => item.id === entry.id);
    if (!delivered) appendFileSync(INBOX, JSON.stringify(inboxEntry) + "\n");

    return c.json({ ok: true, id: entry.id, duplicate: !!stored && delivered });
  } catch (err) {
    process.stderr.write(`embervy-app: email-inbox error: ${err}\n`);
    return c.json({ error: "Failed to process email" }, 500);
  }
});

const DOCTOR_STATE_FILE = `${EMBERVY_HOME_DIR}/state/doctor-last.json`;
const DOCTOR_MUTE_FILE = `${EMBERVY_HOME_DIR}/state/doctor-mute.json`;
function readDoctorState(): any {
  try { return JSON.parse(readFileSync(DOCTOR_STATE_FILE, "utf8")); }
  catch { return { state: "unknown", reason: "no background check yet" }; }
}
function readDoctorMutes(): DoctorMutes {
  try { return parseDoctorMutes(readFileSync(DOCTOR_MUTE_FILE, "utf8")); }
  catch { return Object.create(null); }
}
function saveDoctorJson(file: string, value: any) {
  mkdirSync(`${EMBERVY_HOME_DIR}/state`, { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${file}.tmp`, file);
}
// Synchronous read/modify/write sections cannot interleave with another request.
function storeDoctorStatus(raw: any) {
  const mutes = pruneDoctorMutes(raw, readDoctorMutes());
  saveDoctorJson(DOCTOR_MUTE_FILE, mutes);
  saveDoctorJson(DOCTOR_STATE_FILE, raw);
  return applyDoctorMutes(raw, mutes);
}
app.post("/api/doctor/mute", async (c) => {
  const body = await c.req.json().catch(() => null);
  const id = body?.id;
  const raw = readDoctorState();
  if (!validDoctorId(id) || !Array.isArray(raw.checks) || !raw.checks.some((check: any) => check.id === id && (check.status === "FAIL" || check.status === "WARN"))) {
    return c.json({ error: "id must identify a current FAIL or WARN check (at most 200 characters)" }, 400);
  }
  const now = Date.now();
  const mute = { at: new Date(now).toISOString(), until: new Date(now + DOCTOR_MUTE_MS).toISOString() };
  const mutes = pruneDoctorMutes(raw, readDoctorMutes(), now);
  mutes[id] = mute;
  saveDoctorJson(DOCTOR_MUTE_FILE, mutes);
  const status = applyDoctorMutes(raw, mutes, now);
  broadcastToClients({ type: "doctor-status", data: status });
  return c.json({ ok: true, mute, status });
});
app.get("/api/internal/doctor/status", (c) => c.json(applyDoctorMutes(readDoctorState(), readDoctorMutes())));

app.post("/api/internal/doctor/status", async (c) => {
  const raw = rawDoctorStatus(await c.req.json());
  const prev = applyDoctorMutes(readDoctorState(), readDoctorMutes());
  let body: any;
  try {
    body = storeDoctorStatus(raw);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
  broadcastToClients({ type: "doctor-status", data: body });
  if (doctorRegressed(prev, body)) {
    const label = body.badge_state === "fail" ? S("push.doctorFail") : S("push.doctorWarn");
    const detail = body.summary
      ? S("push.doctorSummary", { fail: body.summary.fail || 0, warn: body.summary.warn || 0 })
      : S("push.doctorProblems");
    try { await sendPushToAll(label, detail); } catch { /* push optional */ }
  }
  return c.json({ ok: true, ...body });
});

// On-demand and background runs write the same state, so the badge never
// reverts to an older result.
async function runDoctor(opts: { mode?: string; verbose?: boolean; background?: boolean } = {}) {
  const args = [`${EMBERVY_HOME_DIR}/shared/tools/embervy-doctor.ts`, "--json"];
  if (opts.mode === "offline") args.push("--offline");
  if (opts.verbose) args.push("--verbose");
  const proc = Bun.spawn(["bun", ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, ...(opts.background ? { EMBERVY_DOCTOR_BACKGROUND: "1" } : {}) },
  });
  const out = await new Response(proc.stdout).text();
  const errText = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  let report: any;
  try { report = JSON.parse(out); }
  catch { return { ok: false as const, exitCode, raw: out, stderr: errText }; }
  const s = report.summary || {};
  const statusBody = {
    state: s.fail > 0 ? "fail" : s.warn > 0 ? "warn" : "ok",
    summary: s,
    result: report.result,
    checks: report.checks || [],
    ts: new Date().toISOString(),
    exitCode,
  };
  const prev = applyDoctorMutes(readDoctorState(), readDoctorMutes());
  const status = storeDoctorStatus(rawDoctorStatus(statusBody));
  broadcastToClients({ type: "doctor-status", data: status });
  return { ok: true as const, exitCode, report, status, prev };
}

app.get("/api/internal/doctor", async (c) => {
  const run = await runDoctor({ mode: c.req.query("mode") || "online", verbose: c.req.query("verbose") === "1" });
  if (!run.ok) return c.json({ exitCode: run.exitCode, raw: run.raw, stderr: run.stderr, error: "doctor output not parseable" }, 500);
  const { exitCode, report, status } = run;
  return c.json({ exitCode, status, report: { ...report, checks: status.checks, badge_state: status.badge_state, muted: status.muted } });
});

const DOCTOR_INTERVAL_MIN = (() => {
  const n = Number.parseFloat(envValue("EMBERVY_DOCTOR_INTERVAL_MIN") ?? "30");
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();
let doctorBackgroundRunning = false;
async function doctorBackgroundRun() {
  if (doctorBackgroundRunning) return;
  doctorBackgroundRunning = true;
  try {
    const run = await runDoctor({ background: true });
    // The first result has no baseline and must not trigger a regression alert.
    const known = run.ok && ["ok", "warn", "fail"].includes(run.prev?.badge_state ?? run.prev?.state);
    if (run.ok && known && doctorRegressed(run.prev, run.status)) {
      const body = run.status;
      const label = body.badge_state === "fail" ? S("push.doctorFail") : S("push.doctorWarn");
      const detail = body.summary
        ? S("push.doctorSummary", { fail: body.summary.fail || 0, warn: body.summary.warn || 0 })
        : S("push.doctorProblems");
      try { await sendPushToAll(label, detail); } catch { /* push optional */ }
    }
  } catch (e) {
    process.stderr.write(`embervy-app: background doctor failed: ${e}\n`);
  } finally {
    doctorBackgroundRunning = false;
  }
}
if (DOCTOR_INTERVAL_MIN > 0) {
  const every = DOCTOR_INTERVAL_MIN * 60_000;
  setTimeout(() => {
    void doctorBackgroundRun();
    setInterval(() => void doctorBackgroundRun(), every);
  }, Math.min(120_000, every));
}

registerPeerRoutes(app, PEERS, {
  internalToken: INTERNAL_API_TOKEN,
  bearerMatches,
  append: entry => appendFileSync(INBOX, JSON.stringify(entry) + "\n"),
});

// New room messages go to the agent as foreign content. The cursor survives
// restarts, so nothing repeats and nothing is skipped.
const ROOMS = roomConfigsFromEnv(process.env);
for (const [index, room] of ROOMS.entries()) {
  const stateFile = join(DATA_DIR, roomStateFileName(room.name, index));
  let polling = false;
  let failures = 0;
  async function roomPollOnce() {
    if (polling) return;
    polling = true;
    try {
      const state = parseRoomState(existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null);
      const { entries, state: next } = await pollRoom(room, state);
      for (const entry of entries) {
        if (index > 0) entry.id = roomMessagePrefix(room.name) + entry.id.slice("room-".length);
        appendFileSync(INBOX, JSON.stringify(entry) + "\n");
      }
      writeFileSync(stateFile, JSON.stringify(next), { mode: 0o600 });
      if (failures > 0) process.stderr.write(`embervy-app: room ${room.name} reachable again\n`);
      failures = 0;
    } catch (e) {
      if (failures++ % 30 === 0) process.stderr.write(`embervy-app: room ${room.name} not reachable: ${(e as Error)?.message ?? e}\n`);
    } finally {
      polling = false;
    }
  }
  process.stderr.write(`embervy-app: room door open: ${room.name}\n`);
  setTimeout(() => {
    void roomPollOnce();
    setInterval(() => void roomPollOnce(), room.pollMs);
  }, 5_000);
}
// The agent's door into the room: internal bearer only. A browser session is
// not enough here, because in the room this key speaks as the agent.
app.get("/api/internal/room", (c) => {
  if (!INTERNAL_API_TOKEN || !bearerMatches(c.req.header("authorization") || "", INTERNAL_API_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  if (!ROOMS.length) return c.json({ error: "no room" }, 404);
  return c.json({ rooms: ROOMS.map(room => room.name) });
});
app.post("/api/internal/room/send", async (c) => {
  if (!INTERNAL_API_TOKEN || !bearerMatches(c.req.header("authorization") || "", INTERNAL_API_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  if (!ROOMS.length) return c.json({ error: "no room" }, 404);
  const body = await c.req.json().catch(() => null);
  const room = body?.room === undefined && ROOMS.length === 1 ? ROOMS[0] : ROOMS.find(room => room.name === body?.room);
  if (!room) return c.json({ error: "choose a room by name", rooms: ROOMS.map(room => room.name) }, 400);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return c.json({ error: "text required" }, 400);
  const replyTo = typeof body?.reply_to === "string" ? body.reply_to : undefined;
  const sent = await sendToRoom(room, text, replyTo);
  // Always 502: a 401 from the room must not read as this door refusing the agent.
  if (!sent.ok) return c.json({ error: `room ${room.name}: ${sent.reason} (HTTP ${sent.status})` }, 502);
  return c.json({ ok: true, id: sent.id, room: room.name });
});

// Two doors, one handler: the agent's door runs the same checks, so it is no
// way around approval. Approving has no agent door.
app.post("/api/send-email", (c) => queueOutgoingEmail(c));
app.post("/api/internal/send-email", (c) => queueOutgoingEmail(c));

async function queueOutgoingEmail(c: any) {
  try {
    const req = await c.req.json();
    const to = (req.to || "").trim();
    const subject = (req.subject || "").trim();
    const body = (req.body || "").trim();
    const from = (req.from || "").trim() || undefined;

    if (!to || !subject || !body) {
      return c.json({ error: "to, subject, body required" }, 400);
    }

    const cc = (req.cc || "").trim();
    const hits = checkEmailBlacklist(subject, body, [to, cc].filter(Boolean).join(", "));
    const entries = readMailOutbox();
    const fingerprint = createHash("sha256").update(JSON.stringify([to, cc, subject, body, from || ""])).digest("hex");
    const explicit = req.delivery_id !== undefined;
    if (explicit && (typeof req.delivery_id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(req.delivery_id))) return c.json({ error: "invalid delivery_id" }, 400);
    // Rolling window, not calendar buckets: a retry across midnight is still the same job.
    const existing = explicit ? entries.find(e => e.id === req.delivery_id) : [...entries].reverse().find(e =>
      Date.now() - Date.parse(e.created_at) < 24 * 3600_000 &&
      e.to === to && (e.cc || "") === cc && e.subject === subject && e.body === body && (e.from || "") === (from || ""));
    const id = existing?.id || (explicit ? req.delivery_id : `mail-${fingerprint}-${Date.now().toString(36)}`);
    if (existing) {
      if (existing.to !== to || (existing.cc || "") !== cc || existing.subject !== subject || existing.body !== body || existing.from !== from) return c.json({ error: "delivery_id belongs to different content" }, 409);
      return c.json({ ok: !["failed", "unknown"].includes(existing.status), id, status: existing.status, error: existing.error,
        duplicate: true, created_at: existing.created_at, sent_at: existing.sent_at, hits: existing.hits || [] });
    }
    // Only an explicit opt-in lets clean mail bypass approval; blacklist hits always require it.
    const autoSendClean = (process.env.EMAIL_AUTO_SEND_CLEAN ?? "false") === "true";
    const status = hits.length > 0
      ? "pending_approval"
      : autoSendClean
      ? "ready"
      : "pending_approval";
    const entry = {
      id,
      from,
      to,
      cc,
      subject,
      body,
      status,
      hits,
      created_at: new Date().toISOString(),
      sent_at: null as string | null,
    };

    writeMailOutbox([...readMailOutbox(), entry]);

    if (status === "ready") {
      const result = await deliverMail(id);
      return c.json({ ...result, id, hits });
    }

    if (status === "pending_approval") {
      const notification = {
        id: generateId(),
        user: AGENT_LABEL,
        text: S("email.approvalMessage", { to: cc ? `${to}\nCc: ${cc}` : to, subject, hits: hits.join(", "), body, id }),
        ts: new Date().toISOString(),
        source: "email-approval",
        email_id: id,
        ...mailCardFields(entry),
      };
      appendFileSync(EMAIL_APPROVAL_CARDS, JSON.stringify({ card_id: notification.id, email_id: id }) + "\n");
      appendFileSync(OUTBOX, JSON.stringify(notification) + "\n");
      broadcastToClients({ type: "message", data: notification });
      try { await sendPushToAll(S("push.emailApproval"), S("push.emailApprovalBody", { to, subject })); } catch {}
    }

    return c.json({ ok: true, id, status, hits });
  } catch (err) {
    process.stderr.write(`embervy-app: send-email error: ${err}\n`);
    return c.json({ error: "Failed to queue email" }, 500);
  }
}

// Mail state and decisions never inherit local, developer or agent trust.
const isHumanSession = (c: any) => !!APP_SESSION_SECRET && isAuthenticatedFromCookie(c.req.header("cookie") || "").catch(() => false);

const settingsFingerprint = (settings: ApprovalSettings) => JSON.stringify([settings.level, settings.extra]);
const approvalSettings = BRAIN_HARNESS ? new ApprovalSettingsStore(join(DATA_DIR, "approval-settings.json"), (old, next) => {
  const message = { id: generateId(), ts: new Date().toISOString(), source: "system", text: S("approvalSettings.outside", { old: old.level, next: next?.level ?? S("approvalSettings.invalidLevel") }) };
  appendToOutbox(message);
  broadcastToClients({ type: "message", data: message });
}) : null;
if (approvalSettings) watchFile(approvalSettings.path, { interval: 1000 }, () => {
  try { approvalSettings.read(); } catch { /* A later complete write will be checked again. */ }
});
app.get("/api/approval-settings", (c) => {
  if (!approvalSettings) return c.json({ available: false });
  c.header("Cache-Control", "private, no-store");
  try { return c.json(approvalSettings.read()); }
  catch { return c.json({ error: S("approvalSettings.invalid") }, 400); }
});
app.post("/api/approval-settings", async (c) => {
  if (!approvalSettings) return c.json({ error: S("approvalSettings.unavailable") }, 404);
  try {
    const body = await c.req.json();
    const change = approvalChange({ level: body?.level, reason: "person" });
    if (!change.level) return c.json({ error: S("approvalSettings.invalid") }, 400);
    return c.json(approvalSettings.write(proposedSettings(approvalSettings.read(), change), "person"));
  } catch { return c.json({ error: S("approvalSettings.invalid") }, 400); }
});
app.post("/api/internal/approval-settings", async (c) => {
  if (!approvalSettings) return c.json({ error: S("approvalSettings.unavailable") }, 404);
  // Developer/local trust never grants access to this agent-only door.
  if (!INTERNAL_API_TOKEN || !bearerMatches(c.req.header("authorization") || "", INTERNAL_API_TOKEN)) return c.json({ error: S("email.humanRequired") }, 403);
  try {
    const change = approvalChange(await c.req.json());
    const current = approvalSettings.read(), next = proposedSettings(current, change);
    if (!loosens(current, next)) return c.json({ ok: true, settings: approvalSettings.write(next, "agent") });
    const what = [
      ...(next.level === "important" ? [S("approvalSettings.stop.important")] : next.level === "none" ? [S("approvalSettings.stop.none")] : []),
      ...current.extra.filter(p => !next.extra.some(e => JSON.stringify(e) === JSON.stringify(p))).map(p => p.label),
    ].join("; ");
    const title = S("approvalSettings.request", { agent: AGENT_LABEL, what });
    const entry: Approval = { id: generateId(), ts: new Date().toISOString(), title, detail: S("approvalSettings.reason", { reason: change.reason }), kind: "approval-settings", status: "pending", settings: { before: settingsFingerprint(current), next } };
    appendFileSync(APPROVALS, JSON.stringify(entry) + "\n");
    const message = { id: entry.id, ts: entry.ts, source: "approval", approval_id: entry.id, text: title, detail: entry.detail };
    appendToOutbox(message);
    broadcastToClients({ type: "message", data: message });
    if (!inQuietHours(new Date(), process.env.APPROVAL_QUIET_HOURS ?? "23-6", houseTimeZone())) void sendPushToAll(S("approval.push"), title).catch(() => {});
    return c.json({ ok: true, id: entry.id, status: "pending" });
  } catch { return c.json({ error: S("approvalSettings.invalid") }, 400); }
});

app.get("/api/send-email/:id/status", async (c) => {
  if (!await isHumanSession(c)) return c.json({ error: S("email.humanRequired") }, 403);
  c.header("Cache-Control", "private, no-store");
  const entry = readMailOutbox().find(e => e.id === c.req.param("id"));
  return c.json({ status: entry?.status || "unknown" });
});

app.post("/api/send-email/approve", async (c) => {
  if (!await isHumanSession(c)) return c.json({ error: S("email.humanRequired") }, 403);
  try {
    const req = await c.req.json();
    const id = (req.id || "").trim();
    const action = (req.action || "").trim();

    if (!id || (action !== "send" && action !== "discard")) {
      return c.json({ error: "id and action (send|discard) required" }, 400);
    }

    const decision = decideMail(id, action);
    if (!decision.accepted) return c.json({ error: decision.code === 404 ? S("email.notFound") : S("email.notPending"), status: decision.status }, decision.code);

    if (action === "send") {
      const result = await deliverMail(id);
      return c.json({ ...result, id });
    }

    return c.json({ ok: true, id, status: decision.status });
  } catch (err) {
    process.stderr.write(`embervy-app: approve error: ${err}\n`);
    return c.json({ error: "Failed to approve" }, 500);
  }
});

async function proxyToVideoBackend(c: any, path: "/watch" | "/listen") {
  if (!EXTERNAL_PUSH_TOKEN) return c.json({ error: "EXTERNAL_PUSH_TOKEN not configured" }, 503);
  const auth = c.req.header("authorization") || "";
  if (!bearerMatches(auth, EXTERNAL_PUSH_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.text();
  try {
    const resp = await fetch(videoBackendUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await resp.text();
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("Content-Type") || "application/json" },
    });
  } catch (err) {
    process.stderr.write(`external proxy ${path}: ${err}\n`);
    return c.json({ error: `proxy failure: ${err}` }, 502);
  }
}
app.post("/api/external/watch", (c) => proxyToVideoBackend(c, "/watch"));
app.post("/api/external/listen", (c) => proxyToVideoBackend(c, "/listen"));
app.post("/api/external/audio", async (c) => {
  if (!EXTERNAL_PUSH_TOKEN) return c.json({ error: "EXTERNAL_PUSH_TOKEN not configured" }, 503);
  const auth = c.req.header("authorization") || "";
  if (!bearerMatches(auth, EXTERNAL_PUSH_TOKEN)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.text();
  try {
    const resp = await fetch(videoBackendUrl("/audio"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "audio/mpeg",
        "X-Title": resp.headers.get("X-Title") || "",
      },
    });
  } catch (err) {
    return c.json({ error: `proxy failure: ${err}` }, 502);
  }
});

app.post("/api/external/broadcast", async (c) => {
  if (!EXTERNAL_PUSH_TOKEN) {
    return c.json({ error: "EXTERNAL_PUSH_TOKEN not configured" }, 503);
  }
  const auth = c.req.header("authorization") || "";
  if (!bearerMatches(auth, EXTERNAL_PUSH_TOKEN)) {
    process.stderr.write("external broadcast: auth mismatch\n");
    return c.json({ error: "unauthorized" }, 401);
  }
  const msg = await c.req.json();
  const broken = brokenBroadcastField(msg);
  if (broken) return c.json({ ok: false, error: broken }, 400);
  dropServerFields(msg);
  if (!msg.ts) msg.ts = new Date().toISOString();
  try {
    appendFileSync(OUTBOX, JSON.stringify(msg) + "\n");
  } catch (err) {
    process.stderr.write(`external broadcast: outbox write failed: ${err}\n`);
  }
  broadcastToClients({ type: "message", data: msg });
  if (!lastClientPing || Date.now() - lastClientPing > 5000) {
    await sendPushToAll(AGENT_LABEL, msg.text || "");
  }
  return c.json({ ok: true });
});

app.post("/api/internal/broadcast", async (c) => {
  const msg = await c.req.json();
  if (msg && typeof msg === "object" && !Array.isArray(msg) && msg.reply_to !== undefined) {
    const quote = replyQuoteFromId(msg.reply_to, readInboxEntries(true), readNewOutboxEntries(undefined, true));
    delete msg.reply_to;
    if (quote) msg.reply_to = quote;
  }
  const broken = brokenBroadcastField(msg);
  if (broken) return c.json({ ok: false, error: broken }, 400);
  dropServerFields(msg);
  const id = typeof msg?.id === "string" && msg.id ? msg.id : "";
  if (id && deliveredIds.has(id)) return c.json({ ok: true, duplicate: true });
  if (!msg.ts) msg.ts = new Date().toISOString();

  // Stored first, confirmed second: a failed write answers 500 and leaves the
  // id free, so a retry lands exactly once.
  try {
    appendFileSync(OUTBOX, JSON.stringify(msg) + "\n");
  } catch (err) {
    process.stderr.write(`broadcast: outbox write failed: ${err}\n`);
    return c.json({ ok: false, error: "the message could not be stored" }, 500);
  }
  if (id) rememberDeliveredId(id);

  broadcastToClients({ type: "message", data: msg });

  if (!lastClientPing || Date.now() - lastClientPing > 5000) {
    await sendPushToAll(AGENT_LABEL, msg.text || "");
  }

  return c.json({ ok: true });
});

app.get("/api/internal/model", async (c) => {
  const substrate = BRAIN_HARNESS ? "brain" : envValue("EMBERVY_SUBSTRATE") || "claude";
  if (substrate !== "claude") return c.json({ ok: true, model: null, substrate, switchable: false });
  try {
    const f = Bun.file(join(DATA_DIR, "current_model"));
    if (await f.exists()) {
      const model = (await f.text()).trim();
      if (model) return c.json({ ok: true, model });
    }
  } catch {}
  try {
    const sessionDir = envValue("EMBERVY_SESSION_DIR") || "";
    if (sessionDir) {
      const glob = new Bun.Glob("*.jsonl");
      let newest = "", newestMtime = 0;
      for await (const fp of glob.scan({ cwd: sessionDir, absolute: true })) {
        const st = await Bun.file(fp).stat();
        if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = fp; }
      }
      if (newest) {
        let real: string | null = null;
        for (const line of (await Bun.file(newest).text()).split("\n")) {
          if (!line.trim()) continue;
          try {
            const mdl = JSON.parse(line)?.message?.model;
            if (mdl && mdl !== "<synthetic>") real = mdl;
          } catch {}
        }
        if (real) {
          const bare = real.replace(/\[1m\]$/, "");
          const alias = Object.entries(CLAUDE_HEADER_MODELS).find(([, id]) => id.replace(/\[1m\]$/, "") === bare)?.[0]
            ?? bare.replace(/^claude-opus-4-(\d)$/, "opus-4.$1");
          return c.json({ ok: true, model: alias });
        }
      }
    }
  } catch {}
  return c.json({ ok: true, model: null });
});

const CLAUDE_HEADER_MODELS: Record<string, string> = {
  "opus-5.5": "claude-opus-5-5[1m]",
  "fable-5.1": "claude-fable-5-1[1m]",
  "sonnet-5": "claude-sonnet-5",
  "opus-5": "claude-opus-5[1m]",
  "fable-5": "claude-fable-5",
  "opus-4.8": "claude-opus-4-8[1m]",
  "opus-4.7": "claude-opus-4-7[1m]",
  "opus-4.6": "claude-opus-4-6[1m]",
  "opus-4.7-200k": "claude-opus-4-7",
  "opus-4.6-200k": "claude-opus-4-6",
  "opus-4.5": "claude-opus-4-5",
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

app.post("/api/internal/model", async (c) => {
  if (BRAIN_HARNESS) return c.json({ error: S("model.brain") }, 409);
  const substrate = envValue("EMBERVY_SUBSTRATE") || "claude";
  if (substrate !== "claude") return c.json({ error: "model switching is unavailable for this substrate" }, 409);
  const { model } = await c.req.json();
  const modelMap = CLAUDE_HEADER_MODELS;
  // Engine switches change the endpoint behind Claude Code and need a clean
  // restart, not /model.
  const ENGINES = new Set(["glm", "kimi", "minimax", "claude"]);
  if (model && ENGINES.has(model)) {
    const home = envValue("EMBERVY_HOME") || process.cwd().replace(/\/Claude\/app$/, "");
    Bun.spawn(["setsid", "bash", `${home}/Claude/scripts/switch-backend.sh`, `--to=${model}`], {
      stdout: "ignore", stderr: "ignore",
    });
    return c.json({ ok: true, mode: "respawn", to: model }, 202);
  }

  // Strict allowlist — never pass user-supplied model strings through to
  // tmux. Add new entries to modelMap above if you need more models.
  const resolved = model ? modelMap[model] : null;
  if (!resolved) {
    return c.json({ error: "unsupported model", allowed: [...Object.keys(modelMap), ...ENGINES] }, 400);
  }

  try {
    const cmd = `/model ${resolved}`;
    const tmux = Bun.spawn(terminalCommand("send-keys", [cmd, "Enter"]), {
      stdout: "pipe", stderr: "pipe"
    });
    const stderr = await new Response(tmux.stderr).text();
    await tmux.exited;

    if (tmux.exitCode !== 0) throw new Error(stderr || "tmux send-keys failed");

    // The CLI's model confirmation needs Enter or the switch waits in a dialog the app cannot show.
    await new Promise((r) => setTimeout(r, 1200));
    const confirm = Bun.spawn(terminalCommand("send-keys", ["Enter"]), {
      stdout: "pipe", stderr: "pipe"
    });
    await confirm.exited;

    try { await Bun.write(join(DATA_DIR, "current_model"), model); } catch {}

    process.stderr.write(`embervy-app: model switch to ${resolved} via tmux\n`);
    return c.json({ ok: true, model, resolved });
  } catch (err) {
    process.stderr.write(`embervy-app: model switch failed: ${err}\n`);
    return c.json({ error: `switch failed: ${err}` }, 500);
  }
});

const BRAIN_HEADS_TIMEOUT_MS = 25_000; // An uncached CLI catalog lookup can take 20 seconds.

function readBrainControl() {
  let text = ["BRAIN_CONTROL_PORT", "BRAIN_CONTROL_TOKEN"]
    .filter(key => process.env[key])
    .map(key => `${key}=${process.env[key]}`).join("\n") + "\n";
  for (const file of BRAIN_ENV_FILES) {
    try { text += `${readFileSync(file, "utf8")}\n`; } catch { /* absent: the next file, or not set up */ }
  }
  return brainControlFrom(text);
}

const CUT_REQUESTED = "Cut requested; the new session greets you when it is up.";

function claudeCodeCutAvailable(): boolean {
  return !BRAIN_HARNESS && (envValue("EMBERVY_SUBSTRATE") || "claude") === "claude" && !readBrainControl();
}

function readClaudeCodeEnv(): Record<string, string | undefined> & { EMBERVY_HOME: string } {
  const home = houseHome(process.env, existsSync);
  return { ...process.env, ...parseEnv(readText(join(home, ".env"))), ...parseEnv(readText(join(home, "Claude/app/.env"))), EMBERVY_HOME: home };
}

function readClaudeCodeBridge() {
  const env = readClaudeCodeEnv();
  const mode = env.EMBERVY_BRIDGE_MODE?.trim().toLowerCase() === "sessions" ? "sessions" : "turns";
  const raw = (mode === "sessions" ? env.EMBERVY_BRIDGE_SESSIONS : env.EMBERVY_BRIDGE_TURNS)?.trim() || "";
  const count = /^[0-9]+$/.test(raw) ? Number(raw) : 0;
  return { mode, count: Number.isSafeInteger(count) && count > 0 ? count : mode === "sessions" ? 2 : 40 };
}

async function requestClaudeCodeCut(): Promise<void> {
  const env = readClaudeCodeEnv();
  const home = env.EMBERVY_HOME;
  mkdirSync(join(home, "logs"), { recursive: true });
  const log = openSync(join(home, "logs/cutoff.log"), "a");
  try {
    const child = spawn("setsid", [join(home, "Claude/scripts/cutoff.sh")], {
      cwd: home, env, detached: true, stdio: ["ignore", log, log],
    });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => { child.unref(); resolve(); });
    });
  } finally {
    closeSync(log);
  }
}

function announceCut(): void {
  const reply = { id: generateId(), text: CUT_REQUESTED, ts: new Date().toISOString(), type: "send" };
  appendToOutbox(reply);
  broadcastToClients({ type: "message", data: reply });
}

function brainHeadsErrorText(status: number): string {
  const kind = brainHeadsError(status);
  if (kind === "notReady") return S("brainMenu.error.notReady");
  if (kind === "refused") return S("brainMenu.error.refused");
  return S("brainMenu.error.status", { status });
}

app.get("/api/brain/heads", async (c) => {
  if (claudeCodeCutAvailable()) {
    c.header("Cache-Control", "no-store");
    return c.json({ restartOnly: true, current: { headLabel: S("brainMenu.claudeCode.title"), modelLabel: "" }, heads: [], bridge: readClaudeCodeBridge() });
  }
  if (!BRAIN_HARNESS) return c.json({ error: "not brain" }, 404);
  const control = readBrainControl();
  if (!control) return c.json({ error: S("brainMenu.error.notSetUp") }, 503);
  let res: Response;
  try {
    const refresh = c.req.query("refresh") === "1" ? "?refresh=1" : "";
    res = await fetch(`http://127.0.0.1:${control.port}/heads${refresh}`, {
      headers: { Authorization: `Bearer ${control.token}` },
      signal: AbortSignal.timeout(BRAIN_HEADS_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return c.json({ error: timeout ? S("brainMenu.error.timeout") : S("brainMenu.error.unreachable") }, 502);
  }
  if (!res.ok) return c.json({ error: brainHeadsErrorText(res.status) }, res.status === 404 ? 503 : 502);
  const menu = shapeBrainHeads(await res.json().catch(() => null), {
    otherFamily: S("brainMenu.family.other"),
    notSetUp: S("brainMenu.head.notSetUp"),
  });
  if (!menu) return c.json({ error: S("brainMenu.error.unreadable") }, 502);
  c.header("Cache-Control", "no-store");
  return c.json({ ...menu, bridge: control.bridge });
});

app.post("/api/brain/command", async (c) => {
  const canCut = claudeCodeCutAvailable();
  if (!BRAIN_HARNESS && !canCut) return c.json({ error: "not brain" }, 404);
  const picked = brainMenuCommand(await c.req.json().catch(() => null));
  if (!picked) return c.json({ error: S("brainMenu.error.invalid") }, 400);
  if (canCut) {
    if (picked.action !== "restart") return c.json({ error: S("brainMenu.error.invalid") }, 400);
    try {
      await requestClaudeCodeCut();
      announceCut();
      return c.json({ ok: true, mode: "respawn", message: CUT_REQUESTED }, 202);
    } catch (err) {
      process.stderr.write(`embervy-app: cut request failed: ${err}\n`);
      return c.json({ error: "The cut could not be requested." }, 500);
    }
  }
  // Persist the UI origin so history can omit menu controls without hiding typed commands.
  const msg = { id: generateId(), text: picked.cmd, ts: new Date().toISOString(), type: "text", ui_origin: "brain-menu" };
  try {
    appendFileSync(INBOX, JSON.stringify(msg) + "\n");
  } catch (err) {
    process.stderr.write(`embervy-app: brain menu: inbox write failed: ${err}\n`);
    return c.json({ error: S("brainMenu.error.notSent") }, 500);
  }
  process.stderr.write(`embervy-app: brain menu sent "${picked.cmd}"\n`);
  return c.json({ ok: true, id: msg.id, ts: msg.ts, command: picked.cmd });
});

// A voice id becomes a segment of the ElevenLabs address. Their ids are
// letters and digits; anything else ("../", "?", "/") could point the call,
// with the API key, at another path.
const VOICE_ID_RE = /^[A-Za-z0-9]{1,64}$/;

app.post("/api/tts", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ error: "JSON body required" }, 400);
  // Checked before anything else, the key included: a refused id never
  // depends on how the server is configured.
  const askedVoice = body.voice_id;
  if (askedVoice !== undefined && askedVoice !== null && askedVoice !== "" && !(typeof askedVoice === "string" && VOICE_ID_RE.test(askedVoice))) {
    return c.json({ error: "voice_id: letters and digits only, at most 64" }, 400);
  }
  if (!ELEVENLABS_KEY) return c.json({ error: "no API key" }, 500);

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const voiceId = askedVoice || process.env.ELEVENLABS_VOICE_ID || "onwK4e9ZLuTAKqWW03F9";
  if (!text) return c.json({ error: "text required" }, 400);

  const cleanText = text
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/#+\s/g, "")
    .trim();

  if (!cleanText) return c.json({ error: "no speakable text" }, 400);

  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: cleanText.slice(0, 5000),
        model_id: "eleven_v3",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return c.json({ error: `11Labs: ${res.status} ${err}` }, 500);
    }

    return new Response(res.body, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err) {
    return c.json({ error: `TTS failed: ${err}` }, 500);
  }
});

app.post("/api/internal/voice-broadcast", async (c) => {
  const { text, id: msgId, reply_to: replyId } = await c.req.json();
  const replyTo = replyId === undefined ? undefined : replyQuoteFromId(replyId, readInboxEntries(true), readNewOutboxEntries(undefined, true));
  if (!text) return c.json({ error: "text required" }, 400);
  // The id names the audio file and the stored message, so it follows the
  // same rule as on the other two broadcast doors (message-fields.ts) —
  // checked before speech synthesis to prevent paths outside the images folder.
  if (msgId !== undefined && msgId !== null && msgId !== "" && !isSafeMessageId(msgId)) {
    return c.json({ ok: false, error: "id: letters, digits and . _ : - only, at most 64" }, 400);
  }
  if (!ELEVENLABS_KEY) return c.json({ error: "no 11Labs key" }, 500);

  const voiceId = process.env.ELEVENLABS_VOICE_ID || "onwK4e9ZLuTAKqWW03F9";

  const cleanText = text
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/#+\s/g, "")
    .trim();

  if (!cleanText) return c.json({ error: "no speakable text" }, 400);

  try {
    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: cleanText.slice(0, 5000),
        model_id: "eleven_v3",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      return c.json({ error: `11Labs: ${ttsRes.status} ${err}` }, 500);
    }

    const id = msgId ? String(msgId) : generateId();
    const filename = `${id}.mp3`;
    const filepath = join(IMAGES_DIR, filename);
    const audioBuffer = await ttsRes.arrayBuffer();
    writeFileSync(filepath, Buffer.from(audioBuffer));

    const words = cleanText.split(/\s+/).length;
    const duration = Math.max(1, Math.round(words / 2.5));

    const msg = {
      id,
      text,
      ts: new Date().toISOString(),
      type: "voice",
      audio_url: `/api/images/${filename}`,
      duration,
      ...(replyTo ? { reply_to: replyTo } : {}),
    };

    appendFileSync(OUTBOX, JSON.stringify(msg) + "\n");
    // The bridge's text fallback reuses this id: if the voice answer got
    // lost on the way back, the fallback must not post the message again.
    rememberDeliveredId(id);

    broadcastToClients({ type: "message", data: msg });

    if (!lastClientPing || Date.now() - lastClientPing > 5000) {
      await sendPushToAll(AGENT_LABEL, S("push.voiceMessage"));
    }

    return c.json({ ok: true, id, audio_url: msg.audio_url, duration });
  } catch (err) {
    return c.json({ error: `voice broadcast failed: ${err}` }, 500);
  }
});

// Per-session product setting. The server owns the effective state; client
// messages and query parameters are never trusted as authorization.
app.get("/api/terminal/settings", (c) => {
  const key = terminalPreferenceKey(c.req.header("cookie") || "");
  return c.json({ enabled: terminalEnabledFor(key), input_enabled: terminalInputEnabledFor(key) });
});

app.post("/api/terminal/settings", async (c) => {
  const body = await c.req.json().catch(() => null) as { enabled?: unknown; input_enabled?: unknown } | null;
  if (typeof body?.enabled !== "boolean") return c.json({ error: "enabled must be boolean" }, 400);
  if (body.input_enabled !== undefined && typeof body.input_enabled !== "boolean") {
    return c.json({ error: "input_enabled must be boolean" }, 400);
  }
  const key = terminalPreferenceKey(c.req.header("cookie") || "");
  terminalPanelPreferences.set(key, body.enabled);
  if (body.input_enabled !== undefined) terminalInputPreferences.set(key, body.input_enabled);
  saveTerminalPreferences();
  if (!terminalEnabledFor(key)) {
    for (const ws of terminalSubscribers) {
      if (ws.data?.terminalPreferenceKey === key) {
        terminalSubscribers.delete(ws);
        try { sendToClient(ws, JSON.stringify({ type: "terminal-disabled" })); } catch {}
      }
    }
    stopTerminalStream();
  }
  return c.json({ enabled: terminalEnabledFor(key), input_enabled: terminalInputEnabledFor(key) });
});

app.get("/api/terminal/history", async (c) => {
  const key = terminalPreferenceKey(c.req.header("cookie") || "");
  if (!terminalEnabledFor(key)) return c.json({ error: "terminal panel disabled" }, 403);
  const pageSize = Math.min(Math.max(Number.parseInt(c.req.query("lines") || "200", 10) || 200, 1), 200);
  const offset = Math.min(Math.max(Number.parseInt(c.req.query("offset") || "0", 10) || 0, 0), 5000);
  const take = Math.min(pageSize, 5000 - offset);
  if (c.req.query("mode") === "log") {
    const entries = terminalLogEntries();
    const before = c.req.query("before");
    const after = c.req.query("after");
    if (before !== undefined || after !== undefined) {
      const page = logHistoryPage(entries, before, after, pageSize);
      return c.json({ ...page, lines: page.lines.map(terminalLogItem) });
    }
    // Offset remains a compatibility path, never used by the shipped log client.
    const end = Math.max(entries.length - offset, 0);
    const start = Math.max(end - take, 0);
    const lines = entries.slice(start, end).map(terminalLogItem);
    const next = offset + lines.length;
    return c.json({ lines, offset, nextOffset: start > 0 && next < 5000 ? next : null, limit: 200, totalCap: 5000 });
  }
  if (offset >= 5000) return c.json({ lines: [], offset, nextOffset: null, limit: 200, totalCap: 5000 });
  try {
    const raw = await captureTerminal(["-S", String(-(offset + take)), "-E", String(-(offset + 1))]);
    const lines = raw.replace(/\n$/, "").split("\n").map(ansiToHtml);
    // Joined output lines can span several pane lines, so pagination must advance by the requested range.
    const next = BRAIN_HARNESS ? offset + take : offset + lines.length;
    return c.json({ lines, offset, nextOffset: next < 5000 ? next : null, limit: 200, totalCap: 5000 });
  } catch {
    return c.json({ error: "terminal history unavailable" }, 503);
  }
});

app.get("/strings.js", (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  c.header("Cache-Control", "no-cache, must-revalidate");
  const s = loadStrings();
  // The page names the version it was served with (?v=), and the payload
  // carries that one: a page served just before an update still counts as
  // older and reloads, even if this script is fetched after the update.
  const asked = c.req.query("v");
  return c.body(clientScript(s, asked && /^[0-9a-f]{12}$/.test(asked) ? asked : pageVersion(s, PUBLIC_DIR)));
});

// A phone often restores the app from memory; it asks here when it comes back
// and reloads once if the texts or the code changed.
app.get("/api/strings/version", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ version: pageVersion(loadStrings(), PUBLIC_DIR) });
});

app.get("/feature-defaults.js", (c) => {
  c.header("Content-Type", "text/javascript; charset=utf-8");
  c.header("Cache-Control", "no-cache, must-revalidate");
  return c.body(`window.embervyHouseFeatures = ${JSON.stringify(houseFeatureDefaults(EMBERVY_HOME_DIR))};\n`);
});

// The pages load /strings.js?v=<fingerprint> with <html lang> set, so no cache
// can hold an older table under the address a page asks for.
const STAMPED_PAGES: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/settings.html": "settings.html" };
for (const [route, file] of Object.entries(STAMPED_PAGES)) {
  app.get(route, (c) => {
    let html: string;
    try {
      html = readFileSync(join(APP_DIR, "public", file), "utf8");
    } catch {
      return c.notFound();
    }
    if (file === "settings.html" && !mailboxWritingSetUp()) html = html.replace(/\s*<!-- mailbox-write:start -->[\s\S]*?<!-- mailbox-write:end -->/, "");
    if (file === "index.html" && VOICE_MESSAGES) html = html.replace("</head>", '  <meta name="embervy-voice" content="message">\n</head>');
    const s = loadStrings();
    html = html
      .replace('<script src="/strings.js"></script>', `<script src="/strings.js?v=${pageVersion(s, PUBLIC_DIR)}"></script>`)
      .replace('<html lang="en">', `<html lang="${escapeText(s.language)}">`);
    c.header("Cache-Control", "no-cache, must-revalidate");
    return c.html(html);
  });
}

app.use("/*", async (c, next) => {
  await next();
  const url = c.req.url;
  if (url.includes("app.js") || url.includes("i18n.js") || url.includes("style.css") || url.includes("sw.js") || url.endsWith("/")) {
    c.header("Cache-Control", "no-cache, must-revalidate");
  }
});
app.use("/*", serveStatic({ root: "./public" }));

const uploadBodyLimits = new Map([
  ["/api/image", MAX_IMAGE_BYTES + REQUEST_BODY_MAX],
  ["/api/voice", MAX_VOICE_BYTES + REQUEST_BODY_MAX],
  ["/api/voice/transcribe", VOICE_MAX_BYTES],
]);
// Bun has one transport ceiling; the reader enforces the smaller default before parsing.
const transportBodyMax = Math.max(REQUEST_BODY_MAX, ...uploadBodyLimits.values());
const server = Bun.serve({
  maxRequestBodySize: transportBodyMax,
  port: APP_PORT,
  hostname: APP_HOST,
  async fetch(req, server) {
    const url = new URL(req.url);

    // The same auth as the HTTP API: the middleware never sees /ws.
    if (url.pathname === "/ws") {
      if (!websocketOriginAllowed(req, calendarConfig.publicUrl)) {
        return new Response("Forbidden origin", { status: 403 });
      }
      if (APP_PASSWORD && !trustedWithoutCookie((name) => req.headers.get(name))
          && !(await isAuthenticatedFromCookie(req.headers.get("cookie") || ""))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      const token = readSessionCookie(req.headers.get("cookie") || "");
      const sessionExpiresAt = !trustedWithoutCookie((name) => req.headers.get(name)) && APP_PASSWORD
        ? Number(token.slice(0, token.indexOf("."))) + SESSION_MAX_AGE_MS : null;
      const upgraded = server.upgrade(req, {
        data: { terminalPreferenceKey: terminalPreferenceKey(req.headers.get("cookie") || ""), sessionExpiresAt },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // An online doctor run can take longer than Bun's 10 s idle timeout (the
    // claude -p canary alone), which would cut the answer to the doctor button.
    if (url.pathname === "/api/internal/doctor") server.timeout(req, 120);
    // The peer's bounded wait must finish before Bun closes the internal request.
    if (PEERS.length && url.pathname === "/api/internal/peer/send") server.timeout(req, 30);
    if (url.pathname.startsWith("/api/brain/claude-signin/")) server.timeout(req, 120);

    let bodyMax = REQUEST_BODY_MAX;
    const uploadMax = req.method === "POST" ? uploadBodyLimits.get(url.pathname) : undefined;
    if (uploadMax !== undefined) {
      const authenticated = trustedWithoutCookie(name => req.headers.get(name))
        || await isAuthenticatedFromCookie(req.headers.get("cookie") || "").catch(() => false);
      if (!authenticated) return Response.json({ error: "unauthorized" }, { status: 401 });
      bodyMax = uploadMax;
    }
    const bounded = await boundedRequest(req, bodyMax);
    if (bounded instanceof Response) return bounded;
    return app.fetch(bounded);
  },
  websocket: {
    open(ws) {
      // Keep each authenticated device connected so concurrent clients cannot evict each other.
      if (!wsSessionActive(ws)) return;
      wsClients.add(ws);
      scheduleWsExpiry(ws);
      process.stderr.write(`embervy-app: client connected (${wsClients.size} total)\n`);
    },
    close(ws) {
      clearTimeout(wsExpiryTimers.get(ws));
      wsExpiryTimers.delete(ws);
      wsClients.delete(ws);
      unsubscribeTerminal(ws);
      process.stderr.write(`embervy-app: client disconnected (${wsClients.size} total)\n`);
    },
    async message(ws, message) {
      if (!wsSessionActive(ws)) return;
      try {
        const data = JSON.parse(String(message));
        if (data.type === "ping") {
          sendToClient(ws, JSON.stringify({ type: "pong" }));
          return;
        }
        if (data.type === "terminal-subscribe") {
          if (!terminalEnabledFor(ws.data?.terminalPreferenceKey || "dev-open")) {
            unsubscribeTerminal(ws);
            sendToClient(ws, JSON.stringify({ type: "terminal-disabled" }));
            return;
          }
          const view: TerminalView = data.mode === "tui" ? "tui" : "log";
          if (ws.data && typeof ws.data === "object") (ws.data as any).terminalView = view;
          terminalSubscribers.add(ws);
          sendToClient(ws, JSON.stringify({ type: "terminal-subscribed", mode: view, input_enabled: terminalInputEnabledFor(ws.data?.terminalPreferenceKey || "dev-open") }));
          const cached = terminalLastFrame.get(view);
          if (cached) sendToClient(ws, cached);
          startTerminalStream();
          return;
        }
        if (data.type === "terminal-unsubscribe") {
          unsubscribeTerminal(ws);
          return;
        }
        if (data.type === "terminal-input") {
          const key = ws.data?.terminalPreferenceKey || "dev-open";
          if (!terminalInputEnabledFor(key)) {
            sendToClient(ws, JSON.stringify({ type: "terminal-input-disabled" }));
            return;
          }
          if (!terminalSubscribers.has(ws)) {
            sendToClient(ws, JSON.stringify({ type: "terminal-input-not-subscribed" }));
            return;
          }
          const input = {
            ...(Object.prototype.hasOwnProperty.call(data, "text") ? { text: data.text } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, "key") ? { key: data.key } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, "ctrl") ? { ctrl: data.ctrl } : {}),
            ...(Object.prototype.hasOwnProperty.call(data, "alt") ? { alt: data.alt } : {}),
          } as TerminalInput;
          const task = terminalInputChain.then(async () => {
            if (!wsSessionActive(ws)) return;
            await sendTerminalInput(input);
            logTerminalInput(input);
          });
          terminalInputChain = task.catch(() => {});
          try {
            await task;
            sendToClient(ws, JSON.stringify({ type: "terminal-input-ack", ...(Number.isInteger(data.request_id) ? { request_id: data.request_id } : {}) }));
          } catch (error) {
            sendToClient(ws, JSON.stringify({ type: "terminal-input-error", ...(Number.isInteger(data.request_id) ? { request_id: data.request_id } : {}), error: error instanceof Error ? error.message : "invalid terminal input" }));
          }
          return;
        }
        if (data.type === "message" && data.text?.trim()) {
          const answer = await acceptTextMessage(data.text.trim(), null, data.client_id);
          sendToClient(ws, JSON.stringify({ type: "ack", ...answer }));
        }
      } catch {}
    },
  },
});

process.stderr.write(`embervy-app: HTTP server on http://${APP_HOST}:${APP_PORT}\n`);

setInterval(() => {
  for (const ws of wsClients) {
    try {
      sendToClient(ws, JSON.stringify({ type: "pong" }));
    } catch {
      wsClients.delete(ws);
      unsubscribeTerminal(ws);
      process.stderr.write(`embervy-app: removed dead WebSocket client (${wsClients.size} remaining)\n`);
    }
  }
}, 30000);

void recoverMailOutbox().catch(err => process.stderr.write(`mail recovery: ${err}\n`));
setInterval(() => { void recoverMailOutbox().catch(err => process.stderr.write(`mail recovery: ${err}\n`)); }, 30_000);

