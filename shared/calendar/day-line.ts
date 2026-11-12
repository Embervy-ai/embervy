#!/usr/bin/env bun
// Adds today's calendar entries at session start and day changes.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { calendarFile, entriesOn, EXTERNAL_CACHE_NAME, readEntries, writeJsonAtomic, type CalendarEntry } from "./store";
import { externalOn, parseIcsUrls, readExternalCache, type ExternalCache } from "./external";
import type { ExternalOccurrence } from "./ics-reader";
import { envWord, houseTimeZone, localDate, localTime, weekdayName } from "./time";
import { envValue, houseHome } from "../scripts/legacy-names";
import { contextLine, foreignContext } from "../scripts/context-text";

function fmtAgent(e: CalendarEntry): string {
  const when = e.time ? (e.end ? `${e.time}–${e.end}` : e.time) : "all day";
  return `${contextLine(when, 32)} ${contextLine(e.title)}`;
}

function fmtPerson(o: ExternalOccurrence): string {
  let when: string;
  if (o.time) when = o.end ? `${o.time}–${o.end}` : o.time;
  else if (o.continued) when = o.end ? `until ${o.end}` : "all day (continues)";
  else when = "all day";
  return `${contextLine(when, 32)} ${contextLine(o.title)}`;
}

export interface DayLineInput {
  today: string;
  tz: string;
  agentEntries: CalendarEntry[];
  personConfigured: boolean;
  personCache: ExternalCache | null;
  userLabel: string;
}

export function composeDayLines(i: DayLineInput): string[] {
  const head = `${weekdayName(i.today)} ${i.today}`;
  const mine = entriesOn(i.agentEntries, i.today);
  const lines = [`📅 Your calendar today (${head}): ${mine.length ? mine.map(fmtAgent).join(" · ") : "nothing entered"}`];
  if (i.personConfigured) {
    const who = `${contextLine(i.userLabel, 80) || "Your user"}'s calendar today`;
    const external: string[] = [];
    const c = i.personCache;
    if (!c) {
      external.push(`📅 ${who} (read-only): not synced yet`);
    } else {
      const theirs = externalOn(c, i.today);
      const failed = c.sources.filter((s) => !s.ok).length;
      const synced = c.sources.map((s) => s.synced_at).filter(Boolean).sort()[0];
      const stamp = synced ? `synced ${localDate(i.tz, Date.parse(synced)) === i.today ? localTime(i.tz, Date.parse(synced)) : localDate(i.tz, Date.parse(synced))}` : "never synced";
      const warn = failed ? `, ${failed} link(s) failing` : "";
      external.push(`📅 ${who} (read-only, ${stamp}${warn}): ${theirs.length ? theirs.map(fmtPerson).join(" · ") : "nothing"}`);
    }
    lines.push(foreignContext("calendar", external.join("\n")));
  }
  return lines;
}

export interface DayLineState {
  sessions: Record<string, string>;
}

export function dueForSession(state: DayLineState | null, session: string, today: string): { due: boolean; next: DayLineState } {
  const sessions = { ...(state?.sessions ?? {}) };
  const key = session || "default";
  const due = sessions[key] !== today;
  delete sessions[key];
  sessions[key] = today; // Reinsertion keeps the newest session last.
  const keys = Object.keys(sessions);
  for (const k of keys.slice(0, Math.max(0, keys.length - 10))) delete sessions[k];
  return { due, next: { sessions } };
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function runDayLine(argv: string[], env: Record<string, string | undefined>, now = Date.now()): string {
  if (envWord(envValue("EMBERVY_HOOK_CALENDAR", env)) !== "1") return "";
  const home = houseHome(env, existsSync);
  const session = (argv[0] && !argv[0].startsWith("--") ? argv[0] : "").replace(/[^A-Za-z0-9._-]/g, "");
  const dataDir = envValue("EMBERVY_APP_DATA_DIR", env) || argValue(argv, "--data-dir") || join(home, "Claude", "app", "data");
  const stateFile = argValue(argv, "--state") || join(home, "state", "calendar-day-line.json");
  const tz = houseTimeZone(env);
  const today = localDate(tz, now);

  let state: DayLineState | null = null;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {}
  const { due, next } = dueForSession(state, session, today);
  if (!due) return "";

  const lines = composeDayLines({
    today,
    tz,
    agentEntries: readEntries(calendarFile(dataDir)),
    personConfigured: parseIcsUrls(env.CALENDAR_ICS_URLS).length > 0,
    personCache: readExternalCache(join(dataDir, EXTERNAL_CACHE_NAME)),
    userLabel: (env.USER_LABEL || env.USER_NAME || "").trim(),
  });
  writeJsonAtomic(stateFile, next);
  return lines.join("\n");
}

if (import.meta.main) {
  try {
    const out = runDayLine(process.argv.slice(2), process.env);
    if (out) console.log(out);
  } catch {
    // Calendar context is optional and must not interrupt the inlet.
  }
}
