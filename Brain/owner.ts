/**
 * owner.ts — the house seam for "is this process mine?".
 *
 * Several houses can share one server. A process belongs to this house if
 * its systemd unit names this house's folder, or, outside systemd, if it
 * runs under that folder. The product's runtime module
 * (shared/scripts/house-runtime.ts, next to Brain/) decides that. Without
 * that module next to Brain, Brain runs alone and every process counts as
 * its own.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const SCRIPTS = join(import.meta.dir, "..", "shared", "scripts");

function load<T>(file: string, name: string): T | null {
  const path = join(SCRIPTS, file);
  if (!existsSync(path)) return null;
  try {
    const value = require(path)[name];
    return typeof value === "function" ? value : null;
  } catch {
    return null;
  }
}

const ownsProcess = load<(pid: number, home: string) => boolean>("house-runtime.ts", "ownsProcess");
const envValue = load<(key: string) => string | undefined>("legacy-names.ts", "envValue");

export function ownsHousePid(pid: number): boolean {
  if (!ownsProcess) return true;
  const home = envValue?.("EMBERVY_HOME") || process.env.EMBERVY_HOME || process.env.BRAIN_HOME || import.meta.dir;
  return ownsProcess(pid, home);
}
