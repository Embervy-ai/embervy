import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("internal mailbox delivery requires bearer and persists foreign inbox input exactly once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-inbox-"));
  const data = join(dir, "data");
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port;
  listener.stop(true);
  if (port === 3030) throw new Error("refusing default port");
  const base = `http://127.0.0.1:${port}`;
  const server = Bun.spawn([process.execPath, "run", join(import.meta.dir, "server.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH!, HOME: dir, TMUX_TMPDIR: dir, EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), INTERNAL_API_TOKEN: "internal-test", EMAIL_WORKER_TOKEN: "worker-test", APP_PASSWORD: "test-password", APP_SESSION_SECRET: "test-session-secret", EMBERVY_TERMINAL_PANEL: "0" },
    stdout: "ignore", stderr: "pipe",
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
    const body = { id: "mail-test-1", from: "sender@example.test", text: "[Mailbox] 1 new: test", source: "user", type: "send" };
    const post = (headers: Record<string, string>) => fetch(`${base}/api/internal/mail-inbox`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await post({})).status).toBe(401);
    expect((await post({ cookie })).status).toBe(401);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(401);
    const inbox = join(data, "inbox.jsonl");
    mkdirSync(inbox);
    expect((await post({ authorization: "Bearer internal-test" })).status).toBe(500);
    rmSync(inbox, { recursive: true });
    expect((await post({ authorization: "Bearer internal-test" })).status).toBe(200);
    expect(await (await post({ authorization: "Bearer internal-test" })).json()).toMatchObject({ ok: true, duplicate: true });
    const entries = readFileSync(inbox, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: body.id, from: body.from, text: body.text, source: "email" });
    expect(entries[0].type).toBeUndefined();
    const outbox = join(data, "outbox.jsonl");
    expect(existsSync(outbox) ? readFileSync(outbox, "utf8") : "").not.toContain(body.id);
    const history: any = await (await fetch(`${base}/api/messages`, { headers: { cookie } })).json();
    expect(history.filter((m: any) => m.id === body.id)).toHaveLength(1);
    expect(history.find((m: any) => m.id === body.id).role).toBe("email");
    const policy = (await fetch(`${base}/health`)).headers.get("content-security-policy");
    expect(policy).toContain("img-src 'self' data: blob:");
    const overlap = async (id: string) => fetch(`${base}/api/internal/mail-inbox`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer internal-test" }, body: JSON.stringify({ ...body, id, mailKey: "same-mail-across-validity" }) });
    expect((await overlap("uid-old")).status).toBe(200);
    expect(await (await overlap("uid-new")).json()).toMatchObject({ ok: true, duplicate: true });
    const batch = (mails: any[]) => fetch(`${base}/api/internal/mail-inbox`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer internal-test" }, body: JSON.stringify({ ...body, id: `batch-${mails.length}`, mails, mailKeys: mails.map((m) => m.mailKey) }) });
    const mails = Array.from({ length: 40 }, (_, i) => ({ mailKey: `key-${i}`, subject: `subject-${i}`, from: "sender" }));
    const rows = () => readFileSync(inbox, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const before = rows().length;
    expect((await batch(mails)).status).toBe(200);
    expect(rows()).toHaveLength(before + 1);
    expect(rows().at(-1).mailKeys).toHaveLength(40);
    expect(rows().at(-1).text.match(/^- /gm)).toHaveLength(10);
    expect(rows().at(-1).text).toEndWith("…and 30 more");
    expect(await (await batch(mails)).json()).toMatchObject({ ok: true, duplicate: true });
    const extra = { mailKey: "key-extra", subject: "new arrival", from: "new sender" };
    expect((await batch([...mails, extra])).status).toBe(200);
    expect(rows()).toHaveLength(before + 2);
    expect(rows().at(-1).mailKeys).toEqual([extra.mailKey]);
    expect(rows().at(-1).text).toBe("[Mailbox] 1 new:\n- new arrival (from new sender)");
    expect(await (await batch([...mails, extra])).json()).toMatchObject({ duplicate: true });
    const legacyEmail = { from: "old-sender", subject: "without id", body: "legacy body" };
    const legacyPost = () => fetch(`${base}/api/email-inbox`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer worker-test" }, body: JSON.stringify(legacyEmail) });
    expect((await legacyPost()).status).toBe(200);
    expect(await (await legacyPost()).json()).toMatchObject({ duplicate: true });
    rmSync(join(data, "email-inbox.jsonl"));
    const email = { id: "email-stable", from: "sender@example.test", subject: "subject", body: "mail body" };
    const workerPost = () => fetch(`${base}/api/email-inbox`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer worker-test" }, body: JSON.stringify(email) });
    rmSync(inbox);
    mkdirSync(inbox);
    expect((await workerPost()).status).toBe(500);
    const storedMail = join(data, "email-inbox.jsonl");
    expect(readFileSync(storedMail, "utf8").trim().split("\n")).toHaveLength(1);
    rmSync(inbox, { recursive: true });
    expect((await workerPost()).status).toBe(200);
    expect(await (await workerPost()).json()).toMatchObject({ ok: true, duplicate: true });
    expect(readFileSync(storedMail, "utf8").trim().split("\n")).toHaveLength(1);
    const repaired = readFileSync(inbox, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(repaired).toHaveLength(1);
    expect(repaired[0]).toMatchObject({ id: email.id, source: "email" });
  } finally {
    server.kill();
    await server.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
