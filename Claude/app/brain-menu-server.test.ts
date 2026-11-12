import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainMenuCommand, shapeBrainHeads } from "./brain-menu";
import { isForeignEntry, readInbox } from "../../Brain/app-channel";
import { JsonlHistory } from "./jsonl-history";
import { cleanReplyTo } from "./message-fields";

// Isolate the production handler so forwarding checks do not depend on house startup.
test("heads handler forwards only refresh=1, authenticates upstream, and tolerates optional metadata", async () => {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const start = source.indexOf('app.get("/api/brain/heads"');
  const end = source.indexOf('app.post("/api/brain/command"', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  let handler: Function | undefined;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let upstream: unknown = { current: { head: "claude", model: "opus" }, heads: [] };
  const token = "test-control-token";
  const control = { port: 3910, token, bridge: { mode: "turns", count: 40 } };
  const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  new Function("app", "claudeCodeCutAvailable", "BRAIN_HARNESS", "readBrainControl", "fetch", "BRAIN_HEADS_TIMEOUT_MS", "shapeBrainHeads", "S", compiled)(
    { get: (_path: string, fn: Function) => { handler = fn; } },
    () => false, true, () => control,
    async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(upstream); },
    25_000, shapeBrainHeads, (key: string) => key,
  );
  const baseline = shapeBrainHeads(upstream);
  for (const [query, suffix] of [
    ["", ""], ["?refresh=1", "?refresh=1"], ["?refresh=1&foreign=1", "?refresh=1"],
    ["?foreign=1", ""], ["?refresh=0", ""], ["?refresh=true", ""], ["?refresh=", ""],
    ["?refresh=1%26foreign%3D1", ""], ["?refresh=1&refresh=foreign", "?refresh=1"],
  ]) {
    for (const extra of [{}, { futureCatalogTimestamp: "2026-01-02T03:04:05.000Z" }]) {
      upstream = { current: { head: "claude", model: "opus" }, heads: [], ...extra };
      const headers: Record<string, string> = {};
      const params = new URLSearchParams(query);
      const result = await handler!({
        req: { query: (key: string) => params.get(key) ?? undefined },
        header: (key: string, value: string) => { headers[key] = value; },
        json: (body: unknown) => body,
      });
      const call = calls.at(-1)!;
      expect(call.url).toBe(`http://127.0.0.1:3910/heads${suffix}`);
      expect(call.init.headers).toEqual({ Authorization: `Bearer ${token}` });
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(result).toEqual({ ...baseline, bridge: control.bridge });
      expect(headers["Cache-Control"]).toBe("no-store");
    }
  }
  expect(calls).toHaveLength(18);
});


// Exercise the production routes and durable history without requiring an HTTP framework at startup.
function commandRoutes(dataDir: string) {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const section = (from: string, to: string) => {
    const start = source.indexOf(from);
    const end = source.indexOf(to, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };
  const code = [
    section("async function deliverChatMessage(", "const GPT_MODELS:"),
    section("function sanitizeMessageForClient(", "const memoryMedia ="),
    section("const inboxHistory =", 'app.post("/api/push/subscribe"'),
    section('app.post("/api/brain/command"', "const VOICE_ID_RE ="),
  ].join("\n");
  const routes = new Map<string, Function>();
  const register = (path: string, handler: Function) => routes.set(path, handler);
  new Function("deps", `
    const { app, appendFileSync, INBOX, OUTBOX, JsonlHistory, brainMenuCommand, cleanReplyTo } = deps;
    const BRAIN_HARNESS = true;
    const claudeCodeCutAvailable = () => false;
    const generateId = () => crypto.randomUUID();
    const S = key => key;
    const process = { stderr: { write() {} } };
    ${new Bun.Transpiler({ loader: "ts" }).transformSync(code)}
  `)({
    app: { get: register, post: register }, appendFileSync,
    INBOX: join(dataDir, "inbox.jsonl"), OUTBOX: join(dataDir, "outbox.jsonl"),
    JsonlHistory, brainMenuCommand, cleanReplyTo,
  });
  return (path: string, body?: unknown) => routes.get(path)!({
    req: { json: async () => body },
    json: (body: any, status = 200) => ({ status, body }),
  });
}

test("menu commands reach Brain once but only assistant replies and typed commands appear in reloaded history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "menu-history-"));
  try {
    const call = commandRoutes(dir);
    const inbox = join(dir, "inbox.jsonl");
    let cursor = { offset: 0, seen: [] as string[] };
    const cases: Array<[unknown, string]> = [
      [{ action: "restart" }, "/respawn"],
      [{ action: "switch", head: "gpt", model: "model", move: true }, "/move gpt model"],
      [{ action: "switch", head: "gpt", model: "model", move: false }, "/head gpt model"],
      [{ action: "effort", level: "high" }, "/effort high"],
      [{ action: "effort", level: "default" }, "/effort default"],
    ];
    for (const [body, command] of cases) {
      const before = call("/api/messages").body;
      const response = await call("/api/brain/command", body);
      expect(response.status).toBe(200);
      expect(response.body.command).toBe(command);
      const delivered = readInbox(inbox, cursor);
      expect(delivered.entries).toEqual([{
        id: response.body.id, ts: response.body.ts, type: "text", text: command,
        ui_origin: "brain-menu", repeat_count: 1,
      }]);
      expect(isForeignEntry(delivered.entries[0]!)).toBe(false);
      cursor = delivered.cursor;
      expect(readInbox(inbox, cursor).entries).toEqual([]);
      expect(call("/api/messages").body).toEqual(before);
      expect(commandRoutes(dir)("/api/messages").body).toEqual(before);

      const typed = await call("/api/message", { text: command, ui_origin: "brain-menu" });
      expect(typed.status).toBe(200);
      const typedEntry = readInbox(inbox, cursor);
      expect(typedEntry.entries).toHaveLength(1);
      expect(typedEntry.entries[0]!.ui_origin).toBeUndefined();
      cursor = typedEntry.cursor;
      const visible = call("/api/messages").body;
      expect(visible.filter((m: any) => m.id === typed.body.id)).toEqual([
        expect.objectContaining({ role: "user", text: command }),
      ]);
      expect(commandRoutes(dir)("/api/messages").body).toEqual(visible);
    }
    const cut = await call("/api/message", { text: "/cut" });
    expect(call("/api/messages").body.find((m: any) => m.id === cut.body.id)).toMatchObject({ role: "user", text: "/respawn" });
    const reply = { id: crypto.randomUUID(), ts: new Date().toISOString(), type: "send", text: "Session ready." };
    appendFileSync(join(dir, "outbox.jsonl"), JSON.stringify(reply) + "\n");
    const expected = call("/api/messages").body;
    expect(expected.filter((m: any) => m.role === "assistant")).toEqual([{ ...reply, role: "assistant" }]);
    expect(expected.filter((m: any) => m.role === "user")).toHaveLength(cases.length + 1);
    expect(expected.some((m: any) => m.ui_origin === "brain-menu")).toBe(false);
    expect(commandRoutes(dir)("/api/messages").body).toEqual(expected);
    expect(call("/api/messages").body).toEqual(expected);
    expect(readInbox(inbox, { offset: 0, seen: [] }).entries).toHaveLength(cases.length * 2 + 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("menu controls do not displace typed messages from the bounded history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "menu-window-"));
  try {
    const call = commandRoutes(dir);
    const typed = await call("/api/message", { text: "/respawn" });
    const before = call("/api/messages").body;
    expect(before).toHaveLength(1);
    expect(before[0].id).toBe(typed.body.id);
    for (let i = 0; i < 201; i++) {
      expect((await call("/api/brain/command", { action: "restart" })).status).toBe(200);
    }
    expect(call("/api/messages").body).toEqual(before);
    expect(commandRoutes(dir)("/api/messages").body).toEqual(before);
    expect(readInbox(join(dir, "inbox.jsonl"), { offset: 0, seen: [] }).entries).toHaveLength(202);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const INTERNAL = "internal-test-token-0123456789";
const PASSWORD = "test-password-not-real";
const CONTROL_TOKEN = "control-token-for-tests-0123456789abcdef";
const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };

const HEADS = {
  current: { head: "claude", model: "claude-opus-5-5[1m]", transport: "pipe", effort: "high", effortApplied: "high", effortVia: "cli", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh", "max"] },
  claudeCatalog: true,
  heads: [
    { name: "claude", label: "Claude", model: "claude-opus-5-5[1m]", available: true, reason: null, models: [
      { id: "claude-opus-5-5[1m]", label: "Default (recommended)", group: "catalog", family: "Opus", version: "Opus 5.5 (1M)", aliases: ["default"] },
      { id: "claude-sonnet-5", label: "Sonnet", group: "catalog", family: "Sonnet", version: "Sonnet 5" },
    ] },
    { name: "gpt", label: "ChatGPT", model: "gpt-5.6-terra", available: true, reason: null, models: [
      { id: "gpt-5.6-terra", label: "gpt-5.6-terra", group: "catalog", family: "Terra", version: "gpt-5.6-terra" },
    ] },
    { name: "grok", label: "Grok", model: "grok-4.7", available: false, reason: "XAI_API_KEY is not set", models: [] },
  ],
};

interface FakeBrain { port: number; asked: () => string[]; mode: (m: "ok" | "garbage" | "missing") => void; stop: () => void }
function fakeBrain(): FakeBrain {
  const seen: string[] = [];
  let mode: "ok" | "garbage" | "missing" = "ok";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      seen.push(`${req.method} ${url.pathname}${url.search} ${req.headers.get("authorization") ?? "-"}`);
      if (mode === "missing" || req.method !== "GET" || url.pathname !== "/heads") return new Response("not found", { status: 404 });
      if (req.headers.get("authorization") !== `Bearer ${CONTROL_TOKEN}`) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
      return mode === "garbage" ? new Response("not json", { status: 200 }) : Response.json(HEADS);
    },
  });
  return { port: server.port, asked: () => [...seen], mode: (m) => { mode = m; }, stop: () => server.stop(true) };
}

import { startTestApp, testPort } from "./test-app-start";

interface House {
  dataDir: string;
  brainEnv: string;
  call: (method: string, path: string, opts?: { auth?: "cookie" | "bearer" | "none" | "wrong"; body?: unknown }) => Promise<{ status: number; body: any; headers: Headers; raw: string }>;
  inbox: () => any[];
  calls: () => string;
  cuts: () => any[];
  outbox: () => any[];
  restart: () => Promise<void>;
  stop: () => void;
}

async function startHouse(env: Record<string, string>, brainEnvText: string, houseEnvText = ""): Promise<House> {
  const dir = mkdtempSync(join(tmpdir(), "brain-menu-"));
  const dataDir = join(dir, "data");
  const binDir = join(dir, "bin");
  const callsLog = join(dir, "calls.log");
  const brainEnv = join(dir, "brain.env");
  mkdirSync(binDir, { recursive: true });
  const home = join(dir, "embervy-home");
  mkdirSync(join(home, "Claude/app"), { recursive: true });
  writeFileSync(join(home, ".env"), houseEnvText);
  writeFileSync(join(home, "Claude/app/.env"), "CUT_FIXTURE_VALUE=app-value\n");
  writeFileSync(brainEnv, brainEnvText);
  for (const name of ["pgrep", "pkill", "setsid", "tmux"]) {
    const file = join(binDir, name);
    writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\nexit 0\n`);
    chmodSync(file, 0o755);
  }
  writeFileSync(join(binDir, "setsid"), `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['STUB_LOG'], 'a') as f: f.write('setsid '+ ' '.join(sys.argv[1:])+'\\n')
with open(os.environ['STUB_LOG']+'.cuts', 'a') as f:
    f.write(json.dumps({'argv':sys.argv[1:], 'home':os.environ.get('EMBERVY_HOME'), 'userHome':os.environ.get('HOME'), 'socket':os.environ.get('EMBERVY_TMUX_SOCKET'), 'project':os.environ.get('CLAUDE_PROJECT_DIR'), 'pattern':os.environ.get('CLAUDE_PROCESS_PATTERN'), 'config':os.environ.get('CUT_FIXTURE_VALUE')})+'\\n')
`);
  const startOptions = {
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: dir,
      TMUX_TMPDIR: dir,
      STUB_LOG: callsLog,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: dataDir,
      EMBERVY_HOME: join(dir, "embervy-home"),
      EMBERVY_STRINGS_LOCAL: join(dir, "no-such-strings.local.json"),
      BRAIN_ENV_FILE: brainEnv,
      INTERNAL_API_TOKEN: INTERNAL,
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "brain-menu-test-no-such-session",
      ...env,
    },
    stdout: "ignore" as const,
    stderr: "ignore" as const,
  };
  let { base, proc: server, cookie } = await startTestApp(startOptions);

  return {
    dataDir,
    brainEnv,
    call: async (method, path, opts = {}) => {
      const auth = opts.auth ?? "cookie";
      // Every request comes "through the tunnel": no same-host trust, ever.
      const headers: Record<string, string> = { ...viaTunnel, "content-type": "application/json" };
      if (auth === "cookie") headers.cookie = cookie;
      if (auth === "bearer") headers.authorization = `Bearer ${INTERNAL}`;
      if (auth === "wrong") headers.authorization = "Bearer not-the-internal-token";
      const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
      const raw = await res.text();
      let body: any = null;
      try { body = JSON.parse(raw); } catch {}
      return { status: res.status, body, headers: res.headers, raw };
    },
    inbox: () => {
      const f = join(dataDir, "inbox.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
    calls: () => (existsSync(callsLog) ? readFileSync(callsLog, "utf8") : ""),
    cuts: () => existsSync(callsLog + ".cuts") ? readFileSync(callsLog + ".cuts", "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [],
    outbox: () => {
      const f = join(dataDir, "outbox.jsonl");
      return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    },
    restart: async () => {
      server.kill();
      await server.exited;
      ({ base, proc: server, cookie } = await startTestApp(startOptions));
    },
    stop: () => {
      server.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const envFor = (port: number, extra = "") =>
  `# Brain's env file, as the installer writes it\nBRAIN_CONTROL_TOKEN=${CONTROL_TOKEN}\nBRAIN_CONTROL_PORT=${port}\nBRAIN_BRIDGE_MODE=sessions\nBRAIN_BRIDGE_SESSIONS=3\n${extra}`;

describe("Brain house (EMBERVY_HARNESS=brain): the Brain menu", () => {
  let brain: FakeBrain;
  let house: House;
  beforeAll(async () => {
    brain = fakeBrain();
    house = await startHouse({ EMBERVY_HARNESS: "brain" }, envFor(brain.port));
  }, 30_000);
  afterAll(() => { house?.stop(); brain?.stop(); });

  test("GET /api/brain/heads without a session or with a wrong bearer: 401, Brain is never asked", async () => {
    for (const auth of ["none", "wrong"] as const) {
      for (const path of ["/api/brain/heads", "/api/brain/heads?refresh=1"]) {
        const r = await house.call("GET", path, { auth });
        expect([auth, path, r.status, r.body]).toEqual([auth, path, 401, { error: "unauthorized" }]);
      }
    }
    expect(brain.asked()).toEqual([]);
  });

  test("with the session cookie: Brain is asked with the control token, the answer comes back shaped", async () => {
    const r = await house.call("GET", "/api/brain/heads");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(brain.asked()).toEqual([`GET /heads Bearer ${CONTROL_TOKEN}`]);
    expect(r.body.current).toMatchObject({ head: "claude", headLabel: "Claude", modelLabel: "Opus 5.5 (1M)", family: "Opus", effort: "high", supportsEffort: true });
    expect(r.body.heads.map((h: any) => [h.name, h.available, h.current])).toEqual([["claude", true, true], ["gpt", true, false], ["grok", false, false]]);
    expect(r.body.heads[1].families[0].models[0]).toMatchObject({ id: "gpt-5.6-terra", kind: "head", effortLevels: ["low", "medium", "high", "xhigh"] });
    expect(r.body.heads[2].reason).toBe("XAI_API_KEY is not set");
    expect(r.body.bridge).toEqual({ mode: "sessions", count: 3 });
    expect(r.raw).not.toContain(CONTROL_TOKEN);
  });

  test("with the internal bearer (as the house does it): the same answer", async () => {
    const cookie = await house.call("GET", "/api/brain/heads");
    const bearer = await house.call("GET", "/api/brain/heads", { auth: "bearer" });
    expect(bearer.status).toBe(200);
    expect(bearer.body).toEqual(cookie.body);
  });

  test("only the fixed refresh=1 value reaches Brain; older Brain replies remain usable", async () => {
    const baseline = await house.call("GET", "/api/brain/heads");
    for (const [query, upstream] of [
      ["", "/heads"],
      ["?refresh=1", "/heads?refresh=1"],
      ["?refresh=1&token=foreign&other=1", "/heads?refresh=1"],
      ["?other=1", "/heads"],
      ["?refresh=0", "/heads"],
      ["?refresh=true", "/heads"],
      ["?refresh=", "/heads"],
      ["?refresh=1%26other%3D1", "/heads"],
    ]) {
      for (const auth of ["cookie", "bearer"] as const) {
        const before = brain.asked().length;
        const result = await house.call("GET", `/api/brain/heads${query}`, { auth });
        expect([query, auth, result.status]).toEqual([query, auth, 200]);
        expect(result.body).toEqual(baseline.body);
        expect(result.headers.get("cache-control")).toBe("no-store");
        expect(brain.asked().slice(before)).toEqual([`GET ${upstream} Bearer ${CONTROL_TOKEN}`]);
        expect(result.raw).not.toContain(CONTROL_TOKEN);
      }
    }
  });

  test("Brain not set up, refusing, old, unreachable or talking nonsense: a clear sentence, never a crash", async () => {
    const original = readFileSync(house.brainEnv, "utf8");
    try {
      writeFileSync(house.brainEnv, "BRAIN_CONTROL_TOKEN=<random-hex-32>\n");
      expect(await house.call("GET", "/api/brain/heads")).toMatchObject({ status: 503, body: { error: "Brain's control endpoint is not set up (BRAIN_CONTROL_TOKEN in Brain's brain.env)." } });

      writeFileSync(house.brainEnv, original.replace(CONTROL_TOKEN, "another-token-that-brain-does-not-know"));
      expect(await house.call("GET", "/api/brain/heads")).toMatchObject({ status: 502, body: { error: "Brain refused the request (the control token does not match)." } });

      writeFileSync(house.brainEnv, original);
      brain.mode("missing");
      expect(await house.call("GET", "/api/brain/heads")).toMatchObject({ status: 503, body: { error: "Brain does not offer the menu yet — it will after Brain's next restart." } });
      brain.mode("garbage");
      expect(await house.call("GET", "/api/brain/heads")).toMatchObject({ status: 502, body: { error: "Brain's answer could not be read." } });

      writeFileSync(house.brainEnv, envFor(testPort()));
      expect(await house.call("GET", "/api/brain/heads")).toMatchObject({ status: 502, body: { error: "Brain is not reachable." } });
    } finally {
      writeFileSync(house.brainEnv, original);
      brain.mode("ok");
    }
    expect((await house.call("GET", "/api/brain/heads")).status).toBe(200);
  });

  test("POST /api/brain/command: each choice lands in the inbox as exactly one Brain command", async () => {
    const before = house.inbox().length;
    const cases: Array<[unknown, string]> = [
      [{ action: "switch", head: "gpt", model: "gpt-5.6-terra", move: true, effort: "high" }, "/move gpt gpt-5.6-terra effort=high"],
      [{ action: "switch", head: "gpt", model: "gpt-5.6-terra", move: true }, "/move gpt gpt-5.6-terra"],
      [{ action: "switch", head: "claude", model: "claude-sonnet-5", move: false }, "/head claude claude-sonnet-5"],
      [{ action: "effort", level: "low" }, "/effort low"],
      [{ action: "effort", level: "default" }, "/effort default"],
      [{ action: "restart" }, "/respawn"],
    ];
    const inboxPath = join(house.dataDir, "inbox.jsonl");
    let cursor = readInbox(inboxPath, { offset: 0, seen: [] }).cursor;
    const historyBefore = await house.call("GET", "/api/messages");
    expect(historyBefore.status).toBe(200);
    const outboxBefore = house.outbox();
    for (const [body, cmd] of cases) {
      const r = await house.call("POST", "/api/brain/command", { body });
      expect([cmd, r.status, r.body.ok, r.body.command]).toEqual([cmd, 200, true, cmd]);
      const last = house.inbox().at(-1);
      expect(last).toEqual({ id: r.body.id, text: cmd, ts: r.body.ts, type: "text", ui_origin: "brain-menu" });
      const delivered = readInbox(inboxPath, cursor);
      expect(delivered.entries).toEqual([{ ...last, repeat_count: 1 }]);
      expect(isForeignEntry(delivered.entries[0]!)).toBe(false);
      cursor = delivered.cursor;
      expect(readInbox(inboxPath, cursor).entries).toEqual([]);
      for (let load = 0; load < 2; load++) {
        const history = await house.call("GET", "/api/messages");
        expect(history.status).toBe(200);
        expect(history.body).toEqual(historyBefore.body);
      }
    }
    expect(house.outbox()).toEqual(outboxBefore);
    expect(house.inbox().length).toBe(before + cases.length);
  });

  test("POST /api/brain/command refuses unclean or foreign choices (/stop never), and needs a session — never the agent's bearer", async () => {
    const before = house.inbox().length;
    for (const body of [
      { action: "stop" }, { action: "exit" }, { action: "switch", head: "claude", model: "x; /stop" },
      { action: "switch", head: "claude", model: "opus", move: false, effort: "high" }, { action: "effort", level: "high /stop" }, {}, "restart",
    ]) {
      const r = await house.call("POST", "/api/brain/command", { body });
      expect([JSON.stringify(body), r.status, r.body.error]).toEqual([JSON.stringify(body), 400, "That choice is not valid (head, model or thinking level)."]);
    }
    expect((await house.call("POST", "/api/brain/command", { auth: "none", body: { action: "restart" } })).status).toBe(401);
    expect((await house.call("POST", "/api/brain/command", { auth: "wrong", body: { action: "restart" } })).status).toBe(401);
    expect(house.inbox().length).toBe(before);
    expect((await house.call("POST", "/api/brain/command", { auth: "bearer", body: { action: "effort", level: "max" } })).status).toBe(401);
    expect(house.inbox().length).toBe(before);
    const viaSession = await house.call("POST", "/api/brain/command", { body: { action: "effort", level: "max" } });
    expect(viaSession.body.command).toBe("/effort max");
    expect(house.inbox().map((m) => m.text).filter((t) => t.startsWith("/stop"))).toEqual([]);
  });

  test.each(["/respawn", "/cut", "/cut now"])("chat %s reaches Brain as respawn exactly once without spawning a cut", async (command) => {
    const before = house.inbox().length;
    const response = await house.call("POST", "/api/message", { body: { text: command } });
    expect(response).toMatchObject({ status: 200, body: { ok: true } });
    expect(response.body.slash).toBeUndefined();
    expect(house.inbox().slice(before).map(m => m.text)).toEqual([command.replace("/cut", "/respawn")]);
    expect(house.inbox().at(-1).ui_origin).toBeUndefined();
    for (let load = 0; load < 2; load++) {
      const history = await house.call("GET", "/api/messages");
      expect(history.status).toBe(200);
      expect(history.body.filter((m: any) => m.id === response.body.id)).toEqual([
        expect.objectContaining({ role: "user", text: command.replace("/cut", "/respawn") }),
      ]);
    }
    expect(house.cuts()).toEqual([]);
  });

  test("menu commands stay hidden after an app restart while typed commands and one assistant reply remain", async () => {
    const typed = await house.call("POST", "/api/message", { body: { text: "/respawn", ui_origin: "brain-menu" } });
    expect(typed.status).toBe(200);
    const menu = await house.call("POST", "/api/brain/command", { body: { action: "restart" } });
    expect(menu.status).toBe(200);
    const reply = { id: crypto.randomUUID(), type: "send", text: "Session ready.", ts: new Date().toISOString() };
    const sent = await house.call("POST", "/api/internal/broadcast", { auth: "bearer", body: reply });
    expect(sent.status).toBe(200);
    const before = await house.call("GET", "/api/messages");
    expect(before.status).toBe(200);
    expect(before.body.filter((m: any) => m.id === menu.body.id)).toEqual([]);
    expect(before.body.filter((m: any) => m.id === typed.body.id)).toEqual([
      expect.objectContaining({ role: "user", text: "/respawn" }),
    ]);
    expect(before.body.filter((m: any) => m.id === reply.id)).toEqual([{ ...reply, role: "assistant" }]);
    const inboxBefore = house.inbox();
    await house.restart();
    for (let load = 0; load < 2; load++) {
      const reloaded = await house.call("GET", "/api/messages");
      expect(reloaded.status).toBe(200);
      expect(reloaded.body).toEqual(before.body);
      expect(reloaded.body.some((m: any) => m.ui_origin === "brain-menu")).toBe(false);
    }
    expect(house.inbox()).toEqual(inboxBefore);
  }, 30_000);

  test("nothing was typed into a terminal or started during this whole run", () => {
    expect(house.calls()).toBe("");
  });
});

describe("Claude Code with a Brain control configuration: the Brain menu is absent", () => {
  let brain: FakeBrain;
  let house: House;
  beforeAll(async () => {
    brain = fakeBrain();
    house = await startHouse({ EMBERVY_SUBSTRATE: "claude" }, envFor(brain.port));
  }, 30_000);
  afterAll(() => { house?.stop(); brain?.stop(); });

  test("GET /api/brain/heads: 404 \"not brain\" with a session or the bearer, 401 without; Brain is never asked", async () => {
    for (const auth of ["cookie", "bearer"] as const) {
      expect(await house.call("GET", "/api/brain/heads", { auth })).toMatchObject({ status: 404, body: { error: "not brain" } });
    }
    expect((await house.call("GET", "/api/brain/heads", { auth: "none" })).status).toBe(401);
    expect(brain.asked()).toEqual([]);
  });

  test("POST /api/brain/command: 404, nothing in the inbox", async () => {
    expect(await house.call("POST", "/api/brain/command", { body: { action: "restart" } })).toMatchObject({ status: 404, body: { error: "not brain" } });
    expect(house.inbox()).toEqual([]);
  });

  test.each(["/respawn", "/cut"])("chat %s with Brain control keeps the existing forwarding path", async (command) => {
    const before = house.inbox().length;
    const response = await house.call("POST", "/api/message", { body: { text: command } });
    expect(response.status).toBe(200);
    expect(response.body.slash).toBeUndefined();
    expect(house.inbox().slice(before).map(m => m.text)).toEqual(["/respawn"]);
    expect(house.cuts()).toEqual([]);
  });

  test("the header keeps its model dropdown: GET /api/internal/model is unchanged", async () => {
    const before = house.calls();
    expect((await house.call("GET", "/api/internal/model", { auth: "bearer" })).body).toEqual({ ok: true, model: null });
    expect(house.calls()).toBe(before);
  });
});

const CUT_REPLY = "Cut requested; the new session greets you when it is up.";
async function waitForCuts(house: House, count: number) {
  for (let i = 0; i < 100 && house.cuts().length < count; i++) await Bun.sleep(10);
  expect(house.cuts()).toHaveLength(count);
}

describe("Claude Code house without Brain control: app cuts", () => {
  let house: House;
  beforeAll(async () => {
    house = await startHouse({ EMBERVY_SUBSTRATE: "claude", EMBERVY_TMUX_SOCKET: "cut-test-socket" }, "BRAIN_CONTROL_TOKEN=PLACEHOLDER\n", "CLAUDE_PROJECT_DIR=/fixture/project\nCLAUDE_PROCESS_PATTERN='claude.*server:fixture'\nCUT_FIXTURE_VALUE=house-value\n");
  }, 30_000);
  afterAll(() => house?.stop());

  test("the menu offers only Restart (cut) and keeps its response private", async () => {
    const r = await house.call("GET", "/api/brain/heads");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.body).toMatchObject({ restartOnly: true, heads: [], current: { headLabel: "Claude Code" } });
    expect(house.cuts()).toEqual([]);
  });

  test.each(["/respawn", "/cut"])("chat %s invokes the detached house cut exactly once and answers one line", async (command) => {
    const cutCount = house.cuts().length;
    const callCount = house.calls().trim().split("\n").filter(Boolean).length;
    const before = house.outbox().length;
    const r = await house.call("POST", "/api/message", { body: { text: command } });
    expect(r).toMatchObject({ status: 200, body: { ok: true, slash: true } });
    await waitForCuts(house, cutCount + 1);
    expect(house.inbox()).toEqual([]);
    expect(house.outbox().slice(before).map(m => m.text)).toEqual([CUT_REPLY]);
    const cut = house.cuts()[cutCount];
    expect(cut.argv).toEqual([join(cut.home, "Claude/scripts/cutoff.sh")]);
    expect(cut.home).toBe(join(cut.userHome, "embervy-home"));
    expect(cut).toMatchObject({ socket: "cut-test-socket", project: "/fixture/project", pattern: "claude.*server:fixture", config: "app-value" });
    expect(house.calls().trim().split("\n")).toHaveLength(callCount + 1);
  });

  test("menu Restart invokes the same cut exactly once, answers 202 and announces it in chat", async () => {
    const before = house.outbox().length;
    const r = await house.call("POST", "/api/brain/command", { body: { action: "restart" } });
    expect(r).toMatchObject({ status: 202, body: { ok: true, mode: "respawn", message: CUT_REPLY } });
    await waitForCuts(house, 3);
    expect(house.cuts()[2]).toEqual(house.cuts()[0]);
    expect(house.inbox()).toEqual([]);
    expect(house.outbox().slice(before).map(m => m.text)).toEqual([CUT_REPLY]);
    expect(house.calls().trim().split("\n")).toHaveLength(3);
  });

  test("cut requires the same session as Brain commands; other menu actions cannot spawn it", async () => {
    for (const auth of ["none", "wrong", "bearer"] as const) {
      expect((await house.call("POST", "/api/brain/command", { auth, body: { action: "restart" } })).status).toBe(401);
    }
    for (const body of [{ action: "effort", level: "high" }, { action: "switch", head: "claude", model: "opus" }, { action: "stop" }]) {
      expect((await house.call("POST", "/api/brain/command", { body })).status).toBe(400);
    }
    expect(house.cuts()).toHaveLength(3);
    expect(house.inbox()).toEqual([]);
  });
});

test("a non-Brain, non-Claude Code house keeps its chat and menu behaviour", async () => {
  const house = await startHouse({ EMBERVY_SUBSTRATE: "codex" }, "");
  try {
    for (const command of ["/respawn", "/cut", "/cut now", "/cutlery"]) {
      const response = await house.call("POST", "/api/message", { body: { text: command } });
      expect(response.status).toBe(200);
      expect(response.body.slash).toBeUndefined();
    }
    expect(house.inbox().map(m => m.text)).toEqual(["/respawn", "/respawn", "/respawn now", "/cutlery"]);
    expect(await house.call("POST", "/api/brain/command", { body: { action: "restart" } })).toMatchObject({ status: 404, body: { error: "not brain" } });
    expect((await house.call("GET", "/api/brain/heads")).status).toBe(404);
    expect(house.cuts()).toEqual([]);
  } finally { house.stop(); }
}, 30_000);

test("a Brain house without control credentials never falls back to a Claude Code cut", async () => {
  const house = await startHouse({ EMBERVY_HARNESS: "brain" }, "");
  try {
    for (const command of ["/respawn", "/cut"]) await house.call("POST", "/api/message", { body: { text: command } });
    expect((await house.call("POST", "/api/brain/command", { body: { action: "restart" } })).status).toBe(200);
    expect(house.inbox().map(m => m.text)).toEqual(["/respawn", "/respawn", "/respawn"]);
    expect(house.cuts()).toEqual([]);
  } finally { house.stop(); }
}, 30_000);
