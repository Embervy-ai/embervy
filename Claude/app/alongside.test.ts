import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { brainTmuxSocket, chatgptAuthFile, housePids, ownsProcess, tmuxCommand, tmuxSocket, videoBackendUrl } from "../../shared/scripts/house-runtime";
import { checkParallel } from "../../Brain/lock";
import "../scripts/inlet.test";
import "../../shared/scripts/reply-gateway.test";

const repo = resolve(import.meta.dir, "../..");
const root = mkdtempSync(join(tmpdir(), "alongside-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let serial = 0;
function fixture() {
  const home = join(root, String(++serial));
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, EMBERVY_HOME: home };
  const fake = (name: string, text: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${text}\n`, { mode: 0o755 });
  fake("systemctl", "exit 0");
  const run = (code: string, extra = {}, input = "{}") => Bun.spawnSync(["bash", "-c", code], {
    cwd: home, env: { ...env, ...extra }, stdin: Buffer.from(input), stdout: "pipe", stderr: "pipe",
  });
  return { home, bin, env, fake, run };
}
const lib = join(repo, "shared/scripts/house-runtime.sh");

test("the app builds every terminal command with the selected named socket", () => {
  const source = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const selection = source.match(/^const TERMINAL_TMUX_SOCKET =[\s\S]*?;\n/m)![0];
  const start = source.indexOf("function terminalCommand(");
  const command = source.slice(start, source.indexOf("\n}", start) + 2)
    .replace('command: "capture-pane" | "send-keys", args: string[]', "command, args")
    .replace("): string[]", ")");
  for (const brain of [false, true]) for (const socket of ["", "house-two"]) {
    const env = { EMBERVY_TMUX_SOCKET: socket };
    const build = new Function("BRAIN_HARNESS", "process", "envValue", "tmuxSocket", "brainTmuxSocket", "tmuxCommand", `
      ${selection}
      const TERMINAL_TMUX_SESSION = "resident";
      ${command}
      return terminalCommand;
    `)(brain, { env: {} }, (key: keyof typeof env) => env[key], tmuxSocket, brainTmuxSocket, tmuxCommand);
    for (const verb of ["capture-pane", "send-keys"]) {
      expect(build(verb, ["-p"])).toEqual(["tmux", "-L", socket || (brain ? "brain" : "embervy"), verb, "-t", "resident", "-p"]);
    }
  }
});

// The manual stays in the repository; the installer package leaves it out.
test.skipIf(!existsSync(join(repo, "INSTALL.md")))("installation house-session commands name their socket", () => {
  const docs = readFileSync(join(repo, "INSTALL.md"), "utf8");
  expect(docs).not.toMatch(/\btmux (?:send-keys|capture-pane|attach)\b/);
  expect(docs).toContain("tmux -L brain ls; tmux ls");
});

test("socket defaults do not turn the first house into a neighbour", () => {
  expect(tmuxSocket("")).toBe("embervy");
  expect(brainTmuxSocket("")).toBe("brain");
  expect(brainTmuxSocket("brain-two")).toBe("brain-two");
  expect(chatgptAuthFile({ HOME: "/home/first", EMBERVY_HOME: "/house" })).toBe("/home/first/.codex/auth.json");
  const f = fixture();
  expect(f.run(`. '${lib}'; embervy_tmux_socket; embervy_chatgpt_auth`).stdout.toString().trim())
    .toBe(`embervy\n${f.home}/.codex/auth.json`);
});

for (const brain of [false, true]) {
  for (const socket of ["", "house-two"]) {
    test(`${brain ? "Brain" : "Claude"} wrapper leaves the default server alone, socket=${socket || "unset"}`, () => {
      const f = fixture();
      writeFileSync(join(f.home, "foreign-brain"), "alive");
      f.fake("tmux", `printf '%s\\n' "$*" >> "$EMBERVY_HOME/tmux.calls"
if [ "$1" != -L ]; then rm -f "$EMBERVY_HOME/foreign-brain"; exit 99; fi
exit 1`);
      const path = brain ? "Brain/scripts/brain-loop-wrapper.sh" : "Claude/scripts/loop-wrapper.sh";
      expect(f.run(`bash '${repo}/${path}'`, {
        BRAIN_HOME: f.home, BRAIN_NO_ENV_FILE: "1",
        BRAIN_TMUX_SOCKET: socket, EMBERVY_TMUX_SOCKET: socket,
      }).exitCode).toBe(1);
      expect(readFileSync(join(f.home, "foreign-brain"), "utf8")).toBe("alive");
      const own = socket || (brain ? "brain" : "embervy");
      const calls = readFileSync(join(f.home, "tmux.calls"), "utf8").trim().split("\n");
      expect(calls.some(call => call.includes("new-session"))).toBe(true);
      expect(calls.every(call => call.startsWith(`-L ${own} `))).toBe(true);
    });
  }
  for (const same of [false, true]) {
    test(`${brain ? "Brain" : "Claude"} wrapper ${same ? "retains own" : "refuses foreign"} server`, () => {
      const f = fixture();
      f.fake("cmp", `exit ${same ? 0 : 1}`);
      f.fake("tmux", `echo "$*" >> "$EMBERVY_HOME/tmux.calls"
case "$3" in
  list-sessions) echo ${process.pid} ;;
  has-session) if [ -f "$EMBERVY_HOME/checked" ]; then exit 1; else touch "$EMBERVY_HOME/checked"; fi ;;
  *) exit 99 ;;
esac`);
      const path = brain ? "Brain/scripts/brain-loop-wrapper.sh" : "Claude/scripts/loop-wrapper.sh";
      const r = f.run(`bash '${repo}/${path}'`, { BRAIN_HOME: f.home, BRAIN_NO_ENV_FILE: "1" });
      expect(r.exitCode).toBe(same ? 0 : 1);
      expect(r.stderr.toString().includes("refusing tmux server outside own cgroup")).toBe(!same);
      expect(readFileSync(join(f.home, "tmux.calls"), "utf8")).not.toMatch(/new-session|kill-session|kill-server/);
    });
  }
}

for (const socket of ["", "house-two"]) {
  test(`tmux commands and auth defaults, socket=${socket || "unset"}`, () => {
    const f = fixture();
    f.fake("tmux", 'printf "%s\\n" "$*" >> "$EMBERVY_HOME/tmux.calls"; exit 1');
    const extra = { EMBERVY_TMUX_SOCKET: socket, TMUX: "/tmp/tmux-0/default,1,0" };
    for (const script of ["loop-wrapper.sh", "start-claude-loop.sh"]) {
      f.run(`bash '${repo}/Claude/scripts/${script}'`, extra);
    }
    f.run(`. '${repo}/Claude/scripts/loop-dialog.sh'; LOG=/dev/null; loop_dialog_step 'Loading development channels I am using this for local development' target`, extra);
    const calls = readFileSync(join(f.home, "tmux.calls"), "utf8").trim().split("\n");
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) expect(call.startsWith(`-L ${socket || "embervy"} `)).toBe(true);
    expect(tmuxCommand(["capture-pane"], socket)).toEqual(["tmux", "-L", socket || "embervy", "capture-pane"]);
    const auth = new TextDecoder().decode(f.run(`. '${lib}'; embervy_chatgpt_auth`, extra).stdout).trim();
    expect(auth).toBe(socket ? `${f.home}/state/chatgpt-auth.json` : `${f.home}/.codex/auth.json`);
    expect(chatgptAuthFile({ ...f.env, ...extra })).toBe(auth);
    expect(chatgptAuthFile({ ...f.env, ...extra, CHATGPT_AUTH_FILE: "/custom/login.json" })).toBe("/custom/login.json");
  });

  test(`switch backend reads house unit and auth from file, socket=${socket || "unset"}`, () => {
    const f = fixture();
    mkdirSync(join(f.home, "Claude/app"), { recursive: true });
    mkdirSync(join(f.home, socket ? "state" : ".codex"), { recursive: true });
    writeFileSync(join(f.home, socket ? "state/chatgpt-auth.json" : ".codex/auth.json"), "{}");
    writeFileSync(join(f.home, "Claude/app/.env"), socket ? "EMBERVY_TMUX_SOCKET=house-two\nEMBERVY_LOOP_SERVICE=embervy-two-loop\n" : "");
    f.fake("systemctl", 'printf "%s" "$*" > "$EMBERVY_HOME/unit.calls"');
    expect(f.run(`bash '${repo}/Claude/scripts/switch-backend.sh' --to=gpt`).exitCode).toBe(0);
    expect(readFileSync(join(f.home, "unit.calls"), "utf8")).toBe(`restart ${socket ? "embervy-two-loop" : "embervy-loop.service"}`);
  });
}

test("Brain wrappers never use default tmux and use the named socket", () => {
  for (const socket of ["", "brain-two"]) {
    const f = fixture();
    f.fake("tmux", 'printf "%s\\n" "$*" >> "$EMBERVY_HOME/tmux.calls"; exit 1');
    for (const script of ["brain-loop-wrapper.sh", "brain-loop.sh"]) {
      f.run(`bash '${repo}/Brain/scripts/${script}'`, {
        BRAIN_HOME: f.home, BRAIN_NO_ENV_FILE: "1", BRAIN_TMUX_SESSION: "resident", BRAIN_TMUX_SOCKET: socket,
        TMUX: "/tmp/tmux-0/foreign,1,0",
      });
    }
    const calls = readFileSync(join(f.home, "tmux.calls"), "utf8").trim().split("\n");
    expect(calls.length).toBe(5);
    for (const call of calls) expect(call.startsWith(`-L ${socket || "brain"} `)).toBe(true);
    for (const call of calls.filter(call => !call.includes("list-sessions"))) expect(call).toContain("resident");
  }
});

for (const mode of ["unknown", "no-claude", "available", "current", "claude-code", "gpt-code"]) {
  test(`Claude auth polling follows the house capability: ${mode}`, async () => {
    const source = readFileSync(join(import.meta.dir, "public/app.js"), "utf8");
    const part = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    const calls: string[] = [], rendered: unknown[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const data = url === "/api/internal/model"
        ? mode === "claude-code" ? { ok: true, model: null }
          : { ok: true, switchable: false, substrate: mode === "gpt-code" ? "gpt" : "brain" }
        : url === "/api/brain/heads"
          ? { current: { head: mode === "current" ? "claude" : "gpt" }, heads: [{ name: "claude", available: mode === "available", current: mode === "current" }] }
          : { expired: true, kept: true };
      return { ok: true, status: 200, json: async () => data };
    };
    const h = new Function("fetch", "renderClaudeAuth", `
      let claudeAuthEnabled = false;
      let brainMenuLoadSeq = 0, brainMenuLoading, brainMenuError, brainMenuData;
      const modelToggle = { hidden: false, options: [] };
      const showBrainMenuButton = () => {}, renderBrainMenu = () => {}, bmResetSelection = () => {};
      const bmSel = {}, bmHead = () => null, bmSelectedModel = () => null;
      ${part("  async function loadBrainMenu(", "  function bmReloadSoon(")}
      ${part("  async function syncModel()", "  if (modelToggle) {")}
      ${part("  async function pollClaudeAuth()", "  async function sendClaudeAuth(")}
      return { syncModel, pollClaudeAuth };
    `)(fetch, (data: unknown) => rendered.push(data));
    if (mode !== "unknown") await h.syncModel();
    await h.pollClaudeAuth();
    await h.pollClaudeAuth();
    const enabled = ["available", "current", "claude-code"].includes(mode);
    expect(calls.filter(url => url === "/api/claude-auth").length).toBe(enabled ? 2 : 0);
    expect(rendered.length).toBe(enabled ? 2 : 0);
    if (enabled) expect(rendered[0]).toEqual({ expired: true, kept: true });
  });
}

test("browser default port and house port are read without starting a browser", () => {
  const f = fixture();
  for (const port of ["", "4155"]) {
    const code = "import runpy,json; m=runpy.run_path(" + JSON.stringify(join(repo, "shared/tools/browser/browse.py")) + ",run_name='test'); print(m['paths']()['port'])";
    const r = Bun.spawnSync(["python3", "-c", code], { env: { ...f.env, EMBERVY_BROWSER_PORT: port }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(new TextDecoder().decode(r.stdout).trim()).toBe(port || "3055");
  }
});

test("process attribution excludes prefix siblings and unknown processes", () => {
  const f = fixture();
  f.fake("pgrep", "printf '101\\n202\\n303\\n'");
  f.fake("readlink", `case "$*" in */proc/101/cwd) echo '${f.home}/Claude';; */proc/202/cwd) echo '${f.home}-other/Claude';; */proc/303/cwd) exit 1;; *) /usr/bin/readlink "$@";; esac`);
  const r = f.run(`. '${lib}'; embervy_house_pids -f claude`);
  expect(new TextDecoder().decode(r.stdout).trim()).toBe("101");
  for (const pid of [101, 202, 303]) {
    expect(ownsProcess(pid, f.home, {
      cwd: p => p === 101 ? `${f.home}/Claude` : p === 202 ? `${f.home}-other/Claude` : "",
      argv: () => [],
    })).toBe(pid === 101);
  }
  expect(ownsProcess(404, f.home, { cwd: () => "/", argv: () => ["bun", `${f.home}/shared/adapter.ts`] })).toBe(true);
  expect(ownsProcess(404, f.home, { cwd: () => "/", argv: () => ["bun", `${f.home}-other/shared/adapter.ts`] })).toBe(false);
  const probes = { readLock: () => "202", isAlive: () => true, cmdline: () => "bun brain.ts", environ: () => [], stdinTarget: () => "/dev/pts/1", pgrep: () => "202", owns: (pid: number) => pid === 101 };
  const input = { lockFile: "lock", ownPid: 1, sterile: false, parallelPattern: "brain.ts", allowParallel: false };
  expect(checkParallel(input, probes).blocked).toBe(false);
  expect(checkParallel(input, { ...probes, pgrep: () => "202\n101" }).blocked).toBe(true);
});

test("cutoff signals only the attributed original PID, including escalation", () => {
  const f = fixture();
  mkdirSync(join(f.home, "Claude/scripts"), { recursive: true });
  const transcript = join(f.home, "main.jsonl");
  writeFileSync(transcript, "{}");
  writeFileSync(join(f.home, "Claude/scripts/session-to-rag.sh"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  f.fake("python3", `case "$1" in *latest_main_session.py) echo '${transcript}';; esac`);
  f.fake("sleep", "exit 0");
  f.fake("pgrep", "printf '101\\n202\\n'");
  f.fake("readlink", `case "$*" in */proc/101/cwd) echo '${f.home}';; */proc/202/cwd) echo '${f.home}-other';; *) /usr/bin/readlink "$@";; esac`);
  const result = f.run(`kill() { printf '%s\\n' "$*" >> "$EMBERVY_HOME/kills"; }; export -f kill; bash '${repo}/Claude/scripts/cutoff.sh'`);
  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(f.home, "kills"), "utf8").trim().split("\n")).toEqual(["-TERM 101", "-KILL 101"]);
  const alive = f.run(`bash '${repo}/Claude/scripts/context_watchdog.sh' --check-alive`);
  expect(new TextDecoder().decode(alive.stdout).trim()).toBe("1");
});

test("video proxy uses the configured port for every media route", () => {
  for (const path of ["/watch", "/listen", "/audio"]) {
    expect(videoBackendUrl(path, {})).toBe(`http://localhost:3032${path}`);
    expect(videoBackendUrl(path, { EMBERVY_VIDEO_PORT: "4132" })).toBe(`http://localhost:4132${path}`);
  }
});

test("gateway fallback reads only this project even if another transcript is newer; foreign hooks are silent", () => {
  const f = fixture();
  const projects = join(f.home, ".claude/projects");
  const own = join(projects, f.home.replaceAll("/", "-"));
  const foreign = join(projects, "other-house");
  mkdirSync(own, { recursive: true }); mkdirSync(foreign, { recursive: true });
  const transcript = (text: string) => [
    { type: "user", message: { content: "hello" } },
    { type: "assistant", uuid: text, message: { content: [{ type: "text", text }] } },
  ].map(x => JSON.stringify(x)).join("\n");
  writeFileSync(join(own, "main.jsonl"), transcript("own reply"));
  writeFileSync(join(foreign, "main.jsonl"), transcript("foreign reply"));
  utimesSync(join(own, "main.jsonl"), 1, 1);
  f.fake("sleep", "exit 0");
  f.fake("curl", 'cat > "$EMBERVY_HOME/payload"');
  const script = `bash '${repo}/shared/scripts/reply-gateway.sh'`;
  const hook = { EMBERVY_HOOK_HOME: f.home };
  expect(f.run(script, hook, JSON.stringify({ cwd: f.home })).exitCode).toBe(0);
  expect(JSON.parse(readFileSync(join(f.home, "payload"), "utf8")).text).toBe("own reply");
  rmSync(join(f.home, "payload"));
  expect(f.run(script, hook, JSON.stringify({ transcript_path: join(foreign, "main.jsonl") })).exitCode).toBe(0);
  expect(Bun.file(join(f.home, "payload")).size).toBe(0);
  const inlet = f.run(`bash '${repo}/Claude/scripts/inlet.sh'`, hook, JSON.stringify({ transcript_path: join(foreign, "main.jsonl"), prompt: "hello" }));
  expect(inlet.exitCode).toBe(0);
  expect(new TextDecoder().decode(inlet.stdout)).toBe("");
});

test("production code has no fixed local default-port URLs or fixed house-unit operations", async () => {
  const issues: string[] = [];
  for (const dir of ["Claude", "Brain", "shared/scripts", "shared/tools/browser"]) {
    for await (const file of new Bun.Glob("**/*.{ts,sh,py}").scan({ cwd: join(repo, dir), absolute: true })) {
      if (/test|node_modules|legacy-names/.test(file)) continue;
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        if (/^\s*(#|\/\/|\*)/.test(line)) return;
        if (/\btmux\b/.test(line) && !["server.ts", "house-runtime.ts", "house-runtime.sh", "start-claude-loop.sh", "loop-wrapper.sh", "loop-dialog.sh", "cache-ping.sh", "brain-loop.sh", "brain-loop-wrapper.sh"].some(name => file.endsWith("/" + name))) {
          issues.push(`${file}:${i + 1}: ${line.trim()}`);
        }
        if (/https?:\/\/(?:localhost|127\.0\.0\.1):(?:3030|3041|3055)(?:[\/"'`])/.test(line)
          || /systemctl.*["']embervy-(?:app|loop|brain)["']/.test(line)) issues.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
  }
  if (issues.length) throw new Error("House isolation audit: " + issues.join(" | "));
});

test("a systemd unit decides ownership before cwd and argv", () => {
  const f = fixture();
  const own = `/bin/bash ${f.home}/Claude/scripts/loop-wrapper.sh`;
  const other = `/opt/embervy-other/Claude/app\n{ path=/bin/bash ; argv[]=/bin/bash /opt/embervy-other/Claude/scripts/loop-wrapper.sh }`;
  expect(ownsProcess(7, f.home, { cwd: () => "/tmp", argv: () => ["claude"], unitPaths: () => `\n{ argv[]=${own} }` })).toBe(true);
  expect(ownsProcess(7, f.home, { cwd: () => f.home, argv: () => [], unitPaths: () => other })).toBe(false);
  expect(ownsProcess(7, f.home, { cwd: () => f.home, argv: () => [], unitPaths: () => "\n{ argv[]=/usr/bin/cloudflared tunnel run }" })).toBe(true);
  const self = readFileSync("/proc/self/cgroup", "utf8");
  if (!/^0::.*\.service$/m.test(self)) return;
  f.fake("systemctl", `printf '%s\\n' '/opt/embervy-other' '{ argv[]=/bin/bash /opt/embervy-other/Brain/scripts/brain-loop-wrapper.sh }'`);
  expect(f.run(`. '${lib}'; embervy_owns_pid $$`).exitCode).toBe(1);
  f.fake("systemctl", `printf '%s\\n' '${f.home}/Brain' 'x'`);
  expect(f.run(`cd /; . '${lib}'; embervy_owns_pid $$`).exitCode).toBe(0);
});

test("a hook acts only for sessions of its own house", () => {
  const f = fixture();
  const gate = (transcript: string | null, home: string) => f.run(
    `. '${lib}'; embervy_hook_owns_input "$(cat)" '${home}'`, {}, JSON.stringify(transcript ? { transcript_path: transcript } : {}),
  ).exitCode;
  const projects = join(f.home, ".claude/projects");
  expect(gate(`${projects}/-opt-embervy/abc.jsonl`, "/opt/embervy")).toBe(0);
  expect(gate(`${projects}/-opt-embervy-kollege/abc.jsonl`, "/opt/embervy")).toBe(1);
  expect(gate(`${projects}/-opt-embervy/abc.jsonl`, "/opt/embervy-kollege")).toBe(1);
  expect(gate(`${projects}/-opt-embervy-kollege/abc.jsonl`, "/opt/embervy-kollege")).toBe(0);
  expect(gate(null, "/opt/embervy")).toBe(0);
});
