import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
const start = SOURCE.indexOf("  function renderMarkdown(text) {");
const end = SOURCE.indexOf("  const approvalStates = new Map();");
if (start < 0 || end < start) throw new Error("renderMarkdown not found");
const renderMarkdown = new Function("location", `${SOURCE.slice(start, end)}\nreturn renderMarkdown;`)(
  { origin: "https://app.example" },
) as (text: string) => string;

// Use the same HTML tokenizer as the message security tests, not a tag regex.
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
  p: [], br: [], strong: [], em: [], pre: [], code: [],
  div: ["class"], table: ["class"], thead: [], tbody: [], tr: [], th: ["class"], td: ["class"],
  button: ["type", "class", "aria-label"], img: ["src", "alt", "class", "loading"],
  a: ["href", "target", "rel"],
};
const CLASSES: Record<string, string[]> = {
  div: ["markdown-table-scroll", "copybox"], table: ["markdown-table"],
  th: ["ta-left", "ta-center", "ta-right"], td: ["ta-left", "ta-center", "ta-right"],
  button: ["copybox-btn"], img: ["chat-image"],
};
async function expectSafe(html: string) {
  expect(html).not.toContain("\u0000");
  const els = await elements(html);
  for (const el of els) {
    expect(Object.hasOwn(ALLOWED, el.tag)).toBe(true);
    for (const name of Object.keys(el.attrs)) {
      expect(ALLOWED[el.tag]).toContain(name);
      expect(name.toLowerCase().startsWith("on")).toBe(false);
    }
    if (el.attrs.class !== undefined) expect(CLASSES[el.tag] ?? []).toContain(el.attrs.class);
    if (el.tag === "a") {
      expect(el.attrs.href).not.toMatch(/["'\s<>]|^javascript:/i);
      expect(el.attrs.target).toBe("_blank");
      expect(el.attrs.rel).toBe("noopener noreferrer");
    }
  }
  return els;
}

const wrap = (head: string, body = "") =>
  `<div class="markdown-table-scroll"><table class="markdown-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
const row = (tag: "th" | "td", values: string[], align: string[] = []) =>
  `<tr>${values.map((value, i) => `<${tag} class="ta-${align[i] || "left"}">${value}</${tag}>`).join("")}</tr>`;
const simple = "| Name | Count |\n| --- | --- |\n| First | 1 |\n| Second | 2 |";
const simpleHtml = wrap(row("th", ["Name", "Count"]), row("td", ["First", "1"]) + row("td", ["Second", "2"]));

describe("message tables", () => {
  test("a header and two rows have the exact block structure", async () => {
    expect(renderMarkdown(simple)).toBe(simpleHtml);
    expect((await elements(simpleHtml)).map(e => e.tag)).toEqual([
      "div", "table", "thead", "tr", "th", "th", "tbody", "tr", "td", "td", "tr", "td", "td",
    ]);
  });

  test("all three alignments use fixed classes on header and body cells", async () => {
    const html = renderMarkdown("Left | Center | Right\n:--- | :---: | ---:\na | b | 12.50\nc | d | 7");
    const align = ["left", "center", "right"];
    expect(html).toBe(wrap(row("th", ["Left", "Center", "Right"], align),
      row("td", ["a", "b", "12.50"], align) + row("td", ["c", "d", "7"], align)));
    await expectSafe(html);
  });

  test.each([
    "A | B\n--- | ---\n1 | 2",
    "| A | B |\n|---|---|\n|1|2|",
    "| A | B\n|---|---\n|1|2",
    "A | B |\n---|---|\n1|2|",
    "  | A | B |  \r\n | --- | --- | \r\n | 1 | 2 | ",
  ])("outer delimiters and row whitespace are optional: %j", md => {
    expect(renderMarkdown(md)).toBe(wrap(row("th", ["A", "B"]), row("td", ["1", "2"])));
  });

  test("empty first, middle, and last cells are not discarded", () => {
    expect(renderMarkdown("| | A | B |\n|---|---|---|\n| 1 | | |"))
      .toBe(wrap(row("th", ["", "A", "B"]), row("td", ["1", "", ""])));
    expect(renderMarkdown("||A||\n|---|---|---|\n|||"))
      .toBe(wrap(row("th", ["", "A", ""]), row("td", ["", "", ""])));
  });

  test("short single-column form accepts a header-only table", () => {
    expect(renderMarkdown("| A |\n|---|" )).toBe(wrap(row("th", ["A"])));
    expect(renderMarkdown("| A |\n---\n| 1 |" )).toBe(wrap(row("th", ["A"]), row("td", ["1"])));
  });

  test("missing cells are padded and extra cells remain left aligned", () => {
    expect(renderMarkdown("| A | B |\n|---|---:|\n| 1 |\n| 2 | 3 | 4 |"))
      .toBe(wrap(row("th", ["A", "B"], ["left", "right"]),
        row("td", ["1", ""], ["left", "right"]) + row("td", ["2", "3", "4"], ["left", "right", "left"])));
    expect(renderMarkdown("| A |\n|---|---:|\n| 1 |"))
      .toBe(wrap(row("th", ["A", ""], ["left", "right"]), row("td", ["1", ""], ["left", "right"])));
    expect(renderMarkdown("| A | B |\n|---|\n| 1 |"))
      .toBe(wrap(row("th", ["A", "B"]), row("td", ["1", ""])));
  });

  test("text on both sides stays in paragraphs without requiring blank lines", () => {
    expect(renderMarkdown(`Before.\nStill before.\n${simple}\nAfter.\nStill after.`))
      .toBe(`<p>Before.<br>Still before.</p>${simpleHtml}<p>After.<br>Still after.</p>`);
    expect(renderMarkdown(`${simple}\n\nordinary | text`)).toBe(`${simpleHtml}<p>ordinary | text</p>`);
    expect(renderMarkdown(`${simple}\nplain\nordinary | text`)).toBe(`${simpleHtml}<p>plain<br>ordinary | text</p>`);
  });

  test("two tables remain separate blocks", () => {
    expect(renderMarkdown(`${simple}\n\n${simple}`)).toBe(simpleHtml + simpleHtml);
    expect(renderMarkdown(`${simple}\nBetween.\n${simple}`)).toBe(`${simpleHtml}<p>Between.</p>${simpleHtml}`);
  });

  test("cells use the existing inline rules, including images and bare addresses", async () => {
    const values = ["**bold**", "__bold__", "*quiet*", "`<literal> **code**`", "[link](https://example.test/a?b=1&c=2)",
      "https://example.test/path.", "![local](/api/images/p.png)"];
    const html = renderMarkdown(`| ${values.join(" | ")} |\n| ${values.map(() => "---").join(" | ")} |`);
    expect(html).toBe(wrap(row("th", values.map(value => renderMarkdown(value).slice(3, -4)))));
    await expectSafe(html);
  });

  test("escaped pipes and pipes inside inline code do not split cells", () => {
    expect(renderMarkdown("| A\\|B | `C|D` |\n|---|---|\n| x\\|y | `z|q` |"))
      .toBe(wrap(row("th", ["A|B", "<code>C|D</code>"]), row("td", ["x|y", "<code>z|q</code>"])));
    expect(renderMarkdown("A | B\\|\n---|---\n1 | 2\\|"))
      .toBe(wrap(row("th", ["A", "B|"]), row("td", ["1", "2|"])));
    expect(renderMarkdown("| A | B |\n|---|---|\n| x\\\\|y |"))
      .toBe(wrap(row("th", ["A", "B"]), row("td", ["x\\\\", "y"])));
  });

  test("pipe-containing link labels and addresses can be escaped", async () => {
    const html = renderMarkdown("| [a\\|b](https://example.test/a\\|b) | value |\n|---|---|");
    expect(html).toContain('<th class="ta-left"><a href="https://example.test/a|b" target="_blank" rel="noopener noreferrer">a|b</a></th>');
    await expectSafe(html);
  });

  test.each([
    ["a | b\nc | d", "<p>a | b<br>c | d</p>"],
    ["|---|---|", "<p>|---|---|</p>"],
    ["| A | B |\n|--|---|", "<p>| A | B |<br>|--|---|</p>"],
    ["| A | B |\n|---||", "<p>| A | B |<br>|---||</p>"],
    ["| A | B |\n|- - -|---|", "<p>| A | B |<br>|- - -|---|</p>"],
    ["| A | B |\n\n|---|---|", "<p>| A | B |</p><p>|---|---|</p>"],
    ["`a|b`\n---", "<p><code>a|b</code><br>---</p>"],
    ["a\\|b\n---", "<p>a\\|b<br>---</p>"],
  ])("non-tables keep their exact output: %j", (md, expected) => {
    expect(renderMarkdown(md)).toBe(expected);
  });

  test("a fenced table stays text and cannot be consumed as a table row", async () => {
    const code = `<div class="copybox"><button type="button" class="copybox-btn" aria-label="Copy">Copy</button><pre><code>${simple}</code></pre></div>`;
    expect(renderMarkdown(`\`\`\`md\n${simple}\n\`\`\``)).toBe(code);
    const html = renderMarkdown(`${simple}\n\`\`\`md\n${simple}\n\`\`\``);
    expect(html).toBe(simpleHtml + code);
    expect((await expectSafe(html)).filter(e => e.tag === "table")).toHaveLength(1);
    expect(renderMarkdown(`\`\`\`md\n${simple}\n\`\`\` | x\n|---|---|`)).not.toContain("<table");
  });

  test("non-table markup and paragraph whitespace retain exact output", () => {
    expect(renderMarkdown("  *one\ntwo* \n\n__three__ <four> & five  "))
      .toBe("<p><em>one<br>two</em></p><p><strong>three</strong> &lt;four&gt; &amp; five</p>");
    expect(renderMarkdown("Before `x|y` and \\| after."))
      .toBe("<p>Before <code>x|y</code> and \\| after.</p>");
    expect(renderMarkdown("\n\n")).toBe("");
  });
});

describe("table safety and bounded scanning", () => {
  test("hostile cell contents cannot introduce tags, attributes, or classes", async () => {
    const payloads = [
      '<script>alert(1)</script>', '" onmouseover="alert',
      '[link](/ok" onmouseover="alert)', '[link](javascript:alert)',
      '![" onerror="alert](/image.png)', '<td class="foreign">x</td>',
      '`<img src=x onerror=alert>`', '**" class="foreign**',
      '\u00000\u0000 [x](/safe)', '&lt;script&gt;alert&lt;/script&gt;',
    ];
    for (const payload of payloads) {
      const html = renderMarkdown(`| ${payload} | safe |\n|:---|---:|\n| safe | ${payload} |`);
      const els = await expectSafe(html);
      expect(els.filter(e => e.tag === "table")).toHaveLength(1);
      expect(els.filter(e => e.tag === "th")).toHaveLength(2);
      expect(els.filter(e => e.tag === "td")).toHaveLength(2);
    }
    expect(renderMarkdown('| [x](/ok" onmouseover="alert) |\n|---|')).toContain('href="#"');
  });

  test.each(['|---: ta-right|---|', '|---:" class="foreign|---|', '|---:<script>|---|', '|---:;color:red|---|'])
    ("a separator cannot inject a class: %j", async separator => {
      const html = renderMarkdown(`| A | B |\n${separator}\n| 1 | 2 |`);
      expect(html).not.toContain("<table");
      await expectSafe(html);
    });

  test("cell boundaries cannot carry markup into neighboring cells", async () => {
    const html = renderMarkdown('| [x | y](/path) | ** | * |\n|---|---|---|---|\n| [ | ](https://example.test) | ** | * |');
    await expectSafe(html);
    expect((await elements(html)).filter(e => e.tag === "td")).toHaveLength(4);
    expect((await elements(html)).filter(e => e.tag === "a")).toHaveLength(1);
    expect(html).toContain('<td class="ta-left">](<a href="https://example.test" target="_blank" rel="noopener noreferrer">https://example.test</a>)</td>');
  });

  test("mixed hostile fragments cannot escape table cells", async () => {
    const fragments = ["<script>", "</td>", '" onmouseover="x', "&", "![", "[", "](/x)",
      "`", "**", "*", "|", "\\|", "https://example.test", "\u00000\u0000", "](/x\"bad)"];
    let seed = 19;
    const pick = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return fragments[seed % fragments.length];
    };
    for (let i = 0; i < 250; i++) {
      const cell = Array.from({ length: 8 }, pick).join("");
      await expectSafe(renderMarkdown(`| Header | Value |\n|---|---:|\n| ${cell} | ${cell} |`));
    }
  });

  test("a table with 200 rows and long delimiter lines complete promptly", async () => {
    const md = "| Name | Count |\n|:---|---:|\n" + Array.from({ length: 200 }, (_, i) => `| Row ${i} | ${i} |`).join("\n");
    const started = performance.now();
    const html = renderMarkdown(md);
    const wide = renderMarkdown("| A |\n|" + "-".repeat(5000) + "|\n| value |");
    const pipes = renderMarkdown("|".repeat(5000));
    const manyCells = renderMarkdown("| A |\n|---|\n" + "|".repeat(5000));
    const invalidPipes = renderMarkdown("| A |\n" + "|".repeat(5000));
    const invalid = renderMarkdown("| A |\n|" + "-".repeat(5000) + "x|");
    expect(performance.now() - started).toBeLessThan(1500);
    expect((await elements(html)).filter(e => e.tag === "tr")).toHaveLength(201);
    expect(wide).toBe(wrap(row("th", ["A"]), row("td", ["value"])));
    expect(pipes).toBe(`<p>${"|".repeat(5000)}</p>`);
    expect(manyCells).toBe(wrap(row("th", ["A"]), row("td", Array(4999).fill(""))));
    expect(invalidPipes).not.toContain("<table");
    expect(invalid).not.toContain("<table");
  });
});

test("table styles bound overflow in chat and saved message containers", () => {
  const css = readFileSync(join(import.meta.dir, "public/style.css"), "utf8");
  const rule = (selector: string) => {
    const from = css.indexOf(selector + " {");
    expect(from).toBeGreaterThanOrEqual(0);
    return css.slice(from, css.indexOf("}", from) + 1);
  };
  expect(rule(".message")).toContain("min-width: 0");
  expect(rule(".message")).toContain("max-width: 85%");
  expect(rule(".message .markdown-table-scroll")).toContain("overflow-x: auto");
  expect(rule(".message .markdown-table-scroll")).toContain("max-width: 100%");
  const cells = rule(".message .markdown-table td");
  expect(cells).toContain("min-width: 3rem");
  expect(cells).toContain("overflow-wrap: break-word");
  expect(cells).toContain("word-break: normal");
  expect(cells).toContain("var(--border)");
  expect(rule(".message .markdown-table th")).toContain("var(--shadow)");
  expect(rule(".message .markdown-table .ta-right")).toContain("tabular-nums");
  expect(rule("#kept-dialog")).toContain("calc(100% - 24px)");
  expect(rule("#kept-dialog .kept-content")).toContain("max-width: 100%");
  expect(SOURCE).toContain('content.innerHTML = renderMarkdown(entry.text)');
});

test("a swipe that starts in a sideways-scrolling part of a message does not open a panel", () => {
  const from = SOURCE.indexOf("  function startsInSidewaysScroller(target) {");
  const to = SOURCE.indexOf("  let terminalTouchX = null;", from);
  expect(from).toBeGreaterThanOrEqual(0);
  class FakeElement {
    constructor(public cls: string, public parentElement: FakeElement | null, public scrollWidth = 100, public clientWidth = 100, public overflowX = "visible") {}
    closest(selector: string): FakeElement | null {
      for (let el: FakeElement | null = this; el; el = el.parentElement) if ("." + el.cls === selector) return el;
      return null;
    }
  }
  const starts = new Function("Element", "getComputedStyle", `${SOURCE.slice(from, to)}\nreturn startsInSidewaysScroller;`)(
    FakeElement, (el: FakeElement) => ({ overflowX: el.overflowX }),
  ) as (target: unknown) => boolean;
  const message = new FakeElement("message", null);
  const wide = new FakeElement("markdown-table-scroll", message, 477, 272, "auto");
  const fits = new FakeElement("markdown-table-scroll", message, 272, 272, "auto");
  expect(starts(new FakeElement("cell", wide))).toBe(true);
  expect(starts(new FakeElement("cell", fits))).toBe(false);
  expect(starts(new FakeElement("text", message))).toBe(false);
  // Outside a message (the terminal panel) an overflowing area keeps the swipe.
  const terminal = new FakeElement("terminal-scroll", null, 900, 300, "auto");
  expect(starts(new FakeElement("line", terminal))).toBe(false);
  expect(starts(null)).toBe(false);
  expect(SOURCE).toContain("if (startsInSidewaysScroller(event.target)) { terminalTouchX = terminalTouchY = null; return; }");
});
