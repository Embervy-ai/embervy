// The fresh zone: the last tool steps of the ending session, appended to the bridge.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshZone, freshZoneCut } from "./fresh-zone";
import { FRESH_ZONE_INTRO, textForLanguage, tr } from "./texts";
import { extractJumpTurns, FRESH_ZONE_MARKER, logBefore, renderCapsule, writeWakeBridgeSync } from "./wake-bridge";

const rules = { userName: "User", workerName: "Worker", systemLine: /^\s*\[system\]/i, scheduledLine: /^\s*\[gateway(?::[a-z-]+)?\]/i };
const line = (record: Record<string, unknown>) => JSON.stringify(record);
const channel = (text: string) => `<channel source="app" user="User" ts="06.11.2026, 12:30:43" message_id="m1">\n${text}\n</channel>`;

// Shapes as a pipe head logs them: user turn, the pipe's tool call and result, the aggregate answer.
const log = [
  line({ ts: "2026-11-06T11:30:43.000Z", role: "user", content: `<inlet>chronicle piece</inlet>\n\n${channel("Can you check the cut?")}` }),
  line({ ts: "2026-11-06T11:30:50.000Z", role: "assistant", content: null, origin: "claude_pipe", tool_calls: [{ id: "t1", type: "function", function: { name: "Bash", arguments: JSON.stringify({ command: "grep -n cutoff logs/brain-loop.log", description: "Find the cut" }) } }] }),
  line({ ts: "2026-11-06T11:30:51.000Z", role: "tool", tool_call_id: "t1", origin: "claude_pipe", content: "347: brain exited rc=0" }),
  line({ ts: "2026-11-06T11:30:52.000Z", role: "assistant", content: null, origin: "claude_pipe", tool_calls: [{ id: "t2", type: "function", function: { name: "mcp__app__reply", arguments: JSON.stringify({ text: "Found it." }) } }] }),
  line({ ts: "2026-11-06T11:30:53.000Z", role: "tool", tool_call_id: "t2", origin: "claude_pipe", content: "Sent: Found it." }),
  line({ ts: "2026-11-06T11:30:54.000Z", role: "assistant", via: "pipe", content: "Found it.", pipe_final_text: "Terminal note that reached nobody." }),
  line({ ts: "2026-11-06T11:31:00.000Z", role: "user", origin: "cache_ping", content: "cache ping" }),
].join("\n");

describe("fresh zone", () => {
  test("carries the user's words, the tool calls with their arguments and the results, in order", () => {
    const zone = freshZone(log, rules, { maxChars: 10_000 });
    const order = ["Can you check the cut?", "→ Bash", "command: grep -n cutoff logs/brain-loop.log", "347: brain exited rc=0", "→ mcp__app__reply", "text: Found it.", "Sent: Found it."];
    let at = -1;
    for (const part of order) {
      const next = zone.indexOf(part);
      expect(next).toBeGreaterThan(at);
      at = next;
    }
    expect(zone).toContain("**User**");
  });

  test("terminal prose rides along; inlet, cache pings and channel tags stay out", () => {
    const zone = freshZone(log, rules, { maxChars: 10_000 });
    expect(zone).toContain("Terminal note that reached nobody.");
    expect(zone).toMatch(/\*\*Worker\*\* \(terminal\) · \d{2}:\d{2}/);
    for (const absent of ["chronicle piece", "cache ping", "<channel", "message_id"]) expect(zone).not.toContain(absent);
  });

  test("whole blocks from the end within the budget; long results are cut", () => {
    const long = [line({ ts: "2026-11-06T11:00:00.000Z", role: "user", content: channel("first question") }),
      line({ ts: "2026-11-06T11:00:01.000Z", role: "tool", name: "Read", tool_call_id: "x", content: "y".repeat(5000) }), log].join("\n");
    const zone = freshZone(long, rules, { maxChars: 300, resultChars: 100 });
    expect(zone).not.toContain("first question");
    expect(zone).toContain("Sent: Found it.");
    const cut = freshZone(long, rules, { maxChars: 10_000, resultChars: 100 });
    expect(cut).toContain("first question");
    expect(cut).not.toContain("y".repeat(101));
    expect(cut).toContain("4900");
  });

  test("off at zero, empty for a log without steps", () => {
    expect(freshZone(log, rules, { maxChars: 0 })).toBe("");
    expect(freshZone("", rules, { maxChars: 10_000 })).toBe("");
  });

  test("the capsule puts it after the turns, and a jump to the other house leaves it behind", () => {
    const capsule = { lint: "l", facts: ["f"], arc: "a", note: "n", turns: "**User** · 12:30\n\nhello\n", fresh: "→ Bash\nls" };
    const text = renderCapsule(capsule);
    expect(text.indexOf(FRESH_ZONE_MARKER)).toBeGreaterThan(text.indexOf("## CAPSULE: TURNS"));
    expect(text.trimEnd().endsWith("→ Bash\nls")).toBe(true);
    expect(extractJumpTurns(text).text).not.toContain("→ Bash");
    expect(extractJumpTurns(text).text).toContain("hello");
    expect(renderCapsule({ ...capsule, fresh: undefined })).not.toContain(FRESH_ZONE_MARKER);
  });
});

describe("fresh zone in a written bridge", () => {
  test("the bridge a cut writes ends with the fresh zone of the ending session", () => {
    const root = mkdtempSync(join(tmpdir(), "fresh-bridge-"));
    const logDir = join(root, "logs"), stateDir = join(root, "state");
    mkdirSync(logDir); mkdirSync(stateDir);
    const id = `${Date.now()}-abc123`;
    writeFileSync(join(logDir, `conversation-${id}.jsonl`), `${log}\n`);
    const cfg = {
      bridgeFile: join(logDir, "bridge.md"), stateDir, logDir, sessionPrefix: "Session", noBridgeMarker: "",
      mode: "sessions" as const, n: 2, turns: 40, minUserTurns: 0, ...rules,
      freshZone: (text: string) => freshZone(text, rules, { maxChars: 10_000 }),
    };
    const built = writeWakeBridgeSync(cfg, { sessionId: id, reason: "SIGTERM", model: "m", now: new Date(), wakeByBrain: true });
    expect(built && built !== "empty").toBeTruthy();
    const bridge = readFileSync(cfg.bridgeFile, "utf8");
    const turnsAt = bridge.indexOf("## CAPSULE: TURNS"), freshAt = bridge.indexOf(FRESH_ZONE_MARKER);
    expect(turnsAt).toBeGreaterThan(0);
    expect(freshAt).toBeGreaterThan(turnsAt);
    expect(bridge.slice(freshAt)).toContain("347: brain exited rc=0");
    expect(bridge.slice(turnsAt, freshAt)).not.toContain("347: brain exited rc=0");
    const without = writeWakeBridgeSync({ ...cfg, freshZone: null }, { sessionId: id, reason: "SIGTERM", model: "m", now: new Date(), wakeByBrain: true });
    expect(without && without !== "empty").toBeTruthy();
    expect(readFileSync(cfg.bridgeFile, "utf8")).not.toContain(FRESH_ZONE_MARKER);
  });
});

describe("the fresh zone takes over the end of the ending session", () => {
  const earlier = [
    line({ ts: "2026-11-06T11:00:00.000Z", role: "user", content: channel(`An earlier question about the bridge depth. ${"words ".repeat(400)}`) }),
    line({ ts: "2026-11-06T11:00:05.000Z", role: "assistant", content: null, origin: "claude_pipe", tool_calls: [{ id: "e1", type: "function", function: { name: "mcp__app__reply", arguments: JSON.stringify({ text: "Two sessions it is." }) } }] }),
    line({ ts: "2026-11-06T11:00:06.000Z", role: "tool", tool_call_id: "e1", origin: "claude_pipe", content: "Sent: Two sessions it is." }),
  ].join("\n");
  const whole = `${earlier}\n${log}`;
  const tailBudget = freshZone(log, rules, { maxChars: 100_000 }).length - tr(FRESH_ZONE_INTRO).length;

  test("it says where it begins, and never splits one record", () => {
    const cut = freshZoneCut(whole, rules, { maxChars: tailBudget });
    expect(cut.since).toBe("2026-11-06T11:30:43.000Z");
    expect(cut.text).toContain("Can you check the cut?");
    expect(cut.text).not.toContain("An earlier question");
    const all = freshZoneCut(whole, rules, { maxChars: 100_000 });
    expect(all.since).toBe("2026-11-06T11:00:00.000Z");
    expect(freshZone(whole, rules, { maxChars: tailBudget })).toBe(cut.text);
  });

  test("the log before a time keeps every line up to the first record at or after it", () => {
    const before = logBefore(whole, "2026-11-06T11:30:43.000Z");
    expect(before).toContain("An earlier question");
    expect(before).toContain("Sent: Two sessions it is.");
    expect(before).not.toContain("Can you check the cut?");
    expect(logBefore(whole, "not a time")).toBe(whole);
  });

  test("in a written bridge the turns stop where the fresh zone begins, so nothing is carried twice", () => {
    const root = mkdtempSync(join(tmpdir(), "fresh-cut-bridge-"));
    const logDir = join(root, "logs"), stateDir = join(root, "state");
    mkdirSync(logDir); mkdirSync(stateDir);
    const id = `${Date.now()}-def456`;
    writeFileSync(join(logDir, `conversation-${id}.jsonl`), `${whole}\n`);
    const cfg = {
      bridgeFile: join(logDir, "bridge.md"), stateDir, logDir, sessionPrefix: "Session", noBridgeMarker: "",
      mode: "sessions" as const, n: 2, turns: 40, minUserTurns: 0, ...rules,
      freshZone: (text: string) => freshZoneCut(text, rules, { maxChars: tailBudget }),
    };
    const built = writeWakeBridgeSync(cfg, { sessionId: id, reason: "SIGTERM", model: "m", now: new Date(), wakeByBrain: true });
    expect(built && built !== "empty").toBeTruthy();
    const bridge = readFileSync(cfg.bridgeFile, "utf8");
    const turnsAt = bridge.indexOf("## CAPSULE: TURNS"), freshAt = bridge.indexOf(FRESH_ZONE_MARKER);
    expect(freshAt).toBeGreaterThan(turnsAt);
    const turns = bridge.slice(turnsAt, freshAt), fresh = bridge.slice(freshAt);
    expect(turns).toContain("An earlier question");
    expect(turns).toContain("Two sessions it is.");
    expect(turns).not.toContain("Can you check the cut?");
    expect(turns).not.toContain("Found it.");
    expect(fresh).toContain("Can you check the cut?");
    expect(fresh).toContain("Found it.");
    expect(fresh).not.toContain("An earlier question");
  });
});

const toolCall = (name: string, id: string, args: unknown = {}) => ({
  id, type: "function", function: { name, arguments: JSON.stringify(args) },
});
const renderRecords = (records: Record<string, unknown>[], maxChars = 60_000) =>
  freshZone(records.map(line).join("\n"), rules, { maxChars });

describe("terminal speech and context filtering", () => {
  test("a standalone still marker is silent, but does not erase surrounding prose", () => {
    expect(renderRecords([{ role: "assistant", via: "pipe", pipe_final_text: " \n[still]\n " }])).toBe("");
    const zone = renderRecords([{ role: "assistant", via: "pipe", pipe_final_text: "[still]\nKeep working." }]);
    expect(zone).toContain("Keep working.");
    expect(zone).not.toContain("[still]");
    expect(renderRecords([{ role: "assistant", content: "[still]" }])).toBe("");
  });

  test("reply duplicates are suppressed only within the same turn", () => {
    for (const final of [{ via: "pipe", pipe_final_text: "  Already sent.  " }, { content: "  Already sent.  " }]) {
      const records = [
        { role: "assistant", tool_calls: [toolCall("mcp__app__reply", "reply", { text: "Already sent." })] },
        { role: "tool", tool_call_id: "reply", content: "ok" },
        { role: "assistant", ...final },
      ];
      const once = renderRecords(records);
      expect(once.split("Already sent.")).toHaveLength(2);
      expect(once).not.toContain("(terminal)");
      const twice = renderRecords([...records, { role: "user", content: channel("Again?") }, { role: "assistant", ...final }]);
      expect(twice.split("Already sent.")).toHaveLength(3);
      expect(twice).toContain("(terminal)");
    }
  });

  test("API prose uses content and honors explicit and late outreach receipts", () => {
    expect(renderRecords([{ role: "assistant", content: "Private progress.", outreach_text: "" }])).toContain("Private progress.");
    expect(renderRecords([{ role: "assistant", content: "Delivered.", outreach_text: "Delivered." }])).toBe("");
    expect(renderRecords([
      { role: "assistant", speech_id: "s1", content: "Delivered.", outreach_text: "" },
      { role: "system", speech_update: "s1", outreach_text: "Delivered." },
    ])).toBe("");
    expect(renderRecords([{ role: "assistant", via: "pipe", content: "Aggregate, not terminal." }])).toBe("");
    expect(renderRecords([{ role: "assistant", intermediate: true, content: "Intermediate." }])).toBe("");
  });

  test("system and task records stay out while person and room messages remain", () => {
    const zone = renderRecords([
      { role: "user", content: "[task] Background command finished" },
      { role: "user", content: "[system] Internal status" },
      { role: "user", content: "[gateway:reply] Internal scheduled status" },
      { role: "user", content: '<channel kind="scheduled">Scheduled input</channel>' },
      { role: "user", content: channel("Person's words") },
      { role: "user", content: channel("[Workshop/Peer] Room words") },
    ]);
    for (const absent of ["Background", "Internal", "Scheduled input", "**System**"]) expect(zone).not.toContain(absent);
    expect(zone).toContain("Person's words");
    expect(zone).toContain("**Peer**");
    expect(zone).toContain("Room words");
  });

  test("inlet and body-state fragments are removed without discarding the surrounding work", () => {
    const dirty = "Before\n<inlet>private retrieval\nmore retrieval</inlet>\nSENSE · private state\nAfter";
    const zone = renderRecords([
      { role: "user", content: dirty },
      { role: "user", content: channel(dirty) },
      { role: "assistant", via: "pipe", pipe_final_text: dirty },
      { role: "assistant", tool_calls: [toolCall("Write", "w1", { content: dirty })] },
      { role: "tool", tool_call_id: "w1", content: [{ type: "text", text: dirty }] },
    ]);
    for (const absent of ["<inlet>", "retrieval", "SENSE ·", "private state"]) expect(zone).not.toContain(absent);
    expect(zone.split("Before")).toHaveLength(6);
    expect(zone.split("After")).toHaveLength(6);
  });

  test("the introduction describes selective shortening", () => {
    expect(textForLanguage("en", FRESH_ZONE_INTRO)).toContain("only what was read is shortened");
  });
});

describe("selective shortening and whole records", () => {
  const output = "r".repeat(7000);
  const resultRecords = (name: string, extra: Record<string, unknown> = {}) => [
    { role: "assistant", tool_calls: [toolCall(name, "t1")] },
    { role: "tool", tool_call_id: "t1", content: output, ...extra },
  ];

  test("read, search and fetch tools shorten results at 6000 characters", () => {
    const names = ["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch", "ToolSearch", "namespace.Read",
      ...["read", "find", "recall", "scan", "search", "list", "wake", "fetch", "get", "see"].map((name) => `mcp__memory__${name}`)];
    for (const name of names) {
      const zone = renderRecords(resultRecords(name));
      expect(zone).toContain("r".repeat(6000));
      expect(zone).not.toContain("r".repeat(6001));
      expect(zone).toContain(`1000 ${tr("characters cut")}`);
    }
  });

  test("commands, writes, replies, unknown tools and read errors remain whole", () => {
    for (const name of ["Bash", "Write", "Edit", "mcp__app__reply", "mcp__memory__write", "search", "unknown"]) {
      expect(renderRecords(resultRecords(name))).toContain(output);
    }
    expect(renderRecords([{ role: "tool", content: output }])).toContain(output);
    expect(renderRecords(resultRecords("Read", { is_error: true }))).toContain(output);
    expect(renderRecords(resultRecords("Read", { content: `error: ${output}` }))).toContain(output);
    expect(renderRecords(resultRecords("Read", { content: JSON.stringify({ isError: true, text: output }) }))).toContain(output);
  });

  test("result names are matched by call id, not the most recent call", () => {
    const zone = renderRecords([
      { role: "assistant", tool_calls: [toolCall("Read", "read"), toolCall("Bash", "bash")] },
      { role: "tool", tool_call_id: "bash", content: "b".repeat(7000) },
      { role: "tool", tool_call_id: "read", content: output },
    ]);
    expect(zone).toContain("b".repeat(7000));
    expect(zone).not.toContain("r".repeat(6001));
  });

  test("delivery receipts never remove failed calls or their results", () => {
    const zone = renderRecords([
      { role: "assistant", speech_id: "failed", tool_calls: [toolCall("mcp__app__reply", "reply", { text: "Attempted reply." })] },
      { role: "tool", tool_call_id: "reply", content: `error: ${output}` },
      { role: "assistant", content: "Investigate the failure.", outreach_text: "" },
      { role: "system", speech_update: "failed", outreach_text: "" },
    ]);
    expect(zone).toContain("Attempted reply.");
    expect(zone).toContain(output);
    expect(zone).toContain("Investigate the failure.");
  });

  test("arguments ignore the legacy 3000-character limit", () => {
    const records = [{ role: "assistant", tool_calls: [toolCall("Write", "w", { content: output })] }];
    const zone = freshZone(records.map(line).join("\n"), rules, { maxChars: 60_000, argChars: 20 });
    expect(zone).toContain(output);
  });

  test("each block, including its header and truncation notice, fits one third of maxChars", () => {
    for (const record of [
      { role: "tool", name: "Bash", content: output },
      { role: "tool", name: "Read", content: output, is_error: true },
      { role: "assistant", tool_calls: [toolCall("Write", "w", { content: output })] },
      { role: "assistant", via: "pipe", pipe_final_text: output },
      { role: "user", content: channel(output) },
    ]) {
      const zone = renderRecords([record], 18_000);
      const block = zone.slice(tr(FRESH_ZONE_INTRO).length + 2);
      expect(block.length).toBeLessThanOrEqual(6000);
      expect(block).toContain(tr("characters cut"));
      expect(block).not.toContain(output);
    }
    expect(renderRecords([{ role: "tool", name: "Bash", content: output }], 30_000)).toContain(output);
  });

  test("person and terminal text do not use the read-result limit", () => {
    expect(renderRecords([{ role: "user", content: channel(output) }])).toContain(output);
    expect(renderRecords([{ role: "assistant", content: output }])).toContain(output);
  });

  test("a boundary never splits the tool calls or channel bodies of one record", () => {
    for (const record of [
      { role: "assistant", tool_calls: Array.from({ length: 5 }, (_, i) => toolCall("Write", `w${i}`, { content: `part${i} ${"x".repeat(500)}` })) },
      { role: "user", content: Array.from({ length: 5 }, (_, i) => channel(`part${i} ${"x".repeat(500)}`)).join("\n") },
    ]) {
      const cut = freshZoneCut([
        line({ role: "user", ts: "2026-11-06T10:00:00.000Z", content: "Earlier record" }),
        line({ ...record, ts: "2026-11-06T11:00:00.000Z" }),
      ].join("\n"), rules, { maxChars: 300 });
      expect(cut.since).toBe("2026-11-06T11:00:00.000Z");
      expect(cut.text).not.toContain("Earlier record");
      for (let i = 0; i < 5; i++) expect(cut.text).toContain(`part${i}`);
    }
  });
});

describe("pictures in tool results", () => {
  const base64 = "iVBORw0KGgo".repeat(800);
  const picture = [{ type: "text", text: "Screenshot of the settings" }, { type: "image", source: { type: "base64", media_type: "image/png", data: base64 } }];
  const withPicture = (content: unknown) => [
    line({ ts: "2026-11-07T07:30:00.000Z", role: "assistant", content: null, origin: "claude_pipe", tool_calls: [{ id: "r1", type: "function", function: { name: "Read", arguments: JSON.stringify({ file_path: "/tmp/shot.png" }) } }] }),
    line({ ts: "2026-11-07T07:30:01.000Z", role: "tool", tool_call_id: "r1", origin: "claude_pipe", content }),
  ].join("\n");

  test("an image block becomes one short line, never its data, whether the log keeps blocks or their JSON", () => {
    for (const content of [picture, JSON.stringify(picture)]) {
      const zone = freshZone(withPicture(content), rules, { maxChars: 10_000 });
      expect(zone).toContain("Screenshot of the settings");
      expect(zone).toContain(`[${tr("image")}]`);
      expect(zone).not.toContain("iVBORw0KGgo");
    }
  });

  test("a result that only looks like a list stays as it is", () => {
    const zone = freshZone(withPicture("[1, 2, 3] rows found"), rules, { maxChars: 10_000 });
    expect(zone).toContain("[1, 2, 3] rows found");
  });
});

describe("internal inputs and a short first session", () => {
  const internalLog = [
    line({ ts: "2026-11-09T05:00:00.000Z", role: "user", content: "A new session has started after a cut or restart; pick up quietly.", internal_input: true }),
    line({ ts: "2026-11-09T05:00:05.000Z", role: "user", content: channel("Is the bridge there?") }),
    line({ ts: "2026-11-09T05:00:06.000Z", role: "assistant", content: null, origin: "claude_pipe", tool_calls: [toolCall("Bash", "b1", { command: "ls logs" })] }),
    line({ ts: "2026-11-09T05:00:07.000Z", role: "tool", tool_call_id: "b1", origin: "claude_pipe", content: "bridge.md" }),
  ].join("\n");

  test("an internal input never enters the fresh zone", () => {
    const zone = freshZone(internalLog, rules, { maxChars: 60_000 });
    expect(zone).toContain("Is the bridge there?");
    expect(zone).not.toContain("pick up quietly");
  });

  test("a session that fits wholly into the fresh zone still writes a bridge with it", () => {
    const root = mkdtempSync(join(tmpdir(), "fresh-only-"));
    const logDir = join(root, "logs"), stateDir = join(root, "state");
    mkdirSync(logDir); mkdirSync(stateDir);
    const id = `${Date.now()}-fff111`;
    writeFileSync(join(logDir, `conversation-${id}.jsonl`), `${internalLog}\n`);
    const cfg = {
      bridgeFile: join(logDir, "bridge.md"), stateDir, logDir, sessionPrefix: "Session", noBridgeMarker: "",
      mode: "sessions" as const, n: 1, turns: 40, minUserTurns: 0, ...rules,
      freshZone: (text: string) => freshZoneCut(text, rules, { maxChars: 120_000 }),
    };
    const built = writeWakeBridgeSync(cfg, { sessionId: id, reason: "SIGTERM", model: "m", now: new Date(), wakeByBrain: true });
    expect(built && built !== "empty").toBeTruthy();
    const bridge = readFileSync(cfg.bridgeFile, "utf8");
    expect(bridge).toContain(FRESH_ZONE_MARKER);
    expect(bridge.slice(bridge.indexOf(FRESH_ZONE_MARKER))).toContain("Is the bridge there?");
  });
});
