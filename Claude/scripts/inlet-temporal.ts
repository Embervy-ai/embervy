/**
 * The inlet's time channel: turns a time reference in a message ("what happened
 * yesterday?", "last Tuesday", "on September 24") into a date range of archived
 * sessions.
 *
 * Regular expressions only, no network, no clock of its own (the caller passes
 * `now`). English is built in; other languages come from the "timeWords" of
 * Claude/app/strings.local.json. Check that file with
 *   bun Claude/scripts/inlet-temporal.ts --check ["a sentence to try"]
 *
 * A range never filters the meaning search: it opens a second, parallel channel
 * over the sessions dated inside it. Days end at 04:00 local time, so at 00:30
 * "today" is still the evening's day.
 *
 * Environment: INLET_TEMPORAL (1/0), BRAIN_TIMEZONE or EMBERVY_TIMEZONE (IANA,
 * default UTC), INLET_NOW (fixed "now" for reproducible runs),
 * EMBERVY_STRINGS_LOCAL (another language file, for tests).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, envWord, houseTimeZone, isValidTimeZone, pad2, parseDate, wallTimeIn, weekdayOf } from "../../shared/calendar/time.ts";
import { envValue } from "../../shared/scripts/legacy-names.ts";
import { contextLine } from "../../shared/scripts/context-text.ts";

/** Local hour at which a day ends (the night belongs to the day before). */
export const DAY_END_HOUR = 4;
/** Longest union of ranges that still opens the time channel; longer = boost only. */
export const MAX_FILTER_DAYS = 14;
/** "N days ago" beyond this is not read as a time reference. */
export const MAX_DAYS_AGO = 60;

/** asc = earliest session first, desc = latest first, night = the end of the
 * first day (latest first), then the start of the next (earliest first). */
export type TemporalOrder = "asc" | "desc" | "night";

export interface TemporalQuery {
  from: string;
  to: string;
  ranges: Array<{ from: string; to: string }>;
  /** filter: the time channel searches inside the range. boost: meaning hits
   * dated inside the range rank higher, nothing else changes. */
  mode: "filter" | "boost";
  order: TemporalOrder;
  /** The prompt asks only about the time ("what happened yesterday?"). */
  pure: boolean;
  rest: string;
  today: string;
  /** Every recognised range lies on today (today lives in the context, not the archive). */
  onlyToday: boolean;
  phrases: string[];
}

export function temporalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(0|off|false|no)$/i.test(envWord(env.INLET_TEMPORAL));
}

export function temporalTimeZone(env: Record<string, string | undefined> = process.env): string {
  const brain = envWord(env.BRAIN_TIMEZONE);
  return isValidTimeZone(brain) ? brain : houseTimeZone(env);
}

export function temporalNow(env: Record<string, string | undefined> = process.env, fallback: number = Date.now()): number {
  const raw = envWord(env.INLET_NOW);
  if (!raw) return fallback;
  const at = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(at) ? at : fallback;
}

export function logicalToday(now: number, tz: string): string {
  const w = wallTimeIn(tz, now);
  const date = `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
  return w.hour < DAY_END_HOUR ? addDays(date, -1) : date;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function dateInRange(date: unknown, from: string, to: string): boolean {
  return typeof date === "string" && date.length === 10 && date >= from && date <= to;
}

export function inWindow(date: unknown, q: Pick<TemporalQuery, "from" | "to"> & { ranges?: TemporalQuery["ranges"] }): boolean {
  const ranges = q.ranges?.length ? q.ranges : [{ from: q.from, to: q.to }];
  return ranges.some((r) => dateInRange(date, r.from, r.to));
}

function lastWeekday(today: string, weekday: number): string {
  let back = (weekdayOf(today) - weekday + 7) % 7;
  if (back === 0) back = 7;
  return addDays(today, -back);
}

function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

function monthEnd(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(last)}`;
}

function isoDate(y: number, m: number, d: number): string | null {
  const s = `${y}-${pad2(m)}-${pad2(d)}`;
  return parseDate(s) ? s : null;
}

/** What a part of the day says about the sessions shown: morning = earliest
 * first, night = the end of that day and the start of the next, day = no order. */
export type PartOfDay = "morning" | "day" | "night";

/**
 * The words the time channel reads. English is built in (ENGLISH_TIME_WORDS);
 * the "timeWords" object of Claude/app/strings.local.json adds words of any
 * language on top (loadTimeWords) — the same file that sets the app's language.
 *
 * Word lists map a word to its value (weekdays 0 = Sunday … 6 = Saturday,
 * months 1 … 12). Phrases are small templates, case never matters:
 *   a space       one or more spaces       [x]     x is optional
 *   (a|b)         one of the alternatives  [a|b]   one of them, or none
 *   '             ' or ’                   …  ...  a gap of up to 25 characters
 *   {weekday} {month} (full name) {mon} (full name or abbreviation) {day}
 *   {monthnum} {year} (four digits) {yy} (two or four digits) {iso} (YYYY-MM-DD)
 *   {n} (digits or a number word) {part} (a part of the day)
 * Everything else is literal. "[on] last {weekday}", "{day} [of] {mon}" and
 * "yesterday [{part}]" read as written: an optional part at the start, between
 * two spaces or at the end takes one of its spaces along.
 */
export interface TimeWords {
  weekdays: Record<string, number>;
  /** Full month names: dates and "in {month}". */
  months: Record<string, number>;
  /** Abbreviations: dates only ({mon}). */
  monthsShort: Record<string, number>;
  /** Number words for {n} ("two days ago"). */
  numbers: Record<string, number>;
  /** Words after "yesterday"/"today" ({part}). */
  partsOfDay: Record<string, PartOfDay>;
  /** In front of a date: that one day ("on", "from"). */
  datePrefixes: string[];
  /** In front of a date: from that day to today ("since"). */
  sincePrefixes: string[];
  /** How a date is written after its prefix. */
  dateForms: string[];
  weekdayBeforeLast: string[];
  lastWeekday: string[];
  dayBeforeYesterday: string[];
  yesterday: string[];
  lastNight: string[];
  earlierToday: string[];
  /** Today: "today", "this {part}" — counts only without a future word. */
  today: string[];
  tonight: string[];
  daysAgo: string[];
  lastWeek: string[];
  thisWeek: string[];
  lastWeekend: string[];
  lastMonth: string[];
  inMonth: string[];
  /** A weekday that points ahead or repeats ("next Tuesday", "every Monday"): never a reference. */
  notWeekday: string[];
  /** A bare weekday: counts only with a past word in the sentence. */
  weekday: string[];
  /** Past words: a bare weekday counts, a date or month ahead means last year. */
  past: string[];
  /** Future words: today, this week, a bare weekday or a month do not count. */
  future: string[];
  /** Fixed phrases that name a time but point at no archived day ("good morning"). */
  idioms: string[];
  /** Words without a topic of their own: a prompt of only these and time words asks only about the time. */
  filler: string[];
}

export const ENGLISH_TIME_WORDS: Readonly<TimeWords> = {
  weekdays: { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 },
  months: {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9,
    october: 10, november: 11, december: 12,
  },
  monthsShort: { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 },
  numbers: {
    a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, thirty: 30,
  },
  partsOfDay: { morning: "morning", afternoon: "day", evening: "night", night: "night" },
  datePrefixes: ["on", "from"],
  sincePrefixes: ["since"],
  dateForms: [
    "{iso}",
    "[{weekday}[,] ][the ]{day}[st|nd|rd|th] [of] {mon}[.][[,] {year}]",
    "[{weekday}[,] ]{mon}[.] [the] {day}[st|nd|rd|th][[,] {year}]",
  ],
  weekdayBeforeLast: ["[on] [the] {weekday} before last"],
  lastWeekday: ["[on] (last|this past|past|previous) {weekday}"],
  dayBeforeYesterday: ["[the] day before yesterday"],
  yesterday: ["yesterday[ {part}]"],
  lastNight: ["last night"],
  earlierToday: ["earlier today"],
  today: ["today", "this {part}"],
  tonight: ["tonight"],
  daysAgo: ["{n} day[s] ago"],
  lastWeek: ["(last|previous) week"],
  thisWeek: ["this week"],
  lastWeekend: ["(last|previous) weekend"],
  lastMonth: ["(last|previous) month"],
  inMonth: ["in {month}"],
  notWeekday: ["(next|coming|this coming|every|until|till|by|from) [on ]{weekday}[s]", "[on] {weekday}s"],
  weekday: ["[on] {weekday}"],
  past: [
    "was", "were", "did", "didn't", "had", "remember", "recall", "happened", "said", "talked", "told", "discussed", "wrote",
    "built", "made", "asked", "saw", "met", "decided", "found", "forgot", "back then",
  ],
  future: ["will", "won't", "going to", "gonna", "tomorrow", "next", "upcoming", "later", "in {n} days", "'ll"],
  idioms: [
    "(until|till|up to|as of|from|for) today",
    "to this day",
    "good (morning|evening|night|afternoon)",
    "how('s| are| is| do) … today",
  ],
  filler: (
    "what was were is are am how where who when why did do does we you i me us it the a an and or but happened happen " +
    "going on in at of about talk talked discuss discussed say said remember recall tell told again anything something " +
    "new there that this so please can could would summarize summary up our my your hello hey hi good morning evening"
  ).split(" "),
};

type MapKey = "weekdays" | "months" | "monthsShort" | "numbers";
type PhraseKey =
  | "datePrefixes" | "sincePrefixes" | "dateForms" | "weekdayBeforeLast" | "lastWeekday" | "dayBeforeYesterday" | "yesterday"
  | "lastNight" | "earlierToday" | "today" | "tonight" | "daysAgo" | "lastWeek" | "thisWeek" | "lastWeekend" | "lastMonth"
  | "inMonth" | "notWeekday" | "weekday" | "past" | "future" | "idioms";
type Slot = "weekday" | "month" | "mon" | "day" | "monthnum" | "year" | "yy" | "iso" | "n" | "part";

const MAP_RANGE: Record<MapKey, [number, number, string]> = {
  weekdays: [0, 6, "a whole number from 0 (Sunday) to 6 (Saturday)"],
  months: [1, 12, "a whole number from 1 to 12"],
  monthsShort: [1, 12, "a whole number from 1 to 12"],
  numbers: [1, 999, "a whole number from 1 to 999"],
};
const PARTS: readonly PartOfDay[] = ["morning", "day", "night"];
const SLOTS: ReadonlySet<string> = new Set<Slot>(["weekday", "month", "mon", "day", "monthnum", "year", "yy", "iso", "n", "part"]);

const PHRASES: Record<PhraseKey, { slots: readonly Slot[]; needs?: (has: Set<Slot>) => string | null }> = {
  datePrefixes: { slots: [] },
  sincePrefixes: { slots: [] },
  dateForms: {
    slots: ["weekday", "month", "mon", "day", "monthnum", "year", "yy", "iso"],
    needs: (has) => has.has("iso") || (has.has("day") && (has.has("monthnum") || has.has("month") || has.has("mon")))
      ? null : "needs {day} with {monthnum}, {month} or {mon}, or {iso}",
  },
  weekdayBeforeLast: { slots: ["weekday"], needs: (has) => (has.has("weekday") ? null : "needs {weekday}") },
  lastWeekday: { slots: ["weekday"], needs: (has) => (has.has("weekday") ? null : "needs {weekday}") },
  dayBeforeYesterday: { slots: [] },
  yesterday: { slots: ["part"] },
  lastNight: { slots: [] },
  earlierToday: { slots: [] },
  today: { slots: ["part"] },
  tonight: { slots: [] },
  daysAgo: { slots: ["n"], needs: (has) => (has.has("n") ? null : "needs {n}") },
  lastWeek: { slots: [] },
  thisWeek: { slots: [] },
  lastWeekend: { slots: [] },
  lastMonth: { slots: [] },
  inMonth: { slots: ["month", "mon"], needs: (has) => (has.has("month") || has.has("mon") ? null : "needs {month}") },
  notWeekday: { slots: ["weekday"], needs: (has) => (has.has("weekday") ? null : "needs {weekday}") },
  weekday: { slots: ["weekday"], needs: (has) => (has.has("weekday") ? null : "needs {weekday}") },
  past: { slots: ["n"] },
  future: { slots: ["n"] },
  idioms: { slots: [] },
};
const PHRASE_KEYS = Object.keys(PHRASES) as PhraseKey[];

type Node =
  | { kind: "text"; text: string }
  | { kind: "space" }
  | { kind: "gap" }
  | { kind: "slot"; slot: Slot }
  | { kind: "group"; optional: boolean; alts: Node[][] };

function parseTemplate(template: string): Node[] {
  const src = template.trim();
  if (!src) throw new Error("is empty");
  let i = 0;
  const seq = (closing: "]" | ")" | null): Node[][] => {
    const alts: Node[][] = [[]];
    let cur = alts[0];
    while (i < src.length) {
      const c = src[i];
      if (closing && c === closing) { i += 1; return alts; }
      if (c === "]" || c === ")") throw new Error(`has a "${c}" without its opening bracket`);
      if (c === "|") {
        if (!closing) throw new Error('has "|" outside (…) or […]');
        cur = [];
        alts.push(cur);
        i += 1;
      } else if (c === "[" || c === "(") {
        i += 1;
        cur.push({ kind: "group", optional: c === "[", alts: seq(c === "[" ? "]" : ")") });
      } else if (c === "{") {
        const end = src.indexOf("}", i);
        if (end < 0) throw new Error('has "{" without "}"');
        const name = src.slice(i + 1, end).trim();
        if (!SLOTS.has(name)) throw new Error(`has an unknown slot {${name}}`);
        cur.push({ kind: "slot", slot: name as Slot });
        i = end + 1;
      } else if (c === "…" || src.startsWith("...", i)) {
        cur.push({ kind: "gap" });
        i += c === "…" ? 1 : 3;
      } else if (/\s/.test(c)) {
        while (i < src.length && /\s/.test(src[i])) i += 1;
        if (cur.at(-1)?.kind !== "space") cur.push({ kind: "space" });
      } else {
        const last = cur.at(-1);
        if (last?.kind === "text") last.text += c;
        else cur.push({ kind: "text", text: c });
        i += 1;
      }
    }
    if (closing) throw new Error(`misses its "${closing}"`);
    return alts;
  };
  const top = seq(null)[0];
  // An optional word takes one of the spaces around it along: "[on] last" and
  // "{day} [of] {mon}" need no space when the word is missing.
  if (top[0]?.kind === "group" && top[0].optional && top[1]?.kind === "space") {
    top[0] = { ...top[0], alts: top[0].alts.map((alt) => [...alt, { kind: "space" } as Node]) };
    top.splice(1, 1);
  }
  for (let k = 1; k + 1 < top.length; k += 1) {
    const node = top[k];
    if (node.kind === "group" && node.optional && top[k - 1].kind === "space" && top[k + 1].kind === "space") {
      top[k] = { ...node, alts: node.alts.map((alt) => [...alt, { kind: "space" } as Node]) };
      top.splice(k + 1, 1);
    }
  }
  const last = top.at(-1);
  if (top.length > 1 && last?.kind === "group" && last.optional && top.at(-2)?.kind === "space") {
    top[top.length - 1] = { ...last, alts: last.alts.map((alt) => [{ kind: "space" } as Node, ...alt]) };
    top.splice(top.length - 2, 1);
  }
  return top;
}

function slotsOf(nodes: Node[], into = new Set<Slot>()): Set<Slot> {
  for (const n of nodes) {
    if (n.kind === "slot") into.add(n.slot);
    else if (n.kind === "group") for (const alt of n.alts) slotsOf(alt, into);
  }
  return into;
}

function startsWordy(nodes: Node[]): boolean {
  const first = nodes[0];
  if (!first) return false;
  if (first.kind === "slot") return true;
  if (first.kind === "text") return /^[\p{L}\p{N}]/u.test(first.text);
  if (first.kind === "group") return first.alts.every((alt) => startsWordy(alt)) && (!first.optional || startsWordy(nodes.slice(1)));
  return false;
}

const normWord = (w: string) => w.toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ").trim();
const escapeLiteral = (t: string) => t.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&").replace(/['’]/g, "['’]");
const alternation = (words: Iterable<string>) => {
  const list = [...new Set(words)].sort((a, b) => b.length - a.length);
  return list.length ? list.map((w) => escapeLiteral(w).replace(/ /g, "\\s+")).join("|") : "(?!)";
};

// Word boundaries that know accented letters (\b does not).
const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const rx = (source: string) => new RegExp(source, "giu");
const GAP = "\\s[^.!?\\n]{0,25}?(?<![\\p{L}\\p{N}])";

interface SlotSources { weekday: string; month: string; mon: string; n: string; part: string }
interface Compiler { sources: SlotSources; capture: boolean; groups: Map<string, Slot> }

function compileNodes(nodes: Node[], c: Compiler): string {
  let out = "";
  nodes.forEach((n, k) => {
    if (n.kind === "space") {
      if (nodes[k - 1]?.kind !== "gap" && nodes[k + 1]?.kind !== "gap") out += "\\s+";
    } else if (n.kind === "text") {
      out += escapeLiteral(n.text);
    } else if (n.kind === "gap") {
      out += GAP;
    } else if (n.kind === "group") {
      out += `(?:${n.alts.map((alt) => compileNodes(alt, c)).join("|")})${n.optional ? "?" : ""}`;
    } else {
      const body = n.slot === "weekday" || n.slot === "month" || n.slot === "mon" || n.slot === "part" ? `(?:${c.sources[n.slot]})`
        : n.slot === "n" ? `(?:\\d{1,3}|${c.sources.n})`
        : n.slot === "day" || n.slot === "monthnum" ? "\\d{1,2}"
        : n.slot === "year" ? "\\d{4}(?!\\d)"
        : n.slot === "yy" ? "(?:\\d{4}|\\d{2})(?!\\d)"
        : "\\d{4}-\\d{2}-\\d{2}";
      if (c.capture) {
        const name = `s${c.groups.size}`;
        c.groups.set(name, n.slot);
        out += `(?<${name}>${body})`;
      } else {
        out += body;
      }
    }
  });
  return out;
}

type Kind = "relative" | "date" | "weekday" | "today" | "thisweek" | "month";
interface Hit {
  start: number;
  end: number;
  from: string;
  to: string;
  kind: Kind;
  weekday?: boolean;
  order?: TemporalOrder;
}
type Read = Omit<Hit, "start" | "end"> | null | "block";
type Get = (slot: Slot | "since") => string | undefined;
interface Phrase { key: PhraseKey; re: RegExp; groups: Map<string, Slot> }

export interface TimeVocabulary {
  readonly phrases: readonly Phrase[];
  readonly past: RegExp;
  readonly future: RegExp;
  readonly idioms: readonly RegExp[];
  readonly filler: ReadonlySet<string>;
  readonly weekdays: ReadonlyMap<string, number>;
  readonly months: ReadonlyMap<string, number>;
  readonly numbers: ReadonlyMap<string, number>;
  readonly parts: ReadonlyMap<string, PartOfDay>;
}

/** The order the phrases are tried in: most specific first, a span claimed by an earlier phrase is not read again. */
const ORDER: readonly PhraseKey[] = [
  "dateForms", "weekdayBeforeLast", "lastWeekday", "dayBeforeYesterday", "yesterday", "lastNight", "earlierToday", "today",
  "tonight", "daysAgo", "lastWeek", "thisWeek", "lastWeekend", "lastMonth", "inMonth", "notWeekday", "weekday",
];

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function templateProblem(key: PhraseKey, template: unknown): string | null {
  if (typeof template !== "string") return `must be text, got ${Array.isArray(template) ? "a list" : typeof template}`;
  let nodes: Node[];
  try { nodes = parseTemplate(template); } catch (err) { return err instanceof Error ? err.message : String(err); }
  const has = slotsOf(nodes);
  const foreign = [...has].filter((s) => !PHRASES[key].slots.includes(s));
  if (foreign.length) return `may not use ${foreign.map((s) => `{${s}}`).join(", ")}${PHRASES[key].slots.length ? ` (allowed: ${PHRASES[key].slots.map((s) => `{${s}}`).join(", ")})` : " (no slot here)"}`;
  return PHRASES[key].needs?.(has) ?? null;
}

/** English plus the extra words, merged on top. Whatever is wrong in `extra`
 * is skipped and reported, never thrown; English stays. */
export function compileTimeWords(extra?: unknown): { vocabulary: TimeVocabulary; warnings: string[]; added: number } {
  const warnings: string[] = [];
  const words: TimeWords = JSON.parse(JSON.stringify(ENGLISH_TIME_WORDS));
  let added = 0;
  if (extra !== undefined && extra !== null) {
    if (!isPlainObject(extra)) {
      warnings.push(`timeWords must be an object ({ "yesterday": ["…"], … }) — ignored, English only`);
    } else {
      for (const [key, value] of Object.entries(extra)) {
        if (key.startsWith("_")) continue;
        const where = `timeWords.${key}`;
        if (Object.hasOwn(MAP_RANGE, key)) {
          const [min, max, what] = MAP_RANGE[key as MapKey];
          if (!isPlainObject(value)) { warnings.push(`${where} must be an object ({ "word": number }) — skipped`); continue; }
          for (const [word, n] of Object.entries(value)) {
            if (!normWord(word)) warnings.push(`${where}: an empty word — skipped`);
            else if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) warnings.push(`${where}.${JSON.stringify(word)} must be ${what} — skipped`);
            else { words[key as MapKey][normWord(word)] = n; added += 1; }
          }
        } else if (key === "partsOfDay") {
          if (!isPlainObject(value)) { warnings.push(`${where} must be an object ({ "word": "morning" | "day" | "night" }) — skipped`); continue; }
          for (const [word, part] of Object.entries(value)) {
            if (!normWord(word)) warnings.push(`${where}: an empty word — skipped`);
            else if (!PARTS.includes(part as PartOfDay)) warnings.push(`${where}.${JSON.stringify(word)} must be "morning", "day" or "night" — skipped`);
            else { words.partsOfDay[normWord(word)] = part as PartOfDay; added += 1; }
          }
        } else if (key === "filler") {
          if (!Array.isArray(value)) { warnings.push(`${where} must be a list of words — skipped`); continue; }
          for (const word of value) {
            if (typeof word !== "string" || !normWord(word) || /\s/.test(normWord(word))) warnings.push(`${where}: ${JSON.stringify(word)} is not a single word — skipped`);
            else { words.filler.push(normWord(word)); added += 1; }
          }
        } else if (Object.hasOwn(PHRASES, key)) {
          if (!Array.isArray(value)) { warnings.push(`${where} must be a list of phrases — skipped`); continue; }
          for (const template of value) {
            const problem = templateProblem(key as PhraseKey, template);
            if (problem) warnings.push(`${where}: ${JSON.stringify(template)} ${problem} — skipped`);
            else { words[key as PhraseKey].push(template as string); added += 1; }
          }
        } else {
          warnings.push(`${where} is not a list the time channel reads (known: ${[...Object.keys(MAP_RANGE), "partsOfDay", ...PHRASE_KEYS, "filler"].join(", ")}) — skipped`);
        }
      }
    }
  }

  const sources: SlotSources = {
    weekday: alternation(Object.keys(words.weekdays)),
    month: alternation(Object.keys(words.months)),
    mon: alternation([...Object.keys(words.months), ...Object.keys(words.monthsShort)]),
    n: alternation(Object.keys(words.numbers)),
    part: alternation(Object.keys(words.partsOfDay)),
  };
  const compile = (template: string, capture: boolean, groups = new Map<string, Slot>()) => {
    const nodes = parseTemplate(template);
    return { wordy: startsWordy(nodes), source: compileNodes(nodes, { sources, capture, groups }) };
  };
  const bounded = ({ wordy, source }: { wordy: boolean; source: string }) => `${wordy ? L : ""}(?:${source})${R}`;
  const unique = (list: string[]) => [...new Set(list.map((t) => t.trim()))];

  const phrases: Phrase[] = [];
  const prefixes = (list: string[]) => unique(list).map((t) => compile(t, false).source).join("|") || "(?!)";
  const dateStart = `(?:(?<since>${prefixes(words.sincePrefixes)})|${prefixes(words.datePrefixes)})`;
  for (const key of ORDER) {
    for (const template of unique(words[key])) {
      const groups = new Map<string, Slot>();
      const body = compile(template, true, groups);
      const source = key === "dateForms" ? `${L}${dateStart}\\s+(?:${body.source})${R}` : bounded(body);
      phrases.push({ key, re: rx(source), groups });
    }
  }
  const markers = (list: string[]) => rx(unique(list).map((t) => bounded(compile(t, false))).join("|") || "(?!)");
  const vocabulary: TimeVocabulary = {
    phrases,
    past: markers(words.past),
    future: markers(words.future),
    idioms: unique(words.idioms).map((t) => rx(bounded(compile(t, false)))),
    filler: new Set(words.filler.map(normWord)),
    weekdays: new Map(Object.entries(words.weekdays).map(([w, n]) => [normWord(w), n])),
    months: new Map([...Object.entries(words.monthsShort), ...Object.entries(words.months)].map(([w, n]) => [normWord(w), n])),
    numbers: new Map(Object.entries(words.numbers).map(([w, n]) => [normWord(w), n])),
    parts: new Map(Object.entries(words.partsOfDay).map(([w, p]) => [normWord(w), p])),
  };
  return { vocabulary, warnings, added };
}

export const ENGLISH: TimeVocabulary = compileTimeWords().vocabulary;

export function timeWordsFile(env: Record<string, string | undefined> = process.env): string {
  return envValue("EMBERVY_STRINGS_LOCAL", env)?.trim() || join(import.meta.dir, "..", "app", "strings.local.json");
}

export function loadTimeWords(env: Record<string, string | undefined> = process.env): {
  vocabulary: TimeVocabulary; warnings: string[]; added: number; file: string; present: boolean;
} {
  const file = timeWordsFile(env);
  if (!existsSync(file)) return { vocabulary: ENGLISH, warnings: [], added: 0, file, present: false };
  let local: unknown;
  try {
    local = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { vocabulary: ENGLISH, warnings: [`${file} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — English only`], added: 0, file, present: true };
  }
  const extra = isPlainObject(local) ? local.timeWords : undefined;
  if (extra === undefined) return { vocabulary: ENGLISH, warnings: [], added: 0, file, present: true };
  return { ...compileTimeWords(extra), file, present: true };
}

// System lines (scheduled prompts, due reminders, approvals, self-turn
// notices, Brain's sense block) are not the user speaking about time.
const SYSTEM_LINE = /^\s*(?:\[(?:gateway|silent|reminder|approval|system|task|wake|self|steer|control|brain)\b[^\]]*\]|<task-notification>|SENSE ·|Stop hook feedback)/i;

interface Ctx {
  today: string;
  past(start: number, end: number): boolean;
  future(start: number, end: number): boolean;
}

/** A date without year: this year, or last year when this year's would lie
 * in the future and the clause speaks in the past. Explicit years are kept;
 * dates in the future never count. */
function resolveDate(ctx: Ctx, start: number, end: number, day: number, month: number, year?: number): string | null {
  if (year !== undefined) {
    const d = isoDate(year, month, day);
    return d && d <= ctx.today ? d : null;
  }
  const thisYear = Number(ctx.today.slice(0, 4));
  const d = isoDate(thisYear, month, day);
  if (!d) return null;
  if (d <= ctx.today) return d;
  if (!ctx.past(start, end)) return null;
  return isoDate(thisYear - 1, month, day);
}

function monthHit(ctx: Ctx, start: number, end: number, month: number): Read {
  const y = Number(ctx.today.slice(0, 4));
  const current = Number(ctx.today.slice(5, 7));
  let year = y;
  if (month > current) {
    if (!ctx.past(start, end)) return null;
    year = y - 1;
  }
  const from = `${year}-${pad2(month)}-01`;
  const last = monthEnd(year, month);
  return { from, to: last < ctx.today ? last : ctx.today, kind: "month" };
}

const shortYear = (raw: string | undefined): number | undefined =>
  raw === undefined ? undefined : raw.length === 2 ? 2000 + Number(raw) : Number(raw);

function readPhrase(key: PhraseKey, get: Get, v: TimeVocabulary, ctx: Ctx, start: number, end: number): Read {
  const today = ctx.today;
  const weekdayOfMatch = () => v.weekdays.get(normWord(get("weekday") ?? ""));
  const order = (): TemporalOrder | undefined => {
    const part = v.parts.get(normWord(get("part") ?? ""));
    return part === "morning" ? "asc" : part === "night" ? "night" : undefined;
  };
  switch (key) {
    case "dateForms": {
      const iso = get("iso");
      const [day, month, year] = iso
        ? [Number(iso.slice(8, 10)), Number(iso.slice(5, 7)), Number(iso.slice(0, 4))]
        : [Number(get("day")), get("monthnum") !== undefined ? Number(get("monthnum")) : v.months.get(normWord(get("mon") ?? get("month") ?? "")),
          shortYear(get("year") ?? get("yy"))];
      if (!day || !month) return null;
      const date = resolveDate(ctx, start, end, day, month, year);
      return date ? { from: date, to: get("since") !== undefined ? today : date, kind: "date" } : null;
    }
    case "weekdayBeforeLast":
    case "lastWeekday": {
      const wd = weekdayOfMatch();
      if (wd === undefined) return null;
      const d = addDays(lastWeekday(today, wd), key === "weekdayBeforeLast" ? -7 : 0);
      return { from: d, to: d, kind: "relative", weekday: true };
    }
    case "dayBeforeYesterday": return { from: addDays(today, -2), to: addDays(today, -2), kind: "relative" };
    case "yesterday": {
      const o = order();
      const d = addDays(today, -1);
      return o === "night" ? { from: d, to: today, kind: "relative", order: o } : { from: d, to: d, kind: "relative", order: o };
    }
    case "lastNight": return { from: addDays(today, -1), to: today, kind: "relative", order: "night" };
    case "earlierToday": return { from: today, to: today, kind: "relative" };
    case "today": {
      const o = order();
      return { from: today, to: today, kind: "today", order: o === "night" ? "desc" : o };
    }
    case "tonight": return { from: today, to: today, kind: "today", order: "desc" };
    case "daysAgo": {
      const raw = get("n") ?? "";
      const n = /^\d+$/.test(raw) ? Number(raw) : v.numbers.get(normWord(raw));
      if (!n || n < 1 || n > MAX_DAYS_AGO) return null;
      const d = addDays(today, -n);
      return { from: d, to: d, kind: "relative" };
    }
    case "lastWeek": return { from: addDays(mondayOf(today), -7), to: addDays(mondayOf(today), -1), kind: "relative" };
    case "thisWeek": return { from: mondayOf(today), to: today, kind: "thisweek" };
    case "lastWeekend": {
      const sunday = lastWeekday(today, 0);
      return { from: addDays(sunday, -1), to: sunday, kind: "relative" };
    }
    case "lastMonth": {
      const y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7));
      const py = mo === 1 ? y - 1 : y, pm = mo === 1 ? 12 : mo - 1;
      return { from: `${py}-${pad2(pm)}-01`, to: monthEnd(py, pm), kind: "month" };
    }
    case "inMonth": {
      const month = v.months.get(normWord(get("month") ?? get("mon") ?? ""));
      return month ? monthHit(ctx, start, end, month) : null;
    }
    case "notWeekday": return "block";
    case "weekday": {
      const wd = weekdayOfMatch();
      if (wd === undefined) return null;
      const d = lastWeekday(today, wd);
      return { from: d, to: d, kind: "weekday", weekday: true };
    }
    default: return null;
  }
}

function maskIdioms(text: string, v: TimeVocabulary): string {
  let out = text;
  for (const re of v.idioms) {
    re.lastIndex = 0;
    out = out.replace(re, (s) => " ".repeat(s.length));
  }
  return out;
}

// Clause boundaries: ! ? ; newline, and a full stop after a letter (a date's
// dots stay inside the clause).
function clauseAround(text: string, start: number, end: number): string {
  const boundary = /[!?;\n]|(?<=\p{L})\.(?=\s|$)/gu;
  let from = 0;
  let to = text.length;
  for (let m = boundary.exec(text); m; m = boundary.exec(text)) {
    if (m.index < start) from = m.index + 1;
    else if (m.index >= end) { to = m.index; break; }
  }
  return text.slice(from, start) + " ".repeat(end - start) + text.slice(end, to);
}

function markerIn(re: RegExp, clause: string): boolean {
  re.lastIndex = 0;
  return re.test(clause);
}

/** Reads at most the beginning and end of a long message (a pasted text keeps
 * the question below it) and weighs at most MAX_TIME_MATCHES phrases. */
export const MAX_TEMPORAL_CHARS = 4_000;
export const MAX_TIME_MATCHES = 64;

export function parseTemporal(text: string, now: number | Date, tz: string, vocabulary: TimeVocabulary = ENGLISH): TemporalQuery | null {
  if (!text) return null;
  if (text.length > MAX_TEMPORAL_CHARS) {
    const half = MAX_TEMPORAL_CHARS / 2;
    text = `${text.slice(0, half)}\n${text.slice(-half)}`;
  }
  const v = vocabulary;
  const lines = text.split("\n");
  const firstLine = lines.find((l) => l.trim()) ?? "";
  if (SYSTEM_LINE.test(firstLine)) return null;
  const own = lines.map((l) => (SYSTEM_LINE.test(l) ? " ".repeat(l.length) : l)).join("\n");
  const masked = maskIdioms(own, v);

  const zone = isValidTimeZone(tz) ? tz : "UTC";
  const today = logicalToday(typeof now === "number" ? now : now.getTime(), zone);
  const ctx: Ctx = {
    today,
    past: (s, e) => markerIn(v.past, clauseAround(masked, s, e)),
    future: (s, e) => markerIn(v.future, clauseAround(masked, s, e)),
  };

  const claimed: Array<[number, number]> = [];
  const free = (s: number, e: number) => claimed.every(([a, b]) => e <= a || s >= b);
  let hits: Hit[] = [];
  let weighed = 0;
  for (const phrase of v.phrases) {
    if (weighed >= MAX_TIME_MATCHES) break;
    phrase.re.lastIndex = 0;
    for (let m = phrase.re.exec(masked); m && weighed < MAX_TIME_MATCHES; m = phrase.re.exec(masked)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!m[0].length) { phrase.re.lastIndex++; continue; }
      if (!free(start, end)) continue;
      weighed += 1;
      const groups = m.groups ?? {};
      const get: Get = (slot) => {
        if (slot === "since") return groups.since;
        for (const [name, s] of phrase.groups) if (s === slot && groups[name] !== undefined) return groups[name];
        return undefined;
      };
      const read = readPhrase(phrase.key, get, v, ctx, start, end);
      if (read === "block") { claimed.push([start, end]); continue; }
      if (!read) continue;
      // Words that also speak about the future count only without a future
      // word; a bare weekday needs a past word as well.
      const ambiguous = read.kind === "today" || read.kind === "thisweek" || read.kind === "weekday" || read.kind === "month";
      if (ambiguous && ctx.future(start, end)) { claimed.push([start, end]); continue; }
      if (read.kind === "weekday" && !ctx.past(start, end)) { claimed.push([start, end]); continue; }
      if (read.from > today) continue;
      claimed.push([start, end]);
      hits.push({ ...read, start, end });
    }
  }
  if (!hits.length) return null;

  // An explicit date beats a weekday ("on Wednesday" next to "on September 30").
  if (hits.some((h) => h.kind === "date")) hits = hits.filter((h) => !h.weekday);
  if (!hits.length) return null;

  const from = hits.reduce((a, h) => (h.from < a ? h.from : a), hits[0].from);
  const to = hits.reduce((a, h) => (h.to > a ? h.to : a), hits[0].to);
  const span = daysBetween(from, to) + 1;
  const mode = hits.some((h) => h.kind === "month") || span > MAX_FILTER_DAYS ? "boost" : "filter";
  const order = hits.find((h) => h.order)?.order ?? "asc";

  const ordered = [...hits].sort((a, b) => a.start - b.start);
  let rest = "";
  let at = 0;
  for (const h of ordered) {
    rest += own.slice(at, h.start) + " ";
    at = h.end;
  }
  rest += own.slice(at);
  rest = rest.replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").trim();
  const words = rest.toLowerCase().replace(/’/g, "'").split(/[^\p{L}\p{N}']+/u).map((w) => w.replace(/^'+|'+$/g, "")).filter((w) => w.length > 0);
  const pure = words.every((w) => v.filler.has(w) || w.length < 2);

  return {
    from,
    to,
    ranges: ordered.map((h) => ({ from: h.from, to: h.to })),
    mode,
    order,
    pure,
    rest,
    today,
    onlyToday: from >= today,
    phrases: ordered.map((h) => own.slice(h.start, h.end).replace(/\s+/g, " ").trim()),
  };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export function dayLabel(date: string): string {
  return parseDate(date) ? `${DAY_NAMES[weekdayOf(date)]} ${date}` : date;
}
export function rangeLabel(from: string, to: string): string {
  return from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`;
}

export interface FileRow {
  filename: string;
  prefix?: string;
  session?: number;
  part?: number;
  date: string;
  themes?: string | null;
  summary?: string | null;
  key_moments?: string | null;
}

export interface SessionCard {
  key: string;
  name: string;
  date: string;
  session: number;
  themes: string | null;
  summary: string | null;
}

export function sessionCards(rows: FileRow[]): SessionCard[] {
  const byKey = new Map<string, SessionCard & { part: number }>();
  for (const r of rows) {
    const session = Number.isInteger(r.session) ? (r.session as number) : 0;
    const prefix = typeof r.prefix === "string" && r.prefix ? r.prefix : r.filename.replace(/\.md$/, "");
    const key = session > 0 ? `${prefix}#${session}` : r.filename;
    const part = Number.isInteger(r.part) ? (r.part as number) : 1;
    const name = session > 0 ? `${prefix}_${session}` : r.filename.replace(/\.md$/, "");
    const card = byKey.get(key);
    const facts = { themes: clean(r.themes), summary: clean(r.summary) };
    if (!card) {
      byKey.set(key, { key, name, date: r.date, session, part, ...facts });
      continue;
    }
    if (r.date < card.date) card.date = r.date;
    if ((!card.themes && !card.summary) || part < card.part) {
      if (facts.themes || facts.summary) { card.themes = facts.themes; card.summary = facts.summary; }
      card.part = Math.min(card.part, part);
    }
  }
  return [...byKey.values()].map(({ part: _part, ...card }) => card);
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t && !/^(—|-|–|placeholder\.?)$/i.test(t) ? t : null;
}

function chronological(a: SessionCard, b: SessionCard): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.session - b.session || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export function orderCards(cards: SessionCard[], q: Pick<TemporalQuery, "from" | "to" | "order">, max = 6): SessionCard[] {
  const asc = [...cards].sort(chronological);
  if (q.order === "asc") return asc.slice(0, max);
  if (q.order === "desc") return asc.reverse().slice(0, max);
  // night: the end of the first day, latest first, then the start of the next.
  const first = asc.filter((c) => c.date === q.from).reverse();
  const after = asc.filter((c) => c.date !== q.from);
  const out = [...first.slice(0, Math.max(max - Math.min(after.length, 2), 0)), ...after.slice(0, 2)];
  for (const c of [...first, ...after]) {
    if (out.length >= max) break;
    if (!out.includes(c)) out.push(c);
  }
  return out.slice(0, max);
}

export function cardLine(card: SessionCard, maxChars = 300): string {
  const facts = [card.themes, card.summary].filter(Boolean).join(" — ");
  const line = `- ${card.name} (${dayLabel(card.date)})${facts ? `: ${facts}` : ""}`;
  return contextLine(line, maxChars);
}

function quoted(q: Pick<TemporalQuery, "phrases">): string {
  const phrases = q.phrases.map((p) => p.slice(0, 40)).slice(0, 3);
  return phrases.length ? ` (${phrases.map((p) => `"${p}"`).join(", ")})` : "";
}

/** With nothing in the range: one honest line, then the adjacent days'
 * sessions, if there are any. */
export function formatDayCard(
  q: Pick<TemporalQuery, "from" | "to" | "order" | "phrases">,
  inRange: FileRow[],
  adjacent: FileRow[] = [],
  max = 6,
): string {
  const head = `Time window ${rangeLabel(q.from, q.to)}${quoted(q)}`;
  const cards = sessionCards(inRange);
  if (cards.length) {
    const shown = orderCards(cards, q, max);
    const lines = [`${head}:`, ...shown.map((c) => cardLine(c))];
    if (cards.length > shown.length) lines.push(`- … ${cards.length - shown.length} more session(s) in this window`);
    return lines.join("\n");
  }
  const lines = [`${head}: no archived session.`];
  const near = sessionCards(adjacent);
  if (near.length) {
    lines.push("Adjacent days:");
    lines.push(...orderCards(near, { from: q.from, to: q.to, order: "asc" }, Math.min(max, 4)).map((c) => cardLine(c)));
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] !== "--check") {
    console.log('usage: bun inlet-temporal.ts --check ["a sentence to try"]   (the time words of the language file, its problems, and what a sentence reads as)');
    process.exit(2);
  }
  const loaded = loadTimeWords();
  console.log(`language file: ${loaded.present ? loaded.file : `not present (${loaded.file}) — English only`}`);
  console.log(`time words added on top of English: ${loaded.added}`);
  console.log(loaded.warnings.length ? `problems (${loaded.warnings.length}):\n${loaded.warnings.map((w) => `  ${w}`).join("\n")}` : "problems: none");
  const sentence = args.slice(1).join(" ").trim();
  if (sentence) {
    const q = parseTemporal(sentence, temporalNow(), temporalTimeZone(), loaded.vocabulary);
    console.log(q
      ? `${JSON.stringify(sentence)} → ${rangeLabel(q.from, q.to)} (${q.mode}${q.pure ? ", only the time" : ""}; read: ${q.phrases.map((p) => JSON.stringify(p)).join(", ")})`
      : `${JSON.stringify(sentence)} → no time reference`);
  }
  process.exit(loaded.warnings.length ? 1 : 0);
}
