import { describe, expect, test } from "bun:test";
import { harness } from "./terminal-open.test";
import { questionHarness, renderCard } from "./house-question-ui.test";

const items = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ key: `k${from + i}`, html: `line ${from + i}` }));
const page = (mode: string, from: number, to: number, more = true, offset = 200) => ({
  lines: mode === "log" ? items(from, to) : items(from, to).map(item => item.html),
  nextBefore: more ? `k${from}` : null, nextOffset: more ? offset : null,
});
const hint = (h: ReturnType<typeof harness>) => h.byId("terminal-history-state").textContent;

for (const mode of ["log", "tui"]) describe(`automatic terminal history in ${mode} mode`, () => {
  test("short output loads sequential pages until the viewport overflows and follows the newest line", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    expect(hint(h)).toBe("");
    h.frame(items(100, 102));
    expect(h.fetches).toHaveLength(1);
    expect(hint(h)).toBe("Loading older output…");
    h.scroll.fire("scroll");
    h.frame(items(100, 102));
    expect(h.fetches).toHaveLength(1);
    h.fetches[0].resolve(page(mode, 98, 100));
    await h.settle();
    expect(h.fetches).toHaveLength(2);
    expect(h.fetches[1].url).toContain(mode === "log" ? "before=k98" : "offset=200");
    h.fetches[1].resolve(page(mode, 60, 98, true, 400));
    await h.settle();
    expect(h.fetches).toHaveLength(2);
    expect(h.output.lines()).toEqual(items(60, 102).map(item => item.html));
    expect(h.scroll.atNewest).toBe(true);
    expect(hint(h)).toBe("Scroll up for older output");
  });

  test("showing the hint keeps the newest line visible without paging an already filled view", async () => {
    const h = harness(mode);
    h.scroll.hint = h.byId("terminal-history-state");
    h.app.openTerminal();
    h.frame(items(100, 120));
    expect(hint(h)).toBe("Scroll up to load older output");
    expect(h.scroll.atNewest).toBe(true);
    h.scroll.fire("scroll");
    h.paint();
    await h.settle();
    expect(h.fetches).toHaveLength(0);
    expect(h.scroll.atNewest).toBe(true);
  });

  test("content exactly as tall as the viewport still loads older output", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.frame(items(100, 119));
    expect(h.scroll.scrollHeight).toBe(h.scroll.clientHeight);
    expect(h.fetches).toHaveLength(1);
    h.fetches[0].resolve(page(mode, 99, 100));
    await h.settle();
    expect(h.scroll.scrollHeight).toBeGreaterThan(h.scroll.clientHeight);
    expect(h.fetches).toHaveLength(1);
    expect(h.scroll.atNewest).toBe(true);
  });

  test("programmatic scroll events cannot bypass the eight-page limit after filling the view", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.scroll.fire("pointerdown");
    h.frame(items(100, 102));
    for (let n = 0; n < 7; n++) {
      h.fetches[n].resolve(page(mode, 99 - n, 100 - n, true, (n + 1) * 200));
      await h.settle();
    }
    h.fetches[7].resolve(page(mode, 82, 93, true, 1600));
    await h.settle();
    expect(h.scroll.scrollTop).toBe(20);
    h.scroll.fire("scroll");
    h.paint();
    expect(h.fetches).toHaveLength(8);
    h.scroll.fire("wheel");
    h.scroll.scrollTop = 0;
    h.scroll.fire("scroll");
    expect(h.fetches).toHaveLength(9);
  });

  test("a failure after a successful page ends the sequence and only shows an error when scrollable", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.frame(items(100, 102));
    h.fetches[0].resolve(page(mode, 90, 100));
    await h.settle();
    expect(h.fetches).toHaveLength(2);
    h.fetches[1].fail();
    await h.settle();
    expect(hint(h)).toBe("");
    h.frame(items(100, 150));
    await h.settle();
    expect(hint(h)).toBe("Older output unavailable");
    h.scroll.scrollTop = 0;
    h.scroll.fire("scroll");
    expect(h.fetches).toHaveLength(2);
  });

  test("a final short page hides the hint and stops subsequent frames from paging", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.frame(items(100, 102));
    h.fetches[0].resolve(page(mode, 98, 100, false));
    await h.settle();
    expect(hint(h)).toBe("");
    h.frame(items(100, 102));
    h.paint();
    h.scroll.fire("scroll");
    expect(h.fetches).toHaveLength(1);
  });

  test("eight pages exhaust the automatic budget until human input, including across frames", async () => {
    const h = harness(mode);
    h.scroll.clientHeight = 10000;
    h.app.openTerminal();
    h.frame(items(100, 102));
    for (let n = 0; n < 8; n++) {
      expect(h.fetches).toHaveLength(n + 1);
      h.fetches[n].resolve(page(mode, 99 - n, 100 - n, true, (n + 1) * 200));
      await h.settle();
    }
    h.frame(items(100, 102));
    h.paint();
    h.panel.fire("transitionend");
    h.scroll.fire("scroll");
    expect(h.fetches).toHaveLength(8);
    expect(hint(h)).toBe("");
    h.scroll.fire("wheel");
    expect(h.fetches).toHaveLength(9);
  });

  for (const failure of ["empty", "http", "network", "no progress"]) test(`${failure} stops automatic retries on later frames`, async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.frame(items(100, 102));
    if (failure === "http") h.fetches[0].fail();
    else if (failure === "network") h.fetches[0].reject();
    else if (failure === "empty") h.fetches[0].resolve(page(mode, 100, 100));
    else h.fetches[0].resolve(mode === "log" ? page(mode, 100, 102) : page(mode, 98, 100, true, 0));
    await h.settle();
    h.frame(items(100, 102));
    h.paint();
    h.scroll.fire("scroll");
    await h.settle();
    expect(h.fetches).toHaveLength(1);
    expect(hint(h)).toBe("");
    if (failure === "no progress" && mode === "log") expect(h.output.lines()).toHaveLength(2);
    if (failure === "http" || failure === "network") {
      h.scroll.fire("pointerdown");
      expect(h.fetches).toHaveLength(2);
    }
  });

  test("closed views neither request nor apply older output", async () => {
    const h = harness(mode);
    h.frame(items(100, 102));
    h.scroll.fire("scroll");
    h.scroll.fire("wheel");
    expect(h.fetches).toHaveLength(0);
    h.app.openTerminal();
    h.frame(items(100, 102));
    h.app.closeTerminal();
    h.fetches[0].resolve(page(mode, 90, 100));
    await h.settle();
    h.frame(items(100, 102));
    h.paint();
    expect(h.output.lines()).toEqual(items(100, 102).map(item => item.html));
    expect(h.fetches).toHaveLength(1);
  });

  test("reopening during a pending request does not overlap requests or apply stale data", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.frame(items(100, 102));
    h.app.closeTerminal();
    h.app.openTerminal();
    h.frame(items(100, 102));
    expect(h.fetches).toHaveLength(1);
    h.fetches[0].resolve(page(mode, 50, 100));
    await h.settle();
    expect(h.output.lines()).toEqual(items(100, 102).map(item => item.html));
    expect(h.fetches).toHaveLength(2);
    h.fetches[1].resolve(page(mode, 99, 100, false));
    await h.settle();
    expect(h.output.lines()).toEqual(items(99, 102).map(item => item.html));
  });

  test("filled output only pages on upward scrolling and keeps the reader's line", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.frame(items(100, 150));
    h.paint();
    expect(h.fetches).toHaveLength(0);
    expect(hint(h)).toBe("Scroll up to load older output");
    h.readTo(40);
    const oldHeight = h.scroll.scrollHeight;
    h.fetches[0].resolve(page(mode, 50, 100));
    await h.settle();
    expect(h.scroll.scrollTop).toBe(40 + h.scroll.scrollHeight - oldHeight);
    expect(h.scroll.atNewest).toBe(false);
    expect(h.fetches).toHaveLength(1);
  });

  test("an automatic page respects a reader who moves while the request is pending", async () => {
    const h = harness(mode);
    h.scroll.clientHeight = 2000;
    h.app.openTerminal();
    h.frame(items(100, 150));
    expect(h.fetches).toHaveLength(1);
    h.scroll.clientHeight = 400;
    h.readTo(100);
    const oldHeight = h.scroll.scrollHeight;
    h.fetches[0].resolve(page(mode, 50, 100));
    await h.settle();
    h.paint();
    expect(h.scroll.scrollTop).toBe(100 + h.scroll.scrollHeight - oldHeight);
    expect(h.scroll.atNewest).toBe(false);
    expect(h.fetches).toHaveLength(1);
  });

  test("a subsequent short frame starts paging after an initially filled frame", async () => {
    const h = harness(mode);
    h.app.openTerminal();
    h.frame(items(100, 150));
    expect(h.fetches).toHaveLength(0);
    h.frame(items(148, 150));
    expect(h.fetches).toHaveLength(1);
  });
});

const permission = {
  id: "permission", instance: "session:1", permission: true,
  text: "Bash command\n\nprintf hello\n\nDo you want to proceed?",
  options: [{ number: 1, label: "Yes" }, { number: 2, label: "Yes, and don't ask again for: printf *" }, { number: 3, label: "No" }],
};

test("the lasting rule answer has its own secondary row, exact explanatory text and unchanged response", async () => {
  const requests: any[] = [];
  const h = questionHarness(async (path: string, options: any) => {
    if (options.method === "POST") requests.push({ path, body: JSON.parse(options.body) });
    return Response.json({ question: permission, submitted: false });
  });
  await h.api.refreshHouseQuestion();
  const html = h.cards()[0].html;
  const rows = [...html.matchAll(/<div class="approval-actions">(.*?)<\/div>/g)].map(match => match[1]);
  expect(rows).toEqual([
    '<button type="button" class="approval-allow" data-house-number="1">Yes</button><button type="button" class="approval-deny" data-house-number="3">No</button>',
    '<button type="button" class="approval-lasting" data-house-number="2">Yes, and don&#39;t ask again for: printf *<br><small>Adds a lasting rule to your agent&#39;s settings.</small></button>',
  ]);
  const button = h.cards()[0].querySelectorAll().find((button: any) => button.dataset.houseNumber === "2");
  // A click on the explanatory child reaches the same delegated button handler.
  await h.click({ target: { closest: () => button } });
  expect(requests).toEqual([{ path: "/api/house-question/answer", body: { id: "permission", instance: "session:1", number: 2 } }]);
  expect(renderCard(permission, true).match(/ disabled/g)).toHaveLength(3);
});

test("answer wording, not answer number or middle position, identifies lasting rules", () => {
  const html = renderCard({ ...permission, options: [
    { number: 9, label: "Yes, and don't ask again for: <pattern>" },
    { number: 4, label: "Yes, only once" }, { number: 7, label: "No" },
  ] }, false);
  expect(html).toContain('data-house-number="9">Yes, and don&#39;t ask again for: &lt;pattern&gt;<br><small>');
  expect(html).toContain('data-house-number="4">Yes, only once</button>');
  expect(html.match(/<small>/g)).toHaveLength(1);
});

test("two-answer permission markup is identical to its fixed original markup", () => {
  expect(renderCard({ id: "two", permission: true, text: permission.text, options: [{ number: 1, label: "Yes" }, { number: 2, label: "No" }] }, false)).toBe('<div class="approval-card house-question-card house-permission-card" data-house-question="two"><div class="approval-head">🔒 Agent question</div><div class="house-permission-detail"><p class="approval-title">Bash command</p><pre class="approval-detail">printf hello</pre><p class="house-permission-prompt">Do you want to proceed?</p></div><div class="house-permission-hint">Your choice is typed into the agent&#39;s terminal.</div><div class="approval-actions"><button type="button" class="approval-allow" data-house-number="1">Yes</button><button type="button" class="approval-deny" data-house-number="2">No</button></div><div class="approval-status" role="status"></div></div>');
});

test("ordinary question markup is identical to its fixed original markup", () => {
  expect(renderCard({ id: "ordinary", text: "Pick one", options: [{ number: 4, label: "First" }, { number: 7, label: "Second" }] }, false)).toBe('<div class="approval-card house-question-card" data-house-question="ordinary"><div class="approval-head">🔒 Agent question</div><pre class="approval-detail">Pick one</pre><div class="approval-title">Your choice is typed into the agent&#39;s terminal.</div><div class="approval-actions"><button type="button" data-house-number="4">First</button><button type="button" data-house-number="7">Second</button></div><div class="approval-status" role="status">Choose an answer to continue. If no buttons are available, answer in the terminal.</div></div>');
});
