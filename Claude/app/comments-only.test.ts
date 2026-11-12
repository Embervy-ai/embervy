import { test, expect } from "bun:test";
import * as ts from "typescript";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const self = "Claude/app/comments-only.test.ts";
// A comment says why the code is as it is, never when or where it was noticed:
// no dates, no finding places, no review rounds, no history. Names of people
// and houses are kept out by the package's own name check.
const forbidden = /\b\d{2}\.\d{2}\.(?:(?:20)?\d{2})?|\b\d{4}-\d{2}-\d{2}\b|\baudit|\breview|found in|field (?:find|note|trial)|live run|\bused to\b|before the rename|was removed/i;

function eligible(path: string): boolean {
  return /^(Claude|shared|Brain)\//.test(path)
    && !path.startsWith("shared/tools/installer/")
    && !path.split("/").includes("node_modules")
    && /\.(ts|js|sh|html|css)$/.test(path);
}
// The files under version control where there is a checkout (ignored build
// leftovers are not the product), else every file below the folder.
function productFiles(): string[] {
  try {
    return execFileSync("git", ["ls-files", "--", "Claude", "shared", "Brain"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split("\n").filter(path => path && eligible(path));
  } catch {
    return [...files("Claude"), ...files("shared"), ...files("Brain")];
  }
}
function files(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap(entry => {
    const path = `${dir}/${entry.name}`;
    if (entry.name === "node_modules" || path === "shared/tools/installer") return [];
    return entry.isDirectory() ? files(path) : eligible(path) ? [path] : [];
  });
}
function comments(source: string, path: string): { pos: number; text: string }[] {
  if (/\.(ts|js)$/.test(path)) {
    const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const ranges = new Map<number, ts.CommentRange>();
    function visit(node: ts.Node) {
      for (const pos of [node.pos, node.end]) {
        for (const range of [...(ts.getLeadingCommentRanges(source, pos) || []), ...(ts.getTrailingCommentRanges(source, pos) || [])]) ranges.set(range.pos, range);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return [...ranges.values()].sort((a, b) => a.pos - b.pos).map(range => ({ pos: range.pos, text: source.slice(range.pos, range.end) }));
  }
  const pattern = path.endsWith(".sh") ? /^[\t ]*#.*$/gm : /<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g;
  return [...source.matchAll(pattern)].map(match => ({ pos: match.index!, text: match[0] }));
}
test("product comments contain no dated provenance or review history", () => {
  const hits: string[] = [];
  const datesOutsideComments: string[] = [];
  for (const path of productFiles()) {
    if (path === self) continue;
    const source = readFileSync(resolve(root, path), "utf8");
    const ranges = comments(source, path);
    for (const comment of ranges) {
      if (forbidden.test(comment.text)) hits.push(`${path}:${source.slice(0, comment.pos).split("\n").length}: ${comment.text}`);
    }
    for (const match of source.matchAll(/\d{2}\.\d{2}\.(?:20)?2\d/g)) {
      if (!ranges.some(comment => match.index! >= comment.pos && match.index! < comment.pos + comment.text.length)) {
        const line = source.slice(0, match.index).split("\n").length;
        datesOutsideComments.push(`${path}:${line}: ${source.split("\n")[line - 1].trim()}`);
      }
    }
  }
  console.log("COMMENT dates outside comments " + JSON.stringify(datesOutsideComments));
  console.log("COMMENT inventory " + JSON.stringify(hits));
  expect(hits, JSON.stringify(hits)).toEqual([]);
});
