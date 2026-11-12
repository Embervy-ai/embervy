import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// inlet.sh is the UserPromptSubmit hook. In a Brain house the harness runs
// `claude -p` with EMBERVY_BRAIN_SUBTURN=1 and injects its own context block;
// the hook must then stay completely silent (exit 0, no output, nothing read or
// written) or every turn would carry the context twice. Everywhere else it
// runs normally. Runs the real script against a throw-away EMBERVY_HOME with
// a fake inlet-worker — no network, no real state.

const INLET = join(import.meta.dir, "inlet.sh");
const PROMPT = JSON.stringify({ prompt: "hello there", session_id: "s-1" });

let home = "";
const workerMarker = () => join(home, "worker-called");

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "inlet-test-"));
  mkdirSync(join(home, "Claude", "scripts"), { recursive: true });
  writeFileSync(
    join(home, "Claude", "scripts", "inlet-worker.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'writeFileSync(join(import.meta.dir, "..", "..", "worker-called"), process.argv[2] ?? "");',
      'console.log("FAKE-CONTEXT for " + process.argv[2]);',
      'console.error("confidence gate suppressed all hits");',
      "",
    ].join("\n"),
  );
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

function reset() {
  for (const p of [workerMarker(), join(home, "state"), join(home, "logs")]) rmSync(p, { recursive: true, force: true });
}

// The env is built from scratch: the test must not inherit Brain's sub-turn
// marker (under either name) from wherever it happens to run.
async function runInlet(extra: Record<string, string>, stdin = PROMPT) {
  const proc = Bun.spawn(["bash", INLET], {
    cwd: home,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: home,
      EMBERVY_HOME: home,
      EMBERVY_TIMEZONE: "UTC",
      ...extra,
    },
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

describe("inlet.sh in a Brain house (EMBERVY_BRAIN_SUBTURN=1)", () => {
  test("exits 0 and prints nothing; the worker is never called and no state is written", async () => {
    reset();
    const r = await runInlet({ EMBERVY_BRAIN_SUBTURN: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(existsSync(workerMarker())).toBe(false);
    expect(existsSync(join(home, "state"))).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
  });

  test("also silent for a payload with no prompt (the branch that answers {} elsewhere)", async () => {
    reset();
    const r = await runInlet({ EMBERVY_BRAIN_SUBTURN: "1" }, "{}");
    expect(r).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  test("the skip is in the script before anything is loaded or read", () => {
    const src = readFileSync(INLET, "utf8");
    const skip = src.indexOf("if embervy_is_subturn; then");
    expect(skip).toBeGreaterThan(-1);
    // Only the shared reader's functions come first (sourcing it reads nothing);
    // the .env is read as data through shared/scripts/env-file.sh (no `source` any more).
    expect(src.indexOf(". \"$ENV_LIB\"")).toBeLessThan(skip);
    expect(src.indexOf("embervy_env_load -x")).toBeGreaterThan(-1);
    expect(skip).toBeLessThan(src.indexOf("embervy_env_load -x"));
    expect(skip).toBeLessThan(src.indexOf("INPUT=$(cat)"));
  });
});

test("the same session receives the clock on turns one, six and eleven", async () => {
  reset();
  for (let turn = 1; turn <= 11; turn++) {
    const result = await runInlet({});
    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout).hookSpecificOutput?.additionalContext || "").includes("⏰")).toBe(turn % 5 === 1);
  }
});

test("a new session receives the clock immediately", async () => {
  reset();
  await runInlet({});
  await runInlet({});
  const result = await runInlet({}, JSON.stringify({ prompt: "hello", session_id: "s-2" }));
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput?.additionalContext).toContain("⏰");
  expect(readFileSync(join(home, "state/inlet-turn-counter"), "utf8").trim()).toBe("1");
  expect(readFileSync(join(home, "state/inlet-turn-session"), "utf8").trim()).toBe("s-2");
});

for (const mode of ["missing", "unreadable", "malformed"]) test(`${mode} turn counter still supplies the clock`, async () => {
  reset();
  await runInlet({});
  const counter = join(home, "state/inlet-turn-counter");
  rmSync(counter);
  if (mode === "unreadable") symlinkSync("/proc/self/mem", counter);
  if (mode === "malformed") writeFileSync(counter, "not a number\n");
  const result = await runInlet({});
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).hookSpecificOutput?.additionalContext).toContain("⏰");
  expect(readFileSync(counter, "utf8").trim()).toBe("1");
});

describe("inlet.sh everywhere else is unchanged", () => {
  for (const [label, extra] of [
    ["variable unset", {}],
    ["variable empty", { EMBERVY_BRAIN_SUBTURN: "" }],
    ["variable 0 (only the exact value 1 skips, like reply-gateway.sh)", { EMBERVY_BRAIN_SUBTURN: "0" }],
  ] as const) {
    test(label, async () => {
      reset();
      const r = await runInlet({ ...extra });
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(out.hookSpecificOutput.additionalContext).toContain("FAKE-CONTEXT for hello there");
      expect(readFileSync(workerMarker(), "utf8")).toBe("hello there");
      expect(r.stdout).not.toContain("confidence gate suppressed");
      expect(readFileSync(join(home, "logs/inlet.log"), "utf8")).toContain("confidence gate suppressed all hits");
      await runInlet({ ...extra });
      expect(readFileSync(join(home, "logs/inlet.log"), "utf8").match(/confidence gate suppressed/g)).toHaveLength(2);
      expect(readFileSync(join(home, "state", "inlet-turn-counter"), "utf8").trim()).toBe("2");
    });
  }

  test("no prompt in the payload still answers {}", async () => {
    reset();
    const r = await runInlet({}, "{}");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("{}");
    expect(existsSync(workerMarker())).toBe(false);
  });
});
