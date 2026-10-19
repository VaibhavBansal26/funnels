-- One row per (funnel, UTC day, visitor) so funnel-level distinct visitors never scan raw events for whole days.
CREATE TABLE visitor_days (
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  PRIMARY KEY (funnel_id, day, visitor_id)
) WITHOUT ROWID;

CREATE TRIGGER events_visitor_day_ai AFTER INSERT ON events WHEN NEW.type = 'page_view' AND NEW.visitor_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO visitor_days (funnel_id, day, visitor_id) VALUES (NEW.funnel_id, substr(NEW.created_at, 1, 10), NEW.visitor_id);
END;

INSERT OR IGNORE INTO visitor_days (funnel_id, day, visitor_id)
SELECT funnel_id, substr(created_at, 1, 10), visitor_id FROM events WHERE type = 'page_view' AND visitor_id IS NOT NULL;
