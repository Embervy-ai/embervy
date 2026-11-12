// The memory media proxy answers 502 when the worker cannot be reached
// A bad gateway is distinct from an app server error.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestApp } from "./test-app-start";

test("memory image and video proxy: unreachable worker is 502", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-proxy-"));
  const dead = 0; // No service can listen on destination port zero.
  const { base, proc, cookie } = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "proxy-test-no-such-session",
      EMBERVY_URL: `http://127.0.0.1:${dead}`,
      EMBERVY_API_KEY: "proxy-test-key",
      APP_PASSWORD: "proxy-password",
      APP_SESSION_SECRET: "proxy-session-secret-for-tests",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
    for (const [path, kind] of [["/api/memory-image/7", "image"], ["/api/memory-video/7", "video"]]) {
      const res = await fetch(`${base}${path}`, { headers: { ...viaTunnel, cookie } });
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: `${kind} worker unreachable` });
    }
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// Videos support byte ranges through the proxy because iOS Safari needs 206,
// and each route only ever serves its own kind of content.
test("memory proxy: video byte ranges pass through, foreign content types are refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-proxy-range-"));
  const video = new Uint8Array(1000).map((_, i) => i % 256);
  const seen: string[] = [];
  const worker = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${path} ${req.headers.get("range") ?? "-"}`);
      if (path === "/videos/7") {
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
        if (!m) return new Response(video, { headers: { "content-type": "video/mp4", "content-length": "1000" } });
        const [s, e] = [Number(m[1]), Number(m[2])];
        return new Response(video.slice(s, e + 1), { status: 206, headers: { "content-type": "video/mp4", "content-range": `bytes ${s}-${e}/1000`, "content-length": String(e - s + 1) } });
      }
      if (path === "/videos/8") return new Response(null, { status: 416, headers: { "content-range": "bytes */1000" } });
      if (path === "/images/7") return new Response("<script>alert(1)</script>", { headers: { "content-type": "text/html" } });
      if (path === "/images/8") return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png; charset=binary" } });
      return new Response("nope", { status: 404 });
    },
  });
  const { base, proc, cookie } = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "proxy-test-no-such-session",
      EMBERVY_URL: `http://127.0.0.1:${worker.port}`,
      EMBERVY_API_KEY: "proxy-test-key",
      APP_PASSWORD: "proxy-password",
      APP_SESSION_SECRET: "proxy-session-secret-for-tests",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
    const get = (path: string, extra: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { ...viaTunnel, cookie, ...extra } });

    const part = await get("/api/memory-video/7", { range: "bytes=0-1" });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-1/1000");
    expect(part.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([0, 1]));

    const whole = await get("/api/memory-video/7");
    expect(whole.status).toBe(200);
    expect((await whole.arrayBuffer()).byteLength).toBe(1000);

    expect((await get("/api/memory-video/8", { range: "bytes=5000-" })).status).toBe(416);

    const html = await get("/api/memory-image/7");
    expect(html.status).toBe(502);
    expect(await html.json()).toEqual({ error: "image worker returned text/html" });

    const png = await get("/api/memory-image/8", { range: "bytes=0-1" });
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    expect(seen).toContain("/images/8 -"); // images never forward a range
  } finally {
    proc.kill();
    await proc.exited;
    worker.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
