import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import memory, { PRODUCT_VERSION } from "./src/index";
import { daemonSettings, runDaemon } from "./src/daemon";
import dream, { dreamSettings, processDream } from "./dream-worker/src/index";

const originalFetch = globalThis.fetch;
const databases: Database[] = [];
const spies: { mockRestore(): void }[] = [];
const marker = "PRIVATE-user_id-account-echoed-request";
afterEach(() => {
  globalThis.fetch = originalFetch;
  spies.splice(0).forEach(s => s.mockRestore());
  databases.splice(0).forEach(db => db.close());
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  let fault = "";
  let faultMessage = marker;
  const env: any = { OPENROUTER_API_KEY: "test", EMBERVY_API_KEY: "test", DB: {
    prepare(sql: string) {
      let args: any[] = [];
      const check = () => { if (fault && sql.includes(fault)) throw new Error(faultMessage); };
      return {
        bind(...values: any[]) { args = values; return this; },
        async first() { check(); return db.query(sql).get(...args); },
        async all() { check(); return { results: db.query(sql).all(...args) }; },
        async run() { check(); const r = db.query(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid) } }; },
      };
    },
    async batch(statements: any[]) { return Promise.all(statements.map(s => s.run())); },
  } };
  const bodies: any[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    return Response.json({ choices: [{ message: { content: "{}" } }] });
  }) as typeof fetch;
  async function health() {
    const response = await memory.fetch(new Request("https://memory.test/mcp", {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health", arguments: {} } }),
    }), env);
    const rpc: any = await response.json();
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).not.toBe(true);
    const text = rpc.result.content[0].text;
    expect(text).not.toContain(marker);
    return JSON.parse(text.match(/```json\s*([\s\S]*?)```/)[1]);
  }
  spies.push(spyOn(console, "error").mockImplementation(() => {}));
  return { db, env, bodies, health, fail(sql: string, message = marker) { fault = sql; faultMessage = message; },
    row: () => db.query("SELECT * FROM daemon_runs ORDER BY id DESC LIMIT 1").get() as any };
}
const pause = async () => {};
const defaultModel = "mistralai/mistral-medium-3-5";

test("default requests retain model, budgets, timeouts and other provider fields", async () => {
  const f = fixture();
  const timeout = spyOn(AbortSignal, "timeout"); spies.push(timeout);
  expect((await runDaemon(f.env, pause, pause)).ok).toBe(true);
  const daemonBody = f.bodies[0];
  expect(daemonBody).toEqual({ model: defaultModel, messages: [{ role: "user", content: expect.any(String) }],
    response_format: { type: "json_object" }, temperature: 0.4, max_tokens: 8000 });
  await processDream(f.env, pause);
  expect(f.bodies[1]).toEqual({ model: defaultModel, max_tokens: 2000, temperature: 0.9,
    messages: [{ role: "user", content: expect.any(String) }] });
  expect(timeout.mock.calls.map(c => c[0])).toEqual([120000, 60000]);
  expect(await f.health()).toMatchObject({ product_version: PRODUCT_VERSION, ...daemonSettings({}) });
  expect(await (await dream.fetch(new Request("https://dream.test/health"), f.env)).json())
    .toEqual({ status: "ok", ...dreamSettings({}) });
});

test("configured settings reach both requests, timeouts and health", async () => {
  const f = fixture();
  Object.assign(f.env, { DAEMON_LLM_MODEL: " vendor/model:free ", DAEMON_MAX_TOKENS: "16000", DAEMON_TIMEOUT_MS: "240000",
    DREAM_LLM_MODEL: " vendor/dream-v2 ", DREAM_MAX_TOKENS: "4000", DREAM_TIMEOUT_MS: "180000" });
  const timeout = spyOn(AbortSignal, "timeout"); spies.push(timeout);
  await runDaemon(f.env, pause, pause);
  await processDream(f.env, pause);
  expect(f.bodies[0]).toMatchObject({ model: "vendor/model:free", max_tokens: 16000 });
  expect(f.bodies[1]).toMatchObject({ model: "vendor/dream-v2", max_tokens: 4000 });
  expect(timeout.mock.calls.map(c => c[0])).toEqual([240000, 180000]);
  expect(await f.health()).toMatchObject(daemonSettings(f.env));
  expect(await (await dream.fetch(new Request("https://dream.test/health"), f.env)).json()).toMatchObject(dreamSettings(f.env));
});

for (const value of [undefined, "", " ", "0", "-1", "1.5", "1e4", "+8000", "NaN", "Infinity", "99999999999999999", "12ms"]) {
  test(`invalid integer settings use defaults: ${String(value)}`, () => {
    expect(daemonSettings({ DAEMON_MAX_TOKENS: value, DAEMON_TIMEOUT_MS: value })).toEqual(daemonSettings({}));
    expect(dreamSettings({ DREAM_MAX_TOKENS: value, DREAM_TIMEOUT_MS: value })).toEqual(dreamSettings({}));
  });
}
for (const [tokens, timeout, valid] of [[256, 1000, true], [32768, 300000, true], [255, 999, false], [32769, 300001, false]] as const) {
  test(`integer boundary ${tokens}/${timeout}`, () => {
    const d = daemonSettings({ DAEMON_MAX_TOKENS: ` ${tokens} `, DAEMON_TIMEOUT_MS: String(timeout) });
    const r = dreamSettings({ DREAM_MAX_TOKENS: String(tokens), DREAM_TIMEOUT_MS: String(timeout) });
    expect(d.daemon_max_tokens).toBe(valid ? tokens : 8000);
    expect(d.daemon_timeout_ms).toBe(valid ? timeout : 120000);
    expect(r.dream_max_tokens).toBe(valid ? tokens : 2000);
    expect(r.dream_timeout_ms).toBe(valid ? timeout : 60000);
  });
}
for (const value of [undefined, "", " ", "vendor/model?key=secret", "x\ny", "a".repeat(201), "model name", "/model", "模型"]) {
  test(`invalid model defaults: ${String(value).slice(0, 30)}`, () => {
    expect(daemonSettings({ DAEMON_LLM_MODEL: value }).daemon_llm_model).toBe(defaultModel);
    expect(dreamSettings({ DREAM_LLM_MODEL: value }).dream_llm_model).toBe(defaultModel);
  });
}

for (const code of ["provider_http 400", "provider_http 404", "provider_unreachable", "provider_timeout", "provider_response 200", "write_failed", "unexpected"]) {
  test(`failure persists and exposes only bounded details: ${code}`, async () => {
    const f = fixture();
    if (code === "write_failed") f.fail("UPDATE daemon_runs SET raw_response");
    else if (code === "unexpected") f.fail("SELECT id, ts, kind, content");
    else globalThis.fetch = (async (_url, init) => {
      if (code.startsWith("provider_http")) return new Response(JSON.stringify({ user_id: marker, request: init!.body }), { status: Number(code.split(" ")[1]) });
      if (code === "provider_unreachable") throw new Error(marker);
      if (code === "provider_timeout") throw new DOMException(marker, "TimeoutError");
      return Response.json({ choices: [{ message: { content: marker } }] });
    }) as typeof fetch;
    expect(await runDaemon(f.env, pause, pause)).toMatchObject({ ok: false, reason: code });
    expect(f.row().error_message).toBe(code);
    if (code === "provider_response 200") expect(f.row().raw_response).toBe(marker);
    else {
      expect(f.row().raw_response).toBeNull();
      expect(JSON.stringify(f.row())).not.toContain(marker);
    }
    const log = JSON.stringify((console.error as any).mock.calls);
    if (code === "unexpected" || code === "write_failed") expect(log).toContain(`Error: ${marker}`);
    else expect(log).not.toContain(marker);
    expect((await f.health()).warnings).toContain(`last daemon run failed: ${code}`);
  });
}

for (const body of ["not json", JSON.stringify({ choices: [{ message: { content: { user_id: marker } } }] }),
  JSON.stringify({ choices: [{ message: { content: '{"mood":null}' } }] }), JSON.stringify({ choices: [] })]) {
  test(`unusable provider envelope/proposal is bounded: ${body.slice(0, 45)}`, async () => {
    const f = fixture();
    globalThis.fetch = (async () => new Response(body)) as typeof fetch;
    await runDaemon(f.env, pause, pause);
    expect(f.row().error_message).toBe("provider_response 200");
    expect(f.row().raw_response).toBe(body.includes('{\\"mood\\":null}') ? '{"mood":null}' : null);
  });
}

for (const value of [`OpenRouter 400: {"user_id":"${marker}"}`, `OpenRouter 503 after 4 attempts: ${marker}`,
  `provider_http 400 ${marker}`, marker, `OpenRouter 4000: ${marker}`]) {
  test(`historical error is withheld: ${value.slice(0, 35)}`, async () => {
    const f = fixture();
    f.db.run("INSERT INTO daemon_runs (mode, ok, error_message) VALUES ('normal', 3, ?)", [value]);
    const warnings = (await f.health()).warnings;
    expect(warnings[0]).toStartWith("last daemon run failed: details withheld (recorded before 1.0.3)");
    if (value.startsWith("OpenRouter 400:")) expect(warnings[0]).toEndWith("(HTTP 400)");
    if (value.startsWith("OpenRouter 4000:")) expect(warnings[0]).not.toContain("HTTP");
  });
}

test("preflight and terminal storage errors never escape as raw exception messages", async () => {
  const f = fixture();
  f.fail("SELECT id FROM daemon_runs WHERE ok = 0");
  await expect(runDaemon(f.env, pause, pause)).rejects.toThrow("unexpected");
  expect(f.row()).toBeNull();
  f.fail("INSERT INTO daemon_runs");
  await expect(runDaemon(f.env, pause, pause)).rejects.toThrow("write_failed");
  expect(f.row()).toBeNull();
});

test("timeout while reading a provider body is classified without copying it", async () => {
  const f = fixture();
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => { throw new DOMException(marker, "AbortError"); } })) as any;
  await runDaemon(f.env, pause, pause);
  expect(f.row().error_message).toBe("provider_timeout");
  expect(f.row().raw_response).toBeNull();
});

for (const [content, limit] of [
  [marker + "x".repeat(9000), 8000],
  [JSON.stringify({ mood: null, notes: [marker + "x".repeat(6000)] }), 5000],
] as const) {
  test(`unusable model output is retained privately and truncated to ${limit}`, async () => {
    const f = fixture();
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content } }] })) as typeof fetch;
    await runDaemon(f.env, pause, pause);
    expect(f.row().raw_response).toBe(content.slice(0, limit));
    expect(f.row().error_message).toBe("provider_response 200");
    expect((await f.health()).warnings).toContain("last daemon run failed: provider_response 200");
    expect(JSON.stringify((console.error as any).mock.calls)).not.toContain(marker);
  });
}

test("provider HTTP errors never read or store the echoed error body", async () => {
  const f = fixture();
  const read = () => { throw new Error("HTTP error body must not be read"); };
  globalThis.fetch = (async () => ({ ok: false, status: 401, json: read, text: read })) as any;
  await runDaemon(f.env, pause, pause);
  expect(f.row().error_message).toBe("provider_http 401");
  expect(f.row().raw_response).toBeNull();
  expect(JSON.stringify((console.error as any).mock.calls)).not.toContain("must not be read");
});

for (const [sql, code] of [["UPDATE daemon_runs SET raw_response", "write_failed"],
  ["SELECT id, ts, kind, content", "unexpected"],
  ["SELECT id FROM daemon_runs WHERE ok = 0", "unexpected"],
  ["INSERT INTO daemon_runs", "write_failed"],
  ["ok = 2, error_message", "write_failed"]]) {
  test(`internal diagnostics stay in the bounded private log: ${sql}`, async () => {
    const f = fixture();
    const message = `D1_ERROR: no such column: ${marker} ` + "x".repeat(600);
    f.fail(sql, message);
    if (sql.startsWith("ok = 2")) globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: marker } }] })) as typeof fetch;
    try { await runDaemon(f.env, pause, pause); } catch (error) { expect((error as Error).message).toBe(code); }
    const calls = (console.error as any).mock.calls;
    expect(calls).toContainEqual(["memory daemon failed:", code, `Error: ${message}`.slice(0, 500)]);
    expect(JSON.stringify(calls)).not.toContain(message);
    expect(JSON.stringify(f.row())).not.toContain(marker);
    if (f.row()?.error_message) {
      expect(f.row().error_message).toBe(code);
      expect(JSON.stringify(await f.health())).not.toContain("D1_ERROR");
    }
  });
}

test("non-string settings cannot escape validation", () => {
  for (const value of [123, {}, null, true]) {
    expect(daemonSettings({ DAEMON_LLM_MODEL: value, DAEMON_MAX_TOKENS: value, DAEMON_TIMEOUT_MS: value } as any)).toEqual(daemonSettings({}));
    expect(dreamSettings({ DREAM_LLM_MODEL: value, DREAM_MAX_TOKENS: value, DREAM_TIMEOUT_MS: value } as any)).toEqual(dreamSettings({}));
  }
});

test("dream failures warn, while disabled, absent, and successful attempts do not", async () => {
  const f = fixture();
  f.db.exec("INSERT INTO daemon_runs (mode, ok) VALUES ('normal', 1)");
  expect((await f.health()).warnings).toEqual([]);
  f.db.exec("INSERT INTO dream_runs (started_at, result, error_code, error_status) VALUES (datetime('now'), 'failed', 'provider_http', 400)");
  expect((await f.health()).warnings).toEqual(["last dream attempt failed: provider_http 400"]);
  f.env.EMBERVY_DREAM = "off";
  expect((await f.health()).warnings).toEqual([]);
  delete f.env.EMBERVY_DREAM;
  f.db.exec("INSERT INTO dream_runs (started_at, result) VALUES (datetime('now'), 'ok')");
  expect((await f.health()).warnings).toEqual([]);
});
