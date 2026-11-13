// Test-only readers: house suffixes do not change the shipped version number.
export type TestAsset = "style.css" | "app.js" | "settings.js" | "games.js";

function versionNumber(digits: string, label: string): number {
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) throw new Error(`Invalid ${label}: expected a safe integer, got ${digits}`);
  return number;
}

export function readCacheNumber(worker: string): number {
  const match = /\bconst\s+CACHE_NAME\s*=\s*(["'])embervy-v(\d+)(?:-h\d+)?\1/.exec(worker);
  if (!match) throw new Error('Missing or invalid CACHE_NAME in sw.js: expected "embervy-v<number>" with optional -h<number>');
  return versionNumber(match[2], "CACHE_NAME in sw.js");
}

export function readAssetReferences(text: string, asset: TestAsset): { url: string; version: number }[] {
  const name = asset.replace(".", "\\.");
  // Require a complete quoted URL, so a malformed suffix cannot pass as a numeric prefix.
  const pattern = new RegExp(`(["'])(/${name}\\?v=(\\d+)(?:-h\\d+)?)\\1`, "g");
  const references = [...text.matchAll(pattern)].map(match => ({
    url: match[2],
    version: versionNumber(match[3], `${asset} stamp`),
  }));
  if (!references.length) throw new Error(`Missing or invalid ${asset} stamp: expected /${asset}?v=<number> with optional -h<number> in HTML or sw.js`);
  return references;
}

export function readAssetStamp(text: string, asset: TestAsset): number {
  return readAssetReferences(text, asset)[0].version;
}

export function readAssetUrl(text: string, asset: TestAsset): string {
  return readAssetReferences(text, asset)[0].url;
}
