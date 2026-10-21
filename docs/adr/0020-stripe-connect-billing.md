# 0020. Stripe Connect hosted checkout, idempotent finalization, refunds and plan limits

Status: Accepted (implementation verified against a fake and sandbox response shapes only; no real payment)

## Context

Funnels sells for its customers (workspace owners) and also sells subscriptions to them. Card data must never touch our servers, orders must be created exactly once although a webhook and the buyer's browser race, and refunds must not double-pay.

## Decision

* **Standard connected accounts with direct charges and an application fee** (by plan): the owner is merchant of record, disputes and payouts stay with them, onboarding is hosted by Stripe.
* **Hosted Checkout, not Elements**: no card data in our scope (SAQ A). One-click upsell uses `setup_future_usage=off_session` and an off-session PaymentIntent.
* **Orders are created at finalization, not at submission.** Finalization is triggered by the signed webhook or the return URL, re-reads the session from Stripe, verifies totals, and relies on a unique `idem_key` per session and block, so races collapse to one set of rows.
* **Two webhook endpoints with two secrets**; events deduped by id; failures are non-2xx so Stripe retries; our own handler side effects are idempotent as well.
* **Refund reservation before the external call**, released on failure; idempotency key per refund row; dashboard refunds reconciled by refund id.
* **Plans are derived from price ids** and plan limits are enforced in the services that create the resources, behind `BILLING_ENFORCE_LIMITS`, never deleting data.
* **Testing seam:** `StripeClient` takes the API base and an injectable fetch; `FakeStripe` implements the used subset including failure switches. A fake proves our logic, not Stripe's behaviour.

## Alternatives considered

Embedded Elements with our own PaymentIntents (PCI scope, more code); destination charges (platform is merchant of record, liability and refunds fall on us); creating orders before payment and flipping a flag (orders that never paid pollute analytics and webhooks); trusting only the webhook (buyers land on a page that does not know they paid) or only the return URL (closed tabs lose orders).

## Consequences

Orders appear slightly after payment if the webhook is late and the buyer never returns. API version differences are a risk until the test-mode checklist in docs/STRIPE.md is done. No tax handling, no dispute workflow.
