import { describe, expect, test } from "bun:test";
import { mapTerminalInput, terminalInputActivityDetail } from "./terminal-input";

async function runTmux(args: string[]) {
  const proc = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("terminalInputActivityDetail", () => {
  test("records key modifiers without text", () => {
    expect(terminalInputActivityDetail({ key: "c", ctrl: true })).toEqual({ key: "c", ctrl: true, alt: false });
    expect(terminalInputActivityDetail({ key: "!", alt: true })).toEqual({ key: "!", ctrl: false, alt: true });
  });

  test("records only text length", () => {
    expect(terminalInputActivityDetail({ text: "secret ✓" })).toEqual({ text_length: 8 });
    expect(terminalInputActivityDetail({ text: "secret", key: "Enter" })).toEqual({ key: "Enter", ctrl: false, alt: false });
  });
});

describe("mapTerminalInput", () => {
  test("sends arbitrary text literally", () => {
    const text = `semi; quote\" dollar $(echo unsafe) unicode ✓ é`;
    expect(mapTerminalInput({ text })).toEqual(["-l", "", text]);
  });

  test("protects leading options and terminal tmux separators", () => {
    expect(mapTerminalInput({ text: "-n" })).toEqual(["-l", "", "-n"]);
    expect(mapTerminalInput({ text: ";" })).toEqual(["-l", "", "\\;"]);
    expect(mapTerminalInput({ text: "abc;" })).toEqual(["-l", "", "abc\\;"]);
    expect(mapTerminalInput({ text: "a;b;c" })).toEqual(["-l", "", "a;b;c"]);
    expect(mapTerminalInput({ text: "slash\\;" })).toEqual(["-l", "", "slash\\\\;"]);
  });

  test("enforces the text length limit", () => {
    expect(mapTerminalInput({ text: "x".repeat(2000) })).toEqual(["-l", "", "x".repeat(2000)]);
    expect(() => mapTerminalInput({ text: "x".repeat(2001) })).toThrow();
  });

  test("preserves semicolons through an argv tmux pane probe", async () => {
    const socket = `terminal-input-port-test-${process.pid}`;
    try {
      const created = await runTmux(["-L", socket, "new-session", "-d", "-s", "probe", "cat"]);
      if (created.exitCode !== 0) throw new Error(created.stderr);
      for (const text of ["a;b;c", ";", "abc;", "slash\\;"]) {
        const sent = await runTmux(["-L", socket, "send-keys", "-t", "probe", ...mapTerminalInput({ text })]);
        expect(sent.exitCode).toBe(0);
      }
      const captured = await runTmux(["-L", socket, "capture-pane", "-p", "-t", "probe"]);
      expect(captured.exitCode).toBe(0);
      expect(captured.stdout).toContain("a;b;c;abc;slash\\;");
    } finally {
      await runTmux(["-L", socket, "kill-server"]);
    }
  });

  test.each([
    ["Enter", ["Enter"]], ["Escape", ["Escape"]], ["Tab", ["Tab"]], ["BTab", ["BTab"]],
    ["Up", ["Up"]], ["Down", ["Down"]], ["Left", ["Left"]], ["Right", ["Right"]],
  ])("maps named key %s", (key, expected) => {
    expect(mapTerminalInput({ key })).toEqual(expected);
  });

  test("maps ctrl and alt combinations", () => {
    expect(mapTerminalInput({ key: "c", ctrl: true })).toEqual(["C-c"]);
    expect(mapTerminalInput({ key: "C", ctrl: true })).toEqual(["C-C"]);
    expect(mapTerminalInput({ key: "!", alt: true })).toEqual(["M-!"]);
    expect(mapTerminalInput({ key: "x", alt: true })).toEqual(["M-x"]);
    expect(mapTerminalInput({ key: "@", ctrl: true })).toEqual(["C-@"]);
  });

  test("rejects unknown keys and malformed combinations", () => {
    expect(() => mapTerminalInput({ key: "Delete" })).toThrow();
    expect(() => mapTerminalInput({ key: "enter" })).toThrow();
    expect(() => mapTerminalInput({ key: "xy", ctrl: true })).toThrow();
    expect(() => mapTerminalInput({ key: "Enter", alt: true })).toThrow();
    expect(() => mapTerminalInput({ text: "x", key: "Enter" })).toThrow();
    expect(() => mapTerminalInput({})).toThrow();
    expect(() => mapTerminalInput({ text: 42 })).toThrow();
  });
});
