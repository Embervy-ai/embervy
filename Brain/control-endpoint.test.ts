import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptLoopFileKeys, headEnvironment, headsSnapshot } from "./brain";
import { resolveHead } from "./heads";
import { saveHeadKey } from "../Claude/app/brain-key-setup";
import { startAuthenticatedControlEndpoint } from "./control-endpoint";

test("control heads loads App-written keys and legacy env syntax unchanged, without changing the running head", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kimi-head-reload-"));
  const file = join(dir, "brain.env");
  const names = ["BRAIN_NO_ENV_FILE", "BRAIN_ENV_FILE", "BRAIN_EXTRA_ENV_FILE", "BRAIN_IMPORT_ENV_FILE", "KIMI_CODE_KEY", "BRAIN_KIMI_API_KEY",
    "LEGACY_ENV_BARE", "LEGACY_ENV_QUOTED", "LEGACY_ENV_EXPORTED"];
  const before = Object.fromEntries(names.map(k => [k, process.env[k]]));
  const key = "NOT-A-REAL-KEY.valid_0123456789";
  const state: any = { head: resolveHead("claude", {}), effort: null };
  const events: unknown[] = [];
  try {
    for (const name of names) delete process.env[name];
    process.env.BRAIN_ENV_FILE = file;
    // Simulate the loop exporting a file-owned credential at process start.
    process.env.KIMI_CODE_KEY = "not-a-real-old-key";
    adoptLoopFileKeys({ BRAIN_ENV_FILE_KEYS: "KIMI_CODE_KEY", KIMI_CODE_KEY: process.env.KIMI_CODE_KEY });
    writeFileSync(file, "OTHER=keep\n");
    let handler!: (r: Request) => Promise<Response>;
    const token = "kimi-control-contract-token";
    startAuthenticatedControlEndpoint({ port: 0, token, log: e => events.push(e),
      handle: async () => ({ ok: false }), heads: () => headsSnapshot(state, null),
      serve: options => { handler = options.fetch; return {}; } });
    const get = (authorized = true) => handler(new Request("http://localhost/heads", {
      headers: authorized ? { authorization: `Bearer ${token}` } : {},
    }));
    expect((await get(false)).status).toBe(401);
    const kimi = async () => {
      const text = await (await get()).text();
      expect(text.includes(key)).toBe(false);
      const result = JSON.parse(text);
      expect(result.current.head).toBe("claude");
      return result.heads.find((h: any) => h.name === "kimi");
    };
    expect((await kimi()).setup).toBe("key");
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => Response.json({ usages: {} })) as typeof fetch;
      await saveHeadKey(file, "kimi", key);
    } finally { globalThis.fetch = originalFetch; }
    expect(readFileSync(file).equals(Buffer.from(`OTHER=keep\nKIMI_CODE_KEY=${key}\n`))).toBe(true);
    writeFileSync(file, readFileSync(file, "utf8") + [
      "LEGACY_ENV_BARE=  words with spaces # literal comment  ",
      String.raw`LEGACY_ENV_QUOTED="keep\n\$literal\\tail"`,
      "export LEGACY_ENV_EXPORTED=ignored-before-round-one",
      "",
    ].join("\n"));
    // Actual loadConfiguredEnv -> loadEnv path, not the shared shell-style parser.
    const env = headEnvironment();
    expect(resolveHead("kimi", env).apiKey === key).toBe(true);
    // Pre-round-one loadEnv: trim RHS, remove only outer quotes, ignore export.
    expect(env.LEGACY_ENV_BARE).toBe("words with spaces # literal comment");
    expect(env.LEGACY_ENV_QUOTED).toBe(String.raw`keep\n\$literal\\tail`);
    expect(env.LEGACY_ENV_EXPORTED).toBeUndefined();
    expect((await kimi()).available).toBe(true);
    expect((await kimi()).setup).toBeUndefined();
    writeFileSync(file, "OTHER=keep\n");
    expect((await kimi()).setup).toBe("key");
    process.env.BRAIN_KIMI_API_KEY = "externally-configured-test-override";
    expect((await kimi()).available).toBe(true);
    expect(JSON.stringify(events).includes(key)).toBe(false);
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
