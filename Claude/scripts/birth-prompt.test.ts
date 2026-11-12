import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(import.meta.dir, "birth-prompt.sh");
const loop = join(import.meta.dir, "start-claude-loop.sh");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const defaultLine = "[gateway:silent] Fresh session after a cut. Read your lore and the bridge, then greet your person in the app in one or two sentences; no report of what you did before the cut.";

function fixture(panes: string[], config = "", after = "", mode = "fresh", timeout = "300", history = "bridge", clock?: { times: number[], alive?: boolean[] }) {
  const root = mkdtempSync(join(tmpdir(), "birth-prompt-"));
  roots.push(root);
  for (const path of ["bin", "Claude/app", "state"]) mkdirSync(join(root, path), { recursive: true });
  if (history === "bridge") writeFileSync(join(root, "state/wake_bridge.md"), "Previous conversation\n");
  if (history === "archive") writeFileSync(join(root, "state/uploaded_sessions"), "previous.jsonl:100:1\n");
  writeFileSync(join(root, ".env"), config);
  writeFileSync(join(root, "panes.json"), JSON.stringify(panes));
  writeFileSync(join(root, "bin/tmux"), `#!/usr/bin/env python3
import json, os, sys
root=os.environ['FIXTURE_ROOT']
args=sys.argv[1:]
assert args[:2] == ['-L', 'birth-test-socket']
args=args[2:]
with open(root+'/calls', 'a') as f: f.write(json.dumps(args)+'\\n')
def read(name, default=''):
    try:
        with open(root+'/'+name) as f: return f.read()
    except FileNotFoundError: return default
if args[0]=='capture-pane':
    entered=read('entered')
    if entered:
        print(os.environ['AFTER'] or ('› '+entered))
    else:
        count=int(read('count', '0'))
        with open(root+'/panes.json') as f: panes=json.load(f)
        print(panes[min(count, len(panes)-1)])
        with open(root+'/count', 'w') as f: f.write(str(count+1))
elif args[0]=='send-keys' and '-l' in args:
    with open(root+'/entered','w') as f: f.write(args[-1])
`);
  chmodSync(join(root, "bin/tmux"), 0o755);
  const p = Bun.spawnSync(["bash", "-c", `
    source "$1"
    sleep() { :; }
    checks=0
    times=(${clock?.times.join(" ") ?? ""})
    alive=(${clock?.alive?.map(value => value ? "0" : "1").join(" ") ?? ""})
    ${clock ? "LOOP_STARTUP_NOW=0" : ""}
    embervy_pane_has_claude() {
      if [ "\${#times[@]}" -gt 0 ]; then
        index=$checks
        [ "$index" -lt "\${#times[@]}" ] || index=$((\${#times[@]}-1))
        LOOP_STARTUP_NOW=\${times[$index]}
      fi
      status=\${alive[$checks]:-0}
      checks=$((checks+1))
      return "$status"
    }
    birth_prompt_main "$2" "$3"
  `, "fixture", helper, mode, timeout], {
    env: { PATH: `${root}/bin:/usr/bin:/bin`, HOME: root, EMBERVY_HOME: root, FIXTURE_ROOT: root, EMBERVY_TMUX_SOCKET: "birth-test-socket", EMBERVY_CACHE_PING_PANE: "%42", AFTER: after },
    stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  expect(p.exitCode).toBe(0);
  expect(p.stderr.toString()).toBe("");
  const calls: string[][] = existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map(x => JSON.parse(x)) : [];
  const sends = calls.filter(x => x[0] === "send-keys");
  const log = existsSync(join(root, "logs/claude-loop.log")) ? readFileSync(join(root, "logs/claude-loop.log"), "utf8") : "";
  return { calls, sends, log, stdout: p.stdout.toString() };
}

describe("Claude Code birth prompt (fake tmux)", () => {
  test.each(["›", ">", "❯"])("types the default exactly once, only after the %s prompt appears", prompt => {
    const f = fixture(["Starting Claude Code", "Loading development channels\n> 1. I am using this for local development\nEnter to confirm", "Update available\n> ", `${prompt} `]);
    expect(f.sends).toEqual([["send-keys", "-t", "%42", "-l", defaultLine], ["send-keys", "-t", "%42", "Enter"]]);
    expect(f.calls.slice(0, 5).every(x => x[0] === "capture-pane")).toBe(true);
    expect(f.log.match(/birth prompt sent/g)).toHaveLength(1);
  });
  test("a newborn greets for the first time without a cut or bridge instruction", () => {
    const f = fixture(["› "], "", "", "fresh", "300", "none");
    expect(f.sends).toHaveLength(2);
    expect(f.sends[0].at(-1)).toBe("[gateway:silent] First start. Read your identity and HANDBOOK.md, then greet your person for the first time in the app in one or two sentences.");
  });
  test("an archived life keeps the cut prompt even without a bridge", () => {
    const f = fixture(["› "], "", "", "fresh", "300", "archive");
    expect(f.sends[0].at(-1)).toBe(defaultLine);
  });
  test("the house .env supplies a literal custom birth line", () => {
    const line = '[gateway:silent] Say hello; $(touch /not-a-command)';
    const f = fixture(["› "], `EMBERVY_BIRTH_PROMPT='${line}'\n`);
    expect(f.sends[0]?.at(-1)).toBe(line);
    expect(f.sends).toHaveLength(2);
  });
  test("an empty birth line disables all typing and polling", () => {
    expect(fixture(["› "], "EMBERVY_BIRTH_PROMPT=\n").calls).toEqual([]);
  });
  test("continuing an existing session does not poll or type", () => {
    expect(fixture(["› "], "", "", "continue").calls).toEqual([]);
  });
  test("a first-start dialog or nonempty input must clear before typing", () => {
    const f = fixture(["Do you trust the files in this folder?\n> ", "Choose the text style\n> ", "> a person's unfinished message", "> "]);
    expect(f.calls.findIndex(x => x[0] === "send-keys")).toBe(5);
    expect(f.sends).toHaveLength(2);
  });
  test("workspace trust menus must clear before the birth prompt is typed", () => {
    const trust = "Accessing workspace:\n/opt/embervy\nQuick safety check: Is this a project you created or one you trust?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel";
    const f = fixture([trust, "> "]);
    expect(f.calls.findIndex(x => x[0] === "send-keys")).toBe(3);
    expect(f.sends).toHaveLength(2);
    expect(fixture(["› "], "", trust).sends).toEqual([["send-keys", "-t", "%42", "-l", defaultLine]]);
  });
  test("a dialog appearing after literal input never receives Enter", () => {
    const f = fixture(["› "], "", "Do you want to allow this?\n> 1. Yes\nEnter to confirm");
    expect(f.sends).toHaveLength(1);
    expect(f.sends[0]).toContain("-l");
  });
  test("long human questions pause birth timing until development clears and the prompt is ready", () => {
    for (const question of [
      "Do you trust the files in this folder?\n❯ 1. Yes\n2. No\nEnter to confirm",
      "Accessing workspace:\nQuick safety check: Is this a project you trust?\n❯ No, exit\n  Yes, I trust this folder\nEnter to confirm · Esc to cancel",
      "Choose the text style",
      "Detected new MCP servers",
      "Choose a response style?\n❯ 1. Concise\n2. Detailed\nEnter to confirm",
    ]) {
      const f = fixture([question, question, "Loading development channels\n❯ 1. I am using this for local development\n2. Exit\nEnter to confirm", "> "], "", "", "fresh", "300", "bridge", { times: [1, 200000, 200001, 200002] });
      expect(f.sends).toEqual([["send-keys", "-t", "%42", "-l", defaultLine], ["send-keys", "-t", "%42", "Enter"]]);
      expect(f.calls.findIndex(x => x[0] === "send-keys")).toBe(5);
      expect(f.log).toContain("birth prompt sent");
      expect(f.log).not.toContain("timed out");
    }
  });
  test("a human question pauses but does not renew the remaining birth budget", () => {
    const question = "Do you trust the files in this folder?";
    const f = fixture(["Starting", question, question, "Starting", "> "], "", "", "fresh", "300", "bridge", { times: [299, 299, 200000, 200000, 200001] });
    expect(f.sends).toEqual([]);
    expect(f.log).toContain("birth prompt timed out after 300s");
  });
  test("without human questions birth still expires at 300 active seconds", () => {
    const f = fixture(["Starting", "> "], "", "", "fresh", "300", "bridge", { times: [299, 300] });
    expect(f.sends).toEqual([]);
    expect(f.log).toContain("birth prompt timed out after 300s");
    const ready = fixture(["> "], "", "", "fresh", "300", "bridge", { times: [299] });
    expect(ready.sends).toHaveLength(2);
  });
  test("exiting Claude ends a paused birth worker without typing or waiting for timeout", () => {
    const f = fixture(["Do you trust the files in this folder?"], "", "", "fresh", "300", "bridge", { times: [1, 200000], alive: [true, false] });
    expect(f.calls).toHaveLength(1);
    expect(f.sends).toEqual([]);
    expect(f.log).not.toContain("timed out");
  });
  test("a worker waiting for Claude to start retains its bounded startup wait", () => {
    const f = fixture(["> "], "", "", "fresh", "300", "bridge", { times: [1, 300], alive: [false, false] });
    expect(f.calls).toEqual([]);
    expect(f.log).toContain("birth prompt timed out after 300s");
  });
  test("expiry is quiet and logged without typing", () => {
    const f = fixture(["Starting"], "", "", "fresh", "0");
    expect(f.calls).toEqual([]);
    expect(f.stdout).toBe("");
    expect(f.log).toContain("birth prompt timed out after 300s");
  });
  test("the loop starts one fresh-session worker on the cache-ping pane and stops it on exit", () => {
    const source = readFileSync(loop, "utf8");
    expect(source).toContain('INPUT_PANE="${EMBERVY_CACHE_PING_PANE:-${TMUX_PANE:-$TMUX_SESSION}}"');
    expect(source).toContain('if [ "$MODE" = fresh ]; then\n    EMBERVY_CACHE_PING_PANE="$INPUT_PANE" bash');
    expect(source.match(/\/birth-prompt\.sh/g)).toHaveLength(1);
    expect(source).toContain("stop_cache_ping() {\n  stop_birth_prompt");
    expect(source).toContain('wait "$BIRTH_PROMPT_PID"');
  });
  test("birth helper and loop parse as shell scripts", () => {
    for (const path of [helper, loop]) expect(Bun.spawnSync(["bash", "-n", path]).exitCode).toBe(0);
  });
});
