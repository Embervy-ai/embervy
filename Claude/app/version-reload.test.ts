import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The open app reloads once when the server's version (texts and client
// files) differs from its own. That reload waits while it would lose
// something. The reload code is sliced out of public/app.js (markers, as in
// ws-liveness.test.ts) and driven with a fake fetch, storage and clock; the
// settings preview is sliced out of public/settings.js.

const APP = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");
const SETTINGS = readFileSync(join(import.meta.dir, "public", "settings.js"), "utf8");

function slice(source: string, start: string, end: string): string {
  const a = source.indexOf(start);
  const b = a < 0 ? -1 : source.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`marker not found: ${a < 0 ? start : end}`);
  return source.slice(a, b);
}

function harness(serverVersion = "new-version") {
  const timers: (() => void)[] = [];
  const reloads: string[] = [];
  const session = new Map<string, string>();
  const body = `"use strict";
    let pendingImages = [], isRecording = false, isStarting = false, isTranscribing = false;
    ${slice(APP, "  let uploadsInFlight = 0;", "  document.addEventListener(\"visibilitychange\", () => {")}
    return {
      check: checkStringsVersion,
      set(name, value) {
        if (name === "pendingImages") pendingImages = value;
        if (name === "uploadsInFlight") uploadsInFlight = value;
        if (name === "isTranscribing") isTranscribing = value;
        if (name === "isRecording") isRecording = value;
      },
    };`;
  const app = new Function("I18N", "fetch", "sessionStorage", "window", "setInterval", "clearInterval", body)(
    { version: "old-version" },
    async () => ({ ok: true, json: async () => ({ version: serverVersion }) }),
    { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => session.set(k, v) },
    { location: { reload: () => reloads.push("reload") } },
    (fn: () => void) => { timers.push(fn); return timers.length; },
    (id: number) => { timers[id - 1] = () => {}; },
  ) as { check: () => Promise<void>; set: (name: string, value: unknown) => void };
  const tick = () => { for (const fn of [...timers]) fn(); };
  return { app, reloads, tick, session };
}

describe("reload after an update", () => {
  test("with nothing in hand it reloads at once, and only once per version", async () => {
    const h = harness();
    await h.app.check();
    expect(h.reloads).toHaveLength(1);
    expect(h.session.get("embervy-strings-reload")).toBe("new-version");
    await h.app.check();
    expect(h.reloads).toHaveLength(1);
  });

  for (const [what, value, empty] of [
    ["attachments chosen but not sent", [{ name: "a.jpg" }], []],
    ["an upload batch on its way", 1, 0],
    ["a transcription running", true, false],
    ["a recording running", true, false],
  ] as const) {
    test(`it waits while ${what}, and follows when it is done`, async () => {
      const h = harness();
      const name = what.startsWith("attachments") ? "pendingImages" : what.startsWith("an upload") ? "uploadsInFlight" : what.includes("transcription") ? "isTranscribing" : "isRecording";
      h.app.set(name, value);
      await h.app.check();
      h.tick();
      expect(h.reloads).toHaveLength(0);
      h.app.set(name, empty);
      h.tick();
      expect(h.reloads).toHaveLength(1);
    });
  }

  test("the same version as the page: no reload", async () => {
    const h = harness("old-version");
    await h.app.check();
    expect(h.reloads).toHaveLength(0);
  });
});

describe("settings preview", () => {
  test("a page from an older cache without the preview element still runs", () => {
    const code = slice(SETTINGS, "function showPhotoPreview(unsaved)", "showPhotoPreview(false);");
    const run = (preview: unknown) => new Function("$", "t", "bgPhotoData", `${code}\nshowPhotoPreview(false); showPhotoPreview(true); return true;`)(
      (id: string) => (id === "bg-photo-preview" ? preview : { textContent: "" }), (k: string) => k, "data:image/jpeg;base64,AA");
    expect(run(null)).toBe(true);
    const img: Record<string, unknown> = { hidden: true, removeAttribute() {} };
    expect(run(img)).toBe(true);
    expect(img.src).toBe("data:image/jpeg;base64,AA");
  });
});
