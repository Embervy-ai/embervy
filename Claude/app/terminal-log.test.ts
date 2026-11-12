import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brainLogEntries,
  claudeLogEntries,
  claudeProjectDir,
  logHistoryPage,
  renderBrainConversation,
  renderClaudeSession,
  splitUserText,
  type LogEntry,
} from "./terminal-log";

const names = { self: "Wren", user: "Sam" };
const plain = (entries: LogEntry[]) => entries.map((e) => (e.kind === "line" ? e.text : `[tool] ${e.summary}`).replace(/\x1b\[[0-9;]*m/g, ""));
const tools = (entries: LogEntry[]) => entries.filter((e): e is LogEntry & { kind: "tool" } => e.kind === "tool");
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r));

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "terminal-log-"));
  dirs.push(d);
  return d;
}

describe("Brain conversation", () => {
  const turn = [
    "SENSE · window 12k/1M",
    "",
    "⏰ Lakeside: Friday, 09.10.2026, 07:00",
    "",
    "<inlet>",
    "## Chronicle",
    'an older quote: <channel source="app" user="Sam">old words</channel>',
    "</inlet>",
    "",
    '<channel source="app" user="Sam" ts="09.10.2026, 07:00">',
    "Good morning, are you there?",
    "</channel>",
  ].join("\n");
  const rows = jsonl([
    { ts: "2026-10-09T05:00:00Z", role: "user", content: turn },
    { ts: "2026-10-09T05:00:05Z", role: "assistant", content: "Reading the doctor first.", tool_calls: [
      { id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "bun doctor.ts --json", description: "Run the doctor" }) } },
    ] },
    { ts: "2026-10-09T05:00:06Z", role: "tool", tool_call_id: "c1", content: "17 ok, 3 warn" },
    { ts: "2026-10-09T05:00:07Z", role: "assistant", content: "", tool_calls: [
      { id: "c2", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "/opt/house/missing.md" }) } },
    ] },
    { ts: "2026-10-09T05:00:08Z", role: "tool", tool_call_id: "c2", content: "Error: no such file" },
    { ts: "2026-10-09T05:00:09Z", role: "assistant", content: "", tool_calls: [
      { id: "c3", type: "function", function: { name: "mcp__app__reply", arguments: JSON.stringify({ text: "Morning, Sam.\nAll green." }) } },
    ] },
    { ts: "2026-10-09T05:00:10Z", role: "assistant", content: "Morning, Sam.\nAll green." },
  ]);
  const entries = renderBrainConversation(rows, { names, timeZone: "UTC" });
  const text = plain(entries);

  test("the message stands under the person's name, the preamble folds into one context step", () => {
    expect(text).toContain("── Sam · 05:00 ──");
    expect(text).toContain("Good morning, are you there?");
    const context = tools(entries).find((t) => t.summary.includes("Context"));
    expect(context?.summary).toContain("Sense · Clock · Inlet");
    expect(context?.body).toContain("old words");
    // The quoted envelope inside the inlet is no speaker of its own.
    expect(text).not.toContain("old words");
  });

  test("a tool step carries its input and, opened, its result", () => {
    const bash = tools(entries).find((t) => t.summary.includes("Run the doctor"));
    expect(bash?.summary).toContain("▸ bash: Run the doctor");
    expect(bash?.body).toContain("command: bun doctor.ts --json");
    expect(bash?.body).toContain("── Result ──\n17 ok, 3 warn");
    expect(bash?.error).toBe(false);
  });

  test("an error result marks its step", () => {
    const read = tools(entries).find((t) => t.summary.includes("missing.md"));
    expect(read?.error).toBe(true);
    expect(read?.summary.endsWith("✗")).toBe(true);
  });

  test("an app reply reads as speech, and the same text logged again as prose shows once", () => {
    expect(text).toContain("⇢ App message");
    expect(text.filter((l) => l === "Morning, Sam.").length).toBe(1);
    expect(tools(entries).some((t) => t.summary.includes("reply"))).toBe(false);
  });

  test("the bridge at a session's start is one closed step", () => {
    const out = renderBrainConversation(jsonl([{ ts: "2026-10-09T05:00:00Z", role: "user", content: "[bridge — prior session context]\nlong text" }]), { names });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe("tool");
  });

  test("the labels can be translated", () => {
    const out = plain(renderBrainConversation(rows, { names, labels: { appMessage: "⇢ Mensaje", result: "Resultado" } }));
    expect(out).toContain("⇢ Mensaje");
    const bash = tools(renderBrainConversation(rows, { names, labels: { result: "Resultado" } })).find((t) => t.summary.includes("doctor"));
    expect(bash?.body).toContain("── Resultado ──");
  });
});

describe("Claude Code session", () => {
  const rows = jsonl([
    { type: "user", timestamp: "2026-10-09T05:00:00Z", message: { role: "user", content: '<channel source="app" user="Sam">\nHello\n</channel>' } },
    { type: "user", isMeta: true, timestamp: "2026-10-09T05:00:01Z", message: { role: "user", content: "[Image: original 1170x2532]" } },
    { type: "assistant", timestamp: "2026-10-09T05:00:02Z", message: { role: "assistant", content: [
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/opt/house/notes.md" } },
    ] } },
    { type: "user", timestamp: "2026-10-09T05:00:03Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "line one\nline two" }] }] } },
    { type: "attachment", timestamp: "2026-10-09T05:00:04Z", attachment: { type: "queued_command", prompt: '<channel source="app" user="Sam">\nStill there?\n</channel>' } },
    { type: "user", timestamp: "2026-10-09T05:00:05Z", message: { role: "user", content: "<task-notification><task-id>x</task-id><summary>Background command \"Build the package\" completed (exit code 0)</summary></task-notification>" } },
    { type: "assistant", timestamp: "2026-10-09T05:00:06Z", message: { role: "assistant", content: [
      { type: "tool_use", id: "t2", name: "mcp__app__reply", input: { text: "Yes, here." } },
    ] } },
  ]);
  const entries = renderClaudeSession(rows, { names, timeZone: "UTC" });
  const text = plain(entries);

  test("speakers, prose, a paired tool step and a reply", () => {
    expect(text).toContain("── Sam · 05:00 ──");
    expect(text).toContain("Hello");
    expect(text).toContain("── Wren · 05:00 ──");
    expect(text).toContain("Looking.");
    const read = tools(entries)[0]!;
    expect(read.summary).toContain("▸ Read: /opt/house/notes.md");
    expect(read.body).toContain("── Result ──\nline one\nline two");
    expect(text).toContain("⇢ App message");
    expect(text).toContain("Yes, here.");
  });

  test("lines the CLI writes itself never stand under the person's name", () => {
    expect(text.join("\n")).not.toContain("[Image:");
  });

  test("a message queued during a turn shows that it arrived", () => {
    expect(text).toContain("Still there?");
  });

  test("a task notification folds to one line saying what finished", () => {
    expect(text).toContain("· In the background, finished: Build the package");
  });
});

describe("session inlets", () => {
  const ts = (second: number) => `2026-10-09T05:00:${String(second).padStart(2, "0")}Z`;
  const event = (second: number, block: string) => ({ ts: ts(second), type: "inlet_injected", via: "worker", characters: 999, block });
  function fixture(first = "First message") {
    const dir = tmp();
    writeFileSync(join(dir, "conversation-a.jsonl"), jsonl([
      { ts: ts(10), role: "user", content: first },
      { ts: ts(15), role: "assistant", content: "Answer" },
      { ts: ts(20), role: "user", content: "Second message" },
    ]).join("\n"));
    return { dir, session: join(dir, "session-a.jsonl"), read: () => brainLogEntries(dir, { names, timeZone: "UTC" }) };
  }

  test("each inlet folds under the next user header, including equal timestamps", () => {
    const f = fixture();
    const baseline = f.read();
    const blocks = ["<inlet>first context</inlet>", "<inlet>second context</inlet>"];
    writeFileSync(f.session, jsonl([
      event(9, blocks[0]!),
      { ts: ts(11), type: "usage", block: "hidden usage", content: "hidden content" },
      event(20, blocks[1]!),
    ]).join("\n"));
    const out = f.read();
    expect(tools(baseline)).toHaveLength(0);
    expect(tools(out).map((e) => e.body)).toEqual(blocks);
    for (const [index, message] of ["First message", "Second message"].entries()) {
      const at = out.findIndex((e) => e.kind === "line" && e.text === message);
      expect(out[at - 1]).toMatchObject({ kind: "tool", body: blocks[index] });
      expect(plain(out)[at - 2]).toContain("── Sam ·");
      expect(tools(out)[index]!.summary).toContain("Context: Inlet");
    }
    expect(JSON.stringify(out)).not.toContain("hidden");
    rmSync(f.session);
    expect(f.read()).toEqual(baseline);
  });

  test("an existing inlet preamble wins without duplication", () => {
    const f = fixture('<inlet>original</inlet>\n<channel source="app" user="Sam">\nFirst message\n</channel>');
    const baseline = f.read();
    writeFileSync(f.session, jsonl([event(9, "<inlet>duplicate</inlet>")]).join("\n"));
    expect(f.read()).toEqual(baseline);
  });

  test("missing, corrupt, oversized and unmatched session data leave the log unchanged", () => {
    const f = fixture();
    const baseline = f.read();
    expect(tools(baseline)).toHaveLength(0);
    for (const raw of [
      jsonl([event(9, "<inlet>discarded</inlet>")]).join("\n") + "\n{broken",
      jsonl([event(21, "<inlet>no following message</inlet>")]).join("\n"),
      jsonl([{ ts: ts(9), type: "usage", block: "not an inlet" }]).join("\n"),
      jsonl([event(9, "<inlet>too large</inlet>")]).join("\n") + "\n" + " ".repeat(16 * 1024 * 1024),
    ]) {
      writeFileSync(f.session, raw);
      expect(f.read()).toEqual(baseline);
    }
  });

  test("truncated blocks and existing context use the same context step", () => {
    const f = fixture('SENSE · ready\n<channel source="app" user="Sam">\nFirst message\n</channel>');
    const block = "<inlet>" + "x".repeat(3993);
    writeFileSync(f.session, jsonl([event(9, block)]).join("\n"));
    const context = tools(f.read());
    expect(context).toHaveLength(1);
    expect(context[0]!.body).toBe("SENSE · ready\n\n" + block);
    expect(plain(f.read())).toContain("First message");
  });
});

describe("files", () => {
  test("Brain: the newest conversation files, oldest first, with a boundary between sessions", () => {
    const dir = tmp();
    writeFileSync(join(dir, "conversation-a.jsonl"), jsonl([{ ts: "2026-10-08T20:00:00Z", role: "assistant", content: "yesterday" }]).join("\n"));
    writeFileSync(join(dir, "conversation-b.jsonl"), jsonl([{ ts: "2026-10-09T05:00:00Z", role: "assistant", content: "today" }]).join("\n"));
    writeFileSync(join(dir, "session-b.jsonl"), jsonl([{ ts: "2026-10-09T05:00:00Z", role: "assistant", content: "not a conversation" }]).join("\n"));
    utimesSync(join(dir, "conversation-a.jsonl"), new Date("2026-10-08T20:00:00Z"), new Date("2026-10-08T20:00:00Z"));
    const text = plain(brainLogEntries(dir, { names }));
    expect(text.indexOf("yesterday")).toBeLessThan(text.indexOf("today"));
    expect(text.some((l) => l.includes("Session boundary"))).toBe(true);
    expect(text).not.toContain("not a conversation");
  });

  test("Claude Code: one-shot `claude -p` sessions are not the conversation", () => {
    const dir = tmp();
    writeFileSync(join(dir, "a.jsonl"), jsonl([
      { type: "user", entrypoint: "cli", timestamp: "2026-10-09T05:00:00Z", message: { role: "user", content: "talking with you" } },
    ]).join("\n") + "\n" + " ".repeat(300));
    writeFileSync(join(dir, "b.jsonl"), jsonl([
      { type: "user", entrypoint: "sdk-cli", timestamp: "2026-10-09T05:01:00Z", message: { role: "user", content: "a whole copied session" } },
    ]).join("\n") + "\n" + " ".repeat(300));
    const text = plain(claudeLogEntries(dir, { names }));
    expect(text).toContain("talking with you");
    expect(text).not.toContain("a whole copied session");
  });

  test("an absent directory gives an empty log, not an error", () => {
    expect(brainLogEntries(join(tmp(), "nope"), { names })).toEqual([]);
    expect(claudeLogEntries(join(tmp(), "nope"), { names })).toEqual([]);
  });

  test("the Claude Code project directory follows the house's path", () => {
    expect(claudeProjectDir("/opt/house", { HOME: "/home/agent" })).toBe("/home/agent/.claude/projects/-opt-house");
    expect(claudeProjectDir("/opt/house", { HOME: "/home/agent", CLAUDE_CONFIG_DIR: "/srv/claude" })).toBe("/srv/claude/projects/-opt-house");
    expect(claudeProjectDir("/opt/house", { CLAUDE_PROJECT_DIR: "/somewhere/else" })).toBe("/somewhere/else");
  });
});

test("splitUserText: several envelopes in one turn become several speakers", () => {
  const { preamble, parts } = splitUserText('<channel source="app" user="Sam">\none\n</channel>\n<channel source="app" user="Ada">\ntwo\n</channel>');
  expect(preamble).toBeNull();
  expect(parts.map((p) => p.name)).toEqual(["Sam", "Ada"]);
});

test("rendering never creates the directory it reads", () => {
  const dir = join(tmp(), "logs");
  brainLogEntries(dir, { names });
  expect(() => mkdirSync(dir)).not.toThrow();
});

test("Brain's closing entry of a turn (replies + prose) adds only the prose", () => {
  const rows = jsonl([
    { ts: "2026-10-09T06:24:00Z", role: "user", content: '<channel source="app" user="Sam">\nLooks better now.\n</channel>' },
    { ts: "2026-10-09T06:24:05Z", role: "assistant", origin: "claude_pipe", content: null, tool_calls: [
      { id: "r1", type: "function", function: { name: "mcp__app__reply", arguments: JSON.stringify({ text: "Good, then the customer's agent sees it too." }) } },
    ] },
    { ts: "2026-10-09T06:24:06Z", role: "tool", origin: "claude_pipe", tool_call_id: "r1", content: "." },
    { ts: "2026-10-09T06:24:07Z", role: "assistant", content: "Good, then the customer's agent sees it too.\n\nI answered in the app and wait for her reply." },
    { ts: "2026-10-09T06:25:00Z", role: "user", content: '<channel source="app" user="Sam">\nThanks\n</channel>' },
    { ts: "2026-10-09T06:25:05Z", role: "assistant", origin: "claude_pipe", content: null, tool_calls: [
      { id: "r2", type: "function", function: { name: "mcp__app__reply", arguments: JSON.stringify({ text: "Anytime." }) } },
    ] },
    { ts: "2026-10-09T06:25:07Z", role: "assistant", content: "Anytime." },
  ]);
  const text = plain(renderBrainConversation(rows, { names, timeZone: "Europe/Berlin" }));
  expect(text.filter((l) => l === "Good, then the customer's agent sees it too.")).toHaveLength(1);
  expect(text).toContain("I answered in the app and wait for her reply.");
  expect(text.filter((l) => l === "Anytime.")).toHaveLength(1);
  expect(text).toContain("── Sam · 08:24 ──");
});

test("source keys survive growth, tool completion, late inlets and the rendered cap for both sources", () => {
  for (const source of ["brain", "claude"] as const) {
    const dir = tmp();
    const file = join(dir, source === "brain" ? "conversation-a.jsonl" : "a.jsonl");
    const user = source === "brain"
      ? { ts: "2026-10-09T05:00:00Z", role: "user", content: "first" }
      : { timestamp: "2026-10-09T05:00:00Z", type: "user", message: { content: "first" } };
    const call = source === "brain"
      ? { ts: "2026-10-09T05:00:01Z", role: "assistant", tool_calls: [{ id: "stable", function: { name: "Read", arguments: '{"path":"file"}' } }] }
      : { timestamp: "2026-10-09T05:00:01Z", type: "assistant", message: { content: [{ type: "tool_use", id: "stable", name: "Read", input: { path: "file" } }] } };
    const read = () => source === "brain" ? brainLogEntries(dir, { names }) : claudeLogEntries(dir, { names });
    writeFileSync(file, jsonl([user, call]).join("\n") + "\n");
    const before = read();
    const result = source === "brain"
      ? { role: "tool", tool_call_id: "stable", content: "Error: completion" }
      : { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "stable", content: "completion", is_error: true }] } };
    appendFileSync(file, JSON.stringify(result) + "\n");
    const completed = read();
    expect(completed.map((item) => item.key)).toEqual(before.map((item) => item.key));
    expect(tools(completed)[0]!.body).toContain("completion");
    expect(tools(completed)[0]!.error).toBe(true);
    if (source === "brain") {
      writeFileSync(join(dir, "session-a.jsonl"), JSON.stringify({ ts: "2026-10-09T05:00:00Z", type: "inlet_injected", block: "<inlet>late context</inlet>" }) + "\n");
      const withInlet = read();
      for (const entry of before) expect(withInlet.some((item) => item.key === entry.key)).toBe(true);
    }
    const prose = Array.from({ length: 5100 }, (_, i) => `prose ${i}`).join("\n");
    appendFileSync(file, JSON.stringify(source === "brain"
      ? { ts: "2026-10-09T05:01:00Z", role: "assistant", content: prose }
      : { timestamp: "2026-10-09T05:01:00Z", type: "assistant", message: { content: [{ type: "text", text: prose }] } }) + "\n");
    const capped = read();
    expect(capped).toHaveLength(5000);
    const retainedKey = capped.find((item) => item.kind === "line" && item.text === "prose 500")!.key;
    appendFileSync(file, JSON.stringify(source === "brain"
      ? { ts: "2026-10-09T05:02:00Z", role: "assistant", content: "new ending" }
      : { timestamp: "2026-10-09T05:02:00Z", type: "assistant", message: { content: [{ type: "text", text: "new ending" }] } }) + "\n");
    expect(read().find((item) => item.kind === "line" && item.text === "prose 500")!.key).toBe(retainedKey);
    expect(new Set(read().map((item) => item.key)).size).toBe(read().length);
  }
});

test("session divider keys stay stable when the source grows", () => {
  const dir = tmp();
  const older = join(dir, "conversation-a.jsonl");
  writeFileSync(older, JSON.stringify({ ts: "2026-10-09T05:00:00Z", role: "assistant", content: "old session" }) + "\n");
  writeFileSync(join(dir, "conversation-b.jsonl"), JSON.stringify({ ts: "2026-10-09T06:00:00Z", role: "assistant", content: "new session" }) + "\n");
  const before = brainLogEntries(dir, { names });
  const divider = before.find((item) => item.kind === "line" && item.text.includes("Session boundary"))!;
  appendFileSync(older, JSON.stringify({ ts: "2026-10-09T05:01:00Z", role: "assistant", content: "more old session" }) + "\n");
  expect(brainLogEntries(dir, { names }).find((item) => item.key === divider.key)).toEqual(divider);
});

test("server range selection pages a growing source strictly backwards and fills the exact gap", () => {
  const dir = tmp();
  const file = join(dir, "conversation-a.jsonl");
  const grow = (from: number, to: number) => appendFileSync(file, JSON.stringify({ ts: "2026-10-09T05:00:00Z", role: "assistant", content: Array.from({ length: to - from }, (_, i) => `entry ${from + i}`).join("\n") }) + "\n");
  const read = () => brainLogEntries(dir, { names });
  const keys = (items: LogEntry[]) => items.map(item => item.key);
  grow(0, 900);
  const initial = read();
  const tail = initial.slice(-150);
  const first = logHistoryPage(initial, tail[0]!.key, undefined);
  grow(900, 1700);
  const second = logHistoryPage(read(), first.nextBefore!, undefined);
  expect(keys(first.lines)).toEqual(keys(initial.slice(-350, -150)));
  expect(keys(second.lines)).toEqual(keys(initial.slice(-550, -350)));
  expect(keys([...second.lines, ...first.lines, ...tail])).toEqual(keys(initial.slice(-550)));
  expect(new Set(keys([...second.lines, ...first.lines, ...tail])).size).toBe(550);
  const current = read();
  const upper = current.at(-150)!.key!;
  let lower = first.lines.at(-1)!.key!;
  const expected = current.slice(current.findIndex(item => item.key === lower) + 1, -150);
  const filled: LogEntry[] = [];
  do {
    const page = logHistoryPage(current, upper, lower, 999);
    expect(page.lines.length).toBeLessThanOrEqual(200);
    expect(page.anchor_lost).toBe(false);
    filled.push(...page.lines);
    lower = page.nextAfter!;
  } while (lower);
  expect(keys(filled)).toEqual(keys(expected));
  expect(new Set(keys(filled)).size).toBe(filled.length);
  expect(logHistoryPage(current, tail[1]!.key, tail[0]!.key).lines).toEqual([]);
  for (const [before, after] of [["unknown", undefined], [upper, "unknown"], [tail[0]!.key, upper]]) {
    expect(logHistoryPage(current, before, after)).toMatchObject({ lines: [], anchor_lost: true, nextOffset: null });
  }
  grow(1700, 7500);
  expect(read()).toHaveLength(5000);
  expect(logHistoryPage(read(), tail[0]!.key, undefined)).toMatchObject({ lines: [], anchor_lost: true, nextOffset: null });
  const retained = read().at(-1)!.key!;
  rmSync(file);
  grow(7500, 7501);
  expect(logHistoryPage(read(), retained, undefined)).toMatchObject({ lines: [], anchor_lost: true, nextOffset: null });
});

test("the page and service worker request the same app.js version", () => {
  const page = readFileSync(join(import.meta.dir, "public", "index.html"), "utf8");
  const worker = readFileSync(join(import.meta.dir, "public", "sw.js"), "utf8");
  const version = (text: string) => text.match(/\/app\.js\?v=(\d+)/)?.[1];
  expect(version(page)).toBeDefined();
  expect(version(worker)).toBe(version(page));
});

// Exercise the shipped client rather than a second implementation of its paging rules.
function logClient(): any {
  const source = readFileSync(join(import.meta.dir, "public", "app.js"), "utf8");
  const part = source.slice(source.indexOf("  const terminalBtn = document.getElementById(\"terminal-btn\");"), source.indexOf("  async function setupPush() {"));
  return new Function(`
    class Node {
      constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.className = ''; this.innerHTML = ''; this.textContent = ''; this.open = false; this.handlers = {}; this.classList = { add() {}, remove() {}, toggle() {} }; }
      appendChild(n) { this.children.push(n); return n; }
      append(...nodes) { this.children.push(...nodes); }
      prepend(...nodes) { this.children.unshift(...nodes.flatMap(n => n.tagName === '#FRAGMENT' ? n.children : [n])); }
      replaceChildren(...nodes) { this.children = nodes; }
      querySelector(sel) { for (const n of this.children) { if (sel[0] === '.' ? n.className === sel.slice(1) : n.tagName === sel.toUpperCase()) return n; const found = n.querySelector(sel); if (found) return found; } return null; }
      querySelectorAll() { return []; }
      addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
      fire(type) { for (const fn of this.handlers[type] || []) fn({ target: this }); }
      setAttribute() {} removeAttribute() {} focus() {}
    }
    const nodes = {};
    const document = { getElementById: id => nodes[id] ||= new Node(), createElement: tag => new Node(tag), createDocumentFragment: () => new Node('#fragment'), addEventListener() {}, body: new Node() };
    const output = document.getElementById('terminal-output');
    const scroll = document.getElementById('terminal-scroll');
    scroll.scrollTop = 0; scroll.clientHeight = 400;
    Object.defineProperty(scroll, 'scrollHeight', { get: () => 20 * output.children.reduce((sum, n) => sum + n.children.length, 0) });
    const fetches = [];
    const fetch = url => new Promise(resolve => fetches.push({ url, resolve: data => resolve({ ok: true, json: async () => data }) }));
    const ws = { readyState: 1, send() {} }; const WebSocket = { OPEN: 1 };
    const t = key => key; const terminalPanelEnabled = () => true;
    const requestAnimationFrame = () => 0; const setTimeout = () => 0; const setInterval = () => 0;
    ${part}
    return { openTerminal, closeTerminal, renderTerminalFrame, loadTerminalHistory, nodes, output, scroll, fetches,
      lines: () => output.children.flatMap(n => n.children.map(c => c.innerHTML)),
      settle: async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); } };
  `)();
}
const clientItems = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => ({ key: `key:${from + i}`, html: `line ${from + i}` }));
const clientFrame = (items: any[]) => ({ mode: "log", items });

test("client pins the first tail during paging and fills a multi-page gap before swapping frames", async () => {
  const h = logClient();
  h.openTerminal();
  h.renderTerminalFrame(clientFrame(clientItems(450, 600)));
  h.scroll.scrollTop = 0;
  h.scroll.fire("touchstart");
  h.scroll.fire("scroll");
  expect(h.fetches[0].url).toContain("before=key%3A450");
  expect(h.fetches[0].url).not.toContain("offset=");
  h.renderTerminalFrame(clientFrame(clientItems(1100, 1250)));
  expect(h.lines()).toEqual(clientItems(450, 600).map(i => i.html));
  h.fetches[0].resolve({ lines: clientItems(250, 450), nextBefore: "key:250" });
  await h.settle();
  expect(h.fetches[1].url).toContain("after=key%3A599&before=key%3A1100");
  h.fetches[1].resolve({ lines: clientItems(600, 800), nextAfter: "key:799" });
  await h.settle();
  expect(h.fetches[2].url).toContain("after=key%3A799&before=key%3A1100");
  h.renderTerminalFrame(clientFrame(clientItems(1150, 1300)));
  h.fetches[2].resolve({ lines: clientItems(800, 1000), nextAfter: "key:999" });
  await h.settle();
  h.fetches[3].resolve({ lines: clientItems(1000, 1100), nextAfter: null });
  await h.settle();
  expect(h.lines()).toEqual(clientItems(250, 1300).map(i => i.html));
  expect(h.fetches).toHaveLength(4);
  expect(new Set(h.lines()).size).toBe(h.lines().length);
  h.scroll.scrollTop = 0;
  h.scroll.fire("scroll");
  expect(h.fetches[4].url).toContain("before=key%3A250");
  h.fetches[4].resolve({ lines: clientItems(50, 250), nextBefore: "key:50" });
  await h.settle();
  expect(h.lines()).toEqual(clientItems(50, 1300).map(i => i.html));
});

test("client keeps an overlapping moving tail joined without fetching or duplicates", async () => {
  const h = logClient();
  h.openTerminal();
  h.renderTerminalFrame(clientFrame(clientItems(450, 600)));
  const page = h.loadTerminalHistory();
  h.fetches[0].resolve({ lines: clientItems(250, 450), nextBefore: "key:250" });
  await page;
  h.renderTerminalFrame(clientFrame(clientItems(500, 650)));
  await h.settle();
  expect(h.lines()).toEqual(clientItems(250, 650).map(i => i.html));
  expect(h.fetches).toHaveLength(1);
});

test("client reports lost paging and gap anchors without prepending or swapping a wrong range", async () => {
  for (const gap of [false, true]) {
    const h = logClient();
    h.openTerminal();
    h.renderTerminalFrame(clientFrame(clientItems(450, 600)));
    const page = h.loadTerminalHistory();
    h.fetches[0].resolve(gap ? { lines: clientItems(250, 450), nextBefore: "key:250" } : { lines: [], anchor_lost: true, nextOffset: null });
    await page;
    if (gap) {
      h.renderTerminalFrame(clientFrame(clientItems(900, 1050)));
      h.fetches[1].resolve({ lines: [], anchor_lost: true, nextOffset: null });
      await h.settle();
    }
    expect(h.nodes['terminal-history-state'].textContent).toBe("terminal.history.moved");
    expect(h.lines()).toEqual(clientItems(gap ? 250 : 450, 600).map(i => i.html));
    h.renderTerminalFrame(clientFrame(clientItems(1000, 1150)));
    await h.loadTerminalHistory();
    expect(h.fetches).toHaveLength(gap ? 2 : 1);
  }
});

test("client drops stale pages and gaps after reopening or changing views", async () => {
  for (const gap of [false, true]) {
    const h = logClient();
    h.openTerminal();
    h.renderTerminalFrame(clientFrame(clientItems(450, 600)));
    const page = h.loadTerminalHistory();
    if (gap) {
      h.fetches[0].resolve({ lines: clientItems(250, 450), nextBefore: "key:250" });
      await page;
      h.renderTerminalFrame(clientFrame(clientItems(900, 1050)));
    }
    h.closeTerminal();
    h.openTerminal();
    h.renderTerminalFrame(clientFrame(clientItems(950, 1100)));
    h.fetches[gap ? 1 : 0].resolve({ lines: clientItems(250, 450), nextBefore: "key:250" });
    await h.settle();
    expect(h.lines()).toEqual(clientItems(950, 1100).map(i => i.html));
  }
  const h = logClient();
  h.openTerminal();
  h.renderTerminalFrame(clientFrame(clientItems(450, 600)));
  const page = h.loadTerminalHistory();
  h.nodes['terminal-mode-btn'].fire('click');
  h.renderTerminalFrame({ mode: 'tui', lines: ['screen'] });
  h.fetches[0].resolve({ lines: clientItems(250, 450), nextBefore: "key:250" });
  await page;
  expect(h.lines()).toEqual(['screen']);
});

test("client keeps tool expansion by key when equal summaries and changed results swap", () => {
  const h = logClient();
  const tools = ["one", "two"].map(key => ({ key, summary_html: "same summary", body_html: "pending", error: false }));
  h.openTerminal();
  h.renderTerminalFrame(clientFrame(tools));
  h.output.children[0].children[0].open = true;
  h.renderTerminalFrame(clientFrame(tools.map(item => ({ ...item, body_html: "completed", error: true }))));
  const rendered = h.output.children[0].children;
  expect(rendered[0].open).toBe(true);
  expect(rendered[1].open).toBe(false);
  expect(rendered[0].querySelector('div').innerHTML).toBe('completed');
});

test("hostile shapes stay fast: many openings without a closing tag, a long run of spaces", () => {
  const { splitUserText: split, toolSummary: summary } = require("./terminal-log");
  let t = performance.now();
  split("</channel>" + "<channel ".repeat(20000));
  expect(performance.now() - t).toBeLessThan(250);
  t = performance.now();
  expect(summary("Bash", { command: "x" + " ".repeat(100000) + "y" }).length).toBeLessThan(120);
  expect(performance.now() - t).toBeLessThan(250);
});
