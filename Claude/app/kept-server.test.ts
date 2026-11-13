import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startTestApp } from "./test-app-start";

const saidAt = "2024-04-12T09:30:00+02:00";
const original = { id: "source-1", text: "Original **passage**.\n\n```sh\necho sample\n```", ts: saidAt };
const agentMessage = { id: "source-2", text: "An agent passage.", ts: "2024-04-12T10:30:00Z" };

async function house() {
  const dir = mkdtempSync(join(tmpdir(), "kept-server-"));
  const data = join(dir, "data");
  mkdirSync(join(data, "images"), { recursive: true });
  writeFileSync(join(data, "inbox.jsonl"), JSON.stringify(original) + "\n");
  writeFileSync(join(data, "outbox.jsonl"), JSON.stringify(agentMessage) + "\n");
  const internal = crypto.randomUUID();
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMUX_TMPDIR: dir,
    EMBERVY_HOME: dir, EMBERVY_APP_DATA_DIR: data,
    EMBERVY_TMUX_SESSION: `test-${crypto.randomUUID()}`, EMBERVY_TERMINAL_PANEL: "0",
    EMBERVY_TRUST_SAME_HOST: "true", INTERNAL_API_TOKEN: internal,
    APP_SESSION_SECRET: crypto.randomUUID(), AGENT_LABEL: "Agent", USER_LABEL: "Person",
  };
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let client: Client | undefined;
  try { app = await startTestApp({ cwd: dir, env }); }
  catch (error) { rmSync(dir, { recursive: true, force: true }); throw error; }
  const request = (path: string, method = "GET", body?: unknown, auth: "human" | "agent" | "none" = "human") => fetch(`${app.base}${path}`, {
    method, redirect: "manual", headers: {
      "content-type": "application/json",
      ...(auth === "human" ? { cookie: app.cookie } : auth === "agent" ? { authorization: `Bearer ${internal}` } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const list = async () => {
    const response = await request("/api/kept");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    return response.json() as Promise<any[]>;
  };
  return {
    dir, data, request, list,
    async bridge() {
      client = new Client({ name: "kept-test", version: "0.0.0" });
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: ["run", join(import.meta.dir, "mcp.ts")], cwd: dir,
        env: { ...env, EMBERVY_APP_DATA_DIR: join(dir, "bridge-data"), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(app.port) },
        stderr: "ignore",
      }));
      return client;
    },
    async restart() {
      await client?.close(); client = undefined;
      app.proc.kill("SIGKILL"); await app.proc.exited;
      app = await startTestApp({ cwd: dir, env });
    },
    async close() {
      await client?.close().catch(() => {});
      app.proc.kill("SIGKILL"); await app.proc.exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("keeping an ID copies only server history and survives history eviction and restart", async () => {
  const h = await house();
  try {
    const response = await h.request("/api/kept", "POST", {
      message_id: original.id, text: "Forged text", speaker: "agent", said_at: "2000-01-01T00:00:00Z",
      added_by: "agent", audio_url: "https://example.invalid/voice.mp3", id: "forged-id",
    });
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved).toMatchObject({ text: original.text, speaker: "person", said_at: saidAt, added_by: "person", message_id: original.id });
    expect(saved.id).not.toBe(original.id);
    expect(saved.id).not.toBe("forged-id");
    expect(saved.audio_url).toBeUndefined();
    expect(Date.parse(saved.kept_at)).toBeGreaterThan(0);
    const duplicate = await h.request("/api/kept", "POST", { message_id: original.id });
    expect((await duplicate.json()).id).toBe(saved.id);
    expect(await h.list()).toHaveLength(1);
    expect((await h.request("/api/kept", "POST", { message_id: "unknown" })).status).toBe(404);
    expect((await h.request("/api/kept", "POST", { text: "No identifier" })).status).toBe(400);
    appendFileSync(join(h.data, "inbox.jsonl"), JSON.stringify({ id: "too-long", text: "x".repeat(20_001), ts: saidAt }) + "\n");
    const tooLong = await h.request("/api/kept", "POST", { message_id: "too-long", text: "Short forged text" });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).code).toBe("tooLong");
    expect(await h.list()).toHaveLength(1);

    for (let i = 0; i < 201; i++) appendFileSync(join(h.data, "inbox.jsonl"), JSON.stringify({ id: `later-${i}`, text: "Later message", ts: new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString() }) + "\n");
    const visible = await (await h.request("/api/messages")).json();
    expect(visible.some((message: any) => message.id === original.id)).toBe(false);
    expect((await h.request("/api/kept", "POST", { message_id: original.id })).status).toBe(404);
    expect((await h.list())[0]).toEqual(saved);
    expect(statSync(join(h.data, "kept.json")).mode & 0o777).toBe(0o600);
    await h.restart();
    expect(await h.list()).toEqual([saved]);
    expect(statSync(join(h.data, "kept.json")).mode & 0o777).toBe(0o600);
  } finally { await h.close(); }
}, 40_000);

test("removal affects exactly one entry and keeps persisted copies independent", async () => {
  const h = await house();
  try {
    const first = await (await h.request("/api/kept", "POST", { message_id: original.id })).json();
    const second = await (await h.request("/api/kept", "POST", { message_id: agentMessage.id })).json();
    expect(second.speaker).toBe("agent");
    expect(second.added_by).toBe("person");
    expect((await h.request(`/api/kept/${first.id}`, "DELETE")).status).toBe(200);
    expect(await h.list()).toEqual([second]);
    expect((await h.request(`/api/kept/${first.id}`, "DELETE")).status).toBe(404);
    await h.restart();
    expect(await h.list()).toEqual([second]);
    expect(readFileSync(join(h.data, "inbox.jsonl"), "utf8")).toBe(JSON.stringify(original) + "\n");
  } finally { await h.close(); }
}, 40_000);

test("neither local trust nor the agent token can list, keep by ID or remove personal entries", async () => {
  const h = await house();
  try {
    const saved = await (await h.request("/api/kept", "POST", { message_id: original.id })).json();
    for (const auth of ["none", "agent"] as const) {
      expect((await h.request("/api/kept", "GET", undefined, auth)).status).toBe(401);
      expect((await h.request("/api/kept", "POST", { message_id: original.id }, auth)).status).toBe(401);
      expect((await h.request(`/api/kept/${saved.id}`, "DELETE", undefined, auth)).status).toBe(401);
    }
    const args = { text: "Agent copy", said_at: saidAt, speaker: "person", added_by: "person", message_id: original.id };
    expect((await h.request("/api/internal/keep", "POST", args, "none")).status).toBe(401);
    expect((await h.request("/api/internal/keep", "POST", args, "human")).status).toBe(401);
    const result = await h.request("/api/internal/keep", "POST", args, "agent");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect((await h.request("/api/internal/keep", "GET", undefined, "agent")).status).toBe(404);
    expect((await h.request(`/api/internal/keep/${saved.id}`, "DELETE", undefined, "agent")).status).toBe(404);
    const entries = await h.list();
    expect(entries).toHaveLength(2);
    expect(entries.find(entry => entry.text === args.text)).toMatchObject({ added_by: "agent", speaker: "person", said_at: saidAt });
    expect(entries.find(entry => entry.text === args.text).message_id).toBeUndefined();
  } finally { await h.close(); }
}, 30_000);

test("the MCP add_to_kept tool appends unchanged text and refuses invalid input and a full list", async () => {
  const h = await house();
  try {
    const client = await h.bridge();
    const tools = await client.listTools();
    expect(tools.tools.some(tool => tool.name === "keep")).toBe(false);
    const tool = tools.tools.find(tool => tool.name === "add_to_kept")!;
    expect(tool).toBeDefined();
    expect(tool.description).toStartWith("Entries go into the person's Kept list in the app, not into the agent's memory.");
    expect(tool.inputSchema.required).toEqual(["text", "said_at", "speaker"]);
    expect(tools.tools.some(tool => /^(list_kept|remove_kept)$/.test(tool.name))).toBe(false);
    const text = "An exact older passage.\n\n```text\nkeep whitespace\n```";
    const result: any = await client.callTool({ name: "add_to_kept", arguments: { text, said_at: saidAt, speaker: "agent" } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result)).not.toContain(text);
    expect((await h.list())[0]).toMatchObject({ text, said_at: saidAt, speaker: "agent", added_by: "agent" });
    for (const arguments_ of [
      { text: "x".repeat(20_001), said_at: saidAt, speaker: "person" },
      { text: "x", said_at: "2024-02-30T10:00:00Z", speaker: "person" },
      { text: "x", said_at: saidAt, speaker: "user" },
      { said_at: saidAt, speaker: "person" },
    ]) {
      const rejected: any = await client.callTool({ name: "add_to_kept", arguments: arguments_ });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0].text.length).toBeGreaterThan(10);
    }
    expect(await h.list()).toHaveLength(1);
    for (let i = 1; i < 200; i++) {
      const response = await h.request("/api/internal/keep", "POST", { text: `Passage ${i}`, said_at: saidAt, speaker: "person" }, "agent");
      expect(response.status).toBe(200);
    }
    const full: any = await client.callTool({ name: "add_to_kept", arguments: { text: "One too many", said_at: saidAt, speaker: "person" } });
    expect(full.isError).toBe(true);
    expect(full.content[0].text).toContain("200");
    const personFull = await h.request("/api/kept", "POST", { message_id: original.id });
    expect(personFull.status).toBe(409);
    expect((await personFull.json()).code).toBe("full");
    expect(await h.list()).toHaveLength(200);
    expect(readFileSync(join(h.data, "inbox.jsonl"), "utf8")).toBe(JSON.stringify(original) + "\n");
    expect(readFileSync(join(h.data, "outbox.jsonl"), "utf8")).toBe(JSON.stringify(agentMessage) + "\n");
    expect(existsSync(join(h.data, "reactions-inbox.jsonl"))).toBe(false);
  } finally { await h.close(); }
}, 40_000);

test("only existing locally held recordings are copied and their text survives deletion", async () => {
  const h = await house();
  try {
    writeFileSync(join(h.data, "images", "voice-1.webm"), "audio fixture");
    for (const [id, audio_url] of [["voice-1", "/api/images/voice-1.webm"], ["voice-2", "https://example.invalid/voice.mp3"], ["voice-3", "/api/images/missing.mp3"]]) {
      appendFileSync(join(h.data, "inbox.jsonl"), JSON.stringify({ id, text: "A transcript", ts: saidAt, type: "voice", audio_url }) + "\n");
      const response = await h.request("/api/kept", "POST", { message_id: id });
      expect(response.status).toBe(200);
      const entry = await response.json();
      expect(entry.audio_url).toBe(id === "voice-1" ? audio_url : undefined);
    }
    rmSync(join(h.data, "images", "voice-1.webm"));
    const entry = (await h.list()).find(entry => entry.message_id === "voice-1");
    expect(entry.text).toBe("A transcript");
    expect(entry.audio_url).toBe("/api/images/voice-1.webm");
    expect((await h.request(entry.audio_url)).status).toBe(404);
  } finally { await h.close(); }
}, 30_000);
