import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownSkillsWriteAllowed, OWN_SKILLS_DENIAL } from "./approval-rules";
import { pipePermissionArgs, PIPE_PROFILE_KEYS } from "./brain";

const root = mkdtempSync(join(tmpdir(), "brain-own-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const cwd = join(root, "house");
const skills = join(cwd, ".claude/skills");
mkdirSync(skills, { recursive: true });
writeFileSync(join(skills, "existing.md"), "before");
const env = { BRAIN_CLAUDE_CWD: cwd };
const allows = (path: string, tool = "Write", overrides = {}) =>
  ownSkillsWriteAllowed(tool, { file_path: path }, { ...env, ...overrides }, true);

for (const tool of ["Write", "Edit", "MultiEdit"]) {
  test(`${tool} permits new and existing own skill files`, () => {
    for (const path of [join(skills, "new/nested/SKILL.md"), join(skills, "existing.md"), ".claude/skills/relative.md"]) {
      expect(allows(path, tool)).toBe(true);
    }
  });
}

for (const path of [
  ".claude/settings.json", ".claude/settings.local.json", ".claude/hooks/x.sh", ".claude/agents/x.md",
  ".claude/skills/../settings.json", ".claude/skills/../../outside.md",
  ".claude/skills/settings.json", ".claude/skills/settings.local.json", ".claude/skills/hooks/x.sh",
  ".claude/skills", ".claude/skills-sibling/x.md", join(root, "other/.claude/skills/SKILL.md"),
]) test(`denies ${path}`, () => expect(allows(path)).toBe(false));

for (const tool of ["Bash", "bash", "task_start", "WriteFile", "write_file", "edit_file", "mcp__files__Write", "Read", "NotebookEdit", "Unknown"]) {
  test(`does not grant ${tool}`, () => expect(allows(join(skills, "SKILL.md"), tool)).toBe(false));
}

for (const input of [undefined, null, [], {}, { file_path: 1 }, { file_path: "" }, { file_path: "bad\0path" }, { path: join(skills, "x") }]) {
  test(`malformed input fails closed: ${JSON.stringify(input)}`, () => {
    expect(ownSkillsWriteAllowed("Write", input, env, true)).toBe(false);
  });
}

test("tool input cannot substitute the house working directory", () => {
  expect(ownSkillsWriteAllowed("Write", { file_path: ".claude/skills/new.md", cwd: "/elsewhere" }, env, true)).toBe(true);
  expect(ownSkillsWriteAllowed("Write", { file_path: join(root, "foreign/.claude/skills/new.md"), cwd }, env, true)).toBe(false);
});

test("configuration gates the exception", () => {
  for (const overrides of [{ BRAIN_CLAUDE_CWD: undefined }, { BRAIN_CLAUDE_CWD: "relative" },
    { BRAIN_CLAUDE_CWD: "" }, { BRAIN_OWN_SKILLS_WRITE: "off" }, { BRAIN_OWN_SKILLS_WRITE: "invalid" },
    { BRAIN_APPROVAL_SETTINGS: "/settings.json" }]) {
    expect(allows(join(skills, "x"), "Write", overrides)).toBe(false);
  }
  expect(allows(join(skills, "x"), "Write", { BRAIN_OWN_SKILLS_WRITE: "on" })).toBe(true);
  expect(ownSkillsWriteAllowed("Write", { file_path: join(skills, "x") }, env, false)).toBe(false);
});

test("missing .claude and skills directories can be created", () => {
  const fresh = join(root, "fresh");
  mkdirSync(fresh);
  expect(ownSkillsWriteAllowed("Write", { file_path: ".claude/skills/new/SKILL.md" }, { BRAIN_CLAUDE_CWD: fresh }, true)).toBe(true);
  expect(allows(join(skills, "x"), "Write", { BRAIN_CLAUDE_CWD: join(root, "missing") })).toBe(false);
});

test("symlink chains cannot escape, including escape then re-entry", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(skills, "escape"));
  symlinkSync(skills, join(outside, "back"));
  symlinkSync(join(outside, "back"), join(skills, "roundtrip"));
  symlinkSync(join(root, "missing"), join(skills, "dangling"));
  symlinkSync("loop", join(skills, "loop"));
  symlinkSync(join(cwd, ".claude/settings.json"), join(skills, "settings-link"));
  writeFileSync(join(cwd, ".claude/settings.json"), "{}");
  for (const path of ["escape/new.md", "roundtrip/new.md", "dangling/new.md", "loop", "settings-link"]) {
    expect(allows(join(skills, path))).toBe(false);
  }
  symlinkSync("existing.md", join(skills, "inside-file"));
  mkdirSync(join(skills, "real"));
  symlinkSync("real", join(skills, "inside-dir"));
  symlinkSync("inside-dir", join(skills, "inside-chain"));
  symlinkSync("../skills/real", join(skills, "inside-parent-link"));
  symlinkSync("../../../outside/back", join(skills, "relative-roundtrip"));
  expect(allows(join(skills, "relative-roundtrip/new.md"))).toBe(false);
  expect(allows(join(skills, "inside-parent-link/new.md"))).toBe(true);
  expect(allows(join(skills, "inside-file"), "Edit")).toBe(true);
  expect(allows(join(skills, "inside-chain/new.md"))).toBe(true);
  expect(allows(join(skills, "existing.md/child"))).toBe(false);
});

test("relocated .claude or skills roots are not own skills; cwd aliases are canonicalized", () => {
  const relocated = join(root, "relocated");
  mkdirSync(relocated);
  symlinkSync(join(cwd, ".claude"), join(relocated, ".claude"));
  expect(ownSkillsWriteAllowed("Write", { file_path: ".claude/skills/x" }, { BRAIN_CLAUDE_CWD: relocated }, true)).toBe(false);
  const other = join(root, "other");
  mkdirSync(join(other, ".claude"), { recursive: true });
  symlinkSync(skills, join(other, ".claude/skills"));
  expect(ownSkillsWriteAllowed("Write", { file_path: ".claude/skills/x" }, { BRAIN_CLAUDE_CWD: other }, true)).toBe(false);
  const alias = join(root, "alias");
  symlinkSync(cwd, alias);
  for (const file_path of [".claude/skills/x", join(alias, ".claude/skills/x"), join(skills, "x")]) {
    expect(ownSkillsWriteAllowed("Write", { file_path }, { BRAIN_CLAUDE_CWD: alias }, true)).toBe(true);
  }
});

test("pipe none wiring and opt-out, without changing other modes", () => {
  expect(pipePermissionArgs("none", true, env)).toEqual({ permissionPromptTool: "mcp__brain__approve" });
  for (const config of [{}, { BRAIN_CLAUDE_CWD: "relative" }, { ...env, BRAIN_OWN_SKILLS_WRITE: "off" }]) {
    expect(pipePermissionArgs("none", true, config)).toEqual({ permissionPrompts: "none" });
  }
  expect(pipePermissionArgs("none", false, env)).toEqual({ permissionPrompts: "none" });
  expect(PIPE_PROFILE_KEYS).toContain("BRAIN_OWN_SKILLS_WRITE");
  for (const setting of [undefined, "on", "off"]) {
    const config = { ...env, BRAIN_OWN_SKILLS_WRITE: setting };
    expect(pipePermissionArgs("app", true, config)).toEqual({ permissionPromptTool: "mcp__brain__approve", disallowedTools: ["AskUserQuestion"] });
    expect(pipePermissionArgs("app", false, config)).toEqual({ permissionPrompts: "none" });
    expect(pipePermissionArgs("cli", true, config)).toEqual({});
    expect(pipePermissionArgs("cli", false, config)).toEqual({});
    for (const mode of ["none", "app", "cli"]) {
      expect(pipePermissionArgs(mode, true, { ...config, BRAIN_APPROVAL_SETTINGS: "/settings.json" })).toEqual({
        permissionPromptTool: "mcp__brain__approve", disallowedTools: ["AskUserQuestion"],
        approvalHook: { rules: "default", tools: "", settings: "/settings.json" },
      });
    }
  }
});

test("none control handler responds immediately, logs each decision, never contacts the app", async () => {
  let cards = 0;
  const app = Bun.serve({ port: 0, fetch() { cards++; return Response.json({ error: "must not contact app" }, { status: 500 }); } });
  const logs = join(root, "handler-logs");
  const calls = [
    { tool_name: "Write", input: { file_path: join(skills, "new/SKILL.md"), content: "PRIVATE-CONTENT" } },
    { tool_name: "Edit", input: { file_path: join(skills, "existing.md"), old_string: "PRIVATE-OLD", new_string: "PRIVATE-NEW" } },
    { tool_name: "MultiEdit", input: { file_path: join(skills, "existing.md"), edits: [] } },
    { tool_name: "Bash", input: { command: `echo PRIVATE-COMMAND > ${skills}/x` } },
    { tool_name: "Write", input: { file_path: join(cwd, ".claude/settings.json"), content: "PRIVATE-SETTINGS" } },
    { tool_name: "Write", tool_input: { file_path: join(skills, "x") } },
  ];
  const script = `import { handleControlTool } from ${JSON.stringify(join(import.meta.dir, "brain.ts"))};
    const calls = ${JSON.stringify(calls)};
    const results = [];
    for (const call of calls) results.push(JSON.parse((await handleControlTool({}, "approve", call)).text));
    for (const env of [{ BRAIN_OWN_SKILLS_WRITE: "off" }, { BRAIN_CLAUDE_CWD: "relative" }, { BRAIN_CLAUDE_CWD: undefined }]) {
      results.push(JSON.parse((await handleControlTool({ pipeProfile: { env } }, "approve", calls[0])).text));
    }
    console.log("RESULT:" + JSON.stringify(results));`;
  const proc = Bun.spawn([process.execPath, "--eval", script], {
    cwd: root, stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, BRAIN_NO_ENV_FILE: "1",
      BRAIN_HEAD: "claude", BRAIN_CONTROL_TOKEN: "test-token", BRAIN_CLAUDE_CWD: cwd, BRAIN_LOG_DIR: logs,
      BRAIN_STATE_DIR: join(root, "state"), BRAIN_APP_URL: app.url.toString(), BRAIN_APPROVAL: "app" },
  });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 3000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const results = JSON.parse(stdout.split("RESULT:")[1]);
    expect(results.map((r: any) => r.behavior)).toEqual(["allow", "allow", "allow", "deny", "deny", "deny", "deny", "deny", "deny"]);
    expect(results[0].updatedInput).toEqual(calls[0].input);
    for (const result of results.slice(3)) expect(result.message).toBe(OWN_SKILLS_DENIAL);
    expect(cards).toBe(0);
    const raw = readdirSync(logs).map((file) => readFileSync(join(logs, file), "utf8")).join("\n");
    expect(raw).not.toContain("PRIVATE-");
    const events = raw.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const decisions = events.filter((event) => event.type === "approval_decision");
    expect(decisions).toHaveLength(9);
    expect(decisions.map((event) => event.decision)).toEqual(results.map((result: any) => result.behavior));
    expect(decisions.map((event) => event.tool)).toEqual([...calls.map((call) => call.tool_name), "Write", "Write", "Write"]);
    for (const event of decisions) {
      expect(event.wait_ms).toBe(0);
      expect(event.trigger).toBe("own_skills_write");
      expect(event).not.toHaveProperty("input");
      expect(event).not.toHaveProperty("file_path");
    }
  } finally {
    clearTimeout(timer);
    if (proc.exitCode === null) proc.kill("SIGKILL");
    app.stop(true);
  }
}, 5000);
