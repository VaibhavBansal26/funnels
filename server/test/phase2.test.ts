import { describe, expect, it, vi } from 'vitest';
import { CloudflareDomainProvider, mapCloudflareStatus, type DomainProvider } from '../src/edge/domainProvider.js';
import { CloudflareApiPurger, type CloudflarePurger } from '../src/edge/purger.js';
import { NonceCache, signEdge, verifyEdge } from '../src/edge/signing.js';
import { clientIp } from '../src/util/ratelimit.js';
import { csvStream } from '../src/util/csv.js';
import { activeDomain, formTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';

const SECRET = 'edge-secret-edge-secret-edge-secret-1';
const UA = { 'user-agent': 'Mozilla/5.0 Chrome' };

describe('edge request signing', () => {
  const now = 1_800_000_000_000;
  const sign = (over: Partial<{ ts: string; nonce: string; method: string; path: string }> = {}) => {
    const ts = over.ts ?? String(now / 1000);
    const nonce = over.nonce ?? 'abcdefghijklmnop1234';
    const path = over.path ?? '/internal/edge/resolve?host=a.com&path=/x';
    return { method: over.method ?? 'GET', pathAndQuery: path, headers: new Headers({ 'x-edge-timestamp': ts, 'x-edge-nonce': nonce, 'x-edge-signature': signEdge(SECRET, ts, nonce, over.method ?? 'GET', path) }) };
  };
  const opts = (secret: string | null = SECRET, nonces = new NonceCache(240_000)) => ({ secret: secret ?? undefined, skewSeconds: 120, nonces, now });

  it('accepts a valid signature once', () => {
    const o = opts();
    expect(verifyEdge(o, sign()).ok).toBe(true);
    expect(verifyEdge(o, sign())).toMatchObject({ ok: false, reason: 'nonce already used' }); // replay
  });
  it('fails closed without a secret', () => {
    expect(verifyEdge(opts(null), sign())).toMatchObject({ ok: false, status: 503 });
    expect(verifyEdge(opts(''), sign())).toMatchObject({ ok: false, status: 503 });
  });
  it('rejects tampering, wrong secret, stale or future timestamps and malformed headers', () => {
    const t = sign();
    expect(verifyEdge(opts(), { ...t, pathAndQuery: '/internal/edge/resolve?host=evil.com' })).toMatchObject({ reason: 'bad signature' });
    expect(verifyEdge(opts(), { ...t, method: 'POST' })).toMatchObject({ reason: 'bad signature' });
    expect(verifyEdge(opts('other-secret-other-secret-other-secret'), sign())).toMatchObject({ reason: 'bad signature' });
    expect(verifyEdge(opts(), sign({ ts: String(now / 1000 - 121) }))).toMatchObject({ reason: expect.stringContaining('window') });
    expect(verifyEdge(opts(), sign({ ts: String(now / 1000 + 121) }))).toMatchObject({ reason: expect.stringContaining('window') });
    expect(verifyEdge(opts(), sign({ ts: String(now / 1000 - 119), nonce: 'zzzzzzzzzzzzzzzz9999' })).ok).toBe(true);
    for (const bad of [{ ts: 'x' }, { nonce: 'short' }]) expect(verifyEdge(opts(), sign(bad)).ok).toBe(false);
    const missing = { ...t, headers: new Headers() };
    expect(verifyEdge(opts(), missing)).toMatchObject({ status: 401 });
  });
  it('a bad signature does not burn the nonce, and nonces expire with the window', () => {
    const nonces = new NonceCache(1000);
    expect(verifyEdge(opts(SECRET, nonces), { ...sign(), pathAndQuery: '/tampered' }).ok).toBe(false);
    expect(verifyEdge(opts(SECRET, nonces), sign()).ok).toBe(true);
    expect(nonces.use('abcdefghijklmnop1234', now + 500)).toBe(false);
    expect(nonces.use('abcdefghijklmnop1234', now + 1500)).toBe(true);
  });
});

async function edgeWorld(env: Record<string, string> = { EDGE_SHARED_SECRET: SECRET }) {
  const h = makeHarness({ env });
  const u = await h.register();
  const dom = await activeDomain(h, u.token, 'edge.example.com');
  const f = await makeFunnel(h, u.token, { name: 'Edge', base_path: '/promo' });
  await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
  let n = 0;
  const resolve = (host: string, path: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) => {
    const pq = `/internal/edge/resolve?${new URLSearchParams({ host, path, ...extra })}`;
    const ts = String(Math.floor(h.clock.now().getTime() / 1000));
    const nonce = `nonce-${String(++n).padStart(16, '0')}`;
    return h.call('GET', pq, { headers: { 'x-edge-timestamp': ts, 'x-edge-nonce': nonce, 'x-edge-signature': signEdge(SECRET, ts, nonce, 'GET', pq), ...headers } });
  };
  return { h, u, f, dom, resolve };
}

describe('GET /internal/edge/resolve', () => {
  it('returns the page, then notModified for a matching checksum', async () => {
    const { resolve, f } = await edgeWorld();
    const r = await resolve('edge.example.com', '/promo');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: 'page', status: 200, funnelId: f.id, checksum: expect.any(String) });
    expect(r.json.html).toContain('<!doctype html>');
    const again = await resolve('edge.example.com', '/promo', {}, { 'x-edge-checksum': r.json.checksum });
    expect(again.json).toMatchObject({ kind: 'page', notModified: true });
    expect(again.json.html).toBeUndefined();
  });
  it('applies redirect, default home/404 and missing rules', async () => {
    const { resolve, h, u, f, dom } = await edgeWorld();
    expect((await resolve('edge.example.com', '/PROMO/', { search: '?a=1' })).json).toEqual({ kind: 'redirect', status: 301, location: '/promo?a=1' });
    expect((await resolve('edge.example.com', '/nope')).json).toEqual({ kind: 'missing', status: 404 });
    await h.call('PUT', `/api/domains/${dom}/default-pages`, { token: u.token, body: { homeStepId: f.steps[0].id, notFoundStepId: f.steps[0].id } });
    expect((await resolve('edge.example.com', '/')).json).toMatchObject({ kind: 'page', status: 200 });
    expect((await resolve('edge.example.com', '/nope')).json).toMatchObject({ kind: 'page', status: 404 });
    expect((await resolve('unknown.example.com', '/promo')).json.kind).toBe('missing');
  });
  it('rejects unsigned, replayed and unconfigured requests', async () => {
    const { h, resolve } = await edgeWorld();
    expect((await h.call('GET', '/internal/edge/resolve?host=edge.example.com&path=/promo')).status).toBe(401);
    const ts = String(Math.floor(h.clock.now().getTime() / 1000));
    const pq = '/internal/edge/resolve?host=edge.example.com&path=%2Fpromo';
    const headers = { 'x-edge-timestamp': ts, 'x-edge-nonce': 'replayreplayreplay01', 'x-edge-signature': signEdge(SECRET, ts, 'replayreplayreplay01', 'GET', pq) };
    expect((await h.call('GET', pq, { headers })).status).toBe(200);
    expect((await h.call('GET', pq, { headers })).status).toBe(401);
    h.clock.advance(200_000);
    expect((await resolve('edge.example.com', '/promo')).status).toBe(200); // fresh timestamp is fine
    const off = makeHarness();
    const r = await off.call('GET', pq, { headers });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('EDGE_DISABLED');
  });
  it('is not reachable through a customer domain', async () => {
    const { h } = await edgeWorld();
    const res = await h.app.request('/internal/edge/resolve', { headers: { host: 'edge.example.com' } });
    expect(res.status).toBe(404);
  });
});

describe('cache purge', () => {
  class FakePurger implements CloudflarePurger {
    calls: string[][] = [];
    fail = 0;
    async purgeUrls(urls: string[]) {
      if (this.fail > 0) { this.fail--; throw new Error('cf down'); }
      this.calls.push(urls);
    }
  }

  it('save and publish changes queue purges of the public URLs, run by the job worker with retry', async () => {
    const purger = new FakePurger();
    const h = makeHarness({ deps: { purger } });
    const u = await h.register();
    const dom = await activeDomain(h, u.token, 'purge.example.com');
    const f = await makeFunnel(h, u.token, { name: 'P', base_path: '/p' });
    await h.worker.tick();
    expect(purger.calls).toHaveLength(0); // test funnels are not on the CDN
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
    await h.call('PUT', `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`, { token: u.token, body: { doc: { version: 1, blocks: [] } } });
    purger.fail = 2; // both queued purge jobs fail once
    await h.worker.tick();
    expect(purger.calls).toHaveLength(0);
    h.clock.advance(31_000);
    await h.worker.tick();
    expect(purger.calls.flat()).toContain('https://purge.example.com/p');
    // un-publishing purges what was live before the change
    purger.calls = [];
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { status: 'test' } });
    await h.worker.tick();
    expect(purger.calls.flat()).toContain('https://purge.example.com/p');
    // domain deletion purges every affected funnel
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
    await h.worker.tick();
    purger.calls = [];
    await h.call('DELETE', `/api/domains/${dom}`, { token: u.token });
    await h.worker.tick();
    expect(purger.calls.flat()).toContain('https://purge.example.com/p');
  });

  it('the Cloudflare API adapter batches 30 URLs per call and surfaces failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const p = new CloudflareApiPurger({ zoneId: 'z1', token: 'tok', base: 'https://api.test/v4', fetch: fetchMock });
    await p.purgeUrls(Array.from({ length: 65 }, (_, i) => `https://a.com/${i % 62}`));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.test/v4/zones/z1/purge_cache');
    expect(init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body).files).toHaveLength(30);
    fetchMock.mockResolvedValue(new Response('{}', { status: 429 }));
    await expect(p.purgeUrls(['https://a.com/'])).rejects.toThrow('HTTP 429');
  });
});

describe('Cloudflare for SaaS domain provider', () => {
  it('maps hostname + certificate status', () => {
    const m = (status: string, ssl: string) => mapCloudflareStatus({ id: 'h1', status, ssl: { status: ssl } }).status;
    expect(m('active', 'active')).toBe('active');
    expect(m('active', 'pending_validation')).toBe('pending');
    expect(m('pending', 'active')).toBe('pending');
    expect(m('blocked', 'active')).toBe('failed');
    expect(m('moved', 'active')).toBe('failed');
    expect(m('active', 'validation_timed_out')).toBe('failed');
    const r = mapCloudflareStatus({ id: 'h1', status: 'pending', ownership_verification: { type: 'txt', name: '_cf.a.com', value: 'abc' }, ssl: { status: 'pending_validation', validation_records: [{ txt_name: '_acme.a.com', txt_value: 'xyz' }] }, verification_errors: ['No TXT'] });
    expect(r.records).toEqual([{ type: 'TXT', name: '_cf.a.com', value: 'abc' }, { type: 'TXT', name: '_acme.a.com', value: 'xyz' }]);
    expect(r.reason).toBe('No TXT');
  });

  it('calls the custom hostnames API with the token and handles errors', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { id: 'cf1', status: 'pending', ssl: { status: 'initializing' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { id: 'cf1', status: 'active', ssl: { status: 'active' } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { id: 'cf1' } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, errors: [{ message: 'Duplicate hostname' }] }), { status: 409 }));
    const p = new CloudflareDomainProvider({ zoneId: 'z', token: 't', base: 'https://api.test/v4', fetch: f });
    expect(await p.create('a.example.com')).toMatchObject({ externalId: 'cf1', status: 'pending' });
    expect(JSON.parse(f.mock.calls[0]![1].body)).toMatchObject({ hostname: 'a.example.com', ssl: { method: 'txt', type: 'dv' } });
    expect(f.mock.calls[0]![0]).toBe('https://api.test/v4/zones/z/custom_hostnames');
    expect((await p.get('cf1')).status).toBe('active');
    await p.remove('cf1');
    expect(f.mock.calls[2]![1].method).toBe('DELETE');
    await expect(p.create('dup.example.com')).rejects.toThrow('Duplicate hostname');
  });

  it('drives the domain lifecycle through the provider, reverting funnels when it reports a problem', async () => {
    let status: 'pending' | 'active' | 'failed' = 'pending';
    const removed: string[] = [];
    const provider: DomainProvider = {
      name: 'cloudflare',
      create: async () => ({ externalId: 'cf-9', status: 'pending', records: [{ type: 'TXT', name: '_cf.x.com', value: 'v' }] }),
      get: async () => ({ externalId: 'cf-9', status, reason: status === 'failed' ? 'SSL validation timed out' : undefined }),
      remove: async (id) => void removed.push(id),
    };
    const h = makeHarness({ deps: { domainProvider: provider } });
    const u = await h.register();
    const d = (await h.call('POST', '/api/domains', { token: u.token, body: { hostname: 'saas.example.com' } })).json;
    expect(d).toMatchObject({ provider: 'cloudflare', status: 'pending', extraRecords: [{ type: 'TXT' }] });
    const verify = () => h.call('POST', `/api/domains/${d.id}/verify`, { token: u.token });
    expect((await verify()).json.domain.status).toBe('pending');
    status = 'active';
    expect((await verify()).json.domain.status).toBe('active');
    const f = await makeFunnel(h, u.token);
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: d.id, status: 'live' } });
    status = 'failed';
    const lost = (await verify()).json.domain;
    expect(lost).toMatchObject({ status: 'failed', failureReason: 'SSL validation timed out' });
    expect((await h.call('GET', `/api/funnels/${f.id}`, { token: u.token })).json).toMatchObject({ status: 'test', domain: null });
    await h.call('DELETE', `/api/domains/${d.id}`, { token: u.token });
    expect(removed).toEqual(['cf-9']);
  });
});

describe('trusting CF-Connecting-IP', () => {
  const req = (h: Record<string, string>) => ({ req: { header: (n: string) => h[n.toLowerCase()] }, env: { incoming: { socket: { remoteAddress: '10.0.0.9' } } } });
  const cfg = { TRUST_PROXY: false, CF_ORIGIN_SECRET: 'origin-secret-origin' };
  it('only when the shared secret header proves the request came through our Cloudflare path', () => {
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5', 'x-cf-origin-secret': 'origin-secret-origin' }), cfg)).toBe('203.0.113.5');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5' }), cfg)).toBe('10.0.0.9');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5', 'x-cf-origin-secret': 'wrong-secret-wrong!' }), cfg)).toBe('10.0.0.9');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5', 'x-cf-origin-secret': 'origin-secret-origin' }), { TRUST_PROXY: false })).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }), { TRUST_PROXY: true })).toBe('1.1.1.1');
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }), { TRUST_PROXY: false })).toBe('10.0.0.9');
  });
  it('a spoofed header cannot dodge the per-IP rate limit', async () => {
    const h = makeHarness({ env: { PUBLIC_EVENTS_PER_MINUTE: '2', CF_ORIGIN_SECRET: 'origin-secret-origin', TRUST_PROXY: 'false' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const send = (ip: string, secret?: string) => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: 'v' }, headers: { ...UA, 'cf-connecting-ip': ip, ...(secret ? { 'x-cf-origin-secret': secret } : {}) } });
    for (let i = 0; i < 2; i++) expect((await send(`9.9.9.${i}`)).status).toBe(202); // untrusted header: all share one bucket
    expect((await send('9.9.9.9')).status).toBe(429);
    expect((await send('8.8.8.8', 'origin-secret-origin')).status).toBe(202); // genuine edge traffic is keyed by the real client IP
  });
});

describe('write-behind event buffer', () => {
  const view = (h: Harness, f: any, visitor: string) => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: visitor }, headers: UA });
  const rows = (h: Harness) => h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n;

  it('queues, batches into one transaction, and readers see their own writes', async () => {
    const h = makeHarness({ env: { EVENT_BUFFER_MS: '60000' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    for (let i = 0; i < 50; i++) await view(h, f, `v${i % 10}`);
    expect(rows(h)).toBe(0);
    expect(h.deps.events.depth).toBe(50);
    const a = (await h.call('GET', `/api/funnels/${f.id}/analytics`, { token: u.token })).json;
    expect(a.summary.pageViews).toEqual({ all: 50, unique: 10 });
    expect(a.steps[0].pageViews).toEqual({ all: 50, unique: 10 }); // uniqueness decided across queued rows
    expect(h.deps.events.depth).toBe(0);
    expect(h.deps.events.flushes).toBe(1);
    expect((await h.call('GET', '/api/funnels', { token: u.token })).json.data[0].stats.visits).toBe(50);
  });

  it('flushes on the timer, on overflow (backpressure) and on close', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness({ env: { EVENT_BUFFER_MS: '100', EVENT_BUFFER_MAX: '5' } });
      const u = await h.register();
      const f = await makeFunnel(h, u.token);
      await view(h, f, 'a');
      expect(rows(h)).toBe(0);
      vi.advanceTimersByTime(150);
      expect(rows(h)).toBe(1);
      for (let i = 0; i < 5; i++) await view(h, f, `b${i}`);
      expect(rows(h)).toBe(6); // the 5th queued row hit the bound and flushed synchronously
      await view(h, f, 'late');
      expect(h.deps.events.depth).toBe(1);
      h.deps.events.close();
      expect(rows(h)).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps opt-in idempotency across queued rows and drops rows of funnels purged before the flush', async () => {
    const h = makeHarness({ env: { EVENT_BUFFER_MS: '60000' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const optin = () => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'optin', externalId: 'resp-1' }, headers: UA });
    expect((await optin()).json.recorded).toBe(true);
    expect((await optin()).json).toMatchObject({ recorded: false, reason: 'duplicate' });
    await view(h, f, 'x');
    h.deps.db.run('PRAGMA foreign_keys = OFF');
    h.deps.db.run('DELETE FROM funnels WHERE id = ?', f.id);
    h.deps.db.run('PRAGMA foreign_keys = ON');
    expect(h.deps.events.flush()).toBe(2);
    expect(rows(h)).toBe(0);
  });

  it('the rollup trigger keeps 15-minute buckets in step with raw events', async () => {
    const h = makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    await view(h, f, 'v1');
    await view(h, f, 'v1');
    h.clock.advance(16 * 60_000);
    await view(h, f, 'v2');
    const buckets = h.deps.db.all<{ bucket: string; page_views: number; unique_views: number }>('SELECT bucket, page_views, unique_views FROM event_rollups ORDER BY bucket');
    expect(buckets).toEqual([{ bucket: '2026-03-10T12:00', page_views: 2, unique_views: 1 }, { bucket: '2026-03-10T12:15', page_views: 1, unique_views: 1 }]);
    const raw = h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM events')!.n;
    expect(raw).toBe(3);
  });
});

describe('hot query plans use indexes', () => {
  it('EXPLAIN QUERY PLAN shows no full scan of large tables for the hot paths', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const db = h.deps.db;
    const plan = (sql: string, ...p: (string | number)[]) => db.explain(sql, ...p).join(' | ');
    const checks: [string, string, (string | number)[], RegExp][] = [
      ['funnel list', `SELECT f.* FROM funnels f WHERE f.workspace_id = ? AND f.deleted_at IS NULL ORDER BY f.updated_at DESC LIMIT 20`, [u.wsId], /USING (COVERING )?INDEX idx_funnels_workspace/],
      ['steps of a funnel', 'SELECT * FROM steps WHERE workspace_id = ? AND funnel_id = ? ORDER BY position', [u.wsId, t.funnelId], /USING (COVERING )?INDEX/],
      ['public page lookup', `SELECT s.* FROM steps s JOIN funnels f ON f.id = s.funnel_id WHERE f.domain_id = ? AND f.status = 'live' AND s.path_key = ?`, ['d', '/x'], /idx_funnels_domain.*SEARCH s USING (COVERING )?INDEX sqlite_autoindex_steps_2 .funnel_id=. AND path_key=./],
      ['domain by hostname', 'SELECT * FROM domains WHERE hostname = ?', ['a.com'], /USING (COVERING )?INDEX sqlite_autoindex_domains/],
      ['rollup range', 'SELECT SUM(page_views) FROM event_rollups WHERE funnel_id = ? AND workspace_id = ? AND bucket >= ? AND bucket < ? GROUP BY step_id', [t.funnelId, u.wsId, 'a', 'b'], /SEARCH .* USING (COVERING )?INDEX sqlite_autoindex_event_rollups_1|PRIMARY KEY/],
      ['visitor lookup', 'SELECT 1 FROM events WHERE funnel_id = ? AND step_id = ? AND type = ? AND visitor_id = ? LIMIT 1', [t.funnelId, t.stepId, 'page_view', 'v'], /USING (COVERING )?INDEX idx_events_visitor/],
      ['optin dedupe', 'SELECT 1 FROM events WHERE funnel_id = ? AND type = ? AND external_id = ?', [t.funnelId, 'optin', 'x'], /USING (COVERING )?INDEX idx_events_dedupe/],
      ['leads list (keyset)', 'SELECT * FROM leads l WHERE l.workspace_id = ? ORDER BY l.created_at DESC, l.rowid DESC LIMIT 25', [u.wsId], /USING (COVERING )?INDEX idx_leads_workspace_created|sqlite_autoindex_leads_1/],
      ['orders list', 'SELECT * FROM orders o WHERE o.workspace_id = ? ORDER BY o.created_at DESC LIMIT 25', [u.wsId], /USING (COVERING )?INDEX idx_orders_workspace/],
      ['due jobs', `SELECT id FROM jobs WHERE status = 'queued' AND run_at <= ? ORDER BY run_at LIMIT 10`, [1], /USING (COVERING )?INDEX idx_jobs_due/],
      ['backups of a step', 'SELECT * FROM step_backups WHERE step_id = ? ORDER BY created_at DESC', [t.stepId], /USING (COVERING )?INDEX idx_backups_step/],
      ['notifications', 'SELECT * FROM notifications WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 50', [u.wsId], /USING (COVERING )?INDEX idx_notifications_workspace/],
    ];
    for (const [name, sql, p, re] of checks) expect(plan(sql, ...p), name).toMatch(re);
    for (const [name, sql, p] of checks) expect(plan(sql, ...p), `${name} must not scan`).not.toMatch(/\bSCAN (events|leads|orders|steps|funnels|event_rollups)\b(?! USING)/);
  });

  it('list endpoints issue a constant number of queries regardless of page size (no N+1)', async () => {
    const h = makeHarness();
    const u = await h.register();
    const raw = h.deps.db.raw as unknown as { prepare: (s: string) => unknown };
    const orig = raw.prepare.bind(raw);
    let prepared = 0;
    const count = async () => {
      prepared = 0;
      await h.call('GET', '/api/funnels?limit=100', { token: u.token });
      return h.deps.db.get('SELECT 1') && prepared;
    };
    // prepared statements are cached, so count executions through the statement cache instead
    const db = h.deps.db as unknown as { stmt: (sql: string) => unknown };
    const stmt = db.stmt.bind(db);
    let calls = 0;
    db.stmt = (sql: string) => { calls++; return stmt(sql); };
    void orig; void count;
    for (let i = 0; i < 3; i++) await makeFunnel(h, u.token, { name: `F${i}` });
    calls = 0;
    await h.call('GET', '/api/funnels?limit=100', { token: u.token });
    const small = calls;
    for (let i = 3; i < 30; i++) await makeFunnel(h, u.token, { name: `F${i}` });
    calls = 0;
    const r = await h.call('GET', '/api/funnels?limit=100', { token: u.token });
    expect(r.json.data).toHaveLength(30);
    expect(calls).toBe(small);
  });
});

describe('compression, metrics and streaming exports', () => {
  it('gzips pages and JSON on request, but never the SSE stream', async () => {
    const h = makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Z' });
    const json = await h.app.request('/api/funnels', { headers: { authorization: `Bearer ${u.token}`, 'accept-encoding': 'gzip' } });
    expect(json.headers.get('content-encoding')).toBe('gzip');
    const t = (await h.call('POST', `/api/funnels/${f.id}/preview-token`, { token: u.token })).json;
    const page = await h.app.request(t.url, { headers: { 'accept-encoding': 'gzip' } });
    expect(page.headers.get('content-encoding')).toBe('gzip');
    const ticket = (await h.call('POST', '/api/events/ticket', { token: u.token })).json.ticket;
    const sse = await h.app.request(`/api/events/stream?ticket=${ticket}`, { headers: { 'accept-encoding': 'gzip' } });
    expect(sse.headers.get('content-encoding')).toBeNull();
    await sse.body?.cancel();
  });

  it('exposes Prometheus metrics with route-pattern labels, optionally behind a token', async () => {
    const h = makeHarness();
    const u = await h.register();
    await h.call('GET', '/api/funnels', { token: u.token });
    await h.call('GET', '/api/funnels/fn_abc', { token: u.token });
    await h.call('GET', '/api/funnels/fn_def', { token: u.token });
    const text = (await h.call('GET', '/metrics')).text;
    expect(text).toContain('funnels_http_requests_total{method="GET",route="/api/funnels",status="2xx"}');
    expect(text).toMatch(/route="\/api\/funnels\/:id"[^}]*status="4xx"\} 2/);
    expect(text).not.toContain('fn_abc'); // raw ids never become label values
    expect(text).toContain('funnels_event_buffer_depth 0');
    expect(text).toContain('funnels_jobs{status="queued"}');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
    const secured = makeHarness({ env: { METRICS_TOKEN: 'scrape-me' } });
    expect((await secured.call('GET', '/metrics')).status).toBe(401);
    expect((await secured.call('GET', '/metrics', { headers: { authorization: 'Bearer scrape-me' } })).status).toBe(200);
  });

  it('streams large CSV exports in keyset pages with bounded memory and no gaps or duplicates', async () => {
    const h = makeHarness();
    const u = await h.register();
    const t = await formTarget(h, u.token);
    h.deps.db.tx(() => {
      for (let i = 0; i < 2600; i++) {
        h.deps.db.run('INSERT INTO leads (id, workspace_id, email, name, first_funnel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', `l${i}`, u.wsId, `user${i}@example.com`, i === 5 ? '=EVIL()' : `User ${i}`, t.funnelId, `2026-03-0${1 + (i % 9)}T10:00:00.000Z`, '2026-03-10T00:00:00.000Z');
      }
    });
    const res = await h.app.request('/api/leads/export', { headers: { authorization: `Bearer ${u.token}` } });
    expect(res.headers.get('content-type')).toContain('text/csv');
    const reader = res.body!.getReader();
    let chunks = 0;
    let text = '';
    let maxChunk = 0;
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks++;
      maxChunk = Math.max(maxChunk, value.length);
      text += dec.decode(value);
    }
    expect(chunks).toBeGreaterThanOrEqual(4); // header + 3 pages
    const lines = text.trim().split('\r\n');
    expect(lines).toHaveLength(2601);
    expect(new Set(lines.slice(1).map((l) => l.split(',')[0])).size).toBe(2600);
    expect(text).toContain(`'=EVIL()`);
    expect(maxChunk).toBeLessThan(200_000);
    const orders = await h.app.request('/api/orders/export', { headers: { authorization: `Bearer ${u.token}` } });
    expect((await orders.text()).trim().split('\r\n')).toHaveLength(1);
  });

  it('csvStream pulls lazily', async () => {
    let pages = 0;
    const s = csvStream<number>(['a'], (c) => (++pages, { rows: [[c ?? 0]], cursor: (c ?? 0) < 2 ? (c ?? 0) + 1 : null }));
    const r = s.getReader();
    await r.read();
    expect(pages).toBe(0);
    await r.read();
    expect(pages).toBe(1);
  });
});

describe('concurrency: no lost updates or duplicate rows', () => {
  it('parallel saves with the same base version: exactly one wins, the rest get 409 with the current version', async () => {
    const h = makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const url = `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`;
    const base = (await h.call('GET', url, { token: u.token })).json.version;
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => h.call('PUT', url, { token: u.token, body: { version: base, doc: { version: 1, blocks: [{ id: `p${i}`, type: 'paragraph', text: `v${i}` }] } } })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const losers = results.filter((r) => r.status === 409);
    expect(losers).toHaveLength(9);
    expect(losers[0]!.json.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: expect.any(Number) } });
    const winner = results.findIndex((r) => r.status === 200);
    const stored = (await h.call('GET', url, { token: u.token })).json;
    expect(stored.doc.blocks[0].text).toBe(`v${winner}`);
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM step_backups')).toEqual({ n: 1 });
  });

  it('parallel duplicates get distinct names and paths; parallel reorders leave a valid contiguous order', async () => {
    const h = makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Race' });
    const dups = await Promise.all(Array.from({ length: 8 }, () => h.call('POST', `/api/funnels/${f.id}/duplicate`, { token: u.token })));
    expect(dups.every((r) => r.status === 201)).toBe(true);
    const names = dups.map((r) => r.json.name);
    expect(new Set(names).size).toBe(8);
    const sd = await Promise.all(Array.from({ length: 6 }, () => h.call('POST', `/api/funnels/${f.id}/steps/${f.steps[0].id}/duplicate`, { token: u.token })));
    expect(new Set(sd.map((r) => r.json.path)).size).toBe(6);
    const steps = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data;
    const ids = steps.map((s: any) => s.id);
    const orders = (rev: boolean) => (rev ? [...ids].reverse() : ids).map((stepId: string, i: number) => ({ stepId, order: i + 1 }));
    await Promise.all(Array.from({ length: 6 }, (_, i) => h.call('PUT', `/api/funnels/${f.id}/steps/order`, { token: u.token, body: { orders: orders(i % 2 === 0) } })));
    const after = (await h.call('GET', `/api/funnels/${f.id}/steps`, { token: u.token })).json.data;
    expect(after.map((s: any) => s.position)).toEqual(after.map((_: unknown, i: number) => i + 1));
    expect(new Set(after.map((s: any) => s.id)).size).toBe(ids.length);
  });

  it('parallel domain attach: both funnels cannot end up with the same path on one domain', async () => {
    const h = makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const fs = await Promise.all(['A', 'B', 'C'].map((n) => makeFunnel(h, u.token, { name: n, base_path: '/same' })));
    const res = await Promise.all(fs.map((f) => h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom } })));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(2);
    const paths = h.deps.db.all<{ p: string }>('SELECT s.path_key AS p FROM steps s JOIN funnels f ON f.id = s.funnel_id WHERE f.domain_id = ?', dom);
    expect(new Set(paths.map((x) => x.p)).size).toBe(paths.length);
  });

  it('parallel identical submissions create one lead, one opt-in and one order', async () => {
    const h = makeHarness({ env: { PUBLIC_FORMS_PER_MINUTE: '100' } });
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const body = { fields: { name: 'Ada', email: 'ada@example.com', _consent: true }, consent: true, submissionId: 'same-submission-1' };
    const results = await Promise.all(Array.from({ length: 12 }, () => h.call('POST', t.path, { body, headers: UA })));
    expect(results.filter((r) => r.json.recorded === true)).toHaveLength(1);
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM leads')).toEqual({ n: 1 });
    expect(h.deps.db.get("SELECT COUNT(*) AS n FROM events WHERE type = 'optin'")).toEqual({ n: 1 });
    const many = await Promise.all(Array.from({ length: 12 }, (_, i) => h.call('POST', t.path, { body: { fields: { name: 'Same', email: 'same@example.com', _consent: true }, consent: true, submissionId: `distinct-sub-${i}` }, headers: UA })));
    expect(many.every((r) => r.status === 200)).toBe(true);
    expect(h.deps.db.get("SELECT submissions FROM leads WHERE email = 'same@example.com'")).toEqual({ submissions: 12 });
  });

  it('rate limiting is exact under parallel requests', async () => {
    const h = makeHarness({ env: { PUBLIC_EVENTS_PER_MINUTE: '20' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const rs = await Promise.all(Array.from({ length: 60 }, () => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: 'v' }, headers: UA })));
    expect(rs.filter((r) => r.status === 202)).toHaveLength(20);
    expect(rs.filter((r) => r.status === 429)).toHaveLength(40);
  });

  it('a burst of 500 parallel events is counted exactly', async () => {
    const h = makeHarness({ env: { PUBLIC_EVENTS_PER_MINUTE: '1000', EVENT_BUFFER_MS: '50' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    await Promise.all(Array.from({ length: 500 }, (_, i) => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: `v${i % 100}` }, headers: UA })));
    const a = (await h.call('GET', `/api/funnels/${f.id}/analytics`, { token: u.token })).json;
    expect(a.summary.pageViews).toEqual({ all: 500, unique: 100 });
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM events')).toEqual({ n: 500 });
  });
});
