import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterAll(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })));

function defaults(root: string, app?: string, override?: string, obsolete?: string) {
  const home = mkdtempSync(join(tmpdir(), "doctor-app-env-"));
  homes.push(home);
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "Claude/app"), { recursive: true });
  writeFileSync(join(home, ".env"), `RAG_AUTH_TOKEN=archive-test-token\n${root}`);
  if (app !== undefined) writeFileSync(join(home, "Claude/app/.env"), app);
  if (override !== undefined) writeFileSync(join(home, "custom.env"), override);
  if (obsolete !== undefined) {
    mkdirSync(join(home, "app"));
    writeFileSync(join(home, "app/.env"), obsolete);
  }
  writeFileSync(join(home, "bin/systemctl"), '#!/bin/sh\nprintf "LoadState=loaded\\nActiveState=active\\n"\n', { mode: 0o755 });
  const runner = join(home, "runner.ts");
  writeFileSync(runner, `globalThis.fetch = async () => Response.json({ok:true});\nawait import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});\n`);
  const child = Bun.spawnSync([process.execPath, runner, "--offline", "--json"], {
    cwd: home,
    env: { HOME: home, EMBERVY_HOME: home, PATH: join(home, "bin"),
      EMBERVY_HARNESS: "brain", EMBERVY_SUBSTRATE: "brain",
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs"),
      ...(override !== undefined ? { APP_ENV_FILE: join(home, "custom.env") } : {}) },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.stderr.toString()).toBe("");
  const report = JSON.parse(child.stdout.toString());
  const check = report.checks.find((c: any) => c.id === "health.defaults");
  expect(check).toBeDefined();
  return { check, home };
}

const valid = `APP_PASSWORD=nontrivial-test-password\nAPP_SESSION_SECRET=${"s".repeat(48)}\n`;
const blank = "APP_PASSWORD=\nAPP_SESSION_SECRET=\n";

test("app-local secrets override empty root template assignments", () => {
  expect(defaults(blank, valid).check.status).toBe("OK");
});

test("an explicitly empty app password fails despite valid root secrets", () => {
  const { check, home } = defaults(valid, blank);
  expect(check.status).toBe("FAIL");
  expect(check.detail).toContain("APP_PASSWORD is empty");
  expect(check.fix).toContain(`${home}/Claude/app/.env`);
});

test("APP_ENV_FILE overrides the default app file", () => {
  expect(defaults(blank, blank, valid).check.status).toBe("OK");
  const { check, home } = defaults(valid, valid, blank);
  expect(check.status).toBe("FAIL");
  expect(check.fix).toContain(`${home}/custom.env`);
});

test("the obsolete app env path cannot configure the product app", () => {
  expect(defaults(blank, undefined, undefined, valid).check.status).toBe("FAIL");
});

test("without an app env file root-only configuration still works", () => {
  expect(defaults(valid).check.status).toBe("OK");
});

test("Claude doctor probes use house settings and never accept a user-level inlet", () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-house-settings-"));
  homes.push(home);
  for (const dir of ["bin", "state", ".claude"]) mkdirSync(join(home, dir));
  writeFileSync(join(home, ".env"), `RAG_AUTH_TOKEN=archive-test-token\n${valid}`);
  writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: {
    app: { command: "/bin/true" }, lore: { type: "http", url: "https://memory.invalid/mcp" },
  } }));
  writeFileSync(join(home, "state/claude-settings.json"), "{}");
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "foreign-inlet.sh" }] }],
  } }));
  const runner = join(home, "runner.ts");
  writeFileSync(runner, `globalThis.fetch = async () => Response.json({ok:true});\nawait import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});\n`);
  writeFileSync(join(home, "bin/claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${home}/args'\nprintf '%s' "$ENABLE_CLAUDEAI_MCP_SERVERS" > '${home}/connectors'\nprintf 'app: connected\\nlore: connected\\n'\n`, { mode: 0o755 });
  const project = join(home, "project");
  mkdirSync(project);
  writeFileSync(join(project, ".mcp.json"), readFileSync(join(home, ".mcp.json")));
  mkdirSync(join(project, "state"));
  writeFileSync(join(project, "state/claude-settings.json"), "{}");
  writeFileSync(join(project, ".env"), `RAG_AUTH_TOKEN=archive-test-token\n${valid}`);
  const child = Bun.spawnSync([process.execPath, runner, "--json"], {
    cwd: project, stdout: "pipe", stderr: "pipe",
    env: { HOME: home, EMBERVY_HOME: project, PATH: join(home, "bin"), EMBERVY_SUBSTRATE: "brain",
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
  });
  expect(child.stderr.toString()).toBe("");
  const report = JSON.parse(child.stdout.toString());
  expect(report.checks.find((c: any) => c.id === "mcp").status).toBe("OK");
  expect(report.checks.find((c: any) => c.id === "adapter.hook").status).toBe("WARN");
  expect(readFileSync(join(home, "args"), "utf8").trim().split("\n")).toEqual([
    "--setting-sources", "project,local", "--settings", join(project, "state/claude-settings.json"), "mcp", "list",
  ]);
  expect(readFileSync(join(home, "connectors"), "utf8")).toBe("false");
});

test("a user-level inlet counts when it runs this house's script, as the guided installer writes it", () => {
  const home = mkdtempSync(join(tmpdir(), "doctor-user-inlet-"));
  homes.push(home);
  for (const dir of ["bin", ".claude", "project/state"]) mkdirSync(join(home, dir), { recursive: true });
  const project = join(home, "project");
  writeFileSync(join(project, ".env"), `RAG_AUTH_TOKEN=archive-test-token\n${valid}`);
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { app: { command: "/bin/true" } } }));
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ hooks: {
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `${project}/Claude/scripts/inlet.sh` }] }],
  } }));
  writeFileSync(join(home, "bin/claude"), "#!/bin/sh\nprintf 'app: connected\\n'\n", { mode: 0o755 });
  const runner = join(home, "runner.ts");
  writeFileSync(runner, `globalThis.fetch = async () => Response.json({ok:true});\nawait import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});\n`);
  const child = Bun.spawnSync([process.execPath, runner, "--json"], {
    cwd: project, stdout: "pipe", stderr: "pipe",
    env: { HOME: home, EMBERVY_HOME: project, PATH: join(home, "bin"), EMBERVY_SUBSTRATE: "brain",
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
  });
  const hook = JSON.parse(child.stdout.toString()).checks.find((c: any) => c.id === "adapter.hook");
  expect(hook.status).toBe("OK");
  expect(hook.detail).toContain(join(home, ".claude/settings.json"));
});

// The manual stays in the repository; the installer package leaves it out.
const manualPath = join(import.meta.dir, "../../INSTALL.md");
const manual = existsSync(manualPath) ? readFileSync(manualPath, "utf8") : "";
const allow = [
  "Bash(*)", "Read", "Write", "Edit", "Glob", "Grep",
  "Agent(*)", "WebFetch(*)", "WebSearch(*)", "ToolSearch(*)",
  "TaskCreate(*)", "TaskUpdate(*)", "TaskList(*)", "TaskGet(*)",
  "NotebookEdit", "Monitor(*)", "mcp__app", "mcp__app__*",
  "mcp__lore", "mcp__lore__*", "mcp__brain__status", "mcp__brain__effort",
  "mcp__brain__pins", "mcp__brain__pin", "mcp__brain__unpin",
];

for (const file of ["Brain/pipe-settings.json", "state/claude-settings.json"]) {
  test.skipIf(!manual)(`${file} receives the full installer-equivalent allow list`, () => {
    const marker = `cat > "$EMBERVY_HOME/${file}" <<'EOF'\n`;
    const start = manual.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = manual.slice(start + marker.length).split("\nEOF")[0];
    expect(JSON.parse(body).permissions.allow).toEqual(allow);
    expect(manual).toContain(`chmod 600 "$EMBERVY_HOME/${file}"`);
  });
}

test.skipIf(!manual)("the documented unit uses the shipped argument-forwarding wrapper", () => {
  const wrapper = readFileSync(join(import.meta.dir, "../../Claude/scripts/loop-wrapper.sh"), "utf8");
  expect(wrapper).toContain(`printf -v LOOP_COMMAND '%q ' bash "$LOOP_SCRIPT" "$@"`);
  expect(wrapper).toContain('"$LOOP_COMMAND" || exit 1');
  expect(manual).toContain("ExecStart=/bin/bash /opt/embervy/Claude/scripts/loop-wrapper.sh --settings /opt/embervy/state/claude-settings.json --setting-sources project,local");
  expect(manual).not.toContain("state/claude-loop-wrapper.sh");
});

test.skipIf(!manual)("the Brain profile selects explicit settings without user-level hooks", () => {
  expect(manual).toContain("BRAIN_CLAUDE_SETTINGS=/opt/embervy/Brain/pipe-settings.json");
  expect(manual).toContain("BRAIN_CLAUDE_SETTING_SOURCES=project,local");
  expect(manual).not.toContain("BRAIN_CLAUDE_SETTING_SOURCES=user,project,local");
  expect(manual).toContain("BRAIN_PIPE_PERMISSION=app");
  expect(manual).toContain("BRAIN_APPROVAL=app");
  expect(manual).not.toContain("BRAIN_PIPE_PERMISSION=none");
});

test("manual Bash blocks parse without running installation commands", () => {
  for (const block of manual.matchAll(/^```bash\n([\s\S]*?)^```/gm)) {
    const child = Bun.spawnSync(["/bin/bash", "--noprofile", "--norc", "-n"], {
      stdin: Buffer.from(block[1]), stdout: "pipe", stderr: "pipe",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
    });
    expect(child.stderr.toString()).toBe("");
    expect(child.exitCode).toBe(0);
  }
});

test.skipIf(!manual)("the final sweep checks house files and explicitly owned units only", () => {
  expect(manual).not.toContain("(pathlib.Path.home() / '.claude').glob");
  expect(manual).not.toContain("glob('embervy-*.service')");
  expect(manual).toContain("for unit in os.environ['HOUSE_UNITS'].split()");
  expect(manual).toContain("env -i HOME=");
  expect(manual).toContain("/bin/bash --noprofile --norc");
  expect(manual).not.toContain('echo "export EMBERVY_HOME=');
});
