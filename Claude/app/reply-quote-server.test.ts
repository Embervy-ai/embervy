import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const token = "quote-test-internal-token-only";
let server: ReturnType<typeof Bun.spawn>;
let client: Client;
let dir = "", base = "", outbox = "", cookie = "";
const frames: any[] = [];
let socket: WebSocket;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "reply-quote-"));
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  if (port === 3030) throw new Error("refusing port 3030");
  base = `http://127.0.0.1:${port}`;
  const data = join(dir, "data");
  outbox = join(data, "outbox.jsonl");
  const common = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMUX_TMPDIR: dir,
    EMBERVY_HOME: dir, EMBERVY_APP_PORT: String(port), EMBERVY_APP_HOST: "127.0.0.1",
    INTERNAL_API_TOKEN: token, AGENT_LABEL: "Testagent", USER_LABEL: "User",
  };
  server = Bun.spawn([process.execPath, "run", join(import.meta.dir, "server.ts")], {
    cwd: dir, env: { ...common, EMBERVY_APP_DATA_DIR: data, APP_PASSWORD: "quote-password",
      APP_SESSION_SECRET: "quote-session-secret-only", EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "quote-test-no-such-session" }, stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch {}
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("quote test server did not come up");
  const login = await post("/api/auth", { password: "quote-password" });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
  client = new Client({ name: "reply-quote-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["run", join(import.meta.dir, "mcp.ts")], cwd: dir,
    env: { ...common, EMBERVY_APP_DATA_DIR: join(dir, "bridge") }, stderr: "ignore" }));
  socket = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: { cookie } });
  socket.onmessage = (event) => frames.push(JSON.parse(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket timeout")), 3000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error("socket failed")); };
  });
}, 30_000);

afterAll(async () => {
  socket?.close();
  await client?.close().catch(() => {});
  server?.kill();
  if (server) await server.exited;
  if (dir) rmSync(dir, { recursive: true, force: true });
});
function post(path: string, body: unknown, internal = false) {
  return fetch(base + path, { method: "POST", headers: { "content-type": "application/json", cookie,
    ...(internal ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
}
function entries(id: string): any[] {
  return readFileSync(outbox, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(m => m.id === id);
}
async function call(name: string, args: Record<string, unknown>) {
  const result: any = await client.callTool({ name, arguments: args });
  return { error: !!result.isError, text: String(result.content?.[0]?.text ?? "") };
}

test("reply quotes the human in storage, session history and live delivery; retries are unique", async () => {
  const human = await post("/api/message", { text: "An older question\nwith context" });
  expect(human.status).toBe(200);
  const { id } = await human.json() as any;
  const quote = { id, snippet: "An older question with context", role: "user" };
  const args = { text: "The answer", id: "quote-answer", reply_to: id };
  expect((await call("reply", args)).error).toBe(false);
  expect((await call("reply", args)).error).toBe(false);
  expect(entries(args.id)).toHaveLength(1);
  expect(entries(args.id)[0].reply_to).toEqual(quote);
  const history = await fetch(base + "/api/messages", { headers: { cookie } });
  expect(history.status).toBe(200);
  expect((await history.json() as any[]).find(m => m.id === args.id)?.reply_to).toEqual(quote);
  for (let i = 0; i < 40 && !frames.some(f => f.data?.id === args.id); i++) await Bun.sleep(25);
  const live = frames.filter(f => f.type === "message" && f.data?.id === args.id);
  expect(live).toHaveLength(1);
  expect(live[0].data.reply_to).toEqual(quote);
}, 15_000);

test("NOT delivered includes the quote ID and the repaired retry keeps it once", async () => {
  const human = await post("/api/message", { text: "Keep this quote" });
  const { id } = await human.json() as any;
  if (existsSync(outbox)) renameSync(outbox, outbox + ".saved");
  mkdirSync(outbox);
  const args = { text: "Retry answer", id: "quote-retry", reply_to: id };
  const failed = await call("reply", args);
  expect(failed.error).toBe(true);
  expect(failed.text).toContain("NOT delivered");
  expect(failed.text).toContain(`reply_to "${id}"`);
  rmSync(outbox, { recursive: true });
  expect((await call("reply", args)).error).toBe(false);
  expect((await call("reply", args)).error).toBe(false);
  expect(entries(args.id)).toHaveLength(1);
  expect(entries(args.id)[0].reply_to).toEqual({ id, snippet: "Keep this quote", role: "user" });
}, 15_000);

test("send quotes the outbox and voice fallback keeps the quote", async () => {
  expect((await call("send", { id: "quote-send", text: "Follow-up", reply_to: "quote-retry" })).error).toBe(false);
  expect(entries("quote-send")[0].reply_to).toEqual({ id: "quote-retry", snippet: "Retry answer", role: "assistant" });
  const voice = await call("voice_reply", { text: "Spoken follow-up", reply_to: "quote-send" });
  expect(voice.error).toBe(false);
  expect(voice.text).toContain("sent as text");
  const all = readFileSync(outbox, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(all.find(m => m.text === "Spoken follow-up")?.reply_to).toEqual({ id: "quote-send", snippet: "Follow-up", role: "assistant" });
}, 15_000);

test("internal broadcasts ignore unsafe, missing and fabricated quote IDs", async () => {
  for (const reply_to of ["unknown", "room-1", "bad\"id", { id: "quote-send", snippet: "Fabricated" }]) {
    const id = crypto.randomUUID();
    expect((await post("/api/internal/broadcast", { id, text: "No quote", reply_to }, true)).status).toBe(200);
    expect(entries(id)[0].reply_to).toBeUndefined();
  }
});
