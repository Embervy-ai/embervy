import { describe, expect, test } from "bun:test";
import { stripCitationMarks, stripCitationMarksDeep, stripCitationMarksFromArguments } from "./chatgpt-oauth-adapter.ts";

// Remove backend citation marks because private-use characters have no renderer here.

const S = "", SEP = "", E = "";
const cite = (...refs: string[]) => `${S}cite${refs.map((r) => SEP + r).join("")}${E}`;

describe("stripCitationMarks", () => {
  test("text without marks comes back unchanged", () => {
    const t = "Plain answer, with a link https://example.org and no marks.";
    expect(stripCitationMarks(t)).toBe(t);
  });

  test("a cite mark at the end of a sentence goes, the line stays", () => {
    const t = `Programs are protected.${cite("turn0search1", "turn0search14")}\n- Next point.`;
    expect(stripCitationMarks(t)).toBe("Programs are protected.\n- Next point.");
  });

  test("a cite mark inside a sentence leaves one space, not two", () => {
    expect(stripCitationMarks(`It costs 290 euros ${cite("turn0search7")} per filing.`)).toBe("It costs 290 euros per filing.");
  });

  test("several marks in one text all go", () => {
    const t = `A.${cite("turn0search0")} B.${cite("turn0search2", "turn1news3")} C.`;
    expect(stripCitationMarks(t)).toBe("A. B. C.");
  });

  test("an entity mark keeps its display name", () => {
    const t = `Written by ${S}entity${SEP}["people","Ada Lovelace",{"x":1}]${E} in 1843.`;
    expect(stripCitationMarks(t)).toBe("Written by Ada Lovelace in 1843.");
  });

  test("a broken entity mark goes without breaking the text", () => {
    expect(stripCitationMarks(`See ${S}entity${SEP}[not json${E} here.`)).toBe("See here.");
  });

  test("stray mark characters without a pair go too", () => {
    expect(stripCitationMarks(`Half${S}cite${SEP}turn0search1 open`)).toBe("Halfciteturn0search1 open");
  });
});

// Unclosed citation marks must not cause quadratic processing of long answers.
test("an unclosed mark before a long answer stays linear", () => {
  const text = "\ue200" + "x".repeat(200_000); // no separator or end: exercise the unmatched-mark path
  const t = performance.now();
  stripCitationMarks(text);
  expect(performance.now() - t).toBeLessThan(500);
});

// The model writes the marks into a tool's input too (an app reply, a mail).
describe("marks in a tool call's input", () => {
  test("string values lose their marks; keys, numbers and structure stay", () => {
    const input = { text: `Claude stays at 800k/900k.${cite("turn0search1")}`, to: ["a@example.org"], n: 3, nested: { note: `ok${cite("turn1search2")}` } };
    expect(stripCitationMarksDeep(input)).toEqual({ text: "Claude stays at 800k/900k.", to: ["a@example.org"], n: 3, nested: { note: "ok" } });
  });

  test("function_call arguments: literal marks and \\u-escaped marks both go", () => {
    const literal = JSON.stringify({ text: `Done.${cite("turn0search1")}` });
    const escaped = literal.replace(/[\ue200-\ue202]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
    expect(escaped).toContain("\\ue200");
    expect(JSON.parse(stripCitationMarksFromArguments(literal))).toEqual({ text: "Done." });
    expect(JSON.parse(stripCitationMarksFromArguments(escaped))).toEqual({ text: "Done." });
  });

  test("arguments without marks, and unparseable ones, pass as they came", () => {
    const plain = '{"text":"no marks"}';
    expect(stripCitationMarksFromArguments(plain)).toBe(plain);
    const broken = `{"text":"x${cite("turn0search1")}`;
    expect(stripCitationMarksFromArguments(broken)).toBe(broken);
    expect(stripCitationMarksFromArguments(undefined)).toBe("{}");
  });
});
