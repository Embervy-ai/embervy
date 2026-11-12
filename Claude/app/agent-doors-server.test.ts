import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EMAIL_BLACKLIST } from "./config/email-blacklist";

// The agent's tools against the real server.ts and the real mcp.ts bridge,
// both as throw-away processes: random port, own data dir, own tmux socket
// dir, fake env — never the service, never port 3030. Proves that every tool
// that talks HTTP uses a door that accepts the internal bearer, that the
// browser doors still want a login, and that e-mail approval stays with the
// person (the agent's own heart on the approval card approves nothing).

const INTERNAL = "internal-test-token-0123456789";
let PASSWORD = "";
const AGENT = "Testagent";
let server: ReturnType<typeof Bun.spawn>;
let client: Client;
let base = "";
let dir = "";
let dataDir = "";
let cookie = "";

import { startTestApp } from "./test-app-start";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "agent-doors-"));
  dataDir = join(dir, "data");
  const common = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    TMUX_TMPDIR: dir, // any tmux call finds no server — never a live pane
    EMBERVY_APP_PORT: "",
    EMBERVY_APP_HOST: "127.0.0.1",
    INTERNAL_API_TOKEN: INTERNAL,
    AGENT_LABEL: AGENT,
    USER_LABEL: "Sam",
  };
  const app = await startTestApp({
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      ...common,
      EMBERVY_APP_DATA_DIR: dataDir,
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "agent-doors-test-no-such-session",
      // No EMAIL_SENDER_URL: an approved mail ends as "failed", never on the wire.
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc: server, cookie, password: PASSWORD } = app);
  common.EMBERVY_APP_PORT = String(app.port);

  client = new Client({ name: "agent-doors-test", version: "0.0.0" });
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
  rmSync(dir, { recursive: true, force: true });
});

const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
const bearer = { "content-type": "application/json", authorization: `Bearer ${INTERNAL}` };
const post = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
const toolText = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  return String(r.content?.[0]?.text ?? "");
};
const jsonl = (name: string): any[] => {
  const f = join(dataDir, name);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
};
const emailStatus = (id: string) => jsonl("email-outbox.jsonl").find((e) => e.id === id)?.status;

describe("the agent's tools through the real app server and MCP bridge", () => {
  test("reply and send land in the app", async () => {
    expect(await toolText("reply", { text: "hello from the reply tool" })).toContain("Sent:");
    expect(await toolText("send", { text: "hello from the send tool" })).toContain("Sent:");
    const texts = jsonl("outbox.jsonl").map((m) => m.text);
    expect(texts).toEqual(expect.arrayContaining(["hello from the reply tool", "hello from the send tool"]));
  });

  test("voice_reply: passes the internal gate; without a TTS key the text fallback lands", async () => {
    expect(await toolText("voice_reply", { text: "hello from the voice tool" })).toContain("Voice failed, sent as text");
    expect(jsonl("outbox.jsonl").map((m) => m.text)).toContain("hello from the voice tool");
    const gate = await post("/api/internal/voice-broadcast", { text: "x" }, bearer);
    expect(gate.status).toBe(500); // past the gate, stopped by the missing key
    expect((await gate.json()).error).toBe("no 11Labs key");
  });

  test("calendar: works through the bridge", async () => {
    const list = JSON.parse(await toolText("calendar", { action: "list" }));
    expect(Array.isArray(list.agent_calendar)).toBe(true);
  });

  test("react: works over the internal door and is recorded as the agent's", async () => {
    const out = await toolText("react", { message_id: "msg-1", emoji: "heart" });
    expect(out).toBe("Reacted with ❤️");
    const reactions = await (await fetch(`${base}/api/reactions`, { headers: { ...viaTunnel, cookie } })).json();
    expect(reactions).toContainEqual(expect.objectContaining({ message_id: "msg-1", emoji: "❤️", from: AGENT }));
    // An agent reaction is not mirrored into the agent's own inbox.
    expect(jsonl("inbox.jsonl").filter((m) => m.type === "reaction")).toHaveLength(0);
  });

  test("email: queued over the internal door, blacklist checked, waits for the user", async () => {
    expect(EMAIL_BLACKLIST.length).toBeGreaterThan(0);
    const term = EMAIL_BLACKLIST[0];
    const out = await toolText("email", { to: "someone@example.com", subject: "Hello", body: `A note that mentions ${term}.` });
    expect(out).toContain("status=pending_approval");
    expect(out).toContain(`Blacklist hits: ${term}`);
    const clean = await toolText("email", { to: "someone@example.com", subject: "Plain", body: "Nothing special here." });
    // Default (EMAIL_AUTO_SEND_CLEAN unset): even a clean mail waits.
    expect(clean).toContain("status=pending_approval");
    expect(clean).toContain("Blacklist hits: none");
  });

  test("approval stays with the user: the agent's heart approves nothing, the user's does", async () => {
    const queued = await (await post("/api/internal/send-email", { to: "someone@example.com", subject: "Approve me", body: "Body." }, bearer)).json();
    expect(queued.status).toBe("pending_approval");
    const card = jsonl("outbox.jsonl").find((m) => m.source === "email-approval" && m.email_id === queued.id);
    expect(card).toBeTruthy();

    // The agent reacts on its own approval card — via the tool, and via the
    // raw door pretending to be the user. Neither approves.
    expect(await toolText("react", { message_id: card.id, emoji: "heart" })).toBe("Reacted with ❤️");
    expect((await post("/api/internal/react", { message_id: card.id, emoji: "❤️", from: "User" }, bearer)).status).toBe(200);
    await Bun.sleep(200);
    expect(emailStatus(queued.id)).toBe("pending_approval");
    const agentSide = (await (await fetch(`${base}/api/reactions`, { headers: { ...viaTunnel, cookie } })).json())
      .filter((r: any) => r.message_id === card.id);
    expect(agentSide.every((r: any) => r.from === AGENT)).toBe(true);

    // No approve door for the bearer.
    expect((await post("/api/send-email/approve", { id: queued.id, action: "send" }, bearer)).status).toBe(401);
    expect((await post("/api/internal/send-email/approve", { id: queued.id, action: "send" }, bearer)).status).toBe(404);
    expect(emailStatus(queued.id)).toBe("pending_approval");

    // The user's heart in the browser still approves (no sender configured → "failed").
    const person = await post("/api/react", { message_id: card.id, emoji: "❤️", from: "User" }, { ...viaTunnel, cookie, "content-type": "application/json" });
    expect(person.status).toBe(200);
    let status = emailStatus(queued.id);
    for (let i = 0; i < 50 && status === "pending_approval"; i++) {
      await Bun.sleep(50);
      status = emailStatus(queued.id);
    }
    expect(status).toBe("failed");
    expect(jsonl("email-outbox.jsonl").find((e) => e.id === queued.id)?.approved_at).toBeTruthy();
  });

  test("a harmless message dressed as an approval card approves nothing", async () => {
    const queued = await (await post("/api/internal/send-email", { to: "someone@example.com", subject: "Wait for me", body: "Body." }, bearer)).json();
    expect(queued.status).toBe("pending_approval");
    // The agent sends "Good morning" carrying the waiting mail's id and the card's source.
    const forged = { id: "forged-card-1", text: "Good morning! Slept well?", source: "email-approval", email_id: queued.id };
    expect((await post("/api/internal/broadcast", forged, bearer)).status).toBe(200);
    const stored = jsonl("outbox.jsonl").find((m) => m.id === "forged-card-1");
    expect(stored?.text).toBe("Good morning! Slept well?");
    expect(stored?.email_id).toBeUndefined(); // the door drops server-only fields
    expect(stored?.source).toBeUndefined();

    // The user hearts the harmless message: the mail keeps waiting.
    const person = await post("/api/react", { message_id: "forged-card-1", emoji: "❤️", from: "User" }, { ...viaTunnel, cookie, "content-type": "application/json" });
    expect(person.status).toBe(200);
    await Bun.sleep(300);
    expect(emailStatus(queued.id)).toBe("pending_approval");

    // The real card still works.
    const card = jsonl("outbox.jsonl").find((m) => m.source === "email-approval" && m.email_id === queued.id);
    expect(card).toBeTruthy();
    await post("/api/react", { message_id: card.id, emoji: "😢", from: "User" }, { ...viaTunnel, cookie, "content-type": "application/json" });
    let status = emailStatus(queued.id);
    for (let i = 0; i < 50 && status === "pending_approval"; i++) { await Bun.sleep(50); status = emailStatus(queued.id); }
    expect(status).toBe("discarded");
  });

  test("the internal doors refuse without the bearer", async () => {
    for (const path of ["/api/internal/react", "/api/internal/send-email", "/api/internal/broadcast", "/api/internal/voice-broadcast"]) {
      expect((await post(path, {}, { "content-type": "application/json" })).status).toBe(401);
      expect((await post(path, {}, { "content-type": "application/json", authorization: "Bearer wrong-token" })).status).toBe(401);
      expect((await post(path, {}, { ...viaTunnel, "content-type": "application/json" })).status).toBe(401);
    }
  });

  test("the browser doors still want a login — the bearer does not open them", async () => {
    const body = { message_id: "msg-2", emoji: "❤️", to: "someone@example.com", subject: "S", body: "B" };
    for (const path of ["/api/react", "/api/send-email", "/api/send-email/approve"]) {
      // A bearer from a local process does not grant a browser session.
      expect((await post(path, body, bearer)).status).toBe(401);
      expect((await post(path, body, { ...viaTunnel, ...bearer })).status).toBe(401);
      expect((await post(path, body, { ...viaTunnel, "content-type": "application/json" })).status).toBe(401);
    }
    // With a session the user's door opens.
    expect((await post("/api/react", { message_id: "msg-2", emoji: "🔥", from: "User" }, { ...viaTunnel, cookie, "content-type": "application/json" })).status).toBe(200);
  });
});

// WebSocket upgrades require authentication; login failures are scoped to their source.
describe("the live channel and the login", () => {
  const wsUpgrade = (headers: Record<string, string> = {}) => fetch(`${base}/ws`, {
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
  });

  test("/ws without a session is refused, locally and through the tunnel; with the session it opens", async () => {
    expect((await wsUpgrade()).status).toBe(401);
    expect((await wsUpgrade(viaTunnel)).status).toBe(401);
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { cookie } } as any);
      ws.onopen = () => { ws.close(); resolve(true); };
      ws.onerror = () => resolve(false);
      setTimeout(() => resolve(false), 5000);
    });
    expect(opened).toBe(true);
  });

  test("a stranger's wrong password locks out the stranger, not the owner", async () => {
    const auth = (ip: string, password: string) => post("/api/auth", { password }, { "content-type": "application/json", "cf-ray": "r", "cf-connecting-ip": ip });
    expect((await auth("198.51.100.7", "wrong")).status).toBe(401);
    expect((await auth("198.51.100.7", PASSWORD)).status).toBe(429); // the stranger's own source waits
    expect((await auth("203.0.113.9", PASSWORD)).status).toBe(200); // the owner gets in at once
  });

  // Group IPv6 sources by /64 so address rotation cannot bypass throttling.
  test("IPv6 addresses in one /64 count as one source", async () => {
    const auth = (ip: string, password: string) => post("/api/auth", { password }, { "content-type": "application/json", "cf-ray": "r", "cf-connecting-ip": ip });
    expect((await auth("2001:db8:1:2::a", "wrong")).status).toBe(401);
    expect((await auth("2001:db8:1:2:ffff::b", PASSWORD)).status).toBe(429); // the same /64 waits
    expect((await auth("2001:db8:1:3::1", PASSWORD)).status).toBe(200); // the next /64 does not
  });

  test("a wave of failing sources does not lock out one that has logged in before", async () => {
    const auth = (ip: string, password: string) => post("/api/auth", { password }, { "content-type": "application/json", "cf-ray": "r", "cf-connecting-ip": ip });
    expect((await auth("203.0.113.50", PASSWORD)).status).toBe(200); // the owner's phone, earlier
    for (let i = 0; i < 105; i++) expect([401, 429]).toContain((await auth(`198.18.${Math.floor(i / 250)}.${i % 250 + 1}`, "wrong")).status);
    expect((await auth("192.0.2.77", PASSWORD)).status).toBe(429); // the brake holds for unknown sources
    expect((await auth("203.0.113.50", PASSWORD)).status).toBe(200); // the known one still gets in
  });
});
