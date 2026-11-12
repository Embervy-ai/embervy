import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";


const dir = mkdtempSync(join(tmpdir(), "enrich-header-"));
for (const failure of ["cp", "write", "mv"]) test(`failed ${failure} preserves the original and never reports success`, () => {
  const root = mkdtempSync(join(dir, "failure-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const file = join(root, "input.md");
  const original = "# [Input]\n\nSESSION=1\nTHEMES=old\nSUMMARY=old\nEMOTIONAL_ARC=old\nKEY_MOMENTS=old\nDYNAMIC=old\n\nOriginal body\n";
  writeFileSync(file, original);
  writeFileSync(join(bin, "claude"), `#!/bin/bash\nif [ "\${1:-}" = --help ]; then echo '--agents <json>  JSON object defining custom agents'; exit 0; fi\ncat >/dev/null\nprintf '%s\\n' '{"type":"result","result":"# [Input]\\nTHEMES=new"}'\n`, { mode: 0o755 });
  if (failure === "write") symlinkSync("/dev/full", file + ".new");
  else writeFileSync(join(bin, failure), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  const run = Bun.spawnSync(["bash", join(import.meta.dir, "enrich-header.sh"), file], {
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root }, stdout: "pipe", stderr: "pipe",
  });
  expect(run.exitCode).not.toBe(0);
  expect(run.stdout.toString()).not.toContain("Header enriched");
  expect(readFileSync(file, "utf8")).toBe(original);
  if (failure !== "cp") expect(readFileSync(file + ".bak", "utf8")).toBe(original);
  else expect(existsSync(file + ".bak")).toBe(false);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const installedCli = Bun.which("claude", { PATH: `${process.env.PATH}:${process.env.HOME}/.local/bin` });
(installedCli ? test : test.skip)("installed CLI help supports inline agent definitions", () => {
  const root = mkdtempSync(join(dir, "cli-help-"));
  const cli = installedCli;
  const help = Bun.spawnSync([cli!, "--help"], {
    cwd: root, env: { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: join(root, "config"), DISABLE_AUTOUPDATER: "1" },
    stdout: "pipe", stderr: "pipe", timeout: 15000,
  });
  expect(help.exitCode).toBe(0);
  expect(help.stdout.toString()).toContain("--agents");
  expect(help.stdout.toString()).toContain("--agent");
  expect(help.stdout.toString()).toContain("--setting-sources");
  expect(help.stdout.toString()).toContain("--no-session-persistence");
});

test("uses only the house agent, cwd, settings sources and subscription environment", () => {
  const root = mkdtempSync(join(dir, "local-"));
  const home = join(root, "house");
  const userHome = join(root, "user");
  mkdirSync(join(home, "shared/subagents"), { recursive: true });
  mkdirSync(join(root, "bin"));
  mkdirSync(join(userHome, ".claude/agents"), { recursive: true });
  const foreign = join(userHome, ".claude/agents/auto-rag-header.md");
  writeFileSync(foreign, "NEIGHBOUR AGENT: must not be used");
  writeFileSync(join(home, "shared/subagents/auto-rag-header.md"), '---\nmodel: haiku\nname: auto-rag-header\ndescription: House header\n---\nHouse prompt with "quotes".\n');
  const file = join(home, "archive.md");
  const original = "# [House]\n\nSESSION=1\nTHEMES=placeholder\nSUMMARY=placeholder\nEMOTIONAL_ARC=placeholder\nKEY_MOMENTS=placeholder\nDYNAMIC=placeholder\n\nBody\n";
  writeFileSync(file, original);
  writeFileSync(join(root, "bin/claude"), `#!/usr/bin/env python3
import json, os, pathlib, sys
if sys.argv[1:] == ['--help']:
    print('--agents <json>  JSON object defining custom agents (e.g. {"reviewer": {"description": "Reviews code", "prompt": "You are a code reviewer"}})')
    sys.exit(0)
sys.stdin.read()
pathlib.Path('invocation.json').write_text(json.dumps({'args':sys.argv[1:], 'cwd':os.getcwd(), 'env':dict(os.environ)}))
print(json.dumps({'type':'result', 'result':'# [House]\\nTHEMES=local'}))
`, { mode: 0o755 });
  const result = Bun.spawnSync(["bash", join(import.meta.dir, "enrich-header.sh"), "archive.md"], {
    cwd: home, env: { PATH: `${root}/bin:${process.env.PATH}`, HOME: userHome, EMBERVY_HOME: home,
      ENABLE_CLAUDEAI_MCP_SERVERS: "true", ANTHROPIC_API_KEY: "must-drop", ANTHROPIC_AUTH_TOKEN: "must-drop-too" },
    stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(0);
  const invocation = JSON.parse(readFileSync(join(home, "invocation.json"), "utf8"));
  const agents = JSON.stringify({ "auto-rag-header": { description: "House header", model: "haiku", prompt: 'House prompt with "quotes".', tools: [] } });
  expect(invocation.args).toEqual(["-p", "--setting-sources", "project,local", "--no-session-persistence", "--agents", expect.any(String), "--agent", "auto-rag-header",
    "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--output-format", "stream-json", "--include-partial-messages", "--verbose"]);
  expect(JSON.parse(invocation.args[5])).toEqual(JSON.parse(agents));
  expect(invocation.cwd).toBe(resolve(home));
  expect(invocation.env.EMBERVY_HOME).toBe(home);
  expect(invocation.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe("false");
  expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(invocation.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  expect(readdirSync(join(userHome, ".claude/agents"))).toEqual(["auto-rag-header.md"]);
  expect(readFileSync(foreign, "utf8")).toBe("NEIGHBOUR AGENT: must not be used");
  expect(readFileSync(file + ".bak", "utf8")).toBe(original);
});

for (const failure of ["missing-agent", "claude-fails", "empty-output", "unsupported-cli"]) test(`enrichment ${failure} keeps placeholders and explains why`, () => {
  const root = mkdtempSync(join(dir, "fallback-"));
  mkdirSync(join(root, "bin"));
  if (failure !== "missing-agent") {
    mkdirSync(join(root, "shared/subagents"), { recursive: true });
    writeFileSync(join(root, "shared/subagents/auto-rag-header.md"), "---\nmodel: haiku\ndescription: Test\n---\nPrompt\n");
  }
  writeFileSync(join(root, "bin/claude"), `#!/bin/bash\nif [ "\${1:-}" = --help ]; then echo '${failure === "unsupported-cli" ? "--agent <name>" : "--agents <json>  JSON object defining custom agents"}'; exit 0; fi\ncat >/dev/null\nexit ${failure === "claude-fails" ? 7 : 0}\n`, { mode: 0o755 });
  const original = "# [House]\n\nSESSION=1\nTHEMES=placeholder\nSUMMARY=placeholder\nEMOTIONAL_ARC=placeholder\nKEY_MOMENTS=placeholder\nDYNAMIC=placeholder\n\nBody\n";
  const file = join(root, "archive.md");
  writeFileSync(file, original);
  const result = Bun.spawnSync(["bash", join(import.meta.dir, "enrich-header.sh"), file], {
    env: { PATH: `${root}/bin:${process.env.PATH}`, HOME: root, EMBERVY_HOME: root }, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode).toBe(2);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(result.stderr.toString()).toContain("keeping original");
  expect(existsSync(join(root, ".claude/agents"))).toBe(false);
});

test("only the five fields come from the subagent; first line and SESSION line stay", () => {
  mkdirSync(join(dir, "bin"));
  const answer = "# [Session 3] [DATE: 2026-10-09]\\n\\nSESSION=3 | TYPE=CHAT | DATE=2026-10-09\\nTHEMES=Morning, Updates\\n\\nSUMMARY=A morning of updates.\\nEMOTIONAL_ARC=calm → glad\\nKEY_MOMENTS=update | respawn\\nDYNAMIC=warm and steady.\\nTHEMES=a second, ignored";
  writeFileSync(join(dir, "bin", "claude"), `#!/bin/bash\nif [ "\${1:-}" = --help ]; then echo '--agents <json>  JSON object defining custom agents'; exit 0; fi\ncat > /dev/null\nprintf '%s\\n' '{"type":"result","result":"${answer}"}'\n`);
  chmodSync(join(dir, "bin", "claude"), 0o755);
  const file = join(dir, "Session_3.md");
  writeFileSync(file, [
    "# [Session_3] [DATE: 2026-10-09]", "", "SESSION=Session_3 | TYPE=BRAIN | DATE=2026-10-09",
    "THEMES=placeholder", "SUMMARY=placeholder.", "EMOTIONAL_ARC=placeholder", "KEY_MOMENTS=placeholder", "DYNAMIC=placeholder.",
    "", "---", "", "**User**", "", "Good morning", "",
  ].join("\n"));
  const run = Bun.spawnSync(["bash", join(import.meta.dir, "enrich-header.sh"), file], {
    env: { PATH: `${join(dir, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: dir },
    stdout: "pipe", stderr: "pipe",
  });
  expect(run.exitCode).toBe(0);
  const lines = readFileSync(file, "utf8").split("\n");
  expect(lines.slice(0, 8)).toEqual([
    "# [Session_3] [DATE: 2026-10-09]", "", "SESSION=Session_3 | TYPE=BRAIN | DATE=2026-10-09",
    "THEMES=Morning, Updates", "SUMMARY=A morning of updates.", "EMOTIONAL_ARC=calm → glad", "KEY_MOMENTS=update | respawn", "DYNAMIC=warm and steady.",
  ]);
  expect(lines.join("\n")).toContain("**User**\n\nGood morning");
});
