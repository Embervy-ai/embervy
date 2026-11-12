import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, renderCapabilities } from "./house-docs";

const homes: string[] = [];
afterAll(() => homes.forEach(home => rmSync(home, { recursive: true, force: true })));
const sentence = "Running normally. A security update becomes active at the next server restart; nothing needs doing now, and only your person decides when.";
type Options = {
  harness?: string;
  brainUser?: string;
  userLabel?: string;
  appUserLabel?: string;
  marker?: boolean;
  packages?: string;
  directory?: "missing" | "unreadable" | "file";
  unreadablePackages?: boolean;
  unreadableMarker?: boolean;
  boot?: string[];
  running?: string;
};
type Check = { id: string; status: string; detail?: string };

function run(options: Options = {}) {
  const home = mkdtempSync(join(tmpdir(), "doctor-reboot-"));
  homes.push(home);
  const directory = join(home, "run");
  const marker = join(directory, "pending-restart");
  const packagesFile = join(home, "pending-packages");
  if (options.directory === "file") writeFileSync(directory, "not a directory");
  else if (options.directory !== "missing") mkdirSync(directory);
  if (options.marker) writeFileSync(marker, "");
  if (options.packages !== undefined) writeFileSync(packagesFile, options.packages);
  const bootDir = join(home, "boot");
  if (options.boot) {
    mkdirSync(bootDir);
    for (const name of options.boot) writeFileSync(join(bootDir, name), "");
  }
  mkdirSync(join(home, "Brain"));
  mkdirSync(join(home, "state"));
  const harness = options.harness ?? "brain";
  writeFileSync(join(home, "Brain/brain.env"), `BRAIN_INLET=false\nBRAIN_USER_NAME=${options.brainUser ?? ""}\n`);
  writeFileSync(join(home, ".env"), `EMBERVY_HARNESS=${harness}\nUSER_LABEL=${options.userLabel ?? ""}\n`);
  if (options.appUserLabel !== undefined) {
    mkdirSync(join(home, "Claude/app"), { recursive: true });
    writeFileSync(join(home, "Claude/app/.env"), `USER_LABEL=${options.appUserLabel}\n`);
  }
  writeFileSync(join(home, "CLAUDE.md"), "# Identity\n");
  mkdirSync(join(home, "Claude/scripts"), { recursive: true });
  writeFileSync(join(home, "Claude/scripts/inlet-worker.ts"), "export {};\n");
  writeFileSync(join(home, ".mcp.json"), JSON.stringify({ mcpServers: {
    app: { url: "http://app.invalid/mcp" }, lore: { url: "http://memory.invalid/mcp" },
  } }));
  const { facts } = collectFacts(home, { queryUnits: false });
  writeFileSync(join(home, "CAPABILITIES.md"), renderCapabilities(facts));
  const callsFile = join(home, "filesystem-calls.json");
  const runner = join(home, "runner.ts");
  // Child-local mocks keep host resources and permissions from changing the verdict.
  writeFileSync(runner, `
import { mock } from "bun:test";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
const fs = { ...nodeFs };
const options = ${JSON.stringify(options)};
const calls = [];
function track(path) {
  const value = String(path);
  calls.push(value);
  fs.writeFileSync(${JSON.stringify(callsFile)}, JSON.stringify(calls));
  if (value === "/var/run" || value.startsWith("/var/run/")) throw new Error("real reboot path forbidden");
}
function denied() { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); }
mock.module("node:fs", () => ({
  ...fs,
  existsSync(path) { track(path); return fs.existsSync(path); },
  readdirSync(path, ...args) { track(path); return fs.readdirSync(path, ...args); },
  statSync(path, ...args) {
    track(path);
    if (options.unreadableMarker && path === ${JSON.stringify(marker)}) denied();
    return fs.statSync(path, ...args);
  },
  accessSync(path, ...args) {
    track(path);
    if (options.directory === "unreadable" && path === ${JSON.stringify(directory)}) denied();
    return fs.accessSync(path, ...args);
  },
  readFileSync(path, ...args) {
    track(path);
    if (options.unreadablePackages && path === ${JSON.stringify(packagesFile)}) denied();
    if (path === "/proc/swaps") return "Filename Type Size Used Priority\\n/swapfile file 4194304 0 -2\\n";
    return fs.readFileSync(path, ...args);
  },
  statfsSync() { return { blocks: 100, bfree: 80, bavail: 80, bsize: 4096 }; },
}));
mock.module("node:os", () => ({ ...nodeOs, release: () => options.running ?? "6.12.0-test" }));
mock.module("node:child_process", () => ({
  spawnSync() { return { status: 0, stdout: "LoadState=not-found\\nActiveState=inactive\\n", stderr: "" }; },
}));
globalThis.fetch = async () => { throw new Error("network disabled"); };
await import(${JSON.stringify(join(import.meta.dir, "embervy-doctor.ts"))});
`);
  const child = Bun.spawnSync([process.execPath, runner, "--offline", "--json"], {
    cwd: home, stdout: "pipe", stderr: "pipe",
    env: {
      HOME: home, PATH: home, EMBERVY_HOME: home,
      EMBERVY_HARNESS: harness, EMBERVY_SUBSTRATE: harness === "brain" ? "brain" : "claude",
      EMBERVY_DOCTOR_SKIP_CANARY: "1",
      EMBERVY_URL: "https://memory.invalid", EMBERVY_API_KEY: "test-memory-token",
      RAG_URL: "https://archive.invalid", RAG_AUTH_TOKEN: "test-archive-token",
      APP_PASSWORD: "nontrivial-test-password", APP_SESSION_SECRET: "s".repeat(48),
      REBOOT_REQUIRED_FILE: marker, REBOOT_REQUIRED_PKGS_FILE: packagesFile, REBOOT_BOOT_DIR: bootDir,
    },
  });
  expect(child.stderr.toString()).toBe("");
  const report = JSON.parse(child.stdout.toString()) as {
    result: string; summary: { warn: number; fail: number }; checks: Check[];
  };
  const calls = JSON.parse(readFileSync(callsFile, "utf8")) as string[];
  expect(calls.some(path => path === "/var/run" || path.startsWith("/var/run/"))).toBe(false);
  expect(calls).toContain(directory);
  const entries = report.checks.filter(check => check.id === "health.reboot");
  expect(entries).toHaveLength(1);
  expect(report.summary.fail, `Unexpected failed checks: ${report.checks.filter(check => check.status === "FAIL").map(check => check.id).join(", ")}`).toBe(0);
  return { check: entries[0], report, exitCode: child.exitCode, calls, packagesFile };
}

test("an absent marker is OK and does not read a stray package list", () => {
  const result = run({ packages: "libc6\n" });
  expect(result.check.status).toBe("OK");
  expect(result.report.result).toBe("PASS");
  expect(result.exitCode).toBe(0);
  expect(result.calls).not.toContain(result.packagesFile);
});

test("a marker without a package list warns with a readable restart instruction", () => {
  const result = run({ marker: true });
  expect(result.check).toMatchObject({ status: "OK", detail: sentence });
});

const personCases: Array<[Options, string]> = [
    [{ brainUser: "configured person", userLabel: "other label" }, "configured person"],
    [{ harness: "claude-code", userLabel: "configured person", brainUser: "other label" }, "configured person"],
    [{ harness: "claude-code", userLabel: "root label", appUserLabel: "app person" }, "app person"],
    [{ userLabel: "inactive label" }, "your person"],
    [{ harness: "claude-code", brainUser: "inactive label" }, "your person"],
    [{ brainUser: "   " }, "your person"],
    [{ harness: "claude-code", userLabel: "   " }, "your person"],
];
for (const [index, [options, person]] of personCases.entries()) {
  test(`pending restart uses the active house person setting, case ${index + 1}`, () => {
    const result = run({ marker: true, ...options });
    expect(result.check).toMatchObject({ status: "OK", detail: sentence.replace("your person", person) });
  });
}

test("seven packages name only the first five and count the rest, without the kernel meta package", () => {
  const result = run({ marker: true, packages: "linux-image-amd64\nlibc6\nlibssl3\nlibsystemd0\nlibpam0g\nopenssl\nsystemd\nudev\n" });
  expect(result.check.status).toBe("OK");
  expect(result.check.detail).toBe(`${sentence} (packages: libc6, libssl3, libsystemd0, libpam0g, openssl, 2 more)`);
  expect(result.check.detail).not.toContain("amd64");
  expect(result.check.detail).not.toContain("udev");
  expect(result.check.detail).not.toMatch(/, systemd/);
});

test("five packages need no remainder and blank lines are ignored", () => {
  const result = run({ marker: true, packages: "\n libc6\r\nlibssl3\n\nlibpam0g\nopenssl\nsystemd\n" });
  expect(result.check.detail).toBe(`${sentence} (packages: libc6, libssl3, libpam0g, openssl, systemd)`);
});

for (const directory of ["missing", "unreadable", "file"] as const) {
  test(`a ${directory} status directory is skipped, not failed`, () => {
    const result = run({ directory });
    expect(result.check.status).toBe("SKIP");
    expect(result.report.result).toBe("PASS");
    expect(result.exitCode).toBe(0);
  });
}

test("an unreadable marker is skipped rather than claimed absent", () => {
  expect(run({ marker: true, unreadableMarker: true }).check.status).toBe("SKIP");
});

test("an unreadable or empty package list cannot hide a pending restart", () => {
  for (const options of [{ unreadablePackages: true, packages: "libc6\n" }, { packages: "\n \r\n" }]) {
    expect(run({ marker: true, ...options }).check).toMatchObject({ status: "OK", detail: sentence });
  }
});

test("a pending restart alone keeps the report green and the exit code zero", () => {
  const result = run({ marker: true });
  expect(result.report.checks.filter(check => check.status === "WARN").map(check => check.id)).toEqual([]);
  expect(result.report.summary).toMatchObject({ warn: 0, fail: 0 });
  expect(result.report.result).toBe("PASS");
  expect(result.exitCode).toBe(0);
});

const kernel = (version: string) => `linux-image-${version}+deb13-amd64`;
const image = (version: string) => `vmlinuz-${version}+deb13-amd64`;

test("kernels that a later update removed from /boot are not named", () => {
  const result = run({
    marker: true, running: "6.12.107+deb13-amd64",
    packages: [kernel("6.12.111"), kernel("6.12.113"), kernel("6.12.115")].join("\n") + "\n",
    boot: [image("6.12.107"), image("6.12.115"), "config-6.12.111+deb13-amd64"],
  });
  expect(result.check).toMatchObject({ status: "OK",
    detail: `${sentence} (system 6.12.115 installed, 6.12.107 still running)` });
  expect(result.check.detail).not.toContain("amd64");
  expect(result.check.detail).not.toContain("6.12.111");
  expect(result.check.detail).not.toContain("6.12.113");
});

test("the newest kernel is chosen by version, and other packages are still listed", () => {
  const result = run({
    marker: true, running: "6.12.94+deb13-amd64",
    packages: [kernel("6.12.115"), "libc6", kernel("6.12.99"), kernel("6.12.115")].join("\n"),
    boot: [image("6.12.94"), image("6.12.99"), image("6.12.115")],
  });
  expect(result.check.detail).toBe(
    `${sentence} (system 6.12.115 installed, 6.12.94 still running; packages: libc6)`);
});

test("only stale or running kernels leave the plain warning, never silence", () => {
  const result = run({
    marker: true, running: "6.12.107+deb13-amd64",
    packages: [kernel("6.12.107"), kernel("6.12.111")].join("\n"),
    boot: [image("6.12.107")],
  });
  expect(result.check).toMatchObject({ status: "OK", detail: sentence });
});

test("an unreadable /boot keeps the listed kernels instead of dropping them", () => {
  const result = run({
    marker: true, running: "6.12.107+deb13-amd64",
    packages: [kernel("6.12.111"), kernel("6.12.115")].join("\n"),
  });
  expect(result.check.detail).toBe(
    `${sentence} (system 6.12.115 installed, 6.12.107 still running)`);
});
