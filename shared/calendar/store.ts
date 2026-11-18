/**
 * The agent's own calendar — one JSON file in the app's data directory
 * (data/calendar.json). The agent keeps it through the `calendar` tool; the
 * day line, the phone feed and `calendar list` all read it.
 *
 * Entries are house-local: `date` "YYYY-MM-DD", optional `time`/`end`
 * "HH:MM" in EMBERVY_TIMEZONE. No time = all-day. `private: true` keeps an
 * entry off the phone feed; the agent itself always sees it.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { addDays, parseDate, parseTime, weekdayOf } from "./time";

export interface CalendarEntry {
  id: string;
  series?: string;
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
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } finally {
    // Failed staging must not leave partial calendar data beside the live file.
    rmSync(tmp, { force: true });
  }
}

export function writeEntries(file: string, entries: CalendarEntry[]): void {
  // Preserve existing formatting when a caller saves an unchanged calendar.
  try {
    if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) === JSON.stringify(entries)) return;
  } catch {}
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

const REPEAT_WEEKDAYS = [
  ["su", "sunday"], ["mo", "monday"], ["tu", "tuesday"], ["we", "wednesday"],
  ["th", "thursday"], ["fr", "friday"], ["sa", "saturday"],
];

export function validateNewEntries(body: any, now: Date = new Date()): { entries?: CalendarEntry[]; error?: string } {
  const { entry, error } = validateNewEntry(body, now);
  if (!entry) return { error };
  if (body.repeat_weekdays === undefined) {
    if (body.repeat_until !== undefined || body.except_dates !== undefined) {
      return { error: "repeat_until and except_dates need repeat_weekdays" };
    }
    return { entries: [entry] };
  }
  const weekdays = new Set<number>();
  if (Array.isArray(body.repeat_weekdays)) {
    for (const value of body.repeat_weekdays) {
      if (typeof value !== "string") continue;
      const day = REPEAT_WEEKDAYS.findIndex((names) => names.includes(value.trim().toLowerCase()));
      if (day >= 0) weekdays.add(day);
    }
  }
  if (!weekdays.size) return { error: "repeat_weekdays needs at least one valid weekday (mo tu we th fr sa su)" };
  const until = body.repeat_until;
  if (typeof until !== "string" || !parseDate(until)) return { error: "repeat_until required: YYYY-MM-DD" };
  if (until < entry.date) return { error: "repeat_until must not be before date" };
  const except = body.except_dates === undefined ? [] : body.except_dates;
  if (!Array.isArray(except) || except.some((day) => typeof day !== "string" || !parseDate(day))) {
    return { error: "except_dates must be a list of valid YYYY-MM-DD dates" };
  }
  const excluded = new Set(except);
  const dates: string[] = [];
  // These are house-local calendar dates, not instants separated by 24 hours.
  // Keeping time/end unchanged preserves the wall clock across offset changes.
  for (let day = entry.date, span = 1; day <= until; day = addDays(day, 1), span++) {
    if (span > 366) return { error: "series span must not exceed 366 calendar days" };
    if (weekdays.has(weekdayOf(day)) && !excluded.has(day)) dates.push(day);
    if (day === until) break;
  }
  if (dates.length > 200) return { error: "series must not exceed 200 entries" };
  if (!dates.length) return { error: "series has no entries after weekday selection and exceptions" };
  const series = crypto.randomUUID();
  return { entries: dates.map((date) => ({ ...entry, id: crypto.randomUUID(), date, series })) };
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
