// Lore distinguishes the working memory from CLI memory. Legacy server names
// are confined to compatibility modules and their tests to avoid ambiguity.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const ALLOWED = new Set(["shared/scripts/legacy-names.ts", "shared/scripts/legacy-names.test.ts", "shared/scripts/lore-name.test.ts"]);

// Installed houses need a filesystem fallback because they have no checkout.
// Runtime data and agent texts are not product sources; the installer is
// excluded because its compatibility handling must accept legacy prefixes.
function productFiles(): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "--", "Claude", "shared"], { cwd: ROOT, stderr: "ignore" });
  if (git.exitCode === 0) return git.stdout.toString().split("\n").filter(Boolean);
  const skip = new Set(["node_modules", "logs", "state", "data", ".git"]);
  const walk = (dir: string): string[] => readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return skip.has(entry.name) || path === "shared/tools/installer" ? [] : walk(path);
    return /\.(ts|js|sh|html|css|example)$/.test(entry.name) || entry.name === "README.md" ? [path] : [];
  });
  // Brain is maintained separately and must not be policed by product naming rules.
  return ["Claude", "shared"].flatMap(walk);
}

test("the old tool prefix mcp__memory__ appears only in the transition modules", () => {
  const files = productFiles();
  expect(files.length).toBeGreaterThan(100);
  const hits = files.filter((f) => !ALLOWED.has(f) && !/\.(png|jpe?g|gif|ico|webp|woff2?|ttf|zip|gz|pdf)$/i.test(f))
    .filter((f) => { try { return readFileSync(join(ROOT, f), "utf8").includes("mcp__memory__"); } catch { return false; } });
  expect(hits).toEqual([]);
});

test("the agent's own texts name the Lore and its tools", () => {
  const template = readFileSync(join(ROOT, "Claude", "CLAUDE.md.example"), "utf8");
  expect(template).toContain("mcp__lore__");
  expect(readFileSync(join(ROOT, "Claude", "app", ".mcp.json.example"), "utf8")).toContain("as 'lore'");
});
