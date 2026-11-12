import { open, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const inFlight = new Map<string, Promise<unknown>>();
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function refreshStoredCredential<T>(path: string, refresh: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const current = inFlight.get(key);
  if (current) return current as Promise<T>;
  const promise = withCredentialLock(key, refresh).finally(() => {
    if (inFlight.get(key) === promise) inFlight.delete(key);
  });
  inFlight.set(key, promise);
  return promise;
}

let flockReady: Promise<(fd: number) => number> | undefined;
function loadFlock(): Promise<(fd: number) => number> {
  return flockReady ??= (async () => {
    try {
      if (process.platform !== "linux" || typeof Bun === "undefined") throw new Error("Linux and Bun are required");
      const { dlopen, read } = await import("bun:ffi");
      const library = dlopen("libc.so.6", {
        flock: { args: ["i32", "i32"], returns: "i32" },
        __errno_location: { args: [], returns: "ptr" },
      });
      const LOCK_EX = 2, LOCK_NB = 4;
      return (fd: number) => {
        // errno must be read before another native call can overwrite it.
        if (library.symbols.flock(fd, LOCK_EX | LOCK_NB) === 0) return 0;
        return read.i32(library.symbols.__errno_location()!);
      };
    } catch (cause) {
      throw new Error("Credential locking requires Linux/Bun bun:ffi and libc.so.6 flock; no file-lock fallback is available", { cause });
    }
  })();
}

export async function withCredentialLock<T>(path: string, action: () => Promise<T>, waitLimitMs = 120_000): Promise<T> {
  const lock = `${resolve(path)}.lock`;
  if (!Number.isFinite(waitLimitMs) || waitLimitMs < 0) throw new Error(`Invalid lock wait limit for ${lock}`);
  const deadline = performance.now() + waitLimitMs;
  const flock = await loadFlock();
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  // Every contender must open the same inode; removing this path would split the lock.
  const handle = await open(lock, "a", 0o600);
  const EWOULDBLOCK = 11, EINTR = 4;
  try {
    for (;;) {
      const errno = flock(handle.fd);
      if (errno === 0) break;
      if (errno !== EWOULDBLOCK && errno !== EINTR) throw new Error(`flock failed for ${lock}: errno ${errno}`);
      const remaining = deadline - performance.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for credential lock ${lock} after ${waitLimitMs} ms`);
      await sleep(Math.min(25, remaining));
      if (performance.now() >= deadline) throw new Error(`Timed out waiting for credential lock ${lock} after ${waitLimitMs} ms`);
    }
    return await action();
  } finally {
    await handle.close();
  }
}

export function writePrivateJson(path: string, value: unknown): Promise<void> {
  return writePrivateText(path, JSON.stringify(value, null, 2));
}

export async function writePrivateText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(tmp, "wx", 0o600);
  try {
    await handle.writeFile(text);
    await handle.close();
    await rename(tmp, path);
  } finally {
    await handle.close();
    await unlink(tmp).catch((error: any) => { if (error.code !== "ENOENT") throw error; });
  }
}
