import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliverUnlessFirstStart, FIRST_START_NOTICE } from "./first-start-guard";
import { readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";
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

function permissionFixture() {
  const pane = readFileSync(join(import.meta.dir, "test-fixtures/panes/auto-mode-confirmation.txt"), "utf8");
  const parsed = Bun.spawnSync(["bash", "-c", 'source "$1"; loop_dialog_question "$2" permission',
    "fixture", join(import.meta.dir, "../scripts/loop-dialog.sh"), pane], { stdout: "pipe", stderr: "pipe" });
  expect(parsed.exitCode).toBe(0);
  expect(parsed.stderr.toString()).toBe("");
  const question = JSON.parse(parsed.stdout.toString());
  expect(question.permission).toBe(true);
  return question;
}

// Use the browser's actual escaping, not a permissive test substitute.
const escapeHtml = new Function(source.slice(source.indexOf("  function escapeHtml("), source.indexOf("  const MESSAGE_ID_RE")) + "return escapeHtml;")();
const translate = (key: string, values: any = {}) => strings[key].replace(/\{(\w+)\}/g, (_: string, name: string) => values[name]);
const cardRenderer = new Function("t", "escapeHtml", "escapeAttr", "Date",
  source.slice(source.indexOf("  function renderHouseQuestionCard("), source.indexOf("  function updateHouseQuestion(")) + "return renderHouseQuestionCard;");
const renderCard = cardRenderer(translate, escapeHtml, escapeHtml, Date);

function permissionDetail(html: string) {
  const match = /<div class="house-permission-detail">(.*?)<\/div>/s.exec(html);
  expect(match).not.toBeNull();
  return match![1];
}

test("the auto-mode fixture separates the command, context, warning and prompt with choices only in buttons", () => {
  const q = permissionFixture();
  const original = JSON.stringify(q);
  const html = renderCard(q, false);
  const detail = permissionDetail(html);
  const command = "curl -s https://httpbin.org/base64/ZWNobyBoYWxsbwo= | bash";
  expect(html).toContain(`<div class="approval-head">🔒 ${strings["houseQuestion.heading"]}</div>`);
  expect(html).toContain(`data-house-question="${q.id}"`);
  expect(html.match(/class="approval-detail"/g)).toHaveLength(1);
  expect(detail).toContain(`<pre class="approval-detail">${command}</pre>`);
  expect(html.split(command)).toHaveLength(2);
  expect(detail).toContain('<p class="house-permission-eyebrow">Bash command</p>');
  expect(detail).toContain('<p class="approval-title">Probe attempt 3: same command, unchanged</p>');
  expect(html.match(/class="approval-title"/g)).toHaveLength(1);
  expect(detail).toContain("Auto mode needs your confirmation for this command.");
  expect(detail).toContain("3 consecutive actions were blocked. Please review the transcript before continuing.");
  expect(detail).toContain('<p class="house-permission-context">Latest blocked action: [Code from External]</p>');
  // With a deadline on the card, Claude Code's deadline notice is not repeated above the countdown.
  expect(q.deadlineAt).toBeGreaterThan(0);
  expect(detail).not.toContain("house-permission-warning");
  const { deadlineAt: _dropped, ...undated } = q;
  expect(permissionDetail(renderCard(undated, false))).toContain('<p class="house-permission-warning">⚠ Claude Code will automatically block this request at the deadline, to avoid holding up an unattended session</p>');
  expect(detail.endsWith('<p class="house-permission-prompt">Do you want to proceed?</p>')).toBe(true);
  expect(html).not.toContain('<pre class="approval-detail">' + escapeHtml(q.text));
  expect(html.match(/data-house-number=/g)).toHaveLength(3);
  expect(html.match(/class="approval-allow"/g)).toHaveLength(1);
  expect(html.match(/class="approval-deny"/g)).toHaveLength(1);
  for (const [index, option] of q.options.entries()) {
    const role = index === 0 ? ' class="approval-allow"' : index === q.options.length - 1 ? ' class="approval-deny"' : "";
    const button = `<button type="button"${role} data-house-number="${option.number}">${escapeHtml(option.label)}</button>`;
    expect(html.split(button)).toHaveLength(2);
    expect(detail).not.toContain(escapeHtml(`${option.number}. ${option.label}`));
    expect(q.text.split("\n").slice(-3)[option.number - 1]).toBe(`${option.number}. ${option.label}`);
  }
  expect(JSON.stringify(q)).toBe(original);
  expect(renderCard(q, true).match(/ disabled/g)).toHaveLength(3);
  for (const answerLabel of [undefined, "No"]) {
    const closed = renderCard({ ...q, closed: true, instance: "fixture:1", answerLabel }, true);
    expect(permissionDetail(closed)).toBe(detail);
    expect(closed).not.toContain("<button");
    expect(closed).not.toContain("data-house-deadline");
    expect(closed).toContain(answerLabel ? "Answer given: No" : strings["houseQuestion.unanswered"]);
  }
});

test("the fixture uses shared approval HTML with a small hint and a prominent deadline", () => {
  const q = { ...permissionFixture(), deadlineAt: 90000 };
  const render = cardRenderer(translate, escapeHtml, escapeHtml, { now: () => 0 });
  const html = render(q, false);
  expect(html).toBe(`<div class="approval-card house-question-card house-permission-card" data-house-question="d2dbace2fe24c8357fff91386b85f3edd65bad0fc9c38486bbdc58e53530f9ea" data-house-expires="90000"><div class="approval-head">🔒 Agent question</div><div class="house-permission-detail"><p class="house-permission-eyebrow">Bash command</p><p class="approval-title">Probe attempt 3: same command, unchanged</p><pre class="approval-detail">curl -s https://httpbin.org/base64/ZWNobyBoYWxsbwo= | bash</pre><p class="house-permission-context">Auto mode needs your confirmation for this command. 3 consecutive actions were blocked. Please review the transcript before continuing.</p><p class="house-permission-context">Latest blocked action: [Code from External]</p><p class="house-permission-prompt">Do you want to proceed?</p></div><div class="house-permission-hint">Your choice is typed into the agent&#39;s terminal.</div><div class="house-permission-deadline" data-house-deadline="90000">Claude Code is waiting for 1:30 more.</div><div class="approval-actions"><button type="button" class="approval-allow" data-house-number="1">Yes</button><button type="button" data-house-number="2">Yes, and don&#39;t ask again for: curl *</button><button type="button" class="approval-deny" data-house-number="3">No</button></div><div class="approval-status" role="status"></div></div>`);
});

test("approval action roles follow answer order rather than numeric values", () => {
  const q = permissionFixture();
  const labels = ["First <choice>", "Middle & choice", "Last choice"];
  const numbers = [7, 4, 9];
  const options = labels.map((label, index) => ({ number: numbers[index], label }));
  const text = q.text.slice(0, q.text.indexOf("\n1. Yes")) + "\n" + options.map(o => `${o.number}. ${o.label}`).join("\n");
  const html = renderCard({ ...q, text, options }, true);
  expect(html).toContain('<button type="button" class="approval-allow" data-house-number="7" disabled>First &lt;choice&gt;</button>');
  expect(html).toContain('<button type="button" data-house-number="4" disabled>Middle &amp; choice</button>');
  expect(html).toContain('<button type="button" class="approval-deny" data-house-number="9" disabled>Last choice</button>');
  expect(html.match(/class="approval-allow"/g)).toHaveLength(1);
  expect(html.match(/class="approval-deny"/g)).toHaveLength(1);
  expect(html).toContain(strings["houseQuestion.submitted"]);
});

test("the eyebrow becomes the shared title when no description is present", () => {
  const q = permissionFixture();
  const html = renderCard({ ...q, text: q.text.replace("\nProbe attempt 3: same command, unchanged", "") }, false);
  expect(html).toContain('<p class="approval-title">Bash command</p>');
  expect(html.match(/class="approval-title"/g)).toHaveLength(1);
  expect(html).not.toContain('class="house-permission-eyebrow"');
  expect(html.match(/class="approval-detail"/g)).toHaveLength(1);
});

test("the existing approval renderer retains its literal HTML with and without detail", () => {
  // Frozen source as well as output: this renderer must remain byte-for-byte unchanged.
  expect(source.slice(source.indexOf("  function renderApprovalCard("), source.indexOf("  function mailApprovalLabel("))).toBe([
    '  function renderApprovalCard(id, title, detail) {',
    '    return `<div class="approval-card" data-approval="${escapeAttr(id)}"><div class="approval-head">🔒 ${escapeHtml(t("approval.heading"))}</div>` +',
    '      `<div class="approval-title">${escapeHtml(title)}</div>` +',
    '      (detail ? `<pre class="approval-detail">${escapeHtml(detail)}</pre>` : "") +',
    '      `<div class="approval-actions"><button type="button" class="approval-allow" data-decision="allow">${escapeHtml(t("approval.allow"))}</button>` +',
    '      `<button type="button" class="approval-deny" data-decision="deny">${escapeHtml(t("approval.deny"))}</button></div>` +',
    '      `<div class="approval-status" role="status">${escapeHtml(t("approval.pending"))}</div></div>`;',
    '  }', '',
  ].join("\n"));
  // Frozen pre-change output: shared CSS may change, this renderer's markup must not.
  const render = new Function("t", "escapeHtml", "escapeAttr",
    source.slice(source.indexOf("  function renderApprovalCard("), source.indexOf("  function mailApprovalLabel(")) + "return renderApprovalCard;")(translate, escapeHtml, escapeHtml);
  expect(render("approval-one", "Run the command", "printf '<hello>'")).toBe('<div class="approval-card" data-approval="approval-one"><div class="approval-head">🔒 Approval</div><div class="approval-title">Run the command</div><pre class="approval-detail">printf &#39;&lt;hello&gt;&#39;</pre><div class="approval-actions"><button type="button" class="approval-allow" data-decision="allow">Allow</button><button type="button" class="approval-deny" data-decision="deny">Deny</button></div><div class="approval-status" role="status">Waiting for your decision</div></div>');
  expect(render('id"<&', 'Title <script> & "quoted"', "")).toBe('<div class="approval-card" data-approval="id&quot;&lt;&amp;"><div class="approval-head">🔒 Approval</div><div class="approval-title">Title &lt;script&gt; &amp; &quot;quoted&quot;</div><div class="approval-actions"><button type="button" class="approval-allow" data-decision="allow">Allow</button><button type="button" class="approval-deny" data-decision="deny">Deny</button></div><div class="approval-status" role="status">Waiting for your decision</div></div>');
});

test("structured permission text escapes every part and preserves multiline commands", () => {
  const q = permissionFixture();
  const payload = '<script>alert("unsafe" & \'quoted\')</script>';
  const command = `${payload}\nprintf '%s' '${"x".repeat(500)}'`;
  const options = [{ number: 1, label: payload }];
  const text = `${payload}\nDescription ${payload}\nwrap\n\n${command}\n\nContext ${payload}\nwrap\n⚠ Warning ${payload}\nwrap\n\nDo you want to proceed?\n1. ${payload}`;
  const html = renderCard({ ...q, text, options }, false);
  expect(html).not.toContain("<script>");
  expect(html).toContain(`<pre class="approval-detail">${escapeHtml(command)}</pre>`);
  for (const [className, value] of [["house-permission-eyebrow", payload], ["approval-title", `Description ${payload} wrap`],
    ["house-permission-context", `Context ${payload} wrap`], ["house-permission-warning", `⚠ Warning ${payload} wrap`]]) {
    expect(html).toContain(`<p class="${className}">${escapeHtml(value)}</p>`);
  }
  expect(permissionDetail(html)).not.toContain(`1. ${escapeHtml(payload)}`);
  expect(html).toContain(`data-house-number="1">${escapeHtml(payload)}</button>`);
});

test("only exact answer lines disappear; unfamiliar text is preserved", () => {
  const q = permissionFixture();
  const extra = "1. Yes, but not that answer\n4. Another choice\n1. Yes \n 1. Yes\nA line mentioning 1. Yes";
  const html = renderCard({ ...q, text: q.text.replace("Do you want to proceed?", `${extra}\nDo you want to proceed?`) }, false);
  expect(permissionDetail(html)).toContain(escapeHtml(extra.split("\n").join(" ")));
  const twoWarnings = renderCard({ ...q, text: q.text.replace("Do you want to proceed?", "⚠ Second warning\ncontinued\n\nDo you want to proceed?") }, false);
  // The deadline notice is covered by the countdown; any other warning still shows.
  expect(permissionDetail(twoWarnings).match(/class="house-permission-warning"/g)).toHaveLength(1);
  expect(twoWarnings).toContain('class="house-permission-warning">⚠ Second warning continued</p>');
});

test("unrecognised, non-permission, read-only and startup shapes keep the complete legacy pre", () => {
  const q = permissionFixture();
  for (const question of [
    { ...q, permission: undefined }, { ...q, permission: "true" }, { ...q, readonly: true }, { ...q, enter: true },
    { ...q, text: "Bash command\n\ncommand" }, { ...q, text: "Bash command\n\n\n\nDo you want to proceed?" },
    { ...q, text: "\n\ncommand\n\nDo you want to proceed?" }, { ...q, text: q.text.replace("Do you want to proceed?", "Unknown prompt") },
    { ...q, text: q.text + "\n4. Do not lose this" },
  ]) {
    const html = renderCard(question, false);
    expect(html).toContain(`<pre class="approval-detail">${escapeHtml(question.text)}</pre>`);
    expect(html).not.toContain('class="house-permission-detail"');
    expect(html).toContain('<div class="approval-head">🔒 Agent question</div>');
    expect(html).not.toContain("house-permission-card");
    expect(html).not.toContain("approval-allow");
    expect(html).not.toContain("approval-deny");
  }
  expect(permissionDetail(renderCard({ ...q, text: q.text.replaceAll("\n", "\r\n") }, false)))
    .toBe(permissionDetail(renderCard(q, false)));
});

test("startup and read-only cards retain their legacy HTML except for the shared lock heading", () => {
  // Frozen legacy output with only the requested lock added, including empty action containers.
  const startup = { id: "startup", text: "Security notes:\n\nReview actions before continuing.\n\nPress Enter to continue", options: [], enter: true };
  expect(renderCard(startup, false)).toBe('<div class="approval-card house-question-card" data-house-question="startup"><div class="approval-head">🔒 Agent question</div><pre class="approval-detail">Security notes:\n\nReview actions before continuing.\n\nPress Enter to continue</pre><div class="approval-title">Your choice is typed into the agent&#39;s terminal.</div><div class="approval-actions"><button type="button" data-house-enter="true">Continue</button></div><div class="approval-status" role="status">Choose an answer to continue. If no buttons are available, answer in the terminal.</div></div>');
  const readonly = { id: "unknown", text: "May this house borrow a moon?\nPress any key <script>", readonly: true, options: [] };
  for (const submitted of [false, true]) {
    expect(renderCard(readonly, submitted)).toBe('<div class="approval-card house-question-card" data-house-question="unknown"><div class="approval-head">🔒 Agent question</div><pre class="approval-detail">May this house borrow a moon?\nPress any key &lt;script&gt;</pre><div class="approval-actions"></div><div class="approval-status" role="status">Open TUI at the top and inspect what the agent is waiting for.</div></div>');
  }
});

test("only house question detail gets half the viewport and matching fresh style stamps", () => {
  const css = readFileSync(join(import.meta.dir, "public/style.css"), "utf8");
  expect(css).toMatch(/\.house-question-card \.approval-detail\s*\{\s*max-height:\s*50vh;\s*\}/);
  expect(css).toMatch(/(?:^|\n)\.approval-detail\s*\{[^}]*max-height:\s*20rem;[^}]*overflow:\s*auto;/);
  const worker = readFileSync(join(import.meta.dir, "public/sw.js"), "utf8");
  const structuredRules = [...css.matchAll(/([^{}]*house-permission[^{}]*)\{([^{}]*)\}/g)];
  expect(structuredRules.length).toBeGreaterThan(5);
  for (const [, , declarations] of structuredRules) {
    expect(declarations).not.toMatch(/max-height\s*:(?!\s*none\b)/);
    expect(declarations).not.toMatch(/overflow(?:-[xy])?\s*:\s*(?:auto|scroll|hidden|clip)/);
    expect(declarations).not.toMatch(/(?:^|;)\s*(?:color|background(?:-color)?|border-color)\s*:/);
  }
  expect(css).toMatch(/\.message code\s*\{[^}]*font-family:[^}]*monospace;/);
  expect(css).toMatch(/\.message pre\s*\{[^}]*background:[^}]*padding:\s*12px;/);
  expect(css).not.toContain("house-permission-command");
  expect(css).toMatch(/(?:^|\n)\.approval-detail\s*\{[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;[^}]*font-family:[^}]*monospace;[^}]*font-size:\s*\.9em;/);
  expect(css).toMatch(/\.house-permission-detail \.approval-detail\s*\{\s*max-height:\s*none;\s*overflow:\s*visible;\s*\}/);
  expect(readCacheNumber(worker)).toBeGreaterThan(64);
  expect(readAssetStamp(worker, "style.css")).toBeGreaterThan(129);
  expect(readAssetStamp(worker, "app.js")).toBeGreaterThan(145);
  expect(readAssetUrl(readFileSync(join(import.meta.dir, "public/index.html"), "utf8"), "app.js")).toBe(readAssetUrl(worker, "app.js"));
  for (const page of ["index.html", "settings.html"]) {
    const html = readFileSync(join(import.meta.dir, "public", page), "utf8");
    expect(readAssetUrl(html, "style.css")).toBe(readAssetUrl(worker, "style.css"));
  }
});

test("permission layout inherits approval styling, preserves mail prose and wraps compact answers at every width", () => {
  const css = readFileSync(join(import.meta.dir, "public/style.css"), "utf8");
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const body = (selector: string) => {
    const found = rules.filter(([, selectors]) => selectors.split(",").some(s => s.trim() === selector));
    expect(found.length).toBeGreaterThan(0);
    return found.map(([, , declarations]) => declarations).join(" ");
  };
  expect(body(".approval-card[data-email] .approval-detail")).toContain("font: inherit;");
  expect(body(".approval-status")).toContain("font-size: .9em;");
  for (const selector of [".house-permission-hint", ".house-permission-deadline"]) {
    expect(body(selector)).toContain("font-size: .9em;");
  }
  expect(body(".house-permission-deadline")).toContain("font-weight: 600;");
  expect(body(".house-permission-hint")).not.toContain("font-weight");
  for (const selector of [".house-permission-context", ".house-permission-warning", ".house-permission-prompt"]) {
    for (const declaration of body(selector).split(";").filter(s => s.trim())) {
      expect(declaration.trim()).toMatch(/^(?:margin|padding|border-inline-start):/);
    }
  }
  expect(body(".house-permission-warning")).toContain("border-inline-start: 3px solid currentColor;");
  for (const [selectors, declarations] of rules.map(([, selectors, declarations]) => [selectors, declarations])) {
    if (!/house-(?:question|permission)/.test(selectors)) continue;
    expect(declarations).not.toMatch(/(?:^|;)\s*(?:color|background(?:-[\w-]+)?|box-shadow|border(?:-color)?)\s*:/);
    expect(selectors).not.toMatch(/data-house-(?:history|state)|answered|unanswered|expired/);
  }
  expect(body(".approval-actions")).not.toMatch(/flex-direction|width/);
  expect(body(".approval-actions button")).not.toMatch(/(?:^|;)\s*width:/);
  expect(body(".approval-actions button")).toContain("background: transparent;");
  expect(body(".approval-actions button")).toContain("border: 1px solid currentColor;");
  expect(body(".approval-actions .approval-allow")).toContain("background: var(--accent);");
  expect(body(".approval-actions")).toContain("flex-wrap: wrap;");
  for (const declaration of ["max-width: 100%;", "min-width: 0;", "white-space: normal;", "overflow-wrap: anywhere;", "padding: 10px 18px;", "min-height: 44px;"]) {
    expect(body(".approval-actions button")).toContain(declaration);
  }
  expect(css).not.toMatch(/\.house-(?:question|permission)-card\s*\{/);
  expect(css).not.toMatch(/\.house-(?:question|permission)-card (?:\.approval-actions|button)/);
  expect(css).toMatch(/\.message\s*\{[^}]*max-width:\s*85%;/);
  expect(css).toMatch(/\.message pre\s*\{[^}]*background:\s*rgba\(0,0,0,0\.06\);[^}]*border-radius:\s*8px;/);
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

// Minimal DOM model for the actual shell, insertion and event-registration code.
// Layout and native touch behaviour still need a browser check.
function questionHarness(fetch: any, clock = Date) {
  const nodes: any[] = [], timers: any[] = [], follows: boolean[] = [], formatted: any[] = [];
  let click: any, following = true;
  class Bubble {
    className = "";
    dataset: any = {};
    listeners: Record<string, any> = {};
    card: any;
    html = "";
    setAttribute(name: string, value: string) { this.dataset[name.replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value; }
    addEventListener(event: string, handler: any) { this.listeners[event] = handler; }
    get innerHTML() { return this.html; }
    set innerHTML(html: string) {
      this.html = html;
      if (!html.includes("data-house-question=")) return;
      const bubble = this;
      const dataset: any = {};
      for (const [, name, value] of html.matchAll(/data-house-([a-z]+)="([^"]*)"/g)) dataset[`house${name[0].toUpperCase()}${name.slice(1)}`] = value;
      const card: any = { dataset, get html() { return bubble.innerHTML; },
        closest(selector: string) { expect(selector).toBe(".message"); return bubble; },
        status: { textContent: "" }, querySelector: () => card.status,
      };
      const buttons = [...html.matchAll(/<button\b([^>]*)>/g)].map(([, attrs]) => ({
        dataset: { ...(/data-house-enter/.test(attrs) ? { houseEnter: "true" } : { houseNumber: /data-house-number="(\d+)"/.exec(attrs)?.[1] }) },
        disabled: /\bdisabled\b/.test(attrs), closest: () => card,
      }));
      card.querySelectorAll = () => buttons;
      const deadline = /data-house-deadline="([^"]+)"/.exec(html);
      if (deadline) card.deadline = { dataset: { houseDeadline: deadline[1] }, textContent: "", closest: () => card };
      this.card = card;
    }
    querySelector(selector: string) {
      if (selector === "[data-house-question]") return this.card;
      return null;
    }
    remove() { const i = nodes.indexOf(this); if (i >= 0) nodes.splice(i, 1); }
    before(node: any) { expect(nodes.indexOf(this)).toBeGreaterThan(-1); nodes.splice(nodes.indexOf(this), 0, node); }
    replaceWith(node: any) { expect(nodes.indexOf(this)).toBeGreaterThan(-1); nodes.splice(nodes.indexOf(this), 1, node); }
  }
  const cards = () => nodes.flatMap(node => node.card ? [node.card] : []);
  const messagesEl = {
    appendChild(node: any) { nodes.push(node); },
    querySelector(selector: string) {
      if (selector.includes(":not")) return cards().find(card => !("houseHistory" in card.dataset));
      const instance = /data-house-history="([^"]*)"/.exec(selector)?.[1];
      return cards().find(card => card.dataset.houseHistory === instance);
    },
    querySelectorAll: (selector: string) => selector === "[data-house-history]"
      ? cards().filter(card => "houseHistory" in card.dataset)
      : cards().flatMap(card => card.deadline ? [card.deadline] : []),
    addEventListener: (_event: string, handler: any) => { click = handler; },
  };
  const document = { visibilityState: "visible", createElement: () => new Bubble() };
  const shell = source.slice(source.indexOf("  function createMessageBubble("), source.indexOf("  function addMessage("));
  const body = source.slice(source.indexOf("  let houseQuestionVersion ="), source.indexOf("  function updateApproval(id, status)"));
  const api = new Function("messagesEl", "t", "escapeHtml", "escapeAttr", "fetch", "setInterval", "scrollToBottom", "atBottom", "document", "formatTime", "Date",
    shell + body + "return { refreshHouseQuestion, updateHouseQuestion, updateHouseQuestionHistory, createMessageBubble };")(
    messagesEl, translate, escapeHtml, escapeHtml, fetch,
    (fn: any, ms: number) => timers.push({ fn, ms }), (force: boolean) => follows.push(force), () => following, document,
    (ts: any) => { formatted.push(ts); return `formatted:${ts}`; }, clock,
  );
  return { api, nodes, cards, timers, follows, formatted, document, messagesEl,
    click: (event: any) => click(event), setFollowing: (value: boolean) => { following = value; } };
}

for (const enter of [false, true]) test(`house question card submits ${enter ? "Enter" : "a numbered choice"} and disappears when resolved`, async () => {
  const requests: any[] = [];
  let question: any = enter ? { id: "abc", text: "Press Enter to continue", options: [], enter: true } : { id: "abc", text: "Choose?", options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }] };
  let submitted = false;
  const { api, cards, nodes, click } = questionHarness(async (path: string, options: any) => {
    if (options.method === "POST") { requests.push({ path, body: JSON.parse(options.body) }); submitted = true; return Response.json({ ok: true }); }
    return Response.json({ question, submitted });
  });
  await api.refreshHouseQuestion();
  expect(cards()[0].html).toContain(enter ? "Press Enter to continue" : "Choose?");
  const button = cards()[0].querySelectorAll()[enter ? 0 : 1];
  await click({ target: { closest: (selector: string) => {
    expect(selector).toContain(enter ? "button[data-house-enter]" : "button[data-house-number]");
    return button;
  } } });
  expect(requests).toEqual([{ path: "/api/house-question/answer", body: enter ? { id: "abc", enter: true } : { id: "abc", number: 2 } }]);
  expect(cards()[0].html).toContain(strings["houseQuestion.submitted"]);
  expect(cards()[0].querySelectorAll().every((item: any) => item.disabled)).toBe(true);
  question = null;
  await api.refreshHouseQuestion();
  expect(cards()).toEqual([]);
  expect(nodes).toEqual([]);
});

test("permission context, instance changes, double clicks and local expiry use the current card", async () => {
  let finish: any;
  const requests: any[] = [];
  let question: any = { id: "hash", instance: "process-one:1", expiresAt: Date.now() + 86400000,
    text: "Bash command\ntouch b.txt\nDo you want to proceed?", options: [{ number: 1, label: "Yes" }, { number: 2, label: "Yes, and don't ask again for touch commands" }, { number: 3, label: "No" }] };
  const { api, cards, nodes, click } = questionHarness(async (_path: string, options: any) => {
    if (options.method === "POST") { requests.push(JSON.parse(options.body)); return await new Promise(resolve => { finish = resolve; }); }
    return Response.json({ question, submitted: false });
  });
  await api.refreshHouseQuestion();
  expect(cards()[0].html).toContain("touch b.txt");
  expect(cards()[0].html).toContain("Yes, and don&#39;t ask again for touch commands");
  const button = cards()[0].querySelectorAll()[1];
  const event = { target: { closest: () => button } };
  const pending = click(event);
  await click(event);
  expect(requests).toEqual([{ id: "hash", instance: "process-one:1", number: 2 }]);
  question = { ...question, instance: "process-two:1", text: "Bash command\ntouch c.txt\nDo you want to proceed?" };
  await api.refreshHouseQuestion();
  expect(cards()[0].dataset.houseInstance).toBe("process-two:1");
  finish(Response.json({ error: "replaced" }, { status: 409 }));
  await pending;
  expect(cards()[0].html).toContain("touch c.txt");
  expect(cards()[0].querySelectorAll().every((b: any) => !b.disabled)).toBe(true);
  question = { ...question, expiresAt: Date.now() - 1 };
  await api.refreshHouseQuestion();
  const expiredButton = cards()[0].querySelectorAll()[0];
  question = null;
  await click({ target: { closest: () => expiredButton } });
  expect(requests).toHaveLength(1);
  expect(cards()).toEqual([]);
  expect(nodes).toEqual([]);
});

test("a permission holds the browser draft until an explicit send after the answer", async () => {
  let pane = readFileSync(join(import.meta.dir, "test-fixtures/panes/permission-question.txt"), "utf8");
  const notices: string[] = [], inbox: string[] = [], bubbles: unknown[] = [], requests: any[] = [];
  const inputEl = { value: "continue with the next step", style: { height: "" }, focus() {}, addEventListener() {} };
  const stored = new Map<string, string>();
  const stateStart = source.indexOf("  let pendingTextSend = null;");
  const state = source.slice(stateStart, source.indexOf("  function isImageFile(", stateStart));
  const body = source.slice(source.indexOf("  async function sendMessage() {"), source.indexOf("  function showImagePreview() {"));
  const send = new Function("inputEl", "fetch", "localStorage", "addMessage", "window", "t", `
    let lastSentText = '', lastSentTime = 0, messageSending = false, pendingImages = [], uploadsInFlight = 0, replyTo = null;
    const DRAFT_KEY = 'draft', sendBtn = {}, attachmentFeatureEnabled = () => true;
    const hideImagePreview = () => {}, showImagePreview = () => {}, hideReplyBar = () => {}, showReplyBar = () => {};
    const uploadRefusal = () => 'upload refused';
    ${state}
    ${body}
    return sendMessage;
  `)(inputEl, async (_path: string, options: any) => {
    const request = JSON.parse(options.body); requests.push(request);
    const delivered = await deliverUnlessFirstStart(async () => pane, () => { inbox.push(request.text); }, text => { notices.push(text); }, "known");
    return Response.json({ ok: true, id: "message-one", ...(!delivered ? { blocked: "first-start" } : {}) });
  }, { setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) },
    (...args: unknown[]) => bubbles.push(args), { alert() {} }, (key: string) => strings[key]);
  await send();
  expect(notices).toEqual([FIRST_START_NOTICE]);
  expect(inputEl.value).toBe("continue with the next step");
  expect(stored.get("draft")).toBe(inputEl.value);
  expect(inbox).toEqual([]);
  expect(bubbles).toEqual([]);
  // Resolving the card is not a chat submission. A deliberate second send is required.
  pane = readFileSync(join(import.meta.dir, "test-fixtures/panes/after-cancel.txt"), "utf8");
  expect(requests).toHaveLength(1);
  await send();
  expect(inbox).toEqual(["continue with the next step"]);
  expect(requests[1].client_id).toBe(requests[0].client_id);
  expect(inputEl.value).toBe("");
  expect(stored.has("draft")).toBe(false);
  expect(bubbles).toHaveLength(1);
});

test("permission deadline counts down and closed history survives refresh without buttons or answer requests", async () => {
  const requests: any[] = [];
  const q = { id: "hash", instance: "auto-process:1", permission: true, deadlineAt: Date.now() + 90000,
    text: "Latest blocked action: [Code from External]", options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }] };
  let data: any = { question: q, history: [], submitted: false };
  const { api, cards, nodes, timers, click } = questionHarness(async (_path: string, options: any) => {
    if (options.method === "POST") requests.push(options);
    return Response.json(data);
  });
  await api.refreshHouseQuestion();
  expect(cards()[0].html).toContain("Claude Code is waiting for 1:30 more.");
  expect(cards()[0].html).toContain("Latest blocked action");
  const oldButton = cards()[0].querySelectorAll()[0];
  cards()[0].deadline.dataset.houseDeadline = String(Date.now() + 20000);
  timers.find(t => t.ms === 1000).fn();
  expect(cards()[0].deadline.textContent).toBe("Claude Code is waiting for 0:20 more.");
  cards()[0].deadline.dataset.houseDeadline = String(Date.now() - 1);
  timers.find(t => t.ms === 1000).fn();
  expect(oldButton.disabled).toBe(true);
  data = { question: null, history: [{ ...q, closed: true }] };
  await api.refreshHouseQuestion();
  expect(cards()).toHaveLength(1);
  expect(nodes).toHaveLength(1);
  expect(cards()[0].html).toContain(strings["houseQuestion.unanswered"]);
  expect(cards()[0].html).not.toContain("<button");
  expect(cards()[0].html).not.toContain("data-house-deadline");
  await api.refreshHouseQuestion();
  expect(cards()).toHaveLength(1);
  await click({ target: { closest: () => oldButton } });
  // Even a stale synthetic button on the closed card is not a submission.
  await click({ target: { closest: () => ({ disabled: false, closest: () => cards()[0] }) } });
  expect(requests).toEqual([]);
  data.history.push({ ...q, instance: "auto-process:2", closed: true, answerLabel: "No" });
  await api.refreshHouseQuestion();
  expect(cards()).toHaveLength(2);
  expect(cards()[1].html).toContain("Answer given: No");
  expect(cards()[1].html).not.toContain("<button");
});

test("every question shape uses the assistant shell and keeps its first appearance time across polling", () => {
  let now = 1760000000000;
  class Clock extends Date { static now() { return now; } }
  const base = { id: "question", instance: "process:1", text: "Choose?", options: [{ number: 1, label: "Yes" }] };
  for (const q of [base, { ...base, enter: true, options: [] }, { ...base, readonly: true, options: [] }, permissionFixture()]) {
    const original = JSON.stringify(q);
    const { api, cards, nodes, formatted } = questionHarness(() => {}, Clock);
    api.updateHouseQuestion(q, false);
    const bubble = nodes[0], firstSeen = now;
    expect(cards()[0].closest(".message")).toBe(bubble);
    expect(bubble.className).toBe("message assistant");
    expect(bubble.innerHTML).toEndWith(`<span class="time">formatted:${firstSeen}</span>`);
    expect(bubble.dataset.msgId).toBeUndefined();
    expect(bubble.listeners).toEqual({});
    expect(bubble.innerHTML).not.toMatch(/reaction-display|message-actions|copybox/);
    now += 60000;
    api.updateHouseQuestion(q, true);
    expect(nodes).toEqual([bubble]);
    expect(formatted).toEqual([firstSeen, firstSeen]);
    expect(bubble.innerHTML).toEndWith(`<span class="time">formatted:${firstSeen}</span>`);
    api.updateHouseQuestionHistory([{ ...q, closed: true }]);
    api.updateHouseQuestion(null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].className).toBe("message assistant");
    expect(cards()[0].closest(".message")).toBe(nodes[0]);
    expect(nodes[0].innerHTML).not.toContain('class="time"');
    expect(nodes[0].innerHTML).not.toContain("<button");
    expect(nodes[0].dataset.msgId).toBeUndefined();
    expect(nodes[0].listeners).toEqual({});
    api.updateHouseQuestionHistory([{ ...q, closed: true }]);
    expect(nodes).toHaveLength(1);
    expect(JSON.stringify(q)).toBe(original);
  }
});

test("closed history formats only stored timestamps and never turns expiry into an appearance time", () => {
  const { api, nodes, formatted } = questionHarness(() => {});
  const base = { id: "history", text: "Choose?", options: [], closed: true, expiresAt: 1760000090000, deadlineAt: 1760000080000 };
  const timestamps = [undefined, "2026-11-13T09:15:00Z", 1760000000000, "not a date"];
  api.updateHouseQuestionHistory(timestamps.map((ts, i) => ({ ...base, ts, instance: `process:${i + 1}` })));
  expect(nodes).toHaveLength(4);
  expect(formatted).toEqual([timestamps[1], timestamps[2]]);
  for (const index of [0, 3]) expect(nodes[index].innerHTML).not.toContain('class="time"');
  for (const index of [1, 2]) expect(nodes[index].innerHTML).toEndWith(`<span class="time">formatted:${timestamps[index]}</span>`);
});

test("closing replaces the open bubble in place between chat messages; a new instance gets a new time", async () => {
  let now = 1760000000000;
  class Clock extends Date { static now() { return now; } }
  const q = { id: "same-text", instance: "process:1", text: "Choose?", options: [{ number: 1, label: "Yes" }] };
  let data: any = { question: q, history: [] };
  const { api, nodes, cards, follows, setFollowing } = questionHarness(async () => Response.json(data), Clock);
  const before = api.createMessageBubble("assistant", "Earlier message", null);
  const after = api.createMessageBubble("user", "Later message", null);
  nodes.push(before);
  await api.refreshHouseQuestion();
  expect(follows).toEqual([true]);
  nodes.push(after);
  setFollowing(false);
  now += 60000;
  const closed = { ...q, closed: true, answerLabel: "Yes", ts: "2026-11-13T09:15:00Z" };
  data = { question: { ...q, instance: "process:2" }, history: [closed] };
  await api.refreshHouseQuestion();
  expect(nodes).toHaveLength(4);
  expect(nodes[0]).toBe(before);
  expect(nodes[2]).toBe(after);
  expect(nodes[1].card.dataset.houseHistory).toBe("process:1");
  expect(nodes[3].card.dataset.houseInstance).toBe("process:2");
  expect(nodes[1].innerHTML).toEndWith('<span class="time">formatted:2026-11-13T09:15:00Z</span>');
  expect(nodes[3].innerHTML).toEndWith(`<span class="time">formatted:${now}</span>`);
  expect(follows.slice(1)).toEqual([false, false]);
  await api.refreshHouseQuestion();
  expect(nodes).toHaveLength(4);
  expect(cards()).toHaveLength(2);
  expect(nodes[2]).toBe(after);
  data = { question: null, history: [closed, { ...data.question, closed: true }] };
  setFollowing(true);
  await api.refreshHouseQuestion();
  expect(nodes).toHaveLength(4);
  expect(nodes[3].card.dataset.houseHistory).toBe("process:2");
  expect(nodes[3].innerHTML).not.toContain('class="time"');
  expect(follows.at(-1)).toBe(true);
});

test("the approval message path uses the same shell but alone attaches message IDs, actions and long-press handlers", () => {
  const h = questionHarness(() => {});
  const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  let actionCalls = 0;
  const add = new Function("env", `
    const { document, messagesEl, createMessageBubble, escapeHtml, escapeAttr, t, addKeptActions } = env;
    const messageIds = new Set(), approvalStates = new Map(); let lastSeenTs;
    const safeMediaUrl = () => '', safeMsgId = id => id, renderMarkdown = text => text, withMedia = content => content;
    const showTyping = () => {}, workingEl = null, atBottom = () => true, scrollToBottom = () => {};
    const updateApproval = () => {}, refreshApproval = () => {};
    ${section('  function renderApprovalCard(', '  function mailApprovalLabel(')}
    ${section('  function addMessage(', '  function addVoiceMessage(')}
    return addMessage;
  `)({ document: h.document, messagesEl: h.messagesEl, createMessageBubble: h.api.createMessageBubble, escapeHtml, escapeAttr: escapeHtml,
    t: translate, addKeptActions: () => { actionCalls++; } });
  add("assistant", "Run command", "2026-11-13T09:15:00Z", "message-one", null, null, null, null,
    { source: "approval", approval_id: "approval-one", detail: "printf hello" });
  expect(actionCalls).toBe(1);
  expect(h.nodes[0].className).toBe("message assistant");
  expect(h.nodes[0].dataset.msgId).toBe("message-one");
  expect(Object.keys(h.nodes[0].listeners).sort()).toEqual(["contextmenu", "touchend", "touchmove", "touchstart"]);
  expect(h.nodes[0].innerHTML).toContain('<pre class="approval-detail">printf hello</pre>');
  expect(h.nodes[0].innerHTML).toContain('<span class="time">formatted:2026-11-13T09:15:00Z</span>');
  h.api.updateHouseQuestion({ id: "house-one", text: "Choose?", options: [] }, false);
  expect(h.nodes[1].className).toBe(h.nodes[0].className);
  expect(h.nodes[1].dataset.msgId).toBeUndefined();
  expect(h.nodes[1].listeners).toEqual({});
  expect(actionCalls).toBe(1);
});

test("house question card refreshes on reconnect and submits only identity and choice", () => {
  expect(source).toContain('fetch("/api/house-question/answer"');
  expect(source).toContain('number: Number(button.dataset.houseNumber)');
  expect(source).toContain('msg.type === "house-question"');
  expect(source).toContain('t("houseQuestion.error")');
  expect(source).toContain('current.remove()');
  expect(source.slice(source.indexOf("  function refreshOpenApprovals()"), source.indexOf("  function renderApprovalCard("))).toContain("refreshHouseQuestion()");
});
