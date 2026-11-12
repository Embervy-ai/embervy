import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mediaPolicy, sendFile } from "./send-file";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = mkdtempSync(join(tmpdir(), "send-file-"));
const mediaDir = join(dir, "images");
mkdirSync(mediaDir, { recursive: true });
const path = join(dir, "Budget.xlsx");
writeFileSync(path, "spreadsheet bytes");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let posted: any[] = [];
const deliver = async (message: any) => { posted.push(message); return { ok: true as const }; };
const send = (args: Record<string, unknown>, env: Record<string, string | undefined> = {}) =>
  sendFile(args, { mediaDir, deliver, env });
const text = (result: any) => result.content[0].text as string;

const source = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
const start = source.indexOf("  function escapeHtml(text) {");
const end = source.indexOf("  function quoteHtml(meta) {");
if (start < 0 || end <= start) throw new Error("media renderer not found");
const render = new Function("t", `${source.slice(start, end)}; return withMedia;`)((key: string) => key);

describe("send_file", () => {
  test("copies an xlsx under a fresh media name and broadcasts its original basename", async () => {
    posted = [];
    const result = await send({ path });
    expect(text(result)).toStartWith("Sent file:");
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ text: "[File: Budget.xlsx]", type: "file", file_name: "Budget.xlsx" });
    expect(posted[0].file_url).toMatch(/^\/api\/images\/[a-f0-9-]{36}\.xlsx$/);
    expect(readFileSync(join(mediaDir, posted[0].file_url.split("/").pop()), "utf8")).toBe("spreadsheet bytes");
    expect(readFileSync(path, "utf8")).toBe("spreadsheet bytes");
  });

  test("caption, reply_to and retry id are retained; media ids remain fresh", async () => {
    posted = [];
    await send({ path, caption: "Improved", reply_to: "user-1", id: "retry:1.x" });
    await send({ path, caption: "Improved", reply_to: "user-1", id: "retry:1.x" });
    expect(posted[0]).toMatchObject({ text: "Improved", reply_to: "user-1", id: "retry:1.x" });
    expect(posted[0].file_url).not.toBe(posted[1].file_url);
    const html = render("<p>Improved</p>", posted[0].text, posted[0].file_url, posted[0].file_name);
    expect(html).toContain('class="file-link">Budget.xlsx</a><p>Improved</p>');
  });

  test("images use image_url and the image renderer", async () => {
    const image = join(dir, "Photo.PNG");
    writeFileSync(image, "image bytes");
    posted = [];
    await send({ path: image });
    expect(posted[0]).toMatchObject({ type: "image", text: "[Image]", file_name: "Photo.PNG" });
    expect(posted[0].file_url).toBeUndefined();
    expect(render("", posted[0].text, posted[0].image_url, posted[0].file_name)).toContain('<img src="/api/images/');
  });

  test("a file exactly at the size limit is accepted", async () => {
    posted = [];
    const result = await send({ path }, { MAX_IMAGE_BYTES: String(Buffer.byteLength("spreadsheet bytes")) });
    expect(text(result)).toStartWith("Sent file:");
    expect(posted).toHaveLength(1);
  });

  test("copies multiple buffers without truncation", async () => {
    const large = join(dir, "multiple-buffers.xlsx");
    const bytes = Buffer.alloc(150_000, 0x78);
    writeFileSync(large, bytes);
    posted = [];
    await send({ path: large });
    expect(readFileSync(join(mediaDir, posted[0].file_url.split("/").pop()))).toEqual(bytes);
  });

  test("an HTML-shaped name is escaped, never parsed as markup", async () => {
    const name = '<img src=x onerror=alert(1)>.xlsx';
    const unsafe = join(dir, name);
    writeFileSync(unsafe, "bytes");
    posted = [];
    await send({ path: unsafe });
    expect(posted[0].file_name).toBe(name);
    const html = render("ignored", posted[0].text, posted[0].file_url, posted[0].file_name);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.xlsx</a>");
    const tags: string[] = [];
    await new HTMLRewriter().on("*", { element(e) { tags.push(e.tagName); } }).transform(new Response(html)).text();
    expect(tags).toEqual(["a"]);
  });

  const directory = join(dir, "directory.xlsx");
  mkdirSync(directory);
  const link = join(dir, "directory-link.xlsx");
  symlinkSync(directory, link);
  const secret = join(dir, "house.env");
  writeFileSync(secret, "TOKEN=not-for-the-chat");
  const disguised = join(dir, "notes.txt");
  symlinkSync(secret, disguised);
  const oversized = join(dir, "large.xlsx");
  writeFileSync(oversized, "12345");
  const exe = join(dir, "bad.exe");
  writeFileSync(exe, "bad");
  const htmlPath = join(dir, "bad.html");
  writeFileSync(htmlPath, "<html>");
  for (const [label, args, env] of [
    ["missing path", { path: join(dir, "missing.xlsx") }, {}],
    ["relative path", { path: "Budget.xlsx" }, {}],
    ["absent path", {}, {}],
    ["directory", { path: directory }, {}],
    ["symlink to directory", { path: link }, {}],
    ["text name pointing at an env file", { path: disguised }, {}],
    ["oversized file", { path: oversized }, { MAX_IMAGE_BYTES: "4" }],
    ["disallowed extension", { path: exe }, {}],
    ["HTML extension", { path: htmlPath }, {}],
    ["environment override", { path }, { ALLOWED_IMAGE_EXTS: "txt" }],
    ["invalid id", { path, id: "../escape" }, {}],
    ["invalid caption", { path, caption: 123 }, {}],
  ] as const) {
    test(`${label}: error and no broadcast or copy`, async () => {
      posted = [];
      const before = readdirSync(mediaDir);
      const result = await send(args, env);
      expect(text(result)).toStartWith("error");
      expect(result.isError).toBe(true);
      expect(posted).toEqual([]);
      expect(readdirSync(mediaDir)).toEqual(before);
    });
  }

  test("failed delivery preserves the retry id and never reports success", async () => {
    const result = await sendFile({ path, id: "retry-failed" }, {
      mediaDir, env: {}, deliver: async () => ({ ok: false, reason: "the app answered HTTP 500" }),
    });
    expect(text(result)).toStartWith("error");
    expect(text(result)).toContain("HTTP 500");
    expect(text(result)).toContain('id "retry-failed"');
    expect(text(result)).not.toContain("Sent file:");
  });

  test("an unreachable broadcast returns error", async () => {
    const result = await sendFile({ path }, { mediaDir, env: {}, deliver: async () => { throw new Error("unreachable"); } });
    expect(text(result)).toStartWith("error");
    expect(text(result)).toContain("unreachable");
  });
});

test("the shared policy includes Office formats, excludes active formats, and respects overrides", () => {
  const policy = mediaPolicy({});
  for (const ext of ["doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "csv"]) expect(policy.extensions.has(ext)).toBe(true);
  for (const ext of ["svg", "html", "exe"]) expect(policy.extensions.has(ext)).toBe(false);
  expect(policy.maxBytes).toBe(20 * 1024 * 1024);
  expect([...mediaPolicy({ ALLOWED_IMAGE_EXTS: " TXT, XLSX " }).extensions]).toEqual(["txt", "xlsx"]);
  expect([...mediaPolicy({ ALLOWED_IMAGE_EXTS: "" }).extensions]).toEqual([]);
});

test("live and history messages pass the file metadata into the same renderer", () => {
  expect(source).toContain('addMessage("assistant", msg.data.text, msg.data.ts, msg.data.id, msg.data.image_url, msg.data.audio_url, msg.data.duration, msg.data.reply_to, msg.data)');
  expect(source.match(/addMessage\(msg.role, msg.text, msg.ts, msg.id, msg.image_url, msg.audio_url, msg.duration, msg.reply_to, msg\)/g)).toHaveLength(2);
  expect(source).toContain("withMedia(content, text, imageUrl || approvalMeta?.file_url || audioUrl, approvalMeta?.file_name)");
});

describe("Office uploads and send_file through the real app", () => {
  const token = "office-test-internal-token-0123456789";
  const password = "office-test-password";
  const dataDir = join(dir, "server-data");
  let server: ReturnType<typeof Bun.spawn>;
  let base = "";
  let cookie = "";
  let client: Client;
  let failedClient: Client;
  let receiver: ReturnType<typeof Bun.serve>;
  let failedHits: any[] = [];
  const headers = () => ({ Cookie: cookie });
  const entries = (name: string): any[] => {
    try { return readFileSync(join(dataDir, name), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  async function bridge(port: number, data: string) {
    const bridge = new Client({ name: "office-test", version: "0.0.0" });
    await bridge.connect(new StdioClientTransport({
      command: "bun", args: ["run", join(import.meta.dir, "mcp.ts")], cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, EMBERVY_HOME: dir,
        EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), EMBERVY_APP_DATA_DIR: data,
        INTERNAL_API_TOKEN: token, EMBERVY_BROADCAST_TIMEOUT_MS: "1000",
      }, stderr: "ignore",
    }));
    return bridge;
  }
  beforeAll(async () => {
    const socket = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    const port = socket.port;
    socket.stop(true);
    if (port === 3030) throw new Error("refusing to test on port 3030");
    base = `http://127.0.0.1:${port}`;
    server = Bun.spawn(["bun", "run", join(import.meta.dir, "server.ts")], {
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, TMUX_TMPDIR: dir,
        EMBERVY_APP_HOST: "127.0.0.1", EMBERVY_APP_PORT: String(port), EMBERVY_APP_DATA_DIR: dataDir,
        INTERNAL_API_TOKEN: token, APP_PASSWORD: password, APP_SESSION_SECRET: "office-test-session-secret",
        EMBERVY_TERMINAL_PANEL: "0", EMBERVY_TMUX_SESSION: "office-test-no-such-session",
      }, stdout: "ignore", stderr: "ignore",
    });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try { up = (await fetch(`${base}/health`)).ok; } catch {}
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error("Office test server did not start");
    const auth = await fetch(`${base}/api/auth`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password }),
    });
    expect(auth.status).toBe(200);
    cookie = (auth.headers.get("set-cookie") || "").split(";")[0];
    client = await bridge(port, dataDir);
    receiver = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(req) {
        if (new URL(req.url).pathname === "/api/internal/room") return Response.json({});
        failedHits.push(await req.json());
        return new Response("outbox failed", { status: 500 });
      },
    });
    if (receiver.port === 3030) throw new Error("refusing to test on port 3030");
    failedClient = await bridge(receiver.port, join(dir, "failed-data"));
  }, 30_000);
  afterAll(async () => {
    await client?.close();
    await failedClient?.close();
    receiver?.stop(true);
    server?.kill();
    await server?.exited;
  }, 20_000);

  for (const ext of ["xlsx", "docx"]) {
    test(`upload .${ext}: accepted, stored as file and served only as a download`, async () => {
      const form = new FormData();
      form.append("image", new File(["Office bytes"], `Report.${ext}`));
      const response = await fetch(`${base}/api/image`, { method: "POST", headers: headers(), body: form });
      expect(response.status).toBe(200);
      const body = await response.json();
      const stored = entries("inbox.jsonl").find(m => m.id === body.id);
      expect(stored).toMatchObject({ type: "file", text: `[File: Report.${ext}]`, file_name: `Report.${ext}`, file_url: body.image_url });
      expect(readFileSync(stored.file_path, "utf8")).toBe("Office bytes");
      const download = await fetch(`${base}${body.image_url}`, { headers: { ...headers(), Accept: "text/html" } });
      expect(download.status).toBe(200);
      expect(download.headers.get("content-type")).toBe("application/octet-stream");
      expect(download.headers.get("content-disposition")).toBe("attachment");
      expect(download.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await download.text()).toBe("Office bytes");
    });
  }
  for (const ext of ["exe", "html", "svg"]) {
    test(`upload .${ext}: 415 and no stored message`, async () => {
      const before = entries("inbox.jsonl").length;
      const form = new FormData();
      form.append("image", new File(["bad"], `Bad.${ext}`));
      const response = await fetch(`${base}/api/image`, { method: "POST", headers: headers(), body: form });
      expect(response.status).toBe(415);
      expect(entries("inbox.jsonl")).toHaveLength(before);
    });
  }
  test("send_file is advertised with its required path and optional fields", async () => {
    const tools = await client.listTools();
    const tool = tools.tools.find(tool => tool.name === "send_file")!;
    expect(tool.description).toContain("absolute server path");
    expect(tool.inputSchema.required).toEqual(["path"]);
    expect(Object.keys(tool.inputSchema.properties!)).toEqual(["path", "caption", "reply_to", "id"]);
  });
  test("MCP sends a file live, stores its shape, reloads it and deduplicates the retry", async () => {
    const ws = new WebSocket(base.replace("http:", "ws:") + "/ws", { headers: headers() });
    try {
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket failed")); });
      const received = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no live file message")), 5000);
        ws.onmessage = event => {
          const eventData = JSON.parse(String(event.data));
          if (eventData.type === "message" && eventData.data.id === "office-retry") { clearTimeout(timer); resolve(eventData.data); }
        };
      });
      const result: any = await client.callTool({ name: "send_file", arguments: { path, caption: "Improved budget", id: "office-retry" } });
      expect(result.isError).not.toBe(true);
      expect(text(result)).toStartWith("Sent file:");
      const stored = entries("outbox.jsonl").find(m => m.id === "office-retry");
      expect(stored).toMatchObject({ type: "file", text: "Improved budget", file_name: "Budget.xlsx" });
      expect(await received).toEqual(stored);
      for (let reload = 0; reload < 2; reload++) {
        const history = await (await fetch(`${base}/api/messages`, { headers: headers() })).json();
        expect(history.find((m: any) => m.id === stored.id)).toEqual({ ...stored, role: "assistant" });
      }
      expect(await (await fetch(`${base}${stored.file_url}`, { headers: headers() })).text()).toBe("spreadsheet bytes");
      await client.callTool({ name: "send_file", arguments: { path, id: "office-retry" } });
      expect(entries("outbox.jsonl").filter(m => m.id === "office-retry")).toHaveLength(1);
    } finally { ws.close(); }
  }, 15_000);
  test("an image sent through MCP retains its image URL after a history reload", async () => {
    const image = join(dir, "history-photo.png");
    writeFileSync(image, "image bytes");
    const result: any = await client.callTool({ name: "send_file", arguments: { path: image, id: "office-image" } });
    expect(text(result)).toStartWith("Sent file:");
    const stored = entries("outbox.jsonl").find(m => m.id === "office-image");
    expect(stored).toMatchObject({ type: "image", text: "[Image]", file_name: "history-photo.png" });
    expect(stored.file_url).toBeUndefined();
    const history = await (await fetch(`${base}/api/messages`, { headers: headers() })).json();
    expect(history.find((m: any) => m.id === stored.id)).toEqual({ ...stored, role: "assistant" });
    expect(render("", stored.text, stored.image_url, stored.file_name)).toContain('class="chat-image"');
  });
  test("a real HTTP 500 is an MCP error, with stable id on automatic retry", async () => {
    failedHits = [];
    const result: any = await failedClient.callTool({ name: "send_file", arguments: { path } });
    expect(result.isError).toBe(true);
    expect(text(result)).toStartWith("error");
    expect(text(result)).toContain("HTTP 500");
    expect(text(result)).not.toContain("Sent file:");
    expect(failedHits).toHaveLength(2);
    expect(failedHits[0].id).toBe(failedHits[1].id);
    expect(entries("outbox.jsonl").some(m => m.id === failedHits[0].id)).toBe(false);
  });
});

// Installed iOS apps can open plain file links in a window with no way back.
describe("a tapped file in the chat", () => {
  const shareStart = source.indexOf("  const FILE_TYPES = {");
  const shareEnd = source.indexOf('  messagesEl.addEventListener("click"', shareStart);
  if (shareStart < 0 || shareEnd <= shareStart) throw new Error("file share helper not found");
  const makeShare = (env: { fetch: unknown; navigator: unknown; document: unknown; URL: unknown }) =>
    new Function("fetch", "navigator", "document", "URL", `${source.slice(shareStart, shareEnd)}; return shareFile;`)(env.fetch, env.navigator, env.document, env.URL);

  test("goes to the share sheet with its own name and an office type", async () => {
    const shared: any[] = [];
    const share = makeShare({ fetch: async () => new Response("document bytes"), navigator: { platform: "iPhone", canShare: () => true, share: async (data: any) => { shared.push(data); } }, document: {}, URL });
    await share("/api/images/x.docx", "Letter.docx");
    expect(shared).toHaveLength(1);
    expect(shared[0].files[0].name).toBe("Letter.docx");
    expect(shared[0].files[0].type).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await shared[0].files[0].text()).toBe("document bytes");
  });

  test("downloads under its own name where no share sheet exists", async () => {
    const clicked: any[] = [];
    const document = { createElement: () => ({ click() { clicked.push(this); }, remove() {} }), body: { appendChild() {} } };
    const share = makeShare({ fetch: async () => new Response("sheet bytes"), navigator: {}, document, URL: { createObjectURL: () => "blob:test", revokeObjectURL() {} } });
    await share("/api/images/x.xlsx", "Budget.xlsx");
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("Budget.xlsx");
    expect(clicked[0].href).toBe("blob:test");
  });

  test("the chat handles the tap itself instead of following the link", () => {
    const handler = source.slice(shareEnd, source.indexOf("const inputEl", shareEnd));
    expect(handler).toContain('closest("a.file-link")');
    expect(handler).toContain("ev.preventDefault()");
  });
});
