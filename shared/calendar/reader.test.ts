import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { occurrencesBetween, parseContentLine, readCalendar, resolveTzid } from "./ics-reader";
import { fetchIcsText, parseIcsUrls, readExternalCache, syncExternal } from "./external";

const cal = (...events: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "X-WR-CALNAME:Work", ...events, "END:VCALENDAR"].join("\r\n") + "\r\n";
const ev = (...props: string[]) => ["BEGIN:VEVENT", ...props, "END:VEVENT"].join("\r\n");

function occ(text: string, tz: string, from: string, to: string) {
  return occurrencesBetween(readCalendar(text, tz), tz, from, to, "Work");
}
const brief = (o: { date: string; time: string | null; title: string }[]) => o.map((x) => `${x.date} ${x.time ?? "all-day"} ${x.title}`);

describe("parsing", () => {
  test("folded lines, escaped text, quoted params with colons", () => {
    const text = cal(
      ev("UID:1", "DTSTART;TZID=\"Europe/Berlin\":20260928T090000", "DTEND;TZID=Europe/Berlin:20260928T100000", "SUMMARY:Stand\\, up\\; daily", " ly check \\\\ in", "X-FOO;LABEL=\"a:b\":value"),
    );
    const o = occ(text, "Europe/Berlin", "2026-09-28", "2026-09-28");
    expect(o).toHaveLength(1);
    expect(o[0].title).toBe("Stand, up; dailyly check \\ in");
    expect([o[0].time, o[0].end]).toEqual(["09:00", "10:00"]);
    expect(parseContentLine('X-FOO;LABEL="a:b":value')).toEqual({ name: "X-FOO", params: { LABEL: "a:b" }, value: "value" });
  });

  test("TZID forms: IANA, Windows (Outlook), prefixed, unknown → fallback", () => {
    expect(resolveTzid("Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveTzid("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(resolveTzid("/mozilla.org/20050126_1/Europe/Berlin")).toBe("Europe/Berlin");
    expect(resolveTzid("Custom Zone 42")).toBeNull();
    const text = cal(ev("UID:w", "DTSTART;TZID=W. Europe Standard Time:20260928T090000", "SUMMARY:Outlook meeting"));
    // House in UTC: 09:00 Berlin summer time is 07:00 UTC.
    expect(brief(occ(text, "UTC", "2026-09-28", "2026-09-28"))).toEqual(["2026-09-28 07:00 Outlook meeting"]);
  });

  test("UTC and floating times", () => {
    const text = cal(ev("UID:u", "DTSTART:20260928T070000Z", "SUMMARY:utc"), ev("UID:f", "DTSTART:20260928T120000", "SUMMARY:floating"));
    expect(brief(occ(text, "Europe/Berlin", "2026-09-28", "2026-09-28"))).toEqual(["2026-09-28 09:00 utc", "2026-09-28 12:00 floating"]);
  });

  test("all-day across several days shows on each day; timed across midnight continues", () => {
    const text = cal(
      ev("UID:a", "DTSTART;VALUE=DATE:20260927", "DTEND;VALUE=DATE:20260930", "SUMMARY:Trip"),
      ev("UID:n", "DTSTART:20260928T200000Z", "DTEND:20260929T060000Z", "SUMMARY:Night shift"),
    );
    const o = occ(text, "UTC", "2026-09-28", "2026-09-29");
    expect(brief(o)).toEqual(["2026-09-28 all-day Trip", "2026-09-28 20:00 Night shift", "2026-09-29 all-day Trip", "2026-09-29 all-day Night shift"]);
    expect(o.find((x) => x.date === "2026-09-29" && x.title === "Night shift")).toMatchObject({ continued: true, end: "06:00" });
  });

  test("cancelled events are skipped; non-calendars are rejected", () => {
    expect(occ(cal(ev("UID:c", "DTSTART:20260928T090000Z", "STATUS:CANCELLED", "SUMMARY:gone")), "UTC", "2026-09-28", "2026-09-28")).toHaveLength(0);
    expect(() => readCalendar("<html>login</html>", "UTC")).toThrow("not an ICS calendar");
  });
});

describe("recurrence", () => {
  test("WEEKLY BYDAY=MO,WE with COUNT", () => {
    const text = cal(ev("UID:r1", "DTSTART;TZID=Europe/Berlin:20260907T090000", "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5", "SUMMARY:Gym"));
    expect(brief(occ(text, "Europe/Berlin", "2026-09-01", "2026-10-31"))).toEqual([
      "2026-09-07 09:00 Gym",
      "2026-09-09 09:00 Gym",
      "2026-09-14 09:00 Gym",
      "2026-09-16 09:00 Gym",
      "2026-09-21 09:00 Gym",
    ]);
  });

  test("weekly across the DST change keeps the local hour", () => {
    const text = cal(ev("UID:r2", "DTSTART;TZID=Europe/Berlin:20261019T090000", "RRULE:FREQ=WEEKLY", "SUMMARY:Standup"));
    const o = occ(text, "Europe/Berlin", "2026-10-19", "2026-11-02");
    expect(o.map((x) => x.time)).toEqual(["09:00", "09:00", "09:00"]);
    // and in UTC the hour moves by one
    expect(occ(text, "UTC", "2026-10-19", "2026-11-02").map((x) => x.time)).toEqual(["07:00", "08:00", "08:00"]);
  });

  test("DAILY INTERVAL=2 with UNTIL, today's occurrence from a series started long ago", () => {
    const text = cal(ev("UID:r3", "DTSTART:20100101T060000Z", "RRULE:FREQ=DAILY;INTERVAL=2", "SUMMARY:Pills"), ev("UID:r4", "DTSTART:20260901T060000Z", "RRULE:FREQ=DAILY;UNTIL=20260903T060000Z", "SUMMARY:Short"));
    // The target is 6114 days from the start, so the every-other-day rule includes it.
    expect(brief(occ(text, "UTC", "2026-09-28", "2026-09-29"))).toEqual(["2026-09-28 06:00 Pills"]);
    expect(brief(occ(text, "UTC", "2026-09-01", "2026-09-05")).filter((l) => l.endsWith("Short"))).toEqual([
      "2026-09-01 06:00 Short",
      "2026-09-02 06:00 Short",
      "2026-09-03 06:00 Short",
    ]);
  });

  test("MONTHLY: last Friday, and day 31 skipping short months", () => {
    const text = cal(
      ev("UID:m1", "DTSTART;VALUE=DATE:20260130", "RRULE:FREQ=MONTHLY;BYDAY=-1FR", "SUMMARY:Payday"),
      ev("UID:m2", "DTSTART;VALUE=DATE:20260131", "RRULE:FREQ=MONTHLY", "SUMMARY:Month end"),
    );
    const o = occ(text, "UTC", "2026-02-01", "2026-05-31");
    expect(brief(o.filter((x) => x.title === "Payday"))).toEqual(["2026-02-27 all-day Payday", "2026-03-27 all-day Payday", "2026-04-24 all-day Payday", "2026-05-29 all-day Payday"]);
    expect(brief(o.filter((x) => x.title === "Month end"))).toEqual(["2026-03-31 all-day Month end", "2026-05-31 all-day Month end"]);
  });

  test("YEARLY birthday and BYMONTH/BYDAY ordinal (second Sunday of May)", () => {
    const text = cal(
      ev("UID:y1", "DTSTART;VALUE=DATE:19900928", "RRULE:FREQ=YEARLY", "SUMMARY:Birthday"),
      ev("UID:y2", "DTSTART;VALUE=DATE:20200510", "RRULE:FREQ=YEARLY;BYMONTH=5;BYDAY=2SU", "SUMMARY:Mother's Day"),
    );
    expect(brief(occ(text, "UTC", "2026-09-28", "2026-09-28"))).toEqual(["2026-09-28 all-day Birthday"]);
    expect(brief(occ(text, "UTC", "2027-05-01", "2027-05-31"))).toEqual(["2027-05-09 all-day Mother's Day"]);
  });

  test("EXDATE removes one instance, RECURRENCE-ID moves one", () => {
    const text = cal(
      ev("UID:s", "DTSTART;TZID=Europe/Berlin:20260921T100000", "RRULE:FREQ=DAILY;COUNT=5", "EXDATE;TZID=Europe/Berlin:20260922T100000", "SUMMARY:Sync"),
      ev("UID:s", "RECURRENCE-ID;TZID=Europe/Berlin:20260923T100000", "DTSTART;TZID=Europe/Berlin:20260923T150000", "SUMMARY:Sync (moved)"),
    );
    expect(brief(occ(text, "Europe/Berlin", "2026-09-21", "2026-09-30"))).toEqual([
      "2026-09-21 10:00 Sync",
      "2026-09-23 15:00 Sync (moved)",
      "2026-09-24 10:00 Sync",
      "2026-09-25 10:00 Sync",
    ]);
  });

  test("unsupported rule parts: first occurrence only, flagged", () => {
    const text = cal(ev("UID:x", "DTSTART:20260901T090000Z", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "SUMMARY:Last workday"));
    const o = occ(text, "UTC", "2026-09-01", "2026-12-31");
    expect(o).toHaveLength(1);
    expect(o[0]).toMatchObject({ date: "2026-09-01", repeats_unexpanded: true });
  });
});

describe("fetching the user's links", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let dir = "";
  const ICS = cal(ev("UID:1", "DTSTART:20260928T080000Z", "SUMMARY:From the feed"));
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cal-ext-"));
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/ok.ics") return new Response(ICS, { headers: { "content-type": "text/calendar" } });
        if (p === "/big.ics") return new Response("BEGIN:VCALENDAR\r\n" + "X-PAD:" + "x".repeat(300_000) + "\r\nEND:VCALENDAR\r\n");
        if (p === "/slow.ics") {
          await Bun.sleep(1500);
          return new Response(ICS);
        }
        if (p === "/html") return new Response("<html>sign in</html>");
        return new Response("nope", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("link list: comma/space separated, webcal → https, plain http refused", () => {
    expect(parseIcsUrls("webcal://p1.example.com/a.ics, https://b.example.com/x?y=1&z=2  http://c.example.com/c.ics")).toEqual([
      { url: "https://p1.example.com/a.ics", index: 0 },
      { url: "https://b.example.com/x?y=1&z=2", index: 1 },
      { url: null, index: 2 },
    ]);
    expect(parseIcsUrls("")).toEqual([]);
    expect(parseIcsUrls("'https://a.example.com/x.ics#frag,https://b.example.com/y.ics'  # my calendars")).toEqual([
      { url: "https://a.example.com/x.ics#frag", index: 0 },
      { url: "https://b.example.com/y.ics", index: 1 },
    ]);
  });

  test("size cap and timeout hold", async () => {
    expect(await fetchIcsText(`${base}/ok.ics`)).toContain("From the feed");
    await expect(fetchIcsText(`${base}/big.ics`, { maxBytes: 100_000 })).rejects.toThrow("larger than");
    await expect(fetchIcsText(`${base}/slow.ics`, { timeoutMs: 300 })).rejects.toThrow("timed out");
    await expect(fetchIcsText(`${base}/missing`)).rejects.toThrow("HTTP 404");
  });

  test("sync writes the cache, keeps last good data on failure, never leaks the link", async () => {
    const cacheFile = join(dir, "calendar-external.json");
    const route = { target: "/ok.ics" };
    const fetchImpl = ((url: string, init: any) => fetch(`${base}${route.target}`, init)) as typeof fetch;
    const secret = "https://calendar.example.com/private-abc123secret/basic.ics";
    const now = Date.UTC(2026, 8, 28, 6, 0, 0);
    const first = await syncExternal({ urlsRaw: secret, cacheFile, tz: "Europe/Berlin", now, fetchImpl });
    expect(first.sources[0]).toMatchObject({ ok: true, name: "Work" });
    expect(first.sources[0].occurrences.map((o) => `${o.date} ${o.time} ${o.title}`)).toEqual(["2026-09-28 10:00 From the feed"]);

    route.target = "/html";
    const second = await syncExternal({ urlsRaw: secret, cacheFile, tz: "Europe/Berlin", now: now + 60_000, fetchImpl });
    expect(second.sources[0].ok).toBe(false);
    expect(second.sources[0].error).toBe("not an ICS calendar");
    expect(second.sources[0].occurrences).toHaveLength(1); // last good kept
    expect(second.sources[0].synced_at).toBe(first.sources[0].synced_at);

    const raw = await Bun.file(cacheFile).text();
    expect(raw).not.toContain("abc123secret");
    expect(readExternalCache(cacheFile)?.sources).toHaveLength(1);
  });
});
