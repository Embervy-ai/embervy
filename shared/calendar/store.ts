/**
 * The agent's own calendar — one JSON file in the app's data directory
 * (data/calendar.json). The agent keeps it through the `calendar` tool; the
 * day line, the phone feed and `calendar list` all read it.
 *
 * Entries are house-local: `date` "YYYY-MM-DD", optional `time`/`end`
 * "HH:MM" in EMBERVY_TIMEZONE. No time = all-day. `private: true` keeps an
 * entry off the phone feed; the agent itself always sees it.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDate, parseTime } from "./time";

export interface CalendarEntry {
  id: string;
  title: string;
  date: string;
  time: string | null;
  end?: string | null;
  note: string | null;
  private?: boolean;
  created: string;
}

export const CALENDAR_FILE_NAME = "calendar.json";
export const EXTERNAL_CACHE_NAME = "calendar-external.json";

export function calendarFile(dataDir: string): string {
  return join(dataDir, CALENDAR_FILE_NAME);
}

export function readEntries(file: string): CalendarEntry[] {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data) ? data.filter((e) => e && typeof e === "object" && typeof e.date === "string") : [];
  } catch {
    return [];
  }
}

/** Atomic write (temp + rename): a crash mid-write never leaves half a file. */
export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function writeEntries(file: string, entries: CalendarEntry[]): void {
  writeJsonAtomic(file, entries);
}

const MAX_TITLE = 200;
const MAX_NOTE = 2000;

function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

/** Validate an add request. Returns the entry to store, or an error text. */
export function validateNewEntry(body: any, now: Date = new Date()): { entry?: CalendarEntry; error?: string } {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const date = typeof body?.date === "string" ? body.date.trim() : "";
  if (!title || !date) return { error: "title and date required" };
  if (title.length > MAX_TITLE) return { error: `title longer than ${MAX_TITLE} characters` };
  if (!parseDate(date)) return { error: "date must be YYYY-MM-DD" };
  const time = typeof body?.time === "string" && body.time.trim() ? body.time.trim() : null;
  if (time && !parseTime(time)) return { error: "time must be HH:MM (24h)" };
  const end = typeof body?.end === "string" && body.end.trim() ? body.end.trim() : null;
  if (end && !time) return { error: "end needs a start time" };
  if (end && !parseTime(end)) return { error: "end must be HH:MM (24h)" };
  if (end && time && end <= time) return { error: "end must be after time on the same day" };
  const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, MAX_NOTE) : null;
  return {
    entry: {
      id: crypto.randomUUID(),
      title,
      date,
      time,
      ...(end ? { end } : {}),
      note,
      ...(truthy(body?.private) ? { private: true } : {}),
      created: now.toISOString(),
    },
  };
}

function sortKey(e: { date: string; time?: string | null }): string {
  // All-day entries first within a day, then by time.
  return `${e.date} ${e.time || "00:00"}${e.time ? "1" : "0"}`;
}

export function sortEntries<T extends { date: string; time?: string | null }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

/** Entries on or after `today` (house-local date), sorted. */
export function upcomingEntries(entries: CalendarEntry[], today: string): CalendarEntry[] {
  return sortEntries(entries.filter((e) => e.date >= today));
}

export function entriesOn(entries: CalendarEntry[], day: string): CalendarEntry[] {
  return sortEntries(entries.filter((e) => e.date === day));
}
