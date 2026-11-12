import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("app tests do not directly load packages outside the app dependencies", () => {
  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "package.json"), "utf8"));
  const allowed = new Set([...builtinModules, ...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
  const offenders: string[] = [];
  for (const file of readdirSync(import.meta.dir).filter(name => name.endsWith(".test.ts"))) {
    const source = readFileSync(join(import.meta.dir, file), "utf8");
    const loads = source.matchAll(/(?:^\s*import\s+(?:[^;]*?\s+from\s*)?|\b(?:import|require|Bun\.resolveSync)\s*\(\s*)["']([^"']+)["']/gm);
    for (const match of loads) {
      const specifier = match[1];
      // A guarded availability probe is not a load; it only decides whether to skip.
      const lineStart = source.lastIndexOf("\n", match.index) + 1;
      const context = source.slice(source.lastIndexOf("\n", lineStart - 2) + 1, source.indexOf("\n", match.index));
      if (context.includes("optional-probe")) continue;
      if (/^(?:[./]|node:|bun:)/.test(specifier)) continue;
      const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
      if (!allowed.has(name)) offenders.push(`${file}: ${specifier}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("mailbox draft cards bind content and consume human approval even with general approvals disabled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-draft-approval-"));
  const raw = join(dir, "draft.txt"), sends = join(dir, "sends.txt");
  writeFileSync(raw, "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Reviewed\r\n\r\nOriginal body");
  const preload = join(dir, "preload.ts");
  writeFileSync(preload, `
    import { mock } from "bun:test";
    import { readFileSync, appendFileSync } from "node:fs";
    import { createHash } from "node:crypto";
    mock.module(${JSON.stringify(resolve(import.meta.dir, "../../shared/mail/imap.ts"))}, () => ({
      KNOWN_PROVIDERS: {},
      readDraft: async () => {
        const text = readFileSync(${JSON.stringify(raw)}, "utf8");
        return { hash: createHash("sha256").update(text).digest("hex"), detail: text };
      },
      // Mirrors the real sendDraft: the approved hash must still match the draft.
      sendDraft: async (...args) => {
        const expected = args.find((arg, index) => index > 1 && typeof arg === "string" && /^[0-9a-f]{64}$/.test(arg));
        const current = createHash("sha256").update(readFileSync(${JSON.stringify(raw)}, "utf8")).digest("hex");
        if (expected && expected !== current) throw new Error("draft changed since approval; not sent");
        appendFileSync(${JSON.stringify(sends)}, "sent\\n"); return { ok: true, detail: "sent" };
      }
    }));
  `);
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port; listener.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], {
    cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, TMUX_TMPDIR: dir,
      EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
      INTERNAL_API_TOKEN: "internal", APP_PASSWORD: "password", APP_SESSION_SECRET: "secret", EMBERVY_TERMINAL_PANEL: "0",
      MAILBOX_ALLOW_SEND: "true", MAILBOX_HOST: "imap.example.test", MAILBOX_USER: "sender@example.test", MAILBOX_APP_PASSWORD: "synthetic",
      APPROVAL_ENABLED: "false", BRAIN_APPROVAL_ENABLED: "false" }, stdout: "ignore", stderr: "pipe",
  });
  const bearer = { authorization: "Bearer internal" };
  const post = async (path: string, body: any, headers: any = bearer) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() as any };
  };
  const count = () => existsSync(sends) ? readFileSync(sends, "utf8").trim().split("\n").length : 0;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + "/health")).ok; } catch {} if (!ready) await Bun.sleep(100); }
    expect(ready).toBe(true);
    const login = await fetch(base + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
    const human = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    expect((await post("/api/approval/ask", { draft_id: "1" })).status).toBe(403);
    expect((await post("/api/mailbox-write/settings", { enabled: true }, human)).data.enabled).toBe(true);
    const ask = async (uid: string) => {
      const response = await post("/api/approval/ask", { draft_id: uid, title: "Spoofed", detail: "Spoofed" });
      expect({ status: response.status, error: response.data.error }).toEqual({ status: 200, error: undefined });
      const card: any = await (await fetch(base + `/api/approval/${response.data.id}`, { headers: bearer })).json();
      expect(card.title).not.toBe("Spoofed"); expect(card.detail).toContain("recipient@example.test"); expect(card.detail).toContain("Reviewed");
      return response.data.id;
    };
    const send = (id: string, uid: string) => post(`/api/approval/${id}/send-draft`, { draft_id: uid });
    const decide = (id: string, decision: string) => post(`/api/approval/${id}/decide`, { decision }, human);
    const pending = await ask("1");
    expect((await send(pending, "1")).data.ok).toBe(false); expect(count()).toBe(0);
    expect((await post(`/api/approval/${pending}/decide`, { decision: "allow" })).status).toBe(403);
    await decide(pending, "deny"); expect((await send(pending, "1")).data.status).toBe("deny"); expect(count()).toBe(0);
    const expired = await ask("2"); await decide(expired, "expired");
    expect((await send(expired, "2")).data.ok).toBe(false); expect(count()).toBe(0);
    const changed = await ask("3"); await decide(changed, "allow"); writeFileSync(raw, readFileSync(raw, "utf8") + " changed");
    expect((await send(changed, "3")).data.error).toContain("changed"); expect(count()).toBe(0);
    const allowed = await ask("4"); await decide(allowed, "allow");
    expect((await send(allowed, "999")).status).toBe(409);
    const results = await Promise.all([send(allowed, "4"), send(allowed, "4")]);
    expect(results.filter(r => r.data.ok)).toHaveLength(1); expect(count()).toBe(1);
    expect((await send(allowed, "4")).data.error).toContain("consumed"); expect(count()).toBe(1);
    const timed = await ask("5"); await decide(timed, "allow");
    const path = join(dir, "data", "approvals.jsonl");
    const rows = readFileSync(path, "utf8").trim().split("\n").map(l => JSON.parse(l));
    rows.find(row => row.id === timed).ts = new Date(Date.now() - 3600_000).toISOString();
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    expect((await send(timed, "5")).data.status).toBe("expired"); expect(count()).toBe(1);
  } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
}, 20000);

const hasImapflow = (() => { // optional-probe
   try { Bun.resolveSync("imapflow", resolve(import.meta.dir, "../../shared/mail")); return true; } catch { return false; } })();

test.skipIf(!hasImapflow)("mailbox draft cards against the real IMAP provider bind content and consume human approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-draft-approval-"));
  const raw = join(dir, "draft.txt"), sends = join(dir, "sends.txt");
  writeFileSync(raw, "From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Reviewed\r\n\r\nOriginal body");
  const preload = join(dir, "preload.ts");
  writeFileSync(preload, `
    import { mock } from "bun:test";
    import { readFileSync, appendFileSync } from "node:fs";
    // optional-probe: runs only when hasImapflow found the package
    mock.module(${JSON.stringify(Bun.resolveSync("imapflow", resolve(import.meta.dir, "../../shared/mail")))}, () => ({ ImapFlow: class {
      mailbox = { uidValidity: 42n };
      async connect() {} async logout() {} close() {}
      async getMailboxLock() { return { release() {} }; }
      async fetchOne() { return { envelope: { subject: "Reviewed" }, bodyStructure: { type: "text/plain", part: "1" } }; }
      async download(_uid, part) { const text = readFileSync(${JSON.stringify(raw)}, "utf8"); return { content: new Blob([part ? text.split("\\r\\n\\r\\n")[1] : text]).stream() }; }
      async messageMove() { return true; }
    } }));
    const { envelope, deriveSmtpHost } = await import(${JSON.stringify(resolve(import.meta.dir, "../../shared/mail/smtp.ts"))});
    mock.module(${JSON.stringify(resolve(import.meta.dir, "../../shared/mail/smtp.ts"))}, () => ({ envelope, deriveSmtpHost,
      sendRaw: async () => { appendFileSync(${JSON.stringify(sends)}, "sent\\n"); return { ok: true, detail: "sent" }; }
    }));
  `);
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port; listener.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], {
    cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, TMUX_TMPDIR: dir,
      EMBERVY_APP_DATA_DIR: join(dir, "data"), EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
      INTERNAL_API_TOKEN: "internal", APP_PASSWORD: "password", APP_SESSION_SECRET: "secret", EMBERVY_TERMINAL_PANEL: "0",
      MAILBOX_ALLOW_SEND: "true", MAILBOX_HOST: "imap.example.test", MAILBOX_USER: "sender@example.test", MAILBOX_APP_PASSWORD: "synthetic",
      APPROVAL_ENABLED: "false", BRAIN_APPROVAL_ENABLED: "false" }, stdout: "ignore", stderr: "pipe",
  });
  const bearer = { authorization: "Bearer internal" };
  const post = async (path: string, body: any, headers: any = bearer) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() as any };
  };
  const count = () => existsSync(sends) ? readFileSync(sends, "utf8").trim().split("\n").length : 0;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + "/health")).ok; } catch {} if (!ready) await Bun.sleep(100); }
    expect(ready).toBe(true);
    const login = await fetch(base + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "password" }) });
    const human = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    expect((await post("/api/approval/ask", { draft_id: "1" })).status).toBe(403);
    expect((await post("/api/mailbox-write/settings", { enabled: true }, human)).data.enabled).toBe(true);
    const ask = async (uid: string) => {
      const response = await post("/api/approval/ask", { draft_id: uid, title: "Spoofed", detail: "Spoofed" });
      expect({ status: response.status, error: response.data.error }).toEqual({ status: 200, error: undefined });
      const card: any = await (await fetch(base + `/api/approval/${response.data.id}`, { headers: bearer })).json();
      expect(card.title).not.toBe("Spoofed"); expect(card.detail).toContain("recipient@example.test"); expect(card.detail).toContain("Reviewed");
      return response.data.id;
    };
    const send = (id: string, uid: string) => post(`/api/approval/${id}/send-draft`, { draft_id: uid });
    const decide = (id: string, decision: string) => post(`/api/approval/${id}/decide`, { decision }, human);
    const pending = await ask("1");
    expect((await send(pending, "1")).data.ok).toBe(false); expect(count()).toBe(0);
    expect((await post(`/api/approval/${pending}/decide`, { decision: "allow" })).status).toBe(403);
    await decide(pending, "deny"); expect((await send(pending, "1")).data.status).toBe("deny"); expect(count()).toBe(0);
    const expired = await ask("2"); await decide(expired, "expired");
    expect((await send(expired, "2")).data.ok).toBe(false); expect(count()).toBe(0);
    const changed = await ask("3"); await decide(changed, "allow"); writeFileSync(raw, readFileSync(raw, "utf8") + " changed");
    expect((await send(changed, "3")).data.error).toContain("changed"); expect(count()).toBe(0);
    const allowed = await ask("4"); await decide(allowed, "allow");
    expect((await send(allowed, "999")).status).toBe(409);
    const results = await Promise.all([send(allowed, "4"), send(allowed, "4")]);
    expect(results.filter(r => r.data.ok)).toHaveLength(1); expect(count()).toBe(1);
    expect((await send(allowed, "4")).data.error).toContain("consumed"); expect(count()).toBe(1);
    const timed = await ask("5"); await decide(timed, "allow");
    const path = join(dir, "data", "approvals.jsonl");
    const rows = readFileSync(path, "utf8").trim().split("\n").map(l => JSON.parse(l));
    rows.find(row => row.id === timed).ts = new Date(Date.now() - 3600_000).toISOString();
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    expect((await send(timed, "5")).data.status).toBe("expired"); expect(count()).toBe(1);
  } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
}, 20000);
