import { expect, test } from "bun:test";
import { headChoices, pipeUnsetEnv, resolveHead } from "./heads";

test("only Kimi's missing key offers typed key setup; no credential is projected", () => {
  const missing = headChoices({});
  expect(missing.filter(h => h.setup === "key").map(h => h.name)).toEqual(["kimi"]);
  expect(resolveHead("kimi", {}).unavailableReason).toBe("missing-key");
  for (const variable of ["KIMI_CODE_KEY", "BRAIN_KIMI_API_KEY"]) {
    const key = "NOT-A-REAL-BRAIN-KEY-SENTINEL";
    const choices = headChoices({ [variable]: key });
    const kimi = choices.find(h => h.name === "kimi")!;
    expect(kimi.available).toBe(true);
    expect(kimi.setup).toBeUndefined();
    expect(JSON.stringify(choices).includes(key)).toBe(false);
  }
  expect(headChoices({ KIMI_CODE_KEY: " \t " }).find(h => h.name === "kimi")!.setup).toBe("key");
});

test("setup hiding is comma-separated presentation metadata, not availability", () => {
  for (const key of [undefined, "not-a-real-key"]) {
    const choices = headChoices({ BRAIN_HEAD_SETUP_HIDE: "unknown, kimi, gpt", KIMI_CODE_KEY: key });
    const kimi = choices.find(h => h.name === "kimi")!;
    expect(kimi.setupHidden).toBe(true);
    expect(kimi.available).toBe(Boolean(key));
    expect(kimi.setup).toBe(key ? undefined : "key");
    expect(choices.find(h => h.name === "gpt")!.setupHidden).toBe(true);
    expect(choices.some(h => h.name === "unknown")).toBe(false);
  }
  expect(headChoices({ BRAIN_HEAD_SETUP_HIDE: "unknown" }).find(h => h.name === "kimi")!.setupHidden).toBeUndefined();
});

test("Kimi is the Anthropic-compatible coding pipe, not the OpenAI API transport", () => {
  const head = resolveHead("kimi", { KIMI_CODE_KEY: "not-a-real-key" });
  expect(head.transport).toBe("pipe");
  expect(head.endpoint).toBe("https://api.kimi.com/coding");
  expect(head.model).toBe("kimi-for-coding");
  expect(head.contextWindow).toBe(1_048_576);
  expect(head.pipeEnv.ANTHROPIC_BASE_URL).toBe(head.endpoint);
  expect(head.pipeEnv.ANTHROPIC_AUTH_TOKEN === head.apiKey).toBe(true);
  expect(pipeUnsetEnv(head)).toContain("ANTHROPIC_API_KEY");
});
