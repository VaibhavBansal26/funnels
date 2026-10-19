import { createHash } from 'node:crypto';

/**
 * Payment boundary. Funnels only ever talks to this interface, so the checkout block, order
 * records, analytics and webhooks do not change when a real processor is plugged in.
 *
 * Stripe Connect plug-in point: implement `PaymentProvider` with the workspace's connected account
 * (`stripeAccount: workspace.stripe_user_id`), create a PaymentIntent with `idempotencyKey` as the
 * Stripe idempotency key, return the intent id as `providerRef` and the saved PaymentMethod id as
 * `paymentMethodRef` so one-click upsells can charge off-session. Then pass the instance to
 * `createApp({ payments })` in `src/index.ts`. See docs/ARCHITECTURE.md.
 */
export interface ChargeRequest {
  amountCents: number;
  currency: string;
  description: string;
  customer: { email: string; name?: string };
  /** Stable per purchase attempt so retries never double-charge. */
  idempotencyKey: string;
  /** Present for one-click upsells: reuse the payment method of the original order. */
  paymentMethodRef?: string;
}

export type ChargeResult =
  | { status: 'succeeded'; providerRef: string; paymentMethodRef: string }
  | { status: 'failed'; reason: string };

export interface PaymentProvider {
  readonly name: string;
  charge(req: ChargeRequest): Promise<ChargeResult>;
}

/**
 * Test payment provider. Never contacts a network. Deterministic: the same idempotency key yields
 * the same reference. Emails whose local part starts with "decline" are declined, which lets the UI
 * and tests exercise the failure path.
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock';

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    if (req.customer.email.toLowerCase().startsWith('decline')) return { status: 'failed', reason: 'card_declined' };
    if (req.amountCents < 0) return { status: 'failed', reason: 'invalid_amount' };
    const ref = createHash('sha256').update(req.idempotencyKey).digest('hex').slice(0, 16);
    return {
      status: 'succeeded',
      providerRef: `mock_ch_${ref}`,
      paymentMethodRef: req.paymentMethodRef ?? `mock_pm_${createHash('sha256').update(req.customer.email.toLowerCase()).digest('hex').slice(0, 12)}`,
    };
  }
}
