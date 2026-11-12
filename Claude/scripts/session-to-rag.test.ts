import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tests transcript export, session numbering and durable archive replacement.

const script = join(import.meta.dir, "session-to-rag.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

for (const customState of [false, true]) test(`archive keeps outreach and proven gateway text, custom state ${customState}`, () => {
  const root = mkdtempSync(join(tmpdir(), "archive-outreach-"));
  roots.push(root);
  const state = join(root, customState ? "delivery-state" : "state");
  mkdirSync(state);
  const session = join(root, "session.jsonl"), out = join(root, "archive.md");
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
  const run = Bun.spawnSync(["bash", script, "Session_1", "1"], { env: {
    PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, SESSION_FILE: session,
    RAG_URL: "http://rag.invalid", DRY_RUN: "1", DRY_OUT: out,
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
  expect(run.stdout.toString()).toContain("EXPORTED:18 messages,");
});

test("bridge and chronicle refresh mail outcomes from the outbox on each export", () => {
  const root = mkdtempSync(join(tmpdir(), "mail-export-"));
  roots.push(root);
  const data = join(root, "mail-data");
  mkdirSync(data);
  const session = join(root, "session.jsonl");
  const archive = join(root, "archive.md"), bridge = join(root, "bridge.md");
  const draft = { id: "mail", to: "reader@example.test", subject: "Update", body: "withheld draft body" };
  writeFileSync(session, [
    { type: "user", message: { role: "user", content: "Please prepare a mail." } },
    { type: "assistant", message: { role: "assistant", content: [
      { type: "tool_use", id: "email-call", name: "mcp__app__email", input: draft },
    ] } },
    { type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "email-call", content: "[Email outgoing] id=mail status=pending_approval" },
    ] } },
  ].map(row => JSON.stringify(row)).join("\n"));
  const env = { PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, EMBERVY_APP_DATA_DIR: data,
    SESSION_FILE: session, RAG_URL: "http://rag.invalid", DRY_RUN: "1", DRY_OUT: archive };
  for (const status of ["pending_approval", "discarded", "sent", "failed"]) {
    const mail = status === "sent"
      ? { ...draft, to: "approved@example.test", subject: "Approved", body: "actual sent body", status }
      : { ...draft, status };
    writeFileSync(join(data, "email-outbox.jsonl"), JSON.stringify(mail) + "\n");
    expect(Bun.spawnSync(["bash", script, "Session_1", "1"], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    expect(Bun.spawnSync(["python3", join(import.meta.dir, "extract_bridge.py"), "40", bridge],
      { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    for (const path of [archive, bridge]) {
      const output = readFileSync(path, "utf8");
      expect(output).toContain("Please prepare a mail.");
      expect(output).not.toContain(draft.body);
      if (status === "sent") {
        expect(output).toContain("[Email to approved@example.test]\nSubject: Approved\n\nactual sent body");
        expect(output).not.toContain("[Mail draft");
      } else {
        expect(output).not.toContain("[Email to");
        expect(output).not.toContain("actual sent body");
        if (status === "failed") expect(output).not.toContain("[Mail draft");
        else expect(output).toContain("[Mail draft to reader@example.test: Update, not sent]");
      }
    }
  }
});

describe("inbound export parity", () => {
  const cases = [
    { label: "task notices never become the person's words", content: "<task-notification><status>complete</status><summary>work complete</summary></task-notification>", pairs: [["System", "work complete"]] },
    { label: "interruptions and hook feedback disappear", content: "[Request interrupted by user for tool use]", pairs: [], extra: ["Stop hook feedback: internal", "PreToolUse:Read hook error: internal", "PostToolUse:Write hook error: internal"] },
    { label: "direct and configured room senders agree", content: "[Direct/sender] direct text", pairs: [["sender", "[Direct/sender] direct text"], ["participant", "[space/participant] room text"]], extra: ["<channel>[space/participant] room text</channel>"] },
    { label: "orphan channel tags disappear from channel bodies", content: "<channel>[space/sender] clean</channel></channel>", pairs: [["sender", "[space/sender] clean"]] },
    { label: "channel messages marked as meta stay", content: '<channel source="app">[space/participant] room line</channel>', pairs: [["participant", "[space/participant] room line"]], contentMeta: true },
    { label: "metadata and continuation notices disappear", content: "[Your previous response had no visible output. Please continue and produce a user-visible response.]", pairs: [], meta: true },
  ];
  for (const sample of cases) test(sample.label, () => {
    const root = mkdtempSync(join(tmpdir(), "inbound-parity-"));
    roots.push(root);
    const session = join(root, "session.jsonl"), archive = join(root, "archive.md"), bridge = join(root, "bridge.md");
    const timestamp = new Date(0).toISOString();
    const row = (content: string) => ({ type: "user", timestamp, message: { role: "user", content } });
    const rows: object[] = [row("ordinary  message\nsecond line"), sample.contentMeta ? { ...row(sample.content), isMeta: true } : row(sample.content), ...(sample.extra ?? []).map(row)];
    if (sample.meta) rows.push({ ...row("internal metadata"), isMeta: true });
    writeFileSync(session, rows.map(row => JSON.stringify(row)).join("\n"));
    writeFileSync(join(root, ".env"), "EMBERVY_ROOM_NAME=space\n");
    const env = { PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, SESSION_FILE: session,
      USER_LABEL: "Person", EMBERVY_TIMEZONE: "UTC", RAG_URL: "http://rag.invalid", DRY_RUN: "1", DRY_OUT: archive };
    expect(Bun.spawnSync(["bash", script, "Session_1", "1"], { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    expect(Bun.spawnSync(["python3", join(import.meta.dir, "extract_bridge.py"), "40", bridge],
      { env, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
    const outputs = [archive, bridge].map(path => readFileSync(path, "utf8"));
    const expected = [["Person", "ordinary  message\nsecond line"], ...sample.pairs];
    for (const output of outputs) {
      const pairs = [...output.matchAll(/\*\*([^*]+)\*\*(?: · \d{2}:\d{2})?\n\n([\s\S]*?)(?=\n+---\n|$)/g)]
        .map(match => [match[1], match[2].trimEnd()]);
      expect(pairs).toEqual(expected);
      for (const dropped of ["<task-notification>", "</channel", "[Request interrupted", "hook error:", "Stop hook feedback:", "internal metadata"])
        expect(output).not.toContain(dropped);
    }
  });
});

const FAKE_CURL = `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
url = next((a for a in args if a.startswith("http")), "")
if url.endswith("/list"):
    sys.stdout.write(os.environ.get("FAKE_LIST_BODY", ""))
    if "-w" in args:
        sys.stdout.write("\\n" + os.environ.get("FAKE_LIST_STATUS", "200"))
elif url.endswith("/upload"):
    form = next(a for a in args if a.startswith("file=@"))
    with open(os.environ["FAKE_UPLOADS"], "a") as f:
        f.write(os.path.basename(form[len("file=@"):]) + "\\n")
    sys.stdout.write('{"success":true,"chunks":3}')
    if "-w" in args:
        sys.stdout.write("\\n200")
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "embervy-session-to-rag-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(bin, "curl"), FAKE_CURL, { mode: 0o755 });
  const session = join(root, "main.jsonl");
  writeFileSync(session, [
    JSON.stringify({ type: "user", timestamp: "2026-10-02T06:00:00Z", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-10-02T06:00:05Z", message: { role: "assistant", content: [{ type: "text", text: "here I am" }] } }),
  ].join("\n") + "\n");
  const uploads = join(root, "uploads");
  const run = (list: { status?: string; body: string }) => Bun.spawnSync(["bash", script], {
    env: {
      PATH: `${bin}:${process.env.PATH}`, HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid",
      SESSION_FILE: session, FAKE_UPLOADS: uploads, FAKE_LIST_STATUS: list.status ?? "200", FAKE_LIST_BODY: list.body,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const uploaded = () => (existsSync(uploads) ? readFileSync(uploads, "utf8").split("\n").filter(Boolean) : []);
  const fingerprints = () => (existsSync(join(root, "state/uploaded_sessions")) ? readFileSync(join(root, "state/uploaded_sessions"), "utf8").trim() : "");
  return { root, run, uploaded, fingerprints };
}

test("a fresh session export needs no existing number floor", () => {
  const f = fixture();
  expect(existsSync(join(f.root, "state/last_session_number_Session"))).toBe(false);
  const result = f.run({ body: '{"files":[]}' });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).not.toContain("No such file or directory");
  expect(f.uploaded()).toEqual(["Session_1.md"]);
});

test("chronicle excludes harness continuation notices and terminal prose without changing human quotations", () => {
  const root = mkdtempSync(join(tmpdir(), "continuation-export-"));
  roots.push(root);
  const notice = "[Your previous response had no visible output. Please continue and produce a user-visible response.]";
  const at = "2026-01-01T12:00:00Z";
  const session = join(root, "session.jsonl"), archive = join(root, "archive.md");
  writeFileSync(session, [
    user(at, "An ordinary message."),
    { ...user(at, "Internal harness metadata."), isMeta: true },
    { ...user(at, notice), isMeta: true },
    user(at, notice),
    user(at, `<channel>${notice}</channel>`),
    user(at, `Please explain this quoted line: ${notice}`),
    agent(at, notice),
    agent(at, "An ordinary answer."),
  ].map(line => JSON.stringify(line)).join("\n"));
  const run = Bun.spawnSync(["bash", script, "Session_1", "1"], { env: {
    PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid", SESSION_FILE: session, DRY_RUN: "1", DRY_OUT: archive,
  } });
  expect(run.exitCode).toBe(0);
  const text = readFileSync(archive, "utf8");
  expect(text).not.toContain("Internal harness metadata.");
  expect(text).not.toContain(`**User**\n\n${notice}`);
  expect(text).toContain(`**User**\n\nPlease explain this quoted line: ${notice}`);
  expect(text).not.toContain(`**Agent**\n\n${notice}`);
  expect(text).toContain("An ordinary message.");
  expect(text).not.toContain("An ordinary answer.");
  expect(run.stdout.toString()).toContain("EXPORTED:2 messages,");
});

function exportDate(lines: object[], zones: Record<string, string>, dotEnv?: string) {
  const root = mkdtempSync(join(tmpdir(), "embervy-session-to-rag-date-"));
  roots.push(root);
  const session = join(root, "main.jsonl");
  writeFileSync(session, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  if (dotEnv !== undefined) writeFileSync(join(root, ".env"), dotEnv);
  const out = join(root, "out.md");
  const r = Bun.spawnSync(["bash", script, "Session_7", "7"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid",
      SESSION_FILE: session, DRY_RUN: "1", DRY_OUT: out, ...zones,
    },
    stdout: "pipe", stderr: "pipe",
  });
  expect(r.exitCode).toBe(0);
  const md = readFileSync(out, "utf8");
  const first = md.match(/^# \[Session_7\] \[DATE: (\S+)\]$/m)?.[1];
  const second = md.match(/^SESSION=7 \| TYPE=CHAT \| DATE=(\S+)$/m)?.[1];
  expect(first).toBe(second!);
  return first;
}

const user = (timestamp: string, content: string) => ({ type: "user", timestamp, message: { role: "user", content } });
const agent = (timestamp: string, text: string) => ({ type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "text", text }] } });
test.skipIf(!("roomUserSpeaker" in (await import("../../Brain/wake-bridge"))))("Brain archive and bridges preserve room senders without changing history", async () => {
  const { historyToMarkdown, extractBridge, userLineSpeaker } = await import("../../Brain/brain");
  const { nativeMessages } = await import("../../Brain/wake-bridge");
  const rules = { userName: "Person", workerName: "Agent", systemLine: /^system:/, scheduledLine: /^scheduled:/ };
  for (const [body, speaker] of [["[Support/Robin] hello", "Robin"], ["[Support/Person] hello", "Person"], ["normal app turn", "Person"], ["[Email from sender@example.test] mail", "Person"]]) {
    const content = `<channel>${body}</channel>`;
    const history = [{ role: "user" as const, content }];
    expect(userLineSpeaker(content, "Person")).toBe(speaker);
    expect(nativeMessages(history, rules)).toEqual([[speaker, body]]);
    for (const output of [historyToMarkdown(history, { name: "Session_1", date: "2026-01-01" }), historyToMarkdown(history, { name: "Session_1", date: "2026-01-01" }, "house"), extractBridge(history)]) {
      expect(output).toContain(content);
      expect(output).toContain(`**${userLineSpeaker(content)}**`);
    }
    expect(history[0].content).toBe(content);
  }
});

test("room senders are preserved in the archive and bridge", () => {
  const root = mkdtempSync(join(tmpdir(), "room-export-"));
  roots.push(root);
  const session = join(root, "session.jsonl");
  const bodies = ["[Support/Robin] hello", "[Support/Person] hello", "normal app turn", "[Email from sender@example.test] mail", "[src/index.ts] inspect this", "[Other/Guest] unknown room"];
  writeFileSync(join(root, ".env"), "EMBERVY_ROOM_NAME=Support\n");
  writeFileSync(session, bodies.map(text => JSON.stringify(user("2026-01-01T12:00:00Z", `<channel source="room">${text}</channel>`))).join("\n"));
  const archive = join(root, "archive.md"), bridge = join(root, "bridge.md");
  const env = { PATH: process.env.PATH, HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid", SESSION_FILE: session, USER_LABEL: "Person", AGENT_LABEL: "Agent", DRY_RUN: "1", DRY_OUT: archive };
  expect(Bun.spawnSync(["bash", script, "Session_1", "1"], { env }).exitCode).toBe(0);
  expect(Bun.spawnSync(["python3", join(import.meta.dir, "extract_bridge.py"), "40", bridge], { env }).exitCode).toBe(0);
  for (const file of [archive, bridge]) {
    const text = readFileSync(file, "utf8");
    for (const [i, body] of bodies.entries()) {
      expect(text).toContain(body);
      const at = text.indexOf(body);
      const preceding = text.slice(0, at);
      expect([...preceding.matchAll(/\*\*([^*]+)\*\*/g)].at(-1)?.[1]).toBe(i === 0 ? "Robin" : "Person");
    }
  }
});

test("the archive leaves out the house's own prompts and keeps the person's words", () => {
  const root = mkdtempSync(join(tmpdir(), "house-prompts-"));
  roots.push(root);
  const session = join(root, "session.jsonl");
  const at = "2026-10-27T12:00:00Z";
  writeFileSync(session, [
    user(at, `<channel source="app">[gateway:silent] This moment is unannounced; nobody knew it would come, not even you.</channel>`),
    user(at, "[gateway:silent] Fresh session after a cut. Read your lore and the bridge."),
    user(at, "[silent] [gateway:silent] Cache keep-warm: no task, no occasion."),
    user(at, "[system:cache-ping] Stay here."),
    user(at, `<channel source="app">Cache ping later, please</channel>`),
    user(at, `<channel source="app">please do not copy [gateway:silent] here</channel>`),
    agent(at, "I thought of you"),
  ].map((line) => JSON.stringify(line)).join("\n") + "\n");
  const archive = join(root, "archive.md");
  const env = { PATH: process.env.PATH, HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid", SESSION_FILE: session, DRY_RUN: "1", DRY_OUT: archive };
  expect(Bun.spawnSync(["bash", script, "Session_1", "1"], { env }).exitCode).toBe(0);
  const text = readFileSync(archive, "utf8");
  for (const gone of ["unannounced", "Fresh session", "Cache keep-warm", "Stay here"]) expect(text).not.toContain(gone);
  for (const kept of ["Cache ping later, please", "please do not copy [gateway:silent] here"]) expect(text).toContain(kept);
  expect(text).not.toContain("I thought of you");
});

describe("archive answers and quiet blocks", () => {
  const at = "2026-10-27T12:00:00Z";
  test.each([
    {
      name: "a channel moment keeps only app output across assistant entries and tool results",
      lines: [
        user(at, '<channel source="app">[gateway:silent] An unannounced moment.</channel>'),
        agent(at, "A terminal-only answer."),
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } },
        user(at, "<system-reminder>Keep working.</system-reminder>"),
        { type: "system", message: "A system reminder." },
        { type: "assistant", message: { role: "assistant", content: [
          { type: "text", text: "A private terminal note." },
          { type: "tool_use", id: "t2", name: "mcp__app__reply", input: { text: "A delivered reply." } },
        ] } },
        agent(at, "Another terminal-only answer."),
      ],
      kept: [["Agent", "[App] A delivered reply."]],
    },
    {
      name: "terminal answers stay out after both cache pings and a person's channel line",
      lines: [
        user(at, "[system:cache-ping] Stay here."),
        agent(at, "A cache-ping answer."),
        user(at, '<channel source="app">Are you ready?</channel>'),
        agent(at, "Yes, ready."),
      ],
      kept: [["User", "Are you ready?"]],
    },
    {
      name: "a person's line arriving with a moment does not preserve terminal prose",
      lines: [
        user(at, '<channel source="app">Are you there?</channel>\n<channel source="app">[gateway:silent] An unannounced moment.</channel>'),
        agent(at, "Here."),
      ],
      kept: [["User", "Are you there?"]],
    },
    {
      name: "quiet blocks and terminal notes both disappear",
      lines: [
        user(at, "Take your time."),
        agent(at, " \n[still]\t "),
        { type: "assistant", message: { role: "assistant", content: [
          { type: "text", text: "[still]" },
          { type: "text", text: "[still] with a note" },
        ] } },
      ],
      kept: [["User", "Take your time."]],
    },
    {
      name: "a typed gateway prompt keeps mail, room and direct output but no terminal prose",
      lines: [
        user(at, "[silent] [gateway:silent] A quiet moment."),
        { type: "assistant", message: { role: "assistant", content: [
          { type: "text", text: "A terminal note." },
          { type: "tool_use", id: "t1", name: "mcp__app__email", input: { to: "reader@example.test", subject: "Update", body: "Mail delivered." } },
          { type: "tool_use", id: "t2", name: "mcp__app__room", input: { text: "Room delivered." } },
          { type: "tool_use", id: "t3", name: "mcp__app__peer", input: { to: "Peer", text: "Direct delivered." } },
        ] } },
        { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1",
          content: "[Email outgoing] id=mail status=sent" }] } },
      ],
      kept: [["Agent", "[Email to reader@example.test]\nSubject: Update\n\nMail delivered.\n\n[Room] Room delivered.\n\n[Direct/Peer] Direct delivered."]],
    },
  ])("$name", ({ lines, kept }) => {
    const root = mkdtempSync(join(tmpdir(), "archive-answers-"));
    roots.push(root);
    const session = join(root, "session.jsonl"), archive = join(root, "archive.md");
    writeFileSync(session, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    const env = { PATH: process.env.PATH, HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid", SESSION_FILE: session, DRY_RUN: "1", DRY_OUT: archive };
    const result = Bun.spawnSync(["bash", script, "Session_1", "1"], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`EXPORTED:${kept.length} messages,`);
    const text = readFileSync(archive, "utf8");
    expect(text.slice(text.indexOf("\n---\n"))).toBe(kept.map(([speaker, body]) => `\n---\n\n**${speaker}**\n\n${body}\n`).join(""));
  });
});

const AFTER_MIDNIGHT = [user("2026-10-02T22:30:00.000Z", "still up"), agent("2026-10-02T22:31:10.250Z", "here")];
const OVER_MIDNIGHT = [user("2026-10-02T21:50:00Z", "late"), agent("2026-10-02T22:20:00Z", "later")];

describe("session-to-rag.sh header date", () => {
  test("a session that starts at 00:30 local time gets the local day, not the UTC day before", () => {
    expect(exportDate(AFTER_MIDNIGHT, { EMBERVY_TIMEZONE: "Europe/Berlin" })).toBe("2026-10-03");
  });

  test("BRAIN_TIMEZONE comes first; an invalid one falls through to EMBERVY_TIMEZONE", () => {
    expect(exportDate(AFTER_MIDNIGHT, { BRAIN_TIMEZONE: "Europe/Berlin", EMBERVY_TIMEZONE: "UTC" })).toBe("2026-10-03");
    expect(exportDate(AFTER_MIDNIGHT, { BRAIN_TIMEZONE: "Not/AZone", EMBERVY_TIMEZONE: "Europe/Berlin" })).toBe("2026-10-03");
  });

  test("the zone is also read from the house .env (with an inline comment)", () => {
    expect(exportDate(AFTER_MIDNIGHT, {}, "EMBERVY_TIMEZONE=Europe/Berlin   # house zone\n")).toBe("2026-10-03");
  });

  test("a session over midnight keeps its start day", () => {
    expect(exportDate(OVER_MIDNIGHT, { EMBERVY_TIMEZONE: "Europe/Berlin" })).toBe("2026-10-02");
  });

  test("winter time: 23:30 UTC is the next local day", () => {
    expect(exportDate([user("2026-12-01T23:30:00Z", "hi")], { EMBERVY_TIMEZONE: "Europe/Berlin" })).toBe("2026-12-02");
  });

  test("without a zone (or only invalid ones) the date is the UTC day, as before", () => {
    expect(exportDate(AFTER_MIDNIGHT, {})).toBe("2026-10-02");
    expect(exportDate(AFTER_MIDNIGHT, { EMBERVY_TIMEZONE: "Not/AZone" })).toBe("2026-10-02");
    expect(exportDate(AFTER_MIDNIGHT, { EMBERVY_TIMEZONE: "UTC" })).toBe("2026-10-02");
  });

  test("an unreadable timestamp keeps the old reading", () => {
    expect(exportDate([user("2026-10-02 garbled", "hi")], { EMBERVY_TIMEZONE: "Europe/Berlin" })).toBe("2026-10-02");
  });
});

describe("session-to-rag.sh numbering", () => {
  for (const [what, list] of [
    ["a server error", { status: "503", body: "upstream unavailable" }],
    ["a refused token", { status: "401", body: '{"error":"unauthorized"}' }],
    ["broken JSON", { body: '{"files": [' }],
    ["JSON without a file list", { body: '{"ok":true}' }],
    ["no answer at all", { status: "000", body: "" }],
  ] as const) {
    test(`${what} from /list: no upload, no fingerprint, exit ≠ 0`, () => {
      const f = fixture();
      const r = f.run(list);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain("no file list");
      expect(f.uploaded()).toEqual([]);
      expect(f.fingerprints()).toBe("");
    });
  }

  test("a real list numbers after the highest session, parts included, and keeps the number", () => {
    const f = fixture();
    const r = f.run({ body: JSON.stringify({ files: [{ name: "Session_1.md" }, { name: "Session_2_part01.md" }, { name: "Other_9.md" }] }) });
    expect(r.exitCode).toBe(0);
    expect(f.uploaded()).toEqual(["Session_3.md"]);
    expect(readFileSync(join(f.root, "state/last_session_number_Session"), "utf8").trim()).toBe("3");
  });

  test("the kept number is never undercut, even when the list comes back shorter", () => {
    const f = fixture();
    writeFileSync(join(f.root, "state/last_session_number_Session"), "7\n");
    expect(f.run({ body: JSON.stringify({ files: [{ name: "Session_2.md" }] }) }).exitCode).toBe(0);
    expect(f.uploaded()).toEqual(["Session_8.md"]);
  });

  test("an empty list on a fresh house is the first session", () => {
    const f = fixture();
    expect(f.run({ body: JSON.stringify({ files: [] }) }).exitCode).toBe(0);
    expect(f.uploaded()).toEqual(["Session_1.md"]);
  });
});

const FAMILY_CURL = `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
url = next(a for a in args if a.startswith('http'))
p = Path(os.environ['FAKE_REMOTE'])
state = json.loads(p.read_text()) if p.exists() else {'files': [], 'pending': []}
status, body = 200, {}
if url.endswith('/list'):
    body = {'files': [{'name': n} for n in state['files']]}
elif url.endswith('/upload'):
    name = Path(next(a[6:] for a in args if a.startswith('file=@'))).name
    if name in state['pending']:
        status, body = 409, {'success': False}
    else:
        state['files'] = sorted(set(state['files'] + [name]))
        body = {'success': True}
        fail = Path(str(p) + '.upload-fail')
        if fail.exists():
            fail.unlink()
            status, body = 500, {'success': False}
elif url.endswith('/delete'):
    name = json.loads(args[args.index('-d') + 1])['filename']
    with open(str(p) + '.deletes', 'a') as out:
        out.write(name + '\\n')
    existed = name in state['files'] or name in state['pending']
    state['files'] = [n for n in state['files'] if n != name]
    fail = Path(str(p) + '.fail')
    if fail.exists():
        fail.unlink()
        state['pending'] = sorted(set(state['pending'] + [name]))
        status, body = 500, {'success': False, 'partial': True}
    else:
        state['pending'] = [n for n in state['pending'] if n != name]
        status, body = (200, {'success': True}) if existed else (404, {'success': False, 'absent': True})
p.write_text(json.dumps(state))
sys.stdout.write(json.dumps(body))
if '-w' in args:
    sys.stdout.write('\\n' + str(status))
`;

function familyFixture() {
  const root = mkdtempSync(join(tmpdir(), 'rag-family-'));
  roots.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'curl'), FAMILY_CURL, { mode: 0o755 });
  const remote = join(root, 'remote.json');
  const file = join(root, 'Session_7.md');
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: root, EMBERVY_HOME: root,
    RAG_URL: 'http://rag.invalid', FAKE_REMOTE: remote, SPLIT_THRESHOLD: '200', PART_TARGET_SIZE: '200' };
  const run = () => Bun.spawnSync(['bash', join(import.meta.dir, '../../shared/scripts/smart_upload.sh'), file], { env, stdout: 'pipe', stderr: 'pipe' });
  const seed = (files: string[]) => writeFileSync(remote, JSON.stringify({ files, pending: [] }));
  const state = () => JSON.parse(readFileSync(remote, 'utf8'));
  const content = (n: number) => '# Header\n' + Array.from({ length: n }, (_, i) => '\n---\nTurn ' + i + ' words '.repeat(22)).join('');
  return { root, bin, remote, file, env, run, seed, state, content };
}

describe('durable upload families', () => {
  test('unsplit to split, fewer parts and split to unsplit remove only the exact family', () => {
    const f = familyFixture();
    f.seed(['Session_7.md', 'Session_70_part03.md', 'Session_7_notes.md']);
    writeFileSync(f.file, f.content(3));
    expect(f.run().exitCode).toBe(0);
    expect(f.state().files).toEqual(['Session_70_part03.md', 'Session_7_notes.md', 'Session_7_part01.md', 'Session_7_part02.md', 'Session_7_part03.md'].sort());
    writeFileSync(f.file, f.content(2));
    expect(f.run().exitCode).toBe(0);
    expect(f.state().files).not.toContain('Session_7_part03.md');
    writeFileSync(f.file, 'Short replacement.');
    expect(f.run().exitCode).toBe(0);
    expect(f.state().files).toEqual(['Session_7.md', 'Session_70_part03.md', 'Session_7_notes.md'].sort());
  });

  test('a delete absent from the next listing is retried from the persistent family plan', () => {
    const f = familyFixture();
    f.seed(['Session_7_part01.md', 'Session_7_part02.md', 'Session_7_part03.md']);
    writeFileSync(f.file, f.content(2));
    writeFileSync(f.remote + '.fail', 'once');
    expect(f.run().exitCode).not.toBe(0);
    expect(f.state().files).not.toContain('Session_7_part03.md');
    expect(f.state().pending).toEqual(['Session_7_part03.md']);
    expect(f.run().exitCode).toBe(0);
    expect(f.state().pending).toEqual([]);
    expect(readFileSync(f.remote + '.deletes', 'utf8').trim().split('\n')).toEqual(['Session_7_part03.md', 'Session_7_part03.md']);
  });

  test('small session exports use the family cleanup and withhold the fingerprint until it completes', () => {
    const f = familyFixture();
    f.seed(['Session_7_part01.md', 'Session_7_part02.md']);
    const session = join(f.root, 'session.jsonl');
    writeFileSync(session, JSON.stringify(user('2026-10-01T00:00:00Z', 'hello')) + '\n');
    writeFileSync(f.remote + '.fail', 'once');
    const run = () => Bun.spawnSync(['bash', script, 'Session_7', '7'], {
      env: { ...f.env, SESSION_FILE: session, SPLIT_THRESHOLD: '81920' }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(run().exitCode).not.toBe(0);
    expect(readFileSync(join(f.root, 'state/uploaded_sessions'), 'utf8')).toBe('');
    expect(run().exitCode).toBe(0);
    expect(f.state()).toEqual({ files: ['Session_7.md'], pending: [] });
    expect(readFileSync(join(f.root, 'state/uploaded_sessions'), 'utf8').trim()).not.toBe('');
  });

  test('an automatic export retries its reserved name after a partial upload', () => {
    const f = familyFixture();
    f.seed([]);
    const session = join(f.root, 'session.jsonl');
    writeFileSync(session, JSON.stringify(user('2026-10-01T00:00:00Z', 'hello')) + '\n');
    writeFileSync(f.remote + '.upload-fail', 'once');
    const run = () => Bun.spawnSync(['bash', script], {
      env: { ...f.env, SESSION_FILE: session, SPLIT_THRESHOLD: '81920' }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(run().exitCode).not.toBe(0);
    expect(f.state().files).toEqual(['Session_1.md']);
    expect(run().exitCode).toBe(0);
    expect(f.state().files).toEqual(['Session_1.md']);
  });

  test('a hard header failure keeps recovery files and writes no upload fingerprint', () => {
    const f = familyFixture();
    const scripts = join(f.root, 'Claude/scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'enrich-header.sh'), '#!/bin/bash\ncp "$1" "$1.bak"\nprintf partial > "$1.new"\nexit 1\n', { mode: 0o755 });
    const session = join(f.root, 'session.jsonl');
    writeFileSync(session, JSON.stringify(user('2026-10-01T00:00:00Z', 'original text')) + '\n');
    const scratch = join(f.root, 'scratch');
    mkdirSync(scratch);
    const run = Bun.spawnSync(['bash', script, 'Session_7', '7'], { env: { ...f.env, SESSION_FILE: session, TMPDIR: scratch }, stdout: 'pipe', stderr: 'pipe' });
    expect(run.exitCode).not.toBe(0);
    expect(existsSync(f.remote)).toBe(false);
    expect(readFileSync(join(f.root, 'state/uploaded_sessions'), 'utf8')).toBe('');
    const recovery = run.stderr.toString().match(/recovery files remain in (.+)/)?.[1];
    expect(recovery).toBeTruthy();
    if (recovery) {
      expect(recovery.startsWith(scratch + '/')).toBe(true);
      expect(readFileSync(join(recovery, 'Session_7.md.bak'), 'utf8')).toContain('original text');
    }
  });
});

test("session export cleans a TMPDIR containing spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "archive-temp-cleanup-"));
  roots.push(root);
  const scratch = join(root, "scratch with spaces");
  mkdirSync(scratch);
  const session = join(root, "session.jsonl"), out = join(root, "archive.md");
  writeFileSync(session, JSON.stringify({ type: "user", timestamp: "2026-01-01T12:00:00Z", message: { role: "user", content: "original text" } }) + "\n");
  const result = Bun.spawnSync(["bash", script, "Session_7", "7"], {
    env: { PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid", SESSION_FILE: session, TMPDIR: scratch, DRY_RUN: "1", DRY_OUT: out },
    stdout: "pipe", stderr: "pipe",
  });
  expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({ code: 0, error: "" });
  expect(readFileSync(out, "utf8")).toContain("original text");
  expect(readdirSync(scratch)).toEqual([]);
});

describe("session-to-rag.sh keeps room lines", () => {
  test("a room tool call is archived as [Room]", () => {
    const root = mkdtempSync(join(tmpdir(), "embervy-session-to-rag-room-"));
    roots.push(root);
    const session = join(root, "main.jsonl");
    writeFileSync(session, [
      user("2026-10-10T10:00:00Z", '<channel source="app" kind="room" room="Support" from="Rowan">\n[Support/Rowan] Are you there?\n</channel>'),
      { type: "assistant", timestamp: "2026-10-10T10:00:05Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__app__room", input: { text: "Yes, here." } }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const out = join(root, "out.md");
    const r = Bun.spawnSync(["bash", script, "Session_8", "8"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid", SESSION_FILE: session, DRY_RUN: "1", DRY_OUT: out },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("[Support/Rowan] Are you there?");
    expect(md).toContain("[Room] Yes, here.");
  });

  test("a direct line is archived both ways, under the other agent's name", () => {
    const root = mkdtempSync(join(tmpdir(), "embervy-session-to-rag-peer-"));
    roots.push(root);
    const session = join(root, "main.jsonl");
    writeFileSync(session, [
      user("2026-10-10T10:00:00Z", '<channel source="app" kind="peer" from="Rowan">\n[Direct/Rowan] Is the door open?\n</channel>'),
      { type: "assistant", timestamp: "2026-10-10T10:00:05Z", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "mcp__app__peer", input: { to: "Rowan", text: "It is." } }] } },
    ].map((l) => JSON.stringify(l)).join("\n") + "\n");
    const out = join(root, "out.md");
    const r = Bun.spawnSync(["bash", script, "Session_9", "9"], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, EMBERVY_HOME: root, RAG_URL: "http://rag.invalid", SESSION_FILE: session, DRY_RUN: "1", DRY_OUT: out },
      stdout: "pipe", stderr: "pipe",
    });
    expect(r.exitCode).toBe(0);
    const md = readFileSync(out, "utf8");
    expect(md).toContain("**Rowan**\n\n[Direct/Rowan] Is the door open?");
    expect(md).toContain("[Direct/Rowan] It is.");
  });
});
