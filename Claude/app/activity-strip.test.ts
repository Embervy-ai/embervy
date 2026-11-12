import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The strip under the chat while the agent works:
// its time jumped back to "0m 5s" with every step of a quarter-hour turn,
// because it counted from the last activity change, and the side processes
// sat between the agent's state and its numbers in one long line, so nobody
// could tell which number was what. Now the time counts from the turn's own
// start when Brain reports it, and the side processes get their own line.

const PASSWORD = "test-password-not-real";
let server: ReturnType<typeof Bun.spawn>;
let base = "";
let dir = "";
let cookie = "";
const TURN_START = new Date(Date.now() - 15 * 60_000).toISOString();

import { startTestApp } from "./test-app-start";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "activity-strip-"));
  const brainState = join(dir, "brain_context.json");
  writeFileSync(brainState, JSON.stringify({
    tokens: 340000, window_live_tokens: 343000, turn_cold_tokens: 190000, turn_output_tokens: 4000,
    turn_helper_tokens: 0, turn_started_at: TURN_START, cut_tokens: 900000, percent: 37,
    pending_tasks: [{ description: "House app patch", kind: "helper", since: TURN_START, tokens: 247000 }],
  }));
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
      EMBERVY_TMUX_SESSION: "activity-strip-test-no-such-session",
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

describe("the activity strip", () => {
  test("the header's window figure is the live window's share of the cut", async () => {
    const data = await (await fetch(`${base}/api/activity`, { headers: { Cookie: cookie } })).json();
    expect(data.percent).toBe(38); // 343000 of 900000, not the 37 computed from the older count
  });

  test("its time counts from the turn's own start when Brain reports it", async () => {
    const data = await (await fetch(`${base}/api/activity`, { headers: { Cookie: cookie } })).json();
    expect(data.since).toBe(TURN_START);
    expect(data.tokens).toBe(343000);
    expect(data.turnOut).toBe(190000);
    expect(data.waitingTasks).toEqual([{ description: "House app patch", kind: "helper", since: TURN_START, tokens: 247000 }]);
    expect(data.turnStartedAt).toBeUndefined();
  });

  test("side processes come last, on their own line", () => {
    const html = readFileSync(join(import.meta.dir, "public", "index.html"), "utf8");
    const strip = html.slice(html.indexOf('<div id="activity-strip"'), html.indexOf("</div>", html.indexOf('<div id="activity-strip"')));
    const order = [...strip.matchAll(/id="(activity-strip-[a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["activity-strip-prefix", "activity-strip-duration", "activity-strip-tokens", "activity-strip-task"]);
    expect(strip).toMatch(/id="activity-strip-task"[^>]*class="side-line"|class="side-line"[^>]*id="activity-strip-task"/);
    const css = readFileSync(join(import.meta.dir, "public", "style.css"), "utf8");
    expect(css).toMatch(/#activity-strip\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.side-line\s*\{[^}]*flex-basis:\s*100%/);
  });
});
