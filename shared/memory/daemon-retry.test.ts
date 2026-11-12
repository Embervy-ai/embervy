// Tests database retries without repeating model calls or other side effects.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { runDaemon, runMechanicalDecay } from "./src/daemon";
import { retryD1Write } from "./src/d1-retry";

const LOST = "D1_ERROR: Network connection lost";
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();
type Method = "run" | "first" | "all" | "batch";
type Rule = { sql: string; method?: Method; nth: number[]; message: string; committed?: boolean; seen?: number };

function fixture(payload: unknown = {}) {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  db.exec(`INSERT INTO events_hot (id, ts, kind, content, embedded) VALUES
    (1, datetime('now', '-2 days'), 'observation', 'first observation', 0),
    (2, datetime('now', '-1 days'), 'observation', 'second observation', 0)`);
  const rules: Rule[] = [];
  const calls: { sql: string; method: Method; binds: unknown[] }[] = [];
  const attempts = new Map<object, number>();
  const pauses: number[] = [];
  let modelCalls = 0;
  let vectorCalls = 0;
  let vectorFailure = false;
  let status = 200;
  let statusQueue: number[] = [];
  let retryAfter: string | undefined;
  const modelPauses: number[] = [];
  let raw: string | undefined;
  function fault(sql: string, method: Method, binds: unknown[]) {
    calls.push({ sql, method, binds });
    let failure: Rule | undefined;
    for (const rule of rules) {
      if (method !== (rule.method ?? "run") || !sql.includes(rule.sql)) continue;
      rule.seen = (rule.seen ?? 0) + 1;
      if (rule.nth.includes(rule.seen)) failure = rule;
    }
    return failure;
  }
  const env: any = {
    OPENROUTER_API_KEY: "test-only",
    DAEMON_LLM_URL: "https://daemon.invalid",
    DB: {
      prepare(input: string) {
        const sql = normalize(input);
        function statement(binds: unknown[] = []) {
          const native = {
            bind(...values: unknown[]) { return statement(values); },
            async first() {
              const failure = fault(sql, "first", binds);
              if (failure) throw new Error(failure.message);
              return db.query(input).get(...binds as any[]);
            },
            async all() {
              const failure = fault(sql, "all", binds);
              if (failure) throw new Error(failure.message);
              return { results: db.query(input).all(...binds as any[]) };
            },
            async run() {
              attempts.set(native, (attempts.get(native) ?? 0) + 1);
              const failure = fault(sql, "run", binds);
              if (failure && !failure.committed) throw new Error(failure.message);
              const result = db.query(input).run(...binds as any[]);
              if (failure) throw new Error(failure.message);
              return { success: true, results: [], meta: { ...result, last_row_id: Number(result.lastInsertRowid) } };
            },
          };
          return native;
        }
        return statement();
      },
      async batch(statements: any[]) {
        const failure = fault("batch", "batch", []);
        if (failure && !failure.committed) throw new Error(failure.message);
        db.exec("BEGIN");
        let results: any[];
        try {
          results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        if (failure) throw new Error(failure.message);
        return results;
      },
    },
    VECTORS: { async deleteByIds() {
      vectorCalls++;
      if (vectorFailure) throw new Error(LOST);
    } },
    ARCHIVE: { async delete() {} },
  };
  const pause = async (milliseconds: number) => { pauses.push(milliseconds); };
  async function run() {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      modelCalls++;
      const code = statusQueue.length ? statusQueue.shift()! : status;
      const headers: Record<string, string> = code !== 200 && retryAfter !== undefined ? { "Retry-After": retryAfter } : {};
      return new Response(code === 200 ? JSON.stringify({ choices: [{ message: { content: raw ?? JSON.stringify(payload) } }] }) : "model unavailable", { status: code, headers });
    }) as typeof fetch;
    try { return await runDaemon(env, pause, async milliseconds => { modelPauses.push(milliseconds); }); }
    finally { globalThis.fetch = original; }
  }
  return {
    db, env, rules, calls, pauses, modelPauses, attempts, pause, run,
    setResponse(value: string, code = 200) { raw = value; status = code; },
    busyFirst(...codes: number[]) { statusQueue = codes; },
    setRetryAfter(value: string) { retryAfter = value; },
    failVectors() { vectorFailure = true; },
    get modelCalls() { return modelCalls; },
    get vectorCalls() { return vectorCalls; },
    count(sql: string, method: Method = "run") { return calls.filter(call => call.method === method && call.sql.includes(sql)).length; },
    row() { return db.query("SELECT * FROM daemon_runs ORDER BY id DESC LIMIT 1").get() as any; },
    close() {
      try {
        for (const attemptsForStatement of attempts.values()) expect(attemptsForStatement).toBeLessThanOrEqual(2);
        for (const milliseconds of pauses) {
          expect(milliseconds).toBeGreaterThanOrEqual(2000);
          expect(milliseconds).toBeLessThanOrEqual(4000);
        }
      } finally { db.close(); }
    },
  };
}

const surface = { pattern: "Quiet tasks improve sustained concentration", observations: ["Working without alerts kept attention steady", "A muted phone helped finish a difficult task"], source_event_ids: [1, 2], confidence: 0.8 };
const mood = { label: "focused", summary: ["Steady attention"], hot_entities: [], active_surface_count: 0 };
const full = {
  surfaces: [surface], consolidations: [{ duplicate_event_ids: [1, 2], keep_id: 2, reason: "same event" }],
  mood, resolutions_proposed: [{ event_id: 1, note: "finished" }],
  edges_proposed: [{ from_event: 1, to_event: 2, relation: "led_to", reason: "sequence" }], notes: ["A useful distinction"],
};
const RAW = "UPDATE daemon_runs SET raw_response = ?";

for (const message of [LOST, "D1_ERROR: storage caused object to be reset", "D1_ERROR: reset because its code was updated"]) {
  test(`safe write retries once: ${message}`, async () => {
    const f = fixture();
    try {
      f.rules.push({ sql: RAW, nth: [1], message });
      expect((await f.run()).ok).toBe(true);
      expect(f.count(RAW)).toBe(2);
      expect(f.row().ok).toBe(1);
      expect(f.pauses).toHaveLength(1);
      expect(f.modelCalls).toBe(1);
    } finally { f.close(); }
  });
}

test("second safe-write failure reaches the existing failed-run path", async () => {
  const f = fixture();
  try {
    f.rules.push({ sql: RAW, nth: [1, 2], message: LOST });
    expect(await f.run()).toEqual({ ok: false, mode: "?", reason: "daemon failed" });
    expect(f.count(RAW)).toBe(2);
    expect(f.row().ok).toBe(3);
    expect(f.row().error_message).toBe(LOST);
    expect(f.row().finished_at).not.toBeNull();
    expect(f.pauses).toHaveLength(1);
    expect(f.modelCalls).toBe(1);
  } finally { f.close(); }
});

test("non-retryable write error is attempted once", async () => {
  const f = fixture();
  try {
    f.rules.push({ sql: RAW, nth: [1], message: "no such table" });
    expect((await f.run()).ok).toBe(false);
    expect(f.count(RAW)).toBe(1);
    expect(f.row().ok).toBe(3);
    expect(f.pauses).toHaveLength(0);
  } finally { f.close(); }
});

const inserts = [
  { sql: "INSERT INTO daemon_runs", table: "daemon_runs", payload: {} },
  { sql: "INSERT INTO events_hot", table: "events_hot WHERE kind = 'surface'", payload: { surfaces: [surface] } },
  { sql: "INSERT INTO consolidation_proposals", table: "consolidation_proposals", payload: { consolidations: full.consolidations } },
  { sql: "INSERT INTO resolution_proposals", table: "resolution_proposals", payload: { resolutions_proposed: full.resolutions_proposed } },
  { sql: "INSERT INTO event_edges", table: "event_edges", payload: { edges_proposed: full.edges_proposed } },
  { sql: "INSERT INTO events_hot", table: "events_hot WHERE source = 'daemon'", payload: { notes: full.notes } },
];
for (const insert of inserts) {
  for (const committed of [false, true]) {
    test(`${insert.table}: lost insert acknowledgement, committed=${committed}`, async () => {
      const f = fixture(insert.payload);
      try {
        f.rules.push({ sql: insert.sql, nth: [1], message: LOST, committed });
        expect((await f.run()).ok).toBe(true);
        expect(f.db.query(`SELECT COUNT(*) AS n FROM ${insert.table}`).get()).toEqual({ n: 1 });
        expect(f.count(insert.sql)).toBe(committed ? 1 : 2);
        expect(f.pauses).toHaveLength(committed ? 0 : 1);
        expect(f.row().ok).toBe(1);
        expect(f.modelCalls).toBe(1);
      } finally { f.close(); }
    });
  }
  test(`${insert.table}: second insert failure has no third attempt`, async () => {
    const f = fixture(insert.payload);
    try {
      f.rules.push({ sql: insert.sql, nth: [1, 2], message: LOST });
      if (insert.table === "daemon_runs") {
        await expect(f.run()).rejects.toThrow(LOST);
        expect(f.modelCalls).toBe(0);
      } else {
        expect((await f.run()).ok).toBe(false);
        expect(f.row().ok).toBe(3);
      }
      expect(f.count(insert.sql)).toBe(2);
    } finally { f.close(); }
  });
  test(`${insert.table}: non-retryable insert error does not check or retry`, async () => {
    const f = fixture(insert.payload);
    try {
      f.rules.push({ sql: insert.sql, nth: [1], message: "no such table" });
      if (insert.table === "daemon_runs") await expect(f.run()).rejects.toThrow("no such table");
      else expect((await f.run()).ok).toBe(false);
      expect(f.count(insert.sql)).toBe(1);
      expect(f.pauses).toHaveLength(0);
    } finally { f.close(); }
  });
}

test("failed insert-existence read fails closed instead of inserting blindly", async () => {
  const f = fixture({ notes: ["note"] });
  try {
    f.rules.push({ sql: "INSERT INTO events_hot", nth: [1], message: LOST, committed: true });
    f.rules.push({ sql: "SELECT id FROM events_hot WHERE id >", method: "first", nth: [1], message: LOST });
    expect((await f.run()).ok).toBe(false);
    expect(f.count("INSERT INTO events_hot")).toBe(1);
    expect(f.row().ok).toBe(3);
  } finally { f.close(); }
});

test("surface recovery cannot mistake an older matching row for this insert", async () => {
  const f = fixture({ surfaces: [surface] });
  try {
    const meta = JSON.stringify({ observations: surface.observations, source_event_ids: [1, 2], show_count: 0, confidence: 0.8 });
    f.db.run("INSERT INTO events_hot (ts, kind, content, source, weight, meta) VALUES (datetime('now', '-20 days'), 'surface', ?, 'inferred', 'medium', ?)", [surface.pattern, meta]);
    f.rules.push({ sql: "INSERT INTO events_hot", nth: [1], message: LOST });
    expect((await f.run()).ok).toBe(true);
    expect(f.count("INSERT INTO events_hot")).toBe(2);
    expect(f.db.query("SELECT COUNT(*) AS n FROM events_hot WHERE kind = 'surface'").get()).toEqual({ n: 2 });
  } finally { f.close(); }
});

test("repeated notes retain existing semantics but recovery adds no extra copy", async () => {
  const f = fixture({ notes: ["same", "same"] });
  try {
    f.rules.push({ sql: "INSERT INTO events_hot", nth: [2], message: LOST, committed: true });
    expect((await f.run()).ok).toBe(true);
    expect(f.db.query("SELECT COUNT(*) AS n FROM events_hot WHERE source = 'daemon'").get()).toEqual({ n: 2 });
    expect(f.count("INSERT INTO events_hot")).toBe(2);
  } finally { f.close(); }
});

for (const sql of [
  "DELETE FROM consolidation_proposals WHERE proposed_at",
  "DELETE FROM resolution_proposals WHERE proposed_at",
  "CREATE TABLE IF NOT EXISTS resolution_proposals",
  "CREATE TABLE IF NOT EXISTS event_edges",
  "CREATE TABLE IF NOT EXISTS event_deletions",
  "UPDATE events_hot SET last_accessed_at",
  "UPDATE daemon_runs SET finished_at = datetime('now'), mode = ?",
  "UPDATE mood_state SET pending_label = ?",
]) {
  test(`safe direct/delegated write retries: ${sql}`, async () => {
    const f = fixture(full);
    try {
      f.rules.push({ sql, nth: [1], message: LOST });
      expect((await f.run()).ok).toBe(true);
      expect(f.count(sql)).toBe(2);
      expect(f.row().ok).toBe(1);
      expect(f.modelCalls).toBe(1);
    } finally { f.close(); }
  });
}

for (const pending of [false, true]) {
  test(`mood update retries, pending confirmation=${pending}`, async () => {
    const f = fixture({ mood });
    try {
      if (pending) f.db.run("UPDATE mood_state SET pending_label = 'focused', pending_at = datetime('now')");
      else f.db.run("UPDATE mood_state SET mood_label = 'focused'");
      const sql = pending ? "UPDATE mood_state SET mood_label = ?" : "UPDATE mood_state SET mood_summary = ?";
      f.rules.push({ sql, nth: [1], message: LOST, committed: true });
      expect((await f.run()).ok).toBe(true);
      expect(f.count(sql)).toBe(2);
      expect(f.db.query("SELECT mood_label, pending_label FROM mood_state").get()).toEqual({ mood_label: "focused", pending_label: null });
    } finally { f.close(); }
  });
}

for (const sql of ["UPDATE events_hot SET resolved_at", "DELETE FROM resolution_proposals WHERE event_id"]) {
  test(`confirmed resolution retries: ${sql}`, async () => {
    const f = fixture({ resolutions_proposed: full.resolutions_proposed });
    try {
      f.db.exec("CREATE TABLE resolution_proposals (id INTEGER PRIMARY KEY, event_id INTEGER, note TEXT, proposed_at TEXT); INSERT INTO resolution_proposals VALUES (1, 1, 'old', datetime('now', '-24 hours'))");
      f.rules.push({ sql, nth: [1], message: LOST, committed: true });
      expect((await f.run()).ok).toBe(true);
      expect(f.count(sql)).toBe(2);
      expect((f.db.query("SELECT resolved_at FROM events_hot WHERE id = 1").get() as any).resolved_at).not.toBeNull();
      expect(f.db.query("SELECT * FROM resolution_proposals").all()).toHaveLength(0);
    } finally { f.close(); }
  });
}

function seedConsolidation(f: ReturnType<typeof fixture>) {
  f.db.exec("INSERT INTO consolidation_proposals (duplicate_ids, keep_id, reason) VALUES ('[1]', 2, 'old')");
}
for (const gone of ["duplicate", "keep"]) {
  test(`a confirmed merge whose ${gone} left hot storage is dropped and the night succeeds`, async () => {
    const f = fixture({ consolidations: full.consolidations });
    try {
      seedConsolidation(f);
      f.db.exec(`DELETE FROM events_hot WHERE id = ${gone === "duplicate" ? 1 : 2}`);
      expect((await f.run()).ok).toBe(true);
      expect(f.db.query("SELECT * FROM consolidation_proposals").all()).toHaveLength(0);
      if (gone === "keep") expect((f.db.query("SELECT meta FROM events_hot WHERE id = 1").get() as any).meta ?? "").not.toContain("consolidated_into");
    } finally { f.close(); }
  });
}
for (const committed of [false, true]) {
  test(`delegated consolidation intent insert recovery, committed=${committed}`, async () => {
    const f = fixture({ consolidations: full.consolidations });
    try {
      seedConsolidation(f);
      f.rules.push({ sql: "INSERT INTO event_deletions", nth: [1], message: LOST, committed });
      expect((await f.run()).ok).toBe(true);
      expect(f.count("INSERT INTO event_deletions")).toBe(committed ? 1 : 2);
      expect((f.db.query("SELECT meta FROM events_hot WHERE id = 1").get() as any).meta).toContain('"consolidated_into":2');
      expect(f.db.query("SELECT * FROM event_deletions").all()).toHaveLength(0);
    } finally { f.close(); }
  });
}
for (const committed of [false, true]) {
  for (const twice of [false, true]) {
    test(`atomic merge batch has one retry budget, committed=${committed}, twice=${twice}`, async () => {
      const f = fixture({ consolidations: full.consolidations });
      try {
        seedConsolidation(f);
        f.rules.push({ sql: "batch", method: "batch", nth: twice ? [1, 2] : [1], message: LOST, committed });
        expect((await f.run()).ok).toBe(!twice);
        expect(f.count("batch", "batch")).toBe(2);
        expect(f.row().ok).toBe(twice ? 3 : 1);
        expect(f.modelCalls).toBe(1);
      } finally { f.close(); }
    });
  }
}
for (const sql of ["DELETE FROM consolidation_proposals WHERE id", "DELETE FROM event_deletions WHERE id"]) {
  test(`confirmed merge cleanup retries: ${sql}`, async () => {
    const f = fixture({ consolidations: full.consolidations });
    try {
      seedConsolidation(f);
      f.rules.push({ sql, nth: [1], message: LOST, committed: true });
      expect((await f.run()).ok).toBe(true);
      expect(f.count(sql)).toBe(2);
    } finally { f.close(); }
  });
}

test("consolidation does not retry Vectorize even for a retryable-looking error", async () => {
  const f = fixture({ consolidations: full.consolidations });
  try {
    seedConsolidation(f);
    f.db.exec("UPDATE events_hot SET embedded = 1 WHERE id = 1");
    f.failVectors();
    expect((await f.run()).ok).toBe(false);
    expect(f.vectorCalls).toBe(1);
    expect(f.row().ok).toBe(3);
    expect(f.pauses).toHaveLength(0);
  } finally { f.close(); }
});

for (const kind of ["http", "json", "schema", "catch"]) {
  test(`terminal ${kind} daemon_runs update retries without repeating the model`, async () => {
    const f = fixture();
    try {
      let sql: string;
      if (kind === "http") { f.setResponse("", 401); sql = "ok = 3, error_message = ?"; }
      else if (kind === "json") { f.setResponse("not json"); sql = "error_message = 'JSON parse failed'"; }
      else if (kind === "schema") { f.setResponse('{"mood":null}'); sql = "ok = 2, error_message = ?"; }
      else {
        f.rules.push({ sql: RAW, nth: [1], message: "no such table" });
        sql = "ok = 3, error_message = ?";
      }
      f.rules.push({ sql, nth: [1], message: LOST });
      expect((await f.run()).ok).toBe(false);
      expect(f.count(sql)).toBe(2);
      expect(f.row().ok).toBe(kind === "json" || kind === "schema" ? 2 : 3);
      expect(f.modelCalls).toBe(1);
    } finally { f.close(); }
  });
}

test("a failed failure-marker update propagates after exactly two attempts", async () => {
  const f = fixture();
  try {
    f.rules.push({ sql: RAW, nth: [1], message: "no such table" });
    f.rules.push({ sql: "ok = 3, error_message = ?", nth: [1, 2], message: LOST });
    await expect(f.run()).rejects.toThrow(LOST);
    expect(f.count("ok = 3, error_message = ?")).toBe(2);
  } finally { f.close(); }
});

test("read errors are left to D1, not retried by the write helper", async () => {
  const f = fixture();
  try {
    f.rules.push({ sql: "SELECT id, ts, kind, content", method: "all", nth: [1], message: LOST });
    expect((await f.run()).ok).toBe(false);
    expect(f.count("SELECT id, ts, kind, content", "all")).toBe(1);
    expect(f.modelCalls).toBe(0);
  } finally { f.close(); }
});

test("run lock still prevents model and writes", async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO daemon_runs (mode, ok) VALUES ('normal', 0)");
    expect((await f.run()).reason).toContain("daemon already running");
    expect(f.modelCalls).toBe(0);
    expect(f.calls.filter(call => call.method === "run")).toHaveLength(0);
  } finally { f.close(); }
});

test("mechanical multiplicative decay is never retried", async () => {
  const f = fixture();
  try {
    f.rules.push({ sql: "UPDATE events_hot SET access_count", nth: [1], message: LOST });
    await expect(runMechanicalDecay(f.env)).rejects.toThrow(LOST);
    expect(f.count("UPDATE events_hot SET access_count")).toBe(1);
    expect(f.pauses).toHaveLength(0);
  } finally { f.close(); }
});

test("helper propagates the actual second error without retrying it", async () => {
  const first = new Error(LOST);
  const second = new Error("D1_ERROR: storage caused object to be reset");
  let attempts = 0;
  let pauses = 0;
  await expect(retryD1Write(async () => { throw ++attempts === 1 ? first : second; }, {
    pause: async () => { pauses++; },
  })).rejects.toBe(second);
  expect(attempts).toBe(2);
  expect(pauses).toBe(1);
});

test("a busy model provider is asked again after growing pauses, and the run completes", async () => {
  const f = fixture();
  try {
    f.busyFirst(429, 502, 503);
    expect((await f.run()).ok).toBe(true);
    expect(f.modelCalls).toBe(4);
    expect(f.modelPauses).toEqual([30_000, 120_000, 300_000]);
    expect(f.row().ok).toBe(1);
  } finally { f.close(); }
});

test("a provider that stays busy fails the run once, with the number of attempts", async () => {
  const f = fixture();
  try {
    f.setResponse("", 504);
    const result = await f.run();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("OpenRouter 504");
    expect(f.modelCalls).toBe(4);
    expect(f.row().ok).toBe(3);
    expect(f.row().error_message).toStartWith("OpenRouter 504 after 4 attempts: ");
  } finally { f.close(); }
});

test("other model errors are not asked again", async () => {
  const f = fixture();
  try {
    f.setResponse("", 400);
    expect((await f.run()).ok).toBe(false);
    expect(f.modelCalls).toBe(1);
    expect(f.modelPauses).toHaveLength(0);
    expect(f.row().error_message).toStartWith("OpenRouter 400: ");
  } finally { f.close(); }
});

test("a longer Retry-After is honoured, capped at five minutes", async () => {
  const f = fixture();
  try {
    f.setRetryAfter("90");
    f.busyFirst(429);
    expect((await f.run()).ok).toBe(true);
    f.setRetryAfter("3600");
    f.busyFirst(429, 429);
    expect((await f.run()).ok).toBe(true);
    expect(f.modelPauses).toEqual([90_000, 300_000, 300_000]);
  } finally { f.close(); }
});
