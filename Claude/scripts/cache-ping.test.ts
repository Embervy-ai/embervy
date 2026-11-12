import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const script = join(import.meta.dir, "cache-ping.sh");
const roots: string[] = [];
const processes: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
  for (const child of processes.splice(0)) { child.kill(); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function paneSession(root: string, name: string) {
  const executable = join(root, name);
  // A named stand-in process: a script keeps its own file name in the process table on every system,
  // a link to sleep does not where sleep is one multi-call program.
  writeFileSync(executable, "#!/bin/bash\ntrap 'kill \"$s\" 2>/dev/null; exit 0' TERM INT\n/bin/sleep \"$1\" & s=$!\nwait \"$s\"\n", { mode: 0o755 });
  const child = Bun.spawn(["setsid", "bash", "-c", `
    trap 'kill "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 0' TERM INT
    "$1" 60 & child=$!
    echo $$ > "$2"
    wait "$child"
  `, "fixture", executable, join(root, "pane-pid")], { stdout: "ignore", stderr: "pipe" });
  processes.push(child);
  // Wait for exec as well as setsid so the real process-table query is deterministic.
  const ready = Bun.spawnSync(["bash", "-c", `
    for ((i=0; i<200; i++)); do
      if [ -s "$1/pane-pid" ] && pgrep -s "$(cat "$1/pane-pid")" -x "$2" >/dev/null; then exit 0; fi
      sleep 0.01
    done
    exit 1
  `, "fixture", root, name], { stdout: "pipe", stderr: "pipe" });
  expect(ready.exitCode).toBe(0);
  return readFileSync(join(root, "pane-pid"), "utf8").trim();
}
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const event = (type: string, minutes: number) => JSON.stringify({ type, timestamp: ago(minutes), message: { role: type, content: "test" } });

function fixture(processName = "claude") {
  const root = mkdtempSync(join(tmpdir(), "embervy-cache-ping-"));
  roots.push(root);
  paneSession(root, processName);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const project = join(home, ".claude/projects", root.replaceAll("/", "-"));
  for (const dir of [home, bin, project, join(root, "Claude/app"), join(root, "state")]) mkdirSync(dir, { recursive: true });
  const envFile = join(root, "Claude/app/.env");
  const session = join(project, "main.jsonl");
  const callsFile = join(root, "tmux-calls");
  const logFile = join(root, "logs/cache-ping.log");
  const config = (enabled = "1", minutes = "55") => writeFileSync(envFile, `EMBERVY_CACHE_PING=${enabled}\nEMBERVY_CACHE_PING_MINUTES=${minutes}\nEMBERVY_TMUX_SESSION=fixture-session\n`);
  config();
  writeFileSync(session, event("assistant", 70) + "\n");
  writeFileSync(join(root, "pane"), "Claude Code\n❯ \n────────────────────\n? for shortcuts\n");
  writeFileSync(join(bin, "tmux"), `#!/usr/bin/env python3
import json, os, sys
root=os.environ['FIXTURE_ROOT']
args=sys.argv[1:]
if args[:2] != ['-L','fixture-socket']: sys.exit(90)
args=args[2:]
with open(root+'/tmux-calls','a') as f: f.write(json.dumps(args)+'\\n')
def read(name, default=''):
    try:
        with open(root+'/'+name) as f: return f.read()
    except FileNotFoundError: return default
if args[0]=='display-message':
    field=args[-1]
    print({'#{pane_id}':'%42', '#{pane_current_command}':read('command','claude'), '#{pane_pid}':read('pane-pid').strip(), '#{pane_in_mode}':read('copy-mode','0')}[field])
elif args[0]=='capture-pane':
    if read('capture-fails'): sys.exit(1)
    if read('injected'):
        if read('dialog-after'): print('Do you want to allow this?\\n❯ 1. Yes\\nEnter to confirm')
        else:
            text=read('injected')
            print('❯ '+text[:65])
            for i in range(65,len(text),65): print('  '+text[i:i+65])
            print('────────────────────')
    else: print(read('pane'))
elif args[0]=='send-keys' and '-l' in args:
    with open(root+'/injected','w') as f: f.write(args[-1])
    if read('cut-after'):
        with open(root+'/state/last_cut_session','w') as f: f.write('main.jsonl')
    if read('stop-after'):
        import subprocess
        subprocess.run(['pkill','-TERM','-s',read('pane-pid').strip(),'-x','claude'],check=True)
`);
  chmodSync(join(bin, "tmux"), 0o755);
  // No inherited application paths, provider credentials or real tmux socket.
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, EMBERVY_HOME: root, FIXTURE_ROOT: root, EMBERVY_TMUX_SOCKET: "fixture-socket" };
  const run = () => {
    const result = Bun.spawnSync(["bash", script], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  };
  const calls = (): string[][] => existsSync(callsFile) ? readFileSync(callsFile, "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
  const sends = () => calls().filter(x => x[0] === "send-keys");
  const log = () => existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
  const put = (name: string, content: string) => writeFileSync(join(root, name), content);
  return { root, env, home, project, session, config, run, calls, sends, log, put };
}

function expectOneTurn(f: ReturnType<typeof fixture>) {
  const sends = f.sends();
  expect(sends.filter(x => x.includes("-l"))).toHaveLength(1);
  expect(sends.filter(x => x.at(-1) === "Enter")).toHaveLength(1);
  expect(sends).toHaveLength(2);
  expect(sends[0]).toContain("%42");
  expect(sends[0].at(-1)).toContain("[gateway:silent]");
  expect(f.log()).toContain("sent: cache keep-warm");
}

describe("Claude Code cache ping (fake tmux, temporary homes, no network)", () => {
  test("off means no tmux, no log, even with missing minutes", () => {
    const f = fixture(); f.config("0", ""); f.run();
    expect(f.calls()).toEqual([]); expect(f.log()).toBe("");
  });
  test("missing switch does not inherit an enabled setting", () => {
    const f = fixture(); f.put("Claude/app/.env", "");
    const p = Bun.spawnSync(["bash", script], { env: { ...f.env, EMBERVY_CACHE_PING: "1", EMBERVY_CACHE_PING_MINUTES: "55" } });
    expect(p.exitCode).toBe(0); expect(f.calls()).toEqual([]);
  });
  test("the switch in the house .env alone turns it on, as the installer writes it", () => {
    const f = fixture(); f.put("Claude/app/.env", "");
    f.put(".env", "EMBERVY_CACHE_PING=1\nEMBERVY_CACHE_PING_MINUTES=55\nEMBERVY_TMUX_SESSION=fixture-session\n");
    f.run(); expectOneTurn(f);
  });
  test("under threshold: no injection", () => {
    const f = fixture(); writeFileSync(f.session, event("assistant", 54)); f.run(); expect(f.calls()).toEqual([]);
  });
  test("idle status is logged at most hourly, without changing ping eligibility", () => {
    const f = fixture();
    writeFileSync(f.session, event("assistant", 12));
    f.run(); f.run(); f.run();
    expect(f.log().match(/idle 12m < 55m/g)).toHaveLength(1);
    const stamp = join(f.root, "state/cache-ping-idle-log");
    writeFileSync(stamp, String(Math.floor(Date.now() / 1000) - 3590));
    f.run();
    expect(f.log().match(/idle 12m < 55m/g)).toHaveLength(1);
    writeFileSync(stamp, String(Math.floor(Date.now() / 1000) - 3601));
    f.run();
    expect(f.log().match(/idle 12m < 55m/g)).toHaveLength(2);
    expect(f.calls()).toEqual([]);
    writeFileSync(f.session, event("assistant", 70));
    f.run(); expectOneTurn(f);
  });
  test.each([["1", "55", "enabled, threshold 55m"], ["0", "55", "disabled: EMBERVY_CACHE_PING is not 1"], ["1", "bad", "disabled: EMBERVY_CACHE_PING_MINUTES is empty or invalid"]])("watcher startup status: %s, %s", async (enabled, minutes, status) => {
    const f = fixture(); f.config(enabled, minutes);
    writeFileSync(f.session, event("assistant", 12));
    writeFileSync(join(f.root, "bin/sleep"), '#!/bin/bash\nif [ "$1" = 300 ]; then exec /bin/sleep 0.05; fi\nexec /bin/sleep "$@"\n', { mode: 0o755 });
    const watcher = Bun.spawn(["bash", script, "--watch"], { env: f.env, stdout: "pipe", stderr: "pipe" });
    try {
      for (let i = 0; i < 100 && !f.log(); i++) await Bun.sleep(20);
      expect(f.log()).toContain(status);
      if (enabled === "1" && minutes === "55") {
        for (let i = 0; i < 100 && !f.log().includes("idle 12m < 55m"); i++) await Bun.sleep(20);
        expect(f.log()).toContain("idle 12m < 55m");
      }
      await Bun.sleep(300);
      const lines = f.log().trim().split("\n");
      expect(lines.filter(line => line.includes(status))).toHaveLength(1);
      expect(lines).toHaveLength(enabled === "1" && minutes === "55" ? 2 : 1);
      expect(f.calls()).toEqual([]);
    } finally {
      watcher.kill(); expect(await watcher.exited).toBe(0);
      expect(await new Response(watcher.stderr).text()).toBe("");
    }
  });
  test("over threshold: exactly one silent turn, pinned to the configured session", () => {
    const f = fixture(); f.run(); expectOneTurn(f);
    expect(f.calls()[0]).toContain("fixture-session");
  });
  test("a completed ping resets silence without a ping timestamp file", () => {
    const f = fixture(); f.run(); expectOneTurn(f);
    writeFileSync(f.session, event("assistant", 0)); f.run(); expectOneTurn(f);
  });
  test.each(["", "0", "-1", "abc", "2.5", "9999999999999999999999"])("invalid minutes %j: log, no tmux", minutes => {
    const f = fixture(); f.config("1", minutes); f.run();
    expect(f.calls()).toEqual([]); expect(f.log()).toContain("empty or invalid");
  });
  test.each(["Do you want to allow this?\n❯ 1. Yes\nEnter to confirm", "❯ \nAllow once", "❯ \nEsc to interrupt", "❯ draft from user", "unknown UI"])("unsafe pane %j: no keys", pane => {
    const f = fixture(); f.put("pane", pane); f.run(); expect(f.sends()).toEqual([]);
    expect(f.log()).toContain("approval dialog");
  });
  test("assistant timestamp wins over a just-touched mtime", () => {
    const f = fixture(); utimesSync(f.session, new Date(), new Date()); f.run(); expectOneTurn(f);
  });
  test("last assistant wins over older assistant and old mtime", () => {
    const f = fixture(); writeFileSync(f.session, event("assistant", 120) + "\n" + event("assistant", 2) + "\n{partial");
    const old = new Date(Date.now() - 180 * 60_000); utimesSync(f.session, old, old);
    f.run(); expect(f.sends()).toEqual([]);
  });
  test("missing assistant timestamp falls back to mtime", () => {
    const f = fixture(); writeFileSync(f.session, '{"type":"assistant"}\n');
    const old = new Date(Date.now() - 70 * 60_000); utimesSync(f.session, old, old);
    f.run(); expectOneTurn(f);
  });
  test("newer SDK and agent JSONL files are not main sessions", () => {
    const f = fixture();
    writeFileSync(join(f.project, "helper.jsonl"), '{"entrypoint":"sdk-cli"}\n' + event("assistant", 0));
    writeFileSync(join(f.project, "agent-helper.jsonl"), event("assistant", 0));
    f.run(); expectOneTurn(f);
  });
  test("pending user turn prevents injection even before a busy UI appears", () => {
    const f = fixture(); writeFileSync(f.session, event("assistant", 80) + "\n" + event("user", 1));
    f.run(); expect(f.calls()).toEqual([]);
  });
  test("no main session: no keys", () => {
    const f = fixture(); rmSync(f.session); f.run(); expect(f.calls()).toEqual([]);
  });
  test("watchdog cut marker suppresses ping", () => {
    const f = fixture(); f.put("state/last_cut_session", "main.jsonl"); f.run(); expect(f.calls()).toEqual([]);
    expect(f.log()).toContain("cut/respawn");
  });
  test("a bash-labelled pane with a claude child receives a ping", () => {
    const f = fixture(); f.put("command", "bash"); f.run(); expectOneTurn(f);
  });
  test("a bash-labelled pane with a node child retains compatibility", () => {
    const f = fixture("node"); f.put("command", "bash"); f.run(); expectOneTurn(f);
  });
  test("respawn shell without an agent is never a target", () => {
    const f = fixture("sleep"); f.put("command", "bash"); f.run(); expect(f.sends()).toEqual([]);
    expect(f.log()).toContain("skip: Claude is not foreground (respawn or stopped)");
  });
  test("a claude in another session does not make this pane safe", () => {
    const foreign = fixture();
    const f = fixture("sleep"); f.put("command", "bash");
    expect(readFileSync(join(f.root, "pane-pid"), "utf8")).not.toBe(readFileSync(join(foreign.root, "pane-pid"), "utf8"));
    f.run(); expect(f.sends()).toEqual([]);
    expect(f.log()).toContain("skip: Claude is not foreground (respawn or stopped)");
  });
  test("a similar process name is not an exact match", () => {
    const f = fixture("claude-helper"); f.put("command", "bash"); f.run(); expect(f.sends()).toEqual([]);
  });
  test("pane capture failure is fail closed", () => {
    const f = fixture(); f.put("capture-fails", "1"); f.run(); expect(f.sends()).toEqual([]);
  });
  test("copy mode is cancelled before prompt injection", () => {
    const f = fixture(); f.put("copy-mode", "1"); f.run();
    expect(f.sends()[0]).toEqual(["send-keys", "-X", "-t", "%42", "cancel"]);
    expect(f.sends().filter(x => x.includes("-l"))).toHaveLength(1);
  });
  test.each(["dialog-after", "cut-after", "stop-after"])("%s during delay: no blind Enter", marker => {
    const f = fixture(); f.put(marker, "1"); f.run();
    expect(f.sends().filter(x => x.includes("-l"))).toHaveLength(1);
    expect(f.sends().some(x => x.at(-1) === "Enter")).toBe(false);
    expect(f.log()).toContain("Enter withheld");
  });
  test.each([[1, 100, false], [16, 100, true], [1, 99, true], [-1, 100, true]])("quota age=%i used=%i send=%j", (age, used, send) => {
    const f = fixture();
    f.put("state/claude-statusline.json", JSON.stringify({ timestamp: ago(age as number), rate_limits: { five_hour: { used_percentage: used } } }));
    f.run();
    if (send) expectOneTurn(f);
    else { expect(f.sends()).toEqual([]); expect(f.log()).toContain("exhausted rate limit"); }
  });
  test("cutoff lock prevents all tmux access", async () => {
    const f = fixture();
    const holder = Bun.spawn(["python3", "-c", "import fcntl,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(30)", join(f.root, "state/claude-input.lock")], { env: f.env, stdout: "pipe" });
    try {
      const reader = holder.stdout.getReader(); await reader.read(); reader.releaseLock();
      f.run(); expect(f.calls()).toEqual([]); expect(f.log()).toContain("cut or another cache ping");
    } finally { holder.kill(); await holder.exited; }
  });
  test("watcher re-reads the switch and terminates its sleeping child", async () => {
    const f = fixture(); f.config("0");
    const sleep = join(f.root, "bin/sleep");
    writeFileSync(sleep, '#!/bin/bash\nif [ "$1" = 300 ]; then echo tick >> "$FIXTURE_ROOT/ticks"; exec /bin/sleep 0.1; fi\nexec /bin/sleep "$@"\n');
    chmodSync(sleep, 0o755);
    const watcher = Bun.spawn(["bash", script, "--watch"], { env: f.env, stdout: "pipe", stderr: "pipe" });
    async function until(check: () => boolean) {
      const deadline = Date.now() + 5000;
      while (!check() && Date.now() < deadline) await Bun.sleep(20);
      expect(check()).toBe(true);
    }
    try {
      await until(() => existsSync(join(f.root, "ticks")));
      expect(f.calls()).toEqual([]);
      expect(f.log()).toContain("disabled: EMBERVY_CACHE_PING is not 1");
      f.config("1");
      await until(() => f.log().includes("sent: cache keep-warm"));
      expectOneTurn(f);
      f.config("0");
      await Bun.sleep(300);
      const count = f.calls().length;
      await Bun.sleep(300);
      expect(f.calls()).toHaveLength(count);
    } finally {
      watcher.kill();
      expect(await watcher.exited).toBe(0);
      expect(await new Response(watcher.stderr).text()).toBe("");
    }
    const ticks = readFileSync(join(f.root, "ticks"), "utf8");
    await Bun.sleep(200);
    expect(readFileSync(join(f.root, "ticks"), "utf8")).toBe(ticks);
  }, 10000);
  test("loop owns watcher and stops it before finalize/respawn; cut shares lock", () => {
    const loop = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
    expect(loop).toContain('cache-ping.sh" --watch');
    expect(loop).toContain('rc=$?\n  stop_cache_ping\n');
    expect(loop).toContain("trap 'stop_cache_ping;");
    expect(readFileSync(join(import.meta.dir, "cutoff.sh"), "utf8")).toContain('exec 9>"$EMBERVY_HOME/state/claude-input.lock"');
  });
  test("shell scripts parse", () => {
    for (const name of ["cache-ping.sh", "start-claude-loop.sh", "cutoff.sh"]) {
      expect(Bun.spawnSync(["bash", "-n", join(import.meta.dir, name)]).exitCode).toBe(0);
    }
  });
});
