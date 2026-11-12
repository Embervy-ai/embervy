import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ReturnType<typeof Bun.spawn>;
let base = "", dir = "", dataDir = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "message-replay-"));
  dataDir = join(dir, "data");
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === 3030) throw new Error("refusing to use the app port");
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      TMUX_TMPDIR: dir,
      EMBERVY_HOME: dir,
      EMBERVY_APP_PORT: String(port),
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: dataDir,
      EMBERVY_HARNESS: "brain",
      EMBERVY_TRUST_SAME_HOST: "1",
      APP_PASSWORD: crypto.randomUUID(),
      APP_SESSION_SECRET: crypto.randomUUID(),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "message-replay-no-session",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error("test server did not start");
}, 30_000);

afterAll(async () => {
  server?.kill();
  if (server) await server.exited;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function rows(text: string) {
  const path = join(dataDir, "inbox.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.text === text) : [];
}

async function post(text: string, client_id?: unknown, reply_to?: unknown) {
  const response = await fetch(`${base}/api/message`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, client_id, reply_to }),
  });
  expect(response.status).toBe(200);
  return response.json();
}

test("two requests with one client id store one row and return the same answer", async () => {
  const text = "one stored message";
  const reply = { id: "quoted", snippet: "quote", role: "assistant" };
  const first = await post(text, "client-repeat-01", reply);
  const second = await post(text, "client-repeat-01", reply);
  expect(second).toEqual(first);
  expect(first).toEqual({ ok: true, id: expect.any(String) });
  expect(rows(text)).toHaveLength(1);
  expect(rows(text)[0].id).toBe(first.id);
  expect(rows(text)[0].reply_to).toEqual(reply);
});

test("different client ids store two rows", async () => {
  const text = "two intended messages";
  const first = await post(text, "client-distinct-01");
  const second = await post(text, "client-distinct-02");
  expect(second.id).not.toBe(first.id);
  expect(rows(text)).toHaveLength(2);
});

for (const [label, id] of Object.entries({ missing: undefined, short: "short", long: "x".repeat(65), punctuation: "client/bad-01", newline: "client-bad-01\n", number: 12345678, array: ["client-array-01"], object: { id: "client-object-01" } })) {
  test(`${label} client ids retain independent sends`, async () => {
    const text = `ignored id ${label}`;
    const first = await post(text, id);
    const second = await post(text, id);
    expect(second.id).not.toBe(first.id);
    expect(rows(text)).toHaveLength(2);
  });
}

test("concurrent requests share the accepted message", async () => {
  const text = "concurrent message";
  const answers = await Promise.all(Array.from({ length: 8 }, () => post(text, "client-concurrent-01")));
  expect(new Set(answers.map(answer => answer.id)).size).toBe(1);
  expect(rows(text)).toHaveLength(1);
});

async function socket() {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("socket did not open"));
  });
  return {
    close: () => ws.close(),
    send(text: string, client_id: unknown) {
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ack missing")), 2000);
        ws.onmessage = event => {
          const answer = JSON.parse(String(event.data));
          if (answer.type !== "ack") return;
          clearTimeout(timer);
          resolve(answer);
        };
        ws.send(JSON.stringify({ type: "message", text, client_id }));
      });
    },
  };
}

test("socket repeats and HTTP retries share the same message id", async () => {
  const ws = await socket();
  try {
    const text = "socket then HTTP";
    const first = await ws.send(text, "client-socket-01");
    expect(await ws.send(text, "client-socket-01")).toEqual(first);
    const http = await post(text, "client-socket-01");
    expect(first).toEqual({ type: "ack", id: http.id });
    expect(rows(text)).toHaveLength(1);
    const reverse = await post("HTTP then socket", "client-socket-02");
    expect(await ws.send("HTTP then socket", "client-socket-02")).toEqual({ type: "ack", id: reverse.id });
    expect(rows("HTTP then socket")).toHaveLength(1);
  } finally { ws.close(); }
});

const serverSource = readFileSync(join(import.meta.dir, "server.ts"), "utf8");

function replayHarness(deliver: (msg: any) => Promise<boolean>) {
  const section = serverSource.slice(serverSource.indexOf("const TEXT_CLIENT_ID_RE ="), serverSource.indexOf('app.post("/api/message"'));
  const script = new Bun.Transpiler({ loader: "ts" }).transformSync(section);
  let now = 0, sequence = 0;
  class Clock extends Date { static now() { return now; } }
  const run = new Function("deliverChatMessage", "generateId", "Date", `${script}
    return { send: acceptTextMessage, cache: textReplays, max: TEXT_REPLAY_MAX, ttl: TEXT_REPLAY_TTL_MS };
  `)(deliver, () => `stored-${++sequence}`, Clock);
  return { ...run, advance(ms: number) { now += ms; } };
}

test("a blocked message is delivered by a later retry with the same id, and only once", async () => {
  let calls = 0, allowed = false;
  const h = replayHarness(async () => { calls++; return allowed; });
  const first = await h.send("held message", null, "client-blocked-01");
  expect(first).toEqual({ id: "stored-1", blocked: "first-start" });
  allowed = true;
  const second = await h.send("held message", null, "client-blocked-01");
  expect(second).toEqual({ id: "stored-2" });
  expect(await h.send("held message", null, "client-blocked-01")).toEqual(second);
  expect(calls).toBe(2);
});

test("overlapping first-start checks share one delivery and one blocked answer", async () => {
  let finish!: (allowed: boolean) => void;
  let calls = 0;
  const h = replayHarness(() => { calls++; return new Promise(resolve => finish = resolve); });
  const first = h.send("held message", null, "client-pending-01");
  const second = h.send("held message", null, "client-pending-01");
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(h.cache.size).toBe(1);
  finish(false);
  expect(await second).toEqual(await first);
  expect((await second).blocked).toBe("first-start");
});

test("a known id returns its original answer rather than accepting a changed payload", async () => {
  const delivered: any[] = [];
  const h = replayHarness(async msg => { delivered.push(msg); return true; });
  const first = await h.send("original", null, "client-original-01");
  expect(await h.send("changed", null, "client-original-01")).toEqual(first);
  expect(delivered.map(msg => msg.text)).toEqual(["original"]);
});

test("a failed delivery releases its reservation for a later attempt", async () => {
  let calls = 0;
  const h = replayHarness(async () => {
    if (++calls === 1) throw new Error("storage unavailable");
    return true;
  });
  await expect(h.send("message", null, "client-storage-01")).rejects.toThrow("storage unavailable");
  expect(h.cache.size).toBe(0);
  expect(await h.send("message", null, "client-storage-01")).toEqual({ id: "stored-2" });
  expect(calls).toBe(2);
});

test("replay retention expires without being extended by repeats", async () => {
  let calls = 0;
  const h = replayHarness(async () => { calls++; return true; });
  expect(h.ttl).toBe(24 * 60 * 60 * 1000);
  const first = await h.send("message", null, "client-expiry-01");
  h.advance(h.ttl - 1);
  expect(await h.send("message", null, "client-expiry-01")).toEqual(first);
  h.advance(1);
  expect((await h.send("message", null, "client-expiry-01")).id).not.toBe(first.id);
  expect(calls).toBe(2);
});

test("the replay count is bounded and evicts the oldest completed answer", async () => {
  const h = replayHarness(async () => true);
  expect(h.max).toBe(2048);
  const first = await h.send("message", null, "client-capacity-first");
  for (let i = 0; i < h.max; i++) await h.send("message", null, `client-capacity-${i}`);
  expect(h.cache.size).toBe(h.max);
  expect(h.cache.has("client-capacity-first")).toBe(false);
  expect((await h.send("message", null, "client-capacity-first")).id).not.toBe(first.id);
  expect(h.cache.size).toBe(h.max);
});

test("a full active cache waits rather than evicting a delivery in progress", async () => {
  const finishes: Array<(allowed: boolean) => void> = [];
  const h = replayHarness(() => new Promise(resolve => finishes.push(resolve)));
  const pending = Array.from({ length: h.max }, (_, i) => h.send("message", null, `client-active-${i}`));
  await Promise.resolve();
  const extra = h.send("extra", null, "client-active-extra");
  const repeat = h.send("message", null, "client-active-0");
  expect(h.cache.size).toBe(h.max);
  expect(finishes).toHaveLength(h.max);
  finishes[0](true);
  expect(await repeat).toEqual(await pending[0]);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(finishes).toHaveLength(h.max + 1);
  expect(h.cache.size).toBe(h.max);
  finishes.forEach(finish => finish(true));
  await Promise.all([...pending, extra]);
  expect(h.cache.size).toBe(h.max);
});

test("slash text keeps independent sends", async () => {
  const first = await post("/unhandled", "client-slash-01");
  const second = await post("/unhandled", "client-slash-01");
  expect(second.id).not.toBe(first.id);
  expect(rows("/unhandled")).toHaveLength(2);
});
