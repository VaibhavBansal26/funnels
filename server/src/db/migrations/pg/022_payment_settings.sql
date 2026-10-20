-- Payments setup per workspace (docs/STRIPE.md): what the funnel checkout asks Stripe for on the connected account.
CREATE TABLE payment_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Appended to the account's statement descriptor on card statements (Stripe: the suffix of a prefix the account already has; at most 22 characters, letters and digits).
  statement_descriptor TEXT,
  -- Ask Stripe to email a receipt for each payment (needs "email customers for successful payments" enabled in the Stripe dashboard).
  receipt_emails INTEGER NOT NULL DEFAULT 1,
  -- Calculate tax with Stripe Tax at checkout (needs Stripe Tax set up on the connected account).
  tax_enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
