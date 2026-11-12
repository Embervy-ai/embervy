-- memory worker v0.2 — Archive R2 + Recency-Tracking + Chunking
-- migration: archive to R2 + recency + chunking
--
-- Phase 1: add R2-path index fields to events_archive
-- Phase 2: add touch + engage tracking fields to events_hot
-- Migration step: set every existing hot event to the medium class
--   (last_engaged_at = COALESCE(resolved_at, ts))
--
-- Note: SQLite ALTER TABLE ADD COLUMN is safe and non-blocking.

-- events_archive: R2-path index fields
ALTER TABLE events_archive ADD COLUMN r2_path TEXT;
ALTER TABLE events_archive ADD COLUMN summary TEXT;

-- events_hot: touch / engage tracking fields
ALTER TABLE events_hot ADD COLUMN last_searched_at TEXT;
ALTER TABLE events_hot ADD COLUMN last_engaged_at  TEXT;

-- One-off normalization: lift all existing hot events to the medium decay class.
-- Medium = only one of the two tracking fields set. We set last_engaged_at, not last_searched_at.
UPDATE events_hot
SET last_engaged_at = COALESCE(resolved_at, ts)
WHERE last_engaged_at IS NULL;
