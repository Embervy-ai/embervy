import { readFile } from "node:fs/promises";
import { envLine, envLineKey } from "../../shared/scripts/env-file";
import { withCredentialLock, writePrivateText } from "../../shared/scripts/credential-store";

// Deliberate allowlist. A future provider gets its own non-generating probe;
// neither the browser nor an environment variable can redirect credentials.
const KEY_SETUPS = {
  kimi: { variable: "KIMI_CODE_KEY", probe: "https://api.kimi.com/coding/v1/usages" },
} as const;
export type KeySetupHead = keyof typeof KEY_SETUPS;
export function keySetupHead(head: string): head is KeySetupHead {
  return Object.hasOwn(KEY_SETUPS, head);
}
export class KeySetupError extends Error {
  constructor(public code: "invalid" | "rejected" | "unchecked" | "storage") {
    super(code); // Never include a key, a provider response, or an underlying exception.
  }
}

function assignment(head: KeySetupHead, key: unknown): string {
  // Keep the assignment bare and unambiguous for Brain's legacy env reader.
  if (typeof key !== "string" || key.length < 8 || key.length > 512 ||
      /[^A-Za-z0-9._-]/.test(key)) throw new KeySetupError("invalid");
  try { return envLine(KEY_SETUPS[head].variable, key); }
  catch { throw new KeySetupError("invalid"); }
}

async function updateKey(file: string, head: KeySetupHead, line: string): Promise<void> {
  try {
    await withCredentialLock(file, async () => {
      let text = "";
      try { text = await readFile(file, "utf8"); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; }
      // Remove every old assignment (including export/quoted variants), not comments
      // or similarly named variables. The private writer replaces the file atomically.
      let next = text.split("\n").filter((old) => envLineKey(old) !== KEY_SETUPS[head].variable).join("\n");
      next += `${next && !next.endsWith("\n") ? "\n" : ""}${line}\n`;
      await writePrivateText(file, next);
    }, 5_000);
  } catch { throw new KeySetupError("storage"); }
}

export async function saveHeadKey(file: string, head: KeySetupHead, key: unknown): Promise<void> {
  const line = assignment(head, key);
  try {
    // Exactly one non-generating request; no retries and no credential-bearing redirects.
    const response = await fetch(KEY_SETUPS[head].probe, {
      method: "GET", headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new KeySetupError(response.status === 401 ? "rejected" : "unchecked");
    }
    const body = await response.json();
    if (!body || typeof body !== "object" || !body.usages || typeof body.usages !== "object") {
      throw new KeySetupError("unchecked");
    }
  } catch (error) {
    if (error instanceof KeySetupError) throw error;
    throw new KeySetupError("unchecked");
  }
  await updateKey(file, head, line);
}
