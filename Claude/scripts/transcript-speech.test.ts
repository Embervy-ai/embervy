import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const user = (content = "hello") => ({ type: "user", message: { role: "user", content } });
const text = (text: string) => ({ type: "text", text });
const tool = (name: string, input: object, id = "tool") => ({ type: "tool_use", name, input, id });
const assistant = (content: object[], uuid = "last") => ({ type: "assistant", uuid, message: { role: "assistant", content } });
const result = (id: string, is_error = false, content: string | object[] = "") => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error, content }] } });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function render(rows: object[], logs: Record<string, string> = {}, env: Record<string, string> = {}, customState = false,
  mail: { outbox?: object[] | string; customData?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "transcript-speech-"));
  roots.push(root);
  const state = join(root, customState ? "delivery-state" : "state");
  mkdirSync(state);
  const data = join(root, mail.customData ? "mail-data" : "Claude/app/data");
  if (mail.outbox !== undefined) {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "email-outbox.jsonl"), typeof mail.outbox === "string"
      ? mail.outbox : mail.outbox.map(row => JSON.stringify(row)).join("\n"));
  }
  for (const [name, value] of Object.entries(logs)) writeFileSync(join(state, name), value);
  const run = Bun.spawnSync(["python3", "-c", `import json, sys
sys.path.insert(0, sys.argv[1])
from transcript_speech import TranscriptSpeech
print(json.dumps([speech for _, speech in TranscriptSpeech().entries(json.load(sys.stdin)) if speech]))
`, import.meta.dir], {
    env: { PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root,
      ...(customState ? { EMBERVY_GATEWAY_STATE_DIR: state } : {}),
      ...(mail.customData ? { EMBERVY_APP_DATA_DIR: data } : {}), ...env },
    stdin: Buffer.from(JSON.stringify(rows)), stdout: "pipe", stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString());
}

function selectUser(entry: object, env: Record<string, string> = {}) {
  const run = Bun.spawnSync(["python3", "-c", `import json, sys
sys.path.insert(0, sys.argv[1])
from transcript_speech import user_speech
print(json.dumps(user_speech(json.load(sys.stdin))))
`, import.meta.dir], {
    env: { PATH: process.env.PATH!, USER_LABEL: "Person", ...env },
    stdin: Buffer.from(JSON.stringify(entry)), stdout: "pipe", stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
  return JSON.parse(run.stdout.toString());
}

describe("user speech selection", () => {
  test("metadata and automatic prompts are not speech", () => {
    expect(selectUser({ ...user("internal metadata"), isMeta: true })).toEqual([]);
    expect(selectUser({ ...user('<channel source="app" user="Person">from the app</channel>'), isMeta: true })).toEqual([["Person", "from the app"]]);
    expect(selectUser({ ...user('<system-reminder>note</system-reminder>\n<channel source="app">after a reminder</channel>'), isMeta: true })).toEqual([["Person", "after a reminder"]]);
    expect(selectUser({ ...user('Expanded command output quoting <channel source="app">not a message</channel>'), isMeta: true })).toEqual([]);
    for (const content of ["[gateway] prompt", "[silent] [gateway:moment] prompt", "[system:cache-ping] prompt",
      "[Your previous response had no visible output. Please continue and produce a user-visible response.]"]) {
      expect(selectUser(user(content))).toEqual([]);
      expect(selectUser(user(`<channel>${content}</channel>`))).toEqual([]);
    }
  });

  test("task blocks use summary then status then a generic state change", () => {
    for (const [body, summary] of [
      ["<status>done</status><summary>Background\n work finished</summary>", "Background work finished"],
      ["<summary> </summary><status>failed</status>", "failed"],
      ["<task-id>internal</task-id><output-file>private path</output-file>", "A background task changed state."],
    ]) expect(selectUser(user(`<task-notification>${body}</task-notification>`))).toEqual([["System", summary]]);
    expect(selectUser(user("before<task-notification><status>done</status></task-notification>after")))
      .toEqual([["Person", "before"], ["System", "done"], ["Person", "after"]]);
    expect(selectUser(user(`<channel><task-notification><summary>${"x".repeat(300)}</summary></task-notification></channel>`)))
      .toEqual([["System", "x".repeat(239) + "…"]]);
  });

  test("interruptions and hook diagnostics are not speech", () => {
    for (const content of ["[Request interrupted by user]", "[Request interrupted by user for tool use]",
      "[Request interrupted by user] for tool use", "Stop hook feedback: rejected\ninternal detail",
      "PreToolUse:Read hook error: rejected", "PostToolUse:Write hook error: rejected"]) {
      expect(selectUser(user(content))).toEqual([]);
      expect(selectUser(user(`<channel>${content}</channel>`))).toEqual([]);
    }
    expect(selectUser(user("keep this\n[Request interrupted by user]\nkeep that")))
      .toEqual([["Person", "keep this\nkeep that"]]);
  });

  test("configured rooms and direct prefixes select the sender without rewriting text", () => {
    const env = { EMBERVY_ROOM_NAME: "space", ROOM_NAME: "alternate" };
    for (const route of ["space", "alternate", "Direct"]) {
      const content = `[${route}/sender] hello`;
      expect(selectUser(user(content), env)).toEqual([["sender", content]]);
      expect(selectUser(user(`<channel>${content}</channel>`), env)).toEqual([["sender", content]]);
    }
    for (const content of ["[unknown/sender] hello", "[src/file.ts] inspect", "ordinary\nmessage  with spacing",
      "Please explain [Request interrupted by user]", "PreToolUse: examples are useful"]) {
      expect(selectUser(user(content), env)).toEqual([["Person", content]]);
    }
  });

  test("channel bodies lose nested and orphan wrappers but retain their text", () => {
    const content = '<channel>one two three</channel></channel>'
      + '<channel>four <channel kind="nested">five</channel> six</channel>';
    expect(selectUser(user(content))).toEqual([["Person", "one two three"], ["Person", "four five six"]]);
  });

  test("all metadata tag bodies disappear both inside and outside channels", () => {
    const tags = ["system-reminder", "local-command-caveat", "local-command-stdout", "command-name", "command-message", "command-args"];
    const content = tags.map(tag => `<${tag}>discard\nthis</${tag}>`).join("") + "ordinary message";
    expect(selectUser(user(content))).toEqual([["Person", "ordinary message"]]);
    expect(selectUser(user(`<channel>${content}</channel>`))).toEqual([["Person", "ordinary message"]]);
    expect(selectUser(result("tool"))).toEqual([]);
    expect(selectUser(assistant([text("not user speech")]))).toEqual([]);
  });
});

describe("mail outcomes", () => {
  const draft = { to: "reader@example.test", subject: "Update", body: "unsent body" };
  const call = () => assistant([tool("mcp__app__email", draft, "email-call")]);
  const outcome = (status: string, error = false, structured = false) => {
    const content = `[Email outgoing] id=mail status=${status}`;
    return result("email-call", error, structured ? [text(content)] : content);
  };
  const pending = "[Mail draft to reader@example.test: Update, not sent]";
  const sent = "[Email to reader@example.test]\nSubject: Update\n\nunsent body";
  const approved = { id: "mail", to: "approved@example.test", cc: [], subject: "Approved", body: "sent version", status: "sent" };
  const approvedText = "[Email to approved@example.test]\nSubject: Approved\n\nsent version";

  test("a sent result preserves the submitted text with no matching outbox row", () => {
    for (const structured of [false, true]) {
      expect(render([user(), call(), outcome("sent", false, structured)], {}, {}, false,
        { outbox: [{ ...approved, id: "unrelated" }] })).toEqual([sent]);
    }
  });

  for (const customData of [false, true]) test(`approval uses the sent outbox version, custom directory ${customData}`, () => {
    expect(render([user(), call(), outcome("pending_approval")], {}, {}, false,
      { outbox: [approved], customData })).toEqual([approvedText]);
  });

  test("a sent marker proves delivery even when the stored status differs", () => {
    expect(render([user(), call(), outcome("pending_approval")], {}, {}, false,
      { outbox: [{ ...approved, status: "sending", sent_at: "recorded" }] })).toEqual([approvedText]);
  });

  for (const status of ["discarded", "pending_approval", "ready", "sending", "unknown"]) {
    test(`an outbox ${status} mail keeps only a draft line`, () => {
      expect(render([user(), call(), outcome("pending_approval")], {}, {}, false,
        { outbox: [{ ...draft, id: "mail", status, sent_at: null }] })).toEqual([pending]);
    });
  }

  test("an unsent outbox row overrides a sent result", () => {
    expect(render([user(), call(), outcome("sent")], {}, {}, false,
      { outbox: [{ ...draft, id: "mail", status: "discarded" }] })).toEqual([pending]);
  });

  test("failed results and tool errors disappear even beside sent outbox rows", () => {
    for (const response of [outcome("failed"), outcome("sent", true), result("email-call", true, "send error")]) {
      expect(render([user(), call(), response], {}, {}, false, { outbox: [approved] })).toEqual([]);
    }
    expect(render([user(), call(), outcome("pending_approval")], {}, {}, false,
      { outbox: [{ ...draft, id: "mail", status: "failed" }] })).toEqual([]);
  });

  test("a missing outbox falls back only to explicit sent results", () => {
    expect(render([user(), call(), outcome("sent")])).toEqual([sent]);
    expect(render([user(), call(), outcome("failed")])).toEqual([]);
    for (const status of ["pending_approval", "ready", "sending", "unknown"]) {
      expect(render([user(), call(), outcome(status)])).toEqual([pending]);
    }
    expect(render([user(), call()])).toEqual([pending]);
    expect(render([user(), call(), result("email-call", false, "unrecognized result")])).toEqual([pending]);
  });

  test("unreadable and malformed outboxes do not invent delivery", () => {
    const rows = [user(), call(), outcome("pending_approval")];
    expect(render(rows, {}, { EMBERVY_APP_DATA_DIR: "/dev/null/unavailable" }, false,
      { outbox: [approved] })).toEqual([pending]);
    expect(render(rows, {}, {}, false, { outbox: "broken\n[]\nnull\n" })).toEqual([pending]);
    expect(render(rows, {}, {}, false,
      { outbox: `broken\n[]\n${JSON.stringify(approved)}\n` })).toEqual([approvedText]);
  });

  test("result matching stays per call across turns and excludes sidechains", () => {
    expect(render([user(), call(),
      assistant([tool("mcp__app__email", { ...draft, body: "other body" }, "other-call")]),
      result("other-call", false, "[Email outgoing] id=other status=sent"),
      { ...outcome("sent"), isSidechain: true }, user("next turn"), outcome("pending_approval")]))
      .toEqual([pending, "[Email to reader@example.test]\nSubject: Update\n\nother body"]);
  });

  test("draft metadata cannot split the not sent marker onto another line", () => {
    expect(render([user(), assistant([tool("mcp__app__email",
      { to: "reader@example.test\n", subject: "Update\r\ncontinued", body: "unsent body" })])]))
      .toEqual(["[Mail draft to reader@example.test: Update continued, not sent]"]);
  });
});

describe("shared transcript speech", () => {
  test("plain text and thinking after a person's message never become speech without a record", () => {
    expect(render([user(), assistant([text("terminal only"), { type: "thinking", thinking: "private reasoning" }]),
      { type: "assistant", message: { role: "assistant", content: "string terminal prose" } }])).toEqual([]);
  });

  test("a reply next to a terminal summary keeps only the reply", () => {
    expect(render([user(), assistant([tool("mcp__app__reply", { text: "answer" }), text("terminal summary")])]))
      .toEqual(["[App] answer"]);
  });

  test("app tool aliases come from the existing resolver, including voice and mail", () => {
    const aliases = Bun.spawnSync(["bash", "-c", '. "$1"; embervy_app_tool_names reply send voice_reply email',
      "speech-test", join(import.meta.dir, "../../shared/scripts/legacy-names.sh")], {
      env: { PATH: process.env.PATH! }, stdout: "pipe", stderr: "pipe",
    });
    expect(aliases.exitCode).toBe(0);
    const names = aliases.stdout.toString().trim().split(/\s+/);
    // One current name per tool: the house no longer carries aliases from older server names.
    expect(names.length).toBe(4);
    for (const name of names) {
      const email = name.endsWith("__email");
      expect(render([user(), assistant([tool(name, email ? { to: "reader@example.test", subject: "Update", body: "mail" } : { text: "spoken" })]),
        result("tool", false, "[Email outgoing] id=mail status=sent")]))
        .toEqual([email ? "[Email to reader@example.test]\nSubject: Update\n\nmail" : "[App] spoken"]);
    }
  });

  test("configured reply and mail matching stays exact while room and peer accept suffixes", () => {
    const parts = [tool("custom_reply", { text: "answer" }), tool("mcp__app__reply", { text: "not configured" }),
      tool("mcp__other__voice_reply", { text: "not the app" }), tool("mcp__app__voice_reply", { text: "voice" }),
      tool("room", { text: "room" }), tool("mcp__other__room", { text: "other room" }),
      tool("peer", { to: "recipient", text: "direct" }), tool("mcp__other__peer", { text: "direct fallback" }),
      tool("custom_email", { to: "reader@example.test", subject: "Update", body: "mail" }),
      tool("mcp__app__email", { body: "not configured" })];
    expect(render([user(), assistant(parts), result("tool", false, "[Email outgoing] id=mail status=sent")], {},
      { REPLY_TOOL_NAMES: "custom_reply", EMAIL_TOOL_NAMES: "custom_email" }))
      .toEqual(["[App] answer\n\n[App] voice\n\n[Room] room\n\n[Room] other room\n\n[Direct/recipient] direct\n\n[Direct] direct fallback\n\n[Email to reader@example.test]\nSubject: Update\n\nmail"]);
  });

  test("the last assistant uuid proves delivery across records and intervening tool results", () => {
    expect(render([user(), assistant([text(" first ")], "first"), result("other"),
      { type: "system", message: "metadata" }, assistant([text("second"), { type: "thinking", thinking: "never speech" }]),
      { ...assistant([text("sidechain")], "side"), isSidechain: true },
      user("next turn"), assistant([text("not delivered")], "next")], { "gateway-sent-uuids.log": "last\n" }, {}, true))
      .toEqual(["[App] first", "[App] second"]);
  });

  test("an earlier uuid and the overwritten single marker are not proof for the final turn", () => {
    expect(render([user(), assistant([text("first")], "first"), assistant([text("last")])],
      { "gateway-sent-uuids.log": "first\n", "gateway-sent-uuid": "last\n" })).toEqual([]);
  });

  test("old hashes cover missing replies followed by all stripped text blocks with blank lines", () => {
    const rows = [user(), assistant([tool("mcp__app__reply", { text: " owed " }, "reply"), text(" first ")], "first"),
      result("reply", true), assistant([text(" second \n")])];
    expect(render(rows, { "gateway-sent-hashes.log": hash("owed\n\nfirst\n\nsecond") + "\n" }))
      .toEqual(["[App] owed\n\n[App] first", "[App] second"]);
    // A hash that covers neither the failed reply nor the whole turn proves no delivery of either.
    expect(render(rows, { "gateway-sent-hashes.log": hash("first\n\nsecond") + "\n" }))
      .toEqual([]);
  });

  test("hash fallback remains available when the uuid log also exists", () => {
    expect(render([user(), assistant([text("older delivery")])], {
      "gateway-sent-uuids.log": "newer\n", "gateway-sent-hashes.log": hash("older delivery") + "\n",
    })).toEqual(["[App] older delivery"]);
  });

  test("missing and unrelated records do not preserve text", () => {
    const rows = [user(), assistant([text("not sent")])];
    expect(render(rows)).toEqual([]);
    expect(render(rows, { "gateway-sent-uuids.log": "other\n", "gateway-sent-hashes.log": hash("different") + "\n" })).toEqual([]);
  });

  test("a selected state directory does not fall back to another directory", () => {
    expect(render([user(), assistant([text("not sent here")])], { "gateway-sent-uuids.log": "last\n" },
      { EMBERVY_GATEWAY_STATE_DIR: "/dev/null/unavailable" })).toEqual([]);
  });

  test("a successful reply and an owed reply never authorize the surrounding terminal summary", () => {
    const rows = [user(), assistant([tool("mcp__app__reply", { text: "arrived" }, "ok")], "first"), result("ok"),
      assistant([tool("mcp__app__reply", { text: "owed" }, "failed"), text("terminal summary")]), result("failed", true)];
    for (const logs of [{ "gateway-sent-uuids.log": "last\n" }, { "gateway-sent-hashes.log": hash("owed") + "\n" }]) {
      expect(render(rows, logs)).toEqual(["[App] arrived", "[App] owed"]);
    }
  });

  test("successful room delivery and quiet markers also keep owed sends free of terminal prose", () => {
    const logs = { "gateway-sent-uuids.log": "last\n" };
    expect(render([user('<channel kind="room">hello</channel>'),
      assistant([tool("room", { text: "room answer" }, "room")], "first"), result("room"),
      assistant([tool("mcp__app__reply", { text: "owed" }), text("terminal summary")])], logs))
      .toEqual(["[Room] room answer", "[App] owed"]);
    expect(render([user(), assistant([tool("mcp__app__reply", { text: "owed" }), text("[still] private")])], logs))
      .toEqual(["[App] owed"]);
  });

  test("a failure reported only in the result text counts as failed everywhere", () => {
    const rows = [user(), assistant([tool("mcp__app__reply", { text: "owed" }, "quiet-fail")], "first"),
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "quiet-fail", content: [{ type: "text", text: "NOT delivered — no answer from the app" }] }] } }];
    expect(render(rows)).toEqual([]);
    expect(render(rows, { "gateway-sent-hashes.log": hash("owed") + "\n" })).toEqual(["[App] owed"]);
  });

  test("successful retries settle missing reply text without exposing terminal prose", () => {
    expect(render([user(), assistant([tool("mcp__app__reply", { text: "answer" }, "failed")], "first"), result("failed", true),
      assistant([tool("mcp__app__reply", { text: "answer" }, "retry"), text("terminal summary")]), result("retry")],
      // The failed attempt reached nobody; the retry did, once.
      { "gateway-sent-uuids.log": "last\n" })).toEqual(["[App] answer"]);
  });

  test("house prompts keep outreach tools but not terminal prose", () => {
    expect(render([user("[gateway:silent] quiet"), assistant([text("private"), tool("mcp__app__reply", { text: "answer" })])]))
      .toEqual(["[App] answer"]);
  });
});
