import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const source = read("public/app.js");
const html = read("public/index.html");
const css = read("public/style.css");
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  expect(a).toBeGreaterThan(-1);
  expect(b).toBeGreaterThan(a);
  return source.slice(a, b);
}

test("the header bookmark opens a named native dialog with translated controls", () => {
  expect(html).not.toContain('id="side-menu"');
  expect(source + css).not.toContain('side-menu');
  expect(html).toContain('id="kept-btn"');
  expect(html).toContain('aria-controls="kept-dialog"');
  expect(html).toContain('<dialog id="kept-dialog" aria-labelledby="kept-title">');
  expect(html).toContain('id="kept-title" data-i18n="kept.title"');
  expect(html).toContain('id="kept-status" role="status"');
  expect(source).toContain('keptDialog.showModal()');
  expect(source).toContain('keptDialog.close()');
  expect(source).toContain('audio.pause()');
  expect(source).toContain('document.getElementById("kept-btn")?.focus()');
});

test("text and voice bubbles expose keyboard actions in addition to long press and right click", () => {
  for (const [start, end] of [["  function addMessage(", "  function addVoiceMessage("], ["  function addVoiceMessage(", "  function formatDuration("]]) {
    const code = section(start, end);
    expect(code).toContain('addKeptActions(div, msgId)');
    expect(code).toContain('"contextmenu"');
    expect(code).toContain('"touchstart"');
  }
  const picker = section("  function showEmojiPicker(", "  window.sendReaction =");
  expect(picker).toContain('toggleKept(msgId)');
  expect(picker).toContain('t("kept.remove")');
  expect(picker).toContain('t("kept.keep")');
  expect(picker).toContain('event.key === "Escape"');
  expect(picker).toContain('firstButton?.focus?.()');
  expect(source).toContain('button.setAttribute("aria-label", t("kept.actions"))');
  expect(css).toContain('.message-actions:focus-visible');
  expect(css).toContain('color: inherit');
  expect(css).toContain('100dvh');
});

test("house question bubbles cannot acquire message actions or a picker, even with a supplied message ID", () => {
  const shell = section("  function createMessageBubble(", "  function addMessage(");
  const questions = section("  function updateHouseQuestion(", "  setInterval(() => {");
  // Registration stays in addMessage/addVoiceMessage, never in the shared visual shell.
  expect(shell + questions).not.toMatch(/addKeptActions|addEventListener|showEmojiPicker|data-msg-id|reaction-display/);
  expect(questions).toContain('createMessageBubble("assistant",');
  expect(section("  function addMessage(", "  function addVoiceMessage(")).toContain('pressTimer = setTimeout(() => showEmojiPicker(div, msgId), 500)');
  const bubble = { querySelector(selector: string) { expect(selector).toBe("[data-house-question]"); return {}; } };
  const api = new Function(
    section("  function addKeptActions(", "  async function keptRequest(") +
    section("  function showEmojiPicker(", "  window.sendReaction =") +
    "return { addKeptActions, showEmojiPicker };")();
  // Without the early guards either function would try to build controls and fail here.
  expect(() => api.addKeptActions(bubble, "not-a-message")).not.toThrow();
  expect(() => api.showEmojiPicker(bubble, "not-a-message")).not.toThrow();
  const copy = section("  window.copyMessage =", "  window.enableSelect =");
  expect(copy).toContain('document.querySelector(`[data-msg-id="${msgId}"]`)');
  expect(copy).toContain('if (!div) return;');
});

// Inspect declarations per selector, rather than accepting a property elsewhere in CSS.
const cssRules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
function declarations(selector: string) {
  const matches = cssRules.filter(([, selectors]) => selectors.split(",").some(s => s.trim() === selector));
  expect(matches.length).toBeGreaterThan(0);
  return Object.fromEntries(matches.flatMap(([, , body]) => body.split(";").filter(d => d.trim()).map(d => {
    const colon = d.indexOf(":");
    return [d.slice(0, colon).trim(), d.slice(colon + 1).trim()];
  })));
}

test("the bookmark is next to Notes, with native keyboard activation and room to wrap", () => {
  const header = html.slice(html.indexOf('<header id="header">'), html.indexOf('</header>'));
  expect(header).toMatch(/^<header id="header">\s*<h1>/);
  const button = header.match(/<button id="kept-btn"[\s\S]*?<\/button>/)![0];
  expect(button).toContain('type="button"');
  expect(button).toContain('aria-label="Kept"');
  expect(button).toContain('title="Kept"');
  expect(button).toContain('data-i18n-aria-label="kept.title"');
  expect(button).toContain('data-i18n-title="kept.title"');
  expect(button).toContain('aria-hidden="true"');
  expect(button).toContain('<path d="M5 2h14v20l-7-5-7 5z"/>');
  expect(button).toContain('width="20" height="20"');
  expect(button).toContain('stroke-width="2"');
  expect(button).not.toMatch(/tabindex|disabled|hidden(?!=)|onkeydown|🔖/);
  expect(header.slice(header.indexOf(button) + button.length)).toMatch(/^\s*<button id="notes-btn"/);
  // Native buttons supply Tab, Enter and Space without custom key interception.
  expect(source).toContain('document.getElementById("kept-btn")?.addEventListener("click", openKept)');
  expect(declarations("#kept-btn")).toEqual(declarations("#notes-btn"));
  expect(declarations("#kept-btn")).toMatchObject({ "min-width": "44px", "min-height": "44px", "flex-shrink": "0" });
  expect(declarations("#kept-btn:focus-visible")).toEqual(declarations("#notes-btn:focus-visible"));
  expect(declarations("#kept-btn:focus-visible")).toMatchObject({ outline: "2px solid currentColor", "outline-offset": "2px" });
  expect(declarations("header")).toMatchObject({ display: "flex", "flex-wrap": "wrap" });
  // No fixed header height, clipping or absolute button placement to defeat wrapping.
  expect(declarations("header").height).toBeUndefined();
  expect(declarations("header").overflow).toBeUndefined();
  expect(declarations("#kept-btn").position).toBeUndefined();
});

test("one polite confirmation overlays the composer, replaces its predecessor and expires after two seconds", () => {
  const nodes: any[] = [], frames = new Map<number, () => void>(), timers = new Map<number, { callback: () => void, ms: number }>();
  let next = 0, composerTop = 600, resized!: () => void;
  const composer = { getBoundingClientRect: () => ({ top: composerTop }) };
  const document = {
    createElement: () => ({ className: "", textContent: "", style: {} as any, attributes: {} as any,
      setAttribute(key: string, value: string) { this.attributes[key] = value; } }),
    body: { appendChild: (node: any) => nodes.push(node) },
    getElementById: (id: string) => { expect(id).toBe("input-area"); return composer; },
  };
  class Observer {
    constructor(callback: () => void) { resized = callback; }
    observe(target: any) { expect(target).toBe(composer); }
  }
  const run = new Function("document", "window", "ResizeObserver", "requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout", `
    ${section('  // Keep an empty live region', '  const keptDialog =')}
    return { showConfirmation, clearConfirmation };
  `)(document, { addEventListener() {} }, Observer,
    (callback: () => void) => { frames.set(++next, callback); return next; }, (id: number) => frames.delete(id),
    (callback: () => void, ms: number) => { timers.set(++next, { callback, ms }); return next; }, (id: number) => timers.delete(id));
  const paint = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback()); };
  expect(nodes).toHaveLength(1);
  const node = nodes[0];
  expect(node.attributes).toEqual({ role: "status", "aria-live": "polite", "aria-atomic": "true" });
  expect(node.textContent).toBe("");
  run.showConfirmation("Message kept.");
  paint();
  expect(node.textContent).toBe("Message kept.");
  expect(node.style.top).toBe("592px");
  composerTop = 420;
  resized();
  expect(node.style.top).toBe("412px");
  run.showConfirmation("Removed from Kept.");
  run.showConfirmation("Message kept.");
  expect(frames.size).toBe(1);
  expect(timers.size).toBe(0);
  expect(node.textContent).toBe("");
  paint();
  expect(nodes).toHaveLength(1);
  expect(node.textContent).toBe("Message kept.");
  expect(timers.size).toBe(1);
  const timer = [...timers.values()][0];
  expect(timer.ms).toBe(2000);
  timer.callback();
  expect(node.textContent).toBe("");
  expect(timers.size).toBe(0);
  run.showConfirmation("Cancelled before paint");
  run.clearConfirmation();
  paint();
  expect(node.textContent).toBe("");
  expect(declarations(".confirmation-status")).toMatchObject({
    position: "fixed", "pointer-events": "none", background: "var(--bg)", color: "var(--text)",
    animation: "none", transition: "none", "max-width": "calc(100% - 32px)",
  });
});

test("opening and closing Kept moves the same live region into and out of the modal and restores focus", async () => {
  const listeners: Record<string, Record<string, () => any>> = {};
  const status = {}, parents: string[] = [];
  let focused = "", cleared = 0;
  const control = (id: string) => ({
    addEventListener: (event: string, callback: () => any) => { (listeners[id] ||= {})[event] = callback; },
    focus: () => { focused = id; },
  });
  const dialog = { ...control("dialog"), open: false,
    showModal() { this.open = true; }, close() { this.open = false; listeners.dialog.close(); },
    appendChild(node: any) { expect(node).toBe(status); parents.push("dialog"); },
  };
  new Function("document", "keptDialog", "keptStatus", "keptBody", "confirmationStatus", "clearKeptBody", "loadKept", "renderKeptList", "t", `
    ${section('  async function openKept(', '  function showEmojiPicker(')}
  `)({ getElementById: control, body: { appendChild(node: any) { expect(node).toBe(status); parents.push("body"); } } },
    dialog, {}, {}, status, () => { cleared++; }, async () => {}, () => {}, (key: string) => key);
  await listeners["kept-btn"].click();
  expect(dialog.open).toBe(true);
  expect(parents).toEqual(["dialog"]);
  listeners["kept-close"].click();
  expect(dialog.open).toBe(false);
  expect(parents).toEqual(["dialog", "body"]);
  expect(focused).toBe("kept-btn");
  expect(cleared).toBe(2);
  // Native Escape dismissal emits the same close event.
  focused = "";
  listeners.dialog.close();
  expect(focused).toBe("kept-btn");
});

test("unfocused message actions are visually clipped and reserve no layout space", () => {
  const base = declarations(".message .message-actions");
  expect(base).toMatchObject({
    position: "absolute", width: "1px", height: "1px",
    "min-width": "0", "min-height": "0", padding: "0", margin: "-1px",
    overflow: "hidden", clip: "rect(0, 0, 0, 0)", "clip-path": "inset(50%)",
    "white-space": "nowrap", border: "0",
  });
  const actionRules = cssRules.filter(([, selectors]) => selectors.includes(".message-actions"));
  for (const [, selectors, body] of actionRules) {
    expect(body).not.toMatch(/display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)/i);
    // No hover, ordinary focus, or parent focus-within reveal on touch.
    for (const selector of selectors.split(",").filter(s => s.includes(".message-actions"))) {
      expect([".message .message-actions", ".message .message-actions:focus-visible", ".message-actions:focus-visible"]).toContain(selector.trim());
    }
  }
});

test("keyboard-visible actions overlay both bubble types with a 44px target and focus ring", () => {
  const base = declarations(".message .message-actions");
  const focused = declarations(".message .message-actions:focus-visible");
  expect(focused).toMatchObject({
    position: "absolute", width: "44px", height: "44px",
    "min-width": "44px", "min-height": "44px", margin: "0",
    clip: "auto", "clip-path": "none", overflow: "visible", "white-space": "normal",
    background: "var(--bg)", color: "var(--text)",
  });
  expect(base.top).toBe("4px");
  expect(base.right).toBe("4px");
  expect(Number(focused["z-index"])).toBeGreaterThan(0);
  expect(declarations(".message-actions:focus-visible")).toMatchObject({ outline: "2px solid currentColor", "outline-offset": "2px" });
  expect(declarations(".message").position).toBe("relative");
  expect(declarations(".voice-message").position).toBeUndefined();
  expect(section("  function createMessageBubble(", "  function addMessage(")).toContain('div.className = `message ${role}`');
  expect(section("  function addMessage(", "  function addVoiceMessage(")).toContain('const div = createMessageBubble(role,');
  expect(section("  function addVoiceMessage(", "  function formatDuration(")).toContain('div.className = `message ${role} voice-message`');
});

test("actions remain a named native button with default keyboard activation and Escape focus return", () => {
  const helper = section("  function keptButton(", "  function paintKeptMarker(");
  const actions = section("  function addKeptActions(", "  async function keptRequest(");
  expect(helper).toContain('document.createElement("button")');
  expect(helper).toContain('button.type = "button"');
  expect(helper).toContain('button.addEventListener("click", action)');
  expect(actions).toContain('keptButton("⋯", () => showEmojiPicker(div, msgId))');
  expect(actions).toContain('button.setAttribute("aria-label", t("kept.actions"))');
  expect(actions).toContain('div.appendChild(button)');
  expect(helper + actions).not.toMatch(/tabIndex|tabindex|aria-hidden|disabled|\.hidden/);
  expect(section("  function showEmojiPicker(", "  window.sendReaction =")).toContain('if (event.key === "Escape") { picker.remove(); msgEl.querySelector(".message-actions")?.focus(); }');
  for (const [start, end] of [["  function messageSnippet(", "  window.startReply ="], ["  function messageSnippetFull(", "  // Copy through the picker:"]]) {
    expect(section(start, end)).toContain('.msg-quote, .kept-marker, .message-actions").forEach(el => el.remove())');
  }
});

test("the detail view uses chat Markdown and the existing copy handler without live message IDs", () => {
  const detail = section("  function renderKeptEntry(", "  async function removeKept(");
  expect(detail).toContain('content.innerHTML = renderMarkdown(entry.text)');
  expect(detail).toContain('copy._copyText = entry.text');
  expect(detail).toContain('copyButton.className = "copybox-btn"');
  expect(source).toContain('btn.closest("#messages, #kept-dialog")');
  expect(source).toContain('(btn.closest("dialog") || document.body).appendChild(area)');
  expect(detail).not.toContain('data-msg-id');
  expect(detail).toContain('audio.controls = true');
  expect(detail).toContain('audio.preload = "none"');
  expect(detail).toContain('t("kept.audioMissing")');
  expect(detail).toContain('t("kept.addedByAgent")');
  const list = section("  function renderKeptList(", "  function renderKeptEntry(");
  expect(list).toContain('preview.textContent = entry.text');
  expect(list).toContain('t("kept.empty")');
  expect(list).toContain('t("kept.addedByAgent")');
  expect(css).toContain('-webkit-line-clamp: 3');
  expect(source.match(/\.msg-quote, \.kept-marker, \.message-actions/g)).toHaveLength(2);
});

function mutations(entries: any[] = [], confirm = true, fail = false, hooks: {
  request?: () => Promise<void>, load?: (count: number) => Promise<void>, open?: boolean,
} = {}) {
  const calls: any[] = [], alerts: string[] = [], confirmations: string[] = [], notices: string[] = [];
  let loads = 0, renders = 0, clears = 0;
  const code = section("  async function removeKept(", "  async function openKept(");
  const run = new Function("window", "document", "t", "keptRequest", "loadKept", "initial", "showConfirmation", "clearConfirmation", "keptDialog", "renderKeptList", `
    let keptBusy = false, keptEntries = initial;
    const keptBody = { querySelector: () => null };
    ${code}
    return { toggleKept, removeKept };
  `)({ confirm: (text: string) => { confirmations.push(text); return confirm; }, alert: (text: string) => alerts.push(text) },
    { querySelector: () => null }, (key: string) => key,
    async (path: string, options: any) => { calls.push({ path, ...options }); if (fail) throw new Error("kept.storage"); await hooks.request?.(); },
    async () => { loads++; await hooks.load?.(loads); }, entries,
    (text: string) => notices.push(text), () => { clears++; }, { open: hooks.open ?? false }, () => { renders++; });
  return { run, calls, alerts, confirmations, notices, get loads() { return loads; }, get renders() { return renders; }, get clears() { return clears; } };
}

test("keeping sends only the source ID, and failures are visible instead of optimistic markers", async () => {
  const h = mutations();
  await h.run.toggleKept("message-1");
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0].path).toBe("/api/kept");
  expect(JSON.parse(h.calls[0].body)).toEqual({ message_id: "message-1" });
  const broken = mutations([], true, true);
  await broken.run.toggleKept("message-1");
  expect(broken.alerts).toEqual(["kept.storage"]);
});

test("toggling a kept bubble removes exactly its entry after confirmation", async () => {
  const entries = [{ id: "kept-1", message_id: "message-1" }, { id: "kept-2", message_id: "message-2" }];
  const h = mutations(entries);
  await h.run.toggleKept("message-1");
  expect(h.calls).toEqual([{ path: "/api/kept/kept-1", method: "DELETE" }]);
  expect(h.confirmations).toEqual(["kept.confirm"]);
  const cancelled = mutations(entries, false);
  await cancelled.run.toggleKept("message-1");
  expect(cancelled.calls).toEqual([]);
  await cancelled.run.removeKept(entries[1]);
  expect(cancelled.calls).toEqual([]);
});

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test("saving confirms only after both the mutation and the list reload succeed", async () => {
  const request = deferred(), reload = deferred();
  const h = mutations([], true, false, { request: () => request.promise, load: n => n === 2 ? reload.promise : Promise.resolve() });
  const pending = h.run.toggleKept("message-1");
  expect(h.notices).toEqual([]);
  await flush();
  expect(h.loads).toBe(1);
  expect(h.calls).toHaveLength(1);
  expect(h.notices).toEqual([]);
  await h.run.toggleKept("message-2"); // An in-flight operation cannot start a second request.
  expect(h.calls).toHaveLength(1);
  request.resolve();
  await flush();
  expect(h.loads).toBe(2);
  expect(h.notices).toEqual([]);
  reload.resolve();
  await pending;
  expect(h.notices).toEqual(["kept.saved"]);
  expect(h.alerts).toEqual([]);
  expect(h.clears).toBe(1);
});

test("both removal paths confirm only after DELETE and reload", async () => {
  const entry = { id: "kept-1", message_id: "message-1" };
  for (const fromDialog of [false, true]) {
    const request = deferred(), reload = deferred();
    const h = mutations([entry], true, false, {
      open: fromDialog, request: () => request.promise,
      load: n => n === (fromDialog ? 1 : 2) ? reload.promise : Promise.resolve(),
    });
    const pending = fromDialog ? h.run.removeKept(entry) : h.run.toggleKept(entry.message_id);
    await flush();
    expect(h.calls).toEqual([{ path: "/api/kept/kept-1", method: "DELETE" }]);
    expect(h.notices).toEqual([]);
    request.resolve();
    await flush();
    expect(h.loads).toBe(fromDialog ? 1 : 2);
    expect(h.notices).toEqual([]);
    reload.resolve();
    await pending;
    expect(h.notices).toEqual(["kept.removed"]);
    expect(h.renders).toBe(fromDialog ? 1 : 0);
    expect(h.alerts).toEqual([]);
  }
});

test("request, preflight and reload failures alert without a success confirmation", async () => {
  const entry = { id: "kept-1", message_id: "message-1" };
  for (const remove of [false, true]) {
    for (const stage of ["request", "reload", "preflight"]) {
      const h = mutations(remove ? [entry] : [], true, stage === "request", {
        open: remove,
        load: async n => {
          if (stage === "preflight" || (stage === "reload" && n === (remove ? 1 : 2))) throw new Error("reload failed");
        },
      });
      await (remove ? h.run.removeKept(entry) : h.run.toggleKept(entry.message_id));
      expect(h.alerts).toEqual([stage === "request" ? "kept.storage" : "reload failed"]);
      expect(h.notices).toEqual([]);
      expect(h.renders).toBe(0);
    }
  }
  const cancelled = mutations([entry], false);
  await cancelled.run.removeKept(entry);
  await cancelled.run.toggleKept(entry.message_id);
  expect(cancelled.notices).toEqual([]);
});

test("all Kept texts are present in every shipped language file", () => {
  const en = JSON.parse(read("strings/en.json"));
  const keys = Object.keys(en).filter(key => key.startsWith("kept."));
  expect(keys.length).toBeGreaterThan(20);
  const combined = [source, html, read("server.ts"), read("mcp.ts")].join("\n");
  for (const key of new Set(combined.match(/kept\.[A-Za-z]+/g))) {
    if (["kept.json", "kept.ts"].includes(key)) continue;
    expect(typeof en[key]).toBe("string");
  }
  for (const file of readdirSync(join(import.meta.dir, "strings")).filter(file => file.endsWith(".json"))) {
    const table = JSON.parse(read(`strings/${file}`));
    for (const key of keys) expect(typeof table[key]).toBe("string");
    expect(table["kept.tool"]).toStartWith("Entries go into the person's Kept list in the app, not into the agent's memory.");
    expect(table["kept.tool"]).toContain("only when they ask");
    expect(table["kept.tool"]).toContain("unchanged");
    expect(table["kept.tool"]).toContain("only add entries, not read the list or remove anything");
  }
  expect(en["kept.tool"]).toContain("only when they ask");
  expect(en["kept.tool"]).toContain("unchanged");
});

test("changed assets have bumped version stamps and the implementation parses", () => {
  expect(readAssetStamp(html, "app.js")).toBeGreaterThan(141);
  const styleStamp = readAssetUrl(html, "style.css");
  expect(readAssetStamp(html, "style.css")).toBeGreaterThan(126);
  expect(readAssetUrl(read("public/settings.html"), "style.css")).toBe(styleStamp);
  const worker = read("public/sw.js");
  expect(readAssetUrl(worker, "style.css")).toBe(styleStamp);
  expect(readAssetUrl(worker, "app.js")).toBe(readAssetUrl(html, "app.js"));
  expect(readCacheNumber(worker)).toBeGreaterThan(60);
  expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(source)).not.toThrow();
  for (const path of ["kept.ts", "server.ts", "mcp.ts", "kept-server.test.ts"]) {
    expect(() => new Bun.Transpiler({ loader: "ts" }).transformSync(read(path))).not.toThrow();
  }
});

test("Kept uses separate authentication gates and never forwards copies to the agent", () => {
  const server = read("server.ts");
  const gate = server.slice(server.indexOf('// Kept belongs'), server.indexOf('// This preference never'));
  expect(gate).toContain('if (!await isHumanSession(c))');
  expect(gate).toContain('bearerMatches');
  expect(gate).toContain('private, no-store');
  const routes = server.slice(server.indexOf('const keptStore ='), server.indexOf('app.get("/strings.js"'));
  expect(routes).not.toMatch(/appendToOutbox|appendFileSync|broadcastToClients|console\.|stderr/);
  expect(routes).toContain('visibleMessages().find');
  expect(routes).toContain('text: message.text');
  const mcp = read("mcp.ts");
  const addToKept = mcp.slice(mcp.indexOf('if (name === "add_to_kept")'), mcp.indexOf('if (name === "approval_settings")'));
  expect(addToKept).toContain('/api/internal/keep');
  expect(addToKept).not.toContain('/api/kept');
});
