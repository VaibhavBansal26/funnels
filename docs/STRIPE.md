# Stripe: Connect checkout, refunds, platform billing and plan limits

Status: implemented and tested against an in-process fake of the Stripe API (`server/test/support/fakestripe.ts`). **Not verified against the real Stripe API.** Before enabling in production, run the test-mode checklist at the end of this page.

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

## Platform billing and plan limits

`POST /api/billing/subscribe {plan}` creates the platform customer once and a subscription Checkout Session; `POST /api/billing/portal` opens the Stripe customer portal. Subscription events (`customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`, `checkout.session.completed` in subscription mode) set `workspaces.plan`, `plan_status` and `plan_period_end`; the plan comes from the price id (`STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS`) and an unknown price changes nothing. Past-due keeps the plan while Stripe retries and notifies the owners. Cancellation returns to Free.

Limits (`BILLING_ENFORCE_LIMITS=true`; off by default so self-hosted installs are unlimited):

| | Free | Pro | Business |
|---|---|---|---|
| funnels | 3 | 50 | 1000 |
| domains | 1 | 10 | 100 |
| members (pending invitations count) | 2 | 10 | 100 |
| API keys | 1 | 10 | 50 |

Going over is `402 PLAN_LIMIT_REACHED` with `details {resource, limit, used, plan}`. Nothing is ever deleted on downgrade; trashed funnels free a slot and restoring needs one. `GET /api/billing` reports plan, limits, usage and the connect state.

## Test-mode validation checklist (not yet done)

1. Create a Connect platform in test mode; set the two webhook endpoints and secrets; `stripe listen --forward-to` works for local runs.
2. Onboard a test Standard account; confirm `GET /api/billing/connect` shows charges enabled.
3. Buy with `4242 4242 4242 4242`; confirm orders appear once whether the webhook or the return URL wins; confirm the application fee on the connected account's payment.
4. Run the upsell with `4242...` and with `4000 0025 0000 3155` (authentication) and `4000 0000 0000 9995` (decline).
5. Refund fully and partially from the dashboard and from the API; confirm single counting.
6. Subscribe to Pro with a test price; confirm plan changes, portal opens, past-due with `4000 0000 0000 0341`, and cancellation.
7. Confirm fields we read exist as assumed (`payment_intent.latest_charge`, `session.payment_intent`, `subscription.items.data[0].current_period_end`; newer API versions moved some of these).

Known gaps: no tax or invoices on funnel checkouts, no disputes handling, no SCA flow for the upsell beyond failing cleanly, one currency per order, no proration controls (portal decides).
