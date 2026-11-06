-- Server-side carts (one per visitor and funnel, no personal data) and embedded payments (a PaymentIntent per attempt). docs/PRODUCTS.md#cart, docs/STRIPE.md#embedded-payment-form.
CREATE TABLE carts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  visitor_id TEXT,
  currency TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'checked_out')),
  bumps_json TEXT NOT NULL DEFAULT '[]',
  preview INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  checked_out_at TEXT
);
CREATE INDEX idx_carts_visitor ON carts(funnel_id, visitor_id, status);
CREATE INDEX idx_carts_expiry ON carts(expires_at);

CREATE TABLE cart_items (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  added_step_id TEXT,
  added_block_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (cart_id, price_id)
);

-- Client operation ids already applied to a cart: a retried or double-clicked add/update changes the cart once.
CREATE TABLE cart_ops (
  cart_id TEXT NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  op_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (cart_id, op_id)
);

-- One embedded (Payment form) purchase attempt: the quote the server computed (lines from the catalog), the PaymentIntent on the connected account and the buyer.
CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  cart_id TEXT,
  cart_version INTEGER,
  provider TEXT NOT NULL,
  stripe_account TEXT,
  stripe_intent_id TEXT UNIQUE,
  stripe_customer TEXT,
  items_json TEXT NOT NULL,
  bumps_json TEXT NOT NULL DEFAULT '[]',
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  fee INTEGER NOT NULL DEFAULT 0,
  email TEXT,
  name TEXT,
  address_json TEXT,
  visitor_id TEXT,
  utms_json TEXT,
  next_url TEXT,
  cancel_url TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  last_error TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_payment_attempts_workspace ON payment_attempts(workspace_id, created_at);
CREATE INDEX idx_payment_attempts_cart ON payment_attempts(cart_id);

ALTER TABLE checkout_sessions ADD COLUMN cart_id TEXT;

-- Cart funnel events: how many visitors added to a cart and started a checkout, per 15-minute bucket like the other counters.
ALTER TABLE event_rollups ADD COLUMN cart_adds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_rollups ADD COLUMN checkouts INTEGER NOT NULL DEFAULT 0;

-- `events.type` gains add_to_cart and begin_checkout. SQLite cannot change a CHECK constraint in place: the table is rebuilt with the same columns and indexes.
CREATE TABLE events_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL REFERENCES funnels(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('page_view', 'optin', 'order', 'add_to_cart', 'begin_checkout')),
  visitor_id TEXT,
  unique_visit INTEGER NOT NULL DEFAULT 0,
  lead_id TEXT,
  order_id TEXT,
  external_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT,
  utm_json TEXT,
  url TEXT,
  created_at TEXT NOT NULL,
  device TEXT,
  country TEXT,
  referrer_host TEXT
);
INSERT INTO events_new (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, lead_id, order_id, external_id, amount_cents, currency, utm_json, url, created_at, device, country, referrer_host)
  SELECT id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, lead_id, order_id, external_id, amount_cents, currency, utm_json, url, created_at, device, country, referrer_host FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX idx_events_funnel_time ON events(funnel_id, created_at);
CREATE INDEX idx_events_step_type ON events(funnel_id, step_id, type);
CREATE INDEX idx_events_lead ON events(lead_id);
CREATE INDEX idx_events_workspace_time ON events(workspace_id, created_at, id);
