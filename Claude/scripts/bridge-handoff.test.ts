import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pass the bridge by path so its size cannot exceed Linux's 128 KiB argument limit.

const LOOP = process.env.LOOP_UNDER_TEST ?? join(import.meta.dir, "start-claude-loop.sh");
const loop = readFileSync(LOOP, "utf8");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("start-claude-loop.sh hands the bridge over by path", () => {
  test("the bridge goes in as a file, never as its text", () => {
    expect(loop).toContain('--append-system-prompt-file "$BRIDGE"');
    expect(loop).not.toMatch(/--append-system-prompt "\$\(cat/);
  });

  test("a start that cannot happen at all is named in the log", () => {
    expect(loop).toContain('[ "$rc" -eq 126 ]');
  });

  test("why: the old way fails above 128 KiB, the path does not", () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-handoff-"));
    dirs.push(dir);
    const bridge = join(dir, "wake_bridge.md");
    writeFileSync(bridge, "x".repeat(150 * 1024));
    const run = (script: string) => Bun.spawnSync(["bash", "-c", script, "_", bridge], { stderr: "pipe" });
    const asText = run('/bin/true --append-system-prompt "$(cat "$1")"');
    expect(asText.exitCode).toBe(126);
    expect(asText.stderr.toString()).toContain("Argument list too long");
    expect(run('/bin/true --append-system-prompt-file "$1"').exitCode).toBe(0);
  });
});
