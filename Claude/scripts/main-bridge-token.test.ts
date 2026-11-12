import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The app bridge's inbox position is one file, and
// every `claude` run that loads the project's MCP servers starts a bridge of
// its own. Only the main session's bridge may use it (Claude/app/mcp.ts,
// inbox-gap.test.ts). The loop marks that session: a fresh token per start in
// state/main-bridge-token, the same value in that one claude's environment,
// the file gone once the session ends. Here the real loop runs against a fake
// claude in a scratch home, with an explicit environment, so it can never see
// or touch a real install's processes.

const LOOP = join(import.meta.dir, "start-claude-loop.sh");
const loop = readFileSync(LOOP, "utf8");
const mcp = readFileSync(join(import.meta.dir, "..", "app", "mcp.ts"), "utf8");

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe("start-claude-loop.sh marks the main session for its bridge", () => {
  test("the loop and the bridge name the same file", () => {
    expect(loop).toContain('MAIN_BRIDGE_TOKEN_FILE="$EMBERVY_HOME/state/main-bridge-token"');
    expect(mcp).toContain('join(EMBERVY_HOME, "state", "main-bridge-token")');
    expect(mcp).toContain('envValue("EMBERVY_MAIN_BRIDGE_TOKEN")');
  });

  test("the token goes to the main claude only and is gone before finalize", () => {
    // in that one process's environment, not exported to the loop's helpers
    expect(loop).toContain('EMBERVY_MAIN_BRIDGE_TOKEN="$MAIN_BRIDGE_TOKEN" claude "${CLAUDE_ARGS[@]}"');
    expect(loop).not.toMatch(/export EMBERVY_MAIN_BRIDGE_TOKEN/);
    expect(loop).toContain("rc=$?\n  stop_cache_ping\n  clear_main_bridge_token\n");
    expect(loop).toContain("trap 'stop_cache_ping; clear_main_bridge_token; echo");
  });

  test("a real loop run: a fresh token per start, env and file match while claude runs, no file afterwards", async () => {
    const home = mkdtempSync(join(tmpdir(), "main-bridge-token-"));
    dirs.push(home);
    const bin = join(home, "bin");
    const rec = join(home, "rec");
    mkdirSync(bin, { recursive: true });
    mkdirSync(rec, { recursive: true });
    mkdirSync(join(home, "state"), { recursive: true });
    const tokenFile = join(home, "state", "main-bridge-token");
    writeFileSync(tokenFile, "left-by-a-killed-loop\n");

    // Records what the session would see, then ends the loop on its second start.
    const fakeClaude = join(bin, "claude");
    writeFileSync(fakeClaude, `#!/bin/bash
[ "$1" = "--version" ] && { echo "0.0.0 (fake)"; exit 0; }
n=$(( $(cat "$REC/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$REC/count"
printf '%s\\n%s\\n%s\\n' "\${EMBERVY_MAIN_BRIDGE_TOKEN-<unset>}" "$(cat "$EMBERVY_HOME/state/main-bridge-token" 2>/dev/null || echo '<none>')" "$(stat -c %a "$EMBERVY_HOME/state/main-bridge-token" 2>/dev/null || echo '<none>')" > "$REC/run-$n"
if [ "$n" -ge 2 ]; then kill -TERM "$PPID"; exit 143; fi
exit 0
`);
    chmodSync(fakeClaude, 0o755);

    // A leftover temporary file readable by everyone, and the loop started
    // under the common umask 022: the token must still come out 0600.
    writeFileSync(`${tokenFile}.tmp`, "left-by-a-killed-loop\n", { mode: 0o644 });
    const proc = Bun.spawn(["setsid", "bash", "-c", 'umask 022 && exec bash "$0"', LOOP], {
      cwd: home,
      env: {
        PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
        HOME: home,
        EMBERVY_HOME: home,
        REC: rec,
        TMUX: "test", // skip the tmux wrapper
        EMBERVY_TMUX_SESSION: `main-bridge-token-test-${process.pid}`,
        EMBERVY_APP_HOST: "127.0.0.1",
        EMBERVY_APP_PORT: "9",
        EMBERVY_APP_SERVICE: "main-bridge-token-test.service",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      const end = Date.now() + 20_000;
      while (Date.now() < end && proc.exitCode === null) await Bun.sleep(100);
      expect(proc.exitCode).toBe(0);
    } finally {
      try { process.kill(-proc.pid, "SIGKILL"); } catch {} // the dialog pollers
    }

    const runs = [1, 2].map((n) => readFileSync(join(rec, `run-${n}`), "utf8").trim().split("\n"));
    for (const [env, file, mode] of runs) {
      expect(env).toMatch(/\S{16,}/);
      expect(env).not.toBe("<unset>");
      expect(file).toBe(env);
      expect(mode).toBe("600");
    }
    expect(runs[0][0]).not.toBe("left-by-a-killed-loop");
    expect(runs[1][0]).not.toBe(runs[0][0]);
    expect(existsSync(tokenFile)).toBe(false);
  }, 30_000);
});
