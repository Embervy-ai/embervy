import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { paneHasClaude } from "./pane-claude";
import { join } from "node:path";
import { envValue } from "../../shared/scripts/legacy-names";
import { FIRST_START_NOTICE, UNKNOWN_INPUT_NOTICE, deliverUnlessFirstStart, hasFirstStartDialog, inputReadiness } from "./first-start-guard";

const workspaceTrust = `Accessing workspace:

/opt/embervy

Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

Security guide

❯ No, exit
  Yes, I trust this folder

Enter to confirm · Esc to cancel`;

describe("first-start guard", () => {
  test("recognises the workspace trust dialog and independent trust cues", () => {
    expect(hasFirstStartDialog(workspaceTrust)).toBe(true);
    expect(hasFirstStartDialog(`\x1b[1m${workspaceTrust.replace("Quick safety check", "Quick\nsafety check")}\x1b[0m`)).toBe(true);
    for (const cue of ["Quick safety check", "Yes, I trust this folder", "Accessing workspace:"]) {
      expect(hasFirstStartDialog(cue)).toBe(true);
      expect(hasFirstStartDialog(workspaceTrust.replace(cue, "Reworded"))).toBe(true);
    }
  });
  test("recognises Claude Code's first-start questions, also through colour codes and wrapping", () => {
    expect(hasFirstStartDialog("\x1b[1mDo you trust the files\nin this folder?\x1b[0m\n❯ 1. Yes, proceed\n  2. No, exit")).toBe(true);
    expect(hasFirstStartDialog("Choose the text style that looks best with your terminal")).toBe(true);
    expect(hasFirstStartDialog("2 new MCP servers found in .mcp.json")).toBe(true);
    expect(hasFirstStartDialog("> hello\n● Hi, I'm here.")).toBe(false);
  });

  test.each([
    { name: "legacy trust", pane: "Do you trust the files in this folder?" },
    { name: "workspace trust", pane: workspaceTrust },
  ])("$name holds the message back and tells the person why", async ({ pane }) => {
    let sent = 0;
    const notices: string[] = [];
    const delivered = await deliverUnlessFirstStart(async () => pane, () => { sent++; }, (t) => { notices.push(t); });
    expect(delivered).toBe(false);
    expect(sent).toBe(0);
    expect(notices).toEqual([FIRST_START_NOTICE]);
  });

  test("an empty pane or a failing capture delivers for wake-up", async () => {
    for (const capture of [async () => "", async () => "  \n\t", async () => { throw new Error("no session"); }]) {
      let sent = 0;
      const notices: string[] = [];
      expect(await deliverUnlessFirstStart(capture, () => { sent++; }, (t) => { notices.push(t); })).toBe(true);
      expect(sent).toBe(1);
      expect(notices).toEqual([]);
    }
  });
});

test("server forwards the house input guard setting and preserves the Brain bypass", async () => {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const start = source.indexOf('let lastInputGuardNotice = "";');
  const end = source.indexOf("const TEXT_CLIENT_ID_RE", start);
  expect(start).toBeGreaterThan(-1);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  for (const brain of [false, true]) for (const mode of [undefined, "known"]) {
    const delivered: unknown[] = [], notices: any[] = [];
    const deliver = new Function("BRAIN_HARNESS", "captureFirstStartPane", "deliverUnlessFirstStart", "envValue", "appendFileSync", "INBOX", "generateId", "appendToOutbox", "broadcastToClients", code + "return deliverChatMessage;")(
      brain, async () => unknownQuestion, deliverUnlessFirstStart,
      (name: string) => envValue(name, { EMBERVY_INPUT_GUARD: mode }),
      (_file: string, text: string) => delivered.push(JSON.parse(text)), "inbox", () => "notice-1", (msg: any) => notices.push(msg), () => {},
    );
    const msg = { id: "message-1", text: "hello", ts: "now", type: "text" };
    expect(await deliver(msg)).toBe(brain || mode === "known");
    expect(delivered).toEqual(brain || mode === "known" ? [msg] : []);
    expect(notices.map(msg => msg.text)).toEqual(brain || mode === "known" ? [] : [UNKNOWN_INPUT_NOTICE]);
  }
});

test("house question API and UI regression suites", () => {
  const result = Bun.spawnSync([process.execPath, "test", "./house-question.test.ts", "./house-question-ui.test.ts"], {
    cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  expect(result.stderr.toString()).not.toContain("(fail)");
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
});

const unknownQuestion = "May this house borrow a moon?\nPress any key";

describe("positive input readiness", () => {
  test.each([
    { name: "real input box with status footer", pane: () => runningInput },
    { name: "working agent above input", pane: () => `● Reading the files…\n${runningInput}` },
    ...["❯", "›", ">"].map(prompt => ({ name: `${prompt} input`, pane: () => runningInput.replace("❯", prompt) })),
  ])("delivers with $name", async ({ pane }) => {
    let sent = 0;
    expect(inputReadiness(pane())).toBe("ready");
    expect(await deliverUnlessFirstStart(async () => pane(), () => { sent++; }, () => { throw new Error("unexpected notice"); })).toBe(true);
    expect(sent).toBe(1);
  });

  test.each([
    { name: "wrapped typed text", pane: () => wrappedInput },
    { name: "unknown question", pane: () => unknownQuestion },
    { name: "nonempty startup output", pane: () => "Starting Claude Code" },
    { name: "unframed prompt", pane: () => "❯ hello" },
    { name: "box buried in output", pane: () => `${runningInput}\n${"More output\n".repeat(6)}` },
    { name: "incomplete box", pane: () => "──────────\n❯\u00a0" },
  ])("holds $name unless known-only mode is selected", async ({ pane }) => {
    expect(inputReadiness(pane())).toBe("unknown");
    for (const mode of [undefined, "known", "invalid"]) {
      const notices: string[] = [];
      let sent = 0;
      const delivered = await deliverUnlessFirstStart(async () => pane(), () => { sent++; }, text => { notices.push(text); }, mode);
      expect(delivered).toBe(mode === "known");
      expect(sent).toBe(mode === "known" ? 1 : 0);
      expect(notices).toEqual(mode === "known" ? [] : [UNKNOWN_INPUT_NOTICE]);
    }
  });

  test.each([1, 2, 3, 4, 12])("rejects foreign input with %s continuation lines", async count => {
    const pane = runningInput.replace("❯\u00a0", `❯ foreign text${"\n  continued".repeat(count)}`);
    expect(inputReadiness(pane)).toBe("unknown");
    let sent = 0;
    expect(await deliverUnlessFirstStart(async () => pane, () => { sent++; }, () => {})).toBe(false);
    expect(sent).toBe(0);
  });

  test("known-only mode still holds a known question with the original notice", async () => {
    const notices: string[] = [];
    expect(inputReadiness(workspaceTrust)).toBe("known");
    expect(await deliverUnlessFirstStart(async () => workspaceTrust, () => { throw new Error("must not send"); }, text => { notices.push(text); }, "known")).toBe(false);
    expect(notices).toEqual([FIRST_START_NOTICE]);
  });
});

const workspaceTrustWithRule = `────────────────────────────────────────────────────────
${workspaceTrust}`;

const runningInput = `  3 more notices hidden

                                        ✔ Update installed · /restart to apply
──────────────────────────────────────────────────────────────────────────────
❯\u00a0
──────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;

const conversationCues = `● Here is the guard's regex as a diff:
+  return /Do you trust the files in this folder|Quick safety check|Yes, I trust this folder|Accessing workspace:|Choose the text style|new MCP servers/i.test(plain);
● The instructions say: “Quick safety check … Yes, I trust this folder”.`;

const wrappedInput = runningInput.replace("❯\u00a0", "❯ Please explain this change\n  and keep the answer short\n  enough to read here.");

describe("first-start guard input boxes", () => {
  test.each([
    { name: "workspace trust with its upper rule", pane: workspaceTrustWithRule, blocked: true },
    { name: "quoted cues followed by the live input", pane: `${conversationCues}\n${runningInput}`, blocked: false },
    { name: "quoted cues followed by wrapped typed input", pane: `${conversationCues}\n${wrappedInput}`, blocked: false },
    { name: "live trust dialog after an earlier input", pane: `${conversationCues}\n${runningInput}\n${workspaceTrustWithRule}`, blocked: true },
    { name: "cue without a recognisable input", pane: "● Quick safety check", blocked: true },
  ])("$name controls delivery", async ({ pane, blocked }) => {
    expect(hasFirstStartDialog(pane)).toBe(blocked);
    let sent = 0;
    const notices: string[] = [];
    const ready = inputReadiness(pane) === "ready";
    expect(await deliverUnlessFirstStart(async () => pane, () => { sent++; }, (text) => { notices.push(text); })).toBe(ready);
    expect(sent).toBe(ready ? 1 : 0);
    expect(notices).toEqual(blocked ? [FIRST_START_NOTICE] : ready ? [] : [UNKNOWN_INPUT_NOTICE]);
  });

  test.each([
    "Do you trust the files in this folder",
    "Quick safety check",
    "Yes, I trust this folder",
    "Accessing workspace:",
    "Choose the text style",
    "new MCP servers",
  ])("recognises wrapped, coloured conversation cue: %s", (cue) => {
    const wrapped = cue.replace(/ /g, "\n  ");
    const pane = `  \x1b[1m${wrapped}\x1b[0m\n${runningInput}`;
    expect(hasFirstStartDialog(pane)).toBe(false);
    expect(hasFirstStartDialog(`  \x1b[1m${wrapped}\x1b[0m`)).toBe(true);
    expect(hasFirstStartDialog(`${pane}\n${cue}`)).toBe(true);
  });

  test.each(["❯", "›", ">"])("accepts an indented, coloured %s input with CRLF", (prompt) => {
    const pane = `${conversationCues}\n${wrappedInput.replace("❯", prompt)}`
      .split("\n").map((line) => `  \x1b[32m${line}\x1b[0m`).join("\r\n");
    expect(hasFirstStartDialog(pane)).toBe(false);
  });

  test("accepts ten-character rules and up to three continuation lines", () => {
    expect(hasFirstStartDialog("Quick safety check\n──────────\n> typed\n  one\n  two\n  three\n──────────\nstatus")).toBe(false);
  });

  test.each([
    { name: "menu without rules", box: "❯ No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel" },
    { name: "missing upper rule", box: "❯\u00a0\n──────────" },
    { name: "missing lower rule", box: "──────────\n❯\u00a0\nstatus" },
    { name: "short upper rule", box: "─────────\n❯\u00a0\n──────────" },
    { name: "short lower rule", box: "──────────\n❯\u00a0\n─────────" },
    { name: "gap above the prompt", box: "──────────\n\n❯\u00a0\n──────────" },
    { name: "distant lower rule", box: "──────────\n❯ typed\n  one\n  two\n  three\n  four\n──────────" },
    { name: "rule on the cue line", box: "──────────\n❯\u00a0\n──────────", separator: "" },
  ])("keeps blocking with $name", ({ box, separator }) => {
    expect(hasFirstStartDialog(`Quick safety check${separator ?? "\n"}${box}`)).toBe(true);
  });
});

const paneDirectory = join(import.meta.dir, "test-fixtures/panes");
const paneCases = [
  ["idle", "ready"],
  ["idle-typed", "ready"],
  ["working", "ready"],
  ["working-later", "ready"],
  ["turn-done", "ready"],
  ["turn-done-accept-edits", "ready"],
  ["mode-accept-edits", "ready"],
  ["mode-plan", "ready"],
  ["mode-auto", "ready"],
  ["mode-manual", "ready"],
  ["after-cancel", "ready"],
  ["background-shell", "ready"],
  ["input-cleared", "ready"],
  ["onboarding-theme", "known"],
  ["onboarding-security-notes", "unknown"],
  ["trust-question", "known"],
  ["trust-question-restart", "known"],
  ["model-menu", "unknown"],
  ["permission-question", "unknown"],
  ["long-input", "unknown"],
  ["shell-after-exit", "unknown"],
] as const;

describe("captured Claude Code panes", () => {
  test("every fixture has exactly one expectation", () => {
    const files = paneCases.map(([name]) => `${name}.txt`);
    expect(new Set(files).size).toBe(files.length);
    expect(files.sort()).toEqual(readdirSync(paneDirectory).sort());
  });

  test.each(paneCases)("%s is %s and only ready panes deliver chat", async (name, expected) => {
    const pane = readFileSync(join(paneDirectory, `${name}.txt`), "utf8");
    expect(inputReadiness(pane)).toBe(expected);
    let sent = 0;
    const notices: string[] = [];
    expect(await deliverUnlessFirstStart(async () => pane, () => { sent++; }, text => { notices.push(text); })).toBe(expected === "ready");
    expect(sent).toBe(expected === "ready" ? 1 : 0);
    expect(notices).toEqual(expected === "ready" ? [] : [expected === "known" ? FIRST_START_NOTICE : UNKNOWN_INPUT_NOTICE]);
  });
});

function serverDelivery(capture: () => Promise<string>, brain = false) {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const start = source.indexOf('let lastInputGuardNotice = "";');
  const end = source.indexOf("const TEXT_CLIENT_ID_RE", start);
  expect(start).toBeGreaterThan(-1);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  const inbox: any[] = [], outbox: any[] = [], events: any[] = [];
  const deliver = new Function("BRAIN_HARNESS", "captureFirstStartPane", "deliverUnlessFirstStart", "envValue", "appendFileSync", "INBOX", "generateId", "appendToOutbox", "broadcastToClients", code + "return deliverChatMessage;")(
    brain, capture, deliverUnlessFirstStart, () => undefined,
    (_file: string, text: string) => inbox.push(JSON.parse(text)), "inbox", () => crypto.randomUUID(),
    (msg: any) => outbox.push(msg), (event: any) => events.push(event),
  );
  return { deliver: () => deliver({ id: crypto.randomUUID(), text: "hello", ts: "now", type: "text" }), inbox, outbox, events };
}

test("both guard hints appear once per wait, including overlapping messages", async () => {
  let pane = unknownQuestion;
  const f = serverDelivery(async () => pane);
  for (const screen of [unknownQuestion, workspaceTrust, unknownQuestion]) {
    pane = screen;
    const count = f.outbox.length;
    expect(await Promise.all([f.deliver(), f.deliver(), f.deliver()])).toEqual([false, false, false]);
    expect(f.outbox).toHaveLength(count + 1);
    expect(f.events).toHaveLength(count + 1);
    expect(f.inbox).toHaveLength(0);
  }
  expect(f.outbox.map(m => m.text)).toEqual([UNKNOWN_INPUT_NOTICE, FIRST_START_NOTICE, UNKNOWN_INPUT_NOTICE]);
  pane = runningInput;
  expect(await f.deliver()).toBe(true);
  pane = unknownQuestion;
  expect(await f.deliver()).toBe(false);
  expect(f.outbox).toHaveLength(4);
  expect(f.inbox).toHaveLength(1);
  expect(UNKNOWN_INPUT_NOTICE).toMatch(/^[^.!?]+[.]$/);
  expect(UNKNOWN_INPUT_NOTICE).toContain("open TUI at the top");
});

function serverCapture(probe: typeof paneHasClaude, spawn: typeof Bun.spawn) {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const start = source.indexOf("async function captureFirstStartPane(");
  const end = source.indexOf('let lastInputGuardNotice = "";', start);
  expect(start).toBeGreaterThan(-1);
  const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end));
  return new Function("paneHasClaude", "TERMINAL_TMUX_SESSION", "TERMINAL_TMUX_SOCKET", "terminalCommand", "Bun", code + "return captureFirstStartPane;")(
    probe, "fixture-session", "fixture-socket", (command: string, args: string[]) => [command, ...args], { spawn },
  ) as () => Promise<string>;
}

test("a shell-only pane queues chat without capturing, notifying or typing terminal keys", async () => {
  const capture = serverCapture(async (target, socket) => {
    expect([target, socket]).toEqual(["fixture-session", "fixture-socket"]);
    return false;
  }, (() => { throw new Error("must not capture or type into a shell"); }) as any);
  const f = serverDelivery(capture);
  expect(await f.deliver()).toBe(true);
  expect(f.inbox).toHaveLength(1);
  expect(f.outbox).toEqual([]);
  expect(f.events).toEqual([]);
});

test("running panes are captured without joining wrapped input", async () => {
  let pane = readFileSync(join(paneDirectory, "long-input.txt"), "utf8");
  const capture = serverCapture(async () => true, ((args: string[], options: any) => {
    expect(args).toEqual(["capture-pane", "-p"]);
    expect(options.stdout).toBe("pipe");
    return { stdout: new Response(pane).body, exited: Promise.resolve(0) };
  }) as any);
  const f = serverDelivery(capture);
  expect(await f.deliver()).toBe(false);
  expect(f.inbox).toHaveLength(0);
  pane = runningInput;
  expect(await f.deliver()).toBe(true);
  expect(f.inbox).toHaveLength(1);
});

test("the app reuses the loop probe with its exact target, socket and process-session rules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "app-pane-check-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const calls = join(dir, "calls");
    writeFileSync(join(bin, "tmux"), `#!/bin/bash
printf 'tmux:%s\\n' "$*" >> "$CALLS"
[ "$PROBE" != failed ] || exit 1
[ "$PROBE" != timeout ] || exec /bin/sleep 5
printf '%s\\n' "$PANE_PID"
`, { mode: 0o755 });
    writeFileSync(join(bin, "pgrep"), `#!/bin/bash
printf 'pgrep:%s\\n' "$*" >> "$CALLS"
[ "$PROBE" = running ]
`, { mode: 0o755 });
    for (const [pid, status, expected] of [
      ["1234", "running", true], ["1234", "stopped", false], ["1234", "failed", false],
      ["0", "running", false], ["not-a-pid", "running", false], ["", "running", false],
      ["1234", "timeout", false],
    ] as const) {
      writeFileSync(calls, "");
      const env = { PATH: `${bin}:/usr/bin:/bin`, CALLS: calls, PANE_PID: pid, PROBE: status, EMBERVY_TMUX_SOCKET: "wrong-socket" };
      const timeoutMs = status === "timeout" ? 100 : 1000;
      expect(await paneHasClaude("%42; echo unsafe", "fixture-socket", { env, timeoutMs })).toBe(expected);
      const log = readFileSync(calls, "utf8");
      expect(log).toContain("tmux:-L fixture-socket display-message -p -t %42; echo unsafe #{pane_pid}\n");
      if (pid === "1234" && !["failed", "timeout"].includes(status)) {
        expect(log).toContain("pgrep:-s 1234 -x claude|node\n");
      } else {
        expect(log).not.toContain("pgrep:");
      }
      if (!expected) {
        const f = serverDelivery(serverCapture((target, socket) => paneHasClaude(target, socket, { env, timeoutMs }), (() => { throw new Error("must not capture"); }) as any));
        expect(await f.deliver()).toBe(true);
        expect(f.inbox).toHaveLength(1);
        expect(f.outbox).toEqual([]);
      }
    }
    expect(await paneHasClaude("%42", "fixture-socket", { env: { PATH: "/missing" } })).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
