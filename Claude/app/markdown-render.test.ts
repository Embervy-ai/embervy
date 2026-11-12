import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// These tests use an HTML tokenizer to detect attribute injection in rendered messages.

const SOURCE = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");
const start = SOURCE.indexOf("  function renderMarkdown(text) {");
const end = SOURCE.indexOf("  const approvalStates = new Map();");
if (start < 0 || end < start) throw new Error("renderMarkdown not found in public/app.js");
const renderMarkdown = new Function("location", `${SOURCE.slice(start, end)}\nreturn renderMarkdown;`)(
  { origin: "https://app.example" },
) as (text: string) => string;

const AUDIT_PAYLOAD = `![" onerror="globalThis.auditXss=73](/missing.png)`;

type El = { tag: string; attrs: Record<string, string> };

async function elements(html: string): Promise<El[]> {
  const found: El[] = [];
  await new HTMLRewriter()
    .on("*", { element(e) { found.push({ tag: e.tagName, attrs: Object.fromEntries([...e.attributes]) }); } })
    .transform(new Response(html))
    .text();
  return found;
}

const ALLOWED: Record<string, string[]> = {
  div: ["class"],
  button: ["type", "class", "aria-label"],
  img: ["src", "alt", "class", "loading"],
  a: ["href", "target", "rel"],
};

async function expectNoInjectedAttributes(html: string): Promise<El[]> {
  const els = await elements(html);
  for (const el of els) {
    for (const name of Object.keys(el.attrs)) {
      expect(name.toLowerCase().startsWith("on")).toBe(false);
      expect(ALLOWED[el.tag] ?? []).toContain(name);
    }
  }
  return els;
}

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

describe("renderMarkdown: attribute values and code", () => {
  test("normal messages render as before", () => {
    expect(renderMarkdown("Hello.\nSecond line\n\n**bold** and *quiet*")).toBe(
      "<p>Hello.<br>Second line</p><p><strong>bold</strong> and <em>quiet</em></p>");
    expect(renderMarkdown("A [link](https://example.com/a?b=1&c=2).")).toBe(
      '<p>A <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">link</a>.</p>');
    expect(renderMarkdown("Code:\n\n```ts\nconst a = 1 < 2;\n```\n\nAfter.")).toBe(
      '<p>Code:</p><div class="copybox"><button type="button" class="copybox-btn" aria-label="Copy">Copy</button><pre><code>const a = 1 &lt; 2;</code></pre></div><p>After.</p>');
    expect(renderMarkdown("![Evening](https://worker.example/images/42)")).toBe(
      '<p><img src="/api/memory-image/42" alt="Evening" class="chat-image" loading="lazy"></p>');
  });

  test("foreign images become links, including protocol-relative and backslash variants", async () => {
    for (const url of ["https://attacker.test/beacon?secret=42", "http://attacker.test/x", "//attacker.test/x", "/\\\\attacker.test/x"]) {
      const els = await elements(renderMarkdown(`![x](${url})`));
      expect(els.some(e => e.tag === "img")).toBe(false);
      expect(els.some(e => e.tag === "a")).toBe(true);
    }
    expect(renderMarkdown("![own](https://app.example/api/images/own.png)")).toContain('<img src="https://app.example/api/images/own.png"');
  });

  test("normal alt text", async () => {
    const html = renderMarkdown("![Sunset over the sea](/api/images/abc.png)");
    expect(html).toBe('<p><img src="/api/images/abc.png" alt="Sunset over the sea" class="chat-image" loading="lazy"></p>');
    const [, img] = await expectNoInjectedAttributes(html);
    expect(img.attrs.alt).toBe("Sunset over the sea");
  });

  test("quotes in alt text stay inside the attribute", async () => {
    const html = renderMarkdown(`![say "hi" & 'bye'](/a.png)`);
    const els = await expectNoInjectedAttributes(html);
    const img = els.find((e) => e.tag === "img")!;
    expect(Object.keys(img.attrs)).toEqual(["src", "alt", "class", "loading"]);
    expect(decode(img.attrs.alt)).toBe(`say "hi" & 'bye'`);
  });

  test("the audit payload: one image, its alt is text, no onerror attribute", async () => {
    const html = renderMarkdown(AUDIT_PAYLOAD);
    expect(html).toBe('<p><img src="/missing.png" alt="&quot; onerror=&quot;globalThis.auditXss=73" class="chat-image" loading="lazy"></p>');
    const els = await expectNoInjectedAttributes(html);
    const imgs = els.filter((e) => e.tag === "img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].attrs.onerror).toBeUndefined();
    expect(decode(imgs[0].attrs.alt)).toBe(`" onerror="globalThis.auditXss=73`);
  });

  test("the audit payload inside a ```md code block is shown as text, never as an image", async () => {
    const html = renderMarkdown("Look:\n\n```md\n" + AUDIT_PAYLOAD + "\n```");
    const els = await expectNoInjectedAttributes(html);
    expect(els.map((e) => e.tag)).toEqual(["p", "div", "button", "pre", "code"]);
    expect(html).toBe(`<p>Look:</p><div class="copybox"><button type="button" class="copybox-btn" aria-label="Copy">Copy</button><pre><code>![" onerror="globalThis.auditXss=73](/missing.png)</code></pre></div>`);
  });

  test("inline code is never read as Markdown", async () => {
    const html = renderMarkdown("Try `" + AUDIT_PAYLOAD + "` and `**not bold** [no](/link)`");
    const els = await expectNoInjectedAttributes(html);
    expect(els.map((e) => e.tag)).toEqual(["p", "code", "code"]);
    expect(html).toBe(`<p>Try <code>![" onerror="globalThis.auditXss=73](/missing.png)</code> and <code>**not bold** [no](/link)</code></p>`);
  });

  test("links: quotes and script URLs never reach the href", async () => {
    for (const md of [
      `[x](" autofocus onfocus="alert)`,
      "[x](javascript:alert(1))",
      `[x](/ok" onmouseover="alert)`,
      "[x](/x![b](/y.png))",
      "[![" + `" onerror="a` + "](/i.png)](/u)",
    ]) {
      const els = await expectNoInjectedAttributes(renderMarkdown(md));
      for (const a of els.filter((e) => e.tag === "a")) expect(decode(a.attrs.href)).not.toMatch(/["'\s]|^javascript:/i);
    }
  });

  test("a NUL in the text cannot forge a placeholder", async () => {
    const html = renderMarkdown("`a` \u00000\u0000 ![x](/p.png) \u00001\u0000");
    await expectNoInjectedAttributes(html);
    expect(html).not.toContain("\u0000");
  });

  test("fuzz: no combination of Markdown and quotes yields a foreign attribute", async () => {
    const parts = ["![", "[", "]", "(", ")", "](", '"', "'", "`", "```md\n", "```", "*", "**", "_", "__", "\n", "\n\n",
      " onerror=", '" onerror="x', "alert(1)", "/x.png", "https://h.example/images/7", "javascript:", "<", ">", "&", " ", "a", "\u0000"];
    let seed = 20261001;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let i = 0; i < 1500; i++) {
      let md = "";
      const len = 3 + rand(18);
      for (let j = 0; j < len; j++) md += parts[rand(parts.length)];
      const html = renderMarkdown(md);
      expect(html).not.toContain("\u0000");
      await expectNoInjectedAttributes(html);
    }
  });
});

describe("bare addresses", () => {
  test("a bare https address becomes a link that opens outside, without the sentence's full stop", async () => {
    const html = renderMarkdown("Here: https://example.com/a?b=1&c=2.");
    const links = (await expectNoInjectedAttributes(html)).filter((e) => e.tag === "a");
    // The tokenizer reports the attribute as written; the browser reads &amp; as &.
    expect(links).toEqual([{ tag: "a", attrs: { href: "https://example.com/a?b=1&amp;c=2", target: "_blank", rel: "noopener noreferrer" } }]);
    expect(html).toContain("</a>.</p>");
  });

  test.each(["", ".", ");"])("a trailing ampersand stays intact before punctuation %j", async (punctuation) => {
    const address = "https://example.com/a?b=1&";
    const html = renderMarkdown(address + punctuation);
    expect(html).toBe(`<p><a href="https://example.com/a?b=1&amp;" target="_blank" rel="noopener noreferrer">https://example.com/a?b=1&amp;</a>${punctuation}</p>`);
    const links = (await expectNoInjectedAttributes(html)).filter(e => e.tag === "a");
    expect(links).toHaveLength(1);
    expect(decode(links[0].attrs.href)).toBe(address);
  });

  test("an address that is already a written link is not linked twice", async () => {
    const html = renderMarkdown("[https://example.com](https://example.com) and [docs](https://example.com/docs)");
    const links = (await expectNoInjectedAttributes(html)).filter((e) => e.tag === "a");
    expect(links.map((l) => l.attrs.href)).toEqual(["https://example.com", "https://example.com/docs"]);
  });

  test("brackets around an address stay outside, brackets inside it stay in", async () => {
    const outside = (await elements(renderMarkdown("(https://example.com/page)"))).filter((e) => e.tag === "a");
    expect(outside.map((l) => l.attrs.href)).toEqual(["https://example.com/page"]);
    const inside = (await elements(renderMarkdown("https://example.com/wiki/Foo_(Bar)"))).filter((e) => e.tag === "a");
    expect(inside.map((l) => l.attrs.href)).toEqual(["https://example.com/wiki/Foo_(Bar)"]);
  });

  test("addresses in code stay code, and nothing but http(s) is linked", async () => {
    expect(renderMarkdown("`https://example.com`")).not.toContain("<a ");
    expect(renderMarkdown("javascript:alert(1) and http://a\"b")).not.toContain("<a ");
  });
});
