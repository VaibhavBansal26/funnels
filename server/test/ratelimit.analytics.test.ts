import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers.js';

/**
 * How the analytics API's limits behave (docs/RATE-LIMITING.md, "Analytics API: reading the limits"). These pin what looked odd in the integration run:
 * fewer than 10 export answers, a Retry-After of 6 s next to a reset of 60 s, no escalation after two 429s.
 */
async function world() {
  const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' } });
  const owner = await h.register();
  const key = (await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'k', scopes: ['analytics:read', 'analytics:export'] } })).json.key as string;
  const get = (path: string) => h.call('GET', `/api/v1/analytics${path}`, { token: key });
  return { h, owner, get };
}

describe('analytics API rate limits', () => {
  it('reads and exports have separate budgets per key: three reads do not reduce the ten export requests', async () => {
    const { get } = await world();
    for (let i = 0; i < 3; i++) expect((await get('/funnels')).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await get('/export/events')).status, `export ${i + 1}`).toBe(200);
    const r = await get('/export/events');
    expect(r.status).toBe(429);
    expect(r.json.error.policy).toBe('analytics.export');
  });

  it('every export route of a key draws on the same 10 per minute, including the JSON funnel-structure export', async () => {
    const { get } = await world();
    for (let i = 0; i < 3; i++) expect((await get('/export/events')).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await get('/export/leads')).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await get('/export/funnel-structure')).status).toBe(200);
    expect((await get('/export/events')).status).toBe(429);
  });

  it('Retry-After is the time until the same request would succeed (one token: window / quota); X-RateLimit-Reset and RateLimit t are the time until the bucket is full again', async () => {
    const { get } = await world();
    for (let i = 0; i < 10; i++) await get('/export/events');
    const r = await get('/export/events');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('6');
    expect(r.json.error.retry_after_s).toBe(6); // the same number in the body
    expect(r.headers.get('x-ratelimit-reset')).toBe('60');
    expect(r.headers.get('ratelimit')).toBe('"analytics.export";r=0;t=60');
    expect(r.headers.get('ratelimit-policy')).toBe('"analytics.export";q=10;w=60');
    expect(Number(r.headers.get('retry-after'))).toBeLessThanOrEqual(Number(r.headers.get('x-ratelimit-reset')));
  });

  it('two consecutive 429s do not escalate: the analytics policies have no penalty box, only the auth, reset and public form policies do', async () => {
    const { h, get } = await world();
    for (let i = 0; i < 10; i++) await get('/export/events');
    const a = await get('/export/events');
    const b = await get('/export/events');
    expect([a.status, b.status]).toEqual([429, 429]);
    expect(Number(b.headers.get('retry-after'))).toBeLessThanOrEqual(Number(a.headers.get('retry-after')));
    for (const id of ['analytics.read', 'analytics.export', 'analytics.workspace']) expect(h.deps.limiter.policy(id).penalty, id).toBeFalsy();
    for (const id of ['auth.attempts', 'auth.reset', 'public.forms']) expect(h.deps.limiter.policy(id).penalty, id).toBeTruthy();
    // a minute later the bucket has refilled
    h.clock.advance(61_000);
    expect((await get('/export/events')).status).toBe(200);
  });
});
