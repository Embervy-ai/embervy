import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ansiToHtml } from "./ansi";
import { DEFAULT_LOG_LABELS, formatToolInput, lineDiff, renderBrainConversation, renderClaudeSession, type LogLabels } from "./terminal-log";

const red = (text: string) => `\x1b[31m- ${text}\x1b[0m`;
const green = (text: string) => `\x1b[32m+ ${text}\x1b[0m`;
const dim = (text: string) => `\x1b[2m  ${text}\x1b[0m`;
const options = { names: { self: "assistant", user: "user" } };

function body(input: unknown, labels?: Partial<LogLabels>): string {
  const entries = renderClaudeSession([JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "edit", name: "Edit", input },
  ] } })], { ...options, labels });
  const tool = entries.find((entry) => entry.kind === "tool");
  if (!tool || tool.kind !== "tool") throw new Error("Missing tool body");
  return tool.body;
}

describe("line diff", () => {
  test("a middle replacement keeps context and collapses both outer runs", () => {
    const before = ["a", "b", "c", "d", "e", "old", "f", "g", "h", "i", "j"];
    const after = [...before];
    after[5] = "new";
    expect(lineDiff(before.join("\n"), after.join("\n"))).toBe([
      dim("⋯ 3 unchanged lines"), dim("d"), dim("e"), red("old"), green("new"),
      dim("f"), dim("g"), dim("⋯ 3 unchanged lines"),
    ].join("\n"));
  });

  test("pure insertion has no removed empty line", () => {
    expect(lineDiff("", "first\nsecond")).toBe([green("first"), green("second")].join("\n"));
    expect(lineDiff("first\nlast", "first\ninserted\nlast")).toBe([
      dim("first"), green("inserted"), dim("last"),
    ].join("\n"));
  });

  test("pure deletion and empty inputs do not invent lines", () => {
    expect(lineDiff("first\nsecond", "")).toBe([red("first"), red("second")].join("\n"));
    expect(lineDiff("", "")).toBe("");
    expect(lineDiff("same", "same")).toBe(dim("⋯ 1 unchanged line"));
  });

  test("every coloured line carries its own reset", () => {
    const diff = lineDiff("a\nb\nc\nd\nold\ne\nf\ng\nh", "a\nb\nc\nd\nnew\ne\nf\ng\nh");
    for (const line of diff.split("\n")) {
      expect(line).toMatch(/^\x1b\[(2|31|32)m/);
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  test("large unmatched ranges fall back to all removed then all added lines, shared lines stay context", () => {
    const oldMiddle = Array.from({ length: 501 }, (_, i) => `old ${i}`);
    const newMiddle = Array.from({ length: 501 }, (_, i) => `new ${i}`);
    expect(lineDiff(["start", ...oldMiddle, "end"].join("\n"), ["start", ...newMiddle, "end"].join("\n"))).toBe([
      dim("start"), ...oldMiddle.map(red), ...newMiddle.map(green), dim("end"),
    ].join("\n"));
  });

  test("LCS retains matching lines between separate changes", () => {
    expect(lineDiff("old\na\nb\nc\nd\ne\nf\nlast", "new\na\nb\nc\nd\ne\nf\nnext")).toBe([
      red("old"), green("new"), dim("a"), dim("b"), dim("⋯ 2 unchanged lines"),
      dim("e"), dim("f"), red("last"), green("next"),
    ].join("\n"));
  });

  test("custom context and singular and plural labels are used", () => {
    const labels = { ...DEFAULT_LOG_LABELS, unchangedLine: "kept row", unchangedLines: "kept rows" };
    expect(lineDiff("a\nold\nb\nc", "a\nnew\nb\nc", labels, 0)).toBe([
      dim("⋯ 1 kept row"), red("old"), green("new"), dim("⋯ 2 kept rows"),
    ].join("\n"));
  });
});

describe("edit bodies", () => {
  test("an edit retains other fields without raw pair keys", () => {
    const result = body({ file_path: "file.ts", old_string: "old", new_string: "new", replace_all: true });
    expect(result).toBe(`file_path: file.ts\nreplace_all: true\nChange:\n${red("old")}\n${green("new")}`);
    expect(result).not.toContain("old_string");
    expect(result).not.toContain("new_string");
  });

  test("multiple edits are numbered and retain per-edit fields", () => {
    expect(body({ file_path: "file.ts", edits: [
      { old_string: "a", new_string: "b", replace_all: false },
      { old_string: "c", new_string: "d" },
    ] })).toBe(`file_path: file.ts\nChange 1:\nreplace_all: false\n${red("a")}\n${green("b")}\nChange 2:\n${red("c")}\n${green("d")}`);
    expect(formatToolInput({ edits: [{ old_string: "a", new_string: "b" }] })).toBe(`Change 1:\n${red("a")}\n${green("b")}`);
  });

  test("non-edit input stays byte for byte unchanged", () => {
    expect(formatToolInput({ file_path: "file.ts", content: "first\nsecond", enabled: false, config: { count: 2 } })).toBe(
      'file_path: file.ts\ncontent:\nfirst\nsecond\nenabled: false\nconfig: {\n  "count": 2\n}',
    );
    expect(formatToolInput(null)).toBe("");
    expect(formatToolInput("first\nsecond")).toBe('"first\\nsecond"');
    expect(formatToolInput([1, 2])).toBe("[\n  1,\n  2\n]");
  });

  test("incomplete pairs and mixed edit arrays retain their original rendering", () => {
    for (const input of [
      { old_string: "a", new_string: 1 },
      { edits: [] },
      { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c" }] },
    ]) {
      const expected = Object.entries(input).map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`).join("\n");
      expect(formatToolInput(input)).toBe(expected);
    }
  });

  test("an edit does not drop unrelated edits metadata", () => {
    expect(formatToolInput({ old_string: "a", new_string: "b", edits: "metadata" })).toBe(
      `edits: metadata\nChange:\n${red("a")}\n${green("b")}`,
    );
  });

  test("custom labels reach both transcript renderers", () => {
    const labels = { change: "patch", changeNumber: "patch [{n}]", unchangedLine: "kept row", unchangedLines: "kept rows" };
    const pair = { old_string: "a\nb\nc\nold\nd\ne\nf\ng", new_string: "a\nb\nc\nnew\nd\ne\nf\ng" };
    const result = body(pair, labels);
    expect(result).toContain("patch:\n");
    expect(result).toContain("⋯ 1 kept row");
    expect(result).toContain("⋯ 2 kept rows");
    const entries = renderBrainConversation([JSON.stringify({ role: "assistant", tool_calls: [
      { id: "edit", function: { name: "MultiEdit", arguments: JSON.stringify({ edits: [pair, pair] }) } },
    ] })], { ...options, labels });
    const tool = entries.find((entry) => entry.kind === "tool");
    if (!tool || tool.kind !== "tool") throw new Error("Missing tool body");
    expect(tool.body).toContain("patch [1]:\n");
    expect(tool.body).toContain("patch [2]:\n");
    expect(tool.body).toContain("⋯ 1 kept row");
  });

  test("body HTML keeps red green and dim styles on independently rendered lines", () => {
    const result = body({ old_string: "same\n<old>", new_string: "same\n<new>" });
    const html = result.split("\n").map(ansiToHtml).join("<br>");
    expect(html).toBe('Change:<br><span style="opacity:.65">  same</span><br><span style="color:#cd3131">- &lt;old&gt;</span><br><span style="color:#0dbc79">+ &lt;new&gt;</span>');
    const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(source).toContain('body_html: entry.body.split("\\n").map(ansiToHtml).join("<br>")');
  });

  test("truncation prefers a complete line in the last fifth of the limit", () => {
    const input = { old_string: Array.from({ length: 200 }, () => "x".repeat(90)).join("\n"), new_string: "replacement" };
    const full = formatToolInput(input);
    const end = full.lastIndexOf("\n", 12000);
    expect(end).toBeGreaterThanOrEqual(9600);
    expect(body(input)).toBe(`${full.slice(0, end)}\n… (${full.length} characters in total, truncated)`);
    for (const line of body(input).split("\n").filter((line) => line.startsWith("\x1b"))) {
      expect(line.endsWith("\x1b[0m")).toBe(true);
    }
  });

  test("a long unbroken non-edit body keeps the character cutoff and note", () => {
    const input = { content: "x".repeat(13000) };
    const full = formatToolInput(input);
    expect(body(input)).toBe(`${full.slice(0, 12000)}\n… (${full.length} characters in total, truncated)`);
  });

  test("a cutoff inside a reset leaves a complete coloured line", () => {
    const input = { old_string: "x".repeat(11983), new_string: "new" };
    const full = formatToolInput(input);
    expect(full.slice(11998, 12002)).toBe("\x1b[0m");
    expect(body(input)).toBe(`${full.slice(0, 11998)}\x1b[0m\n… (${full.length} characters in total, truncated)`);
  });
});
