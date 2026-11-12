import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const [harness, substrate, backend, presence, status] of [
  ["claude-code", "gpt", "", "file", "OK"],
  ["claude-code", "glm", "", "missing", "FAIL"],
  ["claude-code", "kimi", "", "empty", "FAIL"],
  ["claude-code", "minimax", "", "custom", "OK"],
  ["claude-code", "", "gpt", "token", "OK"],
  ["claude-code", "claude", "glm", "missing", "FAIL"],
  ["claude-code", "claude", "", "missing", "SKIP"],
  ["brain", "gpt", "gpt", "missing", "SKIP"],
  ["brain", "claude", "", "missing", "SKIP"],
]) {
  test(`doctor Claude channel sign-in: ${harness} ${substrate} ${backend} ${presence}`, () => {
    const home = mkdtempSync(join(tmpdir(), "doctor-signin-"));
    try {
      const config = join(home, presence === "custom" ? "custom" : ".claude");
      mkdirSync(config);
      if (["file", "custom", "empty"].includes(presence)) writeFileSync(join(config, ".credentials.json"), JSON.stringify(presence === "empty" ? {} : { claudeAiOauth: { accessToken: "private-test-token" } }));
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "embervy-doctor.ts"), "--startup-child", "--offline"], {
        env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home, EMBERVY_HARNESS: harness, EMBERVY_SUBSTRATE: substrate, EMBERVY_BACKEND: backend,
          ...(presence === "custom" ? { CLAUDE_CONFIG_DIR: config } : {}), ...(presence === "token" ? { CLAUDE_CODE_OAUTH_TOKEN: "private-test-token" } : {}) },
      });
      const output = result.stdout.toString();
      expect(output + result.stderr.toString()).not.toContain("private-test-token");
      const check = output.trim().split("\n").map(line => JSON.parse(line)).find(c => c.id === "claude.channel-signin");
      expect(check?.status).toBe(status);
      if (status === "SKIP") expect(check.label).toBe(harness === "claude-code"
        ? "Claude sign-in for another head: this house thinks with Claude, its own sign-in is checked by the canary"
        : "Claude sign-in for another head: this check is only for a Claude Code house with another head");
      if (status === "OK") expect(check.label).toBe("Claude sign-in present for the app channel");
      if (status === "FAIL") expect(check.label).toBe("App messages cannot reach this agent: Claude Code has no Claude sign-in, and Anthropic opens its app channel only for a signed-in Claude account. Sign in with claude and /login.");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
