import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { readAssetReferences, readAssetStamp, readAssetUrl, readCacheNumber } from "./test-asset-stamps";

const assets = ["style.css", "app.js", "settings.js", "games.js"] as const;

for (const suffix of ["", "-h1", "-h12"]) {
  test(`reads the cache number with suffix ${suffix || "(none)"}`, () => {
    expect(readCacheNumber(`const CACHE_NAME = "embervy-v58${suffix}";`)).toBe(58);
    expect(readCacheNumber(`const CACHE_NAME\n = 'embervy-v58${suffix}';`)).toBe(58);
  });

  for (const asset of assets) {
    test(`reads ${asset} from HTML and sw.js with suffix ${suffix || "(none)"}`, () => {
      const url = `/${asset}?v=124${suffix}`;
      const html = asset.endsWith(".css") ? `<link href="${url}" rel="stylesheet">` : `<script src="${url}"></script>`;
      const worker = `const CACHE_URLS = ["${url}"];`;
      for (const text of [html, worker, `<link href='${url}'>`]) {
        expect(readAssetStamp(text, asset)).toBe(124);
        expect(readAssetUrl(text, asset)).toBe(url);
        expect(readAssetReferences(text, asset)).toEqual([{ url, version: 124 }]);
      }
    });
  }
}

test.each([
  "",
  'const OTHER_NAME = "embervy-v58";',
  'const CACHE_NAME = "embervy-v";',
  'const CACHE_NAME = "embervy-v58-h";',
  'const CACHE_NAME = "embervy-v58-h1-extra";',
  'const CACHE_NAME = "embervy-v58.1";',
  'const CACHE_NAME = "embervy-v9007199254740992";',
])("invalid or missing cache names throw clearly: %s", text => {
  expect(() => readCacheNumber(text)).toThrow("CACHE_NAME in sw.js");
});

for (const asset of assets) {
  test(`missing or malformed ${asset} stamps throw instead of returning NaN`, () => {
    for (const text of [
      "",
      `"/${asset}"`,
      `"/${asset}?v="`,
      `"/${asset}?v=NaN"`,
      `"/${asset}?v=124-h"`,
      `"/${asset}?v=124-h1-extra"`,
      `"/${asset}?v=124.5"`,
      `"/${asset}?v=9007199254740992"`,
      `"/other-${asset}?v=124"`,
      `"/${asset.replace(".", "X")}?v=124"`,
    ]) {
      expect(() => readAssetStamp(text, asset)).toThrow(`${asset} stamp`);
      expect(() => readAssetUrl(text, asset)).toThrow(`${asset} stamp`);
      expect(() => readAssetReferences(text, asset)).toThrow(`${asset} stamp`);
    }
  });
}

test("all references are returned, without confusing asset names or discarding house suffixes", () => {
  const text = '<script src="/app.js?v=141-h1"></script><link href="/style.css?v=124-h12"><script src="/app.js?v=142-h12"></script>';
  expect(readAssetReferences(text, "app.js")).toEqual([
    { url: "/app.js?v=141-h1", version: 141 },
    { url: "/app.js?v=142-h12", version: 142 },
  ]);
  expect(readAssetStamp(text, "style.css")).toBe(124);
  expect(readAssetUrl(text, "style.css")).toBe("/style.css?v=124-h12");
  expect(() => readAssetStamp(text, "settings.js")).toThrow("settings.js stamp");
});

function appTests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appTests(path);
    return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

// Check the cache prefix rather than one regex spelling, including shortened
// parsers, but do not confuse unrelated names such as embervy-voice with it.
function hasOwnCacheExpression(source: string): boolean {
  return /embervy-v(?![a-z])/i.test(source);
}

test("the guard catches both full assignments and shortened independent cache expressions", () => {
  for (const source of [
    String.raw`Number(/const CACHE_NAME = "embervy-v(\d+)"/.exec(worker)?.[1])`,
    String.raw`worker.match(/CACHE_NAME = "embervy-v(\d+)(?:-h\d+)?"/)`,
    String.raw`worker.match(/embervy-v(\d+)/)`,
    String.raw`new RegExp('CACHE_NAME\\s*=\\s*"embervy-v(\\d+)"')`,
  ]) expect(hasOwnCacheExpression(source)).toBe(true);
  expect(hasOwnCacheExpression('expect(readCacheNumber(worker)).toBeGreaterThan(57);')).toBe(false);
  expect(hasOwnCacheExpression('expect(page).toContain(\'<meta name="embervy-voice" content="message">\');')).toBe(false);
});

test("app tests use the shared cache reader rather than their own cache-name expressions", () => {
  const allowed = new Set(["test-asset-stamps.ts", "test-asset-stamps.test.ts"]);
  const files = appTests(import.meta.dir).filter(path => !allowed.has(relative(import.meta.dir, path)));
  expect(files.length).toBeGreaterThan(0);
  const offenders = files.filter(path => hasOwnCacheExpression(readFileSync(path, "utf8")))
    .map(path => relative(import.meta.dir, path));
  expect(offenders).toEqual([]);
});
