import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderBrainConversation, renderClaudeSession } from "./terminal-log";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const source = read("public/i18n.js");
function clock(language: string, timeZone?: string) {
  const window: any = { EMBERVY_STRINGS: { language }, embervyHouseTimeZone: timeZone };
  new Function("window", "module", source)(window, undefined);
  return window.embervyI18n;
}
const app = read("public/app.js");
const chatSource = app.slice(app.indexOf("  function formatTime(ts)"), app.indexOf("  function atBottom("));
const chatClock = (api: any) => new Function("I18N", `${chatSource}; return formatTime;`)(api);

test("chat and both terminal logs show the exact same minute, including midnight and DST", () => {
  for (const timeZone of ["UTC", "Europe/Berlin", "Pacific/Auckland", "America/New_York"]) {
    for (const ts of ["2026-11-19T00:05:00Z", "2026-11-19T13:47:20Z", "2026-03-29T01:30:00Z"]) {
      const expected = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(new Date(ts));
      const options = { names: { self: "Wren", user: "Sam" }, timeZone };
      const brain = renderBrainConversation([JSON.stringify({ ts, role: "user", content: "Hello" })], options);
      const claude = renderClaudeSession([JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content: "Hello" } })], options);
      const lines = (entries: any[]) => entries.filter(e => e.kind === "line").map(e => e.text.replace(/\x1b\[[0-9;]*m/g, ""));
      expect(lines(brain)).toContain(`── Sam · ${expected} ──`);
      expect(lines(claude)).toContain(`── Sam · ${expected} ──`);
      for (const language of ["en", "de", "fr", "es", "ja", "ar", "fa", "hi", "zh", "ko", "pt", "en-US"]) {
        const api = clock(language, timeZone);
        expect(chatClock(api)(ts)).toBe(expected);
        expect(api.formatTime(ts)).toMatch(/^\d{2}:\d{2}$/);
        expect(api.formatTime(ts)).not.toMatch(/AM|PM/i);
        expect(api.formatDateTime(ts)).toBe(new Date(ts).toLocaleDateString(language, { dateStyle: "medium", timeZone }) + ", " + expected);
      }
    }
  }
});

test("invalid or missing house zone falls back to the device; invalid dates stay empty", () => {
  const ts = "2026-11-19T00:05:00Z";
  const expected = new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const zone of [undefined, "", "Invalid/Zone"]) {
    const api = clock("en", zone);
    expect(api.formatTime(ts)).toBe(expected);
    expect(api.formatDateTime(ts)).toBe(new Date(ts).toLocaleDateString("en", { dateStyle: "medium" }) + ", " + expected);
    expect(api.formatTime("bad")).toBe("");
  }
});

test("doctor and Kept use the same clock rather than local timeStyle formatting", () => {
  expect(app).toContain('I18N.formatTime(c.muted_until)');
  expect(app).toContain('I18N.formatDateTime(entry.said_at)');
  expect(app).not.toContain('timeStyle: "short"');
  const api = clock("en", "Pacific/Auckland");
  const ts = "2026-11-19T12:05:00Z";
  expect(api.formatDateTime(ts)).toBe("Nov 20, 2026, 01:05");
  expect(chatClock(api)(ts)).toBe("01:05");
});

test("house script precedes the clock and appearance scripts on both pages", () => {
  for (const page of ["public/index.html", "public/settings.html"]) {
    const html = read(page);
    expect(html.indexOf('/feature-defaults.js')).toBeLessThan(html.indexOf('/i18n.js'));
    expect(html.indexOf('/house-look.js')).toBeLessThan(html.search(/src="\/(app|settings)\.js/));
  }
  const worker = read("public/sw.js");
  const cacheList = worker.split("const CACHE_URLS = ")[1].split(";")[0];
  expect(cacheList).not.toContain("/api/"); expect(cacheList).not.toContain("feature-defaults");
  expect(worker).toContain('!CACHE_URLS.includes(url.pathname + url.search)');
});
