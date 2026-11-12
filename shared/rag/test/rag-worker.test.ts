import { MEMORY_REF_PREFIX } from "../../scripts/legacy-names";
import { describe, expect, test } from "bun:test";
import { fakeEnv, sessionFile, TOKEN, type FakeEnv } from "./fake-env.ts";

// Tests archive retrieval, isolation and deletion with offline storage fakes.

let fresh = 0;
// A fresh module instance per test: the worker keeps "schema ready" in a
// module-level flag.
async function load(): Promise<{ fetch(req: Request, env: any): Promise<Response> }> {
  return (await import(`../src/index.ts?instance=${++fresh}`)).default;
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const get = (path: string) => new Request(`https://rag.test${path}`, { headers: auth });
const post = (path: string, body: unknown) =>
  new Request(`https://rag.test${path}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function upload(worker: Awaited<ReturnType<typeof load>>, env: FakeEnv, name: string, content: string) {
  const form = new FormData();
  form.append("file", new File([content], name, { type: "text/markdown" }));
  const res = await worker.fetch(new Request("https://rag.test/upload", { method: "POST", headers: auth, body: form }), env);
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}

const turn = (who: string, text: string) => `**${who}**\n\n${text}\n`;

async function archive() {
  const worker = await load();
  const env = fakeEnv();
  await upload(worker, env, "Session_10.md", sessionFile("Session_10", "2026-09-27",
    { themes: "Bicycle repair", summary: "Fixed the rear brake." },
    turn("User", "The rear brake of the bicycle squeaks.") + turn("Agent", "Clean the brake pads and adjust the cable.")));
  await upload(worker, env, "Session_11.md", sessionFile("Session_11", "2026-09-29",
    { themes: "Garden plans, Tool shed", summary: "Planned raised beds for the garden.", moments: "Chose cedar | Measured the shed" },
    turn("User", "Let us plan the garden beds near the shed.") + turn("Agent", "Raised beds of cedar, two metres long, beside the tool shed.")));
  const long = Array.from({ length: 6 }, (_, i) => turn(i % 2 ? "Agent" : "User", `Garden notes ${i}: tomatoes, beans and the compost corner. `.repeat(4))).join("\n");
  await upload(worker, env, "Session_12_part01.md", sessionFile("Session_12", "2026-09-29",
    { themes: "Seed list", summary: "Wrote the seed list." }, long));
  await upload(worker, env, "Session_12_part02.md", sessionFile("Session_12", "2026-09-29",
    { themes: "Seed list", summary: "Wrote the seed list." }, turn("User", "And the garden hose too.")));
  await upload(worker, env, "Session_13.md", sessionFile("Session_13", "2026-09-30",
    {}, turn("User", "The garden fence needs paint.") + turn("Agent", "Green paint for the garden fence.")));
  await upload(worker, env, "Session_3.md", "# [Session_3] [DATE: 2026-03]\n\nSESSION=3 | TYPE=CHAT | DATE=2026-03\n\n---\n\n**User**\n\nAn old garden memory.\n");
  return { worker, env };
}

test("episodes cross missing session numbers within the neighbour span", async () => {
  const worker = await load(), env = fakeEnv();
  for (const n of [1, 3, 5]) await upload(worker, env, `Session_${n}.md`, sessionFile(`Session_${n}`, "2026-01-01", {}, turn("User", "Garden notes.")));
  for (const [anchor, expected] of [[1, [1, 3]], [3, [1, 3, 5]], [5, [3, 5]]] as const) {
    const response = await worker.fetch(post("/expand", { anchors: [{ filename: `Session_${anchor}.md`, chunkIndex: 0 }], query: "garden", neighbors: 0, episodeSpan: 1 }), env);
    expect(response.status).toBe(200);
    expect((await response.json()).episode.sessions).toEqual(expected);
  }
});

describe("schema", () => {
  test("files_by_date is created lazily on an older database, next to files_by_session", async () => {
    const worker = await load();
    const env = fakeEnv("fts-only");
    expect(env.FTS.db.query("SELECT name FROM sqlite_master WHERE name = 'files_by_date'").all()).toHaveLength(0);
    const res = await worker.fetch(get("/files?from=2026-09-01&to=2026-09-30"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ files: [], sessions: 0, truncated: false });
    const idx = env.FTS.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('files_by_date', 'files_by_session')").all();
    expect(idx).toHaveLength(2);
  });

  test("fts-init.sql carries the same index for a fresh database", () => {
    const env = fakeEnv("full");
    expect(env.FTS.db.query("SELECT sql FROM sqlite_master WHERE name = 'files_by_date'").get()).toEqual({ sql: "CREATE INDEX files_by_date ON files(date)" });
  });
});

describe("upload", () => {
  test("oversized chunk IDs are rejected before any binding write", async () => {
    const worker = await load();
    const env = fakeEnv();
    const form = new FormData();
    form.append("file", new File(["Synthetic conversation."], "a".repeat(49) + ".md"));
    const res = await worker.fetch(new Request("https://rag.test/upload", { method: "POST", headers: auth, body: form }), env);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("64 bytes");
    expect(env.R2.objects.size).toBe(0);
    expect(env.VECTORIZE.vectors.size).toBe(0);
    expect(env.FTS.log).toEqual([]);
    expect(env.FTS.db.query("SELECT * FROM chunks").all()).toEqual([]);
    expect(env.FTS.db.query("SELECT * FROM chunk_map").all()).toEqual([]);
    expect(env.FTS.db.query("SELECT * FROM files").all()).toEqual([]);
  });

  test("a filename with a 64-byte maximum chunk ID is accepted", async () => {
    const name = "a".repeat(48) + ".md";
    expect(new TextEncoder().encode(name + "_chunk_999999").byteLength).toBe(64);
    const env = fakeEnv();
    await upload(await load(), env, name, "Synthetic conversation.");
    expect(env.VECTORIZE.vectors.has(name + "_chunk_0")).toBe(true);
  });

  test("fake Vectorize enforces bytes rather than character count atomically", async () => {
    const env = fakeEnv();
    await expect(env.VECTORIZE.upsert([
      { id: "valid", values: [], metadata: {} },
      { id: "é".repeat(33), values: [], metadata: {} },
    ])).rejects.toThrow("64 bytes");
    expect(env.VECTORIZE.vectors.size).toBe(0);
    await env.VECTORIZE.upsert([{ id: "é".repeat(32), values: [], metadata: {} }]);
    expect(env.VECTORIZE.vectors.size).toBe(1);
  });
  for (const retryUpload of [true, false]) {
    test(`surplus vector failure preserves R2 targets for ${retryUpload ? "reupload" : "direct delete"}`, async () => {
      const worker = await load();
      const env = fakeEnv();
      const filename = "shortened.md";
      expect((await upload(worker, env, filename, "a".repeat(4400))).chunks).toBe(5);
      const remove = env.VECTORIZE.deleteByIds.bind(env.VECTORIZE);
      let fail = true;
      env.VECTORIZE.deleteByIds = async ids => {
        if (fail) { fail = false; throw new Error("Temporary vector outage"); }
        return remove(ids);
      };
      const form = new FormData();
      form.append("file", new File(["Short replacement content."], filename));
      const failed = await worker.fetch(new Request("https://rag.test/upload", { method: "POST", headers: auth, body: form }), env);
      expect(failed.status).toBe(500);
      expect(await failed.json()).not.toMatchObject({ success: true });
      for (let i = 1; i < 5; i++) expect(env.R2.objects.has(`chunks/${filename}_chunk_${i}`)).toBe(true);
      if (retryUpload) await upload(await load(), env, filename, "Short replacement content.");
      const deleted = await (await load()).fetch(post("/delete", { filename }), env);
      expect(deleted.status).toBe(200);
      expect(env.VECTORIZE.vectors.size).toBe(0);
      expect(env.R2.objects.size).toBe(0);
    });
  }
  test("vectors carry date and session; files without them stay as before", async () => {
    const { env } = await archive();
    expect(env.VECTORIZE.vectors.get("Session_11.md_chunk_0")!.metadata).toEqual({
      filename: "Session_11.md", chunkIndex: 0, totalChunks: 1, date: "2026-09-29", session: 11,
    });
    expect(env.VECTORIZE.vectors.get("Session_3.md_chunk_0")!.metadata).toMatchObject({ date: "2026-03", session: 3 });
    const worker = await load();
    await upload(worker, env, "notes.md", "No header here, just a note about the garden gate.");
    expect(env.VECTORIZE.vectors.get("notes.md_chunk_0")!.metadata).toEqual({ filename: "notes.md", chunkIndex: 0, totalChunks: 1 });
  });
});

describe("GET /head", () => {
  test("defaults missing bytes to 800 and rejects invalid explicit lengths", async () => {
    const worker = await load();
    const env = fakeEnv();
    for (const content of ["A short complete header.", "abcdefghij".repeat(500)]) {
      await upload(worker, env, "header.md", content);
      for (const [suffix, length] of [["", 800], ["&bytes=10", 10], ["&bytes=4000", 4000]] as const) {
        const res = await worker.fetch(get(`/head?filename=header.md${suffix}`), env);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ filename: "header.md", head: content.slice(0, length) });
      }
      for (const value of ["", "0", "9000", "1e400", "1.5"]) {
        expect((await worker.fetch(get(`/head?filename=header.md&bytes=${value}`), env)).status).toBe(400);
      }
    }
  });
});

describe("GET /files", () => {
  test("rows in the range, ordered by date, session, part; month-only dates never match", async () => {
    const { worker, env } = await archive();
    const res = await worker.fetch(get("/files?from=2026-09-01&to=2026-09-30"), env);
    const data = await res.json() as any;
    expect(data.files.map((f: any) => f.filename)).toEqual([
      "Session_10.md", "Session_11.md", "Session_12_part01.md", "Session_12_part02.md", "Session_13.md",
    ]);
    expect(data).toMatchObject({ from: "2026-09-01", to: "2026-09-30", order: "asc", sessions: 4, truncated: false });
    expect(data.files[1]).toMatchObject({
      prefix: "Session", session: 11, part: 1, date: "2026-09-29",
      themes: "Garden plans, Tool shed", summary: "Planned raised beds for the garden.", key_moments: "Chose cedar | Measured the shed",
    });
    expect(data.files[3]).toMatchObject({ part: 2, themes: "Seed list" });
    expect(data.files[4]).toMatchObject({ themes: null, summary: null, key_moments: null });
  });

  test("desc order, facts only for the first N sessions (one head read each)", async () => {
    const { worker, env } = await archive();
    env.R2.reads = [];
    const data = await (await worker.fetch(get("/files?from=2026-09-27&to=2026-09-30&order=desc&facts=2"), env)).json() as any;
    expect(data.files.map((f: any) => f.filename)).toEqual([
      "Session_13.md", "Session_12_part01.md", "Session_12_part02.md", "Session_11.md", "Session_10.md",
    ]);
    expect(env.R2.reads.sort()).toEqual(["originals/Session_12_part01.md", "originals/Session_13.md"]);
    expect(data.files.find((f: any) => f.filename === "Session_11.md").themes).toBeNull();
    const none = await (await worker.fetch(get("/files?from=2026-09-27&to=2026-09-30&facts=0"), env)).json() as any;
    expect(none.files.every((f: any) => f.themes === null)).toBe(true);
  });

  test("limit and truncated", async () => {
    const { worker, env } = await archive();
    const data = await (await worker.fetch(get("/files?from=2026-09-01&to=2026-09-30&limit=2"), env)).json() as any;
    expect(data.files).toHaveLength(2);
    expect(data.truncated).toBe(true);
  });

  test("bad ranges are refused; the route needs the token", async () => {
    const { worker, env } = await archive();
    for (const qs of ["", "?from=2026-09-01", "?from=2026-09-31&to=2026-10-01", "?from=2026-10-02&to=2026-10-01", "?from=2025-01-01&to=2026-10-01", "?from=1.9.&to=2.9."]) {
      expect((await worker.fetch(get(`/files${qs}`), env)).status).toBe(400);
    }
    expect((await worker.fetch(new Request("https://rag.test/files?from=2026-09-01&to=2026-09-30"), env)).status).toBe(401);
  });
});

describe("POST /search with dateFrom/dateTo", () => {
  test("only chunks of files dated in the range; the range is echoed", async () => {
    const { worker, env } = await archive();
    const data = await (await worker.fetch(post("/search", { query: "garden", topK: 10, dateFrom: "2026-09-29", dateTo: "2026-09-29" }), env)).json() as any;
    expect(data.date_filter).toEqual({ from: "2026-09-29", to: "2026-09-29" });
    expect(data.results.length).toBeGreaterThan(0);
    for (const r of data.results) {
      expect(r.date).toBe("2026-09-29");
      expect(["Session_11.md", "Session_12_part01.md", "Session_12_part02.md"]).toContain(r.filename);
    }
    expect(env.FTS.log.some((sql) => sql.includes("filename IN (SELECT filename FROM files WHERE length(date) = 10"))).toBe(true);
    expect(env.VECTORIZE.filtersSeen).toEqual([]);
  });

  test("an empty range answers empty, without a search", async () => {
    const { worker, env } = await archive();
    const before = env.FTS.log.length;
    const data = await (await worker.fetch(post("/search", { query: "garden", dateFrom: "2026-09-01", dateTo: "2026-09-02" }), env)).json() as any;
    expect(data).toMatchObject({ results: [], date_filter: { from: "2026-09-01", to: "2026-09-02" }, reranked: false });
    expect(env.FTS.log.slice(before).some((sql) => sql.includes("MATCH"))).toBe(false);
  });

  test("invalid or half ranges are refused", async () => {
    const { worker, env } = await archive();
    for (const body of [
      { query: "garden", dateFrom: "2026-09-29" },
      { query: "garden", dateTo: "2026-09-29" },
      { query: "garden", dateFrom: "29.09.2026", dateTo: "2026-09-29" },
      { query: "garden", dateFrom: "2026-09-30", dateTo: "2026-09-29" },
      { query: "garden", dateFrom: 20260929, dateTo: "2026-09-29" },
    ]) {
      expect((await worker.fetch(post("/search", body), env)).status).toBe(400);
    }
  });

  test("without the new fields the answer is what it was (plus date_filter: null)", async () => {
    const { worker, env } = await archive();
    const data = await (await worker.fetch(post("/search", { query: "garden shed beds", topK: 5 }), env)).json() as any;
    expect(data.date_filter).toBeNull();
    const files = new Set(data.results.map((r: any) => r.filename));
    expect(files.has("Session_11.md")).toBe(true);
    expect(data.results.some((r: any) => r.date !== "2026-09-29")).toBe(true);
    expect(Object.keys(data).sort()).toEqual(
      ["counts", "date_filter", "filtered", "ghosts_repaired", "mode", "query", "reranked", "results", "session_filter"]);
  });

  test("the endpoint list names /files", async () => {
    const { worker, env } = await archive();
    expect(await (await worker.fetch(get("/"), env)).text()).toContain("GET /files");
  });
});

describe("deletion regressions", () => {
  async function sendUpload(worker: Awaited<ReturnType<typeof load>>, env: FakeEnv, filename: string, content: string) {
    const form = new FormData();
    form.append("file", new File([content], filename));
    return worker.fetch(new Request("https://rag.test/upload", { method: "POST", headers: auth, body: form }), env);
  }

  test("an open deletion rejects the longer upload before it can stale the plan", async () => {
    const worker = await load(), env = fakeEnv(), filename = "Audit_001.md";
    await upload(worker, env, filename, "Short original.");
    const remove = env.VECTORIZE.deleteByIds.bind(env.VECTORIZE);
    env.VECTORIZE.deleteByIds = async () => { throw new Error("outage"); };
    expect((await worker.fetch(post("/delete", { filename }), env)).status).toBe(500);
    expect((await sendUpload(await load(), env, filename, "Long replacement. ".repeat(400))).status).toBe(409);
    env.VECTORIZE.deleteByIds = remove;
    expect((await (await load()).fetch(post("/delete", { filename }), env)).status).toBe(200);
    expect(env.R2.objects.size).toBe(0);
    expect(env.VECTORIZE.vectors.size).toBe(0);
    expect(env.FTS.db.query("SELECT * FROM chunk_map").all()).toEqual([]);
  });

  for (const shorterRetry of [false, true]) test(`failed chunk write retains all vector identities, shorter retry=${shorterRetry}`, async () => {
    const worker = await load(), env = fakeEnv(), filename = "interrupted.md";
    const put = env.R2.put.bind(env.R2);
    env.R2.put = async (key, value) => {
      if (key.startsWith("chunks/")) throw new Error("chunk storage outage");
      return put(key, value);
    };
    expect((await sendUpload(worker, env, filename, "private words ".repeat(400))).status).toBe(500);
    expect(env.VECTORIZE.vectors.size).toBeGreaterThan(1);
    expect([...env.R2.objects.keys()]).toEqual([`originals/${filename}`]);
    env.R2.put = put;
    if (shorterRetry) {
      await upload(await load(), env, filename, "Short replacement.");
      expect(env.VECTORIZE.vectors.size).toBe(1);
    }
    expect((await (await load()).fetch(post("/delete", { filename }), env)).status).toBe(200);
    expect(env.VECTORIZE.vectors.size).toBe(0);
    expect(env.R2.objects.size).toBe(0);
  });

  for (const replacement of ["different ".repeat(450), "Short replacement."]) test(`replacement removes incoming and outgoing semantic references (${replacement.length})`, async () => {
    const worker = await load(), env = fakeEnv(), filename = "replace.md";
    await upload(worker, env, filename, "original ".repeat(500));
    await upload(worker, env, "other.md", "Other file.");
    for (const edge of [
      { src: "replace.md_chunk_0", dst: "memory:42", type: "CORRECTED_BY" },
      { src: "other.md_chunk_0", dst: "replace.md_chunk_4", type: "SUPPORTS" },
    ]) expect((await worker.fetch(post("/edge", { ...edge, confirmed: 1, note: "private old snapshot" }), env)).status).toBe(200);
    await upload(worker, env, filename, replacement);
    expect(env.FTS.db.query("SELECT * FROM chunk_edges WHERE type != 'NEXT'").all()).toEqual([]);
  });

  test("graph invalidation failure stops the upload before content replacement", async () => {
    const worker = await load(), env = fakeEnv();
    await upload(worker, env, "graph.md", "Old content.");
    env.FTS.db.exec("CREATE TRIGGER refuse_edges BEFORE DELETE ON chunk_edges BEGIN SELECT RAISE(ABORT, 'outage'); END");
    await worker.fetch(post("/edge", { src: "graph.md_chunk_0", dst: "memory:42", type: "ABOUT", note: "old" }), env);
    expect((await sendUpload(worker, env, "graph.md", "Replacement.")).status).toBe(500);
    expect(env.R2.objects.get("originals/graph.md")).toBe("Old content.");
  });

  test("memory-edge cleanup removes the event's snapshots from every chunk, preserves unrelated edges and retries", async () => {
    const worker = await load(), env = fakeEnv();
    await upload(worker, env, "edges.md", "Some content.");
    await upload(worker, env, "other.md", "Other content.");
    for (const [src, dst] of [["edges.md_chunk_0", `${MEMORY_REF_PREFIX}42`], ["other.md_chunk_0", `${MEMORY_REF_PREFIX}42`], ["edges.md_chunk_0", "memory:43"]]) {
      expect((await worker.fetch(post("/edge", { src, dst, type: "CORRECTED_BY", note: "snapshot" }), env)).status).toBe(200);
    }
    env.FTS.db.exec("CREATE TRIGGER refuse_edges BEFORE DELETE ON chunk_edges BEGIN SELECT RAISE(ABORT, 'outage'); END");
    expect((await worker.fetch(post("/delete-memory-edges", { event_id: 42 }), env)).status).toBe(500);
    expect(env.FTS.db.query("SELECT * FROM chunk_edges").all()).toHaveLength(3);
    env.FTS.db.exec("DROP TRIGGER refuse_edges");
    const res = await (await load()).fetch(post("/delete-memory-edges", { event_id: 42 }), env);
    expect(await res.json()).toMatchObject({ success: true, removed: 2 });
    expect(env.FTS.db.query("SELECT dst FROM chunk_edges").all()).toEqual([{ dst: "memory:43" }]);
    const retry = await worker.fetch(post("/delete-memory-edges", { event_id: "42" }), env);
    expect(retry.status).toBe(404);
    expect(await retry.json()).toMatchObject({ success: false, absent: true });
    expect((await worker.fetch(new Request("https://rag.test/delete-memory-edges", { method: "POST", body: '{"event_id":43}' }), env)).status).toBe(401);
  });

  test("deleting a missing file says it was absent, not that something was removed", async () => {
    const env = fakeEnv();
    const res = await (await load()).fetch(post("/delete", { filename: "missing.md" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, absent: true, deleted: false });
  });
});

describe("durable deletion", () => {
  test("a vector failure keeps a content-free plan for a fresh worker retry", async () => {
    const worker = await load();
    const env = fakeEnv();
    const filename = "delete.md";
    await upload(worker, env, filename, "Private content that must not enter the deletion plan.");
    const ids = [...env.VECTORIZE.vectors.keys()];
    const remove = env.VECTORIZE.deleteByIds.bind(env.VECTORIZE);
    let first = true;
    env.VECTORIZE.deleteByIds = async ids => {
      if (first) { first = false; throw new Error("temporary vector outage"); }
      return remove(ids);
    };
    const res = await worker.fetch(post("/delete", { filename }), env);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, partial: true });
    expect(env.R2.objects.size).toBe(0);
    expect([...env.VECTORIZE.vectors.keys()]).toEqual(ids);
    const pending: any = env.FTS.db.query("SELECT plan FROM rag_deletions WHERE filename = ?").get(filename);
    expect(JSON.parse(pending.plan).vectorIds).toEqual(ids);
    expect(pending.plan).not.toContain("Private content");
    const retry = await (await load()).fetch(post("/delete", { filename }), env);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ success: true, deleted: filename });
    expect(env.VECTORIZE.vectors.size).toBe(0);
    expect(env.R2.objects.size).toBe(0);
    for (const table of ["rag_deletions", "chunks", "chunk_map", "files", "chunk_edges"]) {
      expect(env.FTS.db.query(`SELECT * FROM ${table}`).all()).toHaveLength(0);
    }
  });
});

describe("Builder archive isolation", () => {
  for (const mode of ["hybrid", "vector", "bm25"]) {
    test(`${mode}: default excludes Builder_; explicit prefix includes only Builder_`, async () => {
      const worker = await load(), env = fakeEnv();
      for (const name of ["Builder_order.md", "Builder_other.md", "Session_1.md", "notes.md", "Builderish.md"]) {
        await upload(worker, env, name, sessionFile(name, "2026-09-29", {}, "Shared needle code memory."));
      }
      const search = async (extra = {}) => {
        const response = await worker.fetch(post("/search", { query: "needle", mode, topK: 20, ...extra }), env);
        expect(response.status).toBe(200);
        return response.json() as Promise<any>;
      };
      env.R2.reads = [];
      const ordinary = await search();
      expect(new Set(ordinary.results.map((hit: any) => hit.filename)))
        .toEqual(new Set(["Session_1.md", "notes.md", "Builderish.md"]));
      expect(env.R2.reads.some(key => key.includes("Builder_"))).toBe(false);
      const explicit = await search({ filenamePrefix: "Builder_" });
      expect(new Set(explicit.results.map((hit: any) => hit.filename)))
        .toEqual(new Set(["Builder_order.md", "Builder_other.md"]));
      expect((await search({ filenamePrefix: "Builder_order" })).results.map((hit: any) => hit.filename))
        .toEqual(["Builder_order.md"]);
      expect((await search({ filenamePrefix: "Builder" })).results.map((hit: any) => hit.filename))
        .toEqual(["Builderish.md"]);
      expect((await search({ filenamePrefix: "Builder_missing" })).results).toEqual([]);
      const dated = await search({ filenamePrefix: "Builder_", dateFrom: "2026-09-29", dateTo: "2026-09-29" });
      expect(dated.results.length).toBeGreaterThan(0);
      expect(dated.results.every((hit: any) => hit.filename.startsWith("Builder_"))).toBe(true);
    });
  }
  test("prefix validation is literal and old limit/mode/session callers keep their contract", async () => {
    const worker = await load(), env = fakeEnv();
    await upload(worker, env, "Session_1.md", "A needle memory.");
    await upload(worker, env, "Builder_order.md", "A needle memory.");
    for (const filenamePrefix of [null, 4, "", "Builder_%", "../", "x".repeat(129)]) {
      expect((await worker.fetch(post("/search", { query: "needle", filenamePrefix }), env)).status).toBe(400);
    }
    for (const body of [
      { query: "needle", limit: 1 }, { query: "needle", topK: 1, mode: "unknown" },
      { query: "Session_1 needle", mode: "vector" },
    ]) {
      const result = await (await worker.fetch(post("/search", body), env)).json() as any;
      expect(result.results.map((hit: any) => hit.filename)).toEqual(["Session_1.md"]);
      expect(Object.keys(result).sort()).toEqual(
        ["counts", "date_filter", "filtered", "ghosts_repaired", "mode", "query", "reranked", "results", "session_filter"]);
    }
  });
  test("temporal discovery and expansion use the same default namespace boundary", async () => {
    const worker = await load(), env = fakeEnv();
    for (const name of ["Builder_order.md", "Session_1.md"]) {
      await upload(worker, env, name, sessionFile(name, "2026-09-29", {}, "needle ".repeat(400)));
    }
    const files = async (suffix = "") => (await worker.fetch(
      get(`/files?from=2026-09-29&to=2026-09-29${suffix}`), env)).json() as Promise<any>;
    expect((await files()).files.map((f: any) => f.filename)).toEqual(["Session_1.md"]);
    expect((await files("&filenamePrefix=Builder_")).files.map((f: any) => f.filename))
      .toEqual(["Builder_order.md"]);
    const expand = (extra = {}) => worker.fetch(post("/expand", {
      anchors: [{ filename: "Builder_order.md", chunkIndex: 0 }], query: "needle", ...extra,
    }), env);
    expect((await expand()).status).toBe(400);
    const explicit = await (await expand({ filenamePrefix: "Builder_" })).json() as any;
    expect(explicit.results.length).toBeGreaterThan(0);
    expect(explicit.results.every((r: any) => r.filename.startsWith("Builder_"))).toBe(true);
    await worker.fetch(post("/edge", {
      src: "Session_1.md_chunk_0", dst: "Builder_order.md_chunk_0", type: "CORRECTED_BY", confirmed: 1,
    }), env);
    const ordinary = await (await expand({ anchors: [{ filename: "Session_1.md", chunkIndex: 0 }] })).json() as any;
    expect(ordinary.vetoes).toEqual([]);
  });
  test("BM25 excludes builder logs before LIMIT so they cannot crowd out agent history", async () => {
    const worker = await load(), env = fakeEnv();
    for (let i = 0; i < 55; i++) await upload(worker, env, `Builder_${i}.md`, "needle ".repeat(10));
    await upload(worker, env, "Session_1.md", "needle");
    const result = await (await worker.fetch(post("/search", { query: "needle", mode: "bm25", topK: 1 }), env)).json() as any;
    expect(result.results.map((hit: any) => hit.filename)).toEqual(["Session_1.md"]);
  });
});

describe("the token", () => {
  test("only the exact bearer token passes: no prefix, no extension, no other scheme", async () => {
    const { worker, env } = await archive();
    expect((await worker.fetch(get("/files?from=2026-09-01&to=2026-09-30"), env)).status).toBe(200);
    for (const header of [`Bearer ${TOKEN.slice(0, -1)}`, `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, TOKEN, "Bearer ", ""]) {
      const req = new Request("https://rag.test/files?from=2026-09-01&to=2026-09-30", { headers: { Authorization: header } });
      expect([header, (await worker.fetch(req, env)).status]).toEqual([header, 401]);
    }
  });

  test("is compared in constant time, never with === or !==", async () => {
    const src = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
    expect(src).toContain("safeEqual(authHeader, `Bearer ${env.RAG_AUTH_TOKEN}`)");
    expect(src).not.toMatch(/[!=]==\s*`Bearer \$\{env\.RAG_AUTH_TOKEN\}`/);
  });
});
