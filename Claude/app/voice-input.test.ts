import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The app's speech section, run against stubs: a recorder, the browser's
// recognition, the server's /api/voice/transcribe. What gets sent, and with
// which text, is the behaviour under test.

const app = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
const SECTION = app.slice(app.indexOf("  function voiceSettings() {"), app.indexOf("  let pingInterval = null;"));

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };

type Options = {
  recorder?: boolean;          // MediaRecorder + getUserMedia available
  recognition?: boolean;       // SpeechRecognition available
  transcribe?: () => Response; // the server's answer
  look?: Record<string, unknown>;
  whisperOff?: boolean;
};

function harness(o: Options = {}) {
  const sent: string[] = [];
  const fetches: Array<{ url: string; init: any }> = [];
  const session = new Map<string, string>(o.whisperOff ? [["embervy-whisper-off", "1"]] : []);
  let gumCalls = 0;
  let clickHandler: ((e: any) => void) | null = null;
  const classes = new Set<string>();
  const micBtn = {
    style: { display: "" },
    classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)), add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
    setAttribute: () => {},
    addEventListener: (type: string, fn: any) => { if (type === "click") clickHandler = fn; },
  };
  const inputEl = { value: "", style: { height: "" }, scrollHeight: 20, focus: () => {} };
  let recognitionInstance: any = null;
  class FakeRecognition {
    lang = ""; continuous = false; interimResults = false;
    onresult: any; onend: any; onerror: any;
    constructor() { recognitionInstance = this; }
    start() {}
    stop() { setTimeout(() => this.onend?.(), 0); }
    abort() {}
    say(text: string) { this.onresult?.({ results: [[{ transcript: text }]] }); }
  }
  let recorderInstance: any = null;
  class FakeRecorder {
    static isTypeSupported = (t: string) => t === "audio/webm";
    mimeType: string; state = "inactive"; ondataavailable: any; onstop: any;
    constructor(_stream: unknown, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType || "audio/mp4"; recorderInstance = this; }
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(3000)]) });
      setTimeout(() => this.onstop?.(), 0);
    }
  }
  const window: any = {};
  if (o.recognition !== false) window.SpeechRecognition = FakeRecognition;
  if (o.recorder !== false) window.MediaRecorder = FakeRecorder;
  const navigator: any = o.recorder === false ? {} : {
    mediaDevices: { getUserMedia: async () => { gumCalls++; return { getTracks: () => [{ stop() {} }] }; } },
  };
  const localStorage = {
    getItem: (k: string) => (k === "embervy-appearance" && o.look ? JSON.stringify(o.look) : null),
    removeItem: () => {},
  };
  const sessionStorage = { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => { session.set(k, v); } };
  const fetch = async (url: string, init: any) => {
    fetches.push({ url, init });
    return (o.transcribe ?? (() => Response.json({ text: "Whisper heard this." })))();
  };
  const sendMessage = () => { sent.push(inputEl.value); };
  const body = `${SECTION}; return {};`;
  new Function(
    "window", "navigator", "localStorage", "sessionStorage", "fetch", "micBtn", "inputEl", "sendMessage", "DRAFT_KEY", "I18N", "MediaRecorder", "console",
    body,
  )(window, navigator, localStorage, sessionStorage, fetch, micBtn, inputEl, sendMessage, "draft", { language: "en" }, FakeRecorder, { warn() {}, error() {}, log() {} });
  const click = async () => { clickHandler!({ preventDefault() {} }); await flush(); };
  return {
    sent, fetches, session, classes, micBtn, inputEl, click,
    gumCalls: () => gumCalls,
    recognition: () => recognitionInstance as FakeRecognition,
    recorder: () => recorderInstance as FakeRecorder | null,
  };
}

describe("voice input", () => {
  test("the recording goes to Whisper in the chosen language, and Whisper's text is sent", async () => {
    const h = harness({ look: { speechLang: "de" } });
    await h.click();
    expect(h.classes.has("recording")).toBe(true);
    expect(h.recognition().continuous).toBe(true);
    expect(h.recognition().lang).toBe("de");
    h.recognition().say("browser guess");
    expect(h.inputEl.value).toBe("browser guess");
    await h.click();
    expect(h.fetches.length).toBe(1);
    expect(h.fetches[0]!.url).toBe("/api/voice/transcribe?language=de");
    expect(h.fetches[0]!.init.headers["Content-Type"]).toBe("audio/webm");
    expect(h.sent).toEqual(["Whisper heard this."]);
    expect(h.classes.has("transcribing")).toBe(false);
  });

  test("a late browser result does not overwrite Whisper's text", async () => {
    const h = harness({ look: { speechSend: false } });
    await h.click();
    await h.click();
    h.recognition().say("too late");
    expect(h.inputEl.value).toBe("Whisper heard this.");
    expect(h.sent).toEqual([]);
  });

  test("without Whisper the browser's text is sent, and the session stops recording", async () => {
    const h = harness({ transcribe: () => Response.json({ error: "voice transcription is not configured" }, { status: 503 }) });
    await h.click();
    h.recognition().say("browser text");
    await h.click();
    expect(h.sent).toEqual(["browser text"]);
    expect(h.session.get("embervy-whisper-off")).toBe("1");
    const asked = h.gumCalls();
    await h.click();
    expect(h.gumCalls()).toBe(asked);
    expect(h.recognition().continuous).toBe(false);
  });

  test("a failing Whisper keeps the browser's text but tries again next time", async () => {
    const h = harness({ transcribe: () => Response.json({ error: "whisper failed" }, { status: 502 }) });
    await h.click();
    h.recognition().say("kept");
    await h.click();
    expect(h.sent).toEqual(["kept"]);
    expect(h.session.has("embervy-whisper-off")).toBe(false);
  });

  test("only the browser's recognition: its end sends, as before", async () => {
    const h = harness({ recorder: false });
    await h.click();
    h.recognition().say("just the browser");
    await h.click();
    expect(h.fetches.length).toBe(0);
    expect(h.sent).toEqual(["just the browser"]);
  });

  test("only a recorder (no browser recognition): Whisper alone fills the field", async () => {
    const h = harness({ recognition: false, look: { speechSend: false } });
    await h.click();
    await h.click();
    expect(h.inputEl.value).toBe("Whisper heard this.");
    expect(h.sent).toEqual([]);
  });

  test("Whisper turned off in Settings: no recording, the browser's text is sent", async () => {
    const h = harness({ look: { features: { whisper: false } } });
    await h.click();
    expect(h.gumCalls()).toBe(0);
    h.recognition().say("browser only");
    await h.click();
    expect(h.fetches.length).toBe(0);
    expect(h.sent).toEqual(["browser only"]);
  });

  test("neither way to listen hides the button", () => {
    const h = harness({ recorder: false, recognition: false });
    expect(h.micBtn.style.display).toBe("none");
  });
});
