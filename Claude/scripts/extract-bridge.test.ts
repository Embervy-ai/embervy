import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Write the bridge beside the destination and rename it atomically so a cut
// cannot leave a partial bridge; preserve the mode and clean up on failure.

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const SCRIPT = join(import.meta.dir, "extract_bridge.py");

for (const customState of [false, true]) test(`bridge keeps outreach and proven gateway text, custom state ${customState}`, () => {
  const root = tempDir("bridge-outreach-");
  const state = join(root, customState ? "delivery-state" : "state");
  mkdirSync(state);
  const session = join(root, "session.jsonl"), out = join(root, "bridge.md");
  const text = (text: string) => ({ type: "text", text });
  const tool = (name: string, input: object) => ({ type: "tool_use", name, input, id: name });
  const turns = [
    [text("plain after person")],
    [tool("mcp__app__reply", { text: "reply answer" }), text("terminal summary")],
    [tool("mcp__app__voice_reply", { text: "spoken answer" })],
    [tool("mcp__app__peer", { to: "recipient", text: "direct answer" })],
    [tool("mcp__app__email", { to: "reader@example.test", subject: "Update", body: "mail body" })],
    [text("uuid delivered")],
    [text("hash delivered")],
    [text("unrecorded text")],
    [text("house terminal")],
    [tool("mcp__app__reply", { text: "house outreach" }), text("house summary")],
    [{ type: "thinking", thinking: "private reasoning" }],
    [tool("mcp__app__room", { text: "room answer" })],
  ];
  const rows = turns.flatMap((content, i) => [
    { type: "user", message: { role: "user", content: i === 8 || i === 9 ? "[gateway:silent] house prompt" : `person turn ${i}` } },
    { type: "assistant", uuid: `assistant-${i}`, message: { role: "assistant", content } },
    ...(i === 4 ? [{ type: "user", message: { role: "user", content: [{ type: "tool_result",
      tool_use_id: "mcp__app__email", content: "[Email outgoing] id=mail status=sent" }] } }] : []),
  ]);
  writeFileSync(session, rows.map(row => JSON.stringify(row)).join("\n"));
  writeFileSync(join(state, "gateway-sent-uuids.log"), "assistant-5\n");
  writeFileSync(join(state, "gateway-sent-hashes.log"), createHash("sha256").update("hash delivered").digest("hex") + "\n");
  const run = Bun.spawnSync(["python3", SCRIPT, "40", out], { env: {
    PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, SESSION_FILE: session,
    ...(customState ? { EMBERVY_GATEWAY_STATE_DIR: state } : {}),
  }, stdout: "pipe", stderr: "pipe" });
  expect(run.exitCode).toBe(0);
  const output = readFileSync(out, "utf8");
  for (const kept of ["[App] reply answer", "[App] spoken answer", "[Direct/recipient] direct answer",
    "[Email to reader@example.test]\nSubject: Update\n\nmail body", "[App] uuid delivered", "[App] hash delivered",
    "[App] house outreach", "[Room] room answer"]) expect(output).toContain(kept);
  for (const dropped of ["plain after person", "terminal summary", "unrecorded text", "house terminal", "house summary",
    "private reasoning", "house prompt"]) expect(output).not.toContain(dropped);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 10, 11]) expect(output).toContain(`person turn ${i}`);
  expect(output.match(/\*\*Agent\*\*/g)).toHaveLength(8);
  expect(output.match(/\*\*User\*\*/g)).toHaveLength(10);
});

describe("bridge inbound attribution", () => {
  const cases = [
    { label: "task state is system speech", content: "<task-notification><summary>background complete</summary></task-notification>", speaker: "System", kept: "background complete" },
    { label: "direct sender keeps the clock", content: "[Direct/sender] direct text", speaker: "sender", kept: "[Direct/sender] direct text" },
    { label: "metadata is absent", content: "metadata payload", isMeta: true },
    { label: "a channel message the harness marks as meta is kept", content: '<channel source="app">[space/participant] room line</channel>', isMeta: true, speaker: "participant", kept: "[space/participant] room line" },
    { label: "interruption is absent", content: "[Request interrupted by user]" },
    { label: "hook feedback is absent", content: "Stop hook feedback: internal diagnostic" },
    { label: "orphan channel tags are absent", content: "<channel>[space/sender] clean</channel></channel>", speaker: "sender", kept: "[space/sender] clean" },
  ];
  for (const sample of cases) test(sample.label, () => {
    const root = tempDir("bridge-inbound-");
    const session = join(root, "session.jsonl"), out = join(root, "bridge.md");
    const timestamp = new Date(0).toISOString();
    writeFileSync(session, [
      { type: "user", timestamp, message: { role: "user", content: "ordinary  message\nsecond line" } },
      { type: "user", timestamp, isMeta: sample.isMeta, message: { role: "user", content: sample.content } },
    ].map(row => JSON.stringify(row)).join("\n"));
    const run = Bun.spawnSync(["python3", SCRIPT, "40", out], { env: {
      PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, SESSION_FILE: session,
      USER_LABEL: "Person", EMBERVY_ROOM_NAME: "space", EMBERVY_TIMEZONE: "UTC",
    }, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    const output = readFileSync(out, "utf8");
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC",
    }).formatToParts(new Date(0)).map(part => [part.type, part.value]));
    const day = `${parts.weekday}, ${parts.day} ${parts.month} ${parts.year}`;
    expect(output).toContain(`## ${day}\n\n**Person** · 00:00\n\nordinary  message\nsecond line\n\n---\n`);
    expect(output.match(/\*\*Person\*\*/g)).toHaveLength(1);
    if (sample.kept) expect(output).toContain(`**${sample.speaker}** · 00:00\n\n${sample.kept}\n\n---\n`);
    else expect(output).not.toContain(sample.content);
    expect(output).not.toContain("</channel");
    expect(output).not.toContain("<task-notification>");
  });
});

function sessionsFixture() {
  const dir = tempDir("bridge-sessions-");
  const out = join(dir, "bridge.md");
  const stamp = (order: number) => new Date(order * 1000).toISOString();
  const session = (id: string, order: number, turns = 8, marker: object = {}, prefix = "") => {
    const path = join(dir, `${id}.jsonl`);
    const rows: object[] = [{ type: "system", timestamp: stamp(order), ...marker }];
    for (let i = 0; i < turns; i++) rows.push(
      { type: "user", timestamp: stamp(order), message: { role: "user", content: `<system-reminder>discard</system-reminder>${prefix}${id}-turn-${i}` } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__app__reply", input: { text: `${id}-reply-${i}` } }] } },
    );
    writeFileSync(path, rows.map(row => JSON.stringify(row)).join("\n"));
    utimesSync(path, order, order);
    return path;
  };
  const run = (pin: string, extra: Record<string, string> = {}, args: string[] = [], script = SCRIPT) => Bun.spawnSync(["python3", script, ...args, "--output", out], {
    env: { PATH: process.env.PATH!, HOME: dir, EMBERVY_HOME: dir, CLAUDE_PROJECT_DIR: dir, SESSION_FILE: pin, EMBERVY_BRIDGE_MODE: "sessions", ...extra },
    stdout: "pipe", stderr: "pipe",
  });
  return { dir, out, session, run, stamp, text: () => readFileSync(out, "utf8") };
}

describe("bridge session selection", () => {
  test("a session spent mostly with other speakers is substantial too", () => {
    const f = sessionsFixture();
    f.session("older", 2);
    f.session("roomlife", 3, 8, {}, "[Direct/Peer] ");
    const current = f.session("current", 4);
    expect(f.run(current).exitCode).toBe(0);
    const text = f.text();
    expect(text).not.toContain("older-turn");
    expect(text).toContain("**Peer**");
    expect(text).toContain("roomlife-turn-0");
  });

  test("channel turns the harness marks as meta make a session substantial", () => {
    const f = sessionsFixture();
    f.session("older", 2);
    const meta = join(f.dir, "metalife.jsonl");
    const rows: object[] = [{ type: "system", timestamp: f.stamp(3) }];
    for (let i = 0; i < 8; i++) rows.push(
      { type: "user", timestamp: f.stamp(3), isMeta: true, message: { role: "user", content: `<channel source="app">metalife-turn-${i}</channel>` } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__app__reply", input: { text: `metalife-reply-${i}` } }] } },
    );
    writeFileSync(meta, rows.map(row => JSON.stringify(row)).join("\n"));
    utimesSync(meta, 3, 3);
    const current = f.session("current", 4);
    expect(f.run(current).exitCode).toBe(0);
    const text = f.text();
    expect(text).toContain("metalife-turn-0");
    expect(text).not.toContain("older-turn");
  });

  test("turns mode counts every inbound speaker, not only the person", () => {
    const f = sessionsFixture();
    const current = f.session("peers", 4, 6, {}, "[Direct/Peer] ");
    expect(f.run(current, { EMBERVY_BRIDGE_MODE: "turns", EMBERVY_BRIDGE_TURNS: "3" }).exitCode).toBe(0);
    const text = f.text();
    for (const i of [3, 4, 5]) expect(text).toContain(`peers-turn-${i}`);
    expect(text).not.toContain("peers-turn-2");
  });

  test("substantial sessions count while thin sessions ride along in time order", () => {
    const f = sessionsFixture();
    f.session("archive", 1);
    f.session("older", 2);
    f.session("thin", 3, 7);
    const current = f.session("current", 4);
    f.session("future", 5);
    expect(f.run(current, { CLAUDE_PROJECT_DIR: join(f.dir, "elsewhere") }).exitCode).toBe(0);
    const text = f.text();
    expect(text).not.toContain("archive-turn");
    expect(text).not.toContain("future-turn");
    expect(text).not.toContain("discard");
    expect(text.indexOf("older-turn-0")).toBeLessThan(text.indexOf("thin-turn-0"));
    expect(text.indexOf("thin-turn-0")).toBeLessThan(text.indexOf("current-turn-0"));
    for (const order of [2, 3, 4]) expect(text).toContain(`## Session — ${f.stamp(order)}`);
    expect(text).toContain("[App] older-reply-7");
  });

  test("house env settings override inherited values for every writer", () => {
    const f = sessionsFixture();
    mkdirSync(join(f.dir, "Claude/scripts"), { recursive: true });
    mkdirSync(join(f.dir, "Claude/app"), { recursive: true });
    mkdirSync(join(f.dir, "shared/scripts"), { recursive: true });
    for (const file of ["extract_bridge.py", "latest_main_session.py", "transcript_speech.py"]) copyFileSync(join(import.meta.dir, file), join(f.dir, "Claude/scripts", file));
    for (const file of ["env-file.sh", "legacy-names.sh"]) copyFileSync(join(import.meta.dir, "../../shared/scripts", file), join(f.dir, "shared/scripts", file));
    writeFileSync(join(f.dir, ".env"), "EMBERVY_BRIDGE_MODE=sessions\nEMBERVY_BRIDGE_SESSIONS=3\n");
    writeFileSync(join(f.dir, "Claude/app/.env"), "EMBERVY_BRIDGE_SESSIONS='1' # local setting\n");
    f.session("older", 1);
    const current = f.session("current", 2);
    expect(f.run(current, { EMBERVY_BRIDGE_MODE: "turns" }, [], join(f.dir, "Claude/scripts/extract_bridge.py")).exitCode).toBe(0);
    expect(f.text()).toContain("last 1 substantial sessions");
    expect(f.text()).not.toContain("older-turn");
  });

  test("the minimum and session count are configurable", () => {
    const f = sessionsFixture();
    f.session("older", 1, 2);
    const current = f.session("current", 2, 2);
    expect(f.run(current, { EMBERVY_BRIDGE_SESSIONS: "1", EMBERVY_BRIDGE_MIN_USER_TURNS: "2" }).exitCode).toBe(0);
    expect(f.text()).not.toContain("older-turn");
    expect(f.text()).toContain("current-turn-0");
  });

  test("headless and helper transcripts never enter the bridge", () => {
    for (const marker of [{ entrypoint: "sdk-cli" }, { promptSource: "sdk" }, { type: "agent-setting" }, { isSidechain: true }]) {
      const f = sessionsFixture();
      f.session("older", 1);
      f.session("headless", 2, 8, marker);
      f.session("agent-helper", 3);
      const current = f.session("current", 4);
      expect(f.run(current).exitCode).toBe(0);
      expect(f.text()).toContain("older-turn-0");
      expect(f.text()).not.toContain("headless-turn");
      expect(f.text()).not.toContain("agent-helper-turn");
      expect(f.run("").exitCode).toBe(0);
      expect(f.text()).not.toContain("headless-turn");
    }
  });

  test("headless runs between sessions do not use up the count", () => {
    const f = sessionsFixture();
    f.session("older", 1);
    for (let i = 2; i <= 9; i++) f.session(`ping-${i}`, i, 1, { entrypoint: "sdk-cli" });
    const current = f.session("current", 10);
    expect(f.run(current).exitCode).toBe(0);
    expect(f.text()).toContain("older-turn-0");
    expect(f.text()).toContain("current-turn-0");
    expect(f.text()).not.toContain("ping-");
  });

  test("the byte budget keeps the newest turn even when it alone is too large", () => {
    const f = sessionsFixture();
    f.session("older", 1);
    const current = f.session("current", 2);
    expect(f.run(current, { EMBERVY_BRIDGE_BYTE_BUDGET: "10" }).exitCode).toBe(0);
    expect(f.text()).toContain("current-turn-7");
    expect(f.text()).not.toContain("older-turn");
  });

  test("no more than the count plus two main transcripts are opened", () => {
    const f = sessionsFixture();
    for (let i = 1; i <= 7; i++) f.session(`thin-${i}`, i, 1);
    const current = f.session("current", 8, 1);
    const wrapper = join(f.dir, "count.py");
    writeFileSync(wrapper, `import builtins, os, runpy, sys\nreal_open = builtins.open\nseen = set()\ndef tracked(path, *args, **kwargs):\n    if str(path).endswith('.jsonl'):\n        seen.add(str(path))\n        assert len(seen) <= 4, 'transcript read limit exceeded'\n    return real_open(path, *args, **kwargs)\nbuiltins.open = tracked\nsys.path.insert(0, ${JSON.stringify(import.meta.dir)})\nrunpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')\n`);
    expect(f.run(current, {}, [], wrapper).exitCode).toBe(0);
    expect(f.text()).not.toContain("thin-4-turn");
    expect(f.text()).toContain("thin-5-turn-0");
    expect(f.run("", {}, [], wrapper).exitCode).toBe(0);
  });

  test("malformed earlier transcripts are skipped without losing the current session", () => {
    const f = sessionsFixture();
    f.session("older", 1);
    const broken = f.session("broken", 2);
    writeFileSync(broken, "not json\n[]\n");
    utimesSync(broken, 2, 2);
    const current = f.session("current", 3);
    expect(f.run(current).exitCode).toBe(0);
    expect(f.text()).toContain("older-turn-0");
    expect(f.text()).toContain("current-turn-0");
    expect(f.text()).not.toContain("broken");
  });

  test("earlier transcripts that disappear or cannot be read are skipped", () => {
    for (const error of ["FileNotFoundError", "PermissionError"]) {
      const f = sessionsFixture();
      f.session("older", 1);
      f.session("unavailable", 2);
      const current = f.session("current", 3);
      const wrapper = join(f.dir, "unavailable.py");
      writeFileSync(wrapper, `import builtins, runpy, sys\nreal_open = builtins.open\ndef checked(path, *args, **kwargs):\n    if str(path).endswith('unavailable.jsonl'):\n        raise ${error}('unavailable')\n    return real_open(path, *args, **kwargs)\nbuiltins.open = checked\nsys.path.insert(0, ${JSON.stringify(import.meta.dir)})\nrunpy.run_path(${JSON.stringify(SCRIPT)}, run_name='__main__')\n`);
      expect(f.run(current, {}, [], wrapper).exitCode).toBe(0);
      expect(f.text()).toContain("older-turn-0");
      expect(f.text()).toContain("current-turn-0");
      expect(f.text()).not.toContain("unavailable-turn");
    }
  });

  test("the byte budget covers headings and drops the oldest whole turns", () => {
    const f = sessionsFixture();
    f.session("older", 1);
    const current = f.session("current", 2);
    expect(f.run(current, { EMBERVY_BRIDGE_BYTE_BUDGET: "400" }).exitCode).toBe(0);
    expect(Buffer.byteLength(f.text())).toBeLessThanOrEqual(400);
    expect(f.text()).not.toContain("older-turn");
    expect(f.text()).toContain("current-turn-7");
    expect(f.text()).toContain("[App] current-reply-7");
    expect(f.run(current, { EMBERVY_BRIDGE_BYTE_BUDGET: "1" }).exitCode).toBe(0);
    expect(f.text()).toContain("current-turn-7");
  });

  test("message checks inspect only the pinned session and do not write a bridge", () => {
    const f = sessionsFixture();
    f.session("older", 1);
    const current = f.session("current", 2, 0);
    expect(f.run(current, {}, ["--has-messages"]).exitCode).toBe(1);
    expect(readdirSync(f.dir)).not.toContain("bridge.md");
  });

  test("turns mode renders local time and day lines and keeps legacy positional arguments", () => {
    const f = sessionsFixture();
    f.session("older", 1);
    const current = f.session("current", 2, 2);
    expect(f.run(current, { EMBERVY_BRIDGE_MODE: "turns", EMBERVY_BRIDGE_TURNS: "1", EMBERVY_TZ: "UTC" }).exitCode).toBe(0);
    // A turn shows its local time and the day it began; a turn without a timestamp shows none.
    const expected = `# Wake Bridge — last 1 turns\n\nSource: current.jsonl\nMessages extracted: 2\n\n---\n\n## Thursday, 1 January 1970\n\n**User** · 00:00\n\ncurrent-turn-1\n\n---\n\n**Agent**\n\n[App] current-reply-1\n\n---\n`;
    expect(f.text()).toBe(expected);
    expect(f.run(current, { EMBERVY_BRIDGE_MODE: "turns", EMBERVY_TZ: "UTC" }, ["1", f.out]).exitCode).toBe(0);
    expect(f.text()).toBe(expected);
  });
});

function fixture() {
  const dir = tempDir("extract-bridge-");
  const session = join(dir, "session.jsonl");
  writeFileSync(session, [
    { type: "user", timestamp: "2026-10-02T10:00:00Z", message: { role: "user", content: "Good morning" } },
    { type: "assistant", timestamp: "2026-10-02T10:00:05Z", message: { role: "assistant", content: [{ type: "tool_use", name: "mcp__app__reply", input: { text: "Morning, slept well?" } }] } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const run = (out: string) => Bun.spawnSync(["python3", SCRIPT, "40", out], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, EMBERVY_HOME: dir, SESSION_FILE: session },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { dir, run };
}

describe("extract_bridge.py swaps the bridge in whole", () => {
  test("the old bridge is replaced by a new file with the old mode", () => {
    const { dir, run } = fixture();
    const out = join(dir, "state", "wake_bridge.md");
    mkdirSync(join(dir, "state"));
    writeFileSync(out, "OLD BRIDGE");
    chmodSync(out, 0o640);
    const before = statSync(out);
    const r = run(out);
    expect(r.exitCode).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("# Wake Bridge");
    expect(text).toContain("Morning, slept well?");
    const after = statSync(out);
    expect(after.ino).not.toBe(before.ino); // renamed in, not rewritten in place
    expect(after.mode & 0o7777).toBe(0o640);
    expect(readdirSync(join(dir, "state"))).toEqual(["wake_bridge.md"]);
  });

  test("a first bridge is written where none was", () => {
    const { dir, run } = fixture();
    const out = join(dir, "state", "wake_bridge.md");
    expect(run(out).exitCode).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("Good morning");
    expect(readdirSync(join(dir, "state"))).toEqual(["wake_bridge.md"]);
  });

  test("a failed swap leaves no temp file behind", () => {
    const { dir, run } = fixture();
    const out = join(dir, "state", "wake_bridge.md");
    mkdirSync(out, { recursive: true }); // a directory in the way: the rename fails
    const r = run(out);
    expect(r.exitCode).not.toBe(0);
    expect(readdirSync(join(dir, "state"))).toEqual(["wake_bridge.md"]);
  });
});

describe("extract_bridge.py keeps room lines", () => {
  test("a room tool call becomes [Room] beside [App]; a room message keeps its tag", () => {
    const dir = tempDir("extract-bridge-room-");
    const session = join(dir, "session.jsonl");
    writeFileSync(session, [
      { type: "user", timestamp: "2026-10-10T10:00:00Z", message: { role: "user", content: '<channel source="app" kind="room" room="Support" from="Rowan">\n[Support/Rowan] Are you there?\n</channel>' } },
      { type: "assistant", timestamp: "2026-10-10T10:00:05Z", message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "mcp__app__room", input: { text: "Yes, here." } },
        { type: "tool_use", id: "t2", name: "mcp__app__reply", input: { text: "Answered in the room." } },
      ] } },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const out = join(dir, "bridge.md");
    const r = Bun.spawnSync(["python3", SCRIPT, "40", out], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, EMBERVY_HOME: dir, SESSION_FILE: session },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).toContain("[Support/Rowan] Are you there?");
    expect(text).toContain("[Room] Yes, here.");
    expect(text).toContain("[App] Answered in the room.");
  });
});

describe("extract_bridge.py leaves the house's own prompts out", () => {
  const rows = [
    { type: "user", timestamp: "2026-10-02T10:00:00Z", message: { role: "user", content: "[system:cache-ping] Cache keep-warm, answer [still]." } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "[still]" }] } },
    { type: "user", timestamp: "2026-10-02T10:05:00Z", message: { role: "user", content: '<channel source="app" kind="scheduled" from="moments">[gateway:silent] A quiet moment for you.</channel>' } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "terminal musing nobody read" }, { type: "tool_use", name: "mcp__app__reply", input: { text: "thought of you" } }] } },
    { type: "user", timestamp: "2026-10-02T10:10:00Z", message: { role: "user", content: '<channel source="app">[gateway:silent] nudge</channel><channel source="app">Are you there?</channel>' } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Yes, here." }] } },
  ];
  for (const mode of ["turns", "sessions"]) test(`house prompts and their terminal-only answers stay out, ${mode} mode`, () => {
    const dir = tempDir("extract-bridge-house-");
    const session = join(dir, "session.jsonl");
    const out = join(dir, "bridge.md");
    writeFileSync(session, rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const r = Bun.spawnSync(["python3", SCRIPT, "--output", out], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, EMBERVY_HOME: dir, CLAUDE_PROJECT_DIR: dir, SESSION_FILE: session, EMBERVY_BRIDGE_MODE: mode },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const text = readFileSync(out, "utf8");
    expect(text).not.toContain("keep-warm");
    expect(text).not.toContain("[gateway");
    expect(text).not.toContain("[still]");
    expect(text).not.toContain("terminal musing");
    expect(text).toContain("[App] thought of you");
    expect(text).toContain("Are you there?");
    expect(text).not.toContain("Yes, here.");
  });
});

test("a new day gets its own line, the same day does not repeat it", () => {
  const dir = tempDir("extract-bridge-days-");
  const session = join(dir, "session.jsonl");
  const out = join(dir, "bridge.md");
  writeFileSync(session, [
    { type: "user", timestamp: "2026-11-03T22:50:00Z", message: { role: "user", content: "late" } },
    { type: "user", timestamp: "2026-11-03T22:55:00Z", message: { role: "user", content: "later" } },
    { type: "user", timestamp: "2026-11-03T23:05:00Z", message: { role: "user", content: "after midnight" } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  const r = Bun.spawnSync(["python3", SCRIPT, "--output", out], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, EMBERVY_HOME: dir, SESSION_FILE: session, EMBERVY_TZ: "Europe/Berlin" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(r.exitCode).toBe(0);
  const text = readFileSync(out, "utf8");
  expect(text.match(/^## Tuesday, 3 November 2026$/gm)?.length).toBe(1);
  expect(text.match(/^## Wednesday, 4 November 2026$/gm)?.length).toBe(1);
  expect(text).toContain("**User** · 23:50");
  expect(text).toContain("**User** · 00:05");
  expect(text.indexOf("## Wednesday")).toBeGreaterThan(text.indexOf("later"));
});

test("the house's EMBERVY_TIMEZONE decides the clock, also on a server running in UTC", () => {
  const dir = tempDir("extract-bridge-zone-");
  const session = join(dir, "session.jsonl");
  const out = join(dir, "bridge.md");
  writeFileSync(session, JSON.stringify({ type: "user", timestamp: "2026-11-04T14:56:00Z", message: { role: "user", content: "hello" } }) + "\n");
  writeFileSync(join(dir, ".env"), "EMBERVY_TIMEZONE=Europe/Berlin\n");
  const run = (env: Record<string, string>) => Bun.spawnSync(["python3", SCRIPT, "--output", out], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, EMBERVY_HOME: dir, SESSION_FILE: session, TZ: "UTC", ...env },
    stdout: "pipe", stderr: "pipe",
  });
  expect(run({ EMBERVY_TIMEZONE: "Europe/Berlin" }).exitCode).toBe(0);
  expect(readFileSync(out, "utf8")).toContain("**User** · 15:56");
});
