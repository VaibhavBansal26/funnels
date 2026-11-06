# 0047. Card fields on the page (Stripe Payment Element) and a server-side cart

Status: Accepted (tested against the in-process fake of Stripe and in Chrome with the TEST card form; **never run against real Stripe**)

## Context

Checkout only redirected to Stripe's hosted page, one offer (plus bumps) at a time. Owners asked for (1) a payment step with the card fields on their own page, placeable anywhere (an offer page followed by a dedicated checkout page), and (2) a cart: several products, quantities, a cart page.

Constraints: card data must never touch our servers (PCI SAQ A), money goes to the workspace's connected Standard account (direct charges with an application fee, ADR 0020), the server is the only authority on prices (ADR 0024), pages are served from four places (the app's own origin, the built-in address under a path prefix, customer domains through the edge, Cloudflare Pages bundles on another origin), and orders must be recorded exactly once whatever arrives first.

## Decision

* **Payment form block** (`fn-payment`): order summary plus card fields. `mode: embedded | hosted`; `source: cart | product`. Embedded with Stripe mounts the **Payment Element** with a **PaymentIntent created by the server on the connected account** (`Stripe-Account`, `application_fee_amount` by plan, idempotency key `pay:<attempt>:<version>`), amount computed from the catalog (cart lines re-read, replaced prices followed) and the selected order bumps; nothing priced by the browser. A bump checkbox re-quotes and updates the intent. Stripe.js is loaded from `js.stripe.com` with `stripeAccount`, only by the separate `/commerce.js` runtime, only on pages with this block; the publishable key comes from `STRIPE_PUBLISHABLE_KEY` (validated, same mode as the secret key or the app refuses to start). `confirmPayment(..., redirect: 'if_required')` runs 3-D Secure; the `return_url` is this API, which finishes the order and redirects to the next step with the order id (for one-click upsells; `setup_future_usage=off_session` and a customer on the connected account when the funnel has one).
* **One attempt row per purchase** (`payment_attempts`): the server's quote (`items_json`, amount, currency, fee), the intent id, the buyer. **Finalisation is shared** with hosted Checkout (`ordersFromItems`, `persistPurchase`): the webhook `payment_intent.succeeded`, the browser's `POST /api/public/pay/complete` and the return URL all re-read the intent from Stripe, require `succeeded` and the stored amount and currency, and insert orders under `pi:<attempt>:<line>` (unique index), so a race yields one set. `payment_intent.payment_failed` is recorded. Events of another connected account, and intents this app did not create for an attempt, are ignored.
* **Without Stripe** (`PAYMENTS_PROVIDER=mock`) the runtime renders a TEST card form: inputs without `name`, a local Luhn/expiry/CVC check mapping the documented test numbers to an outcome; only the outcome reaches the server. The TEST label is styled inline with `!important` and the runtime refuses to pay when it is not visible.
* **Cart** (`carts`, `cart_items`, `cart_ops`): server-side, per funnel and visitor, no personal data, one currency, `CART_MAX_LINES`, `CART_MAX_QUANTITY`, expiry `CART_TTL_DAYS` (default 7) extended by every change and swept by maintenance. The browser keeps a signed token (`crt_<id>.<hmac>`) in a first-party cookie of the page's host and sends it in the JSON body, so the same cross-origin calls work on every host (CORS as for the other public endpoints); without a token (sandboxed page) the visitor id finds the cart. Every change carries a client operation id (idempotent). Blocks: **Add to cart**, **Cart** (quantities, remove, the checkout step's bumps, totals, Checkout button), **Cart count**. Checkout of a cart creates one order per line with the new role `cart` (bumps keep `bump`); refunds stay per order line. When a cart is paid, other open attempts on it are cancelled (their intents too), so a second tab cannot pay it again.
* **Analytics**: funnel events `add_to_cart` and `begin_checkout` (rollup columns `cart_adds`, `checkouts`; the events table CHECK widened, SQLite by table rebuild), server-side AddToCart and InitiateCheckout with the browser's event ids (consent rules unchanged), `roles.cart` in product analytics, line items in `funnel.purchase` (additive).
* **CSP**: pages with an embedded Payment form get `script-src https://js.stripe.com https://*.js.stripe.com`, `connect-src https://api.stripe.com` and `frame-src` for js.stripe.com, hooks.stripe.com and m.stripe.network, and only when payments run on Stripe; every other page keeps its exact policy. A built-in address page with owner code is sandboxed (opaque origin); Stripe.js does not work there, so the runtime falls back to the hosted redirect (recommend a custom domain or Cloudflare Pages).

## Alternatives considered

* **Stripe Checkout embedded mode** (`ui_mode=embedded`): less code, but an iframe of Stripe's whole checkout, not card fields in the owner's design, and no cart summary we render.
* **Deferred intent creation** (Elements with `mode`/`amount`, intent created at submit): fewer abandoned intents, but the amount shown before submit would be browser-computed; we chose the server-quoted intent.
* **Cart in localStorage only**: no server state, but prices and currency rules would be enforced only at checkout, the cart would not follow the visitor across hosts, and two tabs could diverge silently.
* **Cart id in a third-party cookie on the API host**: blocked by browsers for Pages hosts and custom domains.

## Consequences

* Each Payment form view creates a PaymentIntent (abandoned ones stay `requires_payment_method` at Stripe; attempts without a payment are deleted after 30 days).
* Subscriptions are not sold through carts or the embedded form (they use the hosted Checkout path).
* The beacon stays under its size budget: the commerce runtime is its own file, copied into Pages bundles only when a page uses it.
* **Not verified against Stripe**: Payment Element mounting, `confirmPayment`, 3-D Secure redirects, `elements.fetchUpdates()` after an amount change, Stripe's real CSP needs, webhook delivery. See VERIFIED.md and the checklist in STRIPE.md.
