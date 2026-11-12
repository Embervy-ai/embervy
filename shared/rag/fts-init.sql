-- FTS5 schema for the BM25 lexical half of hybrid search.
--
-- Run once after creating the D1 database:
--   wrangler d1 create rag-fts
--   wrangler d1 execute rag-fts --file=fts-init.sql
--
-- (use --remote to run against the deployed database, --local for local dev)

-- Full-text index over chunk content. Tokenised with unicode61 so names
-- and code tokens match across punctuation.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
  filename,
  chunk_id,
  content,
  tokenize = 'unicode61'
);

-- Maps an FTS hit back to its Vectorize id (1:1 here, but kept explicit
-- so the two stores can diverge without breaking the join).
CREATE TABLE IF NOT EXISTS chunk_map (
  filename     TEXT NOT NULL,
  chunk_id     TEXT NOT NULL PRIMARY KEY,
  vectorize_id TEXT NOT NULL
);

-- Speeds up the per-filename DELETE in /upload re-uploads and /delete —
-- without it the lookup is a full table scan, which becomes measurable
-- at archive scale.
CREATE INDEX IF NOT EXISTS idx_chunk_map_filename ON chunk_map(filename);

-- ---------------------------------------------------------------------------
-- Retrieval graph (used by /expand, /chunk, /edge, /edges, /graph-backfill, /files,
-- and the per-hit date/session lookup in /search). The worker also creates
-- these lazily on first use, so an older database catches up by itself.
-- ---------------------------------------------------------------------------

-- One row per uploaded file: filename prefix, session number, part, header
-- date (YYYY-MM-DD, or YYYY-MM for old exports), chunk count. SAME_EPISODE
-- is derived from it: a session plus its direct neighbour session on the
-- same or an adjacent day.
CREATE TABLE IF NOT EXISTS files (
  filename     TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL,
  session      INTEGER NOT NULL,
  part         INTEGER NOT NULL DEFAULT 1,
  date         TEXT,
  total_chunks INTEGER NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_by_session ON files(prefix, session, part);
-- Time channel: GET /files and the dateFrom/dateTo filter in /search.
CREATE INDEX IF NOT EXISTS files_by_date ON files(date);

-- Typed edges between chunk ids (dst may also be memory:<event_id>; edges
-- written before the rename carry the old prefix, which is still read).
-- Ingest writes NEXT (chunk i -> i+1, also across _partNN boundaries) with
-- origin='ingest', confirmed=1. Typed edges (CORRECTED_BY, SUPERSEDED_BY,
-- SUPPORTS, ABOUT) carry their own origin and confirmed=0 until reviewed:
-- 0 = proposal, 1 = confirmed (in effect), -1 = rejected (kept, no effect).
-- note = snapshot of the correcting text for edges that point at memory:<id>.
CREATE TABLE IF NOT EXISTS chunk_edges (
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  type       TEXT NOT NULL,
  src_file   TEXT NOT NULL,
  dst_file   TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'ingest',
  confirmed  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  note       TEXT,
  PRIMARY KEY (src, dst, type)
);
CREATE INDEX IF NOT EXISTS edges_by_dst ON chunk_edges(dst, type);
CREATE INDEX IF NOT EXISTS edges_by_src_file ON chunk_edges(src_file);
CREATE INDEX IF NOT EXISTS edges_by_dst_file ON chunk_edges(dst_file);
CREATE INDEX IF NOT EXISTS edges_by_confirmed ON chunk_edges(confirmed, type);
