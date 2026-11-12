import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Failed or unreachable delivery must not report success. The real
// mcp.ts runs as a stdio process against (a) a scripted local receiver and
// (b) the real server.ts — random ports, own data dirs, never port 3030.
// "Sent" only after a 2xx; anything else is an MCP error that keeps the
// text and the id; a retry repeats the id and the server takes it once.

const TOKEN = "delivery-test-token-0123456789";
const dir = mkdtempSync(join(tmpdir(), "reply-delivery-"));

type Hit = { path: string; auth: string | null; body: any };
let hits: Hit[] = [];
let mode: "ok" | "401" | "500" | "500-then-ok" | "slow-then-ok" = "ok";
let voiceOk = false;

const receiver = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = await req.json().catch(() => null);
    hits.push({ path, auth: req.headers.get("authorization"), body });
    if (path === "/api/internal/voice-broadcast") {
      return voiceOk ? Response.json({ ok: true, id: body?.id, duration: 3 }) : Response.json({ error: "no 11Labs key" }, { status: 500 });
    }
    const n = hits.filter((h) => h.path === path).length;
    switch (mode) {
      case "ok": return Response.json({ ok: true });
      case "401": return Response.json({ error: "unauthorized" }, { status: 401 });
      case "500": return Response.json({ error: "outbox write failed" }, { status: 500 });
      case "500-then-ok": return n === 1 ? new Response("boom", { status: 500 }) : Response.json({ ok: true });
      case "slow-then-ok":
        if (n === 1) await Bun.sleep(1500);
        return Response.json({ ok: true });
    }
  },
});

import { startTestApp, testPort } from "./test-app-start";

const clients: Client[] = [];
async function bridge(port: number, env: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "reply-delivery-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "mcp.ts")],
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_PORT: String(port),
      EMBERVY_APP_DATA_DIR: join(dir, `mcp-data-${clients.length}`),
      EMBERVY_BROADCAST_TIMEOUT_MS: "400",
      ...env,
    },
    stderr: "ignore",
  }));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r: any = await client.callTool({ name, arguments: args });
  return { isError: r.isError === true, text: String(r.content?.[0]?.text ?? "") };
}

const broadcasts = () => hits.filter((h) => h.path === "/api/internal/broadcast");

let main: Client;
beforeAll(async () => {
  if (receiver.port === 3030) throw new Error("refusing to test on port 3030");
  main = await bridge(receiver.port, { INTERNAL_API_TOKEN: TOKEN });
}, 30_000);

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  receiver.stop(true);
  rmSync(dir, { recursive: true, force: true });
}, 20_000);

describe("reply/send: Sent only after the app took the message", () => {
  test("HTTP 200 → Sent, with the bearer and a message id", async () => {
    hits = []; mode = "ok";
    const r = await call(main, "reply", { text: "hello" });
    expect(r).toEqual({ isError: false, text: "Sent: hello" });
    expect(broadcasts()).toHaveLength(1);
    expect(broadcasts()[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(broadcasts()[0].body).toMatchObject({ text: "hello", type: "reply" });
    expect(broadcasts()[0].body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("HTTP 401 → MCP error, NOT delivered, text and id kept, no second attempt", async () => {
    hits = []; mode = "401";
    const r = await call(main, "reply", { text: "audit synthetic message" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NOT delivered");
    expect(r.text).toContain("HTTP 401");
    expect(r.text).toContain("audit synthetic message");
    expect(r.text).not.toContain("Sent:");
    expect(broadcasts()).toHaveLength(1);
    expect(r.text).toContain(`id "${broadcasts()[0].body.id}"`);
  });

  test("HTTP 500 → MCP error after one retry with the same id", async () => {
    hits = []; mode = "500";
    const r = await call(main, "send", { text: "server trouble" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NOT delivered");
    expect(r.text).toContain("HTTP 500");
    expect(r.text).toContain("call send again");
    const ids = broadcasts().map((h) => h.body.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  test("HTTP 500, then 200 → Sent; both attempts carry the same id", async () => {
    hits = []; mode = "500-then-ok";
    expect(await call(main, "reply", { text: "second time lucky" })).toEqual({ isError: false, text: "Sent: second time lucky" });
    const ids = broadcasts().map((h) => h.body.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  test("a timeout is retried with the same id (the server drops the repeat)", async () => {
    hits = []; mode = "slow-then-ok";
    expect(await call(main, "reply", { text: "slow app" })).toEqual({ isError: false, text: "Sent: slow app" });
    const ids = broadcasts().map((h) => h.body.id);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
  });

  test("the agent's retry passes the id back; a malformed id is refused before anything is sent", async () => {
    hits = []; mode = "ok";
    expect((await call(main, "reply", { text: "again", id: "3f2b-retry_1.x:y" })).isError).toBe(false);
    expect(broadcasts()[0].body.id).toBe("3f2b-retry_1.x:y");
    hits = [];
    const bad = await call(main, "reply", { text: "again", id: `x" onclick="y` });
    expect(bad.isError).toBe(true);
    expect(broadcasts()).toHaveLength(0);
  });

  test("voice_reply: voice fails and the text fallback is refused → MCP error; fallback accepted → sent as text, same id", async () => {
    hits = []; mode = "401"; voiceOk = false;
    const r = await call(main, "voice_reply", { text: "spoken words" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NOT delivered");
    expect(r.text).toContain("voice failed");
    hits = []; mode = "ok";
    expect(await call(main, "voice_reply", { text: "spoken words" })).toEqual({ isError: false, text: "Voice failed, sent as text: spoken words" });
    const voice = hits.find((h) => h.path === "/api/internal/voice-broadcast")!;
    expect(broadcasts()[0].body.id).toBe(voice.body.id);
    hits = []; voiceOk = true;
    expect(await call(main, "voice_reply", { text: "spoken words" })).toEqual({ isError: false, text: "Voice sent (3s): spoken words" });
    expect(broadcasts()).toHaveLength(0);
    voiceOk = false;
  });

  test("no app server listening → MCP error, unreachable", async () => {
    const closed = await bridge(testPort(), { INTERNAL_API_TOKEN: TOKEN });
    const r = await call(closed, "reply", { text: "into the void" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NOT delivered");
    expect(r.text).toContain("unreachable");
  }, 20_000);

  test("token: BRAIN_APP_TOKEN counts when INTERNAL_API_TOKEN is not inherited; neither → the 401 says so", async () => {
    hits = []; mode = "ok";
    const brainOnly = await bridge(receiver.port, { BRAIN_APP_TOKEN: "brain-install-token" });
    expect((await call(brainOnly, "reply", { text: "from a Brain install" })).isError).toBe(false);
    expect(broadcasts()[0].auth).toBe("Bearer brain-install-token");

    hits = []; mode = "401";
    const none = await bridge(receiver.port, {});
    const r = await call(none, "reply", { text: "no token" });
    expect(broadcasts()[0].auth).toBeNull();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("neither INTERNAL_API_TOKEN nor BRAIN_APP_TOKEN");
  }, 20_000);
});

describe("the real server takes a message id once", () => {
  const dataDir = join(dir, "server-data");
  let server: ReturnType<typeof Bun.spawn> | null = null;
  let base = "";
  let port = 0;

  async function startServer() {
    const app = await startTestApp({
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        TMUX_TMPDIR: dir,
        EMBERVY_APP_HOST: "127.0.0.1",
        EMBERVY_APP_DATA_DIR: dataDir,
        INTERNAL_API_TOKEN: TOKEN,
        APP_PASSWORD: "test-password-not-real",
        APP_SESSION_SECRET: "session-secret-for-tests-only",
        EMBERVY_TERMINAL_PANEL: "0",
        EMBERVY_TMUX_SESSION: "reply-delivery-test-no-such-session",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    ({ base, port, proc: server } = app);
  }
  async function stopServer() {
    server?.kill();
    await server?.exited;
    server = null;
  }

  beforeAll(async () => {
    await startServer();
  }, 30_000);
  afterAll(async () => { await stopServer(); });

  const outbox = (): any[] => {
    const f = join(dataDir, "outbox.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  };
  const post = (body: unknown) => fetch(`${base}/api/internal/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });

  test("a repeated id is answered ok and stored once — also after a restart", async () => {
    const msg = { id: "dedupe-test-1", text: "only once", ts: new Date().toISOString(), type: "reply" };
    expect(await (await post(msg)).json()).toEqual({ ok: true });
    expect(await (await post(msg)).json()).toEqual({ ok: true, duplicate: true });
    expect(outbox().filter((m) => m.id === "dedupe-test-1")).toHaveLength(1);

    await stopServer();
    await startServer();
    expect(await (await post(msg)).json()).toEqual({ ok: true, duplicate: true });
    expect(outbox().filter((m) => m.id === "dedupe-test-1")).toHaveLength(1);
    // a new id is a new message
    expect(await (await post({ ...msg, id: "dedupe-test-2" })).json()).toEqual({ ok: true });
    expect(outbox().filter((m) => m.text === "only once")).toHaveLength(2);
  }, 30_000);

  test("through the bridge: a refused reply is an error and leaves nothing; an accepted one lands once", async () => {
    const wrong = await bridge(port, { INTERNAL_API_TOKEN: "wrong-token" });
    const refused = await call(wrong, "reply", { text: "refused message" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("HTTP 401");
    expect(outbox().some((m) => m.text === "refused message")).toBe(false);

    const right = await bridge(port, { INTERNAL_API_TOKEN: TOKEN });
    expect(await call(right, "reply", { text: "accepted message" })).toEqual({ isError: false, text: "Sent: accepted message" });
    const landed = outbox().filter((m) => m.text === "accepted message");
    expect(landed).toHaveLength(1);
    // the agent retries with the same id (say, after a timeout): still one
    expect((await call(right, "reply", { text: "accepted message", id: landed[0].id })).isError).toBe(false);
    expect(outbox().filter((m) => m.text === "accepted message")).toHaveLength(1);
  }, 30_000);
});
