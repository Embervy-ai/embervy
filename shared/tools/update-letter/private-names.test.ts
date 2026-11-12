import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPrivateOldNames } from "./private-names";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function patterns(contents: string): RegExp[] {
  const root = mkdtempSync(join(tmpdir(), "update-letter-patterns-"));
  roots.push(root);
  const file = join(root, "private.txt");
  writeFileSync(file, contents);
  return readPrivateOldNames(file, () => { throw new Error("unexpected missing list"); });
}

describe("private old-name rules", () => {
  test("comments, blanks, default iu, embedded matches and explicit case-sensitive u", () => {
    const names = patterns("# Private test patterns\n\n  \nfictional\tplimzorbit\nexact\tExactPlimzorbit\tu\nexpression\tplim[0-9]+zorbit\tiu\n");
    expect(names.map(re => re.flags)).toEqual(["iu", "u", "iu"]);
    for (const value of ["PLIMZORBIT_SETTING", "preplimzorbitpost", "me@ourplimzorbit.invalid", "folder/Plimzorbit.txt"]) {
      expect(names[0].test(value)).toBe(true);
      expect(names[0].test(value)).toBe(true);
    }
    expect(names[1].test("ExactPlimzorbit")).toBe(true);
    expect(names[1].test("exactplimzorbit")).toBe(false);
    expect(names[2].test("PLIM42ZORBIT")).toBe(true);
    expect(names.some(re => re.test("unrelated text"))).toBe(false);
  });

  test.each(["", "# Only comments\n\n", "fictional", "\tplimzorbit", "fictional\t", "fictional\tplimzorbit\tu\textra", "fictional\tplimzorbit\t", "fictional\tplimzorbit\tui", "fictional\tplimzorbit\tgiu", "fictional\t[plimzorbit\tu"])(
    "rejects malformed or empty lists without echoing private data (%#)", contents => {
      expect(() => patterns(contents)).toThrow("private old-name list");
      try { patterns(contents); } catch (error) {
        expect(String(error)).not.toContain("fictional");
        expect(String(error)).not.toContain("plimzorbit");
      }
    }
  );

  test.each(["Ll", "Lu", "Lt", "LC", "Lowercase_Letter", "Uppercase_Letter", "Titlecase_Letter", "Cased_Letter", "Lowercase", "Uppercase", "gc=Ll", "General_Category=Lu"])(
    "rejects case-specific Unicode class %s under i", category => {
      expect(() => patterns(`fictional\t\\p{${category}}plimzorbit\n`)).toThrow("case-specific Unicode classes");
      expect(() => patterns(`fictional\t\\P{${category}}plimzorbit\n`)).toThrow("case-specific Unicode classes");
    }
  );

  test("allows case-specific classes with u and general letter classes with iu", () => {
    const names = patterns("fictional\t\\p{Ll}plimzorbit\tu\nletters\t\\p{L}plimzorbit\n");
    expect(names[0].test("aplimzorbit")).toBe(true);
    expect(names[0].test("Aplimzorbit")).toBe(false);
    expect(names[1].test("ÉPLIMZORBIT")).toBe(true);
  });

  test("a missing file returns no filters and emits exactly one neutral warning", () => {
    const root = mkdtempSync(join(tmpdir(), "update-letter-missing-patterns-"));
    roots.push(root);
    const messages: string[] = [];
    expect(readPrivateOldNames(join(root, "missing"), message => messages.push(message))).toEqual([]);
    expect(messages).toEqual(["WARN no private old-name list found; building without private-name filtering."]);
  });
});
