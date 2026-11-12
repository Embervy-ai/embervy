import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeStrings, t as translate } from "./strings";

// settings.js: the model section. A Brain house ({substrate:"brain"} from
// /api/gpt-model) must get no GPT/backend switcher — one line from en.json says
// that heads and models are switched inside Brain. The section's code is the
// last statement of public/settings.js; it is run here against a tiny fake DOM.

const APP = import.meta.dir;
const SOURCE = readFileSync(join(APP, "public", "settings.js"), "utf8");
const EN = JSON.parse(readFileSync(join(APP, "strings", "en.json"), "utf8"));
const strings = mergeStrings(EN, undefined).strings;
const t = (key: string, vars?: Record<string, string | number>) => translate(strings, key, vars);

class FakeElement {
  classes: Set<string>;
  textContent = "";
  listeners: Record<string, Function[]> = {};
  constructor(classes: string[] = [], public children: Record<string, FakeElement> = {}) { this.classes = new Set(classes); }
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    toggle: (c: string, on?: boolean) => { if (on === undefined ? !this.classes.has(c) : on) this.classes.add(c); else this.classes.delete(c); },
  };
  querySelector(sel: string) { return this.children[sel] ?? null; }
  addEventListener(name: string, fn: Function) { (this.listeners[name] ??= []).push(fn); }
  get hidden() { return this.classes.has("hidden"); }
  dataset: Record<string, string> = {};
}

async function runModelSection(gptModel: unknown | "throw") {
  const start = SOURCE.indexOf("(async function setupModelSwitcher()");
  expect(start).toBeGreaterThan(-1);
  const code = SOURCE.slice(start).trim();
  expect(code.endsWith("})();")).toBe(true); // the last statement — nothing after it is cut off

  const field = new FakeElement();
  const section = new FakeElement(["settings-section", "hidden"], { ".field": field });
  const hint = new FakeElement(["hint"]);
  const buttons = ["terra", "luna", "sol"].map((model) => Object.assign(new FakeElement(), { dataset: { model } }));
  const fetched: string[] = [];
  const queried: string[] = [];
  const document = {
    getElementById: (id: string) => ({ "model-section": section, "model-hint": hint } as Record<string, FakeElement>)[id] ?? null,
    querySelectorAll: (sel: string) => { queried.push(sel); return buttons; },
  };
  const fetchFake = async (url: string, init?: { method?: string }) => {
    fetched.push(`${init?.method ?? "GET"} ${url}`);
    if (gptModel === "throw") throw new Error("offline");
    return { json: async () => gptModel };
  };
  const run = new Function("document", "fetch", "t", "setTimeout", `return ${code}`);
  await run(document, fetchFake, t, (fn: Function) => fn());
  return { section, field, hint, buttons, fetched, queried };
}

describe("settings.js model section", () => {
  test("substrate brain: no switcher, one line from en.json, no adapter or /model traffic", async () => {
    const r = await runModelSection({ substrate: "brain" });
    expect(r.section.hidden).toBe(false); // the section shows…
    expect(r.field.hidden).toBe(true); // …but the label + the Terra/Luna/Sol buttons are hidden
    expect(r.hint.textContent).toBe(EN["settings.model.brain"]);
    expect(r.hint.textContent).toContain("inside Brain");
    expect(r.queried).toEqual([]); // the buttons were never even looked up
    expect(r.buttons.every((b) => Object.keys(b.listeners).length === 0)).toBe(true); // no click handler
    expect(r.fetched).toEqual(["GET /api/gpt-model"]); // and nothing was sent through /api/message
  });

  test("substrate gpt: the switcher shows as before", async () => {
    const r = await runModelSection({ substrate: "gpt", model: "gpt-5.6-terra" });
    expect(r.section.hidden).toBe(false);
    expect(r.field.hidden).toBe(false);
    expect(r.hint.textContent).toBe("Current: gpt-5.6-terra");
    expect(r.buttons.every((b) => (b.listeners.click ?? []).length === 1)).toBe(true);
  });

  test("any other substrate, or an unreachable server: the section stays hidden", async () => {
    for (const info of [{ substrate: "claude" }, { substrate: "glm" }, null, "throw" as const]) {
      const r = await runModelSection(info);
      expect(r.section.hidden).toBe(true);
      expect(r.hint.textContent).toBe("");
    }
  });
});
