import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Keep pattern semantics aligned with the installer's name-check.ts.
const FLAGS = new Set(["iu", "u"]);
// Case-specific Unicode classes under i disagree across regex runtimes.
const CASE_CLASS = /\\[pP]\{(?:gc=|General_Category=)?(?:Ll|Lu|Lt|LC|Lowercase_Letter|Uppercase_Letter|Titlecase_Letter|Cased_Letter|Lowercase|Uppercase)\}/;

export function privateOldNamesFile(): string {
  return process.env.EMBERVY_PRIVATE_OLD_NAMES ?? join(homedir(), ".config", "embervy-checks", "old-names-private.txt");
}

export function readPrivateOldNames(file = privateOldNamesFile(), onMissing: (message: string) => void = console.log): RegExp[] {
  if (!existsSync(file)) {
    onMissing("WARN no private old-name list found; building without private-name filtering.");
    return [];
  }
  const names: RegExp[] = [];
  for (const [index, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [label, pattern, flags = "iu", ...rest] = line.split("\t");
    // Diagnostics must not copy private labels or patterns into build logs.
    const fail = (reason: string): never => { throw new Error(`private old-name list, line ${index + 1}: ${reason}`); };
    if (!label || !pattern || rest.length) fail("expected LABEL<TAB>PATTERN[<TAB>FLAGS]");
    if (!FLAGS.has(flags)) fail('flags must be "iu" or "u"');
    if (flags.includes("i") && CASE_CLASS.test(pattern)) fail('case-specific Unicode classes require flags "u"');
    try {
      names.push(new RegExp(pattern, flags));
    } catch {
      fail("invalid regular expression");
    }
  }
  if (!names.length) throw new Error("private old-name list contains no patterns");
  return names;
}
