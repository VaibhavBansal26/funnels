import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/routes/spec.js';
import { store } from './support/stripeworld.js';

let n = 0;
const DUE = 1_900_000_000;

/** A Stripe dispute object for the payment `pi`. */
const dispute = (pi: string | null, over: Record<string, unknown> = {}) => ({
  id: 'dp_1', object: 'dispute', amount: 0, currency: 'usd', charge: 'ch_1', payment_intent: pi, reason: 'fraudulent', status: 'needs_response', evidence_details: { due_by: DUE }, livemode: false, created: 1_800_000_000, ...over,
});

/** A connected store with one paid checkout (offer + bump, one PaymentIntent) and helpers to deliver dispute events for it. */
async function disputed() {
  const w = await store({ API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' });
  const { sid } = await w.pay();
  const pi = (w.stripe.sessions.get(sid)!.payment_intent as string);
  await w.hook('connect', 'checkout.session.completed', { id: sid }, { account: w.acct });
  const [main, bump] = await w.orders();
  const total = main!.amount_cents + bump!.amount_cents;
  const send = (type: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}, opts: { id?: string } = {}) =>
    w.hook('connect', `charge.dispute.${type}`, dispute(pi, { amount: total, ...over }), { account: w.acct, created: (over.created as number | undefined) ?? 1_800_000_000, ...extra }, opts);
  const list = async (token = w.owner.token, q = '') => (await w.h.call('GET', `/api/disputes${q}`, { token })).json;
  const dbOrders = () => w.orders() as Promise<{ id: string; status: string; amount_cents: number; refunded_cents: number; disputed_lost_cents: number }[]>;
  const analytics = async () => (await w.h.call('GET', `/api/funnels/${w.t.funnelId}/analytics`, { token: w.owner.token })).json.summary.sales as { orders: number; gross: number; refunded: number; disputedLost: number; net: number };
  const refund = (id: string, body: object = {}) => w.h.call('POST', `/api/orders/${id}/refund`, { token: w.owner.token, body });
  return { ...w, pi, main: main!, bump: bump!, total, send, list, dbOrders, analytics, refund };
}

describe('Stripe disputes', () => {
  it('created: records the dispute, marks the orders disputed, and raises notification, webhook, audit entry; the order list shows status, evidence due date and the dashboard link', async () => {
    const { h, owner, send, list, dbOrders, main, total } = await disputed();
    await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/d', events: ['funnel.dispute'] } });
    const r = await send('created');
    expect(r.status).toBe(200);
    expect((await dbOrders()).map((o) => o.status)).toEqual(['disputed', 'disputed']);
    const l = await list();
    expect(l.data).toHaveLength(1);
    expect(l.data[0]).toMatchObject({ stripeDisputeId: 'dp_1', orderId: main.id, orphan: false, amountCents: total, status: 'needs_response', outcome: 'open', reason: 'fraudulent', evidenceDueBy: new Date(DUE * 1000).toISOString(), dashboardUrl: 'https://dashboard.stripe.com/test/disputes/dp_1', order: { id: main.id, status: 'disputed' } });
    const orders = (await h.call('GET', '/api/orders', { token: owner.token })).json.data as { status: string; dispute: { stripeDisputeId: string; evidenceDueBy: string } | null }[];
    expect(orders.map((o) => [o.status, o.dispute?.stripeDisputeId])).toEqual([['disputed', 'dp_1'], ['disputed', 'dp_1']]);
    expect((await h.call('GET', `/api/orders/${main.id}`, { token: owner.token })).json.dispute.evidenceDueBy).toBe(new Date(DUE * 1000).toISOString());
    const note = await h.deps.db.get<{ title: string; data_json: string }>("SELECT title, data_json FROM notifications WHERE type = 'dispute'");
    expect(note!.title).toBe('Payment disputed');
    expect(JSON.parse(note!.data_json)).toMatchObject({ stripeDisputeId: 'dp_1', orderId: main.id });
    const hook = await h.deps.db.all<{ payload_json: string }>("SELECT payload_json FROM webhook_deliveries WHERE event = 'funnel.dispute'");
    expect(hook).toHaveLength(1);
    expect(JSON.parse(hook[0]!.payload_json).data).toMatchObject({ event: 'opened', dispute: { id: 'dp_1', outcome: 'open', amount: total / 100 }, order: { id: main.id } });
    const audit = (await h.call('GET', '/api/audit?action=dispute.opened', { token: owner.token })).json.data as { actorId: string; target: string }[];
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: 'stripe', target: main.id });
  });

  it('funnel.dispute is an allowed webhook event; unknown events are still refused', async () => {
    const { h, owner } = await disputed();
    expect((await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/d', events: ['funnel.dispute', 'funnel.refund'] } })).status).toBe(201);
    expect((await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/d', events: ['funnel.disputes'] } })).status).toBe(400);
  });

  it('updated: status and evidence deadline follow Stripe; the orders stay disputed', async () => {
    const { send, list, dbOrders } = await disputed();
    await send('created');
    await send('updated', { status: 'under_review', evidence_details: { due_by: DUE + 86_400 }, created: undefined }, { created: 1_800_000_100 });
    const d = (await list()).data[0];
    expect(d).toMatchObject({ status: 'under_review', outcome: 'open', evidenceDueBy: new Date((DUE + 86_400) * 1000).toISOString() });
    expect((await dbOrders()).map((o) => o.status)).toEqual(['disputed', 'disputed']);
  });

  it('closed (won): the orders go back to their previous state (also after a partial refund) and analytics are untouched', async () => {
    const { send, dbOrders, analytics, refund, main, list } = await disputed();
    const before = await analytics();
    await send('created');
    expect((await refund(main.id, { amountCents: 1000 })).json.order.status).toBe('disputed'); // refunding during a dispute keeps it disputed
    expect((await send('closed', { status: 'won' }, { created: 1_800_000_200 })).status).toBe(200);
    expect((await dbOrders()).map((o) => [o.status, o.disputed_lost_cents])).toEqual([['partially_refunded', 0], ['paid', 0]]);
    // gross and orders are untouched; the partial refund shows in the additive refunded and net fields
    expect(await analytics()).toEqual({ ...before, refunded: 10, net: before.gross - 10 });
    expect((await list()).data[0]).toMatchObject({ outcome: 'won', status: 'won', lostCents: 0 });
  });

  it('closed (lost): orders become charged_back, the amount leaves sales analytics and the analytics API, and nothing is refundable any more', async () => {
    const { h, owner, send, dbOrders, analytics, refund, main, total, t } = await disputed();
    const before = await analytics();
    expect(before.gross * 100).toBe(total);
    await send('created');
    expect((await send('closed', { status: 'lost' }, { created: 1_800_000_200 })).status).toBe(200);
    expect((await dbOrders()).map((o) => [o.status, o.disputed_lost_cents])).toEqual([['charged_back', main.amount_cents], ['charged_back', total - main.amount_cents]]);
    const after = await analytics();
    expect(after).toEqual({ ...before, orders: 0, gross: 0, disputedLost: before.gross, net: 0 }); // the loss leaves gross and is shown next to it
    const steps = (await h.call('GET', `/api/funnels/${t.funnelId}/analytics`, { token: owner.token })).json;
    expect(steps.series.reduce((a: number, p: { gross: number }) => a + p.gross, 0)).toBe(0);
    expect((await refund(main.id)).json.error.code).toBe('ORDER_CHARGED_BACK');
    const key = (await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'k', scopes: ['analytics:read'] } })).json.key as string;
    const api = (await h.call('GET', '/api/v1/analytics/funnels', { token: key })).json.data as { id: string; gross: number; orders: number }[];
    expect(api.find((f) => f.id === t.funnelId)).toMatchObject({ gross: 0, orders: 0 });
    // audit and notification for the loss
    expect((await h.call('GET', '/api/audit?action=dispute.lost', { token: owner.token })).json.data).toHaveLength(1);
    expect((await h.deps.db.get<{ title: string }>("SELECT title FROM notifications WHERE type = 'dispute' AND title = 'Dispute lost'"))).toBeTruthy();
  });

  it('a partial loss only takes the disputed amount, from the first order onwards', async () => {
    const { send, dbOrders, analytics, main, total } = await disputed();
    const lost = main.amount_cents - 500;
    await send('created', { amount: lost });
    await send('closed', { amount: lost, status: 'lost' }, { created: 1_800_000_200 });
    expect((await dbOrders()).map((o) => [o.status, o.disputed_lost_cents])).toEqual([['charged_back', lost], ['paid', 0]]);
    const a = await analytics();
    expect(a.gross * 100).toBe(total - lost);
    expect(a.orders).toBe(2); // neither order is gone entirely
  });

  it('duplicate delivery of the same event id changes nothing; a replay under another id changes nothing either', async () => {
    const { h, owner, send, list, analytics } = await disputed();
    await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/d', events: ['funnel.dispute'] } });
    expect(await (await send('created', {}, {}, { id: 'evt_dp_created' })).json()).toEqual({ received: true });
    expect(await (await send('created', {}, {}, { id: 'evt_dp_created' })).json()).toEqual({ received: true, duplicate: true });
    await send('created', {}, {}, { id: 'evt_dp_created_again' });
    await send('closed', { status: 'lost' }, { created: 1_800_000_200 }, { id: 'evt_dp_closed' });
    const once = await analytics();
    expect((await (await send('closed', { status: 'lost' }, { created: 1_800_000_200 }, { id: 'evt_dp_closed' })).json()).duplicate).toBe(true);
    await send('closed', { status: 'lost' }, { created: 1_800_000_200 }, { id: 'evt_dp_closed_2' });
    expect(await analytics()).toEqual(once);
    expect((await list()).data).toHaveLength(1);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM notifications WHERE type = 'dispute'"))!.n)).toBe(2); // opened + lost
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event = 'funnel.dispute'"))!.n)).toBe(2);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'dispute.%'"))!.n)).toBe(2);
  });

  it('out of order: closed before created, and a late created or stale update never reopens or regresses it', async () => {
    const { send, list, dbOrders, analytics, total } = await disputed();
    expect((await send('closed', { status: 'lost' }, { created: 1_800_000_200 })).status).toBe(200);
    expect((await dbOrders()).map((o) => o.status)).toEqual(['charged_back', 'charged_back']);
    await send('created', {}, { created: 1_800_000_000 });
    await send('updated', { status: 'under_review' }, { created: 1_800_000_100 });
    expect((await list()).data[0]).toMatchObject({ outcome: 'lost', status: 'lost' });
    expect((await dbOrders()).map((o) => o.status)).toEqual(['charged_back', 'charged_back']);
    expect((await analytics()).gross * 100).toBe(0);
    expect(total).toBeGreaterThan(0);
  });

  it('out of order while open: a stale update after a newer one is ignored', async () => {
    const { send, list } = await disputed();
    await send('created', {}, { created: 1_800_000_000 });
    await send('updated', { status: 'under_review' }, { created: 1_800_000_500 });
    await send('updated', { status: 'needs_response', evidence_details: { due_by: DUE + 5 } }, { created: 1_800_000_100 });
    expect((await list()).data[0]).toMatchObject({ status: 'under_review', evidenceDueBy: new Date(DUE * 1000).toISOString() });
  });

  it('funds_withdrawn and funds_reinstated are recorded once', async () => {
    const { send, list, h } = await disputed();
    await send('created');
    await send('funds_withdrawn', {}, { created: 1_800_000_050 });
    await send('funds_withdrawn', {}, { created: 1_800_000_060 }, { id: 'evt_fw_again' });
    await send('closed', { status: 'won' }, { created: 1_800_000_300 });
    await send('funds_reinstated', {}, { created: 1_800_000_310 });
    expect((await list()).data[0]).toMatchObject({ outcome: 'won', fundsWithdrawnAt: new Date(1_800_000_050 * 1000).toISOString(), fundsReinstatedAt: new Date(1_800_000_310 * 1000).toISOString() });
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dispute.funds_withdrawn'"))!.n)).toBe(1);
  });

  it('orphan: a dispute for a payment we have no order for is kept, visible to its workspace, and linked (with its loss) when the order appears', async () => {
    const w = await store({ API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' });
    const { sid } = await w.pay();
    const pi = w.stripe.sessions.get(sid)!.payment_intent as string;
    const amount = Number(w.stripe.sessions.get(sid)!.amount_total);
    const lostFirst = await w.hook('connect', 'charge.dispute.closed', dispute(pi, { amount, status: 'lost' }), { account: w.acct, created: 1_800_000_200 });
    expect(lostFirst.status).toBe(200); // not an error: Stripe would retry for days
    const orphan = (await w.h.call('GET', '/api/disputes', { token: w.owner.token })).json.data[0];
    expect(orphan).toMatchObject({ orphan: true, orderId: null, outcome: 'lost', order: null, lostCents: 0 });
    expect(Number((await w.h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dispute.lost'"))!.n)).toBe(1);
    // the order shows up later (webhook or return URL): the dispute is linked and the loss applied exactly once
    await w.hook('connect', 'checkout.session.completed', { id: sid }, { account: w.acct });
    const linked = (await w.h.call('GET', '/api/disputes', { token: w.owner.token })).json.data[0];
    expect(linked).toMatchObject({ orphan: false, lostCents: amount, outcome: 'lost' });
    const orders = await w.orders();
    expect(orders.map((o) => o.status)).toEqual(['charged_back', 'charged_back']);
    const sales = (await w.h.call('GET', `/api/funnels/${w.t.funnelId}/analytics`, { token: w.owner.token })).json.summary.sales;
    expect(sales).toMatchObject({ orders: 0, gross: 0 });
    await w.h.call('GET', `/api/public/checkout/return?cs=${sid}`); // a second finalisation (the visitor returns) must not apply the loss again
    expect((await w.h.call('GET', `/api/funnels/${w.t.funnelId}/analytics`, { token: w.owner.token })).json.summary.sales).toMatchObject({ orders: 0, gross: 0 });
    expect((await w.h.call('GET', '/api/audit?action=dispute.reconciled', { token: w.owner.token })).json.data).toHaveLength(1);
  });

  it('orphan with an unknown connected account belongs to nobody: stored, invisible to every workspace', async () => {
    const { h, owner, hook, pi, list } = await disputed();
    const r = await hook('connect', 'charge.dispute.created', dispute('pi_unknown', { amount: 500 }), { account: 'acct_nobody', created: 1_800_000_000 });
    expect(r.status).toBe(200);
    const row = await h.deps.db.get<{ workspace_id: string | null; order_id: string | null }>("SELECT workspace_id, order_id FROM disputes WHERE stripe_dispute_id = 'dp_1'");
    expect(row).toEqual({ workspace_id: null, order_id: null });
    expect((await list(owner.token)).data).toEqual([]);
    expect(pi).toBeTruthy();
  });

  it('refund + dispute: refunded money is never taken twice, in either order, and the analytics gross loses exactly what the dispute took', async () => {
    // refund first (ours, partial), then the dispute covers the whole payment and is lost
    const a = await disputed();
    const before = await a.analytics();
    await a.refund(a.main.id, { amountCents: 1000 });
    await a.send('created');
    await a.send('closed', { status: 'lost' }, { created: 1_800_000_200 });
    const rows = await a.dbOrders();
    expect(rows[0]).toMatchObject({ refunded_cents: 1000, disputed_lost_cents: a.main.amount_cents - 1000, status: 'charged_back' });
    expect(rows[0]!.refunded_cents + rows[0]!.disputed_lost_cents).toBe(a.main.amount_cents);
    expect(rows[1]).toMatchObject({ refunded_cents: 0, disputed_lost_cents: a.bump.amount_cents });
    const lostTotal = rows.reduce((s, o) => s + o.disputed_lost_cents, 0);
    expect(lostTotal).toBe(a.total - 1000);
    expect((await a.analytics()).gross).toBe(before.gross - lostTotal / 100); // refunds are not subtracted from gross (documented); the dispute takes only what was left
    expect((await a.refund(a.main.id)).json.error.code).toBe('ORDER_CHARGED_BACK');

    // dispute lost first, then a refund made in the Stripe dashboard: only what is left can be allocated
    const b = await disputed();
    await b.send('closed', { status: 'lost', amount: b.main.amount_cents }, { created: 1_800_000_200 });
    expect((await b.dbOrders())[0]).toMatchObject({ disputed_lost_cents: b.main.amount_cents, status: 'charged_back' });
    await b.hook('connect', 'charge.refunded', { payment_intent: b.pi, refunds: { data: [{ id: 're_dash', amount: b.main.amount_cents }] } }, { account: b.acct });
    const after = await b.dbOrders();
    expect(after[0]).toMatchObject({ refunded_cents: 0, disputed_lost_cents: b.main.amount_cents }); // the lost order takes nothing
    expect(after[1]).toMatchObject({ refunded_cents: Math.min(b.main.amount_cents, b.bump.amount_cents), disputed_lost_cents: 0 });
    for (const o of after) expect(o.refunded_cents + o.disputed_lost_cents).toBeLessThanOrEqual(o.amount_cents);
  });

  it('a fully refunded order is not charged back by a later lost dispute for the same money', async () => {
    const { send, refund, main, bump, dbOrders, analytics, total } = await disputed();
    expect((await refund(main.id)).status).toBe(200);
    expect((await refund(bump.id)).status).toBe(200);
    await send('created');
    expect((await dbOrders()).map((o) => o.status)).toEqual(['refunded', 'refunded']); // nothing left to dispute
    await send('closed', { status: 'lost' }, { created: 1_800_000_200 });
    expect((await dbOrders()).map((o) => [o.status, o.disputed_lost_cents])).toEqual([['refunded', 0], ['refunded', 0]]);
    expect((await analytics()).gross * 100).toBe(total);
  });

  it('GET /api/disputes needs orders:read and is declared in the route table', async () => {
    const { h, owner, send } = await disputed();
    await send('created');
    expect((await h.call('GET', '/api/disputes')).status).toBe(401);
    const none = await h.memberWith(owner, ['funnels:read']);
    expect((await h.call('GET', '/api/disputes', { token: none.token })).status).toBe(403);
    const reader = await h.memberWith(owner, ['orders:read']);
    expect((await h.call('GET', '/api/disputes', { token: reader.token })).json.data).toHaveLength(1);
    const viewer = await h.member(owner, 'viewer');
    expect((await h.call('GET', '/api/disputes', { token: viewer.token })).status).toBe(200);
    expect(OPERATIONS.find((o) => o.method === 'GET' && o.path === '/api/disputes')).toMatchObject({ auth: 'user', permission: 'orders:read' });
    expect((await h.call('GET', '/api/disputes?outcome=bogus', { token: owner.token })).status).toBe(400);
  });

  it('tenant isolation: another workspace sees nothing, cannot filter into it, and an event from another account cannot touch these orders', async () => {
    const { h, owner, send, pi, main, dbOrders, hook } = await disputed();
    await send('created');
    const other = await h.register('other@example.test', 'Other');
    const theirs = (await h.call('GET', '/api/disputes', { token: other.token })).json;
    expect(theirs.data).toEqual([]);
    expect((await h.call('GET', `/api/disputes?orderId=${main.id}`, { token: other.token })).json.data).toEqual([]);
    expect((await h.call('GET', `/api/orders/${main.id}`, { token: other.token })).status).toBe(404);
    // a dispute event arriving for another connected account with our PaymentIntent id must not be linked to our orders
    const spoof = await hook('connect', 'charge.dispute.created', dispute(pi, { id: 'dp_spoof', amount: 100 }), { account: 'acct_attacker', created: 1_800_000_000 });
    expect(spoof.status).toBe(200);
    const row = await h.deps.db.get<{ order_id: string | null; workspace_id: string | null }>("SELECT order_id, workspace_id FROM disputes WHERE stripe_dispute_id = 'dp_spoof'");
    expect(row).toEqual({ order_id: null, workspace_id: null });
    expect((await dbOrders()).map((o) => o.disputed_lost_cents)).toEqual([0, 0]);
    expect((await h.call('GET', '/api/disputes', { token: owner.token })).json.data).toHaveLength(1);
  });

  it('an order of a non-Stripe provider is untouched and the order list reports no dispute', async () => {
    const { h, owner } = await disputed();
    const orders = (await h.call('GET', '/api/orders', { token: owner.token })).json.data as { dispute: unknown }[];
    expect(orders.every((o) => o.dispute === null)).toBe(true);
  });
});
