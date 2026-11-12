// Tests update packages, local-edit preservation and exact rollback.
// Restricted runners may deny ownership changes even as root.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Minimal runners may provide POSIX awk as mawk without an awk alias.
const originalPath = process.env.PATH;
const mawk = !Bun.which("awk") && Bun.which("mawk");
const runtimeBin = mawk ? mkdtempSync(join(tmpdir(), "update-letter-runtime-")) : undefined;
if (runtimeBin && mawk) {
  symlinkSync(mawk, join(runtimeBin, "awk"));
  process.env.PATH = `${runtimeBin}:${originalPath ?? ""}`;
}
afterAll(() => {
  if (runtimeBin) {
    process.env.PATH = originalPath;
    rmSync(runtimeBin, { recursive: true, force: true });
  }
});

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function run(args: string[], cwd: string, env?: Record<string, string | undefined>) {
  return Bun.spawnSync(args, { cwd, env: { ...process.env, EMBERVY_HOME: undefined, EMBERVY_PRIVATE_OLD_NAMES: join(cwd, ".missing-private-old-names"), ...env }, stdout: "pipe", stderr: "pipe" });
}

function git(repo: string, ...args: string[]): string {
  const result = run(["git", ...args], repo);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function put(root: string, path: string, content: string, mode?: number): void {
  const full = join(root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  if (mode !== undefined) chmodSync(full, mode);
}

function fixtureRepo(): { repo: string; from: string; to: string } {
  const repo = temp("update-letter-repo-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test Builder");
  for (const path of ["replace.txt", "already.txt", "diverged.txt", "deleted.txt"]) put(repo, path, `old ${path}\n`);
  put(repo, "Brain/private.txt", "old brain\n");
  put(repo, "shared/tools/installer/internal.txt", "old installer\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const from = git(repo, "rev-parse", "HEAD");
  for (const path of ["replace.txt", "already.txt", "diverged.txt"]) put(repo, path, `new ${path}\n`);
  rmSync(join(repo, "deleted.txt"));
  put(repo, "neighbours/example.txt", "payload\n");
  put(repo, "new/deep/file.txt", "deep payload\n");
  put(repo, "Brain/private.txt", "new brain\n");
  put(repo, "shared/tools/installer/internal.txt", "new installer\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "target");
  return { repo, from, to: git(repo, "rev-parse", "HEAD") };
}

function build(repo: string, from: string, to: string, out: string, extra: string[] = [], env: Record<string, string | undefined> = {}, house = "brain") {
  const builder = join(import.meta.dir, "build.ts");
  const result = run(["bun", builder, "--from", from, "--to", to, "--house", house, "--out", out, ...extra], repo, env);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result;
}

function listing(root: string): string[] {
  const rows: string[] = [];
  function walk(relative: string): void {
    const full = relative ? join(root, relative) : root;
    for (const name of readdirSync(full).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(join(root, path));
      const metadata = `${stat.uid}:${stat.gid}:${(stat.mode & 0o7777).toString(8)}`;
      if (stat.isDirectory()) {
        rows.push(`d ${metadata} ${path}`);
        walk(path);
      } else if (stat.isSymbolicLink()) {
        rows.push(`l ${metadata} ${readlinkSync(join(root, path))} ${path}`);
      } else {
        const hash = createHash("sha256").update(readFileSync(join(root, path))).digest("hex");
        rows.push(`f ${metadata} ${hash} ${path}`);
      }
    }
  }
  walk("");
  return rows;
}

function mergeFixture(base: string, upstream: string, resident: string, path = "file.txt") {
  const repo = temp("update-letter-merge-repo-");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Test Builder");
  put(repo, path, base);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const from = git(repo, "rev-parse", "HEAD");
  put(repo, path, upstream);
  git(repo, "commit", "-qam", "update");
  const to = git(repo, "rev-parse", "HEAD");
  const letter = temp("update-letter-merge-output-");
  const house = temp("update-letter-merge-house-");
  // Working-tree edits must not leak into either committed payload version.
  put(repo, path, "uncommitted bytes\n");
  build(repo, from, to, letter);
  put(house, path, resident, 0o640);
  return { repo, from, to, letter, house };
}

function operation(letter: string, house: string, name: string, env: Record<string, string> = {}) {
  const result = run(["bash", join(letter, "update.sh"), "--home", house, name], letter, env);
  if (result.exitCode !== 0) throw new Error(`${name}: ${result.stderr.toString()}\n${result.stdout.toString()}`);
  return result.stdout.toString();
}

const baseText = "first\nsecond\nthird\nfourth\nfifth\n";
const upstreamText = "first\nsecond\nthird\nfourth\nupstream fifth\n";
const residentText = "resident first\nsecond\nthird\nfourth\nfifth\n";

describe("update letter", () => {
  test.each([true, false])("new TypeScript files use a same-extension neighbour or 0644 (mixed=%s)", (mixed) => {
    const { repo } = fixtureRepo();
    const from = git(repo, "rev-parse", "HEAD");
    put(repo, "mixed/new.test.ts", "new test\n");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "add test");
    const house = temp("update-letter-metadata-house-");
    const letter = temp("update-letter-metadata-letter-");
    put(house, "mixed/run.sh", "script\n", 0o755);
    if (mixed) put(house, "mixed/existing.ts", "neighbour\n", 0o644);
    const reference = join(house, mixed ? "mixed/existing.ts" : "mixed");
    if (process.getuid?.() === 0) {
      try { chownSync(reference, 1001, 1002); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
    const owner = lstatSync(reference);
    build(repo, from, git(repo, "rev-parse", "HEAD"), letter);
    const before = listing(house);
    operation(letter, house, "apply");
    const added = lstatSync(join(house, "mixed/new.test.ts"));
    expect(added.mode & 0o7777).toBe(0o644);
    expect([added.uid, added.gid]).toEqual([owner.uid, owner.gid]);
    operation(letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test.each(["replace", "merge-clean", "diverged"])("UPDATE requires resolving a critical server file (%s)", (state) => {
    const resident = state === "replace" ? baseText : state === "merge-clean" ? residentText : "conflicting server\n";
    const { letter, house } = mergeFixture(baseText, upstreamText, resident, "Claude/app/server.ts");
    expect(operation(letter, house, "check")).toContain(`${state} Claude/app/server.ts`);
    const text = readFileSync(join(letter, "UPDATE.md"), "utf8");
    expect(text).toContain("## Must resolve before reporting applied");
    expect(text).toContain('`Claude/app/server.ts`: any `.embervy-merged` or `diverged` state must be resolved in the live file before reporting "applied".');
    expect(text).toContain("TERMINAL_TMUX_SOCKET");
    expect(text).toContain("old socket");
  });

  test("UPDATE does not require resolving critical files absent from this letter or deleted upstream", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-no-critical-");
    build(repo, from, to, letter);
    expect(readFileSync(join(letter, "UPDATE.md"), "utf8")).not.toContain("## Must resolve");
    put(repo, "Claude/app/server.ts", "server\n");
    git(repo, "add", "-A"); git(repo, "commit", "-qm", "server base");
    const base = git(repo, "rev-parse", "HEAD");
    rmSync(join(repo, "Claude/app/server.ts"));
    git(repo, "commit", "-qam", "remove server");
    build(repo, base, git(repo, "rev-parse", "HEAD"), letter);
    expect(readFileSync(join(letter, "UPDATE.md"), "utf8")).not.toContain("## Must resolve");
  });
  for (const verb of ["check", "apply", "take", "back"]) {
    test(`${verb} rejects an ambient other house before reading any artifacts or house`, () => {
      const { repo, from, to } = fixtureRepo();
      const letter = temp("update-letter-home-guard-");
      const house = temp("update-letter-intended-");
      const other = temp("update-letter-other-");
      build(repo, from, to, letter, ["--home-default", house]);
      // Missing inputs distinguish the routing guard from later validation failures.
      rmSync(house, { recursive: true });
      for (const path of ["manifest.txt", "known.txt", "files.tar.gz"]) rmSync(join(letter, path));
      const before = listing(letter);
      const otherBefore = listing(other);
      const result = run(["bash", "update.sh", verb, ...(verb === "take" ? ["replace.txt"] : [])], letter, { EMBERVY_HOME: other });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe(`house: ${house} (built for this house)\n`);
      expect(result.stderr.toString()).toBe(`error: EMBERVY_HOME=${other} differs from chosen house ${house}; pass --home <dir> if the other folder is the house meant.\n`);
      expect(listing(letter)).toEqual(before);
      expect(listing(other)).toEqual(otherBefore);
      expect(existsSync(house)).toBe(false);
    });
  }

  test("an explicitly empty EMBERVY_HOME is a conflicting set value", () => {
    const { repo, from, to } = fixtureRepo();
    const house = temp("update-letter-empty-env-house-");
    const letter = temp("update-letter-empty-env-");
    build(repo, from, to, letter, ["--home-default", house]);
    for (const verb of ["check", "apply", "take", "back"]) {
      const result = run(["bash", "update.sh", verb], letter, { EMBERVY_HOME: "" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString()).toBe(`house: ${house} (built for this house)\n`);
      expect(result.stderr.toString()).toContain(`EMBERVY_HOME= differs from chosen house ${house}; pass --home <dir>`);
      expect(listing(house)).toEqual([]);
      expect(existsSync(join(letter, "backup"))).toBe(false);
    }
  });

  for (const ambient of ["unset", "same"]) {
    test(`all verbs use the built home with EMBERVY_HOME ${ambient}`, () => {
      const { repo, from, to, letter, house } = mergeFixture(baseText, upstreamText, residentText);
      const other = temp("update-letter-unselected-");
      build(repo, from, to, letter, ["--home-default", house]);
      const before = listing(house);
      const env = { EMBERVY_HOME: ambient === "same" ? house : undefined };
      for (const args of [["check"], ["apply"], ["take", "file.txt"], ["back"]]) {
        const result = run(["bash", "update.sh", ...args], letter, env);
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString().split("\n")[0]).toBe(`house: ${house} (built for this house)`);
      }
      expect(listing(house)).toEqual(before);
      expect(listing(other)).toEqual([]);
      const text = readFileSync(join(letter, "UPDATE.md"), "utf8");
      expect(text).toContain("--home <dir>");
      expect(text).toContain("EMBERVY_HOME");
      expect(text).toContain("bun test ./shared/tools/x.test.ts");
    });
  }

  test("explicit --home selects the other house for every verb and overrides ambient routing", () => {
    const { repo, from, to, letter, house } = mergeFixture(baseText, upstreamText, residentText);
    const other = join(temp("update-letter-explicit-"), "other ' house");
    mkdirSync(other);
    put(other, "file.txt", residentText, 0o604);
    build(repo, from, to, letter, ["--home-default", house]);
    const before = listing(house);
    const otherBefore = listing(other);
    for (const args of [["check"], ["apply"], ["take", "file.txt"], ["back"]]) {
      const command = args[0] === "take" ? ["--home", other, ...args] : [...args, "--home", other];
      const result = run(["bash", "update.sh", ...command], letter, { EMBERVY_HOME: args[0] === "take" ? other : house });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString().split("\n")[0]).toBe(`house: ${other} (--home)`);
      expect(listing(house)).toEqual(before);
      if (args[0] === "take") expect(readFileSync(join(other, "file.txt"), "utf8")).toContain("upstream fifth");
    }
    expect(listing(other)).toEqual(otherBefore);
  });

  test("take and back refuse a backup bound to another explicitly selected house", () => {
    const { repo, from, to, letter, house } = mergeFixture(baseText, upstreamText, residentText);
    const other = temp("update-letter-bound-other-");
    build(repo, from, to, letter, ["--home-default", house]);
    operation(letter, house, "apply");
    const before = listing(house);
    const journal = listing(letter);
    for (const args of [["take", "file.txt"], ["back"]]) {
      const result = run(["bash", "update.sh", ...args, "--home", other], letter);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout.toString().split("\n")[0]).toBe(`house: ${other} (--home)`);
      expect(result.stderr.toString()).toContain("backup belongs to a different house");
      expect(listing(house)).toEqual(before);
      expect(listing(letter)).toEqual(journal);
      expect(listing(other)).toEqual([]);
    }
    operation(letter, house, "back");
  });

  test("archived test backups are invisible to Bun name filters and restore exact files and metadata", () => {
    const { repo } = fixtureRepo();
    const paths = ["shared/tools/x.test.ts", "shared/tools/y.test.js", "shared/tools/z.spec.ts", "shared/tools/test_saved.py"];
    const old = "throw new Error('saved tests must not run');\n\0original bytes\n";
    for (const path of paths) put(repo, path, old);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "test fixture base");
    const from = git(repo, "rev-parse", "HEAD");
    for (const path of paths) put(repo, path, "updated bytes\n");
    put(repo, "created/deep/absent.test.ts", "new bytes\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "test fixture update");
    const house = temp("update-letter-runner-house-");
    const letter = join(house, "state/updates/letter");
    build(repo, from, git(repo, "rev-parse", "HEAD"), letter, ["--home-default", house]);
    for (const path of paths) {
      put(house, path, old, 0o640);
      if (process.getuid?.() === 0) {
        try { chownSync(join(house, path), 1001, 1002); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
        }
      }
    }
    // The journal intentionally remains in state; compare the restored house payload.
    const payloadListing = () => listing(house).filter(row => !/ state(?:\/|$)/.test(row));
    const before = payloadListing();
    operation(letter, house, "apply");
    const backup = listing(join(letter, "backup"));
    expect(backup.filter(row => /(?:\.test\.(?:ts|js)$|\.spec\.[^/]*$|\/test_[^/]*\.py$)/.test(row))).toEqual([]);
    expect(existsSync(join(letter, "backup/files.tar"))).toBe(true);
    expect(existsSync(join(letter, "backup/files"))).toBe(false);
    const filtered = run(["bun", "test", "state/updates/letter"], house);
    expect(filtered.exitCode).not.toBe(0);
    expect(filtered.stdout.toString() + filtered.stderr.toString()).toMatch(/(?:No tests|No test files|did not match any test files)/i);
    operation(letter, house, "back");
    expect(payloadListing()).toEqual(before);
    expect(existsSync(join(house, "created"))).toBe(false);
    expect(listing(join(letter, "backup.after-back")).filter(row => /(?:\.test\.(?:ts|js)$|\.spec\.[^/]*$|\/test_[^/]*\.py$)/.test(row))).toEqual([]);
  });

  test("documentation uses explicit Bun test paths instead of accidental name filters", () => {
    const docs = join(import.meta.dir, "../../..", "docs");
    const offenders: string[] = [];
    function inspect(dir: string): void {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) inspect(path);
        else if (/\.(?:md|html|txt)$/.test(entry.name)) {
          readFileSync(path, "utf8").split("\n").forEach((line, i) => {
            const command = line.match(/\bbun test\s+([^`<\n]+)/);
            if (command && command[1].split(/\s+/).some(arg => !/^(?:\.\/|\/|-)/.test(arg) && /(?:\/|\.(?:test|spec)\.)/.test(arg))) offenders.push(`${path}:${i + 1}: ${line.trim()}`);
          });
        }
      }
    }
    inspect(docs);
    expect(offenders).toEqual([]);
  });

  test("a simulated take is kept, check is read-only, and apply writes no sidecars", () => {
    const combined = "resident first\nsecond\nthird\nfourth\nupstream fifth\n";
    const { letter, house } = mergeFixture(baseText, upstreamText, combined);
    const before = listing(house);
    const letterBefore = listing(letter);
    const scratch = temp("update-letter-kept-scratch-");
    const check = operation(letter, house, "check", { TMPDIR: scratch });
    expect(check).toContain("kept file.txt — your file already contains this update\n");
    expect(check).toContain("summary: replace=0 already=0 kept=1 new=0 merge-clean=0 diverged=0 deleted-upstream=0");
    expect(listing(house)).toEqual(before);
    expect(listing(letter)).toEqual(letterBefore);
    expect(listing(scratch)).toEqual([]);
    const apply = operation(letter, house, "apply");
    expect(apply).toContain("summary: replace=0 already=0 kept=1 new=0 merged=0 diverged=0 deleted-upstream=0");
    expect(listing(house)).toEqual(before);
    expect(readFileSync(join(letter, "backup/touched.txt"), "utf8")).toBe("");
    for (const suffix of [".embervy-merged", ".embervy-new", ".embervy-base"]) {
      expect(existsSync(join(house, `file.txt${suffix}`))).toBe(false);
    }
    operation(letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test("take followed by check reports kept, never diverged", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, residentText);
    operation(letter, house, "apply");
    const taken = run(["bash", join(letter, "update.sh"), "--home", house, "take", "file.txt"], house);
    expect(taken.exitCode).toBe(0);
    const before = listing(house);
    const check = operation(letter, house, "check");
    expect(check).toContain("kept file.txt — your file already contains this update\n");
    expect(check).toContain("kept=1 new=0 merge-clean=0 diverged=0");
    expect(check).not.toContain("diverged file.txt");
    expect(listing(house)).toEqual(before);
  });

  test("a house that made the same change by hand keeps its own additions", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, "house heading\n" + upstreamText);
    const before = listing(house);
    expect(operation(letter, house, "check")).toContain("kept file.txt — your file already contains this update\n");
    expect(operation(letter, house, "apply")).toContain("kept=1 new=0 merged=0 diverged=0");
    expect(listing(house)).toEqual(before);
  });

  test("byte-identical files remain already, not kept", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, upstreamText);
    expect(operation(letter, house, "check")).toContain("already=1 kept=0");
    expect(operation(letter, house, "apply")).toContain("already=1 kept=0");
    expect(readFileSync(join(letter, "backup/touched.txt"), "utf8")).toBe("");
  });

  test("an identical edit does not hide a real conflict elsewhere", () => {
    const upstream = "same first\nsecond\nthird\nfourth\nupstream fifth\n";
    const resident = "same first\nsecond\nthird\nfourth\nresident fifth\n";
    const { letter, house } = mergeFixture(baseText, upstream, resident);
    const check = operation(letter, house, "check");
    expect(check).toContain("diverged file.txt");
    expect(check).toContain("kept=0 new=0 merge-clean=0 diverged=1");
    operation(letter, house, "apply");
    expect(readFileSync(join(house, "file.txt"), "utf8")).toBe(resident);
    expect(readFileSync(join(house, "file.txt.embervy-new"), "utf8")).toBe(upstream);
    expect(existsSync(join(house, "file.txt.embervy-merged"))).toBe(false);
  });

  for (const path of ["sw.js", "index.html", "Claude/app/public/sw.js", "Claude/app/public/index.html", "file.txt", "app.js", "style.css"]) {
    for (const state of ["diverged", "merge-clean", "kept", "already", "replace", "new"]) {
      test(`version reminder for ${state} ${path}`, () => {
        const resident = state === "diverged" ? "resident fifth\n"
          : state === "already" ? upstreamText
          : state === "replace" ? baseText
          : state === "kept" ? "house heading\n" + upstreamText : residentText;
        const { letter, house } = mergeFixture(baseText, upstreamText, resident, path);
        if (state === "new") rmSync(join(house, path));
        const expected = ["diverged", "merge-clean"].includes(state) && ["sw.js", "index.html"].includes(path.split("/").pop()!);
        const hint = `versions ${path} — keep your asset versions and service-worker cache number above the letter's, with a house suffix (for example ?v=115-h1 and embervy-v30-h1), so phones fetch the new files.`;
        for (const name of ["check", "apply"]) {
          const output = operation(letter, house, name);
          if (name === "check") expect(output).toContain(`${state} ${path}`);
          expect(output.split("\n").filter(line => line.startsWith("versions "))).toEqual(expected ? [hint] : []);
        }
      });
    }
  }

  test("merges separate edits, checks without writes, and restores exact resident bytes and metadata", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, residentText);
    const before = listing(house);
    const letterBefore = listing(letter);
    const scratch = temp("update-letter-check-scratch-");
    const check = operation(letter, house, "check", { TMPDIR: scratch });
    expect(check).toContain("merge-clean file.txt");
    expect(check).toContain("merge-clean=1 diverged=0");
    expect(listing(house)).toEqual(before);
    expect(listing(letter)).toEqual(letterBefore);
    expect(listing(scratch)).toEqual([]);
    expect(existsSync(join(letter, "backup"))).toBe(false);
    const owner = lstatSync(join(house, "file.txt"));
    const apply = operation(letter, house, "apply");
    expect(apply).toContain("left file.txt.embervy-merged");
    expect(apply).toContain("merged=1 diverged=0");
    expect(readFileSync(join(house, "file.txt"), "utf8")).toBe(residentText);
    expect(readFileSync(join(house, "file.txt.embervy-merged"), "utf8")).toBe("resident first\nsecond\nthird\nfourth\nupstream fifth\n");
    const taken = run(["bash", join(letter, "update.sh"), "--home", house, "take", "file.txt"], house);
    expect(taken.exitCode).toBe(0);
    expect(readFileSync(join(house, "file.txt"), "utf8")).toBe("resident first\nsecond\nthird\nfourth\nupstream fifth\n");
    const merged = lstatSync(join(house, "file.txt"));
    expect([merged.uid, merged.gid, merged.mode]).toEqual([owner.uid, owner.gid, owner.mode]);
    const saved = run(["tar", "-xOf", join(letter, "backup/files.tar"), "--", "file.txt"], letter);
    expect(saved.exitCode).toBe(0);
    expect(saved.stdout.toString()).toBe(residentText);
    expect(readFileSync(join(letter, "backup/touched.txt"), "utf8")).toBe("file.txt.embervy-merged\nfile.txt\n");
    expect(existsSync(join(house, "file.txt.embervy-new"))).toBe(false);
    operation(letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test("overlapping edits keep the resident file and provide both committed sidecars", () => {
    const { letter, house } = mergeFixture("base\n", "upstream\n", "resident\n");
    const before = listing(house);
    expect(operation(letter, house, "check")).toContain("merge-clean=0 diverged=1");
    const apply = operation(letter, house, "apply");
    expect(apply).toContain("merged=0 diverged=1");
    expect(readFileSync(join(house, "file.txt"), "utf8")).toBe("resident\n");
    expect(readFileSync(join(house, "file.txt.embervy-new"), "utf8")).toBe("upstream\n");
    expect(readFileSync(join(house, "file.txt.embervy-base"), "utf8")).toBe("base\n");
    expect(apply).toContain("diff -u file.txt.embervy-base file.txt.embervy-new");
    expect(readFileSync(join(letter, "backup/touched.txt"), "utf8")).toBe("file.txt.embervy-new\nfile.txt.embervy-base\n");
    operation(letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test("without diff3 even separate edits use sidecars without error", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, residentText);
    const tools = temp("update-letter-no-diff3-");
    for (const name of ["bash", "dirname", "sha256sum", "awk", "mktemp", "mkdir", "tar", "gzip", "rm", "cat", "find", "chown", "chmod", "mv", "cp", "basename", "tac", "rmdir"]) {
      const executable = name === "awk" && mawk ? mawk : Bun.which(name);
      if (!executable) throw new Error(`required test utility missing: ${name}`);
      symlinkSync(executable, join(tools, name));
    }
    const env = { PATH: tools };
    const before = listing(house);
    expect(operation(letter, house, "check", env)).toContain("merge-clean=0 diverged=1");
    expect(operation(letter, house, "apply", env)).toContain("merged=0 diverged=1");
    expect(readFileSync(join(house, "file.txt"), "utf8")).toBe(residentText);
    expect(readFileSync(join(house, "file.txt.embervy-base"), "utf8")).toBe(baseText);
    expect(readFileSync(join(house, "file.txt.embervy-new"), "utf8")).toBe(upstreamText);
    operation(letter, house, "back", env);
    expect(listing(house)).toEqual(before);
  });

  for (const binary of ["house", "base", "new"]) {
    test(`NUL in ${binary} prevents any merge attempt`, () => {
      const base = binary === "base" ? `${baseText}\0` : baseText;
      const upstream = binary === "new" ? `${upstreamText}\0` : upstreamText;
      const resident = binary === "house" ? `${residentText}\0` : residentText;
      const { letter, house } = mergeFixture(base, upstream, resident);
      const before = listing(house);
      const tools = temp("update-letter-diff3-spy-");
      put(tools, "diff3", '#!/usr/bin/env bash\nprintf attempted > "$MERGE_SPY"\nexit 0\n', 0o755);
      const spy = join(tools, "called");
      const env = { PATH: `${tools}:${process.env.PATH}`, MERGE_SPY: spy };
      expect(operation(letter, house, "check", env)).toContain("merge-clean=0 diverged=1");
      expect(operation(letter, house, "apply", env)).toContain("merged=0 diverged=1");
      expect(existsSync(spy)).toBe(false);
      expect(readFileSync(join(house, "file.txt"), "utf8")).toBe(resident);
      expect(readFileSync(join(house, "file.txt.embervy-base"), "utf8")).toBe(base);
      expect(readFileSync(join(house, "file.txt.embervy-new"), "utf8")).toBe(upstream);
      operation(letter, house, "back");
      expect(listing(house)).toEqual(before);
    });
  }

  test("builder refuses sidecar collisions, including unchanged repository files", () => {
    for (const suffix of [".embervy-base", ".embervy-new", ".embervy-merged"]) {
      const { repo, from, to } = fixtureRepo();
      put(repo, `replace.txt${suffix}`, "resident repository path\n");
      git(repo, "add", "-A");
      git(repo, "commit", "-qm", "sidecar collision");
      const collided = git(repo, "rev-parse", "HEAD");
      const out = temp("update-letter-collision-");
      const invoke = (start: string, end: string) => run(["bun", join(import.meta.dir, "build.ts"), "--from", start, "--to", end, "--house", "brain", "--out", out], repo);
      const changed = invoke(from, collided);
      expect(changed.exitCode).not.toBe(0);
      expect(changed.stderr.toString()).toContain(`sidecar conflicts with repository path: replace.txt${suffix}`);
      put(repo, "replace.txt", "another update\n");
      git(repo, "commit", "-qam", "change beside unchanged sidecar");
      expect(invoke(collided, git(repo, "rev-parse", "HEAD")).exitCode).not.toBe(0);
    }
  });

  test("a merge tool error never installs its output or touches the resident file", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, residentText);
    const before = listing(house);
    const tools = temp("update-letter-diff3-error-");
    put(tools, "diff3", '#!/usr/bin/env bash\nprintf "unsafe output\\n"\nexit 2\n', 0o755);
    const env = { PATH: `${tools}:${process.env.PATH}` };
    expect(operation(letter, house, "check", env)).toContain("merge-clean=0 diverged=1");
    expect(operation(letter, house, "apply", env)).toContain("merged=0 diverged=1");
    expect(readFileSync(join(house, "file.txt"), "utf8")).toBe(residentText);
    expect(readFileSync(join(house, "file.txt.embervy-base"), "utf8")).toBe(baseText);
    expect(readFileSync(join(house, "file.txt.embervy-new"), "utf8")).toBe(upstreamText);
    operation(letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test("a base-sidecar directory is refused before any write or backup", () => {
    const { letter, house } = mergeFixture("base\n", "upstream\n", "resident\n");
    put(house, "file.txt.embervy-base/keep", "resident directory\n");
    const before = listing(house);
    const result = run(["bash", join(letter, "update.sh"), "--home", house, "apply"], letter);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("destination is a directory: file.txt.embervy-base");
    expect(listing(house)).toEqual(before);
    expect(existsSync(join(letter, "backup"))).toBe(false);
  });

  test("new upstream paths have no base, and a resident collision stays untouched", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-new-collision-");
    const house = temp("update-letter-new-collision-house-");
    build(repo, from, to, letter);
    put(house, "neighbours/example.txt", "resident owns this path\n");
    const before = listing(house);
    expect(operation(letter, house, "check")).toContain("diverged neighbours/example.txt");
    const apply = operation(letter, house, "apply");
    expect(apply).toContain("base unavailable for neighbours/example.txt");
    expect(readFileSync(join(house, "neighbours/example.txt"), "utf8")).toBe("resident owns this path\n");
    expect(readFileSync(join(house, "neighbours/example.txt.embervy-new"), "utf8")).toBe("payload\n");
    expect(readFileSync(join(house, "neighbours/example.txt.embervy-base"), "utf8")).toBe("");
    operation(letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test("corrupt base bytes fail validation before house writes or backup creation", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, residentText);
    const stage = temp("update-letter-base-corrupt-");
    expect(run(["tar", "-xzf", join(letter, "files.tar.gz"), "-C", stage], letter).exitCode).toBe(0);
    put(stage, "file.txt.embervy-base", "corrupt\n");
    expect(run(["tar", "-czf", join(letter, "files.tar.gz"), "-C", stage, "."], letter).exitCode).toBe(0);
    const before = listing(house);
    for (const name of ["check", "apply"]) {
      const result = run(["bash", join(letter, "update.sh"), "--home", house, name], letter);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("base hash mismatch: file.txt");
      expect(listing(house)).toEqual(before);
      expect(existsSync(join(letter, "backup"))).toBe(false);
    }
  });

  test("missing base leaves resident bytes untouched and labels the placeholder honestly", () => {
    const { letter, house } = mergeFixture(baseText, upstreamText, residentText);
    const stage = temp("update-letter-base-missing-");
    expect(run(["tar", "-xzf", join(letter, "files.tar.gz"), "-C", stage], letter).exitCode).toBe(0);
    rmSync(join(stage, "file.txt.embervy-base"));
    expect(run(["tar", "-czf", join(letter, "files.tar.gz"), "-C", stage, "."], letter).exitCode).toBe(0);
    const before = listing(house);
    expect(operation(letter, house, "check")).toContain("merge-clean=0 diverged=1");
    expect(operation(letter, house, "apply")).toContain("empty placeholder, not the original");
    expect(readFileSync(join(house, "file.txt"), "utf8")).toBe(residentText);
    expect(readFileSync(join(house, "file.txt.embervy-base"), "utf8")).toBe("");
    expect(readFileSync(join(house, "file.txt.embervy-new"), "utf8")).toBe(upstreamText);
    operation(letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test("builds the installed file set and applies every state without overwriting divergence", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-output-");
    build(repo, from, to, letter);
    const manifest = readFileSync(join(letter, "manifest.txt"), "utf8");
    expect(manifest).toContain(" replace.txt\n");
    expect(manifest).not.toContain("shared/tools/installer");
    const letterText = readFileSync(join(letter, "UPDATE.md"), "utf8");
    expect(letterText).toContain("## What changes and why");
    expect(letterText).toContain(`${from}\` → \`${to}`);
    expect(letterText).toContain("### neighbours");
    const archive = run(["tar", "-tzf", join(letter, "files.tar.gz")], repo);
    expect(archive.exitCode).toBe(0);
    expect(archive.stdout.toString()).toContain("./replace.txt");
    expect(archive.stdout.toString()).not.toContain("deleted.txt");
    expect(archive.stdout.toString()).toContain("./replace.txt.embervy-base");
    expect(archive.stdout.toString()).not.toContain("./neighbours/example.txt.embervy-base");

    const house = temp("update-letter-house-");
    put(house, "replace.txt", "old replace.txt\n", 0o640);
    put(house, "already.txt", "new already.txt\n", 0o600);
    put(house, "diverged.txt", "agent version\n", 0o644);
    put(house, "deleted.txt", "old deleted.txt\n", 0o620);
    put(house, "neighbours/keep.txt", "neighbour\n", 0o604);
    put(house, "diverged.txt.embervy-new", "previous merge candidate\n", 0o610);
    if (process.getuid?.() === 0) {
      try {
        chownSync(join(house, "replace.txt"), 1001, 1002);
        chownSync(join(house, "neighbours/keep.txt"), 1003, 1004);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
    chmodSync(join(house, "replace.txt"), 0o4750);
    const modeProbe = join(house, "mode-probe");
    put(house, "mode-probe", "probe\n");
    run(["chmod", `--reference=${join(house, "replace.txt")}`, modeProbe], house);
    const specialModesSupported = (lstatSync(modeProbe).mode & 0o7777) === 0o4750;
    rmSync(modeProbe);
    // Some restricted runners strip special bits from external chmod calls.
    if (!specialModesSupported) chmodSync(join(house, "replace.txt"), 0o750);
    const replaceOwner = lstatSync(join(house, "replace.txt"));
    const neighbourOwner = lstatSync(join(house, "neighbours/keep.txt"));
    const before = listing(house);

    let moved = join(temp("update-letter-moved-parent-"), "letter");
    renameSync(letter, moved);
    const check = run(["bash", join(moved, "update.sh"), "--home", house, "check"], moved);
    if (check.exitCode !== 0) throw new Error(check.stderr.toString() || check.stdout.toString());
    expect(listing(house)).toEqual(before);
    expect(existsSync(join(moved, "backup"))).toBe(false);
    const states = check.stdout.toString();
    expect(states).toContain("new Brain/private.txt — missing in house, will be added");
    for (const expected of ["replace replace.txt", "already already.txt", "new neighbours/example.txt", "diverged diverged.txt", "deleted-upstream deleted.txt"]) expect(states).toContain(expected);

    const apply = run(["bash", join(moved, "update.sh"), "--home", house, "apply"], moved);
    if (apply.exitCode !== 0) throw new Error(`apply failed: ${apply.stderr.toString()}\n${apply.stdout.toString()}`);
    expect(readFileSync(join(house, "replace.txt"), "utf8")).toBe("new replace.txt\n");
    const replaced = lstatSync(join(house, "replace.txt"));
    expect(replaced.mode & 0o7777).toBe(replaceOwner.mode & 0o7777);
    expect([replaced.uid, replaced.gid]).toEqual([replaceOwner.uid, replaceOwner.gid]);
    expect(readFileSync(join(house, "already.txt"), "utf8")).toBe("new already.txt\n");
    expect(readFileSync(join(house, "diverged.txt"), "utf8")).toBe("agent version\n");
    expect(readFileSync(join(house, "diverged.txt.embervy-new"), "utf8")).toBe("new diverged.txt\n");
    expect(readFileSync(join(house, "deleted.txt"), "utf8")).toBe("old deleted.txt\n");
    expect(readFileSync(join(house, "neighbours/example.txt"), "utf8")).toBe("payload\n");
    const added = lstatSync(join(house, "neighbours/example.txt"));
    expect(added.mode & 0o7777).toBe(0o604);
    expect([added.uid, added.gid]).toEqual([neighbourOwner.uid, neighbourOwner.gid]);
    expect(readFileSync(join(house, "new/deep/file.txt"), "utf8")).toBe("deep payload\n");
    expect(readFileSync(join(house, "diverged.txt.embervy-base"), "utf8")).toBe("old diverged.txt\n");
    expect(apply.stdout.toString()).toContain("diff -u diverged.txt.embervy-base diverged.txt.embervy-new shows exactly what the update changes; carry that into your version.");
    expect(apply.stdout.toString()).toContain("merged=0 diverged=1");

    const second = run(["bash", join(moved, "update.sh"), "--home", house, "apply"], moved);
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr.toString()).toContain("backup already exists");

    const nextLocation = join(temp("update-letter-second-move-"), "letter with spaces");
    renameSync(moved, nextLocation);
    moved = nextLocation;
    const back = run(["bash", join(moved, "update.sh"), "--home", house, "back"], repo);
    expect(back.exitCode).toBe(0);
    expect(listing(house)).toEqual(before);
    expect(existsSync(join(moved, "backup"))).toBe(false);
    expect(existsSync(join(moved, "backup.after-back"))).toBe(true);
  });

  test("backs up the full touch set before writing and restores after a partial failure", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-failure-");
    const house = temp("update-letter-failure-house-");
    build(repo, from, to, letter);
    put(house, "Brain/private.txt", "old brain\n", 0o640);
    put(house, "replace.txt", "old replace.txt\n", 0o600);
    put(house, "already.txt", "new already.txt\n", 0o604);
    put(house, "diverged.txt", "agent version\n", 0o644);
    put(house, "deleted.txt", "old deleted.txt\n", 0o620);
    const before = listing(house);
    const tools = temp("update-letter-fake-tools-");
    put(tools, "mv", `#!/usr/bin/env bash
set -eu
[[ "$(wc -l < "$LETTER/backup/touched.txt")" == 6 ]] || exit 91
tar -tf "$LETTER/backup/files.tar" | grep -Fxq replace.txt || exit 92
if [[ -e "$COUNTER" ]]; then echo 'injected write failure' >&2; exit 93; fi
: > "$COUNTER"
exec /usr/bin/mv "$@"
`, 0o755);
    const failed = run(["bash", join(letter, "update.sh"), "--home", house, "apply"], repo, {
      EMBERVY_HOME: house, LETTER: letter, COUNTER: join(tools, "counter"), PATH: `${tools}:${process.env.PATH}`,
    });
    expect(failed.exitCode).toBe(93);
    expect(failed.stderr.toString()).toContain("injected write failure");
    expect(readFileSync(join(house, "Brain/private.txt"), "utf8")).toBe("new brain\n");
    const back = run(["bash", join(letter, "update.sh"), "--home", house, "back"], repo);
    expect(back.exitCode).toBe(0);
    expect(listing(house)).toEqual(before);
  });

  test("preserves divergent symlinks and directories and restores an existing sidecar symlink", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-links-");
    const house = temp("update-letter-links-house-");
    const outside = temp("update-letter-outside-");
    build(repo, from, to, letter);
    put(outside, "source", "outside bytes\n", 0o640);
    symlinkSync(join(outside, "source"), join(house, "replace.txt"));
    symlinkSync(join(outside, "source"), join(house, "replace.txt.embervy-new"));
    symlinkSync(join(outside, "source"), join(house, "replace.txt.embervy-base"));
    put(house, "diverged.txt/agent-file", "directory bytes\n");
    const before = listing(house);
    const apply = run(["bash", join(letter, "update.sh"), "--home", house, "apply"], repo);
    if (apply.exitCode !== 0) throw new Error(apply.stderr.toString());
    expect(lstatSync(join(house, "replace.txt")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(house, "replace.txt.embervy-new")).isFile()).toBe(true);
    expect(lstatSync(join(house, "replace.txt.embervy-base")).isFile()).toBe(true);
    expect(readFileSync(join(outside, "source"), "utf8")).toBe("outside bytes\n");
    expect(readFileSync(join(house, "diverged.txt/agent-file"), "utf8")).toBe("directory bytes\n");
    expect(run(["bash", join(letter, "update.sh"), "--home", house, "back"], repo).exitCode).toBe(0);
    expect(listing(house)).toEqual(before);
  });

  test("validates payload hashes before modifying the house", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-corrupt-");
    const house = temp("update-letter-corrupt-house-");
    build(repo, from, to, letter);
    put(house, "replace.txt", "old replace.txt\n", 0o640);
    const before = listing(house);
    const manifestPath = join(letter, "manifest.txt");
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, manifest.replace(/([a-f0-9]{64}) (replace.txt)/, `${"0".repeat(64)} $2`));
    const apply = run(["bash", join(letter, "update.sh"), "--home", house, "apply"], repo);
    expect(apply.exitCode).not.toBe(0);
    expect(apply.stderr.toString()).toContain("payload hash mismatch: replace.txt");
    expect(listing(house)).toEqual(before);
    expect(existsSync(join(letter, "backup"))).toBe(false);
  });

  test("quotes the home default and refuses to restore a different house", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-default-");
    const parent = temp("update-letter-default-house-");
    const house = join(parent, "house ' with spaces");
    mkdirSync(house);
    build(repo, from, to, letter, ["--home-default", house]);
    const before = listing(house);
    expect(run(["bash", join(letter, "update.sh"), "check"], repo).exitCode).toBe(0);
    expect(run(["bash", join(letter, "update.sh"), "apply"], repo).exitCode).toBe(0);
    const wrong = run(["bash", join(letter, "update.sh"), "back", "--home", parent], repo, { EMBERVY_HOME: house });
    expect(wrong.exitCode).not.toBe(0);
    expect(wrong.stderr.toString()).toContain("different house");
    expect(run(["bash", join(letter, "update.sh"), "back"], repo).exitCode).toBe(0);
    expect(listing(house)).toEqual(before);
  });

  test("check classifies unsafe parents and apply refuses without writing through them", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-parent-");
    const house = temp("update-letter-parent-house-");
    const outside = temp("update-letter-parent-outside-");
    build(repo, from, to, letter);
    symlinkSync(outside, join(house, "neighbours"));
    const before = listing(house);
    const check = run(["bash", join(letter, "update.sh"), "--home", house, "check"], repo);
    expect(check.exitCode).toBe(0);
    expect(check.stdout.toString()).toContain("diverged neighbours/example.txt");
    const apply = run(["bash", join(letter, "update.sh"), "--home", house, "apply"], repo);
    expect(apply.exitCode).not.toBe(0);
    expect(apply.stderr.toString()).toContain("refusing symlink parent");
    expect(listing(house)).toEqual(before);
    expect(listing(outside)).toEqual([]);
    expect(existsSync(join(letter, "backup"))).toBe(false);
  });

  test("missing base files are added and rolled back, and directories inherit metadata under a restrictive umask", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-inheritance-");
    const house = temp("update-letter-inheritance-house-");
    chmodSync(house, 0o2750);
    if (process.getuid?.() === 0) {
      try {
        chownSync(house, 1001, 1002);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
    // Restore special bits after chown because ownership changes may clear them.
    chmodSync(house, 0o2750);
    const parent = lstatSync(house);
    build(repo, from, to, letter);
    const before = listing(house);
    const check = run(["bash", join(letter, "update.sh"), "--home", house, "check"], repo);
    expect(check.exitCode).toBe(0);
    expect(check.stdout.toString()).toContain("new replace.txt — missing in house, will be added");
    const apply = run(["bash", "-c", 'umask 077; bash "$1" --home "$2" apply', "test", join(letter, "update.sh"), house], repo);
    expect(apply.exitCode).toBe(0);
    expect(readFileSync(join(house, "replace.txt"), "utf8")).toBe("new replace.txt\n");
    for (const path of ["new", "new/deep", "neighbours", "Brain"]) {
      const directory = lstatSync(join(house, path));
      expect([directory.uid, directory.gid, directory.mode & 0o7777]).toEqual([parent.uid, parent.gid, parent.mode & 0o7777]);
    }
    expect(run(["bash", join(letter, "update.sh"), "--home", house, "back"], repo).exitCode).toBe(0);
    expect(existsSync(join(house, "replace.txt"))).toBe(false);
    expect(listing(house)).toEqual(before);
  });

  test("the Brain letter requires the person's word and checks before and after applying", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-permission-");
    build(repo, from, to, letter);
    const text = readFileSync(join(letter, "UPDATE.md"), "utf8");
    expect(text).toContain("## Who applies it");
    expect(text).toContain("On the person's word, the agent");
    expect(text).toContain("then the doctor");
    expect(text).toContain("Never apply without the person's word.");
  });

  test("empty letters still support check, apply and back", () => {
    const { repo, from } = fixtureRepo();
    const letter = temp("update-letter-empty-");
    const house = temp("update-letter-empty-house-");
    build(repo, from, from, letter);
    expect(readFileSync(join(letter, "manifest.txt"), "utf8")).toBe("");
    for (const operation of ["check", "apply", "back", "apply", "back"]) {
      expect(run(["bash", join(letter, "update.sh"), "--home", house, operation], repo).exitCode).toBe(0);
      expect(listing(house)).toEqual([]);
    }
    expect(existsSync(join(letter, "backup.after-back"))).toBe(true);
    expect(existsSync(join(letter, "backup.after-back.1"))).toBe(true);
  });

  test("measurement keeps measured changes and genuinely new files", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-measured-");
    const measured = join(repo, "measurement.txt");
    writeFileSync(measured, "replace.txt\n");
    build(repo, from, to, letter, ["--only-existing", measured]);
    const manifest = readFileSync(join(letter, "manifest.txt"), "utf8");
    expect(manifest).toContain(" replace.txt\n");
    expect(manifest).toContain(" neighbours/example.txt\n");
    expect(manifest).toContain(" new/deep/file.txt\n");
    expect(manifest).not.toContain(" already.txt\n");
    expect(manifest).not.toContain(" deleted.txt\n");
  });

  test("a Claude Code house carries Brain too, as the installer pushes it", () => {
    const { repo, from, to } = fixtureRepo();
    const letter = temp("update-letter-claude-");
    const result = run(["bun", join(import.meta.dir, "build.ts"), "--from", from, "--to", to, "--house", "claude", "--out", letter], repo);
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(letter, "manifest.txt"), "utf8")).toContain("Brain/private.txt");
    const text = readFileSync(join(letter, "UPDATE.md"), "utf8");
    expect(text).toContain("## Who applies it");
    expect(text).toContain("permission check can block");
    expect(text).toContain("! bash update.sh apply");
    expect(text).toContain("before and after, then the doctor");
    expect(text).toContain("Never apply without the person's word.");
  });
});

function privateFixture(base = "embedded PLIMZORBIT identifier\n") {
  const { repo } = fixtureRepo();
  const removed = ["old/PrePlimzorbitPost.txt", "PLIMZORBIT-folder/retired.txt"];
  put(repo, "file.txt", base);
  put(repo, "clean.txt", "safe base\n");
  put(repo, "retired.txt", "ordinary path with PLIMZORBIT content\n");
  for (const path of removed) put(repo, path, "retired content\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "private fixture base");
  const from = git(repo, "rev-parse", "HEAD");
  put(repo, "file.txt", "safe update\n");
  put(repo, "clean.txt", "safe clean update\n");
  for (const path of [...removed, "retired.txt"]) rmSync(join(repo, path));
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "private fixture target");
  const to = git(repo, "rev-parse", "HEAD");
  // The private list belongs to the test's own home, never to the repository.
  const home = temp("update-letter-private-config-");
  const privateFile = join(home, "private.txt");
  writeFileSync(privateFile, "# Fictional private pattern\nfictional-label\tplimzorbit\n");
  const env = { HOME: home, EMBERVY_PRIVATE_OLD_NAMES: privateFile };
  const letter = temp("update-letter-private-output-");
  return { repo, from, to, base, removed, home, privateFile, env, letter };
}

function unpack(letter: string): string {
  const stage = temp("update-letter-private-unpacked-");
  const result = run(["tar", "-xzf", join(letter, "files.tar.gz"), "-C", stage], letter);
  expect(result.exitCode).toBe(0);
  return stage;
}

describe("private names in letters", () => {
  test.each(["brain", "claude"])("%s letters omit unsafe bases and deleted paths from every artifact", house => {
    const f = privateFixture();
    // An explicit override must win even if the default file has other rules.
    put(f.home, ".config/embervy-checks/old-names-private.txt", "other\tunrelated\n");
    put(f.repo, "file.txt", "uncommitted working bytes\n");
    const result = build(f.repo, f.from, f.to, f.letter, [], f.env, house);
    expect(result.stdout.toString()).not.toContain("WARN");
    const stage = unpack(f.letter);
    expect(readFileSync(join(stage, "file.txt"), "utf8")).toBe("safe update\n");
    expect(existsSync(join(stage, "file.txt.embervy-base"))).toBe(false);
    expect(readFileSync(join(stage, "clean.txt.embervy-base"), "utf8")).toBe("safe base\n");
    expect(readFileSync(join(f.letter, "manifest.txt"), "utf8")).toContain(`${createHash("sha256").update(f.base).digest("hex")} `);
    expect(readFileSync(join(f.letter, "manifest.txt"), "utf8")).toContain(" DELETED retired.txt\n");
    const update = readFileSync(join(f.letter, "UPDATE.md"), "utf8");
    expect(update).toContain("`retired.txt` (deleted upstream)");
    expect(update).toContain("2 withdrawn files are not listed and may remain in the house.");
    for (const root of [f.letter, stage]) {
      expect(listing(root).join("\n").toLowerCase()).not.toContain("plimzorbit");
      for (const name of readdirSync(root, { recursive: true }) as string[]) {
        const path = join(root, name);
        if (!lstatSync(path).isFile() || name === "files.tar.gz") continue;
        const contents = readFileSync(path, "utf8").toLowerCase();
        expect(contents).not.toContain("plimzorbit");
        expect(contents).not.toContain("fictional-label");
      }
    }
    expect((result.stdout.toString() + result.stderr.toString()).toLowerCase()).not.toContain("plimzorbit");
  });

  test.each(["edited", "original", "missing"])("a withheld base uses existing house behavior (%s)", state => {
    const f = privateFixture();
    build(f.repo, f.from, f.to, f.letter, [], f.env);
    const house = temp("update-letter-private-house-");
    if (state !== "missing") put(house, "file.txt", state === "edited" ? "resident changes\n" : f.base, 0o640);
    for (const path of [...f.removed, "retired.txt"]) put(house, path, "resident retired file\n");
    const before = listing(house);
    const letterBefore = listing(f.letter);
    const check = operation(f.letter, house, "check");
    expect(check).toContain(`${state === "edited" ? "diverged" : state === "original" ? "replace" : "new"} file.txt`);
    expect(check).toContain("deleted-upstream retired.txt");
    expect(check.toLowerCase()).not.toContain("plimzorbit");
    expect(listing(house)).toEqual(before);
    expect(listing(f.letter)).toEqual(letterBefore);
    const apply = operation(f.letter, house, "apply");
    if (state === "edited") {
      expect(apply).toContain("base unavailable for file.txt");
      expect(apply).toContain("empty placeholder, not the original");
      expect(readFileSync(join(house, "file.txt"), "utf8")).toBe("resident changes\n");
      expect(readFileSync(join(house, "file.txt.embervy-new"), "utf8")).toBe("safe update\n");
      expect(readFileSync(join(house, "file.txt.embervy-base"), "utf8")).toBe("");
      expect(existsSync(join(house, "file.txt.embervy-merged"))).toBe(false);
    } else {
      expect(readFileSync(join(house, "file.txt"), "utf8")).toBe("safe update\n");
      expect(existsSync(join(house, "file.txt.embervy-new"))).toBe(false);
    }
    for (const path of [...f.removed, "retired.txt"]) expect(readFileSync(join(house, path), "utf8")).toBe("resident retired file\n");
    operation(f.letter, house, "back");
    expect(listing(house)).toEqual(before);
  });

  test("the default private file is resolved from the builder's home", () => {
    const f = privateFixture();
    put(f.home, ".config/embervy-checks/old-names-private.txt", readFileSync(f.privateFile, "utf8"));
    build(f.repo, f.from, f.to, f.letter, [], { HOME: f.home, EMBERVY_PRIVATE_OLD_NAMES: undefined });
    expect(existsSync(join(unpack(f.letter), "file.txt.embervy-base"))).toBe(false);
    expect(readFileSync(join(f.letter, "UPDATE.md"), "utf8")).toContain("2 withdrawn files");
  });

  test.each([true, false])("a missing private file preserves unfiltered payloads and names (override=%s)", override => {
    const f = privateFixture();
    const result = build(f.repo, f.from, f.to, f.letter, [], {
      HOME: f.home, EMBERVY_PRIVATE_OLD_NAMES: override ? join(f.home, "missing.txt") : undefined,
    });
    const lines = result.stdout.toString().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("WARN no private old-name list found; building without private-name filtering.");
    expect(lines[1]).toBe("built update letter with 5 changed file(s)");
    const stage = unpack(f.letter);
    expect(readFileSync(join(stage, "file.txt.embervy-base"), "utf8")).toBe(f.base);
    const manifest = readFileSync(join(f.letter, "manifest.txt"), "utf8");
    const update = readFileSync(join(f.letter, "UPDATE.md"), "utf8");
    for (const path of [...f.removed, "retired.txt"]) {
      expect(manifest).toContain(` DELETED ${path}\n`);
      expect(update).toContain(`\`${path}\` (deleted upstream)`);
    }
    expect(update).not.toContain("withdrawn");
    const comparison = temp("update-letter-no-matches-");
    writeFileSync(f.privateFile, "nonmatching\tno-such-fictional-token\n");
    build(f.repo, f.from, f.to, comparison, [], f.env);
    for (const name of ["manifest.txt", "known.txt", "UPDATE.md", "update.sh"]) {
      expect(readFileSync(join(comparison, name), "utf8")).toBe(readFileSync(join(f.letter, name), "utf8"));
    }
    expect(listing(unpack(comparison))).toEqual(listing(stage));
  });

  test("measurement restricts the neutral count to selected deletions", () => {
    const f = privateFixture();
    const measured = join(f.home, "measurement.txt");
    writeFileSync(measured, `${f.removed[0]}\nretired.txt\n`);
    build(f.repo, f.from, f.to, f.letter, ["--only-existing", measured], f.env);
    expect(readFileSync(join(f.letter, "UPDATE.md"), "utf8")).toContain("1 withdrawn file is not listed and may remain in the house.");
    expect(readFileSync(join(f.letter, "manifest.txt"), "utf8")).toMatch(/^[a-f0-9]{64} DELETED retired.txt\n$/);
    writeFileSync(measured, "retired.txt\n");
    build(f.repo, f.from, f.to, f.letter, ["--only-existing", measured], f.env);
    expect(readFileSync(join(f.letter, "UPDATE.md"), "utf8")).not.toContain("withdrawn");
  });

  test.each([
    { base: "heading\nPlimzorbit\ntail\n", pattern: "^plimzorbit$", flags: "iu", omitted: true },
    { base: "heading\nExactPlimzorbit\n", pattern: "ExactPlimzorbit", flags: "u", omitted: true },
    { base: "heading\nexactplimzorbit\n", pattern: "ExactPlimzorbit", flags: "u", omitted: false },
    { base: "binary\0PLIM42ZORBIT\n", pattern: "plim[0-9]+zorbit", flags: "iu", omitted: true },
  ])("base filtering honors anchors, flags and regexes (%#)", ({ base, pattern, flags, omitted }) => {
    const f = privateFixture(base);
    writeFileSync(f.privateFile, `fictional-label\t${pattern}\t${flags}\n`);
    build(f.repo, f.from, f.to, f.letter, [], f.env);
    const stage = unpack(f.letter);
    expect(existsSync(join(stage, "file.txt.embervy-base"))).toBe(!omitted);
    if (!omitted) expect(readFileSync(join(stage, "file.txt.embervy-base"), "utf8")).toBe(base);
    expect(readFileSync(join(stage, "file.txt"), "utf8")).toBe("safe update\n");
  });

  test("a letter containing only withdrawn files has an empty manifest and a neutral count", () => {
    const f = privateFixture();
    const measured = join(f.home, "measurement.txt");
    writeFileSync(measured, f.removed.join("\n") + "\n");
    build(f.repo, f.from, f.to, f.letter, ["--only-existing", measured], f.env);
    expect(readFileSync(join(f.letter, "manifest.txt"), "utf8")).toBe("");
    expect(readFileSync(join(f.letter, "known.txt"), "utf8")).toBe("");
    expect(listing(unpack(f.letter))).toEqual([]);
    const update = readFileSync(join(f.letter, "UPDATE.md"), "utf8");
    expect(update).toContain("2 withdrawn files are not listed and may remain in the house.");
    expect(update.toLowerCase()).not.toContain("plimzorbit");
  });

  test("invalid private patterns stop the build without leaking their data", () => {
    const f = privateFixture();
    writeFileSync(f.privateFile, "plimzorbit-label\t[plimzorbit\n");
    const result = run(["bun", join(import.meta.dir, "build.ts"), "--from", f.from, "--to", f.to, "--house", "brain", "--out", f.letter], f.repo, f.env);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("invalid regular expression");
    expect(result.stderr.toString()).not.toContain("plimzorbit");
    expect(listing(f.letter)).toEqual([]);
  });
});

describe("carried paths", () => {
  test("a letter never carries add-on folders", async () => {
    const { carriedByHouse } = await import("./build.ts");
    expect(carriedByHouse("shared/extensions/builder/runner.ts", "brain")).toBe(false);
    expect(carriedByHouse("shared/extensions/moments/moment.sh", "claude")).toBe(false);
    expect(carriedByHouse("shared/tools/house-docs.ts", "brain")).toBe(true);
  });
});
