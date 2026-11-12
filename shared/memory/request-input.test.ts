import { expect, test } from "bun:test";
import { boundedBody, invalidIntegerQuery } from "./src/request-input";
import worker, { TRANSCRIBE_MAX_BYTES } from "./src/index";

for (const length of [undefined, "1", "5"]) {
  test(`bounded body enforces actual bytes with length ${length}`, async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(3)); },
      cancel() { cancelled = true; },
    });
    const request = new Request("https://memory.test/upload", { method: "POST", headers: length ? { "Content-Length": length } : {}, body });
    const result = await boundedBody(request, 4);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
    expect(cancelled).toBe(true);
  });
}

test("bounded body accepts the exact limit and rejects malformed lengths and broken streams", async () => {
  const request = new Request("https://memory.test/upload", { method: "POST", body: new Uint8Array([1, 2, 3, 4]) });
  expect(await boundedBody(request, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  for (const length of ["-1", "NaN", "Infinity", "1.5"]) {
    const result = await boundedBody(new Request(request.url, { method: "POST", headers: { "Content-Length": length } }), 4);
    expect((result as Response).status).toBe(400);
  }
  const result = await boundedBody(new Request(request.url, { method: "POST", body: new ReadableStream({ start(c) { c.error(new Error("private")); } }) }), 4);
  expect((result as Response).status).toBe(400);
  expect(await (result as Response).text()).not.toContain("private");
});

test("bounded body handles tiny chunks and growth without changing bytes", async () => {
  let count = 0;
  const request = new Request("https://memory.test/upload", { method: "POST", body: new ReadableStream<Uint8Array>({
    pull(c) {
      if (count === 70000) { c.close(); return; }
      c.enqueue(new Uint8Array([count++ % 256]));
    },
  }) });
  const bytes = await boundedBody(request, 70000);
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect((bytes as Uint8Array).length).toBe(70000);
  for (const index of [0, 1, 255, 256, 65535, 65536, 69999]) expect((bytes as Uint8Array)[index]).toBe(index % 256);
});

test("numeric validation includes duplicate values and safe integer boundaries", () => {
  const fields = [["offset", 0, Number.MAX_SAFE_INTEGER]] as const;
  expect(invalidIntegerQuery(new URL("https://test/?offset=9007199254740991"), fields)).toBeNull();
  expect(invalidIntegerQuery(new URL("https://test/?offset=0&offset=1e400"), fields)).toBe("offset");
});

for (const path of ["/due?until=1e400", "/due?limit=51", "/due?limit=-1", "/events?days=0.5", "/events?limit=1e400", "/events?days=366"]) {
  test(`memory numeric queries reject invalid input before D1: ${path}`, async () => {
    const result = await worker.fetch(new Request("https://memory.test" + path, { headers: { Authorization: "Bearer test" } }), { EMBERVY_API_KEY: "test" } as any);
    expect(result.status).toBe(400);
  });
}

test("transcribe caps an undeclared stream before calling AI", async () => {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) {
    c.enqueue(new Uint8Array(1024 * 1024));
    sent += 1024 * 1024;
    if (sent > TRANSCRIBE_MAX_BYTES) c.close();
  } });
  const response = await worker.fetch(new Request("https://memory.test/transcribe", { method: "POST", headers: { Authorization: "Bearer test" }, body }), { EMBERVY_API_KEY: "test" } as any);
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "recording too large" });
});
