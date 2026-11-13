import { describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hasPermissionDialog, inputReadiness, deliverUnlessFirstStart } from "../app/first-start-guard";

const helper = join(import.meta.dir, "loop-dialog.sh");
const loop = join(import.meta.dir, "start-claude-loop.sh");
const dev = (cursor: number) => `Loading development channels\n${cursor === 1 ? "❯" : " "} 1. I am using this for local development\n${cursor === 2 ? "❯" : " "} 2. Exit\nEnter to confirm`;

function step(pane: string, after = pane, fail = "") {
  // Shell functions prevent any access to a real tmux session or wall-clock wait.
  const result = Bun.spawnSync(["bash", "-c", `
    source "$1"
    LOG=/dev/stdout
    sleep() { :; }
    tmux() {
      case "$1" in
        send-keys)
          printf 'KEY:%s\\n' "$4"
          [ "$FAIL" != send ] ;;
        capture-pane)
          [ "$FAIL" != capture ] || return 1
          printf '%s\\n' "$AFTER" ;;
        *) return 99 ;;
      esac
    }
    loop_dialog_step "$PANE" '%42'
    status=$?
    printf 'STATUS:%s\\n' "$status"
  `, "fixture", helper], {
    env: { PATH: "/usr/bin:/bin", PANE: pane, AFTER: after, FAIL: fail },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr.toString()).toBe("");
  const output = result.stdout.toString();
  return { output, keys: output.split("\n").filter(x => x.startsWith("KEY:")).map(x => x.slice(4)) };
}

const workspaceTrust = `Accessing workspace:

/opt/embervy

Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.

Claude Code'll be able to read, edit, and execute files here.

Security guide

❯ No, exit
  Yes, I trust this folder

Enter to confirm · Esc to cancel`;
const generic = "Choose a response style?\n❯ 1. Concise\n  2. Detailed\nEnter to confirm";
function questionRun(script: string, pane = generic, answer?: unknown, after = pane) {
  const home = mkdtempSync(join(tmpdir(), "question-loop-"));
  mkdirSync(join(home, "state"));
  if (answer !== undefined) writeFileSync(join(home, "state/house-question-answer.json"), JSON.stringify(answer));
  try {
    const result = Bun.spawnSync(["bash", "-c", `source "$1"
      LOG=/dev/stdout
      sleep() { :; }
      loop_question_notify() { printf 'REQUEST:%s\\n' "$1"; }
      tmux() { case "$1" in capture-pane) printf '%s\\n' "$AFTER";; send-keys) [ ! -f "$EMBERVY_HOME/state/house-question-answer.json" ] || { echo 'answer not consumed' >&2; return 1; }; shift 3; printf 'KEY:%s\\n' "$@";; esac; }
      ${script}`, "fixture", helper], { env: { PATH: "/usr/bin:/bin", EMBERVY_HOME: home, PANE: pane, AFTER: after, LOOP_STARTUP_NOW: "0" }, stdout: "pipe", stderr: "pipe" });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return { output: result.stdout.toString(), answerExists: existsSync(join(home, "state/house-question-answer.json")) };
  } finally { rmSync(home, { recursive: true, force: true }); }
}
function parsed(pane = generic) {
  return JSON.parse(questionRun('loop_dialog_question "$PANE"', pane).output);
}

describe("house question protocol", () => {
  test.each(["trust-question", "trust-question-restart"])("captured %s keeps its two-option start card", name => {
    const pane = readFileSync(join(import.meta.dir, `../app/test-fixtures/panes/${name}.txt`), "utf8");
    expect(questionRun('loop_dialog_kind "$PANE"', pane).output).toBe("first-start\n");
    expect(parsed(pane)).toMatchObject({
      navigation: "arrows", selected: 1,
      options: [{ number: 1, label: "No, exit" }, { number: 2, label: "Yes, I trust this folder" }],
    });
    expect(step(pane).keys).toEqual([]);
  });
  test("the workspace trust dialog publishes a two-option card without confirming the default exit", () => {
    const q = parsed(workspaceTrust);
    expect(q.options).toEqual([{ number: 1, label: "No, exit" }, { number: 2, label: "Yes, I trust this folder" }]);
    expect(q).toMatchObject({ navigation: "arrows", selected: 1 });
    expect(q.text).toContain("Quick safety check:");
    expect(q.text).not.toContain("Enter to confirm");
    const result = questionRun('loop_dialog_step "$PANE" p; true', workspaceTrust);
    const requests = result.output.split("\n").filter(x => x.startsWith("REQUEST:")).map(x => JSON.parse(x.slice(8)));
    expect(requests).toEqual([{ action: "pending", question: q }]);
    expect(result.output).not.toContain("KEY:");
    expect(questionRun('loop_dialog_kind "$PANE"', workspaceTrust).output).toBe("first-start\n");
  });
  test("independent trust cues still block an incomplete or reworded workspace dialog", () => {
    for (const cue of ["Quick safety check", "Yes, I trust this folder", "Accessing workspace:"]) {
      expect(questionRun('loop_dialog_kind "$PANE"', cue).output).toBe("first-start\n");
      const pane = workspaceTrust.replace(cue, "Reworded");
      expect(parsed(pane).options).toHaveLength(2);
      expect(questionRun('loop_dialog_kind "$PANE"', pane).output).toBe("first-start\n");
    }
  });
  test("unnumbered answers use arrows from the freshly captured cursor, including ASCII markers", () => {
    for (const marker of ["❯", ">"]) {
      const pane = workspaceTrust.replace("❯", marker);
      const moved = pane.replace(`${marker} No, exit\n  Yes, I trust this folder`, `  No, exit\n${marker} Yes, I trust this folder`);
      const q = parsed(pane);
      expect(parsed(moved).id).toBe(q.id);
      expect(parsed(moved).selected).toBe(2);
      for (const [initial, after, number, keys] of [
        [pane, pane, 2, ["Down", "Enter"]],
        [pane, moved, 2, ["Enter"]],
        [moved, moved, 1, ["Up", "Enter"]],
        [moved, pane, 1, ["Enter"]],
      ] as const) {
        const result = questionRun('loop_dialog_step "$PANE" p; true', initial, { id: q.id, number }, after);
        expect(result.output.split("\n").filter(x => x.startsWith("KEY:")).map(x => x.slice(4))).toEqual([...keys]);
        expect(result.answerExists).toBe(false);
        expect(result.output).toContain("house question answered");
      }
    }
  });
  test("unnumbered stale, malformed, changed and disappeared answers cannot type keys", () => {
    const q = parsed(workspaceTrust);
    for (const [answer, after] of [
      [{ id: "stale", number: 2 }, workspaceTrust],
      [{ id: q.id, number: 3 }, workspaceTrust],
      [{ id: q.id, number: "2" }, workspaceTrust],
      [{ id: q.id, enter: true }, workspaceTrust],
      [{ id: q.id, number: 2, enter: true }, workspaceTrust],
      [{ id: q.id, number: 2 }, workspaceTrust.replace("No, exit", "No, cancel")],
      [{ id: q.id, number: 2 }, workspaceTrust.replace("❯ No, exit", "  No, exit")],
      [{ id: q.id, number: 2 }, "❯ "],
    ] as const) {
      const result = questionRun('loop_dialog_step "$PANE" p; true', workspaceTrust, answer, after);
      expect(result.output).not.toContain("KEY:");
      expect(result.answerExists).toBe(false);
      expect(result.output).toContain("house question answer discarded");
    }
  });
  test("numbered trust answers retain their terminal shortcuts", () => {
    const pane = "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\nEnter to confirm";
    const q = parsed(pane);
    expect(q.options).toEqual([{ number: 1, label: "Yes, proceed" }, { number: 2, label: "No, exit" }]);
    const result = questionRun('loop_dialog_step "$PANE" p; true', pane, { id: q.id, number: 1 });
    expect(result.output.split("\n").filter(x => x.startsWith("KEY:"))).toEqual(["KEY:1", "KEY:Enter"]);
  });
  test("unnumbered menus navigate multiple rows and do not turn ordinary input into a question", () => {
    const pane = "Choose a response style?\n> Concise\n  Balanced\n  Detailed\nEnter to confirm";
    const q = parsed(pane);
    expect(q.options).toHaveLength(3);
    const result = questionRun('loop_dialog_step "$PANE" p; true', pane, { id: q.id, number: 3 });
    expect(result.output.split("\n").filter(x => x.startsWith("KEY:"))).toEqual(["KEY:Down", "KEY:Down", "KEY:Enter"]);
    for (const text of ["> hello\n  ordinary output", "Plan\n> Read\n  Write", "Choose?\n> Read\n> Write"]) expect(parsed(text)).toBeNull();
  });
  test("incomplete trust menus and cursor selections never become Enter-only cards", () => {
    for (const pane of [
      "Quick safety check\n❯ No, exit\nEnter to confirm",
      "Accessing workspace:\nNo, exit\nYes, I trust this folder\nEnter to confirm",
      "Do you trust the files in this folder?\nEnter to confirm",
      "Choose?\n❯ No, exit\nEnter to confirm",
    ]) {
      const q = parsed(pane);
      expect(q?.enter).toBeUndefined();
      const result = questionRun('loop_dialog_step "$PANE" p; true', pane, { id: q?.id, enter: true });
      expect(result.output).not.toContain("KEY:");
      expect(result.answerExists).toBe(false);
    }
  });
  test("colours and terminal indentation do not change an unnumbered trust menu", () => {
    const q = parsed(workspaceTrust);
    const coloured = workspaceTrust.split("\n").map(line => `  \x1b[1m${line}\x1b[0m`).join("\n");
    expect(parsed(coloured)).toEqual(q);
    const result = questionRun('loop_dialog_step "$PANE" p; true', coloured, { id: q.id, number: 2 });
    expect(result.output.split("\n").filter(x => x.startsWith("KEY:"))).toEqual(["KEY:Down", "KEY:Enter"]);
  });
  test("Enter-only prompts are trailing instructions with bounded dialog text", () => {
    for (const instruction of ["Press Enter to continue", "press Enter to confirm", "Enter to continue", "PRESS ENTER TO CONTINUE."]) {
      const q = parsed(`Setup complete\n\n  ${instruction}  \n\n`);
      expect(q).toMatchObject({ text: `Setup complete\n\n${instruction}`, options: [], enter: true });
      expect(q.id).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(parsed("private pane line\n\nSetup complete\n\nPress Enter to continue").text).toBe("Setup complete\n\nPress Enter to continue");
    expect(parsed("Context\n".repeat(40) + "Press Enter to continue").text.split("\n")).toHaveLength(30);
    expect(parsed(generic + "\nPress Enter to continue").enter).toBeUndefined();
    expect(parsed("Choose?\n1. Yes\n2. No\nPress Enter to continue")).toBeNull();
  });
  test("ordinary mentions and earlier Enter instructions are not Enter questions", () => {
    for (const pane of ["The guide says Press Enter to continue.", "Use Enter to continue editing text", 'Example: "Press Enter to continue"', "Press Enter to continue\nWork completed", "Press Enter to continue\n❯ ", "Press Enter to continue or type a response"]) {
      expect(parsed(pane)).toBeNull();
    }
  });
  test("Enter answers are consumed before typing and require the same visible question", () => {
    const pane = "Setup complete\nPress Enter to continue";
    const q = parsed(pane);
    for (const [answer, after, keys] of [
      [{ id: q?.id, enter: true }, pane, ["Enter"]],
      [{ id: "stale", enter: true }, pane, []],
      [{ id: q?.id, enter: true }, "Changed\nPress Enter to continue", []],
      [{ id: q?.id, enter: true }, "❯ ", []],
      [{ id: q?.id, enter: "true" }, pane, []],
      [{ id: q?.id, number: 1 }, pane, []],
      [{ id: q?.id, enter: true, number: 1 }, pane, []],
      [{ id: q?.id, enter: true, text: "unsafe" }, pane, []],
      [{ id: parsed().id, enter: true }, generic, []],
      [{ id: parsed().id, number: 1, enter: true }, generic, []],
    ] as const) {
      const result = questionRun('loop_dialog_step "$PANE" p; true', after === generic ? generic : pane, answer, after);
      expect(result.output.split("\n").filter(x => x.startsWith("KEY:"))).toEqual(keys.map(key => `KEY:${key}`));
      expect(result.answerExists).toBe(false);
      expect(result.output).toContain(keys.length ? "house question answered" : "house question answer discarded");
    }
  });
  test("generic selection is recognised without including surrounding pane text", () => {
    const q = parsed("private pane line\n\n" + generic + "\n\nunrelated footer");
    expect(q.text).toBe("Choose a response style?\n1. Concise\n2. Detailed");
    expect(q.options).toEqual([{ number: 1, label: "Concise" }, { number: 2, label: "Detailed" }]);
    expect(q.id).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed(generic.replace("❯ 1.", "  1.").replace("  2.", "❯ 2.")).id).toBe(q.id);
    expect(questionRun('loop_dialog_kind "$PANE"').output).toBe("first-start\n");
    expect(step(dev(2) + "\n\n" + generic).keys).toEqual([]);
  });
  test("ordinary numbered lists and ordinary panes are not questions", () => {
    for (const pane of ["Plan\n1. Read\n2. Write\n❯ ", "❯ \n? for shortcuts"]) {
      expect(parsed(pane)).toBeNull();
      expect(questionRun('loop_dialog_kind "$PANE"', pane).output).toBe("none\n");
    }
  });
  test("each distinct question is sent once and disappearing questions resolve", () => {
    const output = questionRun('loop_dialog_step "$PANE" p; loop_dialog_step "$PANE" p; loop_dialog_step "❯ " p; true').output;
    const requests = output.split("\n").filter(x => x.startsWith("REQUEST:")).map(x => JSON.parse(x.slice(8)));
    expect(requests).toHaveLength(2);
    expect(requests[0].question.id).toBe(parsed().id);
    expect(requests[1]).toEqual({ action: "resolved", id: parsed().id });
  });
  test("only a matching parsed number reaches the terminal", () => {
    const q = parsed();
    for (const [answer, after, keys] of [
      [{ id: q.id, number: 2 }, generic, ["2", "Enter"]],
      [{ id: "different", number: 2 }, generic, []],
      [{ id: q.id, number: 9 }, generic, []],
      [{ id: q.id, number: "2; exit" }, generic, []],
      [{ id: q.id, number: "2" }, generic, []],
      [{ id: q.id, number: 2 }, generic.replace("Concise", "Short"), []],
    ] as const) {
      const result = questionRun('loop_dialog_step "$PANE" p; true', generic, answer, after);
      expect(result.output.split("\n").filter(x => x.startsWith("KEY:")).map(x => x.slice(4))).toEqual([...keys]);
      expect(result.answerExists).toBe(false);
      expect(result.output).toContain(keys.length ? "house question answered" : "house question answer discarded");
    }
  });
  test("replacements publish once and a submitted question does not reopen before it disappears", () => {
    const changed = generic.replace("style?", "format?");
    const output = questionRun(`loop_dialog_step "$PANE" p; loop_dialog_step "${changed}" p; loop_dialog_step "${changed}" p; true`).output;
    expect(output.split("\n").filter(x => x.startsWith("REQUEST:"))).toHaveLength(2);
    const answered = questionRun('loop_dialog_step "$PANE" p; loop_dialog_step "$PANE" p; true', generic, { id: parsed().id, number: 1 }).output;
    expect(answered.split("\n").filter(x => x.startsWith("REQUEST:"))).toHaveLength(2);
    expect(answered.split("\n").filter(x => x.startsWith("KEY:"))).toEqual(["KEY:1", "KEY:Enter"]);
  });
  test("answers with no visible question are discarded without keys", () => {
    const result = questionRun('loop_dialog_step "$PANE" p; true', "❯ ", { id: parsed().id, number: 1 });
    expect(result.answerExists).toBe(false);
    expect(result.output).toContain("house question answer discarded");
    expect(result.output).not.toContain("KEY:");
  });
  test("successive questions pause the remaining budget instead of renewing it", () => {
    const output = questionRun(`loop_startup_clock_start 180
      LOOP_STARTUP_NOW=179; loop_dialog_continue none; echo ACTIVE:$?
      loop_dialog_step "$PANE" p; loop_dialog_continue first-start
      LOOP_STARTUP_NOW=80000; loop_dialog_step "Choose again?\n❯ 1. Yes\n2. No" p; loop_dialog_continue first-start
      LOOP_STARTUP_NOW=200000; loop_dialog_continue first-start; echo NEXT:$?
      loop_dialog_step "❯ " p; loop_dialog_continue none; echo RESOLVED:$?
      LOOP_STARTUP_NOW=200001; loop_dialog_continue none; echo EXPIRED:$?`).output;
    expect(output).toContain("ACTIVE:0");
    expect(output).toContain("NEXT:0");
    expect(output).toContain("RESOLVED:0");
    expect(output).toContain("EXPIRED:1");
    expect(output).toContain("timed out after 180s");
  });
  test("dialog lines are trimmed and bounded and old development text does not replace a newer question", () => {
    const q = parsed("  Do you trust the files in this folder?  \n\n  ❯ 1. Yes  \n    2. No  \nEnter to confirm\nprivate footer");
    expect(q.text.split("\n").every((line: string) => line === line.trim())).toBe(true);
    expect(q.text.split("\n").length).toBeLessThanOrEqual(30);
    expect(q.text).not.toContain("private footer");
    expect(parsed(dev(2) + "\nDo you trust the files in this folder?").text).toBe("Do you trust the files in this folder?");
  });
  test("visible human questions have no time bound, even without a complete card", () => {
    for (const pane of [generic, workspaceTrust, "Do you trust the files in this folder?", "Accessing workspace:", "Choose the text style", "Detected new MCP servers"]) {
      const result = questionRun(`loop_startup_clock_start 180
        loop_dialog_step "$PANE" p; loop_dialog_continue "$(loop_dialog_kind "$PANE")"
        LOOP_STARTUP_NOW=200000; loop_dialog_continue "$(loop_dialog_kind "$PANE")"; echo WAIT:$?`, pane);
      expect(result.output).toContain("WAIT:0");
      expect(result.output).not.toContain("timed out");
      expect(result.output).not.toContain("KEY:");
    }
  });
  test("a start question beyond a day is not renewed and pauses startup until answered in TUI", () => {
    const result = questionRun(`
      LOOP_QUESTION_GENERATION=start-process
      loop_startup_clock_start 180
      LOOP_STARTUP_NOW=179; loop_dialog_observe "" p
      loop_dialog_observe "$PANE" p
      for now in 86580 200000; do
        LOOP_STARTUP_NOW=$now; loop_dialog_observe "$PANE" p
        echo WAIT:$LOOP_STARTUP_REMAINING:$LOOP_STARTUP_PAUSED:$LOOP_QUESTION_INSTANCE
      done
      # A human answers in TUI; only the resulting screen change resumes startup.
      loop_dialog_observe "" p
      echo RESOLVED:$LOOP_STARTUP_REMAINING:$LOOP_STARTUP_PAUSED:$LOOP_QUESTION_ID
      LOOP_STARTUP_NOW=200001; loop_dialog_observe "" p
      echo FINISHED:$LOOP_STARTUP_FINISHED
    `);
    const requests = requestsIn(result.output);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ action: "pending", question: { id: parsed().id, instance: "start-process:1" } });
    expect(requests[1]).toEqual({ action: "resolved", id: parsed().id, instance: "start-process:1" });
    expect(result.output.split("\n").filter(line => line.startsWith("WAIT:"))).toEqual([
      "WAIT:1:1:start-process:1", "WAIT:1:1:start-process:1",
    ]);
    expect(result.output).toContain("RESOLVED:1::\n");
    expect(result.output).toContain("FINISHED:1");
    expect(result.output).not.toContain("KEY:");
    expect(result.answerExists).toBe(false);
  });
  test("submitting an answer cannot resume the clock while its question is still visible", () => {
    const result = questionRun(`loop_startup_clock_start 180
      loop_dialog_step "$PANE" p
      echo CARD:$LOOP_QUESTION_ID
      LOOP_STARTUP_NOW=200000; loop_dialog_continue "$(loop_dialog_kind "$PANE")"; echo WAIT:$?`, generic, { id: parsed().id, number: 1 });
    expect(result.output).toContain("house question answered");
    expect(result.output).toContain("CARD:\n");
    expect(result.output).toContain("WAIT:0");
    expect(result.output).not.toContain("timed out");
  });
  test("without a human question the original startup timeout still applies", () => {
    const output = questionRun(`loop_startup_clock_start 180
      LOOP_STARTUP_NOW=179; loop_dialog_continue none; echo BEFORE:$?
      LOOP_STARTUP_NOW=180; loop_dialog_continue none; echo LIMIT:$?`).output;
    expect(output).toContain("BEFORE:0");
    expect(output).toContain("LIMIT:1");
    expect(output).toContain("dialog poller timed out after 180s (no dialog seen)");
  });
});

const readyInput = `  3 more notices hidden

                                        ✔ Update installed · /restart to apply
──────────────────────────────────────────────────────────────────────────────
❯\u00a0
──────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`;
const unknownScreen = "May this house borrow a moon?\nPress any key";

describe("unknown startup screens", () => {
  test("ready input suppresses quoted setup cues, also while working and with wrapped text", () => {
    for (const prompt of ["❯", "›", ">"]) for (const typed of ["\u00a0", "typed text\n  wrapped\n  again\n  last line"]) {
      const pane = `${workspaceTrust}\n● Working…\n${readyInput.replace("❯\u00a0", prompt + typed)}`;
      expect(parsed(pane)).toBeNull();
      expect(questionRun('loop_dialog_kind "$PANE"', pane).output).toBe("none\n");
    }
    expect(questionRun('loop_dialog_kind "$PANE"', `${readyInput}\n${workspaceTrust}`).output).toBe("first-start\n");
  });

  test("more than twenty seconds publishes once without buttons or keys, and ready resolves it", () => {
    const result = questionRun(`
      embervy_pane_has_claude() { return 0; }
      loop_startup_clock_start 180
      for now in 0 20 21 22; do
        LOOP_STARTUP_NOW=$now; KIND=$(loop_dialog_kind "$PANE")
        loop_unknown_watch "$PANE" p "$KIND"
        loop_dialog_continue "$KIND"
        loop_dialog_step "$PANE" p "$KIND" || true
        echo TICK:$now
      done
      LOOP_STARTUP_NOW=200; KIND=none
      loop_unknown_watch "$AFTER" p "$KIND"
      loop_dialog_step "$AFTER" p "$KIND" || true
    `, unknownScreen, { id: "stale", enter: true }, readyInput);
    const requests = result.output.split("\n").filter(line => line.startsWith("REQUEST:")).map(line => JSON.parse(line.slice(8)));
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ action: "pending", question: { text: `${unknownScreen}\nYour agent is waiting in its terminal; open TUI at the top and inspect it.`, options: [], readonly: true } });
    expect(requests[0].question.enter).toBeUndefined();
    expect(requests[1]).toEqual({ action: "resolved", id: requests[0].question.id });
    expect(result.output.indexOf("TICK:20")).toBeLessThan(result.output.indexOf("REQUEST:"));
    expect(result.output.indexOf("REQUEST:")).toBeLessThan(result.output.indexOf("TICK:21"));
    expect(result.output).not.toContain("KEY:");
    expect(result.answerExists).toBe(false);
  });

  test("unknown cards bound and sanitize the last visible lines", () => {
    const pane = "earlier private line\n" + "line\n".repeat(35) + ("  1. <visible> \x1b[32m" + "🌙 ".repeat(200) + "\n").repeat(27) + "Last visible line\x07\nPress any key\n\n";
    const result = questionRun(`embervy_pane_has_claude() { return 0; }
      loop_startup_clock_start 180
      KIND=none; loop_unknown_watch "$PANE" p "$KIND"
      LOOP_STARTUP_NOW=21; loop_unknown_watch "$PANE" p "$KIND"`, pane);
    const q = JSON.parse(result.output.split("\n").find(line => line.startsWith("REQUEST:"))!.slice(8)).question;
    expect(q.text.split("\n")).toHaveLength(30);
    expect(q.text.length).toBeLessThanOrEqual(12000);
    expect(q.text.split("\n").every((line: string) => line === line.trim() && line.length <= 400)).toBe(true);
    expect(q.text).toContain("1. <visible>");
    expect(q.text).toContain("Last visible line\nPress any key");
    expect(q.text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
    expect(q.text).not.toContain("earlier private line");
    expect(q.options).toEqual([]);
  });

  test("ready, blank, stopped, and recognised screens reset the continuous wait", () => {
    for (const interrupt of ["ready", "blank", "ansi-blank", "stopped", "known"]) {
      const result = questionRun(`
        running=1; embervy_pane_has_claude() { [ "$running" = 1 ]; }
        loop_startup_clock_start 180
        KIND=none; loop_unknown_watch "$PANE" p "$KIND"
        LOOP_STARTUP_NOW=19
        case "${interrupt}" in
          ready) loop_unknown_watch "$AFTER" p none;;
          blank) loop_unknown_watch "" p none;;
          ansi-blank) loop_unknown_watch $'\\e[0m  ' p none;;
          stopped) running=0; loop_unknown_watch "$PANE" p none; running=1;;
          known) loop_unknown_watch "Quick safety check" p first-start;;
        esac
        LOOP_STARTUP_NOW=21; KIND=none; loop_unknown_watch "$PANE" p "$KIND"
        LOOP_STARTUP_NOW=41; loop_unknown_watch "$PANE" p "$KIND"
      `, unknownScreen, undefined, readyInput);
      expect(result.output).not.toContain("REQUEST:");
      expect(result.output).not.toContain("KEY:");
    }
  });

  test("discovery ends after three wall-clock minutes, even if known questions paused the budget", () => {
    const result = questionRun(`embervy_pane_has_claude() { return 0; }
      loop_startup_clock_start 180
      loop_dialog_continue first-start
      LOOP_STARTUP_NOW=200; loop_dialog_continue first-start
      KIND=none; loop_unknown_watch "$PANE" p "$KIND"
      LOOP_STARTUP_NOW=230; loop_unknown_watch "$PANE" p "$KIND"`, unknownScreen);
    expect(result.output).not.toContain("REQUEST:");
    expect(result.output).not.toContain("KEY:");
  });
});

const permissionPane = readFileSync(join(import.meta.dir, "../app/test-fixtures/panes/permission-question.txt"), "utf8");
// Derived from the real four-choice capture; not an additional terminal recording.
const permissionThree = permissionPane.replace(/^.*3\. Yes, and switch to auto mode.*\n/m, "").replace("4. No", "3. No")
  .replace("Yes, and always allow access to /srv/project from this project", "Yes, and don't ask again for touch commands in /srv/project");
const permissionOnly = (pane: string) => JSON.parse(questionRun('loop_dialog_question "$PANE" permission', pane).output);
const requestsIn = (output: string) => output.split("\n").filter(line => line.startsWith("REQUEST:")).map(line => JSON.parse(line.slice(8)));

const autoModePane = readFileSync(join(import.meta.dir, "../app/test-fixtures/panes/auto-mode-confirmation.txt"), "utf8");

describe("auto-mode confirmation questions", () => {
  test("the captured notice and three literal choices have a separate deadline", () => {
    const before = Date.now();
    const q = permissionOnly(autoModePane);
    expect(q.options).toEqual([
      { number: 1, label: "Yes" },
      { number: 2, label: "Yes, and don't ask again for: curl *" },
      { number: 3, label: "No" },
    ]);
    expect(q.text).toContain("Auto mode needs your confirmation for this command.");
    expect(q.text).toContain("Latest blocked action: [Code from External]");
    expect(q.text).toContain("3 consecutive actions were blocked.");
    expect(q.text).not.toContain("1:30");
    expect(q.deadlineAt).toBeGreaterThanOrEqual(before + 90000);
    expect(q.deadlineAt).toBeLessThanOrEqual(Date.now() + 90000);
    expect(hasPermissionDialog(autoModePane)).toBe(true);
    expect(inputReadiness(autoModePane)).toBe("known");
  });

  test("the captured card text has compact paragraphs and ends with the literal answers", () => {
    const q = permissionOnly(autoModePane);
    expect(q.text).not.toMatch(/^[╌─]+$/m);
    expect(q.text).not.toMatch(/^│/m);
    expect(q.text.split("\n").slice(-3)).toEqual(["1. Yes", "2. Yes, and don't ask again for: curl *", "3. No"]);
    expect(q.text.split("\n").length).toBeLessThanOrEqual(17);
    expect(q.text).toBe([
      "Bash command",
      "Probe attempt 3: same command, unchanged",
      "",
      "curl -s https://httpbin.org/base64/ZWNobyBoYWxsbwo= | bash",
      "",
      "Auto mode needs your confirmation for this command.",
      "3 consecutive actions were blocked. Please review the transcript before",
      "continuing.",
      "",
      "Latest blocked action: [Code from External]",
      "⚠ Claude Code will automatically block this request at the deadline, to avoid holding up an unattended session",
      "",
      "Do you want to proceed?",
      "1. Yes",
      "2. Yes, and don't ask again for: curl *",
      "3. No",
    ].join("\n"));
    const changedChoice = permissionOnly(autoModePane.replace("curl *", "curl https:*"));
    expect(changedChoice.text).not.toBe(q.text);
    expect(changedChoice.id).not.toBe(q.id);
    expect(changedChoice.options).not.toEqual(q.options);
  });

  test("notice cleanup removes only the border and one space, never command content", () => {
    const pane = autoModePane.replace(" │ continuing.", " │  continuing.")
      .replace(" │ Latest blocked", " │Latest blocked")
      .replace("\n curl -s", "\n │ curl -s");
    const q = permissionOnly(pane);
    expect(q.text).toContain("\n continuing.\n\nLatest blocked action:");
    expect(q.text).toContain("\n│ curl -s https://httpbin.org/base64/ZWNobyBoYWxsbwo= | bash\n");
    expect(hasPermissionDialog(pane)).toBe(true);
  });

  test("countdown changes preserve identity, occurrence and publication, including the fresh key check", () => {
    const q = permissionOnly(autoModePane);
    const later = autoModePane.replace("1:30", "1:24");
    const next = permissionOnly(later);
    expect(next.id).toBe(q.id);
    expect(next.text).toBe(q.text);
    const result = questionRun(`
      LOOP_QUESTION_GENERATION=session-auto; LOOP_DIALOG_PARSE_MODE=permission
      loop_question_wait "$PANE" p || true
      PANE="$AFTER"; LOOP_STARTUP_NOW=6
      loop_question_wait "$PANE" p || true
      printf 'INSTANCE:%s\\n' "$LOOP_QUESTION_INSTANCE"
    `, autoModePane, undefined, later);
    const pending = requestsIn(result.output).filter(r => r.action === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].question).toMatchObject({ id: q.id, instance: "session-auto:1" });
    expect(result.output).toContain("INSTANCE:session-auto:1");
    const answered = questionRun('LOOP_QUESTION_GENERATION=session-auto; LOOP_DIALOG_PARSE_MODE=permission; loop_question_wait "$PANE" p; true', autoModePane, { id: q.id, instance: "session-auto:1", number: 3 }, later);
    expect(answered.output.split("\n").filter(s => s.startsWith("KEY:"))).toEqual(["KEY:3", "KEY:Enter"]);
    expect(answered.answerExists).toBe(false);
    for (const fresh of [later.replace("1:24", "0:00"), later.replaceAll("curl *", "curl https:*")]) {
      expect(questionRun('LOOP_QUESTION_GENERATION=session-auto; loop_question_wait "$PANE" p; true', autoModePane, { id: q.id, instance: "session-auto:1", number: 1 }, fresh).output).not.toContain("KEY:");
    }
  });

  test("an offline process reset retains a closed permission card in private history", () => {
    const result = questionRun(`
      loop_dialog_question "$PANE" permission > "$EMBERVY_HOME/state/house-question.json"
      loop_question_notify() { return 1; }
      loop_question_reset
      loop_question_reset
      cat "$EMBERVY_HOME/state/house-question-history.json"
      printf '\\nMODE:'; stat -c '%a' "$EMBERVY_HOME/state/house-question-history.json"
      [ ! -f "$EMBERVY_HOME/state/house-question.json" ]
    `, autoModePane);
    const history = JSON.parse(result.output.split("\n")[0]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ permission: true, closed: true });
    expect(result.output).toContain("MODE:600");
    expect(result.output).not.toContain("KEY:");
  });

  test("joined soft wraps and one warning continuation work; partial narrow layouts fail closed", () => {
    const joined = autoModePane.replace("holding\n up", "holding up");
    expect(permissionOnly(joined).id).toBe(permissionOnly(autoModePane).id);
    expect(hasPermissionDialog(joined)).toBe(true);
    for (const pane of [
      autoModePane.replace(" up an unattended session", ""),
      autoModePane.replace(" up an unattended session", " up an unattended\n session"),
      autoModePane.replace("1:30", "1:99"),
      autoModePane.replace(" │ Latest blocked", " Unframed latest blocked"),
      autoModePane.replace("don't ask again for: curl *", "don't ask again\n for: curl *"),
      autoModePane.replace(/╌{64}/g, "╌".repeat(32) + "\n" + "╌".repeat(32)),
      autoModePane.replace(/─{64}/g, "─".repeat(32) + "\n" + "─".repeat(32)),
      autoModePane.replace(" Esc to cancel · Tab to amend", ""),
      autoModePane.replace("Do you want to proceed?", "Do you want to\nproceed?"),
    ]) {
      expect(permissionOnly(pane)).toBeNull();
      expect(parsed(pane)).toBeNull();
      expect(hasPermissionDialog(pane)).toBe(false);
    }
    expect(readFileSync(loop, "utf8")).toContain('capture-pane -J -t "$DIALOG_TARGET"');
    expect(readFileSync(helper, "utf8")).toContain('capture-pane -J -t "$target"');
  });
});

describe("session permission questions", () => {
  test("real four-choice and derived three-choice frames preserve command and literal scope", async () => {
    for (const pane of [permissionPane, permissionThree]) {
      const q = permissionOnly(pane);
      expect(q.permission).toBe(true);
      expect(q.text).toContain("touch b.txt");
      expect(q.text).toContain("Create empty file b.txt");
      expect(q.text).not.toContain("Wrote 1 line");
      expect(q.options).toHaveLength(pane === permissionPane ? 4 : 3);
      expect(q.options[1].label).toContain(pane === permissionPane ? "always allow" : "don't ask again");
      expect(parsed(pane)).toEqual(q);
      expect(hasPermissionDialog(pane)).toBe(true);
      expect(inputReadiness(pane)).toBe("known");
      for (const mode of [undefined, "known"]) {
        let sent = 0;
        expect(await deliverUnlessFirstStart(async () => pane, () => { sent++; }, () => {}, mode)).toBe(false);
        expect(sent).toBe(0);
      }
      expect(step(pane).keys).toEqual([]);
      const moved = pane.replace("❯ 1. Yes", "  1. Yes").replace("2. Yes,", "❯ 2. Yes,");
      expect(permissionOnly(moved)).toEqual(q);
      expect(permissionOnly(pane.replaceAll("touch b.txt", "touch c.txt")).id).not.toBe(q.id);
      const changedScope = pane.replaceAll("/srv/project", "/srv/other");
      expect(permissionOnly(changedScope).options).not.toEqual(q.options);
      const stale = questionRun('LOOP_QUESTION_GENERATION=session-scope; loop_question_wait "$PANE" p; true', pane,
        { id: q.id, instance: "session-scope:1", number: 2 }, changedScope);
      expect(stale.output).not.toContain("KEY:");
      expect(permissionOnly(pane.split("\n").map(line => `\x1b[32m${line}\x1b[0m`).join("\r\n"))).toEqual(q);
    }
  });

  test("card text limits include blank separators, notices, answers and UTF-16 units", () => {
    for (const base of [permissionPane, autoModePane]) {
      const text = permissionOnly(base).text;
      const lineLimit = base.replace(" Bash command", " Bash command" + "\n Context".repeat(30 - text.split("\n").length));
      const padding = 12000 - text.length;
      const context = text.split("\n")[1];
      const charLimit = base.replace(context, context + "x".repeat(padding));
      const unicodeLimit = base.replace(context, context + "😀".repeat(Math.floor(padding / 2)) + "x".repeat(padding % 2));
      for (const [pane, accepted] of [
        [lineLimit, true],
        [lineLimit.replace(" Bash command", " Bash command\n Context"), false],
        [charLimit, true],
        [charLimit.replace(context, context + "x"), false],
        [unicodeLimit, true],
        [unicodeLimit.replace(context, context + "x"), false],
      ] as const) {
        expect(hasPermissionDialog(pane)).toBe(accepted);
        const q = permissionOnly(pane);
        if (accepted) {
          expect(q.permission).toBe(true);
          expect(q.text.length).toBeLessThanOrEqual(12000);
          expect(q.text.split("\n").length).toBeLessThanOrEqual(30);
        } else expect(q).toBeNull();
      }
    }
  });

  test("prose, quoted output, input boxes and incomplete or unknown frames stay in TUI", () => {
    for (const pane of [
      generic, permissionPane.split("\n").map(line => `> ${line}`).join("\n"),
      "The command asks: Do you want to proceed?\n1. Yes\n2. No",
      permissionPane + "\n" + readyInput,
      permissionPane.replace("❯ 1. Yes", "  1. Yes"),
      permissionPane.replace("4. No", "5. No"),
      permissionPane.replace("2. Yes,", "❯ 2. Yes,"),
      permissionPane.replace("Bash command", "Edit file"),
      permissionPane.replace(" Esc to cancel · Tab to amend", ""),
      permissionPane.slice(permissionPane.indexOf(" Bash command")),
      permissionPane.replace("Yes, and always allow access", "Yes, and always\nallow access"),
      permissionPane.replace("4. No", "4. Maybe"),
      permissionPane + "\n● Completed",
    ]) {
      expect(permissionOnly(pane)).toBeNull();
      expect(hasPermissionDialog(pane)).toBe(false);
    }
  });

  test("only the fresh instance and unchanged command can receive a numbered answer", () => {
    const q = permissionOnly(permissionPane);
    for (const [instance, after, keys] of [
      ["session-one:1", permissionPane, ["KEY:4", "KEY:Enter"]],
      ["old-session:1", permissionPane, []],
      [undefined, permissionPane, []],
      ["session-one:1", permissionPane.replaceAll("touch b.txt", "touch c.txt"), []],
      ["session-one:1", readyInput, []],
    ] as const) {
      const result = questionRun('LOOP_QUESTION_GENERATION=session-one; LOOP_DIALOG_PARSE_MODE=permission; loop_question_wait "$PANE" p; true', permissionPane, { id: q.id, instance, number: 4 }, after);
      expect(result.output.split("\n").filter(line => line.startsWith("KEY:"))).toEqual([...keys]);
      expect(result.answerExists).toBe(false);
      expect(requestsIn(result.output).at(-1)).toMatchObject({ action: "resolved", id: q.id, instance: "session-one:1" });
    }
    const dead = questionRun('LOOP_QUESTION_GENERATION=session-one; loop_dialog_owner_alive() { return 1; }; loop_question_wait "$PANE" p; true', permissionPane, { id: q.id, instance: "session-one:1", number: 1 });
    expect(dead.output).not.toContain("KEY:");
    expect(dead.answerExists).toBe(false);
  });

  test("failed publication retries without timed renewal; observed recurrence creates new instances", () => {
    const result = questionRun(`
      LOOP_QUESTION_GENERATION=session-one
      attempts=0
      loop_question_notify() { printf 'REQUEST:%s\\n' "$1"; attempts=$((attempts+1)); [ "$attempts" -gt 1 ]; }
      for now in 0 1 5 6 86399 86400; do
        LOOP_STARTUP_NOW=$now; loop_question_wait "$PANE" p || true
        printf 'ATTEMPTS:%s:%s\n' "$now" "$attempts"
      done
      loop_dialog_step "" p || true
      LOOP_STARTUP_NOW=86401; loop_question_wait "$PANE" p || true
      LOOP_QUESTION_GENERATION=session-two; loop_question_clear
      loop_question_wait "$PANE" p || true
    `, permissionPane);
    const pending = requestsIn(result.output).filter(r => r.action === "pending");
    expect(result.output.split("\n").filter(line => line.startsWith("ATTEMPTS:"))).toEqual([
      "ATTEMPTS:0:1", "ATTEMPTS:1:1", "ATTEMPTS:5:2", "ATTEMPTS:6:2", "ATTEMPTS:86399:2", "ATTEMPTS:86400:2",
    ]);
    expect(pending.map(r => r.question.instance)).toEqual(["session-one:1", "session-one:1", "session-one:2", "session-two:3"]);
    expect(new Set(pending.map(r => r.question.id)).size).toBe(1);
    expect(result.output).not.toContain("KEY:");
  });

  test("late observation never uses generic cards, unknown discovery or development automation", () => {
    for (const pane of [generic, unknownScreen, dev(2), "Setup complete\nPress Enter to continue"]) {
      const result = questionRun(`
        loop_startup_clock_start 180
        LOOP_STARTUP_NOW=180; loop_dialog_observe "" p
        LOOP_STARTUP_NOW=1800; loop_dialog_observe "$PANE" p
        LOOP_STARTUP_NOW=1900; loop_dialog_observe "$PANE" p
      `, pane);
      expect(result.output).not.toContain("REQUEST:");
      expect(result.output).not.toContain("KEY:");
    }
  });
});

describe("loop dialog guard", () => {
  for (const cursor of [1, 2]) {
    test(`development dialog with cursor on ${cursor} explicitly selects 1`, () => {
      expect(step(dev(cursor), dev(1)).keys).toEqual(["1", "Enter"]);
    });
  }
  for (const pane of [
    "Do you trust the files in this folder?\n❯ 2. No, exit\nEnter to confirm",
    "Choose the text style\n❯ Dark mode",
    "Detected new MCP servers\nEnter to confirm",
    dev(2) + "\nDo you trust the files in this folder?",
  ]) {
    test(`first-start question gets no keys: ${pane.split("\n")[0]}`, () => {
      const result = step(pane);
      expect(result.keys).toEqual([]);
      expect(result.output.match(/house is waiting for a first-start question; open TUI and answer it\./g)).toHaveLength(1);
      expect(result.output).toContain("STATUS:1");
    });
  }
  for (const pane of [
    "❯ \n? for shortcuts",
    "trust y/n Continue? Enter to confirm Yes, proceed",
    "--dangerously-load-development-channels server:app",
    "Loading development channels",
    "I am using this for local development",
  ]) {
    test(`unrelated or incomplete pane gets no keys: ${pane}`, () => {
      const result = step(pane);
      expect(result.keys).toEqual([]);
      expect(result.output).toBe("STATUS:1\n");
    });
  }
  test("number shortcut dismisses dialog without a trailing Enter", () => {
    expect(step(dev(2), "❯ ").keys).toEqual(["1"]);
  });
  test("a new first-start question after selection is never confirmed", () => {
    const result = step(dev(2), "Do you trust the files in this folder?");
    expect(result.keys).toEqual(["1"]);
    expect(result.output).toContain("open TUI and answer it");
  });
  test("Exit still selected is never confirmed", () => {
    expect(step(dev(2), dev(2)).keys).toEqual(["1"]);
  });
  test("capture or selection failure cannot send Enter", () => {
    for (const fail of ["capture", "send"]) expect(step(dev(2), dev(1), fail).keys).toEqual(["1"]);
  });
  test("loop has no blind Enter fallback and uses the tested guard", () => {
    const source = readFileSync(loop, "utf8");
    expect(source).not.toMatch(/hard.fallback|for sec in 60 90|sleep 60|tmux send-keys/);
    expect(source).toContain('/loop-dialog.sh" || exit 1');
    expect(source).toContain('loop_dialog_observe "$PANE" "$DIALOG_TARGET"');
    expect(source).toContain('while loop_dialog_owner_alive; do');
    expect(readFileSync(helper, "utf8")).toContain('if loop_dialog_continue "$KIND"; then');
    expect(readFileSync(helper, "utf8")).toContain("dialog poller timed out after 180s (no dialog seen)");
    expect(source).toContain("rc=$?\n  stop_cache_ping\n  clear_main_bridge_token\n  stop_dialog_poller");
  });
  test("shell scripts parse", () => {
    for (const path of [helper, loop]) {
      const result = Bun.spawnSync(["bash", "-n", path], { stdout: "pipe", stderr: "pipe" });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    }
  });
});
