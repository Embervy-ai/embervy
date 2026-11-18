import { expect, test } from "bun:test";
import { join } from "node:path";

// Keep the shipped shell-export tests in the Brain verification entry point.
// The suite executes shell sections with local adapter/auth stubs, never services.
test("Claude loop head exports (script regression suite)", () => {
  const run = Bun.spawnSync([process.execPath, "test", "./kimi-window.test.ts"], {
    cwd: join(import.meta.dir, "../Claude/scripts"),
    env: { PATH: process.env.PATH!, HOME: process.env.HOME! },
    stdout: "pipe", stderr: "pipe", timeout: 60000,
  });
  const output = run.stdout.toString() + run.stderr.toString();
  if (run.exitCode !== 0) console.error(output);
  // Preserve the literal summary of the nested script run in the test output.
  const summary = output.trimEnd().split("\n").slice(-4).join("\n");
  console.error(`\nClaude/scripts/kimi-window.test.ts:\n${summary}`);
  expect(run.exitCode).toBe(0);
  expect(output).toContain("0 fail");
}, 65000);
