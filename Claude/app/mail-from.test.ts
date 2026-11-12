import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const autoSend of [true, false]) {
  test(`outgoing sender reaches the worker unchanged or absent (auto send: ${autoSend})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "mail-from-"));
    const requests: any[] = [];
    const sender = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      expect(req.headers.get("authorization")).toBe("Bearer sender-test");
      requests.push(await req.json());
      return Response.json({ ok: true });
    } });
    const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = listener.port;
    listener.stop(true);
    if (port === 3030) throw new Error("refusing default port");
    const base = `http://127.0.0.1:${port}`;
    const server = Bun.spawn([process.execPath, "run", join(import.meta.dir, "server.ts")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir,
        EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
        INTERNAL_API_TOKEN: "internal-test", APP_PASSWORD: "test-password", APP_SESSION_SECRET: "test-session-secret",
        EMBERVY_TERMINAL_PANEL: "0", EMAIL_AUTO_SEND_CLEAN: String(autoSend),
        EMAIL_SENDER_URL: `http://127.0.0.1:${sender.port}/send`, EMAIL_SENDER_AUTH: "sender-test",
      }, stdout: "ignore", stderr: "pipe",
    });
    try {
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        try { ready = (await fetch(`${base}/health`)).ok; } catch {}
        if (!ready) await Bun.sleep(100);
      }
      if (!ready) {
        server.kill();
        throw new Error(`Test server startup failed: ${await new Response(server.stderr).text()}`);
      }
      const login = await fetch(`${base}/api/auth`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test-password" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      for (const from of [undefined, "", "   ", "Reply <reply@example.test>"]) {
        const res = await fetch(`${base}/api/internal/send-email`, {
          method: "POST", headers: { "content-type": "application/json", authorization: "Bearer internal-test" },
          body: JSON.stringify({ to: "recipient@example.test", subject: "Hello", body: "A short greeting.", from, delivery_id: crypto.randomUUID() }),
        });
        expect(res.status).toBe(200);
        const draft: any = await res.json();
        expect(draft.ok).toBe(true);
        if (!autoSend) {
          expect(draft.status).toBe("pending_approval");
          const approved = await fetch(`${base}/api/send-email/approve`, {
            method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ id: draft.id, action: "send" }),
          });
          expect((await approved.json() as any).status).toBe("sent");
        } else expect(draft.status).toBe("sent");
        const sent = requests.at(-1);
        expect(sent).toMatchObject({ to: "recipient@example.test", subject: "Hello", body: "A short greeting." });
        if (from?.trim()) expect(sent.from).toBe(from);
        else expect(Object.hasOwn(sent, "from")).toBe(false);
      }
      expect(requests).toHaveLength(4);
    } finally {
      server.kill();
      await server.exited;
      sender.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
}
