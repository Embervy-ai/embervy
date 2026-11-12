import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Retry a failed cut after a pause so a failed bridge or export cannot leave
// the session running into its hard limit; emit one failure notice.

const watchdog = join(import.meta.dir, "context_watchdog.sh");
const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0)) c(); });

test("a failed cut is tried again after the pause, with one start and one failure notice", async () => {
  const root = mkdtempSync(join(tmpdir(), "embervy-cut-retry-"));
  const scripts = join(root, "Claude/scripts"), project = join(root, "project");
  mkdirSync(scripts, { recursive: true }); mkdirSync(project, { recursive: true });
  symlinkSync(join(import.meta.dir, "latest_main_session.py"), join(scripts, "latest_main_session.py"));
  copyFileSync(join(import.meta.dir, "cutoff.sh"), join(scripts, "cutoff.sh"));
  // The watchdog loads its helpers next to itself: a copy keeps it on the fixture, not on an installed house.
  copyFileSync(watchdog, join(scripts, "context_watchdog.sh"));
  mkdirSync(join(root, "shared/scripts"), { recursive: true });
  writeFileSync(join(root, "shared/scripts/env-file.sh"), "");
  // Notices go out through the shared bearer helper, so the fixture needs the real one.
  copyFileSync(join(import.meta.dir, "../../shared/scripts/curl-auth.sh"), join(root, "shared/scripts/curl-auth.sh"));
  // Keep termination inside the fixture while exercising the real cut script.
  writeFileSync(join(root, "shared/scripts/house-runtime.sh"), `
embervy_house_pids() { [ ! -f "$EMBERVY_HOME/exited" ] && echo 12345; }
embervy_owns_pid() { [ ! -f "$EMBERVY_HOME/exited" ]; }
kill() { touch "$EMBERVY_HOME/exited"; }
`);
  writeFileSync(join(scripts, "extract_bridge.py"), "pass\n");
  writeFileSync(join(scripts, "session-to-rag.sh"), `#!/bin/bash
n=$(( $(cat "${root}/cuts" 2>/dev/null || echo 0) + 1 )); echo $n > "${root}/cuts"
echo "export attempt $n" >&2
[ "$n" -ge 3 ] && exit 0
exit 1
`, { mode: 0o755 });
  writeFileSync(join(project, "main.jsonl"), JSON.stringify({ type: "assistant", entrypoint: "cli", message: { role: "assistant", usage: { input_tokens: 950 } } }) + "\n");

  const tag = `fakeclaude-${process.pid}-${Date.now()}`;
  const claude = Bun.spawn(["bash", "-c", `exec -a ${tag} sleep 120`], { cwd: root });
  const notices: string[] = [];
  const app = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { notices.push(String((await req.json()).text)); return new Response("ok"); } });
  const wd = Bun.spawn(["bash", join(scripts, "context_watchdog.sh")], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, EMBERVY_HOME: root, CLAUDE_PROJECT_DIR: project,
      CLAUDE_PROCESS_PATTERN: tag, EMBERVY_APP_PORT: String(app.port), WATCHDOG_WARN_TOKENS: "800", WATCHDOG_CUT_TOKENS: "900",
      WATCHDOG_CHECK_INTERVAL: "1", WATCHDOG_CUT_RETRY_SECONDS: "2",
    },
    stdout: "ignore", stderr: "ignore",
  });
  cleanups.push(() => { wd.kill("SIGKILL"); claude.kill("SIGKILL"); app.stop(true); rmSync(root, { recursive: true, force: true }); });

  const cuts = () => Number(existsSync(join(root, "cuts")) ? readFileSync(join(root, "cuts"), "utf8").trim() : 0);
  const deadline = Date.now() + 20_000;
  while (cuts() < 3 && Date.now() < deadline) await Bun.sleep(200);
  await Bun.sleep(500);

  expect(cuts()).toBe(3);
  expect(notices.filter((n) => n.startsWith("Cutover starting"))).toHaveLength(1);
  expect(notices.filter((n) => n.startsWith("Cutover failed"))).toHaveLength(1);
  expect(readFileSync(join(root, "state/last_cut_session"), "utf8")).toBe("main.jsonl\n"); // the grace holds after the cut that worked
  const log = readFileSync(join(root, "logs/context_watchdog.log"), "utf8");
  expect(log).toContain("CUT FAILED (cutoff.sh rc=1)");
  expect(log).toContain("next try at");
  const cutLog = readFileSync(join(root, "logs/cutoff.log"), "utf8");
  expect(cutLog.split("cutoff.sh start")).toHaveLength(4);
  expect(cutLog.split("Export FAILED")).toHaveLength(3);
  expect(cutLog.split("cutoff.sh done")).toHaveLength(2);
  for (const attempt of [1, 2, 3]) expect(cutLog.split(`export attempt ${attempt}`)).toHaveLength(2);
}, 30_000);
