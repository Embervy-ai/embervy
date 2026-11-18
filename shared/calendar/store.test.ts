import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEntries, validateNewEntries, writeEntries } from "./store";
import { addDays } from "./time";

const recurring = {
  title: "Practice", date: "2026-09-28", time: "17:30", end: "18:30", note: "Local note",
  repeat_weekdays: ["MO", "Thursday"], repeat_until: "2026-11-08",
  except_dates: ["2026-10-01", "2026-10-19"],
};

describe("calendar series expansion", () => {
  test("two weekdays over six weeks omit exactly the two exceptions", () => {
    const result = validateNewEntries(recurring);
    expect(result.error).toBeUndefined();
    expect(result.entries!.map((entry) => entry.date)).toEqual([
      "2026-09-28", "2026-10-05", "2026-10-08", "2026-10-12", "2026-10-15",
      "2026-10-22", "2026-10-26", "2026-10-29", "2026-11-02", "2026-11-05",
    ]);
    for (const entry of result.entries!) {
      expect([entry.title, entry.time, entry.end, entry.note]).toEqual(["Practice", "17:30", "18:30", "Local note"]);
    }
  });

  test("the start date is only included when its weekday matches and the end is inclusive", () => {
    const entries = validateNewEntries({ ...recurring, date: "2026-09-29", repeat_until: "2026-10-05", except_dates: [] }).entries!;
    expect(entries.map((entry) => entry.date)).toEqual(["2026-10-01", "2026-10-05"]);
    expect(validateNewEntries({ ...recurring, repeat_until: recurring.date }).entries!.map((entry) => entry.date)).toEqual([recurring.date]);
  });

  test("each English name and abbreviation is case insensitive and duplicate weekdays do not duplicate entries", () => {
    for (const [short, full, date] of [
      ["mo", "Monday", "2026-09-28"], ["tu", "Tuesday", "2026-09-29"],
      ["we", "Wednesday", "2026-09-30"], ["th", "Thursday", "2026-10-01"],
      ["fr", "Friday", "2026-10-02"], ["sa", "Saturday", "2026-10-03"], ["su", "Sunday", "2026-10-04"],
    ]) {
      const entries = validateNewEntries({ ...recurring, repeat_weekdays: [short.toUpperCase(), full, full.toUpperCase(), "invalid"], repeat_until: "2026-10-04", except_dates: [] }).entries!;
      expect(entries.map((entry) => entry.date)).toEqual([date]);
    }
  });

  test("series have distinct identifiers and occurrences have their own identifiers", () => {
    const first = validateNewEntries(recurring).entries!;
    const second = validateNewEntries(recurring).entries!;
    expect(new Set(first.map((entry) => entry.series)).size).toBe(1);
    expect(first[0].series).toMatch(/^[0-9a-f-]{36}$/);
    expect(first[0].series).not.toBe(second[0].series);
    expect(new Set([...first, ...second].map((entry) => entry.id)).size).toBe(first.length + second.length);
    expect(first.every((entry) => entry.id !== entry.series)).toBe(true);
  });

  test("366 inclusive calendar days and exactly 200 occurrences are accepted", () => {
    const date = "2028-01-01";
    const year = validateNewEntries({ title: "Weekly", date, repeat_weekdays: ["mo"], repeat_until: "2028-12-31" });
    expect(year.error).toBeUndefined();
    expect(year.entries).toHaveLength(52);
    const daily = validateNewEntries({ title: "Daily", date, repeat_weekdays: ["mo", "tu", "we", "th", "fr", "sa", "su"], repeat_until: addDays(date, 199) });
    expect(daily.entries).toHaveLength(200);
    const excluded = validateNewEntries({ title: "Daily", date, repeat_weekdays: ["mo", "tu", "we", "th", "fr", "sa", "su"], repeat_until: addDays(date, 200), except_dates: [date] });
    expect(excluded.entries).toHaveLength(200);
  });

  test("all-day private series retain privacy and ordinary entries have no series field", () => {
    const entries = validateNewEntries({ ...recurring, time: undefined, end: undefined, private: true }).entries!;
    expect(entries.every((entry) => entry.time === null && entry.private === true && !entry.end)).toBe(true);
    const single = validateNewEntries({ title: "Single", date: recurring.date }).entries!;
    expect(single).toHaveLength(1);
    expect(single[0]).not.toHaveProperty("series");
  });
});

test("a calendar without series fields round trips without changing its bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "calendar-legacy-"));
  const file = join(dir, "calendar.json");
  const old = [{ id: "old-id", title: "Existing", date: "2026-09-28", time: null, note: null, created: "2026-09-01T00:00:00.000Z" }];
  try {
    for (const bytes of [JSON.stringify(old, null, 2), JSON.stringify(old) + "\n"]) {
      writeFileSync(file, bytes);
      const entries = readEntries(file);
      expect(entries).toEqual(old);
      writeEntries(file, entries);
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
    const added = validateNewEntries(recurring).entries!;
    writeEntries(file, [...readEntries(file), ...added]);
    expect(readEntries(file)[0]).toEqual(old[0]);
    writeEntries(file, readEntries(file).filter((entry) => !entry.series));
    expect(readEntries(file)).toEqual(old);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
