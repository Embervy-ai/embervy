// Exchanges messages with remote group rooms using member keys.
// The remote room binds the sender to the key.
// Incoming room text stays foreign content, never the user's voice.

import { createHash } from "node:crypto";
import { defuseSenderLines } from "./message-fields";

export type RoomConfig = { name: string; base: string; token: string; pollMs: number };
export type RoomState = { after: string; seen: string[] };
export type RoomEntry = { id: string; from: string; room: string; text: string; ts: string; source: "room" };

export const ROOM_TEXT_MAX = 8000;
const SEEN_MAX = 300;
export const ROOM_POLL_LIMIT = 50;
const FIRST_LOOK_BACK_MS = 10 * 60 * 1000;

function cleanRoomName(name: unknown): string {
  return (typeof name === "string" ? name : "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 40) || "Room";
}

function roomConfig(value: any): RoomConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected a room object");
  const rawUrl = typeof value.url === "string" ? value.url.trim() : "";
  const token = typeof value.token === "string" ? value.token.trim() : "";
  if (!rawUrl || !token) throw new Error("URL and token required");
  if (token.length < 32 || /\s/.test(token)) throw new Error("token must have at least 32 characters without whitespace");
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new Error("invalid URL"); }
  const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new Error("URL must use https or loopback http");
  if (url.username || url.password || url.search || url.hash) throw new Error("URL must not contain credentials, query or hash");
  const seconds = Number(value.poll_seconds);
  const pollMs = Number.isFinite(seconds) && seconds >= 15 ? Math.floor(seconds * 1000) : 60_000;
  return { name: cleanRoomName(value.name), base: url.origin + url.pathname.replace(/\/+$/, ""), token, pollMs };
}

export function roomConfigFromEnv(env: Record<string, string | undefined>): RoomConfig | null {
  try {
    return roomConfig({ url: env.EMBERVY_ROOM_URL, token: env.EMBERVY_ROOM_TOKEN, name: env.EMBERVY_ROOM_NAME, poll_seconds: env.EMBERVY_ROOM_POLL_SECONDS });
  } catch { return null; }
}

export function roomConfigsFromEnv(env: Record<string, string | undefined>, warn: (line: string) => void = line => process.stderr.write(line + "\n")): RoomConfig[] {
  const rooms: RoomConfig[] = [];
  const add = (value: unknown, label: string) => {
    try {
      const cfg = roomConfig(value);
      if (rooms.some(room => room.name === cfg.name)) throw new Error("duplicate cleaned name");
      rooms.push(cfg);
    } catch (err) {
      warn(`embervy-app: room (${label}) skipped: ${(err as Error).message}`);
    }
  };
  if (env.EMBERVY_ROOM_URL || env.EMBERVY_ROOM_TOKEN || env.EMBERVY_ROOM_NAME) {
    add({ url: env.EMBERVY_ROOM_URL, token: env.EMBERVY_ROOM_TOKEN, name: env.EMBERVY_ROOM_NAME, poll_seconds: env.EMBERVY_ROOM_POLL_SECONDS }, "legacy");
  }
  if (env.EMBERVY_ROOMS?.trim()) {
    let list: unknown;
    try { list = JSON.parse(env.EMBERVY_ROOMS); } catch {
      warn("embervy-app: EMBERVY_ROOMS skipped: invalid JSON list");
      return rooms;
    }
    if (!Array.isArray(list)) warn("embervy-app: EMBERVY_ROOMS skipped: expected a JSON list");
    else list.forEach((value, index) => add(value, `EMBERVY_ROOMS[${index}]`));
  }
  return rooms;
}

export function roomMessagePrefix(name: string): string {
  // Independent servers can issue the same message ID; keep inbox IDs distinct.
  return `room-${createHash("sha256").update(name).digest("hex").slice(0, 16)}:`;
}

export function roomStateFileName(name: string, index: number): string {
  // The first room keeps the default cursor so adding rooms does not reset its position.
  return index === 0 ? "room-state.json" : `room-state-${cleanRoomName(name)}.json`;
}

export function parseRoomState(text: string | null, now = Date.now()): RoomState {
  const fresh: RoomState = { after: new Date(now - FIRST_LOOK_BACK_MS).toISOString(), seen: [] };
  if (!text) return fresh;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v.after !== "string" || !Number.isFinite(Date.parse(v.after))) return fresh;
    const seen = Array.isArray(v.seen) ? v.seen.filter((s: unknown) => typeof s === "string").slice(-SEEN_MAX) : [];
    return { after: v.after, seen };
  } catch {
    return fresh;
  }
}

function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  let t = s.slice(0, n);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t + "…";
}

function displayName(m: any): string {
  const raw = typeof m?.sender_name === "string" && m.sender_name.trim() ? m.sender_name : String(m?.sender || "?");
  const clean = raw.replace(/[\[\]\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "").trim().slice(0, 40) || "?";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function roomEntries(messages: unknown, state: RoomState, roomName: string): { entries: RoomEntry[]; state: RoomState } {
  const list = Array.isArray(messages) ? messages.slice(0, ROOM_POLL_LIMIT) : [];
  const seen = new Set(state.seen);
  let after = state.after;
  const entries: RoomEntry[] = [];
  for (const m of list as any[]) {
    if (!m || typeof m.id !== "string" || typeof m.ts !== "string" || typeof m.text !== "string") continue;
    if (!Number.isFinite(Date.parse(m.ts))) continue;
    if (m.ts > after) after = m.ts;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if ((m.type || "text") !== "text" || !m.text.trim()) continue;
    const from = displayName(m);
    let quote = "";
    const rp = m.reply_preview;
    if (rp && typeof rp === "object" && typeof rp.text === "string") {
      quote = `[replying to ${displayName({ sender: rp.sender })}: "${cut(rp.text.replace(/\s+/g, " ").trim(), 90)}"] `;
    }
    entries.push({
      id: `room-${m.id.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 100)}`,
      from,
      room: roomName,
      text: `[${cleanRoomName(roomName)}/${from}] ${quote}${defuseSenderLines(cut(m.text, ROOM_TEXT_MAX))}`,
      ts: m.ts,
      source: "room",
    });
  }
  return { entries, state: { after, seen: [...seen].slice(-SEEN_MAX) } };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function pollRoom(cfg: RoomConfig, state: RoomState, fetchImpl: FetchLike = fetch): Promise<{ entries: RoomEntry[]; state: RoomState }> {
  const url = `${cfg.base}/api/synth/messages?after=${encodeURIComponent(state.after)}&limit=${ROOM_POLL_LIMIT}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${cfg.token}` }, redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`room answered HTTP ${res.status}`);
  const data = (await res.json()) as any;
  return roomEntries(data?.messages, state, cfg.name);
}

export async function sendToRoom(cfg: RoomConfig, text: string, replyTo: string | undefined, fetchImpl: FetchLike = fetch): Promise<{ ok: true; id: string } | { ok: false; status: number; reason: string }> {
  const body: Record<string, string> = { text: cut(text, ROOM_TEXT_MAX) };
  // The room knows the bare ID, not the inbox prefix.
  const prefix = roomMessagePrefix(cfg.name);
  const rid = replyTo?.startsWith(prefix) ? replyTo.slice(prefix.length) : (replyTo || "").replace(/^room-/, "");
  if (rid && /^[A-Za-z0-9-]{1,100}$/.test(rid)) body.reply_to = rid;
  try {
    const res = await fetchImpl(`${cfg.base}/api/synth/send`, {
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await res.json().catch(() => null)) as any;
    if (!res.ok) return { ok: false, status: res.status, reason: String(data?.error || `HTTP ${res.status}`).slice(0, 200) };
    return { ok: true, id: String(data?.message?.id || "") };
  } catch (err) {
    return { ok: false, status: 0, reason: (err as Error)?.name === "TimeoutError" ? "the room did not answer within 20s" : "the room is unreachable" };
  }
}
