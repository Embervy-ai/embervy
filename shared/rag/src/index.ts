/**
 * Stores transcripts and searches them with lexical and vector retrieval.
 * Graph links supply neighbouring passages and confirmed corrections.
 */

import { LEGACY_MEMORY_REF_PREFIX, MEMORY_REF_PREFIX, MEMORY_REF_RE } from "../../scripts/legacy-names";
import { boundedBody, invalidIntegerQuery } from "../../memory/src/request-input";

interface Env {
  R2: R2Bucket;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  FTS: D1Database;
  RAG_AUTH_TOKEN?: string;
  SESSION_PREFIX?: string;
  EMBED_MODEL?: string;
  RERANK_MODEL?: string;
}

const DEFAULT_EMBED_MODEL = "@cf/baai/bge-m3";
const DEFAULT_RERANK_MODEL = "@cf/baai/bge-reranker-base";
const embedModel = (env: Env) => (env.EMBED_MODEL || DEFAULT_EMBED_MODEL) as any;
const rerankModel = (env: Env) => (env.RERANK_MODEL || DEFAULT_RERANK_MODEL) as any;

interface ChunkMetadata {
  filename: string;
  chunkIndex: number;
  totalChunks: number;
  date?: string;
  session?: number;
}


interface FileRow {
  filename: string;
  prefix: string;
  session: number;
  part: number;
  date: string | null;
  total_chunks: number;
}

let graphSchemaReady = false;
async function ensureGraphSchema(env: Env): Promise<void> {
  if (graphSchemaReady) return;
  await env.FTS.batch([
    env.FTS.prepare(
      `CREATE TABLE IF NOT EXISTS files (
        filename TEXT PRIMARY KEY,
        prefix TEXT NOT NULL,
        session INTEGER NOT NULL,
        part INTEGER NOT NULL DEFAULT 1,
        date TEXT,
        total_chunks INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ),
    env.FTS.prepare(`CREATE INDEX IF NOT EXISTS files_by_session ON files(prefix, session, part)`),
    env.FTS.prepare(`CREATE INDEX IF NOT EXISTS files_by_date ON files(date)`),
    env.FTS.prepare(
      `CREATE TABLE IF NOT EXISTS chunk_edges (
        src TEXT NOT NULL,
        dst TEXT NOT NULL,
        type TEXT NOT NULL,
        src_file TEXT NOT NULL,
        dst_file TEXT NOT NULL,
        origin TEXT NOT NULL DEFAULT 'ingest',
        confirmed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        note TEXT,
        PRIMARY KEY (src, dst, type)
      )`,
    ),
    env.FTS.prepare(`CREATE INDEX IF NOT EXISTS edges_by_dst ON chunk_edges(dst, type)`),
    env.FTS.prepare(`CREATE INDEX IF NOT EXISTS edges_by_src_file ON chunk_edges(src_file)`),
    env.FTS.prepare(`CREATE INDEX IF NOT EXISTS edges_by_dst_file ON chunk_edges(dst_file)`),
    env.FTS.prepare(`CREATE INDEX IF NOT EXISTS edges_by_confirmed ON chunk_edges(confirmed, type)`),
  ]);
  try {
    const cols = await env.FTS.prepare(`PRAGMA table_info(chunk_edges)`).all<{ name: string }>();
    if (!(cols.results ?? []).some((c) => c.name === "note")) {
      await env.FTS.prepare(`ALTER TABLE chunk_edges ADD COLUMN note TEXT`).run();
    }
  } catch (e) {
    console.error("rag: note column check failed:", e);
  }
  graphSchemaReady = true;
}

const EDGE_TYPES = new Set(["NEXT", "SAME_EPISODE", "CORRECTED_BY", "SUPERSEDED_BY", "SUPPORTS", "ABOUT"]);
const CHUNK_ID_RE = /^[A-Za-z0-9._-]+\.md_chunk_\d{1,6}$/;
const MAX_VECTOR_ID_BYTES = 64;
const MAX_CHUNK_SUFFIX = "_chunk_999999";
function isChunkRef(s: unknown): s is string { return typeof s === "string" && CHUNK_ID_RE.test(s); }
function isEdgeTarget(s: unknown): s is string { return isChunkRef(s) || (typeof s === "string" && MEMORY_REF_RE.test(s)); }

function parseFilename(filename: string): { prefix: string; session: number; part: number } | null {
  const m = filename.match(/^(.+?)_(\d{1,4})(?:_part(\d{1,3}))?\.md$/);
  if (!m) return null;
  return { prefix: m[1], session: parseInt(m[2], 10), part: m[3] ? parseInt(m[3], 10) : 1 };
}

function parseHeaderDate(head: string): string | null {
  const full = head.match(/DATE[:=]\s*(\d{4}-\d{2}-\d{2})/);
  if (full) return full[1];
  const month = head.match(/DATE[:=]\s*(\d{4}-\d{2})\b/);
  return month ? month[1] : null;
}
const isFullDate = (d: string | null | undefined): d is string => typeof d === "string" && d.length === 10;

function isIsoDay(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === v;
}

function headerFacts(head: string): { themes: string | null; summary: string | null; key_moments: string | null } {
  const pick = (key: string): string | null => {
    const m = head.match(new RegExp(`^${key}[=:][ \\t]*(.*)$`, "m"));
    const v = (m?.[1] ?? "").trim();
    return v && !/^(—|–|-|placeholder\.?)$/i.test(v) ? v.slice(0, 400) : null;
  };
  return { themes: pick("THEMES"), summary: pick("SUMMARY"), key_moments: pick("KEY_MOMENTS") };
}

function chunkId(filename: string, index: number): string {
  return `${filename}_chunk_${index}`;
}

function dayDiff(a: string, b: string): number {
  return Math.abs((Date.parse(a) - Date.parse(b)) / 86_400_000);
}

// Check both neighbouring parts so links do not depend on upload order.
async function writeFileGraph(env: Env, filename: string, head: string, totalChunks: number): Promise<number> {
  await ensureGraphSchema(env);
  const parsed = parseFilename(filename);
  const prefix = parsed?.prefix ?? filename.replace(/\.md$/, "");
  const session = parsed?.session ?? 0;
  const part = parsed?.part ?? 1;
  const date = parseHeaderDate(head);
  const now = new Date().toISOString();

  const stmts: D1PreparedStatement[] = [
    env.FTS.prepare(
      `INSERT INTO files (filename, prefix, session, part, date, total_chunks, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(filename) DO UPDATE SET prefix=excluded.prefix, session=excluded.session,
         part=excluded.part, date=excluded.date, total_chunks=excluded.total_chunks, updated_at=excluded.updated_at`,
    ).bind(filename, prefix, session, part, date, totalChunks, now),
    env.FTS.prepare(
      `DELETE FROM chunk_edges WHERE type='NEXT' AND origin='ingest' AND (src_file = ? OR dst_file = ?)`,
    ).bind(filename, filename),
  ];

  const edge = (src: string, srcFile: string, dst: string, dstFile: string) =>
    env.FTS.prepare(
      `INSERT OR IGNORE INTO chunk_edges (src, dst, type, src_file, dst_file, origin, confirmed, created_at)
       VALUES (?, ?, 'NEXT', ?, ?, 'ingest', 1, ?)`,
    ).bind(src, dst, srcFile, dstFile, now);

  let edges = 0;
  for (let i = 0; i + 1 < totalChunks; i++) {
    stmts.push(edge(chunkId(filename, i), filename, chunkId(filename, i + 1), filename));
    edges++;
  }

  if (parsed && totalChunks > 0) {
    const neighbours = await env.FTS.prepare(
      `SELECT filename, part, total_chunks FROM files WHERE prefix = ? AND session = ? AND part IN (?, ?)`,
    ).bind(parsed.prefix, parsed.session, parsed.part - 1, parsed.part + 1)
      .all<{ filename: string; part: number; total_chunks: number }>();
    for (const n of neighbours.results ?? []) {
      if (n.total_chunks <= 0) continue;
      if (n.part === parsed.part - 1) {
        stmts.push(edge(chunkId(n.filename, n.total_chunks - 1), n.filename, chunkId(filename, 0), filename));
        edges++;
      } else if (n.part === parsed.part + 1) {
        stmts.push(edge(chunkId(filename, totalChunks - 1), filename, chunkId(n.filename, 0), n.filename));
        edges++;
      }
    }
  }

  const BATCH = 50;
  for (let i = 0; i < stmts.length; i += BATCH) {
    await env.FTS.batch(stmts.slice(i, i + BATCH));
  }
  return edges;
}

// A narrow span avoids merging many unrelated sessions on days with frequent context cuts.
async function episodeFiles(env: Env, prefix: string, session: number, span = 1): Promise<{ sessions: number[]; files: string[] }> {
  await ensureGraphSchema(env);
  const rows = await env.FTS.prepare(
    `SELECT filename, prefix, session, part, date, total_chunks FROM files
     WHERE prefix = ? AND session IN (
       SELECT session FROM (SELECT DISTINCT session FROM files WHERE prefix = ? AND session < ? ORDER BY session DESC LIMIT ?)
       UNION SELECT session FROM (SELECT DISTINCT session FROM files WHERE prefix = ? AND session > ? ORDER BY session LIMIT ?)
       UNION SELECT ?
     ) ORDER BY session, part`,
  ).bind(prefix, prefix, session, span, prefix, session, span, session).all<FileRow>();
  const bySession = new Map<number, FileRow[]>();
  for (const r of rows.results ?? []) {
    const list = bySession.get(r.session) ?? [];
    list.push(r);
    bySession.set(r.session, list);
  }
  const dateOf = (s: number): string | null => bySession.get(s)?.find((r) => r.date)?.date ?? null;
  const sessions = new Set<number>([session]);
  for (const dir of [-1, 1]) {
    let cur = session;
    for (let step = 0; step < span; step++) {
      const neighbours = [...bySession.keys()].filter((s) => dir < 0 ? s < cur : s > cur).sort((a, b) => dir < 0 ? b - a : a - b);
      const next = neighbours[0];
      const a = dateOf(cur), b = dateOf(next);
      if (!bySession.has(next) || !isFullDate(a) || !isFullDate(b) || dayDiff(a, b) > 1) break;
      sessions.add(next);
      cur = next;
    }
  }
  const files: string[] = [];
  for (const s of [...sessions].sort((x, y) => x - y)) {
    for (const r of bySession.get(s) ?? []) files.push(r.filename);
  }
  return { sessions: [...sessions].sort((x, y) => x - y), files };
}

// Avoid early exits that reveal how much of a guessed token matches.
function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // A missing secret must not expose the archive, including through service bindings.
    if (!env.RAG_AUTH_TOKEN) {
      return new Response(
        JSON.stringify({ error: "RAG_AUTH_TOKEN not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
    const authHeader = request.headers.get("Authorization") || "";
    if (!safeEqual(authHeader, `Bearer ${env.RAG_AUTH_TOKEN}`)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (request.method === "GET") {
      const fields: ReadonlyArray<readonly [string, number, number]> =
        url.pathname === "/edges" ? [["limit", 1, 200], ["offset", 0, Number.MAX_SAFE_INTEGER], ["pending", 0, 1]] :
        url.pathname === "/files" ? [["facts", 0, 12], ["limit", 1, 500]] :
        url.pathname === "/head" ? [["bytes", 1, 4000]] :
        url.pathname === "/chunk" ? [["index", 0, 999999]] : [];
      const invalid = invalidIntegerQuery(url, fields);
      const invalidConfirmed = url.pathname === "/edges" && url.searchParams.getAll("confirmed").some(v => !["-1", "0", "1"].includes(v));
      if (invalid || invalidConfirmed) {
        return Response.json({ error: `Invalid ${invalid || "confirmed"}` }, { status: 400, headers: corsHeaders });
      }
    }

    try {
      if (url.pathname === "/upload" && request.method === "POST") {
        return await handleUpload(request, env, corsHeaders);
      }

      if (url.pathname === "/search" && request.method === "POST") {
        return await handleSearch(request, env, corsHeaders);
      }

      if (url.pathname === "/list" && request.method === "GET") {
        return await handleList(env, corsHeaders);
      }

      if (url.pathname === "/files" && request.method === "GET") {
        return await handleFiles(url, env, corsHeaders);
      }

      if (url.pathname === "/head" && request.method === "GET") {
        const filename = (url.searchParams.get("filename") || "").trim();
        if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) {
          return new Response(JSON.stringify({ error: "Invalid filename" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bytes = Number(url.searchParams.get("bytes") ?? 800);
        const candidates = [filename, filename.replace(/\.md$/, "_part01.md")];
        for (const cand of candidates) {
          const obj = await env.R2.get(`originals/${cand}`, { range: { offset: 0, length: bytes } });
          if (obj) {
            return new Response(JSON.stringify({ filename: cand, head: await obj.text() }), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
        return new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/original" && request.method === "GET") {
        const filename = (url.searchParams.get("filename") || "").trim();
        if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) {
          return new Response(JSON.stringify({ error: "Invalid filename" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const obj = await env.R2.get(`originals/${filename}`);
        if (!obj) {
          return new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        return new Response(obj.body, {
          headers: { ...corsHeaders, "Content-Type": "text/markdown; charset=utf-8" },
        });
      }

      if (url.pathname === "/delete-memory-edges" && request.method === "POST") {
        const { event_id } = await request.json() as { event_id?: unknown };
        if (!((typeof event_id === "string" || typeof event_id === "number") && /^\d{1,9}$/.test(String(event_id)))) {
          return new Response(JSON.stringify({ error: "Invalid event_id" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        await ensureGraphSchema(env);
        // One atomic statement removes references and snapshots while the caller retains its deletion plan.
        const rows = await env.FTS.prepare("DELETE FROM chunk_edges WHERE dst IN (?, ?) RETURNING src").bind(`${MEMORY_REF_PREFIX}${event_id}`, `${LEGACY_MEMORY_REF_PREFIX}${event_id}`).all();
        return new Response(JSON.stringify({ success: rows.results.length > 0, absent: rows.results.length === 0, removed: rows.results.length }), {
          status: rows.results.length ? 200 : 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/delete" && request.method === "POST") {
        return await handleDelete(request, env, corsHeaders);
      }

      if (url.pathname === "/expand" && request.method === "POST") {
        return await handleExpand(request, env, corsHeaders);
      }
      if (url.pathname === "/chunk" && request.method === "GET") {
        return await handleChunk(url, env, corsHeaders);
      }
      if (url.pathname === "/graph-backfill" && request.method === "POST") {
        return await handleGraphBackfill(request, env, corsHeaders);
      }
      if (url.pathname === "/edge" && request.method === "POST") {
        return await handleEdgeWrite(request, env, corsHeaders);
      }
      if (url.pathname === "/edges" && request.method === "GET") {
        return await handleEdgesRead(url, env, corsHeaders);
      }

      if (url.pathname === "/fts-backfill" && request.method === "POST") {
        return await handleFtsBackfill(request, env, corsHeaders);
      }

      return new Response(
        "RAG API\n\nEndpoints:\nPOST /upload\nPOST /search\nPOST /delete\nPOST /delete-memory-edges\nGET /list\nGET /files\nGET /head\nGET /original\nPOST /fts-backfill\nPOST /expand\nGET /chunk\nPOST /graph-backfill\nPOST /edge\nGET /edges",
        { headers: { ...corsHeaders, "Content-Type": "text/plain" } }
      );
    } catch (error) {
      // Raw errors can expose internals to clients.
      console.error("rag worker error:", error);
      return new Response(JSON.stringify({ error: "internal error" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};

async function handleUpload(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
  // Multipart framing must fit too, without reducing the existing file limit.
  const bytes = await boundedBody(request, MAX_UPLOAD_BYTES + 64 * 1024);
  if (bytes instanceof Response) {
    for (const [key, value] of Object.entries(corsHeaders)) bytes.headers.set(key, value);
    return bytes;
  }
  let formData: FormData;
  try {
    formData = await new Response(bytes as BodyInit, { headers: request.headers }).formData();
  } catch {
    return Response.json({ error: "Invalid multipart body" }, { status: 400, headers: corsHeaders });
  }
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return new Response(JSON.stringify({ error: "No file provided" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (file.size > MAX_UPLOAD_BYTES) {
    return new Response(JSON.stringify({ error: "File too large" }), {
      status: 413,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const content = await file.text();
  const filename = file.name;

  // Filenames become storage keys, so slashes and path traversal are forbidden.
  if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) {
    return new Response(JSON.stringify({ error: "Invalid filename" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Reserving the longest chunk suffix prevents partial writes for names Vectorize cannot accept.
  if (new TextEncoder().encode(filename + MAX_CHUNK_SUFFIX).byteLength > MAX_VECTOR_ID_BYTES) {
    return new Response(JSON.stringify({ error: "Filename is too long: vector IDs allow at most 64 bytes including _chunk_999999 (filename maximum: 51 bytes)" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const chunkSize = 1000;
  const overlap = 150;
  const chunks: string[] = [];

  // Keep UTF-16 surrogate pairs intact at chunk boundaries because invalid
  // Unicode makes the embedder reject the entire batch.
  const isHighSurrogate = (i: number) => {
    const c = content.charCodeAt(i); return c >= 0xd800 && c <= 0xdbff;
  };
  const isLowSurrogate = (i: number) => {
    const c = content.charCodeAt(i); return c >= 0xdc00 && c <= 0xdfff;
  };

  // Require Unicode letters or digits so whitespace and terminal frame residue
  // cannot crowd meaningful passages out of reranked results.
  const hasSubstance = (chunk: string) =>
    (chunk.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;

  let start = 0;
  while (start < content.length) {
    if (start > 0 && isLowSurrogate(start)) start -= 1;
    let end = Math.min(start + chunkSize, content.length);
    if (end < content.length && isHighSurrogate(end - 1)) end -= 1;
    const piece = content.slice(start, end);
    if (hasSubstance(piece)) chunks.push(piece);
    if (end >= content.length) break;
    start = end - overlap;
  }

  await env.FTS.prepare("CREATE TABLE IF NOT EXISTS rag_deletions (filename TEXT PRIMARY KEY, plan TEXT NOT NULL)").run();
  const pending = await env.FTS.prepare("SELECT plan FROM rag_deletions WHERE filename = ?").bind(filename).first();
  if (pending) return new Response(JSON.stringify({ success: false, error: "Deletion pending; retry /delete before uploading this filename" }), {
    status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

  // The existing map inventories every possible vector before any external write.
  for (let i = 0; i < chunks.length; i += 50) {
    await env.FTS.batch(chunks.slice(i, i + 50).map((_, j) => {
      const id = `${filename}_chunk_${i + j}`;
      return env.FTS.prepare("INSERT OR IGNORE INTO chunk_map (filename, chunk_id, vectorize_id) VALUES (?, ?, ?)").bind(filename, id, id);
    }));
  }
  // Old graph references disappear before positional IDs acquire replacement content.
  await ensureGraphSchema(env);
  await env.FTS.prepare("DELETE FROM chunk_edges WHERE src_file = ? OR dst_file = ?").bind(filename, filename).run();
  await env.R2.put(`originals/${filename}`, content);


  const ftsStmts: D1PreparedStatement[] = [
    env.FTS.prepare("DELETE FROM chunks WHERE filename = ?").bind(filename),
  ];

  const headDate = parseHeaderDate(content.slice(0, 600));
  const parsedName = parseFilename(filename);
  const extraMetadata: Pick<ChunkMetadata, "date" | "session"> = {};
  if (headDate) extraMetadata.date = headDate;
  if (parsedName) extraMetadata.session = parsedName.session;

  // The embedding API accepts at most 20 texts per batch.
  const batchSize = 20;
  for (let batchStart = 0; batchStart < chunks.length; batchStart += batchSize) {
    const batch = chunks.slice(batchStart, batchStart + batchSize);

    const embeddings = await env.AI.run(embedModel(env), {
      text: batch
    }) as { data: number[][] };

    const vectors = batch.map((chunk, i) => {
      const globalIndex = batchStart + i;
      const chunkId = `${filename}_chunk_${globalIndex}`;

      return {
        id: chunkId,
        values: embeddings.data[i],
        metadata: {
          filename,
          chunkIndex: globalIndex,
          totalChunks: chunks.length,
          ...extraMetadata,
        } as ChunkMetadata
      };
    });

    await env.VECTORIZE.upsert(vectors);

    for (let i = 0; i < batch.length; i++) {
      const globalIndex = batchStart + i;
      const chunkId = `${filename}_chunk_${globalIndex}`;
      await env.R2.put(`chunks/${chunkId}`, batch[i]);
    }

    // Searchable rows are replaced only after the external writes succeed.
    for (let i = 0; i < batch.length; i++) {
      const globalIndex = batchStart + i;
      const chunkId = `${filename}_chunk_${globalIndex}`;
      ftsStmts.push(
        env.FTS.prepare("INSERT INTO chunks (filename, chunk_id, content) VALUES (?, ?, ?)")
          .bind(filename, chunkId, batch[i])
      );
      ftsStmts.push(
        env.FTS.prepare("INSERT OR IGNORE INTO chunk_map (filename, chunk_id, vectorize_id) VALUES (?, ?, ?)")
          .bind(filename, chunkId, chunkId)
      );
    }
  }

  const FTS_BATCH = 50;
  for (let i = 0; i < ftsStmts.length; i += FTS_BATCH) {
    await env.FTS.batch(ftsStmts.slice(i, i + FTS_BATCH));
  }

  const mapped = await env.FTS.prepare("SELECT vectorize_id FROM chunk_map WHERE filename = ?").bind(filename).all<{ vectorize_id: string }>();
  const surplusIds: string[] = mapped.results.map(row => row.vectorize_id).filter(id => Number(id.match(/_chunk_(\d+)$/)?.[1]) >= chunks.length);
  let staleCursor: string | undefined;
  do {
    const page = await env.R2.list({ prefix: `chunks/${filename}_chunk_`, cursor: staleCursor });
    for (const obj of page.objects) {
      const m = obj.key.match(/_chunk_(\d+)$/);
      if (m && parseInt(m[1], 10) >= chunks.length) {
        const id = obj.key.replace("chunks/", "");
        if (!surplusIds.includes(id)) surplusIds.push(id);
      }
    }
    staleCursor = r2Cursor(page);
  } while (staleCursor);
  for (let i = 0; i < surplusIds.length; i += 100) {
    await env.VECTORIZE.deleteByIds(surplusIds.slice(i, i + 100));
  }
  // R2 retains every cleanup target until all vector deletions succeed so retries can reconstruct the IDs.
  for (const id of surplusIds) await env.R2.delete(`chunks/${id}`);

  // Inventory entries survive until both external stores confirm surplus removal.
  for (const id of surplusIds) await env.FTS.prepare("DELETE FROM chunk_map WHERE filename = ? AND vectorize_id = ?").bind(filename, id).run();
  const edges = await writeFileGraph(env, filename, content.slice(0, 600), chunks.length);

  return new Response(JSON.stringify({
    success: true,
    filename,
    chunks: chunks.length,
    edges,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function r2Cursor(page: { truncated: boolean } & Record<string, unknown>): string | undefined {
  if (!page.truncated) return undefined;
  const c = (page as { cursor?: unknown }).cursor;
  return typeof c === "string" && c.length > 0 ? c : undefined;
}

function detectSessionFilter(query: string, prefix: string): string | null {
  const re = new RegExp(`\\b(?:${escapeRegex(prefix)}|Session)[\\s_]+(\\d{1,3})\\b`, "i");
  const match = query.match(re);
  if (!match) return null;
  return `${prefix}_${match[1]}`;
}

// Quoted tokens prevent query punctuation from becoming FTS5 syntax.
function escapeFtsQuery(q: string): string {
  const cleaned = q.replace(/[\x00-\x1f]/g, " ").trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(/\s+/).map((t) => t.replace(/"/g, "")).filter(Boolean);
  if (!tokens.length) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function rrfMerge(
  vectorRanks: { id: string; metadata?: ChunkMetadata }[],
  bm25Ranks: { chunk_id: string; filename: string }[],
  k: number = 60
): { id: string; filename: string; score: number; sources: string[] }[] {
  const scores = new Map<string, { score: number; filename: string; sources: Set<string> }>();

  vectorRanks.forEach((hit, rank) => {
    const id = hit.id;
    const filename = hit.metadata?.filename || "";
    const score = 1 / (k + rank + 1);
    const existing = scores.get(id);
    if (existing) {
      existing.score += score;
      existing.sources.add("vector");
    } else {
      scores.set(id, { score, filename, sources: new Set(["vector"]) });
    }
  });

  bm25Ranks.forEach((hit, rank) => {
    const id = hit.chunk_id;
    const score = 1 / (k + rank + 1);
    const existing = scores.get(id);
    if (existing) {
      existing.score += score;
      existing.sources.add("bm25");
    } else {
      scores.set(id, { score, filename: hit.filename, sources: new Set(["bm25"]) });
    }
  });

  return Array.from(scores.entries())
    .map(([id, v]) => ({ id, filename: v.filename, score: v.score, sources: Array.from(v.sources) }))
    .sort((a, b) => b.score - a.score);
}

// The reserved namespace requires its full prefix; substr keeps underscores literal.
function filenameScope(prefix: unknown) {
  if (prefix !== undefined && (typeof prefix !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(prefix))) return null;
  const explicit = typeof prefix === "string" ? prefix : undefined;
  const includeBuilder = explicit?.startsWith("Builder_") === true;
  return {
    visible: (filename: string) => (!filename.startsWith("Builder_") || includeBuilder) &&
      (explicit === undefined || filename.startsWith(explicit)),
    sql: (includeBuilder ? "" : " AND substr(filename, 1, 8) != 'Builder_'") +
      (explicit === undefined ? "" : " AND substr(filename, 1, ?) = ?"),
    params: explicit === undefined ? [] : [explicit.length, explicit],
  };
}

async function handleSearch(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const body = await request.json() as {
    query: string;
    topK?: number;
    limit?: number;
    mode?: "hybrid" | "vector" | "bm25";
    filenamePrefix?: unknown;
    dateFrom?: unknown;
    dateTo?: unknown;
  };
  const { query, mode = "hybrid" } = body;
  const topK = body.topK ?? body.limit ?? 5;

  if (!query || typeof query !== "string") {
    return new Response(JSON.stringify({ error: "No query provided" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const safeQuery = query.slice(0, 2000).trim();
  if (!safeQuery) {
    return new Response(JSON.stringify({ error: "No query provided" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const scope = filenameScope(body.filenamePrefix);
  if (!scope) {
    return new Response(JSON.stringify({ error: "Invalid filenamePrefix" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
  const visibleFile = scope.visible;
  const visibilitySql = scope.sql;
  const prefixParams = scope.params;

  const safeTopK = Math.min(Math.max(Number(topK) || 5, 1), 20);

  const allowedModes = new Set(["hybrid", "vector", "bm25"]);
  const safeMode = (allowedModes.has(mode as string) ? mode : "hybrid") as "hybrid" | "vector" | "bm25";

  let dateFilter: { from: string; to: string } | null = null;
  if (body.dateFrom !== undefined || body.dateTo !== undefined) {
    if (!isIsoDay(body.dateFrom) || !isIsoDay(body.dateTo) || body.dateFrom > body.dateTo) {
      return new Response(JSON.stringify({ error: "Invalid date range (dateFrom and dateTo as YYYY-MM-DD, dateFrom <= dateTo)" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    dateFilter = { from: body.dateFrom, to: body.dateTo };
  }
  let dateFiles: Set<string> | null = null;
  if (dateFilter) {
    await ensureGraphSchema(env);
    const rows = await env.FTS.prepare(
      `SELECT filename FROM files WHERE length(date) = 10 AND date >= ? AND date <= ? LIMIT 5000`,
    ).bind(dateFilter.from, dateFilter.to).all<{ filename: string }>();
    dateFiles = new Set((rows.results ?? []).map((r) => r.filename));
  }

  const sessionPrefix = detectSessionFilter(safeQuery, env.SESSION_PREFIX || "Session");

  if (dateFiles && !dateFiles.size) {
    return new Response(JSON.stringify({
      query: safeQuery,
      mode: safeMode,
      results: [],
      filtered: !!sessionPrefix || body.filenamePrefix !== undefined,
      session_filter: sessionPrefix || null,
      date_filter: dateFilter,
      reranked: false,
      ghosts_repaired: 0,
      counts: { vector: 0, bm25: 0 },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  // Overfetch for post-filtering, but Vectorize allows only 50 hits with full metadata.
  const fetchK = Math.min(sessionPrefix || dateFilter ? Math.max(safeTopK * 10, 50) : Math.max(safeTopK * 5, 30), 50);

  const ftsQuery = escapeFtsQuery(safeQuery);

  const [vectorResults, bm25Results] = await Promise.all([
    safeMode === "bm25" ? Promise.resolve({ matches: [] as any[] }) :
      env.AI.run(embedModel(env), { text: [safeQuery] })
        .then((emb: any) =>
          env.VECTORIZE.query(emb.data[0], { topK: fetchK, returnMetadata: "all" })
        ),
    (safeMode === "vector" || !ftsQuery) ? Promise.resolve({ results: [] as any[] }) :
      dateFilter
        ? env.FTS.prepare(
          `SELECT filename, chunk_id FROM chunks WHERE chunks MATCH ?
             AND filename IN (SELECT filename FROM files WHERE length(date) = 10 AND date >= ? AND date <= ?)
             ${visibilitySql} ORDER BY rank LIMIT ?`
        ).bind(ftsQuery, dateFilter.from, dateFilter.to, ...prefixParams, fetchK)
          .all<{ filename: string; chunk_id: string }>()
        : env.FTS.prepare(
          `SELECT filename, chunk_id FROM chunks WHERE chunks MATCH ?${visibilitySql} ORDER BY rank LIMIT ?`
        ).bind(ftsQuery, ...prefixParams, fetchK).all<{ filename: string; chunk_id: string }>(),
  ]);

  // Filter before ranking or reading bodies so excluded namespaces never supply context.
  let vectorMatches = ((vectorResults as any).matches || [])
    .filter((match: any) => visibleFile((match.metadata?.filename as string) || filenameOf(match.id)));
  if (dateFiles) {
    const inRange = dateFiles;
    vectorMatches = vectorMatches.filter((match: any) => inRange.has((match.metadata?.filename as string) || ""));
  }
  if (sessionPrefix) {
    const prefixWithBound = sessionPrefix + "_";
    const prefixExact = sessionPrefix + ".";
    // Keep empty results rather than returning unrelated sessions when the filter has no hits.
    vectorMatches = vectorMatches.filter((match: any) => {
      const fn = (match.metadata?.filename as string) || "";
      return fn.startsWith(prefixExact) || fn.startsWith(prefixWithBound) || fn === sessionPrefix;
    });
  }

  const bm25Hits = ((bm25Results as any).results || [])
    .filter((hit: any) => visibleFile(hit.filename || ""));
  let bm25Filtered = bm25Hits;
  if (sessionPrefix) {
    const prefixWithBound = sessionPrefix + "_";
    const prefixExact = sessionPrefix + ".";
    bm25Filtered = bm25Hits.filter((hit: any) => {
      const fn = hit.filename || "";
      return fn.startsWith(prefixExact) || fn.startsWith(prefixWithBound) || fn === sessionPrefix;
    });
  }

  let finalRanking: { id: string; filename: string; score: number; sources: string[] }[];
  if (safeMode === "vector") {
    finalRanking = vectorMatches.map((m: any) => ({
      id: m.id,
      filename: m.metadata?.filename || filenameOf(m.id),
      score: m.score,
      sources: ["vector"],
    }));
  } else if (safeMode === "bm25") {
    finalRanking = bm25Filtered.map((h: any, i: number) => ({
      id: h.chunk_id,
      filename: h.filename,
      score: 1 / (60 + i + 1),
      sources: ["bm25"],
    }));
  } else {
    finalRanking = rrfMerge(vectorMatches, bm25Filtered, 60);
  }

  const rerankN = Math.min(finalRanking.length, 20);
  let ranked = finalRanking;
  let reranked = false;

  // Vectorize has no list API; search reveals orphan vectors that would waste result slots.
  const ghostIds = new Set<string>();

  if (safeMode === "hybrid" && rerankN > 1) {
    try {
      const allCandidates = finalRanking.slice(0, rerankN);

      const bodies = await Promise.all(
        allCandidates.map(async (hit) => {
          const obj = await env.R2.get(`chunks/${hit.id}`);
          if (!obj) {
            ghostIds.add(hit.id);
            return null;
          }
          return await obj.text();
        })
      );
      const candidates = allCandidates.filter((_, i) => bodies[i] !== null);
      const texts = bodies.filter((t): t is string => t !== null);

      const rr = await env.AI.run(rerankModel(env), {
        query: safeQuery,
        contexts: texts.map((text) => ({ text })),
      }) as { response?: { id: number; score: number }[] };

      if (rr?.response?.length) {
        const seen = new Set<number>();
        const rerankedTop = rr.response
          .filter((r) => candidates[r.id])
          .sort((a, b) => b.score - a.score)
          .map((r) => {
            seen.add(r.id);
            return {
              ...candidates[r.id],
              score: r.score,
              sources: [...candidates[r.id].sources, "rerank"],
            };
          });

        const leftover = candidates.filter((_, idx) => !seen.has(idx));

        ranked = rerankedTop.concat(leftover, finalRanking.slice(rerankN));
        reranked = true;
      }
    } catch {
      // keep RRF order
    }
  }

  const top = ranked.slice(0, safeTopK);

  const resultsRaw = await Promise.all(
    top.map(async (hit) => {
      const chunkContent = await env.R2.get(`chunks/${hit.id}`);
      if (!chunkContent) {
        ghostIds.add(hit.id);
        return null;
      }
      const content = await chunkContent.text();

      let chunkIndex = 0;
      let totalChunks = 1;
      const vMatch = vectorMatches.find((m: any) => m.id === hit.id);
      if (vMatch?.metadata) {
        chunkIndex = vMatch.metadata.chunkIndex || 0;
        totalChunks = vMatch.metadata.totalChunks || 1;
      } else {
        const m = hit.id.match(/_chunk_(\d+)$/);
        if (m) chunkIndex = parseInt(m[1], 10);
      }

      return {
        score: hit.score,
        filename: hit.filename,
        chunkIndex,
        totalChunks,
        content,
        sources: hit.sources,
      };
    })
  );
  const results = resultsRaw.filter((r) => r !== null) as NonNullable<(typeof resultsRaw)[number]>[];

  try {
    const names = [...new Set(results.map((r) => r.filename).filter(Boolean))].slice(0, 50);
    if (names.length) {
      await ensureGraphSchema(env);
      const rows = await env.FTS.prepare(
        `SELECT filename, date, session FROM files WHERE filename IN (${names.map(() => "?").join(",")})`,
      ).bind(...names).all<{ filename: string; date: string | null; session: number }>();
      const byName = new Map((rows.results ?? []).map((r) => [r.filename, r]));
      for (const r of results as any[]) {
        const f = byName.get(r.filename);
        r.date = f?.date ?? null;
        r.session = f?.session ?? null;
      }
    }
  } catch (e) {
    console.error("rag: date lookup failed (search stays green):", e);
  }

  if (ghostIds.size) {
    const ids = [...ghostIds];
    try {
      await env.VECTORIZE.deleteByIds(ids);
      const delStmts: D1PreparedStatement[] = [];
      for (const id of ids) {
        delStmts.push(env.FTS.prepare("DELETE FROM chunks WHERE chunk_id = ?").bind(id));
        delStmts.push(env.FTS.prepare("DELETE FROM chunk_map WHERE chunk_id = ?").bind(id));
      }
      for (let i = 0; i < delStmts.length; i += 50) {
        await env.FTS.batch(delStmts.slice(i, i + 50));
      }
      console.log(`rag: lazy-repaired ${ids.length} ghost vector(s):`, ids.slice(0, 5).join(", "));
    } catch (e) {
      console.error("rag: ghost repair failed:", e);
    }
  }

  return new Response(JSON.stringify({
    query: safeQuery,
    mode: safeMode,
    results,
    filtered: !!sessionPrefix || body.filenamePrefix !== undefined,
    session_filter: sessionPrefix || null,
    date_filter: dateFilter,
    reranked,
    ghosts_repaired: ghostIds.size,
    counts: { vector: vectorMatches.length, bm25: bm25Filtered.length },
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

async function handleList(env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  // R2.list returns at most 1000 objects per page.
  const files: { name: string; size: number; uploaded: Date }[] = [];
  let cursor: string | undefined;
  do {
    const listed = await env.R2.list({ prefix: "originals/", cursor });
    for (const obj of listed.objects) {
      files.push({
        name: obj.key.replace("originals/", ""),
        size: obj.size,
        uploaded: obj.uploaded,
      });
    }
    cursor = r2Cursor(listed);
  } while (cursor);

  return new Response(JSON.stringify({ files }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

async function handleFiles(url: URL, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const json = { ...corsHeaders, "Content-Type": "application/json" };
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (!isIsoDay(from) || !isIsoDay(to) || from > to) {
    return new Response(JSON.stringify({ error: "Invalid range (from and to as YYYY-MM-DD, from <= to)" }), { status: 400, headers: json });
  }
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) {
    return new Response(JSON.stringify({ error: "Range longer than 366 days" }), { status: 400, headers: json });
  }
  const scope = filenameScope(url.searchParams.get("filenamePrefix") ?? undefined);
  if (!scope) return new Response(JSON.stringify({ error: "Invalid filenamePrefix" }), { status: 400, headers: json });
  const order = url.searchParams.get("order") === "desc" ? "desc" : "asc";
  const facts = Number(url.searchParams.get("facts") ?? 6);
  const limit = Number(url.searchParams.get("limit") ?? 200);
  const dir = order === "desc" ? "DESC" : "ASC";

  await ensureGraphSchema(env);
  const rows = await env.FTS.prepare(
    `SELECT filename, prefix, session, part, date, total_chunks FROM files
     WHERE length(date) = 10 AND date >= ? AND date <= ?${scope.sql}
     ORDER BY date ${dir}, session ${dir}, prefix ${dir}, part ASC, filename ASC LIMIT ?`,
  ).bind(from, to, ...scope.params, limit + 1).all<FileRow>();
  const all = rows.results ?? [];
  const list = all.slice(0, limit);

  const sessionKey = (r: FileRow) => (r.session > 0 ? `${r.prefix}#${r.session}` : r.filename);
  const firstPart = new Map<string, FileRow>();
  const keys: string[] = [];
  for (const r of list) {
    const k = sessionKey(r);
    const known = firstPart.get(k);
    if (!known) { keys.push(k); firstPart.set(k, r); }
    else if (r.part < known.part) firstPart.set(k, r);
  }
  const factsBy = new Map<string, ReturnType<typeof headerFacts>>();
  await Promise.all(keys.slice(0, facts).map(async (k) => {
    const r = firstPart.get(k)!;
    try {
      const obj = await env.R2.get(`originals/${r.filename}`, { range: { offset: 0, length: 800 } });
      if (obj) factsBy.set(k, headerFacts(await obj.text()));
    } catch (e) {
      console.error("rag: header read failed (files stays green):", e);
    }
  }));
  const none = { themes: null, summary: null, key_moments: null };
  const files = list.map((r) => ({ ...r, ...(factsBy.get(sessionKey(r)) ?? none) }));

  return new Response(JSON.stringify({
    from, to, order, files, sessions: keys.length, truncated: all.length > limit,
  }), { headers: json });
}

async function handleDelete(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const { filename } = await request.json() as { filename: string };

  if (!filename) {
    return new Response(JSON.stringify({ error: "No filename provided" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) {
    return new Response(JSON.stringify({ error: "Invalid filename" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }

  const completed: string[] = [];
  const failed: string[] = [];
  let plan: { keys: string[]; vectorIds: string[] } = { keys: [], vectorIds: [] };
  try {
    // A content-free durable plan preserves cleanup targets after their source objects disappear.
    await env.FTS.prepare("CREATE TABLE IF NOT EXISTS rag_deletions (filename TEXT PRIMARY KEY, plan TEXT NOT NULL)").run();
    const pending = await env.FTS.prepare("SELECT plan FROM rag_deletions WHERE filename = ?").bind(filename).first<{ plan: string }>();
    if (pending) plan = JSON.parse(pending.plan);
    else {
      plan.keys.push(`originals/${filename}`);
      let cursor: string | undefined;
      do {
        const page = await env.R2.list({ prefix: `chunks/${filename}_chunk_`, cursor });
        for (const obj of page.objects) {
          plan.keys.push(obj.key);
          plan.vectorIds.push(obj.key.slice("chunks/".length));
        }
        cursor = r2Cursor(page);
      } while (cursor);
      const mapped = await env.FTS.prepare("SELECT vectorize_id FROM chunk_map WHERE filename = ?").bind(filename).all<{ vectorize_id: string }>();
      plan.vectorIds = [...new Set([...plan.vectorIds, ...mapped.results.map(row => row.vectorize_id)])];
      plan.keys = [...new Set([...plan.keys, ...plan.vectorIds.map(id => `chunks/${id}`)])];
      await ensureGraphSchema(env);
      const indexed = await env.FTS.prepare("SELECT filename FROM files WHERE filename = ?").bind(filename).first();
      const edge = await env.FTS.prepare("SELECT src FROM chunk_edges WHERE src_file = ? OR dst_file = ? LIMIT 1").bind(filename, filename).first();
      const text = await env.FTS.prepare("SELECT chunk_id FROM chunks WHERE filename = ? LIMIT 1").bind(filename).first();
      if (!plan.vectorIds.length && !indexed && !edge && !text && !await env.R2.get(`originals/${filename}`)) {
        return new Response(JSON.stringify({ success: true, absent: true, deleted: false }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      await env.FTS.prepare("INSERT INTO rag_deletions (filename, plan) VALUES (?, ?)").bind(filename, JSON.stringify(plan)).run();
    }
    const attempt = async (label: string, work: () => Promise<unknown>) => {
      try { await work(); completed.push(label); }
      catch (err) {
        console.error("rag deletion failed:", label, err);
        failed.push(`${label}: cleanup failed`);
      }
    };
    for (const key of plan.keys) await attempt(`R2 ${key}`, () => env.R2.delete(key));
    for (let i = 0; i < plan.vectorIds.length; i += 100) {
      await attempt(`vectors ${i}`, () => env.VECTORIZE.deleteByIds(plan.vectorIds.slice(i, i + 100)));
    }
    await attempt("D1 indexes and graph", async () => {
      await ensureGraphSchema(env);
      await env.FTS.batch([
        env.FTS.prepare("DELETE FROM chunks WHERE filename = ?").bind(filename),
        env.FTS.prepare("DELETE FROM chunk_map WHERE filename = ?").bind(filename),
        env.FTS.prepare("DELETE FROM chunk_edges WHERE src_file = ? OR dst_file = ?").bind(filename, filename),
        env.FTS.prepare("DELETE FROM files WHERE filename = ?").bind(filename),
      ]);
    });
    // Idempotent cleanup replays the plan until every store confirms deletion.
    if (!failed.length) await env.FTS.prepare("DELETE FROM rag_deletions WHERE filename = ?").bind(filename).run();
  } catch (err) {
    console.error("rag deletion preparation or finalization failed:", err);
    failed.push("cleanup preparation or finalization failed");
  }
  return new Response(JSON.stringify(failed.length ? {
    success: false, partial: true, error: "Deletion incomplete; retry with the same filename", completed, failed,
  } : {
    success: true, deleted: filename, chunksRemoved: plan.vectorIds.length,
  }), {
    status: failed.length ? 500 : 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}

async function handleFtsBackfill(
  request: Request,
  env: Env,
  corsHeaders: Record<string, string>
): Promise<Response> {
  const { cursor, limit = 200 } = await request.json().catch(() => ({} as any)) as {
    cursor?: string;
    limit?: number;
  };

  const safeLimit = Math.min(Math.max(Number(limit) || 200, 1), 1000);

  const listed = await env.R2.list({ prefix: "chunks/", limit: safeLimit, cursor });
  let inserted = 0;
  let skipped = 0;

  for (const obj of listed.objects) {
    const chunkId = obj.key.replace("chunks/", "");
    const m = chunkId.match(/^(.+)_chunk_(\d+)$/);
    if (!m) {
      skipped++;
      continue;
    }
    const filename = m[1];

    const existing = await env.FTS
      .prepare("SELECT 1 FROM chunk_map WHERE chunk_id = ? LIMIT 1")
      .bind(chunkId)
      .first();
    if (existing) {
      skipped++;
      continue;
    }

    const chunkObj = await env.R2.get(`chunks/${chunkId}`);
    if (!chunkObj) {
      skipped++;
      continue;
    }
    const content = await chunkObj.text();

    await env.FTS.batch([
      env.FTS.prepare("INSERT INTO chunks (filename, chunk_id, content) VALUES (?, ?, ?)")
        .bind(filename, chunkId, content),
      env.FTS.prepare("INSERT INTO chunk_map (filename, chunk_id, vectorize_id) VALUES (?, ?, ?)")
        .bind(filename, chunkId, chunkId),
    ]);
    inserted++;
  }

  return new Response(JSON.stringify({
    inserted,
    skipped,
    truncated: listed.truncated,
    cursor: r2Cursor(listed) ?? null,
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" }
  });
}


type ExpandEdge = "NEXT" | "PREV" | "SAME_EPISODE";

interface ExpandResult {
  id: string;
  filename: string;
  chunkIndex: number;
  content: string;
  edge: ExpandEdge;
  via: string;          
  hop: number;          
  score: number | null; 
}

function chunkIndexOf(id: string): number {
  const m = id.match(/_chunk_(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}
function filenameOf(id: string): string {
  return id.replace(/_chunk_\d+$/, "");
}

// Vectorize rejects filename filters without a metadata index, so post-filtering is the fallback.
async function hybridWithin(
  env: Env,
  query: string,
  files: string[],
  topK: number,
  exclude: Set<string>,
): Promise<{ id: string; filename: string; score: number }[]> {
  if (!files.length || !query) return [];
  const fileSet = new Set(files);
  const emb = await env.AI.run(embedModel(env), { text: [query] }) as { data: number[][] };
  let vectorMatches: { id: string; metadata?: ChunkMetadata }[] = [];
  try {
    const r = await env.VECTORIZE.query(emb.data[0], {
      topK: 50,
      returnMetadata: "all",
      filter: { filename: { $in: files.slice(0, 50) } } as any,
    });
    vectorMatches = (r.matches || []) as any[];
  } catch {
    const r = await env.VECTORIZE.query(emb.data[0], { topK: 50, returnMetadata: "all" });
    vectorMatches = ((r.matches || []) as any[]).filter((m) => fileSet.has(m.metadata?.filename || ""));
  }

  const ftsQuery = escapeFtsQuery(query);
  let bm25: { chunk_id: string; filename: string }[] = [];
  if (ftsQuery) {
    const placeholders = files.slice(0, 50).map(() => "?").join(",");
    const r = await env.FTS.prepare(
      `SELECT filename, chunk_id FROM chunks WHERE chunks MATCH ? AND filename IN (${placeholders}) ORDER BY rank LIMIT 50`,
    ).bind(ftsQuery, ...files.slice(0, 50)).all<{ filename: string; chunk_id: string }>();
    bm25 = r.results ?? [];
  }

  const merged = rrfMerge(vectorMatches, bm25, 60).filter((h) => !exclude.has(h.id));
  const cands = merged.slice(0, 20);
  if (cands.length <= 1) return cands.map((c) => ({ id: c.id, filename: c.filename, score: c.score }));

  const bodies = await Promise.all(cands.map(async (h) => (await env.R2.get(`chunks/${h.id}`))?.text() ?? null));
  const alive = cands.filter((_, i) => bodies[i] !== null);
  const texts = bodies.filter((t): t is string => t !== null);
  try {
    const rr = await env.AI.run(rerankModel(env), {
      query,
      contexts: texts.map((text) => ({ text })),
    }) as { response?: { id: number; score: number }[] };
    if (rr?.response?.length) {
      return rr.response
        .filter((r) => alive[r.id])
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map((r) => ({ id: alive[r.id].id, filename: alive[r.id].filename, score: r.score }));
    }
  } catch { /* keep RRF order */ }
  return alive.slice(0, topK).map((c) => ({ id: c.id, filename: c.filename, score: c.score }));
}

async function handleExpand(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const json = { ...corsHeaders, "Content-Type": "application/json" };
  const body = await request.json().catch(() => ({})) as {
    anchors?: { filename?: string; chunkIndex?: number }[];
    filenamePrefix?: unknown;
    query?: string;
    neighbors?: number;
    episodeTopK?: number;
    episodeSpan?: number;
    exclude?: { filename?: string; chunkIndex?: number }[];
    veto_for?: { filename?: string; chunkIndex?: number }[];
  };
  const valid = (a: any): a is { filename: string; chunkIndex: number } =>
    a && typeof a.filename === "string" && /^[A-Za-z0-9._-]+\.md$/.test(a.filename) && Number.isInteger(a.chunkIndex) && a.chunkIndex >= 0;
  const scope = filenameScope(body.filenamePrefix);
  if (!scope) return new Response(JSON.stringify({ error: "Invalid filenamePrefix" }), { status: 400, headers: json });
  const anchors = (Array.isArray(body.anchors) ? body.anchors : []).filter(valid)
    .filter(a => scope.visible(a.filename)).slice(0, 5);
  if (!anchors.length) {
    return new Response(JSON.stringify({ error: "No valid anchors" }), { status: 400, headers: json });
  }
  const hops = Math.min(Math.max(Math.trunc(Number(body.neighbors ?? 1)), 0), 2);
  const episodeTopK = Math.min(Math.max(Math.trunc(Number(body.episodeTopK ?? 5)), 0), 10);
  const episodeSpan = Math.min(Math.max(Math.trunc(Number(body.episodeSpan ?? 1)), 0), 3);
  const query = typeof body.query === "string" ? body.query.slice(0, 2000).trim() : "";

  await ensureGraphSchema(env);

  const exclude = new Set<string>();
  for (const a of anchors) exclude.add(chunkId(a.filename, a.chunkIndex));
  for (const e of (Array.isArray(body.exclude) ? body.exclude : []).filter(valid).slice(0, 200)) {
    exclude.add(chunkId(e.filename, e.chunkIndex));
  }

  const results: ExpandResult[] = [];
  const seen = new Set<string>(exclude);

  if (hops > 0) {
    for (const a of anchors) {
      const anchorId = chunkId(a.filename, a.chunkIndex);
      let frontier: { id: string; edge: ExpandEdge }[] = [{ id: anchorId, edge: "NEXT" }, { id: anchorId, edge: "PREV" }];
      for (let hop = 1; hop <= hops; hop++) {
        const next: { id: string; edge: ExpandEdge }[] = [];
        for (const f of frontier) {
          const row = f.edge === "NEXT"
            ? await env.FTS.prepare(`SELECT dst AS id FROM chunk_edges WHERE src = ? AND type = 'NEXT' AND confirmed = 1 LIMIT 1`).bind(f.id).first<{ id: string }>()
            : await env.FTS.prepare(`SELECT src AS id FROM chunk_edges WHERE dst = ? AND type = 'NEXT' AND confirmed = 1 LIMIT 1`).bind(f.id).first<{ id: string }>();
          if (!row?.id || !scope.visible(filenameOf(row.id))) continue;
          next.push({ id: row.id, edge: f.edge });
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          results.push({
            id: row.id, filename: filenameOf(row.id), chunkIndex: chunkIndexOf(row.id),
            content: "", edge: f.edge, via: anchorId, hop, score: null,
          });
        }
        frontier = next;
        if (!frontier.length) break;
      }
    }
  }

  let episode: { sessions: number[]; files: string[] } = { sessions: [], files: [] };
  if (episodeTopK > 0 && query) {
    const keys = new Set<string>();
    const fileSet = new Set<string>();
    const sessSet = new Set<number>();
    for (const a of anchors) {
      const p = parseFilename(a.filename);
      if (!p) continue;
      const key = `${p.prefix}#${p.session}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const ep = await episodeFiles(env, p.prefix, p.session, episodeSpan);
      ep.files.filter(scope.visible).forEach((f) => fileSet.add(f));
      ep.sessions.forEach((s) => sessSet.add(s));
    }
    episode = { sessions: [...sessSet].sort((x, y) => x - y), files: [...fileSet] };
    if (episode.files.length) {
      const hits = await hybridWithin(env, query, episode.files, episodeTopK, seen);
      for (const h of hits) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        const via = anchors.find((a) => parseFilename(a.filename)?.session === parseFilename(h.filename)?.session) ?? anchors[0];
        results.push({
          id: h.id, filename: h.filename, chunkIndex: chunkIndexOf(h.id),
          content: "", edge: "SAME_EPISODE", via: chunkId(via.filename, via.chunkIndex), hop: 1, score: h.score,
        });
      }
    }
  }

  const filled = (await Promise.all(results.map(async (r) => {
    const obj = await env.R2.get(`chunks/${r.id}`);
    if (!obj) return null;
    return { ...r, content: await obj.text() };
  }))).filter((r): r is ExpandResult => r !== null);

  const vetoFor = (Array.isArray(body.veto_for) ? body.veto_for : anchors).filter(valid)
    .filter(a => scope.visible(a.filename)).slice(0, 12)
    .map((a) => chunkId(a.filename, a.chunkIndex));
  const vetoes: { src: string; dst: string; type: string; note: string | null; origin: string; dst_content: string | null }[] = [];
  if (vetoFor.length) {
    const ph = vetoFor.map(() => "?").join(",");
    const rows = await env.FTS.prepare(
      `SELECT src, dst, type, note, origin FROM chunk_edges
       WHERE confirmed = 1 AND type IN ('CORRECTED_BY','SUPERSEDED_BY') AND src IN (${ph}) LIMIT 40`,
    ).bind(...vetoFor).all<{ src: string; dst: string; type: string; note: string | null; origin: string }>();
    for (const row of rows.results ?? []) {
      if (isChunkRef(row.dst) && !scope.visible(filenameOf(row.dst))) continue;
      let dst_content: string | null = null;
      if (isChunkRef(row.dst)) {
        const obj = await env.R2.get(`chunks/${row.dst}`);
        dst_content = obj ? (await obj.text()).slice(0, 600) : null;
      }
      vetoes.push({ ...row, dst_content });
    }
  }

  return new Response(JSON.stringify({
    anchors: anchors.map((a) => chunkId(a.filename, a.chunkIndex)),
    episode,
    results: filled,
    vetoes,
    counts: {
      neighbors: filled.filter((r) => r.edge !== "SAME_EPISODE").length,
      episode: filled.filter((r) => r.edge === "SAME_EPISODE").length,
      vetoes: vetoes.length,
    },
  }), { headers: json });
}

async function handleEdgeWrite(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const json = { ...corsHeaders, "Content-Type": "application/json" };
  const b = await request.json().catch(() => ({})) as {
    src?: unknown; dst?: unknown; type?: unknown; confirmed?: unknown; origin?: unknown; note?: unknown;
  };
  if (!isChunkRef(b.src) || !isEdgeTarget(b.dst) || typeof b.type !== "string" || !EDGE_TYPES.has(b.type) || b.src === b.dst) {
    return new Response(JSON.stringify({ error: "Invalid edge (src chunk-id, dst chunk-id|memory:<id>, known type)" }), { status: 400, headers: json });
  }
  const confirmed = [0, 1, -1].includes(Number(b.confirmed ?? 0)) ? Number(b.confirmed ?? 0) : 0;
  const origin = typeof b.origin === "string" && /^[a-z0-9_-]{1,32}$/.test(b.origin) ? b.origin : "manual";
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 1200) : null;
  await ensureGraphSchema(env);
  const now = new Date().toISOString();
  await env.FTS.prepare(
    `INSERT INTO chunk_edges (src, dst, type, src_file, dst_file, origin, confirmed, created_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(src, dst, type) DO UPDATE SET confirmed = excluded.confirmed,
       note = COALESCE(excluded.note, chunk_edges.note)`,
  ).bind(b.src, b.dst, b.type, filenameOf(b.src), isChunkRef(b.dst) ? filenameOf(b.dst) : "memory", origin, confirmed, now, note).run();
  const row = await env.FTS.prepare(`SELECT src, dst, type, origin, confirmed, created_at, note FROM chunk_edges WHERE src = ? AND dst = ? AND type = ?`)
    .bind(b.src, b.dst, b.type).first();
  return new Response(JSON.stringify({ success: true, edge: row }), { headers: json });
}

async function handleEdgesRead(url: URL, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const json = { ...corsHeaders, "Content-Type": "application/json" };
  await ensureGraphSchema(env);
  const src = url.searchParams.get("src");
  const dst = url.searchParams.get("dst");
  const type = url.searchParams.get("type");
  const pending = Number(url.searchParams.get("pending") ?? 0) === 1;
  const confirmedRaw = url.searchParams.get("confirmed");
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (src) { if (!isChunkRef(src)) return new Response(JSON.stringify({ error: "Invalid src" }), { status: 400, headers: json }); where.push("src = ?"); binds.push(src); }
  if (dst) { if (!isEdgeTarget(dst)) return new Response(JSON.stringify({ error: "Invalid dst" }), { status: 400, headers: json }); where.push("dst = ?"); binds.push(dst); }
  if (type) { if (!EDGE_TYPES.has(type)) return new Response(JSON.stringify({ error: "Invalid type" }), { status: 400, headers: json }); where.push("type = ?"); binds.push(type); }
  if (pending) { where.push("confirmed = 0"); }
  else if (confirmedRaw !== null && [0, 1, -1].includes(Number(confirmedRaw))) { where.push("confirmed = ?"); binds.push(Number(confirmedRaw)); }
  if (!where.length) return new Response(JSON.stringify({ error: "Need src, dst, pending=1 or confirmed" }), { status: 400, headers: json });
  // NEXT edges only on explicit request (otherwise tens of thousands of rows).
  if (!type && !src && !dst) where.push("type != 'NEXT'");
  const rows = await env.FTS.prepare(
    `SELECT src, dst, type, origin, confirmed, created_at, note FROM chunk_edges WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds, limit, offset).all();
  return new Response(JSON.stringify({ edges: rows.results ?? [], limit, offset }), { headers: json });
}

async function handleChunk(url: URL, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const json = { ...corsHeaders, "Content-Type": "application/json" };
  const filename = (url.searchParams.get("filename") || "").trim();
  const index = Number(url.searchParams.get("index"));
  if (!/^[A-Za-z0-9._-]+\.md$/.test(filename) || !Number.isSafeInteger(index) || index < 0) {
    return new Response(JSON.stringify({ error: "Invalid filename or index" }), { status: 400, headers: json });
  }
  const id = chunkId(filename, index);
  const obj = await env.R2.get(`chunks/${id}`);
  if (!obj) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers: json });
  await ensureGraphSchema(env);
  const [next, prev, file] = await Promise.all([
    env.FTS.prepare(`SELECT dst AS id FROM chunk_edges WHERE src = ? AND type = 'NEXT' AND confirmed = 1 LIMIT 1`).bind(id).first<{ id: string }>(),
    env.FTS.prepare(`SELECT src AS id FROM chunk_edges WHERE dst = ? AND type = 'NEXT' AND confirmed = 1 LIMIT 1`).bind(id).first<{ id: string }>(),
    env.FTS.prepare(`SELECT filename, prefix, session, part, date, total_chunks FROM files WHERE filename = ?`).bind(filename).first<FileRow>(),
  ]);
  return new Response(JSON.stringify({
    id, filename, chunkIndex: index, content: await obj.text(),
    next: next?.id ?? null, prev: prev?.id ?? null, file: file ?? null,
  }), { headers: json });
}

async function handleGraphBackfill(request: Request, env: Env, corsHeaders: Record<string, string>): Promise<Response> {
  const json = { ...corsHeaders, "Content-Type": "application/json" };
  const { cursor, limit = 20, force = false } = await request.json().catch(() => ({} as any)) as {
    cursor?: string; limit?: number; force?: boolean;
  };
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  await ensureGraphSchema(env);

  const listed = await env.R2.list({ prefix: "originals/", limit: safeLimit, cursor });
  let written = 0, skipped = 0, edges = 0;
  const touched: string[] = [];
  for (const obj of listed.objects) {
    const filename = obj.key.replace("originals/", "");
    if (!/^[A-Za-z0-9._-]+\.md$/.test(filename)) { skipped++; continue; }
    const count = await env.FTS.prepare(`SELECT COUNT(*) AS n FROM chunk_map WHERE filename = ?`).bind(filename).first<{ n: number }>();
    const total = Number(count?.n ?? 0);
    if (total <= 0) { skipped++; continue; }
    if (!force) {
      const existing = await env.FTS.prepare(`SELECT total_chunks FROM files WHERE filename = ?`).bind(filename).first<{ total_chunks: number }>();
      if (existing && Number(existing.total_chunks) === total) { skipped++; continue; }
    }
    const head = await env.R2.get(obj.key, { range: { offset: 0, length: 600 } });
    const headText = head ? await head.text() : "";
    edges += await writeFileGraph(env, filename, headText, total);
    written++;
    touched.push(filename);
  }

  return new Response(JSON.stringify({
    written, skipped, edges, touched,
    truncated: listed.truncated,
    cursor: r2Cursor(listed) ?? null,
  }), { headers: json });
}
