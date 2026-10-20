import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020Module from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { DOCUMENTS, jsonSchemaOf, SCHEMA_VERSION } from '../src/analyticsapi/schemas.js';
import { OPERATIONS } from '../src/routes/spec.js';
import { insertEvents, type EventInsert } from '../src/services/rollups.js';
import { newId } from '../src/util/ids.js';
import { activeDomain, checkoutTarget, formTarget, makeHarness } from './helpers.js';

// The contract tests validate real API output against the JSON Schema FILES in docs/analytics-api/ (the documents a consumer such as the Python
// service reads), with a real JSON Schema validator, not against the zod objects they were generated from.
const dir = fileURLToPath(new URL('../../docs/analytics-api/', import.meta.url));
const file = (name: string) => JSON.parse(readFileSync(`${dir}${name}.schema.json`, 'utf8')) as Record<string, unknown>;
// ajv and ajv-formats are CommonJS with a default export; under NodeNext that arrives as the module object itself
const Ajv2020 = ((Ajv2020Module as unknown as { default?: typeof Ajv2020Module }).default ?? Ajv2020Module) as unknown as new (o: object) => { compile(s: object): ValidateFunction };
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (a: object) => void;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new Map<string, ValidateFunction>();
const validator = (name: string): ValidateFunction => {
  if (!compiled.has(name)) compiled.set(name, ajv.compile(file(name)));
  return compiled.get(name)!;
};
const check = (name: string, value: unknown) => {
  const v = validator(name);
  const ok = v(value);
  expect(ok, `${name}: ${JSON.stringify(v.errors)} for ${JSON.stringify(value).slice(0, 300)}`).toBe(true);
};
const lines = (text: string) => text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as unknown);

async function populated() {
  const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', ANALYTICS_API_PER_MINUTE: '100000', ANALYTICS_EXPORT_PER_MINUTE: '100000', TRUST_PROXY: 'true' } });
  const owner = await h.register();
  const sales = await checkoutTarget(h, owner.token);
  const form = await formTarget(h, owner.token);
  for (const [i, id] of [sales.funnelId, form.funnelId].entries()) {
    const d = await activeDomain(h, owner.token, `contract${i}.example.com`);
    await h.call('PATCH', `/api/funnels/${id}`, { token: owner.token, body: { status: 'live', domain_id: d } });
  }
  const ua = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
  await h.call('POST', sales.mainPath, { body: { email: 'buyer@example.com', name: 'Bea', bumpBlockIds: [sales.bumpId], visitorId: 'v-buy', utms: { source: 'ads' } }, headers: ua });
  await h.call('POST', form.path, { body: { fields: { name: 'Lee', email: 'lee@example.com', _consent: true }, consent: true, utms: { source: 'blog' } }, headers: ua });
  const rows: EventInsert[] = ['a', 'b', 'c'].map((v, i) => ({ id: newId('evt') + i, workspace_id: owner.wsId, funnel_id: form.funnelId, step_id: form.stepId, type: 'page_view', visitor_id: v, unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null, created_at: '2026-03-10T12:00:00.000Z' }));
  await h.deps.db.transaction((tx) => insertEvents(tx, rows, { decideUnique: true }));
  const key = (await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'contract', scopes: ['analytics:read', 'analytics:export'] } })).json.key as string;
  const get = (path: string, k = key) => h.call('GET', `/api/v1/analytics${path}`, { token: k });
  return { h, owner, key, get, sales, form };
}

describe('analytics API contract (JSON Schema files vs live responses)', () => {
  it('every schema file is the JSON Schema of its zod definition, carries a stable $id, and the schema endpoint serves the same documents', async () => {
    const { get } = await populated();
    const served = (await get('/schema')).json as { schema_version: number; schemas: Record<string, Record<string, unknown>> };
    expect(served.schema_version).toBe(SCHEMA_VERSION);
    expect(Object.keys(served.schemas).sort()).toEqual(Object.keys(DOCUMENTS).sort());
    for (const [name, zodSchema] of Object.entries(DOCUMENTS)) {
      const { $id, ...rest } = file(name);
      expect($id).toBe(`https://funnels.example/analytics-api/v${SCHEMA_VERSION}/${name}.schema.json`);
      expect(rest, name).toEqual(jsonSchemaOf(zodSchema));
      expect(served.schemas[name], name).toEqual(jsonSchemaOf(zodSchema));
    }
  });

  it('funnels, steps and every metric x interval of the time series validate', async () => {
    const { get, sales, form } = await populated();
    const q = '?from=2026-03-01&to=2026-03-31';
    const funnels = await get(`/funnels${q}`);
    check('funnels', funnels.json);
    expect((funnels.json as { data: unknown[] }).data).toHaveLength(2);
    for (const f of [sales, form]) {
      check('steps', (await get(`/funnels/${f.funnelId}/steps${q}`)).json);
      for (const metric of ['visits', 'unique_visits', 'optins', 'orders', 'gross']) {
        for (const interval of ['hour', 'day', 'week', 'month']) {
          const range = interval === 'hour' ? '?from=2026-03-10&to=2026-03-11' : q;
          const r = await get(`/funnels/${f.funnelId}/timeseries${range}&metric=${metric}&interval=${interval}`);
          expect(r.status, `${metric}/${interval}`).toBe(200);
          check('timeseries', r.json);
        }
      }
    }
  });

  it('every line of the events and leads exports and the funnel structure validate', async () => {
    const { get } = await populated();
    const events = lines((await get('/export/events?from=2026-03-01&to=2026-03-31')).text);
    expect(events.length).toBeGreaterThanOrEqual(5);
    for (const e of events) check('export-event', e);
    expect(new Set(events.map((e) => (e as { type: string }).type))).toEqual(new Set(['page_view', 'optin', 'order']));
    const leads = lines((await get('/export/leads?from=2026-03-01&to=2026-03-31')).text);
    expect(leads).toHaveLength(2);
    for (const l of leads) check('export-lead', l);
    check('funnel-structure', (await get('/export/funnel-structure')).json);
    for (const q of ['', '?include=series&interval=week&tz=Pacific/Auckland', '?limit=1']) {
      const r = await get(`/products${q}`);
      expect(r.status, r.text).toBe(200);
      check('products', r.json);
    }
    expect(((await get('/products')).json as { data: unknown[] }).data.length).toBeGreaterThan(0);
  });

  it('error bodies of every failure class validate against the error schema', async () => {
    const { h, owner, key, get } = await populated();
    const readOnly = (await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'ro', scopes: ['analytics:read'] } })).json.key as string;
    const failures = [
      await get('/funnels', 'fa_live_' + 'x'.repeat(32)), // 401
      await get('/export/events', readOnly), // 403 scope
      await get('/funnels/nope/steps'), // 404
      await get('/funnels?limit=0'), // 400 validation
      await get('/funnels?from=garbage'), // 400 range
    ];
    expect(failures.map((f) => f.status)).toEqual([401, 403, 404, 400, 400]);
    for (const f of failures) check('error', f.json);
    const tight = await makeHarness({ env: { ANALYTICS_API_PER_MINUTE: '1' } });
    const o = await tight.register();
    const k = (await tight.call('POST', '/api/v1/api-keys', { token: o.token, body: { name: 'k', scopes: ['analytics:read'] } })).json.key as string;
    await tight.call('GET', '/api/v1/analytics/funnels', { token: k });
    const limited = await tight.call('GET', '/api/v1/analytics/funnels', { token: k });
    expect(limited.status).toBe(429);
    check('error', limited.json);
    void key;
  });

  it('the schemas are not vacuous: they reject a missing field, a wrong type, a bad enum and an out-of-range rate', () => {
    const f = { id: 'fn_1', name: 'n', status: 'live', steps_count: 1, visits: 1, unique_visits: 1, optins: 0, optin_rate: 0, orders: 0, gross: 0, refunded: 0, disputed_lost: 0, net: 0, currency: null, earnings_per_view: 0, created_at: '2026-03-10T00:00:00.000Z' };
    check('funnels', { data: [f], next_cursor: null });
    const bad = (mut: (x: Record<string, unknown>) => void) => {
      const copy = { ...f } as Record<string, unknown>;
      mut(copy);
      return validator('funnels')({ data: [copy], next_cursor: null });
    };
    expect(bad((x) => delete x.visits)).toBe(false);
    expect(bad((x) => (x.visits = '1'))).toBe(false);
    expect(bad((x) => (x.status = 'draft'))).toBe(false);
    expect(bad((x) => (x.optin_rate = 1.5))).toBe(false);
    // open objects: an extra field is fine (additive evolution), a missing or mistyped one is not
    expect(bad((x) => (x.brand_new_field = 1))).toBe(true);
    expect(validator('export-event')({ id: 'e' })).toBe(false);
    expect(validator('timeseries')({ interval: 'year', points: [] })).toBe(false);
  });

  it('every API-key route refuses a missing key (401) and the other scope (403), and admits its own scope', async () => {
    const { h, owner, key, form } = await populated();
    const readKey = (await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'r', scopes: ['analytics:read'] } })).json.key as string;
    const exportKey = (await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'e', scopes: ['analytics:export'] } })).json.key as string;
    const failures: string[] = [];
    const ops = OPERATIONS.filter((o) => o.auth === 'apikey');
    expect(ops.length).toBeGreaterThanOrEqual(7);
    for (const o of ops) {
      const path = o.path.replace(':id', form.funnelId);
      const call = (token?: string) => h.call(o.method, path, { token });
      const label = `${o.method} ${o.path} [${o.apiScope}]`;
      if ((await call()).status !== 401) failures.push(`${label}: no key must be 401`);
      if ((await call(owner.token)).status !== 401) failures.push(`${label}: a user token must be 401`);
      const own = o.apiScope === 'analytics:read' ? readKey : exportKey;
      const other = o.apiScope === 'analytics:read' ? exportKey : readKey;
      const denied = await call(other);
      if (denied.status !== 403) failures.push(`${label}: the other scope must be 403, got ${denied.status}`);
      const ok = await call(own);
      if (ok.status === 401 || ok.status === 403) failures.push(`${label}: its own scope got ${ok.status}`);
      if ((await call(key)).status !== 200) failures.push(`${label}: a key with both scopes should succeed`);
      expect(o.limits.some((id) => h.deps.limiter.policy(id).layer === 'principal'), `${label}: counted against the key`).toBe(true);
      expect(o.limits.some((id) => h.deps.limiter.policy(id).layer === 'workspace'), `${label}: and against the workspace`).toBe(true);
    }
    expect(failures).toEqual([]);
  });
});
