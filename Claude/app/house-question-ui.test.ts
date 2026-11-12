import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const source = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
const strings = JSON.parse(readFileSync(join(import.meta.dir, "strings/en.json"), "utf8"));

test("house question card uses translated copy and escaped dialog options", () => {
  const start = source.indexOf("  function renderHouseQuestionCard(");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("  function updateHouseQuestion(", start);
  const escape = (s: string) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  const used: string[] = [];
  const render = new Function("t", "escapeHtml", "escapeAttr", source.slice(start, end) + "return renderHouseQuestionCard;")((key: string) => { used.push(key); expect(typeof strings[key]).toBe("string"); return strings[key]; }, escape, escape);
  const html = render({ id: "abc", text: "Question <script>", options: [{ number: 1, label: "<img>" }, { number: 2, label: "No" }] }, false);
  expect(html).toContain("approval-card");
  expect(html).toContain("Question &lt;script>");
  expect(html).toContain("&lt;img>");
  expect(html.match(/data-house-number=/g)).toHaveLength(2);
  expect(used).toContain("houseQuestion.terminal");
  expect(used).toContain("houseQuestion.heading");
  expect(render({ id: "abc", text: "Question", options: [{ number: 1, label: "Yes" }] }, true)).toContain("disabled");
});

test("Enter card renders one translated button and no numbered choice", () => {
  const start = source.indexOf("  function renderHouseQuestionCard(");
  const end = source.indexOf("  function updateHouseQuestion(", start);
  const used: string[] = [];
  const render = new Function("t", "escapeHtml", "escapeAttr", source.slice(start, end) + "return renderHouseQuestionCard;")((key: string) => {
    used.push(key);
    expect(typeof strings[key]).toBe("string");
    return `translated:${strings[key]}`;
  }, String, String);
  const q = { id: "abc", text: "Press Enter to continue", options: [], enter: true };
  const html = render(q, false);
  expect(html.match(/<button\b/g)).toHaveLength(1);
  expect(html).toContain("data-house-enter");
  expect(html).not.toContain("data-house-number");
  expect(html).toContain(`>translated:${strings["houseQuestion.continue"]}</button>`);
  expect(used).toContain("houseQuestion.continue");
  expect(render(q, true)).toContain("disabled");
  expect(render({ ...q, enter: undefined }, false)).not.toContain("<button");
});

test("read-only unknown card has no buttons and only terminal guidance", () => {
  const start = source.indexOf("  function renderHouseQuestionCard(");
  const end = source.indexOf("  function updateHouseQuestion(", start);
  const escape = (s: string) => String(s).replaceAll("<", "&lt;");
  const render = new Function("t", "escapeHtml", "escapeAttr", source.slice(start, end) + "return renderHouseQuestionCard;")((key: string) => strings[key], escape, escape);
  const q = { id: "unknown", text: "May this house borrow a moon?\nPress any key <script>", readonly: true, options: [] };
  for (const submitted of [false, true]) {
    const html = render(q, submitted);
    expect(html).not.toContain("<button");
    expect(html).not.toContain(strings["houseQuestion.terminal"]);
    expect(html).not.toContain(strings["houseQuestion.submitted"]);
    expect(html).toContain(strings["houseQuestion.waiting"]);
    expect(html).toContain("Press any key &lt;script>");
  }
});

for (const enter of [false, true]) test(`house question card submits ${enter ? "Enter" : "a numbered choice"} and disappears when resolved`, async () => {
  let card: any = null, click: any;
  const requests: any[] = [];
  let question: any = enter ? { id: "abc", text: "Press Enter to continue", options: [], enter: true } : { id: "abc", text: "Choose?", options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }] };
  let submitted = false;
  const messagesEl = {
    querySelector: () => card,
    insertAdjacentHTML: (_where: string, html: string) => { card = makeCard(html); },
    addEventListener: (_event: string, handler: any) => { click = handler; },
  };
  function makeCard(html: string): any {
    const buttons = (enter ? [{ houseEnter: "true" }] : [1, 2].map(number => ({ houseNumber: String(number) }))).map(dataset => ({ disabled: submitted, dataset, closest: () => card }));
    return {
      html, dataset: { houseQuestion: "abc" }, status: { textContent: "" },
      querySelectorAll: () => buttons,
      querySelector() { return this.status; },
      remove() { card = null; },
      set outerHTML(value: string) { card = makeCard(value); },
    };
  }
  const start = source.indexOf("  let houseQuestionVersion =");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("  function updateApproval(id, status)", start);
  const api = new Function("messagesEl", "t", "escapeHtml", "escapeAttr", "fetch", "setInterval", "scrollToBottom", "document", source.slice(start, end) + "return { refreshHouseQuestion, updateHouseQuestion };")(
    messagesEl, (key: string) => strings[key], String, String,
    async (path: string, options: any) => {
      if (options.method === "POST") { requests.push({ path, body: JSON.parse(options.body) }); submitted = true; return Response.json({ ok: true }); }
      return Response.json({ question, submitted });
    }, () => {}, () => {}, { visibilityState: "visible" },
  );
  await api.refreshHouseQuestion();
  expect(card.html).toContain(enter ? "Press Enter to continue" : "Choose?");
  const button = card.querySelectorAll()[enter ? 0 : 1];
  await click({ target: { closest: (selector: string) => {
    expect(selector).toContain(enter ? "button[data-house-enter]" : "button[data-house-number]");
    return button;
  } } });
  expect(requests).toEqual([{ path: "/api/house-question/answer", body: enter ? { id: "abc", enter: true } : { id: "abc", number: 2 } }]);
  expect(card.html).toContain(strings["houseQuestion.submitted"]);
  expect(card.querySelectorAll().every((item: any) => item.disabled)).toBe(true);
  question = null;
  await api.refreshHouseQuestion();
  expect(card).toBeNull();
});

test("house question card refreshes on reconnect and submits only id and option number", () => {
  expect(source).toContain('fetch("/api/house-question/answer"');
  expect(source).toContain('number: Number(button.dataset.houseNumber)');
  expect(source).toContain('msg.type === "house-question"');
  expect(source).toContain('t("houseQuestion.error")');
  expect(source).toContain('card.remove()');
  expect(source.slice(source.indexOf("  function refreshOpenApprovals()"), source.indexOf("  function renderApprovalCard("))).toContain("refreshHouseQuestion()");
});
