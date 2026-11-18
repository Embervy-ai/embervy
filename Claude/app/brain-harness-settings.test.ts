import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { mergeStrings, t as translate } from "./strings";
import { readAssetReferences, readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";

// Run the last statement of settings.js against a tiny DOM populated from the
// shipped HTML. Render its mutations back into that document with HTMLRewriter.
const APP = import.meta.dir;
const SOURCE = readFileSync(join(APP, "public", "settings.js"), "utf8");
const HTML = readFileSync(join(APP, "public", "settings.html"), "utf8");
const EN = JSON.parse(readFileSync(join(APP, "strings", "en.json"), "utf8"));
const strings = mergeStrings(EN, undefined).strings;
const t = (key: string, vars?: Record<string, string | number>) => translate(strings, key, vars);

class FakeElement {
  classes: Set<string>;
  textContent = "";
  removed = false;
  listeners: Record<string, Function[]> = {};
  constructor(classes: string[] = [], public children: Record<string, FakeElement> = {}) { this.classes = new Set(classes); }
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    toggle: (c: string, on?: boolean) => { if (on === undefined ? !this.classes.has(c) : on) this.classes.add(c); else this.classes.delete(c); },
  };
  querySelector(sel: string) { return this.children[sel] ?? null; }
  addEventListener(name: string, fn: Function) { (this.listeners[name] ??= []).push(fn); }
  remove() { this.removed = true; }
  get hidden() { return this.classes.has("hidden"); }
  dataset: Record<string, string> = {};
}

async function runModelSection(gptModel: unknown | "throw") {
  const start = SOURCE.indexOf("(async function setupModelSwitcher()");
  expect(start).toBeGreaterThan(-1);
  const code = SOURCE.slice(start).trim();
  expect(code.endsWith("})();")).toBe(true);

  const nodes: Record<string, FakeElement[]> = {};
  const selectors = ["#model-section", "#model-section .field", "#model-hint", "#model-buttons button"];
  const parser = new HTMLRewriter();
  for (const selector of selectors) {
    nodes[selector] = [];
    parser.on(selector, { element(el) {
      const node = new FakeElement((el.getAttribute("class") || "").split(/\s+/).filter(Boolean));
      const model = el.getAttribute("data-model");
      if (model) node.dataset.model = model;
      nodes[selector].push(node);
    } });
  }
  await parser.transform(new Response(HTML)).text();
  const [section] = nodes["#model-section"];
  const [field] = nodes["#model-section .field"];
  const [hint] = nodes["#model-hint"];
  const buttons = nodes["#model-buttons button"];
  expect(section.hidden).toBe(true); // no initial flash of the card
  section.children[".field"] = field;
  const fetched: string[] = [];
  const sent: unknown[] = [];
  const queried: string[] = [];
  const document = {
    getElementById: (id: string) => section.removed ? null : ({ "model-section": section, "model-hint": hint } as Record<string, FakeElement>)[id] ?? null,
    querySelectorAll: (sel: string) => { queried.push(sel); return section.removed ? [] : nodes[sel] ?? []; },
  };
  const fetchFake = async (url: string, init?: { method?: string; body?: string }) => {
    fetched.push(`${init?.method ?? "GET"} ${url}`);
    if (gptModel === "throw") throw new Error("offline");
    if (url === "/api/message") {
      const body = JSON.parse(init!.body!);
      sent.push(body);
      gptModel = { substrate: "gpt", model: `gpt-5.6-${body.text.split(" ")[1]}` };
    }
    return { json: async () => gptModel };
  };
  const run = new Function("document", "fetch", "t", "setTimeout", `return ${code}`);
  await run(document, fetchFake, t, (fn: Function) => fn());
  const render = async () => {
    const renderer = new HTMLRewriter();
    for (const selector of selectors) {
      let index = 0;
      renderer.on(selector, { element(el) {
        const node = nodes[selector][index++];
        if (node.removed) { el.remove(); return; }
        if (node.classes.size) el.setAttribute("class", [...node.classes].join(" "));
        else el.removeAttribute("class");
        if (selector === "#model-hint") el.setInnerContent(node.textContent);
      } });
    }
    return renderer.transform(new Response(HTML)).text();
  };
  return { section, field, hint, buttons, fetched, sent, queried, document, render };
}

describe("settings.js model section", () => {
  test("Brain: the whole Model card is absent from the rendered document, without model traffic", async () => {
    const r = await runModelSection({ substrate: "brain" });
    const rendered = await r.render();
    expect(r.document.getElementById("model-section")).toBeNull();
    for (const marker of ['id="model-section"', 'data-i18n="settings.model.heading"', 'id="model-buttons"', 'id="model-hint"']) {
      expect(rendered).not.toContain(marker);
    }
    // Every other settings card, including its content, is untouched.
    const withoutModel = await new HTMLRewriter().on("#model-section", { element(el) { el.remove(); } }).transform(new Response(HTML)).text();
    expect(rendered).toBe(withoutModel);
    expect(r.queried).toEqual([]);
    expect(r.buttons.every((b) => Object.keys(b.listeners).length === 0)).toBe(true);
    expect(r.fetched).toEqual(["GET /api/gpt-model"]);
  });

  test("Claude Code with GPT backend: the card, choices and model switching stay unchanged", async () => {
    const r = await runModelSection({ substrate: "gpt", model: "gpt-5.6-terra" });
    expect(r.document.getElementById("model-section")).toBe(r.section);
    expect(r.section.hidden).toBe(false);
    expect(r.field.hidden).toBe(false);
    expect(await r.render()).toContain('<h2 data-i18n="settings.model.heading">Model</h2>');
    expect(r.buttons.map(b => b.dataset.model)).toEqual(["terra", "luna", "sol"]);
    expect(r.hint.textContent).toBe("Current: gpt-5.6-terra");
    expect(r.buttons.map(b => b.classes.has("active"))).toEqual([true, false, false]);
    expect(r.buttons.every((b) => (b.listeners.click ?? []).length === 1)).toBe(true);
    await r.buttons[1].listeners.click[0]();
    expect(r.sent).toEqual([{ text: "/model luna" }]);
    expect(r.fetched).toEqual(["GET /api/gpt-model", "POST /api/message", "GET /api/gpt-model"]);
    expect(r.buttons.map(b => b.classes.has("active"))).toEqual([false, true, false]);
    expect(r.hint.textContent).toBe("Current: gpt-5.6-luna");
  });

  test("any other substrate, or an unreachable server: the section stays hidden as before", async () => {
    for (const info of [{ substrate: "claude" }, { substrate: "glm" }, null, "throw" as const]) {
      const r = await runModelSection(info);
      expect(r.section.hidden).toBe(true);
      expect(r.section.removed).toBe(false);
      expect(r.hint.textContent).toBe("");
      expect(r.queried).toEqual([]);
    }
  });

  test("the still-used Brain model response points to the chat header menu, not typed commands", () => {
    expect(EN["model.brain"]).toContain("Brain menu at the top of the chat");
    expect(EN["model.brain"]).not.toMatch(/\/(?:heads?|model)\b/);
    expect(EN["settings.model.brain"]).toBeUndefined();
  });

  test("the changed settings asset and worker have fresh, matching stamps on every HTML reference", () => {
    const worker = readFileSync(join(APP, "public", "sw.js"), "utf8");
    expect(readAssetStamp(HTML, "settings.js")).toBeGreaterThan(114);
    expect(readCacheNumber(worker)).toBeGreaterThan(68);
    const url = readAssetUrl(HTML, "settings.js");
    expect(readAssetUrl(worker, "settings.js")).toBe(url);
    for (const file of readdirSync(join(APP, "public")).filter(file => file.endsWith(".html"))) {
      const page = readFileSync(join(APP, "public", file), "utf8");
      if (!page.includes("settings.js?v=")) continue;
      for (const ref of readAssetReferences(page, "settings.js")) expect(ref.url).toBe(url);
    }
  });
});
