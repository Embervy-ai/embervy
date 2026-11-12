import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The activity strip distinguishes running tools, queued messages and stalled heads.

const PASSWORD = "test-password-not-real";
let server: ReturnType<typeof Bun.spawn>;
let base = "";
let dir = "";
let cookie = "";
let brainState = "";
const TURN_START = new Date(Date.now() - 5 * 60_000).toISOString();

import { startTestApp } from "./test-app-start";

function writeState(extra: Record<string, unknown>): void {
  writeFileSync(brainState, JSON.stringify({ tokens: 200000, turn_output_tokens: 1200, turn_started_at: TURN_START, head: "claude", ...extra }));
}

async function activity(): Promise<any> {
  await Bun.sleep(1100); // past the one-second activity cache
  return (await fetch(`${base}/api/activity`, { headers: { Cookie: cookie } })).json();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "activity-brain-"));
  brainState = join(dir, "watchdog_state.json");
  writeState({});
  const app = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      TMUX_TMPDIR: dir, // no live pane
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      APP_PASSWORD: PASSWORD,
      APP_SESSION_SECRET: "session-secret-for-tests-only",
      INTERNAL_API_TOKEN: "internal-test-token-0123456789",
      ACTIVITY_TOKENS_FILE: brainState,
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "activity-brain-test-no-such-session",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  ({ base, proc: server, cookie } = app);
}, 30_000);

afterAll(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

describe("Brain's own fields in the activity strip", () => {
  test("a running tool shows by name, and waiting messages are counted", async () => {
    writeState({ tool: "Bash", queued: 2, last_event_ts: new Date().toISOString() });
    const data = await activity();
    expect(data.state).toBe("tool");
    expect(data.task).toBe("Bash");
    expect(data.queued).toBe(2);
    expect(data.stalledHead).toBeUndefined();
  });

  test("a head silent for over a minute in an open turn is named", async () => {
    writeState({ tool: null, queued: 0, last_event_ts: new Date(Date.now() - 3 * 60_000).toISOString() });
    const data = await activity();
    expect(data.state).toBe("thinking");
    expect(data.stalledHead).toBe("Claude");
    expect(data.queued).toBeUndefined();
  });

  test("an unknown head keeps its own name; a recent event is just thinking", async () => {
    writeState({ head: "mistral", last_event_ts: new Date(Date.now() - 2 * 60_000).toISOString() });
    expect((await activity()).stalledHead).toBe("mistral");
    writeState({ last_event_ts: new Date().toISOString() });
    const data = await activity();
    expect(data.state).toBe("thinking");
    expect(data.stalledHead).toBeUndefined();
  });

  test("without Brain's fields nothing changes (Claude Code path)", async () => {
    writeState({});
    const data = await activity();
    expect(data.state).toBe("idle");
    expect(data.task).toBeUndefined();
    expect(data.stalledHead).toBeUndefined();
  });

  test("the strings the strip uses exist", () => {
    const en = JSON.parse(readFileSync(join(import.meta.dir, "strings", "en.json"), "utf8"));
    for (const key of ["activity.stalled", "activity.stalledModel", "activity.queuedOne", "activity.queuedMany"]) expect(typeof en[key]).toBe("string");
    expect(en["activity.stalled"]).toContain("{head}");
    expect(en["activity.queuedMany"]).toContain("{count}");
  });
});
