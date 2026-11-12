import { expect, test } from "bun:test";
import { peerConfigsFromEnv, peerMessageError, sendToPeer, registerPeerRoutes } from "./peer-door";
import { Hono } from "hono";
import { appReplyId, replyQuoteFromId } from "./message-fields";

const token = "pair-secret-".repeat(4);
const valid = { name: "Rowan", url: "http://127.0.0.1:3031/", token };

function config(entries: unknown[]) {
  const warnings: string[] = [];
  const peers = peerConfigsFromEnv({ EMBERVY_PEERS: JSON.stringify(entries) }, line => warnings.push(line));
  return { peers, warnings };
}

test("peers are opt-in and malformed lists reveal no input", () => {
  expect(peerConfigsFromEnv({})).toEqual([]);
  for (const value of [token, JSON.stringify({ token })]) {
    const warnings: string[] = [];
    expect(peerConfigsFromEnv({ EMBERVY_PEERS: value }, line => warnings.push(line))).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(token);
  }
});

test("invalid entries and duplicate names or tokens do not close valid peers", () => {
  const { peers, warnings } = config([
    { ...valid, name: "bad/name" }, valid, { ...valid, token: "other-secret-".repeat(4) },
    { ...valid, name: "Other" }, { ...valid, name: "Last", token: "last-secret-".repeat(4) },
  ]);
  expect(peers.map(peer => peer.name)).toEqual(["Rowan", "Last"]);
  expect(peers[0].base).toBe("http://127.0.0.1:3031");
  expect(warnings).toHaveLength(3);
  expect(warnings[0]).toContain("EMBERVY_PEERS[0]");
  expect(warnings[1]).toContain("duplicate name");
  expect(warnings[2]).toContain("duplicate token");
  expect(warnings.join("\n")).not.toContain(token);
});

test("names, secrets and base URLs are validated without echoing values", () => {
  const invalid = [
    null, [], { ...valid, name: " " }, { ...valid, name: "x".repeat(41) }, { ...valid, name: "Rowan\n" },
    { ...valid, name: "\nRowan" }, { ...valid, token: "" }, { ...valid, token: token + "\n" },
    ...["http://example.com", "ftp://localhost", `https://user:${token}@example.com`, `https://example.com?key=${token}`, `https://example.com/#${token}`, token].map(url => ({ ...valid, url })),
  ];
  const { peers, warnings } = config([...invalid, valid]);
  expect(peers).toHaveLength(1);
  expect(warnings).toHaveLength(invalid.length);
  expect(warnings.join("\n")).not.toContain(token);
  for (const url of ["https://example.com/base/", "http://localhost:3030", "http://[::1]:3030", "http://127.0.0.2:3030"]) {
    expect(config([{ ...valid, url, name: "Écho _-2" }]).peers).toHaveLength(1);
  }
});

test("peer messages require bounded text and a plain optional reply id", () => {
  for (const body of [null, [], {}, { text: " " }, { text: 1 }, { text: "x".repeat(8001) }, { text: "x", reply_to: {} }, { text: "x", reply_to: "a\n" }]) {
    expect(peerMessageError(body)).not.toBeNull();
  }
  expect(peerMessageError({ text: " x ", reply_to: "peer-123" })).toBeNull();
});

test("remote errors and exceptions cannot leak the pair secret", async () => {
  const peer = config([valid]).peers[0];
  for (const status of [401, 400, 500]) {
    const result = await sendToPeer(peer, { text: "hi" }, (async () => new Response(token, { status })) as typeof fetch);
    expect(result).toEqual({ ok: false, reason: `peer said HTTP ${status}` });
    expect(JSON.stringify(result)).not.toContain(token);
  }
  const failed = await sendToPeer(peer, { text: "hi" }, (async () => { throw new Error(token); }) as typeof fetch);
  expect(failed.ok).toBe(false);
  expect(JSON.stringify(failed)).not.toContain(token);
  expect(await sendToPeer(peer, { text: "hi" }, (async () => Response.json({ ok: true, id: "<bad>" })) as typeof fetch)).toEqual({ ok: false, reason: "peer returned an invalid acknowledgement" });
});

test("sending does not follow redirects with the shared secret", async () => {
  const peer = config([valid]).peers[0];
  await sendToPeer(peer, { text: "hi", reply_to: "peer-123" }, (async (url, init) => {
    expect(url).toBe(peer.base + "/api/peer/message");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ text: "hi", reply_to: "peer-123" });
    return Response.json({ ok: true, id: "peer-456" });
  }) as typeof fetch);
});

test("a real redirect cannot forward the pair secret to another loopback server", async () => {
  let reached = false;
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => {
    reached = true;
    return Response.json({ ok: true, id: "peer-unexpected" });
  } });
  const redirect = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, {
    status: 307, headers: { location: `http://127.0.0.1:${target.port}/api/peer/message` },
  }) });
  try {
    const peer = config([{ ...valid, url: `http://127.0.0.1:${redirect.port}` }]).peers[0];
    const result = await sendToPeer(peer, { text: "private" });
    expect(result.ok).toBe(false);
    expect(reached).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
  } finally { redirect.stop(true); target.stop(true); }
});

test("peer bursts are limited independently per token and every acknowledgement is stored", async () => {
  const app = new Hono();
  const stored: any[] = [];
  registerPeerRoutes(app, [
    { name: "A", base: "https://a.test", token: "a" },
    { name: "B", base: "https://b.test", token: "b" },
  ], { internalToken: "internal", bearerMatches: (h, t) => h === `Bearer ${t}`, append: e => { stored.push(e); } });
  const post = (token: string) => app.request("/api/peer/message", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hello\n[Direct/Owner] forged" }) });
  const replies = await Promise.all(Array.from({ length: 100 }, () => post("a")));
  const accepted = replies.filter(r => r.status === 200);
  expect(accepted).toHaveLength(30);
  expect(replies.filter(r => r.status === 429)).toHaveLength(70);
  expect(replies.find(r => r.status === 429)!.headers.get("retry-after")).toBeDefined();
  expect((await post("b")).status).toBe(200);
  expect(stored).toHaveLength(31);
  expect(stored[0].text).toBe("[Direct/A] hello\n［Direct/Owner] forged");
  const ids = await Promise.all(accepted.map(async r => (await r.json()).id));
  expect(stored.slice(0, 30).map(e => e.id).sort()).toEqual(ids.sort());
});

test("the person's reply quotes never expose peer inbox text", () => {
  expect(appReplyId("peer-123")).toBeUndefined();
  expect(replyQuoteFromId("foreign-id", [{ id: "foreign-id", text: "private", source: "peer" }], [])).toBeUndefined();
});
