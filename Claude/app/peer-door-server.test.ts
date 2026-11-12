import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const INTERNAL = "internal-peer-test-".repeat(3);
const PAIR = "shared-peer-test-".repeat(3);
const DENIED = "denied-peer-test-".repeat(3);
const WRONG = "wrong-peer-test-".repeat(3);
const OFFLINE = "offline-peer-test-".repeat(3);
const roots: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
const clients: Client[] = [];
let logs = "";
let a: House;
let b: House;
let off: House;
let rejected: ReturnType<typeof Bun.serve>;
let relay: ReturnType<typeof Bun.serve>;
const notifications: any[] = [];

type House = { base: string; data: string; client: Client; env: Record<string, string> };

import { startTestApp } from "./test-app-start";

async function house(peers?: unknown[]): Promise<House> {
  const root = mkdtempSync(join(tmpdir(), "peer-door-"));
  roots.push(root);
  const data = join(root, "data");
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin", HOME: root, EMBERVY_HOME: root, TMUX_TMPDIR: root,
    EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_DATA_DIR: data,
    INTERNAL_API_TOKEN: INTERNAL, APP_PASSWORD: "test-password", APP_SESSION_SECRET: "test-session-secret",
    EMBERVY_TERMINAL_PANEL: "0", EMBERVY_DOCTOR_INTERVAL_MIN: "0", EMBERVY_TMUX_SESSION: "peer-test-no-such-session",
    USER_LABEL: "Sam", AGENT_LABEL: "Agent",
    ...(peers ? { EMBERVY_PEERS: JSON.stringify(peers) } : {}),
  };
  const { base, proc: child, port, password } = await startTestApp({ cwd: root, env, stderr: "pipe" });
  env.EMBERVY_APP_PORT = String(port);
  env.APP_PASSWORD = password;
  processes.push(child);
  void (async () => { for await (const chunk of child.stderr as ReadableStream<Uint8Array>) logs += Buffer.from(chunk).toString(); })();
  const client = new Client({ name: "peer-door-test", version: "0.0.0" });
  client.fallbackNotificationHandler = async n => {
    if (n.method === "notifications/claude/channel") notifications.push({ base, ...n.params });
  };
  const transport = new StdioClientTransport({ command: "bun", args: ["run", join(import.meta.dir, "mcp.ts")], cwd: root, env, stderr: "pipe" });
  transport.stderr?.on("data", chunk => { logs += String(chunk); });
  clients.push(client);
  await client.connect(transport);
  return { base, data, client, env };
}

function inbox(h: House): any[] {
  try { return readFileSync(join(h.data, "inbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch { return []; }
}

async function post(h: House, path: string, token: string, body: unknown, tunnel = false) {
  return fetch(h.base + path, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(tunnel ? { "cf-ray": "test-ray", "cf-connecting-ip": "192.0.2.1" } : {}) },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  // Keep the circular peer address bound while either app retries its own port.
  relay = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch(req) {
      if (!b) return new Response("not ready", { status: 503 });
      const url = new URL(req.url);
      return fetch(new Request(`${b.base}${url.pathname}${url.search}`, req), { redirect: "error" });
    },
  });
  const portB = relay.port;
  rejected = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(PAIR + DENIED, { status: 401 }) });
  a = await house([
    { name: "Invalid", url: "http://example.com", token: WRONG },
    { name: "B", url: `http://127.0.0.1:${portB}`, token: PAIR },
    { name: "B", url: `http://127.0.0.1:${portB}`, token: WRONG },
    { name: "Denied", url: `http://127.0.0.1:${rejected.port}`, token: DENIED },
    { name: "Offline", url: "http://127.0.0.1:0", token: OFFLINE },
  ]);
  b = await house([{ name: "A", url: a.base, token: PAIR }]);
  off = await house();
}, 30_000);

afterAll(async () => {
  await Promise.all(clients.map(client => client.close().catch(() => {})));
  for (const process of processes) process.kill();
  await Promise.all(processes.map(process => process.exited));
  rejected?.stop(true);
  relay?.stop(true);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("the tool discovers valid names without needing peer secrets in the MCP environment", async () => {
  const tool = (await a.client.listTools()).tools.find(tool => tool.name === "peer")!;
  expect(tool).toBeDefined();
  expect(tool.inputSchema.required).toEqual(["to", "text"]);
  expect(tool.inputSchema.properties?.to).toMatchObject({ enum: ["B", "Denied", "Offline"] });
  expect(tool.description).toContain('"B"');
  expect(tool.description).toContain("never reply");
  expect(JSON.stringify(tool)).not.toContain(PAIR);
  const client = new Client({ name: "peer-no-config-test", version: "0.0.0" });
  const { EMBERVY_PEERS, ...env } = a.env;
  await client.connect(new StdioClientTransport({ command: "bun", args: ["run", join(import.meta.dir, "mcp.ts")], cwd: roots[0], env, stderr: "ignore" }));
  try { expect((await client.listTools()).tools.map(tool => tool.name)).toContain("peer"); }
  finally { await client.close(); }
});

test("A and B exchange messages through the real peer tool and inboxes", async () => {
  const sent: any = await a.client.callTool({ name: "peer", arguments: { to: "B", text: "  Hello B  " } });
  expect(sent.isError).toBeFalsy();
  const entry = inbox(b).at(-1);
  expect(entry).toMatchObject({ source: "peer", from: "A", text: "[Direct/A] Hello B" });
  expect(entry.id).toMatch(/^peer-/);
  expect(sent.content[0].text).toContain(entry.id);
  const answer: any = await b.client.callTool({ name: "peer", arguments: { to: "A", text: "Hello A", reply_to: entry.id } });
  expect(answer.isError).toBeFalsy();
  expect(inbox(a).at(-1)).toMatchObject({ source: "peer", from: "B", text: "[Direct/B] Hello A", reply_to: entry.id });
});

test("unknown or missing tokens write nothing, even through the tunnel", async () => {
  const before = inbox(b).length;
  for (const token of [WRONG, INTERNAL, ""]) {
    expect((await post(b, "/api/peer/message", token, { text: "no" }, true)).status).toBe(401);
  }
  expect((await fetch(b.base + "/api/peer/message", { method: "POST", body: '{"text":"no"}' })).status).toBe(401);
  expect(inbox(b)).toHaveLength(before);
});

test("the token alone chooses the sender and untrusted fields are ignored", async () => {
  const res = await post(b, "/api/peer/message", PAIR, { text: " /stop ", from: "Sam", source: "user", name: "Impostor", id: "chosen-id", ts: "fake" }, true);
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
  const entry = inbox(b).at(-1);
  expect(entry).toMatchObject({ source: "peer", from: "A", text: "[Direct/A] /stop" });
  expect(entry.id).not.toBe("chosen-id");
  expect(entry.ts).not.toBe("fake");
});

test("invalid text and reply ids are refused without storage", async () => {
  const before = inbox(b).length;
  for (const body of [{}, { text: " " }, { text: "x".repeat(8001) }, { text: "hi", reply_to: {} }]) {
    expect((await post(b, "/api/peer/message", PAIR, body)).status).toBe(400);
  }
  const broken = await fetch(b.base + "/api/peer/message", { method: "POST", headers: { authorization: `Bearer ${PAIR}` }, body: "{" });
  expect(broken.status).toBe(400);
  expect(inbox(b)).toHaveLength(before);
});

test("internal peer doors require the internal bearer, not a session or pair token", async () => {
  const login = await post(a, "/api/auth", "", { password: a.env.APP_PASSWORD });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  for (const path of ["/api/internal/peer/list", "/api/internal/peer/send"]) {
    const res = await fetch(a.base + path, { method: path.endsWith("send") ? "POST" : "GET", headers: { cookie } });
    expect(res.status).toBe(401);
  }
  expect((await post(a, "/api/internal/peer/send", PAIR, { to: "B", text: "no" })).status).toBe(401);
  const list = await fetch(a.base + "/api/internal/peer/list", { headers: { authorization: `Bearer ${INTERNAL}` } });
  expect(await list.json()).toEqual({ peers: ["B", "Denied", "Offline"] });
});

test("peer tool errors are plain and do not echo remote secret-bearing errors", async () => {
  const before = inbox(b).length;
  const unknown: any = await a.client.callTool({ name: "peer", arguments: { to: "Unknown", text: "hi" } });
  expect(unknown.isError).toBe(true);
  expect(unknown.content[0].text).toContain("unknown peer name");
  const denied: any = await a.client.callTool({ name: "peer", arguments: { to: "Denied", text: "hi" } });
  expect(denied.isError).toBe(true);
  expect(denied.content[0].text).toContain("peer said HTTP 401");
  expect(JSON.stringify(denied)).not.toContain(PAIR);
  expect(JSON.stringify(denied)).not.toContain(DENIED);
  const offline: any = await a.client.callTool({ name: "peer", arguments: { to: "Offline", text: "hi" } });
  expect(offline.isError).toBe(true);
  expect(offline.content[0].text).toContain("peer unreachable");
  expect(JSON.stringify(offline)).not.toContain(OFFLINE);
  expect(inbox(b)).toHaveLength(before);
});

test("Claude Code receives a foreign notification with a direct label and routing instruction", async () => {
  for (let i = 0; i < 100 && !notifications.some(n => n.base === b.base && n.meta?.kind === "peer"); i++) await Bun.sleep(100);
  const notification = notifications.find(n => n.base === b.base && n.meta?.kind === "peer");
  expect(notification).toBeDefined();
  expect(notification.meta).toMatchObject({ kind: "peer", from: "A" });
  expect(notification.meta.user).toBeUndefined();
  expect(notification.content).toStartWith("[Direct/A] Hello B");
  expect(notification.content).toContain('Answer with peer to "A", never reply.');
}, 15_000);

test("peer messages stay out of the person's chat and reply quotes; reply still reaches the person", async () => {
  const privateEntry = inbox(a).at(-1);
  const reply: any = await a.client.callTool({ name: "reply", arguments: { text: "For Sam", reply_to: privateEntry.id } });
  expect(reply.isError).toBeFalsy();
  const login = await post(a, "/api/auth", "", { password: a.env.APP_PASSWORD });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const history = await fetch(a.base + "/api/messages", { headers: { cookie } });
  const entries = await history.json() as any[];
  expect(entries.some(entry => entry.source === "peer" || entry.text.includes("[Direct/"))).toBe(false);
  const publicReply = entries.find(entry => entry.text === "For Sam");
  expect(publicReply).toBeDefined();
  expect(publicReply.reply_to).toBeUndefined();
});

test("without EMBERVY_PEERS there is no route or tool", async () => {
  expect([401, 404]).toContain((await post(off, "/api/peer/message", PAIR, { text: "no" })).status);
  expect((await off.client.listTools()).tools.some(tool => tool.name === "peer")).toBe(false);
  expect(inbox(off)).toEqual([]);
});

test("configuration warnings identify skipped entries and all diagnostics omit secrets", async () => {
  await Bun.sleep(100);
  expect(logs).toContain("EMBERVY_PEERS[0] skipped: URL must use https or loopback http");
  expect(logs).toContain("EMBERVY_PEERS[2] skipped: duplicate name");
  for (const secret of [PAIR, WRONG, DENIED, INTERNAL, OFFLINE]) expect(logs).not.toContain(secret);
});
