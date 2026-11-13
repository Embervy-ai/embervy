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
    // The signal-reset launcher must retain its PID, but must not inherit the
    // marker itself: only exec's target environment contains it. Runtime checks
    // below cover the launcher, observer, helpers and both finalize paths.
    expect(loop).toContain('os.execvpe("claude", ["claude"] + sys.argv[2:], dict(os.environ, EMBERVY_MAIN_BRIDGE_TOKEN=token))');
    expect(loop).toContain('\' "$MAIN_BRIDGE_TOKEN_FILE" "${CLAUDE_ARGS[@]}" "${PASS_ARGS[@]}" <&0 &');
    expect(loop).not.toMatch(/EMBERVY_MAIN_BRIDGE_TOKEN=[^\n]*python3/);
    expect(loop).not.toMatch(/os\.environ\s*\[[^\]]*EMBERVY_MAIN_BRIDGE_TOKEN/);
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

    // Observe actual environments, not just the spelling of the launch command.
    // These commands are used by the loop, not by our mock main Claude.
    for (const command of ["python3", "bash"]) {
      writeFileSync(join(bin, command), `#!/bin/bash
printf '%s|%s\\n' '${command}' "\${EMBERVY_MAIN_BRIDGE_TOKEN-<unset>}" >> "$REC/helpers"
exec /usr/bin/${command} "$@"
`, { mode: 0o755 });
    }
    writeFileSync(join(bin, "tmux"), `#!/bin/bash
printf 'tmux|%s\\n' "\${EMBERVY_MAIN_BRIDGE_TOKEN-<unset>}" >> "$REC/helpers"
shift 2 # house socket arguments
case "$1" in
  display-message) printf '%%1\\n';;
  capture-pane)
    printf 'observer|%s\\n' "\${EMBERVY_MAIN_BRIDGE_TOKEN-<unset>}" >> "$REC/helpers"
    touch "$REC/observed-$(cat "$REC/count")"
    printf '❯ ';;
esac
`, { mode: 0o755 });
    // Inspect the launcher immediately before exec as well as at entry. Reading
    // the file to build exec's env must not mutate the launcher's own environment.
    writeFileSync(join(home, "sitecustomize.py"), `import os, json
real_exec = os.execvpe
def checked_exec(file, args, env):
    with open(os.path.join(os.environ["REC"], "execs"), "a") as out:
        out.write(json.dumps({"target": file, "own": os.environ.get("EMBERVY_MAIN_BRIDGE_TOKEN"), "token": env.get("EMBERVY_MAIN_BRIDGE_TOKEN"), "args": args}) + "\\n")
    return real_exec(file, args, env)
os.execvpe = checked_exec
`);
    const scripts = join(home, "Claude/scripts");
    mkdirSync(scripts, { recursive: true });
    for (const script of ["cache-ping.sh", "birth-prompt.sh", "session-to-rag.sh"]) {
      writeFileSync(join(scripts, script), `#!/bin/bash
printf '${script}|%s\\n' "\${EMBERVY_MAIN_BRIDGE_TOKEN-<unset>}" >> "$REC/helpers"
${script === "session-to-rag.sh" ? '[ ! -e "$EMBERVY_HOME/state/main-bridge-token" ] || exit 99\nprintf "finalized\\n" >> "$REC/finalized"' : ""}
`, { mode: 0o755 });
    }
    writeFileSync(join(home, "session.jsonl"), "{}\n");
    writeFileSync(join(scripts, "latest_main_session.py"), `import os
if os.path.exists(os.path.join(os.environ["REC"], "count")):
    assert "EMBERVY_MAIN_BRIDGE_TOKEN" not in os.environ
    assert not os.path.exists(os.path.join(os.environ["EMBERVY_HOME"], "state/main-bridge-token"))
    print(os.path.join(os.environ["EMBERVY_HOME"], "session.jsonl"))
`);
    writeFileSync(join(scripts, "extract_bridge.py"), `import os
assert "EMBERVY_MAIN_BRIDGE_TOKEN" not in os.environ
assert not os.path.exists(os.path.join(os.environ["EMBERVY_HOME"], "state/main-bridge-token"))
`);

    // Records what the session would see, then ends the loop on its second start.
    const fakeClaude = join(bin, "claude");
    writeFileSync(fakeClaude, `#!/bin/bash
[ "$1" = "--version" ] && { printf 'version|%s\\n' "\${EMBERVY_MAIN_BRIDGE_TOKEN-<unset>}" >> "$REC/helpers"; echo "0.0.0 (fake)"; exit 0; }
n=$(( $(cat "$REC/count" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$REC/count"
printf '%s\\n%s\\n%s\\n' "\${EMBERVY_MAIN_BRIDGE_TOKEN-<unset>}" "$(cat "$EMBERVY_HOME/state/main-bridge-token" 2>/dev/null || echo '<none>')" "$(stat -c %a "$EMBERVY_HOME/state/main-bridge-token" 2>/dev/null || echo '<none>')" > "$REC/run-$n"
for ((i=0; i<200; i++)); do
  [ -e "$REC/observed-$n" ] && break
  sleep 0.01
done
[ -e "$REC/observed-$n" ] || exit 91
if [ "$n" -ge 2 ]; then
  rm -f "$EMBERVY_HOME/state/last_cutover_ts"
  kill -TERM "$PPID"; exit 143
fi
exit 0
`);
    chmodSync(fakeClaude, 0o755);

    // A leftover temporary file readable by everyone, and the loop started
    // under the common umask 022: the token must still come out 0600.
    writeFileSync(`${tokenFile}.tmp`, "left-by-a-killed-loop\n", { mode: 0o644 });
    const proc = Bun.spawn(["setsid", "/bin/bash", "-c", 'umask 022 && exec /bin/bash "$0"', LOOP], {
      cwd: home,
      env: {
        PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`,
        HOME: home,
        EMBERVY_HOME: home,
        REC: rec,
        PYTHONPATH: home,
        EMBERVY_MAIN_BRIDGE_TOKEN: "inherited-session-must-not-reach-helpers",
        EMBERVY_TMUX_SOCKET: "test",
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
    const helpers = readFileSync(join(rec, "helpers"), "utf8").trim().split("\n").map(line => line.split("|"));
    for (const [, token] of helpers) expect(token).toBe("<unset>");
    const names = new Set(helpers.map(([name]) => name));
    for (const name of ["python3", "bash", "tmux", "observer", "version", "cache-ping.sh", "birth-prompt.sh", "session-to-rag.sh"]) {
      expect(names.has(name)).toBe(true);
    }
    const execs = readFileSync(join(rec, "execs"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(execs).toHaveLength(2);
    for (const [i, exec] of execs.entries()) {
      expect(exec.target).toBe("claude");
      expect(exec.own).toBeNull();
      expect(exec.token).toBe(runs[i][0]);
      expect(exec.args.join(" ")).not.toContain(exec.token);
    }
    // One natural exit and one TERM: both must actually reach finalize, after
    // token removal (the fixture refuses to record success otherwise).
    expect(readFileSync(join(rec, "finalized"), "utf8").trim().split("\n")).toEqual(["finalized", "finalized"]);
  }, 30_000);
});
