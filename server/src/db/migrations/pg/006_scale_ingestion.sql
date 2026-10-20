-- Scale-friendly ingestion (docs/SCALING.md, ADR 0013). Same tables as migrations/sqlite/006; additionally `events` becomes a table
-- partitioned by month on created_at (ISO text, "C" collation so partition bounds compare byte-wise). Bounds are full instants
-- ('2026-03-01T00:00:00.000Z'), so a query for [month start, next month start) prunes to exactly one partition.
CREATE TABLE event_dedupe (
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (funnel_id, type, external_id)
);
CREATE INDEX idx_event_dedupe_created ON event_dedupe(created_at);
INSERT INTO event_dedupe (funnel_id, type, external_id, created_at) SELECT funnel_id, type, external_id, created_at FROM events WHERE external_id IS NOT NULL ON CONFLICT DO NOTHING;

CREATE TABLE visitor_steps (
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  PRIMARY KEY (funnel_id, step_id, visitor_id)
);
INSERT INTO visitor_steps (funnel_id, step_id, visitor_id, first_seen)
  SELECT funnel_id, step_id, visitor_id, MIN(created_at) FROM events WHERE type = 'page_view' AND visitor_id IS NOT NULL GROUP BY funnel_id, step_id, visitor_id ON CONFLICT DO NOTHING;

CREATE TABLE events_partitioned (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('page_view', 'optin', 'order')),
  visitor_id TEXT,
  unique_visit INTEGER NOT NULL DEFAULT 0,
  lead_id TEXT,
  order_id TEXT,
  external_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  utm_json TEXT,
  url TEXT,
  created_at TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

CREATE TABLE events_default PARTITION OF events_partitioned DEFAULT;

-- One partition per month that already has data, plus the current month and the next two (the maintenance job keeps creating them ahead of time).
DO $$
DECLARE m date;
DECLARE last_m date;
BEGIN
  SELECT COALESCE(date_trunc('month', MIN(created_at::timestamptz)), date_trunc('month', now()))::date INTO m FROM events;
  last_m := (date_trunc('month', GREATEST(COALESCE((SELECT MAX(created_at::timestamptz) FROM events), now()), now())) + interval '2 months')::date;
  WHILE m <= last_m LOOP
    EXECUTE format('CREATE TABLE %I PARTITION OF events_partitioned FOR VALUES FROM (%L) TO (%L)', 'events_' || to_char(m, 'YYYY_MM'), to_char(m, 'YYYY-MM-DD"T"00:00:00.000"Z"'), to_char(m + interval '1 month', 'YYYY-MM-DD"T"00:00:00.000"Z"'));
    m := (m + interval '1 month')::date;
  END LOOP;
END $$;

INSERT INTO events_partitioned SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_partitioned RENAME TO events;

-- Indexes are declared on the parent and created on every partition (local indexes). The old visitor and dedupe indexes are gone on purpose.
CREATE INDEX idx_events_funnel_time ON events(funnel_id, created_at);
CREATE INDEX idx_events_step_type ON events(funnel_id, step_id, type);
CREATE INDEX idx_events_lead ON events(lead_id);
