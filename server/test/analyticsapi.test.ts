import { createHmac } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { enumerateIntervals, intervalStart, summarizeDoc } from '../src/services/analyticsapi.js';
import { insertEvents, type EventInsert } from '../src/services/rollups.js';
import { newId } from '../src/util/ids.js';
import { activeDomain, checkoutTarget, formTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' };
const DESKTOP = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

const world = async (env: Record<string, string> = {}) => {
  const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', ANALYTICS_API_PER_MINUTE: '100000', ANALYTICS_EXPORT_PER_MINUTE: '100000', ...env } });
  const owner = await h.register();
  const mk = async (body: Record<string, unknown> = {}) => {
    const r = await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'k', scopes: ['analytics:read', 'analytics:export'], ...body } });
    if (r.status !== 201) throw new Error(`key failed: ${r.text}`);
    return { key: r.json.key as string, id: r.json.apiKey.id as string };
  };
  const key = await mk();
  const get = (path: string, k = key.key, headers: Record<string, string> = {}) => h.call('GET', `/api/v1/analytics${path}`, { token: k, headers });
  return { h, owner, mk, key, get };
};

/** Events through the production write path including the first-view ledger (visitor_steps), so exit rates and unique counts are real. */
async function seed(h: Harness, rows: (Pick<EventInsert, 'workspace_id' | 'funnel_id' | 'step_id'> & Partial<EventInsert>)[]) {
  let n = 0;
  const full: EventInsert[] = rows.map((r) => ({ id: newId('evt') + String(++n), type: 'page_view', visitor_id: null, unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null, created_at: '2026-03-10T12:00:00.000Z', ...r }));
  await h.deps.db.transaction((tx) => insertEvents(tx, full, { decideUnique: true }));
}

const ndjson = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('API keys', () => {
  it('the secret is shown once at creation; the list shows prefix, scopes and last use, never the secret; only a hash is stored', async () => {
    const { h, owner, key, get } = await world();
    expect(key.key).toMatch(/^fa_live_[A-Za-z0-9_-]{32}$/);
    const list = (await h.call('GET', '/api/v1/api-keys', { token: owner.token })).json.data as { id: string; prefix: string; lastUsedAt: string | null }[];
    expect(list[0]).toMatchObject({ prefix: key.key.slice(0, 12), scopes: ['analytics:read', 'analytics:export'] });
    expect(JSON.stringify(list)).not.toContain(key.key);
    expect(list[0]!.lastUsedAt).toBeNull();
    expect((await get('/funnels')).status).toBe(200);
    const after = (await h.call('GET', '/api/v1/api-keys', { token: owner.token })).json.data as { lastUsedAt: string | null }[];
    expect(after[0]!.lastUsedAt).not.toBeNull();
    const row = await h.deps.db.get<{ key_hash: string }>('SELECT key_hash FROM api_keys');
    expect(row!.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.key_hash).not.toContain(key.key);
  });

  it('a revoked, expired, malformed or unknown key all get the same 401; user tokens are not keys and keys are not user tokens', async () => {
    const { h, owner, mk, get } = await world();
    const revoked = await mk();
    await h.call('DELETE', `/api/v1/api-keys/${revoked.id}`, { token: owner.token });
    const expiring = await mk({ expiresAt: new Date(h.clock.now().getTime() + 3600_000).toISOString() });
    expect((await get('/funnels', expiring.key)).status).toBe(200);
    h.clock.advance(2 * 3600_000);
    const bodies = [] as string[];
    for (const k of [revoked.key, expiring.key, 'fa_live_' + 'x'.repeat(32), 'not-a-key', owner.token, '']) {
      const r = await get('/funnels', k);
      expect(r.status, k.slice(0, 14)).toBe(401);
      bodies.push(r.text);
    }
    expect(new Set(bodies).size).toBe(1);
    const fresh = await mk();
    expect((await h.call('GET', '/api/funnels', { token: fresh.key })).status).toBe(401); // a key does not open the app API
    expect((await h.call('GET', '/api/v1/api-keys', { token: fresh.key })).status).toBe(401);
  });

  it('scopes: a read-only key cannot export; an export-only key cannot read', async () => {
    const { mk, get } = await world();
    const readOnly = await mk({ scopes: ['analytics:read'] });
    const exportOnly = await mk({ scopes: ['analytics:export'] });
    expect((await get('/funnels', readOnly.key)).status).toBe(200);
    const denied = await get('/export/events', readOnly.key);
    expect(denied.status).toBe(403);
    expect(denied.json.error.message).toContain('analytics:export');
    expect((await get('/export/events', exportOnly.key)).status).toBe(200);
    expect((await get('/funnels', exportOnly.key)).status).toBe(403);
  });

  it('an IP allow-list (addresses and CIDR ranges) refuses other addresses with 403', async () => {
    const { mk, get } = await world({ TRUST_PROXY: 'true', TRUSTED_PROXY_HOPS: '1' });
    const exact = await mk({ ipAllowlist: ['198.51.100.7'] });
    const range = await mk({ ipAllowlist: ['203.0.113.0/24', '2001:db8::/32'] });
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    expect((await get('/funnels', exact.key, from('198.51.100.7'))).status).toBe(200);
    expect((await get('/funnels', exact.key, from('198.51.100.8'))).status).toBe(403);
    expect((await get('/funnels', range.key, from('203.0.113.200'))).status).toBe(200);
    expect((await get('/funnels', range.key, from('203.0.114.1'))).status).toBe(403);
    expect((await get('/funnels', range.key, from('2001:db8:1::5'))).status).toBe(200);
    expect((await get('/funnels', range.key, from('2001:db9::1'))).status).toBe(403);
  });

  it('input is validated, and a user cannot create a key that can do more than they can', async () => {
    const { h, owner } = await world();
    const post = (token: string, body: unknown) => h.call('POST', '/api/v1/api-keys', { token, body });
    expect((await post(owner.token, { name: 'x', scopes: [] })).status).toBe(400);
    expect((await post(owner.token, { name: 'x', scopes: ['everything'] })).status).toBe(400);
    expect((await post(owner.token, { name: 'x', scopes: ['analytics:read'], ipAllowlist: ['not-an-ip'] })).status).toBe(400);
    expect((await post(owner.token, { name: 'x', scopes: ['analytics:read'], ipAllowlist: ['10.0.0.0/33'] })).status).toBe(400);
    expect((await post(owner.token, { name: 'x', scopes: ['analytics:read'], expiresAt: '2020-01-01T00:00:00Z' })).json.error.code).toBe('INVALID_EXPIRY');
    const mgr = await h.memberWith(owner, ['api_keys:manage', 'analytics:read']);
    expect((await post(mgr.token, { name: 'x', scopes: ['analytics:read'] })).status).toBe(201);
    const noExport = await post(mgr.token, { name: 'x', scopes: ['analytics:read', 'analytics:export'] });
    expect(noExport.status).toBe(403);
    expect(noExport.json.error.message).toContain('analytics:export');
  });

  it('rename, set expiry and allow-list; revoked keys cannot be changed; other workspaces cannot see or touch keys; everything is audited', async () => {
    const { h, owner, key } = await world();
    const other = await h.register();
    const patched = await h.call('PATCH', `/api/v1/api-keys/${key.id}`, { token: owner.token, body: { name: 'Intelligence', ipAllowlist: ['203.0.113.9'] } });
    expect(patched.json).toMatchObject({ name: 'Intelligence', ipAllowlist: ['203.0.113.9'] });
    expect((await h.call('PATCH', `/api/v1/api-keys/${key.id}`, { token: other.token, body: { name: 'mine now' } })).status).toBe(404);
    expect((await h.call('DELETE', `/api/v1/api-keys/${key.id}`, { token: other.token })).status).toBe(404);
    expect(((await h.call('GET', '/api/v1/api-keys', { token: other.token })).json.data as unknown[]).length).toBe(0);
    await h.call('DELETE', `/api/v1/api-keys/${key.id}`, { token: owner.token });
    expect((await h.call('PATCH', `/api/v1/api-keys/${key.id}`, { token: owner.token, body: { name: 'x' } })).json.error.code).toBe('API_KEY_REVOKED');
    const actions = (await h.deps.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'api_key.%' ORDER BY created_at, id")).map((a) => a.action);
    expect(actions).toEqual(['api_key.created', 'api_key.updated', 'api_key.revoked']);
    expect(JSON.stringify(await h.deps.db.all('SELECT detail_json FROM audit_log'))).not.toContain(key.key);
  });

  it('live keys see live funnels, test keys see test funnels; other modes and other workspaces are 404', async () => {
    const { h, owner, mk, get } = await world();
    const live = await mk({ mode: 'live' });
    const test = await mk({ mode: 'test' });
    expect(test.key).toMatch(/^fa_test_/);
    const f = await makeFunnel(h, owner.token, { name: 'Draft' }); // new funnels start in test mode
    const ids = async (k: string) => ((await get('/funnels', k)).json.data as { id: string; status: string }[]);
    expect((await ids(live.key)).map((x) => x.id)).not.toContain(f.id);
    expect((await ids(test.key)).map((x) => x.id)).toContain(f.id);
    expect((await get(`/funnels/${f.id}/steps`, live.key)).status).toBe(404);
    expect((await get(`/funnels/${f.id}/steps`, test.key)).status).toBe(200);
    const other = await h.register();
    const theirs = await makeFunnel(h, other.token, { name: 'Theirs' });
    expect((await get(`/funnels/${theirs.id}/steps`, test.key)).status).toBe(404);
    expect((await ids(test.key)).map((x) => x.id)).not.toContain(theirs.id);
  });
});

let hostCounter = 0;
async function goLive(h: Harness, token: string, funnelId: string) {
  const domainId = await activeDomain(h, token, `offers${++hostCounter}.example.com`);
  const r = await h.call('PATCH', `/api/funnels/${funnelId}`, { token, body: { status: 'live', domain_id: domainId } });
  if (r.status !== 200) throw new Error(`go live failed: ${r.text}`);
}

async function liveFunnel(h: Harness, token: string, name = 'Spring launch') {
  const f = await makeFunnel(h, token, { name });
  await goLive(h, token, f.id);
  const second = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token, body: { name: 'Offer', base_path: '/offer' } })).json;
  return { id: f.id as string, s1: f.steps[0].id as string, s2: second.id as string };
}

describe('funnels, steps and time series', () => {
  it('lists funnels with totals, rates and the entry-step unique count; cursor pagination is complete and ordered', async () => {
    const { h, owner, mk, get } = await world();
    const a = await liveFunnel(h, owner.token, 'A');
    const b = await liveFunnel(h, owner.token, 'B');
    const ws = owner.wsId;
    const at = (d: string) => `2026-03-${d}T10:00:00.000Z`;
    await seed(h, [
      { workspace_id: ws, funnel_id: a.id, step_id: a.s1, visitor_id: 'v1', created_at: at('10') }, { workspace_id: ws, funnel_id: a.id, step_id: a.s1, visitor_id: 'v1', created_at: at('10') },
      { workspace_id: ws, funnel_id: a.id, step_id: a.s1, visitor_id: 'v2', created_at: at('11') }, { workspace_id: ws, funnel_id: a.id, step_id: a.s2, visitor_id: 'v1', created_at: at('11') },
      { workspace_id: ws, funnel_id: a.id, step_id: a.s2, visitor_id: 'v1', type: 'optin', created_at: at('11') },
      { workspace_id: ws, funnel_id: a.id, step_id: a.s2, visitor_id: 'v1', type: 'order', amount_cents: 4700, currency: 'USD', created_at: at('11') },
      { workspace_id: ws, funnel_id: b.id, step_id: b.s1, visitor_id: 'v9', created_at: at('12') },
    ]);
    const q = '?from=2026-03-01&to=2026-03-31';
    const list = (await get(`/funnels${q}`)).json as { data: Record<string, unknown>[]; next_cursor: string | null };
    expect(list.next_cursor).toBeNull();
    const row = list.data.find((r) => r.id === a.id)!;
    expect(row).toMatchObject({ name: 'A', status: 'live', steps_count: 2, visits: 4, unique_visits: 2, optins: 1, orders: 1, gross: 47, currency: null }); // currency comes from the orders table; these events were seeded directly
    expect(row.optin_rate).toBe(0.5); // 1 opt-in / 2 unique entry visitors
    expect(row.earnings_per_view).toBe(11.75); // 47 / 4 page views
    expect(list.data.find((r) => r.id === b.id)).toMatchObject({ visits: 1, orders: 0, gross: 0, currency: null, earnings_per_view: 0 });
    // outside the range: zero
    const none = ((await get('/funnels?from=2025-01-01&to=2025-01-31')).json.data as { visits: number }[]);
    expect(none.every((r) => r.visits === 0)).toBe(true);
    // pagination, one at a time
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 5; i++) {
      const p = (await get(`/funnels?limit=1${cursor ? `&cursor=${cursor}` : ''}`)).json as { data: { id: string }[]; next_cursor: string | null };
      seen.push(...p.data.map((d) => d.id));
      if (!p.next_cursor) break;
      cursor = p.next_cursor;
    }
    expect(seen).toEqual([a.id, b.id].sort());
    expect((await get('/funnels?cursor=garbage')).json.error.code).toBe('INVALID_CURSOR');
    expect((await get('/funnels?limit=1001')).status).toBe(400);
    void mk;
  });

  it('steps: totals per step, unique first views, rates, and the exit rate from the first-view ledger (null for the last step)', async () => {
    const { h, owner, get } = await world();
    const f = await liveFunnel(h, owner.token);
    const ws = owner.wsId;
    const ev = (step: string, v: string, extra: Partial<EventInsert> = {}) => ({ workspace_id: ws, funnel_id: f.id, step_id: step, visitor_id: v, created_at: '2026-03-10T10:00:00.000Z', ...extra });
    // 4 visitors see step 1; 3 of them go on to step 2; 1 buys
    await seed(h, [ev(f.s1, 'a'), ev(f.s1, 'b'), ev(f.s1, 'c'), ev(f.s1, 'd'), ev(f.s2, 'a'), ev(f.s2, 'b'), ev(f.s2, 'c'), ev(f.s2, 'a', { type: 'order', amount_cents: 1000, currency: 'USD' }), ev(f.s1, 'a', { type: 'optin' })]);
    const steps = (await get(`/funnels/${f.id}/steps?from=2026-03-10&to=2026-03-10`)).json as { data: Record<string, unknown>[]; next_cursor: null };
    expect(steps.next_cursor).toBeNull();
    expect(steps.data).toHaveLength(2);
    expect(steps.data[0]).toMatchObject({ order: 1, visits: 4, unique_visits: 4, optins: 1, optin_rate: 0.25, orders: 0, avg_time_on_page_s: null });
    expect(steps.data[0]!.exit_rate).toBe(0.25); // d never reached step 2
    expect(steps.data[1]).toMatchObject({ order: 2, visits: 3, unique_visits: 3, orders: 1, gross: 10, exit_rate: null });
  });

  it('time series: zero-filled points in the requested interval; day buckets follow the time zone; week starts Monday; month is the local month', async () => {
    const { h, owner, get } = await world();
    const f = await liveFunnel(h, owner.token);
    const ws = owner.wsId;
    const ev = (at: string, extra: Partial<EventInsert> = {}) => ({ workspace_id: ws, funnel_id: f.id, step_id: f.s1, visitor_id: `v-${at}`, created_at: at, ...extra });
    await seed(h, [ev('2026-03-10T03:30:00.000Z'), ev('2026-03-10T09:00:00.000Z'), ev('2026-03-12T23:45:00.000Z'), ev('2026-03-12T23:45:00.000Z', { type: 'order', amount_cents: 2500, currency: 'USD' })]);
    const ts = async (query: string) => (await get(`/funnels/${f.id}/timeseries?${query}`)).json as { interval: string; tz: string; points: { t: string; value: number }[] };
    const utc = await ts('metric=visits&interval=day&from=2026-03-09&to=2026-03-13');
    expect(utc.points.map((p) => [p.t.slice(0, 10), p.value])).toEqual([['2026-03-09', 0], ['2026-03-10', 2], ['2026-03-11', 0], ['2026-03-12', 1], ['2026-03-13', 0]]); // the order event is not a page view
    // New York (UTC-4 after the March 8 change): 03:30Z on the 10th is 23:30 on the 9th local
    const ny = await ts('metric=visits&interval=day&tz=America/New_York&from=2026-03-09&to=2026-03-12');
    expect(ny.points.map((p) => [p.t, p.value])).toEqual([['2026-03-09T04:00:00.000Z', 1], ['2026-03-10T04:00:00.000Z', 1], ['2026-03-11T04:00:00.000Z', 0], ['2026-03-12T04:00:00.000Z', 1]]);
    const gross = await ts('metric=gross&interval=day&from=2026-03-12&to=2026-03-12');
    expect(gross.points).toEqual([{ t: '2026-03-12T00:00:00.000Z', value: 25 }]);
    const orders = await ts('metric=orders&interval=month&from=2026-02-01&to=2026-03-31');
    expect(orders.points).toEqual([{ t: '2026-02-01T00:00:00.000Z', value: 0 }, { t: '2026-03-01T00:00:00.000Z', value: 1 }]);
    const week = await ts('metric=visits&interval=week&from=2026-03-09&to=2026-03-15'); // 9 March 2026 is a Monday
    expect(week.points).toEqual([{ t: '2026-03-09T00:00:00.000Z', value: 3 }]);
    const hours = await ts('metric=visits&interval=hour&from=2026-03-10T00:00:00Z&to=2026-03-10T12:00:00Z');
    expect(hours.points).toHaveLength(12);
    expect(hours.points.filter((p) => p.value > 0).map((p) => [p.t.slice(11, 13), p.value])).toEqual([['03', 1], ['09', 1]]);
    const uniques = await ts('metric=unique_visits&interval=day&from=2026-03-10&to=2026-03-10');
    expect(uniques.points).toEqual([{ t: '2026-03-10T00:00:00.000Z', value: 2 }]); // entry step first views
  });

  it('rejects bad parameters with 400 and a code', async () => {
    const { h, owner, get } = await world();
    const f = await liveFunnel(h, owner.token);
    const bad = async (q: string, code: string) => {
      const r = await get(`/funnels/${f.id}/timeseries?${q}`);
      expect([r.status, r.json.error?.code]).toEqual([400, code]);
    };
    await bad('metric=revenue', 'VALIDATION_ERROR');
    await bad('interval=minute', 'VALIDATION_ERROR');
    await bad('tz=Mars/Base', 'INVALID_TIMEZONE');
    await bad('from=yesterday', 'INVALID_RANGE');
    await bad('from=2026-03-02&to=2026-03-01', 'INVALID_RANGE');
    await bad('from=2024-01-01&to=2026-03-01', 'INVALID_RANGE');
    await bad('from=2026-01-01&to=2026-03-01&interval=hour', 'INVALID_RANGE');
    await bad('from=2026-03-01T00:00:00&to=2026-03-02', 'INVALID_RANGE'); // a datetime needs an offset
    expect((await get('/funnels/nope/timeseries')).status).toBe(404);
  });

  it('interval helpers: hour, day, week and month in odd zones and across DST', () => {
    // India (+05:30): the local hour starts at :30 UTC
    expect(new Date(intervalStart(Date.parse('2026-03-10T10:20:00Z'), 'Asia/Kolkata', 'hour')).toISOString()).toBe('2026-03-10T09:30:00.000Z');
    // New York on the spring-forward day has 23 local hours: 2026-03-08
    const day = enumerateIntervals(Date.parse('2026-03-08T05:00:00Z'), Date.parse('2026-03-09T04:00:00Z'), 'America/New_York', 'hour');
    expect(day).toHaveLength(23);
    // a week that straddles a month end starts on Monday
    expect(new Date(intervalStart(Date.parse('2026-04-01T12:00:00Z'), 'UTC', 'week')).toISOString()).toBe('2026-03-30T00:00:00.000Z');
    expect(new Date(intervalStart(Date.parse('2026-04-01T12:00:00Z'), 'UTC', 'month')).toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(enumerateIntervals(Date.parse('2026-01-15T00:00:00Z'), Date.parse('2026-03-02T00:00:00Z'), 'UTC', 'month').map((s) => new Date(s).toISOString().slice(0, 7))).toEqual(['2026-01', '2026-02', '2026-03']);
  });
});

describe('exports', () => {
  /** A live funnel with a form, one anonymous visit and one visitor who opts in; device, country and referrer come from the real ingestion path. */
  async function exportWorld() {
    const w = await world({ CF_ORIGIN_SECRET: 'origin-secret-origin', TRUST_PROXY: 'true' });
    const { h, owner } = w;
    const t = await formTarget(h, owner.token);
    await goLive(h, owner.token, t.funnelId);
    const view = (headers: Record<string, string>, visitor: string, extra: object = {}) =>
      h.call('POST', '/api/public/events', { body: { funnelId: t.funnelId, stepId: t.stepId, type: 'page_view', visitorId: visitor, utms: { source: 'newsletter', medium: 'email', campaign: 'spring' }, ...extra }, headers: { ...headers, 'x-forwarded-for': '203.0.113.50' } });
    await view({ ...UA, 'x-cf-origin-secret': 'origin-secret-origin', 'cf-ipcountry': 'de' }, 'visitor-1', { referrer: 'News.Example.org' });
    h.clock.advance(1000);
    await view({ ...DESKTOP, 'cf-ipcountry': 'FR' }, 'visitor-2'); // a country header without the origin secret is ignored: anyone can send one
    h.clock.advance(1000);
    const submit = await h.call('POST', t.path, { body: { fields: { name: 'Ada Lovelace', email: 'Ada@Example.com', _consent: true }, consent: true, utms: { source: 'newsletter', campaign: 'spring' }, visitorId: 'visitor-1' }, headers: DESKTOP });
    expect(submit.json.recorded).toBe(true);
    await h.deps.events.flush();
    return { ...w, t };
  }
  const range = '?from=2026-03-01&to=2026-03-31';

  it('events: contract fields; device, verified country, referrer host and UTMs captured; no raw email or visitor id anywhere', async () => {
    const { h, owner, get, t } = await exportWorld();
    const r = await get(`/export/events${range}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/x-ndjson');
    const lines = ndjson(r.text);
    expect(lines.map((l) => l.type)).toEqual(['page_view', 'page_view', 'optin']);
    const [first, second, optin] = lines as Record<string, unknown>[];
    expect(first).toMatchObject({ funnel_id: t.funnelId, step_id: t.stepId, device: 'mobile', country: 'DE', referrer_host: 'news.example.org', utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'spring', amount: null, currency: null, unique_visit: true });
    expect(second).toMatchObject({ device: 'desktop', country: null, referrer_host: null });
    expect(optin).toMatchObject({ type: 'optin', device: 'unknown', country: null });
    // keys are HMACs with the workspace pepper: the same visitor gives the same key, a lead event carries the contact key
    const pepper = ((await h.call('GET', '/api/v1/analytics/identity-pepper', { token: owner.token })).json as { pepper: string }).pepper;
    const hm = (m: string) => createHmac('sha256', pepper).update(m).digest('hex');
    expect(first!.visitor_key).toBe(hm('v:visitor-1'));
    expect(first!.contact_key).toBeNull();
    expect(optin!.contact_key).toBe(hm('ada@example.com')); // lower-cased and trimmed before hashing
    expect(Object.keys(first!).sort()).toEqual(['amount', 'contact_key', 'country', 'currency', 'device', 'funnel_id', 'id', 'referrer_host', 'step_id', 'ts', 'type', 'unique_visit', 'utm_campaign', 'utm_medium', 'utm_source', 'visitor_key']);
    for (const secret of ['ada@example.com', 'Ada@Example.com', 'Ada Lovelace', 'visitor-1', 'visitor-2', '203.0.113.50']) expect(r.text.toLowerCase(), secret).not.toContain(secret.toLowerCase());
  });

  it('events are paged by (ts, id) with X-Next-Cursor: the pages join up exactly, in order, and a cursor can be reused to resume', async () => {
    const { get } = await exportWorld();
    const all = ndjson((await get(`/export/events${range}`)).text);
    const pages: Record<string, unknown>[][] = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = await get(`/export/events${range}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      pages.push(ndjson(r.text));
      cursor = r.headers.get('x-next-cursor') ?? '';
      expect(r.headers.get('x-row-count')).toBe(String(pages.at(-1)!.length));
      if (!cursor) break;
    }
    expect(pages.map((p) => p.length)).toEqual([2, 1]);
    expect(pages.flat()).toEqual(all);
    const ts = all.map((l) => `${l.ts}|${l.id}`);
    expect([...ts].sort()).toEqual(ts);
    const firstCursor = (await get(`/export/events${range}&limit=1`)).headers.get('x-next-cursor')!;
    expect((await get(`/export/events${range}&limit=5&cursor=${firstCursor}`)).text).toBe((await get(`/export/events${range}&limit=5&cursor=${firstCursor}`)).text); // resumable and stable
    expect(ndjson((await get(`/export/events${range}&limit=5&cursor=${firstCursor}`)).text)).toEqual(all.slice(1));
    expect((await get(`/export/events${range}&cursor=%%%`)).status).toBe(400);
  });

  it('filters by funnel and time, supports gzip, and an empty page is an empty body without a cursor', async () => {
    const { h, owner, mk, get, t } = await exportWorld();
    expect(ndjson((await get(`/export/events${range}&funnel_id=${t.funnelId}`)).text)).toHaveLength(3);
    expect((await get(`/export/events${range}&funnel_id=fn_other`)).text).toBe('');
    expect((await get('/export/events?from=2025-01-01&to=2025-01-02')).text).toBe('');
    const narrow = await get('/export/events?from=2026-03-10T12:00:01Z&to=2026-03-10T12:00:02Z');
    expect(ndjson(narrow.text)).toHaveLength(1); // only the second page view (12:00:01)
    // the compressor skips bodies under 1 KB, so make the export a little larger first
    await seed(h, Array.from({ length: 12 }, (_, i) => ({ workspace_id: owner.wsId, funnel_id: t.funnelId, step_id: t.stepId, visitor_id: `bulk-${i}`, created_at: '2026-03-11T08:00:00.000Z' })));
    const plain = await get(`/export/events${range}`);
    expect(plain.text.length).toBeGreaterThan(2000);
    const k = (await mk()).key;
    const res = await h.app.request(`/api/v1/analytics/export/events${range}`, { headers: { authorization: `Bearer ${k}`, 'accept-encoding': 'gzip', 'x-forwarded-for': '203.0.113.7' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(plain.text);
    void owner;
  });

  it('leads: contact_key, source, UTMs, conversion and order totals; no email or name', async () => {
    const w = await world({ TRUST_PROXY: 'true' });
    const { h, owner, get } = w;
    const t = await checkoutTarget(h, owner.token);
    await goLive(h, owner.token, t.funnelId);
    const buy = (email: string, name: string) => h.call('POST', t.mainPath, { body: { email, name, bumpBlockIds: [t.bumpId], utms: { source: 'ads', campaign: 'spring' }, visitorId: 'visitor-buyer' }, headers: DESKTOP });
    expect((await buy('buyer@example.com', 'Bea Buyer')).status).toBe(200);
    h.clock.advance(60_000);
    const form = await formTarget(h, owner.token);
    await goLive(h, owner.token, form.funnelId);
    await h.call('POST', form.path, { body: { fields: { name: 'Lee Lead', email: 'lee@example.com', _consent: true }, consent: true, utms: { source: 'blog' } }, headers: DESKTOP });
    const flist = (await get('/funnels?from=2026-03-01&to=2026-03-31')).json.data as { id: string; currency: string | null; orders: number }[];
    expect(flist.find((f) => f.id === t.funnelId)).toMatchObject({ currency: 'USD' }); // one currency in the range: reported
    const r = await get('/export/leads?from=2026-03-01&to=2026-03-31');
    const lines = ndjson(r.text);
    expect(lines).toHaveLength(2);
    const pepper = ((await h.call('GET', '/api/v1/analytics/identity-pepper', { token: owner.token })).json as { pepper: string }).pepper;
    const hm = (m: string) => createHmac('sha256', pepper).update(m).digest('hex');
    const buyer = lines.find((l) => l.contact_key === hm('buyer@example.com'))!;
    expect(buyer).toMatchObject({ funnel_id: t.funnelId, source: 'checkout', utm_source: 'ads', utm_campaign: 'spring', converted_to_order: true });
    expect(buyer.order_total as number).toBeGreaterThan(0);
    expect(buyer.first_order_at).toEqual(expect.any(String));
    const lead = lines.find((l) => l.contact_key === hm('lee@example.com'))!;
    expect(lead).toMatchObject({ source: 'form', utm_source: 'blog', converted_to_order: false, order_total: 0, first_order_at: null });
    for (const secret of ['buyer@example.com', 'Bea Buyer', 'lee@example.com', 'Lee Lead']) expect(r.text).not.toContain(secret);
    expect(Object.keys(lead).sort()).toEqual(['contact_key', 'converted_to_order', 'created_at', 'first_order_at', 'funnel_id', 'id', 'order_total', 'source', 'step_id', 'utm_campaign', 'utm_source']);
    // order events carry amount, currency and the contact key
    const events = ndjson((await get('/export/events?from=2026-03-01&to=2026-03-31')).text);
    const order = events.find((e) => e.type === 'order')!;
    expect(order).toMatchObject({ currency: 'USD', contact_key: hm('buyer@example.com') });
    expect(order.amount as number).toBeGreaterThan(0);
  });

  it('funnel structure: block counts, word count, order bump and upsell flags from the page documents', async () => {
    const { h, owner, get } = await world();
    const t = await checkoutTarget(h, owner.token);
    await goLive(h, owner.token, t.funnelId);
    const lead = await formTarget(h, owner.token);
    await goLive(h, owner.token, lead.funnelId);
    const r = await get('/export/funnel-structure');
    const data = (r.json as { data: { id: string; has_order_bump: boolean; has_upsell: boolean; word_count: number; steps: { blocks: Record<string, number>; word_count: number; order: number }[] }[] }).data;
    const sales = data.find((f) => f.id === t.funnelId)!;
    expect(sales).toMatchObject({ has_order_bump: true, has_upsell: true });
    expect(sales.steps[0]!.blocks.checkout).toBeGreaterThanOrEqual(2);
    expect(sales.steps.map((s) => s.order)).toEqual([1, 2, 3]);
    expect(sales.word_count).toBe(sales.steps.reduce((a, s) => a + s.word_count, 0));
    const lm = data.find((f) => f.id === lead.funnelId)!;
    expect(lm).toMatchObject({ has_order_bump: false, has_upsell: false });
    expect(lm.steps[0]!.blocks.form).toBe(1);
    expect(lm.word_count).toBeGreaterThan(20);
  });

  it('summarizeDoc walks sections and columns and counts only visible copy', () => {
    const doc = { blocks: [{ type: 'section', children: [{ type: 'heading', text: 'Two words' }, { type: 'columns', columns: [{ children: [{ type: 'paragraph', text: 'one two three' }, { type: 'video' }] }, { children: [{ type: 'list', items: ['a b', 'c'] }, { type: 'faq', items: [{ q: 'Why not', a: 'Because I said so' }] }, { type: 'checkout', orderBump: true, oneClickUpsell: false }, { type: 'form' }, { type: 'countdown' }] }] }] }] };
    expect(summarizeDoc(doc)).toEqual({ blocks: { form: 1, checkout: 1, video: 1, countdown: 1 }, word_count: 2 + 3 + 3 + 2 + 4, has_order_bump: true, has_upsell: false });
    expect(summarizeDoc({})).toEqual({ blocks: { form: 0, checkout: 0, video: 0, countdown: 0 }, word_count: 0, has_order_bump: false, has_upsell: false });
  });
});

describe('rate limits and the identity pepper', () => {
  it('limits per key (default 60 per minute, here 3) with 429 and Retry-After; another key and the export budget are separate', async () => {
    const { h, mk, key, get } = await world({ ANALYTICS_API_PER_MINUTE: '3', ANALYTICS_EXPORT_PER_MINUTE: '2' });
    const other = await mk();
    for (let i = 0; i < 3; i++) expect((await get('/funnels')).status).toBe(200);
    const limited = await get('/funnels');
    expect(limited.status).toBe(429);
    expect(limited.json.error).toMatchObject({ code: 'RATE_LIMITED', policy: 'analytics.read' });
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(limited.headers.get('ratelimit')).toContain('analytics.read');
    expect((await get('/funnels', other.key)).status).toBe(200); // a different key has its own budget
    expect((await get('/export/events')).status).toBe(200); // and exports their own
    expect((await get('/export/events')).status).toBe(200);
    expect((await get('/export/events')).status).toBe(429);
    h.clock.advance(61_000);
    expect((await get('/funnels', key.key)).status).toBe(200);
  });

  it('the identity pepper is for people with analytics_identity:manage AND analytics:export (or a key with both scopes, test/pepper.test.ts); a key without the identity scope is refused; rotation changes every exported key and is audited', async () => {
    const { h, owner, key, mk, get } = await world();
    const admin = await h.member(owner, 'admin'); // has analytics:export but not analytics_identity:manage
    const onlyIdentity = await h.memberWith(owner, ['analytics_identity:manage']); // lacks analytics:export
    const peek = (token: string) => h.call('GET', '/api/v1/analytics/identity-pepper', { token });
    expect((await peek(key.key)).status).toBe(403); // the key has analytics:read and analytics:export but not analytics_identity:manage
    expect((await peek(admin.token)).status).toBe(403);
    const lacksExport = await peek(onlyIdentity.token);
    expect(lacksExport.status).toBe(403);
    expect(lacksExport.json.error.message).toContain('analytics:export');
    const first = (await peek(owner.token)).json as { pepper: string; rotatedAt: string | null };
    expect(first.pepper).toMatch(/^[0-9a-f]{64}$/);
    expect(first.rotatedAt).toEqual(expect.any(String));
    expect(((await peek(owner.token)).json as { pepper: string }).pepper).toBe(first.pepper); // stable
    const f = await liveFunnel(h, owner.token);
    await seed(h, [{ workspace_id: owner.wsId, funnel_id: f.id, step_id: f.s1, visitor_id: 'stable-visitor', created_at: '2026-03-10T12:00:00.000Z' }]);
    const before = ndjson((await get('/export/events?from=2026-03-10&to=2026-03-10')).text)[0]!.visitor_key;
    for (const [m, path, body] of [['PUT', '/api/v1/analytics/identity-pepper', { pepper: 'x'.repeat(40) }], ['POST', '/api/v1/analytics/identity-pepper/rotate', undefined]] as const) {
      const r = await h.call(m, path, { token: key.key, body });
      expect(r.status, `${m} ${path}`).toBe(403);
      expect(r.json.error.code).toBe('SESSION_REQUIRED');
      expect(r.json.error.message).toMatch(/signed-in person/);
    }
    const rot = await h.call('POST', '/api/v1/analytics/identity-pepper/rotate', { token: owner.token });
    expect(rot.json.pepper).not.toBe(first.pepper);
    expect(rot.json.rotatedAt).toEqual(expect.any(String));
    const after = ndjson((await get('/export/events?from=2026-03-10&to=2026-03-10')).text)[0]!.visitor_key;
    expect(after).not.toBe(before);
    expect(after).toBe(createHmac('sha256', rot.json.pepper).update('v:stable-visitor').digest('hex'));
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'analytics.pepper_rotated'"))!.n)).toBe(1);
    expect(JSON.stringify(await h.deps.db.all('SELECT detail_json FROM audit_log'))).not.toContain(rot.json.pepper);
    void mk;
  });

  it('each workspace has its own pepper; two requests racing to create it agree on one value', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' } });
    const a = await h.register();
    const b = await h.register();
    const peppers = await Promise.all([a, a, a, b].map((u) => h.call('GET', '/api/v1/analytics/identity-pepper', { token: u.token }).then((r) => r.json.pepper as string)));
    expect(new Set(peppers.slice(0, 3)).size).toBe(1);
    expect(peppers[3]).not.toBe(peppers[0]);
  });
});

describe('analytics.daily_rollup_ready webhook', () => {
  it('announces yesterday once per subscribed workspace, with the funnels that had data, signed over the body; never twice, never to others', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' } });
    const owner = await h.register();
    const other = await h.register(); // no subscription
    const f = await makeFunnel(h, owner.token);
    await seed(h, [{ workspace_id: owner.wsId, funnel_id: f.id, step_id: f.steps[0].id, visitor_id: 'v', created_at: '2026-03-09T10:00:00.000Z' }]);
    const hook = await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/rollup', events: ['analytics.daily_rollup_ready'] } });
    expect(hook.status).toBe(201);
    await h.call('POST', '/api/webhooks', { token: other.token, body: { url: 'https://hooks.example.com/funnel', events: ['funnel.optin'] } });
    const { runMaintenance } = await import('../src/services/maintenance.js');
    expect((await runMaintenance(h.deps)).rollupsAnnounced).toBe(1); // clock is 2026-03-10 12:00Z: "yesterday" is the 9th
    expect((await runMaintenance(h.deps)).rollupsAnnounced).toBe(0); // same day again: nothing
    await h.worker.tick();
    expect(h.http.calls).toHaveLength(1);
    const call = h.http.calls[0]!;
    const body = JSON.parse(call.body) as { id: string; event: string; data: { day: string; funnels: string[]; schemaVersion: number } };
    expect(body.event).toBe('analytics.daily_rollup_ready');
    expect(body.data).toMatchObject({ day: '2026-03-09', funnels: [f.id], schemaVersion: 1 });
    expect(call.headers['x-signature']).toBe(`sha256=${createHmac('sha256', hook.json.secret).update(call.body).digest('hex')}`);
    h.clock.advance(24 * 3600_000); // next day: yesterday is now the 10th
    expect((await runMaintenance(h.deps)).rollupsAnnounced).toBe(1);
    expect(Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM analytics_daily_ready'))!.n)).toBe(2);
  });

  it('concurrent maintenance runs on several replicas announce a day exactly once', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/rollup', events: ['analytics.daily_rollup_ready'] } });
    const { announceDailyRollups } = await import('../src/services/maintenance.js');
    const results = await Promise.all([1, 2, 3, 4].map(() => announceDailyRollups(h.deps)));
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE event = 'analytics.daily_rollup_ready'"))!.n)).toBe(1);
  });
});
