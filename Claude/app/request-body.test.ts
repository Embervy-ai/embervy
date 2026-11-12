import { expect, test } from "bun:test";
import { boundedRequest, REQUEST_BODY_MAX } from "./request-body";

test("ordinary requests are bounded before parsing, with and without Content-Length", async () => {
  for (const declared of [false, true]) {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled = true; },
    });
    const req = new Request("https://app.test/api/auth", { method: "POST", body,
      headers: declared ? { "content-length": String(64 * 1024 * 1024) } : {} });
    const res = await boundedRequest(req);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(413);
    expect(reads).toBeLessThanOrEqual(18);
    expect(cancelled).toBe(true);
  }
});

test("the default boundary and explicit upload allowance preserve accepted bytes", async () => {
  for (const size of [REQUEST_BODY_MAX, REQUEST_BODY_MAX + 20]) {
    const req = new Request("https://app.test/api/image", { method: "POST", body: "x".repeat(size) });
    const res = await boundedRequest(req, size);
    expect(res).toBeInstanceOf(Request);
    expect(await (res as Request).text()).toBe("x".repeat(size));
  }
});
