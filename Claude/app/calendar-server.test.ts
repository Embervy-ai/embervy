import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callCalendarTool } from "../../shared/calendar/tool";

// The real server.ts, started as a throw-away process on a random port with
// its own data dir — never the service, never port 3030. Proves the auth
// gate: the feed passes with its token only, the agent's door needs the
// internal bearer, the browser's door still needs a login.

const FEED_TOKEN = "0123456789abcdef0123456789abcdef";
const INTERNAL = "internal-test-token-0123456789";
let PASSWORD = "";
let proc: ReturnType<typeof Bun.spawn>;
let base = "";
let dir = "";

import { startTestApp } from "./test-app-start";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cal-server-"));
  const app = await startTestApp({
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      INTERNAL_API_TOKEN: INTERNAL,
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "calendar-test-no-such-session",
      EMBERVY_HOOK_CALENDAR: "1",
      CALENDAR_FEED_TOKEN: FEED_TOKEN,
      EMBERVY_TIMEZONE: "Europe/Berlin",
      AGENT_LABEL: "Testagent",
      USER_LABEL: "Sam",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc, password: PASSWORD } = app);
}, 20_000);

afterAll(() => {
  proc?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
const agent = { "content-type": "application/json", authorization: `Bearer ${INTERNAL}` };
const tool = (args: Record<string, unknown>) => callCalendarTool(args, { baseUrl: base, headers: () => agent });
// Future dates keep these entries upcoming whenever the suite runs.
const ZONE = "Europe/Berlin";
const dayAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString("en-CA", { timeZone: ZONE });
const PARCEL_DAY = dayAhead(30), GIFT_DAY = dayAhead(31);
/** DTSTART of a local time on a day in ZONE, as the feed writes it (UTC). */
function utcStamp(day: string, hhmm: string): string {
  const [y, m, d] = day.split("-").map(Number), [h, min] = hhmm.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, min);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, timeZoneName: "shortOffset" }).formatToParts(new Date(guess)).find((p) => p.type === "timeZoneName")!.value;
  const [, sign, hh, mm] = /GMT([+-])?(\d+)?(?::(\d+))?/.exec(off)!;
  const minutes = (Number(hh ?? 0) * 60 + Number(mm ?? 0)) * (sign === "-" ? -1 : 1);
  return new Date(guess - minutes * 60_000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

describe("calendar through the real app server", () => {
  test("the agent's tool works over the internal door (bearer)", async () => {
    const add = await tool({ action: "add", title: "Pick up parcel", date: PARCEL_DAY, time: "17:00", note: "counter 3" });
    expect(add.content[0].text).toContain('"ok": true');
    await tool({ action: "add", title: "Gift shopping", date: GIFT_DAY, private: true });
    const list = JSON.parse((await tool({ action: "list" })).content[0].text);
    expect(list.timezone).toBe("Europe/Berlin");
    const titles = list.agent_calendar.map((e: any) => e.title);
    expect(titles).toEqual(expect.arrayContaining(["Pick up parcel", "Gift shopping"]));
  });

  test("internal door refuses without the bearer; browser door refuses without a login", async () => {
    expect((await fetch(`${base}/api/internal/calendar`)).status).toBe(401);
    expect((await fetch(`${base}/api/calendar`, { headers: viaTunnel })).status).toBe(401);
  });

  test("phone feed: token opens it through the tunnel, no token gets 404 — not the login page", async () => {
    const ok = await fetch(`${base}/calendar.ics?token=${FEED_TOKEN}`, { headers: viaTunnel });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/calendar");
    const body = await ok.text();
    expect(body).toContain("SUMMARY:Pick up parcel");
    expect(body).toContain(`DTSTART:${utcStamp(PARCEL_DAY, "17:00")}`);
    expect(body).not.toContain("Gift shopping");
    expect(body).not.toContain("counter 3");
    expect(body).toContain("X-WR-CALNAME:Testagent — calendar");

    for (const url of [`${base}/calendar.ics`, `${base}/calendar.ics?token=wrong-token-wrong-token-wrong`]) {
      const r = await fetch(url, { headers: viaTunnel });
      expect(r.status).toBe(404);
      expect(await r.text()).not.toContain("<html");
    }
  });

  test("logged-in person can fetch their subscription link", async () => {
    const login = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { ...viaTunnel, "content-type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    const info = await (await fetch(`${base}/api/calendar/feed`, { headers: { ...viaTunnel, cookie, host: "home.example.com" } })).json();
    expect(info.enabled).toBe(true);
    expect(info.url).toBe(`https://home.example.com/calendar.ics?token=${FEED_TOKEN}`);
  });
});
