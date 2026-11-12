// Converts calendar dates and times between local zones and UTC.

import { envValue } from "../scripts/legacy-names";

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Unlike shell sourcing, systemd's EnvironmentFile preserves inline comments in values.
export function envWord(v: string | undefined): string {
  return (v ?? "").trim().replace(/^(['"])(.*)\1$/, "$2").split(/\s+/)[0] ?? "";
}

export function houseTimeZone(env: Record<string, string | undefined> = process.env): string {
  const tz = envWord(envValue("EMBERVY_TIMEZONE", env));
  return isValidTimeZone(tz) ? tz : "UTC";
}

export interface WallTime {
  year: number;
  month: number; 
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; 
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallTimeIn(tz: string, instant: number): WallTime {
  const p: Record<string, string> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(instant))) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
    weekday: WEEKDAYS[p.weekday] ?? 0,
  };
}

function offsetAt(tz: string, instant: number): number {
  const whole = Math.floor(instant / 1000) * 1000;
  const w = wallTimeIn(tz, whole);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - whole;
}

// The offset can change when correcting the UTC guess, so check it again at the corrected instant.
export function zonedToUtc(tz: string, y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = offsetAt(tz, guess);
  let t = guess - off1;
  const off2 = offsetAt(tz, t);
  if (off2 !== off1) t = guess - off2;
  return t;
}

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function localDate(tz: string, instant: number = Date.now()): string {
  const w = wallTimeIn(tz, instant);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

export function localTime(tz: string, instant: number): string {
  const w = wallTimeIn(tz, instant);
  return `${pad2(w.hour)}:${pad2(w.minute)}`;
}

export function parseDate(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function parseTime(s: string): { h: number; mi: number } | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

export function addDays(date: string, days: number): string {
  const p = parseDate(date);
  if (!p) return date;
  const t = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

export function weekdayOf(date: string): number {
  const p = parseDate(date);
  return p ? new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() : 0;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export function weekdayName(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)];
}
