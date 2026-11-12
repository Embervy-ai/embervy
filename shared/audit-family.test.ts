import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// A lived-in house keeps backups of old program files, logs and its own agent settings next to the product.
const HOUSE_ONLY = new Set([".runtime", "backups", ".claude"]);
// .gitignore keeps these out of the product at every depth (Brain/logs holds session exports, for example).
const RUNTIME_ANYWHERE = new Set(["state", "logs", "data"]);
function productFiles(dir = "."): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    if (item.isDirectory() && (RUNTIME_ANYWHERE.has(item.name) || (dir === "." && HOUSE_ONLY.has(item.name)))) return [];
    // The installer is its own repository; a checkout nested here is not part of the product.
    if (item.isDirectory()) return ["node_modules", ".git", ".cache"].includes(item.name) || path === join("shared", "tools", "installer") ? [] : productFiles(path);
    return /\.(ts|js|py|sh|md|example|json|toml|ya?ml)$/.test(item.name) ? [path] : [];
  });
}

test("the forbidden password is only a startup rejection and a negative fixture", () => {
  const magic = "DEV_INSECURE" + "_OPEN";
  const allowed = new Map([["Claude/app/server.ts", 2], ["Claude/app/audit-auth.test.ts", 1], ["SECURITY.md", 1]]);
  for (const path of productFiles()) {
    if (path === "BERICHT-AUDIT-FIX.md" || path === "shared/audit-family.test.ts") continue;
    let text: string;
    try { text = readFileSync(join(root, path), "utf8"); } catch { continue; }
    expect(text.includes("DEV" + "_OPEN"), path).toBe(false);
    const count = text.split(magic).length - 1;
    expect(count, path).toBe(allowed.get(path) ?? 0);
  }
});
