import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { Db, migrate } from '../src/db/db.js';
import { createLogger } from '../src/logger.js';
import { RateLimiter } from '../src/util/ratelimit.js';
import { PageCache } from '../src/util/pagecache.js';
import { EventBus } from '../src/util/bus.js';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemo } from '../src/seed.js';
import { makeHarness } from './helpers.js';

describe('config', () => {
  it('works with zero env in development, generating a JWT secret', () => {
    const c = loadConfig({});
    expect(c.NODE_ENV).toBe('development');
    expect(c.PORT).toBe(3000);
    expect(c.JWT_SECRET).toHaveLength(64);
    expect(c.JWT_SECRET_GENERATED).toBe(true);
    expect(c.PLATFORM_ADMIN_EMAILS).toEqual([]);
    expect(c.ANTHROPIC_MODEL).toBe('claude-sonnet-5-5');
    expect(c.TRUST_PROXY).toBe(false);
    expect(loadConfig({}).JWT_SECRET).not.toBe(c.JWT_SECRET);
  });

  it('requires a strong JWT secret in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET is required/);
    expect(() => loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short' })).toThrow(/at least 32/);
    const ok = loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) });
    expect(ok.JWT_SECRET_GENERATED).toBe(false);
  });

  it('parses lists, booleans and integers and rejects invalid values', () => {
    const c = loadConfig({ PLATFORM_ADMIN_EMAILS: ' a@x.com , b@x.com,,', CORS_ORIGINS: 'https://a.test', TRUST_PROXY: 'TRUE', PORT: '8080', ENABLE_WORKER: 'no', AI_DAILY_CAP: '0' });
    expect(c.PLATFORM_ADMIN_EMAILS).toEqual(['a@x.com', 'b@x.com']);
    expect(c.CORS_ORIGINS).toEqual(['https://a.test']);
    expect(c.TRUST_PROXY).toBe(true);
    expect(c.PORT).toBe(8080);
    expect(c.ENABLE_WORKER).toBe(false);
    expect(c.AI_DAILY_CAP).toBe(0);
    for (const bad of [{ PORT: 'abc' }, { PORT: '70000' }, { NODE_ENV: 'staging' }, { WEBHOOK_MAX_ATTEMPTS: '0' }, { LOG_LEVEL: 'loud' }]) expect(() => loadConfig(bad)).toThrow(/Invalid environment/);
  });
});

describe('sqlite layer', () => {
  it('applies migrations once and enforces foreign keys', () => {
    const db = new Db(':memory:');
    expect(migrate(db)).toEqual(['001_init.sql']);
    expect(migrate(db)).toEqual([]);
    expect(() => db.run(`INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES ('u', 'missing', 'a@b.c', 'n', 'h', 'owner', 'now')`)).toThrow(/FOREIGN KEY/);
    expect(() => db.run(`INSERT INTO workspaces (id, name, created_at) VALUES ('w', 'n', 'now')`)).not.toThrow();
    expect(() => db.run(`INSERT INTO users (id, workspace_id, email, name, password_hash, role, created_at) VALUES ('u', 'w', 'a@b.c', 'n', 'h', 'god', 'now')`)).toThrow(/CHECK/);
  });

  it('transactions commit, roll back, and nest with savepoints', () => {
    const db = new Db(':memory:');
    migrate(db);
    const count = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')!.n;
    const add = (id: string) => db.run(`INSERT INTO workspaces (id, name, created_at) VALUES (?, 'n', 'now')`, id);
    db.tx(() => add('a'));
    expect(count()).toBe(1);
    expect(() => db.tx(() => { add('b'); throw new Error('boom'); })).toThrow('boom');
    expect(count()).toBe(1);
    db.tx(() => {
      add('c');
      expect(() => db.tx(() => { add('d'); throw new Error('inner'); })).toThrow('inner');
      add('e');
    });
    expect(db.all<{ id: string }>('SELECT id FROM workspaces ORDER BY id').map((r) => r.id)).toEqual(['a', 'c', 'e']);
    expect(() => db.tx(() => { add('f'); db.tx(() => add('g')); throw new Error('outer'); })).toThrow('outer');
    expect(count()).toBe(3);
    expect(db.tx(() => 42)).toBe(42);
  });

  it('binds undefined as NULL and booleans as integers', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (a, b)');
    db.run('INSERT INTO t VALUES (?, ?)', undefined, true);
    expect(db.get('SELECT a, b FROM t')).toEqual({ a: null, b: 1 });
  });
});

describe('rate limiter', () => {
  it('is a token bucket with refill and per-key isolation', () => {
    let now = 0;
    const l = new RateLimiter(() => now);
    const lim = { capacity: 3, perMinute: 60 };
    expect([1, 2, 3].map(() => l.take('k', lim).ok)).toEqual([true, true, true]);
    const denied = l.take('k', lim);
    expect(denied).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(l.take('other', lim).ok).toBe(true);
    now += 1000;
    expect(l.take('k', lim).ok).toBe(true);
    expect(l.take('k', lim).ok).toBe(false);
    now += 60_000;
    expect([1, 2, 3, 4].map(() => l.take('k', lim).ok)).toEqual([true, true, true, false]); // never exceeds capacity
  });
  it('reports a sensible Retry-After for slow refill rates', () => {
    let now = 0;
    const l = new RateLimiter(() => now);
    const lim = { capacity: 1, perMinute: 6 };
    l.take('k', lim);
    expect(l.take('k', lim)).toEqual({ ok: false, retryAfterSeconds: 10 });
  });
});

describe('small utilities', () => {
  it('structured JSON logs honour the level', () => {
    const lines: string[] = [];
    const log = createLogger('warn', (l) => lines.push(l));
    log.info('hidden');
    log.warn('shown', { a: 1 });
    log.error('also shown');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', msg: 'shown', a: 1 });
    expect(Number.isNaN(Date.parse(JSON.parse(lines[0]!).time))).toBe(false);
  });

  it('page cache evicts the least recently used and supports invalidation', () => {
    const c = new PageCache(2);
    c.set('a', { html: 'A', checksum: '1' });
    c.set('b', { html: 'B', checksum: '2' });
    c.get('a');
    c.set('c', { html: 'C', checksum: '3' });
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')?.html).toBe('A');
    c.invalidate(['a']);
    expect(c.get('a')).toBeUndefined();
    c.clear();
    expect(c.size).toBe(0);
  });

  it('event bus is scoped per workspace and unsubscribes', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const off = bus.subscribe('w1', (e) => seen.push(e.type));
    bus.publish('w1', { type: 'a', data: 1 });
    bus.publish('w2', { type: 'b', data: 1 });
    off();
    bus.publish('w1', { type: 'c', data: 1 });
    expect(seen).toEqual(['a']);
  });
});

describe('demo seed', () => {
  it('creates a realistic demo workspace once, and its data flows through the real API', async () => {
    const h = makeHarness();
    const first = await seedDemo(h.deps);
    expect(first.created).toBe(true);
    expect((await seedDemo(h.deps)).created).toBe(false);
    const login = await h.call('POST', '/api/auth/login', { body: { email: DEMO_EMAIL, password: DEMO_PASSWORD } });
    expect(login.status).toBe(200);
    const token = login.json.token;
    const funnels = (await h.call('GET', '/api/funnels', { token })).json.data;
    expect(funnels.length).toBeGreaterThanOrEqual(5);
    expect(funnels.filter((f: any) => f.status === 'live')).toHaveLength(2);
    const live = funnels.find((f: any) => f.status === 'live');
    expect(live.stats.visits).toBeGreaterThan(100);
    const a = (await h.call('GET', `/api/funnels/${live.id}/analytics?from=2026-02-20&to=2026-03-10`, { token })).json;
    expect(a.summary.pageViews.all).toBeGreaterThan(100);
    expect(a.series.some((d: any) => d.pageViews > 0)).toBe(true);
    expect((await h.call('GET', '/api/leads', { token })).json.pagination.total).toBeGreaterThan(10);
    expect((await h.call('GET', '/api/orders', { token })).json.pagination.total).toBeGreaterThan(5);
    expect((await h.call('GET', '/api/members', { token })).json.data).toHaveLength(3);
    expect((await h.call('GET', '/api/domains', { token })).json.data[0]).toMatchObject({ status: 'active', funnelCount: 2 });
    const live2 = await h.app.request('/free-guide', { headers: { host: 'demo.funnels.example', 'user-agent': 'Mozilla/5.0' } });
    expect(live2.status).toBe(200);
  });
});
