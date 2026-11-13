import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";
import { acceptedPushEndpoint } from "./push-endpoint";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const app = read("public/app.js");
const html = read("public/settings.html");
const css = read("public/style.css");
// Installed copies may customize colors; shipped-palette assertions apply only to the source tree.
const shippedLookTest = existsSync(join(import.meta.dir, "..", "..", ".git")) ? test : test.skip;
const settings = read("public/settings.js");
const helper = app.slice(app.indexOf("  function appearanceTextColors("), app.indexOf("  // The stored photo is a data URL"));
const colors = new Function(`${helper}; return appearanceTextColors;`)() as (bg: string) => { text: string; textLight: string };
const presets = new Function(`return ${settings.match(/const THEME_PRESETS = (\[[\s\S]*?\]);/)![1]}`)() as { id: string; nameKey: string; bg: string; user: string; agent: string }[];

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].reduce((sum, byte, i) => {
    const x = byte / 255;
    return sum + [0.2126, 0.7152, 0.0722][i] * (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
  }, 0);
}
function contrast(a: string, b: string) {
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
function composite(fg: string, bg: string, alpha: number) {
  return "#" + [1, 3, 5].map(i => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, "0")).join("");
}
function rule(source: string, selector: string) {
  const rules = [...source.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const match = rules.find(([, selectors]) => selectors.trim() === selector || selectors.split(",").some(s => s.trim() === selector));
  expect(match).toBeDefined();
  return match![2];
}

test("eight named presets retain six dark schemes and add Paper and Sand", () => {
  expect(presets.map(p => p.id)).toEqual(["midnight", "slate", "carbon", "forest", "plum", "ember", "paper", "sand"]);
  const strings = JSON.parse(read("strings/en.json"));
  for (const p of presets) expect(strings[p.nameKey]).toBeTruthy();
});
for (const p of presets) {
  test(`${p.id}: both text roles exceed WCAG AA on the background`, () => {
    const result = colors(p.bg);
    expect(contrast(p.bg, result.text)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(p.bg, result.textLight)).toBeGreaterThanOrEqual(4.5);
    // Conservative contrast bounds avoid rounding a marginal result upward.
    expect(contrast(p.bg, result.text)).toBeGreaterThanOrEqual(p.id === "sand" ? 11 : p.id === "paper" ? 13 : 15);
    expect(contrast(p.bg, result.textLight)).toBeGreaterThanOrEqual(p.id === "sand" ? 4.5 : p.id === "paper" ? 5 : 8);
    for (const [fg, alpha] of [[p.user, 0.20], [p.agent, 0.18]] as const) {
      expect(contrast(composite(fg, p.bg, alpha), result.text)).toBeGreaterThanOrEqual(4.5);
    }
  });
}
test("white uses today's dark text; midnight uses light text", () => {
  expect(colors("#FFFFFF")).toEqual({ text: "#2C2C2C", textLight: "#6B6560" });
  expect(colors("#0B1228")).toEqual({ text: "#ECEFF4", textLight: "#A9B1C0" });
  expect(colors("invalid")).toEqual(colors("#FFFFFF"));
});
test("midtones and saturated colours preserve the 4.5 floor for both roles", () => {
  for (let r = 0; r <= 255; r += 17) for (let g = 0; g <= 255; g += 17) for (let b = 0; b <= 255; b += 17) {
    const bg = "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
    for (const value of Object.values(colors(bg))) expect(contrast(bg, value)).toBeGreaterThanOrEqual(4.5);
  }
});
test("switch labels cannot grow or shrink; adjacent text wraps in the same row", () => {
  expect(html).not.toContain(".field label {");
  expect(rule(html, ".field label:not(.switch)")).toContain("overflow-wrap: anywhere");
  const sw = rule(html, ".field label.switch");
  for (const declaration of ["width: 42px", "height: 24px", "flex: 0 0 42px", "margin-left: auto"]) expect(sw).toContain(declaration);
  expect(rule(html, ".field:has(> .switch)")).toContain("flex-wrap: nowrap");
});
shippedLookTest("settings header and Apply use light text with AA contrast", () => {
  expect(rule(html, ".settings-header h1")).toContain("color: #EAF0FA");
  expect(rule(html, ".back-link")).toContain("color: #EAF0FA");
  expect(rule(html, "#save-btn")).toContain("color: #FFFFFF");
  for (const name of ["accent", "accent-hover"]) {
    const bg = css.match(new RegExp(`--${name}: (#[0-9A-Fa-f]{6})`))![1];
    expect(contrast("#FFFFFF", bg)).toBeGreaterThanOrEqual(4.5);
  }
});
const appearanceBody = () => app.slice(app.indexOf("  // The stored photo is a data URL"), app.indexOf("  applyAppearance();"));
test("appearance applies text with bg, and resets photo/default to CSS values", () => {
  const body = appearanceBody();
  for (const name of ["--bg", "--bg-chat", "--text", "--text-light"]) expect(body).toContain(`root.setProperty("${name}"`);
  const stored: Record<string, string> = {};
  const style = { setProperty: (k: string, v: string) => { stored[k] = v; }, removeProperty: (k: string) => { delete stored[k]; } };
  const document = { documentElement: { style }, body: { style }, getElementById: () => ({ textContent: "", remove() {} }), querySelector: () => null };
  const apply = (value: object) => new Function("document", "localStorage", `${helper}\n${body}\napplyAppearance();`)(document, { getItem: () => JSON.stringify(value) });
  apply({ bgMode: "color", bgColor: "#0B1228" });
  expect(stored["--text"]).toBe("#ECEFF4");
  expect(stored["--text-light"]).toBe("#A9B1C0");
  expect(stored["--bg-chat"]).toBe("#0B1228");
  for (const bgMode of ["photo", "default"]) {
    apply({ bgMode, bgPhoto: "data:image/png;base64,AA" });
    for (const key of ["--bg", "--bg-chat", "--text", "--text-light"]) expect(stored[key]).toBeUndefined();
  }
});
shippedLookTest("a photo background is not covered by the body's own background", () => {
  // An opaque body background would cover the z-index:-1 photo layer.
  expect(rule(css, "html, body")).toContain("background: var(--bg)");
  const body = appearanceBody();
  const layer = { textContent: "", remove() {} };
  const style = { setProperty() {}, removeProperty() {} };
  const document = { documentElement: { style }, body: { style }, getElementById: () => layer, querySelector: () => null };
  const apply = (bgPhoto: string) => new Function("document", "localStorage", `${helper}\n${body}\napplyAppearance();`)(document, { getItem: () => JSON.stringify({ bgMode: "photo", bgPhoto }) });
  apply("data:image/png;base64,iVBORw0KGgo=");
  expect(layer.textContent).toContain("body{background:transparent !important;}");
  expect(layer.textContent).toMatch(/url\("blob:[^"]+"\) center \/ contain no-repeat/);
  expect(layer.textContent).not.toContain("base64");
  apply("data:,");
  expect(layer.textContent).toContain('url("data:,")');
});
const lookHelpers = new Function(`${settings.slice(settings.indexOf("const isHex ="), settings.indexOf("const DEFAULTS ="))}; return { suggestLook, contrastRatio, readableOn };`)() as {
  suggestLook: (bg: string, own: string) => { text: string; accent: string; onAccent: string; border: string };
  contrastRatio: (a: string, b: string) => number;
};
function runLook() {
  const stored: Record<string, string> = {};
  const style = { setProperty: (k: string, v: string) => { stored[k] = v; }, removeProperty: (k: string) => { delete stored[k]; } };
  const meta = { content: "#F5F0EB", getAttribute() { return this.content; }, setAttribute(_k: string, v: string) { this.content = v; } };
  const document = { documentElement: { style }, body: { style }, getElementById: () => ({ textContent: "", remove() {} }), querySelector: () => meta, createElement: () => ({}) };
  let current = "null";
  const run = new Function("document", "localStorage", `${helper}\n${appearanceBody()}\nreturn applyAppearance;`)(document, { getItem: () => current }) as () => void;
  return { stored, meta, apply: (look: object) => { current = JSON.stringify(look); run(); } };
}
test("the app shows the stored look exactly, with a colour and with a photo", () => {
  const { stored, meta, apply } = runLook();
  const look = { textColor: "#FFCC00", accentColor: "#B6BAC0", onAccentColor: "#2C2C2C", borderColor: "#606264" };
  apply({ bgMode: "color", bgColor: "#121316", ...look });
  expect([stored["--bg"], stored["--text"], stored["--accent"], stored["--on-accent"], stored["--border"]]).toEqual(["#121316", "#FFCC00", "#B6BAC0", "#2C2C2C", "#606264"]);
  expect(stored["--text-light"]).toBe("rgba(255, 204, 0, 0.72)");
  expect(meta.content).toBe("#121316");
  apply({ bgMode: "photo", bgPhoto: "data:image/jpeg;base64,AAAA", bgColor: "#494A4A", ...look });
  expect([stored["--bg"], stored["--bg-chat"], stored["--text"], stored["--accent"]]).toEqual(["#494A4A", "#494A4A", "#FFCC00", "#B6BAC0"]);
  expect(meta.content).toBe("#494A4A");
  apply({ bgMode: "color", bgColor: "#0B1228" });
  expect(stored["--text"]).toBe("#ECEFF4");
  expect(stored["--accent"]).toMatch(/^#[0-9a-f]{6}$/i);
  apply({ bgMode: "photo", bgPhoto: "data:image/jpeg;base64,AAAA", bgColor: "#121316" });
  expect(stored["--bg"]).toBe("#121316");
  for (const key of ["--text", "--accent", "--border"]) expect(stored[key]).toMatch(/^#[0-9a-f]{6}$/i);
  apply({ bgMode: "default" });
  expect(meta.content).toBe("#F5F0EB");
});
test("presets and a photo fill text, buttons and frame that read on each other", () => {
  const backgrounds = [...presets.map((p) => [p.bg, p.user] as const), ["#494A4A", "#B0B4BA"] as const, ["#F2EFE6", "#DED3C3"] as const];
  for (const [bg, own] of backgrounds) {
    const look = lookHelpers.suggestLook(bg, own);
    expect(lookHelpers.contrastRatio(look.text, bg)).toBeGreaterThanOrEqual(4.5);
    expect(lookHelpers.contrastRatio(look.accent, bg)).toBeGreaterThanOrEqual(4.5);
    expect(lookHelpers.contrastRatio(look.onAccent, look.accent)).toBeGreaterThanOrEqual(4.5);
    expect(look.border).toMatch(/^#[0-9a-f]{6}$/);
  }
  expect(settings).toContain("setLook(suggestLook(preset.bg, preset.user));");
  expect(settings).toContain('setLook(suggestLook(tone, $("user-color").value));');
  for (const id of ["text-color", "accent-color", "on-accent-color", "border-color"]) expect(html).toContain(`id="${id}"`);
  expect(app).not.toContain("photoTone");
});
test("whatever sits on the accent takes its label colour from --on-accent", () => {
  // Hard-coded white would make labels unreadable on light accents.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const onAccent = rules.filter(([, , body]) => /background(-color)?:\s*var\(--accent/.test(body!));
  expect(onAccent.length).toBeGreaterThanOrEqual(5);
  for (const [, selector, body] of onAccent) {
    const color = /(?<![-\w])color:\s*([^;]+)/.exec(body!)?.[1]?.trim();
    if (color !== undefined) expect(`${selector!.trim()}: ${color}`).toBe(`${selector!.trim()}: var(--on-accent)`);
  }
  expect(rule(css, "#send-btn")).toContain("color: var(--on-accent)");
});
test("an older cached settings page without the look fields still runs", () => {
  const part = settings.slice(settings.indexOf("const LOOK_FIELDS ="), settings.indexOf('$("user-color").value = s.userColor;'));
  const body = `${settings.slice(settings.indexOf("const isHex ="), settings.indexOf("const DEFAULTS ="))}\n${part}\nsetLook(suggestLook("#121316", "#B0B4BA")); updateReadability(); return lookValue("accentColor");`;
  const s = { textColor: "#ECEFF4", accentColor: "#B0B4BA", onAccentColor: "#2C2C2C", borderColor: "#41475A" };
  const $ = (id: string) => (id === "bg-color" ? { value: "#121316", addEventListener() {} } : null);
  const run = () => new Function("$", "t", "s", "document", "manualLook", body)($, (k: string) => k, s, { querySelectorAll: () => [] }, new Set());
  expect(run).not.toThrow();
  expect(run()).toMatch(/^#[0-9a-f]{6}$/i);
});
test("timestamps, placeholder and header icons follow text variables", () => {
  for (const selector of [".message .time", "#input::placeholder", "#doctor-btn", "#notes-btn", "#kept-btn", "#activity-strip", "#reply-bar-cancel"]) expect(rule(css, selector)).toContain("var(--text-light)");
});
test("the service worker never answers dynamic requests, so deleted content is not revived from it", async () => {
  const handlers: Record<string, Function> = {};
  let cacheReads = 0;
  const self = { location: { origin: "https://app.test" }, addEventListener: (k: string, f: Function) => handlers[k] = f, skipWaiting() {} };
  new Function("self", "caches", "fetch", read("public/sw.js"))(self, { match() { cacheReads++; return new Response("deleted"); } }, async () => { throw new Error("offline"); });
  for (const path of ["/share/a.txt", "/calendar.ics?token=secret", "/api/memory-image/1", "/api/images/1.png", "/", "/other.js"]) {
    let answered = false;
    handlers.fetch({ request: new Request("https://app.test" + path), respondWith() { answered = true; } });
    expect(answered).toBe(false);
  }
  expect(cacheReads).toBe(0);
  expect(read("server.ts")).not.toContain('kind === "video" ? "private, no-store" : "private, max-age=3600"');
});

function notesExport(window: any = {}, navigator: any = {}) {
  const body = app.slice(app.indexOf("    async function doSave()"), app.indexOf('    saveBtn.addEventListener("click", doSave)'));
  const editor = { innerHTML: "draft", innerText: "draft" };
  let stored: string | null = "draft", flashed = false;
  const run = new Function("editor", "window", "navigator", "localStorage", "autosave", "flashSaved", "document", "t", "console", `const STORAGE_KEY = 'notes'; let saveTimer; ${body}; return doSave;`)(editor, window, navigator,
    { removeItem() { stored = null; } }, () => stored = editor.innerHTML, () => flashed = true,
    { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } }, () => "notes", { error() {} });
  return { editor, run, state: () => ({ stored, flashed }) };
}
test("a completed share clears the note; a plain download or a failed share keeps it", async () => {
  for (const [nav, cleared] of [[{}, false], [{ platform: "iPhone", share: async () => {} }, true], [{ platform: "Win32", share: async () => {} }, false], [{ platform: "iPhone", share: async () => { throw new Error("failed"); } }, false]] as const) {
    const n = notesExport({}, nav); await n.run();
    expect(n.editor.innerHTML).toBe(cleared ? "" : "draft");
    expect(n.state()).toEqual(cleared ? { stored: null, flashed: true } : { stored: "draft", flashed: false });
  }
});
test("only a closed export deletes its unchanged snapshot", async () => {
  for (const mode of ["success", "failure", "edit"]) {
    let n: ReturnType<typeof notesExport>;
    n = notesExport({ showSaveFilePicker: async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {
      if (mode === "failure") throw new Error("disk full");
      if (mode === "edit") n.editor.innerHTML = "new draft";
    } }) }) });
    await n.run();
    expect(n.editor.innerHTML).toBe(mode === "success" ? "" : mode === "edit" ? "new draft" : "draft");
    expect(n.state().stored).toBe(mode === "success" ? null : mode === "edit" ? "new draft" : "draft");
    expect(n.state().flashed).toBe(mode !== "failure");
  }
});
test("push cleanup preserves registrations made while sending", async () => {
  const source = read("server.ts");
  const body = source.slice(source.indexOf("async function sendPushToAll("), source.indexOf("function generateId("));
  const js = new Bun.Transpiler({ loader: "ts" }).transformSync(body);
  let subs = [{ endpoint: "https://fcm.googleapis.com/fcm/send/A" }];
  const send = new Function("loadSubscriptions", "saveSubscriptions", "webpush", "acceptedPushEndpoint", `${js}; return sendPushToAll;`)(
    () => structuredClone(subs), (s: typeof subs) => subs = s,
    { sendNotification: async () => { subs.push({ endpoint: "https://fcm.googleapis.com/fcm/send/B" }); throw { statusCode: 410 }; } }, acceptedPushEndpoint);
  await send("title", "body");
  expect(subs).toEqual([{ endpoint: "https://fcm.googleapis.com/fcm/send/B" }]);
});

test("asset URLs agree across settings, app and service worker", () => {
  const index = read("public/index.html"), sw = read("public/sw.js");
  const style = readAssetUrl(index, "style.css");
  expect(readAssetUrl(html, "style.css")).toBe(style);
  expect(readAssetUrl(sw, "style.css")).toBe(style);
  expect(readAssetUrl(sw, "app.js")).toBe(readAssetUrl(index, "app.js"));
  // Local asset changes may add a version suffix; require agreement rather than a fixed shipped number.
  expect(() => readCacheNumber(sw)).not.toThrow();
  expect(() => readAssetStamp(html, "settings.js")).not.toThrow();
});
