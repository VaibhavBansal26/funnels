# Stripe: Connect checkout, refunds, disputes, platform billing and plan limits

> **Status mapping (checked against https://docs.stripe.com/api/disputes/object on 2026-10-21).** `lost` deducts the amount. `won`, `warning_closed` and `prevented` close the dispute with nothing deducted and the order returns to its previous state. Every other status (`needs_response`, `under_review`, `warning_needs_response`, `warning_under_review`) is open.


Status: implemented and tested against an in-process fake of the Stripe API (`server/test/support/fakestripe.ts`); field names and response shapes were checked against Stripe's API reference and sandbox responses. **No real payment, refund, dispute or webhook delivery has been run against Stripe** ([VERIFIED.md](VERIFIED.md)). Before enabling in production, run the test-mode checklist at the end of this page.

## Two separate money flows

| Flow | Whose money | Stripe account | Webhook endpoint | Secret |
|---|---|---|---|---|
| Checkout of a funnel's product | the workspace owner's customers pay the workspace owner | the owner's **connected Standard account** (direct charges, `Stripe-Account` header) | `POST /api/stripe/connect-webhook` | `STRIPE_CONNECT_WEBHOOK_SECRET` |
| Funnels subscription (Pro, Business) | the workspace pays the platform | the platform account | `POST /api/stripe/webhook` | `STRIPE_WEBHOOK_SECRET` |

Each endpoint verifies its own signing secret, so an event meant for one cannot be replayed at the other. Funnels keeps an **application fee** from each connected checkout, by plan: Free 5%, Pro 2%, Business 0 (`server/src/billing/plans.ts`).

Enabling: `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, and the two webhook secrets (see [CONFIGURATION.md](CONFIGURATION.md)). With `PAYMENTS_PROVIDER=mock` (default) nothing here is active except refunds of mock orders.

## Connect onboarding

`POST /api/billing/connect/start` creates (once per workspace) a Standard connected account and returns an Account Link URL. `GET /api/billing/connect` re-reads the account from Stripe and stores `charges_enabled`, `payouts_enabled`, `details_submitted`. `account.updated` and `account.application.deauthorized` webhooks keep it current; `POST /api/billing/connect/disconnect` forgets the account locally (it does not delete it at Stripe). Checkout answers `409 STRIPE_NOT_CONNECTED` until charges are enabled.

## Hosted checkout

1. The visitor submits the checkout block. The server loads the stored block (never trusting a client price), builds line items for the offer and selected bumps and creates a Checkout Session on the connected account with an idempotency key, `application_fee_amount`, `customer_creation=always`, and `setup_future_usage=off_session` when the funnel has a one-click upsell. Orders are **not** created yet; the response carries `redirect`, which the beacon follows.
2. Orders are created when payment is confirmed, by whichever arrives first: the signed `checkout.session.completed` webhook, or the visitor returning to `GET /api/public/checkout/return?cs=...`. Both call the same `finalizeSession`, which re-reads the session from Stripe, checks status and that the paid total equals the stored total (otherwise `409`, the webhook is left unprocessed so Stripe retries), and inserts main and bump orders with a unique `idem_key` per session and block, so the race produces exactly one set of orders, events, lead and `funnel.purchase` webhooks.
3. The return URL redirects to the funnel's next step (or back with `purchase=cancelled`).

Webhook handling: signature (`t=...,v1=...`, HMAC-SHA256 over `t.body`, timestamp tolerance `STRIPE_WEBHOOK_TOLERANCE_SECONDS`, constant time, any matching `v1` accepted for secret rotation), then event-id dedup in `stripe_events`; a handler failure records the error, returns a non-2xx and the event is retried.

## One-click upsell

Charges a PaymentIntent off-session with the customer and payment method saved from the first checkout, on the same connected account. Declines and cards needing authentication are `402 PAYMENT_FAILED` (`details.reason`), and an intent that needs the customer is cancelled. Idempotent per submission id.

## Refunds

`POST /api/orders/:id/refund` (`orders:refund`, owner and admin by default) with optional `amountCents` and `reason`. The amount is **reserved inside a transaction before Stripe is called** (so concurrent double refunds cannot both go through), the refund is created with an idempotency key, and the reservation is released if Stripe fails (`502 REFUND_FAILED`; Stripe's "already refunded" becomes `409 ALREADY_REFUNDED`). Partial refunds add up; orders carry `status` (`paid`, `partially_refunded`, `refunded`) and `refunded_cents`. Refunds made in the Stripe dashboard arrive as `charge.refunded` and are spread over the orders of that payment, never counting our own refunds twice. Each refund writes the audit log, a notification and a `funnel.refund` webhook.

## Disputes (chargebacks)

The Connect webhook handles `charge.dispute.created`, `.updated`, `.closed`, `.funds_withdrawn` and `.funds_reinstated` (`server/src/services/disputes.ts`, migration 014). Enable these events on the Connect endpoint in the Stripe dashboard.

**What is stored.** One `disputes` row per Stripe dispute id (workspace-scoped, `ON DELETE CASCADE`): Stripe status (`needs_response`, `under_review`, `won`, `lost`, `warning_*`), a derived `outcome` (`open`, `won`, `lost`), reason, amount, currency, `evidence_due_by`, funds withdrawn/reinstated timestamps, livemode, the amount lost. The dispute is linked to the order(s) through the **PaymentIntent** (`orders.provider_ref`); a checkout of an offer plus bumps is one payment, so one dispute covers several orders.

**Order status.** Derived, never stored as a "previous state", so winning always restores exactly what refunds say:

| Order status | When |
|---|---|
| `charged_back` | the order lost money to a lost dispute (`orders.disputed_lost_cents > 0`) |
| `disputed` | a dispute on its payment is open and the order still has value left (amount - refunded - lost) |
| `paid` / `partially_refunded` / `refunded` | otherwise, from `refunded_cents` |

A **won** (or `warning_closed`) dispute therefore returns the orders to `paid` or `partially_refunded`; a **lost** one makes them `charged_back`.

**Money math.** A lost dispute takes `min(dispute amount, what is left of each order after refunds)` from the payment's orders in creation order and stores it in `orders.disputed_lost_cents`. Refund plus dispute can never take more than the order's amount, in either order: refunding is limited to `amount - refunded - lost` (`409 ORDER_CHARGED_BACK` when nothing is left), and a dashboard refund (`charge.refunded`) arriving after a loss is allocated only to what is left. The loss is applied exactly once per dispute (`loss_applied_at` claim in the same transaction).

**Analytics.** The lost amount is subtracted from the sales rollups (`event_rollups.cents`, and `orders` by 1 when a whole order is gone), booked into the 15-minute bucket in which the loss was recorded (closed periods are not rewritten). Every analytics read uses the rollups, so the funnel analytics API, step analytics, funnel list stats and the Analytics API v1 `gross` and `orders` (funnels, steps, time series) are net of lost disputes; so is the per-lead `order_total` of the leads export. The raw `events` rows (and the NDJSON event export) stay as the facts they are: an `order` event keeps its original amount. **Refunds are not subtracted from gross today** (only lost disputes are); this is unchanged, so a refunded-then-charged-back order loses only the part that was not refunded and nothing is counted twice. Limitation: with `ANALYTICS_READ_STORE=clickhouse` the ClickHouse mirror is fed from events and does not see the dispute correction (unverified, no ClickHouse here).

**Delivery guarantees.** Idempotent by Stripe event id (`stripe_events`) and by state: a replay under another event id changes nothing. Out-of-order tolerant: `closed` before `created` creates the row in its closed state; a terminal outcome (`won`/`lost`) is never reopened by a late `created` or `updated`; an `updated` older than the last applied event (by Stripe's `created`) is ignored; a second `closed` with a different outcome is logged and ignored. A dispute whose payment is not known yet (or arrives before the order exists) is an **orphan**: stored with the workspace of the connected account (`event.account`) and no order, listed with `orphan: true`, and linked when the orders appear (`reconcileDisputes` runs after every order insert), applying a lost outcome then. If even the connected account is unknown the row has no workspace and is invisible to every workspace. A dispute is only linked to orders whose `provider_account` equals the event's account, so another account cannot attach a dispute to these orders by quoting a PaymentIntent id.

**Notifications.** Per dispute change, in the workspace: in-app notification (`type: dispute`: opened, won, lost), outbound webhook `funnel.dispute` (payload `{event: opened|updated|won|lost|funds_withdrawn|funds_reinstated, dispute: {id, status, outcome, reason, amount, currency, evidenceDueBy, lostAmount, fundsWithdrawn}, order}`; `order` is null for an orphan) and an audit entry (`dispute.opened|updated|won|lost|funds_withdrawn|funds_reinstated|reconciled`, actor `stripe`). Replays do not repeat them.

**API and UI.** `GET /api/disputes` (`orders:read`; filters `outcome`, `orderId`; paging) lists the workspace's disputes with a `dashboardUrl` (`https://dashboard.stripe.com/[test/]disputes/dp_...`); `GET /api/orders` and `GET /api/orders/:id` carry a `dispute` object (or null). The Orders tab shows a Disputed or Charged back badge, the evidence due date for open disputes, the deducted amount for lost ones, and a "View in Stripe" link; responding with evidence happens in Stripe, not in Funnels.

Not modelled: submitting evidence, accepting a dispute from Funnels, inquiries that are only `warning_*` are tracked like disputes but no money is taken, disputes on platform subscription charges (platform webhook), multiple currencies per payment. Unverified against the real Stripe API (field names `payment_intent`, `evidence_details.due_by`, `status` taken from Stripe's documented dispute object).

## Platform billing and plan limits

`POST /api/billing/subscribe {plan}` creates the platform customer once and a subscription Checkout Session; `POST /api/billing/portal` opens the Stripe customer portal. Subscription events (`customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `checkout.session.completed` in subscription mode) set `workspaces.plan`, `plan_status` and `plan_period_end`; the plan comes from the price id (`STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`) and an unknown price changes nothing. Past-due keeps the plan while Stripe retries and notifies the owners. Cancellation returns to Free.

Limits (`BILLING_ENFORCE_LIMITS=true`; off by default so self-hosted installs are unlimited):

| | Free | Pro | Business |
|---|---|---|---|
| funnels | 3 | 50 | 1000 |
| domains | 1 | 10 | 100 |
| members (pending invitations count) | 2 | 10 | 100 |
| API keys | 1 | 10 | 50 |
| Cloudflare Pages projects hosted on the installation's account (`CF_PAGES_*`) | 1 | 10 | 100 |

Going over is `402 PLAN_LIMIT_REACHED` with `details {resource, limit, used, plan}`. Nothing is ever deleted on downgrade; trashed funnels free a slot and restoring needs one. `GET /api/billing` reports plan, limits, usage and the connect state.

## Payments setup (Settings, Payments)

`GET /api/payments/status` (`products:read`) answers what the screen shows: the server mode from the key (`test` for `sk_test_...`, `live`, or none: built-in test payments), the connection `state` (`unavailable`, `not_connected`, `onboarding_incomplete` with the requirements Stripe still lists, `restricted`, `connected`), charges and payouts, and from the connected account its country, default currency, active payment methods (capabilities), statement descriptor, display name and whether Stripe Tax is set up. A Stripe outage answers the stored state with `stale: true`. `PATCH /api/payments/settings` (`billing:manage`) sets the statement descriptor suffix (at most 22 letters, digits and spaces: `payment_intent_data[statement_descriptor_suffix]`), receipt emails (`receipt_email`, the account must have customer emails enabled in Stripe) and Stripe Tax (`automatic_tax`; the toggle needs Stripe Tax set up on the account). With tax on, the paid total may exceed the subtotal: orders record the line amounts and the tax is not revenue. Onboarding returns to `/settings`.

Test mode (a test key) shows a banner and the Stripe test cards (`4242 4242 4242 4242` succeeds; `4000 0000 0000 0002` declines; `4000 0000 0000 9995` insufficient funds, also declines one-click upsells; `4000 0025 0000 3155` and `4000 0000 0000 3220` ask for 3-D Secure, which an off-session upsell cannot answer). Use any future expiry, any CVC and any postal code. The wizard "Add payments to this funnel" builds the checkout steps ([PRODUCTS.md](PRODUCTS.md#templates-and-the-wizard)).

Checkout now prices from the product catalog ([PRODUCTS.md](PRODUCTS.md)): synced prices are sent as `line_items[].price`, others as `price_data`; quantity, promotion codes (`allow_promotion_codes`, discounts recorded per order), subscriptions (`mode=subscription`, trials, application fee as a percentage) and zero- and three-decimal currencies are handled there. The Connect webhook also reconciles `product.*` and `price.*` events. The finalizer accepts `payment_status` `paid`, or `no_payment_required` for a subscription trial, and verifies `amount_total = subtotal - discount + tax` against what the server stored (`409 CHECKOUT_MISMATCH` otherwise). Not verified against the real Stripe API: the catalog sync, the subscription session shape (`invoice.payment_intent` expansion), promotion codes and Stripe Tax.

## Test-mode validation checklist (not yet done)

1. Create a Connect platform in test mode; set the two webhook endpoints and secrets; `stripe listen --forward-to` works for local runs.
2. Onboard a test Standard account; confirm `GET /api/billing/connect` shows charges enabled.
3. Buy with `4242 4242 4242 4242`; confirm orders appear once whether the webhook or the return URL wins; confirm the application fee on the connected account's payment.
4. Run the upsell with `4242...` and with `4000 0025 0000 3155` (authentication) and `4000 0000 0000 9995` (decline).
5. Refund fully and partially from the dashboard and from the API; confirm single counting. Create a dispute with `4000 0000 0000 0259` (and `4000 0000 0000 1976` for an inquiry), submit winning (`winning_evidence`) and losing (`losing_evidence`) evidence in test mode and confirm the order status, the analytics and the notification each time.
6. Subscribe to Pro with a test price; confirm plan changes, portal opens, past-due with `4000 0000 0000 0341`, and cancellation.
7. Confirm fields we read exist as assumed (`payment_intent.latest_charge`, `session.payment_intent`, `subscription.items.data[0].current_period_end`; newer API versions moved some of these).

Known gaps: subscription renewals are not recorded as orders, no invoices on funnel checkouts, disputes are tracked but not answered from Funnels (see above), no SCA flow for the upsell beyond failing cleanly, one currency per order, no proration controls (portal decides).
