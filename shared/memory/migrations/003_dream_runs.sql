-- Optional: the dream worker also creates this table and index automatically.
-- Additive and safe to apply again on existing houses. No notes are changed.
-- The dream and memory workers must share this D1 database.
CREATE TABLE IF NOT EXISTS dream_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  result        TEXT NOT NULL CHECK (result IN ('ok', 'failed', 'empty')),
  error_code    TEXT CHECK (error_code IN ('provider_http', 'provider_unreachable', 'provider_response', 'write_failed', 'unexpected')),
  error_status  INTEGER CHECK (error_status BETWEEN 100 AND 599),
  CHECK ((result = 'failed' AND error_code IS NOT NULL) OR
         (result IN ('ok', 'empty') AND error_code IS NULL AND error_status IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_dream_runs_started ON dream_runs(started_at DESC, id DESC);
