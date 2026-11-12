import { describe, expect, test } from "bun:test";
import {
  LONG_LINE,
  parseHeading,
  pdfViewerPage,
  rawFileHeaders,
  renderMarkdown,
  textViewerPage,
  VIEWER_CSP,
  VIEWER_JS,
  VIEWER_SCRIPT_PATH,
  viewerKind,
  wantsViewer,
} from "./file-viewer";

// The file viewer (file-viewer.ts) as plain functions. Its pages are read
// with a real HTML tokenizer (Bun's HTMLRewriter), like markdown-render.test.ts
// does for the chat renderer: which elements and attributes would a browser
// build? The page may carry no inline script (the app's policy forbids it),
// so the close button must work as a plain link plus /viewer.js.

type El = { tag: string; attrs: Record<string, string> };

async function elements(html: string): Promise<El[]> {
  const found: El[] = [];
  await new HTMLRewriter()
    .on("*", { element(e) { found.push({ tag: e.tagName, attrs: Object.fromEntries([...e.attributes]) }); } })
    .transform(new Response(html))
    .text();
  return found;
}

async function textOf(html: string, selector: string): Promise<string> {
  let text = "";
  await new HTMLRewriter()
    .on(selector, { text(t) { text += t.text; } })
    .transform(new Response(html))
    .text();
  return text;
}

// What renderMarkdown itself may write, and nothing else.
const MARKDOWN_ALLOWED: Record<string, string[]> = {
  h1: [], h2: [], h3: [], h4: [], h5: [], h6: [], p: [], br: [], hr: [],
  ul: [], ol: ["start"], li: [], pre: [], code: [], strong: [], em: [], blockquote: [],
  a: ["href", "target", "rel"],
};

const HOSTILE_MD = [
  "# Title <script>alert(1)</script>",
  "",
  "<script>alert(2)</script>",
  '<img src=x onerror="alert(3)">',
  "[click](javascript:alert(4)) and [data](data:text/html,<b>5</b>)",
  '[quote](https://example.org/a"onmouseover="alert(6))',
  "**bold <i>x</i>** *em* `code <b>y</b>`",
  "",
  "```html",
  "<script>alert(7)</script>",
  "```",
  "",
  "| a | <b>b</b> |",
  "|---|---|",
  "",
  "> quoted <iframe src=x></iframe>",
  "",
  "- item <svg onload=alert(8)>",
  "3. third",
].join("\n");

describe("renderMarkdown writes only its own markup", () => {
  test("hostile input: only allowed elements and attributes, links only http(s)", async () => {
    const html = renderMarkdown(HOSTILE_MD);
    for (const el of await elements(html)) {
      expect(Object.keys(MARKDOWN_ALLOWED)).toContain(el.tag);
      for (const name of Object.keys(el.attrs)) expect(MARKDOWN_ALLOWED[el.tag]).toContain(name);
      if (el.tag === "a") {
        expect(el.attrs.href).toMatch(/^https?:\/\//);
        expect(el.attrs.href).not.toContain('"');
        expect(el.attrs.rel).toBe("noopener noreferrer");
      }
    }
    // The markup in the file is shown as text.
    expect(html).toContain("&lt;script&gt;alert(2)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;alert(7)&lt;/script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("[click](javascript:alert(4))"); // not a link: left as text
  });

  test("the quote in a link address stays inside the attribute", async () => {
    const links = (await elements(renderMarkdown('[q](https://example.org/a"onmouseover="alert(6))'))).filter((e) => e.tag === "a");
    expect(links).toHaveLength(1);
    expect(Object.keys(links[0].attrs).sort()).toEqual(["href", "rel", "target"]);
  });

  test("ordinary markdown renders", () => {
    const html = renderMarkdown("# Head\n\nSome **bold** and *em* and `x`.\nNext line.\n\n- a\n- b\n\n2. two\n3. three\n\n---\n\n[site](https://example.org/?a=1&b=2)");
    expect(html).toContain("<h1>Head</h1>");
    expect(html).toContain("<p>Some <strong>bold</strong> and <em>em</em> and <code>x</code>.<br>\nNext line.</p>");
    expect(html).toContain("<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
    expect(html).toContain('<ol start="2">\n<li>two</li>\n<li>three</li>\n</ol>');
    expect(html).toContain("<hr>");
    expect(html).toContain('<a href="https://example.org/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">site</a>');
  });

  test("accented and other non-ASCII text pass through untouched", () => {
    expect(renderMarkdown("Café Zoë in Ærø — naïve, ñ, 日本")).toBe("<p>Café Zoë in Ærø — naïve, ñ, 日本</p>");
  });
});

describe("viewer pages", () => {
  test("a markdown page: close link to /, the script as a file, no inline script or handlers", async () => {
    const html = textViewerPage("notes.md", "# Café <script>alert(1)</script>\n\nText");
    const els = await elements(html);
    const close = els.filter((e) => e.attrs.id === "viewer-close");
    expect(close).toHaveLength(1);
    expect(close[0].tag).toBe("a");
    expect(close[0].attrs.href).toBe("/");
    expect(close[0].attrs["aria-label"]).toBe("Close");
    const scripts = els.filter((e) => e.tag === "script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].attrs.src).toBe(VIEWER_SCRIPT_PATH);
    expect(await textOf(html, "script")).toBe(""); // no inline code
    for (const el of els) for (const name of Object.keys(el.attrs)) expect(name).not.toMatch(/^on/i);
    expect(await textOf(html, "title")).toBe("Café &lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("a plain text file is escaped inside <pre>; JSON is indented", async () => {
    const txt = textViewerPage("log.txt", "a <b>c</b> & d");
    expect(txt).toContain('<pre class="wrap">a &lt;b&gt;c&lt;/b&gt; &amp; d</pre>');
    expect(textViewerPage("x.json", '{"a":[1,2]}')).toContain('<pre class="wrap">{\n  &quot;a&quot;: [\n    1,\n    2\n  ]\n}</pre>');
  });

  test("a truncated file says so", () => {
    expect(textViewerPage("big.log", "abc", 12 * 1048576)).toContain("Showing the first 5 MB of 12.0 MB.");
  });

  test("a PDF page frames the raw address, escaped", async () => {
    const html = pdfViewerPage('a"b.pdf', '/share/a%22b.pdf?raw=1');
    const frames = (await elements(html)).filter((e) => e.tag === "iframe");
    expect(frames).toHaveLength(1);
    expect(frames[0].attrs.src).toBe("/share/a%22b.pdf?raw=1");
    // HTMLRewriter hands out attribute values as written: the quote stays escaped
    // and inside the attribute (no extra attributes appear).
    expect(frames[0].attrs.title).toBe("a&quot;b.pdf");
    expect(Object.keys(frames[0].attrs).sort()).toEqual(["src", "title"]); // no sandbox: PDF viewers refuse sandboxed frames
  });
});

describe("the policy fits the page", () => {
  const directives = Object.fromEntries(VIEWER_CSP.split(";").map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));

  test("scripts only as files from this origin", () => {
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(VIEWER_SCRIPT_PATH.startsWith("/")).toBe(true); // same origin, so 'self' allows it
  });

  test("the page's own <style> block and the same-origin PDF frame are allowed", () => {
    expect(directives["style-src"]).toContain("'unsafe-inline'");
    expect(directives["frame-src"]).toEqual(["'self'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
    expect(directives["frame-ancestors"]).toEqual(["'self'"]);
    expect(directives["sandbox"]).toBeUndefined(); // a sandbox would stop the close script
  });
});

describe("the close script", () => {
  type Run = { prevented: boolean; backs: number; href: string; fire: () => void; pagehide: () => void; timers: Map<number, () => void> };

  function run(historyLength: number): Run {
    let handler: ((e: any) => void) | null = null;
    let pagehide: (() => void) | null = null;
    const timers = new Map<number, () => void>();
    let nextTimer = 1;
    const state: Run = {
      prevented: false, backs: 0, href: "", timers,
      fire: () => { for (const fn of [...timers.values()]) fn(); },
      pagehide: () => pagehide?.(),
    };
    const button = { addEventListener: (type: string, fn: (e: any) => void) => { if (type === "click") handler = fn; } };
    const document = { getElementById: (id: string) => (id === "viewer-close" ? button : null) };
    const history = { length: historyLength, back: () => { state.backs++; } };
    const location = { set href(v: string) { state.href = v; }, get href() { return state.href; } };
    const setTimeout = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; };
    const clearTimeout = (id: number) => { timers.delete(id); };
    const addEventListener = (type: string, fn: () => void) => { if (type === "pagehide") pagehide = fn; };
    new Function("document", "history", "location", "setTimeout", "clearTimeout", "addEventListener", VIEWER_JS)(
      document, history, location, setTimeout, clearTimeout, addEventListener,
    );
    expect(handler).not.toBeNull();
    handler!({ preventDefault: () => { state.prevented = true; } });
    return state;
  }

  test("with a page to go back to: history.back(), the link is not followed", () => {
    const r = run(3);
    expect(r.prevented).toBe(true);
    expect(r.backs).toBe(1);
    r.pagehide(); // the back navigation left the page
    r.fire();
    expect(r.href).toBe("");
  });

  test("going back did nothing: home after the fallback timer", () => {
    const r = run(2);
    expect(r.backs).toBe(1);
    r.fire();
    expect(r.href).toBe("/");
  });

  test("a fresh window: the link itself goes to /", () => {
    const r = run(1);
    expect(r.prevented).toBe(false);
    expect(r.backs).toBe(0);
  });
});

describe("which request gets which answer", () => {
  test("viewer kinds", () => {
    expect(viewerKind("a.md")).toBe("markdown");
    expect(viewerKind("A.MD")).toBe("markdown");
    for (const ext of ["txt", "json", "log", "csv", "yaml", "yml", "toml", "sh", "py", "ts", "js", "css"]) expect(viewerKind(`x.${ext}`)).toBe("text");
    expect(viewerKind("x.pdf")).toBe("pdf");
    for (const name of ["x.png", "x.jpg", "x.mp3", "x.html", "x.svg", "x.zip"]) expect(viewerKind(name)).toBeNull();
  });

  test("only a navigating browser without ?raw=1 gets the page", () => {
    const safari = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
    expect(wantsViewer(safari, undefined)).toBe(true);
    expect(wantsViewer(safari, "1")).toBe(false);
    expect(wantsViewer("*/*", undefined)).toBe(false);
    expect(wantsViewer(undefined, undefined)).toBe(false);
    expect(wantsViewer("image/avif,image/webp,*/*", undefined)).toBe(false);
  });

  test("raw bytes of a viewable file vary by Accept; other files keep their headers", () => {
    expect(rawFileHeaders("a.md", undefined)).toEqual({ Vary: "Accept", "Cache-Control": "private" });
    expect(rawFileHeaders("a.pdf", "1")).toEqual({ Vary: "Accept" });
    expect(rawFileHeaders("a.png", undefined)).toEqual({});
  });
});

// Long lines must not monopolize the server.
describe("renderMarkdown on hostile line lengths", () => {
  const timed = (md: string) => {
    const start = performance.now();
    const html = renderMarkdown(md);
    return { html, ms: performance.now() - start };
  };

  test("a 100 KB line of [ and a 100 KB heading line render in under 100 ms, escaped", () => {
    const brackets = timed("[".repeat(100_000));
    expect(brackets.ms).toBeLessThan(100);
    expect(brackets.html).toBe(`<p>${"[".repeat(100_000)}</p>`);
    const heading = timed(`# a${" ".repeat(100_000)}x`);
    expect(heading.ms).toBeLessThan(100);
    expect(heading.html).toBe(`<p># a${" ".repeat(100_000)}x</p>`);
    expect(timed(`<b>${"[".repeat(LONG_LINE)}`).html).toStartWith("<p>&lt;b&gt;[[[");
  });

  test("lines just under the cutoff are matched in linear time too", () => {
    const n = LONG_LINE - 100;
    for (const md of [
      Array(10).fill("[".repeat(n)).join("\n\n"),
      Array(10).fill(`# a${" ".repeat(n)}x`).join("\n"),
      Array(10).fill("[a](https://x".repeat(Math.floor(n / 13))).join("\n\n"),
      Array(10).fill(`- ${"[a]".repeat(Math.floor(n / 3))}`).join("\n"),
      Array(10).fill(`> ${"**a*".repeat(Math.floor(n / 4))}`).join("\n"),
    ]) {
      expect(timed(md).ms).toBeLessThan(100);
    }
  });

  test("links still render, a [ inside the text starts the link after it", () => {
    expect(renderMarkdown("[a](https://example.org/x) and [b](http://example.org)")).toBe(
      '<p><a href="https://example.org/x" target="_blank" rel="noopener noreferrer">a</a> and <a href="http://example.org" target="_blank" rel="noopener noreferrer">b</a></p>',
    );
    expect(renderMarkdown("see [1](https://example.org)")).toContain('>1</a>');
    expect(renderMarkdown("[see [1](https://example.org)")).toBe('<p>[see <a href="https://example.org" target="_blank" rel="noopener noreferrer">1</a></p>');
  });

  test("parseHeading gives what the old heading regex gave, on every short line", () => {
    const OLD = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
    const alphabet = ["#", " ", "a", "\t", "\u2028"];
    const lines: string[] = [""];
    for (let len = 1; len <= 7; len++) {
      for (const prefix of lines.filter((l) => l.length === len - 1)) for (const ch of alphabet) lines.push(prefix + ch);
    }
    for (const line of [...lines, "# Title #", "## Title ##  ", "####### seven", "# a ## ##", "#\tx\t#"]) {
      const m = line.match(OLD);
      expect([line, parseHeading(line)]).toEqual([line, m ? { level: m[1].length, text: m[2] } : null]);
    }
  });
});
