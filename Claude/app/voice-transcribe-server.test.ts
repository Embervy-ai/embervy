// /api/voice/transcribe passes the recording to the memory worker's
// /transcribe with the house key and the language hint; the browser never
// sees the key. Errors are the gateway's: 503 unconfigured, 502 worker trouble.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestApp } from "./test-app-start";
const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };

async function startApp(extraEnv: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "voice-transcribe-"));
  const { base, proc, cookie } = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "voice-test-no-such-session",
      APP_PASSWORD: "voice-password",
      APP_SESSION_SECRET: "voice-session-secret-for-tests",
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const stop = async () => { proc.kill(); await proc.exited; rmSync(dir, { recursive: true, force: true }); };
  return { base, cookie, stop };
}

test("voice transcription: forwards bytes, type, key and language; returns the text", async () => {
  const seen: Array<{ path: string; language: string | null; auth: string | null; type: string | null; size: number }> = [];
  const worker = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      seen.push({ path: url.pathname, language: url.searchParams.get("language"), auth: req.headers.get("authorization"), type: req.headers.get("content-type"), size: body.length });
      if (body.length === 1) return Response.json({ error: "whisper failed: busy" }, { status: 502 });
      return Response.json({ text: "Hello from the test." });
    },
  });
  const app = await startApp({ EMBERVY_URL: `http://127.0.0.1:${worker.port}`, EMBERVY_API_KEY: "voice-key" });
  try {
    const post = (body: Uint8Array, headers: Record<string, string> = {}) =>
      fetch(`${app.base}/api/voice/transcribe?language=de`, { method: "POST", headers: { ...viaTunnel, "content-type": "audio/mp4", ...headers }, body });

    expect((await post(new Uint8Array(3000))).status).toBe(401); // no session cookie
    expect(seen.length).toBe(0);

    const ok = await post(new Uint8Array(3000), { cookie: app.cookie });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: "Hello from the test." });
    expect(seen[0]).toEqual({ path: "/transcribe", language: "de", auth: "Bearer voice-key", type: "audio/mp4", size: 3000 });

    const empty = await post(new Uint8Array(0), { cookie: app.cookie });
    expect(empty.status).toBe(400);

    const failed = await post(new Uint8Array(1), { cookie: app.cookie });
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toContain("whisper failed: busy");
  } finally {
    await app.stop();
    worker.stop(true);
  }
}, 30_000);

test("voice transcription: without a memory worker the answer is 503, so the app keeps the browser's text", async () => {
  const app = await startApp({});
  try {
    const res = await fetch(`${app.base}/api/voice/transcribe?language=de`, { method: "POST", headers: { ...viaTunnel, cookie: app.cookie, "content-type": "audio/webm" }, body: new Uint8Array(3000) });
    expect(res.status).toBe(503);
  } finally {
    await app.stop();
  }
}, 30_000);
