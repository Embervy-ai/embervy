import { afterEach, test, expect } from "bun:test";
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { houseCheckBlock, runStartupDoctor } from "../../Brain/house-check";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

// The startup identity probe needs the CLI and its static import closure, not a house build.
const fixtureSources = [
  "shared/tools/embervy-doctor.ts",
  "shared/scripts/env-file.ts",
  "shared/scripts/house-runtime.ts",
  "shared/scripts/legacy-names.ts",
];
function house(): string {
  const home = mkdtempSync(join(tmpdir(), "doctor-house-root-"));
  homes.push(home);
  for (const file of fixtureSources) {
    const destination = join(home, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(import.meta.dir, "../..", file), destination);
  }
  mkdirSync(join(home, "Brain"));
  writeFileSync(join(home, "Brain/brain.env"), "BRAIN_SYSTEM=identity.md\nBRAIN_INLET=false\n");
  writeFileSync(join(home, "identity.md"), "# Identity\n");
  return home;
}

test("started from Brain/ without EMBERVY_HOME, the doctor checks the house it lives in", async () => {
  const home = house();
  try {
    expect(readdirSync(home, { recursive: true }).sort()).toEqual([
      ...fixtureSources, "Brain", "Brain/brain.env", "identity.md", "shared", "shared/scripts", "shared/tools",
    ].sort());
    const child = Bun.spawn([process.execPath, join(home, "shared/tools/embervy-doctor.ts"), "--startup", "--json", "--offline"], {
      cwd: join(home, "Brain"), env: { PATH: process.env.PATH!, HOME: home, EMBERVY_HARNESS: "brain" }, stdout: "pipe", stderr: "pipe",
    });
    const report = JSON.parse(await new Response(child.stdout).text());
    await child.exited;
    const identity = report.checks.find((c: any) => c.id === "identity");
    expect(identity?.status).toBe("OK");
    expect(identity?.detail).toBe(join(home, "identity.md"));
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 20_000);

test("Brain's startup check runs from the house root and names the house", async () => {
  const saved = process.env.EMBERVY_HOME;
  const home = mkdtempSync(join(tmpdir(), "doctor-house-env-"));
  try {
    process.env.EMBERVY_HOME = home;
    const findings = await runStartupDoctor(`printf '{"checks":[{"id":"where","label":"where","status":"WARN","detail":"%s|%s"}]}' "$PWD" "$EMBERVY_HOME"`);
    expect(findings[0]?.detail).toBe(`${home}|${home}`);
    expect(houseCheckBlock(findings)).toContain(home);
  } finally {
    if (saved === undefined) delete process.env.EMBERVY_HOME; else process.env.EMBERVY_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
});
