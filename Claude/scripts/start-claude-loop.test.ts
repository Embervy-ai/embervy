import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("literal terminal submissions wait before Enter and use the identity template heading", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const submissions = [...guide.matchAll(/tmux[^\n]*send-keys[^\n]* -l [^\n]+/g)];
  expect(submissions.length).toBeGreaterThan(0);
  for (const match of submissions) {
    const text = guide.slice(match.index);
    expect(text).toMatch(/^tmux[^\n]* -l [^\n]*?(?:; sleep 0\.5; |\nsleep 0\.5\n)tmux[^\n]*send-keys[^\n]* Enter/);
  }
  expect(guide).toContain("a menu that just closed can swallow an immediate Enter");
  expect(guide).toContain("Who I am, Memory, Tools,");
  expect(guide).not.toContain("Tools I use");
});

function dialogPoller() {
  const source = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
  const start = source.indexOf("    loop_startup_clock_start 180");
  const end = source.indexOf("\n  ) &", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return { source, body: `DIALOG_TARGET=%42\n${source.slice(start, end)}` };
}

test("dialog poller resumes after a long human question and confirms only development", () => {
  const { body } = dialogPoller();
  const result = Bun.spawnSync(["bash", "-c", `source "$1"
    LOG=/dev/stdout
    LOOP_STARTUP_NOW=0
    sleeps=0
    loop_dialog_owner_alive() { [ "$sleeps" -lt 7 ]; }
    sleep() {
      sleeps=$((sleeps+1))
      case "$sleeps" in
        1) LOOP_STARTUP_NOW=200;;
        2) LOOP_STARTUP_NOW=200000;;
        3|4) LOOP_STARTUP_NOW=200001;;
        5) LOOP_STARTUP_NOW=200002;;
        *) LOOP_STARTUP_NOW=200181;;
      esac
    }
    loop_question_notify() { printf 'REQUEST:%s\\n' "$1"; }
    tmux() {
      if [ "$1" = send-keys ]; then printf 'KEY:%s\\n' "$4"; return; fi
      case "$sleeps" in
        1|2) printf 'Do you trust the files in this folder?\\n❯ 1. Yes\\n2. No\\n';;
        3) printf 'Loading development channels\\n  1. I am using this for local development\\n❯ 2. Exit\\nEnter to confirm';;
        4) printf 'Loading development channels\\n❯ 1. I am using this for local development\\n  2. Exit\\nEnter to confirm';;
        *) printf '❯ ';;
      esac
    }
    ${body}
    printf 'SLEEPS:%s\\n' "$sleeps"
  `, "fixture", join(import.meta.dir, "loop-dialog.sh")], { env: { PATH: "/usr/bin:/bin", TMUX_SESSION: "test" }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const output = result.stdout.toString();
  expect(output).toContain("SLEEPS:7");
  expect(output.split("\n").filter(line => line.startsWith("KEY:"))).toEqual(["KEY:1", "KEY:Enter"]);
  expect(output).toContain("confirmed explicitly selected development-channels option 1");
  expect(output).toContain("timed out after 180s");
  expect(output.split("\n").filter(line => line.startsWith("REQUEST:"))).toHaveLength(2);
});

test("startup expires without questions or capture while the observer waits for process exit", () => {
  const { body } = dialogPoller();
  for (const fail of [false, true]) {
    const result = Bun.spawnSync(["bash", "-c", `source "$1"
      LOG=/dev/stdout; LOOP_STARTUP_NOW=0; sleeps=0
      loop_dialog_owner_alive() { [ "$sleeps" -lt 3 ]; }
      sleep() { sleeps=$((sleeps+1)); LOOP_STARTUP_NOW=$((sleeps * 90)); }
      tmux() { ${fail ? "return 1" : "printf 'Starting Claude Code'"}; }
      ${body}
      echo SLEEPS:$sleeps
    `, "fixture", join(import.meta.dir, "loop-dialog.sh")], { env: { PATH: "/usr/bin:/bin", TMUX_SESSION: "test" }, timeout: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain("SLEEPS:3");
    expect(result.stdout.toString()).toContain("dialog poller timed out after 180s");
  }
});

test("dialog poller publishes one unknown card without typing and resolves it on ready input", () => {
  const { body } = dialogPoller();
  const result = Bun.spawnSync(["bash", "-c", `source "$1"
    LOG=/dev/stdout; LOOP_STARTUP_NOW=0; sleeps=0
    embervy_pane_has_claude() { return 0; }
    loop_dialog_owner_alive() { [ "$sleeps" -lt 7 ]; }
    sleep() {
      sleeps=$((sleeps+1))
      case "$sleeps" in
        1) LOOP_STARTUP_NOW=1;; 2) LOOP_STARTUP_NOW=21;;
        3) LOOP_STARTUP_NOW=22;; 4) LOOP_STARTUP_NOW=23;;
        5) LOOP_STARTUP_NOW=201;; *) LOOP_STARTUP_NOW=380;;
      esac
    }
    loop_question_notify() { printf 'REQUEST:%s\\n' "$1"; }
    tmux() {
      if [ "$1" = send-keys ]; then echo KEY:unexpected; return; fi
      if [ "$sleeps" -lt 5 ]; then printf 'May this house borrow a moon?\\nPress any key';
      else printf '● Working…\\n──────────\\n❯ \\n──────────\\n  ⏵⏵ auto mode on (shift+tab to cycle)'; fi
    }
    ${body}
    echo SLEEPS:$sleeps
  `, "fixture", join(import.meta.dir, "loop-dialog.sh")], { env: { PATH: "/usr/bin:/bin", TMUX_SESSION: "test" }, stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const output = result.stdout.toString();
  const requests = output.split("\n").filter(line => line.startsWith("REQUEST:")).map(line => JSON.parse(line.slice(8)));
  expect(requests).toHaveLength(2);
  expect(requests[0]).toMatchObject({ action: "pending", question: { options: [], readonly: true } });
  expect(requests[0].question.text).toContain("May this house borrow a moon?\nPress any key");
  expect(requests[1]).toEqual({ action: "resolved", id: requests[0].question.id });
  expect(output).not.toContain("KEY:");
  expect(output).toContain("SLEEPS:7");
});

test("process-exit cleanup stops a poller paused on a human question and resets its card", () => {
  const { source, body } = dialogPoller();
  const stop = source.match(/stop_dialog_poller\(\) \{[\s\S]*?\n\}/)?.[0];
  expect(stop).toBeDefined();
  const home = mkdtempSync(join(tmpdir(), "loop-poller-exit-"));
  try {
    const result = Bun.spawnSync(["bash", "-c", `source "$1"
      LOG="$EMBERVY_HOME/loop.log"; touch "$LOG"
      loop_question_notify() { printf 'REQUEST:%s\\n' "$1" >> "$LOG"; }
      tmux() { printf 'Do you trust the files in this folder?'; }
      ${stop}
      (${body}) & DIALOG_POLLER_PID=$!
      pid=$DIALOG_POLLER_PID
      for ((i=0; i<100; i++)); do
        grep -q '"action":"pending"' "$LOG" && break
        sleep 0.02
      done
      grep -q '"action":"pending"' "$LOG" || exit 98
      stop_dialog_poller
      kill -0 "$pid" 2>/dev/null && exit 99
      [ -z "$DIALOG_POLLER_PID" ] || exit 97
      cat "$LOG"
    `, "fixture", join(import.meta.dir, "loop-dialog.sh")], { env: { PATH: "/usr/bin:/bin", EMBERVY_HOME: home, TMUX_SESSION: "test" }, timeout: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toContain('REQUEST:{"action":"reset"}');
    expect(result.stdout.toString()).not.toContain("timed out");
    expect(source).toContain("  loop_question_reset\n  (");
    expect(source).toContain('    DIALOG_POLLER_PID=""\n    loop_question_reset');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the process observer relays a question after thirty minutes, then a new identical occurrence", () => {
  const { body, source } = dialogPoller();
  const home = mkdtempSync(join(tmpdir(), "permission-lifetime-"));
  mkdirSync(join(home, "state"));
  const pane = readFileSync(join(import.meta.dir, "../app/test-fixtures/panes/permission-question.txt"), "utf8");
  try {
    const result = Bun.spawnSync(["bash", "-c", `source "$1"
      LOG="$EMBERVY_HOME/loop.log"; LOOP_STARTUP_NOW=0; sleeps=0; LOOP_QUESTION_GENERATION=process-one
      loop_dialog_owner_alive() { [ "$sleeps" -lt 8 ]; }
      sleep() {
        sleeps=$((sleeps+1))
        case "$sleeps" in
          1) LOOP_STARTUP_NOW=90;; 2) LOOP_STARTUP_NOW=180;;
          *) LOOP_STARTUP_NOW=$((1797+sleeps));;
        esac
        if [ "$sleeps" = 4 ]; then
          python3 -c 'import json,sys; q=json.load(open(sys.argv[1])); json.dump({"id":q["id"],"instance":q["instance"],"number":4},open(sys.argv[2],"w"))' "$EMBERVY_HOME/pending" "$EMBERVY_HOME/state/house-question-answer.json"
        fi
      }
      loop_question_notify() {
        printf 'REQUEST:%s\\n' "$1"
        printf '%s' "$1" | python3 -c 'import json,sys; r=json.load(sys.stdin); r.get("action")=="pending" and json.dump(r["question"],open(sys.argv[1],"w"))' "$EMBERVY_HOME/pending"
      }
      tmux() {
        if [ "$1" = send-keys ]; then shift 3; printf 'KEY:%s\\n' "$@"; return; fi
        case "$sleeps" in 3|4|6|7) printf '%s' "$PERMISSION";; *) printf '──────────\\n❯ \\n──────────';; esac
      }
      ${body}
      echo DONE:$sleeps
      cat "$LOG"
    `, "fixture", join(import.meta.dir, "loop-dialog.sh")], { env: { PATH: "/usr/bin:/bin", EMBERVY_HOME: home, PERMISSION: pane }, stdout: "pipe", stderr: "pipe", timeout: 10000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const output = result.stdout.toString();
    expect(output).toContain("DONE:8");
    expect(output).toContain("timed out after 180s");
    const requests = output.split("\n").filter(line => line.startsWith("REQUEST:")).map(line => JSON.parse(line.slice(8)));
    const pending = requests.filter(r => r.action === "pending");
    expect(pending.map(r => r.question.instance)).toEqual(["process-one:1", "process-one:2"]);
    expect(pending[0].question.id).toBe(pending[1].question.id);
    expect(pending[0].question.text).toContain("touch b.txt");
    expect(output.split("\n").filter(line => line.startsWith("KEY:"))).toEqual(["KEY:4", "KEY:Enter"]);
    expect(requests.at(-1)).toMatchObject({ action: "resolved", instance: "process-one:2" });
    expect(source).toContain('wait "$LOOP_CLAUDE_PID"');
    expect(source.indexOf("  stop_dialog_poller", source.indexOf('wait "$LOOP_CLAUDE_PID"\n'))).toBeGreaterThan(0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("process binding rejects exited processes and a reused PID with a different start stamp", () => {
  const result = Bun.spawnSync(["bash", "-c", `source "$1"
    /bin/sleep 60 & LOOP_CLAUDE_PID=$!
    trap 'kill "$LOOP_CLAUDE_PID" 2>/dev/null; wait "$LOOP_CLAUDE_PID" 2>/dev/null' EXIT
    read -r _ LOOP_CLAUDE_STAMP < <(loop_dialog_process_stamp "$LOOP_CLAUDE_PID")
    loop_dialog_owner_alive; echo ALIVE:$?
    stamp=$LOOP_CLAUDE_STAMP; LOOP_CLAUDE_STAMP=wrong
    loop_dialog_owner_alive; echo REUSED:$?
    LOOP_CLAUDE_STAMP=$stamp
    kill "$LOOP_CLAUDE_PID"; wait "$LOOP_CLAUDE_PID" 2>/dev/null
    loop_dialog_owner_alive; echo DEAD:$?
    trap - EXIT
  `, "fixture", join(import.meta.dir, "loop-dialog.sh")], { env: { PATH: "/usr/bin:/bin" }, timeout: 5000 });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("ALIVE:0");
  expect(result.stdout.toString()).toContain("REUSED:1");
  expect(result.stdout.toString()).toContain("DEAD:1");
});

test("the observed CLI keeps stdin, arguments, PID and interrupt handling", () => {
  const source = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
  const start = source.indexOf("  python3 -c '\nimport os, signal, sys");
  const end = source.indexOf("\n  LOOP_CLAUDE_PID=$!", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const home = mkdtempSync(join(tmpdir(), "observed-cli-"));
  try {
    writeFileSync(join(home, "claude"), `#!/usr/bin/python3
import os, signal, sys, json
print(json.dumps({"pid":os.getpid(),"stdin":sys.stdin.readline().strip(),"args":sys.argv[1:],"token":os.environ.get("EMBERVY_MAIN_BRIDGE_TOKEN"),"interrupt":signal.getsignal(signal.SIGINT)!=signal.SIG_IGN}), flush=True)
`, { mode: 0o755 });
    const result = Bun.spawnSync(["bash", "-c", `
      MAIN_BRIDGE_TOKEN_FILE="$HOME/token"; printf '%s\\n' bridge > "$MAIN_BRIDGE_TOKEN_FILE"
      CLAUDE_ARGS=(--continue); PASS_ARGS=('two words')
      ${source.slice(start, end)}
      pid=$!; wait "$pid"; echo PID:$pid
    `], { env: { PATH: `${home}:/usr/bin:/bin`, HOME: home }, stdin: Buffer.from("terminal input\n"), stdout: "pipe", stderr: "pipe", timeout: 5000 });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    const [json, pid] = result.stdout.toString().trim().split("\n");
    expect(JSON.parse(json)).toEqual({ pid: Number(pid.slice(4)), stdin: "terminal input", args: ["--continue", "two words"], token: "bridge", interrupt: true });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("manual clean-shell paths include system administration tools", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const paths = [...guide.matchAll(/^\s*PATH="([^"]+)"/gm)].map(match => match[1]);
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) {
    expect(path.split(":" )).toContain("/usr/sbin");
    expect(path.split(":" )).toContain("/sbin");
  }
});

test("the Claude Code bridge guide documents mode and session defaults", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const section = guide.slice(guide.indexOf("### Cut and watchdog"), guide.indexOf("### App channel", guide.indexOf("### Cut and watchdog")));
  expect(section).toContain("`EMBERVY_BRIDGE_MODE` (default `turns`)");
  expect(section).toContain("`EMBERVY_BRIDGE_SESSIONS` (default `2`)");
});

test("all bridge writers delegate settings to the extractor", () => {
  const loop = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
  const cut = readFileSync(join(import.meta.dir, "cutoff.sh"), "utf8");
  const writers = [...`${loop}\n${cut}`.matchAll(/extract_bridge\.py" ([^\n]+)/g)].filter(match => !match[1].includes("--has-messages"));
  expect(writers).toHaveLength(4);
  for (const writer of writers) expect(writer[1]).toMatch(/^--output "/);
  expect(loop).not.toContain("EMBERVY_BRIDGE_TURNS:-40");
});

test("startup ignores login-only transcripts but builds a conversation bridge", () => {
  for (const conversation of [false, true]) {
    const home = mkdtempSync(join(tmpdir(), "loop-bridge-"));
    try {
      for (const dir of ["Claude/scripts", "state", "project"]) mkdirSync(join(home, dir), { recursive: true });
      for (const script of ["latest_main_session.py", "extract_bridge.py", "transcript_speech.py"]) copyFileSync(join(import.meta.dir, script), join(home, "Claude/scripts", script));
      const rows: object[] = [{ type: "system", entrypoint: "cli" }, { type: "user", message: { role: "user", content: "<command-name>/login</command-name><local-command-stdout>Signed in</local-command-stdout>" } }];
      if (conversation) rows.push({ type: "user", message: { role: "user", content: "Hello from the conversation" } });
      writeFileSync(join(home, "project/session.jsonl"), rows.map(row => JSON.stringify(row)).join("\n"));
      const source = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
      const startup = source.slice(source.indexOf('if [ "$INITIAL_MODE" = "fresh" ]'), source.indexOf('\nclaude_signin_warning'));
      const result = Bun.spawnSync(["bash", "-c", `INITIAL_MODE=fresh; PROJECT_DIR="$EMBERVY_HOME/project"; BRIDGE="$EMBERVY_HOME/state/wake_bridge.md"; LOG="$EMBERVY_HOME/loop.log"; touch "$LOG"; ${startup}`], {
        env: { PATH: process.env.PATH, HOME: home, EMBERVY_HOME: home },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      const log = readFileSync(join(home, "loop.log"), "utf8");
      expect(log).not.toContain("failed");
      expect(log).not.toContain("No messages extracted");
      expect(existsSync(join(home, "state/wake_bridge.md"))).toBe(conversation);
      if (conversation) expect(readFileSync(join(home, "state/wake_bridge.md"), "utf8")).toContain("Hello from the conversation");
      else expect(log).toBe("");
    } finally { rmSync(home, { recursive: true, force: true }); }
  }
});

test("a recent export never suppresses a different session", () => {
  const home = mkdtempSync(join(tmpdir(), "loop-export-"));
  try {
    for (const dir of ["state", "Claude/scripts", "project"]) mkdirSync(join(home, dir), { recursive: true });
    writeFileSync(join(home, "state/last_cutover_ts"), String(Math.floor(Date.now() / 1000)));
    writeFileSync(join(home, "state/last_cut_session"), "previous.jsonl");
    writeFileSync(join(home, "project/current.jsonl"), "{}\n");
    writeFileSync(join(home, "Claude/scripts/latest_main_session.py"), 'import os\nprint(os.environ["EMBERVY_HOME"]+"/project/current.jsonl")\n');
    writeFileSync(join(home, "Claude/scripts/extract_bridge.py"), "pass\n");
    writeFileSync(join(home, "Claude/scripts/session-to-rag.sh"), '#!/bin/bash\necho exported > "$EMBERVY_HOME/exported"\n', { mode: 0o755 });
    const source = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
    const finalize = source.slice(source.indexOf('    MARKER="$EMBERVY_HOME/state/last_cutover_ts"'), source.indexOf('\n  else\n    CRASH_TIMES+=("$NOW")'));
    const result = Bun.spawnSync(["bash", "-c", `NOW=$(date +%s); LOG="$EMBERVY_HOME/loop.log"; PROJECT_DIR="$EMBERVY_HOME/project"; BRIDGE="$EMBERVY_HOME/state/bridge"; ${finalize}`], {
      env: { PATH: process.env.PATH, EMBERVY_HOME: home },
    });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(home, "exported"), "utf8")).toBe("exported\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("clean foreground exits offer a visible stop window only after export", () => {
  const source = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
  const helper = source.match(/loop_restart_pause\(\) \{[\s\S]*?\n\}/)?.[0];
  expect(helper).toBeDefined();
  expect(source).toContain('loop_restart_pause "$rc" "$POST_EXIT_EXPORTED"');
  for (const [tty, attached, rc, exported, delay] of [[1, 1, 0, 1, 15], [0, 0, 0, 1, 2], [1, 0, 0, 1, 2], [1, 1, 1, 1, 2], [1, 1, 0, 0, 2]]) {
    const result = Bun.spawnSync(["bash", "-c", `${helper}
      [() { if [[ "$1" == -t ]]; then return $((1 - TTY)); else builtin [ "$@"; fi; }
      tmux() { printf '%s' "$ATTACHED"; }
      sleep() { printf 'pause=%s\\n' "$1"; }
      loop_restart_pause "$RC" "$EXPORTED"
    `], { env: { PATH: process.env.PATH, TTY: String(tty), ATTACHED: String(attached), RC: String(rc), EXPORTED: String(exported), TMUX: "test", TMUX_SESSION: "test" } });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(result.stdout.toString()).toBe((delay === 15 ? "exported; press Ctrl-C within 15 seconds to stop here, otherwise a new session starts\n" : "") + `pause=${delay}\n`);
  }
});

for (const backend of ["gpt", "glm", "kimi", "minimax", "claude"]) {
  test(`loop sign-in warning for ${backend} is safe and non-blocking`, () => {
    const home = mkdtempSync(join(tmpdir(), "loop-signin-"));
    try {
      const source = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
      expect(source).toContain('claude_signin_warning "${EMBERVY_BACKEND:-claude}"');
      expect(source.indexOf("claude_signin_warning")).toBeLessThan(source.indexOf("BACKEND_MODEL_ARGS=()"));
      for (const token of ["", "private-test-token"]) {
        const log = join(home, "loop.log");
        const run = Bun.spawnSync(["bash", "-c", '. "$1"; claude_signin_warning "$2" | tee -a "$3"; echo started', "test", join(import.meta.dir, "claude-signin-present.sh"), backend, log], {
          env: { PATH: process.env.PATH!, HOME: home, CLAUDE_CODE_OAUTH_TOKEN: token, ANTHROPIC_AUTH_TOKEN: "private-adapter-token" },
        });
        const warning = `Warning: this house thinks with ${backend} but Claude Code has no Claude sign-in. Anthropic opens Claude Code's app channel only for a signed-in Claude account, so messages from the app will not reach the agent. Sign in once with claude and /login, then restart the loop.`;
        expect(run.exitCode).toBe(0);
        expect(run.stdout.toString()).toBe((backend !== "claude" && !token ? warning + "\n" : "") + "started\n");
        expect(run.stderr.toString()).toBe("");
        expect(readFileSync(log, "utf8")).not.toContain("private-");
      }
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
