// Translates built-in messages and app notices.
// Read configuration lazily because environment loading follows module imports.
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { GERMAN } from "./texts-de";

export const FRESH_ZONE_INTRO = "The last steps before the cut, with tools and results; only what was read is shortened. They are there to carry on the work; nothing here needs an answer.";

export type BrainLanguage = "en" | "de";
export function brainLanguage(env: Record<string, string | undefined> = process.env): BrainLanguage {
  return env.BRAIN_LANG?.trim().toLowerCase() === "de" ? "de" : "en";
}
const ENGLISH_IDS: Record<string, string> = {
  "decimal.point": ".",
  "loop.clean": "clean exit (cut or /exit)", "loop.guard": "guard: lock or parallel head", "loop.crash": "crash (rc={0})",
  "loop.restart": "Brain restarted. Reason: {0}. Head: {1}.",
  "loop.guard_refused": "{0} cannot start: {1}. Trying again every minute; your messages wait.",
  "watch.cut": "Cut starting: {0}% window. Bridge + RAG + restart, about a minute.",
  "watch.notice": "Window at {0}%. Cut at {1} tokens.",
  "watch.warning": "⚠️ Window at {0}% of the cut threshold ({1} tokens, cut at {2}).\n\nThe cut happens automatically — bridge and archive, restart, and the next session\nuploads the archive. Unless the fresh zone is off, your last steps ride along in\nthe bridge. Anything that should outlast the bridge: write it to your Lore.\n",
};
export const de: Record<string, string> = { ...GERMAN };
export const en: Record<string, string> = { ...ENGLISH_IDS, ...Object.fromEntries(Object.keys(de).map((key) => [key, ENGLISH_IDS[key] ?? key])) };

export function localStringsPath(env: Record<string, string | undefined> = process.env): string {
  return env.BRAIN_STRINGS_FILE?.trim() || join(dirname(import.meta.dir), "Claude", "app", "strings.local.json");
}
interface LocalStrings { table: Record<string, string>; language?: string }
export const APP_NOTICE_KEYS: ReadonlySet<string> = new Set([
  "watch.cut", "watch.notice", "loop.restart", "loop.guard_refused",
  "⚠️ Model fallback: last turn ran on {0} instead of {1}.",
  "[Brain] Skipped {0} older backlog messages; delivering the last {1}.",
  "[Brain] The command failed: {0}",
  "[Brain] Your agent is here; only its Claude sign-in has expired. Your message is kept. Tap “Sign in again” in the app.",
  "[Brain] The Claude sign-in works again. Your kept message is on its way.",
  "[Brain] Your message arrived but got no answer: the limit is reached, free again at {0}. Please send it again after that.",
  "[Brain] Your message arrived but got no answer: the head stopped with an error ({0}). Please send it again; /status shows more.",
]);
// Other programs parse these prefixes, so translations must preserve them.
export const PROTOCOL_PREFIXES = ["SENSE ·", "[Brain]"] as const;
let localCache: (LocalStrings & { path: string; mtimeMs: number; checkedAt: number }) | undefined;
export function localStrings(env: Record<string, string | undefined> = process.env): LocalStrings {
  const path = localStringsPath(env);
  const now = Date.now();
  if (localCache && localCache.path === path && now - localCache.checkedAt < 5000) return localCache;
  let mtimeMs = -1;
  try { mtimeMs = statSync(path).mtimeMs; } catch { /* no file: nothing local */ }
  if (localCache && localCache.path === path && localCache.mtimeMs === mtimeMs) { localCache.checkedAt = now; return localCache; }
  const table: Record<string, string> = {};
  let language: string | undefined;
  if (mtimeMs >= 0) {
    try {
      const json = JSON.parse(readFileSync(path, "utf8"));
      const brain = json?.brain;
      if (brain && typeof brain === "object" && !Array.isArray(brain)) {
        for (const [key, value] of Object.entries(brain)) {
          if (typeof value !== "string" || !value.trim() || !APP_NOTICE_KEYS.has(key)) continue;
          if (PROTOCOL_PREFIXES.some((p) => key.startsWith(p) && !value.startsWith(p))) continue;
          table[key] = value;
        }
      }
      if (typeof json?.language === "string") {
        try { language = Intl.getCanonicalLocales(json.language.trim())[0]; } catch { /* not a language tag */ }
      }
    } catch { /* broken file: nothing local */ }
  }
  localCache = { path, mtimeMs, checkedAt: now, table, language };
  return localCache;
}
export function resetLocalStringsCache(): void { localCache = undefined; }

export function brainLocale(): string { return brainLanguage() === "de" ? "de-DE" : localStrings().language ?? "en-US"; }
export function registerTexts(german: Record<string, string>, english: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries(german)) { de[key] = value; en[key] = english[key] ?? key; }
}
export function tr(message: string | TemplateStringsArray, ...values: unknown[]): string {
  const key = typeof message === "string" ? message : message.reduce((s, part, i) => s + (i ? `{${i - 1}}` : "") + part, "");
  const local = own(localStrings().table, key);
  return local !== undefined ? fill(local, values) : textForLanguage(brainLanguage(), key, ...values);
}
const own = (table: Record<string, string>, key: string): string | undefined => Object.hasOwn(table, key) ? table[key] : undefined;
const fill = (template: string, values: unknown[]) =>
  template.replace(/\{(\d+)\}/g, (match, index) => Number(index) < values.length ? String(values[Number(index)]) : match);
export function textForLanguage(language: BrainLanguage | "local", key: string, ...values: unknown[]): string {
  const template = language === "local" ? own(localStrings().table, key) ?? own(en, key) ?? key : language === "de" ? own(de, key) ?? own(en, key) ?? key : own(en, key) ?? key;
  return fill(template, values);
}

if (import.meta.main && process.argv[2] === "--app-notices") {
  process.stdout.write(JSON.stringify(Object.fromEntries([...APP_NOTICE_KEYS].map((key) => [key, en[key] ?? key])), null, 2) + "\n");
} else if (import.meta.main) process.stdout.write(process.argv[2] === "--catalog"
  ? JSON.stringify({ ...en, ...(brainLanguage() === "de" ? de : {}), ...localStrings().table })
  : tr(process.argv[2] ?? "", ...process.argv.slice(3)));
