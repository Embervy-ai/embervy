import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let server: ReturnType<typeof Bun.spawn>;
let dir = "", base = "", cookie = "";
const tunnel = { "cf-ray": "test", "cf-connecting-ip": "203.0.113.8" };
const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "cache-private-"));
  const data = join(dir, "data");
  for (const sub of ["images", "shared"]) {
    mkdirSync(join(data, sub), { recursive: true });
    for (const name of ["test.png", "test.mp3", "test.pdf", "test.bin", "test.txt"]) {
      writeFileSync(join(data, sub, name), "test bytes for cache checks");
    }
  }
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port; probe.stop(true);
  if (port === 3030) throw new Error("Refusing service port");
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
    cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir,
      EMBERVY_APP_PORT: String(port), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_DATA_DIR: data,
      APP_PASSWORD: "test-password", APP_SESSION_SECRET: "test-session-secret", EMBERVY_TRUST_SAME_HOST: "true",
      INTERNAL_API_TOKEN: "test-internal", EMBERVY_TERMINAL_PANEL: "0" }, stdout: "ignore", stderr: "ignore",
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${base}/health`)).ok; } catch {}
    if (!up) await Bun.sleep(100);
  }
  if (!up) throw new Error("Server unavailable");
  const login = await fetch(`${base}/api/auth`, { method: "POST", headers: { ...tunnel, "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
  expect(login.status).toBe(200);
  cookie = login.headers.get("set-cookie")!.split(";")[0];
}, 30000);
afterAll(async () => {
  try {
    if (server) { server.kill(); await server.exited; }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

for (const trusted of [false, true]) {
  for (const [path, headers] of [
    ["test.png", {}], ["test.mp3", {}], ["test.pdf?raw=1", {}], ["test.bin", {}],
    ["test.mp3", { range: "bytes=0-3" }], ["test.pdf", { accept: "text/html" }],
    ["test.txt?raw=1", { accept: "text/html" }],
  ] as [string, Record<string, string>][]) {
    test(`${trusted ? "trusted" : "session"} ${path} ${JSON.stringify(headers)} is private`, async () => {
      const res = await fetch(`${base}/api/images/${path}`, { headers: { ...(trusted ? {} : { ...tunnel, cookie }), ...headers } });
      expect(res.ok).toBe(true);
      if (headers.range) expect(res.status).toBe(206);
      const cache = res.headers.get("cache-control")!;
      expect(cache).toMatch(/\b(private|no-store)\b/);
      expect(cache).not.toMatch(/\bpublic\b/);
      if (path.includes("raw=1")) expect(res.headers.get("vary")).toBe("Accept");
      if (path === "test.bin") expect(res.headers.get("content-disposition")).toBe("attachment");
      await res.arrayBuffer();
    });
  }
}
test("shares stay out of shared caches and login scripts retain their freshness", async () => {
  for (const auth of [{}, { cookie }]) {
    const res = await fetch(`${base}/share/test.png`, { headers: { ...tunnel, ...auth } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private");
    await res.arrayBuffer();
  }
  for (const path of ["test.mp3", "test.bin", "test.txt?raw=1", "test.pdf?raw=1", "test.pdf", "missing.png", "bad%00.txt"]) {
    const res = await fetch(`${base}/share/${path}`, { headers: { ...tunnel, accept: "text/html" } });
    expect(res.headers.get("cache-control")).toMatch(/(?:^|,)\s*(?:private|no-store)\b/);
    await res.arrayBuffer();
  }
  const range = await fetch(`${base}/share/test.png`, { headers: { ...tunnel, range: "bytes=0-3" } });
  expect(range.status).toBe(206);
  expect(range.headers.get("cache-control")).toBe("private");
  await range.arrayBuffer();
  expect((await fetch(`${base}/login.js`, { headers: tunnel })).headers.get("cache-control")).toBe("no-cache");
});
test("the gate preserves freshness and existing privacy", async () => {
  const start = source.indexOf("  const next = async () => {", source.indexOf("app.use(\"*\", async (c, publicNext)"));
  const end = source.indexOf("\n  };", start);
  const run = new Function("c", "publicNext", `${source.slice(start, end + 5)}; return next();`);
  for (const [input, output] of [[null, "private"], ["public, max-age=3600", "private, max-age=3600"], ["no-cache", "private, no-cache"], ["private, max-age=9", "private, max-age=9"], ["no-store", "no-store"]]) {
    const c = { res: new Response("ok", { headers: input ? { "cache-control": input } : {} }) };
    await run(c, async () => {});
    expect(c.res.headers.get("cache-control")).toBe(output);
  }
  const immutable = { res: Response.redirect("https://app.test/file") };
  await run(immutable, async () => {});
  expect(immutable.res.status).toBe(302);
  expect(immutable.res.headers.get("cache-control")).toBe("private");
});
