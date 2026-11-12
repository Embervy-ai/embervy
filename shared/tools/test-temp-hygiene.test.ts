import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");

// A lived-in house keeps runtime data, old letter copies and builder worktrees next to the product, at any depth.
const HOUSE_DATA = new Set(["node_modules", ".git", ".claude", "state", "logs", "data", "backups", ".runtime", ".cache"]);

function excluded(path: string): boolean {
  // The installer is its own repository with its own suite; build output is not a product file.
  return path === "Brain" || path === "docs/blind-test" || path === "shared/tools/installer" || path === "shared/tools/installer-build"
    || path.split("/").some(part => HOUSE_DATA.has(part));
}

test("a house's own data folders are not searched for test files", () => {
  for (const path of ["state/builder/work/run/Claude/app/x.test.ts", "Claude/app/data/old.test.ts", "backups/u1/shared/tools/y.test.ts", "Brain", "shared/logs/z.test.ts", ".runtime/a.test.ts"]) expect(excluded(path), path).toBe(true);
  for (const path of ["Claude/app/server.test.ts", "shared/tools/house-docs.test.ts", "shared/scripts/statement.test.ts"]) expect(excluded(path), path).toBe(false);
});

function testFile(path: string): boolean {
  return /(?:^|\/)(?:test[-_].*|.*[.-](?:test|spec))\.(?:[cm]?[jt]sx?|py|sh)$/.test(path)
    || /\/(?:test|tests)\/.*\.(?:[cm]?[jt]sx?|py|sh)$/.test(path);
}

function repositoryTests(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (excluded(path)) continue;
    // Symlinks can lead outside the repository or back into an ancestor.
    if (entry.isDirectory()) files.push(...repositoryTests(absolute));
    else if (entry.isFile() && testFile(path)) files.push(path);
  }
  return files.sort();
}

function hygieneProblems(path: string, source: string): string[] {
  const allocations = [...source.matchAll(/\b(?:mkdtempSync|mkdtemp)\s*\(|\bmktemp\b/g)];
  // A bare unlink or non-recursive rm cannot reclaim a fixture directory.
  const cleanup = /\b(?:rmSync|rm)\s*\([^;]*\{[^}]*\brecursive\s*:\s*true\b[^}]*\}/.test(source);
  if (cleanup) return [];
  return allocations.map(match => `${path}:${source.slice(0, match.index).split("\n").length}: temporary directory creation needs recursive cleanup`);
}

test("repository tests that allocate temporary directories declare recursive cleanup", () => {
  const files = repositoryTests(root);
  expect(files).toContain("Claude/scripts/extract-bridge.test.ts");
  expect(files).toContain("shared/tools/embervy-doctor-house-root.test.ts");
  expect(files.some(path => excluded(path))).toBe(false);
  const problems = files.flatMap(path => hygieneProblems(path, readFileSync(join(root, path), "utf8")));
  expect(problems).toEqual([]);
});

test("the hygiene scan identifies every allocation by file and line", () => {
  const source = `// fixture\nconst first = ${"mkd" + "tempSync"}(prefix);\nconst second = await ${"mkd" + "temp"}(prefix);\n${"mk" + "temp"} -d`;
  expect(hygieneProblems("nested/leaky.test.ts", source)).toEqual([
    "nested/leaky.test.ts:2: temporary directory creation needs recursive cleanup",
    "nested/leaky.test.ts:3: temporary directory creation needs recursive cleanup",
    "nested/leaky.test.ts:4: temporary directory creation needs recursive cleanup",
  ]);
});

test("the hygiene scan requires a recursive removal call, including multiline async cleanup", () => {
  const source = `const dir = ${"mkd" + "tempSync"}(prefix);\n`;
  expect(hygieneProblems("fixture.test.ts", source + "rmSync(dir);")).toHaveLength(1);
  expect(hygieneProblems("fixture.test.ts", source + "rmSync(dir, { force: true });\nmkdirSync(other, { recursive: true });")).toHaveLength(1);
  expect(hygieneProblems("fixture.test.ts", source + "rmSync(dir, { recursive: true, force: true });")).toEqual([]);
  expect(hygieneProblems("fixture.test.ts", source + "await rm(\n dir,\n { recursive: true, force: true }\n);")).toEqual([]);
  expect(hygieneProblems("pure.test.ts", "expect(1 + 1).toBe(2);")).toEqual([]);
});

test("test discovery covers supported test names and excludes only external or exempt trees", () => {
  for (const path of ["x/unit.test.ts", "x/unit.spec.js", "x/test_browser.py", "x/test-cli.sh", "x/tests/helper.ts"]) expect(testFile(path)).toBe(true);
  for (const path of ["x/runtime.ts", "x/browser.py", "x/contest.ts"]) expect(testFile(path)).toBe(false);
  for (const path of ["Brain", "docs/blind-test", "x/node_modules", ".git"]) expect(excluded(path)).toBe(true);
  for (const path of ["Claude", "shared/tools", "docs/tests", "x/build"]) expect(excluded(path)).toBe(false);
});
