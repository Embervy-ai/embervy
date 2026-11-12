import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Load no MCP servers in the headless canary so it cannot start a second app bridge.

const home = mkdtempSync(join(tmpdir(), "doctor-canary-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

test("the headless canary starts claude -p without any MCP server", () => {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const calls = join(home, "calls");
  writeFileSync(join(bin, "claude"), `#!/bin/bash
printf '%s\\n' "$*" >> "${calls}"
printf 'cwd=%s\\n' "$PWD" >> "${calls}"
[ "$1" = "--version" ] && { echo "0.0.0 (fake)"; exit 0; }
echo OK
`);
  chmodSync(join(bin, "claude"), 0o755);

  const run = Bun.spawnSync(["bun", join(import.meta.dir, "embervy-doctor.ts"), "--offline", "--json"], {
    cwd: home,
    env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: home, EMBERVY_HOME: home, EMBERVY_SUBSTRATE: "claude",
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const report = JSON.parse(run.stdout.toString());
  const canary = report.checks.find((c: any) => c.id === "claude-headless");
  expect(canary?.status).toBe("OK");

  const prompt = readFileSync(calls, "utf8").split("\n").find((l) => l.startsWith("-p "));
  expect(prompt).toBeDefined();
  expect(prompt).toContain("--strict-mcp-config");
  expect(prompt).toContain('--mcp-config {"mcpServers":{}}');
  // A SessionStart hook would consume the canary's single turn.
  expect(prompt).toContain("--setting-sources  --strict-mcp-config");
  // Each run would otherwise leave a session file in the shared temporary folder's project directory.
  expect(prompt).toContain("--no-session-persistence");
  const lines = readFileSync(calls, "utf8").split("\n");
  const cwd = lines[lines.indexOf(prompt!) + 1];
  expect(cwd).toStartWith("cwd=/");
  expect(cwd).not.toBe(`cwd=${home}`);
}, 30_000);
