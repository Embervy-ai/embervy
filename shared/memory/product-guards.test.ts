import "../audit-family.test";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
function sources(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    if (["node_modules", ".git", "logs", "state", "data", "backups", "installer"].includes(entry.name)) return [];
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? sources(path) : /\.(ts|js|py|sh)$/.test(path) && !path.includes(".test.") ? [path] : [];
  });
}

for (const path of ["shared", "Brain", "Claude"].flatMap(sources)) {
  const source = readFileSync(resolve(root, path), "utf8");
  if (!source.includes("/health") || !/hot_count|daemon_last_run|daemon_mode|unresolved_observations|archive_count|backlog_cursor|dream_last_run/.test(source)) continue;
  test(`health detail consumer has been checked: ${path}`, () => {
    expect(["shared/memory/src/index.ts", "shared/memory/dream-worker/src/index.ts", "shared/tools/embervy-doctor.ts"]).toContain(path);
  });
}

const changed = [
  "shared/memory/src/index.ts", "shared/memory/src/daemon.ts", "shared/memory/src/request-input.ts",
  "shared/memory/dream-worker/src/index.ts",
  "shared/memory/security.test.ts", "shared/memory/request-input.test.ts", "shared/memory/product-guards.test.ts",
  "shared/memory/delete.test.ts", "shared/memory/daemon-retry.test.ts", "shared/memory/transcribe.test.ts",
  "shared/rag/src/index.ts", "shared/rag/test/security.test.ts", "shared/rag/test/rag-worker.test.ts",
  "shared/tools/embervy-doctor.ts", "shared/tools/embervy-doctor-real-path.test.ts",
];

test("changed worker and doctor comments follow the product comment rule", () => {
  const guard = readFileSync(resolve(root, "Claude/app/comments-only.test.ts"), "utf8");
  const rule = guard.match(/const forbidden = \/(.*)\/i;/)?.[1];
  expect(rule).toBeDefined();
  const forbidden = new RegExp(rule!, "i");
  const hits: string[] = [];
  for (const path of changed) {
    const source = readFileSync(resolve(root, path), "utf8");
    for (const match of source.matchAll(/^[ \t]*\/\/[^\n]*|^[ \t]*\/\*[\s\S]*?\*\//gm)) {
      if (forbidden.test(match[0])) hits.push(`${path}:${source.slice(0, match.index).split("\n").length}`);
    }
  }
  expect(hits).toEqual([]);
});
