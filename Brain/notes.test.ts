import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notesCliEnvironment, notesSection } from "./notes";
import { DEFAULT_TOOL_RULES, systemPromptExtras } from "./system-prompt";
import { apiSystemPrompt, buildPipeSystemPrompt, makeInitialState } from "./brain";
import { resolveHead } from "./heads";

const dirs: string[] = [];
const saved = new Map<string, string | undefined>();
function env(key: string, value?: string) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "brain-notes-"));
  dirs.push(dir);
  const events: Record<string, unknown>[] = [];
  return { dir, index: join(dir, "NOTES.md"), events, log: (e: Record<string, unknown>) => { events.push(e); } };
}
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const pipe = { name: "claude", transport: "pipe" as const };
const api = { name: "api", transport: "api" as const };

test("unset notes add no section; the default tool rules and CLI environment are independent", () => {
  expect(systemPromptExtras(pipe, {}, () => {})).toEqual([DEFAULT_TOOL_RULES]);
  expect(systemPromptExtras(api, {}, () => {})).toEqual([]);
  expect(notesSection({}, "ignored", true)).toBe("");
  expect(notesCliEnvironment({})).toEqual({});
  expect(notesCliEnvironment({})).not.toHaveProperty("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
});

test("CLI environment override disables auto-memory only with notes enabled", () => {
  const f = fixture();
  expect(notesCliEnvironment({ BRAIN_NOTES_DIR: f.dir })).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  expect(notesCliEnvironment({ BRAIN_NOTES_DIR: " " })).toEqual({});
  expect(notesCliEnvironment({ BRAIN_NOTES_DIR: "relative" })).toEqual({});
});

test("real pipe-birth and API prompt builders reread the index without restarting", async () => {
  const f = fixture();
  env("BRAIN_NOTES_DIR", f.dir);
  env("BRAIN_CLAUDE_SYSTEM_PROMPT_MODE", "append");
  env("BRAIN_API_SYSTEM_PROMPT_MODE", "append");
  env("BRAIN_NOTES_MAX_BYTES");
  const state = makeInitialState([]);
  state.head = resolveHead("api", process.env);
  const head = resolveHead("claude", process.env, "pipe");
  for (const text of ["[First](first.md) — original rule", "[Second](second.md) — corrected rule"]) {
    writeFileSync(f.index, text);
    const birth = await buildPipeSystemPrompt(state, head, "test");
    const turn = await apiSystemPrompt(state);
    for (const prompt of [birth, turn]) {
      expect(prompt).toContain("## Notes\n");
      expect(prompt).toContain(`Directory: ${f.dir}`);
      expect(prompt).toContain(text);
      if (text.includes("Second")) expect(prompt).not.toContain("original rule");
    }
  }
});

test("API default preserves the previous append prompt byte-for-byte for GPT, Grok and generic API", async () => {
  const f = fixture();
  const context = join(f.dir, "context.md"), rules = join(f.dir, "rules.md");
  writeFileSync(f.index, "NOTE-BYTES");
  writeFileSync(context, "CONTEXT-BYTES");
  writeFileSync(rules, "RULE-BYTES");
  env("BRAIN_NOTES_DIR", f.dir);
  env("BRAIN_CONTEXT_FILES", context);
  env("BRAIN_TOOL_RULES_FILE", rules);
  const state = makeInitialState([]);
  for (const name of ["gpt", "grok", "api"]) {
    const key = `BRAIN_${name.toUpperCase()}_SYSTEM_PROMPT_MODE`;
    state.head = resolveHead(name, { BRAIN_GPT_CACHE_KEY: "fixture", XAI_API_KEY: "fixture", BRAIN_ENDPOINT: "http://127.0.0.1:1" });
    env(key, "append");
    const appended = await apiSystemPrompt(state);
    env(key);
    const defaulted = await apiSystemPrompt(state);
    expect(defaulted).toContain("NOTE-BYTES");
    expect(defaulted).toContain("CONTEXT-BYTES");
    expect(defaulted).toBe(appended);
    expect(defaulted).not.toContain("## Tool use");
    expect(defaulted).not.toContain("RULE-BYTES");
    env(key, "replace");
    const replaced = await apiSystemPrompt(state);
    expect(replaced).toContain("\n\n## Tool use\n\nRULE-BYTES");
    expect(replaced.replace("\n\n## Tool use\n\nRULE-BYTES", "")).toBe(defaulted);
  }
});

test("missing index stays empty without crashing and logs the missing file", () => {
  const f = fixture();
  for (const head of [pipe, api]) {
    expect(systemPromptExtras(head, { BRAIN_NOTES_DIR: f.dir }, f.log).join("\n")).toContain("The index is still empty.");
  }
  expect(f.events[0]?.type).toBe("notes_file_missing");
});

test("notes have an independent UTF-8 byte limit and a visible truncation notice", () => {
  const f = fixture();
  writeFileSync(f.index, "ab€END");
  const config = { BRAIN_NOTES_DIR: f.dir, BRAIN_NOTES_MAX_BYTES: "4", BRAIN_CONTEXT_FILE_MAX_BYTES: "1" };
  const section = systemPromptExtras(pipe, config, f.log)[0];
  expect(section).toContain("### NOTES.md\n\nab\n\n[The index is truncated;");
  expect(section).not.toContain("�");
  expect(section).not.toContain("END");
  expect(f.events).toEqual([{ type: "notes_file_truncated", file: f.index, max_bytes: 4 }]);
  writeFileSync(f.index, "abcd");
  expect(systemPromptExtras(api, config, f.log)[0]).not.toContain("[The index is truncated;");
});

test("default notes cap is 25000 bytes and invalid limits fall back", () => {
  const f = fixture();
  writeFileSync(f.index, "x".repeat(25001));
  for (const cap of [undefined, "", "0", "-1", "NaN", "1.5"]) {
    const section = systemPromptExtras(api, { BRAIN_NOTES_DIR: f.dir, BRAIN_NOTES_MAX_BYTES: cap }, f.log)[0];
    expect(section).toContain("x".repeat(25000));
    expect(section).not.toContain("x".repeat(25001));
    expect(section).toContain("[The index is truncated;");
  }
});
