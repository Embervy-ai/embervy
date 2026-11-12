import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("local trust never authorizes mail decisions without a human session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-trust-"));
  const data = join(dir, "data");
  const requests: any[] = [];
  const sender = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
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
      EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
      INTERNAL_API_TOKEN: "internal-test", APP_PASSWORD: "test-password", APP_SESSION_SECRET: "test-secret",
      EMBERVY_TRUST_SAME_HOST: "true", EMBERVY_TERMINAL_PANEL: "0", EMAIL_AUTO_SEND_CLEAN: "false",
      EMAIL_SENDER_URL: `http://127.0.0.1:${sender.port}/send`, EMAIL_SENDER_AUTH: "sender-test",
    }, stdout: "ignore", stderr: "pipe",
  });
  const call = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const rows = (file: string) => readFileSync(join(data, file), "utf8").trim().split("\n").map(line => JSON.parse(line));
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(base + "/health")).ok; } catch {}
      if (!ready) await Bun.sleep(100);
    }
    if (!ready) { server.kill(); throw new Error(`Startup failed: ${await new Response(server.stderr).text()}`); }
    const login = await call("/api/auth", { password: "test-password" }, { "cf-connecting-ip": "192.0.2.1" });
    const human = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const bearer = { authorization: "Bearer internal-test" };
    for (const route of ["direct", "reaction"]) {
      for (const action of ["send", "discard"]) {
        const queued: any = await (await call("/api/internal/send-email", {
          to: "recipient@example.test", subject: "Hello", body: "A short greeting.", delivery_id: crypto.randomUUID(),
        }, bearer)).json();
        expect(queued.status).toBe("pending_approval");
        const card = rows("email-approval-cards.jsonl").find(row => row.email_id === queued.id);
        const reaction = { message_id: card.card_id, emoji: action === "send" ? "❤️" : "😢" };
        const status = () => rows("email-outbox.jsonl").find(row => row.id === queued.id).status;
        const before = requests.length;
        for (const headers of [{}, bearer, { cookie: "embervy_session=forged" }]) {
          if (route === "direct") expect((await call("/api/send-email/approve", { id: queued.id, action }, headers)).status).toBe(403);
          else expect((await call("/api/react", reaction, headers)).status).toBe(200);
          expect(status()).toBe("pending_approval");
          expect(requests.length).toBe(before);
        }
        expect((await call("/api/internal/react", reaction, bearer)).status).toBe(200);
        expect(status()).toBe("pending_approval");
        const result = route === "direct"
          ? await call("/api/send-email/approve", { id: queued.id, action }, human)
          : await call("/api/react", reaction, human);
        expect(result.status).toBe(200);
        for (let i = 0; i < 100 && ["ready", "sending"].includes(status()); i++) await Bun.sleep(10);
        expect(status()).toBe(action === "send" ? "sent" : "discarded");
        expect(requests.length).toBe(before + (action === "send" ? 1 : 0));
      }
    }
  } finally {
    server.kill();
    await server.exited;
    sender.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
