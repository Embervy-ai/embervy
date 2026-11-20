import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeySetupError, saveHeadKey } from "./brain-key-setup";

test("keys use only the installer alphabet at lengths 8 through 512; saved assignment is byte-exact", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-key-alphabet-"));
  const file = join(dir, "brain.env");
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ usages: {} }); }) as typeof fetch;
  try {
    const prefix = "# unchanged\r\nOTHER='space # and \\ remain'\n";
    for (const key of ["Aa09._-z", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-", "x".repeat(512)]) {
      writeFileSync(file, prefix);
      await saveHeadKey(file, "kimi", key);
      expect(readFileSync(file).equals(Buffer.from(`${prefix}KIMI_CODE_KEY=${key}\n`))).toBe(true);
    }
    expect(requests).toBe(3);
    const saved = readFileSync(file);
    const invalid: unknown[] = [undefined, null, 12345678, {}, "", "x".repeat(7), "x".repeat(513), "12345678é", "12345678😀"];
    // Every ASCII character outside the allowlist, including a final newline.
    for (let code = 0; code < 128; code++) {
      const char = String.fromCharCode(code);
      if (!/[A-Za-z0-9._-]/.test(char)) invalid.push(`12345678${char}`);
    }
    for (const key of invalid) {
      let error: unknown;
      try { await saveHeadKey(file, "kimi", key); } catch (caught) { error = caught; }
      expect(error instanceof KeySetupError && error.code === "invalid").toBe(true);
      expect(readFileSync(file).equals(saved)).toBe(true);
    }
    expect(requests).toBe(3);
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replacement preserves aliases, comments, similar names and unrelated bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-replace-"));
  const file = join(dir, "brain.env");
  const remaining = "# KIMI_CODE_KEY=comment\r\nBRAIN_KIMI_API_KEY=alias-not-real\nKIMI_CODE_KEY_EXTRA=keep\nOTHER='keep me'\n";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ usages: {} })) as typeof fetch;
  try {
    writeFileSync(file, remaining + "export KIMI_CODE_KEY='not-real'\n  KIMI_CODE_KEY = duplicate-not-real\n", { mode: 0o644 });
    for (let i = 0; i < 2; i++) {
      await saveHeadKey(file, "kimi", "not-real-replacement");
      expect(readFileSync(file, "utf8") === remaining + "KIMI_CODE_KEY=not-real-replacement\n").toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  } finally { globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); }
});
