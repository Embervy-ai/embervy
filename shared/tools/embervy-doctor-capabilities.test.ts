import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFacts, renderCapabilities } from "./house-docs";

const temp = mkdtempSync(join(tmpdir(), "doctor-capabilities-"));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
function house() {
  const home = mkdtempSync(join(temp, "house-"));
  mkdirSync(join(home, "Brain"));
  writeFileSync(join(home, ".env"), "EMBERVY_HARNESS=brain\n");
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_HEAD=api\nBRAIN_INLET=false\n");
  return home;
}
function check(home: string, startup = true) {
  const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "embervy-doctor.ts"), "--json", "--offline", ...(startup ? ["--startup"] : [])], {
    cwd: tmpdir(), env: { PATH: process.env.PATH, HOME: home, EMBERVY_HOME: home }, stdout: "pipe", stderr: "pipe",
  });
  const report = JSON.parse(result.stdout.toString());
  const entries = report.checks.filter((entry: any) => entry.id === "capabilities");
  expect(entries.length).toBe(1);
  expect(entries[0].status).not.toBe("FAIL");
  return entries[0];
}

for (const startup of [true, false]) test(`doctor warns for missing capabilities with a creation command (${startup ? "startup" : "full"})`, () => {
  const home = house();
  const entry = check(home, startup);
  expect(entry.status).toBe("WARN");
  expect(entry.detail).toContain("CAPABILITIES.md");
  expect(entry.fix).toContain("house-docs.ts");
  expect(entry.fix).toContain("--write");
});

test("doctor reports contradictory and missing ability names, never source lines", () => {
  const home = house();
  const text = renderCapabilities(collectFacts(home).facts)
    .replace("- Pins | Keep important context visible | on", "- Pins | PRIVATE_DESCRIPTION | off")
    .replace(/^.*- House doctor .*\n/m, "");
  writeFileSync(join(home, "CAPABILITIES.md"), text);
  const entry = check(home);
  expect(entry.status).toBe("WARN");
  expect(entry.detail).toContain("Pins");
  expect(entry.detail).toContain("House doctor");
  expect(JSON.stringify(entry)).not.toContain("PRIVATE_DESCRIPTION");
  expect(entry.fix).toContain("--capabilities");
});

test("doctor accepts current capabilities and ignores a hand-added ability", () => {
  const home = house();
  writeFileSync(join(home, "CAPABILITIES.md"), renderCapabilities(collectFacts(home).facts) + "- Handmade | Do my own thing | on | always on\n");
  expect(check(home).status).toBe("OK");
});

test("unreadable capabilities and invalid configuration warn instead of failing", () => {
  const home = house();
  const path = join(home, "CAPABILITIES.md");
  mkdirSync(path);
  expect(check(home).status).toBe("WARN");
  rmSync(path, { recursive: true });
  writeFileSync(path, "Agent words\n");
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_CONTROL_PORT=not-a-port\n");
  expect(check(home).status).toBe("WARN");
});
