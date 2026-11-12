import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainLogEntries } from "./terminal-log";

// The terminal panel's two views against the real server.ts: the log view
// reads Brain's conversation files, the TUI view reads the tmux screen with
// wrapped lines joined, and an idle view keeps saying it is alive. tmux is a
// stub on the server's PATH that prints a fixed screen and logs its arguments.

const PASSWORD = "test-password-not-real";
const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };

import { startTestApp } from "./test-app-start";

const dir = mkdtempSync(join(tmpdir(), "terminal-log-server-"));
const logsDir = join(dir, "brain-logs");
const tmuxLog = join(dir, "tmux.log");
let server: ReturnType<typeof Bun.spawn>;
let base = "";
let cookie = "";

beforeAll(async () => {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  writeFileSync(join(binDir, "tmux"), `#!/bin/sh\necho "$*" >> "${tmuxLog}"\necho "a screen line that tmux would have wrapped"\nexit 0\n`);
  chmodSync(join(binDir, "tmux"), 0o755);
  writeFileSync(join(dir, "brain.env"), `BRAIN_LOG_DIR=${logsDir}\n`);
  writeFileSync(join(logsDir, "conversation-1.jsonl"), [
    { ts: "2026-10-09T05:00:00Z", role: "user", content: '<channel source="app" user="Sam">\nAre you there?\n</channel>' },
    { ts: "2026-10-09T05:00:02Z", role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "uptime" }) } }] },
    { ts: "2026-10-09T05:00:03Z", role: "tool", tool_call_id: "c1", content: "up 3 days" },
    { ts: "2026-10-09T05:00:04Z", role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "mcp__app__reply", arguments: JSON.stringify({ text: "Here <b>and</b> awake." }) } }] },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");

  const app = await startTestApp({
    cwd: dir,
    env: {
      PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: dir,
      TZ: "UTC",
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_HOME: join(dir, "home"),
      EMBERVY_STRINGS_LOCAL: join(dir, "no-such-strings.local.json"),
      EMBERVY_HARNESS: "brain",
      BRAIN_ENV_FILE: join(dir, "brain.env"),
      EMBERVY_TERMINAL_PANEL: "1",
      EMBERVY_TMUX_SESSION: "test-session",
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      AGENT_LABEL: "Wren",
      USER_LABEL: "Sam",
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  ({ base, proc: server, cookie } = app);
}, 15000);

afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

/** Subscribes in one view and collects messages until `until` holds or time runs out. */
async function watch(mode: "log" | "tui", until: (msgs: any[]) => boolean, ms = 6000): Promise<any[]> {
  const ws = new WebSocket(`${base.replace("http:", "ws:")}/ws`, { headers: { cookie } } as any);
  const msgs: any[] = [];
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    ws.onmessage = (e) => { try { msgs.push(JSON.parse(String(e.data))); } catch {} };
    ws.send(JSON.stringify({ type: "terminal-subscribe", mode }));
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !until(msgs)) await Bun.sleep(50);
  } finally { ws.close(); }
  return msgs;
}

describe("terminal panel on a Brain house", () => {
  test("the log view streams the conversation: speakers, a tool step that opens, the reply as speech", async () => {
    const msgs = await watch("log", (m) => m.some((x) => x.type === "terminal-frame"));
    const frame = msgs.find((x) => x.type === "terminal-frame");
    expect(frame?.mode).toBe("log");
    const html = JSON.stringify(frame.items);
    expect(html).toContain("Sam");
    expect(html).toContain("Are you there?");
    const tool = frame.items.find((i: any) => i.summary_html !== undefined && i.summary_html.includes("uptime"));
    expect(tool.body_html).toContain("up 3 days");
    expect(html).toContain("App message");
    // Text from the transcript is escaped, never markup.
    expect(html).toContain("&lt;b&gt;and&lt;/b&gt;");
    expect(html).not.toContain("<b>and</b>");
  });

  test("an idle view keeps saying it is alive, so the client never reads silence as a lost connection", async () => {
    const msgs = await watch("log", (m) => m.some((x) => x.type === "terminal-alive"), 6000);
    expect(msgs.some((x) => x.type === "terminal-alive")).toBe(true);
  });

  test("the TUI view captures the screen with wrapped lines joined (-J)", async () => {
    const msgs = await watch("tui", (m) => m.some((x) => x.type === "terminal-frame"));
    const frame = msgs.find((x) => x.type === "terminal-frame");
    expect(frame?.mode).toBe("tui");
    expect(frame.lines.join("")).toContain("a screen line");
    const calls = existsSync(tmuxLog) ? readFileSync(tmuxLog, "utf8") : "";
    expect(calls).toMatch(/capture-pane -t test-session -p -e -J/);
  });

  test("older log entries page in from the newest back", async () => {
    const res = await fetch(`${base}/api/terminal/history?mode=log&lines=2&offset=0`, { headers: { ...viaTunnel, cookie } });
    expect(res.status).toBe(200);
    const page = await res.json() as any;
    expect(page.lines).toHaveLength(2);
    expect(page.nextOffset).toBe(2);
    const all = await (await fetch(`${base}/api/terminal/history?mode=log&lines=200&offset=0`, { headers: { ...viaTunnel, cookie } })).json() as any;
    expect(all.nextOffset).toBeNull();
    expect(JSON.stringify(all.lines.slice(-2))).toBe(JSON.stringify(page.lines));
  });

  test("TUI history keeps its -S/-E offset range and ignores log anchors", async () => {
    const res = await fetch(`${base}/api/terminal/history?mode=tui&lines=3&offset=2&before=unknown`, { headers: { ...viaTunnel, cookie } });
    expect(res.status).toBe(200);
    expect((await res.json() as any).nextOffset).toBe(5);
    expect(readFileSync(tmuxLog, "utf8")).toContain("capture-pane -t test-session -p -e -J -S -5 -E -3");
  });

  test("anchored pages stay older after growth and gap pages return exactly the missing range", async () => {
    const file = join(logsDir, "conversation-1.jsonl");
    const grow = (from: number, to: number) => appendFileSync(file, JSON.stringify({ ts: "2026-10-09T06:00:00Z", role: "assistant", content: Array.from({ length: to - from }, (_, i) => `entry ${from + i}`).join("\n") }) + "\n");
    const get = async (query: string) => {
      const res = await fetch(`${base}/api/terminal/history?mode=log&${query}`, { headers: { ...viaTunnel, cookie } });
      expect(res.status).toBe(200);
      return await res.json() as any;
    };
    const keys = (items: any[]) => items.map((item) => item.key);
    grow(0, 900);
    const snapshot = brainLogEntries(logsDir, { names: { self: "Wren", user: "Sam" } });
    const oldTail = snapshot.slice(-150);
    const page1 = await get(`before=${encodeURIComponent(oldTail[0]!.key!)}`);
    expect(keys(page1.lines)).toEqual(keys(snapshot.slice(-350, -150)));
    grow(900, 1700);
    const page2 = await get(`before=${encodeURIComponent(page1.lines[0].key)}`);
    expect(keys(page2.lines)).toEqual(keys(snapshot.slice(-550, -350)));
    expect(new Set(keys([...page2.lines, ...page1.lines, ...oldTail])).size).toBe(550);
    expect(page2.lines.at(-1).html).toBe("entry 549");
    expect(page1.lines[0].html).toBe("entry 550");

    const current = brainLogEntries(logsDir, { names: { self: "Wren", user: "Sam" } });
    const newTail = current.slice(-150);
    const lower = page1.lines.at(-1).key;
    const upper = newTail[0]!.key!;
    const expected = current.slice(current.findIndex((item) => item.key === lower) + 1, current.findIndex((item) => item.key === upper));
    const filled: any[] = [];
    let after = lower;
    do {
      const gap = await get(`after=${encodeURIComponent(after)}&before=${encodeURIComponent(upper)}&lines=999`);
      expect(gap.lines.length).toBeLessThanOrEqual(200);
      expect(gap.anchor_lost).toBe(false);
      filled.push(...gap.lines);
      after = gap.nextAfter;
    } while (after);
    expect(keys(filled)).toEqual(keys(expected));
    expect(new Set(keys(filled)).size).toBe(filled.length);
    const empty = await get(`after=${encodeURIComponent(oldTail[0]!.key!)}&before=${encodeURIComponent(oldTail[1]!.key!)}`);
    expect(empty.lines).toEqual([]);
    expect(empty.nextAfter).toBeNull();

    for (const query of ["before=unknown", `after=unknown&before=${encodeURIComponent(upper)}`, `after=${encodeURIComponent(upper)}&before=${encodeURIComponent(lower)}`]) {
      expect(await get(query)).toMatchObject({ lines: [], anchor_lost: true, nextOffset: null });
    }
    grow(1700, 7500);
    expect(brainLogEntries(logsDir, { names: { self: "Wren", user: "Sam" } })).toHaveLength(5000);
    expect(await get(`before=${encodeURIComponent(oldTail[0]!.key!)}`)).toMatchObject({ lines: [], anchor_lost: true, nextOffset: null });
    const retained = brainLogEntries(logsDir, { names: { self: "Wren", user: "Sam" } }).at(-1)!.key!;
    rmSync(file);
    writeFileSync(file, JSON.stringify({ ts: "2026-10-09T07:00:00Z", role: "assistant", content: "replacement" }) + "\n");
    expect(await get(`before=${encodeURIComponent(retained)}`)).toMatchObject({ lines: [], anchor_lost: true, nextOffset: null });
  });
});
