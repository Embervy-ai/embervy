/** Archive header dates: the local calendar day, in the configured zone
 * (BRAIN_TIMEZONE, then EMBERVY_TIMEZONE), on which a session's first message
 * was written. Not UTC and not the moment of archiving: a session that starts
 * at 00:30 local time belongs to that local day, and a session that runs past
 * midnight keeps the day it started on. The inlet's time channel looks
 * sessions up by this date. */
import { brainTimezone } from "./time-marks";
import { isCachePingRecord } from "./wake-bridge";

/** "YYYY-MM-DD" of an instant in a zone. */
export function localDateKey(atMs: number, zone: string = brainTimezone()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(atMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** A message the archive renders: user or assistant text, not the bridge. */
function rendered(role: unknown, content: unknown): boolean {
  if (role !== "user" && role !== "assistant") return false;
  const text = typeof content === "string" ? content.trim() : "";
  return Boolean(text) && !text.startsWith("[bridge ");
}

// When each in-process message object was logged (set by logTurn). Objects
// only: nothing is kept alive by this map.
const loggedAt = new WeakMap<object, number>();

export function noteLoggedAt(message: object, atMs: number): void {
  loggedAt.set(message, atMs);
}

/** Log time of the first rendered message in a list, or null. */
export function firstLoggedAt(messages: readonly { role: unknown; content: unknown }[]): number | null {
  for (const message of messages) {
    if (!rendered(message.role, message.content)) continue;
    const at = loggedAt.get(message);
    if (at !== undefined) return at;
  }
  return null;
}

/** ts of the first rendered message in a conversation log (JSONL), or null.
 * Skips the same entries historyFromConversationLog skips. */
export function firstMessageAtInLog(text: string): number | null {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.origin === "claude_pipe" || isCachePingRecord(entry) || entry.intermediate) continue;
    if (!rendered(entry.role, entry.content)) continue;
    const at = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
    if (Number.isFinite(at)) return at;
  }
  return null;
}
