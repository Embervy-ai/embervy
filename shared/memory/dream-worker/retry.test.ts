import { afterEach, expect, test } from "bun:test";
import { processDream } from "./src/index";

// The model call is answered by a stub; the pause is recorded, not waited.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setup(statuses: number[]) {
  const notes: string[] = [];
  const pauses: number[] = [];
  let calls = 0;
  globalThis.fetch = (async () => {
    const status = statuses[calls++] ?? 200;
    return status === 200
      ? new Response(JSON.stringify({ choices: [{ message: { content: "a quiet note" } }] }), { status })
      : new Response("busy", { status });
  }) as typeof fetch;
  const env: any = {
    OPENROUTER_API_KEY: "not-a-key",
    RAG: { fetch: async () => new Response(JSON.stringify({ results: [] })) },
    DB: { prepare: () => ({ run: async () => ({}), bind: (value: string) => ({ run: async () => { notes.push(value); return {}; } }) }) },
  };
  return { env, notes, pauses, pause: async (ms: number) => { pauses.push(ms); }, get calls() { return calls; } };
}

test("a busy provider is asked again after growing pauses, and the dream is kept", async () => {
  const s = setup([429, 503, 502]);
  const note = await processDream(s.env, s.pause);
  expect(note).toStartWith("a quiet note");
  expect(s.calls).toBe(4);
  expect(s.pauses).toEqual([30_000, 120_000, 300_000]);
  expect(s.notes).toHaveLength(1);
});

test("a provider that stays busy fails after four attempts and writes nothing", async () => {
  const s = setup([504, 504, 504, 504]);
  await expect(processDream(s.env, s.pause)).rejects.toThrow("Dream error: OpenRouter 504");
  expect(s.calls).toBe(4);
  expect(s.notes).toHaveLength(0);
});

test("other errors are not asked again", async () => {
  const s = setup([401]);
  await expect(processDream(s.env, s.pause)).rejects.toThrow("Dream error: OpenRouter 401");
  expect(s.calls).toBe(1);
  expect(s.pauses).toHaveLength(0);
});
