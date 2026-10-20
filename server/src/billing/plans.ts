import type { Plan } from '../ratelimit/types.js';

/**
 * Plan limits and the application fee Funnels keeps from checkouts made through a workspace's connected Stripe account. Enforced only when
 * BILLING_ENFORCE_LIMITS is on (a self-hosted install without billing has no limits). Going over a limit never deletes anything: creating more is refused (402
 * PLAN_LIMIT_REACHED) until the workspace is back under it or upgrades.
 */
export interface PlanDef {
  id: Plan;
  name: string;
  funnels: number;
  domains: number;
  members: number;
  apiKeys: number;
  /** Application fee in basis points of each checkout (100 = 1%). */
  feeBps: number;
  priceLabel: string;
}

export const PLAN_DEFS: Record<Plan, PlanDef> = {
  free: { id: 'free', name: 'Free', funnels: 3, domains: 1, members: 2, apiKeys: 1, feeBps: 500, priceLabel: '$0' },
  pro: { id: 'pro', name: 'Pro', funnels: 50, domains: 10, members: 10, apiKeys: 10, feeBps: 200, priceLabel: 'see Stripe price' },
  business: { id: 'business', name: 'Business', funnels: 1000, domains: 100, members: 100, apiKeys: 50, feeBps: 0, priceLabel: 'see Stripe price' },
};

export type Limited = 'funnels' | 'domains' | 'members' | 'apiKeys';
