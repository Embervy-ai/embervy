import { describe, expect, test } from "bun:test";
import { escapeText, foldLine, formatUtc, renderFeed, feedEntries } from "./ics";
import { readCalendar, occurrencesBetween, unfoldLines } from "./ics-reader";
import type { CalendarEntry } from "./store";

const NOW = Date.UTC(2026, 8, 28, 10, 0, 0);

function entry(p: Partial<CalendarEntry>): CalendarEntry {
  return { id: p.id ?? crypto.randomUUID(), title: "t", date: "2026-09-28", time: null, note: null, created: "2026-09-01T00:00:00.000Z", ...p };
}

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("ICS feed — RFC 5545 basics", () => {
  const feed = renderFeed(
    [
      entry({ id: "a", title: "Dentist", date: "2026-09-28", time: "17:00" }),
      entry({ id: "b", title: "Holiday", date: "2026-12-31" }),
      entry({ id: "c", title: "Call back", date: "2026-12-01", time: "17:00", end: "18:30", note: "secret note text" }),
      entry({ id: "d", title: "Private thing", date: "2026-09-29", time: "08:00", private: true }),
    ],
    { calName: "Agent — calendar", tz: "Europe/Berlin", now: NOW },
  );

  test("every line ends in CRLF, no bare LF or CR", () => {
    expect(feed.endsWith("\r\n")).toBe(true);
    expect(/[^\r]\n/.test(feed)).toBe(false);
    expect(/\r(?!\n)/.test(feed)).toBe(false);
  });

  test("calendar envelope: BEGIN/END balanced, VERSION, PRODID", () => {
    const lines = feed.split("\r\n");
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("VERSION:2.0");
    expect(lines.some((l) => l.startsWith("PRODID:"))).toBe(true);
    expect(lines.filter((l) => l === "BEGIN:VEVENT").length).toBe(lines.filter((l) => l === "END:VEVENT").length);
    expect(lines.filter(Boolean).at(-1)).toBe("END:VCALENDAR");
  });

  test("each event has a unique UID and a UTC DTSTAMP", () => {
    const uids = feed.split("\r\n").filter((l) => l.startsWith("UID:"));
    expect(uids.length).toBe(3);
    expect(new Set(uids).size).toBe(3);
    const stamps = feed.split("\r\n").filter((l) => l.startsWith("DTSTAMP:"));
    expect(stamps.length).toBe(3);
    for (const s of stamps) expect(s).toBe(`DTSTAMP:${formatUtc(NOW)}`);
    expect(formatUtc(NOW)).toBe("20260928T100000Z");
  });

  test("all-day entry: VALUE=DATE, exclusive DTEND rolls over the year", () => {
    expect(feed).toContain("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101");
  });

  test("timed entry: house-local wall time converted to UTC (summer and winter)", () => {
    expect(feed).toContain("DTSTART:20260928T150000Z"); // 17:00 CEST = 15:00Z
    expect(feed).toContain("DTSTART:20261201T160000Z"); // 17:00 CET = 16:00Z
    expect(feed).toContain("DTEND:20261201T173000Z");
  });

  test("private entries and notes never appear", () => {
    expect(feed).not.toContain("Private thing");
    expect(feed).not.toContain("secret note text");
    expect(feed).not.toContain("DESCRIPTION");
  });

  test("time zone agnostic: same entry, other zones", () => {
    const ny = renderFeed([entry({ title: "x", date: "2026-03-09", time: "09:00" })], { calName: "c", tz: "America/New_York", now: NOW });
    expect(ny).toContain("DTSTART:20260309T130000Z"); // Daylight saving time is active for this occurrence.
    const utc = renderFeed([entry({ title: "x", date: "2026-03-09", time: "09:00" })], { calName: "c", tz: "UTC", now: NOW });
    expect(utc).toContain("DTSTART:20260309T090000Z");
  });

  test("feedEntries drops malformed entries instead of emitting broken ICS", () => {
    const kept = feedEntries([entry({ date: "2026-02-30" }), entry({ time: "25:00" }), entry({ title: "ok" })]);
    expect(kept.map((e) => e.title)).toEqual(["ok"]);
  });
});

describe("escaping and folding", () => {
  test("TEXT escaping: backslash, semicolon, comma, newline", () => {
    expect(escapeText("a,b;c\\d\nnew\r\nline")).toBe("a\\,b\\;c\\\\d\\nnew\\nline");
  });

  test("long lines fold at 75 octets without splitting UTF-8 sequences", () => {
    const title = "Crème brûlée à la façade — ".repeat(8) + "🎉🎉🎉 end";
    const feed = renderFeed([entry({ title })], { calName: "c", tz: "UTC", now: NOW });
    for (const line of feed.split("\r\n")) expect(bytes(line)).toBeLessThanOrEqual(75);
    // No replacement characters: every physical line is valid UTF-8 on its own.
    for (const line of feed.split("\r\n")) expect(new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(line))).toBe(line);
    // Unfolding restores the exact summary.
    const summary = unfoldLines(feed).find((l) => l.startsWith("SUMMARY:"))!;
    expect(summary).toBe(`SUMMARY:${escapeText(title)}`);
  });

  test("foldLine leaves short lines alone and continuation lines start with one space", () => {
    expect(foldLine("SUMMARY:short")).toBe("SUMMARY:short");
    const folded = foldLine("X:" + "a".repeat(200)).split("\r\n");
    expect(folded.length).toBe(3);
    expect(bytes(folded[0])).toBe(75);
    expect(folded[1].startsWith(" ")).toBe(true);
    expect(bytes(folded[1])).toBe(75);
  });
});

describe("round trip: the reader understands the writer", () => {
  test("feed parsed back yields the same titles and house-local times", () => {
    const feed = renderFeed(
      [entry({ title: "Dentist; 2, chairs", date: "2026-10-26", time: "09:15", end: "10:00" }), entry({ title: "Trip", date: "2026-10-27" })],
      { calName: "c", tz: "Europe/Berlin", now: NOW },
    );
    const cal = readCalendar(feed, "Europe/Berlin");
    const occ = occurrencesBetween(cal, "Europe/Berlin", "2026-10-25", "2026-10-28", "c");
    expect(occ.map((o) => [o.date, o.time, o.end, o.title])).toEqual([
      ["2026-10-26", "09:15", "10:00", "Dentist; 2, chairs"],
      ["2026-10-27", null, null, "Trip"],
    ]);
  });
});
