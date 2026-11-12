import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the Stop hook against a fake app on a random port; only successful
// tool results count as delivered replies, so refused replies are sent again.

const SCRIPT = join(import.meta.dir, "reply-gateway.sh");
const root = mkdtempSync(join(tmpdir(), "reply.gateway-"));
const posted: any[] = [];
const app = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    posted.push({ path: new URL(req.url).pathname, auth: req.headers.get("authorization"), body: await req.json().catch(() => null) });
    return Response.json({ ok: true }, { status: posted.at(-1)?.body?.text === "reject this broadcast" ? 503 : 200 });
  },
});
afterAll(() => {
  app.stop(true);
  rmSync(root, { recursive: true, force: true });
});

let runs = 0;
async function gateway(transcript: any[], previousUuids: string[] = [], customState = false): Promise<{ decisions: any[]; posts: any[]; uuids: string[]; mark: string }> {
  const home = join(root, `run-${++runs}`);
  const projects = join(home, ".claude/projects");
  const project = join(projects, home.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  // Hook ownership uses Claude's encoding; the gateway also checks a slash-only alias.
  const gatewayProject = join(projects, home.replaceAll("/", "-"));
  if (gatewayProject !== project) symlinkSync(project, gatewayProject, "dir");
  const path = join(project, `transcript-${runs}.jsonl`);
  writeFileSync(path, transcript.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const state = join(home, customState ? "delivery-state" : "state");
  mkdirSync(state, { recursive: true });
  const uuidLog = join(state, "gateway-sent-uuids.log");
  if (previousUuids.length) writeFileSync(uuidLog, previousUuids.join("\n") + "\n");
  const before = posted.length;
  const proc = Bun.spawn(["bash", SCRIPT], {
    cwd: home,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      EMBERVY_HOME: home,
      ...(customState ? { EMBERVY_GATEWAY_STATE_DIR: state } : {}),
      // The house the hook belongs to; installed scripts take it from their own path.
      EMBERVY_HOOK_HOME: home,
      APP_DIR: home, // no .env there
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_PORT: String(app.port),
      INTERNAL_API_TOKEN: "gateway-test-token",
    },
    stdin: new Blob([JSON.stringify({ transcript_path: path })]),
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await proc.exited).toBe(0);
  const log = join(home, "logs", "reply-gateway.jsonl");
  const decisions = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const uuids = existsSync(uuidLog) ? readFileSync(uuidLog, "utf8").trim().split("\n").filter(Boolean) : [];
  const markPath = join(state, "gateway-sent-uuid");
  const mark = existsSync(markPath) ? readFileSync(markPath, "utf8").trim() : "";
  return { decisions, posts: posted.slice(before), uuids, mark };
}

const user = (text: string) => ({ type: "user", uuid: "u1", message: { role: "user", content: text } });
const replyUse = (id: string, text: string) => ({ type: "assistant", uuid: `a-${id}`, message: { content: [{ type: "tool_use", id, name: "mcp__app__reply", input: { text } }] } });
const result = (id: string, isError: boolean, text: string) => ({ type: "user", uuid: `r-${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: [{ type: "text", text }] }] } });
const say = (text: string) => ({ type: "assistant", uuid: "a-last", message: { content: [{ type: "text", text }] } });

describe("gateway delivery records", () => {
  test("a successful broadcast appends the last assistant uuid in the selected state directory", async () => {
    const r = await gateway([user("hello"), { ...say("first block"), uuid: "a-first" }, say("last block")], ["previous"], true);
    expect(r.posts.map(p => p.body.text)).toEqual(["first block\n\nlast block"]);
    expect(r.uuids).toEqual(["previous", "a-last"]);
    expect(r.mark).toBe("a-last");
  }, 15_000);

  test("a failed broadcast does not append or replace delivery records", async () => {
    const r = await gateway([user("hello"), say("reject this broadcast")], ["previous"]);
    expect(r.posts).toHaveLength(1);
    expect(r.decisions.map(d => d.decision)).toContain("failed");
    expect(r.uuids).toEqual(["previous"]);
    expect(r.mark).toBe("");
  }, 15_000);

  test("the uuid log keeps only its last 5000 records", async () => {
    const previous = Array.from({ length: 5000 }, (_, i) => `previous-${i}`);
    const r = await gateway([user("hello"), say("delivered text")], previous);
    expect(r.uuids).toEqual([...previous.slice(1), "a-last"]);
    expect(r.uuids).toHaveLength(5000);
    expect(r.mark).toBe("a-last");
  }, 15_000);

  test("a skipped reply does not append a delivery record", async () => {
    const r = await gateway([user("hello"), say("[still]")]);
    expect(r.posts).toHaveLength(0);
    expect(r.uuids).toEqual([]);
    expect(r.mark).toBe("");
  }, 15_000);
});

describe("reply-gateway.sh: a reply counts only when it arrived", () => {
  test("reply with a clean tool_result → skipped, nothing posted", async () => {
    const r = await gateway([user("hi"), replyUse("t1", "Hello there"), result("t1", false, "Sent: Hello there"), say("terminal note")]);
    expect(r.posts).toHaveLength(0);
    expect(r.decisions.map((d) => d.detail)).toContain("SKIP:replied");
  }, 15_000);

  test("reply refused by the app (is_error) → the gateway sends the reply text and the turn's text", async () => {
    const r = await gateway([user("hi"), replyUse("t2", "Hello there"), result("t2", true, "NOT delivered — HTTP 401"), say("Something went wrong on my side.")]);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].path).toBe("/api/internal/broadcast");
    expect(r.posts[0].auth).toBe("Bearer gateway-test-token");
    expect(r.posts[0].body.text).toBe("Hello there\n\nSomething went wrong on my side.");
    expect(r.decisions.map((d) => d.decision)).toContain("sent");
  }, 15_000);

  test("reply without any tool_result (turn cut short) → sent; a later clean retry → skipped", async () => {
    const lost = await gateway([user("hi"), replyUse("t3", "Are you there?")]);
    expect(lost.posts.map((p) => p.body.text)).toEqual(["Are you there?"]);
    const retried = await gateway([user("hi"), replyUse("t4", "Again"), result("t4", true, "NOT delivered"), replyUse("t5", "Again"), result("t5", false, "Sent: Again")]);
    expect(retried.posts).toHaveLength(0);
    expect(retried.decisions.map((d) => d.detail)).toContain("SKIP:replied");
  }, 15_000);
});

// Count each reply separately so a delivered reply cannot hide a refused one.
describe("reply-gateway.sh: each reply is counted on its own", () => {
  test("an arrived 'I'll check' does not hide a refused result: only the result is owed, not the terminal text", async () => {
    const r = await gateway([
      user("hi"),
      replyUse("m1", "I'll check that."), result("m1", false, "Sent: I'll check that."),
      replyUse("m2", "The final result."), result("m2", true, "NOT delivered — HTTP 500"),
      say("terminal note after the replies"),
    ]);
    expect(r.posts.map((p) => p.body.text)).toEqual(["The final result."]);
    expect(r.decisions.map((d) => d.decision)).toContain("sent");
  }, 15_000);

  test("the reverse order: a refused early reply, an arrived later one → the early one is owed", async () => {
    const r = await gateway([
      user("hi"),
      replyUse("m3", "Starting now."), result("m3", true, "NOT delivered — HTTP 500"),
      replyUse("m4", "Done, all green."), result("m4", false, "Sent: Done, all green."),
    ]);
    expect(r.posts.map((p) => p.body.text)).toEqual(["Starting now."]);
  }, 15_000);

  test("a refused reply that arrived on a retry, next to another arrived one → nothing owed", async () => {
    const r = await gateway([
      user("hi"),
      replyUse("m5", "First."), result("m5", false, "Sent: First."),
      replyUse("m6", "Second."), result("m6", true, "NOT delivered"),
      replyUse("m7", "Second."), result("m7", false, "Sent: Second."),
    ]);
    expect(r.posts).toHaveLength(0);
    expect(r.decisions.map((d) => d.detail)).toContain("SKIP:replied");
  }, 15_000);
});

describe("reply-gateway.sh: size is no reason to lose a text", () => {
  // Send long text through stdin to avoid Linux's 128 KiB argument limit.
  test("a 200 kB turn text arrives whole", async () => {
    const long = "Line of a long report.\n".repeat(9000); // ~207 kB
    const r = await gateway([user("hi"), say(long)]);
    expect(r.posts).toHaveLength(1);
    const got = String(r.posts[0].body?.text ?? "");
    expect(got.length).toBe(long.trimEnd().length);
    expect(got === long.trimEnd()).toBe(true);
  }, 15_000);
});

describe("reply-gateway.sh: [still] keeps terminal text in the terminal, as in Brain", () => {
  test("a turn that ends with [still] and no reply → nothing posted", async () => {
    const r = await gateway([user("hi"), say("[still] Waiting for the build.")]);
    expect(r.posts).toHaveLength(0);
    expect(r.decisions.map((d) => d.detail)).toContain("SKIP:still");
  }, 15_000);

  test("a bare [still] → nothing posted", async () => {
    const r = await gateway([user("hi"), say("[still]")]);
    expect(r.posts).toHaveLength(0);
  }, 15_000);

  test("a refused reply is still owed; the [still] terminal text stays out", async () => {
    const r = await gateway([user("hi"), replyUse("s1", "The answer"), result("s1", true, "NOT delivered"), say("[still] note to self")]);
    expect(r.posts.map((p) => p.body.text)).toEqual(["The answer"]);
  }, 15_000);
});
