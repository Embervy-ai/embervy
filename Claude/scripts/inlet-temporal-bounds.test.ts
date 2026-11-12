import { describe, expect, test } from "bun:test";
import { compileTimeWords, MAX_TEMPORAL_CHARS, parseTemporal } from "./inlet-temporal.ts";

// Cover inherited names and bounded temporal parsing work.
describe("time words: inherited names are just unknown keys", () => {
  test("constructor, toString, valueOf, hasOwnProperty, __proto__ never throw", () => {
    for (const key of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const out = compileTimeWords(JSON.parse(`{${JSON.stringify(key)}: ["x"]}`));
      expect(out.added).toBe(0);
      expect(parseTemporal("what did we say yesterday?", new Date("2026-10-07T12:00:00Z"), "UTC", out.vocabulary)?.from).toBe("2026-10-06");
    }
  });
});

describe("the time look-up stays fast on long or list-like messages", () => {
  const now = new Date("2026-10-07T12:00:00Z");
  const fast = (text: string) => { const t = performance.now(); parseTemporal(text, now, "UTC"); return performance.now() - t; };
  test("800 weekdays in a list", () => { expect(fast(Array(800).fill("monday").join(", "))).toBeLessThan(300); });
  test("2,500 weekdays", () => { expect(fast("monday, ".repeat(2_500))).toBeLessThan(300); });
  test("yesterday and 20,000 spaces", () => { expect(fast(`yesterday${" ".repeat(20_000)}`)).toBeLessThan(300); });
  test("a long paste keeps the question at its end", () => {
    const text = `${"lorem ipsum ".repeat(2_000)}\nwhat did we say yesterday?`;
    expect(text.length).toBeGreaterThan(MAX_TEMPORAL_CHARS);
    expect(parseTemporal(text, now, "UTC")?.from).toBe("2026-10-06");
  });
});
