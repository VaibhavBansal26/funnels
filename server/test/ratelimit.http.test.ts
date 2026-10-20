import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { clientIp, CLOUDFLARE_RANGES, inCidr } from '../src/ratelimit/ip.js';
import { RateLimiter } from '../src/ratelimit/limiter.js';
import { MemoryStore } from '../src/ratelimit/memory.js';
import { buildPolicies } from '../src/ratelimit/policies.js';
import { RateLimitAdmin } from '../src/ratelimit/admin.js';
import { OPERATIONS, matchOperation } from '../src/routes/spec.js';
import type { Store } from '../src/ratelimit/types.js';
import { activeDomain, formTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

const cfg = { IP_GUARD_PER_MINUTE: 1_000_000, PUBLIC_EVENTS_PER_MINUTE: 120, PUBLIC_FORMS_PER_MINUTE: 20, PUBLIC_PAGES_PER_MINUTE: 1_000_000, AUTH_ATTEMPTS_PER_MINUTE: 10, AI_RATE_LIMIT_PER_MINUTE: 10, API_USER_PER_MINUTE: 600, API_WORKSPACE_PER_MINUTE: 600, EXPORT_CONCURRENCY: 2, EDGE_RESOLVE_PER_MINUTE: 120_000 };

describe('the route declaration', () => {
  it('lists every route the app registers, and nothing else', async () => {
    const h = await makeHarness();
    const registered = new Set<string>();
    for (const r of createApp(h.deps).routes) if (r.method !== 'ALL' && r.path !== '/*') registered.add(`${r.method} ${r.path}`);
    const declared = new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`));
    expect([...registered].filter((r) => !declared.has(r)).sort(), 'registered but not declared in routes/spec.ts').toEqual([]);
    expect([...declared].filter((r) => !registered.has(r)).sort(), 'declared but not registered').toEqual([]);
    expect(new Set(OPERATIONS.map((o) => `${o.method} ${o.path}`)).size).toBe(OPERATIONS.length);
  });

  it('gives every route a limiter policy that exists, and every policy a route (or a documented reason)', async () => {
    const h = await makeHarness();
    const ids = new Set(h.deps.limiter.policies.map((p) => p.id));
    const used = new Set<string>();
    for (const o of OPERATIONS) {
      if (o.exempt) {
        expect(o.limits, `${o.method} ${o.path}`).toEqual([]);
        expect(o.exempt.length, 'an exemption needs a reason').toBeGreaterThan(10);
        continue;
      }
      const all = [...o.limits, ...(o.inHandler ?? [])];
      expect(all.length, `${o.method} ${o.path} has no limiter policy`).toBeGreaterThan(0);
      for (const id of all) {
        expect(ids.has(id), `${o.method} ${o.path} names unknown policy "${id}"`).toBe(true);
        used.add(id);
      }
      if (['user', 'admin', 'owner', 'platform'].includes(o.auth)) {
        expect(o.limits.some((id) => h.deps.limiter.policy(id).layer === 'workspace'), `${o.method} ${o.path}: authenticated routes count against the workspace quota`).toBe(true);
        expect(o.limits.some((id) => h.deps.limiter.policy(id).layer === 'principal'), `${o.method} ${o.path}: and against the caller`).toBe(true);
      }
      if (o.auth === 'public') expect(o.limits.some((id) => ['ip', 'class'].includes(h.deps.limiter.policy(id).layer)), `${o.method} ${o.path}`).toBe(true);
    }
    const reserved = new Set(['public.page' /* applied in host routing */, 'webhook.inbound' /* reserved for Stripe */, 'auth.failures.ip']);
    expect([...ids].filter((id) => !used.has(id) && !reserved.has(id))).toEqual([]);
  });

  it('declares authentication and roles that the routes really enforce', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const member = await h.member(owner, 'member');
    const fill = (p: string) => p.replace(/:[A-Za-z]+/g, 'x').replace('*', 'x');
    for (const o of OPERATIONS) {
      const path = fill(o.path);
      const tokenGated = o.path.startsWith('/preview/'); // authorised by a signed ?token=, answered with a message page
      if (['user', 'admin', 'owner'].includes(o.auth)) {
        const anon = await h.call(o.method, path, { body: o.method === 'GET' || o.method === 'DELETE' ? undefined : {} });
        expect(anon.status, `${o.method} ${o.path} must require a token`).toBe(401);
      }
      if (o.auth === 'admin' || o.auth === 'owner') {
        const low = await h.call(o.method, path, { token: member.token, body: o.method === 'GET' || o.method === 'DELETE' ? undefined : {} });
        expect(low.status, `${o.method} ${o.path} must refuse a member`).toBe(403);
      }
      if (o.auth === 'public' && !tokenGated) {
        const open = await h.call(o.method, path, { body: o.method === 'GET' ? undefined : {}, headers: UA });
        expect(open.status, `${o.method} ${o.path} is declared public`).not.toBe(401);
      }
    }
  });

  it('matches operations by method and path, literals before parameters', () => {
    expect(matchOperation('GET', '/api/funnels/filters')?.op.path).toBe('/api/funnels/filters');
    expect(matchOperation('GET', '/api/funnels/fn_1')?.params).toEqual({ id: 'fn_1' });
    expect(matchOperation('POST', '/api/public/forms/f/s/b')?.params).toEqual({ funnelId: 'f', stepId: 's', blockId: 'b' });
    expect(matchOperation('GET', '/api/templates/categories')?.op.path).toBe('/api/templates/categories');
    expect(matchOperation('GET', '/nope')).toBeNull();
    expect(matchOperation('DELETE', '/api/funnels/')?.op.path).toBeUndefined;
  });
});

describe('HTTP contract', () => {
  it('sends IETF and legacy rate limit headers that count down, and none of them leak other tenants', async () => {
    const h = await makeHarness({ env: { API_WORKSPACE_PER_MINUTE: '30' } });
    const u = await h.register();
    const a = await h.call('GET', '/api/workspace', { token: u.token });
    const b = await h.call('GET', '/api/workspace', { token: u.token });
    for (const r of [a, b]) {
      expect(r.status).toBe(200);
      expect(r.headers.get('ratelimit-policy')).toMatch(/^"[a-z.]+";q=\d+;w=\d+$/);
      expect(r.headers.get('ratelimit')).toMatch(/^"[a-z.]+";r=\d+;t=\d+$/);
      expect(Number(r.headers.get('x-ratelimit-limit'))).toBeGreaterThan(0);
      expect(r.headers.get('retry-after')).toBeNull();
    }
    expect(Number(b.headers.get('x-ratelimit-remaining'))).toBeLessThan(Number(a.headers.get('x-ratelimit-remaining')));
    expect(a.headers.get('ratelimit-policy')).toContain('api.workspace'); // free plan: the workspace quota is the tightest layer
    const other = await h.register();
    const c = await h.call('GET', '/api/workspace', { token: other.token });
    expect(Number(c.headers.get('x-ratelimit-remaining'))).toBe(Number(a.headers.get('x-ratelimit-remaining'))); // a fresh tenant starts full
  });

  it('answers 429 with the documented body, Retry-After and the same headers', async () => {
    const h = await makeHarness({ env: { PUBLIC_FORMS_PER_MINUTE: '2' } });
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const post = () => h.call('POST', t.path, { body: { fields: {} }, headers: UA });
    expect((await post()).status).not.toBe(429);
    expect((await post()).status).not.toBe(429);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.json).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String), retry_after_s: expect.any(Number), policy: 'public.forms' } });
    expect(limited.headers.get('retry-after')).toBe(String(limited.json.error.retry_after_s));
    expect(limited.json.error.retry_after_s).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get('ratelimit-policy')).toContain('public.forms');
    expect(limited.headers.get('ratelimit')).toMatch(/r=0;/);
    expect(JSON.stringify(limited.json)).not.toMatch(/203\.0\.113|ip:|cmp:/); // no keys in the body
  });

  it('Retry-After is honest: waiting that long gets the next request admitted', async () => {
    const h = await makeHarness({ env: { PUBLIC_FORMS_PER_MINUTE: '6' } });
    const u = await h.register();
    const t = await formTarget(h, u.token);
    const post = () => h.call('POST', t.path, { body: { fields: {} }, headers: UA });
    for (let i = 0; i < 6; i++) await post();
    const limited = await post();
    expect(limited.status).toBe(429);
    h.clock.advance(limited.json.error.retry_after_s * 1000);
    expect((await post()).status).not.toBe(429);
  });

  it('503 + Retry-After when a workspace is at its concurrent export cap, and the slot frees on release', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const p = { ip: '203.0.113.7', workspaceId: u.wsId, userId: u.userId };
    const held = [await h.deps.limiter.acquire('api.export', p), await h.deps.limiter.acquire('api.export', p)];
    const refused = await h.call('GET', '/api/leads/export', { token: u.token });
    expect(refused.status).toBe(503);
    expect(refused.json.error).toMatchObject({ code: 'OVERLOADED', policy: 'api.export' });
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await held[0]!.release();
    const ok = await h.app.request('/api/leads/export', { headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': '203.0.113.7' } });
    expect(ok.status).toBe(200);
    await ok.text(); // reading to the end releases the slot
    expect((await h.deps.limiter.acquire('api.export', p)).decision.allowed).toBe(true);
  });

  it('a slot is released when the client abandons the export', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const p = { ip: '203.0.113.7', workspaceId: u.wsId, userId: u.userId };
    const one = await h.deps.limiter.acquire('api.export', p);
    const res = await h.app.request('/api/leads/export', { headers: { authorization: `Bearer ${u.token}`, 'x-forwarded-for': '203.0.113.7' } });
    expect(res.status).toBe(200);
    expect((await h.deps.limiter.acquire('api.export', p)).decision.allowed).toBe(false); // both slots busy
    await res.body!.cancel();
    expect((await h.deps.limiter.acquire('api.export', p)).decision.allowed).toBe(true);
    await one.release();
  });

  it('caps open event streams per user', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const open = async () => {
      const t = (await h.call('POST', '/api/events/ticket', { token: u.token })).json.ticket;
      return h.app.request(`/api/events/stream?ticket=${t}`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
    };
    const streams = [];
    for (let i = 0; i < 5; i++) streams.push(await open());
    expect(streams.map((s) => s.status)).toEqual([200, 200, 200, 200, 200]);
    const sixth = await open();
    expect(sixth.status).toBe(503);
    for (const s of streams) await s.body?.cancel();
    await new Promise((r) => setTimeout(r, 50));
    const again = await open();
    expect(again.status).toBe(200);
    await again.body?.cancel();
  });

  it('does not count a repeated Idempotency-Key twice', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '12' } }); // writes: 6/min, burst 2
    const u = await h.register();
    const write = (key?: string) => h.call('POST', '/api/funnels/validate-path', { token: u.token, body: { path: '/ok' }, headers: key ? { 'idempotency-key': key } : {} });
    for (let i = 0; i < 20; i++) expect((await write('same-key')).status).toBe(200);
    const distinct = [];
    for (let i = 0; i < 6; i++) distinct.push((await write(`k${i}`)).status);
    expect(distinct.filter((s) => s === 429).length).toBeGreaterThan(0);
  });

  it('keeps tenants apart: one workspace exhausting its quota does not touch another', async () => {
    const h = await makeHarness({ env: { API_WORKSPACE_PER_MINUTE: '30' } });
    const a = await h.register();
    const b = await h.register();
    let n = 0;
    while ((await h.call('GET', '/api/workspace', { token: a.token })).status === 200 && n < 100) n++;
    expect(n).toBe(10); // free plan: burst = 30 / 3
    expect((await h.call('GET', '/api/workspace', { token: b.token })).status).toBe(200);
  });
});

describe('plan tiers', () => {
  it('scale the workspace quota (free x1, pro x5, business x20) and a per-workspace multiplier, and apply within one request', async () => {
    const h = await makeHarness({ env: { API_WORKSPACE_PER_MINUTE: '30' } });
    const u = await h.register();
    const admin = new RateLimitAdmin(h.deps);
    const drain = async (token: string) => {
      let n = 0;
      while ((await h.call('GET', '/api/workspace', { token })).status === 200 && n < 1000) n++;
      return n;
    };
    expect(await drain(u.token)).toBe(10);
    await admin.setTier('op@platform', u.wsId, { plan: 'pro' });
    h.clock.advance(3_600_000);
    expect(await drain(u.token)).toBe(50);
    await admin.setTier('op@platform', u.wsId, { plan: 'business' });
    h.clock.advance(3_600_000);
    expect(await drain(u.token)).toBe(200);
    await admin.setTier('op@platform', u.wsId, { plan: 'free', multiplier: 3 });
    h.clock.advance(3_600_000);
    const n3 = await drain(u.token);
    expect(n3).toBe(30);
    const rows = await h.deps.db.all<{ action: string }>('SELECT action FROM audit_log ORDER BY created_at, id');
    expect(rows.map((r) => r.action)).toEqual(['set_tier', 'set_tier', 'set_tier']);
    await expect(admin.setTier('op', u.wsId, { plan: 'gold' as never })).rejects.toThrow(/Plan must be/);
    await expect(admin.setTier('op', 'ws_missing', { plan: 'pro' })).rejects.toThrow(/not found/);
  });
});

describe('admin hooks', () => {
  it('block, allow and unblock a client with a TTL, audited, and listed as limited', async () => {
    const h = await makeHarness({ env: { PUBLIC_EVENTS_PER_MINUTE: '3' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const admin = new RateLimitAdmin(h.deps);
    const send = (ip: string) => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: 'v' }, headers: { ...UA, 'x-forwarded-for': ip } });
    expect((await send('198.51.100.9')).status).toBe(202);
    await admin.block('op@platform', { kind: 'ip', value: '198.51.100.9' }, 600);
    const denied = await send('198.51.100.9');
    expect(denied.status).toBe(429);
    expect(denied.json.error.code).toBe('RATE_LIMITED');
    expect(Number(denied.headers.get('retry-after'))).toBeLessThanOrEqual(600);
    expect((await send('198.51.100.10')).status).toBe(202);
    h.clock.advance(601_000);
    expect((await send('198.51.100.9')).status).toBe(202); // the TTL ended the block
    await admin.block('op@platform', { kind: 'ip', value: '198.51.100.9' }, null);
    expect((await send('198.51.100.9')).status).toBe(429);
    await admin.unblock('op@platform', { kind: 'ip', value: '198.51.100.9' });
    expect((await send('198.51.100.9')).status).toBe(202);
    for (let i = 0; i < 6; i++) await send('198.51.100.20'); // exhaust the burst
    await admin.allow('op@platform', { kind: 'ip', value: '198.51.100.20' }, 60);
    expect((await send('198.51.100.20')).status).toBe(202); // allow-listed: bypasses every limiter
    expect((await admin.lists()).map((l) => `${l.kind}:${l.subject}`)).toContain('allow:ip:198.51.100.20');
    expect((await admin.limited(10)).some((r) => r.policyId === 'public.events' && r.subject.startsWith('cmp:198.51.100.20|'))).toBe(true); // IPs stay readable for operators; other ids are hashes
    const audit = await h.deps.db.all<{ action: string; actor_id: string }>('SELECT action, actor_id FROM audit_log ORDER BY created_at, id');
    expect(audit.map((a) => a.action)).toEqual(['block', 'block', 'unblock', 'allow']);
    expect(audit.every((a) => a.actor_id === 'op@platform')).toBe(true);
  });

  it('workspaces can be blocked and the block applies to their API calls', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const admin = new RateLimitAdmin(h.deps);
    await admin.block('op', { kind: 'workspace', value: u.wsId }, 300);
    const r = await h.call('GET', '/api/workspace', { token: u.token });
    expect(r.status).toBe(429);
    await admin.unblock('op', { kind: 'workspace', value: u.wsId });
    expect((await h.call('GET', '/api/workspace', { token: u.token })).status).toBe(200);
  });
});

describe('admin routes (platform admins only)', () => {
  it('list, block, allow and override tiers over HTTP, refusing everyone else', async () => {
    const h = await makeHarness({ env: { PLATFORM_ADMIN_EMAILS: 'ops@platform.test' } });
    const ops = await h.register('ops@platform.test');
    const user = await h.register('user@platform.test');
    expect((await h.call('GET', '/api/admin/rate-limits', { token: user.token })).status).toBe(403);
    expect((await h.call('POST', '/api/admin/rate-limits/blocks', { token: user.token, body: { kind: 'ip', value: '1.2.3.4' } })).status).toBe(403);
    const listed = await h.call('GET', '/api/admin/rate-limits', { token: ops.token });
    expect(listed.status).toBe(200);
    expect(listed.json.policies.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['ip.global', 'public.events', 'auth.attempts']));
    expect((await h.call('POST', '/api/admin/rate-limits/blocks', { token: ops.token, body: { kind: 'ip', value: '192.0.2.77', ttlSeconds: 120 } })).status).toBe(201);
    const blocked = await h.call('GET', '/beacon.js', { headers: { 'x-forwarded-for': '192.0.2.77' } });
    expect(blocked.status).toBe(429);
    expect((await h.call('GET', '/api/admin/rate-limits', { token: ops.token })).json.lists).toEqual([expect.objectContaining({ kind: 'deny', subject: 'ip:192.0.2.77' })]);
    expect((await h.call('DELETE', '/api/admin/rate-limits/blocks', { token: ops.token, body: { kind: 'ip', value: '192.0.2.77' } })).status).toBe(204);
    expect((await h.call('GET', '/beacon.js', { headers: { 'x-forwarded-for': '192.0.2.77' } })).status).toBe(200);
    const tier = await h.call('PUT', `/api/admin/workspaces/${user.wsId}/rate-tier`, { token: ops.token, body: { plan: 'pro', multiplier: 2 } });
    expect(tier.json).toEqual({ plan: 'pro', multiplier: 2 });
    expect((await h.call('PUT', `/api/admin/workspaces/${user.wsId}/rate-tier`, { token: ops.token, body: { plan: 'gold' } })).status).toBe(400);
    expect((await h.call('POST', '/api/admin/rate-limits/blocks', { token: ops.token, body: { kind: 'ip', value: '1.2.3.4', ttlSeconds: 0 } })).status).toBe(400);
  });
});

describe('penalty box and account lockout', () => {
  it('repeated violations on a fail-closed auth policy escalate to a timed block that outlasts the minute budget', async () => {
    const h = await makeHarness({ env: { AUTH_ATTEMPTS_PER_MINUTE: '3' } });
    const login = () => h.call('POST', '/api/auth/login', { body: { email: 'nobody@example.test', password: 'wrong-password' } });
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await login()).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
    const blocked = await login();
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(30); // the block, not the 20 s bucket refill
    h.clock.advance(61_000);
    expect((await login()).status).toBe(401); // block over, bucket refilled
  });

  it('locks an account after 8 failures in 15 minutes from any address, without affecting other accounts or counting successes', async () => {
    const h = await makeHarness({ env: { AUTH_ATTEMPTS_PER_MINUTE: '1000' } });
    await h.register('victim@example.test');
    await h.register('bystander@example.test');
    const login = (email: string, password: string, ip: string) => h.call('POST', '/api/auth/login', { body: { email, password }, headers: { 'x-forwarded-for': ip } });
    const good = 'correct horse battery';
    for (let i = 0; i < 20; i++) expect((await login('victim@example.test', good, `10.1.0.${i}`)).status).toBe(200); // successes never count
    for (let i = 0; i < 8; i++) expect((await login('victim@example.test', 'wrong-password', `10.2.0.${i}`)).status).toBe(401);
    const locked = await login('victim@example.test', good, '10.3.0.1'); // even the right password is refused during the lockout
    expect(locked.status).toBe(429);
    expect(locked.json.error).toMatchObject({ code: 'RATE_LIMITED', policy: 'auth.failures.account' });
    expect((await login('bystander@example.test', good, '10.3.0.2')).status).toBe(200);
    h.clock.advance(16 * 60_000);
    expect((await login('victim@example.test', good, '10.3.0.3')).status).toBe(200);
  });

  it('the lockout does not reveal whether an account exists', async () => {
    const h = await makeHarness({ env: { AUTH_ATTEMPTS_PER_MINUTE: '1000' } });
    const fail = async (email: string) => {
      const out = [];
      for (let i = 0; i < 10; i++) out.push((await h.call('POST', '/api/auth/login', { body: { email, password: 'wrong-password' }, headers: { 'x-forwarded-for': `10.9.${i}.1` } })).status);
      return out;
    };
    await h.register('real@example.test');
    expect(await fail('real@example.test')).toEqual(await fail('ghost@example.test'));
  });
});

describe('failure behaviour at the HTTP layer', () => {
  const broken: Store = new Proxy(new MemoryStore(undefined, 10, 0), {
    get: (t, k) => (k === 'kind' ? 'memory' : typeof (t as never)[k] === 'function' ? async () => { throw new Error('store down'); } : (t as never)[k]),
  });
  const failing = (h: Harness) => new RateLimiter({ store: broken, policies: buildPolicies({ ...cfg, ...h.deps.config }), hooks: {}, now: h.clock.now as never });

  it('general API keeps working when the store is down (fail-open), auth and public forms refuse with 503', async () => {
    const h0 = await makeHarness();
    const h = await makeHarness({ deps: { limiter: failing(h0) } });
    const u = await h.register().catch((e) => e);
    expect((u as Error).message).toMatch(/failed/); // register is fail-closed
    const direct = await h.call('POST', '/api/auth/register', { body: { email: 'x@example.test', password: 'correct horse battery', name: 'X' } });
    expect(direct.status).toBe(503);
    expect(direct.json.error.code).toBe('RATE_LIMITER_UNAVAILABLE');
    expect(Number(direct.headers.get('retry-after'))).toBeGreaterThan(0);
    // an already-issued token still works because the API policies fail open
    const ok = await h0.register();
    const h2 = await makeHarness({ deps: { limiter: failing(h0), db: h0.deps.db } });
    expect((await h2.call('GET', '/api/workspace', { token: ok.token })).status).toBe(200);
    const t = await formTarget(h0, ok.token);
    expect((await h2.call('POST', t.path, { body: { fields: {} }, headers: UA })).status).toBe(503);
    expect((await h2.call('POST', '/api/public/events', { body: { funnelId: t.funnelId, stepId: t.stepId, type: 'page_view', visitorId: 'v' }, headers: UA })).status).toBe(202);
  });

  it('RATELIMIT_ENABLED=false switches enforcement off', async () => {
    const h = await makeHarness({ env: { RATELIMIT_ENABLED: 'false', API_WORKSPACE_PER_MINUTE: '3', PUBLIC_FORMS_PER_MINUTE: '1' } });
    const u = await h.register();
    for (let i = 0; i < 30; i++) expect((await h.call('GET', '/api/workspace', { token: u.token })).status).toBe(200);
  });
});

describe('customer-domain page serving', () => {
  it('limits direct origin hits per IP and tells the client when to retry', async () => {
    const h = await makeHarness({ env: { PUBLIC_PAGES_PER_MINUTE: '40' } }); // burst = a quarter of the per-minute rate
    const u = await h.register();
    const dom = await activeDomain(h, u.token, 'limited.example.com');
    const f = await makeFunnel(h, u.token, { name: 'P', base_path: '/promo' });
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
    const get = () => h.app.request('/promo', { headers: { host: 'limited.example.com', 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '198.51.100.50' } });
    const codes = [];
    for (let i = 0; i < 16; i++) codes.push((await get()).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(10);
    const refused = await get();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
  });
});

describe('observability', () => {
  it('exposes decisions per policy and outcome, with no client identifiers in the metrics', async () => {
    const h = await makeHarness({ env: { PUBLIC_FORMS_PER_MINUTE: '1' } });
    const u = await h.register();
    const t = await formTarget(h, u.token);
    for (let i = 0; i < 3; i++) await h.call('POST', t.path, { body: { fields: {} }, headers: UA });
    const text = (await h.call('GET', '/metrics')).text;
    expect(text).toMatch(/funnels_ratelimit_decisions_total\{policy="public\.forms",outcome="limited"\} \d+/);
    expect(text).toMatch(/funnels_ratelimit_decisions_total\{policy="api\.read",outcome="allowed"\}|funnels_ratelimit_decisions_total\{policy="ip\.global",outcome="allowed"\}/);
    expect(text).toContain('funnels_ratelimit_breaker_state 0');
    expect(text).toContain('funnels_ratelimit_penalty_box');
    expect(text).not.toMatch(/203\.0\.113\.7|cmp:|usr:|ws_/);
  });
});

describe('trusted client address', () => {
  const req = (hdr: Record<string, string>, peer = '10.0.0.9') => ({ req: { header: (n: string) => hdr[n.toLowerCase()] }, env: { incoming: { socket: { remoteAddress: peer } } } });
  const base = { TRUST_PROXY: false };

  it('believes CF-Connecting-IP only from our Cloudflare path (secret) or from Cloudflare addresses, never from anyone else', () => {
    const secret = { ...base, CF_ORIGIN_SECRET: 'origin-secret-origin' };
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5', 'x-cf-origin-secret': 'origin-secret-origin' }), secret)).toBe('203.0.113.5');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5' }, '173.245.48.9'), base)).toBe('203.0.113.5'); // peer is a Cloudflare address
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5' }, '2606:4700::1'), base)).toBe('203.0.113.5'); // IPv6 Cloudflare range
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5' }, '173.245.64.1'), base)).toBe('173.245.64.1'); // just outside 173.245.48.0/20
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5' }, '8.8.8.8'), base)).toBe('8.8.8.8');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5', 'x-cf-origin-secret': 'nope-nope-nope-no' }, '8.8.8.8'), secret)).toBe('8.8.8.8');
    expect(clientIp(req({ 'cf-connecting-ip': 'not-an-ip' }, '173.245.48.9'), base)).toBe('173.245.48.9');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5' }, '173.245.48.9'), { ...base, TRUST_CLOUDFLARE_RANGES: false })).toBe('173.245.48.9');
    expect(clientIp(req({ 'cf-connecting-ip': '203.0.113.5' }, '192.0.2.1'), { ...base, CF_IP_RANGES: ['192.0.2.0/24'] })).toBe('203.0.113.5');
  });

  it('counts X-Forwarded-For from the right and ignores the client-controlled left side', () => {
    const t = { TRUST_PROXY: true };
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 1.1.1.1' }), t)).toBe('1.1.1.1');
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }), t)).toBe('1.1.1.1');
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 5.5.5.5, 1.1.1.1' }), { ...t, TRUSTED_PROXY_HOPS: 2 })).toBe('5.5.5.5');
    expect(clientIp(req({ 'x-forwarded-for': 'garbage' }), t)).toBe('10.0.0.9');
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1' }), base)).toBe('10.0.0.9'); // proxy not trusted: header ignored
    expect(clientIp({ req: { header: () => undefined } }, base)).toBe('unknown');
  });

  it('matches CIDR ranges for IPv4, IPv6 and IPv4-mapped IPv6', () => {
    expect(inCidr('104.16.0.1', '104.16.0.0/13')).toBe(true);
    expect(inCidr('104.24.0.1', '104.16.0.0/13')).toBe(false);
    expect(inCidr('::ffff:104.16.0.1', '104.16.0.0/13')).toBe(true);
    expect(inCidr('2606:4700:1234::1', '2606:4700::/32')).toBe(true);
    expect(inCidr('2606:4701::1', '2606:4700::/32')).toBe(false);
    expect(CLOUDFLARE_RANGES.every((r) => inCidr(r.split('/')[0]!, r))).toBe(true);
  });

  it('keys IPv6 clients by /64 so one household cannot take a bucket per address', async () => {
    const h = await makeHarness({ env: { PUBLIC_EVENTS_PER_MINUTE: '2' } });
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const send = (ip: string) => h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: 'v' }, headers: { ...UA, 'x-forwarded-for': ip } });
    expect((await send('2001:db8:1:2::1')).status).toBe(202);
    expect((await send('2001:db8:1:2:aaaa::2')).status).toBe(202);
    expect((await send('2001:db8:1:2:ffff:ffff:ffff:ffff')).status).toBe(429); // same /64
    expect((await send('2001:db8:1:3::1')).status).toBe(202); // neighbouring /64
  });
});
