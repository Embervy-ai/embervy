// Loads app translations with local overrides and English fallbacks.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { envValue } from "../../shared/scripts/legacy-names";

export type StringTable = Record<string, string>;
export type Vars = Record<string, string | number>;

export interface Strings {
  language: string;
  strings: StringTable;
  overridden: string[];
  sections: string[];
  warnings: string[];
}

export const DEFAULT_LANGUAGE = "en";

export const SECTIONS: Readonly<Record<string, string>> = {
  brain: "Brain's messages, read by Brain/texts.ts (the keys: bun Brain/texts.ts --catalog)",
  timeWords: "the time channel's words, read by Claude/scripts/inlet-temporal.ts (check: bun Claude/scripts/inlet-temporal.ts --check)",
};
export const APP_DIR = import.meta.dir;
export const EN_PATH = join(APP_DIR, "strings", "en.json");
export const LOCAL_PATH = envValue("EMBERVY_STRINGS_LOCAL") || join(APP_DIR, "strings.local.json");

const own = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

export function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? null;
  } catch {
    return null;
  }
}

export function mergeStrings(en: unknown, local: unknown): Strings {
  const warnings: string[] = [];
  const strings: StringTable = {};
  let language = DEFAULT_LANGUAGE;

  if (isPlainObject(en)) {
    for (const [key, value] of Object.entries(en)) {
      if (key === "language") language = normalizeLanguage(value) ?? DEFAULT_LANGUAGE;
      else if (!key.startsWith("_") && typeof value === "string") strings[key] = value;
    }
  } else {
    warnings.push("strings/en.json is missing or not a JSON object — the app shows raw text keys");
  }

  const overridden: string[] = [];
  const sections: string[] = [];
  if (local !== undefined && local !== null) {
    if (!isPlainObject(local)) {
      warnings.push("strings.local.json must be a JSON object ({ \"key\": \"text\", … }) — ignored");
    } else {
      for (const [key, value] of Object.entries(local)) {
        if (key === "language") {
          const tag = normalizeLanguage(value);
          if (tag) language = tag;
          else warnings.push(`"language": ${JSON.stringify(value)} is not a valid language tag (use e.g. "fr", "de", "en-GB") — kept "${language}"`);
        } else if (key.startsWith("_")) {
          continue;
        } else if (own(SECTIONS, key)) {
          if (isPlainObject(value)) sections.push(key);
          else warnings.push(`"${key}" must be an object (${SECTIONS[key]}) — ignored`);
        } else if (!own(strings, key)) {
          warnings.push(`unknown key "${key}" — not in strings/en.json (typo, or renamed by an update?), skipped`);
        } else if (typeof value !== "string") {
          warnings.push(`"${key}" must be a string, got ${Array.isArray(value) ? "array" : typeof value} — kept English`);
        } else {
          const missing = [...placeholders(strings[key])].filter((p) => !placeholders(value).has(p));
          if (missing.length) {
            warnings.push(`"${key}" drops ${missing.map((p) => `{${p}}`).join(", ")} — that value will not appear`);
          }
          strings[key] = value;
          overridden.push(key);
        }
      }
    }
  }

  return { language, strings, overridden, sections, warnings };
}

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) => (own(vars, name) ? String(vars[name]) : match));
}

export function t(table: StringTable, key: string, vars?: Vars): string {
  return interpolate(own(table, key) ? table[key] : key, vars);
}

function stamp(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "absent";
  }
}

function readJson(path: string, label: string, warnings: string[]): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    warnings.push(`${label} is not valid JSON (${err instanceof Error ? err.message : String(err)}) — ignored, English stays`);
    return undefined;
  }
}

const cache = new Map<string, { stamp: string; value: Strings }>();

export function loadStrings(enPath = EN_PATH, localPath = LOCAL_PATH, log = true): Strings {
  const cacheKey = `${enPath}\u0000${localPath}`;
  const current = `${stamp(enPath)}|${stamp(localPath)}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.stamp === current) return hit.value;

  const readWarnings: string[] = [];
  const en = readJson(enPath, "strings/en.json", readWarnings);
  const local = readJson(localPath, "strings.local.json", readWarnings);
  const merged = mergeStrings(en, local);
  const value = { ...merged, warnings: [...readWarnings, ...merged.warnings] };
  if (log) for (const w of value.warnings) process.stderr.write(`embervy-app: strings: ${w}\n`);
  cache.set(cacheKey, { stamp: current, value });
  return value;
}

// The fingerprint changes the script URL so caches cannot serve an older translation table.
export function stringsVersion(s: Strings): string {
  const data = JSON.stringify({ language: s.language, strings: s.strings });
  return createHash("sha256").update(data).digest("hex").slice(0, 12);
}

export const CLIENT_FILES = ["index.html", "settings.html", "app.js", "settings.js", "i18n.js", "legacy-names.js", "games.js", "style.css"] as const;

export function clientFilesFingerprint(dir: string): string {
  const hash = createHash("sha256");
  for (const f of CLIENT_FILES) {
    hash.update(`${f}\0`);
    try { hash.update(readFileSync(join(dir, f))); } catch { hash.update("-"); }
  }
  return hash.digest("hex");
}

// Phones can restore stale pages from memory; include client files so resuming the app detects updates.
export function pageVersion(s: Strings, publicDir: string): string {
  return createHash("sha256").update(`${stringsVersion(s)}:${clientFilesFingerprint(publicDir)}`).digest("hex").slice(0, 12);
}

export function clientScript(s: Strings, version: string = stringsVersion(s)): string {
  const data = JSON.stringify({ language: s.language, strings: s.strings, version });
  return `window.EMBERVY_STRINGS=${data};document.documentElement.lang=${JSON.stringify(s.language)};\n`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function checkReport(enPath = EN_PATH, localPath = LOCAL_PATH): { text: string; ok: boolean } {
  const s = loadStrings(enPath, localPath, false);
  const total = Object.keys(s.strings).length;
  const lines = [
    `language: ${s.language}`,
    `strings.local.json: ${existsSync(localPath) ? localPath : `not present (${localPath}) — the app is in English`}`,
    `overridden: ${s.overridden.length} of ${total} texts`,
  ];
  const english = Object.keys(s.strings).filter((k) => !s.overridden.includes(k));
  if (existsSync(localPath) && english.length) {
    lines.push(`still English (${english.length}):`, ...english.map((k) => `  ${k} = ${JSON.stringify(s.strings[k])}`));
  }
  if (s.sections.length) lines.push(`sections for other readers: ${s.sections.map((k) => `"${k}" — ${SECTIONS[k]}`).join("; ")}`);
  if (s.warnings.length) lines.push(`problems (${s.warnings.length}):`, ...s.warnings.map((w) => `  ${w}`));
  else lines.push("problems: none");
  return { text: lines.join("\n"), ok: s.warnings.length === 0 };
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const { text, ok } = checkReport();
    console.log(text);
    process.exit(ok ? 0 : 1);
  }
  console.log("usage: bun strings.ts --check   (reports what strings.local.json changes, what is still English, what was skipped)");
}
