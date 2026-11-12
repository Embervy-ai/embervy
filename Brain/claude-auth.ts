import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";


export interface ClaudeAuthProfile { configDir: string | null; account: string | null }
export function credentialsPath(profile: ClaudeAuthProfile): string {
  return join(profile.configDir ?? join(homedir(), ".claude"), ".credentials.json");
}

/** Skip unrelated values without decoding credential strings into JavaScript values. */
function expiryFields(bytes: Buffer): { access: number | null; refresh: number | null } {
  const whitespace = (i: number): number => { while ([9, 10, 13, 32].includes(bytes[i])) i++; return i; };
  const stringEnd = (start: number): number => {
    let i = start + 1;
    while (i < bytes.length) {
      if (bytes[i] === 34) return i + 1;
      i += bytes[i] === 92 ? 2 : 1;
    }
    throw new Error("Invalid credential metadata");
  };
  const skip = (start: number): number => {
    let i = whitespace(start);
    if (bytes[i] === 34) return stringEnd(i);
    if (bytes[i] === 123 || bytes[i] === 91) {
      let depth = 1;
      for (i++; i < bytes.length; i++) {
        if (bytes[i] === 34) { i = stringEnd(i) - 1; continue; }
        if (bytes[i] === 123 || bytes[i] === 91) depth++;
        if ((bytes[i] === 125 || bytes[i] === 93) && --depth === 0) return i + 1;
      }
      throw new Error("Invalid credential metadata");
    }
    while (i < bytes.length && ![9, 10, 13, 32, 44, 125, 93].includes(bytes[i])) i++;
    return i;
  };
  const member = (start: number, wanted: string): number => {
    let i = whitespace(start);
    if (bytes[i++] !== 123) return -1;
    while ((i = whitespace(i)) < bytes.length && bytes[i] !== 125) {
      if (bytes[i] !== 34) return -1;
      const end = stringEnd(i);
      const key = JSON.parse(bytes.toString("utf8", i, end));
      i = whitespace(end);
      if (bytes[i++] !== 58) return -1;
      i = whitespace(i);
      if (key === wanted) return i;
      i = whitespace(skip(i));
      if (bytes[i] !== 44) return -1;
      i++;
    }
    return -1;
  };
  const oauth = member(0, "claudeAiOauth");
  const number = (key: string): number | null => {
    const start = oauth < 0 ? -1 : member(oauth, key);
    if (start < 0 || !((bytes[start] >= 48 && bytes[start] <= 57) || bytes[start] === 45)) return null;
    const raw = bytes.toString("utf8", start, skip(start));
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return { access: number("expiresAt"), refresh: number("refreshTokenExpiresAt") };
}

export function credentialExpiries(profile: ClaudeAuthProfile): { access: number | null; refresh: number | null } {
  let bytes: Buffer | undefined;
  try {
    bytes = readFileSync(credentialsPath(profile));
    return expiryFields(bytes);
  } catch { return { access: null, refresh: null }; }
  finally { bytes?.fill(0); }
}

export function isClaudeAuthText(text: string): boolean {
  return /(?:^|\n)\s*(?:failed to authenticate\b|(?:API Error:\s*)?401\b|invalid_authentication\b|authentication_error\b|unauthorized\b)|\boauth (?:session|token).*(?:expired|invalid)|\brefresh token.*(?:expired|invalid|revoked)/i.test(text);
}

/** Explicit non-auth failures win over stale expiry metadata. */
export function claudeAuthExpired(profile: ClaudeAuthProfile, text: string, code?: unknown, now = Date.now()): boolean {
  if (isClaudeAuthText(text)) return true;
  if (code === 401 || code === "401" || code === "authentication_error" || code === "authentication_failed" || code === "oauth_session_expired") return true;
  if (text.trim() || code != null) return false;
  const expiry = credentialExpiries(profile);
  return (expiry.refresh !== null && expiry.refresh <= now) || (expiry.access !== null && expiry.access <= now);
}

export class ClaudeAuthExpiredError extends Error {
  constructor() { super("Claude sign-in expired"); this.name = "ClaudeAuthExpiredError"; }
}

export function credentialsStamp(profile: ClaudeAuthProfile): string {
  try { const s = statSync(credentialsPath(profile)); return `${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`; }
  catch { return "missing"; }
}

export function writeClaudeAuthState(stateDir: string, state: "expired" | "ok", profile?: ClaudeAuthProfile): void {
  const path = join(stateDir, "claude-auth.json");
  const tmp = `${path}.tmp-${process.pid}`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(tmp, JSON.stringify({ state, since: new Date().toISOString(), ...(state === "expired" ? {
      config_dir: profile!.configDir, account: profile!.account,
    } : {}) }) + "\n", { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } finally { try { unlinkSync(tmp); } catch { /* No partial state should survive a failed write. */ } }
}
