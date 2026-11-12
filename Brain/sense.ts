// Builds per-turn context from model state, calendars, weather and reminders.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { brainTimezone } from "./time-marks";
import { tr } from "./texts";
import { untrustedBlock } from "./web-tools";

export const CALENDAR_TITLE_LIMIT = 120;

function calendarField(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  const line = value.replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ +/g, " ").trim();
  const chars = Array.from(line);
  return chars.length <= limit ? line : chars.slice(0, limit - 1).join("") + "…";
}

export interface SenseState {
  model?: string;
  effort?: string | null;
  tokens?: number;
  calendar_day?: string;
  weather_class?: string | null;
}

export interface CalendarEvent { date?: string; time?: string | null; title?: string; who?: string }

export interface ReminderRow {
  id: number | string;
  due_at?: string;
  content?: string;
  collected_at?: string;
  delivered?: boolean;
  delivered_via?: string;
  delivered_at?: string;
}

export interface SenseInput {
  now: Date;
  timeZone?: string;
  model: string | null;
  effort?: string | null;
  effortApplied?: string | null;
  tokens: number | null;
  contextLimit: number;
  prev: SenseState | null;
  calendar?: CalendarEvent[] | null;
  weather?: { line: string; wclass: string } | null;
  reminders?: ReminderRow[];
  warning?: string | null;
  drift?: { marker: "drift" | "healed"; ordered: string; served: string } | null;
  clockLine?: boolean;
}

export interface SenseOutput {
  text: string | null;
  state: SenseState;
  deliveredReminderIds: Array<number | string>;
}

const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function zoneParts(date: Date, timeZone: string): Record<string, string> {
  timeZone = brainTimezone(process.env, timeZone);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "long", hour12: false,
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localDateKey(date: Date, timeZone = brainTimezone()): string {
  const v = zoneParts(date, timeZone);
  return `${v.year}-${v.month}-${v.day}`;
}

export function clockPlace(timeZone: string, env: Record<string, string | undefined> = process.env): string {
  return env.BRAIN_CLOCK_PLACE?.trim() || (timeZone.split("/").pop() ?? timeZone).replace(/_/g, " ");
}

export function clockLine(now: Date, timeZone = brainTimezone(), place = clockPlace(timeZone)): string {
  const v = zoneParts(now, timeZone);
  const english = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const weekday = tr(WEEKDAYS_LONG[Math.max(0, english.indexOf(v.weekday))]);
  const hour = v.hour === "24" ? "00" : v.hour;
  return `⏰ ${place}: ${weekday}, ${v.day}.${v.month}.${v.year}, ${hour}:${v.minute}`;
}

export function fmtK(n: number): string {
  if (n >= 1_000_000 && n % 100_000 === 0) {
    return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : `${(n / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(n / 1000)}k`;
}

// A context-window suffix belongs to the request, not the served model's identity.
function sameModel(a: string, b: string): boolean {
  const bare = (value: string) => value.trim().toLowerCase().replace(/\[[^\]]*\]$/, "");
  return bare(a) === bare(b);
}

export function renderSense(input: SenseInput): SenseOutput {
  const tz = brainTimezone(process.env, input.timeZone);
  const prev = input.prev;
  const fresh = !prev;
  const lines: string[] = [];
  const model = input.model;
  const effort = input.effort ?? null;

  if (model) {
    if (fresh) {
      lines.push(tr`SENSE · substrate: ${model}, effort ${effort || "default"} — session start`);
    } else if (prev?.model && !sameModel(prev.model, model)) {
      lines.push(tr`SENSE · MODEL CHANGE: ${prev.model} → ${model} (effort ${effort || "default"})`);
    } else if (prev && (prev.effort ?? null) !== effort) {
      lines.push(tr`SENSE · EFFORT CHANGE: ${prev.effort || "default"} → ${effort || "default"} (${model})`);
    }
  }
  if (input.drift?.marker === "drift") {
    lines.push(tr`SENSE · MODEL CHANGE: ordered ${input.drift.ordered}, served ${input.drift.served} — drift guard reports, does not heal`);
  } else if (input.drift?.marker === "healed") {
    lines.push(tr`SENSE · Drift ended: ${input.drift.served} is served again`);
  }

  const today = localDateKey(input.now, tz);
  if (input.calendar && (fresh || prev?.calendar_day !== today)) {
    const todays = input.calendar
      .filter((event) => event?.date === today)
      .sort((a, b) => (calendarField(a.time, 16) || "99:99").localeCompare(calendarField(b.time, 16) || "99:99"));
    if (todays.length) {
      const entries = todays.map((e) => {
        const time = calendarField(e.time, 16) || "—";
        const title = calendarField(e.title, CALENDAR_TITLE_LIMIT);
        const who = calendarField(e.who, 80);
        return `${time} ${title}${who ? ` (${who})` : ""}`;
      }).join(" · ");
      // Neither a calendar label nor a local file proves who authored an invitation.
      // Reuse the external-content fence, naming the actual source rather than the web.
      lines.push(untrustedBlock(tr`SENSE · calendar today (${today}): ` + entries)
        .replace("external content from the web", "external content from calendars"));
    } else {
      lines.push(tr`SENSE · calendar today (${today}): no entries`);
    }
  }

  let wclass = prev?.weather_class ?? null;
  if (input.weather) {
    const dayChanged = prev?.calendar_day !== today;
    if (fresh || dayChanged || (input.weather.wclass && input.weather.wclass !== wclass)) lines.push(input.weather.line);
    if (input.weather.wclass) wclass = input.weather.wclass;
  }

  const delivered: Array<number | string> = [];
  for (const row of input.reminders ?? []) {
    if (row.delivered) continue;
    const due = (row.due_at ?? "").slice(0, 16).replace("T", " ");
    const content = (row.content ?? "").split("\n")[0];
    lines.push(tr`SENSE · Reminder (due ${due}, Todo ${row.id}): ${content} — Your own reminder; still relevant? Act on it, otherwise resolve the Todo.`);
    delivered.push(row.id);
  }

  const head = model ? ` · ${model} · effort ${input.effortApplied || effort || "default"}` : "";
  const tokens = input.tokens;
  if (tokens && tokens > 0) {
    const pct = Math.round((100 * tokens) / input.contextLimit);
    let delta = "";
    if (typeof prev?.tokens === "number" && prev.tokens > 0) {
      const d = tokens - prev.tokens;
      if (Math.abs(d) >= 500) delta = tr`, ${d > 0 ? "+" : "−"}${fmtK(Math.abs(d))} since the last turn`;
    }
    lines.push(tr`SENSE · window: ${fmtK(tokens)}/${fmtK(input.contextLimit)} (${pct}%${delta})${head}`);
  } else if (fresh) {
    lines.push(tr`SENSE · window: fresh${head}`);
  } else if (head) {
    lines.push(`${tr("SENSE ·")}${head.slice(2)}`);
  }

  const blocks: string[] = [];
  if (lines.length) blocks.push(lines.join("\n"));
  if (input.warning && input.warning.trim()) blocks.push(input.warning.trim());
  if (input.clockLine !== false) blocks.push(clockLine(input.now, tz));

  return {
    text: blocks.length ? blocks.join("\n\n---\n\n") : null,
    state: { model: model ?? prev?.model, effort, tokens: tokens ?? 0, calendar_day: today, weather_class: wclass },
    deliveredReminderIds: delivered,
  };
}


export function readPendingReminders(path: string): ReminderRow[] {
  if (!path || !existsSync(path)) return [];
  const rows: ReminderRow[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* one bad line never blocks the rest */ }
  }
  return rows;
}

export function markRemindersDelivered(path: string, ids: Array<number | string>, via: string, now: Date): void {
  if (!ids.length || !existsSync(path)) return;
  const wanted = new Set(ids.map(String));
  const stamp = now.toISOString();
  const rows = readPendingReminders(path).map((row) => wanted.has(String(row.id)) && !row.delivered
    ? { ...row, delivered: true, delivered_via: via, delivered_at: stamp }
    : row);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  renameSync(tmp, path);
}

export function appendDueReminders(path: string, due: Array<{ id: number | string; due_at?: string; content?: string }>, now: Date): Array<number | string> {
  if (!due.length) return [];
  mkdirSync(dirname(path), { recursive: true });
  const existing = new Set(readPendingReminders(path).map((row) => String(row.id)));
  const fresh = due.filter((todo) => !existing.has(String(todo.id)));
  const lines = fresh.map((todo) => JSON.stringify({
    id: todo.id, due_at: todo.due_at, content: (todo.content ?? "").trim(),
    collected_at: now.toISOString(), delivered: false,
  }));
  if (lines.length) writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + lines.join("\n") + "\n", "utf8");
  return due.map((todo) => todo.id);
}

export function lateReminders(rows: ReminderRow[], now: Date, minutes: number): ReminderRow[] {
  return rows.filter((row) => !row.delivered && row.collected_at
    && now.getTime() - new Date(row.collected_at).getTime() >= minutes * 60_000);
}

export const REMINDER_TAG = "[Reminder]";

// Name the configured wait so a punctual reminder cannot claim it has waited an hour.
function escalationOpening(minutes: number): string {
  if (!(minutes > 0)) return tr("Due now, and nothing else woke you:\n");
  if (minutes === 60) return tr("Waiting for you for over an hour, without anything waking you:\n");
  return tr`Waiting for you for over ${minutes} minutes, without anything waking you:\n`;
}

export function reminderEscalationText(late: ReminderRow[], minutes = 60): string {
  const parts = late.map((row) => tr`- Due ${(row.due_at ?? "").slice(0, 16).replace("T", " ")} (Todo ${row.id}): ${row.content ?? ""}`);
  return `${tr(REMINDER_TAG)} ${escalationOpening(minutes)}`
    + parts.join("\n")
    + tr("\n— Your own reminders. Still relevant? Act on them; otherwise resolve the Todo.");
}


const WMO: Record<number, string> = {
  0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "rime fog",
  51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 56: "freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains", 80: "light showers",
  81: "showers", 82: "heavy showers", 85: "snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail",
};

export interface WeatherCache { ts: number; t?: number | null; feel?: number | null; p?: number | null; code?: number | null; wind?: number | null; prob?: number | null }

export function weatherCacheFromOpenMeteo(data: any, nowS: number): WeatherCache {
  const cur = data?.current ?? {};
  const probs: number[] = (data?.hourly?.precipitation_probability ?? []).filter((p: unknown) => typeof p === "number");
  return {
    ts: nowS, t: cur.temperature_2m ?? null, feel: cur.apparent_temperature ?? null, p: cur.precipitation ?? null,
    code: cur.weather_code ?? null, wind: cur.wind_speed_10m ?? null, prob: probs.length ? Math.max(...probs) : 0,
  };
}

export function weatherLine(cache: WeatherCache, place: string, timeZone = brainTimezone()): { line: string; wclass: string } | null {
  if (typeof cache.t !== "number") return null;
  const parts = [`${cache.t.toFixed(0)} °C`];
  if (typeof cache.feel === "number" && Math.abs(cache.feel - cache.t) >= 2) parts[0] += tr` (feels like ${cache.feel.toFixed(0)})`;
  const desc = typeof cache.code === "number" ? WMO[cache.code] ?? "" : "";
  if (desc) parts.push(tr(desc));
  if ((cache.p ?? 0) > 0) parts.push(tr`${(cache.p as number).toFixed(1)} mm rain`);
  else if ((cache.prob ?? 0) >= 40) parts.push(tr`Rain ${(cache.prob as number).toFixed(0)} % in the next 3 h`);
  if (typeof cache.wind === "number") parts.push(`Wind ${cache.wind.toFixed(0)} km/h`);
  const v = zoneParts(new Date(cache.ts * 1000), timeZone);
  const stamp = `${v.hour === "24" ? "00" : v.hour}:${v.minute}`;
  const code = cache.code ?? 0;
  let wet: string;
  if (code >= 95) wet = "thunderstorm";
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) wet = "snow";
  else if (code >= 51 || (cache.p ?? 0) > 0) wet = "rain";
  else if ((cache.prob ?? 0) >= 60) wet = "rain-likely";
  else wet = "dry";
  return { line: tr`SENSE · weather ${place} (${stamp}): ${parts.join(", ")}`, wclass: wet };
}

export function readCalendar(path: string): CalendarEvent[] | null {
  if (!path || !existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function readExternalCalendar(path: string, who: string): CalendarEvent[] | null {
  if (!path || !existsSync(path)) return null;
  try {
    const cache = JSON.parse(readFileSync(path, "utf8"));
    if (cache?.version !== 1 || !Array.isArray(cache.sources)) return null;
    const events: CalendarEvent[] = [];
    for (const source of cache.sources) {
      for (const o of Array.isArray(source?.occurrences) ? source.occurrences : []) {
        if (o && typeof o.date === "string" && typeof o.title === "string") {
          events.push({ date: o.date, time: typeof o.time === "string" ? o.time : null, title: o.title, who });
        }
      }
    }
    return events;
  } catch {
    return null;
  }
}

// The app creates the local calendar only with its first entry; absence must not hide external events.
export function readCalendars(file: string, externalFile: string, who: string): CalendarEvent[] | null {
  if (!externalFile) return file ? readCalendar(file) : null;
  const own = file ? readCalendar(file) ?? [] : [];
  return [...own, ...(readExternalCalendar(externalFile, who) ?? [])];
}

// The watchdog may not clear the previous session's warning before the first turn.
export function readFreshWarning(path: string, sinceMs: number): string | null {
  try {
    return existsSync(path) && statSync(path).mtimeMs >= sinceMs ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}
