-- Stripe disputes (docs/STRIPE.md): one row per Stripe dispute, linked to the order(s) of the disputed payment, plus the amount lost per order.
-- workspace_id is NULL only for an orphan whose connected account is unknown too; such a row is invisible to every workspace until it can be reconciled.
CREATE TABLE disputes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_dispute_id TEXT NOT NULL UNIQUE,
  stripe_account TEXT,
  charge_id TEXT,
  payment_intent TEXT,
  order_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'won', 'lost')),
  livemode INTEGER NOT NULL DEFAULT 0,
  evidence_due_by TEXT,
  funds_withdrawn_at TEXT,
  funds_reinstated_at TEXT,
  lost_cents INTEGER NOT NULL DEFAULT 0,
  loss_applied_at TEXT,
  last_event_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX idx_disputes_workspace ON disputes(workspace_id, created_at);
CREATE INDEX idx_disputes_payment_intent ON disputes(payment_intent);
CREATE INDEX idx_disputes_order ON disputes(order_id);

-- Cents of this order that a lost dispute took away (never more than what was left after refunds): excluded from sales analytics, and not refundable.
ALTER TABLE orders ADD COLUMN disputed_lost_cents INTEGER NOT NULL DEFAULT 0;
