-- Ads: integrations (Meta / Google / TikTok conversion APIs), their delivery log, pixel and consent settings, and attribution.
-- Additive only: new tables, and nullable columns on leads and orders. Secrets (access tokens, API secrets) are stored encrypted (`enc2.` values, auth/dataCrypto.ts).
CREATE TABLE IF NOT EXISTS ad_integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('meta', 'ga4', 'tiktok')),
  name TEXT NOT NULL,
  pixel_id TEXT NOT NULL,
  secret_enc TEXT,
  secret_hint TEXT,
  test_event_code TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  send_lead INTEGER NOT NULL DEFAULT 1,
  send_purchase INTEGER NOT NULL DEFAULT 1,
  last_status TEXT,
  last_error TEXT,
  last_delivery_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider, pixel_id)
);
CREATE INDEX IF NOT EXISTS idx_ad_integrations_workspace ON ad_integrations(workspace_id);

CREATE TABLE IF NOT EXISTS conversion_deliveries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  integration_id TEXT NOT NULL REFERENCES ad_integrations(id) ON DELETE CASCADE,
  funnel_id TEXT,
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'dead', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  http_status INTEGER,
  error TEXT,
  payload_json TEXT NOT NULL,
  response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (integration_id, event_name, event_id)
);
CREATE INDEX IF NOT EXISTS idx_conversion_deliveries_ws ON conversion_deliveries(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversion_deliveries_integration ON conversion_deliveries(integration_id, created_at);

-- Pixel / tag / consent settings by scope: one row per workspace default, funnel or step (a step overrides its funnel, which overrides the workspace).
CREATE TABLE IF NOT EXISTS ad_pixel_configs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('workspace', 'funnel', 'step')),
  scope_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, scope, scope_id)
);

-- First touch and last touch per visitor, plus the browser identifiers server-side conversions need (fbp, fbc, IP, user agent; the last two expire, see ATTRIBUTION_RETENTION_DAYS).
CREATE TABLE IF NOT EXISTS visitor_attribution (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  visitor_id TEXT NOT NULL,
  first_source TEXT, first_medium TEXT, first_campaign TEXT, first_content TEXT, first_term TEXT, first_funnel_id TEXT, first_at TEXT, first_json TEXT,
  last_source TEXT, last_medium TEXT, last_campaign TEXT, last_content TEXT, last_term TEXT, last_funnel_id TEXT, last_at TEXT, last_json TEXT,
  fbp TEXT,
  fbc TEXT,
  ip TEXT,
  user_agent TEXT,
  ids_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, visitor_id)
);
CREATE INDEX IF NOT EXISTS idx_visitor_attr_first ON visitor_attribution(workspace_id, first_at);
CREATE INDEX IF NOT EXISTS idx_visitor_attr_last ON visitor_attribution(workspace_id, last_at);

ALTER TABLE leads ADD COLUMN first_source TEXT;
ALTER TABLE leads ADD COLUMN first_medium TEXT;
ALTER TABLE leads ADD COLUMN first_campaign TEXT;
ALTER TABLE leads ADD COLUMN first_content TEXT;
ALTER TABLE leads ADD COLUMN first_term TEXT;
ALTER TABLE leads ADD COLUMN last_source TEXT;
ALTER TABLE leads ADD COLUMN last_medium TEXT;
ALTER TABLE leads ADD COLUMN last_campaign TEXT;
ALTER TABLE leads ADD COLUMN last_content TEXT;
ALTER TABLE leads ADD COLUMN last_term TEXT;
ALTER TABLE leads ADD COLUMN attribution_json TEXT;
ALTER TABLE orders ADD COLUMN first_source TEXT;
ALTER TABLE orders ADD COLUMN first_medium TEXT;
ALTER TABLE orders ADD COLUMN first_campaign TEXT;
ALTER TABLE orders ADD COLUMN first_content TEXT;
ALTER TABLE orders ADD COLUMN first_term TEXT;
ALTER TABLE orders ADD COLUMN last_source TEXT;
ALTER TABLE orders ADD COLUMN last_medium TEXT;
ALTER TABLE orders ADD COLUMN last_campaign TEXT;
ALTER TABLE orders ADD COLUMN last_content TEXT;
ALTER TABLE orders ADD COLUMN last_term TEXT;
ALTER TABLE orders ADD COLUMN attribution_json TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_attr_first ON orders(workspace_id, first_campaign);
CREATE INDEX IF NOT EXISTS idx_orders_attr_last ON orders(workspace_id, last_campaign);
