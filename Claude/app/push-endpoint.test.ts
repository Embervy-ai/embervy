import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptedPushEndpoint } from "./push-endpoint";

describe("acceptedPushEndpoint", () => {
  for (const host of [
    "fcm.googleapis.com",
    "updates.push.services.mozilla.com",
    "wns.notify.windows.com",
    "web.push.apple.com",
    "device.push.apple.com",
    "android.googleapis.com",
  ]) {
    test(`accepts https://${host}`, () => {
      expect(acceptedPushEndpoint(`https://${host}/push/token`)).toBe(true);
    });
  }

  test("accepts case-insensitive hosts and nested service subdomains", () => {
    for (const url of [
      "https://FCM.GOOGLEAPIS.COM/send/token?key=value",
      "https://a.b.notify.windows.com/token",
      "https://a.b.push.apple.com/token",
    ]) expect(acceptedPushEndpoint(url)).toBe(true);
  });

  test("rejects HTTP and other schemes", () => {
    for (const url of [
      "http://fcm.googleapis.com/token",
      "ftp://fcm.googleapis.com/token",
      "//fcm.googleapis.com/token",
    ]) expect(acceptedPushEndpoint(url)).toBe(false);
  });

  test("rejects IP addresses and localhost", () => {
    for (const host of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "[::1]", "localhost"]) {
      expect(acceptedPushEndpoint(`https://${host}/token`)).toBe(false);
    }
  });

  test("rejects lookalike hosts and names outside the allowed service scope", () => {
    for (const host of [
      "fcm.googleapis.com.evil.example",
      "evilfcm.googleapis.com",
      "updates.push.services.mozilla.com.evil.example",
      "evilnotify.windows.com",
      "notify.windows.com",
      "wns.notify.windows.com.evil.example",
      "evilpush.apple.com",
      "push.apple.com",
      "device.push.apple.com.evil.example",
      "android.googleapis.com.evil.example",
      "sub.fcm.googleapis.com",
      "example.com",
    ]) expect(acceptedPushEndpoint(`https://${host}/token`)).toBe(false);
  });

  test("rejects userinfo, including empty userinfo", () => {
    for (const url of [
      "https://user@fcm.googleapis.com/token",
      "https://user:password@fcm.googleapis.com/token",
      "https://:password@fcm.googleapis.com/token",
      "https://@fcm.googleapis.com/token",
      "https://fcm.googleapis.com@evil.example/token",
    ]) expect(acceptedPushEndpoint(url)).toBe(false);
  });

  test("rejects malformed URLs", () => {
    for (const url of ["", "not a URL", "https://", "https://[::1", "https://fcm.googleapis.com:invalid/token"]) {
      expect(acceptedPushEndpoint(url)).toBe(false);
    }
  });

  test("rejects encoded and ambiguous authorities", () => {
    for (const url of [
      "https://%66cm.googleapis.com/token",
      "https://fcm。googleapis.com/token",
      "https://fcm.googleapis.com\\@evil.example/token",
      "https://fcm.google\napis.com/token",
    ]) expect(acceptedPushEndpoint(url)).toBe(false);
  });

  test("rejects non-string values without coercion", () => {
    for (const value of [undefined, null, 123, true, {}, [], { toString: () => "https://fcm.googleapis.com/token" }]) {
      expect(acceptedPushEndpoint(value as string)).toBe(false);
    }
  });
});

describe("authenticated push subscription", () => {
  const password = "push-endpoint-test-password";
  let server: ReturnType<typeof Bun.spawn>;
  let dir = "";
  let dataDir = "";
  let base = "";
  let cookie = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "push-endpoint-"));
    dataDir = join(dir, "data");
    const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = listener.port;
    listener.stop(true);
    if (port === 3030) throw new Error("refusing to test on port 3030");
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        TMUX_TMPDIR: dir,
        EMBERVY_APP_PORT: String(port),
        EMBERVY_APP_HOST: "127.0.0.1",
        EMBERVY_APP_DATA_DIR: dataDir,
        APP_PASSWORD: password,
        APP_SESSION_SECRET: "push-endpoint-test-session-secret",
        EMBERVY_TERMINAL_PANEL: "0",
        EMBERVY_TMUX_SESSION: "push-endpoint-test-no-such-session",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch {}
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error("test server did not come up");
    const login = await fetch(`${base}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    expect(login.status).toBe(200);
    cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).not.toBe("");
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    if (server) await server.exited;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("POST /api/push/subscribe returns 400 without storing rejected endpoints and 200 for an accepted subscription", async () => {
    const file = join(dataDir, "push-subscriptions.json");
    const subscribe = (body: unknown) => fetch(`${base}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    for (const body of [{ endpoint: "https://127.0.0.1/private" }, { endpoint: 123 }, {}, null]) {
      const rejected = await subscribe(body);
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({ error: "unsupported push endpoint" });
      expect(existsSync(file)).toBe(false);
    }

    const sub = {
      endpoint: "https://fcm.googleapis.com/send/test-token",
      expirationTime: null,
      keys: { p256dh: "test-public-key", auth: "test-auth-secret" },
    };
    const accepted = await subscribe(sub);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([sub]);

    const stored = readFileSync(file, "utf8");
    expect((await subscribe({ endpoint: "https://fcm.googleapis.com.evil.example/token" })).status).toBe(400);
    expect(readFileSync(file, "utf8")).toBe(stored);
    expect((await subscribe(sub)).status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([sub]);
  });
});
