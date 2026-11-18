import { afterEach, expect, test } from "bun:test";
import { processDream } from "./src/index";

// A provider retires models. The dream asks for the configured model, or for the default.

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setup(extra: Record<string, string> = {}) {
  const asked: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    asked.push(JSON.parse(String(init?.body)).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "a quiet note" } }] }), { status: 200 });
  }) as typeof fetch;
  const env: any = {
    OPENROUTER_API_KEY: "not-a-key",
    RAG: { fetch: async () => new Response(JSON.stringify({ results: [] })) },
    DB: { prepare: () => ({ run: async () => ({}), bind: () => ({ run: async () => ({}) }) }) },
    ...extra,
  };
  return { env, asked, pause: async () => {} };
}

test("without a setting the dream asks for the default model", async () => {
  const s = setup();
  await processDream(s.env, s.pause);
  expect(s.asked).toEqual(["mistralai/mistral-medium-3-5"]);
});

test("DREAM_LLM_MODEL replaces the default; blanks around it are ignored", async () => {
  const s = setup({ DREAM_LLM_MODEL: "  example/other-model " });
  await processDream(s.env, s.pause);
  expect(s.asked).toEqual(["example/other-model"]);
});

test("an empty DREAM_LLM_MODEL falls back to the default", async () => {
  const s = setup({ DREAM_LLM_MODEL: "   " });
  await processDream(s.env, s.pause);
  expect(s.asked).toEqual(["mistralai/mistral-medium-3-5"]);
});
