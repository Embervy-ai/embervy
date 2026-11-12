import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The pieces of a message the client builds from fields beside its text —
// media, the quote block, the doctor report — sliced out of public/app.js
// and read with a real HTML tokenizer (Bun's HTMLRewriter), like
// markdown-render.test.ts does for the text itself; fields must not inject handlers.

const SOURCE = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");
const start = SOURCE.indexOf("  function escapeHtml(text) {");
const end = SOURCE.indexOf("  function appearanceTextColors(background) {");
if (start < 0 || end < start) throw new Error("the untrusted-fields block is missing from public/app.js");
const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const pure = new Function("t", `${SOURCE.slice(start, end)}\nreturn { escapeHtml, withMedia, quoteHtml, doctorReportHtml };`)(t) as {
  escapeHtml: (s: unknown) => string;
  withMedia: (content: string, text: string, imageUrl: unknown) => string;
  quoteHtml: (meta: unknown) => string;
  doctorReportHtml: (report: unknown) => string;
};

type El = { tag: string; attrs: Record<string, string> };

async function elements(html: string): Promise<El[]> {
  const found: El[] = [];
  await new HTMLRewriter()
    .on("*", { element(e) { found.push({ tag: e.tagName, attrs: Object.fromEntries([...e.attributes]) }); } })
    .transform(new Response(html))
    .text();
  return found;
}

function handlers(els: El[]): string[] {
  return els.flatMap((el) => Object.keys(el.attrs).filter((a) => a.startsWith("on")).map((a) => `${el.tag}[${a}]`));
}

const BREAKER = `x" onerror="globalThis.hit=1" data-x="`;
const QUOTE_BREAKER = `x');globalThis.hit=1;('`;

describe("message fields on the page", () => {
  test("escapeHtml covers both quote kinds", () => {
    expect(pure.escapeHtml(`<a href="x" title='y'>&`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;");
  });

  test("an unsafe image address leaves the message as it was", async () => {
    expect(pure.withMedia("<p>hi</p>", "[Image]", `/api/images/a.png${BREAKER}`)).toBe("<p>hi</p>");
    expect(pure.withMedia("<p>hi</p>", "[Image]", "javascript:alert(1)//.png")).toBe("<p>hi</p>");
  });

  test("a safe image becomes one img with exactly that address", async () => {
    const els = await elements(pure.withMedia("caption", "caption", "/api/images/a.png"));
    expect(els).toEqual([{ tag: "img", attrs: { src: "/api/images/a.png", class: "chat-image", loading: "lazy" } }]);
  });

  test("a remote image field is a link, never an automatic request", async () => {
    const els = await elements(pure.withMedia("caption", "caption", "https://attacker.test/beacon.png"));
    expect(els.map(e => e.tag)).toEqual(["a"]);
    expect(els[0].attrs.href).toBe("https://attacker.test/beacon.png");
  });

  test("a file becomes a link that opens apart, its name as text", async () => {
    const html = pure.withMedia("ignored", `[File: <img src=x onerror=alert(1)>.pdf]`, "/api/images/a.pdf");
    const els = await elements(html);
    expect(els.map((e) => e.tag)).toEqual(["a"]);
    expect(els[0].attrs.href).toBe("/api/images/a.pdf");
    expect(els[0].attrs.rel).toBe("noopener noreferrer");
  });

  test("the quote block carries no handler and only a safe id", async () => {
    const bad = await elements(pure.quoteHtml({ id: QUOTE_BREAKER, snippet: `<b>hi</b>${BREAKER}`, role: "assistant" }));
    expect(handlers(bad)).toEqual([]);
    expect(bad.map((e) => e.tag)).toEqual(["div", "span"]);
    expect(bad[0].attrs["data-jump"]).toBe("");
    const good = await elements(pure.quoteHtml({ id: "brain-1-a", snippet: "s", role: "user" }));
    expect(good[0].attrs["data-jump"]).toBe("brain-1-a");
  });

  test("doctor lines are text, whatever they contain", async () => {
    const html = pure.doctorReportHtml({
      result: `FAIL${BREAKER}`,
      summary: { pass: 1, warn: 0, fail: 1 },
      checks: [
        { group: "<img src=x onerror=alert(1)>", label: "<script>alert(1)</script>", detail: BREAKER, fix: "<a href=javascript:x>fix</a>", status: "FAIL" },
      ],
    });
    const els = await elements(html);
    expect(handlers(els)).toEqual([]);
    expect(new Set(els.map((e) => e.tag))).toEqual(new Set(["strong", "br", "small", "em"]));
  });
});

describe("no inline code anywhere the page is built", () => {
  test("app.js writes no handler attribute into markup", () => {
    expect(SOURCE).not.toMatch(/\son[a-z]+=\\?["'`$]/);
  });

  for (const page of ["index.html", "settings.html"]) {
    test(`${page}: every script is a file, no handler attributes`, async () => {
      const els = await elements(readFileSync(join(import.meta.dir, "public", page), "utf8"));
      expect(handlers(els)).toEqual([]);
      expect(els.filter((e) => e.tag === "script" && !e.attrs.src)).toEqual([]);
    });
  }
});
