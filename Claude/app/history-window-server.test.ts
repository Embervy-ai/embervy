import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestApp } from "./test-app-start";
const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };

test("a busy room does not push the person's messages out of the history window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "history-window-"));
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const own = Array.from({ length: 5 }, (_, i) => ({ id: `own-${i}`, text: `mine ${i}`, ts: at(i) }));
  const room = Array.from({ length: 250 }, (_, i) => ({ id: `room-${i}`, text: `table ${i}`, ts: at(10 + i), source: "room", room: "Table", from: "Ada" }));
  const toAgent = [
    { id: "scheduled-0", text: "[gateway:silent] A moment.", ts: at(6), type: "text", source: "scheduled", from: "moments" },
    { id: "peer-0", text: "from another house", ts: at(7), source: "peer", from: "Ada" },
  ];
  writeFileSync(join(data, "inbox.jsonl"), [...own, ...toAgent, ...room].map((m) => JSON.stringify(m)).join("\n") + "\n");
  const { base, proc, cookie } = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: data,
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "history-window-no-such-session",
      APP_PASSWORD: "history-password",
      APP_SESSION_SECRET: "history-session-secret-for-tests",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const history = await (await fetch(`${base}/api/messages`, { headers: { ...viaTunnel, cookie } })).json() as Array<{ id: string }>;
    const ids = history.map((m) => m.id);
    expect(ids.filter((id) => id.startsWith("own-"))).toEqual(["own-0", "own-1", "own-2", "own-3", "own-4"]);
    expect(ids.some((id) => id.startsWith("room-"))).toBe(false);
    expect(ids).not.toContain("scheduled-0");
    expect(ids).not.toContain("peer-0");
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
