import { afterAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Persist the inbox position so messages sent during downtime are delivered.
// Only the bridge with the matching main-session token may advance it;
// diagnostic bridges must not consume messages intended for the main session.

const dirs: string[] = [];
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 20_000);

function house() {
  const dir = mkdtempSync(join(tmpdir(), "inbox-gap-"));
  dirs.push(dir);
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  const inbox = join(data, "inbox.jsonl");
  const offsetFile = join(data, ".mcp-inbox-offset");
  const tokenFile = join(dir, "state", "main-bridge-token");
  let starts = 0;
  return {
    write: (id: string, text: string) => appendFileSync(inbox, JSON.stringify({ id, text, ts: "2026-10-02T06:00:00Z" }) + "\n"),
    offset: () => (existsSync(offsetFile) ? Number(readFileSync(offsetFile, "utf8")) : -1),
    inboxSize: () => statSync(inbox).size,
    // What the restart loop does around each start of the main session.
    startSession: () => { const token = `token-${++starts}`; writeFileSync(tokenFile, token + "\n"); return token; },
    endSession: () => rmSync(tokenFile, { force: true }),
    async bridge(received: string[], token?: string): Promise<Client> {
      const client = new Client({ name: "inbox-gap-test", version: "0.0.0" });
      client.fallbackNotificationHandler = async (n: any) => {
        if (n.method === "notifications/claude/channel") received.push(String(n.params?.content));
      };
      const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, EMBERVY_HOME: dir, EMBERVY_APP_DATA_DIR: data, EMBERVY_APP_PORT: "9" };
      if (token !== undefined) env.EMBERVY_MAIN_BRIDGE_TOKEN = token;
      await client.connect(new StdioClientTransport({
        command: "bun", args: ["run", join(import.meta.dir, "mcp.ts")], cwd: dir, env, stderr: "ignore",
      }));
      clients.push(client);
      return client;
    },
  };
}
const until = async (cond: () => boolean, ms: number) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(100); };

test("a first start delivers nothing old; messages sent while no bridge runs arrive after the next start, once", async () => {
  const h = house();
  h.write("old-1", "from last week");
  const first: string[] = [];
  const a = await h.bridge(first, h.startSession());
  await Bun.sleep(4000); // past the backlog check
  expect(first).toEqual([]); // no file yet → from now on, no old history

  h.write("live-1", "while it runs");
  await until(() => first.length > 0, 5000);
  expect(first).toEqual(["while it runs"]);

  await a.close(); // the cut: no bridge
  h.endSession();
  h.write("gap-1", "sent during the cut");
  h.write("gap-2", "and another one");
  for (let i = 0; i < 75; i++) h.write(`gap-extra-${i}`, `accepted ${i}`);
  expect(h.offset()).toBeGreaterThan(0);

  const second: string[] = [];
  await h.bridge(second, h.startSession());
  await until(() => second.length >= 77, 8000);
  await Bun.sleep(1000);
  expect(second).toEqual(["sent during the cut", "and another one", ...Array.from({ length: 75 }, (_, i) => `accepted ${i}`)]);
}, 30_000);

test("a side bridge started during a cut neither delivers the gap nor moves the position; the next main bridge delivers it", async () => {
  const h = house();
  h.write("old-1", "from last week");
  const main1: string[] = [];
  const token1 = h.startSession();
  const a = await h.bridge(main1, token1);
  h.write("live-1", "while it runs");
  await until(() => main1.length > 0, 5000);
  expect(main1).toEqual(["while it runs"]);

  await a.close(); // the cut
  h.endSession();
  h.write("gap-1", "sent during the cut");
  h.write("gap-2", "and another one");
  const before = h.offset();
  expect(before).toBeGreaterThan(0);
  expect(before).toBeLessThan(h.inboxSize());

  // A doctor canary or `claude mcp list` (no token), and a run that still
  // carries the ended session's token (inherited by a child that outlived it).
  const side: string[] = [];
  const stale: string[] = [];
  const s = await h.bridge(side);
  const t = await h.bridge(stale, token1);
  await Bun.sleep(4000); // past the backlog check
  expect(side).toEqual([]);
  expect(stale).toEqual([]);
  expect(h.offset()).toBe(before);

  // A line that lands while they run: a side bridge sees it like any fresh
  // bridge would, but the position stays where the main session left it.
  h.write("gap-3", "arrived while the side bridges ran");
  await until(() => side.length > 0 && stale.length > 0, 5000);
  expect(side).toEqual(["arrived while the side bridges ran"]);
  expect(stale).toEqual(["arrived while the side bridges ran"]);
  expect(h.offset()).toBe(before);
  await s.close();
  await t.close();
  expect(h.offset()).toBe(before);

  const main2: string[] = [];
  await h.bridge(main2, h.startSession());
  await until(() => main2.length >= 3, 8000);
  await Bun.sleep(1000);
  expect(main2).toEqual(["sent during the cut", "and another one", "arrived while the side bridges ran"]);
  expect(h.offset()).toBe(h.inboxSize());
}, 40_000);

test("a main bridge that outlives its session stops moving the position", async () => {
  const h = house();
  h.write("old-1", "from last week");
  const orphan: string[] = [];
  await h.bridge(orphan, h.startSession());
  h.write("live-1", "while it runs");
  await until(() => orphan.length > 0, 5000);
  // Delivery comes before the position is saved; wait for the save itself.
  await until(() => h.offset() === h.inboxSize(), 5000);
  const before = h.offset();
  expect(before).toBe(h.inboxSize());

  h.endSession(); // the session ended, its bridge did not
  h.write("gap-1", "sent during the cut");
  await until(() => orphan.length > 1, 5000);
  expect(orphan).toEqual(["while it runs", "sent during the cut"]);
  expect(h.offset()).toBe(before);

  const next: string[] = [];
  await h.bridge(next, h.startSession());
  await until(() => next.length > 0, 8000);
  await Bun.sleep(1000);
  expect(next).toEqual(["sent during the cut"]);
}, 30_000);

test("a reply from the app reaches the agent with the quoted bubble as a line above the text", async () => {
  const h = house();
  const received: string[] = [];
  await h.bridge(received, h.startSession());
  await Bun.sleep(4000); // past the backlog check
  // Shape the app stores when the person answers a bubble.
  appendFileSync(join(dirs[dirs.length - 1], "data", "inbox.jsonl"), JSON.stringify({ id: "q-1", text: "Is this the one?", ts: "2026-11-06T16:50:55Z", type: "text",
    reply_to: { id: "a-1", snippet: "Package 20261106e is ready, both downloads checked …", role: "assistant" } }) + "\n");
  await until(() => received.length > 0, 5000);
  expect(received).toEqual(['↪ Replying to your message: "Package 20261106e is ready, both downloads checked …"\nIs this the one?']);
}, 20_000);
