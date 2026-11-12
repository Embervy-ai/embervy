// Connects web sign-in to the Claude CLI.
// The CLI handles credentials so the browser never receives tokens.

import { tmuxCommand } from "./house-runtime";
import { parseEnv } from "./env-file";

export type ClaudeAuthState = { state: "expired" | "ok"; config_dir: string | null };
export function parseClaudeAuth(text: string): ClaudeAuthState | null {
  try {
    const value = JSON.parse(text);
    // Brain writes no config_dir for "ok" or for the default profile; a missing one means the default.
    if ((value.state === "expired" || value.state === "ok") &&
        (value.config_dir === undefined || value.config_dir === null || typeof value.config_dir === "string")) {
      return { ...value, config_dir: value.config_dir ?? null };
    }
  } catch { /* Missing or partial state is not evidence of expiry. */ }
  return null;
}

export function claudeProfile(brain: boolean, state: ClaudeAuthState | null, env: string | Record<string, string | undefined>): string | null {
  if (brain && state) return state.config_dir;
  return (typeof env === "string" ? parseEnv(env) : env).CLAUDE_CONFIG_DIR || null;
}

export interface Runner {
  run(cmd: string[], opts?: { timeoutMs?: number; stdin?: string }): Promise<{ code: number; out: string }>;
}
type Target = Runner;

export const localRunner: Runner = {
  async run(cmd, opts) {
    const p = Bun.spawn(cmd, { stdin: opts?.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin), stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => p.kill(), opts?.timeoutMs ?? 60_000);
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
    const code = await p.exited;
    clearTimeout(timer);
    return { code, out };
  },
};

export const CLAUDE_LOGIN_SESSION = "embervy-claude-login";
// A separate tmux socket isolates login from running sessions and other installations.
const HOUSE_SOCKET = process.env.EMBERVY_TMUX_SOCKET || process.env.BRAIN_TMUX_SOCKET || "";
const TMUX = tmuxCommand([], HOUSE_SOCKET ? `embervy-login-${HOUSE_SOCKET}` : "embervy-login");
const CLAUDE_PATH = "export PATH=$PATH:/root/.local/bin";

export type Wait = { pollMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; configDir?: string | null };

export const CLAUDE_AUTH_WORDINGS = {
  expired: ["Failed to authenticate", "OAuth session expired", "Please run /login"],
  failed: ["Login failed"],
  invalid: ["Invalid code"],
  success: ["Login successful"] as string[],
};

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
function profileCommand(command: string, configDir: string | null | undefined): string {
  if (configDir === undefined) return `${CLAUDE_PATH}; ${command}`;
  return `${configDir === null ? "unset CLAUDE_CONFIG_DIR" : `export CLAUDE_CONFIG_DIR=${quote(configDir)}`}; ${command}`;
}

export function claudeScreenExpired(screen: string): boolean {
  const plain = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  // Only CLI result lines count; quoted errors in conversation must not trigger sign-in.
  return plain.split("\n").slice(-30).some((line) => {
    const result = line.match(/^[\s│]*⎿\s*(.*)$/);
    const text = result ? result[1] : line.trim();
    if (!result && !/^API Error: 401\b/.test(text)) return false;
    return CLAUDE_AUTH_WORDINGS.expired.some((word) => text.includes(word)) || /^API Error: 401\b/.test(text);
  });
}

export function needsClaudeLogin(expired: boolean, signedIn: boolean): boolean {
  return expired || !signedIn;
}

async function credentialsStamp(t: Target, configDir: string | null | undefined): Promise<string> {
  // Only metadata and a digest leave the profile, never its credentials.
  const command = 'f="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json"; if test -f "$f"; then stat -c "%i:%s:%y:%z" -- "$f" && sha256sum < "$f"; else printf missing; fi';
  const result = await t.run(["bash", "-c", profileCommand(command, configDir)], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error("credentials-unreadable");
  return result.out.trim();
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function extractSignInUrl(screen: string): string | null {
  const match = screen.match(/https:\/\/[^\s"'<>]*\/oauth\/authorize\?[^\s"'<>]+/);
  return match ? match[0] : null;
}

// A leading dash could make tmux interpret the pasted code as an option.
export function validCode(code: string): boolean {
  return /^[A-Za-z0-9._~#][A-Za-z0-9._~#-]{7,511}$/.test(code);
}

async function screen(t: Target): Promise<string> {
  const { out } = await t.run([...TMUX, "capture-pane", "-p", "-J", "-t", CLAUDE_LOGIN_SESSION], { timeoutMs: 15_000 });
  return out;
}

export async function startClaudeSignIn(t: Target, wait: Wait = {}): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const sleep = wait.sleep ?? pause;
  const pollMs = wait.pollMs ?? 500;
  const timeoutMs = wait.timeoutMs ?? 30_000;
  await t.run([...TMUX, "kill-session", "-t", CLAUDE_LOGIN_SESSION], { timeoutMs: 15_000 });
  // Width prevents URL wrapping; the trailing sleep keeps the result available for polling.
  const started = await t.run([
    ...TMUX, "new-session", "-d", "-s", CLAUDE_LOGIN_SESSION, "-x", "400", "-y", "50",
    "bash", "-c", `${profileCommand("claude auth login --claudeai", wait.configDir)}; sleep 900`,
  ], { timeoutMs: 20_000 });
  if (started.code !== 0) return { ok: false, error: "startFailed" };
  let last = "";
  for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
    last = await screen(t);
    const url = extractSignInUrl(last);
    if (url) return { ok: true, url };
    await sleep(pollMs);
  }
  return { ok: false, error: "noLink" };
}

export async function claudeSignedIn(t: Target, configDir?: string | null): Promise<{ signedIn: boolean; plan: string }> {
  const status = await t.run(["bash", "-c", profileCommand("claude auth status --json", configDir)], { timeoutMs: 20_000 });
  let parsed: { loggedIn?: unknown; subscriptionType?: unknown } | null = null;
  try { parsed = JSON.parse(status.out.slice(status.out.indexOf("{"))); } catch { parsed = null; }
  return {
    signedIn: parsed?.loggedIn === true,
    plan: typeof parsed?.subscriptionType === "string" ? parsed.subscriptionType : "",
  };
}

export async function finishClaudeSignIn(t: Target, code: string, wait: Wait = {}): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  try {
    const sleep = wait.sleep ?? pause;
    const pollMs = wait.pollMs ?? 1_000;
    const timeoutMs = wait.timeoutMs ?? 45_000;
    const pasted = code.trim();
    if (!validCode(pasted)) return { ok: false, error: "invalidCode" };
    const before = await screen(t);
    if (!extractSignInUrl(before)) return { ok: false, error: "notWaiting" };
    // tmux reads the one-time credential from stdin, never from the process list.
    const buffer = `embervy-login-${crypto.randomUUID()}`;
    try {
      const loaded = await t.run([...TMUX, "load-buffer", "-b", buffer, "-"], { timeoutMs: 15_000, stdin: pasted });
      if (loaded.code !== 0) return { ok: false, error: "finishFailed" };
      const sent = await t.run([...TMUX, "paste-buffer", "-d", "-b", buffer, "-t", CLAUDE_LOGIN_SESSION], { timeoutMs: 15_000 });
      if (sent.code !== 0) return { ok: false, error: "finishFailed" };
    } finally {
      await t.run([...TMUX, "delete-buffer", "-b", buffer], { timeoutMs: 15_000 }).catch(() => {});
    }
    // Capture the baseline before Enter so existing credentials cannot prove this login succeeded.
    const stamp = await credentialsStamp(t, wait.configDir);
    const enter = await t.run([...TMUX, "send-keys", "-t", CLAUDE_LOGIN_SESSION, "Enter"], { timeoutMs: 15_000 });
    if (enter.code !== 0) return { ok: false, error: "finishFailed" };
    for (let waited = 0; waited <= timeoutMs; waited += pollMs) {
      await sleep(pollMs);
      const current = await screen(t);
      if (CLAUDE_AUTH_WORDINGS.failed.some(word => current.toLowerCase().includes(word.toLowerCase()))) return { ok: false, error: "loginFailed" };
      if (CLAUDE_AUTH_WORDINGS.invalid.some(word => current.toLowerCase().includes(word.toLowerCase()))) return { ok: false, error: "invalidCode" };
      const after = await credentialsStamp(t, wait.configDir);
      if (CLAUDE_AUTH_WORDINGS.success.some(word => current.includes(word) && !before.includes(word)) || (after !== "missing" && after !== stamp)) {
        await t.run([...TMUX, "kill-session", "-t", CLAUDE_LOGIN_SESSION], { timeoutMs: 15_000 });
        return { ok: true, detail: "done" };
      }
    }
    return { ok: false, error: "unconfirmed" };
  } catch {
    // Subprocess exceptions can contain the command, including the pasted secret.
    return { ok: false, error: "finishFailed" };
  }
}
