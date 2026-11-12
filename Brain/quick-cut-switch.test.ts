import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeShape, FRESH_CHARS_DEFAULT } from "./brain";

const scripts = join(import.meta.dir, "scripts");
const switches = [undefined, "off", "", "onn", "ON", "true", "on ", "on"] as const;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "quick-cut-switch-"));
  for (const dir of ["state", "logs"]) mkdirSync(join(root, dir));
  return root;
}

// Minimal sandboxes may omit the alternatives symlink while retaining the real AWK binary.
export function shellPath(root: string, path = "/usr/local/bin:/usr/bin:/bin"): string {
  if (Bun.which("awk", { PATH: path })) return path;
  const awk = Bun.which("mawk", { PATH: path }) ?? Bun.which("gawk", { PATH: path });
  if (!awk) throw new Error("Shell fixtures require an AWK implementation");
  const bin = join(root, "shell-bin");
  mkdirSync(bin, { recursive: true });
  if (!existsSync(join(bin, "awk"))) symlinkSync(awk, join(bin, "awk"));
  return `${bin}:${path}`;
}

function environment(root: string, value: string | undefined): Record<string, string> {
  return {
    PATH: shellPath(root),
    HOME: root,
    BRAIN_HOME: root,
    BRAIN_NO_ENV_FILE: "1",
    BUN_BIN: process.execPath,
    ...(value === undefined ? {} : { BRAIN_QUICK_CUT: value }),
  };
}

function runShell(root: string, value: string | undefined, source: string) {
  const result = Bun.spawnSync(["bash", "-uc", source], {
    cwd: root, env: environment(root, value), stdout: "pipe", stderr: "pipe", timeout: 5000,
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  return result.stdout.toString();
}

async function ready(path: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(path) && Date.now() < deadline) await Bun.sleep(20);
  expect(existsSync(path)).toBe(true);
}

describe("quick-cut switch: only exact on enables the add-on", () => {
  for (const value of switches) {
    const label = value === undefined ? "unset" : JSON.stringify(value);
    const enabled = value === "on";

    test(`cutoff ${label}: marker at SIGTERM and unconditional cleanup`, async () => {
      const root = fixture();
      const marker = join(root, "state", "cut-respawn");
      const seen = join(root, "seen.json"), started = join(root, "ready");
      const script = join(root, "brain.ts");
      writeFileSync(script, `
const fs = require("node:fs");
process.on("SIGTERM", () => {
  const marker = ${JSON.stringify(marker)};
  fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim() : null));
  fs.writeFileSync(${JSON.stringify(join(root, "logs", "bridge.md"))}, "Cleaned fixture turns.\\n");
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(started)}, "ready");
setInterval(() => {}, 1000);
`);
      const brain = Bun.spawn([process.execPath, script], {
        env: environment(root, value), stdout: "ignore", stderr: "ignore",
      });
      try {
        await ready(started);
        writeFileSync(join(root, "state", "brain_context.json"), JSON.stringify({ pid: brain.pid }));
        // The cutoff asks the house whether the pid is its own; a fixture brain is a child of
        // whatever runs the suite, so it gets a copy of the scripts with an owner seam that says yes.
        const copy = join(root, "scripts");
        mkdirSync(copy, { recursive: true });
        for (const name of ["brain-cutoff.sh", "brain-env.sh"]) copyFileSync(join(scripts, name), join(copy, name));
        writeFileSync(join(copy, "house-owner.sh"), "embervy_owns_pid() { return 0; }\n");
        const result = Bun.spawnSync(["bash", join(copy, "brain-cutoff.sh")], {
          env: { ...environment(root, value), BRAIN_CUT_WAIT_S: "3" },
          stdout: "pipe", stderr: "pipe", timeout: 8000,
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(seen, "utf8"))).toBe(enabled ? String(brain.pid) : null);
        expect(existsSync(marker)).toBe(false);
        expect(result.stdout.toString()).toContain(enabled ? "the next start uploads it" : "uploads before exiting");
        expect(readFileSync(join(root, "state", "last-cut-result"), "utf8").trim()).toBe("TERMINATED");
      } finally {
        if (brain.exitCode === null) brain.kill("SIGKILL");
        await brain.exited;
        rmSync(root, { recursive: true, force: true });
      }
    }, 15000);

    test(`loop ${label}: quiet only for a clean same-head restart`, () => {
      const root = fixture();
      try {
        const source = readFileSync(join(scripts, "brain-loop.sh"), "utf8");
        const notify = source.match(/^notify_runtime_swap\(\) \{\n[\s\S]*?^\}/m)?.[0];
        expect(notify).toBeDefined();
        const output = runShell(root, value, `
LOG="$BRAIN_HOME/logs/loop.log"
brain_text() { printf '%s' "$*"; }
brain_notify_app() { printf '%s\\n' "$1"; }
resolve_effective_head() { EFFECTIVE_HEAD="$NEXT_HEAD"; }
${notify}
STARTED_HEAD=api
NEXT_HEAD=api
notify_runtime_swap 0
for rc in 1 2 137 143; do notify_runtime_swap "$rc"; done
NEXT_HEAD=claude
notify_runtime_swap 0
STARTED_HEAD=""
notify_runtime_swap 0
`);
        const notices = output.trim().split("\n");
        expect(notices).toHaveLength(enabled ? 6 : 7);
        expect(notices.filter((line) => line === "loop.restart loop.clean api")).toHaveLength(enabled ? 0 : 1);
        expect(notices.filter((line) => line === "loop.restart loop.clean claude")).toHaveLength(2);
        const log = readFileSync(join(root, "logs", "loop.log"), "utf8");
        expect(log.split("quiet restart").length - 1).toBe(enabled ? 1 : 0);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    test(`watchdog ${label}: cut notice follows the switch without changing grace suppression`, () => {
      const root = fixture();
      try {
        const source = readFileSync(join(scripts, "brain-watchdog.sh"), "utf8");
        const branch = source.match(/  case "\$ACTION" in\n[\s\S]*?  esac/)?.[0];
        expect(branch).toBeDefined();
        // Execute the production decision branch, but replace notifications and detached starts.
        const output = runShell(root, value, `
STATE_DIR="$BRAIN_HOME/state"
ACTION=cut
TOKENS=950
PERCENT=105
CUT=900
SESSION=fixture
REASON=threshold
log() { :; }
brain_text() { printf '%s' "$*"; }
brain_notify_app() { printf '%s\\n' "$1"; }
setsid() { printf 'cut\\n' >> "$BRAIN_HOME/cuts"; }
${branch}
wait
${branch}
wait
`);
        expect(output).toBe(enabled ? "" : "watch.cut 105\n");
        expect(readFileSync(join(root, "cuts"), "utf8")).toBe("cut\n");
        expect(readFileSync(join(root, "state", "last_cut_session"), "utf8")).toBe("fixture");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

describe("quick-cut add-on: bridge defaults", () => {
  test("missing, empty or unreadable fresh size is off; an explicit size is preserved", () => {
    expect(FRESH_CHARS_DEFAULT).toBe(0);
    expect(bridgeShape({})).toMatchObject({ mode: "turns", turns: 40, freshChars: 0 });
    for (const value of ["", " ", "lots", "NaN", "Infinity", "0", "-1"]) {
      expect(bridgeShape({ BRAIN_BRIDGE_FRESH_CHARS: value }).freshChars).toBe(0);
    }
    for (const value of ["40000", "120000"]) {
      expect(bridgeShape({ BRAIN_BRIDGE_FRESH_CHARS: value }).freshChars).toBe(Number(value));
    }
    expect(bridgeShape({ BRAIN_QUICK_CUT: "on" }).freshChars).toBe(0);
  });

  test("the example selects forty cleaned turns and leaves add-on settings unset", () => {
    const source = readFileSync(join(import.meta.dir, "brain.env.example"), "utf8");
    expect(source).toMatch(/^BRAIN_BRIDGE_MODE=turns$/m);
    // The turn count stays a placeholder; the code default is forty.
    expect(source).toMatch(/^BRAIN_BRIDGE_TURNS=<bridge-turn-count>$/m);
    expect(source).toContain("default 40");
    expect(source).not.toMatch(/^\s*BRAIN_(?:QUICK_CUT|BRIDGE_FRESH_CHARS)=/m);
    expect(source).toContain("BRAIN_BRIDGE_FRESH_CHARS and BRAIN_QUICK_CUT are set by the quick-cut add-on; otherwise leave them off.");
  });
});
