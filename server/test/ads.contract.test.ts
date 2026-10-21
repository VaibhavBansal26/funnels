import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { DOCUMENTS } from '../src/analyticsapi/schemas.js';
import { OPERATIONS } from '../src/routes/spec.js';
import { adsWorld } from './support/adsworld.js';

// Same contract style as analyticsapi.contract.test.ts: real responses validated against the JSON Schema FILES in docs/analytics-api/.
const dir = fileURLToPath(new URL('../../docs/analytics-api/', import.meta.url));
const file = (name: string) => JSON.parse(readFileSync(`${dir}${name}.schema.json`, 'utf8')) as Record<string, unknown>;
const Ajv2020 = ((Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module) as unknown as new (o: object) => { compile(s: object): ValidateFunction };
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (a: object) => void;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new Map<string, ValidateFunction>();
const check = (name: string, value: unknown) => {
  if (!compiled.has(name)) compiled.set(name, ajv.compile(file(name)));
  const v = compiled.get(name)!;
  expect(v(value), `${name}: ${JSON.stringify(v.errors)} for ${JSON.stringify(value).slice(0, 300)}`).toBe(true);
};

async function populated() {
  const w = await adsWorld({ API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', ANALYTICS_API_PER_MINUTE: '100000' });
  await w.spend({ day: '2026-03-05', source: 'meta', campaign: 'Spring', currency: 'USD', spend: 100, impressions: 1000, clicks: 20 });
  await w.spend({ day: '2026-03-05', source: 'google', campaign: 'Orphan', currency: 'USD', spend: 5 });
  await w.visitor({ at: '2026-03-05T10:00:00Z', last: { source: 'facebook', medium: 'paid_social', campaign: 'Spring' } });
  await w.lead({ at: '2026-03-05T10:00:00Z', last: { source: 'facebook', medium: 'paid_social', campaign: 'Spring' } });
  await w.order({ at: '2026-03-06T10:00:00Z', cents: 25000, last: { source: 'facebook', medium: 'paid_social', campaign: 'Spring' } });
  await w.h.deps.db.run("UPDATE funnels SET status = 'live' WHERE id = ?", w.form.funnelId);
  const key = (await w.h.call('POST', '/api/v1/api-keys', { token: w.owner.token, body: { name: 'c', scopes: ['analytics:read'] } })).json.key as string;
  return { w, key, get: (p: string, k = key) => w.h.call('GET', `/api/v1/analytics${p}`, { token: k }) };
}

describe('ads endpoints of the analytics API v1', () => {
  it('declares the two documents and publishes their schema files', async () => {
    expect(Object.keys(DOCUMENTS)).toEqual(expect.arrayContaining(['ads', 'attribution']));
    const ops = OPERATIONS.filter((o) => ['/api/v1/analytics/ads', '/api/v1/analytics/attribution'].includes(o.path));
    expect(ops.map((o) => `${o.method} ${o.path}`).sort()).toEqual(['GET /api/v1/analytics/ads', 'GET /api/v1/analytics/attribution']);
    expect(ops.every((o) => o.apiScope === 'analytics:read')).toBe(true);
  });

  it('GET /ads matches its schema, in snake_case, one currency, with unmatched spend', async () => {
    const { get } = await populated();
    const r = await get('/ads?from=2026-03-01&to=2026-03-31&group_by=campaign');
    expect(r.status).toBe(200);
    check('ads', r.json);
    expect(r.json).toMatchObject({ currency: 'USD', model: 'last', group_by: 'campaign', next_cursor: null, from: '2026-03-01', to: '2026-03-31' });
    const spring = r.json.data.find((x: any) => x.campaign === 'Spring');
    expect(spring).toMatchObject({ source: 'meta', spend: 100, revenue: 250, roas: 2.5, leads: 1, orders: 1, visits: 1, funnel_id: null });
    expect(r.json.unmatched_spend).toEqual([{ source: 'google', campaign: 'Orphan', spend: 5 }]);
    for (const g of ['source', 'funnel', 'day']) check('ads', (await get(`/ads?from=2026-03-01&to=2026-03-31&group_by=${g}`)).json);
    check('ads', (await get('/ads?from=2026-03-01&to=2026-03-31&currency=EUR')).json);
  });

  it('GET /attribution matches its schema', async () => {
    const { get } = await populated();
    for (const dimension of ['source', 'medium', 'campaign', 'content', 'source_medium', 'source_medium_campaign']) {
      const r = await get(`/attribution?from=2026-03-01&to=2026-03-31&dimension=${dimension}&model=first`);
      expect(r.status).toBe(200);
      check('attribution', r.json);
    }
    const r = await get('/attribution?from=2026-03-01&to=2026-03-31');
    expect(r.json.data[0]).toMatchObject({ source: 'facebook', medium: 'paid_social', visits: 1, leads: 1, orders: 1, revenue: 250 });
  });

  it('validates, scopes and refuses like the rest of the API', async () => {
    const { get, w, key } = await populated();
    expect((await get('/ads?from=nope')).status).toBe(400);
    expect((await get('/ads?group_by=week')).status).toBe(400);
    expect((await get('/ads?tz=Mars/Base')).status).toBe(400);
    expect((await get('/attribution?from=2026-03-01T00:00:00Z')).status).toBe(400);
    expect((await w.h.call('GET', '/api/v1/analytics/ads', {})).status).toBe(401);
    expect((await get('/ads', 'fa_live_nonsense')).status).toBe(401);
    // a test-mode key sees test funnels only: no spend, none of this live data
    const testKey = (await w.h.call('POST', '/api/v1/api-keys', { token: w.owner.token, body: { name: 't', mode: 'test', scopes: ['analytics:read'] } })).json.key as string;
    const t = await get('/ads?from=2026-03-01&to=2026-03-31', testKey);
    expect(t.json.totals).toMatchObject({ spend: 0, revenue: 0 });
    // another workspace's key sees none of it
    const other = await w.h.register();
    const otherKey = (await w.h.call('POST', '/api/v1/api-keys', { token: other.token, body: { name: 'o', scopes: ['analytics:read'] } })).json.key as string;
    expect((await get('/ads?from=2026-03-01&to=2026-03-31', otherKey)).json.data).toEqual([]);
    // a key without the scope is refused
    const exportOnly = (await w.h.call('POST', '/api/v1/api-keys', { token: w.owner.token, body: { name: 'e', scopes: ['analytics:export'] } })).json.key as string;
    expect([401, 403]).toContain((await get('/ads', exportOnly)).status);
    void key;
  });

  it('the schema endpoint serves the new documents', async () => {
    const { get } = await populated();
    const served = (await get('/schema')).json as { schemas: Record<string, unknown> };
    expect(Object.keys(served.schemas)).toEqual(expect.arrayContaining(['ads', 'attribution']));
  });
});
