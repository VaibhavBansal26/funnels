-- Images uploaded in the page builder (asset manager). Stored as base64 text so every engine and driver handles them the same way;
-- small raster images only (see services/assets.ts for the limits). Served publicly at /uploads/:id/:name.
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data_b64 TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_assets_workspace ON assets(workspace_id, created_at);
