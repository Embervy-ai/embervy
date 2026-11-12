import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brokenBroadcastField, isSafeMediaUrl } from "./message-fields";

const PUBLIC = join(import.meta.dir, "public");
const SOURCE = readFileSync(join(PUBLIC, "legacy-names.js"), "utf8");

function storage(initial: Record<string, string>) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
  };
}

function run(initial: Record<string, string>) {
  const localStorage = storage(initial);
  new Function("localStorage", "window", SOURCE)(localStorage, {});
  return Object.fromEntries(localStorage.data);
}

describe("browser storage migration", () => {
  test("no stored name is moved today: unknown keys and fields stay as they are", () => {
    const stored = {
      "other-appearance": JSON.stringify({ otherColor: "#ffffff", titleText: "Mira" }),
      "embervy-appearance": JSON.stringify({ agentColor: "#000000", otherColor: "#ffffff", titleText: "My Home" }),
      "embervy-draft": "half a sentence",
    };
    expect(run(stored)).toEqual(stored);
  });

  test("current storage stays byte for byte and unreadable storage is no error", () => {
    const current = { "embervy-appearance": JSON.stringify({ agentColor: "#000000", agentAlpha: 18, titleText: "My Home" }), "embervy-draft": "text", other: "x" };
    expect(run(current)).toEqual(current);
    expect(run({ "embervy-appearance": "{not json" })).toEqual({ "embervy-appearance": "{not json" });
    expect(() => new Function("localStorage", "window", SOURCE)({ getItem() { throw new Error("blocked"); } }, {})).not.toThrow();
  });

  test("both pages load the migration before their own script", () => {
    for (const [page, script] of [["index.html", "/app.js"], ["settings.html", "/settings.js"]]) {
      const html = readFileSync(join(PUBLIC, page), "utf8");
      const legacy = html.indexOf('<script src="/legacy-names.js');
      expect(legacy).toBeGreaterThan(-1);
      expect(legacy).toBeLessThan(html.indexOf(`<script src="${script}`));
    }
    // The client carries no name from the house it was first built in, in any spelling.
    const houseName = new RegExp(["l", "u", "x"].join(""), "i");
    for (const file of ["app.js", "settings.js", "settings.html", "style.css", "index.html", "i18n.js", "sw.js", "manifest.json", "legacy-names.js"]) {
      const text = readFileSync(join(PUBLIC, file), "utf8").replace(/flux|luxury|deluxe/gi, "");
      expect({ file, houseName: houseName.test(text) }).toEqual({ file, houseName: false });
    }
  });
});

describe("supported media paths", () => {
  const URLS = ["/api/memory-image/5123", "/api/memory-video/5123", "https://app.example/api/memory-image/5123"];
  const INVALID = ["/api/unknown-image/5123", "/api/unknown-video/5123", "/api/memory-image/../x", "javascript:alert(1)"];

  test("the server validates current image and video URLs", () => {
    for (const url of URLS) expect(isSafeMediaUrl(url)).toBe(true);
    expect(brokenBroadcastField({ id: "imagine-1", image_url: "/api/memory-image/1" })).toBeNull();
    for (const url of INVALID) expect(isSafeMediaUrl(url)).toBe(false);
  });

  test("the page validates media without a storage migration dependency", () => {
    const app = readFileSync(join(PUBLIC, "app.js"), "utf8");
    const start = app.indexOf("  function escapeHtml(text) {");
    const end = app.indexOf("  function appearanceTextColors(background) {");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = `${app.slice(start, end)}\nreturn { safeMediaUrl };`;
    for (const migrate of [false, true]) {
      const window = {};
      if (migrate) new Function("localStorage", "window", SOURCE)(storage({}), window);
      const page = new Function("window", "t", "location", block)(window, (k: string) => k, { origin: "https://app.example" }) as { safeMediaUrl: (u: unknown) => string };
      for (const url of URLS) expect(page.safeMediaUrl(url)).toBe(url.startsWith("https:") ? new URL(url).pathname : url);
      for (const url of INVALID) expect(page.safeMediaUrl(url)).toBe("");
    }
  });
});

describe("server configuration and authentication", () => {
  test("uses current settings, authenticates the current cookie and exposes memory media routes", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "names-server-"));
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = s.port;
    s.stop(true);
    const base = `http://127.0.0.1:${port}`;
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dir,
        EMBERVY_APP_PORT: String(port),
        EMBERVY_APP_HOST: "127.0.0.1",
        EMBERVY_APP_DATA_DIR: join(dir, "data"),
        EMBERVY_TERMINAL_PANEL: "0",
        EMBERVY_TMUX_SESSION: "names-test-no-such-session",
        APP_PASSWORD: "test-password",
        APP_SESSION_SECRET: "session-secret-for-tests",
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    try {
      let up = false;
      for (let i = 0; i < 100 && !up; i++) {
        up = await fetch(`${base}/health`).then((r) => r.ok, () => false);
        if (!up) await Bun.sleep(100);
      }
      if (!up) {
        proc.kill();
        throw new Error(`Server did not start: ${await new Response(proc.stderr).text()}`);
      }
      const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
      const auth = await fetch(`${base}/api/auth`, { method: "POST", headers: { ...viaTunnel, "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
      expect(auth.status).toBe(200);
      const cookie = (auth.headers.get("set-cookie") || "").split(";")[0];
      expect(cookie).toStartWith("embervy_session=");
      const token = cookie.slice("embervy_session=".length);
      const ask = (headers: Record<string, string>) => fetch(`${base}/api/memory-image/7`, { headers: { ...viaTunnel, ...headers } });
      expect((await ask({})).status).toBe(401);
      expect((await ask({ cookie: `unrelated_session=${token}` })).status).toBe(401);
      const image = await ask({ cookie });
      expect(image.status).toBe(503);
      expect(await image.json()).toEqual({ error: "memory image proxy is not configured" });
      const video = await fetch(`${base}/api/memory-video/7`, { headers: { ...viaTunnel, cookie } });
      expect(video.status).toBe(503);
      expect(await video.json()).toEqual({ error: "memory video proxy is not configured" });
    } finally {
      proc.kill();
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
