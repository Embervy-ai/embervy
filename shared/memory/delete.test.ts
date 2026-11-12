import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import worker, { eventVectorIds, consolidateEvent, retryConsolidations } from "./src/index";
import { runMechanicalDecay } from "./src/daemon";

const KEY = "delete-test-key";
function fixture() {
  const db = new Database(":memory:");
  db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
  const objects = new Map<string, string>();
  const vectors = new Set<string>();
  const failures = new Set<string>();
  const env: any = {
    EMBERVY_API_KEY: KEY,
    DB: {
      async batch(statements: any[]) {
        db.exec("BEGIN");
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          db.exec("COMMIT");
          return results;
        } catch (err) { db.exec("ROLLBACK"); throw err; }
      },
      prepare(sql: string) {
      let binds: any[] = [];
      return {
        bind(...args: any[]) { binds = args; return this; },
        async first() { return db.query(sql).get(...binds); },
        async all() { return { results: db.query(sql).all(...binds) }; },
        async run() {
          if (failures.has(sql)) throw new Error("D1 unavailable");
          const result = db.query(sql).run(...binds);
          return { meta: { ...result, last_row_id: Number(result.lastInsertRowid) } };
        },
      };
    } },
    AI: { async run() {
      if (failures.has("embedding")) throw new Error("AI unavailable");
      return { data: [[1, 0, 0]] };
    } },
    ARCHIVE: {
      async put(key: string, value: string) {
        if (failures.has("put")) throw new Error("R2 unavailable");
        objects.set(key, value);
      },
      async get(key: string) {
        const value = objects.get(key);
        return value === undefined ? null : { json: async () => JSON.parse(value), body: value };
      },
      async head(key: string) { return objects.has(key) ? { size: objects.get(key)!.length } : null; },
      async delete(key: string) {
        if (failures.has(key)) throw new Error("R2 unavailable");
        objects.delete(key);
      },
    },
    VECTORS: {
      // Like the real index: with metadata, a topK above 50 fails the whole query.
      async query(_vec: number[], opts: { topK: number; returnMetadata?: string }) {
        if (opts.returnMetadata === "all" && opts.topK > 50) throw new Error("VECTOR_QUERY_ERROR: topK too large");
        return { matches: [...vectors].slice(0, opts.topK).map(id => ({ id, score: 0.9 })) };
      },
      async upsert(rows: any[]) { rows.forEach(row => vectors.add(row.id)); },
      async getByIds(ids: string[]) { return ids.filter(id => vectors.has(id)).map(id => ({ id })); },
      async deleteByIds(ids: string[]) {
        if (failures.has("vectors")) throw new Error("Vectorize unavailable");
        ids.forEach(id => vectors.delete(id));
      },
    },
  };
  const request = (path: string) => worker.fetch(new Request(`https://memory.example${path}`, { headers: { Authorization: `Bearer ${KEY}` } }), env);
  async function tool(name: string, args: any) {
    const response = await worker.fetch(new Request("https://memory.example/mcp", {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }), env);
    const reply: any = await response.json();
    expect(reply.error).toBeUndefined();
    return reply.result;
  }
  function seed(id: number, kind = "observation", archived = false) {
    const content = "private needle ".repeat(2000);
    if (archived) {
      db.run("INSERT INTO events_archive (id, ts, kind, summary, r2_path) VALUES (?, datetime('now'), ?, ?, ?)", [id, kind, "private needle", `archive/${id}.json`]);
      objects.set(`archive/${id}.json`, JSON.stringify({ content }));
    } else db.run("INSERT INTO events_hot (id, kind, content) VALUES (?, ?, ?)", [id, kind, content]);
    eventVectorIds(id, content).forEach(v => vectors.add(v));
  }
  return { db, objects, vectors, failures, env, request, tool, seed };
}

for (const kind of ["hot", "archive", "image", "video"]) {
  test(`delete removes ${kind}, vectors and all media access`, async () => {
    const f = fixture();
    try {
      f.seed(1, kind === "hot" || kind === "archive" ? "observation" : kind, kind === "archive");
      if (kind === "image") f.db.run("INSERT INTO images_data (path, data, mime_type, event_id) VALUES ('image', 'aGk=', 'image/png', 1)");
      if (kind === "video") f.objects.set("videos/1.mp4", "video bytes");
      if (kind === "image" || kind === "video") expect((await f.request(`/${kind}s/1`)).status).toBe(200);
      const result = await f.tool("delete", { event_id: 1 });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Deleted event 1.");
      for (const table of ["events_hot", "events_archive", "images_data", "event_deletions"]) expect(f.db.query(`SELECT * FROM ${table}`).all()).toHaveLength(0);
      expect(f.objects.size).toBe(0);
      expect(f.vectors.size).toBe(0);
      for (const route of ["images", "videos"]) expect((await f.request(`/${route}/1`)).status).toBe(404);
      const find = await f.tool("find", { query: "private needle", mode: "keyword", include_archive: true });
      expect(find.content[0].text).not.toContain("private needle");
      expect((await f.tool("delete", { event_id: 1 })).content[0].text).toContain("not found");
    } finally { f.db.close(); }
  });
}

test("stored archive paths survive a failed deletion and archived media stays readable until deletion", async () => {
  const f = fixture();
  try {
    f.seed(1, "image", true);
    const key = "archive/imported-event.json";
    f.objects.set(key, f.objects.get("archive/1.json")!);
    f.objects.delete("archive/1.json");
    f.db.run("UPDATE events_archive SET r2_path = ? WHERE id = 1", [key]);
    f.db.run("INSERT INTO images_data (path, data, mime_type, event_id) VALUES ('image', 'aGk=', 'image/png', 1)");
    f.objects.set("videos/1.mp4", "video bytes");
    for (const route of ["images", "videos"]) expect((await f.request(`/${route}/1`)).status).toBe(200);
    f.failures.add(key);
    expect((await f.tool("delete", { event_id: 1 })).isError).toBe(true);
    expect(f.objects.has(key)).toBe(true);
    f.failures.clear();
    expect((await f.tool("delete", { event_id: 1 })).isError).toBeUndefined();
    expect(f.objects.size).toBe(0);
    expect(f.vectors.size).toBe(0);
  } finally { f.db.close(); }
});

test("unknown event is not found and orphan media is inaccessible", async () => {
  const f = fixture();
  try {
    expect((await f.tool("delete", { event_id: 999 })).content[0].text).toContain("not found");
    f.objects.set("videos/999.mp4", "video bytes");
    f.db.run("INSERT INTO images_data (path, data, mime_type, event_id) VALUES ('orphan', 'aGk=', 'image/png', 999)");
    for (const route of ["images", "videos"]) expect((await f.request(`/${route}/999`)).status).toBe(404);
    expect((await f.tool("delete", { event_id: 999 })).content[0].text).toContain("Deleted event 999");
    expect(f.objects.size).toBe(0);
    expect(f.db.query("SELECT * FROM images_data").all()).toHaveLength(0);
  } finally { f.db.close(); }
});

for (const failure of ["archive/1.json", "videos/1.mp4", "vectors", "DELETE FROM images_data WHERE event_id = ?"]) {
  test(`partial failure is explicit and retry completes: ${failure}`, async () => {
    const f = fixture();
    try {
      f.seed(1, "observation", true);
      f.objects.set("videos/1.mp4", "video bytes");
      f.db.run("INSERT INTO images_data (path, data, mime_type, event_id) VALUES ('image', 'aGk=', 'image/png', 1)");
      f.failures.add(failure);
      const first = await f.tool("delete", { event_id: 1 });
      expect(first.isError).toBe(true);
      expect(first.content[0].text).toContain("Deletion incomplete");
      expect(first.content[0].text).toContain("unavailable");
      expect(first.content[0].text).toContain("events_archive 1");
      const d1Failed = failure.startsWith("DELETE");
      expect(f.db.query("SELECT * FROM events_archive").all()).toHaveLength(d1Failed ? 1 : 0);
      if (!d1Failed) for (const route of ["images", "videos"]) expect((await f.request(`/${route}/1`)).status).toBe(404);
      expect(f.db.query("SELECT tasks FROM event_deletions").get()).not.toBeNull();
      f.failures.clear();
      const second = await f.tool("delete", { event_id: 1 });
      expect(second.isError).toBeUndefined();
      expect(second.content[0].text).toContain("Deleted event 1");
      expect(f.objects.size).toBe(0);
      expect(f.vectors.size).toBe(0);
      expect(f.db.query("SELECT * FROM images_data").all()).toHaveLength(0);
      expect(f.db.query("SELECT * FROM event_deletions").all()).toHaveLength(0);
    } finally { f.db.close(); }
  });
}

test("large graph and trace reads keep all nodes with bounded SQL bindings", async () => {
  const f = fixture();
  try {
    f.db.exec(`WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<205)
      INSERT INTO events_hot(id, kind, content) SELECT n, 'observation', 'node ' || n FROM ids`);
    f.db.exec(`INSERT INTO event_edges(from_event, to_event, relation, status, proposed_by, reason)
      SELECT 1, id, 'led_to', 'confirmed', 'test', 'test edge' FROM events_hot WHERE id > 1`);
    const prepare = f.env.DB.prepare.bind(f.env.DB);
    f.env.DB.prepare = (sql: string) => {
      const statement = prepare(sql);
      const bind = statement.bind.bind(statement);
      statement.bind = (...values: any[]) => { expect(values.length).toBeLessThanOrEqual(100); return bind(...values); };
      return statement;
    };
    const graph = await (await f.request("/graph")).json() as any;
    expect(graph.events).toHaveLength(205);
    expect(graph.edges).toHaveLength(204);
    const trace = await f.tool("trace", { event_id: 1, direction: "forward" });
    const payload = JSON.parse(trace.content[0].text.split("```json\n")[1].split("\n```")[0]);
    expect(payload.nodes).toHaveLength(205);
    expect(payload.edges).toHaveLength(204);
  } finally { f.db.close(); }
});

test("wake sorts inherited-property goal statuses after recognized statuses", async () => {
  const f = fixture();
  try {
    for (const status of ["constructor", "fulfilled", "__proto__", "open", "toString", "closer"]) {
      f.db.run("INSERT INTO events_hot(kind, content, meta) VALUES ('goal', ?, ?)", [`goal-${status}`, JSON.stringify({ status })]);
    }
    const text = (await f.tool("wake", {})).content[0].text;
    expect(text.indexOf("goal-open")).toBeLessThan(text.indexOf("goal-closer"));
    expect(text.indexOf("goal-closer")).toBeLessThan(text.indexOf("goal-fulfilled"));
    for (const status of ["constructor", "__proto__", "toString"]) {
      expect(text.indexOf("goal-fulfilled")).toBeLessThan(text.indexOf(`goal-${status}`));
    }
  } finally { f.db.close(); }
});

test("graph edges and proposals disappear; derived surfaces are named, not deleted", async () => {
  const f = fixture();
  try {
    f.seed(1);
    f.seed(2, "surface");
    f.seed(3);
    f.db.run("UPDATE events_hot SET meta = ? WHERE id = 2", [JSON.stringify({ source_event_ids: [1, 3], observations: ["private needle"] })]);
    const pattern = (f.db.query("SELECT content FROM events_hot WHERE id = 2").get() as any).content;
    f.db.run("UPDATE mood_state SET active_surfaces = ?", [JSON.stringify([{ pattern, observations: ["private needle"] }, { pattern: "unrelated" }])]);
    f.db.run("INSERT INTO event_edges (from_event, to_event, relation, proposed_by, reason) VALUES (1, 3, 'led_to', 'test', 'private needle')");
    f.db.run("INSERT INTO relations (from_entity, to_entity, relation_type, source_event_id) VALUES ('a', 'b', 'test', 1)");
    f.db.run("INSERT INTO consolidation_proposals (duplicate_ids, keep_id) VALUES ('[1]', 3)");
    f.db.exec("CREATE TABLE resolution_proposals (event_id INTEGER, note TEXT); INSERT INTO resolution_proposals VALUES (1, 'private needle')");
    const result = await f.tool("delete", { event_id: 1 });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result)).toContain("still exist: 2");
    expect(f.db.query("SELECT id FROM events_hot ORDER BY id").all()).toEqual([{ id: 2 }, { id: 3 }]);
    for (const table of ["event_edges", "relations", "consolidation_proposals", "resolution_proposals"]) expect(f.db.query(`SELECT * FROM ${table}`).all()).toHaveLength(0);
    expect([...f.vectors].some(id => id.startsWith("event-1"))).toBe(false);
    expect(JSON.parse((f.db.query("SELECT active_surfaces FROM mood_state").get() as any).active_surfaces)).toHaveLength(2);
  } finally { f.db.close(); }
});

test("todo resolve preserves exact cleanup on failure and rejects missing targets", async () => {
  const f = fixture();
  try {
    f.seed(1, "todo");
    f.db.run("INSERT INTO event_edges (from_event, to_event, relation, proposed_by, reason) VALUES (1, 2, 'led_to', 'test', 'private needle')");
    f.failures.add("vectors");
    expect((await f.tool("todo", { action: "resolve", todo_id: 1 })).isError).toBe(true);
    f.failures.clear();
    expect((await f.tool("todo", { action: "resolve", todo_id: 1 })).isError).toBeUndefined();
    expect(f.vectors.size).toBe(0);
    expect(f.db.query("SELECT * FROM event_edges").all()).toHaveLength(0);
    expect((await f.tool("todo", { action: "resolve", todo_id: 999 })).isError).toBe(true);
    expect((await f.tool("find", { query: "private needle", mode: "keyword", include_archive: true })).content[0].text).not.toContain("private needle");
  } finally { f.db.close(); }
});

for (const failure of ["vectors", "embedding"]) {
  test(`replacement retries ${failure} without losing old chunk identities`, async () => {
    const f = fixture();
    try {
      f.seed(1, "todo");
      const args = { action: "update", todo_id: 1, new_content: "replacement" };
      f.failures.add(failure);
      expect((await f.tool("todo", args)).isError).toBe(true);
      expect(f.db.query("SELECT * FROM event_deletions WHERE id = 1").get()).not.toBeNull();
      f.failures.clear();
      expect((await f.tool("todo", args)).isError).toBeUndefined();
      expect([...f.vectors]).toEqual(["event-1"]);
      expect((await f.tool("find", { query: "private needle", mode: "keyword", include_archive: true })).content[0].text).not.toContain("private needle");
      expect((await f.tool("edit", { event_id: 999, patch: { content: "missing" } })).isError).toBe(true);
      expect((await f.tool("resolve", { event_id: 999, note: "missing" })).isError).toBe(true);
      await f.tool("delete", { event_id: 1 });
      expect(f.vectors.size).toBe(0);
    } finally { f.db.close(); }
  });
}

test("canon supersession includes archive and resumes failed plans", async () => {
  const f = fixture();
  try {
    f.seed(1, "observation", true);
    f.db.run("UPDATE events_archive SET entity_name = 'subject', tags = '[\"canon:fact\"]' WHERE id = 1");
    f.db.run("INSERT INTO events_hot (id, kind, content) VALUES (2, 'journal', 'unrelated')");
    const args = { kind: "observation", entity: "subject", tags: ["canon:fact"], content: "corrected fact" };
    f.failures.add("vectors");
    expect((await f.tool("write", args)).isError).toBe(true);
    f.failures.clear();
    expect((await f.tool("write", args)).isError).toBeUndefined();
    expect([...f.vectors].some(id => id === "event-1" || id.startsWith("event-1-"))).toBe(false);
    expect(f.objects.size).toBe(0);
    expect(f.db.query("SELECT * FROM event_deletions").all()).toHaveLength(0);
    expect((await f.tool("find", { query: "private needle", mode: "keyword", include_archive: true })).content[0].text).not.toContain("private needle");
  } finally { f.db.close(); }
});

test("consolidation persists vector retry and stays suppressed after archival", async () => {
  const f = fixture();
  try {
    f.seed(1);
    f.failures.add("vectors");
    await expect(consolidateEvent(f.env, 1, 2, "duplicate")).rejects.toThrow("incomplete");
    f.failures.clear();
    await retryConsolidations(f.env);
    expect(f.vectors.size).toBe(0);
    f.db.run("UPDATE events_hot SET ts = datetime('now', '-30 days') WHERE id = 1");
    expect((await runMechanicalDecay(f.env)).ok).toBe(true);
    expect(f.db.query("SELECT * FROM events_archive WHERE id = 1").get()).not.toBeNull();
    expect((await f.tool("find", { query: "private needle", mode: "keyword", include_archive: true })).content[0].text).not.toContain("private needle");
  } finally { f.db.close(); }
});

test("decay reports failed R2 archival and retries from hot storage", async () => {
  const f = fixture();
  try {
    f.seed(1);
    f.db.run("UPDATE events_hot SET ts = datetime('now', '-30 days') WHERE id = 1");
    f.failures.add("put");
    const first = await runMechanicalDecay(f.env);
    expect(first.ok).toBe(false);
    expect(first.failed.map(row => row.id)).toEqual([1]);
    expect(first.archived).toBe(0);
    expect(f.db.query("SELECT * FROM events_hot WHERE id = 1").get()).not.toBeNull();
    f.failures.clear();
    const second = await runMechanicalDecay(f.env);
    expect(second.ok).toBe(true);
    expect(second.archived).toBe(1);
    expect(f.db.query("SELECT * FROM events_hot WHERE id = 1").get()).toBeNull();
  } finally { f.db.close(); }
});

test("failed stale-object cleanup retains an intent for the next decay", async () => {
  const f = fixture();
  try {
    f.seed(1);
    f.db.run("UPDATE events_hot SET ts = datetime('now', '-30 days') WHERE id = 1");
    const put = f.env.ARCHIVE.put;
    f.env.ARCHIVE.put = async (key: string, value: string) => {
      expect((await f.tool("delete", { event_id: 1 })).isError).toBe(true);
      await put(key, value);
      f.failures.add(key);
    };
    expect((await runMechanicalDecay(f.env)).ok).toBe(false);
    expect(f.db.query("SELECT * FROM events_archive").all()).toHaveLength(0);
    expect(f.db.query("SELECT * FROM event_deletions WHERE id < 0").all()).toHaveLength(1);
    f.failures.clear();
    expect((await runMechanicalDecay(f.env)).ok).toBe(true);
    expect((await f.tool("delete", { event_id: 1 })).isError).toBeUndefined();
    expect(f.objects.size).toBe(0);
    expect(f.db.query("SELECT * FROM event_deletions").all()).toHaveLength(0);
  } finally { f.db.close(); }
});

for (const action of ["delete", "edit"]) {
  test(`delayed archive cannot resurrect an event after ${action}`, async () => {
    const f = fixture();
    try {
      f.seed(1);
      f.db.run("UPDATE events_hot SET ts = datetime('now', '-30 days') WHERE id = 1");
      const put = f.env.ARCHIVE.put;
      f.env.ARCHIVE.put = async (key: string, value: string) => {
        const result = await f.tool(action, { event_id: 1, patch: { content: "replacement" } });
        expect(result.isError).toBe(true);
        await put(key, value);
      };
      expect((await runMechanicalDecay(f.env)).ok).toBe(true);
      expect((await f.tool(action, { event_id: 1, patch: { content: "replacement" } })).isError).toBeUndefined();
      expect(f.db.query("SELECT * FROM events_archive WHERE id = 1").get()).toBeNull();
      expect(f.objects.size).toBe(0);
      expect((await f.tool("find", { query: "private needle", mode: "keyword", include_archive: true })).content[0].text).not.toContain("private needle");
    } finally { f.db.close(); }
  });
}

test("vector search with the default limit stays within the index's topK limit", async () => {
  const f = fixture();
  f.seed(7);
  for (const limit of [undefined, 20, 100]) {
    const result = await f.tool("find", { query: "a question in other words", mode: "vector", ...(limit ? { limit } : {}) });
    expect(result.content[0].text).toContain("[7]");
  }
});
