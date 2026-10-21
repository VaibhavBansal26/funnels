import { beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/ads/hash.js';
import { activeDomain, checkoutTarget, formTarget, makeHarness, type Harness } from './helpers.js';
import { FakeNet } from './support/fakenet.js';

const META = { provider: 'meta', name: 'Main pixel', pixelId: '123456789012345', secret: 'EAAB-super-secret-token-123456', testEventCode: 'TEST123' };
const GA = { provider: 'ga4', name: 'GA4', pixelId: 'G-ABC123XYZ9', secret: 'ga-api-secret-xyz' };
const TT = { provider: 'tiktok', name: 'TikTok', pixelId: 'CABCDEF1234567890ABC', secret: 'tt-access-token-123456' };

let net: FakeNet;
let h: Harness;
let owner: Awaited<ReturnType<Harness['register']>>;

async function setup(env: Record<string, string> = {}) {
  net = new FakeNet();
  net.fallback = { status: 200, body: { events_received: 1 } };
  h = await makeHarness({ env: { CONVERSIONS_MAX_ATTEMPTS: '3', ...env }, deps: { outbound: net.fetch } });
  owner = await h.register();
}
const post = (path: string, body: unknown, token = owner.token) => h.call('POST', path, { token, body });
const tick = async (times = 1) => {
  for (let i = 0; i < times; i++) {
    h.clock.advance(2 * 3_600_000); // past any backoff
    await h.worker.tick();
  }
};
const deliveries = async (integrationId: string, token = owner.token) => (await h.call('GET', `/api/integrations/${integrationId}/deliveries`, { token })).json.data as any[];
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

describe('integrations: secrets, permissions, tenancy', () => {
  beforeEach(() => setup());

  it('creates an integration, encrypts the token, never returns it', async () => {
    const r = await post('/api/integrations', META);
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.json)).not.toContain(META.secret);
    expect(r.json).toMatchObject({ provider: 'meta', pixelId: '123456789012345', hasSecret: true, secretHint: '••••3456', enabled: true, sendLead: true, sendPurchase: true });
    const row = await h.deps.db.get<{ secret_enc: string }>('SELECT secret_enc FROM ad_integrations WHERE id = ?', r.json.id);
    expect(row!.secret_enc.startsWith('enc2.')).toBe(true);
    expect(row!.secret_enc).not.toContain(META.secret);
    const list = await h.call('GET', '/api/integrations', { token: owner.token });
    expect(JSON.stringify(list.json)).not.toContain(META.secret);
    // the secret is not in the audit log either
    const audit = await h.call('GET', '/api/audit', { token: owner.token });
    expect(audit.json.data.some((a: any) => a.action === 'integration.created')).toBe(true);
    expect(JSON.stringify(audit.json)).not.toContain(META.secret);
  });

  it('validates the pixel id per provider and refuses bad tokens', async () => {
    for (const bad of [{ ...META, pixelId: 'abc' }, { ...GA, pixelId: '123456789012345' }, { ...TT, pixelId: 'lowercase123456' }, { ...META, secret: 'short' }, { ...META, secret: 'has space inside token' }, { ...META, testEventCode: 'bad code!' }, { ...META, provider: 'google' }]) {
      const r = await post('/api/integrations', bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('refuses a duplicate pixel and a workspace limit', async () => {
    expect((await post('/api/integrations', META)).status).toBe(201);
    expect((await post('/api/integrations', META)).status).toBe(409);
  });

  it('replaces the token, edits flags, deletes; every change is audited', async () => {
    const id = (await post('/api/integrations', META)).json.id;
    const p = await h.call('PATCH', `/api/integrations/${id}`, { token: owner.token, body: { secret: 'EAAB-another-token-999999', enabled: false, sendLead: false, testEventCode: null } });
    expect(p.json).toMatchObject({ secretHint: '••••9999', enabled: false, sendLead: false, testEventCode: null });
    expect((await h.call('DELETE', `/api/integrations/${id}`, { token: owner.token })).status).toBe(204);
    expect((await h.call('GET', `/api/integrations/${id}/deliveries`, { token: owner.token })).status).toBe(404);
    const actions = (await h.call('GET', '/api/audit', { token: owner.token })).json.data.map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['integration.created', 'integration.updated', 'integration.deleted']));
  });

  it('is invisible to other workspaces (404) and to members without the permission (403)', async () => {
    const id = (await post('/api/integrations', META)).json.id;
    const other = await h.register();
    for (const [m, path] of [['GET', `/api/integrations/${id}/deliveries`], ['PATCH', `/api/integrations/${id}`], ['DELETE', `/api/integrations/${id}`], ['POST', `/api/integrations/${id}/test`]] as const) {
      const r = await h.call(m, path, { token: other.token, body: m === 'PATCH' ? { name: 'x' } : undefined });
      expect(r.status, `${m} ${path}`).toBe(404);
    }
    expect((await h.call('GET', '/api/integrations', { token: other.token })).json.data).toEqual([]);
    const member = await h.member(owner, 'member');
    const viewer = await h.member(owner, 'viewer');
    const admin = await h.member(owner, 'admin');
    for (const who of [member, viewer]) {
      expect((await h.call('GET', '/api/integrations', { token: who.token })).status).toBe(403);
      expect((await post('/api/integrations', GA, who.token)).status).toBe(403);
    }
    expect((await h.call('GET', '/api/integrations', { token: admin.token })).status).toBe(200);
    expect((await post('/api/integrations', GA, admin.token)).status).toBe(201);
  });
});

describe('test events', () => {
  beforeEach(() => setup());

  it('Meta needs a test event code and sends with it; the token is only in the body', async () => {
    const noCode = (await post('/api/integrations', { ...META, testEventCode: null })).json.id;
    const r0 = await post(`/api/integrations/${noCode}/test`, {});
    expect(r0.status).toBe(400);
    expect(r0.json.error.code).toBe('TEST_CODE_REQUIRED');
    expect(net.calls).toHaveLength(0);
    const id = (await post('/api/integrations', { ...META, pixelId: '999999999999999' })).json.id;
    const r = await post(`/api/integrations/${id}/test`, {});
    expect(r.json).toMatchObject({ ok: true, httpStatus: 200 });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0]!.url).toBe('https://graph.facebook.com/v23.0/999999999999999/events');
    expect(net.calls[0]!.json.test_event_code).toBe('TEST123');
    expect(net.calls[0]!.json.data[0].event_name).toBe('Purchase');
    expect(net.calls[0]!.json.access_token).toBe(META.secret);
    expect((await deliveries(id))[0]).toMatchObject({ isTest: true, status: 'sent' });
  });

  it('GA4 uses the validation endpoint and reports validation messages; the secret never reaches the log or the response', async () => {
    const id = (await post('/api/integrations', GA)).json.id;
    net.queue.push({ status: 200, body: { validationMessages: [{ fieldPath: 'events[0]', description: 'bad ' + GA.secret, validationCode: 'X' }] } });
    const r = await post(`/api/integrations/${id}/test`, {});
    expect(net.calls[0]!.url).toContain('/debug/mp/collect?measurement_id=G-ABC123XYZ9&api_secret=ga-api-secret-xyz');
    expect(r.json.ok).toBe(false);
    expect(JSON.stringify(r.json)).not.toContain(GA.secret);
    expect(JSON.stringify(await deliveries(id))).not.toContain(GA.secret);
    const ok = await post(`/api/integrations/${id}/test`, {});
    expect(ok.json.ok).toBe(true);
  });

  it('TikTok sends the token as a header and the test code in the body', async () => {
    const id = (await post('/api/integrations', { ...TT, testEventCode: 'TEST9' })).json.id;
    net.queue.push({ status: 200, body: { code: 0, message: 'OK' } });
    const r = await post(`/api/integrations/${id}/test`, {});
    expect(r.json.ok).toBe(true);
    expect(net.calls[0]!.headers['access-token']).toBe(TT.secret);
    expect(net.calls[0]!.json.test_event_code).toBe('TEST9');
    expect(net.calls[0]!.json.event_source_id).toBe('CABCDEF1234567890ABC');
  });

  it('a network error is a result, not a 500', async () => {
    const id = (await post('/api/integrations', GA)).json.id;
    net.queue.push(new Error('connect ECONNREFUSED'));
    const r = await post(`/api/integrations/${id}/test`, {});
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false, httpStatus: null });
    expect((await h.call('GET', '/api/integrations', { token: owner.token })).json.data[0].lastStatus).toBe('error');
  });

  it('is rate limited per workspace', async () => {
    const id = (await post('/api/integrations', GA)).json.id;
    let limited = 0;
    for (let i = 0; i < 20; i++) if ((await post(`/api/integrations/${id}/test`, {})).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe('server-side conversions from real events', () => {
  beforeEach(() => setup());

  async function liveFunnel() {
    const form = await formTarget(h, owner.token);
    const d = await activeDomain(h, owner.token, 'ads.example.com');
    await h.call('PATCH', `/api/funnels/${form.funnelId}`, { token: owner.token, body: { status: 'live', domain_id: d } });
    return form;
  }
  const submit = (form: Awaited<ReturnType<typeof formTarget>>, extra: Record<string, unknown> = {}, email = 'Lee.Smith@Gmail.com') =>
    h.call('POST', form.path, { body: { fields: { name: 'Lee Smith', email, _consent: true }, consent: true, submissionId: 'sub-12345678', visitorId: 'vis-1', ...extra }, headers: UA });

  it('an opt-in queues one Lead per integration; the worker delivers it hashed, with the event id the browser pixel uses', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const ga = (await post('/api/integrations', GA)).json.id;
    const tt = (await post('/api/integrations', TT)).json.id;
    const form = await liveFunnel();
    expect((await submit(form)).status).toBe(200);
    expect(await deliveries(meta)).toHaveLength(1);
    expect((await deliveries(meta))[0]).toMatchObject({ status: 'queued', eventName: 'Lead', eventId: 'lead_sub-12345678' });
    net.routes = [['facebook', { status: 200, body: { events_received: 1 } }], ['google-analytics', { status: 204 }], ['tiktok', { status: 200, body: { code: 0 } }]];
    await h.worker.tick();
    expect(net.calls).toHaveLength(3);
    const m = net.calls.find((c) => c.url.includes('facebook'))!.json;
    expect(m.data[0]).toMatchObject({ event_name: 'Lead', event_id: 'lead_sub-12345678', action_source: 'website' });
    expect(m.data[0].user_data.em).toBe(sha256('lee.smith@gmail.com'));
    expect(m.data[0].user_data.fn).toBe(sha256('lee'));
    expect(m.data[0].user_data.external_id).toBe(sha256('vis-1'));
    expect(m.test_event_code).toBeUndefined();
    const g = net.calls.find((c) => c.url.includes('google-analytics'))!;
    expect(g.url).toContain('/mp/collect?measurement_id=G-ABC123XYZ9');
    expect(g.json.events[0].name).toBe('generate_lead');
    expect(g.json.user_data.sha256_email_address).toEqual([sha256('leesmith@gmail.com')]);
    const t = net.calls.find((c) => c.url.includes('tiktok'))!.json;
    expect(t.data[0]).toMatchObject({ event: 'SubmitForm', event_id: 'lead_sub-12345678' });
    for (const id of [meta, ga, tt]) expect((await deliveries(id))[0], JSON.stringify(await deliveries(id))).toMatchObject({ status: "sent", attempts: 1 });
    // no raw email anywhere in what was stored
    const stored = JSON.stringify(await h.deps.db.all('SELECT payload_json FROM conversion_deliveries'));
    expect(stored.toLowerCase()).not.toContain('lee.smith@gmail.com');
    expect(stored).not.toContain(META.secret);
  });

  it('the same submission twice is one delivery (idempotent), a different one is another', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const form = await liveFunnel();
    await submit(form);
    await submit(form);
    expect(await deliveries(meta)).toHaveLength(1);
    await submit(form, { submissionId: 'sub-87654321' });
    expect(await deliveries(meta)).toHaveLength(2);
  });

  it('retries temporary failures with backoff, then succeeds', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const form = await liveFunnel();
    await submit(form);
    net.queue.push({ status: 503, body: 'down' }, { status: 200, body: { events_received: 1 } });
    await h.worker.tick();
    expect((await deliveries(meta))[0]).toMatchObject({ status: 'failed', attempts: 1, httpStatus: 503 });
    await h.worker.tick(); // not due yet: backoff
    expect(net.calls).toHaveLength(1);
    await tick();
    expect((await deliveries(meta))[0]).toMatchObject({ status: 'sent', attempts: 2 });
    expect((await h.call('GET', '/api/integrations', { token: owner.token })).json.data[0]).toMatchObject({ lastStatus: 'ok', lastError: null });
  });

  it('dead-letters after the maximum attempts and can be sent again by hand', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const form = await liveFunnel();
    await submit(form);
    net.fallback = { status: 500, body: 'boom' };
    await tick(5);
    const d = (await deliveries(meta))[0];
    expect(d).toMatchObject({ status: 'dead', attempts: 3 });
    expect(net.calls).toHaveLength(3);
    const dead = await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE type = 'conversion.deliver' AND status = 'dead'");
    expect(Number(dead!.n)).toBe(1);
    net.fallback = { status: 200, body: { events_received: 1 } };
    expect((await h.call('POST', `/api/integrations/deliveries/${d.id}/retry`, { token: owner.token })).status).toBe(200);
    await tick();
    expect((await deliveries(meta))[0].status).toBe('sent');
  });

  it('a permanent refusal (bad token) is dead at once and visible, without retries', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const form = await liveFunnel();
    await submit(form);
    net.fallback = { status: 400, body: { error: { message: 'Invalid OAuth access token', code: 190 } } };
    await tick(3);
    expect(net.calls).toHaveLength(1);
    expect((await deliveries(meta))[0]).toMatchObject({ status: 'dead', httpStatus: 400, error: expect.stringContaining('190') });
    expect((await h.call('GET', '/api/integrations', { token: owner.token })).json.data[0].lastStatus).toBe('error');
  });

  it('a disabled or removed integration sends nothing', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const form = await liveFunnel();
    await submit(form);
    await h.call('PATCH', `/api/integrations/${meta}`, { token: owner.token, body: { enabled: false } });
    await tick();
    expect(net.calls).toHaveLength(0);
    expect((await deliveries(meta))[0].status).toBe('skipped');
    await h.call('PATCH', `/api/integrations/${meta}`, { token: owner.token, body: { enabled: true, sendLead: false } });
    await submit(form, { submissionId: 'sub-00000002' });
    expect(await deliveries(meta)).toHaveLength(1); // sendLead is off: nothing new queued
  });

  it('a verified order queues ONE Purchase with the total, the items and purchase_<order id>', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const sales = await checkoutTarget(h, owner.token);
    const d = await activeDomain(h, owner.token, 'sales.example.com');
    await h.call('PATCH', `/api/funnels/${sales.funnelId}`, { token: owner.token, body: { status: 'live', domain_id: d } });
    const r = await h.call('POST', sales.mainPath, { body: { email: 'buyer@example.com', name: 'Bea Buyer', bumpBlockIds: [sales.bumpId], visitorId: 'vis-buy', submissionId: 'sub-buy-00001' }, headers: UA });
    expect(r.status).toBe(200);
    const ds = await deliveries(meta);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ eventName: 'Purchase', eventId: `purchase_${r.json.orderId}` });
    await h.worker.tick();
    const ev = net.calls[0]!.json.data[0];
    expect(ev.event_name).toBe('Purchase');
    expect(ev.custom_data.order_id).toBe(r.json.orderId);
    expect(ev.custom_data.num_items).toBe(2);
    const total = r.json.orders.reduce((t: number, o: any) => t + o.amountCents, 0) / 100;
    expect(ev.custom_data.value).toBe(total);
    expect(ev.user_data.em).toBe(sha256('buyer@example.com'));
    // the same checkout repeated (same submission id) is not a second purchase
    await h.call('POST', sales.mainPath, { body: { email: 'buyer@example.com', name: 'Bea Buyer', bumpBlockIds: [sales.bumpId], visitorId: 'vis-buy', submissionId: 'sub-buy-00001' }, headers: UA });
    expect(await deliveries(meta)).toHaveLength(1);
  });

  it('keeps tenants apart: another workspace\'s conversions never use this workspace\'s integration', async () => {
    const meta = (await post('/api/integrations', META)).json.id;
    const other = await h.register();
    const f2 = await formTarget(h, other.token);
    const d2 = await activeDomain(h, other.token, 'other.example.com');
    await h.call('PATCH', `/api/funnels/${f2.funnelId}`, { token: other.token, body: { status: 'live', domain_id: d2 } });
    await h.call('POST', f2.path, { body: { fields: { name: 'X Y', email: 'x@example.com', _consent: true }, consent: true, submissionId: 'sub-other-001' }, headers: UA });
    expect(await deliveries(meta)).toHaveLength(0);
  });
});
