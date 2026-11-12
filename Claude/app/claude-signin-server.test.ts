// Signing the server in to a Claude account is the person's act: the routes
// answer only with the person's session, never with the agent's bearer.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestApp } from "./test-app-start";

test("Claude and ChatGPT sign-in routes: no session, no entry — the agent's bearer included", async () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-signin-"));
  const { base, proc } = await startTestApp({
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      EMBERVY_APP_HOST: "127.0.0.1",
      EMBERVY_APP_DATA_DIR: join(dir, "data"),
      EMBERVY_TERMINAL_PANEL: "0",
      EMBERVY_TMUX_SESSION: "signin-test-no-such-session",
      APP_PASSWORD: "signin-password",
      APP_SESSION_SECRET: "signin-session-secret-for-tests",
      INTERNAL_API_TOKEN: "agent-bearer-for-tests",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const viaTunnel = { "cf-ray": "test-ray", "cf-connecting-ip": "203.0.113.9" };
    for (const path of ["/api/brain/claude-signin/start", "/api/brain/claude-signin/code", "/api/brain/chatgpt-signin/start", "/api/brain/chatgpt-signin/code"]) {
      const bare = await fetch(`${base}${path}`, { method: "POST", headers: viaTunnel });
      expect([path, bare.status]).toEqual([path, 401]);
      const agent = await fetch(`${base}${path}`, { method: "POST", headers: { ...viaTunnel, authorization: "Bearer agent-bearer-for-tests", "content-type": "application/json" }, body: JSON.stringify({ code: "aBcD1234#XyZ" }) });
      expect([path, agent.status]).toEqual([path, 401]);
    }
  } finally {
    proc.kill();
    await proc.exited;
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
