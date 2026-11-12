import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homes: string[] = [];
afterAll(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })));
type Check = { id: string; status: string; detail?: string; fix?: string };
type Options = {
  harness?: "brain" | "claude-code";
  policy?: string;
  restarts?: string;
  journal?: string;
  systemctl?: "missing" | "unavailable";
  journalctl?: "missing" | "denied" | "partial";
  custom?: boolean;
  noUnits?: boolean;
  extraUnits?: string[];
  loopType?: "timer" | "socket";
};

function run(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), "doctor-oom-"));
  homes.push(home);
  const harness = options.harness ?? "brain";
  const loop = options.custom ? "custom-loop.service" : `embervy-test-${harness === "brain" ? "brain" : "loop"}.${options.loopType ?? "service"}`;
  const helper = "embervy-test-ears.service";
  mkdirSync(join(home, "Brain"));
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\nEMBERVY_APP_SERVICE=embervy-test-app\n${harness === "claude-code" ? `EMBERVY_LOOP_SERVICE=${loop}\n` : ""}`);
  writeFileSync(join(home, "Brain/brain.env"), `BRAIN_INLET=false\nBRAIN_UNIT=${loop}\n`);
  if (options.noUnits) {
    writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\n`);
    writeFileSync(join(home, "Brain/brain.env"), "BRAIN_INLET=false\n");
  }
  if (options.extraUnits) {
    writeFileSync(join(home, ".env"), readFileSync(join(home, ".env"), "utf8")
      + options.extraUnits.map((unit, index) => `EMBERVY_EXTRA_${index}_UNIT=${unit}\n`).join(""));
  }
  writeFileSync(join(home, "CLAUDE.md"), "# Identity\n");
  const callsFile = join(home, "calls.json");
  const runner = join(home, "runner.ts");
  writeFileSync(runner, `
import { mock } from "bun:test";
import { writeFileSync } from "node:fs";
const options = ${JSON.stringify(options)};
const loop = ${JSON.stringify(loop)};
const helper = ${JSON.stringify(helper)};
const calls = [];
writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
function fake(command, args) {
  calls.push([command, ...args]);
  writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
  const ok = stdout => ({ status: 0, stdout, stderr: "" });
  const missing = () => ({ status: null, stdout: "", stderr: "", error: Object.assign(new Error("missing"), { code: "ENOENT" }) });
  const unit = args.find(arg => /\\.(service|timer|socket)$/.test(arg));
  if (command === "systemctl") {
    if (options.systemctl === "missing") return missing();
    if (options.systemctl === "unavailable") return { status: 1, stdout: "", stderr: "manager unavailable" };
    if (unit === loop || unit === helper || unit === "embervy-test-app.service" || options.extraUnits?.includes(unit)) {
      return ok("LoadState=loaded\\nActiveState=active\\nUnitFileState=enabled\\nOOMPolicy=" + (unit === loop ? options.policy ?? "continue" : "stop")
        + "\\nNRestarts=" + (unit === helper ? options.restarts ?? "0" : "0") + "\\n");
    }
    return ok("LoadState=not-found\\nActiveState=inactive\\n");
  }
  if (command === "journalctl") {
    if (options.journalctl === "missing") return missing();
    if (options.journalctl === "denied") return { status: 1, stdout: "", stderr: "permission denied" };
    if (options.journalctl === "partial") return { status: 0, stdout: "", stderr: "not seeing all messages" };
    return ok(unit === helper ? options.journal ?? "" : "");
  }
  return { status: 1, stdout: "", stderr: "blocked test command" };
}
mock.module("node:child_process", () => ({ spawnSync: fake }));
// The Node wrapper can call Bun with an options object instead of an argument array.
Bun.spawnSync = (input) => {
  const argv = Array.isArray(input) ? input : input.cmd;
  const result = fake(argv[0], argv.slice(1));
  if (result.error) throw result.error;
  return { exitCode: result.status, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr) };
};
globalThis.fetch = async () => { throw new Error("network disabled"); };
await import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});
`);
  const child = Bun.spawnSync([process.execPath, runner, "--offline", "--json"], {
    cwd: home, stdout: "pipe", stderr: "pipe",
    env: { HOME: home, PATH: home, EMBERVY_HOME: home, EMBERVY_HARNESS: harness,
      EMBERVY_SUBSTRATE: harness === "brain" ? "brain" : "claude",
      REBOOT_REQUIRED_FILE: join(home, "reboot-required"),
      REBOOT_REQUIRED_PKGS_FILE: join(home, "reboot-required.pkgs") },
  });
  expect(child.stderr.toString()).toBe("");
  const report = JSON.parse(child.stdout.toString()) as { checks: Check[] };
  const checks = report.checks.filter(check => /^health\.(oom_policy|oom_kills|restarts)(\.|$)/.test(check.id));
  expect(checks.length).toBeGreaterThan(0);
  expect(checks.some(check => check.status === "FAIL")).toBe(false);
  const calls = JSON.parse(readFileSync(callsFile, "utf8")) as string[][];
  return { checks, calls, loop, helper, text: child.stdout.toString() };
}

function kindChecks(checks: Check[], kind: string) {
  const id = `health.${kind}`;
  return checks.filter(check => check.id === id || check.id.startsWith(`${id}.`));
}

for (const harness of ["brain", "claude-code"] as const) {
  test(`the ${harness} loop warns for stop with a drop-in instruction`, () => {
    const result = run({ harness, policy: "stop" });
    const warnings = result.checks.filter(check => check.status === "WARN");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].id).toBe(`health.oom_policy.${result.loop}`);
    expect(warnings[0].detail).toBe(`${result.loop}: OOMPolicy=stop`);
    expect(warnings[0].fix).toContain(`systemctl edit ${result.loop}`);
    expect(warnings[0].fix).toContain("[Service]");
    expect(warnings[0].fix).toContain("OOMPolicy=continue");
    expect(kindChecks(result.checks, "oom_policy")).toEqual(warnings);
    expect(result.calls.some(call => call[0] === "systemctl" && call.includes("-p") && call.includes("OOMPolicy"))).toBe(true);
  });

  test(`healthy ${harness} units give exactly one counted line per kind`, () => {
    const result = run({ harness });
    expect(result.checks).toHaveLength(3);
    expect(result.checks).toEqual([
      expect.objectContaining({ id: "health.oom_policy", status: "OK", detail: "1 house unit: OOM policy is continue or kill" }),
      expect.objectContaining({ id: "health.oom_kills", status: "OK", detail: "3 house units: no OOM kills in the last seven days" }),
      expect.objectContaining({ id: "health.restarts", status: "OK", detail: "3 house units: restart counts at or below 50" }),
    ]);
  });
}

test("a helper OOM warns with only its unit and event count", () => {
  const result = run({ journal: "A process of this unit has been killed by the OOM killer. private process payload\nA process of this unit has been killed by the OOM killer.\nUnrelated output\n" });
  expect(kindChecks(result.checks, "oom_kills")).toEqual([expect.objectContaining({
    id: `health.oom_kills.${result.helper}`, status: "WARN", detail: `${result.helper}: 2 OOM kills in the last seven days`,
    fix: "Check this unit's memory use and the available memory and swap.",
  })]);
  expect(result.text).not.toContain("private process payload");
  expect(result.text).not.toContain("Unrelated output");
  const journals = result.calls.filter(call => call[0] === "journalctl");
  expect(journals.length).toBeGreaterThan(0);
  for (const call of journals) {
    expect(call).toContain("--since");
    expect(call).toContain("7 days ago");
    expect(call).toContain("_PID=1");
  }
});

for (const count of ["0", "50", "51", "51840"]) {
  test(`restart count ${count} uses a strict threshold of 50`, () => {
    const result = run({ restarts: count });
    expect(kindChecks(result.checks, "restarts")).toEqual([expect.objectContaining(Number(count) > 50 ? {
      id: `health.restarts.${result.helper}`, status: "WARN", detail: `${result.helper}: ${count} restarts`,
      fix: "Check this unit's configuration and resource use before restarting it again.",
    } : {
      id: "health.restarts", status: "OK", detail: "3 house units: restart counts at or below 50",
    })]);
    expect(result.calls.some(call => call[0] === "systemctl" && call.includes("-p") && call.includes("NRestarts"))).toBe(true);
  });
}

for (const policy of ["continue", "kill"]) {
  test(`policy ${policy} and unrelated journal output do not warn`, () => {
    const result = run({ policy, journal: "out of memory\nMain process exited, code=killed, status=9/KILL\n" });
    expect(result.checks.filter(check => check.status === "WARN")).toHaveLength(0);
  });
}

for (const systemctl of ["missing", "unavailable"] as const) {
  test(`systemctl ${systemctl} skips property checks`, () => {
    const result = run({ systemctl });
    const properties = result.checks.filter(check => /^health\.(oom_policy|restarts)\./.test(check.id));
    expect(properties.length).toBeGreaterThan(0);
    expect(properties.every(check => check.status === "SKIP")).toBe(true);
    for (const kind of ["oom_policy", "restarts"]) {
      expect(result.checks.filter(check => check.id === `health.${kind}`)).toEqual([expect.objectContaining({
        status: "SKIP", detail: "no house units could be checked; see per-unit reasons",
      })]);
    }
  });
}

for (const journalctl of ["missing", "denied", "partial"] as const) {
  test(`journalctl ${journalctl} skips history without hiding restart warnings`, () => {
    const result = run({ journalctl, restarts: "51" });
    const history = result.checks.filter(check => check.id.startsWith("health.oom_kills."));
    expect(history.length).toBeGreaterThan(0);
    expect(history.every(check => check.status === "SKIP")).toBe(true);
    expect(history.every(check => check.detail?.endsWith(": journal unavailable or incomplete"))).toBe(true);
    expect(result.checks.filter(check => check.id === "health.oom_kills")).toEqual([expect.objectContaining({
      status: "SKIP", detail: "no house units could be checked; see per-unit reasons",
    })]);
    expect(result.checks.find(check => check.id === `health.restarts.${result.helper}`)?.status).toBe("WARN");
  });
}

test("all three conditions warn independently without exposing journal text", () => {
  const result = run({ policy: "stop", restarts: "51", journal: "A process of this unit has been killed by the OOM killer. private process payload\n" });
  expect(result.checks.filter(check => check.status === "WARN").map(check => check.id).sort()).toEqual([
    `health.oom_kills.${result.helper}`, `health.oom_policy.${result.loop}`, `health.restarts.${result.helper}`,
  ].sort());
  expect(result.checks).toHaveLength(3);
  expect(result.text).not.toContain("private process payload");
});

test("missing properties are skipped instead of treated as healthy", () => {
  const result = run({ policy: "", restarts: "not-a-count" });
  expect(result.checks.find(check => check.id === `health.oom_policy.${result.loop}`)).toMatchObject({
    status: "SKIP", detail: `${result.loop}: OOM policy unavailable`,
  });
  expect(result.checks.find(check => check.id === `health.restarts.${result.helper}`)).toMatchObject({
    status: "SKIP", detail: `${result.helper}: restart count unavailable`,
  });
  expect(result.checks.find(check => check.id === "health.oom_policy")?.status).toBe("SKIP");
  expect(kindChecks(result.checks, "restarts")).toHaveLength(2);
  expect(result.checks.find(check => check.id === "health.restarts")).toMatchObject({
    status: "OK", detail: "2 house units: restart counts at or below 50",
  });
});

test("missing unit configuration skips all three checks", () => {
  const result = run({ noUnits: true });
  expect(result.checks.map(check => check.id).sort()).toEqual(["health.oom_kills", "health.oom_policy", "health.restarts"]);
  expect(result.checks.every(check => check.status === "SKIP")).toBe(true);
  expect(result.checks.every(check => check.detail === "no house units available")).toBe(true);
  expect(result.calls.some(call => call[0] === "journalctl")).toBe(false);
});

test("missing commands skip all three checks", () => {
  const result = run({ systemctl: "missing", journalctl: "missing" });
  expect(result.checks.every(check => check.status === "SKIP")).toBe(true);
  expect(result.checks.filter(check => /^health\.(oom_policy|oom_kills|restarts)$/.test(check.id))).toHaveLength(3);
});

test("configured loop overrides and exact house discovery exclude neighboring units", () => {
  const result = run({ custom: true, policy: "stop" });
  expect(result.checks.find(check => check.id === `health.oom_policy.${result.loop}`)?.status).toBe("WARN");
  expect(result.calls.some(call => call[0] === "journalctl" && call.includes(result.helper))).toBe(true);
  expect(result.calls.some(call => call[0] === "systemctl" && call.includes("NRestarts") && call.includes(result.helper))).toBe(true);
  expect(result.checks.find(check => check.id === "health.restarts")?.detail).toBe("3 house units: restart counts at or below 50");
  for (const call of result.calls.filter(call => ["systemctl", "journalctl"].includes(call[0]))) {
    expect(call.join(" ")).not.toMatch(/list-units|list-unit-files|\*/);
    const unit = call.find(arg => /\.(service|timer|socket)$/.test(arg));
    if (unit) expect(unit === "custom-loop.service" || unit.startsWith("embervy-test-")).toBe(true);
  }
});

for (const type of ["timer", "socket"] as const) {
  test(`a ${type} is not asked for restart count or OOM policy`, () => {
    const unit = `embervy-test-extra.${type}`;
    const result = run({ extraUnits: [unit] });
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every(check => check.status === "OK")).toBe(true);
    expect(result.checks.find(check => check.id === "health.oom_policy")?.detail).toBe("1 house unit: OOM policy is continue or kill");
    expect(result.checks.find(check => check.id === "health.restarts")?.detail).toBe("3 house units: restart counts at or below 50");
    expect(result.checks.find(check => check.id === "health.oom_kills")?.detail).toBe("4 house units: no OOM kills in the last seven days");
    const queries = result.calls.filter(call => call[0] === "systemctl" && call.includes(unit));
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(call => !/OOMPolicy|NRestarts/.test(call.join(" ")))).toBe(true);
    expect(result.calls.some(call => call[0] === "journalctl" && call.includes(unit))).toBe(true);
  });

  test(`a ${type} configured as the loop is still excluded from property checks`, () => {
    const result = run({ loopType: type, policy: "stop" });
    expect(result.checks).toHaveLength(3);
    expect(kindChecks(result.checks, "oom_policy")).toEqual([expect.objectContaining({
      id: "health.oom_policy", status: "SKIP", detail: "no house loop unit available",
    })]);
    expect(result.checks.find(check => check.id === "health.restarts")?.detail).toBe("2 house units: restart counts at or below 50");
    expect(result.calls.filter(call => call[0] === "systemctl" && call.includes(result.loop))
      .every(call => !/OOMPolicy|NRestarts/.test(call.join(" ")))).toBe(true);
  });
}

test("only ineligible units give one reasoned skip per property kind", () => {
  const result = run({ noUnits: true, extraUnits: ["embervy-test-extra.timer", "embervy-test-extra.socket"] });
  expect(result.checks).toHaveLength(3);
  expect(kindChecks(result.checks, "oom_policy")).toEqual([expect.objectContaining({
    id: "health.oom_policy", status: "SKIP", detail: "no house loop unit available",
  })]);
  expect(kindChecks(result.checks, "restarts")).toEqual([expect.objectContaining({
    id: "health.restarts", status: "SKIP", detail: "no eligible house units available",
  })]);
  expect(result.checks.find(check => check.id === "health.oom_kills")).toMatchObject({
    status: "OK", detail: "2 house units: no OOM kills in the last seven days",
  });
  expect(result.calls.filter(call => call[0] === "systemctl").every(call => !/OOMPolicy|NRestarts/.test(call.join(" ")))).toBe(true);
});
