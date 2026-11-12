import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("ready jobs recover with the same delivery ID and unreadable acceptance remains unknown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-outbox-"));
  const data = join(dir, "data"), path = join(data, "email-outbox.jsonl");
  mkdirSync(data);
  const payload = { to: "recipient@example.test", subject: "Hello", body: "Text" };
  writeFileSync(path, JSON.stringify({ ...payload, id: "stable-restart-id", status: "ready", created_at: new Date().toISOString() }) + "\n");
  let mode = "sent";
  const ids: string[] = [];
  const worker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    ids.push(req.headers.get("Idempotency-Key")!);
    return mode === "sent" ? Response.json({ ok: true, status: "sent" }) : new Response("acceptance response lost");
  } });
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port; listener.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const start = () => Bun.spawn([process.execPath, "run", join(import.meta.dir, "server.ts")], {
    cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, TMUX_TMPDIR: dir, EMBERVY_APP_DATA_DIR: data,
      EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), INTERNAL_API_TOKEN: "internal", APP_PASSWORD: "password", APP_SESSION_SECRET: "secret",
      EMBERVY_TERMINAL_PANEL: "0", EMAIL_AUTO_SEND_CLEAN: "true", EMAIL_SENDER_URL: `http://127.0.0.1:${worker.port}/send`, EMAIL_SENDER_AUTH: "sender" },
    stdout: "ignore", stderr: "pipe",
  });
  const ready = async () => { for (let i = 0; i < 100; i++) { try { if ((await fetch(base + "/health")).ok) return; } catch {} await Bun.sleep(100); } throw new Error("server unavailable"); };
  let child = start();
  try {
    await ready();
    for (let i = 0; i < 100 && !ids.length; i++) await Bun.sleep(20);
    expect(ids).toEqual(["stable-restart-id"]);
    const post = async (id: string) => (await fetch(base + "/api/internal/send-email", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer internal" }, body: JSON.stringify({ ...payload, delivery_id: id }),
    })).json() as Promise<any>;
    expect((await post("stable-restart-id")).status).toBe("sent"); expect(ids).toHaveLength(1);
    mode = "lost";
    expect((await post("uncertain-id")).status).toBe("unknown");
    expect((await post("uncertain-id")).status).toBe("unknown"); expect(ids).toHaveLength(2);
    child.kill(); await child.exited;
    const entries = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    entries.push({ ...payload, id: "second-restart-id", status: "ready" });
    writeFileSync(path, entries.map(row => JSON.stringify(row)).join("\n") + "\n");
    mode = "sent"; child = start(); await ready();
    for (let i = 0; i < 100 && ids.length < 3; i++) await Bun.sleep(20);
    expect(ids).toEqual(["stable-restart-id", "uncertain-id", "second-restart-id"]);
    expect((await post("uncertain-id")).status).toBe("unknown");
    const automatic = async (extra: any = {}) => (await fetch(base + "/api/internal/send-email", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer internal" },
      body: JSON.stringify({ ...payload, subject: "Automatic job", cc: "copy@example.test", ...extra }),
    })).json() as Promise<any>;
    const first = await automatic();
    expect(first.status).toBe("sent");
    const duplicate = await automatic();
    expect(duplicate.id).toBe(first.id); expect(duplicate.duplicate).toBe(true);
    expect(duplicate.created_at).toBeTruthy(); expect(duplicate.sent_at).toBeTruthy();
    const count = ids.length;
    child.kill(); await child.exited; child = start(); await ready();
    expect((await automatic()).id).toBe(first.id); expect(ids).toHaveLength(count);
    expect((await automatic({ cc: "different@example.test" })).id).not.toBe(first.id);
    expect((await automatic({ delivery_id: "intentional-repeat" })).id).toBe("intentional-repeat");
    const rows = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
    for (const row of rows) row.created_at = new Date(Date.now() - 25 * 3600_000).toISOString();
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    const later = await automatic(); expect(later.id).not.toBe(first.id); expect(later.duplicate).not.toBe(true);
  } finally { child.kill(); await child.exited; worker.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 25000);

test("MCP reports sent, failed, pending approval and unknown without inventing success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-mcp-out-"));
  let status = "sent";
  const ids: string[] = [];
  const app = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const body: any = await req.json(); ids.push(body.delivery_id);
    return Response.json({ ok: ["sent", "pending_approval"].includes(status), status, id: body.delivery_id || "app-derived-id",
      ...(body.delivery_id ? {} : { duplicate: true, created_at: "2026-10-11T10:00:00.000Z", sent_at: "2026-10-11T10:01:00.000Z" }),
      error: status === "failed" ? "provider rejected" : undefined });
  } });
  const client = new Client({ name: "mail-out-test", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["run", join(import.meta.dir, "mcp.ts")], cwd: dir,
      env: { PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(app.port), INTERNAL_API_TOKEN: "internal" }, stderr: "ignore" }));
    for (const [state, expected] of [["sent", "Email sent."], ["failed", "Email failed: provider rejected"], ["pending_approval", "Not sent. Awaiting"], ["unknown", "Possibly sent; do not compose"]]) {
      status = state;
      const result: any = await client.callTool({ name: "email", arguments: { to: "recipient@example.test", subject: "Hello", body: "Text", delivery_id: "same-job" } });
      expect(result.content[0].text).toContain(expected);
      expect(result.content[0].text).not.toContain("Ready —");
    }
    expect(ids).toEqual(["same-job", "same-job", "same-job", "same-job"]);
    status = "sent";
    const automatic: any = await client.callTool({ name: "email", arguments: { to: "recipient@example.test", subject: "Hello", body: "Text" } });
    expect(automatic.content[0].text).toContain("app-derived-id");
    expect(automatic.content[0].text).toContain("Existing job (no new mail queued)");
    expect(automatic.content[0].text).toContain("2026-10-11T10:01:00.000Z");
  } finally { await client.close(); app.stop(true); rmSync(dir, { recursive: true, force: true }); }
}, 20000);
