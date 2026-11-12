import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { roomMessagePrefix } from "./room-door";


const INTERNAL = "internal-test-token-0123456789";
const MEMBER_KEY = "m".repeat(64);
let server: ReturnType<typeof Bun.spawn>;
let room: ReturnType<typeof Bun.serve>;
let client: Client;
let base = "";
let password = "";
let dir = "";
let dataDir = "";
const roomMessages: any[] = [];
const roomSent: { auth: string; body: any }[] = [];
const roomPolls: string[] = [];

import { startTestApp } from "./test-app-start";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "room-door-"));
  dataDir = join(dir, "data");
  room = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") || "";
      if (auth !== `Bearer ${MEMBER_KEY}`) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (url.pathname === "/api/synth/messages") {
        roomPolls.push(url.searchParams.get("after") || "");
        const after = url.searchParams.get("after") || "";
        return Response.json({ ok: true, messages: roomMessages.filter((m) => m.ts > after) });
      }
      if (url.pathname === "/api/synth/send" && req.method === "POST") {
        const body = await req.json();
        roomSent.push({ auth, body });
        return Response.json({ ok: true, message: { id: "sent-1", sender: "agent" } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const now = new Date();
  roomMessages.push(
    { id: "r1", sender: "rowan", sender_name: "Rowan", text: "Hello, I am in the support room.", ts: new Date(now.getTime() - 60_000).toISOString(), type: "text" },
    { id: "r2", sender: "rowan", sender_name: "Rowan", text: "/stop", ts: new Date(now.getTime() - 30_000).toISOString(), type: "text" },
  );

  const common = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    TMUX_TMPDIR: dir,
    EMBERVY_APP_PORT: "",
    EMBERVY_APP_HOST: "127.0.0.1",
    INTERNAL_API_TOKEN: INTERNAL,
    AGENT_LABEL: "Testagent",
    USER_LABEL: "Sam",
  };
  const app = await startTestApp({
    cwd: dir,
    env: {
      ...common,
      EMBERVY_APP_DATA_DIR: dataDir,
      APP_PASSWORD: "test-password-not-real",
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "room-door-test-no-such-session",
      EMBERVY_ROOM_URL: `http://127.0.0.1:${room.port}`,
      EMBERVY_ROOM_TOKEN: MEMBER_KEY,
      EMBERVY_ROOM_NAME: "Support",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc: server, password } = app);
  common.EMBERVY_APP_PORT = String(app.port);

  client = new Client({ name: "room-door-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: ["run", join(import.meta.dir, "mcp.ts")],
    cwd: dir,
    env: { ...common, EMBERVY_APP_DATA_DIR: join(dir, "mcp-data"), EMBERVY_HOME: dir },
    stderr: "ignore",
  }));
}, 30_000);

afterAll(async () => {
  await client?.close().catch(() => {});
  server?.kill();
  room?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

function inboxLines(): any[] {
  try {
    return readFileSync(join(dataDir, "inbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test("room messages reach the inbox once, as foreign content", async () => {
  for (let i = 0; i < 100 && inboxLines().length < 2; i++) await Bun.sleep(100);
  const lines = inboxLines();
  expect(lines.map((l) => l.text)).toEqual(["[Support/Rowan] Hello, I am in the support room.", "[Support/Rowan] /stop"]);
  for (const l of lines) {
    expect(l.source).toBe("room");
    expect(l.room).toBe("Support");
    expect(l.from).toBe("Rowan");
  }
  const state = JSON.parse(readFileSync(join(dataDir, "room-state.json"), "utf8"));
  expect(state.after).toBe(roomMessages[1].ts);
}, 20_000);

test("room messages stay out of the user's chat history", async () => {
  const login = await fetch(`${base}/api/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const hist = await fetch(`${base}/api/messages`, { headers: { cookie } });
  expect(hist.status).toBe(200);
  const all = (await hist.json()) as any[];
  expect(all.some((m) => String(m.text || "").includes("[Support/"))).toBe(false);
});

test("the room door answers the agent's bearer only", async () => {
  const noAuth = await fetch(`${base}/api/internal/room`);
  expect(noAuth.status).toBe(401);
  const login = await fetch(`${base}/api/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  const asBrowser = await fetch(`${base}/api/internal/room/send`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  expect(asBrowser.status).toBe(401);
  const ok = await fetch(`${base}/api/internal/room`, { headers: { authorization: `Bearer ${INTERNAL}` } });
  expect(await ok.json()).toEqual({ rooms: ["Support"] });
});

test("the room tool is listed and speaks with the member key", async () => {
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("room");
  const before = roomSent.length;
  const result: any = await client.callTool({ name: "room", arguments: { text: "Hello back", reply_to: "room-r1" } });
  expect(result.isError).toBeFalsy();
  expect(result.content[0].text).toBe("Sent to Support (id sent-1)");
  expect(roomSent.length).toBe(before + 1);
  expect(roomSent.at(-1)).toEqual({ auth: `Bearer ${MEMBER_KEY}`, body: { text: "Hello back", reply_to: "r1" } });
});

test("one room keeps the tool schema and accepts an explicit room name", async () => {
  const tool = (await client.listTools()).tools.find(tool => tool.name === "room")!;
  expect(tool.inputSchema).toEqual({
    type: "object",
    properties: {
      text: { type: "string", description: "Message text" },
      reply_to: { type: "string", description: "Optional: the message_id of the room message you answer" },
    },
    required: ["text"],
  });
  const headers = { authorization: `Bearer ${INTERNAL}`, "content-type": "application/json" };
  const res = await fetch(`${base}/api/internal/room/send`, { method: "POST", headers, body: JSON.stringify({ text: "named", room: "Support" }) });
  expect(res.status).toBe(200);
  const unknown = await fetch(`${base}/api/internal/room/send`, { method: "POST", headers, body: JSON.stringify({ text: "wrong", room: "Unknown" }) });
  expect(unknown.status).toBe(400);
  expect((await unknown.json() as any).rooms).toEqual(["Support"]);
});

describe("several rooms", () => {
  const keys = ["a".repeat(64), "b".repeat(64)];
  const names = ["Family", "Work"];
  const cursors = ["2026-01-01T10:00:00.000Z", "2026-01-02T10:00:00.000Z"];
  const next = ["2026-01-01T10:01:00.000Z", "2026-01-02T10:01:00.000Z"];
  const polls: string[][] = [[], []];
  const sent: { room: number; body: any }[] = [];
  const rooms: ReturnType<typeof Bun.serve>[] = [];
  let server: ReturnType<typeof Bun.spawn>;
  let client: Client;
  let dir = "";
  let dataDir = "";
  let base = "";
  const headers = { authorization: `Bearer ${INTERNAL}`, "content-type": "application/json" };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "room-door-multi-"));
    dataDir = join(dir, "data");
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, "room-state.json"), JSON.stringify({ after: cursors[0], seen: ["old-0"] }));
    writeFileSync(join(dataDir, "room-state-Work.json"), JSON.stringify({ after: cursors[1], seen: ["old-1"] }));
    for (let index = 0; index < 2; index++) {
      rooms.push(Bun.serve({
        port: 0, hostname: "127.0.0.1",
        async fetch(req) {
          if (req.headers.get("authorization") !== `Bearer ${keys[index]}`) return new Response("unauthorized", { status: 401 });
          const url = new URL(req.url);
          if (url.pathname === "/api/synth/messages") {
            const after = url.searchParams.get("after") || "";
            polls[index].push(after);
            return Response.json({ messages: [
              { id: `old-${index}`, sender: "sam", text: "already seen", ts: next[index] },
              { id: `new-${index}`, sender: "sam", text: `new in ${names[index]}`, ts: next[index] },
            ].filter(message => message.ts > after) });
          }
          if (url.pathname === "/api/synth/send" && req.method === "POST") {
            sent.push({ room: index, body: await req.json() });
            return Response.json({ message: { id: `sent-${index}` } });
          }
          return new Response("not found", { status: 404 });
        },
      }));
    }
    const common = {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMUX_TMPDIR: dir,
      EMBERVY_APP_PORT: "", EMBERVY_APP_HOST: "127.0.0.1",
      INTERNAL_API_TOKEN: INTERNAL, AGENT_LABEL: "Testagent", USER_LABEL: "Sam",
    };
    const app = await startTestApp({
      cwd: dir,
      env: {
        ...common, EMBERVY_APP_DATA_DIR: dataDir,
        APP_PASSWORD: "test-password-not-real", APP_SESSION_SECRET: "session-secret-for-tests-only",
        EMBERVY_TERMINAL_PANEL: "0", EMBERVY_TMUX_SESSION: "multi-room-test-no-such-session",
        EMBERVY_ROOM_URL: `http://127.0.0.1:${rooms[0].port}`, EMBERVY_ROOM_TOKEN: keys[0], EMBERVY_ROOM_NAME: names[0],
        EMBERVY_ROOMS: JSON.stringify([{ name: names[1], url: `http://127.0.0.1:${rooms[1].port}`, token: keys[1], poll_seconds: 15 }]),
      },
      stdout: "ignore", stderr: "ignore",
    });
    ({ base, proc: server } = app);
    common.EMBERVY_APP_PORT = String(app.port);
    client = new Client({ name: "multi-room-test", version: "0.0.0" });
    await client.connect(new StdioClientTransport({
      command: "bun", args: ["run", join(import.meta.dir, "mcp.ts")], cwd: dir,
      env: { ...common, EMBERVY_APP_DATA_DIR: join(dir, "mcp-data"), EMBERVY_HOME: dir }, stderr: "ignore",
    }));
  }, 30_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    server?.kill();
    for (const room of rooms) room.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists only room names behind the internal bearer", async () => {
    expect((await fetch(`${base}/api/internal/room`)).status).toBe(401);
    const res = await fetch(`${base}/api/internal/room`, { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rooms: names });
  });

  test("requires a known room when several are open", async () => {
    for (const room of [undefined, "Unknown", "", 42]) {
      const before = sent.length;
      const res = await fetch(`${base}/api/internal/room/send`, {
        method: "POST", headers, body: JSON.stringify({ text: "hello", room }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "choose a room by name", rooms: names });
      expect(sent.length).toBe(before);
    }
  });

  test("sends to either named room with its own member key", async () => {
    for (const [index, room] of names.entries()) {
      const res = await fetch(`${base}/api/internal/room/send`, {
        method: "POST", headers, body: JSON.stringify({ text: `hello ${room}`, room, reply_to: `room-new-${index}` }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, id: `sent-${index}`, room });
      expect(sent.at(-1)).toEqual({ room: index, body: { text: `hello ${room}`, reply_to: `new-${index}` } });
    }
  });

  test("the multi-room tool requires an enum and forwards the selected room", async () => {
    const tool = (await client.listTools()).tools.find(tool => tool.name === "room")!;
    expect(tool.inputSchema.required).toEqual(["text", "room"]);
    expect(tool.inputSchema.properties?.room).toEqual({ type: "string", enum: names, description: "The room the message came from" });
    for (const name of names) {
      expect(tool.description).toContain(`"${name}"`);
      expect(tool.description).toContain(`[${name}/Name]`);
    }
    const result: any = await client.callTool({ name: "room", arguments: { text: "work reply", room: "Work" } });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("Sent to Work (id sent-1)");
    expect(sent.at(-1)).toEqual({ room: 1, body: { text: "work reply" } });
    const missing: any = await client.callTool({ name: "room", arguments: { text: "no room" } });
    expect(missing.isError).toBe(true);
  });

  test("polls rooms from separate persisted cursors and retains the first state file", async () => {
    for (let i = 0; i < 150 && (!polls[0].length || !polls[1].length); i++) await Bun.sleep(100);
    // The request can arrive before the app has appended its response.
    let lines: any[] = [];
    for (let i = 0; i < 100; i++) {
      try { lines = readFileSync(join(dataDir, "inbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch {}
      if (lines.length === 2) break;
      await Bun.sleep(50);
    }
    expect(polls[0][0]).toBe(cursors[0]);
    expect(polls[1][0]).toBe(cursors[1]);
    expect(lines.map(line => line.room).sort()).toEqual([...names].sort());
    expect(lines.every(line => line.source === "room" && line.from === "Sam" && line.text === `[${line.room}/Sam] new in ${line.room}`)).toBe(true);
    expect(lines.find(line => line.room === "Family").id).toBe("room-new-0");
    const workEntry = lines.find(line => line.room === "Work");
    expect(workEntry.id).toBe(roomMessagePrefix("Work") + "new-1");
    const reply: any = await client.callTool({ name: "room", arguments: { room: "Work", text: "reply to work", reply_to: workEntry.id } });
    expect(reply.isError).toBeFalsy();
    expect(sent.at(-1)).toEqual({ room: 1, body: { text: "reply to work", reply_to: "new-1" } });
    for (const [index, file] of ["room-state.json", "room-state-Work.json"].entries()) {
      expect(JSON.parse(readFileSync(join(dataDir, file), "utf8"))).toEqual({ after: next[index], seen: [`old-${index}`, `new-${index}`] });
    }
  }, 20_000);
});
