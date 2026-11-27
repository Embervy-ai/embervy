import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");
function section(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  if (a < 0 || b <= a) throw new Error(`Missing source section: ${start}`);
  return source.slice(a, b);
}
const helperSource = section("  async function copyPlainText(", "  const messagesEl =");

type Options = {
  command?: "success" | "false" | "throw" | "missing";
  clipboard?: "success" | "reject" | "throw" | "missing" | "no-method";
  selectionThrows?: boolean;
  noFocus?: boolean;
  focusThrows?: boolean;
};
function harness(options: Options = {}) {
  const events: string[] = [];
  const writes: string[] = [];
  const fields: any[] = [];
  const snapshots: any[] = [];
  const body = { appendChild(area: any) { events.push("body"); area.parent = body; } };
  const host = { appendChild(area: any) { events.push("host"); area.parent = host; } };
  const previousFocus = {
    focus(focusOptions: any) {
      events.push("focus");
      snapshots.push({ focusOptions });
      if (options.focusThrows) throw new Error("Focus unavailable");
      document.activeElement = previousFocus;
    },
  };
  const document: any = {
    body,
    activeElement: options.noFocus ? null : previousFocus,
    createElement(tag: string) {
      const area: any = {
        tag, value: "", style: {}, attributes: {}, parent: null, removed: false,
        setAttribute(name: string, value: string) { this.attributes[name] = value; },
        select() {
          events.push("select");
          document.activeElement = this;
          if (options.selectionThrows) throw new Error("Selection unavailable");
        },
        setSelectionRange(start: number, end: number) { events.push("range"); this.range = [start, end]; },
        remove() { events.push("remove"); this.removed = true; this.parent = null; },
      };
      fields.push(area);
      return area;
    },
  };
  if (options.command !== "missing") document.execCommand = (command: string) => {
    events.push(command);
    const area = fields.at(-1);
    snapshots.push({ value: area.value, attributes: { ...area.attributes }, range: area.range, parent: area.parent });
    if (options.command === "throw") throw new Error("Copy unavailable");
    return options.command !== "false";
  };
  const navigator: any = {};
  if (options.clipboard !== "missing") navigator.clipboard = options.clipboard === "no-method" ? {} : {
    writeText(text: string) {
      events.push("writeText");
      writes.push(text);
      if (options.clipboard === "throw") throw new Error("Clipboard unavailable");
      return options.clipboard === "reject" ? Promise.reject(new Error("Permission denied")) : Promise.resolve();
    },
  };
  const copy = new Function("document", "navigator", `${helperSource}\nreturn copyPlainText;`)(document, navigator) as
    (text: string, host?: unknown) => Promise<boolean>;
  return { copy, document, previousFocus, host, body, events, writes, fields, snapshots };
}

for (const text of ["Subject: a b", "Objet : café – naïve …\nSalut 👋", "  plain text\n", ""]) {
  for (const inDialog of [false, true]) {
    test(`selected field preserves ${JSON.stringify(text)} in ${inDialog ? "dialog" : "body"}`, async () => {
      const h = harness();
      const result = h.copy(text, inDialog ? h.host : undefined);
      expect(result).toBeInstanceOf(Promise);
      expect(await result).toBe(true);
      expect(h.writes).toEqual([]);
      expect(h.snapshots[0]).toEqual({ value: text, attributes: { readonly: "" }, range: [0, text.length], parent: inDialog ? h.host : h.body });
      expect(h.fields[0].tag).toBe("textarea");
      expect(h.fields[0].style.cssText).toContain("position:fixed");
      expect(h.fields[0].style.cssText).toContain("opacity:0");
      expect(h.events).toEqual([inDialog ? "host" : "body", "select", "range", "copy", "remove", "focus"]);
      expect(h.fields[0].removed).toBe(true);
      expect(h.fields[0].parent).toBeNull();
      expect(h.document.activeElement).toBe(h.previousFocus);
      expect(h.snapshots.at(-1)).toEqual({ focusOptions: { preventScroll: true } });
    });
  }
}

for (const command of ["false", "throw", "missing"] as const) {
  for (const clipboard of ["success", "reject", "throw", "missing", "no-method"] as const) {
    test(`field ${command}, clipboard ${clipboard}: result, cleanup and focus`, async () => {
      const h = harness({ command, clipboard });
      expect(await h.copy("Subject: a b", h.host)).toBe(clipboard === "success");
      const hasMethod = clipboard !== "missing" && clipboard !== "no-method";
      expect(h.writes).toEqual(hasMethod ? ["Subject: a b"] : []);
      expect(h.fields).toHaveLength(1);
      expect(h.fields[0].removed).toBe(true);
      expect(h.fields[0].parent).toBeNull();
      expect(h.document.activeElement).toBe(h.previousFocus);
      if (hasMethod) {
        expect(h.events.indexOf("remove")).toBeLessThan(h.events.indexOf("writeText"));
        expect(h.events.indexOf("focus")).toBeLessThan(h.events.indexOf("writeText"));
      }
    });
  }
}

test("selection errors also clean up, restore focus and fall back", async () => {
  const h = harness({ selectionThrows: true });
  expect(await h.copy("Subject: a b")).toBe(true);
  expect(h.events).toEqual(["body", "select", "remove", "focus", "writeText"]);
  expect(h.fields[0].removed).toBe(true);
  expect(h.writes).toEqual(["Subject: a b"]);
  expect(h.document.activeElement).toBe(h.previousFocus);
});

test("absent or unavailable previous focus does not change the copy result", async () => {
  for (const options of [{ noFocus: true }, { focusThrows: true }]) {
    const h = harness(options);
    expect(await h.copy("Subject: a b")).toBe(true);
    expect(h.fields[0].removed).toBe(true);
    expect(h.writes).toEqual([]);
  }
});

test("only the helper calls the clipboard API", () => {
  expect(helperSource).toMatch(/clipboard\.writeText\(text\)/);
  expect(source.replace(helperSource, "")).not.toMatch(/clipboard\??\.writeText/);
});

for (const ok of [true, false]) {
  test(`delegated copy buttons preserve host, text and ${ok ? "Copied" : "Failed"} feedback`, async () => {
    const start = source.indexOf('  document.addEventListener("click",', source.indexOf("  const messagesEl ="));
    const end = source.indexOf("  // Tapping a chat image", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    let click: any;
    const timers: any[] = [], calls: any[] = [], toggles: any[] = [];
    const dialog = {};
    class Element {
      textContent = "Copy";
      parentElement = { _copyText: "Subject: a b" };
      classList = { toggle: (...args: any[]) => toggles.push(args), remove: (name: string) => toggles.push(["remove", name]) };
      closest(selector: string) { return selector === "dialog" ? dialog : this; }
    }
    new Function("document", "Element", "copyPlainText", "t", "setTimeout", source.slice(start, end))(
      { addEventListener: (_event: string, handler: any) => { click = handler; } }, Element,
      (text: string, host: any) => { calls.push([text, host]); return Promise.resolve(ok); },
      (key: string) => key, (callback: any, ms: number) => timers.push({ callback, ms }),
    );
    const btn = new Element();
    click({ target: btn });
    await Promise.resolve();
    expect(calls).toEqual([["Subject: a b", dialog]]);
    expect(btn.textContent).toBe(ok ? "chat.copybox.copied" : "chat.copybox.failed");
    expect(toggles).toEqual([["done", ok]]);
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(1600);
    timers[0].callback();
    expect(btn.textContent).toBe("chat.copybox.copy");
    expect(toggles.at(-1)).toEqual(["remove", "done"]);
  });
}

test("message copying stays silent and uses the helper with the existing text choice", () => {
  const calls: string[] = [];
  let removed = false;
  const window: any = {};
  new Function("window", "document", "copyPlainText", "messageSnippetFull", section("  window.copyMessage =", "  window.enableSelect ="))(
    window,
    { querySelector: (selector: string) => selector === ".emoji-picker" ? { remove() { removed = true; } } : { _rawText: "Subject: a b" } },
    (text: string) => { calls.push(text); return Promise.resolve(false); },
    () => "fallback snippet",
  );
  expect(window.copyMessage("message-id")).toBeUndefined();
  expect(removed).toBe(true);
  expect(calls).toEqual(["Subject: a b"]);
});
