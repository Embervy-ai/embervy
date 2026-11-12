/** Inserts time markers into conversation gaps. */

import { tr } from "./texts";

// Without a zone setting a house shows UTC, as INSTALL.md and .env.example say; the installer writes the buyer's own zone.
const DEFAULT_ZONE = "UTC";
const validZones = new Set<string>([DEFAULT_ZONE]);
let timezoneWarned = false;

// Read lazily so environment configuration is loaded first.
export function brainTimezone(env: Record<string, string | undefined> = process.env, explicit?: string,
  warn: (message: string) => void = console.warn): string {
  const zone = explicit?.trim() || env.BRAIN_TIMEZONE?.trim() || env.EMBERVY_TIMEZONE?.trim() || DEFAULT_ZONE;
  if (validZones.has(zone)) return zone;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
    validZones.add(zone);
    return zone;
  } catch {
    if (!timezoneWarned) { timezoneWarned = true; warn(tr`Brain: invalid timezone ${JSON.stringify(zone)} — falling back to ${DEFAULT_ZONE}`); }
    return DEFAULT_ZONE;
  }
}

export interface TimedMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_id?: string;
  ts?: string;
  [key: string]: unknown;
}

export const TIME_MARK_PREFIX = "⏳";

export const DEFAULT_TIME_MARK_MIN_MS = 3 * 3_600_000;

function berlinDateKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function localParts(date: Date, timeZone: string): { weekday: string; hh: string; mm: string; dateKey: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  // getDay() would use the system timezone rather than the configured one.
  const weekdayIndex = weekdayIndexInZone(date, timeZone);
  return { weekday: tr(WEEKDAYS[weekdayIndex]), hh: values.hour === "24" ? "00" : values.hour, mm: values.minute, dateKey: berlinDateKey(date, timeZone) };
}

function weekdayIndexInZone(date: Date, timeZone: string): number {
  const long = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(date);
  const englishWeekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const index = englishWeekdays.indexOf(long);
  return index >= 0 ? index : 0;
}

type StampMode = "time-only" | "date-and-time" | "date-only";

function formatStamp(date: Date, timeZone: string, mode: StampMode): string {
  const { weekday, hh, mm, dateKey } = localParts(date, timeZone);
  if (mode === "time-only") return `${weekday} ${hh}:${mm}`;
  const [, month, day] = dateKey.split("-");
  if (mode === "date-only") return `${weekday} ${day}.${month}.`;
  return `${weekday} ${day}.${month}. ${hh}:${mm}`;
}

function calendarDayDiff(from: Date, to: Date, timeZone: string): number {
  const fromKey = berlinDateKey(from, timeZone);
  const toKey = berlinDateKey(to, timeZone);
  if (fromKey === toKey) return 0;
  // Treat local date keys as UTC dates so daylight saving cannot change the day count.
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  const fromUtcMidnight = Date.UTC(fy, fm - 1, fd);
  const toUtcMidnight = Date.UTC(ty, tm - 1, td);
  return Math.round((toUtcMidnight - fromUtcMidnight) / 86_400_000);
}

export function formatTimeMark(from: Date, to: Date, timeZone = brainTimezone()): string {
  timeZone = brainTimezone(process.env, timeZone);
  const gapMs = to.getTime() - from.getTime();
  const dayDiff = calendarDayDiff(from, to, timeZone);

  if (dayDiff > 1) {
    const fullDays = Math.floor(gapMs / 86_400_000);
    const fromStamp = formatStamp(from, timeZone, "time-only");
    const toStamp = formatStamp(to, timeZone, "date-and-time");
    return tr`— ${fullDays} days of silence, ${fromStamp} → ${toStamp} —`;
  }

  if (dayDiff === 1 && gapMs < 3_600_000) {
    const toStamp = formatStamp(to, timeZone, "date-only");
    return tr`— New day → ${toStamp} —`;
  }

  const hours = Math.round(gapMs / 3_600_000);
  const fromStamp = formatStamp(from, timeZone, "time-only");
  const toStamp = formatStamp(to, timeZone, "time-only");
  return tr`— ${hours}h of silence, ${fromStamp} → ${toStamp} —`;
}

// A distinct prefix keeps synthetic context from looking like a signed channel message.
export function makeTimeMarkMessage(from: Date, to: Date, timeZone = brainTimezone()): TimedMessage {
  return { role: "user", content: `${TIME_MARK_PREFIX} ${formatTimeMark(from, to, timeZone)}` };
}

function messageTimestamp(message: TimedMessage): Date | null {
  if (typeof message.ts !== "string") return null;
  const date = new Date(message.ts);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Markers must not split a tool call from its result.
function isTurnBoundary(message: TimedMessage): boolean {
  return message.role === "user" && typeof message.content === "string";
}

export interface TimeMarkOptions {
  minGapMs?: number;
  timeZone?: string;
}

export function insertTimeMarks(
  messages: readonly TimedMessage[],
  options: TimeMarkOptions = {},
): TimedMessage[] {
  const minGapMs = options.minGapMs ?? DEFAULT_TIME_MARK_MIN_MS;
  const timeZone = brainTimezone(process.env, options.timeZone);
  const result: TimedMessage[] = [];
  let lastBoundaryTs: Date | null = null;

  for (const message of messages) {
    if (isTurnBoundary(message)) {
      const ts = messageTimestamp(message);
      if (ts && lastBoundaryTs) {
        const gapMs = ts.getTime() - lastBoundaryTs.getTime();
        const dateJump = berlinDateKey(lastBoundaryTs, timeZone) !== berlinDateKey(ts, timeZone);
        if (gapMs >= minGapMs || dateJump) {
          result.push(makeTimeMarkMessage(lastBoundaryTs, ts, timeZone));
        }
      }
      if (ts) lastBoundaryTs = ts;
    }
    result.push(message);
  }

  return result;
}
