-- Rollups are maintained by the application in the same transaction as the event insert (services/rollups.ts),
-- aggregated once per batch instead of once per row. visitor_days is removed: it saved ~30 ms on a 1M-event
-- distinct count and cost write throughput (docs/PERFORMANCE.md).
DROP TRIGGER IF EXISTS events_rollup_ai;
DROP TRIGGER IF EXISTS events_visitor_day_ai;
DROP TABLE IF EXISTS visitor_days;
