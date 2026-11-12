import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A file in the share folder or among the uploads must never run as script on
// the app's origin: HTML, SVG and the like go out as a
// download, only passive types are shown inline. Against the real server.ts as
// a throw-away process: random port, own data dir, fake env — never the
// service, never port 3030.

const PASSWORD = "test-password-not-real";
let server: ReturnType<typeof Bun.spawn>;
let base = "";
let dir = "", dataDir = "";
let cookie = "";

import { startTestApp } from "./test-app-start";

const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
const ACTIVE_HTML = "<html><body><script>alert(document.cookie)</script></body></html>";
const ACTIVE_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
// The 8-byte PNG signature is enough for a type check.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "serve-files-"));
  dataDir = join(dir, "data");
  for (const sub of ["shared", "images"]) mkdirSync(join(dataDir, sub), { recursive: true });
  const shared = join(dataDir, "shared");
  writeFileSync(join(shared, "page-x7k2.html"), ACTIVE_HTML);
  writeFileSync(join(shared, "drawing-x7k2.svg"), ACTIVE_SVG);
  writeFileSync(join(shared, "photo-x7k2.png"), PNG);
  writeFileSync(join(shared, "notes-x7k2.md"), "# Notes\n");
  writeFileSync(join(shared, "paper-x7k2.pdf"), "%PDF-1.4\n");
  const images = join(dataDir, "images");
  writeFileSync(join(images, "upload1.svg"), ACTIVE_SVG);
  writeFileSync(join(images, "upload2.png"), PNG);

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
      EMBERVY_TMUX_SESSION: "serve-files-test-no-such-session",
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

describe("/share/ never runs a file as script on the app's origin", () => {
  for (const name of ["page-x7k2.html", "drawing-x7k2.svg"]) {
    test(`${name} comes back as a download`, async () => {
      const r = await get(`/share/${name}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/octet-stream");
      expect(r.headers.get("content-disposition")).toBe("attachment");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      await r.arrayBuffer();
    });
  }

  test("a .png is still shown inline, sandboxed", async () => {
    const r = await get("/share/photo-x7k2.png");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-disposition")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toEndWith("; sandbox");
    expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'self'"); // the app-wide rule stays
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(PNG);
  });

  test("a .md keeps its markdown type, inline, sandboxed", async () => {
    const r = await get("/share/notes-x7k2.md");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("content-disposition")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toEndWith("; sandbox");
    expect(await r.text()).toBe("# Notes\n");
  });

  test("a .pdf stays inline and unsandboxed, so the browser's viewer can open it", async () => {
    const r = await get("/share/paper-x7k2.pdf");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    // Bun names the file itself (filename="…"), but not as an attachment.
    expect(r.headers.get("content-disposition") ?? "").not.toContain("attachment");
    expect(r.headers.get("content-security-policy")).not.toContain("sandbox");
    await r.arrayBuffer();
  });

  test("a missing file is still a clean 404", async () => {
    expect((await get("/share/nothing-here.html")).status).toBe(404);
  });
});

describe("/api/images/ hands out uploads the same way", () => {
  test("an .svg upload comes back as a download", async () => {
    const r = await get("/api/images/upload1.svg", { cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.headers.get("content-disposition")).toBe("attachment");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    await r.arrayBuffer();
  });

  test("a .png upload is still shown inline", async () => {
    const r = await get("/api/images/upload2.png", { cookie });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(r.headers.get("content-disposition")).toBeNull();
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    await r.arrayBuffer();
  });
});

// Reject control characters before filesystem access to avoid server errors.
describe("a control character in the file name is a bad request", () => {
  const NAMES = ["x%00.md", "x%0A.md", "x%0D.png", "x%1F.txt", "x%7F.md", "x%C2%85.md", "%00"];
  test("/share/ answers 400", async () => {
    for (const name of NAMES) {
      const r = await get(`/share/${name}`);
      expect([name, r.status]).toEqual([name, 400]);
      await r.arrayBuffer();
    }
  });
  test("/api/images/ answers 400", async () => {
    for (const name of NAMES) {
      const r = await get(`/api/images/${name}`, { cookie });
      expect([name, r.status]).toEqual([name, 400]);
      await r.arrayBuffer();
    }
  });
});
