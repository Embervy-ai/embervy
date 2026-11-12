import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A file tapped in the installed iOS web app opens inside the app window,
// without a browser bar, so file pages need a close button and a charset.
// A browser navigating to a file gets a page with a close button; ?raw=1
// and every other client get the bytes. Against the real server.ts as a
// throw-away process, like serve-files-server.test.ts: random port, own data
// dir, fake env and made-up files — never the service, never port 3030.

const PASSWORD = "test-password-not-real";
let server: ReturnType<typeof Bun.spawn>;
let dir = "", base = "";
let cookie = "";

import { startTestApp } from "./test-app-start";

const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
// What Safari sends when it navigates (a tapped link, a typed address).
const NAVIGATE = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const MD = "# Café Zoë\n\n<script>alert(1)</script>\n\nÆrø naïve — façade\n";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = "%PDF-1.4\n";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "file-viewer-"));
  const dataDir = join(dir, "data");
  for (const sub of ["shared", "images"]) mkdirSync(join(dataDir, sub), { recursive: true });
  const shared = join(dataDir, "shared");
  writeFileSync(join(shared, "notes-q4v8.md"), MD);
  writeFileSync(join(shared, "paper-q4v8.pdf"), PDF);
  writeFileSync(join(shared, "photo-q4v8.png"), PNG);
  writeFileSync(join(shared, "tool-q4v8.py"), "print('<b>hi</b>')\n");
  const images = join(dataDir, "images");
  writeFileSync(join(images, "upload3.md"), MD);
  writeFileSync(join(images, "upload4.pdf"), PDF);
  writeFileSync(join(images, "upload5.png"), PNG);
  writeFileSync(join(images, "upload6.txt"), "Café Zoë\n");

  const app = await startTestApp({
    cwd: dir, // no stray .env gets auto-loaded
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      TMUX_TMPDIR: dir, // any tmux call finds no server — never a live pane
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: dataDir,
      INTERNAL_API_TOKEN: "internal-test-token-0123456789",
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "file-viewer-test-no-such-session",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc: server, cookie } = app);
}, 30_000);

afterAll(async () => {
  try {
    if (server) { server.kill(); await server.exited; }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { ...viaTunnel, ...headers } });

type El = { tag: string; attrs: Record<string, string> };
async function elements(html: string): Promise<El[]> {
  const found: El[] = [];
  await new HTMLRewriter()
    .on("*", { element(e) { found.push({ tag: e.tagName, attrs: Object.fromEntries([...e.attributes]) }); } })
    .transform(new Response(html))
    .text();
  return found;
}

function directives(csp: string | null): Record<string, string[]> {
  return Object.fromEntries((csp ?? "").split(";").map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));
}

/** A viewer page: close button, its script as a same-origin file the policy allows, no inline code. */
async function expectViewerPage(r: Response): Promise<{ html: string; els: El[] }> {
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("vary")).toBe("Accept");
  const csp = directives(r.headers.get("content-security-policy"));
  expect(csp["script-src"]).toEqual(["'self'"]);
  expect(csp["sandbox"]).toBeUndefined(); // a sandbox would stop the close script
  const html = await r.text();
  const els = await elements(html);
  const close = els.filter((e) => e.attrs.id === "viewer-close");
  expect(close).toHaveLength(1);
  expect(close[0].attrs["aria-label"]).toBe("Close");
  expect(close[0].attrs.href).toBe("/");
  for (const el of els) for (const name of Object.keys(el.attrs)) expect(name).not.toMatch(/^on/i);
  const scripts = els.filter((e) => e.tag === "script");
  expect(scripts.length).toBe(1);
  // 'self' allows it: a path on this origin, served as JavaScript — without a
  // session too, so the public /share/ page works for anyone.
  expect(scripts[0].attrs.src).toMatch(/^\/[^/]/);
  const js = await fetch(`${base}${scripts[0].attrs.src}`, { headers: viaTunnel });
  expect(js.status).toBe(200);
  expect(js.headers.get("content-type")).toStartWith("text/javascript");
  expect(await js.text()).toContain("history.back()");
  let inline = "";
  await new HTMLRewriter().on("script", { text(t) { inline += t.text; } }).transform(new Response(html)).text();
  expect(inline).toBe("");
  return { html, els };
}

function expectMarkdownViewer(html: string) {
  expect(html).toContain("<h1>Café Zoë</h1>");
  expect(html).toContain("Ærø naïve — façade");
  expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); // shown as text
  expect(html).not.toContain("<script>alert");
}

describe("/share/: a navigating browser gets the viewer", () => {
  test("a .md: rendered page with close button, content escaped, umlauts intact", async () => {
    const { html } = await expectViewerPage(await get("/share/notes-q4v8.md", NAVIGATE));
    expectMarkdownViewer(html);
  });

  test("a .md with ?raw=1: the bytes, utf-8, still sandboxed", async () => {
    const r = await get("/share/notes-q4v8.md?raw=1", NAVIGATE);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toEndWith("; sandbox");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toBe(MD);
  });

  test("a .md fetched without text/html: the bytes, never cached for others", async () => {
    const r = await get("/share/notes-q4v8.md", { accept: "*/*" });
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("content-security-policy")).toEndWith("; sandbox");
    expect(r.headers.get("vary")).toBe("Accept");
    expect(r.headers.get("cache-control")).toBe("private");
    expect(await r.text()).toBe(MD);
  });

  test("a .pdf: page with the PDF in a same-origin frame on ?raw=1", async () => {
    const r = await get("/share/paper-q4v8.pdf", NAVIGATE);
    const csp = directives(r.headers.get("content-security-policy"));
    expect(csp["frame-src"]).toEqual(["'self'"]);
    const { els } = await expectViewerPage(r);
    const frames = els.filter((e) => e.tag === "iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].attrs.src).toBe("/share/paper-q4v8.pdf?raw=1");
    expect(frames[0].attrs.sandbox).toBeUndefined();
  });

  test("the frame's request (?raw=1, Accept text/html) gets the PDF, frameable by the page", async () => {
    const r = await get("/share/paper-q4v8.pdf?raw=1", NAVIGATE);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    const csp = directives(r.headers.get("content-security-policy"));
    expect(csp["sandbox"]).toBeUndefined();
    expect(csp["frame-ancestors"]).toEqual(["'self'"]);
    expect(await r.text()).toBe(PDF);
  });

  test("a .py (a download type): the viewer shows it escaped; the raw bytes stay a download", async () => {
    const { html } = await expectViewerPage(await get("/share/tool-q4v8.py", NAVIGATE));
    expect(html).toContain("print(&#39;&lt;b&gt;hi&lt;/b&gt;&#39;)");
    const r = await get("/share/tool-q4v8.py?raw=1", NAVIGATE);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe("attachment");
    await r.arrayBuffer();
  });

  test("an image is unchanged, even when navigated to", async () => {
    const r = await get("/share/photo-q4v8.png", NAVIGATE);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-security-policy")).toEndWith("; sandbox");
    expect(r.headers.get("vary")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("private");
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
  });

  test("a missing file is still a clean 404", async () => {
    expect((await get("/share/nothing-q4v8.md", NAVIGATE)).status).toBe(404);
  });
});

describe("/api/images/: the same for uploads, behind the login", () => {
  test("a .md: rendered page with close button, content escaped, umlauts intact", async () => {
    const { html } = await expectViewerPage(await get("/api/images/upload3.md", { ...NAVIGATE, cookie }));
    expectMarkdownViewer(html);
  });

  test("a .md with ?raw=1: the bytes with charset=utf-8", async () => {
    const r = await get("/api/images/upload3.md?raw=1", { ...NAVIGATE, cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await r.text()).toBe(MD);
  });

  test("a .md or .txt fetched without text/html: the bytes with charset=utf-8", async () => {
    const md = await get("/api/images/upload3.md", { cookie });
    expect(md.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await md.text()).toBe(MD);
    const txt = await get("/api/images/upload6.txt", { cookie });
    expect(txt.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await txt.text()).toBe("Café Zoë\n");
  });

  test("a .pdf: page with the PDF in a frame on ?raw=1; the frame gets the PDF", async () => {
    const { els } = await expectViewerPage(await get("/api/images/upload4.pdf", { ...NAVIGATE, cookie }));
    expect(els.filter((e) => e.tag === "iframe").map((e) => e.attrs.src)).toEqual(["/api/images/upload4.pdf?raw=1"]);
    const r = await get("/api/images/upload4.pdf?raw=1", { ...NAVIGATE, cookie });
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(directives(r.headers.get("content-security-policy"))["frame-ancestors"]).toEqual(["'self'"]);
    expect(await r.text()).toBe(PDF);
  });

  test("an image is unchanged, even when navigated to", async () => {
    const r = await get("/api/images/upload5.png", { ...NAVIGATE, cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("vary")).toBeNull();
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
  });

  test("without a session there is no page and no file", async () => {
    const r = await get("/api/images/upload3.md", NAVIGATE);
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain("Ærø");
  });

  test("a missing upload is a clean 404, page or not", async () => {
    expect((await get("/api/images/missing7.md", { ...NAVIGATE, cookie })).status).toBe(404);
    expect((await get("/api/images/missing7.pdf", { ...NAVIGATE, cookie })).status).toBe(404);
  });
});
