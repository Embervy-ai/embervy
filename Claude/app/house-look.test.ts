import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const settings = read("public/settings.js");
const app = read("public/app.js");
const defaults = { "--bg": "#F5F0EB", "--bg-user": "#E8E0D8", "--bg-agent": "#FFFFFF", "--text": "#2C2C2C", "--accent": "#887052", "--on-accent": "#FFFFFF", "--border": "#E0D8D0" };

// Model the server's photo URL acknowledgement instead of echoing uploaded data URLs.
function acknowledgedLook(value: any) {
  if (!value?.bgPhoto?.startsWith("data:")) return value;
  const hash = createHash("sha256").update(Buffer.from(value.bgPhoto.split(",")[1], "base64")).digest("hex");
  return { ...value, bgPhoto: `/api/house-look/photo?v=${hash}` };
}

function settingsPage(value: any = {}, house: Record<string, string> = defaults, options: { look?: any; failLoad?: boolean; failSave?: boolean; terminalFail?: boolean } = {}) {
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
  let houseLook = options.look ?? null;
  const requests: { path: string; body: any }[] = [], alerts: string[] = [];
  const fetch = async (path: string, init: any = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ path, body });
    if (path === "/api/house-look" && !body && options.failLoad) throw new Error("offline");
    if (path === "/api/house-look" && body) {
      if (options.failSave) return { ok: false, status: 500 };
      houseLook = acknowledgedLook(body);
    }
    if (path.startsWith("/api/house-look/photo?")) return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } });
    return { ok: !(options.terminalFail && path === "/api/terminal/settings"), json: async () => ({ look: houseLook }) };
  };
  const window: any = { location: { href: "" }, fetch };
  new Function("window", read("public/house-look.js"))(window);
  const source = settings.slice(0, settings.indexOf("// Consent is server-owned"));
  const state = new Function("document", "localStorage", "window", "getComputedStyle", "navigator", "fetch", "alert", `${source}; return { initial, choices, manualLook, phoneChoices, healAppearance, suggestLook, ready: houseLookReady };`)(
    document, localStorage, window, () => ({ getPropertyValue: (key: string) => house[key] || "" }), {}, fetch, (message: string) => alerts.push(message));
  return { ...state, requests, alerts, houseLook: () => houseLook, element, window, stored: () => JSON.parse(raw), input: (id: string, value: string) => { const el = element(id); el.value = value; el.listeners.input?.({ target: el }); } };
}

function appPage(value: any = {}, house: Record<string, string> = defaults, storageMode = "") {
  let raw = storageMode === "malformed" ? "{" : JSON.stringify(value);
  const properties: Record<string, string> = {};
  const style = { setProperty: (key: string, value: string) => properties[key] = value, removeProperty: (key: string) => delete properties[key] };
  const title = { textContent: "Agent's title", style: {} };
  const layer = { textContent: "", remove() { this.textContent = ""; } };
  const document = { documentElement: { style }, body: { style }, getElementById: () => layer, querySelector: (selector: string) => selector === "#header h1" ? title : null };
  const source = app.slice(app.indexOf("  function appearanceTextColors("), app.indexOf("  applyAppearance();"));
  const localStorage = {
    getItem: () => { if (storageMode === "blocked") throw new Error("blocked"); return raw; },
    setItem: (_key: string, next: string) => { if (storageMode === "blocked") throw new Error("blocked"); raw = next; },
  };
  const { applyAppearance: apply, healAppearance } = new Function("document", "localStorage", "getComputedStyle", `${source}; return { applyAppearance, healAppearance };`)(document,
    localStorage, () => ({ getPropertyValue: (key: string) => house[key] || "" }));
  apply();
  const refreshSource = app.slice(app.indexOf("  async function refreshHouseAppearance()"), app.indexOf("  void refreshHouseAppearance();"));
  const refresh = (window: any) => new Function("window", "localStorage", "healAppearance", "applyAppearance", `${refreshSource}; return refreshHouseAppearance();`)(window, localStorage, healAppearance, apply);
  return { properties, title, layer, stored: () => JSON.parse(raw), apply, refresh };
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

test("house-look reset removes device colors, not shared fields, feature or speech preferences", () => {
  const page = settingsPage({ appearanceVersion: 1, bgMode: "photo", bgPhoto: "data:,", bgColor: "#123456", userColor: "#ABCDEF", userAlpha: 30, agentColor: "#112233", agentAlpha: 40, titleText: "Mine", titleFont: "serif", titleColor: "#FFFFFF", textColor: "#EEEEEE", accentColor: "#DDDDDD", onAccentColor: "#111111", borderColor: "#222222", features: { terminal_panel: false, voice: false }, speechLang: "de", speechSend: false });
  page.element("house-look-btn").listeners.click();
  expect(page.stored()).toEqual({ appearanceVersion: 1, bgMode: "photo", bgPhoto: "data:,", titleText: "Mine", titleFont: "serif", features: { terminal_panel: false, voice: false }, speechLang: "de", speechSend: false });
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
  await page.ready;
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

function houseClient(initial: any, fail = false, failPhoto = false) {
  let look = initial;
  const requests: { path: string; body?: any }[] = [];
  const window: any = { fetch: async (path: string, options: any) => {
    requests.push({ path, body: options.body ? JSON.parse(options.body) : undefined });
    expect(options.credentials).toBe("include"); expect(options.cache).toBe("no-store");
    if (fail) throw new Error("offline");
    if (path.startsWith("/api/house-look/photo?")) return new Response(new Uint8Array([255, 216, 255]), { status: failPhoto ? 500 : 200, headers: { "content-type": "image/jpeg" } });
    if (options.body && (path === "/api/house-look" || look === null)) look = acknowledgedLook(JSON.parse(options.body));
    return Response.json({ look });
  } };
  new Function("window", read("public/house-look.js"))(window);
  return { window, requests, look: () => look, setLook: (next: any) => { look = next; } };
}

test("opening with no local appearance displays and remembers the house, leaving device colors alone", async () => {
  const house = houseClient({ titleText: "Wren", titleFont: "Georgia, \"Times New Roman\", serif", bgMode: "photo" });
  const page = appPage();
  expect(page.title.textContent).toBe("Agent's title");
  await page.refresh(house.window);
  expect(page.title.textContent).toBe("Wren");
  expect(page.stored().titleText).toBe("Wren");
  expect(page.properties).toEqual({});
  expect(house.requests.map(r => r.path)).toEqual(["/api/house-look"]);
});

test("blocked or malformed local storage does not prevent drawing the house version", async () => {
  for (const mode of ["blocked", "malformed"]) {
    const page = appPage({}, defaults, mode);
    await page.refresh(houseClient({ titleText: "House" }).window);
    expect(page.title.textContent).toBe("House");
  }
});

test("appearance refresh follows PWA restoration independently of socket listeners", () => {
  const listeners: Record<string, Function> = {};
  const document = { visibilityState: "hidden", addEventListener: (name: string, fn: Function) => listeners[name] = fn };
  const window = { addEventListener: (name: string, fn: Function) => listeners[name] = fn };
  let calls = 0;
  const source = app.slice(app.indexOf("  // Appearance refresh is independent"), app.indexOf("  function featureEnabled"));
  new Function("document", "window", "refreshHouseAppearance", source)(document, window, () => { calls++; });
  listeners.visibilitychange(); expect(calls).toBe(0);
  document.visibilityState = "visible"; listeners.visibilitychange();
  listeners.pageshow({ persisted: false }); expect(calls).toBe(1);
  listeners.pageshow({ persisted: true }); listeners.resume(); listeners.online();
  expect(calls).toBe(4);
});

test("house wins against stale shared fields; missing fields restore the file-based heading", async () => {
  const page = appPage({ appearanceVersion: 1, titleText: "Phone", titleFont: "serif", bgMode: "photo", bgPhoto: "data:,", titleColor: "#123456", textColor: "#FEDCBA", features: { voice: false } });
  const house = houseClient({ titleText: "House" });
  await page.refresh(house.window);
  expect(page.title.textContent).toBe("House");
  expect(page.title.style.fontFamily).toBe("");
  expect(page.stored()).toEqual({ appearanceVersion: 1, titleText: "House", titleColor: "#123456", textColor: "#FEDCBA", features: { voice: false } });
  expect(house.requests).toHaveLength(1);
  await page.refresh(houseClient({}).window);
  expect(page.title.textContent).toBe("Agent's title");
  expect(page.title.style.color).toBe("#123456");
});

test("failed look or photo retrieval leaves the last local appearance untouched", async () => {
  const local = { appearanceVersion: 1, titleText: "Phone", bgColor: "#123456", bgPhoto: "data:image/jpeg;base64,/9j/", bgPhotoVersion: "b".repeat(64) };
  for (const house of [houseClient({}, true), houseClient({ titleText: "New", bgPhoto: `/api/house-look/photo?v=${"a".repeat(64)}` }, false, true)]) {
    const page = appPage(local);
    await page.refresh(house.window);
    expect(page.stored()).toEqual(local); expect(page.title.textContent).toBe("Phone");
  }
});

test("photo bytes are remembered offline, not just a network URL", async () => {
  const page = appPage();
  await page.refresh(houseClient({ bgMode: "photo", bgPhoto: `/api/house-look/photo?v=${"a".repeat(64)}` }).window);
  expect(page.stored().bgPhoto).toBe("data:image/jpeg;base64,/9j/");
  const offline = appPage(page.stored());
  await offline.refresh(houseClient(null, true).window);
  expect(offline.stored()).toEqual(page.stored());
  expect(offline.layer.textContent).toContain("center / contain no-repeat");
});

test("a second sync with the same photo version requests only metadata, even after reopening", async () => {
  const house = houseClient({ bgMode: "photo", bgPhoto: `/api/house-look/photo?v=${"a".repeat(64)}` });
  const page = appPage();
  await page.refresh(house.window);
  expect(house.requests.map(r => r.path)).toEqual(["/api/house-look", house.look().bgPhoto]);
  expect(page.stored().bgPhotoVersion).toBe("a".repeat(64));
  const before = JSON.stringify(page.stored());
  house.requests.length = 0;
  const reopened = appPage(page.stored());
  await reopened.refresh(house.window);
  expect(house.requests.map(r => r.path)).toEqual(["/api/house-look"]);
  expect(JSON.stringify(reopened.stored())).toBe(before);
  // Metadata bookkeeping must not create a false appearance change after healing.
  const next = await house.window.embervyHouseLook.sync(reopened.stored());
  expect(JSON.stringify(next)).toBe(before);
});

test("a changed photo version downloads once and retains the new version", async () => {
  const house = houseClient({ bgPhoto: `/api/house-look/photo?v=${"a".repeat(64)}` });
  const client = house.window.embervyHouseLook;
  const previous = await client.sync({});
  house.setLook({ bgPhoto: `/api/house-look/photo?v=${"b".repeat(64)}` });
  house.requests.length = 0;
  const next = await client.sync(previous);
  expect(house.requests.map(r => r.path)).toEqual(["/api/house-look", house.look().bgPhoto]);
  expect(next.bgPhotoVersion).toBe("b".repeat(64));
  await client.sync(next);
  expect(house.requests.filter(r => r.path.includes("/photo?"))).toHaveLength(1);
});

test("a matching version without a usable local image still downloads the photo", async () => {
  for (const bgPhoto of [undefined, "", "/api/house-look/photo?v=" + "a".repeat(64)]) {
    const house = houseClient({ bgPhoto: `/api/house-look/photo?v=${"a".repeat(64)}` });
    const next = await house.window.embervyHouseLook.sync({ bgPhoto, bgPhotoVersion: "a".repeat(64) });
    expect(house.requests.map(r => r.path)).toEqual(["/api/house-look", house.look().bgPhoto]);
    expect(next.bgPhoto).toBe("data:image/jpeg;base64,/9j/");
  }
});

test("an existing local photo without a version downloads once to establish its identity", async () => {
  const house = houseClient({ bgPhoto: `/api/house-look/photo?v=${"a".repeat(64)}` });
  const next = await house.window.embervyHouseLook.sync({ bgPhoto: "data:image/jpeg;base64,/9j/" });
  expect(house.requests).toHaveLength(2);
  expect(next.bgPhotoVersion).toBe("a".repeat(64));
});

test("removing a house photo clears its local version on sync and save", async () => {
  for (const look of [{}, { bgPhoto: "" }]) {
    const house = houseClient(look), client = house.window.embervyHouseLook;
    const local = { bgPhoto: "data:image/jpeg;base64,/9j/", bgPhotoVersion: "a".repeat(64), bgColor: "#123456" };
    const next = await client.sync(local);
    expect(next.bgPhotoVersion).toBeUndefined();
    expect(next.bgPhoto).toBe(look.bgPhoto);
    expect(next.bgColor).toBe(local.bgColor);
    const saved = await client.save({ ...next, bgPhotoVersion: local.bgPhotoVersion });
    expect(saved.bgPhotoVersion).toBeUndefined();
    expect(house.requests.every(r => !r.body || !Object.hasOwn(r.body, "bgPhotoVersion"))).toBe(true);
  }
});

test("settings remembers a saved photo's POST version so reopening needs only metadata", async () => {
  const bgPhoto = "data:image/jpeg;base64,/9j/";
  const page = settingsPage({ appearanceVersion: 1, bgMode: "photo", bgPhoto, bgPhotoVersion: "a".repeat(64) });
  await page.ready;
  await page.element("save-btn").listeners.click();
  expect(page.alerts).toEqual([]);
  expect(page.requests.filter(r => r.path.includes("/photo?"))).toHaveLength(0);
  const version = page.houseLook().bgPhoto.split("?v=")[1];
  expect(page.stored().bgPhotoVersion).toBe(version);
  expect(page.stored().bgPhoto).toBe(bgPhoto);
  expect(page.requests.filter(r => r.body && Object.hasOwn(r.body, "bgPhotoVersion"))).toEqual([]);
  page.requests.length = 0;
  const reopened = appPage(page.stored());
  await reopened.refresh(page.window);
  expect(page.requests.map(r => r.path)).toEqual(["/api/house-look"]);
  expect(reopened.stored().bgPhoto).toBe(bgPhoto);
});

test("settings keeps the loaded photo version outside healing and edited-field comparisons", async () => {
  const bgPhotoVersion = "a".repeat(64), bgPhoto = "data:image/jpeg;base64,/9j/";
  const page = settingsPage({ bgPhoto, bgPhotoVersion }, defaults, { look: { bgPhoto: `/api/house-look/photo?v=${bgPhotoVersion}` } });
  await page.ready;
  expect(page.stored().bgPhotoVersion).toBe(bgPhotoVersion);
  expect(page.choices.bgPhotoVersion).toBe(bgPhotoVersion);
  expect(page.healAppearance({ bgPhotoVersion }).bgPhotoVersion).toBe(bgPhotoVersion);
  expect(page.phoneChoices(page.initial).bgPhotoVersion).toBe(bgPhotoVersion);
  expect(page.window.embervyHouseLook.pick(page.phoneChoices(page.initial))).toEqual({ bgPhoto });
  expect(page.requests.filter(r => r.path.startsWith("/api/house-look")).map(r => r.path)).toEqual(["/api/house-look"]);
});

test("settings carries a newly downloaded photo version into its save choices", async () => {
  const bgPhotoVersion = "b".repeat(64);
  const page = settingsPage({ bgPhotoVersion: "a".repeat(64), bgPhoto: "data:image/jpeg;base64,/9j/" }, defaults, { look: { bgPhoto: `/api/house-look/photo?v=${bgPhotoVersion}` } });
  await page.ready;
  expect(page.choices.bgPhotoVersion).toBe(bgPhotoVersion);
  expect(page.phoneChoices(page.initial).bgPhotoVersion).toBe(bgPhotoVersion);
  expect(page.requests.filter(r => r.path.includes("/photo?"))).toHaveLength(1);
});

test("migration never sends the device photo version", async () => {
  const house = houseClient(null);
  const bgPhoto = "data:image/jpeg;base64,/9j/";
  await house.window.embervyHouseLook.sync({ bgPhoto, bgPhotoVersion: "a".repeat(64) }, true);
  expect(house.requests.filter(r => r.body)).toEqual([{ path: "/api/house-look/migrate", body: { bgPhoto } }]);
});

test("opening migrates only into an absent house and never sends colors or preferences", async () => {
  const house = houseClient(null);
  const local = { appearanceVersion: 1, titleText: "Phone", bgColor: "#123456", userAlpha: 30, features: { voice: false }, speechLang: "fr" };
  const page = appPage(local);
  await page.refresh(house.window);
  expect(house.requests[1]).toEqual({ path: "/api/house-look/migrate", body: { titleText: "Phone" } });
  expect(house.look()).toEqual({ titleText: "Phone" });
  await page.refresh(house.window);
  expect(house.requests.filter(r => r.body)).toHaveLength(1);
  const other = houseClient(null); await appPage({ bgColor: "#123456" }).refresh(other.window);
  expect(other.requests).toHaveLength(1); expect(other.look()).toBeNull();
  const empty = houseClient({}); await appPage(local).refresh(empty.window);
  expect(empty.requests).toHaveLength(1); expect(empty.look()).toEqual({});
});

test("settings load shared house fields, then explicitly save only shared fields to the house", async () => {
  const page = settingsPage({ appearanceVersion: 1, titleText: "Old", bgColor: "#123456", userAlpha: 40 }, defaults, { look: { titleText: "House", bgMode: "photo" } });
  expect(page.element("title-text").disabled).toBe(true);
  await page.ready;
  expect(page.element("title-text").value).toBe("House");
  expect(page.element("title-text").disabled).toBe(false);
  expect(page.element("bg-color").value).toBe("#123456");
  page.input("title-text", "New"); page.input("title-color", "#123456");
  await page.element("save-btn").listeners.click();
  expect(page.houseLook()).toEqual({ titleText: "New", bgMode: "photo" });
  expect(page.stored().titleColor).toBe("#123456"); expect(page.stored().userAlpha).toBe(40);
  expect(page.alerts).toEqual([]);
});

test("failed settings write preserves both house and device state and reports the failure", async () => {
  for (const options of [{ failSave: true }, { terminalFail: true }]) {
    const page = settingsPage({ appearanceVersion: 1, titleText: "Old", bgColor: "#123456" }, defaults, { look: { titleText: "House" }, ...options });
    await page.ready;
    const previous = page.stored();
    page.input("title-text", "New"); page.input("bg-color", "#FEDCBA");
    await page.element("save-btn").listeners.click();
    expect(page.houseLook()).toEqual({ titleText: "House" }); expect(page.stored()).toEqual(previous);
    expect(page.alerts).toHaveLength(1); expect(page.window.location.href).toBe("");
  }
});

test("device palette reset never writes or clears the shared house version", async () => {
  const page = settingsPage({ appearanceVersion: 1, bgColor: "#123456" }, defaults, { look: { titleText: "House", bgMode: "photo" } });
  await page.ready;
  page.element("house-look-btn").listeners.click();
  expect(page.stored().titleText).toBe("House"); expect(page.stored().bgMode).toBe("photo");
  expect(page.stored().bgColor).toBeUndefined(); expect(page.houseLook()).toEqual({ titleText: "House", bgMode: "photo" });
  expect(page.requests.filter(r => r.body)).toEqual([]);
});
