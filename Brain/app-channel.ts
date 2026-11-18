// Receives app messages, sends replies and requests approval.

import { houseChannelWho, houseForeignSource, houseRoomSpeech, houseRoomTool } from "./house-rooms";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { brainTimezone } from "./time-marks";
import { brainLanguage, tr } from "./texts";
import { splitPrefixedToolName } from "./mcp-stdio";

// Read lazily so environment configuration is loaded first.
export function appMcpServer(env: Record<string, string | undefined> = process.env): string {
  return env.BRAIN_APP_MCP_SERVER?.trim() || "app"; 
}

export function appReplyToolNames(server = appMcpServer()): Set<string> {
  return new Set(["reply", "send", "send_file", "voice_reply"].flatMap((tool) => [
    tool, `mcp__${server}__${tool}`, `mcp__${server.replace(/-/g, "_")}__${tool}`,
  ]));
}

// Only the shipped app identity and its configured alias can represent app speech.
function appToolName(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const split = splitPrefixedToolName(name);
  if (!split) return name.startsWith("mcp__") ? null : name;
  const server = appMcpServer();
  return ["app", server, server.replace(/-/g, "_")].includes(split.server) ? split.tool : null;
}

export function isAppReplyTool(name: unknown): boolean {
  const tool = appToolName(name);
  return tool !== null && ["reply", "send", "send_file", "voice_reply"].includes(tool);
}

export interface InboxEntry {
  id?: string;
  text?: string;
  ts?: string;
  type?: string;
  image_path?: string;
  file_path?: string;
  file_name?: string;
  location?: { lat?: number; lon?: number; acc?: number; name?: string };
  [key: string]: unknown;
}

export interface InboxCursor {
  offset: number;
  seen: string[];
}

export interface InboxRead {
  entries: InboxEntry[];
  // Commit only when the turn starts, so a crash after reading cannot lose the message.
  endOffsets: number[];
  collapsed: Array<{ sender: string; count: number }>;
  cursor: InboxCursor;
}

export const SEEN_MAX = 500;

export function loadCursor(path: string, inboxPath: string): InboxCursor {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed?.offset === "number" && parsed.offset >= 0) {
      return { offset: parsed.offset, seen: Array.isArray(parsed.seen) ? parsed.seen.map(String).slice(-SEEN_MAX) : [] };
    }
  } catch {
    // Starting at the end avoids replaying old messages when the cursor is missing or corrupt.
  }
  let size = 0;
  try { size = existsSync(inboxPath) ? Buffer.byteLength(readFileSync(inboxPath)) : 0; } catch { size = 0; }
  return { offset: size, seen: [] };
}

export function saveCursor(path: string, cursor: InboxCursor): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ offset: cursor.offset, seen: cursor.seen.slice(-SEEN_MAX) }), "utf8");
  renameSync(tmp, path);
}

export const DEFAULT_INBOX_BATCH_BYTES = 256 * 1024;

export function inboxBatchBytes(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.BRAIN_INBOX_BATCH_BYTES);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_INBOX_BATCH_BYTES;
}

function* inboxLines(fd: number, offset: number, size: number, limit: () => number): Generator<{ line: string; end: number }> {
  const chunk = Buffer.alloc(64 * 1024);
  let fragments: Buffer[] = [];
  while (offset < Math.min(size, limit())) {
    const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, size - offset, limit() - offset), offset);
    if (!bytes) break;
    let start = 0;
    for (let i = 0; i < bytes; i++) {
      if (chunk[i] !== 0x0a) continue;
      const tail = chunk.subarray(start, i);
      const line = fragments.length ? Buffer.concat([...fragments, tail]).toString("utf8") : tail.toString("utf8");
      fragments = [];
      yield { line, end: offset + i + 1 };
      start = i + 1;
    }
    if (start < bytes) fragments.push(Buffer.from(chunk.subarray(start, bytes)));
    offset += bytes;
  }
}

function repeatKey(entry: InboxEntry): string | null {
  if ((entry.type && entry.type !== "text") || entry.image_path || entry.file_path || entry.location) return null;
  // Commands are answered by Brain one by one; a repeated command still gets its own answer.
  if (String(entry.text ?? "").trimStart().startsWith("/")) return null;
  // Different routing or other metadata is not a true repeat; only ids and times may differ.
  return JSON.stringify(Object.keys(entry).filter((key) => !["id", "ts", "repeat_count"].includes(key))
    .sort().map((key) => [key, entry[key]]));
}

export function readInbox(inboxPath: string, cursor: InboxCursor, batchBytes = inboxBatchBytes()): InboxRead {
  const none = (c: InboxCursor): InboxRead => ({ entries: [], endOffsets: [], collapsed: [], cursor: c });
  if (!existsSync(inboxPath)) return none(cursor);
  const budget = Number.isSafeInteger(batchBytes) && batchBytes > 0 ? batchBytes : DEFAULT_INBOX_BATCH_BYTES;
  const fd = openSync(inboxPath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < cursor.offset) return none({ offset: size, seen: cursor.seen });
    if (size === cursor.offset) return none(cursor);
    const seen = new Set(cursor.seen);
    const fresh: InboxEntry[] = [];
    const ends: number[] = [];
    const repeats = new Map<string, number>();
    const collapsed = new Map<string, number>();
    let position = cursor.offset;
    // A complete oversized first entry still progresses; partial lines wait for the next read.
    for (const { line, end } of inboxLines(fd, cursor.offset, size,
      () => fresh.length ? cursor.offset + budget : size)) {
      if (fresh.length && end - cursor.offset > budget) break;
      position = end;
      let entry: InboxEntry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry !== "object" || !(entry.text || entry.type === "image" || entry.type === "file")) continue;
      // A rewritten or rotated inbox file can bring delivered lines back; their ids keep them out.
      if (entry.id && seen.has(entry.id)) continue;
      if (entry.id) seen.add(entry.id);
      const key = repeatKey(entry);
      const earlier = key === null ? undefined : repeats.get(key);
      if (earlier !== undefined) {
        fresh[earlier].repeat_count = Number(fresh[earlier].repeat_count) + 1;
        // Never move an earlier representative's commit past an intervening unique entry.
        ends[ends.length - 1] = position;
        const sender = String(entry.from ?? entry.user ?? process.env.BRAIN_USER_NAME ?? "User");
        collapsed.set(sender, (collapsed.get(sender) ?? 0) + 1);
      } else {
        if (key !== null) repeats.set(key, fresh.length);
        fresh.push({ ...entry, repeat_count: 1 });
        ends.push(position);
      }
      if (position - cursor.offset >= budget) break;
    }
    return { entries: fresh, endOffsets: ends,
      collapsed: [...collapsed].map(([sender, count]) => ({ sender, count })),
      cursor: { offset: position, seen: [...seen].slice(-SEEN_MAX) } };
  } finally {
    closeSync(fd);
  }
}

export function commitCursor(cursor: InboxCursor, endOffset: number, id?: string): InboxCursor {
  const seen = id && !cursor.seen.includes(id) ? [...cursor.seen, id].slice(-SEEN_MAX) : cursor.seen;
  return { offset: Math.max(cursor.offset, endOffset), seen };
}

// Callers split on ", " to extract the time.
export function houseLocal(iso: string): string {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone: brainTimezone(), year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    if (!p.year) return iso;
    const date = brainLanguage() === "de" ? `${p.day}.${p.month}.${p.year}` : `${p.year}-${p.month}-${p.day}`;
    return `${date}, ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
  } catch {
    return iso;
  }
}

function attr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function inboxConsoleLine(entry: InboxEntry, user = process.env.BRAIN_USER_NAME || "User"): string {
  const time = houseLocal(entry.ts || new Date().toISOString()).split(", ").pop() ?? "";
  const tags: string[] = [];
  if (entry.image_path || entry.type === "image") tags.push(tr("[Image]"));
  else if (entry.file_path || entry.type === "file") tags.push(tr`[File: ${entry.file_name || tr("unknown")}]`);
  if (entry.type === "voice") tags.push(tr("[Voice]"));
  const text = String(entry.text ?? "").trim();
  const who = isForeignEntry(entry) ? String(entry.from ?? "unknown") : user;
  return `\n» ${who} ${time}: ${[text, ...tags].filter(Boolean).join(" ")}`;
}

// External and scheduled messages must not gain the authority of a user command.
export function isForeignEntry(entry: InboxEntry): boolean {
  return entry.source === "email" || entry.source === "room" || entry.source === "peer" || entry.source === "scheduled" || houseForeignSource(entry);
}

// A room tool answers a room turn; the house may have outside rooms of its own (rooms seam).
export function isRoomTool(name: unknown): boolean {
  const tool = appToolName(name);
  return tool === "room" || houseRoomTool(tool);
}

export function roomSpeechLine(name: unknown, input: unknown): string | null {
  if (!isRoomTool(name) || !input || typeof input !== "object") return null;
  const { text, room, action } = input as { text?: unknown; room?: unknown; action?: unknown };
  if (typeof text !== "string" || !text.trim()) return null;
  const houseLine = houseRoomSpeech(appToolName(name), { text, action });
  if (houseLine !== undefined) return houseLine;
  const where = typeof room === "string" && room.trim() ? `Room ${room.trim()}` : "Room";
  return `[${where}] ${text.trim()}`;
}

export function isPeerTool(name: unknown): boolean {
  return appToolName(name) === "peer";
}

// Named one-to-one delivery tools are direct messages too, not replies to the user.
function namedLineTarget(name: unknown): string | null {
  const match = appToolName(name)?.match(/^message_([a-z][a-z0-9-]*)$/i);
  return match ? match[1].charAt(0).toUpperCase() + match[1].slice(1) : null;
}

export function peerSpeechLine(name: unknown, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const line = namedLineTarget(name);
  if (line) {
    const { content, text } = input as { content?: unknown; text?: unknown };
    const body = typeof content === "string" ? content : typeof text === "string" ? text : "";
    return body.trim() ? `[Direct/${line}] ${body.trim()}` : null;
  }
  if (!isPeerTool(name)) return null;
  const { text, to } = input as { text?: unknown; to?: unknown };
  if (typeof text !== "string" || !text.trim()) return null;
  const where = typeof to === "string" && to.trim() ? `Direct/${to.trim()}` : "Direct";
  return `[${where}] ${text.trim()}`;
}

export function appReplySpeech(name: unknown, input: unknown): string {
  if (!isAppReplyTool(name)) return "";
  const args = input && typeof input === "object" ? input as Record<string, unknown> : {};
  if (appToolName(name) === "send_file") {
    const caption = typeof args.caption === "string" ? args.caption.trim() : "";
    const file = typeof args.path === "string" && args.path.trim() ? `[File: ${basename(args.path.trim())}]` : "";
    return [caption, file].filter(Boolean).join("\n\n");
  }
  return typeof args.text === "string" ? args.text : "";
}

/** Keep room and peer speech separate so neither is mistaken for a reply to the user. */
export function toolCallSpeech(calls: unknown): { texts: string[]; rooms: string[]; peers: string[] } {
  const texts: string[] = [];
  const rooms: string[] = [];
  const peers: string[] = [];
  for (const call of Array.isArray(calls) ? calls : []) {
    let args: any;
    try { args = JSON.parse(call?.function?.arguments || "{}"); } catch { continue; } 
    const room = roomSpeechLine(call?.function?.name, args);
    const peer = peerSpeechLine(call?.function?.name, args);
    if (room) rooms.push(room);
    else if (peer) peers.push(peer);
    else {
      const speech = appReplySpeech(call?.function?.name, args);
      if (speech.trim()) texts.push(speech);
    }
  }
  return { texts, rooms, peers };
}


// The app stores what a message answers as reply_to {id, snippet, role}; the
// snippet is the bubble's own text, already shortened by the app.
const QUOTE_MAX_CHARS = 300;
export function replyQuoteLine(entry: InboxEntry, user = process.env.BRAIN_USER_NAME || "User"): string {
  // Rooms, direct lines and mail carry their own context; only the person's app messages quote a bubble.
  const ref = entry.reply_to;
  if (entry.source || !ref || typeof ref !== "object") return "";
  const { snippet, role } = ref as { snippet?: unknown; role?: unknown };
  const flat = typeof snippet === "string" ? snippet.replace(/\s+/g, " ").trim() : "";
  if (!flat) return "";
  const text = flat.length > QUOTE_MAX_CHARS ? `${flat.slice(0, QUOTE_MAX_CHARS)}…` : flat;
  if (role === "assistant") return tr`↪ Replying to your message: "${text}"`;
  if (role === "email") return tr`↪ Replying to an email: "${text}"`;
  if (role === "user") return tr`↪ Replying to a message from ${user}: "${text}"`;
  return tr`↪ Replying to: "${text}"`;
}

export function channelTag(entry: InboxEntry, source = process.env.BRAIN_APP_SOURCE ?? appMcpServer(), user = process.env.BRAIN_USER_NAME || "User"): string {
  const who: Array<[string, string]> = entry.source === "email"
    ? [["kind", "email"], ["from", String(entry.from ?? "unknown")]]
    : entry.source === "room"
    ? [["kind", "room"], ["room", String(entry.room ?? "room")], ["from", String(entry.from ?? "unknown")]]
    : houseChannelWho(entry) ?? (entry.source === "peer"
    ? [["kind", "peer"], ["from", String(entry.from ?? "unknown")]]
    : entry.source === "scheduled"
    ? [["kind", "scheduled"], ["from", String(entry.from ?? "scheduled")]]
    : [["user", user]]);
  const meta: Array<[string, string]> = [
    ["source", source],
    ...who,
    ["ts", houseLocal(entry.ts || new Date().toISOString())],
    ["message_id", String(entry.id ?? "")],
  ];
  if (typeof entry.repeat_count === "number" && entry.repeat_count > 1) meta.push(["repeat_count", String(entry.repeat_count)]);
  const file = entry.image_path || entry.file_path;
  if (file) meta.push(["image_path", String(file)]);
  if (entry.file_name) meta.push(["file_name", String(entry.file_name)]);
  if (entry.type === "voice") meta.push(["voice", "1"]);
  if (entry.type === "voice" && typeof entry.klang === "string" && entry.klang) meta.push(["klang", entry.klang]);
  if (entry.type === "voice" && typeof entry.gesang === "string" && entry.gesang) meta.push(["gesang", entry.gesang]);
  const loc = entry.location;
  if (loc && typeof loc.lat === "number" && typeof loc.lon === "number") {
    const name = typeof loc.name === "string" && loc.name ? ` — ${loc.name}` : "";
    meta.push(["location", `${loc.lat},${loc.lon}${typeof loc.acc === "number" ? ` ±${loc.acc}m` : ""}${name}`]);
  }
  const quote = replyQuoteLine(entry, user);
  if (quote) meta.push(["reply_to", String((entry.reply_to as { id?: unknown }).id ?? "")]);
  const body = entry.text
    || (entry.type === "image" ? tr("[Image]") : entry.type === "file" ? tr`[File: ${entry.file_name || tr("unknown")}]` : "");
  // A body that itself contains a channel tag is defused, never trusted.
  const safeBody = (quote ? `${quote}\n${body}` : String(body)).replace(/<\/?channel\b/gi, (m) => m.replace("<", "‹"));
  return `<channel ${meta.map(([k, v]) => `${k}="${attr(v)}"`).join(" ")}>\n${safeBody}\n</channel>`;
}


export interface AppClientOptions {
  baseUrl: string;             
  token: string;               
  fetchImpl?: typeof fetch;
}

function authHeaders(token: string): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } : { "Content-Type": "application/json" };
}

export async function appBroadcast(opts: AppClientOptions, text: string, type: "reply" | "send" | "voice" = "reply"): Promise<{ ok: boolean; status: number; id: string }> {
  const id = `brain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`${opts.baseUrl.replace(/\/$/, "")}/api/internal/broadcast`, {
      method: "POST",
      headers: authHeaders(opts.token),
      body: JSON.stringify({ id, text, ts: new Date().toISOString(), type }),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: response.ok, status: response.status, id };
  } catch {
    return { ok: false, status: 0, id };
  }
}

export const APPROVAL_LIFETIME_MS = 1_800_000;
export type ApprovalDecision = "allow" | "deny" | "expired" | "error";
export type ApprovalOutcome = "allow" | "deny" | "expired" | "unreachable" | "invalid" | "disconnected" | "shutdown";
export interface ApprovalResult { decision: ApprovalDecision; id: string | null; outcome: ApprovalOutcome }
export interface ApprovalOptions extends AppClientOptions {
  pollMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onEnd?: (event: Record<string, unknown>) => void;
}

export function approvalFailure(outcome: ApprovalOutcome): string {
  switch (outcome) {
    case "unreachable": return "approval endpoint unreachable";
    case "expired": return "no approval response within the card deadline";
    case "invalid": return "invalid approval response";
    case "shutdown": return "approval wait ended: Brain shutting down; no approval received";
    case "disconnected": return "approval connection lost while waiting; no approval received";
    default: return "approval denied";
  }
}

function approvalPause(ms: number, signal?: AbortSignal, sleep?: (ms: number) => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new Error("approval wait cancelled"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    if (sleep) sleep(ms).then(() => finish(), finish);
    else timer = setTimeout(finish, ms);
  });
}

export async function askApproval(
  opts: ApprovalOptions,
  title: string,
  detail: string,
  kind = "brain",
): Promise<ApprovalResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const started = now();
  const base = opts.baseUrl.replace(/\/$/, "");
  let id: string | null = null;
  let deadline = started + (opts.timeoutMs ?? APPROVAL_LIFETIME_MS);
  const cancelled = (): ApprovalOutcome => opts.signal?.reason === "shutdown" ? "shutdown" : "disconnected";
  const cardDeadline = (data: any) => {
    const raw = data?.expiresAt ?? data?.expires_at;
    if (raw === undefined) return;
    const value = typeof raw === "number" ? raw : Date.parse(raw);
    if (Number.isFinite(value)) deadline = opts.timeoutMs === undefined ? value : Math.min(deadline, value);
  };
  const wait = async (): Promise<ApprovalOutcome> => {
    if (opts.signal?.aborted) return cancelled();
    let response: Response;
    try {
      // Finish creation even after caller cancellation so a returned card can be closed.
      response = await doFetch(`${base}/api/approval/ask`, {
        method: "POST", headers: authHeaders(opts.token),
        body: JSON.stringify({ title, detail, kind }),
        signal: AbortSignal.timeout(10_000), timeout: false,
      });
    } catch { return "unreachable"; }
    const data: any = await response.json().catch(() => null);
    id = typeof data?.id === "string" || typeof data?.id === "number" ? String(data.id) : null;
    if (!response.ok || !id) return "invalid";
    cardDeadline(data);
    while (now() < deadline) {
      if (opts.signal?.aborted) return cancelled();
      try {
        await approvalPause(Math.min(opts.pollMs ?? 3000, deadline - now()), opts.signal, opts.sleep);
        if (now() >= deadline) return "expired";
        const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(10_000, deadline - now()))));
        const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
        const response = await doFetch(`${base}/api/approval/${encodeURIComponent(id)}`, {
          headers: authHeaders(opts.token), signal, timeout: false,
        });
        const data: any = await response.json().catch(() => null);
        if (opts.signal?.aborted) return cancelled();
        // A poll the app could not answer is not a decision: the app may be restarting while the card waits.
        if (!response.ok || !data) continue;
        cardDeadline(data);
        if (now() >= deadline) return "expired";
        const decision = String(data.decision ?? data.status ?? "").toLowerCase();
        if (["allow", "approved", "yes"].includes(decision)) return "allow";
        if (["deny", "denied", "no"].includes(decision)) return "deny";
        if (decision === "expired") return "expired";
        if (decision !== "pending") return "invalid";
      } catch {
        if (opts.signal?.aborted) return cancelled();
        // A failed poll is not an approval decision; the card stays valid until its deadline.
        if (now() >= deadline) return "expired";
      }
    }
    return opts.signal?.aborted ? cancelled() : "expired";
  };
  const outcome = await wait();
  const waitMs = Math.max(0, now() - started);
  let closure = "not_needed";
  if (id && outcome !== "allow" && outcome !== "deny") {
    closure = "failed";
    // Cancellation must not abort the independent, bounded card cleanup request.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await doFetch(`${base}/api/approval/${encodeURIComponent(id)}/decide`, {
          method: "POST", headers: authHeaders(opts.token), body: JSON.stringify({ decision: "expired" }),
          signal: AbortSignal.timeout(10_000), timeout: false,
        });
        if (response.ok) { closure = "expired"; break; }
      } catch { /* A second attempt can survive a transient connection loss. */ }
    }
  }
  const decision: ApprovalDecision = outcome === "allow" || outcome === "deny" || outcome === "expired" ? outcome : "error";
  opts.onEnd?.({ type: "approval_decision", decision, outcome, wait_ms: waitMs, card_id: id, closure });
  return { decision, id, outcome };
}

/** Keep shutdown alive until pending cards have been closed and their outcomes logged. */
export class ApprovalWaits {
  private controller = new AbortController();
  private pending = new Set<Promise<ApprovalResult>>();
  ask(opts: ApprovalOptions, title: string, detail: string, kind = "brain"): Promise<ApprovalResult> {
    const signal = opts.signal ? AbortSignal.any([opts.signal, this.controller.signal]) : this.controller.signal;
    const promise = askApproval({ ...opts, signal }, title, detail, kind);
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }
  async stop(): Promise<void> {
    this.controller.abort("shutdown");
    await Promise.allSettled([...this.pending]);
  }
}
