import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const brain = readFileSync(join(import.meta.dir, "../../Brain/scripts/brain-watchdog.sh"), "utf8");
const claude = readFileSync(join(import.meta.dir, "context_watchdog.sh"), "utf8");
const loop = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");

function stateWriter(source: string): string {
  const body = source.match(/write_state\(\) \{[\s\S]*?\nPY\n\}/)?.[0];
  if (!body) throw new Error("write_state function not found");
  return body;
}
const resolver = claude.slice(claude.indexOf("valid_tokens()"), claude.indexOf("# Is the claude process"));
const engineWriter = loop.slice(
  loop.indexOf('ENGINE_THRESHOLDS_FILE="$EMBERVY_HOME/state/watchdog_engine_thresholds"'),
  loop.indexOf("# TERM/INT:"),
);

function isolated(run: (root: string, shell: (body: string, extra?: Record<string, string>) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), "watchdog-window-state-"));
  mkdirSync(join(root, "state"));
  const shell = (body: string, extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(["bash", "-c", "set -eu\n" + body], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, EMBERVY_HOME: root, ...extra },
      stdout: "pipe", stderr: "pipe",
    });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return result.stdout.toString();
  };
  try { run(root, shell); } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const window of [262144, 1000000, undefined, null, 0, -1, "262144", true]) {
  test(`Brain state: window=${JSON.stringify(window)} measures capacity or stays unknown`, () => {
    isolated((root, shell) => {
      writeFileSync(join(root, "context.json"), JSON.stringify({ window }));
      const out = shell(`
WATCH_STATE_FILE="$HOME/state/watchdog_state.json"
BRAIN_CONTEXT_STATE_FILE="$HOME/context.json"
WARNING_FILE="$HOME/state/context_warning"
TOKENS=5678; PERCENT=99; CUT=235929; SESSION=main
LAST_WARN_TS=""; LAST_CUT_TS=""
${stateWriter(brain)}
write_state
printf '%s' "$PERCENT"
`);
      const state = JSON.parse(readFileSync(join(root, "state/watchdog_state.json"), "utf8"));
      const known = typeof window === "number" && window > 0;
      expect(state.window).toBe(known ? window : null);
      expect(state.percent).toBe(known ? Math.floor(5678 * 100 / window) : null);
      expect(state.tokens).toBe(5678);
      expect(state.cut_tokens).toBe(235929);
      expect(state.session_id).toBe("main");
      expect(out).toBe("99");
    });
  });
}

for (const context of [null, "not json"]) {
  test(`Brain state: ${context === null ? "missing" : "unreadable"} context has a null window and percent`, () => {
    isolated((root, shell) => {
      if (context !== null) writeFileSync(join(root, "context.json"), context);
      shell(`
WATCH_STATE_FILE="$HOME/state/watchdog_state.json"
BRAIN_CONTEXT_STATE_FILE="$HOME/context.json"
WARNING_FILE="$HOME/state/context_warning"
TOKENS=0; CUT=0; SESSION=""; LAST_WARN_TS=""; LAST_CUT_TS=""
${stateWriter(brain)}
write_state
`);
      const state = JSON.parse(readFileSync(join(root, "state/watchdog_state.json"), "utf8"));
      expect(state.window).toBeNull();
      expect(state.percent).toBeNull();
    });
  });
}

for (const secondLine of ["gpt own 262144", "claude generic 1000000", "kimi own", "claude generic 0", "gpt own -1", "gpt own 2e5", "gpt own 262144x"]) {
  test(`Claude Code state: engine metadata '${secondLine}' does not change thresholds or percent`, () => {
    isolated((root, shell) => {
      writeFileSync(join(root, "state/watchdog_engine_thresholds"), `209715 235929\n${secondLine}\n`);
      shell(`
HOUSE_CONFIG_FILE="$HOME/.env"
ENGINE_THRESHOLDS_FILE="$HOME/state/watchdog_engine_thresholds"
ENV_WARN_TOKENS=""; ENV_CUT_TOKENS=""
STATE_FILE="$HOME/state/watchdog_state.json"
WARNING_FILE="$HOME/state/context_warning"
TOKENS=117964; PERCENT=50; SESSION_FILE=main.jsonl
LAST_WARN_TS=""; LAST_CUT_TS=""
${resolver}
${stateWriter(claude)}
resolve_thresholds
write_state
`);
      const state = JSON.parse(readFileSync(join(root, "state/watchdog_state.json"), "utf8"));
      const value = secondLine.split(" ")[2];
      expect(state.window).toBe(value && /^[1-9][0-9]*$/.test(value) ? Number(value) : null);
      expect(state.percent).toBe(50);
      expect(state.warn_tokens).toBe(209715);
      expect(state.cut_tokens).toBe(235929);
      expect(state.session_file).toBe("main.jsonl");
    });
  });
}

test("Claude Code clears a known window when engine metadata disappears", () => {
  isolated((root, shell) => {
    writeFileSync(join(root, "state/watchdog_engine_thresholds"), "209715 235929\ngpt own 262144\n");
    shell(`
HOUSE_CONFIG_FILE="$HOME/.env"
ENGINE_THRESHOLDS_FILE="$HOME/state/watchdog_engine_thresholds"
ENV_WARN_TOKENS=""; ENV_CUT_TOKENS=""
STATE_FILE="$HOME/state/watchdog_state.json"
WARNING_FILE="$HOME/state/context_warning"
TOKENS=0; PERCENT=0; LAST_WARN_TS=""; LAST_CUT_TS=""
${resolver}
${stateWriter(claude)}
resolve_thresholds
[ "$THRESHOLD_WINDOW" = 262144 ]
rm "$ENGINE_THRESHOLDS_FILE"
resolve_thresholds
write_state
`);
    const state = JSON.parse(readFileSync(join(root, "state/watchdog_state.json"), "utf8"));
    expect(state.window).toBeNull();
    expect(state.warn_tokens).toBe(800000);
    expect(state.cut_tokens).toBe(900000);
  });
});

const engines = [
  { engine: "gpt", kind: "own", env: { GPT_WINDOW: "262144" }, window: "262144" },
  { engine: "kimi", kind: "own", env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144", CLAUDE_CODE_MAX_CONTEXT_TOKENS: "256000" }, window: "262144" },
  { engine: "minimax", kind: "own", env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "200000" }, window: "200000" },
  { engine: "claude", kind: "generic", env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "1000000" }, window: "1000000" },
  { engine: "claude", kind: "generic", env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: "262144" }, window: "" },
  { engine: "gpt", kind: "own", env: { GPT_WINDOW: "0" }, window: "" },
  { engine: "minimax", kind: "own", env: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: "2e5" }, window: "" },
];
for (const config of engines) {
  test(`loop metadata: ${config.engine} ${JSON.stringify(config.env)} appends only a positive integer`, () => {
    isolated((root, shell) => {
      shell(`
RUNNING_ENGINE="$TEST_ENGINE"; ENGINE_WINDOW="$TEST_KIND"
WATCHDOG_WARN_TOKENS=209715; WATCHDOG_CUT_TOKENS=235929
LOG="$HOME/loop.log"
${engineWriter}
`, { ...config.env, TEST_ENGINE: config.engine, TEST_KIND: config.kind } as Record<string, string>);
      const file = join(root, "state/watchdog_engine_thresholds");
      expect(readFileSync(file, "utf8")).toBe(`209715 235929\n${config.engine} ${config.kind}${config.window ? ` ${config.window}` : ""}\n`);
      expect(existsSync(file + ".tmp")).toBe(false);
      const parsed = shell(`{ read -r fw fc rest; read -r engine window rest; } < "$HOME/state/watchdog_engine_thresholds"
printf '%s %s|%s' "$engine" "$window" "$rest"`);
      expect(parsed).toBe(`${config.engine} ${config.kind}|${config.window}`);
    });
  });
}
