import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (name: string) => readFileSync(join(import.meta.dir, name), "utf8");
const app = read("public/app.js");
const settings = read("public/settings.js");
const html = read("public/settings.html");
const strings = JSON.parse(read("strings/en.json"));

const voiceSource = app.slice(app.indexOf("  function voiceSettings()"), app.indexOf("  const SpeechRecognitionAPI"));
function voiceSettings(stored: unknown, appLanguage = "en") {
  const localStorage = { getItem: () => (stored === undefined ? null : JSON.stringify(stored)) };
  const make = new Function("localStorage", "I18N", `${voiceSource}; return voiceSettings;`);
  return make(localStorage, { language: appLanguage })();
}

const fillSource = settings.slice(settings.indexOf("const SPEECH_LANGUAGES"), settings.indexOf("const DEFAULTS ="));
function fill(chosen: string, appLanguage = "en") {
  const options: { value: string; textContent: string }[] = [];
  const select = { value: "", appendChild: (o: { value: string; textContent: string }) => options.push(o) };
  const window = { embervyI18n: { language: appLanguage } };
  const document = { createElement: () => ({ value: "", textContent: "" }) };
  new Function("window", "document", `${fillSource}; return fillSpeechLanguages;`)(window, document)(select, chosen);
  return { options, value: select.value };
}

test("voice input follows the app until a language is chosen; sending at once is the default", () => {
  expect(voiceSettings(undefined, "en")).toEqual({ lang: "en", sendAtOnce: true, whisper: true });
  expect(voiceSettings({ speechLang: "" }, "fr")).toEqual({ lang: "fr", sendAtOnce: true, whisper: true });
  expect(voiceSettings({ speechLang: "de", speechSend: false }, "en")).toEqual({ lang: "de", sendAtOnce: false, whisper: true });
  expect(voiceSettings({ features: { whisper: false } }, "en").whisper).toBe(false);
  expect(voiceSettings({ speechLang: 7 }, "en").lang).toBe("en");
});

test("the language list is named in the app's language and keeps a chosen tag", () => {
  const english = fill("de", "en");
  expect(english.value).toBe("de");
  expect(english.options.find((o) => o.value === "de")!.textContent).toBe("German");
  const names = english.options.map((o) => o.textContent);
  expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
  expect(fill("", "en").value).toBe("");
  const other = fill("is", "en");
  expect(other.options.some((o) => o.value === "is")).toBe(true);
  expect(other.value).toBe("is");
});

test("the settings page offers both voice choices with English texts", () => {
  for (const id of ['id="speech-lang"', 'id="speech-send"', 'id="feature-whisper"']) expect(html).toContain(id);
  for (const key of ["settings.voice.whisper", "settings.voice.whisperNote", "settings.voice.language", "settings.voice.sameAsApp", "settings.voice.sendAtOnce"]) {
    expect(strings[key]).toBeTruthy();
    expect(html).toContain(`data-i18n="${key}"`);
  }
  expect(settings).toContain('speechLang: $("speech-lang").value');
  expect(settings).toContain('speechSend: $("speech-send").checked');
  expect(settings).toContain('whisper: $("feature-whisper").checked');
  expect(settings).toMatch(/features: \{[^}]*whisper: true/);
  // The cost stands where the choice is made, in figures.
  expect(strings["settings.voice.whisperNote"]).toContain("free plan it never costs anything");
  expect(strings["settings.voice.whisperNote"]).toContain("$0.0005 per minute");
});

test("dictation reads the choice each time the microphone starts", () => {
  const start = app.slice(app.indexOf("  async function startVoice()"), app.indexOf("  function stopVoice()"));
  expect(start.indexOf("recLang = voiceSettings().lang")).toBeGreaterThan(-1);
  expect(start.indexOf("recLang = voiceSettings().lang")).toBeLessThan(start.indexOf("recognition.start()"));
  expect(start).toContain("recognition.lang = recLang");
  const finish = app.slice(app.indexOf("  function finishSpeech()"), app.indexOf("  if (SpeechRecognitionAPI) {"));
  expect(finish.indexOf("sendAtOnce")).toBeGreaterThan(-1);
  expect(finish.indexOf("sendAtOnce")).toBeLessThan(finish.indexOf("sendMessage()"));
});
