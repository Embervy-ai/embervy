import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loop = readFileSync(join(import.meta.dir, "start-claude-loop.sh"), "utf8");
const finalize = loop.slice(loop.indexOf('    MARKER="$EMBERVY_HOME/state/last_cutover_ts"'), loop.indexOf('\n  else\n    CRASH_TIMES+=("$NOW")'));
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cut-finalize-"));
  for (const dir of ["Claude/scripts", "shared/scripts", "state", "logs", "project"]) mkdirSync(join(home, dir), { recursive: true });
  copyFileSync(join(import.meta.dir, "cutoff.sh"), join(home, "Claude/scripts/cutoff.sh"));
  writeFileSync(join(home, "shared/scripts/env-file.sh"), "");
  writeFileSync(join(home, "shared/scripts/house-runtime.sh"), `
embervy_house_pids() { [ ! -f "$EMBERVY_HOME/exited" ] && [ "$MATCH" = yes ] && echo 12345; }
embervy_owns_pid() { [ "$OWN" = yes ] && [ ! -f "$EMBERVY_HOME/exited" ]; }
# Simulate immediate exit and run the real finalize block before cutoff resumes.
kill() {
  [ "$1" = -TERM ] || return 0
  test -s "$EMBERVY_HOME/state/last_cutover_ts" && touch "$EMBERVY_HOME/marked-before-term"
  touch "$EMBERVY_HOME/exited"
  bash "$EMBERVY_HOME/finalize.sh"
}
sleep() { :; }
`);
  writeFileSync(join(home, "project/main.jsonl"), "{}\n");
  writeFileSync(join(home, "Claude/scripts/latest_main_session.py"), 'import os\nprint(os.environ["EMBERVY_HOME"]+"/project/main.jsonl")\n');
  writeFileSync(join(home, "Claude/scripts/extract_bridge.py"), "pass\n");
  writeFileSync(join(home, "Claude/scripts/session-to-rag.sh"), '#!/bin/bash\necho export >> "$EMBERVY_HOME/exports"\n', { mode: 0o755 });
  writeFileSync(join(home, "finalize.sh"), `NOW=$(date +%s)\nPROJECT_DIR="$EMBERVY_HOME/project"\nLOG="$EMBERVY_HOME/logs/loop.log"\nBRIDGE="$EMBERVY_HOME/state/bridge"\n${finalize}\n`);
  const run = (script: string, extra = {}, redirected = false) => Bun.spawnSync(redirected
    ? ["bash", "-c", 'setsid bash "$1" >> "$EMBERVY_HOME/logs/cutoff.log" 2>&1 < /dev/null & wait $!', "--", join(home, script)]
    : ["bash", join(home, script)], {
    env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HOME: home, MATCH: "yes", OWN: "yes", ...extra },
  });
  const count = () => existsSync(join(home, "exports")) ? readFileSync(join(home, "exports"), "utf8").trim().split("\n").length : 0;
  return { home, run, count, clean: () => rmSync(home, { recursive: true, force: true }) };
}

test("a cut uses the configured bridge depth instead of a shell default", () => {
  const f = fixture();
  try {
    for (const script of ["extract_bridge.py", "latest_main_session.py", "transcript_speech.py"]) copyFileSync(join(import.meta.dir, script), join(f.home, "Claude/scripts", script));
    writeFileSync(join(f.home, "project/main.jsonl"), Array.from({ length: 5 }, (_, i) => JSON.stringify({ type: "user", message: { role: "user", content: `turn-${i}` } })).join("\n"));
    expect(f.run("Claude/scripts/cutoff.sh", { CLAUDE_PROJECT_DIR: join(f.home, "project"), EMBERVY_BRIDGE_TURNS: "2" }).exitCode).toBe(0);
    const bridge = readFileSync(join(f.home, "state/wake_bridge.md"), "utf8");
    expect(bridge).toContain("last 2 turns");
    expect(bridge).not.toContain("turn-2");
    expect(bridge).toContain("turn-3");
    expect(bridge).toContain("turn-4");
  } finally { f.clean(); }
});

test("a cut carries the configured number of substantial sessions", () => {
  const f = fixture();
  try {
    for (const script of ["extract_bridge.py", "latest_main_session.py", "transcript_speech.py"]) copyFileSync(join(import.meta.dir, script), join(f.home, "Claude/scripts", script));
    for (let life = 1; life <= 3; life++) {
      const path = join(f.home, `project/life-${life}.jsonl`);
      writeFileSync(path, Array.from({ length: 8 }, (_, turn) => JSON.stringify({ type: "user", message: { role: "user", content: `life-${life}-turn-${turn}` } })).join("\n"));
      utimesSync(path, life, life);
    }
    rmSync(join(f.home, "project/main.jsonl"));
    expect(f.run("Claude/scripts/cutoff.sh", { CLAUDE_PROJECT_DIR: join(f.home, "project"), EMBERVY_BRIDGE_MODE: "sessions", EMBERVY_BRIDGE_SESSIONS: "2" }).exitCode).toBe(0);
    const bridge = readFileSync(join(f.home, "state/wake_bridge.md"), "utf8");
    expect(bridge).toContain("last 2 substantial sessions");
    expect(bridge).not.toContain("life-1-turn");
    expect(bridge.indexOf("life-2-turn-0")).toBeLessThan(bridge.indexOf("life-3-turn-0"));
  } finally { f.clean(); }
});

test("manual and watchdog cuts export once even with immediate exit", () => {
  for (const watchdog of [false, true]) {
    const f = fixture();
    try {
      if (watchdog) writeFileSync(join(f.home, "state/last_cut_session"), "main.jsonl");
      const result = f.run("Claude/scripts/cutoff.sh", {}, watchdog);
      expect(result.exitCode).toBe(0);
      const log = readFileSync(join(f.home, "logs/cutoff.log"), "utf8");
      for (const message of ["cutoff.sh start", "Bridge OK", "Export OK", "cutoff.sh done"]) {
        expect(log.split(message)).toHaveLength(2);
      }
      expect(result.stdout.toString()).toBe(watchdog ? "" : log);
      expect(existsSync(join(f.home, "marked-before-term"))).toBe(true);
      expect(f.count()).toBe(1);
      expect(readFileSync(join(f.home, "logs/loop.log"), "utf8")).toContain("last_cutover_ts");
    } finally { f.clean(); }
  }
});
test("cut output appends once and preserves export failure status for either launch path", () => {
  for (const redirected of [false, true]) {
    const f = fixture();
    try {
      writeFileSync(join(f.home, "logs/cutoff.log"), "previous cut\n");
      writeFileSync(join(f.home, "Claude/scripts/session-to-rag.sh"), '#!/bin/bash\necho "export diagnostic" >&2\nexit 7\n', { mode: 0o755 });
      for (let attempt = 1; attempt <= 2; attempt++) {
        const result = f.run("Claude/scripts/cutoff.sh", {}, redirected);
        expect(result.exitCode).toBe(1);
        const log = readFileSync(join(f.home, "logs/cutoff.log"), "utf8");
        expect(log.startsWith("previous cut\n")).toBe(true);
        for (const message of ["cutoff.sh start", "export diagnostic", "Export FAILED"]) {
          expect(log.split(message)).toHaveLength(attempt + 1);
          if (!redirected) expect(result.stdout.toString().split(message)).toHaveLength(2);
        }
        if (redirected) expect(result.stdout.toString()).toBe("");
        expect(existsSync(join(f.home, "state/last_cutover_ts"))).toBe(false);
        expect(existsSync(join(f.home, "exited"))).toBe(false);
      }
    } finally { f.clean(); }
  }
});
test("dream check retries only the exact transient response and stops at its limit", () => {
  const guide = readFileSync(join(import.meta.dir, "../../INSTALL.md"), "utf8");
  const responseAt = guide.indexOf("    dream_response=$(curl");
  expect(responseAt).toBeGreaterThan(0);
  const blockAt = guide.lastIndexOf("```bash\n", responseAt) + "```bash\n".length;
  const check = guide.slice(blockAt, guide.indexOf("\n```", responseAt));
  const missing = '{"error":"server misconfigured: DREAM_AUTH_TOKEN missing"}';
  const transient = `printf '%s\\n503' '${missing}'`;
  const success = `printf '%s\\n200' '{"status":"dreamed","content":"synthetic note"}'`;
  for (const scenario of [
    { replies: [success], calls: 1, pauses: 0, ok: true },
    { replies: [transient, success], calls: 2, pauses: 1, ok: true },
    { replies: [transient], calls: 5, pauses: 4, ok: false },
    { replies: [`printf '%s\\n401' '${missing}'`], calls: 1, pauses: 0, ok: false },
    { replies: [`printf '%s\\n503' '{"error":"different failure"}'`], calls: 1, pauses: 0, ok: false },
    { replies: ["return 7"], calls: 1, pauses: 0, ok: false },
  ]) {
    const f = fixture();
    try {
      writeFileSync(join(f.home, "dream-check.sh"), `
DREAM_URL=dream-check; EMBERVY_URL=memory-check
DREAM_AUTH_TOKEN=; EMBERVY_API_KEY=
wrangler() { :; }
sleep() { echo "$1" >> "$EMBERVY_HOME/pauses"; }
curl() {
  case "$*" in
    *memory-check/mcp*) echo health >> "$EMBERVY_HOME/requests"; return 0 ;;
    *'-o /dev/null'*) printf '401\\n'; return 0 ;;
  esac
  echo dream >> "$EMBERVY_HOME/requests"
  n=$(wc -l < "$EMBERVY_HOME/requests")
  case "$n" in
    ${scenario.replies.map((reply, i) => `${i + 1}) ${reply} ;;`).join("\n    ")}
    *) ${scenario.replies.at(-1)} ;;
  esac
}
${check}
`);
      expect(f.run("dream-check.sh").exitCode === 0).toBe(scenario.ok);
      const requests = readFileSync(join(f.home, "requests"), "utf8").trim().split("\n");
      expect(requests.filter((x) => x === "dream")).toHaveLength(scenario.calls);
      expect(requests.includes("health")).toBe(scenario.ok);
      const pauses = existsSync(join(f.home, "pauses")) ? readFileSync(join(f.home, "pauses"), "utf8").trim().split("\n") : [];
      expect(pauses).toEqual(Array(scenario.pauses).fill("7"));
    } finally { f.clean(); }
  }
});
test("natural end exports once without cut markers", () => {
  const f = fixture();
  try { expect(f.run("finalize.sh").exitCode).toBe(0); expect(f.count()).toBe(1); }
  finally { f.clean(); }
});
test("recent matching session guards independently; stale or different sessions do not", () => {
  for (const mode of ["recent", "stale", "different"]) {
    const f = fixture();
    try {
      const marker = join(f.home, "state/last_cut_session");
      writeFileSync(marker, mode === "different" ? "other.jsonl" : "main.jsonl");
      if (mode === "stale") utimesSync(marker, new Date(0), new Date(0));
      expect(f.run("finalize.sh").exitCode).toBe(0);
      expect(f.count()).toBe(mode === "recent" ? 0 : 1);
      if (mode === "recent") expect(readFileSync(join(f.home, "logs/loop.log"), "utf8")).toContain("last_cut_session matches");
    } finally { f.clean(); }
  }
});
test("no matches or no owned PID writes no cut marker", () => {
  for (const extra of [{ MATCH: "no" }, { OWN: "no" }]) {
    const f = fixture();
    try {
      f.run("Claude/scripts/cutoff.sh", extra);
      expect(existsSync(join(f.home, "state/last_cutover_ts"))).toBe(false);
      expect(existsSync(join(f.home, "state/last_cut_session"))).toBe(false);
    } finally { f.clean(); }
  }
});
