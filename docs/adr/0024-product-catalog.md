# 0024: Product catalog with immutable prices and server-side authority

## Context
Prices lived in checkout block props, copied wherever a block was copied, with no product identity for analytics, no Stripe objects, and `price * 100` arithmetic that is wrong for zero- and three-decimal currencies.

## Decision
`products` and `prices` per workspace (migration 021). Amounts are integers in minor units with the currency exponent. Prices are immutable (as in Stripe): changing an amount creates a new price and archives the old one with `replaced_by`; products are archived, never deleted. Checkout blocks link to a price; the page-save pipeline refreshes their display fields from the catalog and the checkout resolves the amount from the catalog again, so neither the page nor the request can choose a price. Existing blocks are linked by a boot backfill and on every save. Stripe objects are mirrored best-effort (idempotency keys, reconciliation by webhook) and never gate selling.

## Alternatives
Keep prices in blocks and sync on demand (no authority, no history); make prices editable (breaks Stripe parity and order history); hard-delete products (orders would lose their link); fail catalog writes when Stripe fails (couples selling to Stripe availability).

## Consequences
A price change reaches every page at once while past orders keep theirs; analytics can group by product and currency; offline installs work. Costs: a catalog lookup per checkout and per save with checkout blocks; renewals of subscriptions are not recorded; the Stripe mirror is verified only against a fake.
