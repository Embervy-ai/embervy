import { afterEach, describe, expect, test } from "bun:test";
import worker from "./src/index";

// POST /dream's bearer check compares in constant time. No network: the model
// call is answered by a stub, the RAG binding is a fake.

const TOKEN = "dream-test-token-0123456789";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const env = (extra: Record<string, unknown> = {}) => ({
  RAG: { fetch: async () => new Response("{}", { status: 503 }) },
  OPENROUTER_API_KEY: "not-a-key",
  ...extra,
});
const dream = (auth: string | null, e: Record<string, unknown>) =>
  worker.fetch(new Request("https://dream.example/dream", {
    method: "POST",
    headers: auth === null ? {} : { Authorization: auth },
  }), e as any);

describe("dream-worker bearer door", () => {
  test("missing, prefix, longer and wrong tokens get 401 unauthorized", async () => {
    for (const auth of [null, "", `Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}x`, "Bearer wrong", TOKEN]) {
      const res = await dream(auth, env({ DREAM_AUTH_TOKEN: TOKEN }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });

  test("no DREAM_AUTH_TOKEN configured: 503, as before", async () => {
    expect((await dream(`Bearer ${TOKEN}`, env())).status).toBe(503);
  });

  test("the right token passes the door", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input instanceof Request ? input.url : input));
      return new Response("stubbed", { status: 500 });
    }) as typeof fetch;
    const res = await dream(`Bearer ${TOKEN}`, env({ DREAM_AUTH_TOKEN: TOKEN }));
    expect(res.status).toBe(502); // past the gate, stopped by the stubbed model call
    expect(calls).toHaveLength(1);
  });
});
