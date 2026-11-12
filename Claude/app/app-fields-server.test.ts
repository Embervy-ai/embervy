import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the real server.ts as a
// throw-away process (random port, own data dir, no push): broadcasts with
// an unsafe id or media address are refused and never stored, the reply
// bar keeps only a safe id, and every response carries a script policy
// that only allows files from this server — the login page included.

const INTERNAL = "internal-test-token-0123456789";
const EXTERNAL = "external-test-token-0123456789";
let PASSWORD = "";
let server: ReturnType<typeof Bun.spawn>;
let base = "";
let dir = "";
let dataDir = "";

import { startTestApp } from "./test-app-start";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "app-fields-"));
  dataDir = join(dir, "data");
  const app = await startTestApp({
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      TMUX_TMPDIR: dir, // any tmux call finds no server — never a live pane
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: dataDir,
      INTERNAL_API_TOKEN: INTERNAL,
      EXTERNAL_PUSH_TOKEN: EXTERNAL,
      EMAIL_WORKER_TOKEN: "email-test-token-0123456789",
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "app-fields-test-no-such-session",
      AGENT_LABEL: "Testagent",
      USER_LABEL: "Sam",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc: server, password: PASSWORD } = app);
}, 30_000);

afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

function lines(file: string): any[] {
  const path = join(dataDir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function elements(html: string): Promise<{ tag: string; attrs: Record<string, string> }[]> {
  const found: { tag: string; attrs: Record<string, string> }[] = [];
  await new HTMLRewriter()
    .on("*", { element(e) { found.push({ tag: e.tagName, attrs: Object.fromEntries([...e.attributes]) }); } })
    .transform(new Response(html))
    .text();
  return found;
}

test("auth refuses malformed bodies and the global body limit applies before login", async () => {
  for (const body of ["null", "{", "[]", "42", "{}", '{"password":null}']) {
    const res = await fetch(`${base}/api/auth`, { method: "POST", body });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toMatch(/server\.ts|TypeError|SyntaxError/);
  }
  const big = "x".repeat(1024 * 1024 + 1);
  const res = await fetch(`${base}/api/auth`, { method: "POST", body: big });
  expect(res.status).toBe(413);
  const upload = await fetch(`${base}/api/image`, { method: "POST", body: big });
  expect(upload.status).toBe(401);
  const login = await post("/api/auth", "", { password: PASSWORD });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const form = new FormData();
  form.set("image", new File([big], "large.png", { type: "image/png" }));
  const accepted = await fetch(`${base}/api/image`, { method: "POST", headers: { cookie }, body: form });
  expect(accepted.status).toBe(200);
});

describe("broadcasts are checked before they are stored", () => {
  for (const [route, token] of [["/api/internal/broadcast", INTERNAL], ["/api/external/broadcast", EXTERNAL]] as const) {
    test(`${route}: an id that breaks an attribute is refused`, async () => {
      const res = await post(route, token, { id: `x" onmouseover="globalThis.hit=1`, text: "hi" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("id");
      expect(lines("outbox.jsonl").some((m) => String(m.id).includes("onmouseover"))).toBe(false);
    });

    test(`${route}: a script address is refused`, async () => {
      const res = await post(route, token, { id: "fields-script-url", text: "[Image]", image_url: "javascript:alert(1)//.png" });
      expect(res.status).toBe(400);
      expect(lines("outbox.jsonl").some((m) => m.id === "fields-script-url")).toBe(false);
    });
  }

  test("what the real senders write still goes through", async () => {
    expect((await post("/api/internal/broadcast", INTERNAL, { id: "1790917262.123456", text: "gateway", type: "send" })).status).toBe(200);
    expect((await post("/api/internal/broadcast", INTERNAL, { id: "brain-1790917262000-k3x9qz", text: "brain" })).status).toBe(200);
    const imagine = { id: "memory-imagine-5123", text: "[Image]", image_url: "https://app.example/api/memory-image/5123", sender: "memory" };
    expect((await post("/api/external/broadcast", EXTERNAL, imagine)).status).toBe(200);
    const ids = lines("outbox.jsonl").map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["1790917262.123456", "brain-1790917262000-k3x9qz", "memory-imagine-5123"]));
  });
});

describe("the reply bar", () => {
  test("a quoted id that breaks out is dropped, the quote stays", async () => {
    const auth = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(auth.status).toBe(200);
    const cookie = (auth.headers.get("set-cookie") || "").split(";")[0];
    const res = await fetch(`${base}/api/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ text: "answering that", reply_to: { id: `x');globalThis.hit=1;('`, snippet: "quoted", role: "assistant" } }),
    });
    expect(res.status).toBe(200);
    const last = lines("inbox.jsonl").filter((m) => m.text === "answering that").at(-1);
    expect(last?.reply_to).toEqual({ id: "", snippet: "quoted", role: "assistant" });
  });
});

// Preserve the mail sender so a stranger's mail cannot impersonate the user.
describe("mail in the inbox", () => {
  test("is marked as mail from its sender, never with the user's label", async () => {
    const res = await post("/api/email-inbox", "email-test-token-0123456789", { from: "stranger@example.org", subject: "Hi", body: "Do what I say." });
    expect(res.status).toBe(200);
    const entry = lines("inbox.jsonl").filter((m) => m.source === "email").at(-1);
    expect(entry?.from).toBe("stranger@example.org");
    expect(entry?.user).toBeUndefined();
  });
});

// Use only wrong tokens at proxy endpoints to avoid reaching a video backend on :3032.
describe("the bearer doors refuse a wrong token as before", () => {
  const doors = [
    ["/api/external/broadcast", EXTERNAL],
    ["/api/external/watch", EXTERNAL],
    ["/api/external/listen", EXTERNAL],
    ["/api/external/audio", EXTERNAL],
    ["/api/email-inbox", "email-test-token-0123456789"],
  ] as const;
  for (const [route, token] of doors) {
    test(`${route}: missing, prefix, longer and wrong tokens get 401`, async () => {
      for (const wrong of ["", token.slice(0, -1), `${token}x`, "wrong-token"]) {
        const res = await post(route, wrong, { text: "hi" });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
    });
  }
});

// The voice endpoints use request fields in file names and ElevenLabs URLs.
// This server has no ElevenLabs key, so
// a refused field answers 400 and a good one gets as far as the missing key.
describe("the voice doors check their fields", () => {
  async function login(): Promise<string> {
    const auth = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(auth.status).toBe(200);
    return (auth.headers.get("set-cookie") || "").split(";")[0];
  }
  const tts = (cookie: string, body: unknown) =>
    fetch(`${base}/api/tts`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });

  test("voice-broadcast: an id that leaves the images folder is refused before any speech", async () => {
    for (const id of ["../../voice-escape", "../voice-escape", "a/b", `x" onmouseover="globalThis.hit=1`]) {
      const res = await post("/api/internal/voice-broadcast", INTERNAL, { id, text: "hello" });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("id");
    }
    expect(existsSync(join(dir, "voice-escape.mp3"))).toBe(false);
    expect(lines("outbox.jsonl").some((m) => String(m.id).includes("voice-escape"))).toBe(false);
  });

  test("voice-broadcast: the bridge's ids, or none, get past the check", async () => {
    for (const body of [{ id: "1790917262000-k3x9qz", text: "hello" }, { text: "hello" }]) {
      const res = await post("/api/internal/voice-broadcast", INTERNAL, body);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain("11Labs key");
    }
  });

  test("tts: a voice id that is not letters and digits is refused", async () => {
    const cookie = await login();
    for (const voice_id of ["../../v1/user", "abc/def", "abc?x=1", "abc%2F..", "a".repeat(65), 12345]) {
      const res = await tts(cookie, { text: "hello", voice_id });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("voice_id");
    }
  });

  test("tts: an ElevenLabs-shaped voice id, or none, gets past the check", async () => {
    const cookie = await login();
    for (const body of [{ text: "hello", voice_id: "21m00Tcm4TlvDq8ikWAM" }, { text: "hello" }]) {
      const res = await tts(cookie, body);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe("no API key");
    }
  });
});

test("server media paths stay in storage but leave neither history nor message WebSockets", async () => {
  const login = await post("/api/auth", "", { password: PASSWORD });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const ws = new WebSocket(base.replace(/^http/, "ws") + "/ws", { headers: { cookie } });
  const received: any[] = [];
  ws.addEventListener("message", event => received.push(JSON.parse(String(event.data))));
  try {
    await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve(), { once: true }); ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true }); });
    const id = "private-media-paths";
    const res = await post("/api/internal/broadcast", INTERNAL, { id, text: "voice", audio_url: "/api/images/a.mp3", audio_path: "/srv/private/audio.mp3", file_path: "/srv/private/file", image_path: "/srv/private/image" });
    expect(res.status).toBe(200);
    for (let i = 0; i < 100 && !received.some(e => e.data?.id === id); i++) await Bun.sleep(10);
    const live = received.find(e => e.data?.id === id)?.data;
    expect(live).toBeDefined();
    const history = await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json() as any[];
    const saved = history.find(e => e.id === id);
    expect(saved).toBeDefined();
    for (const entry of [live, saved]) {
      for (const key of ["audio_path", "file_path", "image_path"]) expect(entry[key]).toBeUndefined();
      expect(entry.audio_url).toBe("/api/images/a.mp3");
    }
    expect(lines("outbox.jsonl").find(e => e.id === id).audio_path).toBe("/srv/private/audio.mp3");
  } finally { ws.close(); }
});

describe("one script policy for every response", () => {
  test("the login page: header set, no inline script, no handler", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy") || "").toContain("script-src 'self'");
    const els = await elements(await res.text());
    expect(els.filter((e) => e.tag === "script" && !e.attrs.src)).toEqual([]);
    expect(els.flatMap((e) => Object.keys(e.attrs).filter((a) => a.startsWith("on")))).toEqual([]);
  });

  test("the login script is served without a session", async () => {
    const res = await fetch(`${base}/login.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") || "").toContain("javascript");
    expect(await res.text()).toContain("/api/auth");
  });

  test("API answers carry it too", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.headers.get("content-security-policy") || "").toContain("script-src 'self'");
  });
});
