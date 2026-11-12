import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");

class Element {
  children: Element[] = [];
  listeners: Record<string, Function> = {};
  hidden = true;
  textContent = "";
  value = "";
  className = "";
  style = {};
  options: Element[] = [];
  classList = { toggle() {}, add() {}, remove() {} };
  constructor(public id = "") {}
  append(...nodes: Element[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  addEventListener(event: string, fn: Function) { this.listeners[event] = fn; }
  setAttribute() {}
  focus() {}
}

async function menu(brain = false) {
  const ids = ["brain-menu-btn", "brain-menu-overlay", "brain-menu-body", "brain-menu-meta", "brain-menu-title", "brain-menu-close-btn", "model-toggle"];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  elements["model-toggle"].hidden = false;
  const calls: Array<{ path: string; body?: unknown }> = [];
  const bubbles: unknown[][] = [];
  const hiddenBeforeAnswer: boolean[] = [];
  const data = brain
    ? { current: { headLabel: "Claude", modelLabel: "Opus", supportsEffort: false }, heads: [], bridge: { mode: "turns", count: 40 } }
    : { restartOnly: true, current: { headLabel: "Claude Code", modelLabel: "" }, heads: [], bridge: { mode: "turns", count: 40 } };
  const fetch = async (path: string, init: any = {}) => {
    calls.push({ path, ...(init.body ? { body: JSON.parse(init.body) } : {}) });
    if (path === "/api/internal/model") return Response.json(brain ? { ok: true, substrate: "brain", switchable: false } : { ok: true, model: null });
    if (path === "/api/brain/heads") {
      hiddenBeforeAnswer.push(elements["brain-menu-btn"].hidden);
      return Response.json(data);
    }
    if (path === "/api/brain/command") return Response.json(brain ? { ok: true, command: "/respawn", id: "command-id", ts: "timestamp" } : { ok: true, mode: "respawn" }, { status: brain ? 200 : 202 });
    throw new Error(`unexpected request: ${path}`);
  };
  const start = source.indexOf("  // The Brain menu:");
  const end = source.indexOf("  const claudeAuthEl", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const run = new Function("document", "window", "fetch", "t", "addMessage", `
    let claudeAuthEnabled = false;
    ${source.slice(start, end)}
    return { syncModel, bmRestart, loadBrainMenu, authEnabled: () => claudeAuthEnabled };
  `);
  const controls = run({
    getElementById: (id: string) => elements[id] ?? null,
    createElement: () => new Element(),
    addEventListener() {},
  }, { confirm: () => true }, fetch, (key: string) => key, (...args: unknown[]) => bubbles.push(args));
  // syncModel starts during setup; await its model and capability requests.
  for (let i = 0; i < 20 && elements["brain-menu-btn"].hidden; i++) await Bun.sleep(1);
  return { controls, elements, calls, bubbles, hiddenBeforeAnswer };
}

function texts(element: Element): string[] {
  return [element.textContent, ...element.children.flatMap(texts)];
}

describe("app restart menu", () => {
  test("Claude Code keeps its model dropdown and exposes a restart-only menu", async () => {
    const m = await menu();
    expect(m.elements["brain-menu-btn"].hidden).toBe(false);
    expect(m.elements["model-toggle"].hidden).toBe(false);
    expect(m.controls.authEnabled()).toBe(true);
    expect(m.elements["brain-menu-meta"].textContent).toBe("Claude Code");
    const labels = texts(m.elements["brain-menu-body"]);
    expect(labels).toContain("brainMenu.restart");
    expect(labels).not.toContain("brainMenu.headsTitle");
    expect(labels).not.toContain("brainMenu.effort");
    await m.controls.bmRestart();
    expect(m.calls.filter(c => c.path === "/api/brain/command")).toEqual([{ path: "/api/brain/command", body: { action: "restart" } }]);
    expect(m.bubbles).toEqual([]);
  });

  test("Brain still hides the model dropdown and sends one restart command", async () => {
    const m = await menu(true);
    expect(m.elements["model-toggle"].hidden).toBe(true);
    expect(m.elements["brain-menu-btn"].hidden).toBe(false);
    await m.controls.bmRestart();
    expect(m.calls.filter(c => c.path === "/api/brain/command")).toHaveLength(1);
    // The button is a control: it leaves no command line in the person's name.
    expect(m.bubbles).toEqual([]);
  });

  test("the menu labels follow the answered harness without changing Brain labels", async () => {
    for (const brain of [false, true]) {
      const m = await menu(brain);
      expect(m.elements["brain-menu-btn"].textContent).toBe(brain ? "header.brain" : "header.claudeCode");
      expect(m.elements["brain-menu-title"].textContent).toBe(brain ? "brainMenu.title" : "brainMenu.claudeCode.title");
      if (!brain) expect(m.hiddenBeforeAnswer[0]).toBe(true);
      const pending = m.controls.loadBrainMenu();
      expect(m.elements["brain-menu-meta"].textContent).toBe(brain ? "brainMenu.refreshing" : "brainMenu.claudeCode.asking");
      await pending;
    }
    const strings = JSON.parse(readFileSync(join(import.meta.dir, "strings/en.json"), "utf8"));
    expect(strings["header.claudeCode"]).toBe("Claude Code ▾");
    expect(strings["brainMenu.claudeCode.title"]).toBe("Claude Code");
    expect(strings["brainMenu.claudeCode.asking"]).toBe("Asking Claude Code…");
  });

  test("the client and worker share the raised asset version", () => {
    const index = readFileSync(join(import.meta.dir, "public/index.html"), "utf8");
    const worker = readFileSync(join(import.meta.dir, "public/sw.js"), "utf8");
    const version = index.match(/app\.js\?v=(\d+)/)?.[1];
    expect(Number(version)).toBeGreaterThan(128);
    expect(worker).toContain(`/app.js?v=${version}`);
    expect(Number(worker.match(/embervy-v(\d+)/)?.[1])).toBeGreaterThan(44);
  });

  test("the complete client script parses", () => {
    expect(() => new Function(source)).not.toThrow();
  });
});
