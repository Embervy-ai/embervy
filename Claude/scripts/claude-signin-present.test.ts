import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const kind of ["oauth", "empty", "missing", "custom", "token", "invalid", "null-entry"]) {
  test(`Claude sign-in presence: ${kind}`, () => {
    const home = mkdtempSync(join(tmpdir(), "claude-presence-"));
    try {
      const config = join(home, kind === "custom" ? "custom" : ".claude");
      mkdirSync(config);
      if (!["missing", "token"].includes(kind)) writeFileSync(join(config, ".credentials.json"), kind === "invalid" ? "invalid" : JSON.stringify(kind === "empty" ? {} : { claudeAiOauth: kind === "null-entry" ? null : { accessToken: "private-test-token" } }));
      const result = Bun.spawnSync(["bash", "-c", '. "$1"; claude_signin_present', "test", join(import.meta.dir, "claude-signin-present.sh")], {
        env: { PATH: process.env.PATH!, HOME: home, ...(kind === "custom" ? { CLAUDE_CONFIG_DIR: config } : {}), ...(kind === "token" ? { CLAUDE_CODE_OAUTH_TOKEN: "private-test-token" } : {}) },
      });
      expect(result.exitCode).toBe(["oauth", "custom", "token", "null-entry"].includes(kind) ? 0 : 1);
      expect(result.stdout.toString() + result.stderr.toString()).toBe("");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
