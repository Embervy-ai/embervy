import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "../..");

// Add-ons are sold and shipped on their own. Anything tracked under
// shared/extensions/ would travel with every update and installer package.
// An installed copy keeps its add-ons there untracked, so only tracked files count.
test("the core tree tracks no add-on code", () => {
  if (!existsSync(join(repo, ".git"))) return;
  const tracked = execFileSync("git", ["-C", repo, "ls-files", "--", "shared/extensions"], { encoding: "utf8" }).trim();
  expect(tracked).toBe("");
});
