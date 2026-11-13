import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
const EN = JSON.parse(readFileSync(join(import.meta.dir, "strings/en.json"), "utf8"));

test("mail cards require a human, persist outcomes and consume each decision once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-card-"));
  const data = join(dir, "data"), sends = join(dir, "sends.jsonl"), preload = join(dir, "preload.ts");
  writeFileSync(preload, `
    import { appendFileSync } from "node:fs";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url) !== "https://sender.invalid/send") return originalFetch(url, options);
      const body = JSON.parse(options.body);
      appendFileSync(${JSON.stringify(sends)}, JSON.stringify({ id: options.headers["Idempotency-Key"], ...body }) + "\\n");
      await Bun.sleep(80);
      return Response.json(body.subject === "Fail" ? { ok: false, status: "failed", error: "Rejected" } : { ok: true });
    };
  `);
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = listener.port; listener.stop(true);
  const base = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "--preload", preload, join(import.meta.dir, "server.ts")], {
    cwd: dir, env: { PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, TMUX_TMPDIR: dir,
      EMBERVY_STRINGS_LOCAL: process.env.EMBERVY_STRINGS_LOCAL!,
      EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port),
      INTERNAL_API_TOKEN: "internal", APP_PASSWORD: "password", APP_SESSION_SECRET: "secret",
      EMBERVY_TRUST_SAME_HOST: "true", EMBERVY_TERMINAL_PANEL: "0", EMAIL_AUTO_SEND_CLEAN: "false",
      EMAIL_SENDER_URL: "https://sender.invalid/send", EMAIL_SENDER_AUTH: "sender" }, stdout: "ignore", stderr: "pipe",
  });
  const bearer = { authorization: "Bearer internal" };
  const post = async (path: string, body: any, headers: Record<string, string> = bearer) => {
    const res = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() as any };
  };
  const rows = (file: string) => readFileSync(join(data, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const count = (id: string) => existsSync(sends) ? readFileSync(sends, "utf8").trim().split("\n").map(line => JSON.parse(line)).filter(row => row.id === id).length : 0;
  try {
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(base + "/health")).ok; } catch {} if (!ready) await Bun.sleep(100); }
    if (!ready) { child.kill(); throw new Error(`Test server startup failed: ${await new Response(child.stderr).text()}`); }
    const login = await fetch(base + "/api/auth", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "192.0.2.1" }, body: JSON.stringify({ password: "password" }) });
    const human = { cookie: login.headers.get("set-cookie")!.split(";")[0] };
    const queue = async (subject = "Reviewed") => {
      const result = await post("/api/internal/send-email", { to: "recipient@example.test", cc: "copy@example.test", subject,
        body: "Full body\n<script>alert('mail')</script>\nLast line", delivery_id: crypto.randomUUID() });
      expect(result.status).toBe(200); expect(result.data.status).toBe("pending_approval");
      return result.data.id as string;
    };
    const decide = (id: string, action = "send", headers: Record<string, string> = human) => post("/api/send-email/approve", { id, action }, headers);
    const status = async (id: string, expected: string) => {
      const res = await fetch(base + `/api/send-email/${id}/status`, { headers: human });
      expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toContain("no-store");
      expect(await res.json()).toEqual({ status: expected });
    };
    const reaction = (id: string, emoji = "❤️", headers: Record<string, string> = human, path = "/api/react") => {
      const card = rows("email-approval-cards.jsonl").find(row => row.email_id === id);
      return post(path, { message_id: card.card_id, emoji }, headers);
    };
    const settled = async (id: string) => {
      for (let i = 0; i < 100; i++) {
        if (!["ready", "sending"].includes(rows("email-outbox.jsonl").find(row => row.id === id).status)) return;
        await Bun.sleep(10);
      }
      throw new Error("delivery did not settle");
    };
    const pending = await queue();
    await status(pending, "pending_approval"); await status("absent", "unknown");
    for (const headers of [{}, bearer, { cookie: "embervy_session=forged" }]) {
      // Without a login the app's own gate answers 401; with a bearer or forged cookie the mail gate answers 403.
      for (const action of ["send", "discard"]) expect([401, 403]).toContain((await decide(pending, action, headers)).status);
      expect([401, 403]).toContain((await fetch(base + `/api/send-email/${pending}/status`, { headers })).status);
      await reaction(pending, "❤️", headers);
      await reaction(pending, "😢", headers);
      await status(pending, "pending_approval"); expect(count(pending)).toBe(0);
    }
    await reaction(pending, "❤️", bearer, "/api/internal/react");
    await status(pending, "pending_approval"); expect(count(pending)).toBe(0);
    expect((await decide(pending)).data.status).toBe("sent");
    await status(pending, "sent"); expect(count(pending)).toBe(1);
    expect((await decide(pending)).status).toBe(409);
    // A reaction is always recorded; on a decided mail it changes nothing.
    expect((await reaction(pending)).status).toBe(200);
    expect((await reaction(pending, "😢")).status).toBe(200);
    await status(pending, "sent"); expect(count(pending)).toBe(1);

    const denied = await queue();
    expect((await decide(denied, "discard")).data.status).toBe("discarded");
    expect((await decide(denied)).status).toBe(409);
    expect((await reaction(denied)).status).toBe(200);
    await status(denied, "discarded"); expect(count(denied)).toBe(0);
    const deniedReaction = await queue();
    expect((await reaction(deniedReaction, "😢")).status).toBe(200);
    expect((await decide(deniedReaction)).status).toBe(409);
    await status(deniedReaction, "discarded"); expect(count(deniedReaction)).toBe(0);

    const double = await queue();
    const attempts = await Promise.all([decide(double), decide(double)]);
    expect(attempts.map(r => r.status).sort()).toEqual([200, 409]);
    expect(count(double)).toBe(1); await status(double, "sent");
    for (const emoji of ["❤️", "🔥", "👍"]) {
      const id = await queue();
      expect((await reaction(id, emoji)).status).toBe(200);
      expect((await decide(id)).status).toBe(409);
      expect((await reaction(id, emoji)).status).toBe(200);
      await settled(id); await status(id, "sent"); expect(count(id)).toBe(1);
    }
    const mixed = await queue();
    const mixedResults = await Promise.all([decide(mixed), reaction(mixed)]);
    expect(mixedResults.some(r => r.status === 200)).toBe(true);
    await settled(mixed); await status(mixed, "sent"); expect(count(mixed)).toBe(1);
    const failed = await queue("Fail");
    expect((await decide(failed)).data.status).toBe("failed");
    await status(failed, "failed"); expect((await decide(failed)).status).toBe(409); expect(count(failed)).toBe(1);

    // Legacy messages only carried the identifier; history must join the current outbox.
    const messages = rows("outbox.jsonl");
    for (const message of messages) { delete message.email_detail; delete message.email_status; }
    messages.push({ id: "old-missing", source: "email-approval", email_id: "absent", text: "Old fallback" });
    writeFileSync(join(data, "outbox.jsonl"), messages.map(row => JSON.stringify(row)).join("\n") + "\n");
    const history: any = await (await fetch(base + "/api/messages", { headers: human })).json();
    const old = history.find((row: any) => row.email_id === pending);
    expect(old.email_status).toBe("sent");
    expect(old.email_detail).toContain("To: recipient@example.test\nCc: copy@example.test\nSubject: Reviewed");
    expect(old.email_detail).toContain("<script>alert('mail')</script>\nLast line");
    expect(old.email_detail).not.toContain("React with"); expect(old.email_detail).not.toContain("POST /api");
    expect(history.find((row: any) => row.email_id === denied).email_status).toBe("discarded");
    expect(history.find((row: any) => row.email_id === failed).email_status).toBe("failed");
    expect(history.find((row: any) => row.email_id === "absent").email_status).toBe("unknown");
  } finally { child.kill(); await child.exited; rmSync(dir, { recursive: true, force: true }); }
}, 20000);

function clientCardRenderer() {
  const escape = SOURCE.slice(SOURCE.indexOf("  function escapeHtml(text)"), SOURCE.indexOf("  const MESSAGE_ID_RE"));
  const renderer = SOURCE.slice(SOURCE.indexOf("  function mailApprovalLabel(status)"), SOURCE.indexOf("  const mailApprovalVersions"));
  return new Function("t", escape + renderer + "\nreturn renderMailApprovalCard;")((key: string) => EN[key]);
}

test("email approval renders the familiar card and escapes the full detail", async () => {
  const render = clientCardRenderer();
  const html = render({ source: "email-approval", email_id: 'mail-"<x>', email_status: "pending_approval",
    email_detail: "To: person@example.test\nCc: copy@example.test\nSubject: Reviewed\nBlacklist hits: private\n\n<script>alert('x')</script>\nLast line" });
  expect(html).toContain("🔒 Approval"); expect(html).toContain("Send mail");
  expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;\nLast line");
  expect(html).toContain("Waiting for your decision");
  const buttons: string[] = [], tags: string[] = [];
  await new HTMLRewriter().on("*", { element(e) { tags.push(e.tagName); } })
    .on("button", { element(e) { buttons.push(e.getAttribute("data-mail-action")!); } })
    .transform(new Response(html)).text();
  expect(tags).not.toContain("script"); expect(tags).not.toContain("x"); expect(buttons).toEqual(["send", "discard"]);
  expect(html).not.toContain("React with");
  expect(SOURCE).toContain('if (emailId) content = renderMailApprovalCard(approvalMeta)');
  expect(SOURCE).toContain('if (emailId) refreshMailApproval(emailId)');
});

test("email-approval history messages take the card path rather than the fallback text", () => {
  const escape = SOURCE.slice(SOURCE.indexOf("  function escapeHtml(text)"), SOURCE.indexOf("  const MESSAGE_ID_RE"));
  const renderer = SOURCE.slice(SOURCE.indexOf("  function mailApprovalLabel(status)"), SOURCE.indexOf("  const mailApprovalVersions"));
  const add = SOURCE.slice(SOURCE.indexOf("  function createMessageBubble("), SOURCE.indexOf("  function addVoiceMessage(role,"));
  const run = new Function("t", "meta", `
    const messageIds = new Set(); let lastSeenTs = ""; const window = {};
    const safeMediaUrl = () => "", showTyping = () => {}, workingEl = null;
    const renderMarkdown = () => "fallback prose", safeMsgId = id => id, withMedia = content => content;
    const atBottom = () => true, scrollToBottom = () => {}, addKeptActions = () => {};
    const refreshes = [], refreshMailApproval = id => refreshes.push(id);
    const div = { innerHTML: "", setAttribute() {}, addEventListener() {} };
    const document = { createElement: () => div }, messagesEl = { appendChild() {} };
    ${escape}${renderer}${add}
    addMessage("assistant", "React with emoji or POST", null, "old-card", null, null, null, null, meta);
    return { html: div.innerHTML, refreshes };
  `);
  for (const state of ["pending_approval", "sent", "discarded", "failed", "unknown"]) {
    const result = run((key: string) => EN[key], { source: "email-approval", email_id: "mail", email_status: state,
      email_detail: "To: recipient@example.test\nSubject: Reviewed\n\n<script>text</script>" });
    expect(result.html).toContain("Send mail"); expect(result.html).toContain("&lt;script&gt;text&lt;/script&gt;");
    expect(result.html).not.toContain("fallback prose"); expect(result.html).not.toContain("React with");
    expect(result.html.includes("<button")).toBe(state === "pending_approval");
    expect(result.refreshes).toEqual(["mail"]);
  }
});

function mailClient(fetcher: (url: string, options?: any) => Promise<Response>) {
  let actions = true;
  let click: any;
  const line = { textContent: "", insertAdjacentHTML() { actions = true; } };
  const buttons: any[] = ["send", "discard"].map(action => ({ disabled: false, dataset: { mailAction: action }, closest: () => card }));
  const card: any = {
    dataset: { email: "mail", emailStatus: "pending_approval" },
    querySelector(selector: string) {
      if (selector === ".approval-status") return line;
      if (selector === ".approval-detail") return { textContent: "Reviewed body" };
      if (selector === ".approval-actions") return actions ? { remove() { actions = false; } } : null;
    },
    querySelectorAll: () => actions ? buttons : [],
  };
  const document = { querySelectorAll: () => [card] };
  const messagesEl = { addEventListener(_type: string, handler: any) { click = handler; } };
  const escape = SOURCE.slice(SOURCE.indexOf("  function escapeHtml(text)"), SOURCE.indexOf("  const MESSAGE_ID_RE"));
  const block = SOURCE.slice(SOURCE.indexOf("  function mailApprovalLabel(status)"), SOURCE.indexOf('  messagesEl.addEventListener("click", async (event) => {\n    const button = event.target.closest(".approval-card button[data-decision]");'));
  const api = new Function("t", "document", "messagesEl", "fetch", escape + block + "\nreturn { updateMailApproval, refreshMailApproval };")(
    (key: string) => EN[key], document, messagesEl, fetcher);
  return { ...api, card, line, buttons, actions: () => actions,
    click: (index = 0) => click({ target: { closest: () => buttons[index] } }) };
}

test("mail buttons use the human endpoint, stay disabled in flight and recover on errors", async () => {
  for (const [index, action] of [[0, "send"], [1, "discard"]] as const) {
    let complete: (value: Response) => void = () => {};
    const calls: any[] = [];
    const client = mailClient(async (url, options) => { calls.push({ url, options }); return new Promise(resolve => { complete = resolve; }); });
    const decision = client.click(index);
    expect(client.buttons.every((b: any) => b.disabled)).toBe(true);
    await client.click(index); expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/send-email/approve");
    expect(calls[0].options.credentials).toBe("same-origin");
    expect(JSON.parse(calls[0].options.body)).toEqual({ id: "mail", action });
    complete(Response.json({ error: "Unavailable" }, { status: 500 }));
    await decision;
    expect(client.line.textContent).toBe(EN["approval.error"]);
    expect(client.actions()).toBe(true); expect(client.buttons.every((b: any) => !b.disabled)).toBe(true);
    const retry = client.click(index);
    complete(Response.json({ status: action === "send" ? "sent" : "discarded" }));
    await retry;
    expect(client.actions()).toBe(false);
    expect(client.line.textContent).toBe(action === "send" ? "Allowed" : "Denied");
  }
});

test("mail cards follow reaction and delivery updates without accepting stale status reads", async () => {
  let complete: (value: Response) => void = () => {};
  const client = mailClient(async () => new Promise(resolve => { complete = resolve; }));
  const read = client.refreshMailApproval("mail");
  client.updateMailApproval("mail", "ready");
  expect(client.line.textContent).toBe("Allowed"); expect(client.actions()).toBe(false);
  client.updateMailApproval("mail", "failed");
  complete(Response.json({ status: "pending_approval" }));
  await read;
  expect(client.line.textContent).toBe("Delivery failed"); expect(client.actions()).toBe(false);
  for (const [status, label] of [["sent", "Allowed"], ["discarded", "Denied"], ["unknown", EN["email.cardUnknown"]]]) {
    const refresh = client.refreshMailApproval("mail");
    complete(Response.json({ status })); await refresh;
    expect(client.line.textContent).toBe(label); expect(client.actions()).toBe(false);
  }
});

test("decided, failed and missing mail cards have no decision buttons", () => {
  const render = clientCardRenderer();
  for (const [status, label] of [["ready", "Allowed"], ["sending", "Allowed"], ["sent", "Allowed"], ["discarded", "Denied"], ["failed", "Delivery failed"], ["unknown", EN["email.cardUnknown"]]]) {
    const html = render({ email_id: "mail", email_status: status, email_detail: "Full body" });
    expect(html).toContain(label); expect(html).not.toContain("<button"); expect(html).toContain("Full body");
  }
  expect(render({ email_id: "missing" })).not.toContain("<button");
});
