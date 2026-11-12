/**
 * Offline stand-ins for the rag worker's bindings, for tests only: D1 on
 * bun:sqlite (FTS5 included), R2 as a map, Vectorize as an in-memory store
 * with dot-product search, Workers AI as a deterministic word-hash embedder
 * and a word-overlap "reranker". No network, no Cloudflare account.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class FakeStatement {
  constructor(private db: Database, private sql: string, private params: unknown[] = []) {}
  bind(...params: unknown[]) { return new FakeStatement(this.db, this.sql, params); }
  async all<T = any>() { return { results: this.db.query(this.sql).all(...(this.params as any[])) as T[], success: true }; }
  async first<T = any>() { return (this.db.query(this.sql).get(...(this.params as any[])) as T) ?? null; }
  async run() { this.db.query(this.sql).run(...(this.params as any[])); return { success: true }; }
  execSync() { this.db.query(this.sql).run(...(this.params as any[])); }
}

export class FakeD1 {
  db = new Database(":memory:");
  /** SQL text of every prepared statement, for assertions. */
  log: string[] = [];
  constructor(schema: "full" | "fts-only" = "full") {
    const sql = readFileSync(join(import.meta.dir, "..", "fts-init.sql"), "utf8");
    if (schema === "full") this.db.exec(sql);
    else {
      // An older database: only the FTS index, no graph tables.
      this.db.exec(sql.split("-- Retrieval graph")[0].split("\n").filter((l) => !l.startsWith("-- ----")).join("\n"));
    }
  }
  prepare(sql: string) { this.log.push(sql); return new FakeStatement(this.db, sql); }
  async batch(stmts: FakeStatement[]) {
    this.db.transaction(() => { for (const s of stmts) s.execSync(); })();
    return stmts.map(() => ({ success: true }));
  }
}

export class FakeR2 {
  objects = new Map<string, string>();
  reads: string[] = [];
  async put(key: string, value: string) { this.objects.set(key, String(value)); }
  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    this.reads.push(key);
    const v = this.objects.get(key);
    if (v === undefined) return null;
    const s = opts?.range ? v.slice(opts.range.offset, opts.range.offset + opts.range.length) : v;
    return { text: async () => s, body: s };
  }
  async delete(key: string) { this.objects.delete(key); }
  async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(opts.prefix ?? "")).sort();
    return { objects: keys.map((key) => ({ key, size: this.objects.get(key)!.length, uploaded: new Date(0) })), truncated: false };
  }
}

const DIM = 64;
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
function embed(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const w of words(text)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export class FakeVectorize {
  vectors = new Map<string, { values: number[]; metadata: Record<string, unknown> }>();
  filtersSeen: unknown[] = [];
  async upsert(list: { id: string; values: number[]; metadata: Record<string, unknown> }[]) {
    if (list.some((v) => new TextEncoder().encode(v.id).byteLength > 64)) throw new Error("Vector ID exceeds 64 bytes");
    for (const v of list) this.vectors.set(v.id, { values: v.values, metadata: v.metadata });
  }
  async query(values: number[], opts: { topK: number; filter?: unknown }) {
    // Like an index without metadata indexes: a filter is refused.
    if (opts.filter) { this.filtersSeen.push(opts.filter); throw new Error("no metadata index"); }
    const matches = [...this.vectors.entries()]
      .map(([id, v]) => ({ id, score: v.values.reduce((s, x, i) => s + x * values[i], 0), metadata: v.metadata }))
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.topK);
    return { matches };
  }
  async deleteByIds(ids: string[]) { for (const id of ids) this.vectors.delete(id); }
}

export class FakeAI {
  async run(_model: string, input: any) {
    if (Array.isArray(input.text)) return { data: input.text.map((t: string) => embed(t)) };
    if (typeof input.query === "string" && Array.isArray(input.contexts)) {
      const q = new Set(words(input.query));
      return {
        response: input.contexts.map((c: { text: string }, id: number) => {
          const w = new Set(words(c.text));
          const hit = [...q].filter((x) => w.has(x)).length;
          return { id, score: q.size ? hit / q.size : 0 };
        }),
      };
    }
    throw new Error("unexpected AI input");
  }
}

export const TOKEN = "test-token";

export function fakeEnv(schema: "full" | "fts-only" = "full") {
  return { FTS: new FakeD1(schema), R2: new FakeR2(), VECTORIZE: new FakeVectorize(), AI: new FakeAI(), RAG_AUTH_TOKEN: TOKEN } as const;
}
export type FakeEnv = ReturnType<typeof fakeEnv>;

/** Invented session export with a header block. */
export function sessionFile(name: string, date: string, facts: { themes?: string; summary?: string; moments?: string }, body: string): string {
  const n = name.match(/_(\d+)/)?.[1] ?? "0";
  return [
    `# [${name}] [DATE: ${date}]`,
    "",
    `SESSION=${n} | TYPE=CHAT | DATE=${date}`,
    `THEMES=${facts.themes ?? "—"}`,
    `SUMMARY=${facts.summary ?? "—"}`,
    "EMOTIONAL_ARC=—",
    `KEY_MOMENTS=${facts.moments ?? "—"}`,
    "DYNAMIC=—",
    "",
    "---",
    "",
    body,
  ].join("\n");
}
