-- Google reviews: the workspace's own Places API key (encrypted, masked), the blocks that show reviews (public token -> workspace/page/block) and a short-lived cache of review content.
CREATE TABLE IF NOT EXISTS google_reviews_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  key_enc TEXT,
  key_hint TEXT,
  default_place_id TEXT,
  default_place_name TEXT,
  status TEXT NOT NULL DEFAULT 'unset',
  last_error TEXT,
  last_ok_at TEXT,
  circuit_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_blocks (
  token TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  place_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_blocks_block ON review_blocks(step_id, block_id);
CREATE INDEX IF NOT EXISTS idx_review_blocks_ws ON review_blocks(workspace_id);

CREATE TABLE IF NOT EXISTS google_places_cache (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  place_id TEXT NOT NULL,
  payload_json TEXT,
  fetched_at TEXT,
  expires_at TEXT,
  fail_count INTEGER NOT NULL DEFAULT 0,
  circuit_until TEXT,
  last_error TEXT,
  PRIMARY KEY (workspace_id, place_id)
);
CREATE INDEX IF NOT EXISTS idx_places_cache_expiry ON google_places_cache(expires_at);
