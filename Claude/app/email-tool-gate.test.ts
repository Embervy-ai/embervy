import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mailbox = {
  MAILBOX_PROVIDER: "imap", MAILBOX_HOST: "imap.example.test",
  MAILBOX_USER: "person@example.test", MAILBOX_APP_PASSWORD: "synthetic",
};

const cases = [
  { name: "nothing configured", sender: false, auth: false, mailbox: false, writing: false, enabled: false },
  { name: "sender URL only", sender: true, auth: false, mailbox: false, writing: false, enabled: false },
  { name: "sender auth only", sender: false, auth: true, mailbox: false, writing: false, enabled: false },
  { name: "agent-address sender configured", sender: true, auth: true, mailbox: false, writing: false, enabled: false },
  { name: "person's read-only mailbox", sender: false, auth: false, mailbox: true, writing: false, enabled: false },
  { name: "person's mailbox writing set up but switched off", sender: false, auth: false, mailbox: true, writing: true, enabled: false },
  { name: "person's mailbox writing set up and switched on", sender: false, auth: false, mailbox: true, writing: true, enabled: true },
  { name: "both mail features configured", sender: true, auth: true, mailbox: true, writing: true, enabled: true },
];

for (const config of cases) {
  test(`email tool gate: ${config.name}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "email-tool-gate-"));
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "mailbox-write.json"), JSON.stringify({ enabled: config.enabled }));
    const app = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "no room" }, { status: 404 }) });
    const client = new Client({ name: "email-tool-gate-test", version: "1" });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: [join(import.meta.dir, "mcp.ts")], cwd: dir,
        env: {
          PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir,
          EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(app.port),
          INTERNAL_API_TOKEN: "internal-test",
          EMAIL_SENDER_URL: config.sender ? `http://127.0.0.1:${app.port}/send` : "",
          EMAIL_SENDER_AUTH: config.auth ? "sender-test" : "",
          ...(config.mailbox ? mailbox : {}), MAILBOX_ALLOW_SEND: String(config.writing),
        }, stderr: "ignore",
      }));
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names.includes("email")).toBe(config.sender && config.auth);
      expect(names.includes("draft_mail")).toBe(config.writing);
      expect(names.includes("send_mail_draft")).toBe(config.writing);
      expect(names).toEqual(expect.arrayContaining(["reply", "send", "calendar", "react", "voice_reply", "watchdog_status"]));
    } finally {
      await client.close();
      app.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}

for (const token of [undefined, "", "worker-test"] as const) {
  test(`inbound add-on door: ${token === undefined ? "unset token" : token ? "configured token" : "empty token"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "email-inbound-gate-"));
    const data = join(dir, "data");
    const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = listener.port;
    listener.stop(true);
    const base = `http://127.0.0.1:${port}`;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "server.ts")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, TMUX_TMPDIR: dir,
        EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
        INTERNAL_API_TOKEN: "internal-test", APP_PASSWORD: "password", APP_SESSION_SECRET: "session-test",
        EMBERVY_TERMINAL_PANEL: "0", EMBERVY_TRUST_SAME_HOST: "true",
        ...(token === undefined ? {} : { EMAIL_WORKER_TOKEN: token }),
      }, stdout: "ignore", stderr: "ignore",
    });
    const post = (authorization?: string) => fetch(base + "/api/email-inbox", {
      method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
      body: JSON.stringify({ id: "inbound-test", from: "external@example.test", subject: "Hello", body: "Foreign input" }),
    });
    try {
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        try { ready = (await fetch(base + "/health")).ok; } catch {}
        if (!ready) await Bun.sleep(50);
      }
      if (!ready) throw new Error("Test server did not start");
      for (const authorization of [undefined, "Bearer wrong", "Bearer internal-test", "Bearer worker-test"]) {
        if (token && authorization === "Bearer worker-test") continue;
        const response = await post(authorization);
        expect(response.status).toBe(token ? 401 : 503);
        expect(await response.json()).toEqual({ error: token ? "unauthorized" : "EMAIL_WORKER_TOKEN not configured" });
      }
      expect(existsSync(join(data, "email-inbox.jsonl"))).toBe(false);
      expect(existsSync(join(data, "inbox.jsonl"))).toBe(false);
      if (token) {
        expect((await post("Bearer worker-test")).status).toBe(200);
        const entry = JSON.parse(readFileSync(join(data, "inbox.jsonl"), "utf8").trim());
        expect(entry).toMatchObject({ id: "inbound-test", source: "email", from: "external@example.test" });
        expect(entry.user).toBeUndefined();
      }
    } finally {
      child.kill();
      await child.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
}
