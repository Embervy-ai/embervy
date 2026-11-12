import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestApp } from "./test-app-start";

// In a Brain house the pane is Brain's live view: free text, written by the
// agent, its rooms and Brain's own status lines. A line there that starts with
// a dot is a sentence, not Claude Code's spinner, so it must never say
// "working". Brain reports an open turn and its tool itself.

let server: ReturnType<typeof Bun.spawn>;
let base = "";
let cookie = "";
let dir = "";
let brainState = "";
const SOCKET = `activity-brain-pane-${process.pid}`;
const SESSION = "brain-pane";

function tmux(args: string[]): void {
  Bun.spawnSync(["tmux", "-L", SOCKET, ...args], { env: { ...process.env, TMUX_TMPDIR: dir } });
}

function writeState(extra: Record<string, unknown>): void {
  writeFileSync(brainState, JSON.stringify({ tokens: 200000, head: "claude", ...extra }));
}

async function activity(): Promise<any> {
  await Bun.sleep(1100); // past the one-second activity cache
  return (await fetch(`${base}/api/activity`, { headers: { Cookie: cookie } })).json();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "activity-brain-pane-"));
  brainState = join(dir, "watchdog_state.json");
  writeState({});
  // A process named claude in this house, as Brain's pipe child looks to the
  // process check, and the lines a Brain pane really carries: the helper count
  // from live-view.ts and a wrapped sentence of the agent's own report.
  mkdirSync(join(dir, "bin"));
  const fake = join(dir, "bin", "claude");
  copyFileSync(Bun.which("sleep") ?? "/bin/sleep", fake);
  chmodSync(fake, 0o755);
  const lines = "printf '%s\\n' 'agent: the probe is done.' '  · 1 helpers running' '· the banner came back'";
  tmux(["new-session", "-d", "-s", SESSION, "-c", dir, "-x", "120", "-y", "30", `${lines}; exec '${fake}' 600`]);
  await Bun.sleep(300);
  const app = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      TMUX_TMPDIR: dir,
      EMBERVY_HOME: dir,
      EMBERVY_HARNESS: "brain",
      BRAIN_TMUX_SOCKET: SOCKET,
      BRAIN_TMUX_SESSION: SESSION,
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      INTERNAL_API_TOKEN: "internal-test-token-0123456789",
      ACTIVITY_TOKENS_FILE: brainState,
      EMBERVY_TERMINAL_PANEL: "0",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc: server, cookie } = app);
}, 30_000);

afterAll(() => {
  server?.kill();
  tmux(["kill-server"]);
  rmSync(dir, { recursive: true, force: true });
});

describe("a Brain house's pane is never read as a spinner", () => {
  test("dot lines in the pane with no open turn are idle", async () => {
    writeState({});
    expect((await activity()).state).toBe("idle");
  });

  test("Brain's own open turn still shows as thinking", async () => {
    writeState({ turn_started_at: new Date().toISOString(), turn_output_tokens: 10, last_event_ts: new Date().toISOString() });
    expect((await activity()).state).toBe("thinking");
    writeState({});
    expect((await activity()).state).toBe("idle");
  });
});
