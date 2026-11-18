import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readEntries, validateNewEntries, writeEntries } from "./store";
import { addDays } from "./time";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarConfigFromEnv, createCalendarHandlers, feedTokenOk, registerCalendarRoutes, type CalendarConfig } from "./routes";
import { callCalendarTool, calendarToolDefinition } from "./tool";
import { envGet, envSet, generateFeedToken } from "./feed-token";
import { syncExternal, readExternalCache } from "./external";
import { startExternalPoller } from "./routes";

test("removed calendar sources stay removed on failures, reorder and disable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-removal-"));
  const cacheFile = join(dir, "calendar-external.json");
  const secret = "https://example.test/private-token";
  const now = Date.UTC(2026, 8, 28);
  const opts = { cacheFile, tz: "UTC", now };
  const good = (async () => new Response("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART:20260928T120000Z\r\nSUMMARY:Private event\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")) as typeof fetch;
  const bad = (async () => { throw new Error("offline"); }) as typeof fetch;
  try {
    await syncExternal({ ...opts, urlsRaw: secret, fetchImpl: good });
    const moved = await syncExternal({ ...opts, urlsRaw: `https://other.test/feed,${secret}`, fetchImpl: bad });
    expect(moved.sources[0].occurrences).toEqual([]);
    expect(moved.sources[1].occurrences).toHaveLength(1);
    const replaced = await syncExternal({ ...opts, urlsRaw: "https://other.test/feed", fetchImpl: bad });
    expect(replaced.sources[0].occurrences).toEqual([]);
    expect(JSON.stringify(readExternalCache(cacheFile))).not.toContain("Private event");
    await syncExternal({ ...opts, urlsRaw: secret, fetchImpl: good });
    const stop = startExternalPoller(cfgFor(dir, { EMBERVY_HOOK_CALENDAR: "0" }));
    stop();
    expect(readExternalCache(cacheFile)?.sources).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const TOKEN = "f".repeat(20) + "0123456789abcdef";

function cfgFor(dataDir: string, over: Record<string, string> = {}): CalendarConfig {
  return calendarConfigFromEnv(
    { EMBERVY_HOOK_CALENDAR: "1", CALENDAR_FEED_TOKEN: TOKEN, EMBERVY_TIMEZONE: "Europe/Berlin", EMBERVY_APP_URL: "https://home.example.com/", ...over },
    { dataDir, agentLabel: "Agent", userLabel: "Sam" },
  );
}

/** Throw-away server: a tiny router in front of the shared handlers. */
function serve(cfg: CalendarConfig) {
  const h = createCalendarHandlers(cfg, () => Date.UTC(2026, 8, 28, 10, 0, 0));
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/calendar.ics") return h.feed(req);
      if (p === "/api/internal/calendar" && req.method === "GET") return h.list(req);
      if (p === "/api/internal/calendar" && req.method === "POST") return h.add(req);
      if (p === "/api/internal/calendar/delete") return h.remove(req);
      if (p === "/api/internal/calendar/feed") return h.feedInfo(req);
      return new Response("no route", { status: 404 });
    },
  });
}

describe("feed token check", () => {
  test("module off, missing, short or wrong token → refused", () => {
    const dir = "/nonexistent";
    expect(feedTokenOk(cfgFor(dir), TOKEN)).toBe(true);
    expect(feedTokenOk(cfgFor(dir), TOKEN.slice(0, -1) + "x")).toBe(false);
    expect(feedTokenOk(cfgFor(dir), "")).toBe(false);
    expect(feedTokenOk(cfgFor(dir), null)).toBe(false);
    expect(feedTokenOk(cfgFor(dir, { EMBERVY_HOOK_CALENDAR: "0" }), TOKEN)).toBe(false);
    expect(feedTokenOk(cfgFor(dir, { CALENDAR_FEED_TOKEN: "short" }), "short")).toBe(false);
    expect(feedTokenOk(cfgFor(dir, { CALENDAR_FEED_TOKEN: "" }), "")).toBe(false);
  });
});

describe("calendar API through a throw-away server", () => {
  let dir = "";
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  const headers = () => ({ "content-type": "application/json" });
  const tool = (args: Record<string, unknown>) => callCalendarTool(args, { baseUrl: base, headers });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "cal-routes-"));
    server = serve(cfgFor(dir, { CALENDAR_ICS_URLS: "https://calendar.example.com/x.ics" }));
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("add validates input", async () => {
    expect((await tool({ action: "add", title: "x", date: "2026-02-30" })).content[0].text).toContain("date must be YYYY-MM-DD");
    expect((await tool({ action: "add", title: "x", date: "2026-10-01", time: "9:00" })).content[0].text).toContain("time must be HH:MM");
    expect((await tool({ action: "add", title: "x", date: "2026-10-01", time: "10:00", end: "09:00" })).content[0].text).toContain("end must be after");
    expect((await tool({ action: "add", date: "2026-10-01" })).content[0].text).toContain("title and date required");
  });

  test("feed shows public entries (title + time), never private ones or notes", async () => {
    await tool({ action: "add", title: "Parents' evening", date: "2026-09-30", time: "18:00", note: "bring the letter" });
    await tool({ action: "add", title: "Surprise planning", date: "2026-10-02", time: "20:00", private: true });
    await tool({ action: "add", title: "Recycling day", date: "2026-10-01" });

    expect((await fetch(`${base}/calendar.ics`)).status).toBe(404);
    expect((await fetch(`${base}/calendar.ics?token=wrong`)).status).toBe(404);
    const res = await fetch(`${base}/calendar.ics?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain("SUMMARY:Parents' evening");
    expect(body).toContain("DTSTART:20260930T160000Z");
    expect(body).toContain("DTSTART;VALUE=DATE:20261001");
    expect(body).not.toContain("Surprise planning");
    expect(body).not.toContain("bring the letter");
    expect(body).toContain("X-WR-CALNAME:Agent — calendar");
  });

  test("list shows the agent's entries (private included) and the user's section, marked read-only", async () => {
    writeFileSync(
      join(dir, "calendar-external.json"),
      JSON.stringify({
        version: 1, checked_at: "2026-09-28T09:00:00.000Z", tz: "Europe/Berlin", from: "2026-09-27", to: "2026-10-28",
        sources: [{ index: 0, name: "Work", ok: true, synced_at: "2026-09-28T09:00:00.000Z", occurrences: [{ title: "Standup", date: "2026-09-28", time: "09:30", end: "09:45", calendar: "Work" }] }],
      }),
    );
    const data = JSON.parse((await tool({ action: "list" })).content[0].text);
    expect(data.today).toBe("2026-09-28");
    expect(data.agent_calendar.map((e: any) => e.title)).toEqual(["Parents' evening", "Recycling day", "Surprise planning"]);
    expect(data.person_calendar.about).toContain("Read-only: Sam's own calendar");
    expect(data.person_calendar.entries).toEqual([{ title: "Standup", date: "2026-09-28", time: "09:30", end: "09:45", calendar: "Work" }]);
    expect(JSON.stringify(data)).not.toContain("calendar.example.com");
  });

  test("remove: unknown id is an error, known id goes", async () => {
    expect((await tool({ action: "remove", id: "nope" })).content[0].text).toContain("HTTP 404");
    const data = JSON.parse((await tool({ action: "list" })).content[0].text);
    const id = data.agent_calendar.find((e: any) => e.title === "Recycling day").id;
    expect(JSON.parse((await tool({ action: "remove", id })).content[0].text)).toEqual({ ok: true, removed: 1 });
    expect((await (await fetch(`${base}/calendar.ics?token=${TOKEN}`)).text())).not.toContain("Recycling day");
  });

  test("feed action returns the subscription link built from EMBERVY_APP_URL", async () => {
    const info = JSON.parse((await tool({ action: "feed" })).content[0].text);
    expect(info.url).toBe(`https://home.example.com/calendar.ics?token=${TOKEN}`);
  });

  test("module off: feed is 404 even with the right token, feed info says off", async () => {
    const off = serve(cfgFor(dir, { EMBERVY_HOOK_CALENDAR: "0" }));
    try {
      expect((await fetch(`http://127.0.0.1:${off.port}/calendar.ics?token=${TOKEN}`)).status).toBe(404);
      const info = await (await fetch(`http://127.0.0.1:${off.port}/api/internal/calendar/feed`)).json();
      expect(info.enabled).toBe(false);
    } finally {
      off.stop(true);
    }
  });
});

const seriesRequest = {
  title: "Practice", date: "2026-09-28", time: "17:30", repeat_weekdays: ["mo", "th"], repeat_until: "2026-11-08",
};
const request = (body: unknown) => new Request("http://localhost/api/internal/calendar", { method: "POST", body: JSON.stringify(body) });

async function withCalendar(check: (h: ReturnType<typeof createCalendarHandlers>, file: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "cal-series-"));
  const file = join(dir, "calendar.json");
  writeEntries(file, validateNewEntries({ title: "Unrelated", date: "2026-09-28" }).entries!);
  try { await check(createCalendarHandlers(cfgFor(dir), () => Date.UTC(2026, 8, 28, 10)), file); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

describe("series routes", () => {
  test("the shared tool forwards series fields through HTTP for add and removal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cal-series-tool-"));
    const server = serve(cfgFor(dir));
    const call = async (args: Record<string, unknown>) => (await callCalendarTool(args, {
      baseUrl: `http://127.0.0.1:${server.port}`, headers: () => ({ "content-type": "application/json" }),
    })).content[0].text;
    try {
      const added = JSON.parse(await call({ action: "add", ...seriesRequest, except_dates: ["2026-10-01", "2026-10-19"] }));
      expect(added.entries.map((entry: any) => entry.date)).toEqual([
        "2026-09-28", "2026-10-05", "2026-10-08", "2026-10-12", "2026-10-15",
        "2026-10-22", "2026-10-26", "2026-10-29", "2026-11-02", "2026-11-05",
      ]);
      expect(JSON.parse(await call({ action: "list" })).agent_calendar).toEqual(added.entries);
      expect(JSON.parse(await call({ action: "remove", series: added.series, from: "2026-10-15" }))).toEqual({ ok: true, removed: 6 });
      expect(JSON.parse(await call({ action: "list" })).agent_calendar).toEqual(added.entries.slice(0, 4));
      expect(JSON.parse(await call({ action: "remove", series: added.series }))).toEqual({ ok: true, removed: 4 });
      expect(JSON.parse(await call({ action: "list" })).agent_calendar).toEqual([]);
    } finally { server.stop(true); rmSync(dir, { recursive: true, force: true }); }
  });

  const daily = ["mo", "tu", "we", "th", "fr", "sa", "su"];
  const invalid: [string, Record<string, unknown>, string][] = [
    ["span", { repeat_until: addDays(seriesRequest.date, 366) }, "series span must not exceed 366 calendar days"],
    ["entry count", { repeat_weekdays: daily, repeat_until: addDays(seriesRequest.date, 200) }, "series must not exceed 200 entries"],
    ["empty weekdays", { repeat_weekdays: [] }, "repeat_weekdays needs at least one valid weekday"],
    ["unknown weekdays", { repeat_weekdays: ["noday", 3] }, "repeat_weekdays needs at least one valid weekday"],
    ["weekday list type", { repeat_weekdays: "mo" }, "repeat_weekdays needs at least one valid weekday"],
    ["missing end", { repeat_until: undefined }, "repeat_until required: YYYY-MM-DD"],
    ["invalid end", { repeat_until: "2026-02-30" }, "repeat_until required: YYYY-MM-DD"],
    ["end before start", { repeat_until: "2026-09-27" }, "repeat_until must not be before date"],
    ["invalid exception", { except_dates: ["2026-02-30"] }, "except_dates must be a list of valid YYYY-MM-DD dates"],
    ["invalid exception format", { except_dates: ["2026-9-28"] }, "except_dates must be a list of valid YYYY-MM-DD dates"],
    ["exception type", { except_dates: [null] }, "except_dates must be a list of valid YYYY-MM-DD dates"],
    ["exception list type", { except_dates: "2026-09-28" }, "except_dates must be a list of valid YYYY-MM-DD dates"],
    ["null exception list", { except_dates: null }, "except_dates must be a list of valid YYYY-MM-DD dates"],
    ["all excluded", { repeat_until: seriesRequest.date, except_dates: [seriesRequest.date] }, "series has no entries after weekday selection and exceptions"],
    ["no matching weekday", { repeat_until: seriesRequest.date, repeat_weekdays: ["tu"] }, "series has no entries after weekday selection and exceptions"],
    ["end without weekdays", { repeat_weekdays: undefined }, "repeat_until and except_dates need repeat_weekdays"],
  ];
  for (const [name, changes, message] of invalid) {
    test(`${name} rejects the whole request without writing`, () => withCalendar(async (h, file) => {
      const before = fs.readFileSync(file, "utf8");
      const writer = spyOn(fs, "writeFileSync");
      try {
        const response = await h.add(request({ ...seriesRequest, ...changes }));
        expect(response.status).toBe(400);
        expect((await response.json()).error).toContain(message);
        expect(writer).not.toHaveBeenCalled();
        expect(fs.readFileSync(file, "utf8")).toBe(before);
      } finally { writer.mockRestore(); }
    }));
  }

  test("a series commits once and list includes both entry and series identifiers", () => withCalendar(async (h, file) => {
    const writer = spyOn(fs, "writeFileSync");
    const rename = spyOn(fs, "renameSync");
    let added: any;
    try {
      const response = await h.add(request(seriesRequest));
      expect(response.status).toBe(200);
      added = await response.json();
      expect(writer).toHaveBeenCalledTimes(1);
      expect(rename).toHaveBeenCalledTimes(1);
    } finally { writer.mockRestore(); rename.mockRestore(); }
    const list = await (await h.list(new Request("http://localhost/api/internal/calendar"))).json();
    expect(list.agent_calendar.filter((entry: any) => entry.series === added.series)).toEqual(added.entries);
    expect(added.entries).toHaveLength(12);
    expect(added.entries.every((entry: any) => typeof entry.id === "string" && entry.series === added.series)).toBe(true);
    expect(readEntries(file)).toHaveLength(13);
  }));

  for (const stage of ["write", "rename"] as const) {
    test(`a failed ${stage} leaves the original file intact and no staged data`, () => withCalendar(async (h, file) => {
      const before = fs.readFileSync(file, "utf8");
      const originalWrite = fs.writeFileSync;
      const fail = stage === "write"
        ? spyOn(fs, "writeFileSync").mockImplementation((path: any) => {
          originalWrite(path, "[{\"partial\":", { mode: 0o600 });
          throw new Error("injected write failure");
        })
        : spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("injected rename failure"); });
      try {
        await expect(h.add(request(seriesRequest))).rejects.toThrow(`injected ${stage} failure`);
        expect(fail).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(file, "utf8")).toBe(before);
        expect(fs.readdirSync(join(file, ".."))).toEqual(["calendar.json"]);
      } finally { fail.mockRestore(); }
    }));
  }

  test("removal by series, inclusive cutoff and individual id leaves other entries intact", () => withCalendar(async (h, file) => {
    const first = await (await h.add(request(seriesRequest))).json();
    const second = await (await h.add(request({ ...seriesRequest, title: "Other series" }))).json();
    expect(first.series).not.toBe(second.series);
    const unrelated = readEntries(file).filter((entry) => entry.series !== first.series);
    const one = first.entries[0];
    expect(await (await h.remove(request({ id: one.id }))).json()).toEqual({ ok: true, removed: 1 });
    expect(readEntries(file).filter((entry) => entry.series === first.series)).toHaveLength(11);
    const cutoff = "2026-10-15";
    const later = first.entries.filter((entry: any) => entry.date >= cutoff);
    expect(await (await h.remove(request({ series: first.series, from: cutoff }))).json()).toEqual({ ok: true, removed: later.length });
    const remaining = first.entries.filter((entry: any) => entry.id !== one.id && entry.date < cutoff);
    expect(readEntries(file).filter((entry) => entry.series === first.series)).toEqual(remaining);
    expect(await (await h.remove(request({ series: first.series }))).json()).toEqual({ ok: true, removed: remaining.length });
    expect(readEntries(file)).toEqual(unrelated);
  }));

  test("unknown series, invalid selectors and a cutoff beyond the series change no bytes", () => withCalendar(async (h, file) => {
    const added = await (await h.add(request(seriesRequest))).json();
    const before = fs.readFileSync(file, "utf8");
    const unknown = await h.remove(request({ series: "unknown" }));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("no series with that id in your calendar");
    for (const args of [
      { id: added.entries[0].id, series: added.series }, { series: added.series, from: "2026-02-30" },
      { series: added.series, from: null }, { id: added.entries[0].id, from: "2026-10-01" }, {},
    ]) expect((await h.remove(request(args))).status).toBe(400);
    expect(await (await h.remove(request({ series: added.series, from: "2027-01-01" }))).json()).toEqual({ ok: true, removed: 0 });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  }));
});

describe("wiring helpers", () => {
  test("registerCalendarRoutes registers both doors and the feed", () => {
    const seen: string[] = [];
    registerCalendarRoutes({ get: (p) => seen.push(`GET ${p}`), post: (p) => seen.push(`POST ${p}`) }, cfgFor("/tmp/x"));
    expect(seen).toEqual(expect.arrayContaining([
      "GET /api/calendar", "POST /api/calendar", "POST /api/calendar/delete", "GET /api/calendar/feed",
      "GET /api/internal/calendar", "POST /api/internal/calendar", "POST /api/internal/calendar/delete", "GET /api/internal/calendar/feed",
      "GET /calendar.ics",
    ]));
  });

  test("inline .env comments (passed through by systemd) do not break the switch, zone or links", () => {
    const c = calendarConfigFromEnv(
      {
        EMBERVY_HOOK_CALENDAR: "1       # calendar: today's entries …",
        EMBERVY_TIMEZONE: "Europe/Lisbon          # IANA timezone",
        CALENDAR_FEED_TOKEN: `${TOKEN}   # secret`,
        CALENDAR_ICS_POLL_MINUTES: "30 # minutes",
      },
      { dataDir: "/tmp/x", agentLabel: "A", userLabel: "U" },
    );
    expect([c.enabled, c.tz, c.feedToken, c.pollMinutes]).toEqual([true, "Europe/Lisbon", TOKEN, 30]);
  });

  test("tool definition carries the private flag and the feed action", () => {
    const d = calendarToolDefinition("Sam");
    expect(d.inputSchema.properties.action.enum).toEqual(["add", "list", "remove", "feed"]);
    expect(d.inputSchema.properties.private.type).toBe("boolean");
  });

  test("feed-token helpers: set replaces every copy, get strips quotes, tokens are fresh", () => {
    const text = "A=1\nCALENDAR_FEED_TOKEN=old\nB='x y'\nCALENDAR_FEED_TOKEN=older\n";
    const next = envSet(text, "CALENDAR_FEED_TOKEN", "new");
    expect(next).toBe("A=1\nCALENDAR_FEED_TOKEN=new\nB='x y'\n");
    expect(envGet(next, "B")).toBe("x y");
    expect(envSet("A=1\n", "K", "v")).toBe("A=1\nK=v\n");
    const t1 = generateFeedToken(), t2 = generateFeedToken();
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(t1).not.toBe(t2);
  });
});
