import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(join(tmpdir(), "watchdog-window-"));
const data = join(dir, "data");
const state = join(dir, "state", "watchdog_state.json");
const client = new Client({ name: "watchdog-window-test", version: "1" });
let server: ReturnType<typeof Bun.spawn> | undefined;
let base: string;
let cookie: string;
const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };

beforeAll(async () => {
  mkdirSync(join(dir, "state"));
  mkdirSync(join(dir, "bin"));
  for (const name of ["pgrep", "pkill", "setsid", "tmux"]) {
    const path = join(dir, "bin", name);
    writeFileSync(path, "#!/bin/sh\nexit 0\n");
    chmodSync(path, 0o755);
  }
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port;
  listener.stop(true);
  if (port === 3030) throw new Error("refusing to test on port 3030");
  base = `http://127.0.0.1:${port}`;
  const env = {
    PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: dir, TMUX_TMPDIR: dir, EMBERVY_HOME: dir, EMBERVY_APP_DATA_DIR: data,
    EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
    WATCHDOG_STATE_PATH: state, EMBERVY_HARNESS: "brain", EMBERVY_TERMINAL_PANEL: "0",
    EMBERVY_STRINGS_LOCAL: join(dir, "no-local-strings.json"),
    INTERNAL_API_TOKEN: "window-test-token", APP_PASSWORD: "window-test-password",
    APP_SESSION_SECRET: "window-test-session-secret",
  };
  server = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
    cwd: dir, env, stdout: "ignore", stderr: "ignore",
  });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = (await fetch(base + "/health")).ok; } catch {}
    if (!ready) await Bun.sleep(50);
  }
  if (!ready) throw new Error("test server did not start");
  const login = await fetch(base + "/api/auth", {
    method: "POST", headers: { ...viaTunnel, "content-type": "application/json" },
    body: JSON.stringify({ password: env.APP_PASSWORD }),
  });
  expect(login.status).toBe(200);
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [join(import.meta.dir, "mcp.ts")], cwd: dir, env, stderr: "ignore",
  }));
}, 15_000);

afterAll(async () => {
  await client.close();
  server?.kill();
  if (server) await server.exited;
  rmSync(dir, { recursive: true, force: true });
});

async function displays(window: number | null | undefined, warn: number, cut: number) {
  writeFileSync(state, JSON.stringify({
    last_check_ts: new Date().toISOString(), tokens: 5678, percent: 99, window,
    warn_tokens: warn, cut_tokens: cut, session_file: "main.jsonl", warn_active: false,
    last_warn_ts: "", last_cut_ts: "", pid: 1,
  }));
  const response = await fetch(base + "/api/message", {
    method: "POST", headers: { ...viaTunnel, cookie, "content-type": "application/json" },
    body: JSON.stringify({ text: "/watch" }),
  });
  expect(response.status).toBe(200);
  expect((await response.json()).slash).toBe(true);
  const outbox = readFileSync(join(data, "outbox.jsonl"), "utf8").trim().split("\n");
  const app = JSON.parse(outbox.at(-1)!).text as string;
  const result: any = await client.callTool({ name: "watchdog_status", arguments: {} });
  expect(result.isError).not.toBe(true);
  const mcp = String(result.content[0].text);
  for (const text of [app, mcp]) {
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
  }
  return { app, mcp };
}

test("/watch and watchdog_status use the 262,144-token head for percentages and labels", async () => {
  const { app, mcp } = await displays(262144, 209715, 235929);
  expect(app).toContain("Thresholds: WARN 80%, CUT 90%");
  expect(app).toContain("Context: 5,678 tokens (2%) / 262,144 tokens");
  expect(mcp).toContain("Thresholds: WARN at 209,715 (80%), CUT at 235,929 (90%)");
  expect(mcp).toContain("Context: 5,678 tokens (2% of 262,144)");
  for (const text of [app, mcp]) {
    expect(text).not.toContain("of 1M");
    expect(text).not.toContain("1M");
  }
});

test("/watch and watchdog_status label a million-token head as 1M", async () => {
  const { app, mcp } = await displays(1000000, 700000, 850000);
  expect(app).toContain("Thresholds: WARN 70%, CUT 85%");
  expect(app).toContain(" / 1M tokens");
  expect(mcp).toContain("Thresholds: WARN at 700,000 (70%), CUT at 850,000 (85%)");
  expect(mcp).toContain("% of 1M)");
});

for (const window of [undefined, null, 0, -1]) {
  test(`/watch and watchdog_status show absolute tokens for window=${window}`, async () => {
    const { app, mcp } = await displays(window, 209715, 235929);
    expect(app).toContain("Context: 5,678 tokens");
    expect(app).toContain("Thresholds: WARN 209,715 tokens, CUT 235,929 tokens");
    expect(mcp).toContain("Context: 5,678 tokens");
    expect(mcp).toContain("Thresholds: WARN at 209,715, CUT at 235,929");
    for (const text of [app, mcp]) {
      expect(text).not.toContain("%");
      expect(text).not.toContain("1M");
    }
  });
}
