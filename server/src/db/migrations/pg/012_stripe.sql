-- Stripe (docs/STRIPE.md, ADR 0020): Connect accounts, webhook idempotency, hosted-checkout sessions, order status and refunds, platform subscriptions.
CREATE TABLE stripe_accounts (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_account_id TEXT NOT NULL UNIQUE,
  charges_enabled INTEGER NOT NULL DEFAULT 0,
  payouts_enabled INTEGER NOT NULL DEFAULT 0,
  details_submitted INTEGER NOT NULL DEFAULT 0,
  requirements_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every Stripe event id seen: a redelivery (Stripe retries for days) is acknowledged and ignored.
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  error TEXT
);

-- What a visitor was about to buy when sent to Stripe Checkout: the server keeps the items (prices come from the page, never the visitor) and finishes the orders from it.
CREATE TABLE checkout_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  funnel_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  stripe_session_id TEXT UNIQUE,
  items_json TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  visitor_id TEXT,
  utms_json TEXT,
  next_url TEXT NOT NULL,
  cancel_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_checkout_sessions_workspace ON checkout_sessions(workspace_id, created_at);

ALTER TABLE orders ADD COLUMN status TEXT NOT NULL DEFAULT 'paid';
ALTER TABLE orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN provider_customer TEXT;
ALTER TABLE orders ADD COLUMN provider_account TEXT;

CREATE TABLE refunds (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT UNIQUE,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_refunds_order ON refunds(order_id);

ALTER TABLE workspaces ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE workspaces ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE workspaces ADD COLUMN plan_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE workspaces ADD COLUMN plan_period_end TEXT;
