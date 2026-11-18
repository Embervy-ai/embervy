import { expect, test } from "bun:test";
import { join } from "node:path";

test("statusline scripts: real stdin, cache-ping reader, atomic replacement and settings setup", async () => {
  const child = Bun.spawn(["python3", "-B", "-m", "unittest", "-v", "statusline_test"], {
    cwd: join(import.meta.dir, "../scripts"), stdout: "pipe", stderr: "pipe",
    env: { ...process.env, EMBERVY_LOOP_SERVICE: "irgendwas-loop" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  console.error("Statusline script tests:\n" + stdout + stderr);
  expect(code).toBe(0);
  expect(stderr).toContain("\nOK\n");
}, 90_000);
