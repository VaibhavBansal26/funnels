import { describe, expect, it, vi } from 'vitest';
import { NonceCache, verifyEdge } from '../../server/src/edge/signing.js';
import { consumeEvents, handle, hmacHex, type CacheLike, type Ctx, type Env, type Runtime } from '../src/index.js';

const SECRET = 'edge-secret-edge-secret-edge-secret-1';

class FakeCache implements CacheLike {
  store = new Map<string, Response>();
  async match(req: Request) {
    return this.store.get(req.url)?.clone();
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, res.clone());
  }
}
class FakeKV {
  data = new Map<string, string>();
  async get(k: string) { return this.data.get(k) ?? null; }
  async put(k: string, v: string) { this.data.set(k, v); }
}

function world(over: Partial<Env> = {}) {
  const clock = { t: 1_800_000_000_000 };
  const nonces = new NonceCache(240_000);
  const origin = { calls: [] as { url: URL; headers: Headers }[], mode: 'ok' as 'ok' | 'down' | 'http500', pages: new Map<string, any>(), proxied: [] as Request[] };
  let counter = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (origin.mode === 'down') throw new TypeError('connection refused');
    if (url.pathname === '/internal/edge/resolve') {
      const headers = new Headers(init?.headers);
      // The real origin verifier checks every signed call.
      const auth = verifyEdge({ secret: SECRET, skewSeconds: 120, nonces, now: clock.t }, { method: 'GET', pathAndQuery: url.pathname + url.search, headers });
      origin.calls.push({ url, headers });
      if (!auth.ok) return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status });
      if (origin.mode === 'http500') return new Response('boom', { status: 500 });
      const key = `${url.searchParams.get('host')}${url.searchParams.get('path')}`;
      const page = origin.pages.get(key);
      if (!page) return Response.json({ kind: 'missing', status: 404 });
      if (page.kind === 'redirect') return Response.json(page);
      return Response.json(headers.get('x-edge-checksum') === page.checksum ? { ...page, html: undefined, notModified: true } : page);
    }
    origin.proxied.push(new Request(url, { ...init, duplex: 'half' } as RequestInit));
    return new Response('{"ok":true}', { status: 202 });
  });
  const cache = new FakeCache();
  const kv = new FakeKV();
  const rt: Runtime = { cache, fetch: fetchMock as unknown as typeof fetch, now: () => clock.t, randomHex: (n) => String(++counter).padStart(n * 2, '0') };
  const env: Env = { ORIGIN_URL: 'https://origin.test', EDGE_SHARED_SECRET: SECRET, CF_ORIGIN_SECRET: 'cf-origin-secret-1', ROUTES: kv, ...over };
  const pending: Promise<unknown>[] = [];
  const ctx: Ctx = { waitUntil: (p) => void pending.push(p) };
  const page = (checksum = 'c1', html = '<html>v1</html>', status = 200) => ({ kind: 'page', status, html, checksum, funnelId: 'fn_1', stepId: 'st_1' });
  origin.pages.set('shop.example.com/promo', page());
  const get = async (path: string, headers: Record<string, string> = {}, method = 'GET') => {
    const res = await handle(new Request(`https://shop.example.com${path}`, { method, headers }), env, ctx, rt);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { get, origin, clock, cache, kv, env, rt, ctx, page, fetchMock };
}

describe('signing contract with the origin verifier', () => {
  it('hmacHex matches the server implementation (verified by the real verifyEdge on every call)', async () => {
    const w = world();
    const res = await w.get('/promo');
    expect(res.status).toBe(200);
    expect(w.origin.calls).toHaveLength(1);
    const call = w.origin.calls[0]!;
    expect(call.headers.get('x-edge-signature')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('fails closed without the shared secret and never calls the origin', async () => {
    const w = world({ EDGE_SHARED_SECRET: undefined });
    const res = await w.get('/promo');
    expect(res.status).toBe(503);
    expect(w.fetchMock).not.toHaveBeenCalled();
  });
});

describe('page caching', () => {
  it('miss -> hit -> stale-while-revalidate -> revalidated by checksum', async () => {
    const w = world();
    const miss = await w.get('/promo');
    expect(miss.headers.get('x-edge-cache')).toBe('miss');
    expect(await miss.text()).toBe('<html>v1</html>');
    expect(miss.headers.get('etag')).toBe('"c1"');
    expect(w.origin.calls).toHaveLength(1);

    const hit = await w.get('/promo');
    expect(hit.headers.get('x-edge-cache')).toBe('hit');
    expect(w.origin.calls).toHaveLength(1);

    w.clock.t += 61_000;
    w.origin.pages.set('shop.example.com/promo', w.page('c2', '<html>v2</html>'));
    const stale = await w.get('/promo');
    expect(stale.headers.get('x-edge-cache')).toBe('stale');
    expect(await stale.text()).toBe('<html>v1</html>'); // the visitor gets the old copy instantly
    expect(w.origin.calls).toHaveLength(2); // and the background revalidation fetched the new one
    expect(w.origin.calls[1]!.headers.get('x-edge-checksum')).toBe('c1');
    const fresh = await w.get('/promo');
    expect(await fresh.text()).toBe('<html>v2</html>');

    w.clock.t += 61_000;
    const same = await w.get('/promo');
    expect(same.headers.get('x-edge-cache')).toBe('stale');
    expect(w.origin.calls.at(-1)!.headers.get('x-edge-checksum')).toBe('c2');
    w.origin.pages.set('shop.example.com/promo', w.page('c2', '<html>v2</html>'));
    expect((await w.get('/promo')).headers.get('x-edge-cache')).toBe('hit'); // notModified refreshed the timestamp
  });

  it('beyond the stale window it asks the origin synchronously and honours notModified', async () => {
    const w = world();
    await w.get('/promo');
    w.clock.t += 2 * 86_400_000;
    const r = await w.get('/promo');
    expect(r.headers.get('x-edge-cache')).toBe('revalidated');
    expect(await r.text()).toBe('<html>v1</html>');
  });

  it('answers If-None-Match with 304 and keeps cookies out of the cached copy', async () => {
    const w = world();
    const first = await w.get('/promo');
    expect(first.headers.getSetCookie().some((c) => c.startsWith('visitor_id='))).toBe(true);
    const second = await w.get('/promo', { 'if-none-match': '"c1"', cookie: 'visitor_id=abc' });
    expect(second.status).toBe(304);
    expect(second.headers.getSetCookie().some((c) => c.startsWith('visitor_id='))).toBe(false);
    const stored = await w.cache.match(new Request('https://shop.example.com/promo'));
    expect(stored!.headers.get('set-cookie')).toBeNull();
    expect((await w.get('/promo', {}, 'HEAD')).status).toBe(200);
  });

  it('the cache key ignores the query string so a URL purge removes every variant', async () => {
    const w = world();
    await w.get('/promo?utm_source=a');
    expect([...w.cache.store.keys()]).toEqual(['https://shop.example.com/promo']);
    expect((await w.get('/promo?utm_source=b')).headers.get('x-edge-cache')).toBe('hit');
  });

  it('sets visitor, funnel, step and sanitised UTM cookies per request', async () => {
    const w = world();
    const r = await w.get('/promo?utm_source=news&utm_campaign=a%3Bb%20c&utm_term=' + 'x'.repeat(300));
    const cookies = r.headers.getSetCookie();
    expect(cookies.find((c) => c.startsWith('funnel_id='))).toContain('fn_1');
    expect(cookies.find((c) => c.startsWith('step_id='))).toContain('st_1');
    expect(cookies.find((c) => c.startsWith('utm_source='))).toContain('news');
    expect(cookies.find((c) => c.startsWith('utm_campaign='))).toContain('abc');
    expect(cookies.find((c) => c.startsWith('utm_term='))!.split(';')[0]!.length).toBeLessThanOrEqual('utm_term='.length + 100);
    expect(cookies.every((c) => c.includes('Secure') && c.includes('SameSite=Lax'))).toBe(true);
  });
});

describe('default pages, redirects and routing metadata', () => {
  it('serves the origin default 404 page with its status', async () => {
    const w = world();
    w.origin.pages.set('shop.example.com/lost', w.page('c404', '<html>custom 404</html>', 404));
    const r = await w.get('/lost');
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('<html>custom 404</html>');
  });
  it('passes redirects through and caches missing/redirect results in KV for 60 s', async () => {
    const w = world();
    w.origin.pages.set('shop.example.com/old', { kind: 'redirect', status: 301, location: '/promo' });
    const r = await w.get('/old');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/promo');
    const calls = w.origin.calls.length;
    expect((await w.get('/old')).status).toBe(301);
    expect(w.origin.calls.length).toBe(calls); // served from KV
    expect((await w.get('/nothing')).status).toBe(404);
    const again = w.origin.calls.length;
    expect((await w.get('/nothing')).status).toBe(404);
    expect(w.origin.calls.length).toBe(again);
  });
  it('rejects non-GET page requests', async () => {
    expect((await world().get('/promo', {}, 'POST')).status).toBe(405);
  });
});

describe('origin failures', () => {
  it('serves stale content when the origin is down or erroring, however old', async () => {
    const w = world();
    await w.get('/promo');
    w.clock.t += 10 * 86_400_000;
    for (const mode of ['down', 'http500'] as const) {
      w.origin.mode = mode;
      const r = await w.get('/promo');
      expect(r.status).toBe(200);
      expect(r.headers.get('x-edge-cache')).toBe('stale-if-error');
      expect(await r.text()).toBe('<html>v1</html>');
    }
  });
  it('shows a friendly error page when nothing is cached', async () => {
    const w = world();
    w.origin.mode = 'down';
    const r = await w.get('/promo');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.text()).toContain('We will be right back');
  });
  it('a rejected signature (wrong secret) is treated as an origin failure, never as content', async () => {
    const w = world({ EDGE_SHARED_SECRET: 'another-secret-another-secret-12345' });
    expect((await w.get('/promo')).status).toBe(503);
  });
});

describe('forwarding to the origin', () => {
  it('forwards event and form posts with the client IP and shared secret, and strips unverifiable IP claims', async () => {
    const w = world();
    const res = await w.get('/api/public/events', { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json', 'x-cf-origin-secret': 'attacker' }, 'POST');
    expect(res.status).toBe(202);
    const fwd = w.origin.proxied[0]!;
    expect(fwd.method).toBe('POST');
    expect(fwd.url).toBe('https://origin.test/api/public/events');
    expect(fwd.headers.get('cf-connecting-ip')).toBe('203.0.113.9');
    expect(fwd.headers.get('x-cf-origin-secret')).toBe('cf-origin-secret-1'); // the worker's own secret replaces any client-supplied value
    expect(fwd.headers.get('x-forwarded-host')).toBe('shop.example.com');
    const noSecret = world({ CF_ORIGIN_SECRET: undefined });
    await noSecret.get('/api/public/forms/f/s/b', { 'cf-connecting-ip': '203.0.113.9', 'x-cf-origin-secret': 'attacker' }, 'POST');
    expect(noSecret.origin.proxied[0]!.headers.get('cf-connecting-ip')).toBeNull();
    expect(noSecret.origin.proxied[0]!.headers.get('x-cf-origin-secret')).toBeNull();
    expect((await w.get('/beacon.js')).status).toBe(202);
  });
});

describe('edge rate limiting', () => {
  const post = (w: ReturnType<typeof world>, path: string, ip = '203.0.113.9') =>
    handle(new Request(`https://shop.example.com${path}`, { method: 'POST', headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' }, body: '{}' }), w.env, w.ctx, w.rt);
  const binding = (allow: number) => {
    const seen: string[] = [];
    return { seen, limit: async ({ key }: { key: string }) => ({ success: seen.push(key) <= allow }) };
  };

  it('refuses a flood at the edge with the same 429 contract as the origin, keyed by client IP and kind', async () => {
    const events = binding(3);
    const w = world({ RL_EVENTS: events });
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await post(w, '/api/public/events')).status);
    expect(codes).toEqual([202, 202, 202, 429, 429]);
    const refused = await post(w, '/api/public/events');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('10');
    expect(await refused.json()).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String), retry_after_s: 10, policy: 'edge.events' } });
    expect(new Set(events.seen)).toEqual(new Set(['events:203.0.113.9']));
    expect(w.origin.proxied).toHaveLength(3); // refused requests never reached the origin
  });

  it('forms and checkout share one budget; unrelated paths and methods are not counted', async () => {
    const forms = binding(1);
    const w = world({ RL_FORMS: forms });
    expect((await post(w, '/api/public/forms/f/s/b')).status).toBe(202);
    expect((await post(w, '/api/public/checkout/f/s/b')).status).toBe(429);
    await w.get('/promo');
    await handle(new Request('https://shop.example.com/api/public/events', { method: 'OPTIONS' }), w.env, w.ctx, w.rt);
    expect(forms.seen).toHaveLength(2);
  });

  it('fails open when the binding throws', async () => {
    const w = world({ RL_EVENTS: { limit: async () => { throw new Error('down'); } } });
    expect((await post(w, '/api/public/events')).status).toBe(202);
  });

  it('Durable Object GCRA gives exact global counts and the origin arithmetic', async () => {
    const { RateLimiterDO, gcra } = await import('../src/ratelimit.js');
    const { gcra: originGcra } = await import('../../server/src/ratelimit/math.js');
    const storage = new Map<string, unknown>();
    let now = 1_800_000_000_000;
    const objects = new Map<string, InstanceType<typeof RateLimiterDO>>();
    const ns = {
      idFromName: (n: string) => n,
      get: (id: unknown) => {
        if (!objects.has(id as string)) objects.set(id as string, new RateLimiterDO({ storage: { get: async (k: string) => storage.get(`${id}:${k}`) as never, put: async (k: string, v: unknown) => void storage.set(`${id}:${k}`, v) } }, () => now));
        const o = objects.get(id as string)!;
        return { fetch: (_u: string, init?: RequestInit) => o.fetch(new Request('https://do/limit', init)) };
      },
    };
    const w = world({ RL_DO: ns, EDGE_FORMS_PER_MINUTE: '60', EDGE_FORMS_BURST: '5' });
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await post(w, '/api/public/forms/f/s/b')).status);
    expect(codes).toEqual([202, 202, 202, 202, 202, 429, 429, 429]);
    expect((await post(w, '/api/public/forms/f/s/b', '198.51.100.1')).status).toBe(202); // another client has its own object
    now += 1000; // one token (60/min) has refilled
    expect((await post(w, '/api/public/forms/f/s/b')).status).toBe(202);
    for (const [tat, t, cost] of [[undefined, 100, 1], [5000, 100, 2], [100, 5000, 1], [10_000, 4000, 3]] as const) {
      expect(gcra(tat, t, 1000, 5, cost)).toMatchObject({ allowed: originGcra(tat, t, 1000, 5, cost).allowed, retryAfterMs: originGcra(tat, t, 1000, 5, cost).retryAfterMs });
    }
  });
});

describe('event queue at the edge', () => {
  const postEvent = (w: ReturnType<typeof world>, body: string) =>
    handle(new Request('https://shop.example.com/api/public/events', { method: 'POST', body, headers: { 'user-agent': 'Mozilla/5.0 Chrome', 'cf-connecting-ip': '198.51.100.9', 'cf-ipcountry': 'DE' } }), w.env, w.ctx, w.rt);

  it('answers 202 at the edge and queues the beacon with a stable id and time; the origin is not called', async () => {
    const sent: unknown[] = [];
    const w = world({ EVENTS_QUEUE: { send: async (m) => void sent.push(m) } });
    const res = await postEvent(w, JSON.stringify({ funnelId: 'fn_1', stepId: 'st_1', type: 'page_view', visitorId: 'v1' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true, recorded: true, queued: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ at: w.clock.t, ua: 'Mozilla/5.0 Chrome', country: 'DE', body: { funnelId: 'fn_1', visitorId: 'v1' } });
    expect((sent[0] as { id: string }).id).toMatch(/^[0-9a-f]+$/);
    expect(w.origin.proxied).toHaveLength(0);
  });

  it('falls back to the origin when the queue is down, forwarding the body it already read', async () => {
    const w = world({ EVENTS_QUEUE: { send: async () => Promise.reject(new Error('queue unavailable')) } });
    const body = JSON.stringify({ funnelId: 'fn_1', stepId: 'st_1', type: 'page_view', visitorId: 'v1' });
    const res = await postEvent(w, body);
    expect(res.status).toBe(202);
    expect(w.origin.proxied).toHaveLength(1);
    expect(await w.origin.proxied[0]!.text()).toBe(body);
  });

  it('sends oversized or non-JSON bodies to the origin, which answers them properly', async () => {
    const sent: unknown[] = [];
    const w = world({ EVENTS_QUEUE: { send: async (m) => void sent.push(m) } });
    await postEvent(w, 'not json');
    await postEvent(w, JSON.stringify({ pad: 'x'.repeat(9000) }));
    expect(sent).toHaveLength(0);
    expect(w.origin.proxied).toHaveLength(2);
  });

  it('consumer: signs the batch for the origin and retries it on 503, 5xx and network errors, but not on success', async () => {
    const w = world();
    const batch = (n: number) => {
      const retried: { delaySeconds?: number }[] = [];
      return { retried, b: { messages: Array.from({ length: n }, (_, i) => ({ id: `m${i}`, body: { id: `abc12345${i}`, at: w.clock.t, ua: 'Mozilla', country: 'DE', body: { funnelId: 'f' } } })), retryAll: (o?: { delaySeconds?: number }) => void retried.push(o ?? {}) } };
    };
    const verify = vi.fn();
    const rt = (status: number | Error): Runtime => ({
      ...w.rt,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        verify(verifyEdge({ secret: SECRET, skewSeconds: 120, nonces: new NonceCache(240_000), now: w.clock.t }, { method: 'POST', pathAndQuery: url.pathname + url.search, headers: new Headers(init?.headers) }), JSON.parse(String(init?.body)).events.length);
        if (status instanceof Error) throw status;
        return new Response('{}', { status });
      }) as unknown as typeof fetch,
    });
    const ok = batch(3);
    await consumeEvents(ok.b, w.env, rt(200));
    expect(ok.retried).toHaveLength(0);
    expect(verify).toHaveBeenCalledWith({ ok: true }, 3);
    const shed = batch(2);
    await consumeEvents(shed.b, w.env, rt(503));
    expect(shed.retried).toEqual([{ delaySeconds: 30 }]);
    const err = batch(2);
    await consumeEvents(err.b, w.env, rt(502));
    expect(err.retried).toEqual([{ delaySeconds: 10 }]);
    const net = batch(2);
    await consumeEvents(net.b, w.env, rt(new TypeError('connection refused')));
    expect(net.retried).toEqual([{ delaySeconds: 10 }]);
    const bad = batch(2);
    await consumeEvents(bad.b, w.env, rt(400)); // can never succeed: dropped, not retried forever
    expect(bad.retried).toHaveLength(0);
  });
});
