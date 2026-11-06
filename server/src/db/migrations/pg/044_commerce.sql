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

-- `events.type` gains add_to_cart and begin_checkout. The check was created on the partitioned parent (named after its first name, events_partitioned): drop
-- whichever check constrains `type` and add the wider one (it propagates to every partition).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint WHERE conrelid = 'events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%type%' LOOP
    EXECUTE format('ALTER TABLE events DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE events ADD CONSTRAINT events_type_check CHECK (type IN ('page_view', 'optin', 'order', 'add_to_cart', 'begin_checkout'));
