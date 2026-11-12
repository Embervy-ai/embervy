import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { approvalHookCommand } from "./approval-hook";
import { ClaudePipe, type PipeOptions } from "./claude-pipe";
import { pipePermissionArgs } from "./brain";

const root = mkdtempSync(join(tmpdir(), "brain-approval-hook-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const script = join(import.meta.dir, "approval-hook.ts");
const ask = (label: string) => ({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: label,
} });

async function hook(stdin: string, env: Record<string, string> = {}, command?: string) {
  const proc = Bun.spawn(command ? ["/bin/sh", "-c", command] : [process.execPath, script], {
    cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", BRAIN_APPROVAL_RULES: "default", BRAIN_APPROVAL_TOOLS: "", ...env },
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(code).toBe(0);
  expect(stderr).toBe("");
  return stdout;
}

const cases: Array<[string, unknown, string | null, Record<string, string>?]> = [
  ["compound Bash delete", { tool_name: "Bash", tool_input: { command: "ls && rm -rf build" } }, "deletes"],
  ["ordinary Bash", { tool_name: "Bash", tool_input: { command: "ls -la" } }, null],
  ...["Write", "Edit", "MultiEdit"].flatMap((tool_name): Array<[string, unknown, string]> => [
    [`${tool_name} relative traversal`, { cwd: "/work/project", tool_name, tool_input: { file_path: "../../etc/cron.d/x" } }, "writes system files"],
    [`${tool_name} own settings`, { cwd: "/app", tool_name, tool_input: { file_path: "./approval-settings.json" } }, "writes system files"],
    [`${tool_name} Claude settings`, { cwd: "/app", tool_name, tool_input: { file_path: ".claude/settings.local.json" } }, "writes system files"],
    [`${tool_name} env sibling`, { cwd: "/app", tool_name, tool_input: { file_path: ".env.bak" } }, "writes system files"],
    [`${tool_name} hook source`, { cwd: "/brain", tool_name, tool_input: { file_path: "approval-hook.ts" } }, "writes system files"],
  ]),
  ...["echo key >> /root/.ssh/authorized_keys", "printf key | tee /etc/cron.d/x", "cp source .claude/settings.json",
    "mv source approval-settings.json", "install source approval-hook.ts", "sed -i 's/a/b/' .env.bak", "crontab -e",
    "echo x > ../../etc/hosts"].map((command): [string, unknown, string] => [command, { cwd: "/work/project", tool_name: "Bash", tool_input: { command } }, "writes system files"]),
  ...["r''m -rf x", String.raw`r\m -rf x`, "gi''t push --force", "find . -exec rm {} +", "printf x | xargs rm"].map((command): [string, unknown, string] => [command, { tool_name: "Bash", tool_input: { command } }, "deletes"]),
  ["encoded shell pipeline", { tool_name: "Bash", tool_input: { command: "printf payload | base64 -d | bash" } }, "runs piped shell code"],
  ["tool input cannot replace hook cwd", { cwd: "/etc", tool_name: "Bash", tool_input: { cwd: "/tmp", command: "echo x > hosts" } }, "writes system files"],
  ...["cat /etc/os-release", "ls ~/.ssh", "cat approval-settings.json", "cp /etc/hosts notes.md", "echo x > notes.md", "git commit -m work", "bun test", "rm notes.tmp", "crontab -l"].map((command): [string, unknown, null] => [command, { tool_name: "Bash", tool_input: { command } }, null]),
  ["system Write", { tool_name: "Write", tool_input: { file_path: "/etc/hosts" } }, "writes system files"],
  ["workspace Write", { tool_name: "Write", tool_input: { file_path: "/work/notes.md" } }, null],
  ["system Edit", { tool_name: "Edit", tool_input: { file_path: "/etc/hosts" } }, "writes system files"],
  ["system MultiEdit", { tool_name: "MultiEdit", tool_input: { file_path: "/etc/hosts", edits: [] } }, "writes system files"],
  ["MCP command does not inherit bare rules", { tool_name: "mcp__resident__task_start", tool_input: { command: "rm -rf x" } }, null],
  ["MCP file does not inherit bare rules", { tool_name: "mcp__files__edit_file", tool_input: { path: "/etc/hosts" } }, null],
  ["rules off", { tool_name: "Bash", tool_input: { command: "rm -rf x" } }, null, { BRAIN_APPROVAL_RULES: "off" }],
  ["rules off with explicit tools", { tool_name: "Bash", tool_input: { command: "rm -rf x" } }, null, { BRAIN_APPROVAL_RULES: "off", BRAIN_APPROVAL_TOOLS: "Bash" }],
  ["Claude always-ask name", { tool_name: "Bash", tool_input: { command: "ls -la" } }, "always asks", { BRAIN_APPROVAL_TOOLS: "Bash" }],
  ["mapped always-ask name", { tool_name: "Bash", tool_input: { command: "ls -la" } }, "always asks", { BRAIN_APPROVAL_TOOLS: "task_start" }],
  ["always-ask precedence", { tool_name: "Bash", tool_input: { command: "rm -rf x" } }, "always asks", { BRAIN_APPROVAL_TOOLS: "task_start" }],
  ["empty object", {}, null],
  ["unknown tool", { tool_name: "Unknown", tool_input: { command: "rm -rf x" } }, null],
  ["unknown explicit tool", { tool_name: "Unknown", tool_input: {} }, null, { BRAIN_APPROVAL_TOOLS: "Unknown" }],
  ["missing input", { tool_name: "Bash" }, null, { BRAIN_APPROVAL_TOOLS: "Bash" }],
  ["null input", { tool_name: "Bash", tool_input: null }, null],
  ["array input", { tool_name: "Bash", tool_input: [] }, null],
  ["non-string command", { tool_name: "Bash", tool_input: { command: 42 } }, null],
  ["null call", null, null],
];

describe("approval hook subprocess", () => {
  test("Bash applies scratch configuration without weakening other rules", async () => {
    const env = { BRAIN_APPROVAL_SCRATCH: "/scratch:/other-scratch" };
    const call = (command: string) => JSON.stringify({ cwd: "/work", tool_name: "Bash", tool_input: { command } });
    expect(JSON.parse(await hook(call("rm -rf /scratch/x/run1")))).toEqual(ask("deletes"));
    for (const command of ["rm -rf /scratch/x/run1", 'echo ready; rm -rf "/scratch/x/run 1"; pwd',
      "rm -rf /scratch/x/run* && rm -rf /other-scratch/x/run2"]) {
      expect(await hook(call(command), env)).toBe("");
    }
    for (const command of ["rm -rf /scratch/$run/run1", "rm -rf /scratch", "rm -rf /scratch/x/run1 /outside",
      "cd /scratch && rm -rf /scratch/x/run1", "find /scratch -delete", "rm -rf /scratch/x/run1; git reset --hard"]) {
      expect(JSON.parse(await hook(call(command), env))).toEqual(ask("deletes"));
    }
    expect(JSON.parse(await hook(call("rm -rf /scratch/x/run1; git push origin main"), env))).toEqual(ask("publishes"));
    expect(JSON.parse(await hook(call("rm -rf /scratch/x/.env"), env))).toEqual(ask("writes system files"));
    const settings = join(root, "scratch-settings.json");
    writeFileSync(settings, '{"level":"important","extra":[]}');
    expect(await hook(call("rm -rf /scratch/x/run1"), { ...env, BRAIN_APPROVAL_SETTINGS: settings })).toBe("");
    expect(JSON.parse(await hook(call("rm -rf /scratch/x/run1"), { ...env, BRAIN_APPROVAL_TOOLS: "task_start" }))).toEqual(ask("always asks"));
  });
  test("generated commands pin scratch configuration despite a different child environment", async () => {
    const call = JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /scratch/x/run1" } });
    const options = { rules: "default", tools: "", scratch: "/scratch:/other scratch" };
    expect(await hook(call, { BRAIN_APPROVAL_SCRATCH: "/outside" }, approvalHookCommand(options))).toBe("");
    expect(JSON.parse(await hook(call, { BRAIN_APPROVAL_SCRATCH: "/scratch" }, approvalHookCommand({ rules: "default", tools: "" })))).toEqual(ask("deletes"));
    const quoted = approvalHookCommand({ ...options, scratch: "/scratch'; echo injected; '" });
    expect(JSON.parse(await hook(call, {}, quoted))).toEqual(ask("deletes"));
    for (const settings of [undefined, join(root, "pinned-scratch-settings.json")]) {
      if (settings) writeFileSync(settings, '{"level":"important","extra":[]}');
      const permission = pipePermissionArgs("app", true, { BRAIN_APPROVAL: "app", BRAIN_APPROVAL_SCRATCH: "/scratch",
        ...(settings ? { BRAIN_APPROVAL_SETTINGS: settings } : {}) });
      expect(permission.approvalHook?.scratch).toBe("/scratch");
      expect(await hook(call, { BRAIN_APPROVAL_SCRATCH: "/outside" }, approvalHookCommand(permission.approvalHook!))).toBe("");
    }
  });
  for (const [name, call, label, env] of cases) test(name, async () => {
    const stdout = await hook(JSON.stringify(call), env);
    if (label) expect(JSON.parse(stdout)).toEqual(ask(label));
    else expect(stdout).toBe("");
  });
  for (const stdin of ["", "{broken", "not JSON\n"]) test(`malformed stdin ${JSON.stringify(stdin)}`, async () => {
    expect(await hook(stdin)).toBe("");
  });
  test("app settings apply to the very next hook call and invalid settings ask important actions", async () => {
    const settings = join(root, "live-settings.json");
    const env = { BRAIN_APPROVAL_SETTINGS: settings, BRAIN_APPROVAL_RULES: "off" };
    const call = (tool_name: string, tool_input = {}) => hook(JSON.stringify({ tool_name, tool_input }), env);
    writeFileSync(settings, '{"level":"all","extra":[]}');
    expect(JSON.parse(await call("Write", { file_path: "/work/notes" }))).toEqual(ask("changes or sends"));
    expect(await call("Read", { file_path: "/work/notes" })).toBe("");
    expect(await call("mcp__brain__approve")).toBe("");
    writeFileSync(settings, '{"level":"none","extra":[]}');
    expect(await call("Bash", { command: "rm -rf build" })).toBe("");
    writeFileSync(settings, '{"level":"important","extra":[{"label":"sends custom mail","tool":"mcp__house__mailbox","field":"action","pattern":"^send$"}]}');
    expect(JSON.parse(await call("mcp__house__mailbox", { action: "send" }))).toEqual(ask("sends custom mail"));
    writeFileSync(settings, "broken");
    expect(JSON.parse(await call("Bash", { command: "rm -rf build" }))).toEqual(ask("deletes"));
  });
  test("arbitrary configured settings paths are protected through writes and Bash", async () => {
    const settings = join(root, "preferences[1].json");
    writeFileSync(settings, '{"level":"important","extra":[]}');
    const env = { BRAIN_APPROVAL_SETTINGS: settings };
    for (const tool_name of ["Write", "Edit", "MultiEdit"]) {
      expect(JSON.parse(await hook(JSON.stringify({ cwd: root, tool_name, tool_input: { file_path: "preferences[1].json" } }), env))).toEqual(ask("writes system files"));
    }
    expect(JSON.parse(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: `echo '{}' > '${settings}'` } }), env))).toEqual(ask("writes system files"));
    expect(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: `cat '${settings}'` } }), env)).toBe("");
  });
  test("custom task_start rules cover Bash without default substitution", async () => {
    const rules = join(root, "task.rules");
    writeFileSync(rules, '["task_start","command","^echo hello$","checks a custom agreement"]\n');
    const env = { BRAIN_APPROVAL_RULES: rules };
    expect(JSON.parse(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hello" } }), env))).toEqual(ask("checks a custom agreement"));
    expect(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }), env)).toBe("");
  });
  test("a custom rule file cannot be replaced without a card", async () => {
    const rules = join(root, "self[1].rules");
    writeFileSync(rules, "# empty action rules\n");
    const env = { BRAIN_APPROVAL_RULES: rules };
    expect(JSON.parse(await hook(JSON.stringify({ cwd: root, tool_name: "Edit", tool_input: { file_path: "./self[1].rules" } }), env))).toEqual(ask("writes system files"));
    expect(JSON.parse(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: `echo '{}' > '${rules}'` } }), env))).toEqual(ask("writes system files"));
    expect(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: `cat '${rules}'` } }), env)).toBe("");
    expect(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }), env)).toBe("");
  });
  test("custom edit_file rules cover all Claude file tools", async () => {
    const rules = join(root, "file.rules");
    writeFileSync(rules, '["edit_file","path","^/work/private$","checks a private file"]\n');
    for (const tool_name of ["Write", "Edit", "MultiEdit"]) {
      expect(JSON.parse(await hook(JSON.stringify({ tool_name, tool_input: { file_path: "/work/private" } }), { BRAIN_APPROVAL_RULES: rules }))).toEqual(ask("checks a private file"));
    }
  });
  test("MCP names and fields pass through custom rules", async () => {
    const rules = join(root, "mcp.rules");
    writeFileSync(rules, '["mcp__house__mailbox","action","^send$","sends custom mail"]\n');
    expect(JSON.parse(await hook(JSON.stringify({ tool_name: "mcp__house__mailbox", tool_input: { action: "send" } }), { BRAIN_APPROVAL_RULES: rules }))).toEqual(ask("sends custom mail"));
  });
  test("unreadable and malformed rules produce no output", async () => {
    const broken = join(root, "broken.rules");
    writeFileSync(broken, 'broken\n["bash","command","[","private"]\n');
    for (const rules of [broken, join(root, "missing.rules")]) {
      expect(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf x" } }), { BRAIN_APPROVAL_RULES: rules })).toBe("");
    }
  });
  test("the exact shell command pins env and quotes rule paths and tool lists", async () => {
    const rules = join(root, "house ' rules; $not_expanded");
    writeFileSync(rules, '["bash","command","^echo hello$","custom reason"]\n');
    const command = approvalHookCommand({ rules, tools: "Bash,odd' tool;$value" });
    expect(JSON.parse(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } }), {
      BRAIN_APPROVAL_RULES: "off", PATH: "/nonexistent",
    }, command))).toEqual(ask("always asks"));
    expect(JSON.parse(await hook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "echo hello" } }), {}, approvalHookCommand({ rules, tools: "" })))).toEqual(ask("custom reason"));
  });
});

function pipe(options: Partial<PipeOptions> = {}) {
  return new ClaudePipe({ model: "fixture", systemPrompt: "fixture", settingsPath: "{}", settingSources: "", cwd: root, ...options });
}

describe("approval hook settings", () => {
  const options = { rules: "default", tools: "Bash" };
  const entry = { matcher: "Bash|Write|Edit|MultiEdit|mcp__.*", hooks: [{ type: "command", command: approvalHookCommand(options) }] };
  const base = { permissions: { allow: ["Bash", "Write", "Edit"] }, env: { HOUSE_KEY: "kept" }, alwaysThinkingEnabled: true,
    hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }], PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "true" }] }] } };
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify(base));
  for (const settingsPath of [path, JSON.stringify(base)]) {
    test(`off preserves settings argument bytes: ${settingsPath === path ? "path" : "JSON"}`, () => {
      expect(pipe({ settingsPath }).settingsArgForThisPipe()).toBe(settingsPath);
    });
    test(`off preserves cache-ping JSON: ${settingsPath === path ? "path" : "JSON"}`, () => {
      expect(pipe({ settingsPath, maxOutputTokens: 100 }).settingsArgForThisPipe()).toBe(JSON.stringify({ ...base, alwaysThinkingEnabled: false }));
    });
    for (const maxOutputTokens of [undefined, 100]) test(`on merges all base keys and hooks: ${settingsPath === path ? "path" : "JSON"}, cap ${maxOutputTokens}`, () => {
      expect(JSON.parse(pipe({ settingsPath, maxOutputTokens, approvalHook: options }).settingsArgForThisPipe())).toEqual({
        ...base, alwaysThinkingEnabled: maxOutputTokens === undefined,
        hooks: { ...base.hooks, PreToolUse: [...base.hooks.PreToolUse, entry] },
      });
    });
  }
  test("on builds hooks without a base hooks key", () => {
    expect(JSON.parse(pipe({ approvalHook: options }).settingsArgForThisPipe())).toEqual({ hooks: { PreToolUse: [entry] } });
  });
  test("app approval hook reaches --settings and the prompt-tool argv", async () => {
    const bin = join(root, "fake-claude");
    const argvFile = join(root, "argv.json");
    writeFileSync(bin, `#!${process.execPath}\nconst { writeFileSync } = require("node:fs");
writeFileSync(process.env.FAKE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
const out = o => process.stdout.write(JSON.stringify(o) + "\\n");
let b = "";
process.stdin.on("data", c => { b += c; if (!b.includes("\\n")) return; b = "";
out({type:"system",subtype:"init",session_id:"approval-fixture",model:"fixture"});
out({type:"assistant",message:{id:"m1",model:"fixture",content:[{type:"text",text:"ok"}]}});
out({type:"result",subtype:"success",is_error:false,result:"ok",usage:{input_tokens:1,output_tokens:1}});
});\n`);
    chmodSync(bin, 0o755);
    const saved = process.env.BRAIN_CLAUDE_BIN;
    process.env.BRAIN_CLAUDE_BIN = bin;
    const permission = pipePermissionArgs("app", true, { BRAIN_APPROVAL: "app" });
    const instance = pipe({ settingsPath: JSON.stringify(base), ...permission, env: { FAKE_ARGV_FILE: argvFile } });
    try {
      const expected = instance.settingsArgForThisPipe();
      await instance.start();
      expect((await instance.send("say ok")).finalContent).toBe("ok");
      const argv: string[] = JSON.parse(readFileSync(argvFile, "utf8"));
      expect(argv[argv.indexOf("--settings") + 1]).toBe(expected);
      const settings = JSON.parse(expected);
      expect(settings.permissions).toEqual(base.permissions);
      expect(settings.hooks.PreToolUse).toHaveLength(2);
      expect(settings.hooks.PreToolUse[1].hooks[0].command).toBe(approvalHookCommand({ rules: "default", tools: "" }));
      expect(argv[argv.indexOf("--permission-prompt-tool") + 1]).toBe("mcp__brain__approve");
      expect(argv).not.toContain("--permission-prompts");
    } finally {
      await instance.stop(1000);
      if (saved === undefined) delete process.env.BRAIN_CLAUDE_BIN;
      else process.env.BRAIN_CLAUDE_BIN = saved;
    }
  });
});

describe("pipePermissionArgs approval hook gate", () => {
  for (const mode of ["app", "cli", "none"]) {
    for (const token of [false, true]) {
      for (const approval of ["app", "off"]) {
        for (const rules of ["default", "off", "house.rules"]) test(`${mode}, token ${token}, approval ${approval}, rules ${rules}`, () => {
          const args = pipePermissionArgs(mode, token, { BRAIN_APPROVAL: approval, BRAIN_APPROVAL_RULES: rules, BRAIN_APPROVAL_TOOLS: "Bash" });
          if (mode === "app" && token && approval === "app" && rules !== "off") {
            expect(args).toEqual({ permissionPromptTool: "mcp__brain__approve", disallowedTools: ["AskUserQuestion"],
              approvalHook: { rules: rules === "default" ? rules : resolve(rules), tools: "Bash" } });
          } else {
            expect(args).toEqual(mode === "app" && token ? { permissionPromptTool: "mcp__brain__approve", disallowedTools: ["AskUserQuestion"] }
              : mode === "cli" ? {} : { permissionPrompts: "none" });
          }
        });
      }
    }
  }
  test("default rules and empty tools pass explicitly; ensurePipe passes the option", async () => {
    expect(pipePermissionArgs("app", true, { BRAIN_APPROVAL: "app" }).approvalHook).toEqual({ rules: "default", tools: "" });
    expect(pipePermissionArgs("app", true, {}).approvalHook).toBeUndefined();
    expect(await Bun.file(join(import.meta.dir, "brain.ts")).text()).toContain("approvalHook: permission.approvalHook");
  });
});
