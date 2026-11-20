import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

// Keep the cross-service contract in the fixed app test entry point. Running
// from Brain loads its isolation preload; importing brain.ts into the app test
// process directly would inherit app-test state and house environment.
test("Brain key-setup and catalog contracts (isolated Brain test runner)", async () => {
  const proc = Bun.spawn([process.execPath, "test", "heads.test.ts", "control-endpoint.test.ts", "heads-refresh.test.ts"], {
    cwd: join(import.meta.dir, "../../Brain"), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const lines = `${out}\n${err}`.trim().split("\n");
  // Only the summary: neither fixture values nor exception text enter app logs.
  const summary = "Brain targeted tests:\n" + lines.filter(l => /^\s*\d+ (pass|fail|expect\(\) calls)|^Ran \d+ tests/.test(l)).join("\n");
  console.info(summary);
  // The fixed house test command tails stdout; retain the child summary as a
  // normal ignored test artifact, never the child's possibly sensitive errors.
  const results = join(import.meta.dir, ".test-results");
  mkdirSync(results, { recursive: true });
  writeFileSync(join(results, "brain-key-contract.txt"), `${summary}\nexitCode=${code}\n`);
  expect(code).toBe(0);
}, 30_000);
