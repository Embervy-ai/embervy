import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDraft, fetchSinceCursor, saveTokenCache, loadTokenCache, startDeviceCode, pollDeviceCodeOnce, refreshToken } from "./graph";

const readScope = "Mail.Read offline_access";
const fullScope = "Mail.Read Mail.ReadWrite Mail.Send offline_access";

for (const allowSend of [undefined, false, true]) {
  test(`device-code permissions follow writing setup: ${allowSend}`, async () => {
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: any, init: any) => {
        expect(String(url)).toEndWith("/devicecode");
        expect(new URLSearchParams(init.body).get("scope")).toBe(allowSend === true ? fullScope : readScope);
        return Response.json({ device_code: "test" });
      }) as typeof fetch;
      await startDeviceCode("test", allowSend);
    } finally { globalThis.fetch = original; }
  });
}

for (const scope of [readScope, fullScope, undefined]) {
  test(`refresh persists and reuses granted scope: ${scope ?? "legacy"}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-scope-"));
    const original = globalThis.fetch;
    try {
      const path = join(dir, "token.json");
      await saveTokenCache(path, { access_token: "old", refresh_token: "refresh", expires_at: 0, ...(scope ? { scope } : {}) });
      globalThis.fetch = (async (_url: any, init: any) => {
        expect(new URLSearchParams(init.body).get("scope")).toBe(scope ?? fullScope);
        return Response.json({ access_token: "new", refresh_token: "rotated", expires_in: 3600 });
      }) as typeof fetch;
      await refreshToken("test", path, (await loadTokenCache(path))!);
      expect(await loadTokenCache(path)).toMatchObject({ access_token: "new", refresh_token: "rotated", scope: scope ?? fullScope });
    } finally { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
  });
}

test("token response scope is retained through cache and refresh", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-grant-"));
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ access_token: "test", refresh_token: "test", expires_in: 3600, scope: readScope })) as typeof fetch;
    const result = await pollDeviceCodeOnce("test", "device", fullScope);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed consent");
    const path = join(dir, "token.json");
    await saveTokenCache(path, result.tokens);
    expect((await loadTokenCache(path))!.scope).toBe(readScope);
    globalThis.fetch = (async (_url: any, init: any) => {
      expect(new URLSearchParams(init.body).get("scope")).toBe(readScope);
      return Response.json({ access_token: "next", refresh_token: "next", expires_in: 3600, scope: "Mail.Read" });
    }) as typeof fetch;
    await refreshToken("test", path, (await loadTokenCache(path))!);
    expect((await loadTokenCache(path))!.scope).toBe("Mail.Read");
  } finally { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
});

test("device-code token without scope retains the requested scope", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () => Response.json({ access_token: "test", refresh_token: "test", expires_in: 3600 })) as typeof fetch;
    for (const scope of [readScope, fullScope]) {
      const result = await pollDeviceCodeOnce("test", "device", scope);
      expect(result.status).toBe("completed");
      if (result.status === "completed") expect(result.tokens.scope).toBe(scope);
    }
  } finally { globalThis.fetch = original; }
});

test("Graph drafts return the created id, remain plain text and preserve header protection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-draft-"));
  const original = globalThis.fetch;
  try {
    const account = { clientId: "test", tokenCachePath: join(dir, "token.json") };
    await saveTokenCache(account.tokenCachePath, { access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 });
    let calls = 0;
    globalThis.fetch = (async (input: any, init: any) => {
      calls++;
      expect(String(input)).toBe("https://graph.microsoft.com/v1.0/me/messages");
      expect(init.method).toBe("POST");
      const payload = JSON.parse(init.body);
      expect(payload.subject).toBe("Hello Bcc: hidden@example.test");
      expect(payload.body.contentType).toBe("Text");
      expect(payload.body.content).toContain("<b>not HTML</b>");
      return Response.json({ id: "graph-draft-id" }, { status: 201 });
    }) as typeof fetch;
    const result = await appendDraft(account, { to: "recipient@example.test", subject: "Hello\r\nBcc: hidden@example.test", body: "<b>not HTML</b>", inReplyTo: "<message@example.test>" });
    expect(result).toMatchObject({ ok: true, id: "graph-draft-id" });
    expect(calls).toBe(1);
    expect((await appendDraft(account, { to: "bad:address", subject: "Hello", body: "Text" })).ok).toBe(false);
    expect(calls).toBe(1);
    globalThis.fetch = (async () => new Response("refused", { status: 403 })) as typeof fetch;
    expect(await appendDraft(account, { to: "recipient@example.test", subject: "Hello", body: "Text" })).toMatchObject({ ok: false, id: null });
  } finally { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); }
});

test("Graph inbox bootstrap, invalid entities and durable page continuation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-pages-"));
  const original = globalThis.fetch;
  try {
    const account = { clientId: "test", tokenCachePath: join(dir, "token.json") };
    await saveTokenCache(account.tokenCachePath, { access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 });
    const before = Date.now();
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1.0/me/mailFolders/inbox/messages");
      expect(Date.parse(url.searchParams.get("$filter")!.replace("receivedDateTime ge ", ""))).toBeGreaterThanOrEqual(before);
      return Response.json({ value: [] });
    }) as typeof fetch;
    const bootstrap = await fetchSinceCursor(account, null);
    expect(Date.parse(bootstrap.cursor.since)).toBeGreaterThanOrEqual(before);
    const time = new Date().toISOString();
    const pages: number[] = [];
    globalThis.fetch = (async (input: any) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/v1.0/me/mailFolders/inbox/messages");
      const page = Number(url.searchParams.get("page") || 0);
      pages.push(page);
      return Response.json({ value: [{ id: `id-${page}`, subject: `page-${page}`, receivedDateTime: time, body: { contentType: "html", content: page === 0 ? "&#1114112; &#x110000; &#xD800; &#65;" : page === 1 ? { broken: true } : "normal" } }], ...(page < 20 ? { "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?page=${page + 1}` } : {}) });
    }) as typeof fetch;
    const first = await fetchSinceCursor(account, { since: new Date(0).toISOString(), seenIdsAtSince: [] });
    expect(first.messages).toHaveLength(20);
    expect(first.messages[0].text).toBe("&#1114112; &#x110000; &#xD800; A");
    expect(first.messages[1].text).toBe("");
    expect(first.cursor.nextLink).toContain("page=20");
    await Bun.write(join(dir, "cursor.json"), JSON.stringify(first.cursor));
    const next = await fetchSinceCursor(account, await Bun.file(join(dir, "cursor.json")).json());
    expect(next.messages.map((m) => m.id)).toEqual(["id-20"]);
    expect(next.cursor.nextLink).toBeUndefined();
    expect(pages).toEqual(Array.from({ length: 21 }, (_, n) => n));
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inclusive Graph boundary delivers a late visible message without repeating the first", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graph-boundary-"));
  const original = globalThis.fetch;
  try {
    const account = { clientId: "test", tokenCachePath: join(dir, "token.json") };
    await saveTokenCache(account.tokenCachePath, { access_token: "test", refresh_token: "test", expires_at: Date.now() + 3600000 });
    const time = new Date(100000).toISOString();
    let visible = ["A"];
    globalThis.fetch = (async (input: any) => {
      const filter = new URL(String(input)).searchParams.get("$filter")!;
      const match = /^receivedDateTime (gt|ge) (.+)$/.exec(filter)!;
      expect(match).not.toBeNull();
      const value = visible.map((id) => ({ id, subject: id, receivedDateTime: time })).filter((m) => match[1] === "ge" ? m.receivedDateTime >= match[2] : m.receivedDateTime > match[2]);
      return Response.json({ value });
    }) as typeof fetch;
    const first = await fetchSinceCursor(account, { since: new Date(0).toISOString(), seenIdsAtSince: [] });
    expect(first.messages.map((m) => m.subject)).toEqual(["A"]);
    visible = ["A", "B"];
    const second = await fetchSinceCursor(account, first.cursor);
    expect(second.messages.map((m) => m.subject)).toEqual(["B"]);
    expect(first.cursor.seenIdsAtSince).toEqual(["A"]);
    expect((await fetchSinceCursor(account, second.cursor)).messages).toEqual([]);
  } finally {
    globalThis.fetch = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
