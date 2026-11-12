import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Opening the terminal panel lands at the newest entry. This test slices the
// live-terminal part out of public/app.js (markers, as in ws-liveness.test.ts)
// and drives it against a small fake DOM: every line is 20 px high, the view
// 400 px, and scrollTop is clamped the way a browser clamps it. Scroll events
// are fired by the test where a browser would fire them.
//
// Run against another version of the file:
//   TERMINAL_APP_JS=path/to/app.js bun test terminal-open

const SOURCE = readFileSync(process.env.TERMINAL_APP_JS ?? join(import.meta.dir, "public", "app.js"), "utf8");
const EN = JSON.parse(readFileSync(join(import.meta.dir, "strings", "en.json"), "utf8")) as Record<string, string>;

function slice(start: string, end: string): string {
  const a = SOURCE.indexOf(start);
  const b = a < 0 ? -1 : SOURCE.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error(`marker not found in app.js: ${a < 0 ? start : end}`);
  return SOURCE.slice(a, b);
}

const TERMINAL_PART = slice("  const terminalBtn = document.getElementById(\"terminal-btn\");", "  async function setupPush() {");
const LINE = 20;
const VIEW = 400;

class FakeNode {
  tagName: string;
  className = "";
  innerHTML = "";
  textContent = "";
  open = false;
  hidden = false;
  readOnly = false;
  value = "";
  dataset: Record<string, string> = {};
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  private listeners: Record<string, ((e: any) => void)[]> = {};
  private classes = new Set<string>();
  classList = {
    add: (c: string) => { this.classes.add(c); },
    remove: (c: string) => { this.classes.delete(c); },
    toggle: (c: string, on?: boolean) => { if (on ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); },
    contains: (c: string) => this.classes.has(c),
  };
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  private take(nodes: FakeNode[]): FakeNode[] {
    const out: FakeNode[] = [];
    for (const n of nodes) {
      if (n.tagName === "#FRAGMENT") { out.push(...n.children); n.children = []; }
      else out.push(n);
    }
    for (const n of out) {
      if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n);
      n.parent = this;
    }
    return out;
  }
  appendChild(n: FakeNode) { this.children.push(...this.take([n])); return n; }
  append(...nodes: FakeNode[]) { this.children.push(...this.take(nodes)); }
  prepend(...nodes: FakeNode[]) { this.children.unshift(...this.take(nodes)); }
  replaceChildren(...nodes: FakeNode[]) {
    for (const c of this.children) c.parent = null;
    this.children = [];
    this.append(...nodes);
  }
  querySelector(sel: string): FakeNode | null {
    const match = (n: FakeNode) => sel.startsWith(".") ? n.className.split(" ").includes(sel.slice(1)) : n.tagName === sel.toUpperCase();
    for (const c of this.children) {
      if (match(c)) return c;
      const deeper = c.querySelector(sel);
      if (deeper) return deeper;
    }
    return null;
  }
  querySelectorAll(_sel: string): FakeNode[] { return []; }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  fire(type: string, e: any = {}) { for (const fn of this.listeners[type] ?? []) fn({ target: this, ...e }); }
  /** Lines (and closed tool steps) are one line high; containers are their children. */
  get height(): number {
    if (this.className === "terminal-line" || this.tagName === "DETAILS") return LINE;
    return this.children.reduce((sum, c) => sum + c.height, 0);
  }
  lines(): string[] {
    if (this.className === "terminal-line") return [this.innerHTML];
    return this.children.flatMap((c) => c.lines());
  }
}

class FakeScroll extends FakeNode {
  clientHeight = VIEW;
  /** Layout that settles after a frame (a panel still sliding in), without a scroll event. */
  late = 0;
  private top = 0;
  constructor(private output: FakeNode) { super("div"); }
  get scrollHeight() { return Math.max(VIEW, LINE + this.output.height + this.late); }
  get scrollTop() { return Math.min(this.top, this.scrollHeight - VIEW); }
  set scrollTop(v: number) { this.top = Math.max(0, Math.min(v, this.scrollHeight - VIEW)); }
  get atNewest() { return this.scrollTop === this.scrollHeight - VIEW; }
}

const items = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ key: `k${from + i}`, html: `line ${from + i}` }));

function harness() {
  const output = new FakeNode("pre");
  const scroll = new FakeScroll(output);
  const panel = new FakeNode("div");
  const elements: Record<string, FakeNode> = {
    "terminal-panel": panel,
    "terminal-scroll": scroll,
    "terminal-output": output,
  };
  const byId = (id: string) => elements[id] ??= new FakeNode("div");
  const document = {
    getElementById: byId,
    createElement: (tag: string) => new FakeNode(tag),
    createDocumentFragment: () => new FakeNode("#fragment"),
    addEventListener: () => {},
    body: new FakeNode("body"),
  };
  const sent: any[] = [];
  const ws = { readyState: 1, send: (data: string) => sent.push(JSON.parse(data)) };
  const fetches: { url: string; resolve: (data: unknown) => void }[] = [];
  const fetch = (url: string) => new Promise((resolve) => {
    fetches.push({ url, resolve: (data) => resolve({ ok: true, json: async () => data }) });
  });
  let frames: (() => void)[] = [];
  const requestAnimationFrame = (fn: () => void) => { frames.push(fn); return frames.length; };
  const t = (key: string) => {
    if (!(key in EN)) throw new Error(`unknown string key: ${key}`);
    return EN[key];
  };

  const body = `"use strict";
    let ws = env.ws;
    ${TERMINAL_PART}
    return { openTerminal, closeTerminal, renderTerminalFrame };`;
  const app = new Function(
    "env", "WebSocket", "document", "fetch", "requestAnimationFrame", "setTimeout", "setInterval", "t", "terminalPanelEnabled", "console",
    body,
  )(
    { ws }, { OPEN: 1 }, document, fetch, requestAnimationFrame, () => 0, () => 0, t, () => true, { warn: () => {}, log: () => {} },
  ) as { openTerminal: () => void; closeTerminal: () => void; renderTerminalFrame: (msg: unknown) => void };

  const frame = (tail: { html: string }[]) => app.renderTerminalFrame({ type: "terminal-frame", mode: "log", items: tail, tail_count: tail.length, ts: new Date().toISOString() });
  const paint = () => { const due = frames; frames = []; for (const fn of due) fn(); };
  /** The reader drags the view to a position; the browser reports the scroll. */
  const readTo = (top: number) => { scroll.fire("touchstart"); scroll.scrollTop = top; scroll.fire("scroll"); };
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { app, output, scroll, panel, sent, fetches, frame, paint, readTo, settle };
}

describe("opening the terminal panel", () => {
  test("a second look loads the newest entries once, not again as older output", async () => {
    const h = harness();
    h.app.openTerminal();
    h.frame(items(450, 600));
    expect(h.scroll.atNewest).toBe(true);
    h.readTo(h.scroll.scrollTop - 500);
    h.app.closeTerminal();

    h.app.openTerminal();
    // The emptied view clamps to the top; the browser reports that as a scroll.
    h.scroll.fire("scroll");
    expect(h.fetches.length).toBe(0);
    h.frame(items(450, 600));
    expect(h.output.lines().length).toBe(150);
    expect(h.scroll.atNewest).toBe(true);

    // Older output still pages in behind the live part.
    h.readTo(0);
    expect(h.fetches.length).toBe(1);
    // Older pages hang on the oldest entry shown, not on a distance from the end.
    expect(h.fetches[0]!.url).toContain("before=k450");
    h.fetches[0]!.resolve({ lines: items(250, 450), nextBefore: "k250", nextOffset: null });
    await h.settle();
    expect(h.output.lines()).toEqual(items(250, 600).map((i) => i.html));
  });

  test("a page of older output asked for in an earlier look is dropped", async () => {
    const h = harness();
    h.app.openTerminal();
    h.frame(items(450, 600));
    h.readTo(0);
    expect(h.fetches.length).toBe(1);
    h.app.closeTerminal();
    h.app.openTerminal();
    h.frame(items(450, 600));
    h.fetches[0]!.resolve({ lines: items(250, 450), nextBefore: "k250", nextOffset: null });
    await h.settle();
    expect(h.output.lines()).toEqual(items(450, 600).map((i) => i.html));
    expect(h.scroll.atNewest).toBe(true);
  });

  test("layout that settles after the first frame is followed down until the reader touches the view", () => {
    const h = harness();
    h.app.openTerminal();
    h.frame(items(450, 600));
    expect(h.scroll.atNewest).toBe(true);
    // The panel is still sliding in: the content grows, no scroll event, no new frame.
    h.scroll.late = 300;
    expect(h.scroll.atNewest).toBe(false);
    h.paint();
    expect(h.scroll.atNewest).toBe(true);
    h.scroll.late = 600;
    h.panel.fire("transitionend");
    expect(h.scroll.atNewest).toBe(true);

    // Once the reader has touched the view, it stays where they put it.
    h.readTo(1000);
    h.scroll.late = 900;
    h.panel.fire("transitionend");
    expect(h.scroll.scrollTop).toBe(1000);
  });
});
