import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const loopPath = join(import.meta.dir, "start-claude-loop.sh");
const loop = readFileSync(loopPath, "utf8");

function shellFunction(name: string): string {
  const body = loop.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"))?.[0];
  if (!body) throw new Error(`${name} function not found`);
  return body;
}
const helpers = ["restart_notice_effort", "restart_notice_mcps"].map(shellFunction).join("\n");

function isolated(run: (home: string, house: string, shell: (body: string, extra?: Record<string, string>) => string) => void) {
  const root = mkdtempSync(join(tmpdir(), "restart-notice-"));
  try {
    const home = join(root, "user home");
    const house = join(root, "house root");
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(join(house, ".claude"), { recursive: true });
    const shell = (body: string, extra: Record<string, string> = {}) => {
      const result = Bun.spawnSync(["bash", "-c", `set -eu\n${helpers}\n${body}`], {
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, EMBERVY_HOME: house, ...extra },
        stdout: "pipe", stderr: "pipe",
      });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      return result.stdout.toString();
    };
    run(home, house, shell);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("effort reads high from the user settings, not the project settings", () => {
  isolated((home, house, shell) => {
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ effortLevel: "high" }));
    writeFileSync(join(house, ".claude/settings.json"), JSON.stringify({ effortLevel: "low" }));
    expect(shell("restart_notice_effort")).toBe("high\n");
  });
});

test("effort is default when the setting is absent", () => {
  isolated((home, _house, shell) => {
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ permissions: {} }));
    expect(shell("restart_notice_effort")).toBe("default\n");
  });
});

for (const state of ["missing", "invalid"] as const) {
  test(`${state} user settings return unknown and the shell continues without a project fallback`, () => {
    isolated((home, house, shell) => {
      if (state === "invalid") writeFileSync(join(home, ".claude/settings.json"), "{invalid");
      writeFileSync(join(house, ".claude/settings.json"), JSON.stringify({ effortLevel: "high" }));
      expect(shell('value=$(restart_notice_effort)\nprintf "%s\\ncontinued\\n" "$value"')).toBe("?\ncontinued\n");
    });
  });
}

test("MCP names come from the house configuration in sorted order", () => {
  isolated((home, house, shell) => {
    writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: { unrelated: {} } }));
    const config = join(house, ".mcp.json");
    writeFileSync(config, JSON.stringify({ mcpServers: { lore: { url: "https://example.invalid" }, app: { command: "bun" } } }));
    expect(shell("restart_notice_mcps")).toBe("app,lore\n");
    writeFileSync(config, JSON.stringify({ mcpServers: { app: {}, lore: {} } }));
    expect(shell("restart_notice_mcps")).toBe("app,lore\n");
  });
});

for (const state of ["valid", "missing", "invalid"] as const) {
  test(`an explicit MCP override wins with ${state} configuration`, () => {
    isolated((_home, house, shell) => {
      if (state === "valid") writeFileSync(join(house, ".mcp.json"), JSON.stringify({ mcpServers: { app: {}, lore: {} } }));
      if (state === "invalid") writeFileSync(join(house, ".mcp.json"), "{invalid");
      expect(shell("restart_notice_mcps", { EMBERVY_MCP_LIST: "custom-z,custom-a" })).toBe("custom-z,custom-a\n");
    });
  });
}

test("an explicitly empty MCP override stays empty", () => {
  isolated((_home, house, shell) => {
    writeFileSync(join(house, ".mcp.json"), JSON.stringify({ mcpServers: { app: {} } }));
    expect(shell("restart_notice_mcps", { EMBERVY_MCP_LIST: "" })).toBe("\n");
  });
});

for (const state of ["missing", "invalid"] as const) {
  test(`${state} MCP configuration returns unknown and the shell continues`, () => {
    isolated((home, house, shell) => {
      writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: { unrelated: {} } }));
      if (state === "invalid") writeFileSync(join(house, ".mcp.json"), "{invalid");
      expect(shell('value=$(restart_notice_mcps)\nprintf "%s\\ncontinued\\n" "$value"')).toBe("?\ncontinued\n");
    });
  });
}

test("an empty MCP server map produces an empty list", () => {
  isolated((_home, house, shell) => {
    writeFileSync(join(house, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    expect(shell("restart_notice_mcps")).toBe("\n");
  });
});

test("the restart notification uses the helpers and preserves the message layout", () => {
  isolated((home, house, shell) => {
    writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ effortLevel: "high" }));
    writeFileSync(join(house, ".mcp.json"), JSON.stringify({ mcpServers: { lore: {}, app: {} } }));
    shell(`
${shellFunction("notify_runtime_swap")}
claude() { printf 'test-build\\n'; }
embervy_curl_bearer() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = -d ]; then printf '%s' "$2" > "$HOME/payload.json"; return 0; fi
    shift
  done
  return 1
}
LOG="$HOME/loop.log"
APP_HOST=127.0.0.1
APP_PORT=3030
notify_runtime_swap 143
`);
    const payload = JSON.parse(readFileSync(join(home, "payload.json"), "utf8"));
    expect(payload.role).toBe("system");
    expect(payload.text).toBe("Runtime restarted.\nReason: SIGTERM (Watchdog/Cutover)\nBuild: test-build\nEffort: high\nMCPs: app,lore");
    expect(payload.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

test("the complete loop script has valid Bash syntax", () => {
  isolated((_home, _house, shell) => {
    expect(shell('bash -n "$LOOP_PATH"', { LOOP_PATH: loopPath })).toBe("");
  });
});
