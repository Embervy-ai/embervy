-- Correction to 001: last_engaged_at was previously seeded from old ts /
-- resolved_at values, which caused events without resolved_at older than 28d
-- to drop into stagnant-archive immediately on the next decay run.
--
-- Variant-2 logic (counter is updated on every touch/engage) means: for the
-- one-off migration we set the counter to NOW so every event gets a fresh
-- 28-day grace period from today.

UPDATE events_hot SET last_engaged_at = datetime('now')
WHERE last_engaged_at IS NOT NULL;
