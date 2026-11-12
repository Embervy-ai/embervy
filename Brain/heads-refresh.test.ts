import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogCache, type ModelInfo } from "./head-models";
import { startAuthenticatedControlEndpoint } from "./control-endpoint";
import { handleCommand, headsSnapshot, loadHeadsSnapshot } from "./brain";
import { resolveHead } from "./heads";

const TOKEN = "catalog-test-token-1234567890";
const names = ["claude", "gpt", "grok", "kimi"] as const;
const models = (id: string): ModelInfo[] => [{ id, label: id }];
const state = () => ({ head: resolveHead("grok", { XAI_API_KEY: "test-key" }), effort: null } as any);

function endpoint(heads: (refresh: boolean) => unknown | Promise<unknown>) {
  let fetcher!: (request: Request) => Promise<Response>;
  startAuthenticatedControlEndpoint({
    token: TOKEN, port: 0, heads,
    handle: async () => ({ ok: true }),
    serve: (options) => { fetcher = options.fetch; return {}; },
  });
  return (path = "/heads", authorized = true) => fetcher(new Request(`http://localhost${path}`, {
    headers: authorized ? { authorization: `Bearer ${TOKEN}` } : {},
  }));
}

function fixture() {
  let now = 1_000_000;
  let version = "old";
  let failure: "null" | "empty" | "throw" | null = null;
  let wait: Promise<void> | null = null;
  const events: Record<string, unknown>[] = [];
  const cache = new ModelCatalogCache(() => now, (event) => events.push(event));
  const calls = Object.fromEntries(names.map((name) => [name, 0])) as Record<typeof names[number], number>;
  const snapshot = async (refresh: boolean) => {
    const mode = cache.readMode(refresh);
    const catalogs: Partial<Record<string, ModelInfo[]>> = {};
    await Promise.all(names.map(async (name) => {
      const list = await cache.get(name, async () => {
        calls[name]++;
        const id = `${name}-${version}`;
        if (wait) await wait;
        if (failure === "throw") throw new Error("catalog unavailable");
        if (failure === "null") return null;
        if (failure === "empty") return [];
        return models(id);
      }, mode);
      if (list) catalogs[name] = list;
    }));
    return headsSnapshot(state(), catalogs.claude ?? null, catalogs, cache.updatedAt);
  };
  return {
    cache, calls, events, get: endpoint(snapshot),
    advance: (ms: number) => { now += ms; },
    version: (value: string) => { version = value; },
    fail: (value: typeof failure) => { failure = value; },
    hold: (value: Promise<void>) => { wait = value; },
  };
}

function expectCatalogs(body: any, version: string) {
  for (const name of names) {
    expect(body.heads.find((head: any) => head.name === name).models.some((model: any) => model.id === `${name}-${version}`)).toBe(true);
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Each deferred probe starts in a microtask, before any simulated provider completes.
const started = () => new Promise<void>((done) => setTimeout(done, 0));

describe("catalog refresh", () => {
  test("refresh=1 bypasses the six-hour lifetime for every catalog and refills memory", async () => {
    const f = fixture();
    expectCatalogs(await (await f.get()).json(), "old");
    f.advance(1_000);
    f.version("new");
    expectCatalogs(await (await f.get("/heads?refresh=1")).json(), "new");
    f.version("later");
    expectCatalogs(await (await f.get()).json(), "new");
    expect(Object.values(f.calls)).toEqual([2, 2, 2, 2]);
    expect(f.events).toEqual([{ type: "head_models_refresh" }]);
  });

  test("ordinary reads and other parameter values keep the cached catalogs", async () => {
    const f = fixture();
    await f.get();
    f.advance(6 * 3_600_000 - 1);
    f.version("new");
    for (const path of ["/heads", "/heads?refresh=0", "/heads?refresh=true", "/heads?refresh="]) {
      expectCatalogs(await (await f.get(path)).json(), "old");
    }
    expect(Object.values(f.calls)).toEqual([1, 1, 1, 1]);
    expect(f.events).toEqual([]);
    f.advance(1);
    expectCatalogs(await (await f.get()).json(), "new");
    expect(Object.values(f.calls)).toEqual([2, 2, 2, 2]);
  });

  test.each(["null", "empty", "throw"] as const)("a %s failure retains and serves the previous lists", async (failure) => {
    const f = fixture();
    await f.get();
    f.advance(1_000);
    f.fail(failure);
    const body = await (await f.get("/heads?refresh=1")).json();
    expectCatalogs(body, "old");
    expect(body.catalogsUpdatedAt).toBe(1_000_000);
    expect(f.cache.peek("grok")).toEqual(models("grok-old"));
    expectCatalogs(await (await f.get()).json(), "old");
    expect(Object.values(f.calls)).toEqual([2, 2, 2, 2]);
  });

  test("simultaneous forced reads reuse one probe per head", async () => {
    const f = fixture();
    await f.get();
    const gate = deferred();
    f.hold(gate.promise);
    f.version("new");
    const first = f.get("/heads?refresh=1");
    const second = f.get("/heads?refresh=1");
    await started();
    expect(Object.values(f.calls)).toEqual([2, 2, 2, 2]);
    gate.resolve();
    for (const response of await Promise.all([first, second])) expectCatalogs(await response.json(), "new");
    expect(f.events).toHaveLength(1);
  });

  test("a refresh also joins an ordinary probe already in progress", async () => {
    const f = fixture();
    const gate = deferred();
    f.hold(gate.promise);
    const first = f.get();
    const second = f.get("/heads?refresh=1");
    await started();
    expect(Object.values(f.calls)).toEqual([1, 1, 1, 1]);
    gate.resolve();
    for (const response of await Promise.all([first, second])) expectCatalogs(await response.json(), "old");
  });

  test("refreshes are limited until exactly ten seconds after the previous forced read", async () => {
    const f = fixture();
    await f.get("/heads?refresh=1");
    f.version("new");
    f.advance(9_999);
    expectCatalogs(await (await f.get("/heads?refresh=1")).json(), "old");
    expect(Object.values(f.calls)).toEqual([1, 1, 1, 1]);
    f.advance(1);
    expectCatalogs(await (await f.get("/heads?refresh=1")).json(), "new");
    expect(Object.values(f.calls)).toEqual([2, 2, 2, 2]);
    expect(f.events).toHaveLength(2);
  });

  test("throttling does not probe expired entries or retry a failed cold refresh", async () => {
    const f = fixture();
    f.fail("null");
    expect((await (await f.get("/heads?refresh=1")).json()).catalogsUpdatedAt).toBeNull();
    f.advance(9_999);
    f.fail(null);
    await f.get("/heads?refresh=1");
    expect(Object.values(f.calls)).toEqual([1, 1, 1, 1]);
    f.advance(1);
    await f.get("/heads?refresh=1");
    f.advance(6 * 3_600_000);
    f.fail("null");
    await f.get("/heads?refresh=1");
    f.advance(1);
    await f.get("/heads?refresh=1");
    expect(Object.values(f.calls)).toEqual([3, 3, 3, 3]);
  });

  test("the response timestamp is the last successful completion, not the request time", async () => {
    const f = fixture();
    const gate = deferred();
    f.hold(gate.promise);
    const pending = f.get();
    await started();
    f.advance(250);
    gate.resolve();
    const body = await (await pending).json();
    expect(body.catalogsUpdatedAt).toBe(1_000_250);
    expect(Object.keys(body).sort()).toEqual(["catalogsUpdatedAt", "claudeCatalog", "commands", "current", "heads"]);
    f.advance(1_000);
    expect((await (await f.get()).json()).catalogsUpdatedAt).toBe(1_000_250);
    expect((await (await f.get("/heads?refresh=1")).json()).catalogsUpdatedAt).toBe(1_001_250);
  });

  test("one failed catalog does not prevent other catalogs from being updated", async () => {
    const cache = new ModelCatalogCache(() => 123);
    await cache.get("first", async () => models("old"));
    await cache.get("second", async () => models("old"));
    const mode = cache.readMode(true);
    const result = await Promise.all([
      cache.get("first", async () => { throw new Error("unavailable"); }, mode),
      cache.get("second", async () => models("new"), mode),
    ]);
    expect(result).toEqual([models("old"), models("new")]);
    expect(cache.peek("first")).toEqual(models("old"));
    expect(cache.peek("second")).toEqual(models("new"));
  });

  test("an unauthorized refresh cannot reach the provider", async () => {
    const f = fixture();
    expect((await f.get("/heads?refresh=1", false)).status).toBe(401);
    expect(Object.values(f.calls)).toEqual([0, 0, 0, 0]);
    expect(f.events).toEqual([]);
  });
});

test("the runtime shares refresh behavior between the endpoint and terminal command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-refresh-"));
  const bin = join(dir, "catalog-cli");
  const data = join(dir, "catalog.json");
  const auth = join(dir, "auth.json");
  writeFileSync(bin, `#!/usr/bin/env bun\nimport { readFileSync } from "node:fs";\nfor await (const line of console) {\n  const request = JSON.parse(line);\n  console.log(JSON.stringify({ type: "control_response", response: { request_id: request.request_id, response: { models: JSON.parse(readFileSync(${JSON.stringify(data)}, "utf8")) } } }));\n}\n`, { mode: 0o700 });
  writeFileSync(auth, JSON.stringify({ tokens: { access_token: "test-token", account_id: "test-account" } }));
  const env: Record<string, string> = {
    BRAIN_CLAUDE_BIN: bin, BRAIN_CLAUDE_LOGIN_CHECK: "0", BRAIN_GPT_CACHE_KEY: "test-catalog",
    CHATGPT_AUTH_FILE: auth, BRAIN_GROK_API_KEY: "test-key", BRAIN_KIMI_API_KEY: "test-key",
    BRAIN_GROK_ENDPOINT: "https://catalog.test/v1/chat/completions", BRAIN_KIMI_BASE: "https://catalog.test/kimi",
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let now = 2_000_000_000_000;
  let version = "old";
  let failed = false;
  let calls = 0;
  const setVersion = (value: string) => {
    version = value;
    writeFileSync(data, JSON.stringify([{ value: `claude-${value}`, displayName: `claude-${value}` }]));
  };
  setVersion("old");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    calls++;
    if (failed) return new Response("unavailable", { status: 503 });
    const url = String(input);
    if (url.includes("chatgpt.com")) return Response.json({ models: [{ slug: `gpt-${version}`, visibility: "list" }] });
    return Response.json({ data: [{ id: `${url.includes("/kimi/") ? "kimi" : "grok"}-${version}` }] });
  });
  try {
    const runtime = state();
    const get = endpoint((refresh) => loadHeadsSnapshot(runtime, refresh));
    expectCatalogs(await (await get()).json(), "old");
    expect(calls).toBe(3);
    setVersion("new");
    expectCatalogs(await (await get()).json(), "old");
    now += 1_000;
    const body = await (await get("/heads?refresh=1")).json();
    expectCatalogs(body, "new");
    expect(body.catalogsUpdatedAt).toBe(now);
    expect(calls).toBe(6);
    setVersion("next");
    expect((await handleCommand(runtime, "/heads refresh", "terminal")).text).toContain("grok-new");
    expect(calls).toBe(6);
    now += 10_000;
    expect((await handleCommand(runtime, "/heads refresh", "terminal")).text).toContain("grok-next");
    expect(calls).toBe(9);
    expectCatalogs(await (await get()).json(), "next");
    now += 10_000;
    failed = true;
    writeFileSync(data, "[]");
    expectCatalogs(await (await get("/heads?refresh=1")).json(), "next");
    expect(calls).toBe(12);
    expect((await handleCommand(runtime, "/help", "terminal")).text).toContain("/heads refresh");
  } finally {
    fetchMock.mockRestore();
    clock.mockRestore();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
