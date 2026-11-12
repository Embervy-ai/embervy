import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeDayLines, dueForSession, runDayLine } from "./day-line";
import { contextLine, foreignContext } from "../scripts/context-text";
import type { CalendarEntry } from "./store";

const SHARED = join(import.meta.dir, "..");
const REPO = join(SHARED, "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const e = (p: Partial<CalendarEntry>): CalendarEntry => ({ id: crypto.randomUUID(), title: "x", date: "2026-09-28", time: null, note: null, created: "", ...p });

describe("composeDayLines", () => {
  test("agent line: all-day first, then by time, ranges shown", () => {
    const lines = composeDayLines({
      today: "2026-09-28",
      tz: "Europe/Berlin",
      agentEntries: [e({ title: "Call back", time: "17:00", end: "18:00" }), e({ title: "Dentist", time: "09:00" }), e({ title: "Holiday" }), e({ title: "Tomorrow", date: "2026-09-29" })],
      personConfigured: false,
      personCache: null,
      userLabel: "",
    });
    expect(lines).toEqual(["📅 Your calendar today (Monday 2026-09-28): all day Holiday · 09:00 Dentist · 17:00–18:00 Call back"]);
  });

  test("empty day and the user's line, marked read-only with sync time", () => {
    const lines = composeDayLines({
      today: "2026-09-28",
      tz: "Europe/Berlin",
      agentEntries: [],
      personConfigured: true,
      personCache: {
        version: 1, checked_at: "2026-09-28T12:05:00.000Z", tz: "Europe/Berlin", from: "2026-09-27", to: "2026-10-28",
        sources: [{ index: 0, name: "Home", ok: true, synced_at: "2026-09-28T12:05:00.000Z", occurrences: [
          { title: "Standup", date: "2026-09-28", time: "08:30", end: "09:30", calendar: "Home" },
          { title: "School trip", date: "2026-09-28", time: null, end: null, calendar: "Home" },
          { title: "Not today", date: "2026-09-29", time: "08:30", end: null, calendar: "Home" },
        ] }],
      },
      userLabel: "Sam",
    });
    expect(lines).toEqual([
      "📅 Your calendar today (Monday 2026-09-28): nothing entered",
      foreignContext("calendar", "📅 Sam's calendar today (read-only, synced 14:05): all day School trip · 08:30–09:30 Standup"),
    ]);
  });

  test("person configured but never synced", () => {
    const lines = composeDayLines({ today: "2026-09-28", tz: "UTC", agentEntries: [], personConfigured: true, personCache: null, userLabel: "" });
    expect(lines[1]).toBe(foreignContext("calendar", "📅 Your user's calendar today (read-only): not synced yet"));
  });
});

describe("once per session start and per day change", () => {
  test("dueForSession", () => {
    let s = dueForSession(null, "A", "2026-09-28");
    expect(s.due).toBe(true);
    s = dueForSession(s.next, "A", "2026-09-28");
    expect(s.due).toBe(false);
    s = dueForSession(s.next, "B", "2026-09-28");
    expect(s.due).toBe(true);
    s = dueForSession(s.next, "A", "2026-09-29");
    expect(s.due).toBe(true);
    let st = s.next;
    for (let i = 0; i < 20; i++) st = dueForSession(st, `S${i}`, "2026-09-29").next;
    expect(Object.keys(st.sessions)).toHaveLength(10);
  });

  test("runDayLine: off → silent; on → first call prints, repeat is silent, next day prints again", () => {
    const home = tmp("cal-home-");
    const data = join(home, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "calendar.json"), JSON.stringify([e({ title: "Dentist", date: "2026-09-28", time: "09:00" }), e({ title: "Bins", date: "2026-09-29" })]));
    const env = { EMBERVY_HOME: home, EMBERVY_TIMEZONE: "Europe/Berlin", EMBERVY_HOOK_CALENDAR: "1" };
    const mon = Date.UTC(2026, 8, 28, 5, 0, 0);
    const tue = Date.UTC(2026, 8, 28, 22, 30, 0); // 00:30 Tuesday in Berlin
    expect(runDayLine(["s1", "--data-dir", data], { ...env, EMBERVY_HOOK_CALENDAR: "0" }, mon)).toBe("");
    expect(runDayLine(["s1", "--data-dir", data], env, mon)).toBe("📅 Your calendar today (Monday 2026-09-28): 09:00 Dentist");
    expect(runDayLine(["s1", "--data-dir", data], env, mon + 3600_000)).toBe("");
    expect(runDayLine(["s1", "--data-dir", data], env, tue)).toBe("📅 Your calendar today (Tuesday 2026-09-29): all day Bins");
    expect(runDayLine(["s2", "--data-dir", data], env, tue)).toContain("Bins");
  });
});

// ---------------------------------------------------------------- the real inlet

function inletHome(hook: "0" | "1"): { home: string; script: string } {
  const home = tmp("cal-inlet-Claude-");
  mkdirSync(join(home, "Claude", "scripts"), { recursive: true });
  mkdirSync(join(home, "Claude", "app", "data"), { recursive: true });
  // A silent stand-in for the memory worker: this test is about the clock
  // block, not about memory retrieval.
  writeFileSync(join(home, "Claude", "scripts", "inlet-worker.ts"), "");
  symlinkSync(SHARED, join(home, "shared"));
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());
  writeFileSync(join(home, "Claude", "app", "data", "calendar.json"), JSON.stringify([e({ title: "Inlet check", date: today, time: "23:59" })]));
  writeFileSync(join(home, ".env"), `EMBERVY_HOOK_CALENDAR=${hook}\nEMBERVY_TIMEZONE=Europe/Berlin\nEMBERVY_TIME_LABEL=Testville\n`);
  return { home, script: join(REPO, "Claude", "scripts", "inlet.sh") };
}

async function turn(script: string, home: string, session: string): Promise<string> {
  const proc = Bun.spawn(["bash", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", EMBERVY_HOME: home },
    stdin: new TextEncoder().encode(JSON.stringify({ prompt: "hello", session_id: session })),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  const j = JSON.parse(out);
  return j.hookSpecificOutput?.additionalContext ?? "";
}

describe("Claude inlet.sh", () => {
  test("calendar line at session start, not on the next turn, again for a new session — clock rides along", async () => {
    const { home, script } = inletHome("1");
    const t1 = await turn(script, home, "sess-a");
    expect(t1).toContain("⏰ Testville:");
    expect(t1).toContain("📅 Your calendar today (");
    expect(t1).toContain("23:59 Inlet check");
    expect(await turn(script, home, "sess-a")).toBe(""); // turn 2: no clock, no calendar
    const t3 = await turn(script, home, "sess-b"); // turn 3 — not a clock turn by itself
    expect(t3).toContain("⏰ Testville:");
    expect(t3).toContain("Inlet check");
    expect(await turn(script, home, "sess-b")).toBe("");
  }, 30_000);

  test("switch off: clock as before, no calendar", async () => {
    const { home, script } = inletHome("0");
    const t1 = await turn(script, home, "sess-a");
    expect(t1).toContain("⏰ Testville:");
    expect(t1).not.toContain("📅");
  }, 30_000);
});
