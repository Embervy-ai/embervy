import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const doctor = join(import.meta.dir, "embervy-doctor.ts");
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function house(servers: { name: string; status: string }[], head = "claude") {
  const home = mkdtempSync(join(tmpdir(), "doctor-mcp-"));
  homes.push(home);
  mkdirSync(join(home, "Brain", "logs"), { recursive: true });
  writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: {
    app: { command: "bun", args: ["run", "Claude/app/mcp.ts"] },
    lore: { type: "http", url: "https://lore.example.invalid/mcp" },
  } }));
  writeFileSync(join(home, "Brain", "brain.env"), `BRAIN_HEAD=${head}\n`);
  writeFileSync(join(home, "Brain", "logs", "session-1-a.jsonl"),
    JSON.stringify({ type: "claude_pipe_init", mcp_servers: servers }) + "\n");
  return home;
}

function mcpCheck(home: string) {
  const res = Bun.spawnSync(["bun", doctor, "--offline", "--json"], {
    cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, EMBERVY_HOME: home, EMBERVY_HARNESS: "brain",
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"), REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
    stdout: "pipe", stderr: "pipe",
  });
  const out = res.stdout.toString();
  const json = JSON.parse(out.slice(out.indexOf("{")));
  return (json.checks ?? json.status?.checks ?? []).find((c: any) => c.id === "mcp");
}

describe("doctor: house MCP servers on Brain", () => {
  test("counts the house's servers from the latest pipe init and ignores account connectors", () => {
    const check = mcpCheck(house([
      { name: "app", status: "connected" }, { name: "lore", status: "connected" },
      { name: "claude.ai Some Account Connector", status: "failed" },
    ]));
    expect(check.status).toBe("OK");
    expect(check.detail).toContain("2/2 connected");
    expect(check.detail).not.toContain("claude.ai");
  });

  test("names the house server that is not connected", () => {
    const check = mcpCheck(house([{ name: "app", status: "connected" }, { name: "lore", status: "failed" }]));
    expect(check.status).toBe("WARN");
    expect(check.detail).toContain("lore: failed");
  });
});
