import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verify HOME isolation and watchdog liveness.

const SCRIPTS_DIR = import.meta.dir; // Claude/scripts
const REPO_ROOT = join(SCRIPTS_DIR, "..", "..");
const CLAUDE_WATCHDOG = join(SCRIPTS_DIR, "context_watchdog.sh");

// Supply latest_main_session.py in the temporary home so the watchdog can find a session.
function withSessionHelper(embervyHome: string): string {
  const dir = join(embervyHome, "Claude", "scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "latest_main_session.py"), readFileSync(join(SCRIPTS_DIR, "latest_main_session.py")));
  return embervyHome;
}

// Match the getent-derived fallback literally to verify the exact HOME initialization.
const HARDENING_LINE = 'HOME="${HOME:-$(getent passwd "$(id -u)" | cut -d: -f6)}"; export HOME';

// Enumerate shipped scripts so new files also receive the HOME check;
// scripts that never expand $HOME need no fallback.
function shippedShellScripts(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, ...dir.split("/")))
    .filter((f) => f.endsWith(".sh"))
    .map((f) => `${dir}/${f}`);
}

const SHIPPED_SCRIPTS = [
  ...shippedShellScripts("Claude/scripts"),
].sort();

describe("criterion 1: $HOME hardening precedes every $HOME use (static scan)", () => {
  for (const rel of SHIPPED_SCRIPTS) {
    test(rel, () => {
      const text = readFileSync(join(REPO_ROOT, rel), "utf8");
      const lines = text.split("\n");

      let hardeningIndex = -1;
      let earliestUseIndex = -1;
      lines.forEach((line, i) => {
        if (hardeningIndex === -1 && line.includes(HARDENING_LINE)) {
          hardeningIndex = i;
        }
        const isCommentLine = line.trim().startsWith("#");
        if (!isCommentLine && earliestUseIndex === -1 && line.includes("$HOME")) {
          earliestUseIndex = i;
        }
      });

      if (earliestUseIndex === -1) {
        // No code use of $HOME in this script (e.g. inlet.sh never expands
        // it) — nothing to harden, and no hardening line is expected.
        expect(hardeningIndex).toBe(-1);
        return;
      }

      expect(hardeningIndex).toBeGreaterThanOrEqual(0);
      expect(hardeningIndex).toBeLessThan(earliestUseIndex);
    });
  }
});

test("an exited process is unowned without a cmdline read diagnostic", () => {
  const result = Bun.spawnSync(["bash", "-c", 'source "$1"; embervy_owns_pid 2147483647', "test", join(REPO_ROOT, "shared/scripts/house-runtime.sh")], {
    env: { ...process.env, EMBERVY_HOME: REPO_ROOT }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toBe("");
});

// --- Criterion 2 helpers --------------------------------------------------
// A fake `id`/`getent` pair on PATH, ahead of the real binaries, so the
// derived HOME is fully under the test's control — independent of whatever
// uid/home the runner actually has. This is what makes the test capable of
// going red if the hardening line is removed (reverting to an empty/root
// HOME would no longer match the fake identity's home).
function makeFakeIdentityBin(fakeHome: string): string {
  const bin = mkdtempSync(join(tmpdir(), "hh-fakebin-"));
  writeFileSync(join(bin, "id"), "#!/bin/bash\necho 776655\n");
  writeFileSync(
    join(bin, "getent"),
    `#!/bin/bash\necho "testuser:x:776655:776655::${fakeHome}:/bin/bash"\n`,
  );
  chmodSync(join(bin, "id"), 0o755);
  chmodSync(join(bin, "getent"), 0o755);
  return bin;
}

async function waitForStateFile(stateFile: string, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        if (state.session_file) return state;
      } catch {
        // still being written atomically — retry.
      }
    }
    await Bun.sleep(100);
  }
  return null;
}

describe("criterion 2: watchdogs run with HOME unset (env -u HOME)", () => {
  test(
    "context_watchdog.sh derives its session directory from getent, no crash",
    async () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "hh-fakehome-"));
      const fakeBin = makeFakeIdentityBin(fakeHome);
      const embervyHome = withSessionHelper(mkdtempSync(join(tmpdir(), "hh-embervy-")));
      let proc: ReturnType<typeof Bun.spawn> | null = null;
      try {
        const mangled = embervyHome.split("/").join("-");
        const sessionDir = join(fakeHome, ".claude", "projects", mangled);
        mkdirSync(sessionDir, { recursive: true });
        writeFileSync(
          join(sessionDir, "session-1.jsonl"),
          JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 10 } } }) + "\n",
        );

        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        delete env.HOME;
        delete env.CLAUDE_PROJECT_DIR;
        env.PATH = `${fakeBin}:${env.PATH ?? ""}`;
        env.EMBERVY_HOME = embervyHome;
        env.WATCHDOG_CHECK_INTERVAL = "1";
        // Point broadcasts at a dead port so the test watchdog cannot reach a real app.
        env.EMBERVY_APP_HOST = "127.0.0.1";
        env.EMBERVY_APP_PORT = "9";

        proc = Bun.spawn(["bash", CLAUDE_WATCHDOG], { env, stdout: "pipe", stderr: "pipe" });

        const stateFile = join(embervyHome, "state", "watchdog_state.json");
        const state = await waitForStateFile(stateFile, 8000);

        expect(state).not.toBeNull();
        expect(state.session_file).toBe("session-1.jsonl");
      } finally {
        proc?.kill();
        if (proc) await proc.exited;
        rmSync(fakeHome, { recursive: true, force: true });
        rmSync(fakeBin, { recursive: true, force: true });
        rmSync(embervyHome, { recursive: true, force: true });
      }
    },
    10000,
  );
});

test("watchdog caches usage offsets and reads only appended records, resetting on truncation and replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "watchdog-offset-"));
  try {
    const file = join(root, "session.jsonl");
    const cache = join(root, "offset.json");
    const usage = (tokens: number) => JSON.stringify({ type: "assistant", message: { usage: { input_tokens: tokens } } }) + "\n";
    const first = usage(100);
    writeFileSync(file, first + JSON.stringify({ type: "user", message: { content: "x".repeat(10000) } }) + "\n");
    const decide = () => {
      const result = Bun.spawnSync(["bash", CLAUDE_WATCHDOG, "--decide-cached", file, "0", cache], {
        env: { ...process.env, EMBERVY_HOME: root }, stdout: "pipe", stderr: "pipe",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
      const full = Bun.spawnSync(["bash", CLAUDE_WATCHDOG, "--decide", file, "0"], {
        env: { ...process.env, EMBERVY_HOME: root }, stdout: "pipe", stderr: "pipe",
      });
      expect(full.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(full.stdout.toString());
      return result.stdout.toString();
    };
    expect(decide()).toContain("none 100 ");
    let saved = JSON.parse(readFileSync(cache, "utf8"));
    expect(saved.usage_offset).toBe(Buffer.byteLength(first));
    expect(saved.scanned_bytes).toBeGreaterThan(10000);
    expect(decide()).toContain("none 100 ");
    expect(JSON.parse(readFileSync(cache, "utf8")).scanned_bytes).toBe(0);
    const appended = usage(200);
    writeFileSync(file, appended, { flag: "a" });
    expect(decide()).toContain("none 200 ");
    saved = JSON.parse(readFileSync(cache, "utf8"));
    expect(saved.scanned_bytes).toBe(Buffer.byteLength(appended));
    expect(saved.usage_offset).toBe(saved.offset);
    writeFileSync(file, usage(300));
    expect(decide()).toContain("none 300 ");
    const identity = JSON.parse(readFileSync(cache, "utf8")).identity;
    rmSync(file);
    writeFileSync(file, usage(400) + usage(500));
    expect(decide()).toContain("none 500 ");
    saved = JSON.parse(readFileSync(cache, "utf8"));
    expect(saved.scanned_bytes).toBe(Buffer.byteLength(usage(400) + usage(500)));
    expect(saved.identity[0]).toBe(identity[0]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- Criterion 3 helpers ---------------------------------------------------
const jsonlDirs: string[] = [];
afterEach(() => {
  for (const dir of jsonlDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function writeJsonlFixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hh-jsonl-"));
  jsonlDirs.push(dir);
  writeFileSync(join(dir, "session.jsonl"), lines.join("\n") + "\n");
  return join(dir, "session.jsonl");
}

interface Decision {
  action: string;
  tokens: number;
  percent: number;
  bytes: number;
  reason: string;
}

function decide(jsonlPath: string, stale: string = "0", envOverrides: Record<string, string> = {}): Decision {
  const result = Bun.spawnSync(["bash", CLAUDE_WATCHDOG, "--decide", jsonlPath, stale], {
    env: { ...(process.env as Record<string, string>), ...envOverrides },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = result.stdout.toString().trim();
  const [action, tokens, percent, bytes, ...rest] = out.split(" ");
  return { action, tokens: Number(tokens), percent: Number(percent), bytes: Number(bytes), reason: rest.join(" ") };
}

describe("criterion 3: context_watchdog.sh --decide (fixture-driven decision function)", () => {
  test("below both thresholds -> none", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 100 } } }),
    ]);
    expect(decide(jsonl).action).toBe("none");
  });

  test("at/above CUT_TOKENS -> cut via the ordinary token threshold", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 950000 } } }),
    ]);
    const d = decide(jsonl);
    expect(d.action).toBe("cut");
    expect(d.reason).toContain("token threshold");
  });

  test("at/above WARN_TOKENS but below CUT_TOKENS -> warn", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 850000 } } }),
    ]);
    expect(decide(jsonl).action).toBe("warn");
  });

  test("a context-limit error line triggers an immediate cut even though tokens read 0", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "system", subtype: "error", message: "API Error: prompt is too long: 1050000 tokens > 1000000 maximum" }),
    ]);
    const d = decide(jsonl);
    expect(d.action).toBe("cut");
    expect(d.tokens).toBe(0);
    expect(d.reason).toContain("context-limit error line in JSONL");
  });

  test("a differently-worded context-limit marker also triggers the cut", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "system", subtype: "error", message: "context_length_exceeded" }),
    ]);
    expect(decide(jsonl).action).toBe("cut");
  });

  test("Claude Code's own records cut: the API error as an assistant message, the api_error system line", () => {
    const apiError = writeJsonlFixture([
      JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "invalid_request", message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "Prompt is too long" }] } }),
    ]);
    expect(decide(apiError).action).toBe("cut");
    const systemLine = writeJsonlFixture([
      JSON.stringify({ type: "system", subtype: "api_error", level: "error", error: { message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1050000 tokens > 1000000 maximum"}}', status: 400 } }),
    ]);
    expect(decide(systemLine).action).toBe("cut");
  });

  test("the phrase anywhere else never cuts (a memory in the inlet, an agent reading this code)", () => {
    const quoted = "claude -p reported is_error=true: Prompt is too long";
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "user", message: { role: "user", content: `<inlet>an old memory: ${quoted}</inlet>` } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: "The watchdog cut on 'prompt is too long' in the inlet." },
        { type: "tool_use", id: "t1", name: "Bash", input: { command: "grep -n 'prompt is too long|context_length_exceeded' context_watchdog.sh" } },
      ], usage: { input_tokens: 100 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "maximum context length" }] } }),
    ]);
    expect(decide(jsonl).action).toBe("none");
  });

  test("byte-size fallback fires when tokens read 0 but bytes are far past the CUT_TOKENS-scaled bound", () => {
    const filler = "x".repeat(6_000_000);
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "user", message: { role: "user", content: filler } }),
    ]);
    const d = decide(jsonl);
    expect(d.action).toBe("cut");
    expect(d.tokens).toBe(0);
    expect(d.reason).toContain("byte-size fallback");
  });

  test("R1-F2: byte-size fallback still fires when a prior assistant usage line left tokens nonzero (but under CUT_TOKENS) before a later giant tool result", () => {
    const filler = "x".repeat(6_000_000);
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 100 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: filler } }),
    ]);
    const d = decide(jsonl);
    expect(d.action).toBe("cut");
    expect(d.tokens).toBe(100);
    expect(d.reason).toContain("byte-size fallback");
  });

  test("R1-F2: the ordinary token threshold still wins the reason once tokens themselves cross CUT_TOKENS, even with a huge file", () => {
    const filler = "x".repeat(6_000_000);
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 950000 } } }),
      JSON.stringify({ type: "user", message: { role: "user", content: filler } }),
    ]);
    const d = decide(jsonl);
    expect(d.action).toBe("cut");
    expect(d.reason).toContain("token threshold");
  });

  test("old images and history do not count as unseen bytes", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "user", message: { content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(6_000_000) } }] } }),
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 325347 } } }),
    ]);
    expect(decide(jsonl).action).toBe("none");
  });

  test("usage plus unseen tail crosses the bound with the configured ratio", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 600000 } } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "result", content: "x".repeat(1_800_000) }] } }),
    ]);
    expect(decide(jsonl).reason).toContain("byte-size fallback");
    expect(decide(jsonl, "0", { WATCHDOG_BYTE_FALLBACK_BYTES_PER_TOKEN: "12" }).action).toBe("none");
  });

  test("a small file with tokens reading 0 does NOT trip the byte-size fallback (no false positive)", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    ]);
    expect(decide(jsonl).action).toBe("none");
  });

  test("stale (process not alive) suppresses warn/cut even at CUT_TOKENS", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 950000 } } }),
    ]);
    expect(decide(jsonl, "1").action).toBe("stale");
  });

  test("a context-limit error line takes priority over a stale flag (worst case is the loudest case)", () => {
    const jsonl = writeJsonlFixture([
      JSON.stringify({ type: "system", subtype: "error", message: "context_length_exceeded" }),
    ]);
    const d = decide(jsonl, "1");
    expect(d.action).toBe("cut");
    expect(d.reason).toContain("context-limit error line in JSONL");
  });
});

async function waitForLogLine(logFile: string, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logFile) && readFileSync(logFile, "utf8").includes(needle)) return true;
    await Bun.sleep(100);
  }
  return false;
}

describe("R1-F3: the running watchdog's own STALE determination is bound to process liveness, not just --check-alive in isolation", () => {
  test(
    "warns while the CLAUDE_PROCESS_PATTERN match is alive, then logs 'stale session' once it exits — proving the main-loop wiring at the decide_action call site (context_watchdog.sh:237-240), not mtime",
    async () => {
      const marker = `hh-235-mainloop-marker-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const sessionDir = mkdtempSync(join(tmpdir(), "hh-mainloop-session-"));
      const embervyHome = withSessionHelper(mkdtempSync(join(tmpdir(), "hh-mainloop-embervy-")));
      writeFileSync(
        join(sessionDir, "session.jsonl"),
        JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 500 } } }) + "\n",
      );

      // Same tail-call-exec caution as the isolated --check-alive test above:
      // a `for` loop, not a single trailing command, so bash never execs
      // itself into `sleep` and drops the marker comment from argv.
      const child = Bun.spawn(
        ["bash", "-c", `for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do sleep 1; done #${marker}`],
        { cwd: embervyHome, stdout: "ignore", stderr: "ignore" },
      );
      let watchdog: ReturnType<typeof Bun.spawn> | null = null;
      const logFile = join(embervyHome, "logs", "context_watchdog.log");

      try {
        await Bun.sleep(300);

        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          EMBERVY_HOME: embervyHome,
          CLAUDE_PROJECT_DIR: sessionDir,
          CLAUDE_PROCESS_PATTERN: marker,
          WATCHDOG_CHECK_INTERVAL: "1",
          // Dead broadcast port — a test watchdog must never notify a real app.
          EMBERVY_APP_HOST: "127.0.0.1",
          EMBERVY_APP_PORT: "9",
          WATCHDOG_WARN_TOKENS: "100",
          WATCHDOG_CUT_TOKENS: "99999999",
        };
        watchdog = Bun.spawn(["bash", CLAUDE_WATCHDOG], { env, stdout: "pipe", stderr: "pipe" });

        const warnedWhileAlive = await waitForLogLine(logFile, "WARN threshold hit", 8000);
        expect(warnedWhileAlive).toBe(true);
        expect(readFileSync(logFile, "utf8")).not.toContain("stale session");

        child.kill();
        await child.exited;

        const wentStale = await waitForLogLine(logFile, "stale session", 8000);
        expect(wentStale).toBe(true);
      } finally {
        watchdog?.kill();
        if (watchdog) await watchdog.exited;
        child.kill();
        rmSync(sessionDir, { recursive: true, force: true });
        rmSync(embervyHome, { recursive: true, force: true });
      }
    },
    20000,
  );
});

describe("criterion 3: stale guard consults process liveness, not mtime (context_watchdog.sh --check-alive)", () => {
  test("reports 1 while a matching process runs, 0 once it's gone", async () => {
    const marker = `hh-235-alive-marker-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const embervyHome = mkdtempSync(join(tmpdir(), "hh-alive-home-"));
    // A `for` loop (not a single simple trailing command) so bash never
    // tail-call execs itself into `sleep` — that would replace this
    // process's argv and silently drop the trailing marker comment,
    // making pgrep -f blind to it.
    const child = Bun.spawn(
      ["bash", "-c", `for i in 1 2 3 4 5; do sleep 1; done #${marker}`],
      { cwd: embervyHome, stdout: "ignore", stderr: "ignore" },
    );
    try {
      await Bun.sleep(300);
      const alive = Bun.spawnSync(["bash", CLAUDE_WATCHDOG, "--check-alive"], {
        env: { ...(process.env as Record<string, string>), EMBERVY_HOME: embervyHome, CLAUDE_PROCESS_PATTERN: marker },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(alive.stdout.toString().trim()).toBe("1");
      const otherHome = mkdtempSync(join(tmpdir(), "hh-other-home-"));
      try {
        const foreign = Bun.spawnSync(["bash", CLAUDE_WATCHDOG, "--check-alive"], {
          env: { ...process.env, EMBERVY_HOME: otherHome, CLAUDE_PROCESS_PATTERN: marker },
          stdout: "pipe", stderr: "pipe",
        });
        expect(foreign.stdout.toString().trim()).toBe("0");
      } finally { rmSync(otherHome, { recursive: true, force: true }); }
    } finally {
      child.kill();
      await child.exited;
    }

    await Bun.sleep(300);
    const dead = Bun.spawnSync(["bash", CLAUDE_WATCHDOG, "--check-alive"], {
      env: { ...(process.env as Record<string, string>), EMBERVY_HOME: embervyHome, CLAUDE_PROCESS_PATTERN: marker },
      stdout: "pipe",
      stderr: "pipe",
    });
    rmSync(embervyHome, { recursive: true, force: true });
    expect(dead.stdout.toString().trim()).toBe("0");
  }, 10000);
});

// --- Live thresholds ------------------------------------------------------
// The watchdog re-reads the house config ($EMBERVY_HOME/Claude/app/.env) and
// the loop's engine file every tick, so a threshold edit lands without a cut
// or a service restart. The service environment is stripped of WATCHDOG_*
// here so the runner's own environment can never leak into the result.
function thresholdHome(config: string | null, engineFile: string | null): string {
  const home = mkdtempSync(join(tmpdir(), "hh-thresholds-"));
  mkdirSync(join(home, "Claude", "app"), { recursive: true });
  mkdirSync(join(home, "state"), { recursive: true });
  if (config !== null) writeFileSync(join(home, "Claude", "app", ".env"), config);
  if (engineFile !== null) writeFileSync(join(home, "state", "watchdog_engine_thresholds"), engineFile);
  return home;
}

function watchdogEnv(embervyHome: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const key of Object.keys(env)) if (key.startsWith("WATCHDOG_")) delete env[key];
  return { ...env, EMBERVY_HOME: embervyHome, ...extra };
}

function thresholds(embervyHome: string, extra: Record<string, string> = {}): string {
  const result = Bun.spawnSync(["bash", CLAUDE_WATCHDOG, "--thresholds"], {
    env: watchdogEnv(embervyHome, extra),
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.stdout.toString().trim();
}

describe("live thresholds: resolution order (context_watchdog.sh --thresholds)", () => {
  const homes: string[] = [];
  const home = (config: string | null, engineFile: string | null) => {
    const h = thresholdHome(config, engineFile);
    homes.push(h);
    return h;
  };
  const cleanup = () => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); };

  test("nothing configured -> defaults", () => {
    try {
      expect(thresholds(home(null, null))).toBe("800000 900000");
    } finally { cleanup(); }
  });

  test("generic keys in the house config apply to the Claude engine, over the numbers the loop wrote", () => {
    try {
      const config = "WATCHDOG_WARN_TOKENS=500000\nWATCHDOG_CUT_TOKENS=600000\n";
      expect(thresholds(home(config, null))).toBe("500000 600000");
      expect(thresholds(home(config, "800000 900000\nclaude generic\n"))).toBe("500000 600000");
    } finally { cleanup(); }
  });

  test("the engine-specific key wins for that engine; another engine's key does not apply", () => {
    try {
      const config = [
        "WATCHDOG_WARN_TOKENS=500000",
        "WATCHDOG_CUT_TOKENS=600000",
        "WATCHDOG_WARN_TOKENS_GPT=150000",
        "WATCHDOG_CUT_TOKENS_GPT=170000",
        "WATCHDOG_WARN_TOKENS_KIMI=1000",
      ].join("\n");
      expect(thresholds(home(config, "200000 220000\ngpt own\n"))).toBe("150000 170000");
      expect(thresholds(home(config, "800000 900000\nclaude generic\n"))).toBe("500000 600000");
      // Engine-specific keys also work for an engine that runs on the generic ones.
      expect(thresholds(home(config + "\nWATCHDOG_CUT_TOKENS_CLAUDE=700000\n", "800000 900000\nclaude generic\n")))
        .toBe("500000 700000");
    } finally { cleanup(); }
  });

  test("an engine with its own window never takes the generic keys (the shipped 800k/900k would overrun a 252K window)", () => {
    try {
      const config = "WATCHDOG_WARN_TOKENS=800000\nWATCHDOG_CUT_TOKENS=900000\nWATCHDOG_CUT_TOKENS_GPT=230000\n";
      expect(thresholds(home(config, "200000 220000\ngpt own\n"))).toBe("200000 230000");
      expect(thresholds(home(config, "180000 210000\nkimi own\n"))).toBe("180000 210000");
    } finally { cleanup(); }
  });

  test("garbage values are ignored and fall through; the config is never executed", () => {
    try {
      const h = home(null, "200000 220000\ngpt own\n");
      const marker = join(h, "executed");
      writeFileSync(join(h, "Claude", "app", ".env"), [
        `WATCHDOG_WARN_TOKENS_GPT=$(touch ${marker})`,
        "WATCHDOG_CUT_TOKENS_GPT=abc",
      ].join("\n"));
      expect(thresholds(h)).toBe("200000 220000");
      expect(existsSync(marker)).toBe(false);

      for (const bad of ["0", "-5", "12e5", "150000x", "1 2", "99999999999", ""]) {
        const g = home(`WATCHDOG_WARN_TOKENS=${bad}\nWATCHDOG_CUT_TOKENS=600000\n`, null);
        expect(thresholds(g)).toBe("600000 600000"); // warn falls to 800000, clamped to cut
      }

      // Garbage in the engine file and the service environment falls through too.
      expect(thresholds(home(null, "lots of\nnonsense here\n"), { WATCHDOG_WARN_TOKENS: "x", WATCHDOG_CUT_TOKENS: "700000" }))
        .toBe("700000 700000");
    } finally { cleanup(); }
  });

  test("the config is read like `source` reads plain assignments: export, quotes, trailing comment, last one wins", () => {
    try {
      const config = [
        "# watchdog",
        "WATCHDOG_WARN_TOKENS=100",
        '  export WATCHDOG_WARN_TOKENS="400000"   # comment',
        "WATCHDOG_CUT_TOKENS='650000'",
        "WATCHDOG_STATE_PATH=         # optional",
      ].join("\r\n");
      expect(thresholds(home(config, null))).toBe("400000 650000");
    } finally { cleanup(); }
  });

  test("an old two-field engine file (no engine name) still works: its numbers stand", () => {
    try {
      const config = "WATCHDOG_WARN_TOKENS=800000\nWATCHDOG_CUT_TOKENS=900000\nWATCHDOG_WARN_TOKENS_GPT=1000\n";
      expect(thresholds(home(config, "200000 220000\n"))).toBe("200000 220000");
      expect(thresholds(home(null, "200000 220000"))).toBe("200000 220000");
      // A loop without valid numbers writes an empty first line.
      expect(thresholds(home(null, "\nclaude generic\n"), { WATCHDOG_WARN_TOKENS: "300000", WATCHDOG_CUT_TOKENS: "400000" }))
        .toBe("300000 400000");
    } finally { cleanup(); }
  });

  test("warn is never above cut", () => {
    try {
      expect(thresholds(home("WATCHDOG_WARN_TOKENS=700000\nWATCHDOG_CUT_TOKENS=600000\n", null))).toBe("600000 600000");
    } finally { cleanup(); }
  });
});

async function waitForThresholds(stateFile: string, warn: number, cut: number, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(stateFile)) {
      try {
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        if (state.warn_tokens === warn && state.cut_tokens === cut) return state;
      } catch {
        // still being written atomically — retry.
      }
    }
    await Bun.sleep(100);
  }
  return null;
}

describe("live thresholds: the running watchdog picks up a config edit without a restart", () => {
  test(
    "edit Claude/app/.env -> next tick reports the new thresholds, same process, one log line for the change",
    async () => {
      const embervyHome = thresholdHome("WATCHDOG_WARN_TOKENS=500000\nWATCHDOG_CUT_TOKENS=600000\n", "800000 900000\nclaude generic\n");
      const sessionDir = mkdtempSync(join(tmpdir(), "hh-thresholds-session-"));
      const stateFile = join(embervyHome, "state", "watchdog_state.json");
      const logFile = join(embervyHome, "logs", "context_watchdog.log");
      let watchdog: ReturnType<typeof Bun.spawn> | null = null;
      try {
        watchdog = Bun.spawn(["bash", CLAUDE_WATCHDOG], {
          env: watchdogEnv(embervyHome, {
            CLAUDE_PROJECT_DIR: sessionDir,
            WATCHDOG_CHECK_INTERVAL: "1",
            // Dead broadcast port — a test watchdog must never notify a real app.
            EMBERVY_APP_HOST: "127.0.0.1",
            EMBERVY_APP_PORT: "9",
          }),
          stdout: "pipe",
          stderr: "pipe",
        });

        const before = await waitForThresholds(stateFile, 500000, 600000, 8000);
        expect(before).not.toBeNull();

        writeFileSync(join(embervyHome, "Claude", "app", ".env"), "WATCHDOG_WARN_TOKENS=300000\nWATCHDOG_CUT_TOKENS=400000\n");
        const after = await waitForThresholds(stateFile, 300000, 400000, 8000);
        expect(after).not.toBeNull();
        expect(after.pid).toBe(before.pid);

        await Bun.sleep(2500); // a few more ticks: no repeat of the change line
        const changes = readFileSync(logFile, "utf8").split("\n").filter((l) => l.includes("thresholds changed"));
        expect(changes.length).toBe(1);
        expect(changes[0]).toContain("warn=500000 cut=600000 → warn=300000 cut=400000");
        expect(changes[0]).toContain("WATCHDOG_WARN_TOKENS");
      } finally {
        watchdog?.kill();
        if (watchdog) await watchdog.exited;
        rmSync(sessionDir, { recursive: true, force: true });
        rmSync(embervyHome, { recursive: true, force: true });
      }
    },
    25000,
  );
});
