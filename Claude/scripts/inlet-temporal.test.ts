import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cardLine, compileTimeWords, ENGLISH, formatDayCard, loadTimeWords, logicalToday, orderCards, parseTemporal, sessionCards,
  temporalEnabled, temporalNow, temporalTimeZone, timeWordsFile, type FileRow, type TimeVocabulary,
} from "./inlet-temporal.ts";

// Pure parser tests with a fixed clock. All sample sentences are made up.
const TZ = "Europe/Berlin";
const FRI = Date.parse("2026-10-02T14:00:00+02:00"); // Friday afternoon
const AFTER_MIDNIGHT = Date.parse("2026-10-03T00:30:00+02:00"); // Saturday 00:30, still Friday's night

const at = (text: string, now = FRI, words: TimeVocabulary = ENGLISH) => parseTemporal(text, now, TZ, words);
const range = (text: string, now = FRI, words: TimeVocabulary = ENGLISH) => {
  const q = at(text, now, words);
  return q ? `${q.from}..${q.to}` : null;
};

describe("the house day ends at 04:00", () => {
  test("00:30 is still the day before; 04:00 starts the new day", () => {
    expect(logicalToday(AFTER_MIDNIGHT, TZ)).toBe("2026-10-02");
    expect(logicalToday(Date.parse("2026-10-03T03:59:00+02:00"), TZ)).toBe("2026-10-02");
    expect(logicalToday(Date.parse("2026-10-03T04:00:00+02:00"), TZ)).toBe("2026-10-03");
    expect(logicalToday(FRI, "UTC")).toBe("2026-10-02");
  });

  test("at 00:30 'yesterday' is the day before the evening one is still in", () => {
    expect(range("What happened yesterday?", AFTER_MIDNIGHT)).toBe("2026-10-01..2026-10-01");
    expect(range("What did we say this morning?", AFTER_MIDNIGHT)).toBe("2026-10-02..2026-10-02");
  });

  test("end of summer time, 25.10.2026 (the night has 25 hours)", () => {
    // 02:30 CEST (first pass) and 02:30 CET (second pass) are both still the 24th.
    expect(logicalToday(Date.parse("2026-10-25T00:30:00Z"), TZ)).toBe("2026-10-24");
    expect(logicalToday(Date.parse("2026-10-25T01:30:00Z"), TZ)).toBe("2026-10-24");
    expect(logicalToday(Date.parse("2026-10-25T02:59:00Z"), TZ)).toBe("2026-10-24"); // 03:59 CET
    expect(logicalToday(Date.parse("2026-10-25T03:00:00Z"), TZ)).toBe("2026-10-25"); // 04:00 CET
    const sundayMorning = Date.parse("2026-10-25T10:00:00+01:00");
    expect(range("What happened yesterday?", sundayMorning)).toBe("2026-10-24..2026-10-24");
    expect(range("What happened last week?", Date.parse("2026-10-26T10:00:00+01:00"))).toBe("2026-10-19..2026-10-25");
    expect(range("seven days ago", Date.parse("2026-10-26T10:00:00+01:00"))).toBe("2026-10-19..2026-10-19");
    // During the repeated hour, "yesterday" is the 23rd.
    expect(range("What happened yesterday?", Date.parse("2026-10-25T01:30:00Z"))).toBe("2026-10-23..2026-10-23");
  });
});

describe("English triggers (now: Fri 2026-10-02 14:00)", () => {
  const cases: Array<[string, string, string?]> = [
    ["What happened yesterday?", "2026-10-01..2026-10-01"],
    ["the day before yesterday", "2026-09-30..2026-09-30"],
    ["What did we do last Tuesday?", "2026-09-29..2026-09-29"],
    ["What happened this past Friday?", "2026-09-25..2026-09-25"],
    ["What was on the Tuesday before last?", "2026-09-22..2026-09-22"],
    ["What did we discuss on Wednesday?", "2026-09-30..2026-09-30"],
    ["Remember Monday?", "2026-09-28..2026-09-28"],
    ["What happened on September 24?", "2026-09-24..2026-09-24"],
    ["What happened on the 24th of September?", "2026-09-24..2026-09-24"],
    ["What happened on Tuesday, 29 September?", "2026-09-29..2026-09-29"],
    ["What happened on July 22?", "2026-07-22..2026-07-22"],
    ["What happened on Sept 24, 2025?", "2025-09-24..2025-09-24"],
    ["What happened on 3 Oct. 2025?", "2025-10-03..2025-10-03"],
    ["What happened on 2026-09-24?", "2026-09-24..2026-09-24"],
    ["What happened on December 24?", "2025-12-24..2025-12-24"],
    ["What happened yesterday evening?", "2026-10-01..2026-10-02", "night"],
    ["What happened last night?", "2026-10-01..2026-10-02", "night"],
    ["What happened yesterday morning?", "2026-10-01..2026-10-01", "asc"],
    ["What did we say this morning?", "2026-10-02..2026-10-02", "asc"],
    ["What did we say earlier today?", "2026-10-02..2026-10-02"],
    ["What happened 3 days ago?", "2026-09-29..2026-09-29"],
    ["What happened two days ago?", "2026-09-30..2026-09-30"],
    ["What happened a day ago?", "2026-10-01..2026-10-01"],
    ["What happened last week?", "2026-09-21..2026-09-27"],
    ["What did we build this week?", "2026-09-28..2026-10-02"],
    ["What happened last weekend?", "2026-09-26..2026-09-27"],
    ["What happened since September 20?", "2026-09-20..2026-10-02"],
    ["What happened since 2026-09-20?", "2026-09-20..2026-10-02"],
  ];
  for (const [text, expected, order] of cases) {
    test(text, () => {
      const q = at(text)!;
      expect(q).not.toBeNull();
      expect(`${q.from}..${q.to}`).toBe(expected);
      expect(q.mode).toBe("filter");
      if (order) expect(q.order).toBe(order as any);
    });
  }
});

describe("never a trigger", () => {
  const negatives = [
    // the future, idioms, greetings
    "Tomorrow I have to see the doctor",
    "Next Tuesday is the appointment",
    "How's it going today?",
    "How’s it going today?",
    "How are you doing today?",
    "How are you today?",
    "Good morning",
    "Good morning! How's it going?",
    "It has been like this until today",
    "That is normal nowadays",
    "from today to tomorrow",
    "The day after tomorrow we leave",
    "Coming Friday works for me",
    "This evening I will cook",
    "From today the new rule applies",
    "That's enough for today",
    "On December 24 is Christmas",
    "On December 24, 2026 is Christmas",
    "See you on October 20",
    "I'll call you tomorrow",
    "See you next Tuesday",
    "to this day",
    "in 3 days",
    "Tomorrow at 9",
    // a weekday without a past word, habits, limits
    "On Tuesday",
    "Tuesday I'm off",
    "Do you have time on Wednesday?",
    "Every Monday we train",
    "It must be done by Friday",
    "On Mondays we train",
    // numbers without on/from/since in front, too far back
    "I have 24 days off",
    "Room 12.10 is free",
    "Version 2026-09-24 is installed",
    "90 days ago",
    // system lines
    "[gateway:silent] What happened yesterday?",
    "[Reminder] Waiting for you for over an hour:\n- ask about yesterday",
    "[approval] What happened yesterday?",
    "[system:cache-ping] Stay here. Yesterday was long.",
    "SENSE · calendar today (2026-10-02): 09:00 what happened yesterday",
    "[task] Background job from yesterday finished",
    "",
  ];
  for (const text of negatives) {
    test(JSON.stringify(text), () => expect(at(text)).toBeNull());
  }

  test("a system line inside a message is ignored, the rest still counts", () => {
    expect(range("Quick question.\n[gateway:silent] the day before yesterday\nWhat happened yesterday?")).toBe("2026-10-01..2026-10-01");
  });
});

describe("several references, precedence, modes", () => {
  test("an explicit date beats a weekday", () => {
    const q = at("On Wednesday, 30 September we decided something")!;
    expect(`${q.from}..${q.to}`).toBe("2026-09-30..2026-09-30");
    const r = at("What happened last Tuesday and on September 30?")!;
    expect(r.ranges).toEqual([{ from: "2026-09-30", to: "2026-09-30" }]);
  });

  test("references are united; up to 14 days stay a filter window", () => {
    const q = at("What happened yesterday and the day before yesterday?")!;
    expect(q.mode).toBe("filter");
    expect(`${q.from}..${q.to}`).toBe("2026-09-30..2026-10-01");
    expect(q.ranges).toHaveLength(2);
  });

  test("over 14 days or a month: boost only", () => {
    expect(at("What happened yesterday and on September 10?")!.mode).toBe("boost");
    expect(at("What happened since September 1?")!.mode).toBe("boost");
    const sept = at("What happened in September?")!;
    expect(sept.mode).toBe("boost");
    expect(`${sept.from}..${sept.to}`).toBe("2026-09-01..2026-09-30");
    expect(range("What happened last month?")).toBe("2026-09-01..2026-09-30");
    expect(at("What happened last month?")!.mode).toBe("boost");
    expect(range("What happened in October?")).toBe("2026-10-01..2026-10-02");
    expect(range("What happened in December?")).toBe("2025-12-01..2025-12-31");
    expect(at("In December we go away")).toBeNull();
    expect(range("What happened in July?")).toBe("2026-07-01..2026-07-31");
  });

  test("pure time question vs. a topic in a window", () => {
    expect(at("What happened yesterday?")!.pure).toBe(true);
    expect(at("Good morning, what happened yesterday?")!.pure).toBe(true);
    const topic = at("What did we say about the garden shed yesterday?")!;
    expect(topic.pure).toBe(false);
    expect(topic.rest).toBe("What did we say about the garden shed?");
    expect(topic.phrases).toEqual(["yesterday"]);
  });

  test("today only is marked, so the channel can stay silent", () => {
    expect(at("What did we say this morning?")!.onlyToday).toBe(true);
    expect(at("What happened yesterday?")!.onlyToday).toBe(false);
  });
});

// The words of another language come from the app's language file
// (strings.local.json, "timeWords"). Spanish here; any language works the same.
const SPANISH = {
  weekdays: { domingo: 0, lunes: 1, martes: 2, "miércoles": 3, miercoles: 3, jueves: 4, viernes: 5, "sábado": 6, sabado: 6 },
  months: {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  },
  numbers: { un: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 },
  partsOfDay: { "por la mañana": "morning", "por la tarde": "day", "por la noche": "night" },
  datePrefixes: ["el"],
  sincePrefixes: ["desde [el]"],
  dateForms: ["{day}/{monthnum}[/{yy}]", "{day} de {month} [de {year}]"],
  lastWeekday: ["[el] {weekday} pasado"],
  dayBeforeYesterday: ["anteayer"],
  yesterday: ["ayer [{part}]"],
  lastNight: ["anoche"],
  today: ["hoy [{part}]"],
  daysAgo: ["hace {n} día[s]"],
  lastWeek: ["la semana pasada"],
  inMonth: ["en {month}"],
  notWeekday: ["[el] próximo {weekday}", "cada {weekday}"],
  weekday: ["[el] {weekday}"],
  past: ["hablamos", "hicimos", "pasó", "fue"],
  future: ["mañana", "voy a", "vamos a"],
  idioms: ["(cómo|como) (estás|está) … hoy", "buenos días"],
  filler: ["qué", "que", "pasó", "el", "la", "de", "nosotros", "hablamos", "hicimos"],
};

const languageDirs: string[] = [];
afterEach(() => {
  for (const dir of languageDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function languageFile(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "inlet-time-words-"));
  languageDirs.push(dir);
  const file = join(dir, "strings.local.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

describe("time words from the language file (strings.local.json)", () => {
  // The same file carries the app's texts and Brain's messages; the time channel reads only "timeWords".
  const file = languageFile({ language: "es", "chat.send": "Enviar", brain: { "cache ping": "ping de caché" }, timeWords: SPANISH });
  const loaded = loadTimeWords({ EMBERVY_STRINGS_LOCAL: file });
  const es = loaded.vocabulary;

  test("the file is read, nothing is skipped", () => {
    expect(loaded.present).toBe(true);
    expect(loaded.file).toBe(file);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.added).toBeGreaterThan(50);
  });

  test("Spanish words find their dates", () => {
    const cases: Array<[string, string, string?]> = [
      ["¿Qué pasó ayer?", "2026-10-01..2026-10-01"],
      ["¿Qué hablamos el martes pasado?", "2026-09-29..2026-09-29"],
      ["martes pasado", "2026-09-29..2026-09-29"],
      ["anteayer", "2026-09-30..2026-09-30"],
      ["¿Qué pasó hace tres días?", "2026-09-29..2026-09-29"],
      ["¿Qué pasó el 30/09?", "2026-09-30..2026-09-30"],
      ["¿Qué pasó el 30/09/25?", "2025-09-30..2025-09-30"],
      ["¿Qué pasó el 30 de septiembre?", "2026-09-30..2026-09-30"],
      ["¿Qué pasó desde el 20/09?", "2026-09-20..2026-10-02"],
      ["¿Qué pasó desde 20/09?", "2026-09-20..2026-10-02"],
      ["¿Qué pasó ayer por la noche?", "2026-10-01..2026-10-02", "night"],
      ["¿Qué pasó anoche?", "2026-10-01..2026-10-02", "night"],
      ["¿Qué hicimos el miércoles?", "2026-09-30..2026-09-30"],
      ["¿Qué hicimos hoy por la mañana?", "2026-10-02..2026-10-02", "asc"],
      ["¿Qué pasó la semana pasada?", "2026-09-21..2026-09-27"],
    ];
    for (const [text, expected, order] of cases) {
      const q = at(text, FRI, es);
      expect([text, q ? `${q.from}..${q.to}` : null]).toEqual([text, expected]);
      if (order) expect([text, q!.order]).toEqual([text, order as any]);
    }
    expect(at("¿Qué pasó en septiembre?", FRI, es)!.mode).toBe("boost");
    const q = at("¿Qué pasó ayer?", FRI, es)!;
    expect(q.pure).toBe(true);
    expect(q.phrases).toEqual(["ayer"]);
  });

  test("its future words, idioms and weekdays ahead never count", () => {
    for (const text of ["El próximo martes tengo médico", "Tengo cita el martes", "¿Cómo estás hoy?", "Hoy voy a cocinar", "Cada lunes entrenamos", "Buenos días"]) {
      expect([text, at(text, FRI, es)]).toEqual([text, null]);
    }
  });

  test("English stays: the file adds words on top", () => {
    expect(range("What happened yesterday?", FRI, es)).toBe("2026-10-01..2026-10-01");
    expect(range("What did we do last Tuesday?", FRI, es)).toBe("2026-09-29..2026-09-29");
    expect(at("See you next Tuesday", FRI, es)).toBeNull();
  });

  test("without the file only English works", () => {
    const none = loadTimeWords({ EMBERVY_STRINGS_LOCAL: join(tmpdir(), "no-such-dir-7f3a", "strings.local.json") });
    expect(none.present).toBe(false);
    expect(none.warnings).toEqual([]);
    expect(none.vocabulary).toBe(ENGLISH);
    for (const text of ["¿Qué pasó ayer?", "¿Qué hablamos el martes pasado?", "¿Qué pasó hace tres días?"]) {
      expect([text, at(text, FRI, none.vocabulary)]).toEqual([text, null]);
      expect([text, at(text)]).toEqual([text, null]); // parseTemporal's default is English alone
    }
    expect(range("What happened yesterday?", FRI, none.vocabulary)).toBe("2026-10-01..2026-10-01");
    // A file with the app's texts but no time words: English too, nothing to report.
    const textsOnly = loadTimeWords({ EMBERVY_STRINGS_LOCAL: languageFile({ language: "es", "chat.send": "Enviar" }) });
    expect([textsOnly.present, textsOnly.warnings, textsOnly.vocabulary]).toEqual([true, [], ENGLISH]);
  });

  test("the default file is the app's strings.local.json", () => {
    expect(timeWordsFile({})).toBe(join(import.meta.dir, "..", "app", "strings.local.json"));
    expect(timeWordsFile({ EMBERVY_STRINGS_LOCAL: " /x/y.json " })).toBe("/x/y.json");
  });

  test("a broken file or entry is reported and skipped; English and the good entries stay", () => {
    const broken = loadTimeWords({ EMBERVY_STRINGS_LOCAL: languageFile("{ \"timeWords\": ") });
    expect(broken.vocabulary).toBe(ENGLISH);
    expect(broken.warnings.join("\n")).toContain("is not valid JSON");

    const { vocabulary, warnings, added } = compileTimeWords({
      yesterday: ["ayer", "{weekday pasado", 7],
      lastWeekday: ["{weekday} pasado", "pasado"],
      daysAgo: ["hace {x} días"],
      today: ["hoy {n}"],
      weekdays: { martes: 2, nunca: 9 },
      partsOfDay: { "por la noche": "midnight" },
      filler: ["dos palabras"],
      sometimes: ["a veces"],
      _note: "notes are allowed",
    });
    expect(added).toBe(3); // "ayer", "{weekday} pasado", martes
    const text = warnings.join("\n");
    for (const part of [
      'timeWords.yesterday: "{weekday pasado" has "{" without "}"',
      "timeWords.yesterday: 7 must be text",
      'timeWords.lastWeekday: "pasado" needs {weekday}',
      'timeWords.daysAgo: "hace {x} días" has an unknown slot {x}',
      'timeWords.today: "hoy {n}" may not use {n}',
      'timeWords.weekdays."nunca" must be a whole number from 0 (Sunday) to 6 (Saturday)',
      'timeWords.partsOfDay."por la noche" must be "morning", "day" or "night"',
      'timeWords.filler: "dos palabras" is not a single word',
      "timeWords.sometimes is not a list the time channel reads",
    ]) expect([part, text.includes(part)]).toEqual([part, true]);
    expect(warnings).toHaveLength(9);
    expect(range("¿Qué pasó ayer?", FRI, vocabulary)).toBe("2026-10-01..2026-10-01");
    expect(range("martes pasado", FRI, vocabulary)).toBe("2026-09-29..2026-09-29");
    expect(range("What happened yesterday?", FRI, vocabulary)).toBe("2026-10-01..2026-10-01");
    expect(compileTimeWords(["not", "an", "object"]).warnings).toEqual(['timeWords must be an object ({ "yesterday": ["…"], … }) — ignored, English only']);
  });

  test("the built-in English compiles without a warning", () => {
    expect(compileTimeWords().warnings).toEqual([]);
    expect(compileTimeWords({}).added).toBe(0);
  });
});

describe("environment", () => {
  test("INLET_TEMPORAL: on by default, 0/off/false switch off (inline comments allowed)", () => {
    expect(temporalEnabled({})).toBe(true);
    expect(temporalEnabled({ INLET_TEMPORAL: "1" })).toBe(true);
    for (const v of ["0", "off", "false", "0   # comment"]) expect(temporalEnabled({ INLET_TEMPORAL: v })).toBe(false);
  });

  test("zone: BRAIN_TIMEZONE, then EMBERVY_TIMEZONE, then UTC", () => {
    expect(temporalTimeZone({ BRAIN_TIMEZONE: "Europe/Berlin", EMBERVY_TIMEZONE: "America/New_York" })).toBe("Europe/Berlin");
    expect(temporalTimeZone({ BRAIN_TIMEZONE: "Not/AZone", EMBERVY_TIMEZONE: "America/New_York" })).toBe("America/New_York");
    expect(temporalTimeZone({})).toBe("UTC");
  });

  test("INLET_NOW: ISO or epoch ms; anything else falls back to the clock", () => {
    expect(temporalNow({ INLET_NOW: "2026-10-02T14:00:00+02:00" }, 1)).toBe(FRI);
    expect(temporalNow({ INLET_NOW: String(FRI) }, 1)).toBe(FRI);
    expect(temporalNow({ INLET_NOW: "soon" }, 1)).toBe(1);
    expect(temporalNow({}, 1)).toBe(1);
  });
});

describe("day card", () => {
  const row = (filename: string, session: number, date: string, extra: Partial<FileRow> = {}): FileRow =>
    ({ filename, prefix: "Session", session, part: 1, date, themes: null, summary: null, ...extra });
  const rows: FileRow[] = [
    row("Session_40.md", 40, "2026-10-01", { themes: "Garden plans", summary: "Raised beds measured." }),
    row("Session_41_part01.md", 41, "2026-10-01", { themes: "Tool shed", summary: "Roof options compared." }),
    row("Session_41_part02.md", 41, "2026-10-01", { part: 2, themes: "Tool shed", summary: "Roof options compared." }),
    row("Session_42.md", 42, "2026-10-02", { themes: "—", summary: "placeholder." }),
  ];

  test("one line per session, parts folded, placeholders dropped", () => {
    const cards = sessionCards(rows);
    expect(cards.map((c) => c.name)).toEqual(["Session_40", "Session_41", "Session_42"]);
    expect(cardLine(cards[1])).toBe("- Session_41 (Thu 2026-10-01): Tool shed — Roof options compared.");
    expect(cardLine(cards[2])).toBe("- Session_42 (Fri 2026-10-02)");
  });

  test("order: earliest first, latest first, around midnight", () => {
    const cards = sessionCards(rows);
    const names = (order: "asc" | "desc" | "night") =>
      orderCards(cards, { from: "2026-10-01", to: "2026-10-02", order }).map((c) => c.name);
    expect(names("asc")).toEqual(["Session_40", "Session_41", "Session_42"]);
    expect(names("desc")).toEqual(["Session_42", "Session_41", "Session_40"]);
    expect(names("night")).toEqual(["Session_41", "Session_40", "Session_42"]);
  });

  test("at most six sessions, at most 300 characters a line", () => {
    const many = Array.from({ length: 9 }, (_, i) => row(`Session_${50 + i}.md`, 50 + i, "2026-10-01", { summary: "x".repeat(400) }));
    const card = formatDayCard({ from: "2026-10-01", to: "2026-10-01", order: "asc", phrases: ["yesterday"] }, many);
    const lines = card.split("\n");
    expect(lines[0]).toBe('Time window Thu 2026-10-01 ("yesterday"):');
    expect(lines.filter((l) => l.startsWith("- Session_"))).toHaveLength(6);
    expect(lines.at(-1)).toBe("- … 3 more session(s) in this window");
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(300);
  });

  test("an empty window says so, then shows the adjacent days", () => {
    const card = formatDayCard({ from: "2026-09-29", to: "2026-09-29", order: "asc", phrases: ["on September 29"] }, [],
      [row("Session_30.md", 30, "2026-09-28", { themes: "Bookshelf" })]);
    expect(card).toBe('Time window Tue 2026-09-29 ("on September 29"): no archived session.\nAdjacent days:\n- Session_30 (Mon 2026-09-28): Bookshelf');
    expect(formatDayCard({ from: "2026-09-29", to: "2026-09-29", order: "asc", phrases: [] }, []))
      .toBe("Time window Tue 2026-09-29: no archived session.");
  });
});
