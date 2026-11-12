// Every entry shape that occurs in real Claude Code transcripts, run through both exporters.
// The fixture mirrors a census of real transcripts (placeholders, no content); each kept line carries a
// token, and the expectation says who must speak it, or that it must not appear at all.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = join(import.meta.dir, "fixtures", "transcript-shapes.jsonl");
const expected: Record<string, string | null> = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "transcript-shapes.expected.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "transcript-contract-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function exportBoth(): { name: string; text: string }[] {
  const archive = join(root, "archive.md"), bridge = join(root, "bridge.md");
  const env = { PATH: process.env.PATH!, HOME: root, EMBERVY_HOME: root, SESSION_FILE: fixture,
    USER_LABEL: "Person", AGENT_LABEL: "Agent", EMBERVY_TIMEZONE: "UTC", RAG_URL: "http://rag.invalid", DRY_RUN: "1", DRY_OUT: archive };
  const chronicle = Bun.spawnSync(["bash", join(import.meta.dir, "session-to-rag.sh"), "Session_1", "1"], { env, stdout: "pipe", stderr: "pipe" });
  expect(chronicle.exitCode).toBe(0);
  const wake = Bun.spawnSync(["python3", join(import.meta.dir, "extract_bridge.py"), "40", bridge], { env, stdout: "pipe", stderr: "pipe" });
  expect(wake.exitCode).toBe(0);
  return [{ name: "chronicle", text: readFileSync(archive, "utf8") }, { name: "bridge", text: readFileSync(bridge, "utf8") }];
}

function speakers(text: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const match of text.matchAll(/\*\*([^*]+)\*\*(?: · \d{2}:\d{2})?\n\n([\s\S]*?)(?=\n+---\n|$)/g)) {
    for (const token of match[2].match(/token-\d+/g) ?? []) found.set(token, [...(found.get(token) ?? []), match[1]]);
  }
  return found;
}

const outputs = exportBoth();

for (const { name, text } of outputs) {
  const found = speakers(text);
  for (const [token, speaker] of Object.entries(expected)) {
    test(`${name}: ${token} ${speaker ? `is spoken by ${speaker}` : "does not appear"}`, () => {
      if (speaker === null) expect(text).not.toContain(token);
      else expect(found.get(token)).toEqual([speaker]);
    });
  }
  test(`${name}: inbound speech is there at all`, () => {
    const inbound = Object.entries(expected).filter(([, speaker]) => speaker && speaker !== "Agent" && speaker !== "System");
    expect(inbound.length).toBeGreaterThan(0);
    for (const [token] of inbound) expect(found.has(token)).toBe(true);
  });
}

test("bridge and chronicle choose the same speaker for every kept line", () => {
  const [chronicle, bridge] = outputs.map(({ text }) => speakers(text));
  expect([...bridge.entries()].sort()).toEqual([...chronicle.entries()].sort());
});
