import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillsSection } from "./skills";
import { DEFAULT_TOOL_RULES, systemPromptExtras } from "./system-prompt";

const dirs: string[] = [];
const api = { name: "gpt", transport: "api" as const };
const pipe = { name: "claude", transport: "pipe" as const };
const notice = "More skills are available in the directory above.";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "brain-skills-"));
  dirs.push(home);
  const dir = join(home, ".claude", "skills");
  mkdirSync(dir, { recursive: true });
  const events: Record<string, unknown>[] = [];
  const log = (event: Record<string, unknown>) => { events.push(event); };
  const env = { BRAIN_CLAUDE_CWD: home };
  function skill(folder: string, metadata: string, body = "BODY_NOT_IN_INDEX", root = dir) {
    const path = join(root, folder, "SKILL.md");
    mkdirSync(join(root, folder), { recursive: true });
    writeFileSync(path, `---\n${metadata}\n---\n${body}`);
    return path;
  }
  return { home, dir, env, events, log, skill };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("API heads receive names, descriptions and paths sorted by name", () => {
  const f = fixture();
  const z = f.skill("first", 'name: Zeta\ndescription: "Inspect a page: layout and behavior."');
  const a = f.skill("last", "name: 'Alpha'\ndescription: 'Check a document.'");
  for (const name of ["gpt", "grok", "api", "kimi"]) {
    const sections = systemPromptExtras({ ...api, name }, f.env, f.log, "append");
    expect(sections).toHaveLength(1);
    const section = sections[0];
    expect(section).toStartWith("## Skills\n");
    expect(section).toContain(`Directory: ${f.dir}`);
    expect(section).toContain(`- Alpha — Check a document. — ${a}`);
    expect(section).toContain(`- Zeta — Inspect a page: layout and behavior. — ${z}`);
    expect(section.indexOf("- Alpha")).toBeLessThan(section.indexOf("- Zeta"));
    expect(section).toContain("read_file");
    expect(section).not.toContain("BODY_NOT_IN_INDEX");
  }
  expect(f.events).toEqual([]);
});

test("pipe heads receive no duplicate index and do not inspect skill files", () => {
  const f = fixture();
  f.skill("valid", "name: Valid\ndescription: A task.");
  mkdirSync(join(f.dir, "missing"));
  expect(systemPromptExtras(pipe, f.env, f.log, "append")).toEqual([]);
  expect(systemPromptExtras(pipe, f.env, f.log, "replace")).toEqual([DEFAULT_TOOL_RULES]);
  expect(f.events).toEqual([]);
});

test("unset, missing, empty and relative directories add no section or error", () => {
  const f = fixture();
  for (const env of [
    {}, f.env, { BRAIN_CLAUDE_CWD: "relative" }, { BRAIN_SKILLS_DIR: "relative" },
    { BRAIN_SKILLS_DIR: join(f.home, "absent") },
    { BRAIN_CLAUDE_CWD: join(f.home, "absent") },
  ]) expect(systemPromptExtras(api, env, f.log, "append")).toEqual([]);
  expect(f.events).toEqual([]);
});

test("an absolute override wins; unusable overrides fall back to the working directory", () => {
  const f = fixture();
  f.skill("default", "name: Default\ndescription: Default task.");
  const override = join(f.home, "override");
  const file = f.skill("custom", "name: Custom\ndescription: Custom task.", "", override);
  const section = skillsSection({ ...f.env, BRAIN_SKILLS_DIR: override }, f.log);
  expect(section).toContain(file);
  expect(section).not.toContain("Default task.");
  expect(skillsSection({ BRAIN_SKILLS_DIR: override }, f.log)).toBe(section);
  expect(skillsSection({ ...f.env, BRAIN_SKILLS_DIR: "relative" }, f.log)).toContain("Default task.");
  expect(skillsSection({ ...f.env, BRAIN_SKILLS_DIR: join(f.home, "absent") }, f.log)).toBe("");
});

test("missing names use folder names; invalid and unreadable files are logged independently", () => {
  const f = fixture();
  const valid = f.skill("fallback", "description: Useful task.");
  f.skill("broken", "description: [unsupported, list]");
  f.skill("duplicate", "name: One\nname: Two");
  f.skill("nested", "description:\n  nested: value");
  f.skill("unquoted", 'description: "Unclosed');
  mkdirSync(join(f.dir, "missing"));
  mkdirSync(join(f.dir, "not-a-file", "SKILL.md"), { recursive: true });
  const section = skillsSection(f.env, f.log);
  expect(section).toContain(`- fallback — Useful task. — ${valid}`);
  expect(section.split("\n").filter(line => line.startsWith("- "))).toHaveLength(1);
  expect(f.events.filter(e => e.type === "skills_frontmatter_invalid")).toHaveLength(4);
  expect(f.events.filter(e => e.type === "skills_file_read_failed")).toHaveLength(2);
  expect(f.events.some(e => e.file === join(f.dir, "missing", "SKILL.md"))).toBe(true);
});

test("only flat frontmatter at the start is accepted, not metadata in the body", () => {
  const f = fixture();
  const file = f.skill("invalid", "name: Invalid");
  for (const text of ["name: Invalid", "Intro\n---\nname: Invalid\n---", "---\nname: Invalid\n", "---\ndescription: >\ntext\n---"]) {
    writeFileSync(file, text);
    expect(skillsSection(f.env, f.log)).toBe("");
  }
  expect(f.events).toHaveLength(4);
  writeFileSync(file, "---\r\ndescription: 'A person''s task.'\r\n---\r\nname: Not metadata");
  expect(skillsSection(f.env, f.log)).toContain("- invalid — A person's task.");
});

test("descriptions are capped at 400 Unicode characters without splitting a character", () => {
  const f = fixture();
  f.skill("long", `name: Long\ndescription: ${"😀".repeat(401)}END`);
  const section = skillsSection(f.env, f.log);
  expect(section).toContain(`— ${"😀".repeat(400)} —`);
  expect(section).not.toContain("😀".repeat(401));
  expect(section).not.toContain("END");
  expect(section).not.toContain("�");
});

test("frontmatter must close within the first 8000 bytes; a large body is not indexed", () => {
  const f = fixture();
  const file = f.skill("boundary", "name: Boundary");
  const prefix = "---\nname: Boundary\ndescription: ";
  writeFileSync(file, prefix + "x".repeat(8000 - Buffer.byteLength(prefix) - 5) + "\n---\n" + "BODY".repeat(10000));
  expect(skillsSection(f.env, f.log)).toContain("- Boundary");
  writeFileSync(file, prefix + "x".repeat(8002 - Buffer.byteLength(prefix) - 5) + "\n---\n");
  expect(skillsSection(f.env, f.log)).toBe("");
  expect(f.events.at(-1)?.type).toBe("skills_frontmatter_invalid");
});

test("the complete section obeys byte caps and ends with a notice when entries do not fit", () => {
  const f = fixture();
  for (let i = 0; i < 40; i++) f.skill(`skill-${String(i).padStart(2, "0")}`, `description: ${"€".repeat(400)}`);
  for (const cap of [1000, 2000, 12000]) {
    const section = skillsSection({ ...f.env, BRAIN_SKILLS_MAX_BYTES: String(cap) }, f.log);
    expect(Buffer.byteLength(section)).toBeLessThanOrEqual(cap);
    expect(section).toStartWith("## Skills\n");
    expect(section).toEndWith(notice);
    expect(section).not.toContain("�");
  }
  const defaultSection = skillsSection(f.env, f.log);
  expect(defaultSection).toEndWith(notice);
  expect(Buffer.byteLength(defaultSection)).toBeLessThanOrEqual(12000);
  for (const cap of ["", "0", "-1", "1.5", "NaN", "Infinity"]) {
    expect(skillsSection({ ...f.env, BRAIN_SKILLS_MAX_BYTES: cap }, f.log)).toBe(defaultSection);
  }
  expect(skillsSection({ ...f.env, BRAIN_SKILLS_MAX_BYTES: "1" }, f.log)).toBe("");
  expect(f.events.at(-1)?.type).toBe("skills_section_omitted");
});

test("an exact byte fit needs no truncation notice", () => {
  const f = fixture();
  f.skill("one", "description: A task.");
  const section = skillsSection(f.env, f.log);
  expect(section).not.toContain(notice);
  expect(skillsSection({ ...f.env, BRAIN_SKILLS_MAX_BYTES: String(Buffer.byteLength(section)) }, f.log)).toBe(section);
  const truncated = skillsSection({ ...f.env, BRAIN_SKILLS_MAX_BYTES: String(Buffer.byteLength(section) - 1) }, f.log);
  expect(truncated).toEndWith(notice);
  expect(Buffer.byteLength(truncated)).toBeLessThan(Buffer.byteLength(section));
});

test("directory and file symlinks outside the skills root are skipped; internal links work", () => {
  const f = fixture();
  const outside = join(f.home, ".claude", "skills-other");
  const external = f.skill("secret", "name: External\ndescription: OUTSIDE_METADATA", "", outside);
  symlinkSync(join(outside, "secret"), join(f.dir, "external-directory"));
  mkdirSync(join(f.dir, "external-file"));
  symlinkSync(external, join(f.dir, "external-file", "SKILL.md"));
  const internal = f.skill("valid", "name: Internal\ndescription: Safe task.");
  symlinkSync(join(f.dir, "valid"), join(f.dir, "internal-directory"));
  mkdirSync(join(f.dir, "internal-file"));
  symlinkSync(internal, join(f.dir, "internal-file", "SKILL.md"));
  const section = skillsSection(f.env, f.log);
  expect(section).toContain("Safe task.");
  expect(section).not.toContain("OUTSIDE_METADATA");
  expect(section).not.toContain("external-file");
  expect(section).not.toContain("external-directory");
  expect(section).toContain(join(f.dir, "internal-directory", "SKILL.md"));
  expect(section).toContain(join(f.dir, "internal-file", "SKILL.md"));
  expect(f.events.filter(e => e.type === "skills_symlink_outside")).toHaveLength(2);
});

test("consecutive calls are identical, ties are ordered by path, and edits are read afresh", () => {
  const f = fixture();
  const z = f.skill("z", "name: Same\ndescription: Old task.");
  const a = f.skill("a", "name: Same\ndescription: Another task.");
  const first = systemPromptExtras(api, f.env, f.log, "append");
  expect(systemPromptExtras(api, f.env, f.log, "append")).toEqual(first);
  expect(first[0].indexOf(a)).toBeLessThan(first[0].indexOf(z));
  writeFileSync(z, "---\nname: Same\ndescription: Updated task.\n---\n");
  const updated = systemPromptExtras(api, f.env, f.log, "append")[0];
  expect(updated).toContain("Updated task.");
  expect(updated).not.toContain("Old task.");
});

test("skills sit between notes and context without changing tool rules", () => {
  const f = fixture();
  f.skill("one", "description: A task.");
  writeFileSync(join(f.home, "NOTES.md"), "NOTE_TEXT");
  const context = join(f.home, "context.md");
  writeFileSync(context, "CONTEXT_TEXT");
  const env = { ...f.env, BRAIN_NOTES_DIR: f.home, BRAIN_CONTEXT_FILES: context };
  const sections = systemPromptExtras(api, env, f.log, "replace");
  expect(sections.map(section => section.split("\n")[0])).toEqual(["## Notes", "## Skills", "## Context files", "## Tool use"]);
  expect(sections[0]).toContain("NOTE_TEXT");
  expect(sections[2]).toContain("CONTEXT_TEXT");
  expect(sections[3]).toBe(DEFAULT_TOOL_RULES);
});
