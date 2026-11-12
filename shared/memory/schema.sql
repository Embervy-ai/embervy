-- Embervy memory worker — D1 schema
-- See your repo's docs (blocks 1 + 4) for the spec
-- Apply via: wrangler d1 execute embervy-memory --remote --file=schema.sql

-- ===========================================================================
-- events_hot — all active events (observation, relation, journal, todo, surface, image, entity_card)
-- Stream-centric: one row per event, discriminated by `kind`
-- ===========================================================================

CREATE TABLE IF NOT EXISTS events_hot (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                  TEXT    NOT NULL DEFAULT (datetime('now')),
  kind                TEXT    NOT NULL,
  content             TEXT    NOT NULL,
  entity_name         TEXT,
  entity_type         TEXT,
  emotion             TEXT,
  weight              TEXT    DEFAULT 'medium',
  source              TEXT    DEFAULT 'conversation',
  certainty           TEXT    DEFAULT 'believed',
  tags                TEXT,                        -- JSON array
  embedded            INTEGER DEFAULT 1,
  decay_weight        REAL    DEFAULT 1.0,
  access_boost_until  TEXT,
  last_accessed_at    TEXT,
  resolved_at         TEXT,
  resolution_note     TEXT,
  mood_at_write       TEXT,
  migration_origin    TEXT,                        -- NULL for native rows, label for migrated rows
  migrated_at         TEXT,
  meta                TEXT,                        -- JSON
  last_searched_at    TEXT,                        -- Touch via find/scan/collide/recall with score >= 0.5
  last_engaged_at     TEXT,                        -- Engage via engage tool or resolve with note > 20 chars
  access_count        REAL    DEFAULT 0,           -- Salience input: +1 per touch (find/recall/engage/see), damped nightly ×0.97
  salience            REAL    DEFAULT 0,           -- Computed nightly: weight × (1+0.3×emotion) × certainty × recency × (1+ln(1+access)) × (1+2·ln(1+used))
  used_count          REAL    DEFAULT 0,           -- +1 per "used" verdict of a context-injection membrane (POST /touch source=membrane-used), damped nightly ×0.99 — NOT the same counter as access
  last_used_at        TEXT,                        -- last "used" verdict
  injected_count      REAL    DEFAULT 0,           -- +1 per injection (POST /touch source=membrane-injected); pure counter, no ranking effect
  last_injected_at    TEXT,                        -- last injection
  distracting_count   REAL    DEFAULT 0            -- +1 per "distracting" verdict (POST /touch source=membrane-distracting); pure counter
);

CREATE INDEX IF NOT EXISTS idx_events_hot_kind     ON events_hot(kind);
CREATE INDEX IF NOT EXISTS idx_events_hot_entity   ON events_hot(entity_name);
CREATE INDEX IF NOT EXISTS idx_events_hot_ts       ON events_hot(ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_hot_decay    ON events_hot(decay_weight);
CREATE INDEX IF NOT EXISTS idx_events_hot_unresolved ON events_hot(resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_hot_kind_unresolved ON events_hot(kind, resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_events_hot_migration ON events_hot(migration_origin);

-- ===========================================================================
-- events_archive — passive full-text archive for decayed observations
-- No Vectorize entry, accessible only via filter
-- ===========================================================================

CREATE TABLE IF NOT EXISTS events_archive (
  id                  INTEGER PRIMARY KEY,
  ts                  TEXT    NOT NULL,
  kind                TEXT    NOT NULL,
  content             TEXT,                          -- DEPRECATED, full text moves to R2 (r2_path)
  entity_name         TEXT,
  entity_type         TEXT,
  emotion             TEXT,
  weight              TEXT,
  source              TEXT,
  certainty           TEXT,
  tags                TEXT,
  resolved_at         TEXT,
  resolution_note     TEXT,
  mood_at_write       TEXT,
  meta                TEXT,
  archived_at         TEXT    DEFAULT (datetime('now')),
  archive_reason      TEXT,
  r2_path             TEXT,                          -- 'archive/<id>.json' inside the archive R2 bucket (embervy-archive)
  summary             TEXT                           -- first 200 chars of content for quick preview
);

CREATE INDEX IF NOT EXISTS idx_events_archive_entity ON events_archive(entity_name);
CREATE INDEX IF NOT EXISTS idx_events_archive_kind   ON events_archive(kind);
CREATE INDEX IF NOT EXISTS idx_events_archive_ts     ON events_archive(ts DESC);

-- ===========================================================================
-- relations — directed relationships between entities
-- ===========================================================================

CREATE TABLE IF NOT EXISTS relations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  from_entity     TEXT    NOT NULL,
  to_entity       TEXT    NOT NULL,
  relation_type   TEXT    NOT NULL,
  context         TEXT,
  certainty       TEXT    DEFAULT 'believed',
  source_event_id INTEGER,
  created_at      TEXT    DEFAULT (datetime('now')),
  UNIQUE(from_entity, to_entity, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_entity);
CREATE INDEX IF NOT EXISTS idx_relations_to   ON relations(to_entity);

-- ===========================================================================
-- entity_cards — base record per entity
-- ===========================================================================

CREATE TABLE IF NOT EXISTS entity_cards (
  name            TEXT    PRIMARY KEY,
  entity_type     TEXT    NOT NULL,
  primary_context TEXT,
  description     TEXT,
  created_at      TEXT    DEFAULT (datetime('now')),
  updated_at      TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_cards_type ON entity_cards(entity_type);

-- ===========================================================================
-- dream_notes — meta-cognition dreams, separate lifecycle
-- ===========================================================================

CREATE TABLE IF NOT EXISTS dream_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  content     TEXT    NOT NULL,
  weight      TEXT    DEFAULT 'medium',
  read_at     TEXT,
  source_model TEXT   DEFAULT 'mistral-medium'
);

CREATE INDEX IF NOT EXISTS idx_dream_unread ON dream_notes(read_at) WHERE read_at IS NULL;

-- ===========================================================================
-- images_data — base64 image storage
-- ===========================================================================

CREATE TABLE IF NOT EXISTS images_data (
  path        TEXT    PRIMARY KEY,
  data        TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  event_id    INTEGER,
  created_at  TEXT    DEFAULT (datetime('now'))
);

-- ===========================================================================
-- mood_state — singleton, updated nightly by the daemon
-- ===========================================================================

CREATE TABLE IF NOT EXISTS mood_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  mood_label        TEXT,
  mood_summary      TEXT,                    -- JSON array
  hot_entities      TEXT,                    -- JSON array
  active_surfaces   TEXT,                    -- JSON array
  -- Pending fields for 2-night smoothing (Patch 3): daemon proposes, must match
  -- next night before becoming canonical mood.
  pending_label     TEXT,
  pending_summary   TEXT,
  pending_entities  TEXT,
  pending_at        TEXT,
  updated_at        TEXT    DEFAULT (datetime('now')),
  source            TEXT    DEFAULT 'daemon'
);

INSERT OR IGNORE INTO mood_state (id, mood_label, mood_summary, hot_entities, active_surfaces, source)
VALUES (1, 'initial', '["memory bootstrapped"]', '[]', '[]', 'init');

-- ===========================================================================
-- daemon_config — singleton, daemon mode + backlog cursor
-- ===========================================================================

CREATE TABLE IF NOT EXISTS daemon_config (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  mode            TEXT    DEFAULT 'normal',  -- 'backlog' | 'normal'
  backlog_cursor  INTEGER DEFAULT 0,
  set_at          TEXT    DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO daemon_config (id, mode, backlog_cursor) VALUES (1, 'normal', 0);

-- ===========================================================================
-- daemon_runs — audit log of daemon runs (for health/debugging)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS daemon_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  mode            TEXT,
  events_seen     INTEGER,
  surfaces_proposed INTEGER,
  consolidations_proposed INTEGER,
  decay_modifiers_proposed INTEGER,
  ok              INTEGER DEFAULT 0,    -- 0=running, 1=ok, 2=schema_invalid, 3=error
  error_message   TEXT,
  raw_response    TEXT
);

CREATE INDEX IF NOT EXISTS idx_daemon_runs_started ON daemon_runs(started_at DESC);

-- ===========================================================================
-- consolidation_proposals — pending consolidations awaiting 2-night confirmation
-- (Patch 2: only applied if proposed in two consecutive runs)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS consolidation_proposals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  duplicate_ids   TEXT    NOT NULL,    -- JSON array, sorted ascending
  keep_id         INTEGER NOT NULL,
  reason          TEXT,
  proposed_at     TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_consolidation_proposals_at ON consolidation_proposals(proposed_at);

-- ===========================================================================
-- event_edges — causal edges between events (graph layer)
-- Always tentative first; only confirmed edges are traversed by `trace`.
-- rejected stays on record so the same wrong edge is not proposed again.
-- (Also created lazily by the worker via CREATE TABLE IF NOT EXISTS.)
-- ===========================================================================

CREATE TABLE IF NOT EXISTS event_edges (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_event   INTEGER NOT NULL,
  to_event     INTEGER NOT NULL,
  relation     TEXT    NOT NULL,                   -- led_to | caused_by | emotional_consequence_of
  strength     REAL    DEFAULT 0.5,
  status       TEXT    NOT NULL DEFAULT 'tentative', -- tentative | confirmed | rejected
  proposed_by  TEXT    NOT NULL,                   -- agent | daemon
  reason       TEXT,
  created_at   TEXT    DEFAULT (datetime('now')),
  confirmed_at TEXT,
  UNIQUE(from_event, to_event, relation)
);

CREATE INDEX IF NOT EXISTS idx_event_edges_status ON event_edges(status);
CREATE INDEX IF NOT EXISTS idx_event_edges_from   ON event_edges(from_event);
CREATE INDEX IF NOT EXISTS idx_event_edges_to     ON event_edges(to_event);
