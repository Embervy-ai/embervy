// Reads ICS feeds and expands supported recurrence rules into local calendar events.

import {
  addDays,
  isValidTimeZone,
  localDate,
  localTime,
  pad2,
  parseDate,
  wallTimeIn,
  weekdayOf,
  zonedToUtc,
} from "./time";


export interface IcsProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsComponent {
  type: string;
  props: IcsProp[];
  children: IcsComponent[];
}

export function unfoldLines(text: string): string[] {
  const raw = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) out[out.length - 1] += line.slice(1);
    else if (line.length) out.push(line);
  }
  return out;
}

export function parseContentLine(line: string): IcsProp | null {
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ":" && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts: string[] = [];
  let cur = "";
  inQuotes = false;
  for (const c of head) {
    if (c === '"') inQuotes = !inQuotes;
    if (c === ";" && !inQuotes) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const name = parts.shift()!.trim().toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value };
}

export function parseIcs(text: string): IcsComponent {
  const root: IcsComponent = { type: "ROOT", props: [], children: [] };
  const stack: IcsComponent[] = [root];
  for (const line of unfoldLines(text)) {
    const prop = parseContentLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const comp: IcsComponent = { type: prop.value.trim().toUpperCase(), props: [], children: [] };
      stack[stack.length - 1].children.push(comp);
      stack.push(comp);
    } else if (prop.name === "END") {
      if (stack.length > 1) stack.pop();
    } else {
      stack[stack.length - 1].props.push(prop);
    }
  }
  return root;
}

export function unescapeText(s: string): string {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
}

function prop(c: IcsComponent, name: string): IcsProp | undefined {
  return c.props.find((p) => p.name === name);
}


// Outlook can supply Windows zone names rather than IANA identifiers.
const WINDOWS_ZONES: Record<string, string> = {
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "Romance Standard Time": "Europe/Paris",
  "E. Europe Standard Time": "Europe/Chisinau",
  "FLE Standard Time": "Europe/Kiev",
  "GTB Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Turkey Standard Time": "Europe/Istanbul",
  "Israel Standard Time": "Asia/Jerusalem",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Arabian Standard Time": "Asia/Dubai",
  "India Standard Time": "Asia/Kolkata",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "E. Australia Standard Time": "Australia/Brisbane",
  "W. Australia Standard Time": "Australia/Perth",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "US Mountain Standard Time": "America/Phoenix",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Atlantic Standard Time": "America/Halifax",
  "Canada Central Standard Time": "America/Regina",
  "SA Pacific Standard Time": "America/Bogota",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Buenos_Aires",
  "Mexico Standard Time": "America/Mexico_City",
  "Central Standard Time (Mexico)": "America/Mexico_City",
};

export function resolveTzid(tzid: string | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.trim().replace(/^"|"$/g, "");
  if (isValidTimeZone(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  // Some feeds prepend a vendor namespace to an IANA zone.
  const m = /([A-Za-z_]+\/[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)?)$/.exec(t);
  if (m && isValidTimeZone(m[1])) return m[1];
  return null;
}


export type IcsTime =
  | { kind: "date"; date: string }
  | { kind: "instant"; instant: number; tz: string; date: string; h: number; mi: number; s: number };

export function parseTimeValue(value: string, params: Record<string, string>, floatingTz: string): IcsTime | null {
  const v = value.trim();
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dm || params.VALUE === "DATE") {
    const m = dm ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    return parseDate(date) ? { kind: "date", date } : null;
  }
  const tm = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!tm) return null;
  const [y, mo, d, h, mi, s] = tm.slice(1, 7).map(Number);
  const date = `${tm[1]}-${tm[2]}-${tm[3]}`;
  if (!parseDate(date) || h > 23 || mi > 59 || s > 60) return null;
  if (tm[7] === "Z") return { kind: "instant", instant: Date.UTC(y, mo - 1, d, h, mi, s), tz: "UTC", date, h, mi, s };
  const tz = resolveTzid(params.TZID) ?? floatingTz;
  return { kind: "instant", instant: zonedToUtc(tz, y, mo, d, h, mi, s), tz, date, h, mi, s };
}

export function parseDuration(v: string): { ms: number; days: number } | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v.trim());
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  const days = (Number(m[2] || 0) * 7 + Number(m[3] || 0)) * sign;
  const ms = sign * ((Number(m[4] || 0) * 3600 + Number(m[5] || 0) * 60 + Number(m[6] || 0)) * 1000) + days * 86400000;
  return { ms, days };
}


export interface ParsedEvent {
  uid: string;
  title: string;
  cancelled: boolean;
  start: IcsTime;
  durationMs: number;
  days: number;
  rrule: Record<string, string> | null;
  exdates: IcsTime[];
  recurrenceId: IcsTime | null;
}

export interface ParsedCalendar {
  name: string | null;
  events: ParsedEvent[];
}

export function readCalendar(text: string, houseTz: string): ParsedCalendar {
  const root = parseIcs(text);
  const cal = root.children.find((c) => c.type === "VCALENDAR");
  if (!cal) throw new Error("not an ICS calendar");
  const nameProp = prop(cal, "X-WR-CALNAME");
  const calTz = resolveTzid(prop(cal, "X-WR-TIMEZONE")?.value) ?? houseTz;
  const events: ParsedEvent[] = [];
  for (const c of cal.children) {
    if (c.type !== "VEVENT") continue;
    const ds = prop(c, "DTSTART");
    if (!ds) continue;
    const start = parseTimeValue(ds.value, ds.params, calTz);
    if (!start) continue;
    let durationMs = 0;
    let days = 1;
    const de = prop(c, "DTEND");
    const du = prop(c, "DURATION");
    if (de) {
      const end = parseTimeValue(de.value, de.params, calTz);
      if (end && start.kind === "date" && end.kind === "date") {
        days = Math.max(1, Math.round((Date.parse(end.date) - Date.parse(start.date)) / 86400000));
      } else if (end && start.kind === "instant" && end.kind === "instant") {
        durationMs = Math.max(0, end.instant - start.instant);
      }
    } else if (du) {
      const d = parseDuration(du.value);
      if (d && start.kind === "date") days = Math.max(1, d.days || Math.round(d.ms / 86400000));
      else if (d) durationMs = Math.max(0, d.ms);
    }
    const rr = prop(c, "RRULE");
    const rrule = rr ? parseRrule(rr.value) : null;
    const exdates: IcsTime[] = [];
    for (const ex of c.props.filter((p) => p.name === "EXDATE")) {
      for (const one of ex.value.split(",")) {
        const t = parseTimeValue(one, ex.params, calTz);
        if (t) exdates.push(t);
      }
    }
    const rid = prop(c, "RECURRENCE-ID");
    events.push({
      uid: prop(c, "UID")?.value.trim() || `${start.kind === "date" ? start.date : start.instant}-${events.length}`,
      title: unescapeText(prop(c, "SUMMARY")?.value ?? "").trim() || "(no title)",
      cancelled: (prop(c, "STATUS")?.value ?? "").trim().toUpperCase() === "CANCELLED",
      start,
      durationMs,
      days,
      rrule,
      exdates,
      recurrenceId: rid ? parseTimeValue(rid.value, rid.params, calTz) : null,
    });
  }
  return { name: nameProp ? unescapeText(nameProp.value).trim() || null : null, events };
}


export function parseRrule(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim().toUpperCase();
  }
  return out;
}

const WD: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

interface ByDay {
  ord: number;
  wd: number;
}

function parseByDay(v: string | undefined): ByDay[] {
  if (!v) return [];
  const out: ByDay[] = [];
  for (const part of v.split(",")) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part.trim());
    if (m) out.push({ ord: m[1] ? Number(m[1]) : 0, wd: WD[m[2]] });
  }
  return out;
}

function intList(v: string | undefined): number[] {
  if (!v) return [];
  return v.split(",").map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n !== 0);
}

const UNSUPPORTED_PARTS = ["BYSETPOS", "BYYEARDAY", "BYWEEKNO", "BYHOUR", "BYMINUTE", "BYSECOND"];

export function ruleSupported(rule: Record<string, string>): boolean {
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(rule.FREQ)) return false;
  if (UNSUPPORTED_PARTS.some((p) => p in rule)) return false;
  const byday = parseByDay(rule.BYDAY);
  if ((rule.FREQ === "DAILY" || rule.FREQ === "WEEKLY") && byday.some((b) => b.ord !== 0)) return false;
  if (rule.FREQ === "YEARLY" && byday.length && !rule.BYMONTH) return false;
  return true;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function monthDays(y: number, m: number, bymonthday: number[], byday: ByDay[], defaultDay: number): number[] {
  const dim = daysInMonth(y, m);
  let days: number[];
  if (bymonthday.length) {
    days = bymonthday.map((n) => (n > 0 ? n : dim + n + 1)).filter((d) => d >= 1 && d <= dim);
    if (byday.length) {
      const wds = new Set(byday.map((b) => b.wd));
      days = days.filter((d) => wds.has(weekdayOf(ymd(y, m, d))));
    }
  } else if (byday.length) {
    days = [];
    for (const b of byday) {
      const all: number[] = [];
      for (let d = 1; d <= dim; d++) if (weekdayOf(ymd(y, m, d)) === b.wd) all.push(d);
      if (b.ord > 0) {
        if (all[b.ord - 1]) days.push(all[b.ord - 1]);
      } else if (b.ord < 0) {
        if (all[all.length + b.ord]) days.push(all[all.length + b.ord]);
      } else days.push(...all);
    }
  } else {
    days = defaultDay <= dim ? [defaultDay] : [];
  }
  return [...new Set(days)].sort((a, b) => a - b);
}

const MAX_PERIODS = 20000;

// RFC 5545 makes the start date the first occurrence; the caller emits it separately.
export function* ruleDates(rule: Record<string, string>, startDate: string, stopDate: string): Generator<string> {
  const base = parseDate(startDate)!;
  const interval = Math.max(1, Number(rule.INTERVAL) || 1);
  const byday = parseByDay(rule.BYDAY);
  const bymonthday = intList(rule.BYMONTHDAY);
  const bymonth = intList(rule.BYMONTH).filter((m) => m >= 1 && m <= 12);
  const monthOk = (date: string) => !bymonth.length || bymonth.includes(Number(date.slice(5, 7)));

  if (rule.FREQ === "DAILY") {
    const wds = new Set(byday.map((b) => b.wd));
    for (let k = 1; k < MAX_PERIODS * 10; k++) {
      const date = addDays(startDate, k * interval);
      if (date > stopDate) return;
      if (!monthOk(date)) continue;
      if (wds.size && !wds.has(weekdayOf(date))) continue;
      if (bymonthday.length) {
        const p = parseDate(date)!;
        const dim = daysInMonth(p.y, p.m);
        if (!bymonthday.some((n) => (n > 0 ? n : dim + n + 1) === p.d)) continue;
      }
      yield date;
    }
    return;
  }

  if (rule.FREQ === "WEEKLY") {
    const wkst = WD[rule.WKST] ?? 1;
    const weekStart = addDays(startDate, -((weekdayOf(startDate) - wkst + 7) % 7));
    const wds = (byday.length ? byday.map((b) => b.wd) : [weekdayOf(startDate)])
      .map((wd) => (wd - wkst + 7) % 7)
      .sort((a, b) => a - b);
    for (let k = 0; k < MAX_PERIODS; k++) {
      const ws = addDays(weekStart, 7 * k * interval);
      if (ws > stopDate) return;
      for (const off of new Set(wds)) {
        const date = addDays(ws, off);
        if (date <= startDate || date > stopDate) continue;
        if (!monthOk(date)) continue;
        yield date;
      }
    }
    return;
  }

  if (rule.FREQ === "MONTHLY") {
    for (let k = 0; k < MAX_PERIODS; k++) {
      const idx = base.m - 1 + k * interval;
      const y = base.y + Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      if (ymd(y, m, 1) > stopDate) return;
      if (bymonth.length && !bymonth.includes(m)) continue;
      for (const d of monthDays(y, m, bymonthday, byday, base.d)) {
        const date = ymd(y, m, d);
        if (date <= startDate || date > stopDate) continue;
        yield date;
      }
    }
    return;
  }

  if (rule.FREQ === "YEARLY") {
    const months = bymonth.length ? [...bymonth].sort((a, b) => a - b) : [base.m];
    for (let k = 0; k < MAX_PERIODS; k++) {
      const y = base.y + k * interval;
      if (ymd(y, 1, 1) > stopDate) return;
      for (const m of months) {
        for (const d of monthDays(y, m, bymonthday, byday, base.d)) {
          const date = ymd(y, m, d);
          if (date <= startDate || date > stopDate) continue;
          yield date;
        }
      }
    }
  }
}


export interface ExternalOccurrence {
  title: string;
  date: string;
  time: string | null;
  end: string | null;
  calendar: string;
  recurring?: boolean;
  continued?: boolean;
  repeats_unexpanded?: boolean;
}

function timeKey(t: IcsTime): string {
  return t.kind === "date" ? `d:${t.date}` : `i:${t.instant}`;
}

const MAX_OCCURRENCES = 5000;
const MAX_SPAN_DAYS = 62;

export function occurrencesBetween(
  cal: ParsedCalendar,
  houseTz: string,
  from: string,
  to: string,
  calendarName: string,
): ExternalOccurrence[] {
  const out: ExternalOccurrence[] = [];
  const winStart = zonedToUtc(houseTz, ...(ymdParts(from) as [number, number, number]));
  const winEnd = zonedToUtc(houseTz, ...(ymdParts(addDays(to, 1)) as [number, number, number]));

  const overridden = new Map<string, Set<string>>();
  for (const ev of cal.events) {
    if (!ev.recurrenceId) continue;
    if (!overridden.has(ev.uid)) overridden.set(ev.uid, new Set());
    overridden.get(ev.uid)!.add(timeKey(ev.recurrenceId));
  }

  const emitAllDay = (ev: ParsedEvent, date: string, extra: Partial<ExternalOccurrence>) => {
    for (let i = 0; i < Math.min(ev.days, MAX_SPAN_DAYS); i++) {
      const d = addDays(date, i);
      if (d < from || d > to) continue;
      out.push({ title: ev.title, date: d, time: null, end: null, calendar: calendarName, ...extra, ...(i > 0 ? { continued: true } : {}) });
    }
  };

  const emitTimed = (ev: ParsedEvent, startMs: number, extra: Partial<ExternalOccurrence>) => {
    const endMs = startMs + ev.durationMs;
    if (!(startMs < winEnd && (endMs > winStart || (ev.durationMs === 0 && startMs >= winStart)))) return;
    const startDay = localDate(houseTz, startMs);
    const lastDay = ev.durationMs > 0 ? localDate(houseTz, endMs - 1) : startDay;
    if (startDay >= from && startDay <= to) {
      out.push({
        title: ev.title,
        date: startDay,
        time: localTime(houseTz, startMs),
        end: ev.durationMs > 0 && lastDay === startDay ? localTime(houseTz, endMs) : null,
        calendar: calendarName,
        ...extra,
      });
    }
    let d = addDays(startDay, 1);
    for (let i = 0; d <= lastDay && i < MAX_SPAN_DAYS; i++, d = addDays(d, 1)) {
      if (d < from || d > to) continue;
      out.push({ title: ev.title, date: d, time: null, end: d === lastDay ? localTime(houseTz, endMs) : null, calendar: calendarName, ...extra, continued: true });
    }
  };

  // Event and display time zones can place the same occurrence on different dates.
  const stopDate = addDays(to, 2);

  for (const ev of cal.events) {
    if (ev.cancelled) continue;
    if (out.length >= MAX_OCCURRENCES) break;

    if (ev.recurrenceId || !ev.rrule) {
      if (ev.start.kind === "date") emitAllDay(ev, ev.start.date, {});
      else emitTimed(ev, ev.start.instant, {});
      continue;
    }

    const rule = ev.rrule;
    if (!ruleSupported(rule)) {
      const extra = { repeats_unexpanded: true };
      if (ev.start.kind === "date") emitAllDay(ev, ev.start.date, extra);
      else emitTimed(ev, ev.start.instant, extra);
      continue;
    }

    const count = Number(rule.COUNT) > 0 ? Number(rule.COUNT) : Infinity;
    let untilDate: string | null = null;
    let untilInstant: number | null = null;
    if (rule.UNTIL) {
      const u = parseTimeValue(rule.UNTIL, {}, ev.start.kind === "instant" ? ev.start.tz : houseTz);
      if (u?.kind === "date") untilDate = u.date;
      else if (u?.kind === "instant") untilInstant = u.instant;
    }
    const skip = overridden.get(ev.uid) ?? new Set<string>();
    const exKeys = new Set(ev.exdates.map(timeKey));
    const exDates = new Set(ev.exdates.filter((x) => x.kind === "date").map((x) => (x as { date: string }).date));
    const extra = { recurring: true };

    const startDate = ev.start.date;
    const dates = (function* () {
      yield startDate;
      yield* ruleDates(rule, startDate, stopDate);
    })();
    // Earlier occurrences still count toward COUNT, but skipping their time conversion keeps old series cheap.
    const earliest = addDays(from, -(Math.ceil(ev.durationMs / 86400000) + 2));
    const untilLocal = untilInstant !== null && ev.start.kind === "instant" ? localDate(ev.start.tz, untilInstant) : null;

    let n = 0;
    for (const date of dates) {
      if (++n > count) break;
      if (untilDate && date > untilDate) break;
      if (untilLocal && date > untilLocal) break;
      if (ev.start.kind === "date") {
        const key = `d:${date}`;
        if (exKeys.has(key) || skip.has(key)) continue;
        emitAllDay(ev, date, extra);
      } else {
        if (date < earliest) continue;
        const p = parseDate(date)!;
        const inst = zonedToUtc(ev.start.tz, p.y, p.m, p.d, ev.start.h, ev.start.mi, ev.start.s);
        if (untilInstant !== null && inst > untilInstant) break;
        if (exKeys.has(`i:${inst}`) || exDates.has(date) || skip.has(`i:${inst}`)) continue;
        emitTimed(ev, inst, extra);
      }
      if (out.length >= MAX_OCCURRENCES) break;
    }
  }

  return out.sort((a, b) => `${a.date} ${a.time ?? ""}`.localeCompare(`${b.date} ${b.time ?? ""}`));
}

function ymdParts(date: string): number[] {
  const p = parseDate(date)!;
  return [p.y, p.m, p.d];
}

export function wallHm(tz: string, instant: number): string {
  const w = wallTimeIn(tz, instant);
  return `${pad2(w.hour)}:${pad2(w.minute)}`;
}
