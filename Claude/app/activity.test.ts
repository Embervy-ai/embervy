import { describe, expect, test } from "bun:test";
import { classifyActivity, classifyFromEvents, classifyObservedActivity } from "./activity";

const now = 100_000;

describe("classifyActivity", () => {
  test("idle when no agent process is present", () => {
    expect(classifyActivity({ processRunning: false, paneText: "" })).toBe("idle");
  });

  test("thinking while terminal output is active", () => {
    expect(classifyActivity({ processRunning: true, paneText: "✻ Thinking…" })).toBe("thinking");
  });

  test("tool while a tool line is visible", () => {
    expect(classifyActivity({ processRunning: true, paneText: "● Read(input.txt)" })).toBe("tool");
  });

  test("done at a recently changed prompt", () => {
    expect(classifyActivity({ processRunning: true, paneText: "Finished the task.\n❯", paneChangedAt: now - 1_000, now })).toBe("done");
  });

  test("needs_input for a permission prompt", () => {
    expect(classifyActivity({ processRunning: true, paneText: "Do you want to allow this command? (y/n)" })).toBe("needs_input");
  });

  test("needs_input for a trust dialog", () => {
    expect(classifyActivity({ processRunning: true, paneText: "Trust this folder?\n❯ 1. Yes\n  2. No" })).toBe("needs_input");
  });

  test("needs_input for a selection menu", () => {
    expect(classifyActivity({ processRunning: true, paneText: "Select one option\n❯ 1. Continue\n  2. Cancel" })).toBe("needs_input");
  });

  test("an empty waiting input is not needs_input", () => {
    expect(classifyActivity({ processRunning: true, paneText: "❯", paneChangedAt: now - 60_000, now })).toBe("idle");
  });

  test("an answered permission prompt yields to newer thinking output", () => {
    expect(classifyActivity({
      processRunning: true,
      paneText: "Do you want to allow this command? (y/n)\nYes\n✻ Thinking…",
    })).toBe("thinking");
  });

  test("an answered dialog is no longer needs_input", () => {
    expect(classifyActivity({
      processRunning: true,
      paneText: "Trust this folder?\n❯ 1. Yes\n  2. No\nYes",
    })).toBe("idle");
  });

  test("a newer thinking marker wins over an older tool marker", () => {
    expect(classifyActivity({
      processRunning: true,
      paneText: "● Read(input.txt)\n✻ Thinking…",
    })).toBe("thinking");
  });

  test("a prompt without a known change time starts idle", () => {
    expect(classifyActivity({ processRunning: true, paneText: "❯", now })).toBe("idle");
  });

  test("finished thinking summary and footer are idle", () => {
    const paneText = "✻ Finished for 1m 21s\n────────────────\n❯\n────────────────\n  manual mode on";
    expect(classifyActivity({ processRunning: true, paneText, paneChangedAt: now - 45_000, now })).toBe("idle");
  });

  test("a running spinner remains thinking", () => {
    expect(classifyActivity({ processRunning: true, paneText: "✻ Thinking… (esc to interrupt)" })).toBe("thinking");
  });

  test("a fresh finished summary at the empty prompt is done", () => {
    expect(classifyActivity({ processRunning: true, paneText: "✻ Pondered for 8s\n❯ ", paneChangedAt: now - 1_000, now })).toBe("done");
  });

  test("a completed tool line above the empty prompt is idle", () => {
    expect(classifyActivity({
      processRunning: true,
      paneText: "● Read(input.txt)\n  Read 12 lines\n❯ \n  ? for shortcuts",
      paneChangedAt: now - 45_000,
      now,
    })).toBe("idle");
  });

  test("static text without a spinner is not thinking", () => {
    expect(classifyActivity({ processRunning: true, paneText: "Finished response text with no active spinner" })).toBe("idle");
  });

  test("a spinner with a duration but no interrupt hint is finished", () => {
    expect(classifyActivity({ processRunning: true, paneText: "✻ Thinking… for 8s", paneChangedAt: now - 45_000, now })).toBe("idle");
  });

  test("an interruptible spinner remains active despite elapsed duration", () => {
    expect(classifyActivity({ processRunning: true, paneText: "✻ Thinking… for 8s (esc to interrupt)" })).toBe("thinking");
  });

  const inputBox = "────────────────\n❯ \n────────────────";
  const quietFooter = "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents";
  const liveFooter = "  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt · ← for agents";
  const finished = "✻ Brewed for 28s · done 6:31 PM";

  test("live spinners above an empty input remain thinking with or without a footer hint", () => {
    for (const spinner of [
      "· Razzmatazzing… (running UserPromptSubmit hook · 0s)",
      "✽ Razzmatazzing… (running UserPromptSubmit hook · 3s)",
      "✽ Razzmatazzing…",
      "· Razzmatazzing… (16s · thinking)",
      "· Razzmatazzing… (18s · ↓ 200 tokens · thought for 2s)",
      "✽ Razzmatazzing… (23s · ↓ 465 tokens)",
      "✢ Razzmatazzing…",
    ]) {
      for (const footer of spinner.includes("thought for") ? [liveFooter] : [liveFooter, quietFooter]) {
        expect(classifyObservedActivity([], {
          paneText: `${finished}\n${spinner}\n${inputBox}\n${footer}`,
          paneChangedAt: now - 1_000,
        }, now)).toBe("thinking");
      }
    }
  });

  test("a tool after a live spinner wins despite the empty input below", () => {
    expect(classifyActivity({
      paneText: `✽ Razzmatazzing…\n⏺ Bash(echo test)\n${inputBox}\n${liveFooter}`,
    })).toBe("tool");
  });

  test("the footer interrupt hint alone means working", () => {
    expect(classifyActivity({ paneText: `${inputBox}\n${liveFooter}\n\n` })).toBe("thinking");
    expect(classifyActivity({ paneText: `${liveFooter}\none\ntwo\nthree\nfour\nfive\n${inputBox}` })).toBe("idle");
  });

  test("a newer finished spinner restores done or idle", () => {
    for (const summary of [finished, "✢ Brewed"])
      for (const [age, expected] of [[1_000, "done"], [45_000, "idle"]] as const) {
        expect(classifyActivity({
          paneText: `✽ Razzmatazzing…\n${summary}\n${inputBox}\n${quietFooter}`,
          paneChangedAt: now - age, now,
        })).toBe(expected);
      }
  });

  test("a current permission dialog wins over live spinner and footer", () => {
    expect(classifyActivity({
      paneText: `✽ Razzmatazzing…\nDo you want to allow this command? (y/n)\n${liveFooter}`,
    })).toBe("needs_input");
  });

  test("copy mode normally classifies the Run 002 probe tail", () => {
    const paneText = `  quiet output with no active tool
  the agent has finished and is waiting
✻ Completed for 1m 21s
───────────────────────────────────────────────────────────────
❯\u00a0
───────────────────────────────────────────────────────────────
  manual mode on · ? for shortcuts
                                                814398 tokens
                                  current: latest
`;
    expect(classifyActivity({
      processRunning: true,
      paneInMode: true,
      paneText,
      paneChangedAt: now - 45_000,
      now,
    })).toBe("idle");
  });
});

describe("classifyFromEvents", () => {
  const iso = (ageMs: number) => new Date(now - ageMs).toISOString();

  test("tool_start is tool", () => {
    expect(classifyFromEvents([{ ts: iso(1_000), event: "tool_start", tool: "Read" }], now)).toBe("tool");
  });

  test("turn_start and tool_end are thinking", () => {
    expect(classifyFromEvents([{ ts: iso(1_000), event: "turn_start" }], now)).toBe("thinking");
    expect(classifyFromEvents([{ ts: iso(1_000), event: "tool_end" }], now)).toBe("thinking");
  });

  test("recent turn_end is done", () => {
    expect(classifyFromEvents([{ ts: iso(15_000), event: "turn_end" }], now)).toBe("done");
  });

  test("older turn_end is idle", () => {
    expect(classifyFromEvents([{ ts: iso(15_001), event: "turn_end" }], now)).toBe("idle");
  });

  test("stale and missing events request TUI fallback", () => {
    expect(classifyFromEvents([{ ts: iso(10 * 60_000 + 1), event: "tool_start" }], now)).toBeNull();
    expect(classifyFromEvents([], now)).toBeNull();
    expect(classifyObservedActivity([], { processRunning: true, paneText: "✻ Thinking…" }, now)).toBe("thinking");
  });

  test("tmux needs_input overrides a current hook state", () => {
    expect(classifyObservedActivity(
      [{ ts: iso(1_000), event: "tool_start", tool: "Bash" }],
      { processRunning: true, paneText: "Do you want to allow this command? (y/n)" },
      now,
    )).toBe("needs_input");
  });

  test("a dead process never reports a hook as working", () => {
    expect(classifyObservedActivity(
      [{ ts: iso(1_000), event: "tool_start", tool: "Bash" }],
      { processRunning: false, paneText: "" },
      now,
    )).toBe("idle");
  });
});
