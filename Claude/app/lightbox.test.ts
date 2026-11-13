import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readAssetReferences, readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";

const read = (path: string) => readFileSync(join(import.meta.dir, path), "utf8");
const source = read("public/app.js");
const css = read("public/style.css");
const strings = JSON.parse(read("strings/en.json"));
function section(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

class Element {
  tagName: string;
  className = "";
  src = "";
  href = "";
  textContent = "";
  title = "";
  hidden = false;
  disabled = false;
  clientWidth = 300;
  clientHeight = 400;
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, { fn: Function; options: any }[]> = {};
  children: Element[] = [];
  parent: Element | null = null;
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  setAttribute(key: string, value: string) { this.attrs[key] = value; }
  addEventListener(type: string, fn: Function, options?: any) { (this.listeners[type] ??= []).push({ fn, options }); }
  removeEventListener(type: string, fn: Function) { this.listeners[type] = (this.listeners[type] || []).filter(item => item.fn !== fn); }
  append(...nodes: Element[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  appendChild(node: Element) { this.append(node); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  closest(selector: string): Element | null {
    if (selector === "button" && this.tagName === "BUTTON") return this;
    return this.parent?.closest(selector) ?? null;
  }
  querySelector(selector: string): Element | null {
    for (const node of this.children) {
      if (node.className.split(" ").includes(selector.slice(1))) return node;
      const found = node.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  fire(type: string, props: any = {}) {
    const event = { target: this, stopped: false, defaultPrevented: false,
      stopPropagation() { this.stopped = true; },
      preventDefault() { this.defaultPrevented = true; }, ...props };
    if (type === "click" && this.disabled) return event;
    let node: Element | null = this;
    while (node) {
      for (const { fn } of [...(node.listeners[type] || [])]) fn(event);
      if (event.stopped || type === "load") break;
      node = node.parent;
    }
    return event;
  }
}

function image(src: string) { const node = new Element("img"); node.src = src; return node; }
function link(href: string) { const node = new Element("a"); node.href = href; return node; }
const point = (x: number, y = 100) => ({ clientX: x, clientY: y });
function harness(nodes = [image("/a.jpg"), image("/b.jpg"), image("/c.jpg")]) {
  const document = Object.assign(new Element("document"), {
    body: new Element("body"), createElement: (tag: string) => new Element(tag),
  });
  document.append(document.body);
  const downloads: string[] = [];
  const translated: string[] = [];
  let now = 1000;
  const api = new Function("document", "messagesEl", "t", "downloadImage", "Date", `
    let terminalOpen = false, opened = 0, closed = 0;
    function openTerminal() { terminalOpen = true; opened++; }
    function closeTerminal() { terminalOpen = false; closed++; }
    ${section("  function lightboxImages(", "  // A file in the chat")}
    ${section("  let terminalTouchX =", "  setInterval(() => {\n    if (terminalOpen && terminalFreshness")}
    return { openLightbox, lightboxImages, state: () => ({ terminalOpen, opened, closed, terminalTouchX, terminalTouchY }) };
  `)(document, { querySelectorAll: (selector: string) => {
    expect(selector).toBe("img.chat-image, a.file-chip, a.file-link");
    return nodes;
  } }, (key: string, vars: any = {}) => {
    translated.push(key);
    expect(typeof strings[key]).toBe("string");
    return strings[key].replace(/\{(\w+)\}/g, (_: string, name: string) => String(vars[name]));
  }, (src: string) => downloads.push(src), { now: () => now });
  const get = (name: string) => {
    const found = document.querySelector(`.lightbox-${name}`);
    expect(found).not.toBeNull();
    return found!;
  };
  const open = (index = 0) => api.openLightbox(nodes[index].src || nodes[index].href, nodes[index]);
  const touch = (type: string, touches: any[], changedTouches = touches, target = get("image")) => target.fire(type, { touches, changedTouches });
  const swipe = (dx = -100, dy = 0, target = get("image")) => {
    touch("touchstart", [point(180)], undefined, target);
    touch("touchmove", [point(180 + dx, 100 + dy)], undefined, target);
    touch("touchend", [], [point(180 + dx, 100 + dy)], target);
  };
  const tap = () => { touch("touchstart", [point(100)]); touch("touchend", [], [point(100)]); now += 100; };
  const pinch = (endDistance: number, startDistance = 100) => {
    touch("touchstart", [point(0), point(startDistance)]);
    touch("touchmove", [point(0), point(endDistance)]);
    touch("touchend", [], [point(0), point(endDistance)]);
  };
  const transform = () => get("image").style.transform;
  const scale = () => Number(/scale\(([^)]+)\)/.exec(transform())![1]);
  return { ...api, document, nodes, downloads, translated, get, open, touch, swipe, tap, pinch, transform, scale,
    advance: (ms: number) => { now += ms; }, key: (key: string) => document.fire("keydown", { key }) };
}

test("images and image links retain loaded document order and repeated occurrences", () => {
  const nodes = [image("/a.jpg"), link("/file.pdf"), link("/b.PNG?size=2"), image("/a.jpg"), image("/a.jpg"), link("/vector.svg#view"), link("/clip.mp4")];
  const h = harness(nodes);
  expect(h.lightboxImages().map((entry: any) => entry.src)).toEqual(["/a.jpg", "/b.PNG?size=2", "/a.jpg", "/a.jpg", "/vector.svg#view"]);
  h.open(3);
  expect(h.get("counter").textContent).toBe("3 / 5");
  h.get("next").fire("click");
  expect(h.get("counter").textContent).toBe("4 / 5");
  h.key("ArrowLeft");
  h.key("ArrowLeft");
  expect(h.get("image").src).toBe("/b.PNG?size=2");
});

for (const count of [1, 2, 4]) test(`navigation visibility and boundaries for ${count} images`, () => {
  const h = harness(Array.from({ length: count }, (_, n) => image(`/image-${n}.jpg`)));
  h.open();
  for (const name of ["prev", "next", "counter"]) expect(h.get(name).hidden).toBe(count === 1);
  expect(h.get("prev").disabled).toBe(true);
  expect(h.get("next").disabled).toBe(count === 1);
  expect(h.get("counter").textContent).toBe(count === 1 ? "" : `1 / ${count}`);
  h.get("prev").fire("click");
  h.key("ArrowLeft");
  expect(h.get("image").src).toBe("/image-0.jpg");
  for (let i = 1; i < count; i++) {
    h.get("next").fire("click");
    expect(h.get("counter").textContent).toBe(`${i + 1} / ${count}`);
  }
  expect(h.get("next").disabled).toBe(true);
  h.get("next").fire("click");
  h.key("ArrowRight");
  expect(h.get("image").src).toBe(`/image-${count - 1}.jpg`);
  if (count > 1) {
    expect(h.get("prev").disabled).toBe(false);
    h.get("prev").fire("click");
    expect(h.get("image").src).toBe(`/image-${count - 2}.jpg`);
  }
});

test("an image outside the loaded history opens without unrelated navigation", () => {
  const h = harness();
  h.openLightbox("/outside.jpg");
  expect(h.get("counter").hidden).toBe(true);
  h.key("ArrowRight");
  expect(h.get("image").src).toBe("/outside.jpg");
});

test("save always delegates the currently visible image to the existing downloader", () => {
  const h = harness(); h.open();
  h.get("download").fire("click");
  h.get("next").fire("click");
  h.get("download").fire("click");
  expect(h.key("ArrowRight").defaultPrevented).toBe(true);
  h.get("download").fire("click");
  h.key("ArrowLeft");
  h.get("download").fire("click");
  expect(h.downloads).toEqual(["/a.jpg", "/b.jpg", "/c.jpg", "/b.jpg"]);
});

test("horizontal swipes navigate in both directions, not short or vertical gestures", () => {
  const h = harness(); h.open();
  h.swipe(-50); h.swipe(-80, 100); h.swipe(0, -150);
  expect(h.get("image").src).toBe("/a.jpg");
  h.swipe(); expect(h.get("image").src).toBe("/b.jpg");
  h.swipe(100); expect(h.get("image").src).toBe("/a.jpg");
  expect(h.state().opened).toBe(0);
});

test("pinch stays between one and six, and zoomed swipes pan rather than navigate", () => {
  const h = harness(); h.open(1);
  h.pinch(250); expect(h.scale()).toBe(2.5);
  h.swipe(-100);
  expect(h.get("image").src).toBe("/b.jpg");
  expect(h.transform()).toBe("translate(-100px, 0px) scale(2.5)");
  h.swipe(-10000, 10000);
  expect(h.transform()).toBe("translate(-249px, 324px) scale(2.5)");
  h.pinch(1000); expect(h.scale()).toBe(6);
  h.pinch(1); expect(h.transform()).toBe("translate(0px, 0px) scale(1)");
  h.swipe(); expect(h.get("image").src).toBe("/c.jpg");
});

test("pinch with coincident starting fingers remains finite", () => {
  const h = harness(); h.open();
  h.pinch(100, 0);
  expect(h.scale()).toBe(6);
  expect(h.transform()).not.toContain("NaN");
});

test("double tap toggles zoom and ignores slow taps and intervening drags", () => {
  const h = harness(); h.open();
  h.tap(); h.advance(400); h.tap(); expect(h.scale()).toBe(1);
  h.tap(); expect(h.scale()).toBe(2.5);
  h.tap(); h.tap(); expect(h.scale()).toBe(1);
  h.tap(); h.swipe(-20); h.tap(); expect(h.scale()).toBe(1);
  h.tap(); expect(h.scale()).toBe(2.5);
});

test("image changes reset zoom immediately, even before the image loads", () => {
  const h = harness(); h.open();
  h.tap(); h.tap(); h.swipe(-100);
  h.get("next").fire("click");
  expect(h.transform()).toBe("translate(0px, 0px) scale(1)");
  h.pinch(300); h.key("ArrowRight"); expect(h.scale()).toBe(1);
  h.pinch(300); h.get("image").fire("load"); expect(h.scale()).toBe(1);
  h.tap(); expect(h.scale()).toBe(1);
});

for (const method of ["close", "background", "Escape"]) test(`${method} closes, clears zoom and removes the key handler`, () => {
  const h = harness(); h.open(); h.pinch(300);
  const img = h.get("image");
  if (method === "Escape") h.key("Escape");
  else if (method === "close") h.get("close").fire("click");
  else {
    const overlay = h.get("overlay");
    h.touch("touchstart", [point(10)], undefined, overlay);
    h.touch("touchend", [], [point(10)], overlay);
    overlay.fire("click");
  }
  expect(h.document.querySelector(".lightbox-overlay")).toBeNull();
  expect(img.style.transform).toBe("translate(0px, 0px) scale(1)");
  expect(h.document.listeners.keydown).toHaveLength(0);
  h.open(); expect(h.scale()).toBe(1);
});

test("a remaining pinch finger cannot trigger navigation or a double tap", () => {
  const h = harness(); h.open(); h.tap();
  h.touch("touchstart", [point(0), point(100)]);
  h.touch("touchmove", [point(0), point(200)]);
  h.touch("touchend", [point(0)], [point(200)]);
  h.touch("touchmove", [point(-150)]);
  h.touch("touchend", [], [point(-150)]);
  expect(h.scale()).toBe(2);
  expect(h.get("image").src).toBe("/a.jpg");
  h.tap(); expect(h.scale()).toBe(2);
});

test("cancelled gestures do not leave a swipe or tap pending", () => {
  const h = harness(); h.open(); h.tap();
  h.touch("touchstart", [point(180)]);
  h.touch("touchcancel", [], [point(180)]);
  h.touch("touchend", [], [point(0)]);
  h.tap(); expect(h.scale()).toBe(1);
  expect(h.get("image").src).toBe("/a.jpg");
  h.swipe(); expect(h.get("image").src).toBe("/b.jpg");
});

test("a background swipe does not close the overlay through a synthetic click", () => {
  const h = harness(); h.open();
  const overlay = h.get("overlay");
  h.swipe(-100, 0, overlay); overlay.fire("click");
  expect(h.get("image").src).toBe("/b.jpg");
  h.touch("touchstart", [point(10)], undefined, overlay);
  h.touch("touchend", [], [point(10)], overlay);
  overlay.fire("click");
  expect(h.document.querySelector(".lightbox-overlay")).toBeNull();
});

test("button touches do not zoom or navigate until the button is clicked", () => {
  const h = harness(); h.open();
  h.swipe(-100, 0, h.get("download"));
  expect(h.get("image").src).toBe("/a.jpg");
  expect(h.scale()).toBe(1);
  h.get("download").fire("click"); expect(h.downloads).toEqual(["/a.jpg"]);
  expect(h.get("overlay").listeners.touchmove[0].options.passive).toBe(false);
});

test("document page gestures ignore an open overlay and resume after closing", () => {
  const h = harness();
  const start = () => h.document.fire("touchstart", { changedTouches: [point(200)] });
  const end = (x = 0) => h.document.fire("touchend", { changedTouches: [point(x)] });
  start(); h.open();
  expect(h.state().terminalTouchX).toBeNull();
  end(); expect(h.state().opened).toBe(0);
  start(); expect(h.state().terminalTouchX).toBeNull();
  end(); expect(h.state().opened).toBe(0);
  h.get("close").fire("click"); end(); expect(h.state().opened).toBe(0);
  start(); end(); expect(h.state().opened).toBe(1);
  h.open(); start(); end(400); expect(h.state().closed).toBe(0);
  h.key("Escape"); start(); end(400); expect(h.state().closed).toBe(1);
});

test("the end guard rejects a page gesture when an overlay appears mid-gesture", () => {
  const h = harness();
  h.document.fire("touchstart", { changedTouches: [point(200)] });
  const overlay = new Element(); overlay.className = "lightbox-overlay";
  h.document.body.append(overlay);
  h.document.fire("touchend", { changedTouches: [point(0)] });
  expect(h.state().opened).toBe(0);
  expect(h.state().terminalTouchX).toBeNull();
});

test("new control labels and counter use translation keys in every shipped language", () => {
  for (const file of readdirSync(join(import.meta.dir, "strings")).filter(file => file.endsWith(".json"))) {
    const table = JSON.parse(read(`strings/${file}`));
    for (const key of ["lightbox.previous", "lightbox.next", "lightbox.counter"]) expect(typeof table[key]).toBe("string");
    expect(table["lightbox.counter"]).toContain("{current}");
    expect(table["lightbox.counter"]).toContain("{total}");
  }
  const h = harness(); h.open();
  for (const [name, key] of [["prev", "lightbox.previous"], ["next", "lightbox.next"]]) {
    expect(h.get(name).title).toBe(strings[key]);
    expect(h.get(name).attrs["aria-label"]).toBe(strings[key]);
    expect(h.translated).toContain(key);
  }
  expect(h.translated).toContain("lightbox.counter");
});

test("navigation has faded disabled edges, centered safe-area controls and clipped touch zoom", () => {
  expect(css).toMatch(/\.lightbox-nav:disabled\s*\{[^}]*opacity:\s*0\.25/);
  expect(css).toMatch(/\.lightbox-nav\s*\{[^}]*left:\s*50%/);
  expect(css).toMatch(/\.lightbox-prev\s*\{[^}]*top:.*safe-area-inset-top/);
  expect(css).toMatch(/\.lightbox-next\s*\{[^}]*bottom:.*safe-area-inset-bottom/);
  expect(css).toMatch(/\.lightbox-overlay\s*\{[^}]*overflow:\s*hidden;[^}]*touch-action:\s*none/);
  expect(css).toMatch(/\.lightbox-nav\[hidden\], \.lightbox-counter\[hidden\]\s*\{\s*display:\s*none/);
});

test("asset references agree across all HTML pages and the service worker", () => {
  const worker = read("public/sw.js");
  const index = read("public/index.html");
  for (const asset of ["app.js", "style.css"] as const) {
    const version = readAssetStamp(index, asset);
    const url = readAssetUrl(index, asset);
    expect(version).toBeGreaterThan(asset === "app.js" ? 136 : 121);
    expect(readAssetUrl(worker, asset)).toBe(url);
    for (const file of readdirSync(join(import.meta.dir, "public")).filter(file => file.endsWith(".html"))) {
      const page = read(`public/${file}`);
      // Some pages do not use this asset; every reference on the others must agree.
      if (!page.includes(`${asset}?v=`)) continue;
      for (const reference of readAssetReferences(page, asset)) {
        expect(reference.version).toBe(version);
        expect(reference.url).toBe(url);
      }
    }
  }
  expect(readCacheNumber(worker)).toBeGreaterThan(53);
  expect(source).toContain("openLightbox(img.src, img)");
});
