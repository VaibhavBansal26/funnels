-- Ad spend by day (manual entry and CSV import) and the mapping from an ad platform campaign name to the UTM values that identify its traffic.
-- Money is integer minor units (cents) with its own currency per row; rows of different currencies are never added together.
CREATE TABLE IF NOT EXISTS ad_spend (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL,
  currency TEXT NOT NULL,
  spend_cents INTEGER NOT NULL CHECK (spend_cents >= 0),
  impressions INTEGER,
  clicks INTEGER,
  funnel_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, day, source, account, campaign, currency)
);
CREATE INDEX IF NOT EXISTS idx_ad_spend_ws_day ON ad_spend(workspace_id, day);

CREATE TABLE IF NOT EXISTS ad_campaign_map (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  campaign TEXT NOT NULL,
  utm_source TEXT,
  utm_campaign TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, source, campaign)
);
