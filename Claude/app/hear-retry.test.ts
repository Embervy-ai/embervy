import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(`${import.meta.dir}/server.ts`, "utf8");
const section = source.slice(source.indexOf("async function hearVoice("), source.indexOf("const VOICE_MAX_BYTES"));
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(section);
const unavailable = "[Voice message, not heard: ask the person to repeat it or to write it.]";
function harness(answers: Array<number | Error | Response>, delay = 0) {
  let now = 0;
  const calls: any[] = [], pauses: number[] = [], timeouts: number[] = [];
  const fetch = async (_url: string, init: any) => {
    calls.push(JSON.parse(init.body));
    const timeout = timeouts[timeouts.length - 1];
    if (delay >= timeout) {
      now += timeout;
      throw Object.assign(new Error("deadline expired"), { name: "TimeoutError" });
    }
    now += delay;
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    if (answer instanceof Response) return answer;
    return answer === 200 ? Response.json({ text: "words", woven: "heard words" }) : new Response("unavailable", { status: answer });
  };
  const hear = new Function("fetch", "Date", "AbortSignal", "setTimeout", "S", "console", `
    const HEAR_URL = 'http://hearing.invalid', HEAR_PROMPT = '', HEAR_WAIT_MAX = 600, HEAR_WAIT_BASE = 30, HEAR_WAIT_PER_SECOND = 2.5;
    const positiveDuration = n => Number.isFinite(n) && n > 0;
    const recordingDuration = async () => 0;
    ${js}
    return hearVoice;
  `)(fetch, { now: () => now }, { timeout: (ms: number) => { timeouts.push(ms); return {}; } },
    (fn: Function, ms: number) => { pauses.push(ms); now += ms; fn(); }, () => unavailable, { log() {}, warn() {} });
  return { hear, calls, pauses, timeouts, elapsed: () => now };
}

for (const status of [502, 503, 504]) test(`HTTP ${status} is retried before forwarding heard words`, async () => {
  const h = harness([status, 200]);
  expect(await h.hear("recording.ogg", true, 4)).toBe("[Voice message, heard]\nheard words");
  expect(h.calls).toHaveLength(2);
  expect(h.pauses).toEqual([250]);
  expect(h.calls[1].deadline_s).toBeLessThan(h.calls[0].deadline_s);
  expect(h.timeouts[1]).toBeLessThan(h.timeouts[0]);
});
for (const nested of [false, true]) test(`a ${nested ? "nested" : "direct"} refused connection is retried`, async () => {
  const error = Object.assign(new TypeError("fetch failed"), nested ? { cause: { code: "ECONNREFUSED" } } : { code: "ConnectionRefused" });
  const h = harness([error, 200]);
  expect(await h.hear("recording.ogg", true, 4)).toContain("heard words");
  expect(h.calls).toHaveLength(2);
});
for (const answer of [503, Object.assign(new Error("refused"), { code: "ECONNREFUSED" })]) test(`exhausted ${typeof answer === "number" ? "HTTP" : "connection"} retries explicitly report unheard audio`, async () => {
  const h = harness([answer]);
  expect(await h.hear("recording.ogg", true, 4)).toBe(unavailable);
  expect(h.calls).toHaveLength(3);
  expect(h.pauses).toEqual([250, 500]);
});
test("the deadline includes pauses and does not restart for each attempt", async () => {
  const h = harness([503], 22400);
  expect(await h.hear("recording.ogg", true, 4)).toBe(unavailable);
  expect(h.calls).toHaveLength(2);
  expect(h.elapsed()).toBe(45000);
  expect(h.timeouts).toEqual([45000, 22350]);
});
test("an elapsed deadline starts no further request", async () => {
  const h = harness([504], 45000);
  expect(await h.hear("recording.ogg", true, 4)).toBe(unavailable);
  expect(h.calls).toHaveLength(1);
  expect(h.pauses).toEqual([]);
});
for (const status of [400, 401, 404, 429, 500]) test(`HTTP ${status} keeps the existing empty fallback without retries`, async () => {
  const h = harness([status]);
  expect(await h.hear("recording.ogg", true, 4)).toBe("");
  expect(h.calls).toHaveLength(1);
  expect(h.pauses).toEqual([]);
});
test("dictation never receives the unheard-audio notice as transcript", async () => {
  const h = harness([503]);
  expect(await h.hear("recording.ogg", false, 4)).toBe("");
  expect(h.calls).toHaveLength(3);
});
test("a failed response body after retry is not mistaken for empty audio", async () => {
  const h = harness([503, new Response(new ReadableStream({ start(controller) { controller.error(new Error("body interrupted")); } }))]);
  expect(await h.hear("recording.ogg", true, 4)).toBe(unavailable);
  expect(h.calls).toHaveLength(2);
});
test("a successful response without words keeps the empty-audio fallback", async () => {
  const h = harness([Response.json({ text: "", woven: "tone only" })]);
  expect(await h.hear("recording.ogg", true, 4)).toBe("");
  expect(h.calls).toHaveLength(1);
});
test("unheard voice storage says so, and still passes on the device transcript when there is one", async () => {
  const body = source.slice(source.indexOf("async function storeAndHearVoice("), source.indexOf('// Public: no login', source.indexOf("async function storeAndHearVoice(")));
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(body);
  const rows: any[] = [];
  const h = harness([503]);
  const strings = JSON.parse(readFileSync(`${import.meta.dir}/strings/en.json`, "utf8"));
  const store = new Function("hearVoice", "appendFileSync", "Bun", "S", `
    const generateId = () => 'voice-id', IMAGES_DIR = 'images', INBOX = 'inbox';
    const join = (...parts) => parts.join('/'), writeFileSync = () => {}, existsSync = () => false;
    ${code}; return storeAndHearVoice;
  `)(h.hear, (_path: string, row: string) => rows.push(JSON.parse(row)), { spawn: () => ({ exited: Promise.resolve(0) }) }, (key: string) => strings[key]);
  const form = new FormData();
  form.set("duration", "4");
  await store(new File(["audio"], "voice.ogg", { type: "audio/ogg" }), "browser guess", form, "recording-id");
  await store(new File(["audio"], "voice.ogg", { type: "audio/ogg" }), "", form, "recording-id");
  expect(rows).toHaveLength(2);
  expect(rows[0].text).toBe("[Voice message, not heard; the device transcribed it as follows]\nbrowser guess");
  expect(rows[1].text).toBe(unavailable);
});
