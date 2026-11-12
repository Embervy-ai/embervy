import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Measure before appending so incoming replies follow readers at the bottom.
test("both message renderers read the bottom before appending", () => {
  const src = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");
  const follows = src.match(/const wasAtBottom = atBottom\(\);\s*messagesEl\.appendChild\(div\);\s*scrollToBottom\(role === "user" \|\| wasAtBottom\);/g) ?? [];
  expect(follows.length).toBe(2);
  expect(src).not.toMatch(/messagesEl\.appendChild\(div\);\s*scrollToBottom\(role === "user"\);/);
});
