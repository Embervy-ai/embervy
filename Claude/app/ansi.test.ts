import { describe, expect, test } from "bun:test";
import { ansiToHtml } from "./ansi";

describe("ansiToHtml", () => {
  test("renders 16-color foreground and reset", () => {
    expect(ansiToHtml("a\x1b[31mred\x1b[0mz")).toBe('a<span style="color:#cd3131">red</span>z');
    expect(ansiToHtml("\x1b[94mblue")).toContain("color:#3b8eea");
  });
  test("renders 256 colors", () => {
    const html = ansiToHtml("\x1b[38;5;196mred\x1b[48;5;244m bg");
    expect(html).toContain("color:rgb(255,0,0)");
    expect(html).toContain("background-color:rgb(128,128,128)");
  });
  test("supports nested style changes, bold, dim and invert", () => {
    const html = ansiToHtml("\x1b[1;31mA\x1b[2;7mB\x1b[22;27mC");
    expect(html).toContain("font-weight:700");
    expect(html).toContain("opacity:.65");
    expect(html).toContain("background-color:#cd3131");
    expect(html.endsWith('<span style="color:#cd3131">C</span>')).toBe(true);
  });
  test("escapes terminal text before styling", () => {
    const html = ansiToHtml("\x1b[32m<script x='1'>&\"</script>");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script x=&#39;1&#39;&gt;&amp;&quot;&lt;/script&gt;");
  });
  test("strips OSC titles, links and non-SGR cursor sequences", () => {
    const input = "safe\x1b]0;<img src=x>\x07A\x1b[2J\x1b[H" + "\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\Z";
    expect(ansiToHtml(input)).toBe("safeAlinkZ");
  });
  test("strips 8-bit C1 OSC, DCS, PM and APC payloads through BEL or ST", () => {
    expect(ansiToHtml("A\u009d0;SECRET\u0007B")).toBe("AB");
    expect(ansiToHtml("A\u0090DCS\u009cB")).toBe("AB");
    expect(ansiToHtml("A\u009ePRIVATE\x1b\\B")).toBe("AB");
    expect(ansiToHtml("A\u009fAPP\u009cB")).toBe("AB");
  });
});
