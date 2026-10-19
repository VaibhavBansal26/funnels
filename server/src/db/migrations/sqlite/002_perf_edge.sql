-- Pre-aggregated analytics: 15-minute UTC buckets maintained by a trigger, so any
-- whole-day range in any real time zone (offsets are multiples of 15 minutes) is a sum over buckets.
CREATE TABLE event_rollups (
  workspace_id TEXT NOT NULL,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  bucket TEXT NOT NULL, -- 'YYYY-MM-DDTHH:MM' (UTC, minute multiple of 15)
  page_views INTEGER NOT NULL DEFAULT 0,
  unique_views INTEGER NOT NULL DEFAULT 0,
  optins INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (funnel_id, bucket, step_id)
) WITHOUT ROWID;

CREATE TRIGGER events_rollup_ai AFTER INSERT ON events
BEGIN
  INSERT INTO event_rollups (workspace_id, funnel_id, step_id, bucket, page_views, unique_views, optins, orders, cents)
  VALUES (
    NEW.workspace_id, NEW.funnel_id, NEW.step_id,
    substr(NEW.created_at, 1, 14) || printf('%02d', (CAST(substr(NEW.created_at, 15, 2) AS INTEGER) / 15) * 15),
    NEW.type = 'page_view', NEW.type = 'page_view' AND NEW.unique_visit = 1, NEW.type = 'optin', NEW.type = 'order',
    CASE WHEN NEW.type = 'order' THEN NEW.amount_cents ELSE 0 END
  )
  ON CONFLICT (funnel_id, bucket, step_id) DO UPDATE SET
    page_views = page_views + excluded.page_views,
    unique_views = unique_views + excluded.unique_views,
    optins = optins + excluded.optins,
    orders = orders + excluded.orders,
    cents = cents + excluded.cents;
END;

INSERT INTO event_rollups (workspace_id, funnel_id, step_id, bucket, page_views, unique_views, optins, orders, cents)
SELECT workspace_id, funnel_id, step_id,
       substr(created_at, 1, 14) || printf('%02d', (CAST(substr(created_at, 15, 2) AS INTEGER) / 15) * 15) AS b,
       SUM(type = 'page_view'), SUM(type = 'page_view' AND unique_visit = 1), SUM(type = 'optin'), SUM(type = 'order'),
       SUM(CASE WHEN type = 'order' THEN amount_cents ELSE 0 END)
FROM events GROUP BY funnel_id, step_id, b;

CREATE INDEX idx_leads_workspace_created ON leads(workspace_id, created_at);
ALTER TABLE domains ADD COLUMN provider TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE domains ADD COLUMN provider_ref TEXT;
ALTER TABLE domains ADD COLUMN provider_records TEXT;
