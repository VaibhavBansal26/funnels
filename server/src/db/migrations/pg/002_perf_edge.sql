-- Pre-aggregated analytics: 15-minute UTC buckets, maintained by the application inside the write transaction
-- (services/rollups.ts), so any whole-day range in any real time zone is a sum over buckets.
CREATE TABLE event_rollups (
  workspace_id TEXT NOT NULL,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  bucket TEXT NOT NULL, -- 'YYYY-MM-DDTHH:MM' (UTC, minute multiple of 15)
  page_views INTEGER NOT NULL DEFAULT 0,
  unique_views INTEGER NOT NULL DEFAULT 0,
  optins INTEGER NOT NULL DEFAULT 0,
  orders INTEGER NOT NULL DEFAULT 0,
  cents BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (funnel_id, bucket, step_id)
);

CREATE INDEX idx_leads_workspace_created ON leads(workspace_id, created_at);
ALTER TABLE domains ADD COLUMN provider TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE domains ADD COLUMN provider_ref TEXT;
ALTER TABLE domains ADD COLUMN provider_records TEXT;
