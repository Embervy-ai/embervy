import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
