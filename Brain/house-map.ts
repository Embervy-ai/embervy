/**
 * house-map.ts — "Your house": the resident's map of its own code.
 *
 * At every birth (process start after a cut or a respawn) the system
 * prompt gets one block that says where the resident lives: which file does
 * what, which scripts cut and respawn it, where state and logs are, which
 * commands exist. Generated from the files themselves (first doc line of
 * each module/script), so it cannot drift from the code the way a static
 * text does. Deterministic order → the block is byte-stable across births
 * of the same code, which keeps the prompt cache warm.
 */

import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tr } from "./texts";

/** First meaningful line of a file's leading comment block. */
export function firstDocLine(text: string): string {
  const lines = text.split("\n").slice(0, 40);
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#!")) continue;
    const isComment = /^(\/\/|\/\*|\*|#)/.test(trimmed);
    if (!isComment) {
      // TS code starts: the leading comment block (if any) is over.
      if (/^(import\s|export\s+(function|const|class|interface|type|async|default)|const\s|let\s|function\s|class\s)/.test(trimmed)) break;
      continue; // shell preamble (HOME=…, export PATH=…, set -u) — keep looking
    }
    const line = trimmed
      .replace(/^\/\*\*?/, "")
      .replace(/\*\/$/, "")
      .replace(/^\*\s?/, "")
      .replace(/^\/\/\s?/, "")
      .replace(/^#\s?/, "")
      .trim();
    if (!line) continue;
    return line.length > 160 ? `${line.slice(0, 159)}…` : line;
  }
  return "";
}

/** "heads.ts — which head thinks" → "which head thinks" (the list already names the file). */
function withoutOwnName(doc: string, name: string): string {
  const stem = name.replace(/\.(ts|sh)$/, "");
  for (const prefix of [`${name} — `, `${stem} — `]) {
    if (doc.startsWith(prefix)) return doc.slice(prefix.length);
  }
  return doc;
}

export interface HouseMapInput {
  root: string;
  stateDir: string;
  logDir: string;
  head: string;
  model: string;
  commands: string[];
  extra?: string | null;
  capabilities?: string | null;
  userName?: string;
}

/** Missing optional personal map: one reminder across process births.
 * Never substitute a reminder for an unreadable existing file. */
export function houseMapExtra(file: string, stateDir: string): string | null {
  if (!file) return null;
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null; }
  const marker = join(stateDir, "house-map-reminded");
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(marker, `${new Date().toISOString()}\n`, { flag: "wx" });
    return tr`Your own house map is still missing; whenever you are ready: ${file}`;
  } catch { return null; } // already reminded, or cannot persist the reminder
}

export function houseCapabilities(brainDir: string, configuredFile?: string): string | null {
  const file = configuredFile || join(dirname(brainDir), "CAPABILITIES.md");
  const maxBytes = 65536;
  let fd: number | undefined;
  try {
    // Nonblocking open and a bounded read keep a replaced file from hanging birth.
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return "Capabilities unavailable: file unreadable.";
    if (stat.size > maxBytes) return "Capabilities unavailable: file too large.";
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) return "Capabilities unavailable: file too large.";
    return bytes.subarray(0, length).toString("utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "Capabilities unavailable: file unreadable.";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* Optional context must not stop birth. */ } }
  }
}

export function renderHouseMap(input: HouseMapInput): string {
  const entries: string[] = [];
  const collect = (dir: string, prefix: string, filter: (name: string) => boolean): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!filter(name)) continue;
      const full = join(dir, name);
      try { if (!statSync(full).isFile()) continue; } catch { continue; }
      let doc = "";
      try { doc = withoutOwnName(firstDocLine(readFileSync(full, "utf8")), name); } catch { doc = ""; }
      entries.push(`- ${prefix}${name}${doc ? ` — ${tr(doc)}` : ""}`);
    }
  };
  collect(input.root, "", (name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "test-env.ts" && name !== "echo.ts" && name !== "texts.ts" && name !== "texts-de.ts");
  collect(join(input.root, "scripts"), "scripts/", (name) => name.endsWith(".sh"));
  const user = input.userName?.trim() || "your user";
  const okay = user === "your user" ? tr("your user's approval") : tr`${user}'s approval`;
  const lines = [
    tr("## Your house (Brain, classic cut)"),
    tr`You run in ${input.root} — head: ${input.head} (${input.model}). The code is yours: you may read everything here, but build only with ${okay}, never from inside the running process.`,
    "",
    tr("Files:"),
    ...entries,
    "",
    tr("How the house runs:"),
    tr("- scripts/brain-loop.sh starts Brain again when the process ends, with your bridge."),
    tr("- scripts/brain-watchdog.sh measures your window; at the cut threshold it calls scripts/brain-cutoff.sh: SIGTERM → you write the bridge and the archive → restart with bridge; the new session uploads the archive to the RAG."),
    tr`- State: ${input.stateDir} · Logs: ${input.logDir}`,
    tr`- Commands (terminal or app): ${input.commands.join(" ")}`,
  ];
  if (input.capabilities && input.capabilities.trim()) lines.push("", input.capabilities.trim());
  if (input.extra && input.extra.trim()) lines.push("", input.extra.trim());
  return lines.join("\n");
}
