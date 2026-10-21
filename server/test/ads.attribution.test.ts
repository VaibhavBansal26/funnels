import { beforeEach, describe, expect, it } from 'vitest';
import { activeDomain, checkoutTarget, formTarget, makeHarness, type Harness } from './helpers.js';
import { FakeNet } from './support/fakenet.js';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
let h: Harness;
let owner: Awaited<ReturnType<Harness['register']>>;
let net: FakeNet;

async function setup() {
  net = new FakeNet();
  h = await makeHarness({ env: { CONVERSIONS_MAX_ATTEMPTS: '3' }, deps: { outbound: net.fetch } });
  owner = await h.register();
}
async function liveForm() {
  const form = await formTarget(h, owner.token);
  const d = await activeDomain(h, owner.token, 'attr.example.com');
  await h.call('PATCH', `/api/funnels/${form.funnelId}`, { token: owner.token, body: { status: 'live', domain_id: d } });
  return form;
}
const touch = (form: { funnelId: string; stepId: string }, visitorId: string, t: unknown, ids: unknown = { consent: 'na' }, headers: Record<string, string> = UA) =>
  h.call('POST', '/api/public/attribution', { body: { funnelId: form.funnelId, stepId: form.stepId, visitorId, touch: t, ids }, headers });
const row = (visitor: string) => h.deps.db.get<any>('SELECT * FROM visitor_attribution WHERE visitor_id = ?', visitor);
const submit = (form: { path: string }, visitorId: string, email: string, sub: string) =>
  h.call('POST', form.path, { body: { fields: { name: 'A B', email, _consent: true }, consent: true, submissionId: sub, visitorId }, headers: UA });

describe('POST /api/public/attribution', () => {
  beforeEach(setup);

  it('records the first touch and keeps it, the last touch follows the newest', async () => {
    const f = await liveForm();
    expect((await touch(f, 'v1', { utm_source: 'Google', utm_medium: 'CPC', utm_campaign: 'Brand', clickIds: { gclid: 'Cj0KCQiA9999' } })).status).toBe(202);
    h.clock.advance(60_000);
    await touch(f, 'v1', { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'Retarget', utm_content: 'ad-9' });
    h.clock.advance(60_000);
    await touch(f, 'v1', {}); // direct visit: changes nothing
    const r = await row('v1');
    expect(r).toMatchObject({ first_source: 'google', first_medium: 'cpc', first_campaign: 'Brand', last_source: 'facebook', last_campaign: 'Retarget', last_content: 'ad-9' });
    expect(JSON.parse(r.first_json).clickIds).toEqual({ gclid: 'Cj0KCQiA9999' });
    expect(r.first_funnel_id).toBe(f.funnelId);
  });

  it('builds fbc from an fbclid and keeps browser ids only in valid shapes', async () => {
    const f = await liveForm();
    await touch(f, 'v2', { clickIds: { fbclid: 'IwAR0abcdEF' } }, { fbp: 'fb.1.1700000000000.123456789', ttp: 'bad ttp!', gaClientId: '1234567890.1700000000', consent: 'granted' });
    const r = await row('v2');
    expect(r.fbc).toBe(`fb.1.${h.clock.now().getTime()}.IwAR0abcdEF`);
    expect(r.fbp).toBe('fb.1.1700000000000.123456789');
    const ids = JSON.parse(r.ids_json);
    expect(ids).toEqual({ fbp: 'fb.1.1700000000000.123456789', fbc: r.fbc, gaClientId: '1234567890.1700000000', consent: 'granted' });
  });

  it('stores hostile values as inert, capped text', async () => {
    const f = await liveForm();
    await touch(f, 'v3', { utm_source: '<script>alert(1)</script>', utm_campaign: `${'x'.repeat(400)}\u0000‮`, utm_content: "'; DROP TABLE orders;--", clickIds: { gclid: '"><svg onload=1>' } });
    const r = await row('v3');
    expect(r.first_source).toBe('<script>alert(1)</script>'); // stored as data; the UI escapes
    expect(r.first_campaign).toHaveLength(100);
    expect(r.first_content).toBe("'; DROP TABLE orders;--");
    expect(JSON.parse(r.first_json).clickIds).toBeUndefined();
    expect((await h.deps.db.get<any>('SELECT COUNT(*) AS n FROM orders'))!.n).toBe(0);
  });

  it('ignores bots, previews, unknown funnels and malformed bodies without error leaks', async () => {
    const f = await liveForm();
    expect((await touch(f, 'bot1', { utm_source: 'x' }, {}, { 'user-agent': 'Googlebot/2.1' })).json).toMatchObject({ recorded: false, reason: 'bot' });
    expect(await row('bot1')).toBeUndefined();
    const prev = await h.call('POST', '/api/public/attribution', { body: { funnelId: f.funnelId, stepId: f.stepId, visitorId: 'p1', touch: { utm_source: 'x' }, preview: true }, headers: UA });
    expect(prev.json.reason).toBe('preview');
    expect((await touch({ funnelId: 'fn_nope', stepId: 'st_x' }, 'u1', { utm_source: 'x' })).json.reason).toBe('unknown_funnel');
    expect((await h.call('POST', '/api/public/attribution', { raw: '{nope', headers: { 'content-type': 'application/json', ...UA } })).status).toBe(400);
    expect((await h.call('POST', '/api/public/attribution', { body: { funnelId: f.funnelId, stepId: f.stepId, visitorId: 'bad id with spaces' }, headers: UA })).status).toBe(400);
    expect((await h.call('POST', '/api/public/attribution', { raw: 'x'.repeat(5000), headers: { 'content-type': 'application/json', ...UA } })).status).toBe(413);
  });

  it('a funnel id of another workspace cannot be used to write into this one', async () => {
    const f = await liveForm();
    const other = await h.register();
    const f2 = await formTarget(h, other.token);
    await touch(f2, 'vx', { utm_source: 'rival' });
    expect((await row('vx')).workspace_id).toBe(other.wsId);
    expect((await h.deps.db.all<any>('SELECT * FROM visitor_attribution WHERE workspace_id = ?', owner.wsId)).length).toBe(0);
    void f;
  });
});

describe('attribution on leads and orders', () => {
  beforeEach(setup);

  it('a lead gets the visitor\'s first and last touch; a later submission updates only the last', async () => {
    const f = await liveForm();
    await touch(f, 'v10', { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'A' });
    h.clock.advance(1000);
    await touch(f, 'v10', { utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'B' });
    await submit(f, 'v10', 'a@example.com', 'sub-aaaaaaa1');
    let lead = await h.deps.db.get<any>("SELECT * FROM leads WHERE email = 'a@example.com'");
    expect(lead).toMatchObject({ first_source: 'google', first_campaign: 'A', last_source: 'facebook', last_campaign: 'B' });
    expect(JSON.parse(lead.attribution_json).last.campaign).toBe('B');
    h.clock.advance(1000);
    await touch(f, 'v10', { utm_source: 'tiktok', utm_medium: 'paid_social', utm_campaign: 'C' });
    await submit(f, 'v10', 'a@example.com', 'sub-aaaaaaa2');
    lead = await h.deps.db.get<any>("SELECT * FROM leads WHERE email = 'a@example.com'");
    expect(lead).toMatchObject({ first_source: 'google', first_campaign: 'A', last_source: 'tiktok', last_campaign: 'C' });
  });

  it('a lead from a visitor never seen by the attribution endpoint has no attribution (direct)', async () => {
    const f = await liveForm();
    await submit(f, 'v11', 'b@example.com', 'sub-bbbbbbb1');
    const lead = await h.deps.db.get<any>("SELECT * FROM leads WHERE email = 'b@example.com'");
    expect(lead.first_source).toBeNull();
    expect(lead.attribution_json).toBeNull();
  });

  it('an order is stamped with both touches at purchase time', async () => {
    const sales = await checkoutTarget(h, owner.token);
    const d = await activeDomain(h, owner.token, 'attr2.example.com');
    await h.call('PATCH', `/api/funnels/${sales.funnelId}`, { token: owner.token, body: { status: 'live', domain_id: d } });
    const s = await h.deps.db.get<any>('SELECT id FROM steps WHERE funnel_id = ? ORDER BY position LIMIT 1', sales.funnelId);
    await touch({ funnelId: sales.funnelId, stepId: s.id }, 'v12', { utm_source: 'bing', utm_medium: 'cpc', utm_campaign: 'Shoes', clickIds: { msclkid: 'abcd1234ef' } });
    const r = await h.call('POST', sales.mainPath, { body: { email: 'c@example.com', name: 'C D', visitorId: 'v12', submissionId: 'sub-ccccccc1' }, headers: UA });
    expect(r.status).toBe(200);
    const o = await h.deps.db.get<any>('SELECT * FROM orders WHERE id = ?', r.json.orderId);
    expect(o).toMatchObject({ first_source: 'bing', first_campaign: 'Shoes', last_source: 'bing', last_medium: 'cpc' });
    // changing the visitor's touch afterwards does not rewrite history
    await touch({ funnelId: sales.funnelId, stepId: s.id }, 'v12', { utm_source: 'other' });
    expect((await h.deps.db.get<any>('SELECT last_source FROM orders WHERE id = ?', r.json.orderId)).last_source).toBe('bing');
  });
});

describe('consent and server-side conversions', () => {
  beforeEach(setup);
  const connect = () => h.call('POST', '/api/integrations', { token: owner.token, body: { provider: 'meta', name: 'm', pixelId: '123456789012345', secret: 'EAAB-secret-token-123456' } });

  it('with a consent banner in use, nothing is sent unless the visitor accepted', async () => {
    const f = await liveForm();
    await connect();
    const put = await h.call('PUT', `/api/funnels/${f.funnelId}/pixels`, { token: owner.token, body: { meta: { pixelId: '123456789012345' }, consent: { enabled: true } } });
    expect(put.status).toBe(200);
    await touch(f, 'ok1', { utm_source: 'x' }, { consent: 'granted' });
    await touch(f, 'no1', { utm_source: 'x' }, { consent: 'denied' });
    await touch(f, 'un1', { utm_source: 'x' }, { consent: 'unknown' });
    for (const [v, sub] of [['ok1', 'sub-consent01'], ['no1', 'sub-consent02'], ['un1', 'sub-consent03'], ['never-seen', 'sub-consent04']] as const) await submit(f, v, `${v}@example.com`, sub);
    const rows = await h.deps.db.all<any>('SELECT event_id, status, error FROM conversion_deliveries ORDER BY event_id');
    expect(rows.map((r) => [r.event_id, r.status])).toEqual([['lead_sub-consent01', 'queued'], ['lead_sub-consent02', 'skipped'], ['lead_sub-consent03', 'skipped'], ['lead_sub-consent04', 'skipped']]);
    expect(rows[1].error).toContain('not agreed');
    await h.worker.tick();
    expect(net.calls).toHaveLength(1);
  });

  it('without a banner, only an explicit refusal (Do Not Track, a decline) stops the conversion', async () => {
    const f = await liveForm();
    await connect();
    await touch(f, 'a1', { utm_source: 'x' }, { consent: 'na' });
    await touch(f, 'a2', { utm_source: 'x' }, { consent: 'denied' });
    await submit(f, 'a1', 'a1@example.com', 'sub-nobanner1');
    await submit(f, 'a2', 'a2@example.com', 'sub-nobanner2');
    await submit(f, 'a3', 'a3@example.com', 'sub-nobanner3'); // no attribution record at all
    const rows = await h.deps.db.all<any>('SELECT event_id, status FROM conversion_deliveries ORDER BY event_id');
    expect(rows.map((r) => r.status)).toEqual(['queued', 'skipped', 'queued']);
  });
});
