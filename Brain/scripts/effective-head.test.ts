import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { effectiveHead } from "./effective-head";
import { headFile } from "../head-file";

const dir = mkdtempSync(join(tmpdir(), "effective-head-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const cli = join(import.meta.dir, "effective-head.ts");
const loop = readFileSync(join(import.meta.dir, "brain-loop.sh"), "utf8");

function state(head: "gpt" | "claude") {
  const file = join(dir, `${head}.json`);
  writeFileSync(file, JSON.stringify({ version: 1, head, model: "test-model", window: 1000000, transport: head === "claude" ? "pipe" : "api" }));
  return file;
}

for (const [envHead, saved] of [["claude", "gpt"], ["gpt", "claude"]] as const) {
  test(`saved ${saved} overrides environment ${envHead}, including CLI output`, () => {
    const env = { BRAIN_HEAD: envHead, BRAIN_HEAD_FILE: state(saved) };
    expect(effectiveHead(env)).toBe(saved);
    const result = Bun.spawnSync([process.execPath, cli], { env, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`${saved}\n`);
    expect(result.stderr.toString()).toBe("");
  });
}

for (const head of ["claude", "gpt"]) {
  test(`missing state falls back to environment ${head}`, () => {
    expect(effectiveHead({ BRAIN_HEAD: head, BRAIN_HEAD_FILE: join(dir, "missing.json") })).toBe(head);
  });
  test(`unreadable state falls back to environment ${head}`, () => {
    // A directory reliably fails readFileSync even when tests run with elevated permissions.
    const file = join(dir, "unreadable");
    mkdirSync(file, { recursive: true });
    expect(effectiveHead({ BRAIN_HEAD: head, BRAIN_HEAD_FILE: file })).toBe(head);
  });
  for (const [kind, raw] of [["JSON", "{"], ["schema", '{"head":"gpt"}']]) {
    test(`invalid ${kind} falls back to environment ${head}`, () => {
      const file = join(dir, `invalid-${kind}-${head}.json`);
      writeFileSync(file, raw);
      expect(effectiveHead({ BRAIN_HEAD: head, BRAIN_HEAD_FILE: file })).toBe(head);
    });
  }
}

test("head file defaults and overrides preserve runtime path semantics", () => {
  expect(headFile({})).toBe(join(import.meta.dir, "..", "state", "brain-head.json"));
  expect(headFile({ BRAIN_STATE_DIR: dir })).toBe(join(dir, "brain-head.json"));
  expect(headFile({ BRAIN_STATE_DIR: "", BRAIN_HEAD_FILE: "" })).toBe("brain-head.json");
  expect(headFile({ BRAIN_STATE_DIR: dir, BRAIN_HEAD_FILE: "custom.json" })).toBe("custom.json");
  expect(effectiveHead({ BRAIN_HEAD_FILE: join(dir, "missing.json") })).toBe("api");
});

for (const [envHead, saved] of [["claude", "gpt"], ["gpt", "claude"]] as const) {
  test(`isolated restart notifier carries saved ${saved}, not environment ${envHead}`, () => {
    const notify = loop.match(/^notify_runtime_swap\(\) \{\n[\s\S]*?^\}/m)?.[0];
    const assignment = loop.match(/^resolve_effective_head\(\) \{\n[\s\S]*?^\}/m)?.[0];
    expect(notify).toBeDefined();
    expect(assignment).toBeDefined();
    const result = Bun.spawnSync(["bash", "-c", `
brain_text() { printf '%s|' "$@"; }
brain_notify_app() { printf '%s' "$1"; }
${notify}
${assignment}
notify_runtime_swap 143
`], { env: { PATH: process.env.PATH!, BUN_BIN: process.execPath, BRAIN_TEXTS_DIR: import.meta.dir, BRAIN_HEAD: envHead, BRAIN_HEAD_FILE: state(saved), LOG: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(`loop.restart|SIGTERM|${saved}|`);
  });
}

test("a failed resolver process leaves the notifier alive on the environment head", () => {
  const notify = loop.match(/^notify_runtime_swap\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const assignment = loop.match(/^resolve_effective_head\(\) \{\n[\s\S]*?^\}/m)?.[0];
  expect(notify).toBeDefined();
  expect(assignment).toBeDefined();
  const result = Bun.spawnSync(["bash", "-c", `
brain_text() { printf '%s|' "$@"; }
brain_notify_app() { printf '%s' "$1"; }
${notify}
${assignment}
notify_runtime_swap 143
`], { env: { PATH: process.env.PATH!, BUN_BIN: "/bin/false", BRAIN_TEXTS_DIR: import.meta.dir, BRAIN_HEAD: "claude", LOG: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("loop.restart|SIGTERM|claude|");
});

test("after a head switch the notice names the new head, not the one captured at start", () => {
  const notify = loop.match(/^notify_runtime_swap\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const resolver = loop.match(/^resolve_effective_head\(\) \{\n[\s\S]*?^\}/m)?.[0];
  expect(notify).toBeDefined();
  expect(resolver).toBeDefined();
  const result = Bun.spawnSync(["bash", "-c", `
brain_text() { printf '%s|' "$@"; }
brain_notify_app() { printf '%s' "$1"; }
${resolver}
${notify}
EFFECTIVE_HEAD=claude
notify_runtime_swap 0
`], { env: { PATH: process.env.PATH!, BUN_BIN: process.execPath, BRAIN_TEXTS_DIR: import.meta.dir, BRAIN_HEAD: "claude", BRAIN_HEAD_FILE: state("gpt"), LOG: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("|gpt|");
});

test("adapter gate shares the resolved head, and each start resolves it before the adapter check", () => {
  expect(loop).toContain('ensure_gpt_adapter() {\n  [ "$EFFECTIVE_HEAD" = "gpt" ] || return 0');
  expect(loop.match(/effective-head\.ts/g)).toHaveLength(1);
  const body = loop.slice(loop.indexOf("\nwhile true; do\n"));
  expect(body.indexOf("\n  resolve_effective_head\n")).toBeGreaterThan(-1);
  expect(body.indexOf("\n  resolve_effective_head\n")).toBeLessThan(body.indexOf("\n  ensure_gpt_adapter\n"));
});
