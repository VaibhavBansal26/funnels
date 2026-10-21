import type { Deps } from '../../deps.js';
import { fromMinor } from '../../util/money.js';
import type { TemplateProduct } from '../../templates/types.js';
import { plainOut } from './redact.js';
import type { Brief, FunnelType, ProductMode, ProductPlan, Strategy } from './types.js';

export interface CatalogItem { productId: string; priceId: string; name: string; type: 'one_time' | 'subscription'; amount: number; currency: string; interval?: 'month' | 'year' }

/** Active products of the workspace with their current price: what "existing" mode may bind to. Read-only. */
export async function loadCatalog(deps: Deps, ws: string, limit = 60): Promise<CatalogItem[]> {
  const rows = await deps.db.all<{ pid: string; name: string; type: 'one_time' | 'subscription'; prid: string; unit_amount: number; currency: string; billing_interval: string | null }>(
    `SELECT p.id AS pid, p.name, p.type, pr.id AS prid, pr.unit_amount, pr.currency, pr.billing_interval FROM products p JOIN prices pr ON pr.id = p.default_price_id
     WHERE p.workspace_id = ? AND p.status = 'active' AND pr.active = 1 ORDER BY p.created_at DESC, p.id LIMIT ?`,
    ws, limit,
  );
  return rows.map((r) => ({ productId: r.pid, priceId: r.prid, name: r.name, type: r.type, amount: fromMinor(r.unit_amount, r.currency), currency: r.currency, ...(r.billing_interval === 'month' || r.billing_interval === 'year' ? { interval: r.billing_interval } : {}) }));
}

const DEFAULT_PRICE: Record<string, number> = { saas: 29, education: 197, ecommerce: 49, events: 49, nonprofit: 25, coaching: 497, general: 97 };
const clamp = (n: number, lo: number | null, hi: number | null): number => Math.min(hi ?? Infinity, Math.max(lo ?? 0, n));
const nice = (n: number): number => (n >= 100 ? Math.round(n) : n >= 10 ? Math.round(n) : Math.round(n * 100) / 100);

/** Price of the main product: the author's price when given (exact, or inside the range), otherwise a typical amount for the industry. Never outside user constraints. */
export function mainPrice(b: Brief, type: FunnelType): { amount: number; assumed: boolean } {
  const base = DEFAULT_PRICE[type === 'donation' ? 'nonprofit' : type === 'event' ? 'events' : b.industry] ?? DEFAULT_PRICE.general!;
  if (b.priceMin !== null && b.priceMin === b.priceMax) return { amount: b.priceMin, assumed: false };
  if (b.priceMin !== null && b.priceMax !== null) return { amount: nice(clamp((b.priceMin + b.priceMax) / 2, b.priceMin, b.priceMax)), assumed: false };
  if (b.priceMax !== null) return { amount: nice(clamp(Math.min(base, b.priceMax), null, b.priceMax)), assumed: false };
  if (b.priceMin !== null) return { amount: nice(Math.max(base, b.priceMin)), assumed: false };
  return { amount: base, assumed: true };
}

export interface ProductResult { plans: ProductPlan[]; assumptions: string[] }

const name = (s: string, fallback: string) => plainOut(s, 80) || fallback;

/**
 * Product suggestions bound to the catalog. Roles come from the plan (main for the offer/checkout page, bump on a sales page, upsell/downsell steps). In
 * `existing` mode each role takes a catalog product the author named or selected; roles without one are dropped (the pipeline removes their steps). In `create`
 * mode every role becomes a new catalog product on save, priced inside the author's constraints. Nothing is created here.
 */
export function planProducts(b: Brief, strategy: Strategy, mode: ProductMode, catalog: CatalogItem[], selected: string[] = [], promptText = ''): ProductResult {
  if (mode === 'none') return { plans: [], assumptions: [] };
  const assumptions: string[] = [];
  const roles: ProductPlan['role'][] = [];
  for (const s of strategy.steps) if (s.role && !roles.includes(s.role)) roles.push(s.role);
  if (strategy.funnelType === 'sales_page' && strategy.steps.some((s) => s.kind === 'sales' && s.primary === 'checkout')) roles.push('bump');
  const plans: ProductPlan[] = [];
  const main = mainPrice(b, strategy.funnelType);
  const cap = b.priceMax;
  const sub = strategy.funnelType === 'saas_trial';
  const text = promptText.toLowerCase();
  let pool = selected.map((id) => catalog.find((c) => c.productId === id)).filter((c): c is CatalogItem => !!c);
  if (mode === 'existing' && !pool.length) pool = catalog.filter((c) => c.name.length > 2 && text.includes(c.name.toLowerCase())).slice(0, 4);
  for (const role of roles) {
    const slot = role;
    if (mode === 'existing') {
      const hit = pool.shift();
      if (!hit) continue;
      plans.push({ slot, role, name: hit.name, description: '', type: hit.type, amount: hit.amount, currency: hit.currency, interval: hit.interval, source: 'catalog', productId: hit.productId, priceId: hit.priceId });
      continue;
    }
    const amount = role === 'main' ? main.amount : role === 'bump' ? nice(clamp(Math.max(5, main.amount * 0.25), null, cap)) : role === 'upsell' ? nice(clamp(Math.max(9, main.amount * 0.5), null, cap)) : nice(clamp(Math.max(5, main.amount * 0.3), null, cap));
    const offer = name(b.offer || b.business, 'Your offer');
    plans.push({
      slot, role, source: 'new', currency: b.currency, amount,
      name: role === 'main' ? name(offer.slice(0, 60), 'Your offer') : role === 'bump' ? 'Bonus add-on' : role === 'upsell' ? 'One-time upgrade' : 'Lighter option',
      description: role === 'main' ? '[Describe what the buyer gets.]' : '[Describe this add-on.]',
      type: sub && role === 'main' ? 'subscription' : 'one_time', ...(sub && role === 'main' ? { interval: 'month' as const } : {}),
    });
  }
  if (mode === 'create') {
    if (main.assumed) assumptions.push(`No price was given, so the main product is a draft at ${main.amount} ${b.currency}. Edit it in the product catalog before you take payment.`);
    else assumptions.push(`The main product is priced at ${main.amount} ${b.currency}, inside the price you gave.`);
    assumptions.push('Products are created as drafts in your catalog (not synced to Stripe) and the funnel is saved in test status, so nothing can be bought until you publish.');
  } else if (plans.length) assumptions.push(`The funnel sells your existing product${plans.length > 1 ? 's' : ''}: ${plans.map((p) => p.name).join(', ')}.`);
  else assumptions.push('No existing catalog product matched, so the funnel collects enquiries instead of taking payment.');
  return { plans, assumptions };
}

export function slotsOf(plans: ProductPlan[]): TemplateProduct[] {
  return plans.map((p) => ({ key: p.slot, role: p.role, name: p.name, description: p.description, type: p.type, amount: p.amount, currency: p.currency, ...(p.interval ? { interval: p.interval } : {}) }));
}

export const bindingsOf = (plans: ProductPlan[]) => Object.fromEntries(plans.map((p) => [p.slot, p.source === 'catalog' ? { priceId: p.priceId! } : { create: true as const }]));
