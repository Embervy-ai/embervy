import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// A quoted or copied bubble must not carry the quote that bubble itself shows.
type Node = El | string;
class El {
  parent: El | null = null;
  constructor(public classes: string[], public children: Node[] = []) {
    for (const child of children) if (typeof child !== "string") child.parent = this;
  }
  cloneNode(): El { return new El([...this.classes], this.children.map((c) => typeof c === "string" ? c : c.cloneNode())); }
  get textContent(): string { return this.children.map((c) => typeof c === "string" ? c : c.textContent).join(""); }
  querySelectorAll(selector: string): El[] {
    const wanted = selector.split(",").map((s) => s.trim().replace(/^\./, ""));
    const found: El[] = [];
    const walk = (el: El) => { for (const c of el.children) if (typeof c !== "string") { if (c.classes.some((x) => wanted.includes(x))) found.push(c); walk(c); } };
    walk(this);
    return found;
  }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
}

function snippetFunctions(): { messageSnippet: (div: El) => string; messageSnippetFull: (div: El) => string } {
  const src = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");
  const take = (name: string) => {
    const start = src.indexOf(`function ${name}(div) {`);
    const end = src.indexOf("\n  }\n", start);
    if (start < 0 || end < 0) throw new Error(`${name} not found in app.js`);
    return src.slice(start, end + 4);
  };
  return new Function(`${take("messageSnippet")}\n${take("messageSnippetFull")}\nreturn { messageSnippet, messageSnippetFull };`)();
}

test("a bubble that shows a quote is quoted and copied without that quote", () => {
  const { messageSnippet, messageSnippetFull } = snippetFunctions();
  const bubble = new El(["message", "assistant"], [
    new El(["msg-quote"], [new El(["reply-bar-who"], ["Person"]), "The earlier message."]),
    new El(["content"], ["The answer itself."]),
    new El(["time"], ["12:33"]),
    new El(["reaction-display"], ["+1"]),
  ]);
  expect(messageSnippet(bubble)).toBe("The answer itself.");
  expect(messageSnippetFull(bubble)).toBe("The answer itself.");
  expect(bubble.textContent).toContain("The earlier message.");
});
