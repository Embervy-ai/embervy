import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const settings = read("public/settings.js");
const app = read("public/app.js");
const defaults = { "--bg": "#F5F0EB", "--bg-user": "#E8E0D8", "--bg-agent": "#FFFFFF", "--text": "#2C2C2C", "--accent": "#887052", "--on-accent": "#FFFFFF", "--border": "#E0D8D0" };

function settingsPage(value: any = {}, house: Record<string, string> = defaults) {
  let raw = JSON.stringify(value);
  const elements: Record<string, any> = {};
  const element = (id: string): any => elements[id] ||= {
    value: "", checked: false, textContent: "", hidden: false, dataset: {}, style: {},
    classList: { toggle() {}, add() {}, remove() {} },
    listeners: {} as Record<string, Function>,
    addEventListener(kind: string, fn: Function) { const previous = this.listeners[kind]; this.listeners[kind] = (...args: any[]) => { previous?.(...args); return fn(...args); }; },
    appendChild() {}, append() {}, setAttribute() {}, removeAttribute() {},
  };
  const document = { documentElement: {}, getElementById: element, querySelectorAll: () => [], createElement: () => element("option") };
  const localStorage = { getItem: () => raw, setItem: (_key: string, next: string) => raw = next, removeItem: () => raw = "{}" };
  const window = { location: { href: "" } };
  const source = settings.slice(0, settings.indexOf("// Consent is server-owned"));
  const state = new Function("document", "localStorage", "window", "getComputedStyle", "navigator", "fetch", "alert", `${source}; return { initial, choices, manualLook, phoneChoices, healAppearance, suggestLook };`)(
    document, localStorage, window, () => ({ getPropertyValue: (key: string) => house[key] || "" }), {}, async () => ({ ok: true }), () => { throw new Error("unexpected alert"); });
  return { ...state, element, window, stored: () => JSON.parse(raw), input: (id: string, value: string) => { const el = element(id); el.value = value; el.listeners.input?.({ target: el }); } };
}

function appPage(value: any = {}, house: Record<string, string> = defaults) {
  let raw = JSON.stringify(value);
  const properties: Record<string, string> = {};
  const style = { setProperty: (key: string, value: string) => properties[key] = value, removeProperty: (key: string) => delete properties[key] };
  const title = { textContent: "Agent's title", style: {} };
  const layer = { textContent: "", remove() { this.textContent = ""; } };
  const document = { documentElement: { style }, body: { style }, getElementById: () => layer, querySelector: (selector: string) => selector === "#header h1" ? title : null };
  const source = app.slice(app.indexOf("  function appearanceTextColors("), app.indexOf("  applyAppearance();"));
  const apply = new Function("document", "localStorage", "getComputedStyle", `${source}; return applyAppearance;`)(document,
    { getItem: () => raw, setItem: (_key: string, next: string) => raw = next }, () => ({ getPropertyValue: (key: string) => house[key] || "" }));
  apply();
  return { properties, title, layer, stored: () => JSON.parse(raw), apply };
}

test("an untouched phone leaves every house CSS value and title alone", () => {
  const page = appPage({ features: { voice: false } });
  expect(page.properties).toEqual({});
  expect(page.title.textContent).toBe("Agent's title");
  expect(settingsPage().initial.bgColor).toBe(defaults["--bg"]);
});

test("changing only the background saves only that appearance field", async () => {
  const page = settingsPage();
  page.input("bg-color", "#123456");
  await page.element("save-btn").listeners.click();
  const { appearanceVersion, features, speechLang, speechSend, ...appearance } = page.stored();
  expect(appearance).toEqual({ bgColor: "#123456" });
  expect(appearanceVersion).toBe(1);
  expect(page.window.location.href).toBe("/");
});

test("saving only a feature never snapshots the house look", async () => {
  const page = settingsPage();
  page.element("feature-voice").checked = false;
  await page.element("save-btn").listeners.click();
  expect(Object.keys(page.stored()).sort()).toEqual(["appearanceVersion", "features", "speechLang", "speechSend"]);
  expect(page.stored().features.voice).toBe(false);
});

test("both loaders heal derived old colours, retaining a hand-set colour", () => {
  const page = settingsPage();
  const look = page.suggestLook("#123456", "#ABCDEF");
  const old = { bgColor: "#123456", userColor: "#ABCDEF", textColor: look.text.toLowerCase(), accentColor: look.accent, onAccentColor: look.onAccent, borderColor: "#010203", features: { games: false }, speechLang: "fr" };
  for (const loaded of [settingsPage(old), appPage(old)]) {
    expect(loaded.stored()).toEqual({ appearanceVersion: 1, bgColor: old.bgColor, userColor: old.userColor, borderColor: "#010203", features: old.features, speechLang: "fr" });
  }
});

test("the old full shipped snapshot no longer pins the house", () => {
  const old = { bgMode: "color", bgColor: "#0B1228", bgPhoto: "", userColor: "#D4A948", userAlpha: 20, agentColor: "#5A91DC", agentAlpha: 18, titleText: "Embervy", titleFont: '"Snell Roundhand", "Savoye LET", "Segoe Script", "Brush Script MT", cursive', titleColor: "#7FB2F0" };
  for (const loaded of [settingsPage(old), appPage(old)]) expect(loaded.stored()).toEqual({ appearanceVersion: 1 });
});

test("manual palette input survives saving, reloading and another background", async () => {
  const page = settingsPage();
  page.input("text-color", "#FEDCBA");
  page.input("bg-color", "#123456");
  await page.element("save-btn").listeners.click();
  expect(page.stored().textColor).toBe("#FEDCBA");
  expect(appPage(page.stored()).properties["--text"]).toBe("#FEDCBA");
});

test("a manual colour equal to today's suggestion survives versioned loading", async () => {
  const page = settingsPage();
  page.input("bg-color", "#123456");
  page.input("text-color", page.element("text-color").value);
  await page.element("save-btn").listeners.click();
  const loaded = appPage(page.stored());
  expect(loaded.stored().textColor).toBe(page.stored().textColor);
});

test("house-look reset removes all appearance choices, not feature or speech preferences", () => {
  const page = settingsPage({ appearanceVersion: 1, bgMode: "photo", bgPhoto: "data:,", bgColor: "#123456", userColor: "#ABCDEF", userAlpha: 30, agentColor: "#112233", agentAlpha: 40, titleText: "Mine", titleFont: "serif", titleColor: "#FFFFFF", textColor: "#EEEEEE", accentColor: "#DDDDDD", onAccentColor: "#111111", borderColor: "#222222", features: { terminal_panel: false, voice: false }, speechLang: "de", speechSend: false });
  page.element("house-look-btn").listeners.click();
  expect(page.stored()).toEqual({ appearanceVersion: 1, features: { terminal_panel: false, voice: false }, speechLang: "de", speechSend: false });
  expect(page.window.location.href).toBe("/");
});

test("sparse bubble colour and opacity choices merge with current house values", () => {
  expect(appPage({ appearanceVersion: 1, userAlpha: 25 }).properties["--bg-user"]).toBe("rgba(232, 224, 216, 0.25)");
  expect(appPage({ appearanceVersion: 1, agentColor: "#123456" }).properties["--bg-agent"]).toBe("rgba(18, 52, 86, 1.00)");
  expect(appPage({ appearanceVersion: 1, userColor: "#123456" }, { ...defaults, "--bg-user": "rgba(1, 2, 3, 0.4)" }).properties["--bg-user"]).toBe("rgba(18, 52, 86, 0.40)");
});

test("phone choices win while unrelated house changes remain live", () => {
  const house = { ...defaults };
  const page = appPage({ appearanceVersion: 1, textColor: "#111111" }, house);
  expect(page.properties).toEqual({ "--text": "#111111", "--text-light": "rgba(17, 17, 17, 0.72)" });
  house["--bg"] = "#FFFEEE";
  page.apply();
  expect(page.properties["--bg"]).toBeUndefined();
  expect(page.properties["--text"]).toBe("#111111");
});

test("background-only phone choices derive a readable palette on every load", () => {
  const page = settingsPage();
  for (const bg of ["#FFFFFF", "#123456", "#777777"]) {
    const expected = page.suggestLook(bg, defaults["--bg-user"]);
    const actual = appPage({ appearanceVersion: 1, bgColor: bg }).properties;
    expect([actual["--text"], actual["--accent"], actual["--on-accent"], actual["--border"]]).toEqual([expected.text, expected.accent, expected.onAccent, expected.border]);
  }
});

test("a dark background choice keeps inherited light bubbles and the doctor report readable", () => {
  const page = appPage({ appearanceVersion: 1, bgColor: "#123456" });
  expect(page.properties["--text"]).toBe("#ECEFF4");
  expect(page.layer.textContent).toContain(".message.user{color:#2C2C2C;}");
  expect(page.layer.textContent).toContain(".message.assistant,.message.email,.approval-card,.doctor-report,.typing,.emoji-picker{color:#2C2C2C;}");
});

test("the doctor report sits on the agent bubble's surface, not a see-through card", () => {
  const css = readFileSync(join(import.meta.dir, "public", "style.css"), "utf8");
  const rule = css.slice(css.indexOf(".doctor-report {"), css.indexOf("}", css.indexOf(".doctor-report {")));
  expect(rule).toContain("background: var(--bg-agent);");
  expect(rule).not.toMatch(/background:\s*rgba\(/);
});

test("every chat card shares the agent surface and adaptive text colour", () => {
  const css = read("public/style.css");
  const selectors = [".message.assistant", ".message.email", ".approval-card", ".doctor-report", ".typing", ".emoji-picker"];
  const shared = css.match(/([^{}]+)\{\s*background: var\(--bg-agent\);\s*color: var\(--text\);\s*\}/)![1];
  expect(shared.split(",").map(selector => selector.trim())).toEqual(selectors);
  const scenarios = [
    { appearanceVersion: 1, bgColor: "#123456" },
    { appearanceVersion: 1, bgMode: "photo", bgPhoto: "data:image/png;base64,AA==" },
    { appearanceVersion: 1, bgMode: "photo", bgPhoto: "data:image/png;base64,AA==", bgColor: "#000000", agentColor: "#FFFFFF", agentAlpha: 50 },
    { appearanceVersion: 1, bgColor: "#FFFFFF", agentColor: "#000000", agentAlpha: 100 },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const page = appPage(scenario);
    const color = ["#2C2C2C", "#2C2C2C", "#000000", "#ECEFF4"][index];
    expect(page.layer.textContent).toContain(`${selectors.join(",")}{color:${color};}`);
  }
  expect(appPage(scenarios[2]).properties["--bg-agent"]).toBe("rgba(255, 255, 255, 0.50)");
  for (const renderer of ["renderApprovalCard", "renderMailApprovalCard", "renderHouseQuestionCard"]) {
    const start = app.indexOf(`function ${renderer}(`);
    expect(start).toBeGreaterThan(-1);
    expect(app.slice(start, app.indexOf("\n  }", start))).toContain('class="approval-card');
  }
});

test("nested card details and secondary actions inherit readable text without stacking surfaces", () => {
  const css = read("public/style.css");
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThan(-1);
    return css.slice(start, css.indexOf("}", start));
  };
  for (const selector of [".message .approval-card", ".message .emoji-picker", ".msg-quote", ".approval-actions button"]) {
    expect(rule(selector)).toContain("background: transparent;");
    expect(rule(selector)).toContain("color: inherit;");
  }
  for (const selector of [".approval-status", ".msg-quote .reply-bar-who", ".emoji-btn", ".doctor-mute-error"]) expect(rule(selector)).toContain("color: inherit;");
  expect(rule(".approval-actions .approval-allow")).toContain("background: var(--accent);");
  expect(rule(".approval-actions .approval-allow")).toContain("color: var(--on-accent);");
});

test("chat asset versions and the offline cache advance together", () => {
  const index = read("public/index.html"), settings = read("public/settings.html"), worker = read("public/sw.js");
  const style = readAssetUrl(index, "style.css");
  const script = readAssetUrl(index, "app.js");
  expect(readAssetStamp(index, "style.css")).toBeGreaterThan(116);
  expect(readAssetStamp(index, "app.js")).toBeGreaterThan(129);
  expect(readAssetUrl(settings, "style.css")).toBe(style);
  expect(readAssetUrl(worker, "style.css")).toBe(style);
  expect(readAssetUrl(worker, "app.js")).toBe(script);
  expect(readCacheNumber(worker)).toBeGreaterThan(45);
});

test("non-object stores do not become appearance choices", () => {
  for (const value of [null, [], "not an object"]) expect(appPage(value).properties).toEqual({});
});

test("an unchanged custom background is retained without saving its computed palette", async () => {
  const page = settingsPage({ appearanceVersion: 1, bgColor: "#123456" });
  await page.element("save-btn").listeners.click();
  const { appearanceVersion, features, speechLang, speechSend, ...appearance } = page.stored();
  expect(appearance).toEqual({ bgColor: "#123456" });
});

test("returning a chosen background to the house value removes the override", async () => {
  const page = settingsPage({ appearanceVersion: 1, bgColor: "#123456" });
  page.input("bg-color", defaults["--bg"]);
  await page.element("save-btn").listeners.click();
  expect(page.stored().bgColor).toBeUndefined();
});

test("title choices are case-sensitive", async () => {
  const page = settingsPage();
  page.input("title-text", "EMBERVY");
  await page.element("save-btn").listeners.click();
  expect(page.stored().titleText).toBe("EMBERVY");
});

test("manual accents derive their label colour without persisting it", async () => {
  const page = settingsPage({ appearanceVersion: 1, accentColor: "#FFFFFF" });
  expect(page.element("on-accent-color").value).toBe("#2C2C2C");
  page.input("bg-color", "#123456");
  expect(page.element("on-accent-color").value).toBe("#2C2C2C");
  await page.element("save-btn").listeners.click();
  expect(page.stored().onAccentColor).toBeUndefined();
  expect(appPage(page.stored()).properties["--on-accent"]).toBe("#2C2C2C");
});

test("the two standalone pages use identical migration and palette helpers", () => {
  const normalize = (source: string) => source.split("\n").map((line) => line.trim()).join("\n").trim();
  const settingsMigration = settings.slice(settings.indexOf("function healAppearance("), settings.indexOf("function cssColor("));
  const appMigration = app.slice(app.indexOf("  function healAppearance("), app.indexOf("  function cssColor("));
  expect(normalize(appMigration)).toBe(normalize(settingsMigration));
  const settingsPalette = settings.slice(settings.indexOf("function suggestLook("), settings.indexOf("const SPEECH_LANGUAGES"));
  const appPalette = app.slice(app.indexOf("  function suggestLook("), app.indexOf("  function healAppearance("));
  expect(normalize(appPalette)).toBe(normalize(settingsPalette));
});
