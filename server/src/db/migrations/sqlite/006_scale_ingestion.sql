-- Scale-friendly ingestion (docs/SCALING.md, ADR 0013).
-- 1. event_dedupe: opt-in / order idempotency keys live in a small table instead of a unique index on events, so `events` can be
--    partitioned by time on PostgreSQL (a unique index there would have to include the partition key and stop deduplicating across months).
--    Rows older than EVENT_DEDUPE_DAYS are deleted by the maintenance job.
-- 2. visitor_steps: one row per (funnel, step, visitor) decides "first view" atomically with INSERT ... ON CONFLICT DO NOTHING RETURNING, which
--    replaces the lookup on events (and its index), so uniqueness no longer depends on one process's memory and costs the same at any table size.
CREATE TABLE event_dedupe (
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (funnel_id, type, external_id)
) WITHOUT ROWID;
CREATE INDEX idx_event_dedupe_created ON event_dedupe(created_at);
INSERT INTO event_dedupe (funnel_id, type, external_id, created_at) SELECT funnel_id, type, external_id, created_at FROM events WHERE external_id IS NOT NULL;
DROP INDEX idx_events_dedupe;

CREATE TABLE visitor_steps (
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (funnel_id, step_id, visitor_id)
) WITHOUT ROWID;
INSERT OR IGNORE INTO visitor_steps (funnel_id, step_id, visitor_id, first_seen)
  SELECT funnel_id, step_id, visitor_id, MIN(created_at) FROM events WHERE type = 'page_view' AND visitor_id IS NOT NULL GROUP BY funnel_id, step_id, visitor_id;
DROP INDEX idx_events_visitor;
