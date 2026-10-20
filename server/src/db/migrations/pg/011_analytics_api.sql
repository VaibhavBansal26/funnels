-- Analytics API v1 (docs/ANALYTICS-API.md, ADR 0019): workspace API keys, the per-workspace identity pepper, and the event attributes the export contract names.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  ip_allowlist_json TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_api_keys_workspace ON api_keys(workspace_id, created_at);

-- Secret used to HMAC emails and visitor ids in exports, so the Python side (or a sibling app) can compute the same keys and join without ever receiving PII.
ALTER TABLE workspaces ADD COLUMN identity_pepper TEXT;
ALTER TABLE workspaces ADD COLUMN identity_pepper_rotated_at TEXT;

-- What the export contract needs and the beacon can know: device class, country (only from a verified Cloudflare header) and the referrer's host (host only, never the full URL).
ALTER TABLE events ADD COLUMN device TEXT;
ALTER TABLE events ADD COLUMN country TEXT;
ALTER TABLE events ADD COLUMN referrer_host TEXT;
-- Workspace-wide exports page by (created_at, id); per-funnel reads already have idx_events_funnel_time.
CREATE INDEX idx_events_workspace_time ON events(workspace_id, created_at, id);

-- One row per workspace and UTC day once `analytics.daily_rollup_ready` was announced, so the push happens once however many replicas run maintenance.
CREATE TABLE analytics_daily_ready (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, day)
);
-- Lead lookups by the exports (orders per lead).
CREATE INDEX idx_orders_lead ON orders(lead_id);
