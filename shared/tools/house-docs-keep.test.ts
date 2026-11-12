import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, configuredTunnel, handbookVars, localPublicIPv4, renderHandbook, renderInfrastructure } from "./house-docs";

const temp = mkdtempSync(join(tmpdir(), "house-docs-keep-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function fixture(harness: string) {
  const home = mkdtempSync(join(temp, "home-"));
  for (const dir of ["Brain", "Claude/app", "bin"]) mkdirSync(join(home, dir), { recursive: true });
  writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\nUSER_LABEL=Configured Person\nEMBERVY_APP_SERVICE=embervy-secondary-app\n`);
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=gpt\nBRAIN_USER_NAME=Configured Person\n");
  writeFileSync(join(home, "bin/systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return home;
}
function run(home: string, ...flags: string[]) {
  return Bun.spawnSync([process.execPath, join(import.meta.dir, "house-docs.ts"), "--home", home, ...flags], {
    env: { PATH: `${home}/bin:/usr/bin:/bin`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe",
  });
}
for (const harness of ["brain", "claude-code"]) test(`${harness} reports disabled modules in kept prose without changing it`, () => {
  const home = fixture(harness);
  const kept = "## Modules enabled\n- weather\n";
  writeFileSync(join(home, "INFRASTRUCTURE.md"), kept);
  for (let pass = 0; pass < 2; pass++) {
    expect(run(home, "--write").exitCode).toBe(0);
    expect(readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8")).toContain(kept);
    const checked = run(home, "--check");
    expect(checked.exitCode).toBe(1);
    expect(checked.stdout.toString()).toContain("kept section Modules enabled: capability Weather: contradicts house configuration");
    expect(checked.stdout.toString()).not.toContain("- weather");
  }
});

for (const harness of ["brain", "claude-code"]) test(`${harness} keeps readable operational instructions in regenerated sections`, () => {
  const home = fixture(harness);
  mkdirSync(join(home, "Brain/scripts"));
  writeFileSync(join(home, "Brain/scripts/brain-doctor.ts"), "export {};\n");
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=gpt\nBRAIN_UNIT=embervy-secondary-brain\nBRAIN_LOG_DIR=Brain/custom-logs\nBRAIN_INLET_WORKER_LOG=Brain/custom-logs/inlet.log\nBRAIN_FIRST_TURN_FILE=state/first-turn.md\nBRAIN_DOCTOR_CMD=private-command\nADAPTER_EFFORT=high\n");
  const text = run(home).stdout.toString();
  for (const fragment of ["journalctl --vacuum-size=200M", "apt-get clean", "feed-token.ts rotate --env", "browse.py stop", ".claude/skills/browser/SKILL.md"]) expect(text).toContain(fragment);
  if (harness === "brain") {
    for (const fragment of ["session-<id>.jsonl", "conversation-<id>.jsonl", "brain-watchdog.log", "brain-cutoff.log", "Brain/custom-logs/inlet.log", "Brain/scripts/brain-doctor.ts", "journalctl -u embervy-secondary-brain.service", "state/first-turn.md", "reasoning effort: high"]) expect(text).toContain(fragment);
    expect(text).not.toContain("private-command");
  }
});

for (const harness of ["brain", "claude-code"]) test(`${harness} handbook describes actual logs and phone feed settings`, () => {
  const home = fixture(harness);
  for (const enabled of [false, true]) {
    writeFileSync(join(home, "Claude/app/.env"), enabled ? "EMBERVY_HOOK_CALENDAR=1\nCALENDAR_FEED_TOKEN=private-feed-value\n" : "EMBERVY_HOOK_CALENDAR=0\n");
    const facts = collectFacts(home, { queryUnits: false }).facts;
    facts.rescueAccess = false;
    const text = renderHandbook(handbookVars(facts), facts.harness);
    expect(text).toContain(`**Logs** are in \`${home}/${harness === "brain" ? "Brain/logs" : "logs"}/\``);
    expect(text).toContain(enabled ? "phone feed is enabled and its token is set" : "phone feed is not configured for use");
    expect(text).not.toContain("private-feed-value");
    const access = text.indexOf("If the app is down");
    expect(access).toBeGreaterThan(text.indexOf("## 6."));
    expect(access).toBeLessThan(text.indexOf("## 7."));
  }
  writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_HOOK_CALENDAR=1\n");
  const facts = collectFacts(home, { queryUnits: false }).facts;
  expect(renderHandbook(handbookVars(facts), facts.harness)).toContain("phone feed is not configured for use");
});

for (const harness of ["brain", "claude-code"]) for (const name of ["HANDBOOK.md", "INFRASTRUCTURE.md"]) test(`${harness} preserves marked ${name} sections in their existing order`, () => {
  const home = fixture(harness);
  const heading = name === "HANDBOOK.md" ? "5. What you may change, and what needs your user" : "Where things live";
  const before = "## Local instructions\n\nKeep this before the agreement.\n\n";
  const marked = `## ${heading}\r\n<!-- kept by the agent -->\r\n\r\nThe identity is written together and changed only with permission.\r\nApp port: 9999\r\n\r\n`;
  const after = "## Local reminders\n\nKeep this after the agreement.\n\n";
  writeFileSync(join(home, name), "# Previous\n\n" + before + marked + after);
  let last: string | undefined;
  for (let pass = 0; pass < 3; pass++) {
    const preview = run(home).stdout.toString();
    expect(preview).toContain(before + marked + after);
    expect(run(home, "--write").exitCode).toBe(0);
    const text = readFileSync(join(home, name), "utf8");
    expect(text).toContain(before + marked + after);
    expect(text.split(`## ${heading}`).length - 1).toBe(1);
    if (name === "HANDBOOK.md") expect(text).not.toContain("## 5. What you may change, and what needs Configured Person");
    if (last) expect(text).toBe(last);
    last = text;
    const checked = run(home, "--check");
    expect(checked.exitCode).toBe(1);
    const output = checked.stdout.toString();
    expect(output).toContain(`${name}: kept section: ${heading} (kept by the agent)`);
    expect(output).toContain(`kept section ${heading}: app port: contradicts house configuration`);
    expect(output).not.toContain("9999");
    expect(output).not.toContain("written together");
  }
});

for (const name of ["HANDBOOK.md", "INFRASTRUCTURE.md"]) test(`${name} requires the marker directly below a real heading`, () => {
  const home = fixture("brain");
  const heading = name === "HANDBOOK.md" ? "1. Where you are" : "Substrate";
  writeFileSync(join(home, name), `## ${heading}\n\n<!-- kept by the agent -->\nOld text.\n`);
  expect(run(home, "--write").exitCode).toBe(0);
  expect(readFileSync(join(home, name), "utf8")).not.toContain("Old text.");
});

for (const harness of ["brain", "claude-code"]) for (const rule of ["own", "together"] as const) test(`${harness} checks a kept identity rule without quoting its prose (${rule})`, () => {
  const home = fixture(harness);
  writeFileSync(join(home, "Claude/app/.env"), `EMBERVY_IDENTITY_RULE=${rule}\n`);
  const opposite = rule === "own"
    ? "Your identity file is written together with your user and changed only with your user's okay."
    : "Your identity file is yours.";
  const kept = `## 1. Where you are\n<!-- kept by the agent -->\n${opposite}\n`;
  writeFileSync(join(home, "HANDBOOK.md"), kept);
  expect(run(home, "--write").exitCode).toBe(0);
  const checked = run(home, "--check");
  expect(checked.exitCode).toBe(1);
  expect(checked.stdout.toString()).toContain("HANDBOOK.md: kept section 1. Where you are: EMBERVY_IDENTITY_RULE: contradicts house configuration");
  expect(checked.stdout.toString()).not.toContain(opposite);
  expect(readFileSync(join(home, "HANDBOOK.md"), "utf8")).toContain(kept);
});

for (const harness of ["brain", "claude-code"]) test(`${harness} refreshes generated sections while keeping the together identity rule`, () => {
  const home = fixture(harness);
  writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_IDENTITY_RULE=together\nEMBERVY_APP_PORT=4130\n");
  expect(run(home, "--write").exitCode).toBe(0);
  writeFileSync(join(home, "Claude/app/.env"), "EMBERVY_IDENTITY_RULE=together\nEMBERVY_APP_PORT=4230\n");
  expect(run(home, "--write").exitCode).toBe(0);
  const text = readFileSync(join(home, "HANDBOOK.md"), "utf8");
  expect(text).toContain("Your local app listens on port 4230.");
  expect(text).toContain("identity file is written together");
  expect(text).toContain("- changes to your identity file.");
  expect(text).not.toContain("<!-- kept by the agent -->");
  expect(run(home, "--check").exitCode).toBe(0);
});

test("saved head configuration supplies the current head and model", () => {
  const home = fixture("brain");
  mkdirSync(join(home, "Brain/state"));
  writeFileSync(join(home, "Brain/state/brain-head.json"), JSON.stringify({ version: 1, head: "claude", model: "configured-model", window: 500000, transport: "pipe" }));
  const facts = collectFacts(home, { queryUnits: false }).facts;
  expect(facts.head).toBe("claude");
  expect(facts.model).toBe("configured-model");
  expect(renderInfrastructure(facts)).toContain("Configured head: claude; model: configured-model");
});

for (const harness of ["brain", "claude-code"]) for (const name of ["HANDBOOK.md", "INFRASTRUCTURE.md"]) test(`${harness} checks clean marked ${name} sections and rejects credentials before writing`, () => {
  const home = fixture(harness);
  const heading = name === "HANDBOOK.md" ? "4.  REACHING  YOUR USER" : "  REACHABILITY";
  const marked = `## ${heading}\n<!-- kept by the agent -->\nApp port: 3030\n`;
  writeFileSync(join(home, name), marked);
  expect(run(home, "--write").exitCode).toBe(0);
  const original = readFileSync(join(home, name), "utf8");
  expect(original).toContain(marked);
  expect(run(home, "--check").exitCode).toBe(0);
  writeFileSync(join(home, "Claude/app/.env"), "APP_PASSWORD=private-test-value\n");
  writeFileSync(join(home, name), original.replace("App port: 3030", "App port: 3030\nprivate-test-value"));
  const privateText = readFileSync(join(home, name), "utf8");
  const checked = run(home, "--write");
  expect(checked.exitCode).toBe(2);
  expect(checked.stdout.toString() + checked.stderr.toString()).not.toContain("private-test-value");
  expect(readFileSync(join(home, name), "utf8")).toBe(privateText);
  expect(run(home).stdout.toString()).not.toContain("private-test-value");
});

const tunnelId = "11111111-2222-3333-4444-555555555555";
for (const prefix of ["embervy", "embervy-secondary"]) test(`${prefix} reads only its unit's tunnel credential`, () => {
  const path = `/etc/${prefix}/tunnel.env`;
  const state = `EnvironmentFiles=${path} (ignore_errors=no)\nExecStart={ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared --no-autoupdate tunnel run ; ignore_errors=no ; }\n`;
  const calls: string[] = [];
  const read = (file: string) => { calls.push(file); return `TUNNEL_TOKEN=${Buffer.from(JSON.stringify({ t: tunnelId, s: "private-value" })).toString("base64")}\n`; };
  const result = configuredTunnel(`/opt/${prefix}`, prefix, state, `- Tunnel: **configured-tunnel** (\`${tunnelId}\`)`, read);
  expect(result.tunnel).toEqual({ id: tunnelId, name: "configured-tunnel" });
  expect(calls).toEqual([path]);
  calls.length = 0;
  expect(configuredTunnel(`/opt/${prefix}`, prefix, state.replace(path, "/etc/embervy-other/tunnel.env"), "", read).tunnel).toBeUndefined();
  expect(calls).toEqual([]);
  expect(configuredTunnel(`/opt/${prefix}`, prefix, "", "", read).tunnel).toBeUndefined();
  expect(calls).toEqual([]);
});

test("public address uses only the primary interface and rejects private or documentation ranges", () => {
  const routes = "Iface Destination Gateway Flags RefCnt Use Metric\neth0 00000000 01010101 0003 0 0 100\n";
  for (const ip of ["10.0.0.1", "192.0.2.1", "100.64.0.1", "127.0.0.1", "169.254.1.1", "198.51.100.1", "203.0.113.1"]) {
    expect(localPublicIPv4({ eth0: [{ address: ip, family: "IPv4", internal: false } as any] }, routes)).toBeUndefined();
  }
  expect(localPublicIPv4({ eth0: [{ address: "8.8.4.4", family: "IPv4", internal: false } as any] }, routes)).toBe("8.8.4.4");
  expect(localPublicIPv4({ eth1: [{ address: "8.8.4.4", family: "IPv4", internal: false } as any] }, routes)).toBeUndefined();
});

for (const harness of ["brain", "claude-code"]) test(`${harness} renders its configured tunnel and omits absent tunnels`, () => {
  const home = fixture(harness);
  const token = Buffer.from(JSON.stringify({ t: tunnelId, s: "private-value" })).toString("base64");
  writeFileSync(join(home, "tunnel.env"), `TUNNEL_TOKEN=${token}\n`);
  writeFileSync(join(home, "INFRASTRUCTURE.md"), `## Reachability\n- Tunnel: **configured-tunnel** (\`${tunnelId}\`)\n`);
  writeFileSync(join(home, "bin/systemctl"), `#!/bin/sh\ncase "$*" in\n  *embervy-secondary-tunnel.service) printf '%s\\n' 'LoadState=loaded' 'EnvironmentFiles=${home}/tunnel.env (ignore_errors=no)' 'ExecStart={ path=/usr/bin/cloudflared ; argv[]=/usr/bin/cloudflared --no-autoupdate tunnel run ; ignore_errors=no ; }';;\n  *) exit 1;;\nesac\n`, { mode: 0o755 });
  for (let pass = 0; pass < 2; pass++) {
    expect(run(home, "--write").exitCode).toBe(0);
    const text = readFileSync(join(home, "INFRASTRUCTURE.md"), "utf8");
    expect(text).toContain(`- Tunnel: **configured-tunnel** (\`${tunnelId}\`)`);
    expect(text).not.toContain(token);
    expect(text).not.toContain("private-value");
  }
  const facts = collectFacts(fixture(harness), { queryUnits: false }).facts;
  expect(renderInfrastructure(facts)).not.toContain("- Tunnel:");
  expect(renderInfrastructure(facts)).toContain(`Configured head: ${harness === "brain" ? "gpt" : "claude"}`);
});

for (const harness of ["brain", "claude-code"]) test(`${harness} matches numbered handbook sections before substituting the configured user`, () => {
  const home = fixture(harness);
  writeFileSync(join(home, "HANDBOOK.md"), "# Handbook\n\n## 4. Reaching your user\nOld contact rule.\n\n## 5. What you may change, and what needs your user\nOld permission rule.\n");
  for (let pass = 0; pass < 2; pass++) {
    expect(run(home, "--write").exitCode).toBe(0);
    const text = readFileSync(join(home, "HANDBOOK.md"), "utf8");
    for (const number of [4, 5]) expect(text.match(new RegExp(`^## ${number}\\.`, "gm"))?.length).toBe(1);
    expect(text).not.toContain("Old contact rule");
    expect(text).not.toContain("Old permission rule");
    expect(text).toContain("4. Reaching Configured Person");
    expect(run(home, "--check").exitCode).toBe(0);
  }
});
