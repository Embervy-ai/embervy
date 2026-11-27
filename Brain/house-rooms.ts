/**
 * Room names for speaker attribution, read from Brain's environment and the
 * house and app settings files. File caches retain only cleaned names and a
 * URL-presence bit; reading settings does not modify the process environment.
 * The remaining hooks provide no additional foreign sources, tools or channel
 * fields beyond the app's built-in handling.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnvLine } from "../shared/scripts/env-file";

const ROOM_KEYS = ["EMBERVY_ROOM_NAME", "ROOM_NAME", "EMBERVY_ROOMS"] as const;
type RoomKey = typeof ROOM_KEYS[number];
type Names = Partial<Record<RoomKey, string[]>> & { urlConfigured?: boolean };
const cache = new Map<string, { mtime: number; size: number; names: Names }>();
let warned = false;

// Match roomConfig's name cleaning without importing the app. An absent single
// name needs the URL-presence bit before it can imply the app's default name.
function cleanName(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 40) || "Room";
}

function namesFor(key: RoomKey, value: string): string[] {
  if (key !== "EMBERVY_ROOMS") {
    const name = cleanName(value);
    return name ? [name] : [];
  }
  try {
    const list: unknown = JSON.parse(value);
    if (!Array.isArray(list)) return [];
    return list.flatMap(entry => {
      return entry && typeof entry === "object" && !Array.isArray(entry) ? [cleanName(entry.name) ?? "Room"] : [];
    });
  } catch { return []; }
}

// Scan keys before decoding values: unrelated assignments are discarded, never
// parsed, retained as strings, cached or logged. Only a small I/O buffer sees
// their bytes. No shell evaluation or environment mutation takes place.
function readRoomNames(file: string): Names {
  const names: Names = {};
  const fd = openSync(file, "r");
  const buffer = Buffer.alloc(4096);
  let prefix = "", selected: RoomKey | undefined, value: number[] = [], skip = false;
  // The fourth key is scanned byte by byte into a bit, never decoded or kept as
  // a value. Quotes, blanks and comments alone do not configure a room.
  let url = false, present = false, quote = 0, escaped = false, start = true, blank = false;
  const finish = () => {
    if (url) names.urlConfigured = present;
    if (selected) {
      const assignment = parseEnvLine(`${selected}=${Buffer.from(value).toString("utf8")}`);
      if (assignment && "value" in assignment) names[selected] = namesFor(selected, assignment.value);
    }
    prefix = "";
    selected = undefined;
    value = [];
    skip = false;
    url = present = escaped = blank = false;
    quote = 0;
    start = true;
  };
  try {
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      for (let i = 0; i < count; i++) {
        const byte = buffer[i];
        if (byte === 10) { finish(); continue; }
        if (skip) continue;
        if (url) {
          const whitespace = byte === 9 || byte === 13 || byte === 32 || byte === 11 || byte === 12;
          if (escaped) { present ||= !whitespace; escaped = false; continue; }
          if (quote) {
            if (byte === quote) { quote = 0; blank = false; }
            else if (byte === 92 && quote === 34) escaped = true;
            else present ||= !whitespace;
          } else if (byte === 13 || (byte === 35 && blank)) {
            skip = true;
          } else if (whitespace) {
            blank = true;
          } else {
            blank = false;
            if (start && (byte === 34 || byte === 39)) quote = byte;
            else { start = false; if (byte === 92) escaped = true; else present = true; }
          }
          continue;
        }
        if (selected) { value.push(byte); continue; }
        if (byte === 61) {
          const key = prefix.replace(/^[ \t]*(?:export[ \t]+)?/, "").trimEnd();
          if (ROOM_KEYS.includes(key as RoomKey)) selected = key as RoomKey;
          else if (key === "EMBERVY_ROOM_URL") url = true;
          else skip = true;
          prefix = "";
        } else if (prefix.length < 128 && (byte === 9 || byte === 32 || byte === 95 || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) {
          prefix += String.fromCharCode(byte);
        } else {
          skip = true;
          prefix = "";
        }
      }
    }
    finish();
    return names;
  } finally {
    buffer.fill(0);
    closeSync(fd);
  }
}

function fileRoomNames(file: string, warnUnavailable: boolean): Names {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) throw new Error("not a regular file");
    const cached = cache.get(file);
    if (cached?.mtime === stat.mtimeMs && cached.size === stat.size) return cached.names;
    const names = readRoomNames(file);
    cache.set(file, { mtime: stat.mtimeMs, size: stat.size, names });
    return names;
  } catch (error) {
    cache.delete(file);
    if (warnUnavailable && !warned) {
      warned = true;
      const kind = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
      console.warn(`Brain: house room settings unavailable (${kind}).`);
    }
    return {};
  }
}

// Brain loads brain.env, not the house environment. At call time, explicit
// environment values win per key (including empty values); missing keys fall
// back to the house .env, then Claude/app/.env. Like house-check.ts, resolve the
// installation from EMBERVY_HOME or Brain's parent directory. Cache only names
// and the URL-presence bit independently by each file's stamp. Cross-language
// and app parity are covered by the room tests.
export function houseRoomNames(env: Record<string, string | undefined> = process.env): Set<string> {
  const home = env.EMBERVY_HOME?.trim() || resolve(import.meta.dir, "..");
  const needsFiles = ROOM_KEYS.some(key => env[key] === undefined) || env.EMBERVY_ROOM_URL === undefined;
  const house: Names = needsFiles ? fileRoomNames(join(home, ".env"), true) : {};
  const app: Names = needsFiles ? fileRoomNames(join(home, "Claude/app/.env"), false) : {};
  const names = (key: RoomKey) => env[key] === undefined ? house[key] ?? app[key] ?? [] : namesFor(key, env[key]!);
  const single = names("EMBERVY_ROOM_NAME");
  const configured = env.EMBERVY_ROOM_URL === undefined
    ? house.urlConfigured ?? app.urlConfigured : /\S/.test(env.EMBERVY_ROOM_URL);
  // EMBERVY_ROOMS is decoded and parsed as a whole, including connection fields,
  // but only cleaned names are retained. URLs and tokens are not validated.
  // Knowing an extra room name is the safe direction: foreign speech must not
  // be attributed to the person.
  return new Set([...(single.length || !configured ? single : ["Room"]), ...names("ROOM_NAME"), ...names("EMBERVY_ROOMS")]);
}

type Entry = { source?: unknown };

export function houseForeignSource(_entry: Entry): boolean {
  return false;
}

export function houseRoomTool(_tool: string): boolean {
  return false;
}

export function houseRoomSpeech(_tool: string, _input: { text: string; action?: unknown }): string | null | undefined {
  return undefined;
}

export function houseChannelWho(_entry: Entry): Array<[string, string]> | null {
  return null;
}
