import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
let server: ReturnType<typeof Bun.spawn>, base = "", dir = "";
const tunnel = { "cf-ray": "test", "cf-connecting-ip": "203.0.113.8" };
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ws-expiry-"));
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port; probe.stop(true);
  if (port === 3030) throw new Error("Refusing service port");
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
    cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir,
      EMBERVY_APP_PORT: String(port), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_DATA_DIR: dir,
      APP_PASSWORD: "test-password", APP_SESSION_SECRET: "test-session-secret", APP_SESSION_MAX_AGE_MS: "1000",
      EMBERVY_TRUST_SAME_HOST: "true", INTERNAL_API_TOKEN: "test-internal", EMBERVY_TERMINAL_PANEL: "0" },
    stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch {}
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("Server unavailable");
}, 30000);
afterAll(async () => {
  try {
    if (server) { server.kill(); await server.exited; }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

test("an open authenticated socket closes at expiry and cannot append or acknowledge later messages", async () => {
  const login = await fetch(`${base}/api/auth`, { method: "POST", headers: { ...tunnel, "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { ...tunnel, cookie } });
  const messages: any[] = [];
  ws.onmessage = e => messages.push(JSON.parse(String(e.data)));
  const closed = new Promise<number>(resolve => { ws.onclose = e => resolve(e.code); });
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
  ws.send(JSON.stringify({ type: "message", text: "before-expiry" }));
  for (let i = 0; i < 50 && !messages.some(m => m.type === "ack"); i++) await Bun.sleep(10);
  expect(messages.filter(m => m.type === "ack")).toHaveLength(1);
  expect(await Promise.race([closed, Bun.sleep(3000).then(() => -1)])).toBe(4001);
  try { ws.send(JSON.stringify({ type: "message", text: "after-expiry" })); } catch {}
  await Bun.sleep(30);
  expect(messages.filter(m => m.type === "ack")).toHaveLength(1);
  const inbox = join(dir, "inbox.jsonl");
  expect(existsSync(inbox)).toBe(true);
  const text = readFileSync(inbox, "utf8");
  expect(text).toContain("before-expiry");
  expect(text).not.toContain("after-expiry");
}, 10000);

test("trusted cookie-free sockets do not expire", async () => {
  const ws = new WebSocket(base.replace("http:", "ws:") + "/ws");
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
  try {
    await Bun.sleep(1100);
    const pong = new Promise<string>(resolve => { ws.onmessage = e => resolve(JSON.parse(String(e.data)).type); });
    ws.send(JSON.stringify({ type: "ping" }));
    expect(await Promise.race([pong, Bun.sleep(1000).then(() => "timeout")])).toBe("pong");
  } finally { ws.close(); }
});

test("all outgoing sends use the expiry guard", () => {
  expect(source.split("\n").filter(line => /\bws\.send\(/.test(line))).toEqual(["  if (wsSessionActive(ws)) ws.send(data);"]);
});
test("delayed timers do not permit sends or incoming messages at the deadline", async () => {
  const start = source.indexOf("function wsSessionActive");
  const end = source.indexOf("function scheduleWsExpiry", start);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  const sent: string[] = [], closed: number[] = [];
  const ws = { data: { sessionExpiresAt: 100 }, send: (data: string) => sent.push(data), close: (code: number) => closed.push(code) };
  const f = new Function("Date", "wsExpiryTimers", "wsClients", "unsubscribeTerminal", "clearTimeout", "WS_SESSION_EXPIRED", `${code}; return { wsSessionActive, sendToClient };`)({ now: () => 100 }, new Map(), new Set(), () => {}, () => {}, 4001);
  f.sendToClient(ws, "private output");
  expect(f.wsSessionActive(ws)).toBe(false);
  expect(sent).toEqual([]);
  expect(closed).toEqual([4001, 4001]);
  const messageStart = source.indexOf("    async message(ws, message) {");
  const messageEnd = source.indexOf("\n  },\n});", messageStart);
  const handlerCode = new Bun.Transpiler({ loader: "ts" }).transformSync(`const handlers = { ${source.slice(messageStart, messageEnd)} };`);
  let appended = 0;
  const handlers = new Function("wsSessionActive", "sendToClient", "appendFileSync", `${handlerCode}; return handlers;`)(f.wsSessionActive, f.sendToClient, () => appended++);
  await handlers.message(ws, JSON.stringify({ type: "message", text: "expired input" }));
  await handlers.message(ws, JSON.stringify({ type: "terminal-input", text: "expired terminal input" }));
  expect(appended).toBe(0);
  expect(sent).toEqual([]);
  ws.data.sessionExpiresAt = 101;
  await handlers.message(ws, JSON.stringify({ type: "ping" }));
  expect(sent).toEqual([JSON.stringify({ type: "pong" })]);
});

test("only the expiry close code reloads the client once instead of reconnecting", () => {
  const app = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
  const start = app.indexOf("    sock.onclose = (event) => {");
  const end = app.indexOf("\n    sock.onerror", start);
  for (const code of [4001, 1006]) {
    let reloads = 0, reconnects = 0;
    const sock: any = {};
    const noop = () => {};
    new Function("sock", "location", "clearTimeout", "stopWsProbe", "stopWsHeartbeat", "stopPollFallback", "wsDown", "scheduleReconnect", "console", `let ws = sock, connectTimer = null, reconnectTimer = null; ${app.slice(start, end)}`)(sock, { reload: () => reloads++ }, noop, noop, noop, noop, noop, () => reconnects++, { log: noop });
    sock.onclose?.({ code });
    sock.onclose?.({ code });
    expect(reloads).toBe(code === 4001 ? 1 : 0);
    expect(reconnects).toBe(code === 4001 ? 0 : 1);
  }
});
