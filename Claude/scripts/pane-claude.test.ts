import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtime = join(import.meta.dir, "../../shared/scripts/house-runtime.sh");
const loop = join(import.meta.dir, "start-claude-loop.sh");
const roots: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of processes.splice(0)) { child.kill(); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pane-claude-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env python3
import json, os, sys
root=os.environ['FIXTURE_ROOT']
args=sys.argv[1:]
with open(root+'/calls','a') as f: f.write(json.dumps(args)+'\\n')
if args[:2] != ['-L','fixture-socket']: sys.exit(90)
args=args[2:]
if args[0]=='has-session': sys.exit(0)
if args[0]=='list-panes':
    if '-s' not in args or args[-1]!='#{pane_id} #{pane_current_command}': sys.exit(91)
    print(open(root+'/panes').read(),end='')
elif args[0]=='display-message':
    if args[-1]!='#{pane_pid}': sys.exit(92)
    target=args[args.index('-t')+1]
    print(open(root+'/'+target).read().strip())
elif args[0] not in ['attach','kill-session','new-session']: sys.exit(93)
`);
  chmodSync(join(bin, "tmux"), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: root, EMBERVY_HOME: root, FIXTURE_ROOT: root,
    EMBERVY_TMUX_SOCKET: "fixture-socket", EMBERVY_TMUX_SESSION: "fixture-session" };
  const put = (name: string, value: string) => writeFileSync(join(root, name), value);
  const calls = (): string[][] => existsSync(join(root, "calls"))
    ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
  function session(target: string, name: string) {
    const dir = join(root, target);
    mkdirSync(dir);
    // A named stand-in process: a script keeps its own file name in the process table on every system,
    // a link to sleep does not where sleep is one multi-call program.
    writeFileSync(join(dir, name), "#!/bin/bash\ntrap 'kill \"$s\" 2>/dev/null; exit 0' TERM INT\n/bin/sleep \"$1\" & s=$!\nwait \"$s\"\n", { mode: 0o755 });
    const child = Bun.spawn(["setsid", "bash", "-c", `
      trap 'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
      "$1" 60 & child=$!
      echo $$ > "$2"
      wait "$child"
    `, "fixture", join(dir, name), join(dir, "pid")], { env, stdout: "ignore", stderr: "pipe" });
    processes.push(child);
    const ready = Bun.spawnSync(["bash", "-c", `
      for ((i=0; i<200; i++)); do
        if [ -s "$1" ] && pgrep -s "$(cat "$1")" -x "$2" >/dev/null; then exit 0; fi
        sleep 0.01
      done
      exit 1
    `, "fixture", join(dir, "pid"), name], { env, stdout: "pipe", stderr: "pipe" });
    expect(ready.exitCode).toBe(0);
    return readFileSync(join(dir, "pid"), "utf8").trim();
  }
  function runLoop() {
    // Only stdout needs a PTY to exercise the real interactive attach branch.
    const result = Bun.spawnSync(["python3", "-c", `
import os, pty, subprocess, sys
master, slave=pty.openpty()
try:
    result=subprocess.run(['bash',sys.argv[1]],stdout=slave,stderr=subprocess.PIPE,timeout=10)
    sys.stderr.buffer.write(result.stderr)
    sys.exit(result.returncode)
finally:
    os.close(slave)
    os.close(master)
`, loop], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return calls().map(args => args[2]);
  }
  function check(target = "%42") {
    return Bun.spawnSync(["bash", "-c", 'source "$1"; embervy_pane_has_claude "$2"', "fixture", runtime, target],
      { env, stdout: "pipe", stderr: "pipe" });
  }
  return { root, env, put, session, calls, runLoop, check };
}

test("loop attaches to a bash-labelled agent in any session window without killing", () => {
  const f = fixture();
  f.put("%41", f.session("empty", "sleep"));
  f.put("%42", f.session("agent", "claude"));
  f.put("panes", "%41 bash\n%42 bash\n");
  const commands = f.runLoop();
  expect(commands).toContain("attach");
  expect(commands).not.toContain("kill-session");
  expect(commands).not.toContain("new-session");
  expect(f.calls().find(args => args[2] === "attach")).toEqual(["-L", "fixture-socket", "attach", "-t", "=fixture-session"]);
});

test("loop replaces a shell-only session even when another session has an agent", () => {
  const f = fixture();
  f.session("foreign", "claude");
  f.put("%42", f.session("empty", "sleep"));
  f.put("panes", "%42 bash\n");
  const commands = f.runLoop();
  expect(commands).not.toContain("attach");
  expect(commands.filter(x => x === "kill-session")).toHaveLength(1);
  expect(commands.at(-1)).toBe("new-session");
});

test.each(["claude", "node", "vim"])("loop preserves an active %s command", command => {
  const f = fixture();
  f.put("%42", f.session("pane", command === "vim" ? "sleep" : command));
  f.put("panes", `%42 ${command}\n`);
  const commands = f.runLoop();
  expect(commands).toContain("attach");
  expect(commands).not.toContain("kill-session");
});

test("helper accepts a pane target and uses only its house socket and process session", () => {
  const f = fixture();
  f.put("fixture-session", f.session("agent", "claude"));
  const result = f.check("fixture-session");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
  expect(f.calls()).toEqual([["-L", "fixture-socket", "display-message", "-p", "-t", "fixture-session", "#{pane_pid}"]]);
});

test.each(["", "0", "-1", "not-a-pid"])("helper rejects invalid pane pid %j", pid => {
  const f = fixture(); f.put("%42", pid);
  const result = f.check();
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
});

test("vanished pid ownership and pane checks are quiet", async () => {
  const f = fixture();
  const child = Bun.spawn(["setsid", "/bin/true"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  expect(existsSync(`/proc/${child.pid}`)).toBe(false);
  f.put("%42", String(child.pid));
  const paneResult = f.check();
  expect(paneResult.exitCode).toBe(1);
  expect(paneResult.stdout.toString()).toBe("");
  expect(paneResult.stderr.toString()).toBe("");
  const result = Bun.spawnSync(["bash", "-c", 'source "$1"; embervy_owns_pid "$2"', "fixture", runtime, String(child.pid)],
    { env: f.env, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(1);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toBe("");
});
