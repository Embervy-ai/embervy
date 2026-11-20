import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestApp } from "./test-app-start";
import { loadStrings } from "./strings";

// Values deliberately conspicuous, but assertions compare booleans so even a
// failed test never prints a credential-shaped value from a response or file.
const firstKey = "NOT-A-REAL-KIMI-KEY-SENTINEL-ONE";
const nextKey = "NOT-A-REAL-KIMI-KEY.two_0123456789";

test("human-only Kimi setup: one local usages probe, private replacement, real Brain list, no secret logs/history", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-route-"));
  const envFile = join(dir, "brain.env");
  const controlToken = "local-kimi-control-token-123456";
  let mode = "ok", requests = 0;
  const seen: Array<{ method: string; path: string; accepted: boolean }> = [];
  const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
    requests++;
    seen.push({ method: req.method, path: new URL(req.url).pathname,
      accepted: [firstKey, nextKey].some(key => req.headers.get("authorization") === `Bearer ${key}`) });
    if (mode === "hang") { await Bun.sleep(11_000); return Response.json({ usages: {} }); }
    if (mode === "bad") return new Response(firstKey, { status: 401 });
    if (mode === "other") return new Response(firstKey, { status: 429 });
    if (mode === "redirect") return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${provider.port}/unexpected` } });
    if (mode === "shape") return Response.json({ error: firstKey });
    if (mode === "json") return new Response(firstKey);
    return Response.json({ usages: {} });
  } });
  const controlProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const controlPort = controlProbe.port!;
  controlProbe.stop(true);
  const initial = `# keep KIMI_CODE_KEY in this comment\nOTHER_KEY=untouched\nBRAIN_CONTROL_TOKEN=${controlToken}\nBRAIN_CONTROL_PORT=${controlPort}\n`;
  writeFileSync(envFile, initial);
  const preload = join(dir, "local-provider.ts");
  writeFileSync(preload, `
const realFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "https://api.kimi.com/coding/v1/usages") return realFetch(${JSON.stringify(`http://127.0.0.1:${provider.port}/coding/v1/usages`)}, init);
  if (/^https?:/.test(url) && !url.startsWith("http://127.0.0.1:")) throw new Error("test forbids external requests");
  return realFetch(input, init);
});
const { headsSnapshot } = await import(${JSON.stringify(join(import.meta.dir, "../../Brain/brain.ts"))});
const { startAuthenticatedControlEndpoint } = await import(${JSON.stringify(join(import.meta.dir, "../../Brain/control-endpoint.ts"))});
const state = { effort: null };
startAuthenticatedControlEndpoint({ port: ${controlPort}, token: ${JSON.stringify(controlToken)},
  handle: async () => ({ ok: false }), serve: options => Bun.serve(options),
  heads: () => headsSnapshot(state, null) });
`);
  let app: Awaited<ReturnType<typeof startTestApp>> | undefined;
  let stdout: Promise<string> | undefined, stderr: Promise<string> | undefined;
  try {
    app = await startTestApp({ cwd: dir,
      cmd: [process.execPath, `--preload=${preload}`, join(import.meta.dir, "server.ts")],
      env: { PATH: process.env.PATH, HOME: dir, EMBERVY_HOME: dir, EMBERVY_HARNESS: "brain",
        BRAIN_ENV_FILE: envFile, BRAIN_STATE_DIR: join(dir, "state"), BRAIN_LOG_DIR: join(dir, "logs"),
        BRAIN_WEB_BROWSER: "off", BRAIN_STERILE: "1", BRAIN_HEAD: "api",
        EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_TERMINAL_PANEL: "0",
        APP_SESSION_SECRET: "kimi-human-session-secret", INTERNAL_API_TOKEN: "agent-test-bearer" },
      spawn(cmd, opts) {
        const proc = Bun.spawn(cmd, { ...opts, stdout: "pipe", stderr: "pipe" });
        stdout = new Response(proc.stdout).text();
        stderr = new Response(proc.stderr).text();
        return proc;
      },
    });
    const call = (action: string, key?: unknown, headers: Record<string, string> = { cookie: app!.cookie }) =>
      fetch(`${app!.base}/api/brain/key-setup/kimi/${action}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ key }) });
    const heads = async () => {
      const response = await fetch(`${app!.base}/api/brain/heads`, { headers: { cookie: app!.cookie } });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect([firstKey, nextKey].some(k => text.includes(k))).toBe(false);
      return JSON.parse(text);
    };
    for (const action of ["save", "remove"]) {
      // Direct same-host requests are intentionally NOT trusted here.
      for (const headers of [{}, { authorization: "Bearer agent-test-bearer" }, { cookie: "session=forged" }]) {
        expect((await call(action, firstKey, headers)).status).toBe(401);
      }
    }
    expect(requests).toBe(0);
    let menu = await heads();
    expect(menu.heads.filter((h: any) => h.setup === "key").map((h: any) => h.name)).toEqual(["kimi"]);
    expect(menu.heads.find((h: any) => h.name === "kimi").available).toBe(false);
    for (const key of [null, "", "short", " ".repeat(20), "x".repeat(513), "12345678\n", "12345678\r", "12345678\t", "12345678\u007f", "12345678é", " 12345678",
      "NOT-A-REAL-KIMI-KEY-$TWO", "12345678#comment", "12345678 space", '12345678"quoted"', "12345678'quoted'", "12345678\\backslash"]) {
      const response = await call("save", key);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe(loadStrings().strings["brainMenu.key.error.invalid"]);
      expect(readFileSync(envFile).equals(Buffer.from(initial))).toBe(true);
    }
    expect(requests).toBe(0);
    for (const failingMode of ["bad", "other", "redirect", "shape", "json", "hang"]) {
      mode = failingMode;
      const before = requests;
      const started = performance.now();
      const result = await call("save", firstKey);
      expect(result.status).toBe(mode === "bad" ? 400 : 502);
      const text = await result.text();
      expect(text.includes(firstKey)).toBe(false);
      expect(text.includes("Nothing was saved")).toBe(true);
      expect(readFileSync(envFile, "utf8") === initial).toBe(true);
      expect(requests - before).toBe(1);
      if (mode === "hang") expect(performance.now() - started < 10_900).toBe(true);
    }
    mode = "ok";
    for (const key of [firstKey, nextKey]) {
      if (key === nextKey) writeFileSync(envFile, readFileSync(envFile, "utf8") + "export KIMI_CODE_KEY='duplicate-not-real'\n KIMI_CODE_KEY = duplicate-not-real\n");
      const before = requests;
      const response = await call("save", key);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(text.includes(key)).toBe(false);
      const body = JSON.parse(text);
      expect(Object.keys(body).sort()).toEqual(["effective", "ok"]);
      expect(body.ok).toBe(true);
      expect(body.effective.includes("when switching to Kimi")).toBe(true);
      const saved = readFileSync(envFile, "utf8");
      expect(readFileSync(envFile).equals(Buffer.from(`${initial}KIMI_CODE_KEY=${key}\n`))).toBe(true);
      expect(saved.split("\n").filter(l => l.startsWith("KIMI_CODE_KEY=")).length).toBe(1);
      expect(saved.startsWith(initial)).toBe(true);
      expect(saved.includes("duplicate-not-real")).toBe(false);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      expect(requests - before).toBe(1);
      menu = await heads();
      const kimi = menu.heads.find((h: any) => h.name === "kimi");
      expect(kimi.available).toBe(true);
      expect(kimi.setup).toBeUndefined();
      expect(menu.current.head).toBe("api");
    }
    expect(seen.every(s => s.method === "GET" && s.path === "/coding/v1/usages" && s.accepted)).toBe(true);
    const beforeRemove = requests;
    const savedBeforeRemove = readFileSync(envFile);
    expect((await call("remove")).status).toBe(404);
    expect(requests).toBe(beforeRemove);
    expect(readFileSync(envFile).equals(savedBeforeRemove)).toBe(true);
    // Agent edits are observed by the same live Brain, without restarting it.
    for (const withKey of [false, true]) {
      writeFileSync(envFile, initial + "BRAIN_HEAD_SETUP_HIDE=unknown, kimi\n" + (withKey ? `KIMI_CODE_KEY=${nextKey}\n` : ""));
      menu = await heads();
      const kimi = menu.heads.find((h: any) => h.name === "kimi");
      expect(kimi.setupHidden).toBe(true);
      expect(kimi.available).toBe(withKey);
      expect(kimi.setup).toBe(withKey ? undefined : "key");
    }
    writeFileSync(envFile, initial);
    for (const head of ["glm", "gpt", "unknown"]) {
      expect((await fetch(`${app.base}/api/brain/key-setup/${head}/save`, { method: "POST", headers: { cookie: app.cookie } })).status).toBe(404);
    }
    provider.stop(true);
    const offline = await call("save", firstKey);
    expect(offline.status).toBe(502);
    expect((await offline.text()).includes(firstKey)).toBe(false);
    expect(readFileSync(envFile, "utf8") === initial).toBe(true);
    const files = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path, e.name)) : [join(path, e.name)]);
    const history = files(dir).filter(p => /\.(jsonl|log)$/.test(p)).map(p => readFileSync(p, "utf8")).join("\n");
    expect([firstKey, nextKey].some(k => history.includes(k))).toBe(false);
  } finally {
    provider.stop(true);
    if (app) { app.proc.kill(); await app.proc.exited; }
    const logs = `${await stdout ?? ""}\n${await stderr ?? ""}`;
    rmSync(dir, { recursive: true, force: true });
    expect([firstKey, nextKey].some(k => logs.includes(k))).toBe(false);
  }
}, 30_000);

test("a Claude-Code house cannot save or remove provider keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-not-brain-"));
  const app = await startTestApp({ cwd: dir, env: { PATH: process.env.PATH, HOME: dir,
    EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_HARNESS: "claude", EMBERVY_TERMINAL_PANEL: "0",
    APP_SESSION_SECRET: "kimi-claude-code-test-secret" } });
  try {
    for (const action of ["save", "remove"]) expect((await fetch(`${app.base}/api/brain/key-setup/kimi/${action}`, {
      method: "POST", headers: { cookie: app.cookie },
    })).status).toBe(404);
  } finally { app.proc.kill(); await app.proc.exited; rmSync(dir, { recursive: true, force: true }); }
}, 15_000);
