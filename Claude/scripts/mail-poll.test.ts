import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";

test("cursor recovery distinguishes missing, corrupt and foreign account state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-state-"));
  try {
    const source = await Bun.file(join(import.meta.dir, "mail-poll.ts")).text();
    const load = source.slice(source.indexOf("async function loadState("), source.indexOf("async function saveState("));
    const script = `
      import { rmSync, mkdirSync } from "node:fs";
      const STATE_PATH = ${JSON.stringify(join(dir, "state.json"))};
      const ACCOUNT = "imap:host:user";
      let IS_GRAPH = false;
      ${load}
      if (Object.keys(await loadState()).length) throw new Error("missing is not first run");
      for (const text of ["{broken", "null", "{}", JSON.stringify({account: "imap:other:user", uid_cursor: {uidValidity: "1", lastUid: 999}})]) {
        await Bun.write(STATE_PATH, text);
        if (!(await loadState()).recovery) throw new Error("bad cursor skips mail");
      }
      await Bun.write(STATE_PATH, JSON.stringify({account: ACCOUNT, uid_cursor: {uidValidity: "1", lastUid: 3}}));
      if ((await loadState()).uid_cursor.lastUid !== 3) throw new Error("valid cursor rejected");
      await Bun.write(STATE_PATH, JSON.stringify({uid_cursor: {uidValidity: "1", lastUid: 42}}));
      const legacy = await loadState();
      if (legacy.recovery || legacy.uid_cursor.lastUid !== 42) throw new Error("legacy cursor triggers recovery");
      await Bun.write(STATE_PATH, "{}");
      rmSync(STATE_PATH);
      mkdirSync(STATE_PATH);
      if (!(await loadState()).recovery) throw new Error("unreadable cursor accepted");
      rmSync(STATE_PATH, {recursive: true});
      IS_GRAPH = true;
      const graph_cursor = {since: '2026-10-10T12:00:00.000Z', seenIdsAtSince: ['old']};
      await Bun.write(STATE_PATH, JSON.stringify({graph_cursor}));
      if (JSON.stringify((await loadState()).graph_cursor) !== JSON.stringify(graph_cursor)) throw new Error('legacy Graph cursor rejected');
      await Bun.write(STATE_PATH, JSON.stringify({account: 'foreign', graph_cursor}));
      if (!(await loadState()).recovery) throw new Error('foreign Graph cursor accepted');
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("UIDVALIDITY change rescans arrivals instead of bootstrapping", async () => {
  const source = await Bun.file(join(import.meta.dir, "../../shared/mail/imap.ts")).text();
  const fn = source.slice(source.indexOf("export async function fetchSinceUid("), source.indexOf("interface RawMeta")).replace("export ", "");
  const script = `
    let range;
    const client = () => ({ mailbox: {uidValidity: 2n, uidNext: 8}, connect: async () => {}, getMailboxLock: async () => ({release() {}}), logout: async () => {}, close() {} });
    const fetchMetas = async (_c, r) => { range = r; return [{uid: 7, subject: "between polls"}]; };
    const downloadBodies = async (_c, m) => m;
    ${fn}
    const first = await fetchSinceUid({}, null);
    if (first.messages.length || first.cursor.lastUid !== 7) throw new Error("bootstrap imports history");
    const changed = await fetchSinceUid({}, {uidValidity: "1", lastUid: 999});
    if (changed.messages[0].uid !== 7 || !range.since || range.since.getTime() > Date.now() - 86399000) throw new Error("renumbering loses arrival");
    await fetchSinceUid({}, {uidValidity: "recovery", lastUid: 0});
    if (Math.abs(range.since.getTime() - (Date.now() - 86400000)) > 1000) throw new Error("corruption recovery exceeds 24 hours");
    await fetchSinceUid({}, {uidValidity: "2", lastUid: 6});
    if (range.uid !== "7:*" || range.since) throw new Error("valid cursor rereads history");
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
});
test("Graph recovery is bounded and legacy provider cursors are adopted on save", async () => {
  const source = await Bun.file(join(import.meta.dir, "mail-poll.ts")).text();
  const graph = source.slice(source.indexOf("async function pollGraph("), source.indexOf("async function deliverAndAdvance("));
  const imap = source.slice(source.indexOf("async function pollImap("), source.indexOf("async function pollGraph("));
  const script = `
    const GRAPH_CLIENT_ID = 'client', GRAPH_TOKEN_CACHE_PATH = 'unused', ACCOUNT = 'account';
    const HOST = 'host', PORT = 993, SECURE = true, USER = 'user', APP_PASSWORD = 'password';
    let state, saved, received;
    const loadState = async () => state;
    const saveState = async (s) => { saved = s; };
    const withTimeout = async (p) => p;
    const deliverAndAdvance = async (_m, commit) => commit();
    const fetchSinceCursor = async (_a, cursor) => { received = cursor; return {messages: [], cursor}; };
    const fetchSinceUid = fetchSinceCursor;
    ${graph}
    ${imap}
    state = {recovery: true};
    await pollGraph();
    if (Math.abs(Date.parse(received.since) - (Date.now() - 86400000)) > 1000) throw new Error('Graph recovery unbounded');
    state = {graph_cursor: {since: '2026-10-10T12:00:00.000Z', seenIdsAtSince: ['seen']}};
    await pollGraph();
    if (received !== state.graph_cursor || saved.account !== ACCOUNT) throw new Error('Graph legacy cursor not adopted');
    state = {uid_cursor: {uidValidity: '2', lastUid: 42}};
    await pollImap();
    if (received !== state.uid_cursor || saved.account !== ACCOUNT) throw new Error('IMAP legacy cursor not adopted');
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
});
import { tmpdir } from "node:os";
import { join } from "node:path";

test("mail poll advances its cursor only after internal inbox acceptance", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mail-poll-"));
  try {
    const source = await Bun.file(join(import.meta.dir, "mail-poll.ts")).text();
    const start = source.indexOf("async function notifyApp(");
    const end = source.indexOf("async function main(");
    const deliveryStart = source.indexOf("async function deliverAndAdvance(");
    const deliveryEnd = source.indexOf("function withTimeout");
    const script = `
      import { contextLine } from ${JSON.stringify(join(import.meta.dir, "../../shared/scripts/context-text.ts"))};
      const USER = "mailbox@example.test", INTERNAL_TOKEN = "internal-test", APP_HOST = "127.0.0.1", APP_PORT = "1";
      let status = 500, commits = 0, requests = [];
      Bun.sleep = async () => {};
      globalThis.fetch = async (url, init) => {
        if (!url.endsWith("/api/internal/mail-inbox")) throw new Error("wrong route");
        if (init.headers.authorization !== "Bearer internal-test") throw new Error("missing bearer");
        requests.push(JSON.parse(init.body));
        return new Response("", { status });
      };
      ${source.slice(start, end)}
      ${source.slice(deliveryStart, deliveryEnd)}
      const messages = [{ subject: "test", from: "sender@example.test" }];
      await deliverAndAdvance(messages, async () => { commits++; });
      if (commits !== 0 || requests.length !== 2 || requests[0].id !== requests[1].id) throw new Error("failed delivery advances or changes retry ID");
      status = 200;
      await deliverAndAdvance(messages, async () => { commits++; });
      if (commits !== 1 || requests[2].source !== "email" || requests[2].from !== USER || !requests[2].text.startsWith("[Mailbox] ")) throw new Error("incorrect accepted delivery");
      if (requests[0].id !== requests[2].id) throw new Error("lost acknowledgement changes delivery ID");
      await deliverAndAdvance([...messages, { uid: 2, subject: "later", from: "sender@example.test" }], async () => { commits++; });
      if (requests.length !== 4 || requests[3].mails.length !== 2 || requests[3].mailKeys[0] !== requests[0].mailKeys[0]) throw new Error("not one summary with stable per-mail keys");
      await deliverAndAdvance(Array.from({length: 40}, (_, uid) => ({uid, subject: 'mail-' + uid, from: 'sender'})), async () => { commits++; });
      if (requests.length !== 5 || requests[4].mailKeys.length !== 40 || requests[4].text.split('\\n').filter(line => line.startsWith('- ')).length !== 10 || !requests[4].text.endsWith('…and 30 more')) throw new Error('summary not capped');
      await deliverAndAdvance([], async () => { commits++; });
      if (requests.length !== 5 || commits !== 4) throw new Error('empty fetch sends notification');
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
