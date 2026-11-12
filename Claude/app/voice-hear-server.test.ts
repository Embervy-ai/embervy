import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestApp } from "./test-app-start";
const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };

async function startApp(extraEnv: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "voice-hear-"));
  const { base, proc, cookie } = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_STRINGS_LOCAL: process.env.EMBERVY_STRINGS_LOCAL!,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "voice-hear-no-such-session",
      APP_PASSWORD: "voice-password",
      APP_SESSION_SECRET: "voice-session-secret-for-tests",
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  const inbox = () => existsSync(join(dir, "data", "inbox.jsonl"))
    ? readFileSync(join(dir, "data", "inbox.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const images = () => existsSync(join(dir, "data", "images")) ? readdirSync(join(dir, "data", "images")) : [];
  const stop = async () => { proc.kill(); await proc.exited; rmSync(dir, { recursive: true, force: true }); };
  return { base, cookie, inbox, images, stop };
}

function fakeEars(answer: (body: { path: string; prompt?: string }) => Response) {
  const seen: Array<{ path: string; prompt?: string; deadline_s?: number; keys: string[]; existed: boolean }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json() as { path: string; prompt?: string; deadline_s?: number };
      seen.push({ path: body.path, prompt: body.prompt, deadline_s: body.deadline_s, keys: Object.keys(body).sort(), existed: existsSync(body.path) });
      return answer(body);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/hear`, seen, stop: () => server.stop(true) };
}

const voiceForm = (size: number) => {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(size)], { type: "audio/webm" }), "voice.webm");
  form.append("duration", "4");
  return form;
};

test("voice message: heard with sounds and tone, prompt passed, tap refused, page marked", async () => {
  const ears = fakeEars(() => Response.json({ text: "Yes, great.", woven: "[tone: dry]\n*laughs* Yes, great." }));
  const app = await startApp({ EMBERVY_HEAR_URL: ears.url, EMBERVY_HEAR_PROMPT: "Names: Ada, Bo.", EMBERVY_VOICE_MESSAGES: "1" });
  try {
    const page = await (await fetch(`${app.base}/`, { headers: { ...viaTunnel, cookie: app.cookie } })).text();
    expect(page).toContain('<meta name="embervy-voice" content="message">');

    const tap = await fetch(`${app.base}/api/voice`, { method: "POST", headers: { ...viaTunnel, cookie: app.cookie }, body: voiceForm(1000) });
    expect(tap.status).toBe(400);
    expect(app.inbox().length).toBe(0);
    expect(ears.seen.length).toBe(0);

    const sent = await fetch(`${app.base}/api/voice`, { method: "POST", headers: { ...viaTunnel, cookie: app.cookie }, body: voiceForm(4000) });
    expect(sent.status).toBe(200);
    const [msg] = app.inbox();
    expect(msg.type).toBe("voice");
    expect(msg.text).toBe("[Voice message, heard]\n[tone: dry]\n*laughs* Yes, great.");
    expect(ears.seen[0].prompt).toBe("Names: Ada, Bo.");
    expect(ears.seen[0].keys).toEqual(["deadline_s", "path", "prompt"]);
    expect(ears.seen[0].existed).toBe(true);
    expect(ears.seen[0].path).toBe(msg.audio_path);
  } finally {
    await app.stop();
    ears.stop();
  }
}, 30_000);

test("dictation: the ears' plain words, no tone line; the temporary file is gone; no page mark without the switch", async () => {
  const ears = fakeEars(() => Response.json({ text: "Plain words.", woven: "[tone: dry]\nPlain words." }));
  const app = await startApp({ EMBERVY_HEAR_URL: ears.url });
  try {
    const page = await (await fetch(`${app.base}/`, { headers: { ...viaTunnel, cookie: app.cookie } })).text();
    expect(page).not.toContain("embervy-voice");

    const res = await fetch(`${app.base}/api/voice/transcribe`, { method: "POST", headers: { ...viaTunnel, cookie: app.cookie, "content-type": "audio/mp4" }, body: new Uint8Array(3000) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "Plain words." });
    expect(ears.seen[0].keys).toEqual(["deadline_s", "path"]);
    expect(ears.seen[0].path.endsWith(".m4a")).toBe(true);
    expect(app.images().filter((name) => name.startsWith("dictation-"))).toEqual([]);
  } finally {
    await app.stop();
    ears.stop();
  }
}, 30_000);

test("ears down: the voice message says it was not heard, dictation falls back to the worker", async () => {
  const ears = fakeEars(() => new Response("busy", { status: 503 }));
  const worker = Bun.serve({ port: 0, fetch: () => Response.json({ text: "From the worker." }) });
  const app = await startApp({ EMBERVY_HEAR_URL: ears.url, EMBERVY_URL: `http://127.0.0.1:${worker.port}`, EMBERVY_API_KEY: "voice-key" });
  try {
    const sent = await fetch(`${app.base}/api/voice`, { method: "POST", headers: { ...viaTunnel, cookie: app.cookie }, body: voiceForm(4000) });
    expect(sent.status).toBe(200);
    expect(app.inbox()[0].text).toBe("[Voice message, not heard: ask the person to repeat it or to write it.]");

    const res = await fetch(`${app.base}/api/voice/transcribe`, { method: "POST", headers: { ...viaTunnel, cookie: app.cookie, "content-type": "audio/webm" }, body: new Uint8Array(3000) });
    expect(await res.json()).toEqual({ text: "From the worker." });
  } finally {
    await app.stop();
    ears.stop();
    worker.stop(true);
  }
}, 30_000);

test("a repeated upload of one recording is answered once and delivered once, during and after hearing", async () => {
  // The ears take their time, like a long message: the phone gives up and sends again meanwhile.
  const ears = fakeEars(() => Bun.sleep(800).then(() => Response.json({ text: "Long message.", woven: "Long message." })) as unknown as Response);
  const app = await startApp({ EMBERVY_HEAR_URL: ears.url, EMBERVY_VOICE_MESSAGES: "1" });
  const post = (voiceId?: string) => {
    const form = voiceForm(4000);
    if (voiceId) form.append("voice_id", voiceId);
    return fetch(`${app.base}/api/voice`, { method: "POST", headers: { ...viaTunnel, cookie: app.cookie }, body: form }).then((r) => r.json() as Promise<any>);
  };
  try {
    const recording = "3f6b2a1c-9d4e-4f7a-8b2c-1e5d6a7b8c9d";
    const first = post(recording);
    await Bun.sleep(200);
    const whileHearing = await post(recording);
    const firstDone = await first;
    expect(whileHearing).toEqual({ ok: true, id: firstDone.id, audio_url: firstDone.audio_url, repeat: true });

    const afterwards = await post(recording);
    expect(afterwards).toEqual({ ok: true, id: firstDone.id, audio_url: firstDone.audio_url, repeat: true });

    expect(app.inbox().length).toBe(1);
    expect(app.inbox()[0].voice_id).toBe(recording);
    expect(ears.seen.length).toBe(1);

    await post("7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
    await post();
    await post("bad id with spaces");
    expect(app.inbox().length).toBe(4);
    expect(app.inbox()[3].voice_id).toBeUndefined();
  } finally {
    await app.stop();
    ears.stop();
  }
}, 30_000);

test("the wait for the ears grows with the recording and is passed on as deadline_s", async () => {
  const ears = fakeEars(() => Response.json({ text: "Heard.", woven: "Heard." }));
  const send = async (base: string, cookie: string, duration: string) => {
    const form = new FormData();
    form.append("audio", new Blob([new Uint8Array(4000)], { type: "audio/webm" }), "voice.webm");
    form.append("duration", duration);
    return fetch(`${base}/api/voice`, { method: "POST", headers: { ...viaTunnel, cookie }, body: form });
  };
  const app = await startApp({ EMBERVY_HEAR_URL: ears.url, EMBERVY_VOICE_MESSAGES: "1" });
  try {
    expect((await send(app.base, app.cookie, "100")).status).toBe(200);
    expect((await send(app.base, app.cookie, "4")).status).toBe(200);
    expect((await send(app.base, app.cookie, "1000")).status).toBe(200);
    expect(ears.seen.map((s) => s.deadline_s)).toEqual([280, 45, 600]);
  } finally {
    await app.stop();
  }
  const capped = await startApp({ EMBERVY_HEAR_URL: ears.url, EMBERVY_VOICE_MESSAGES: "1", EMBERVY_HEAR_WAIT_MAX: "120", EMBERVY_HEAR_WAIT_PER_SECOND: "nonsense" });
  try {
    expect((await send(capped.base, capped.cookie, "40")).status).toBe(200);
    expect(ears.seen.at(-1)?.deadline_s).toBe(120);
  } finally {
    await capped.stop();
    ears.stop();
  }
}, 30_000);
