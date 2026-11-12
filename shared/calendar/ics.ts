// Writes read-only ICS subscription feeds.
// UTC times avoid requiring clients to interpret VTIMEZONE definitions.

import type { CalendarEntry } from "./store";
import { addDays, parseDate, parseTime, pad2, zonedToUtc } from "./time";

export function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545 limits content lines to 75 octets, including the continuation space.
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = "";
      curBytes = 0;
      limit = 74; 
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n ");
}

export function formatUtc(instant: number): string {
  const d = new Date(instant);
  return (
    `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`
  );
}

export function formatDate(date: string): string {
  return date.replace(/-/g, "");
}

export interface FeedOptions {
  calName: string;
  tz: string;
  now?: number;
  refreshMinutes?: number;
}

export function feedEntries(entries: CalendarEntry[]): CalendarEntry[] {
  return entries.filter(
    (e) =>
      e.private !== true &&
      typeof e.title === "string" &&
      !!parseDate(e.date) &&
      (!e.time || !!parseTime(e.time)),
  );
}

function uidFor(e: CalendarEntry): string {
  const base = e.id || `${e.date}-${e.time || "allday"}-${e.title}`;
  return `${base.replace(/[^A-Za-z0-9._-]/g, "-")}@embervy-calendar`;
}

export function renderFeed(entries: CalendarEntry[], opts: FeedOptions): string {
  const now = opts.now ?? Date.now();
  const refresh = Math.max(5, Math.round(opts.refreshMinutes ?? 30));
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Embervy//agent calendar feed//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(opts.calName)}`,
    `REFRESH-INTERVAL;VALUE=DURATION:PT${refresh}M`,
    `X-PUBLISHED-TTL:PT${refresh}M`,
  ];
  const stamp = formatUtc(now);
  for (const e of feedEntries(entries)) {
    const d = parseDate(e.date)!;
    lines.push("BEGIN:VEVENT", `UID:${uidFor(e)}`, `DTSTAMP:${stamp}`);
    const t = e.time ? parseTime(e.time) : null;
    if (!t) {
      lines.push(`DTSTART;VALUE=DATE:${formatDate(e.date)}`, `DTEND;VALUE=DATE:${formatDate(addDays(e.date, 1))}`);
    } else {
      const start = zonedToUtc(opts.tz, d.y, d.m, d.d, t.h, t.mi);
      lines.push(`DTSTART:${formatUtc(start)}`);
      const end = e.end ? parseTime(e.end) : null;
      if (end) lines.push(`DTEND:${formatUtc(zonedToUtc(opts.tz, d.y, d.m, d.d, end.h, end.mi))}`);
      // RFC 5545 treats a DATE-TIME without DTEND as a point in time.
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`, "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
