/**
 * A persistent inode and a lifetime flock prevent duplicate inbox answers.
 * The pid check stays in front of the claim: a running Brain of an older
 * version holds no flock and must still block a second start.
 * Injected probes keep process-identity checks independent of real processes.
 */

import { closeSync, constants, ftruncateSync, openSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { ownsHousePid } from "./owner";
import { join } from "node:path";

export function lockFileFromEnv(stateDir: string, env: Record<string, string | undefined> = process.env): string {
  return env.BRAIN_LOCK_FILE ?? join(stateDir, "brain.pid");
}

export interface LockProbes {
  readLock: (path: string) => string | null;
  isAlive: (pid: number) => boolean;
  cmdline: (pid: number) => string;
  environ: (pid: number) => string[];
  stdinTarget: (pid: number) => string;
  pgrep: (pattern: string) => string;
  owns?: (pid: number) => boolean;
}

function loadFlock() {
  try {
    // Loading lazily keeps an unconfigured lock independent of native FFI.
    const { dlopen, FFIType, read } = require("bun:ffi") as typeof import("bun:ffi");
    const library = dlopen("libc.so.6", {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    });
    return { library, errno: () => read.i32(library.symbols.__errno_location()!) };
  } catch (error) {
    throw new Error(`bun:ffi/libc.so.6 flock is unavailable: ${error}`);
  }
}

let nativeFlock: ReturnType<typeof loadFlock> | undefined;
const heldDescriptors = new Map<string, number>();
const LOCK_EX = 2;
const LOCK_NB = 4;
const EINTR = 4;
const EAGAIN = 11;

function takeFlock(fd: number): boolean {
  const native = nativeFlock ??= loadFlock();
  while (native.library.symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    const errno = native.errno();
    if (errno === EINTR) continue;
    if (errno === EAGAIN) return false;
    throw new Error(`flock failed (errno=${errno})`);
  }
  return true;
}

export const realProbes: LockProbes = {
  owns: ownsHousePid,
  readLock: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
  isAlive: (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  cmdline: (pid) => { try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " "); } catch { return ""; } },
  environ: (pid) => { try { return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0"); } catch { return []; } },
  stdinTarget: (pid) => { try { return readlinkSync(`/proc/${pid}/fd/0`); } catch { return ""; } },
  pgrep: (pattern) => {
    try {
      const proc = Bun.spawnSync(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "ignore" });
      return new TextDecoder().decode(proc.stdout).trim();
    } catch {
      return "";
    }
  },
};

export interface ParallelCheck {
  lockFile: string;          // empty = no lock at all
  ownPid: number;
  sterile: boolean;
  parallelPattern: string;   // empty = no parallel-head check
  allowParallel: boolean;
}

export function checkParallel(input: ParallelCheck, probes: LockProbes = realProbes): { blocked: boolean; reason?: string } {
  if (input.sterile && !input.lockFile) return { blocked: false };
  if (input.lockFile) {
    const raw = probes.readLock(input.lockFile);
    const existing = raw ? Number.parseInt(raw.trim(), 10) : NaN;
    if (Number.isFinite(existing) && existing > 0 && existing !== input.ownPid && probes.isAlive(existing)) {
      const looksLikeBrain = /\bbrain\.ts\b/.test(probes.cmdline(existing));
      const sterileOther = probes.environ(existing).includes("BRAIN_STERILE=1");
      const deletedTty = probes.stdinTarget(existing).includes("(deleted)");
      // Another house's Brain on the same server does not hold this lock.
      if (looksLikeBrain && !sterileOther && !deletedTty && (probes.owns?.(existing) ?? true)) {
        return { blocked: true, reason: `another brain.ts already active (pid=${existing}, lockfile=${input.lockFile})` };
      }
    }
  }
  if (input.parallelPattern && !input.allowParallel) {
    const out = probes.pgrep(input.parallelPattern).split(/\s+/).filter(pid => pid && (probes.owns?.(Number(pid)) ?? true)).join("\n");
    if (out) {
      return { blocked: true, reason: `a parallel head is running (pattern '${input.parallelPattern}', pids: ${out.replace(/\n/g, ",")}) — set BRAIN_ALLOW_PARALLEL=1 to override` };
    }
  }
  return { blocked: false };
}

/** Keep the descriptor open until process death; unlinking would split ownership. */
export function claimLock(lockFile: string, pid = process.pid): { blocked: boolean; reason?: string } {
  if (!lockFile || heldDescriptors.has(lockFile)) return { blocked: false };
  let fd: number | undefined;
  try {
    fd = openSync(lockFile, constants.O_RDWR | constants.O_CREAT, 0o600);
    if (!takeFlock(fd)) {
      const raw = realProbes.readLock(lockFile);
      const existing = raw ? Number.parseInt(raw.trim(), 10) : NaN;
      return { blocked: true, reason: `another brain.ts already active (pid=${existing}, lockfile=${lockFile})` };
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, String(pid));
    heldDescriptors.set(lockFile, fd);
    fd = undefined;
    return { blocked: false };
  } catch (error) {
    return { blocked: true, reason: `cannot acquire brain lock (lockfile=${lockFile}): ${error}` };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
