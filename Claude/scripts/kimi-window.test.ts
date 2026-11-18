import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loop = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
const watchdog = readFileSync(join(import.meta.dir, "context_watchdog.sh"), "utf8");
function section(source: string, start: string, end: string) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to <= from) throw new Error(`Missing shell section: ${start}`);
  return source.slice(from, to);
}
const defaults = section(loop, "# Compaction is the user's choice", "# MCP subprocesses");
const backend = section(loop, "BACKEND_MODEL_ARGS=()", "# TERM/INT:");
const resolver = section(watchdog, "valid_tokens()", "# Is the claude process");
const stateWriter = watchdog.match(/write_state\(\) \{[\s\S]*?\nPY\n\}/)?.[0];
if (!stateWriter) throw new Error("Missing watchdog state writer");

// Execute the shipped setup and metadata writer, not a duplicate model resolver.
// GPT's health/auth seams are local stubs; no adapters, CLI or services are started.
function setup(extra: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "kimi-window-"));
  try {
    writeFileSync(join(home, "auth.json"), "{}");
    const run = Bun.spawnSync(["bash", "-c", `set -eu
LOG="$HOME/loop.log"
date() { printf '%s\\n' timestamp; }
embervy_chatgpt_auth() { printf '%s\\n' "$HOME/auth.json"; }
curl() { printf '%s\\n' '{"ok":true}'; }
${defaults}
${backend}
python3 - "\${BACKEND_MODEL_ARGS[@]}" <<'PY'
import json, os, sys
prefixes = ('ANTHROPIC_', 'CLAUDE_CODE_', 'WATCHDOG_', 'DISABLE_', 'API_TIMEOUT_')
print(json.dumps({'args': sys.argv[1:], 'exports': {k:v for k,v in os.environ.items() if k.startswith(prefixes)}}))
PY
# Resolve the file as the independent watchdog service does (without loop exports).
ENV_WARN_TOKENS=""; ENV_CUT_TOKENS=""
HOUSE_CONFIG_FILE="$HOME/.env"
STATE_FILE="$HOME/state/watchdog_state.json"
WARNING_FILE="$HOME/state/context_warning"
LAST_WARN_TS=""; LAST_CUT_TS=""
TOKENS=12345; PERCENT=50; SESSION_FILE=main.jsonl
${resolver}
${stateWriter}
resolve_thresholds
write_state
`], {
      env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home,
        EMBERVY_BACKEND: "kimi", KIMI_CODE_KEY: "test-kimi-key", ANTHROPIC_API_KEY: "test-api-key", ...extra },
      stdout: "pipe", stderr: "pipe", timeout: 10000,
    });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(home, "state/watchdog_engine_thresholds.tmp"))).toBe(false);
    return {
      ...JSON.parse(run.stdout.toString()) as { args: string[]; exports: Record<string, string> },
      log: readFileSync(join(home, "loop.log"), "utf8"),
      metadata: readFileSync(join(home, "state/watchdog_engine_thresholds"), "utf8"),
      state: JSON.parse(readFileSync(join(home, "state/watchdog_state.json"), "utf8")),
      executed: existsSync(join(home, "executed")),
    };
  } finally { rmSync(home, { recursive: true, force: true }); }
}

function checkKimi(extra: Record<string, string>, model: string, window: number, invalid = false) {
  const result = setup(extra);
  const warn = extra.WATCHDOG_WARN_TOKENS_KIMI || String(Math.floor(window * 180000 / 262144));
  const cut = extra.WATCHDOG_CUT_TOKENS_KIMI || String(Math.floor(window * 210000 / 262144));
  expect(result.args).toEqual(["--model", model]);
  expect(result.exports).toMatchObject({
    ANTHROPIC_BASE_URL: extra.EMBERVY_KIMI_BASE || "https://api.kimi.com/coding",
    ANTHROPIC_AUTH_TOKEN: "test-kimi-key", API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(window), CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window),
    CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: String(Math.floor(window * 95 / 100)),
    WATCHDOG_WARN_TOKENS: warn, WATCHDOG_CUT_TOKENS: cut,
  });
  expect(result.exports.CLAUDE_CODE_SILENT_TURN_REMINDER).toBe("0");
  expect(result.exports).not.toHaveProperty("ANTHROPIC_API_KEY");
  expect(result.metadata).toBe(`${warn} ${cut}\nkimi own ${window}\n`);
  expect(result.state).toMatchObject({ window, warn_tokens: Number(warn), cut_tokens: Number(cut), percent: 50 });
  const invalidLine = invalid ? `timestamp loop: invalid EMBERVY_KIMI_CONTEXT (expected integer 1024..10000000, no leading zeroes) — using model default ${window}-token window\n` : "";
  expect(result.log).toBe(invalidLine
    + `timestamp loop: engine Kimi (${model}, kimi.com/coding, ${window}-token window)\n`
    + `timestamp loop: watchdog engine file: engine=kimi window=own thresholds=${warn} ${cut}\n`);
  expect(result.executed).toBe(false);
  return result;
}

test("Kimi defaults to kimi-for-coding and a 1Mi-token window through watchdog state", () => {
  checkKimi({}, "kimi-for-coding", 1048576);
  checkKimi({ EMBERVY_KIMI_MODEL: "" }, "kimi-for-coding", 1048576);
});

test("another Kimi model keeps a 262144 window and the old 180k/210k thresholds", () => {
  checkKimi({ EMBERVY_KIMI_MODEL: "kimi-k2.7-code" }, "kimi-k2.7-code", 262144);
});

for (const window of [1024, 262144, 524288, 1048576, 2097152, 10000000]) {
  test(`Kimi accepts bounded context ${window} for either model`, () => {
    for (const model of ["kimi-for-coding", "another-model"]) {
      checkKimi({ EMBERVY_KIMI_MODEL: model, EMBERVY_KIMI_CONTEXT: String(window) }, model, window);
    }
  });
}

for (const context of ["", "0", "-1", "1023", "10000001", "99999999999999999999999999999999999",
  "18446744073710600192", "1.5", "1e6", "NaN", "Infinity", "1048576x", " 1048576", "1048576 ",
  "1048576\n", "01048576", "+1048576", "0x100000", "2**20", "$(touch $HOME/executed)", "a[$(touch $HOME/executed)]"]) {
  test(`Kimi rejects context ${JSON.stringify(context)} without arithmetic evaluation`, () => {
    checkKimi({ EMBERVY_KIMI_CONTEXT: context }, "kimi-for-coding", 1048576, true);
    checkKimi({ EMBERVY_KIMI_MODEL: "other", EMBERVY_KIMI_CONTEXT: context }, "other", 262144, true);
  });
}

test("Kimi preserves per-engine thresholds; generic thresholds and stale CLI windows do not win", () => {
  checkKimi({ WATCHDOG_WARN_TOKENS_KIMI: "123456", WATCHDOG_CUT_TOKENS_KIMI: "234567",
    WATCHDOG_WARN_TOKENS: "800000", WATCHDOG_CUT_TOKENS: "900000",
    CLAUDE_CODE_AUTO_COMPACT_WINDOW: "256000", EMBERVY_KIMI_BASE: "https://example.invalid/coding" }, "kimi-for-coding", 1048576);
  checkKimi({ WATCHDOG_WARN_TOKENS_KIMI: "123456" }, "kimi-for-coding", 1048576);
  checkKimi({ WATCHDOG_CUT_TOKENS_KIMI: "900000" }, "kimi-for-coding", 1048576);
});

test("Kimi window settings do not enable auto-compaction without the user's opt-in", () => {
  expect(setup().exports.DISABLE_AUTO_COMPACT).toBe("true");
  const enabled = setup({ EMBERVY_AUTO_COMPACT: "on" });
  expect(enabled.exports).not.toHaveProperty("DISABLE_AUTO_COMPACT");
  expect(enabled.exports.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1048576");
  expect(enabled.log).toStartWith("timestamp loop: EMBERVY_AUTO_COMPACT=on — the harness may summarize the window; the watchdog still cuts as a backstop\n");
  checkKimi({ WATCHDOG_WARN_TOKENS: "800000", WATCHDOG_CUT_TOKENS: "900000" }, "kimi-for-coding", 1048576);
});

test("Kimi missing credentials preserves the Claude fallback and does not apply context settings", () => {
  const result = setup({ KIMI_CODE_KEY: "", EMBERVY_KIMI_CONTEXT: "garbage" });
  expect(result.args).toEqual([]);
  expect(result.exports.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe("1000000");
  expect(result.exports).not.toHaveProperty("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  expect(result.metadata).toBe("\nclaude generic 1000000\n");
  expect(result.log).toBe("timestamp loop: EMBERVY_BACKEND=kimi but KIMI_CODE_KEY missing — falling back to claude\n"
    + "timestamp loop: watchdog engine file: engine=claude window=generic thresholds=none\n");
});

for (const config of [
  { EMBERVY_BACKEND: "claude" },
  { EMBERVY_BACKEND: "glm", GLM_CODE_KEY: "test-glm-key" },
  { EMBERVY_BACKEND: "kimi" },
  { EMBERVY_BACKEND: "minimax", MINIMAX_CODE_KEY: "test-minimax-key" },
  { EMBERVY_BACKEND: "gpt" },
  { EMBERVY_BACKEND: "kimi", KIMI_CODE_KEY: "" }, // Claude fallback
]) {
  test(`${config.EMBERVY_BACKEND} (${config.KIMI_CODE_KEY === "" ? "fallback" : "head"}): silent-turn default and explicit house exports`, () => {
    const baseline = setup(config as Record<string, string>);
    expect(baseline.exports.CLAUDE_CODE_SILENT_TURN_REMINDER).toBe("0");
    for (const value of ["", "1", "0", "house-value"]) {
      const result = setup({ ...config, CLAUDE_CODE_SILENT_TURN_REMINDER: value } as Record<string, string>);
      expect(result).toEqual({ ...baseline,
        exports: { ...baseline.exports, CLAUDE_CODE_SILENT_TURN_REMINDER: value },
        state: { ...baseline.state, pid: expect.any(Number) }, // Each shell run has its own PID.
      });
    }
  });
}

// Baselines for the untouched branches: exact exports, argv, metadata and log lines.
const common = { DISABLE_AUTO_COMPACT: "true", DISABLE_COMPACT: "true",
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000", CLAUDE_CODE_BLOCKING_LIMIT_OVERRIDE: "950000",
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false", CLAUDE_CODE_SILENT_TURN_REMINDER: "0" };
for (const config of [
  { engine: "claude", env: {}, args: [], exports: { ANTHROPIC_API_KEY: "test-api-key" }, numbers: "", kind: "generic", window: 1000000, log: "" },
  { engine: "glm", env: { GLM_CODE_KEY: "test-glm-key" }, args: ["--model", "glm-5.2[1m]"],
    exports: { ANTHROPIC_BASE_URL: "https://api.z.ai/api/anthropic", ANTHROPIC_AUTH_TOKEN: "test-glm-key", API_TIMEOUT_MS: "3000000" },
    numbers: "", kind: "generic", window: 1000000, log: "engine GLM (glm-5.2[1m], z.ai)" },
  { engine: "minimax", env: { MINIMAX_CODE_KEY: "test-minimax-key" }, args: ["--model", "MiniMax-M2"],
    exports: { ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic", ANTHROPIC_AUTH_TOKEN: "test-minimax-key", API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000", WATCHDOG_WARN_TOKENS: "150000", WATCHDOG_CUT_TOKENS: "180000" },
    numbers: "150000 180000", kind: "own", window: 200000, log: "engine MiniMax (MiniMax-M2)" },
  { engine: "gpt", env: {}, args: ["--model", "gpt-5.6-terra"],
    exports: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3041", ANTHROPIC_AUTH_TOKEN: "subscription-via-adapter", API_TIMEOUT_MS: "3000000",
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: "1000000", WATCHDOG_WARN_TOKENS: "200000", WATCHDOG_CUT_TOKENS: "220000" },
    numbers: "200000 220000", kind: "own", window: 1000000,
    log: "engine GPT (gpt-5.6-terra, ChatGPT subscription via local adapter :3041, 1000000-token window)" },
]) {
  test(`${config.engine}: non-Kimi exports and log baseline unchanged by Kimi settings`, () => {
    const result = setup({ ...config.env, EMBERVY_BACKEND: config.engine,
      EMBERVY_KIMI_MODEL: "other", EMBERVY_KIMI_CONTEXT: "invalid" } as Record<string, string>);
    expect(result.args).toEqual(config.args);
    expect(result.exports).toEqual({ ...common, ...config.exports });
    expect(result.metadata).toBe(`${config.numbers}\n${config.engine} ${config.kind} ${config.window}\n`);
    expect(result.log).toBe((config.log ? `timestamp loop: ${config.log}\n` : "")
      + `timestamp loop: watchdog engine file: engine=${config.engine} window=${config.kind} thresholds=${config.numbers || "none"}\n`);
  });
}
