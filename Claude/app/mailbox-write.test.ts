import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("Settings root notice is translated and stays inside the writing-only section", async () => {
  const html = readFileSync(join(import.meta.dir, "public/settings.html"), "utf8");
  const strings = JSON.parse(readFileSync(join(import.meta.dir, "strings/en.json"), "utf8"));
  const section = html.match(/<section[^>]*id="mailbox-write-section"[^>]*>([\s\S]*?)<\/section>/)![0];
  expect(section).toContain('class="settings-section hidden"');
  expect(section).toContain(`data-i18n="mailboxWrite.rootNotice">${strings["mailboxWrite.rootNotice"]}</div>`);
  const js = readFileSync(join(import.meta.dir, "public/settings.js"), "utf8");
  const setup = js.slice(js.indexOf("(async function setupMailboxWriting()"), js.indexOf("(async function setupModelSwitcher()"));
  for (const configured of [false, true]) {
    let hidden = true;
    const elements: Record<string, any> = {
      "mailbox-write-section": { classList: { remove: (name: string) => { if (name === "hidden") hidden = false; } } },
      "mailbox-write-enabled": { addEventListener() {} }, "mailbox-write-hint": {},
    };
    await new Function("$", "fetch", "t", `return ${setup}`)(
      (id: string) => elements[id], async () => Response.json({ configured, enabled: false }), (key: string) => strings[key],
    );
    expect(hidden).toBe(!configured);
  }
});

async function fixture(configured: boolean, provider = "imap", trustLocal = false) {
  const dir = mkdtempSync(join(tmpdir(), "mailbox-write-"));
  const calls = join(dir, "calls.jsonl"), dataDir = join(dir, "data");
  const preload = join(dir, "preload.ts");
  writeFileSync(preload, `
    import { mock } from "bun:test";
    import { appendFileSync } from "node:fs";
    const record = (op, data) => appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ op, ...data }) + "\\n");
    for (const provider of ["imap", "graph"]) {
      mock.module(${JSON.stringify(resolve(import.meta.dir, "../../shared/mail"))} + "/" + provider + ".ts", () => ({
        KNOWN_PROVIDERS: {},
        appendDraft: async (_account, opts) => { record("append", opts); return { ok: true, id: provider === "imap" ? "71" : "graph-created", detail: "saved" }; },
        readDraft: async (_account, id) => { record("read", { id }); return { hash: "bound-content", detail: "To: recipient@example.test\\nSubject: Reviewed\\n\\nPlain text" }; },
        sendDraft: async (_account, id) => { record("send", { id }); return { ok: true, detail: "sent" }; },
      }));
    }
  `);
  const listener = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = listener.port; listener.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, TMUX_TMPDIR: dir,
    EMBERVY_STRINGS_LOCAL: process.env.EMBERVY_STRINGS_LOCAL!,
    EMBERVY_APP_DATA_DIR: dataDir, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
    INTERNAL_API_TOKEN: "internal", BRAIN_APP_TOKEN: "agent", APP_PASSWORD: "password", APP_SESSION_SECRET: "secret",
    EMBERVY_TERMINAL_PANEL: "0", EMBERVY_TRUST_SAME_HOST: String(trustLocal),
    MAILBOX_PROVIDER: provider, MAILBOX_HOST: "imap.example.test", MAILBOX_USER: "sender@example.test",
    MAILBOX_APP_PASSWORD: "synthetic", MAILBOX_GRAPH_CLIENT_ID: "synthetic-client",
    APPROVAL_ENABLED: "false", BRAIN_APPROVAL_ENABLED: "false",
    ...(configured ? { MAILBOX_ALLOW_SEND: "true" } : {}),
  };
  let child: ReturnType<typeof Bun.spawn>;
  const clients: Client[] = [];
  const start = async () => {
    child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], { cwd: dir, env, stdout: "ignore", stderr: "ignore" });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try { ready = (await fetch(base + "/health")).ok; } catch {}
      if (!ready) await Bun.sleep(50);
    }
    if (!ready) throw new Error("test server did not start");
  };
  const stop = async () => { child.kill(); await child.exited; };
  const bearer = { authorization: "Bearer internal" };
  const post = async (path: string, body: unknown, headers: Record<string, string> = bearer) => {
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any };
  };
  const login = async () => {
    // A forwarded request uses password auth even when same-host trust is enabled.
    const response = await fetch(base + "/api/auth", { method: "POST", headers: { "content-type": "application/json", "cf-ray": "test" }, body: JSON.stringify({ password: "password" }) });
    expect(response.ok).toBe(true);
    return { cookie: response.headers.get("set-cookie")!.split(";")[0] };
  };
  const readCalls = () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const mcp = async () => {
    const client = new Client({ name: "mailbox-write-test", version: "1" });
    clients.push(client);
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "mcp.ts")], cwd: dir, env, stderr: "ignore" }));
    return client;
  };
  const close = async () => {
    for (const client of clients) await client.close();
    await stop(); rmSync(dir, { recursive: true, force: true });
  };
  try { await start(); } catch (e) { await close(); throw e; }
  return { base, dir, dataDir, env, post, login, readCalls, mcp, close, start, stop, bearer };
}
const draft = { to: "recipient@example.test", subject: "Reviewed", body: "<b>plain text</b>", in_reply_to: "<original@example.test>" };
function toolText(result: any) { return result.content.map((part: any) => part.text || "").join("\n"); }

test("without installer capability neither mailbox writing tool nor Settings row is offered, and routes refuse", async () => {
  const f = await fixture(false);
  try {
    const human = await f.login(), client = await f.mcp();
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).not.toContain("draft_mail"); expect(names).not.toContain("send_mail_draft"); expect(names).not.toContain("email");
    expect((await client.callTool({ name: "draft_mail", arguments: draft })).isError).toBe(true);
    writeFileSync(join(f.dataDir, "mailbox-write.json"), JSON.stringify({ enabled: true }));
    expect((await f.post("/api/internal/mailbox/draft", draft)).status).toBe(403);
    expect((await f.post("/api/approval/ask", { draft_id: "71" })).status).toBe(403);
    expect((await f.post("/api/approval/missing/send-draft", { draft_id: "71" })).status).toBe(403);
    expect((await f.post("/api/mailbox-write/settings", { enabled: true }, human)).status).toBe(403);
    const state = await (await fetch(f.base + "/api/mailbox-write/settings", { headers: human })).json();
    expect(state).toEqual({ configured: false, enabled: false });
    expect(await (await fetch(f.base + "/settings.html", { headers: human })).text()).not.toContain('id="mailbox-write-section"');
    expect(f.readCalls()).toEqual([]);
  } finally { await f.close(); }
}, 20000);

for (const provider of ["imap", "graph"]) {
  test(`${provider}: default-off writing, human-only consent, one draft and a required single-use card`, async () => {
    const f = await fixture(true, provider);
    try {
      const human = await f.login(), client = await f.mcp();
      const id = provider === "imap" ? "71" : "graph-created";
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toContain("draft_mail"); expect(names).toContain("send_mail_draft");
      expect(await (await fetch(f.base + "/api/mailbox-write/settings", { headers: human })).json()).toEqual({ configured: true, enabled: false });
      expect(await (await fetch(f.base + "/settings.html", { headers: human })).text()).toContain('id="mailbox-write-section"');
      expect(existsSync(join(f.dataDir, "mailbox-write.json"))).toBe(false);
      expect((await f.post("/api/internal/mailbox/draft", draft)).status).toBe(403);
      expect((await f.post("/api/approval/missing/send-draft", { draft_id: id })).status).toBe(403);
      expect(toolText(await client.callTool({ name: "draft_mail", arguments: draft }))).toContain("Only you can turn it on in Settings");
      expect(toolText(await client.callTool({ name: "send_mail_draft", arguments: { draft_id: id } }))).toContain("off");
      expect(f.readCalls()).toEqual([]);
      expect(existsSync(join(f.dataDir, "approvals.jsonl"))).toBe(false);
      for (const authorization of ["Bearer internal", "Bearer agent"]) {
        expect((await f.post("/api/mailbox-write/settings", { enabled: true }, { authorization })).status).toBe(403);
      }
      expect((await f.post("/api/mailbox-write/settings", { enabled: "true" }, human)).status).toBe(400);
      expect((await f.post("/api/mailbox-write/settings", { enabled: true }, human)).data.enabled).toBe(true);
      expect(JSON.parse(readFileSync(join(f.dataDir, "mailbox-write.json"), "utf8"))).toEqual({ enabled: true });
      const result = await client.callTool({ name: "draft_mail", arguments: draft });
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(toolText(result))).toMatchObject({ ok: true, id });
      expect(f.readCalls()).toEqual([{ op: "append", to: draft.to, subject: draft.subject, body: draft.body, inReplyTo: draft.in_reply_to }]);
      expect((await f.post("/api/approval/missing/send-draft", { draft_id: id })).status).toBe(404);
      const waiting = toolText(await client.callTool({ name: "send_mail_draft", arguments: { draft_id: id } }));
      const card = /card ([a-f0-9-]+)/.exec(waiting)![1];
      expect(waiting).toContain("Not sent");
      await client.callTool({ name: "send_mail_draft", arguments: { draft_id: id, approval_id: card } });
      expect(f.readCalls().filter(row => row.op === "send")).toHaveLength(0);
      expect((await f.post(`/api/approval/${card}/decide`, { decision: "allow" })).status).toBe(403);
      expect((await f.post(`/api/approval/${card}/decide`, { decision: "allow" }, human)).status).toBe(200);
      await f.post("/api/mailbox-write/settings", { enabled: false }, human);
      expect((await f.post(`/api/approval/${card}/send-draft`, { draft_id: id })).status).toBe(403);
      expect((await f.post("/api/internal/mailbox/draft", draft)).status).toBe(403);
      expect(f.readCalls().filter(row => row.op === "send")).toHaveLength(0);
      await f.post("/api/mailbox-write/settings", { enabled: true }, human);
      const results = await Promise.all([0, 1].map(() => client.callTool({ name: "send_mail_draft", arguments: { draft_id: id, approval_id: card } })));
      expect(results.filter(result => toolText(result) === "sent")).toHaveLength(1);
      expect(f.readCalls().filter(row => row.op === "send")).toEqual([{ op: "send", id: provider === "imap" ? 71 : id }]);
      expect(f.readCalls().filter(row => row.op === "append")).toHaveLength(1);
      // Persisted app consent is authoritative; restarting must not restore permission from installer settings.
      await f.stop(); await f.start();
      expect((await (await fetch(f.base + "/api/mailbox-write/settings", { headers: human })).json() as any).enabled).toBe(true);
      await f.post("/api/mailbox-write/settings", { enabled: false }, human);
      await f.stop(); await f.start();
      expect((await (await fetch(f.base + "/api/mailbox-write/settings", { headers: human })).json() as any).enabled).toBe(false);
    } finally { await f.close(); }
  }, 30000);
}

test("invalid consent data fails closed and an unknown provider never receives a draft", async () => {
  const f = await fixture(true);
  try {
    const human = await f.login();
    for (const value of ["broken JSON", '{"enabled":"true"}', "null"]) {
      writeFileSync(join(f.dataDir, "mailbox-write.json"), value);
      expect((await f.post("/api/internal/mailbox/draft", draft)).status).toBe(403);
      expect((await (await fetch(f.base + "/api/mailbox-write/settings", { headers: human })).json() as any).enabled).toBe(false);
    }
    await f.post("/api/mailbox-write/settings", { enabled: true }, human);
    await f.stop(); f.env.MAILBOX_PROVIDER = "unknown"; await f.start();
    expect((await f.post("/api/internal/mailbox/draft", draft)).data.ok).toBe(false);
    expect(f.readCalls()).toEqual([]);
  } finally { await f.close(); }
}, 20000);

test("same-host trust never grants consent to internal or agent bearers, or a cookieless browser", async () => {
  const f = await fixture(true, "imap", true);
  try {
    for (const headers of [{}, { authorization: "Bearer internal" }, { authorization: "Bearer agent" }]) {
      expect((await f.post("/api/mailbox-write/settings", { enabled: true }, headers)).status).toBe(403);
    }
    expect(f.readCalls()).toEqual([]);
    const human = await f.login();
    expect((await f.post("/api/mailbox-write/settings", { enabled: true }, human)).data.enabled).toBe(true);
    expect((await f.post("/api/internal/mailbox/draft", draft)).data.ok).toBe(true);
  } finally { await f.close(); }
}, 20000);
