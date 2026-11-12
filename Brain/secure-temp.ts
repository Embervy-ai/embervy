import { existsSync, mkdtempSync, readdirSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface SecureTempMarkdown {
  path: string;
  directory: string;
  cleanup: () => void;
}

/** Unpredictable private directory plus an exclusively created 0600 file. */
export function createSecureTempMarkdown(prefix: string, content: string): SecureTempMarkdown {
  const safePrefix = prefix.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "brain-export";
  const directory = mkdtempSync(join(tmpdir(), `${safePrefix}-`));
  const path = join(directory, "export.md");
  try {
    writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    try { rmdirSync(directory); } catch {}
    throw error;
  }
  // Umask-independent contract: the writeFile mode is only an upper bound;
  // this check prevents silent platform drift.
  if ((statSync(path).mode & 0o777) !== 0o600) {
    try { unlinkSync(path); } catch {}
    try { rmdirSync(directory); } catch {}
    throw new Error("secure export temp file did not receive mode 0600");
  }
  return {
    path,
    directory,
    cleanup: () => {
      try { unlinkSync(path); } catch {}
      try { rmdirSync(directory); } catch {}
    },
  };
}

/** claude-pipe.ts writes the system prompt into a mkdtemp private directory
 * `claude-pipe-system-<pid>-XXXXXX` and removes it only in ClaudePipe.stop().
 * A SIGKILL/crash BEFORE stop() (the rule, not the exception, for a respawning
 * process) leaves the directory behind forever. No single leak is dangerous
 * (0600, unpredictable name), but over many respawns they pile up in /tmp.
 * Pure decision function: which directory names in the given list belong to
 * a PID that is NO LONGER alive (ownPid is never reported as orphaned — the
 * own process removes its own system prompt via stop(), not via the boot
 * sweep). */
export function orphanedClaudePipeTempDirs(
  entries: readonly string[],
  ownPid: number,
  isAlive: (pid: number) => boolean,
): string[] {
  const orphans: string[] = [];
  for (const name of entries) {
    const match = /^claude-pipe-system-(\d+)-/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (pid === ownPid) continue;
    if (isAlive(pid)) continue;
    orphans.push(name);
  }
  return orphans;
}

/** Signal 0 probes process existence without sending a real signal. */
export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Boot sweep: removes orphaned claude-pipe-system-* temp dirs from `root`
 * (default: os.tmpdir()) — only directories of PIDs that `isAlive` reports
 * as dead, never the own one. Best-effort: a single delete or read error does
 * not abort the sweep (same discipline as createSecureTempMarkdown.cleanup —
 * cleanup must never disturb the boot). */
export function sweepOrphanedClaudePipeTempDirs(
  root: string = tmpdir(),
  ownPid: number = process.pid,
  isAlive: (pid: number) => boolean = pidIsAlive,
): string[] {
  let entries: string[];
  try {
    entries = existsSync(root) ? readdirSync(root) : [];
  } catch {
    return [];
  }
  const orphans = orphanedClaudePipeTempDirs(entries, ownPid, isAlive);
  const swept: string[] = [];
  for (const name of orphans) {
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      swept.push(name);
    } catch { /* best-effort — a leftover stays behind, the boot goes on */ }
  }
  return swept;
}
