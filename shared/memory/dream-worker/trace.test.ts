import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import worker, { runDream } from "./src/index";
import memoryWorker from "../src/index";

const realFetch = globalThis.fetch;
const databases: Database[] = [];
const spies: { mockRestore(): void }[] = [];
const marker = "PRIVATE-provider-body-conversation-sk-secret-https://secret.invalid/?key=secret";
const instant = "2026-05-04T04:00:00.000Z";
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
  spies.splice(0).forEach(s => s.mockRestore());
  databases.splice(0).forEach(db => db.close());
});

function fixture() {
  setSystemTime(new Date(instant));
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const writes: string[] = [];
  const failures = new Set<string>();
  const env: any = {
    DREAM_TIMEZONE: "UTC", DREAM_HOUR: "4", DREAM_AUTH_TOKEN: "test", EMBERVY_API_KEY: "test",
    OPENROUTER_API_KEY: marker, RAG_AUTH_TOKEN: marker,
    RAG: { fetch: async () => Response.json({ results: [{ content: "A chronicle fragment" }] }) },
    DB: { prepare(sql: string) {
      let args: any[] = [];
      return {
        bind(...values: any[]) { args = values; return this; },
        async first() { return db.query(sql).get(...args); },
        async run() {
          writes.push(sql);
          if ([...failures].some(part => sql.includes(part))) throw new Error(marker);
          return db.query(sql).run(...args);
        },
      };
    } },
  };
  let calls = 0;
  const prompts: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    calls++;
    prompts.push(JSON.parse(init?.body as string).messages[0].content);
    return Response.json({ choices: [{ message: { content: "A quiet note" } }] });
  }) as typeof fetch;
  const pauses: number[] = [];
  const pause = async (ms: number) => { pauses.push(ms); };
  const trace = () => db.query("SELECT started_at, result, error_code, error_status FROM dream_runs ORDER BY id DESC LIMIT 1").get();
  const notes = () => db.query("SELECT content FROM dream_notes").all();
  const log = spyOn(console, "error").mockImplementation(() => {});
  spies.push(log);
  async function health() {
    const response = await memoryWorker.fetch(new Request("https://memory.test/mcp", {
      method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "health", arguments: {} } }),
    }), env);
    const rpc: any = await response.json();
    expect(rpc.error).toBeUndefined();
    expect(rpc.result.isError).not.toBe(true);
    const text = rpc.result.content[0].text;
    return JSON.parse(text.match(/```json\s*([\s\S]*?)```/)[1]);
  }
  async function scheduled() {
    const pending: Promise<unknown>[] = [];
    await worker.scheduled({} as any, env, { waitUntil(p: Promise<unknown>) { pending.push(p); } } as any);
    await Promise.all(pending);
    return pending.length;
  }
  return { db, env, trace, notes, health, pauses, pause, failures, writes, log, scheduled, prompts, get calls() { return calls; } };
}

test("a due scheduled dream writes ok, and health preserves the note timestamp", async () => {
  const s = fixture();
  expect(await s.scheduled()).toBe(1);
  expect(s.trace()).toEqual({ started_at: instant, result: "ok", error_code: null, error_status: null });
  expect(s.notes()).toHaveLength(1);
  const health = await s.health();
  expect(health.dream_last_run).toBe((s.db.query("SELECT created_at FROM dream_notes").get() as any).created_at);
  expect(health).toMatchObject({ dream_last_attempt: instant, dream_last_result: "ok", dream_last_error: null });
});

test("503 exhausts the unchanged retries, leaves a bounded failed trace, and preserves the previous dream", async () => {
  const s = fixture();
  s.db.run("INSERT INTO dream_notes (created_at, content) VALUES (?, ?)", ["2026-05-01 04:00:00", "old note"]);
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response(marker, { status: 503 }); }) as typeof fetch;
  await expect(runDream(s.env, s.pause)).rejects.toThrow("Dream error: OpenRouter 503");
  expect(calls).toBe(4);
  expect(s.pauses).toEqual([30_000, 120_000, 300_000]);
  expect(s.trace()).toEqual({ started_at: instant, result: "failed", error_code: "provider_http", error_status: 503 });
  expect(JSON.stringify(s.trace())).not.toContain(marker);
  const health = await s.health();
  expect(health).toMatchObject({ dream_last_run: "2026-05-01 04:00:00", dream_last_attempt: instant,
    dream_last_result: "failed", dream_last_error: { class: "provider_http", status: 503 } });
  expect(JSON.stringify(health)).not.toContain(marker);
  expect(s.notes()).toEqual([{ content: "old note" }]);
});

for (const body of ["", "not json " + marker, "null", JSON.stringify({ error: marker }),
  ...["", " \n ", null, 123, { text: marker }].map(content => JSON.stringify({ choices: [{ message: { content } }] }))]) {
  test(`unusable provider response is classified without retaining its body: ${body.slice(0, 20)}`, async () => {
    const s = fixture();
    globalThis.fetch = (async () => new Response(body)) as typeof fetch;
    await expect(runDream(s.env, s.pause)).rejects.toThrow("provider_response");
    expect(s.trace()).toEqual({ started_at: instant, result: "failed", error_code: "provider_response", error_status: null });
    expect(JSON.stringify(s.trace())).not.toContain(marker);
    expect(s.notes()).toHaveLength(0);
  });
}

test("network failure is classified without URL or secret from the exception", async () => {
  const s = fixture();
  globalThis.fetch = (async () => { throw new Error(marker); }) as typeof fetch;
  await expect(runDream(s.env, s.pause)).rejects.toThrow("provider_unreachable");
  expect(s.trace()).toMatchObject({ result: "failed", error_code: "provider_unreachable", error_status: null });
  expect(JSON.stringify(s.trace())).not.toContain(marker);
});

for (const [mode, body, placeholder] of [
  ["missing binding", "", "RAG search failed."],
  ["http 500", marker, "RAG unreachable."],
  ["network", "", "RAG search failed."],
  ["json", marker, "RAG search failed."],
  ["null", "null", "No RAG results."],
  ["shape", JSON.stringify({ error: marker }), "No RAG results."],
  ["non-array results", JSON.stringify({ results: { length: 1 } }), "No RAG results."],
  ...[null, {}, { content: 123 }, { content: {} }, { content: "" }, { content: " \n " }]
    .map(row => ["unusable row " + JSON.stringify(row), JSON.stringify({ results: [row] }), "RAG search failed."]),
]) {
  test(`archive search fallback (${mode}) still writes a dream and an ok trace`, async () => {
    const s = fixture();
    if (mode === "missing binding") delete s.env.RAG;
    else s.env.RAG.fetch = async () => {
      if (mode === "network") throw new Error(marker);
      return new Response(body, { status: mode === "http 500" ? 500 : 200 });
    };
    expect(await runDream(s.env, s.pause)).toContain("A quiet note");
    expect(s.trace()).toEqual({ started_at: instant, result: "ok", error_code: null, error_status: null });
    expect(s.calls).toBe(1);
    expect(s.pauses).toEqual([]);
    expect(s.notes()).toHaveLength(1);
    expect(s.prompts[0]).toContain(`=== CHRONICLE FRAGMENTS ===\n${placeholder}\n=== END ===`);
    expect(s.prompts[0]).not.toContain(marker);
    expect(JSON.stringify(s.trace())).not.toContain(marker);
    expect(s.log).not.toHaveBeenCalled();
  });
}

test("a successful empty archive search still uses the existing abstract dream prompt", async () => {
  const s = fixture();
  s.env.RAG.fetch = async () => Response.json({ results: [] });
  await runDream(s.env, s.pause);
  expect(s.trace()).toMatchObject({ result: "ok" });
  expect(s.notes()).toHaveLength(1);
  expect(s.prompts[0]).toContain("=== CHRONICLE FRAGMENTS ===\nNo RAG results.\n=== END ===");
});

test("note write failures leave a trace but no invented success timestamp", async () => {
  const s = fixture();
  s.failures.add("INSERT INTO dream_notes");
  await expect(runDream(s.env, s.pause)).rejects.toThrow("write_failed");
  expect(s.trace()).toMatchObject({ result: "failed", error_code: "write_failed", error_status: null });
  expect((await s.health()).dream_last_run).toBeNull();
  expect(JSON.stringify(s.trace())).not.toContain(marker);
});

test("trace write failure cannot turn a successful dream into a failed request", async () => {
  const s = fixture();
  s.failures.add("INSERT INTO dream_runs");
  const response = await worker.fetch(new Request("https://dream.test/dream", {
    method: "POST", headers: { Authorization: "Bearer test" },
  }), s.env);
  expect(response.status).toBe(200);
  expect((await response.json() as any).status).toBe("dreamed");
  expect(s.trace()).toBeNull();
  expect(s.notes()).toHaveLength(1);
  expect(s.log).toHaveBeenCalledWith("Dream trace could not be stored");
});

test("scheduled failure plus trace failure is caught and logged, not an unhandled rejection", async () => {
  const s = fixture();
  s.failures.add("INSERT INTO dream_runs");
  globalThis.fetch = (async () => new Response(marker, { status: 401 })) as typeof fetch;
  expect(await s.scheduled()).toBe(1);
  expect(s.trace()).toBeNull();
  expect(s.log).toHaveBeenCalledWith("Dream trace could not be stored");
  expect(s.log).toHaveBeenCalledWith("Dream failed: Error: Dream error: OpenRouter 401");
  expect(JSON.stringify(s.log.mock.calls)).not.toContain(marker);
});

test("outside the local dream hour there are no calls, writes or new trace", async () => {
  const s = fixture();
  s.env.DREAM_TIMEZONE = "Europe/Berlin"; // 06:00 locally, not 04:00
  expect(await s.scheduled()).toBe(0);
  expect(s.calls).toBe(0);
  expect(s.writes).toEqual([]);
  expect(s.trace()).toBeNull();
});

test("the worker creates the trace table and index without a migration on repeated runs", async () => {
  const s = fixture();
  s.db.exec("DROP TABLE dream_runs");
  for (const count of [1, 2]) {
    await runDream(s.env, s.pause);
    expect(s.db.query("SELECT * FROM dream_runs").all()).toHaveLength(count);
    expect(s.trace()).toEqual({ started_at: instant, result: "ok", error_code: null, error_status: null });
    expect(s.notes()).toHaveLength(count);
    expect(s.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_dream_runs_started'").get())
      .toEqual({ name: "idx_dream_runs_started" });
  }
  expect(s.log).not.toHaveBeenCalled();
});

test("worker, schema and migration use identical trace table and index definitions", async () => {
  const s = fixture();
  await runDream(s.env, s.pause);
  for (const pattern of [
    /CREATE TABLE IF NOT EXISTS dream_runs \([\s\S]*?\n\);/,
    /CREATE INDEX IF NOT EXISTS idx_dream_runs_started[^;]*;/,
  ]) {
    const runtime = s.writes.filter(sql => pattern.test(sql));
    expect(runtime).toHaveLength(1);
    for (const file of ["../schema.sql", "../migrations/003_dream_runs.sql"]) {
      const definition = readFileSync(new URL(file, import.meta.url), "utf8").match(pattern)?.[0];
      expect(definition).toBe(runtime[0]);
    }
  }
});

test("a failed first dream also creates its trace without a migration", async () => {
  const s = fixture();
  s.db.exec("DROP TABLE dream_runs");
  globalThis.fetch = (async () => new Response(marker, { status: 401 })) as typeof fetch;
  await expect(runDream(s.env, s.pause)).rejects.toThrow("Dream error: OpenRouter 401");
  expect(s.db.query("SELECT * FROM dream_runs").all()).toHaveLength(1);
  expect(s.trace()).toMatchObject({ result: "failed", error_code: "provider_http", error_status: 401 });
  expect(s.log).not.toHaveBeenCalled();
});

for (const statement of ["CREATE TABLE IF NOT EXISTS dream_runs", "CREATE INDEX IF NOT EXISTS idx_dream_runs_started"]) {
  test(`trace initialization failure does not replace the dream outcome: ${statement}`, async () => {
    const s = fixture();
    s.failures.add(statement);
    expect(await runDream(s.env, s.pause)).toContain("A quiet note");
    expect(s.notes()).toHaveLength(1);
    expect(s.trace()).toBeNull();
    globalThis.fetch = (async () => new Response(marker, { status: 401 })) as typeof fetch;
    await expect(runDream(s.env, s.pause)).rejects.toThrow("Dream error: OpenRouter 401");
    expect(s.log).toHaveBeenCalledTimes(2);
    expect(s.log).toHaveBeenCalledWith("Dream trace could not be stored");
    expect(JSON.stringify(s.log.mock.calls)).not.toContain(marker);
  });
}

test("the additive migration can run twice and keeps historical notes and daemon runs", async () => {
  const s = fixture();
  s.db.exec("DROP TABLE dream_runs");
  s.db.exec("INSERT INTO dream_notes (content) VALUES ('old note'); INSERT INTO daemon_runs (ok) VALUES (1)");
  const migration = readFileSync(new URL("../migrations/003_dream_runs.sql", import.meta.url), "utf8");
  s.db.exec(migration);
  await runDream(s.env, s.pause);
  const before = s.db.query("SELECT * FROM dream_runs").all();
  s.db.exec(migration);
  expect(s.db.query("SELECT * FROM dream_runs").all()).toEqual(before);
  expect(s.notes()).toHaveLength(2);
  expect(s.db.query("SELECT ok FROM daemon_runs").all()).toEqual([{ ok: 1 }]);
});

test("health of an old house without dream_runs keeps every old field and returns null trace fields", async () => {
  const s = fixture();
  s.db.exec("INSERT INTO dream_notes (created_at, content) VALUES ('2026-05-01 04:00:00', 'old note')");
  const before = await s.health();
  s.db.exec("DROP TABLE dream_runs");
  const after = await s.health();
  expect(after).toEqual(before);
  expect(after).toMatchObject({ dream_last_attempt: null, dream_last_result: null, dream_last_error: null,
    dream_last_run: "2026-05-01 04:00:00", daemon_last_run: null, daemon_last_ok: false, hot_count: 0,
    archive_count: 0, unresolved_observations: 0, daemon_mode: "normal", backlog_cursor: 0, warnings: ["daemon never ran"] });
});

test("a later success clears the last error and health orders attempts by their start time", async () => {
  const s = fixture();
  s.db.exec("INSERT INTO dream_runs (started_at, result, error_code, error_status) VALUES ('2026-05-03T04:00:00.000Z', 'failed', 'provider_http', 503)");
  await runDream(s.env, s.pause);
  // A late-finishing older attempt must not hide the newest attempt.
  s.db.exec("INSERT INTO dream_runs (started_at, result, error_code) VALUES ('2026-05-02T04:00:00.000Z', 'failed', 'unexpected')");
  expect(await s.health()).toMatchObject({ dream_last_attempt: instant, dream_last_result: "ok", dream_last_error: null });
});
