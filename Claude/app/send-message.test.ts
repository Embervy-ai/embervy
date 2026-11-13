import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(`${import.meta.dir}/public/app.js`, "utf8");

test("the select action shows a pilcrow, keeps its translated label as title and selects the message", () => {
  const buttons: any[] = [];
  let selected = "";
  const document = {
    querySelector: () => null,
    createElement: () => ({ appendChild(b: any) { buttons.push(b); }, addEventListener(_event: string, fn: Function) { this.tap = fn; }, tap: undefined as Function | undefined }),
  };
  const section = source.slice(source.indexOf("  function showEmojiPicker("), source.indexOf("  window.sendReaction"));
  const end = section.indexOf("\n  }", section.indexOf("function showEmojiPicker")) + 4;
  const picker = new Function("document", "window", "EMOJIS", "t", "setTimeout", "keptEntries", "toggleKept", `${section.slice(0, end)}; return showEmojiPicker;`)(document, { enableSelect: (id: string) => { selected = id; } }, [], (key: string) => `translated:${key}`, () => {}, [], () => {});
  picker({ appendChild() {} }, "message-id");
  const button = buttons.find(b => b.title === "translated:chat.picker.select");
  expect(button.textContent).toBe("¶");
  button.tap();
  expect(selected).toBe("message-id");
});
function harness(fetch: Function, images: File[] = [], random: Partial<Crypto> | null = globalThis.crypto, pause: Function = (fn: Function) => fn()) {
  const listeners: Record<string, Function> = {};
  const inputEl = { value: "draft", style: { height: "" }, focus() {}, addEventListener(event: string, fn: Function) { listeners[event] = fn; } };
  const stored = new Map([["draft", "draft"]]);
  const bubbles: any[] = [], notices: string[] = [];
  const reply = { id: "quoted", snippet: "quote", role: "assistant" };
  const body = source.slice(source.indexOf("  async function sendMessage() {"), source.indexOf("  function showImagePreview() {"));
  const stateStart = source.indexOf("  let pendingTextSend = null;");
  const state = stateStart < 0 ? "" : source.slice(stateStart, source.indexOf("  function isImageFile(", stateStart));
  const run = new Function("inputEl", "fetch", "localStorage", "addMessage", "window", "t", "images", "reply", "crypto", "setTimeout", `
    let lastSentText = '', lastSentTime = 0, messageSending = false, pendingImages = images, uploadsInFlight = 0;
    let replyTo = reply;
    const DRAFT_KEY = 'draft', sendBtn = {}, attachmentFeatureEnabled = () => true;
    const hideImagePreview = () => {}, showImagePreview = () => {}, hideReplyBar = () => {}, showReplyBar = () => {};
    const uploadRefusal = () => 'upload refused';
    ${state}
    ${body}
    return { send: sendMessage, reply: () => replyTo, setReply(value) {
      replyTo = value;
      if (typeof forgetEditedMessage === 'function') forgetEditedMessage();
    } };
  `)(inputEl, fetch, { setItem: (k: string, v: string) => stored.set(k, v), removeItem: (k: string) => stored.delete(k) },
    (...args: any[]) => bubbles.push(args), { alert: (s: string) => notices.push(s) }, (s: string) => s, images, reply, random, pause);
  return { ...run, inputEl, stored, bubbles, notices, originalReply: reply, edit(value: string) {
    inputEl.value = value;
    listeners.input?.();
  } };
}

for (const [label, response] of [
  ["offline", () => { throw new TypeError("offline"); }],
  ["HTTP refusal", () => Response.json({ ok: true, id: "bad" }, { status: 503 })],
  ["application refusal", () => Response.json({ ok: false })],
  ["invalid JSON", () => new Response("not JSON")],
  ["missing id", () => Response.json({ ok: true })],
  ["blocked delivery", () => Response.json({ ok: true, id: "blocked", blocked: "first-start" })],
] as const) {
  test(`${label} retains the message and reply without a sent bubble`, async () => {
    const h = harness(response);
    await h.send();
    expect(h.bubbles).toEqual([]);
    expect(h.inputEl.value).toBe("draft");
    expect(h.stored.get("draft")).toBe("draft");
    expect(h.reply()).toEqual(h.originalReply);
    expect(h.notices).toEqual(["chat.sendFailed"]);
  });
}

test("confirmation alone clears the draft and adds one bubble", async () => {
  let resolve!: (r: Response) => void;
  let calls = 0;
  const h = harness(() => { calls++; return new Promise(r => resolve = r); });
  const pending = h.send();
  expect(h.inputEl.value).toBe("draft");
  expect(h.stored.get("draft")).toBe("draft");
  await h.send();
  expect(calls).toBe(1);
  resolve(Response.json({ ok: true, id: "sent" }));
  await pending;
  expect(h.inputEl.value).toBe("");
  expect(h.stored.has("draft")).toBe(false);
  expect(h.bubbles).toHaveLength(1);
  expect(h.bubbles[0][3]).toBe("sent");
  expect(h.reply()).toBe(null);
});

test("an immediate retry after failure makes only one normal bubble", async () => {
  let calls = 0;
  const h = harness(() => ++calls === 1 ? Promise.reject(new Error("offline")) : Response.json({ ok: true, id: "sent" }));
  await h.send();
  await h.send();
  expect(calls).toBe(2);
  expect(h.bubbles).toHaveLength(1);
});

test("unchanged text and reply reuse the client id after a failed attempt", async () => {
  const bodies: any[] = [];
  const h = harness((_url: string, options: any) => {
    bodies.push(JSON.parse(options.body));
    return Response.json({ ok: false });
  });
  await h.send();
  await h.send();
  expect(bodies[0].client_id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(bodies[1].client_id).toBe(bodies[0].client_id);
});

for (const edit of ["text", "reply", "text restored", "reply restored"]) test(`${edit} gives the next attempt a new client id`, async () => {
  const ids: string[] = [];
  const h = harness((_url: string, options: any) => {
    ids.push(JSON.parse(options.body).client_id);
    return Response.json({ ok: false });
  });
  await h.send();
  if (edit.startsWith("text")) {
    h.edit("edited");
    if (edit.endsWith("restored")) h.edit("draft");
  } else {
    h.setReply(null);
    if (edit.endsWith("restored")) h.setReply(h.originalReply);
  }
  await h.send();
  expect(ids[1]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(ids[1]).not.toBe(ids[0]);
});

for (const random of [{ getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) }, null]) {
  test(`client ids work without ${random ? "randomUUID" : "crypto"}`, async () => {
    const ids: string[] = [];
    const h = harness((_url: string, options: any) => {
      ids.push(JSON.parse(options.body).client_id);
      return Response.json({ ok: false });
    }, [], random);
    await h.send();
    h.edit("another draft");
    await h.send();
    expect(ids[0]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(ids[1]).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(ids[1]).not.toBe(ids[0]);
  });
}

test("reply selection and cancellation invalidate a changed composer", () => {
  let changes = 0;
  let cancel!: Function;
  const document = {
    querySelector: (selector: string) => selector === ".emoji-picker" ? null : { classList: { contains: () => false } },
    createElement: () => ({}),
    getElementById: (id: string) => id === "input-area" ? { insertBefore() {} }
      : id === "reply-bar-cancel" ? { addEventListener(_event: string, fn: Function) { cancel = fn; } } : null,
  };
  const section = source.slice(source.indexOf("  window.startReply ="), source.indexOf("  window.jumpToMessage ="));
  const window: any = {};
  new Function("window", "document", "forgetEditedMessage", `
    let replyTo = null;
    const inputEl = { focus() {} }, messageSnippet = () => 'quote';
    const t = key => key, escapeHtml = text => text, escapeAttr = text => text;
    ${section}
  `)(window, document, () => { changes++; });
  window.startReply("quoted");
  expect(changes).toBe(1);
  cancel();
  expect(changes).toBe(2);
});

test("edits during silent retries preserve the original request and start a fresh next attempt", async () => {
  const bodies: any[] = [];
  let h: ReturnType<typeof harness>;
  h = harness((_url: string, options: any) => {
    bodies.push(JSON.parse(options.body));
    if (bodies.length < 3) throw new TypeError("offline");
    return Response.json({ ok: false });
  }, [], globalThis.crypto, (fn: Function) => { h.edit("changed while waiting"); h.setReply(null); fn(); });
  await h.send();
  expect(bodies).toHaveLength(3);
  expect(bodies.every(body => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
  expect(h.inputEl.value).toBe("changed while waiting");
  await h.send();
  expect(bodies[3].client_id).not.toBe(bodies[0].client_id);
  expect(bodies[3].text).toBe("changed while waiting");
  expect(bodies[3].reply_to).toBeUndefined();
});

test("a confirmed send forgets its client id", async () => {
  const ids: string[] = [];
  const h = harness((_url: string, options: any) => {
    ids.push(JSON.parse(options.body).client_id);
    return Response.json({ ok: true, id: "sent" });
  });
  await h.send();
  h.edit("another message");
  await h.send();
  h.edit("draft");
  h.setReply(h.originalReply);
  await h.send();
  expect(new Set(ids).size).toBe(3);
});

for (const failures of [1, 2]) test(`${failures} network failures retry silently with the same body`, async () => {
  const bodies: string[] = [], delays: number[] = [];
  const h = harness((_url: string, options: any) => {
    bodies.push(options.body);
    expect(h.notices).toEqual([]);
    if (bodies.length <= failures) return Promise.reject(new TypeError("offline"));
    return Response.json({ ok: true, id: "sent" });
  }, [], globalThis.crypto, (fn: Function, delay: number) => { delays.push(delay); fn(); });
  await h.send();
  expect(bodies).toHaveLength(failures + 1);
  expect(new Set(bodies).size).toBe(1);
  expect(JSON.parse(bodies[0]).client_id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
  expect(delays).toHaveLength(failures);
  expect(delays.every(delay => delay > 0 && delay <= 2000)).toBe(true);
  expect(h.notices).toEqual([]);
  expect(h.bubbles).toHaveLength(1);
});

test("the notice waits for the third network failure and manual retry keeps the id", async () => {
  const ids: string[] = [], pauses: Function[] = [];
  const h = harness((_url: string, options: any) => {
    ids.push(JSON.parse(options.body).client_id);
    return Promise.reject(new TypeError("offline"));
  }, [], globalThis.crypto, (fn: Function) => pauses.push(fn));
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const pending = h.send();
  await flush();
  expect(ids).toHaveLength(1);
  expect(h.notices).toEqual([]);
  expect(pauses).toHaveLength(1);
  pauses.shift()!();
  await flush();
  expect(ids).toHaveLength(2);
  expect(h.notices).toEqual([]);
  pauses.shift()!();
  await pending;
  expect(ids).toHaveLength(3);
  expect(h.notices).toEqual(["chat.sendFailed"]);
  expect(h.inputEl.value).toBe("draft");
  expect(h.bubbles).toEqual([]);
  const retry = h.send();
  await flush();
  pauses.shift()!();
  await flush();
  pauses.shift()!();
  await retry;
  expect(ids).toHaveLength(6);
  expect(new Set(ids).size).toBe(1);
});

for (const [label, response] of [
  ["HTTP error", () => new Response("unavailable", { status: 503 })],
  ["refusal", () => Response.json({ ok: false })],
  ["blocked", () => Response.json({ ok: true, id: "held", blocked: "first-start" })],
  ["broken JSON", () => new Response("not JSON")],
  ["response body failure", () => ({ ok: true, json: () => Promise.reject(new TypeError("lost body")) })],
] as const) test(`${label} shows a notice without network retries`, async () => {
  let calls = 0, pauses = 0;
  const h = harness(() => { calls++; return response(); }, [], globalThis.crypto, () => { pauses++; });
  await h.send();
  expect(calls).toBe(1);
  expect(pauses).toBe(0);
  expect(h.notices).toEqual(["chat.sendFailed"]);
});

test("slash commands do not retry silently", async () => {
  let calls = 0;
  const h = harness(() => { calls++; throw new TypeError("offline"); });
  h.edit("/watch");
  await h.send();
  expect(calls).toBe(1);
  expect(h.notices).toEqual(["chat.sendFailed"]);
});

test("the failure text describes missing confirmation and safe resending", () => {
  const strings = JSON.parse(readFileSync(`${import.meta.dir}/strings/en.json`, "utf8"));
  expect(strings["chat.sendFailed"]).toMatch(/not confirmed/i);
  expect(strings["chat.sendFailed"]).toMatch(/again.*(?:won.t|will not).*twice/i);
});

for (const ok of [true, false]) test(`new typing survives a ${ok ? "successful" : "failed"} request`, async () => {
  let resolve!: (r: Response) => void;
  const h = harness(() => new Promise(r => resolve = r));
  const pending = h.send();
  h.inputEl.value = "next draft";
  h.stored.set("draft", "next draft");
  resolve(Response.json({ ok, id: "sent" }));
  await pending;
  expect(h.inputEl.value).toBe("next draft");
  expect(h.stored.get("draft")).toBe("next draft");
});

for (const offline of [true, false]) test(`a refused image restores its caption (${offline ? "offline" : "HTTP"})`, async () => {
  const h = harness(() => offline ? Promise.reject(new Error("offline")) : new Response("refused", { status: 415 }), [new File(["bytes"], "picture.png")]);
  await h.send();
  expect(h.inputEl.value).toBe("draft");
  expect(h.stored.get("draft")).toBe("draft");
});
