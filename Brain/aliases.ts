/**
 * aliases.ts — other names for Brain's settings and stored values.
 *
 * Brain asks this module whether a setting has an older name, how a value an
 * older build stored reads today, which history lines an older build marked
 * as system lines, which background work is a timer besides Brain's own
 * words, and which tags keep an unanswered app turn quiet besides "[still]".
 * Stored values read as stored and the lists are empty. Settings: a house
 * installed before the product's rename may still name them the old way; the
 * product's transition module (shared/scripts/legacy-names.ts, next to Brain/)
 * copies those to today's names while today's are unset. Without that module
 * next to Brain nothing is copied.
 *
 * The shape of AliasSeam is what brain.ts and wake-bridge.ts call; keep it.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

type Env = Record<string, string | undefined>;

const TRANSITION = join(import.meta.dir, "..", "shared", "scripts", "legacy-names.ts");
const adoptLegacyEnv: ((env: Env) => void) | null = (() => {
  if (!existsSync(TRANSITION)) return null;
  try {
    const adopt = require(TRANSITION).adoptLegacyEnv;
    return typeof adopt === "function" ? adopt : null;
  } catch {
    return null;
  }
})();

/** Which stored field a value comes from. */
export type StoredField = "origin" | "source" | "model";

export interface AliasSeam {
  /** Older setting names: copy a value to its current key while that one is unset. */
  env(target: Env): void;
  /** A value an older build stored, in today's spelling (anything else unchanged). */
  stored(field: StoredField, value: unknown): unknown;
  /** Line starts (case-insensitive) that make a history line a system line. */
  systemTags: readonly string[];
  /** Descriptions of background work that is a timer, besides Brain's own words; null = none. */
  timerLine: RegExp | null;
  /** Tags that keep an unanswered app turn out of the app, besides "[still]". */
  quietTags: readonly string[];
}

export const ALIASES: AliasSeam = {
  env: (target) => { adoptLegacyEnv?.(target); },
  stored: (_field, value) => value,
  systemTags: [],
  timerLine: null,
  quietTags: [],
};
