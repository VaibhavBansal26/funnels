import { formTarget, makeHarness, type Harness } from '../helpers.js';
import { newId } from '../../src/util/ids.js';
import { FakeNet } from './fakenet.js';

export interface Touch {
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
}
let n = 0;

/** A workspace with one lead-form funnel, ready for hand-made orders, leads and visitors with exact timestamps and attribution. */
export async function adsWorld(env: Record<string, string> = {}) {
  const net = new FakeNet();
  const h: Harness = await makeHarness({ env, deps: { outbound: net.fetch } });
  const owner = await h.register();
  const form = await formTarget(h, owner.token);
  const ws = owner.wsId;
  return {
    h, owner, form, net, ws,
    async order(o: { at: string; cents: number; currency?: string; first?: Touch; last?: Touch; bump?: boolean; refunded?: number; funnelId?: string }) {
      const id = newId('ord');
      const f = o.first ?? o.last;
      const l = o.last ?? o.first;
      await h.deps.db.run(
        `INSERT INTO orders (id, workspace_id, funnel_id, step_id, block_id, email, product_name, amount_cents, currency, is_bump, is_upsell, provider, provider_ref, created_at, refunded_cents,
           first_source, first_medium, first_campaign, first_content, last_source, last_medium, last_campaign, last_content)
         VALUES (?, ?, ?, ?, 'blk', ?, 'P', ?, ?, ?, 0, 'mock', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ws, o.funnelId ?? form.funnelId, form.stepId, `o${++n}@example.com`, o.cents, o.currency ?? 'USD', o.bump ? 1 : 0, `ref_${id}`, o.at, o.refunded ?? 0,
        f?.source ?? null, f?.medium ?? null, f?.campaign ?? null, f?.content ?? null, l?.source ?? null, l?.medium ?? null, l?.campaign ?? null, l?.content ?? null,
      );
      return id;
    },
    async lead(o: { at: string; first?: Touch; last?: Touch }) {
      const id = newId('lead');
      const f = o.first ?? o.last;
      const l = o.last ?? o.first;
      await h.deps.db.run(
        `INSERT INTO leads (id, workspace_id, email, first_funnel_id, created_at, updated_at, first_source, first_medium, first_campaign, first_content, last_source, last_medium, last_campaign, last_content)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, ws, `l${++n}@example.com`, form.funnelId, o.at, o.at, f?.source ?? null, f?.medium ?? null, f?.campaign ?? null, f?.content ?? null, l?.source ?? null, l?.medium ?? null, l?.campaign ?? null, l?.content ?? null,
      );
    },
    async visitor(o: { at: string; first?: Touch; last?: Touch; funnelId?: string }) {
      const f = o.first ?? o.last;
      const l = o.last ?? o.first;
      await h.deps.db.run(
        `INSERT INTO visitor_attribution (workspace_id, visitor_id, created_at, updated_at, first_source, first_medium, first_campaign, first_content, first_funnel_id, first_at, last_source, last_medium, last_campaign, last_content, last_funnel_id, last_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ws, `vis${++n}`, o.at, o.at, f?.source ?? null, f?.medium ?? null, f?.campaign ?? null, f?.content ?? null, f ? (o.funnelId ?? form.funnelId) : null, f ? o.at : null,
        l?.source ?? null, l?.medium ?? null, l?.campaign ?? null, l?.content ?? null, l ? (o.funnelId ?? form.funnelId) : null, l ? o.at : null,
      );
    },
    spend: (body: Record<string, unknown>, token = owner.token) => h.call('POST', '/api/ads/spend', { token, body: { account: '', ...body } }),
    report: (q: string, token = owner.token) => h.call('GET', `/api/ads/performance?${q}`, { token }),
    attribution: (q: string, token = owner.token) => h.call('GET', `/api/ads/attribution?${q}`, { token }),
    csv: (text: string, q = '', token = owner.token) => h.call('POST', `/api/ads/spend/import${q ? `?${q}` : ''}`, { token, raw: text, headers: { 'content-type': 'text/csv' } }),
  };
}
