import { describe, expect, test } from "bun:test";
import worker, { TRANSCRIBE_MAX_BYTES, WHISPER_MODEL, transcribeAudio, whisperLanguage } from "./src/index";

// Voice input: the app's recording goes to Whisper on Workers AI. No network:
// the AI binding is a stub that records what it was asked.

function stubAi(answer: () => unknown) {
  const calls: Array<{ model: string; input: any }> = [];
  return {
    calls,
    ai: { run: async (model: string, input: unknown) => { calls.push({ model, input }); return answer(); } },
  };
}

describe("transcribe", () => {
  test("language hint is the primary subtag, anything else is no hint", () => {
    expect(whisperLanguage("de-DE")).toBe("de");
    expect(whisperLanguage("en_GB")).toBe("en");
    expect(whisperLanguage("pt-BR")).toBe("pt");
    expect(whisperLanguage("")).toBeUndefined();
    expect(whisperLanguage("de;drop")).toBeUndefined();
    expect(whisperLanguage(undefined)).toBeUndefined();
  });

  test("sends the bytes as base64 with the voice filter and the hint; returns the trimmed text", async () => {
    const { calls, ai } = stubAi(() => ({ text: "  Hello, how are you?  ", word_count: 5 }));
    const out = await transcribeAudio(ai, new Uint8Array([1, 2, 3]), "de-DE");
    expect(out).toEqual({ text: "Hello, how are you?" });
    expect(calls[0]!.model).toBe(WHISPER_MODEL);
    expect(calls[0]!.input).toEqual({ audio: btoa(String.fromCharCode(1, 2, 3)), vad_filter: true, language: "de" });
  });

  test("empty, too large and failing recordings are named, Whisper is not asked for nothing", async () => {
    const { calls, ai } = stubAi(() => { throw new Error("model busy"); });
    expect(await transcribeAudio(ai, new Uint8Array(), "de")).toEqual({ error: "empty recording", status: 400 });
    expect(await transcribeAudio(ai, new Uint8Array(TRANSCRIBE_MAX_BYTES + 1), "de")).toEqual({ error: "recording too large", status: 413 });
    expect(calls.length).toBe(0);
    const failed = await transcribeAudio(ai, new Uint8Array([1]), undefined);
    expect("error" in failed && failed.status).toBe(502);
    expect("error" in failed && failed.error).toBe("whisper failed");
  });

  test("the route needs the house key and passes the language on", async () => {
    const { calls, ai } = stubAi(() => ({ text: "ok" }));
    const env = { EMBERVY_API_KEY: "key", AI: ai } as any;
    const open = await worker.fetch(new Request("https://m.test/transcribe", { method: "POST", body: new Uint8Array([9]) }), env);
    expect(open.status).toBe(401);
    const res = await worker.fetch(new Request("https://m.test/transcribe?language=fr-FR", {
      method: "POST", headers: { Authorization: "Bearer key", "Content-Type": "audio/mp4" }, body: new Uint8Array([9, 8]),
    }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "ok" });
    expect(calls[0]!.input.language).toBe("fr");
  });
});
