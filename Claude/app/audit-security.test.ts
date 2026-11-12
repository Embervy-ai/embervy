import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import { open, truncate } from "node:fs/promises";
import { mediaPolicy, sendFile } from "./send-file";
import { positiveFiniteSetting } from "./security-config";
import { websocketOriginAllowed } from "./ws-origin";
import { startTestApp } from "./test-app-start";
import { defuseChannelTags, defuseSenderLines, safeChannelMeta } from "./message-fields";

const appSource = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
const mcpSource = readFileSync(join(import.meta.dir, "mcp.ts"), "utf8");
const transpile = (source: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(source);

test("channel delivery logs only a closed-set kind and length, never incoming fields", () => {
  const start = mcpSource.indexOf("function sendChannelNotification(");
  const end = mcpSource.indexOf("function deliverNewInboxLines", start);
  const logs: string[] = [], delivered: any[] = [];
  const notify = new Function("mcp", "process", "defuseChannelTags", "defuseSenderLines", "safeChannelMeta",
    `${transpile(mcpSource.slice(start, end))}; return sendChannelNotification;`)(
    { notification: (message: any) => delivered.push(message) }, { stderr: { write: (line: string) => logs.push(line) } },
    defuseChannelTags, defuseSenderLines, safeChannelMeta);
  const secret = "PRIVATE subject sender and message";
  for (const kind of ["email", "room", "peer", "scheduled", "", "PRIVATE\nforged"])
    notify(secret, { kind, from: secret, user: secret, file_name: secret });
  expect(delivered).toHaveLength(6);
  expect(delivered[0].params.content).toBe(secret);
  expect(logs).toEqual(["email", "room", "peer", "scheduled", "message", "message"].map(kind =>
    `embervy-mcp: channel notification kind=${kind} length=${secret.length}\n`));
  expect(logs.join("")).not.toContain("PRIVATE");
});

test("a failed broadcast logs its id and the app's answer, never the message", async () => {
  const start = mcpSource.indexOf("async function deliverBroadcast(");
  const end = mcpSource.indexOf("function notDelivered", start);
  const logs: string[] = [];
  const deliver = new Function("fetch", "process", "APP_BASE", "internalAuthHeaders", "BROADCAST_ATTEMPTS", "BROADCAST_TIMEOUT_MS",
    `${transpile(mcpSource.slice(start, end))}; return deliverBroadcast;`)(
    async () => new Response("PRIVATE provider response", { status: 400 }),
    { stderr: { write: (line: string) => logs.push(line) } }, "http://unused", () => ({}), 1, 1000);
  expect((await deliver({ id: "PRIVATE id", text: "PRIVATE message" })).ok).toBe(false);
  expect(logs).toEqual(["embervy-mcp: message PRIVATE id not delivered: the app answered HTTP 400 PRIVATE provider response\n"]);
  expect(logs.join("")).not.toContain("PRIVATE message");
});

test("external broadcast denial logs are independent of both secret lengths", async () => {
  const start = appSource.indexOf('app.post("/api/external/broadcast"');
  const end = appSource.indexOf("\n});", start) + "\n});".length;
  for (const expected of ["PRIVATE-short", "PRIVATE-".repeat(100)]) {
    let handler: any;
    const logs: string[] = [];
    new Function("app", "process", "EXTERNAL_PUSH_TOKEN", "bearerMatches", transpile(appSource.slice(start, end)))(
      { post: (_path: string, fn: any) => handler = fn }, { stderr: { write: (line: string) => logs.push(line) } },
      expected, (auth: string, token: string) => auth === `Bearer ${token}`);
    for (const auth of ["", "Bearer PRIVATE-other", "Bearer " + "x".repeat(1000)]) {
      const response = await handler({ req: { header: () => auth }, json: (body: unknown, status: number) => ({ body, status }) });
      expect(response.status).toBe(401);
    }
    expect(logs).toEqual(Array(3).fill("external broadcast: auth mismatch\n"));
  }
});

test("WebSocket origin rejection runs before auth bypass and before any upgrade", async () => {
  const start = appSource.indexOf("  async fetch(req, server) {");
  const end = appSource.indexOf("    // An online doctor run", start);
  const code = transpile(`const handler = { ${appSource.slice(start, end)} return new Response('not ws'); } };`);
  for (const bypass of [false, true]) {
    let upgrades = 0, authChecks = 0;
    const f = new Function("websocketOriginAllowed", "calendarConfig", "APP_PASSWORD", "trustedWithoutCookie", "isAuthenticatedFromCookie", "readSessionCookie", "SESSION_MAX_AGE_MS", "terminalPreferenceKey",
      `${code}; return handler.fetch;`)(
      websocketOriginAllowed, { publicUrl: "https://app.example.test" }, "password", () => bypass,
      async (cookie: string) => { authChecks++; return !!cookie; }, () => `${Date.now()}.signature`, 1000, () => "fixture");
    const server = { upgrade: () => { upgrades++; return true; } };
    for (const origin of ["null", "https://sibling.example.test", "http://app.example.test"]) {
      const result = await f(new Request("http://127.0.0.1/ws", { headers: { origin, cookie: "valid" } }), server);
      expect(result.status).toBe(403);
    }
    expect(upgrades).toBe(0);
    expect(authChecks).toBe(0);
    for (const headers of [{ origin: "https://app.example.test", cookie: "valid" }, { cookie: "valid" }])
      expect(await f(new Request("http://127.0.0.1/ws", { headers }), server)).toBeUndefined();
    expect(upgrades).toBe(2);
    const unauthorized = await f(new Request("http://127.0.0.1/ws"), server);
    if (bypass) expect(unauthorized).toBeUndefined();
    else expect(unauthorized.status).toBe(401);
  }
});

test("positive finite settings retain valid values and reject boundary-disabling values", () => {
  for (const raw of [undefined, "", " ", "garbage", "NaN", "Infinity", "-Infinity", "0", "-1", "1e999"])
    expect(positiveFiniteSetting(raw, 123)).toBe(123);
  for (const raw of ["1", "0.5", "1000", " 2000 "])
    expect(positiveFiniteSetting(raw, 123)).toBe(Number(raw));
  expect(appSource).toContain("positiveFiniteSetting(process.env.MAX_VOICE_BYTES, 20 * 1024 * 1024)");
  expect(mcpSource).toContain('positiveFiniteSetting(envValue("EMBERVY_BROADCAST_TIMEOUT_MS"), 15_000)');
});

test("invalid image size settings cannot bypass the file-send boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-media-limit-"));
  try {
    const path = join(dir, "oversized.txt");
    const file = await open(path, "wx"); await file.close();
    await truncate(path, 20 * 1024 * 1024 + 1);
    let deliveries = 0;
    for (const raw of [undefined, "", "bad", "NaN", "0", "-1", "Infinity"]) {
      expect(mediaPolicy({ MAX_IMAGE_BYTES: raw }).maxBytes).toBe(20 * 1024 * 1024);
      const result = await sendFile({ path }, { mediaDir: join(dir, "media"), env: { MAX_IMAGE_BYTES: raw }, deliver: async () => { deliveries++; return { ok: true }; } });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("file too large");
    }
    expect(deliveries).toBe(0);
    expect(mediaPolicy({ MAX_IMAGE_BYTES: "1024" }).maxBytes).toBe(1024);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the session verifier rejects old timestamps with matching signatures and every invalid lifetime", async () => {
  const start = appSource.indexOf("async function verifySessionToken(");
  const end = appSource.indexOf("function readSessionCookie", start);
  const now = 2_000_000_000_000;
  for (const raw of [undefined, "", "garbage", "NaN", "0", "-1", "Infinity", "-Infinity"]) {
    const verify = new Function("Date", "SESSION_MAX_AGE_MS", "APP_SESSION_SECRET", "hmacSign", "timingSafeEqual",
      `${transpile(appSource.slice(start, end))}; return verifySessionToken;`)(
      { now: () => now }, positiveFiniteSetting(raw, 2_592_000_000), "test-secret", async () => "valid-signature", (a: string, b: string) => a === b);
    expect(await verify(`${now - 31 * 86400_000}.valid-signature`)).toBe(false);
    expect(await verify(`${now - 1000}.valid-signature`)).toBe(true);
    expect(await verify(`${now - 1000}.wrong-signature`)).toBe(false);
  }
});

test("Origin matches exact public origins and the calendar feed's forwarding precedence", () => {
  const req = (origin: string | undefined, extra: Record<string, string> = {}) => new Request("http://127.0.0.1:9090/ws", {
    headers: { host: "app.example.test", "cf-ray": "test", ...extra, ...(origin === undefined ? {} : { origin }) },
  });
  expect(websocketOriginAllowed(req(undefined), "https://app.example.test")).toBe(true);
  expect(websocketOriginAllowed(req("https://app.example.test"), "https://app.example.test/path")).toBe(true);
  expect(websocketOriginAllowed(req("https://app.example.test"))).toBe(true);
  expect(websocketOriginAllowed(req("https://app.example.test:443"), "https://app.example.test")).toBe(true);
  expect(websocketOriginAllowed(req("https://public.example.test", { "x-forwarded-host": "public.example.test", "x-forwarded-proto": "https" }))).toBe(true);
  for (const origin of ["https://other.example.test", "https://app.example.test.evil.test", "http://app.example.test", "https://app.example.test:444", "null", "", "not a URL", "https://app.example.test/path", "https://user@app.example.test", "https://app.example.test?q=1"])
    expect(websocketOriginAllowed(req(origin), "https://app.example.test")).toBe(false);
  expect(websocketOriginAllowed(req("https://sibling.example.test", { "x-forwarded-host": "public.example.test" }), "https://app.example.test")).toBe(false);
  // The rescue path opens the app through an SSH tunnel while a public address is configured.
  expect(websocketOriginAllowed(new Request("http://localhost:3030/ws", { headers: { host: "localhost:3030", origin: "http://localhost:3030" } }), "https://app.example.test")).toBe(true);
  expect(websocketOriginAllowed(new Request("http://localhost:3030/ws", { headers: { host: "localhost:3030", origin: "http://localhost:4040" } }), "https://app.example.test")).toBe(false);
  // An unreadable configured address leaves only the address the request itself was sent to.
  expect(websocketOriginAllowed(req("https://app.example.test"), "invalid")).toBe(true);
  expect(websocketOriginAllowed(req("https://sibling.example.test"), "invalid")).toBe(false);
  expect(websocketOriginAllowed(new Request("http://localhost:9090/ws", { headers: { origin: "http://localhost:9090" } }))).toBe(true);
});

async function withApp(settings: Record<string, string>, body: (app: Awaited<ReturnType<typeof startTestApp>>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "audit-boundaries-"));
  let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
  try {
    app = await startTestApp({ cwd: dir, stderr: "pipe", env: {
      PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir, EMBERVY_HOME: dir,
      EMBERVY_APP_DATA_DIR: dir, APP_SESSION_SECRET: "test-session-secret", EMBERVY_TERMINAL_PANEL: "0", ...settings,
    } });
    await body(app);
  } finally {
    if (app) { app.proc.kill(); await app.proc.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("WS rejects sibling origins even with a valid cookie or local bypass; native clients still connect", async () => {
  await withApp({ EMBERVY_APP_URL: "https://app.example.test", EMBERVY_TRUST_SAME_HOST: "true" }, async app => {
    for (const headers of [{ cookie: app.cookie, "cf-ray": "test" }, {}]) {
      const response = await fetch(app.base + "/ws", { headers: { ...headers, origin: "https://sibling.example.test" } });
      expect(response.status).toBe(403);
    }
    for (const origin of [undefined, "https://app.example.test"]) {
      const ws = new WebSocket(app.base.replace("http:", "ws:") + "/ws", { headers: {
        cookie: app.cookie, "cf-ray": "test", ...(origin ? { origin } : {}),
      } });
      try {
        await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
        expect(ws.readyState).toBe(WebSocket.OPEN);
      } finally { ws.close(); }
    }
  });
}, 20_000);

test.each(["garbage", "0", "-1", "Infinity", "NaN", ""])("invalid session age %j really expires old signed cookies", async raw => {
  await withApp({ APP_SESSION_MAX_AGE_MS: raw, MAX_VOICE_BYTES: raw }, async app => {
    const login = await fetch(app.base + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: app.password }) });
    expect(login.headers.get("set-cookie")).toContain("Max-Age=2592000");
    const ts = String(Date.now() - 31 * 86400_000);
    const sig = createHmac("sha256", "test-session-secret").update(ts).digest("hex");
    const expired = await fetch(app.base + "/ws", { headers: { cookie: `embervy_session=${ts}.${sig}` } });
    expect(expired.status).toBe(401);
    // The transport limit is computed from the parsed audio limit before body parsing.
    const oversized = await fetch(app.base + "/api/voice", { method: "POST", headers: { cookie: app.cookie }, body: new Uint8Array(22 * 1024 * 1024) });
    expect(oversized.status).toBe(413);
  });
}, 30_000);

test("broadcast auth failures never reveal either token's length or fragments", async () => {
  const token = "PRIVATE-expected-token-with-distinct-size";
  await withApp({ EXTERNAL_PUSH_TOKEN: token }, async app => {
    for (const auth of ["Bearer short", "Bearer PRIVATE-unexpected-token-with-another-size"]) {
      const response = await fetch(app.base + "/api/external/broadcast", { method: "POST", headers: { authorization: auth, "content-type": "application/json" }, body: "{}" });
      expect(response.status).toBe(401);
    }
    app.proc.kill(); await app.proc.exited;
    const logs = await new Response(app.proc.stderr).text();
    const lines = logs.split("\n").filter(line => line.startsWith("external broadcast:"));
    expect(lines).toEqual(["external broadcast: auth mismatch", "external broadcast: auth mismatch"]);
    expect(logs).not.toContain("PRIVATE");
    expect(logs).not.toContain("expected len");
  });
}, 20_000);
