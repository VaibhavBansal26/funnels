import { describe, expect, it } from 'vitest';
import { checkoutTarget, formTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

async function setup() {
  const h = makeHarness();
  const u = await h.register();
  const f = await makeFunnel(h, u.token);
  const stepId = f.steps[0].id as string;
  const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
    h.call('POST', '/api/public/events', { body: raw === undefined ? body : undefined, raw, headers: { ...UA, ...headers } });
  const count = (type?: string) => h.deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM events ${type ? `WHERE type = '${type}'` : ''}`)!.n;
  return { h, u, f, stepId, post, count, view: (visitorId: string, extra: object = {}) => ({ funnelId: f.id, stepId, type: 'page_view', visitorId, ...extra }) };
}

describe('POST /api/public/events', () => {
  it('records a page view, deriving the workspace from the funnel', async () => {
    const { h, u, f, post, view } = await setup();
    const r = await post({ ...view('v-1'), workspaceId: 'ws_evil', utms: { source: 'google', medium: 'cpc' }, url: 'https://x.test/a' });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true, recorded: true });
    const row = h.deps.db.get<any>('SELECT * FROM events')!;
    expect(row).toMatchObject({ workspace_id: u.wsId, funnel_id: f.id, type: 'page_view', visitor_id: 'v-1', unique_visit: 1 });
    expect(JSON.parse(row.utm_json)).toEqual({ source: 'google', medium: 'cpc' });
  });

  it('decides uniqueness on the server, ignoring the client claim', async () => {
    const { h, post, view } = await setup();
    await post(view('v-1', { unique: false }));
    await post(view('v-1', { unique: true }));
    await post(view('v-2'));
    const flags = h.deps.db.all<{ unique_visit: number }>('SELECT unique_visit FROM events ORDER BY rowid').map((r) => r.unique_visit);
    expect(flags).toEqual([1, 0, 1]);
  });

  it('unknown, deleted and mismatched funnels/steps are ignored without error', async () => {
    const { h, u, f, stepId, post, count } = await setup();
    const other = await makeFunnel(h, u.token, { name: 'Other' });
    for (const body of [
      { funnelId: 'fn_nope', stepId, type: 'page_view', visitorId: 'v' },
      { funnelId: f.id, stepId: 'stp_nope', type: 'page_view', visitorId: 'v' },
      { funnelId: f.id, stepId: other.steps[0].id, type: 'page_view', visitorId: 'v' }, // step of another funnel
    ]) {
      const r = await post(body);
      expect([r.status, r.json]).toEqual([202, { ok: true, recorded: false, reason: 'unknown_funnel' }]);
    }
    await h.call('DELETE', `/api/funnels/${f.id}`, { token: u.token });
    expect((await post({ funnelId: f.id, stepId, type: 'page_view', visitorId: 'v' })).json.reason).toBe('unknown_funnel');
    expect(count()).toBe(0);
  });

  it('rejects malformed payloads with 400 and nothing is stored', async () => {
    const { post, count, stepId, f } = await setup();
    const bad: unknown[] = [
      null, [], 'str', {}, { funnelId: f.id },
      { funnelId: f.id, stepId, type: 'order', visitorId: 'v', amountCents: 99999 }, // browsers cannot report orders
      { funnelId: f.id, stepId, type: 'page_view', visitorId: 'has space' },
      { funnelId: f.id, stepId, type: 'page_view', visitorId: 'a'.repeat(65) },
      { funnelId: ['x'], stepId, type: 'page_view' },
      { funnelId: f.id, stepId, type: 'page_view', visitorId: 'v', url: 'x'.repeat(501) },
      { funnelId: f.id, stepId, type: 'optin', externalId: 'bad id!' },
    ];
    for (const body of bad) {
      const r = await post(body);
      expect([JSON.stringify(body).slice(0, 60), r.status]).toEqual([JSON.stringify(body).slice(0, 60), 400]);
    }
    expect((await post(undefined, {}, '{not json')).json.error.code).toBe('INVALID_JSON');
    expect((await post(undefined, {}, '')).status).toBe(400);
    expect(count()).toBe(0);
  });

  it('accepts text/plain bodies (sendBeacon)', async () => {
    const { post, view, count } = await setup();
    const r = await post(undefined, { 'content-type': 'text/plain;charset=UTF-8' }, JSON.stringify(view('v-9')));
    expect(r.status).toBe(202);
    expect(count('page_view')).toBe(1);
  });

  it('rejects oversized payloads with 413', async () => {
    const { post, view, count } = await setup();
    const r = await post(view('v-1', { utms: { source: 'x'.repeat(20_000) } }));
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(count()).toBe(0);
  });

  it('ignores bots, crawlers, tools and missing user agents', async () => {
    const { post, view, count } = await setup();
    for (const ua of ['Googlebot/2.1 (+http://www.google.com/bot.html)', 'Mozilla/5.0 (compatible; bingbot/2.0)', 'curl/8.4.0', 'python-requests/2.31', 'HeadlessChrome/120', 'Lighthouse', 'facebookexternalhit/1.1', 'Wget/1.21', '']) {
      const r = await post(view('v-bot'), { 'user-agent': ua });
      expect([ua, r.status, r.json.reason]).toEqual([ua, 202, 'bot']);
    }
    expect(count()).toBe(0);
    expect((await post(view('v-human'))).json.recorded).toBe(true);
  });

  it('is idempotent for opt-ins with the same externalId and never reuses ids across funnels', async () => {
    const { h, u, f, stepId, post, count } = await setup();
    const optin = (id?: string) => ({ funnelId: f.id, stepId, type: 'optin', visitorId: 'v', ...(id ? { externalId: id } : {}) });
    expect((await post(optin('resp-1'))).json.recorded).toBe(true);
    const dup = await post(optin('resp-1'));
    expect(dup.json).toEqual({ ok: true, recorded: false, reason: 'duplicate' });
    expect((await post(optin('resp-2'))).json.recorded).toBe(true);
    expect((await post(optin())).json.recorded).toBe(true);
    expect((await post(optin())).json.recorded).toBe(true); // no id: cannot dedupe
    expect(count('optin')).toBe(4);
    const other = await makeFunnel(h, u.token, { name: 'Other' });
    expect((await post({ funnelId: other.id, stepId: other.steps[0].id, type: 'optin', externalId: 'resp-1' })).json.recorded).toBe(true);
  });

  it('preview traffic and page views without a visitor are not recorded', async () => {
    const { post, view, count, f, stepId } = await setup();
    expect((await post(view('v', { preview: true }))).json.reason).toBe('preview');
    expect((await post({ funnelId: f.id, stepId, type: 'page_view' })).json.reason).toBe('no_visitor');
    expect(count()).toBe(0);
  });

  it('rate limits per IP and funnel with 429 + Retry-After, independent between IPs and funnels', async () => {
    const h = makeHarness({ env: { PUBLIC_EVENTS_PER_MINUTE: '5' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const g = await makeFunnel(h, u.token, { name: 'G' });
    const send = (funnel: any, ip: string) => h.call('POST', '/api/public/events', { body: { funnelId: funnel.id, stepId: funnel.steps[0].id, type: 'page_view', visitorId: 'v' }, headers: { ...UA, 'x-forwarded-for': ip } });
    for (let i = 0; i < 5; i++) expect((await send(f, '198.51.100.1')).status).toBe(202);
    const limited = await send(f, '198.51.100.1');
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await send(f, '198.51.100.2')).status).toBe(202);
    expect((await send(g, '198.51.100.1')).status).toBe(202);
    h.clock.advance(13_000);
    expect((await send(f, '198.51.100.1')).status).toBe(202); // tokens refill
  });

  it('answers CORS preflight and sets permissive CORS only for the public API', async () => {
    const { h } = await setup();
    const pre = await h.app.request('/api/public/events', { method: 'OPTIONS', headers: { origin: 'https://customer.example' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    const priv = await h.app.request('/api/funnels', { headers: { origin: 'https://evil.example' } });
    expect(priv.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('public forms', () => {
  const fields = { name: 'Ada Lovelace', email: 'Ada@Example.com' };
  const submit = (h: Harness, t: { path: string }, body: unknown, headers: Record<string, string> = {}) => h.call('POST', t.path, { body, headers: { ...UA, ...headers } });

  it('creates a lead, an opt-in event, a notification and fires the webhook', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await formTarget(h, u.token);
    await h.call('POST', '/api/webhooks', { token: u.token, body: { url: 'https://hooks.example.com/in', events: ['funnel.optin'] } });
    const r = await submit(h, t, { fields: { ...fields, _consent: true }, consent: true, visitorId: 'v1', submissionId: 'sub-0001-abcd' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, recorded: true });
    const leads = (await h.call('GET', '/api/leads', { token: u.token })).json.data;
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ email: 'ada@example.com', name: 'Ada Lovelace', submissions: 1, firstFunnelId: t.funnelId });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM events WHERE type = ?', 'optin')).toEqual({ n: 1 });
    const notes = (await h.call('GET', '/api/notifications', { token: u.token })).json;
    expect(notes.unread).toBe(1);
    expect(notes.data[0]).toMatchObject({ type: 'new_lead', title: 'New lead' });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM jobs WHERE type = ?', 'webhook.deliver')).toEqual({ n: 1 });
  });

  it('dedupes leads by email within a workspace (case-insensitive) but not across workspaces', async () => {
    const h = makeHarness();
    const a = await h.register();
    const b = await h.register();
    const ta = await formTarget(h, a.token);
    const tb = await formTarget(h, b.token);
    await submit(h, ta, { fields: { ...fields, _consent: true }, consent: true });
    await submit(h, ta, { fields: { name: 'Ada L.', email: 'ADA@example.com', _consent: true }, consent: true });
    await submit(h, tb, { fields: { ...fields, _consent: true }, consent: true });
    const la = (await h.call('GET', '/api/leads', { token: a.token })).json.data;
    expect(la).toHaveLength(1);
    expect(la[0]).toMatchObject({ name: 'Ada L.', submissions: 2 });
    expect((await h.call('GET', '/api/leads', { token: b.token })).json.data).toHaveLength(1);
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM events WHERE type = ?', 'optin')).toEqual({ n: 3 });
  });

  it('is idempotent for the same submission id', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const body = { fields: { ...fields, _consent: true }, consent: true, submissionId: 'sub-12345678' };
    expect((await submit(h, t, body)).json.recorded).toBe(true);
    expect((await submit(h, t, body)).json).toMatchObject({ recorded: false, duplicate: true });
    expect((await h.call('GET', '/api/leads', { token: u.token })).json.data[0].submissions).toBe(1);
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM events WHERE type = ?', 'optin')).toEqual({ n: 1 });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM notifications')).toEqual({ n: 1 });
  });

  it('honeypot: pretends success and stores nothing', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const r = await submit(h, t, { fields: { ...fields }, _hp: 'http://spam.example', consent: true });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, recorded: false });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM leads')).toEqual({ n: 0 });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM events')).toEqual({ n: 0 });
  });

  it('validates against the block definition: required, formats, lengths, options, consent', async () => {
    const h = makeHarness();
    const u = await h.register();
    const f = (await h.call('POST', '/api/templates/book-a-call/use', { token: u.token })).json;
    const doc = h.deps.db.get<{ doc_json: string }>('SELECT doc_json FROM step_pages WHERE step_id = ?', f.steps[0].id)!.doc_json;
    const block = /"id":"(bc\d+)","type":"form"/.exec(doc)![1];
    const t = { path: `/api/public/forms/${f.id}/${f.steps[0].id}/${block}` };
    const ok = { name: 'Ada', email: 'ada@example.com', phone: '+1 (555) 010-9999', topic: 'More leads', notes: 'hello', _consent: true };
    const errs = async (over: object, consent: unknown = true) => {
      const r = await submit(h, t, { fields: { ...ok, ...over }, consent });
      return r.status === 422 ? Object.keys(r.json.error.details.fields) : r.status;
    };
    expect(await errs({})).toBe(200);
    expect(await errs({ email: '' })).toEqual(['email']);
    expect(await errs({ email: 'not-an-email' })).toEqual(['email']);
    expect(await errs({ email: 'a@b' })).toEqual(['email']);
    expect(await errs({ email: `${'a'.repeat(250)}@example.com` })).toEqual(['email']);
    expect(await errs({ name: '' })).toEqual(['name']);
    expect(await errs({ name: 'x'.repeat(256) })).toEqual(['name']);
    expect(await errs({ phone: 'abc' })).toEqual(['phone']);
    expect(await errs({ phone: '123' })).toEqual(['phone']);
    expect(await errs({ phone: '' })).toBe(200); // optional
    expect(await errs({ topic: 'Not an option' })).toEqual(['topic']);
    expect(await errs({ topic: '' })).toEqual(['topic']); // required select
    expect(await errs({ notes: 'x'.repeat(5001) })).toEqual(['notes']);
    expect(await errs({}, false)).toEqual(['_consent']);
    expect(await errs({ unexpected: 'dropped', topic: 'More leads' })).toBe(200); // unknown keys ignored
    const stored = JSON.parse(h.deps.db.get<{ data_json: string }>('SELECT data_json FROM leads')!.data_json);
    expect(stored).not.toHaveProperty('unexpected');
  });

  it('accepts url-encoded form posts (no-JS fallback) and rejects bad bodies', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const r = await h.call('POST', t.path, { raw: 'name=Ada&email=ada%40example.com&_consent=yes', headers: { ...UA, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(200);
    expect(r.json.recorded).toBe(true);
    expect((await h.call('POST', t.path, { raw: '{oops', headers: UA })).status).toBe(400);
    expect((await h.call('POST', t.path, { raw: JSON.stringify({ fields: { email: 'x'.repeat(70_000) } }), headers: UA })).status).toBe(413);
  });

  it('unknown funnel/step/block and wrong block type are 404', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const body = { fields: { ...fields, _consent: true }, consent: true };
    for (const path of [`/api/public/forms/nope/${t.stepId}/${t.blockId}`, `/api/public/forms/${t.funnelId}/nope/${t.blockId}`, `/api/public/forms/${t.funnelId}/${t.stepId}/nope`]) {
      expect((await submit(h, { path }, body)).status).toBe(404);
    }
    expect((await h.call('POST', `/api/public/checkout/${t.funnelId}/${t.stepId}/${t.blockId}`, { body: { email: 'a@b.co' }, headers: UA })).status).toBe(404); // a form is not a checkout
    await h.call('DELETE', `/api/funnels/${t.funnelId}`, { token: u.token });
    expect((await submit(h, t, body)).status).toBe(404);
  });

  it('preview submissions are accepted but not recorded; rate limited per IP', async () => {
    const h = makeHarness({ env: { PUBLIC_FORMS_PER_MINUTE: '3' } });
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const r = await submit(h, t, { fields: { ...fields, _consent: true }, consent: true, preview: true });
    expect(r.json).toEqual({ ok: true, recorded: false });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM leads')).toEqual({ n: 0 });
    await submit(h, t, { fields: {} });
    expect((await submit(h, t, { fields: {} })).status).toBe(422);
    const limited = await submit(h, t, { fields: {} });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });
});

describe('public checkout (mock payment provider)', () => {
  const buy = (h: Harness, path: string, body: unknown) => h.call('POST', path, { body, headers: UA });

  it('records orders for the main offer and a selected bump, and prices come from the stored block', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const r = await buy(h, t.mainPath, { email: 'Buyer@Example.com', name: 'Bea', bumpBlockIds: [t.bumpId], amountCents: 1, price: 0.01, visitorId: 'v1', submissionId: 'sub-order-1' });
    expect(r.status).toBe(200);
    expect(r.json.orders.map((o: any) => [o.productName, o.amountCents, o.isBump])).toEqual([['Email Marketing Masterclass', 9700, false], ['Done-for-you subject line pack', 1700, true]]);
    const orders = (await h.call('GET', '/api/orders', { token: u.token })).json.data;
    expect(orders).toHaveLength(2);
    expect(orders[0]).toMatchObject({ email: 'buyer@example.com', provider: 'mock' });
    expect(h.deps.db.get('SELECT COUNT(*) AS n, SUM(amount_cents) AS s FROM events WHERE type = ?', 'order')).toEqual({ n: 2, s: 11400 });
    expect((await h.call('GET', '/api/leads', { token: u.token })).json.data).toHaveLength(1); // buyers are leads too
    expect((await h.call('GET', '/api/notifications', { token: u.token })).json.data.filter((n: any) => n.type === 'new_sale')).toHaveLength(2);
  });

  it('is idempotent per submission id', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const body = { email: 'b@example.com', bumpBlockIds: [t.bumpId], submissionId: 'sub-order-2' };
    const first = await buy(h, t.mainPath, body);
    const second = await buy(h, t.mainPath, body);
    expect(second.json).toMatchObject({ duplicate: true, recorded: false, orderId: first.json.orderId });
    expect(second.json.orders).toHaveLength(2);
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM orders')).toEqual({ n: 2 });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM events WHERE type = ?', 'order')).toEqual({ n: 2 });
  });

  it('declined cards record nothing', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const r = await buy(h, t.mainPath, { email: 'decline@example.com' });
    expect(r.status).toBe(402);
    expect(r.json.error).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'card_declined' } });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM orders')).toEqual({ n: 0 });
  });

  it('validates email, bumps and honeypot; bumps cannot be bought alone', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    expect((await buy(h, t.mainPath, { email: 'nope' })).status).toBe(422);
    expect((await buy(h, t.mainPath, {})).status).toBe(422);
    expect((await buy(h, t.mainPath, { email: 'a@b.co', bumpBlockIds: ['nope'] })).json.error.code).toBe('INVALID_BUMP');
    const bumpPath = `/api/public/checkout/${t.funnelId}/${t.salesStepId}/${t.bumpId}`;
    expect((await buy(h, bumpPath, { email: 'a@b.co' })).json.error.code).toBe('NOT_PURCHASABLE');
    expect((await buy(h, t.mainPath, { email: 'a@b.co', _hp: 'bot' })).json).toMatchObject({ recorded: false });
    expect((await buy(h, t.mainPath, { email: 'a@b.co', preview: true })).json).toMatchObject({ recorded: false });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM orders')).toEqual({ n: 0 });
  });

  it('one-click upsell reuses the identity of an earlier order in the same funnel only', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await checkoutTarget(h, u.token);
    const main = await buy(h, t.mainPath, { email: 'buyer@example.com', name: 'Bea' });
    expect((await buy(h, t.upsellPath, {})).json.error.code).toBe('PREVIOUS_ORDER_REQUIRED');
    expect((await buy(h, t.upsellPath, { previousOrderId: 'ord_nope' })).json.error.code).toBe('PREVIOUS_ORDER_REQUIRED');
    const up = await buy(h, t.upsellPath, { previousOrderId: main.json.orderId, email: 'someone-else@example.com' });
    expect(up.status).toBe(200);
    const row = h.deps.db.get<any>('SELECT * FROM orders WHERE is_upsell = 1')!;
    expect(row).toMatchObject({ email: 'buyer@example.com', name: 'Bea', parent_order_id: main.json.orderId, amount_cents: 9700 });
    // an order of another workspace's funnel cannot be referenced
    const other = await h.register();
    const t2 = await checkoutTarget(h, other.token);
    const foreign = await buy(h, t2.mainPath, { email: 'x@example.com' });
    expect((await buy(h, t.upsellPath, { previousOrderId: foreign.json.orderId })).json.error.code).toBe('PREVIOUS_ORDER_REQUIRED');
  });
});
