import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// A message counts as delivered only once the outbox holds it.
// Against the real server.ts and the real mcp.ts bridge, both as
// throw-away processes: random port, own data dir, no browser, no push. A
// directory at the outbox path makes the write fail for real (EISDIR).

const INTERNAL = "internal-test-token-0123456789";
let server: ReturnType<typeof Bun.spawn>;
let client: Client;
let base = "";
let dir = "";
let dataDir = "";
let outbox = "";

import { startTestApp } from "./test-app-start";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "broadcast-outbox-"));
  dataDir = join(dir, "data");
  outbox = join(dataDir, "outbox.jsonl");
  const common = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: dir,
    TMUX_TMPDIR: dir, // any tmux call finds no server — never a live pane
    EMBERVY_APP_PORT: "",
    EMBERVY_APP_HOST: "127.0.0.1",
    INTERNAL_API_TOKEN: INTERNAL,
    AGENT_LABEL: "Testagent",
    USER_LABEL: "Sam",
  };
  const app = await startTestApp({
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      ...common,
      EMBERVY_APP_DATA_DIR: dataDir,
      APP_PASSWORD: "test-password-not-real",
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "broadcast-outbox-test-no-such-session",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc: server } = app);
  common.EMBERVY_APP_PORT = String(app.port);

  client = new Client({ name: "broadcast-outbox-test", version: "0.0.0" });
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

const broadcast = (body: unknown) =>
  fetch(`${base}/api/internal/broadcast`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${INTERNAL}` },
    body: JSON.stringify(body),
  });
const entries = (id: string): any[] =>
  existsSync(outbox)
    ? readFileSync(outbox, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id === id)
    : [];
const reply = async (args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name: "reply", arguments: args });
  return { isError: Boolean(r.isError), text: String(r.content?.[0]?.text ?? "") };
};

describe("a message is delivered once the outbox holds it", () => {
  test("a failed outbox write is no delivery; the same id lands exactly once after repair", async () => {
    mkdirSync(outbox, { recursive: true }); // a directory where the file goes: EISDIR

    const failed = await broadcast({ id: "outbox-failure-1", text: "Must survive an offline client", type: "reply" });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ ok: false });

    rmSync(outbox, { recursive: true, force: true }); // the write path works again

    const retry = await broadcast({ id: "outbox-failure-1", text: "Must survive an offline client", type: "reply" });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    expect(entries("outbox-failure-1")).toHaveLength(1);

    const again = await broadcast({ id: "outbox-failure-1", text: "Must survive an offline client", type: "reply" });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(entries("outbox-failure-1")).toHaveLength(1);
  });

  test("through the bridge: reply says NOT delivered while the write fails, the retry with its id is stored once", async () => {
    if (existsSync(outbox)) renameSync(outbox, `${outbox}.first-test`); // keep the first test's file out of the way
    mkdirSync(outbox, { recursive: true });

    const first = await reply({ text: "Message must survive offline client", id: "audit-outbox-failure" });
    expect(first.isError).toBe(true);
    expect(first.text).toContain("NOT delivered");
    expect(first.text).toContain("HTTP 500");

    rmSync(outbox, { recursive: true, force: true });

    const second = await reply({ text: "Message must survive offline client", id: "audit-outbox-failure" });
    expect(second.isError).toBe(false);
    expect(second.text).not.toContain("NOT delivered");
    expect(entries("audit-outbox-failure")).toHaveLength(1);
  }, 30_000);
});
