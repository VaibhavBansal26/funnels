-- Product catalog (docs/PRODUCTS.md, ADR 0024): products and immutable prices per workspace, optionally mirrored to the connected Stripe account.
CREATE TABLE products (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  images_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  type TEXT NOT NULL DEFAULT 'one_time' CHECK (type IN ('one_time', 'subscription')),
  tax_code TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  default_price_id TEXT,
  -- Stripe mirror: local (never pushed), pending (changed since the last push), synced, error.
  stripe_product_id TEXT,
  stripe_account_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'local',
  sync_error TEXT,
  synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_products_workspace ON products(workspace_id, status, created_at);
CREATE UNIQUE INDEX idx_products_stripe ON products(stripe_account_id, stripe_product_id) WHERE stripe_product_id IS NOT NULL;

-- A price never changes its amount: a new amount is a new row and the old one is archived with `replaced_by` pointing at it, so pages that still name the old price
-- follow the chain to the current one while orders keep the price they were bought at.
CREATE TABLE prices (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  currency TEXT NOT NULL,
  unit_amount INTEGER NOT NULL,
  billing_interval TEXT,
  billing_interval_count INTEGER NOT NULL DEFAULT 1,
  trial_days INTEGER NOT NULL DEFAULT 0,
  nickname TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  replaced_by TEXT,
  stripe_price_id TEXT,
  stripe_account_id TEXT,
  sync_status TEXT NOT NULL DEFAULT 'local',
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_prices_product ON prices(workspace_id, product_id, created_at);
CREATE UNIQUE INDEX idx_prices_stripe ON prices(stripe_account_id, stripe_price_id) WHERE stripe_price_id IS NOT NULL;

ALTER TABLE orders ADD COLUMN product_id TEXT;
ALTER TABLE orders ADD COLUMN price_id TEXT;
ALTER TABLE orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
-- amount_cents is what was paid for the line (after discount); discount_cents is what a promotion code took off it.
ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
-- main, bump, upsell or downsell
ALTER TABLE orders ADD COLUMN role TEXT;
CREATE INDEX idx_orders_product ON orders(workspace_id, product_id, created_at);

-- Workspaces whose pages were scanned once for checkout blocks without a catalog product (they get one automatically).
CREATE TABLE catalog_backfill (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  done_at TEXT NOT NULL
);
