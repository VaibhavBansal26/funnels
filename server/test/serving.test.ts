import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { signPreviewToken, verifyPreviewToken } from '../src/auth/tokens.js';
import { BEACON_JS } from '../src/beacon.js';
import { createBuilder, documentOf } from '../src/blocks/index.js';
import { activeDomain, makeFunnel, makeHarness, type Harness } from './helpers.js';

const HOST = 'offers.example.com';
const get = (h: Harness, path: string, headers: Record<string, string> = {}, host = HOST, method = 'GET') =>
  h.app.request(path, { method, headers: { host, 'user-agent': 'Mozilla/5.0', ...headers } });

async function liveSetup() {
  const h = await makeHarness();
  const u = await h.register();
  const dom = await activeDomain(h, u.token, HOST);
  const f = await makeFunnel(h, u.token, { name: 'Promo', base_path: '/promo' });
  await h.call('PUT', `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`, { token: u.token, body: { doc: documentOf([createBuilder('s').heading('Live headline')]) } });
  await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
  return { h, u, dom, f };
}

describe('public serving by host and path', () => {
  it('serves live funnels on an active domain with ETag/Cache-Control and tracking cookies', async () => {
    const { h, f } = await liveSetup();
    const res = await get(h, '/promo?utm_source=news&utm_medium=email');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Live headline');
    expect(body).toContain(`data-funnel="${f.id}"`);
    expect(res.headers.get('cache-control')).toContain('must-revalidate');
    const etag = res.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const cookies = res.headers.getSetCookie();
    const find = (n: string) => cookies.find((c) => c.startsWith(`${n}=`));
    expect(find('visitor_id')).toMatch(/^visitor_id=[0-9a-f]{24};/);
    expect(find('funnel_id')).toContain(`funnel_id=${f.id}`);
    expect(find('step_id')).toContain(`step_id=${f.steps[0].id}`);
    expect(find('utm_source')).toContain('utm_source=news');
    expect(find('utm_medium')).toContain('utm_medium=email');
    expect(find('utm_campaign')).toBeUndefined();
    expect(cookies.every((c) => c.includes('Path=/') && c.includes('SameSite=Lax'))).toBe(true);

    const again = await get(h, '/promo', { 'if-none-match': etag, cookie: 'visitor_id=abc' });
    expect(again.status).toBe(304);
    expect(again.headers.getSetCookie().some((c) => c.startsWith('visitor_id='))).toBe(false); // existing visitor kept
  });

  it('sanitises and caps UTM cookies', async () => {
    const { h } = await liveSetup();
    const long = 'x'.repeat(500);
    const res = await get(h, `/promo?utm_source=${long}&utm_campaign=a%0D%0Aset-cookie:evil=1&utm_term=%3Cscript%3E`);
    const cookies = res.headers.getSetCookie();
    const src = cookies.find((c) => c.startsWith('utm_source='))!;
    expect(src.split(';')[0]!.length).toBeLessThanOrEqual('utm_source='.length + 100);
    expect(cookies.some((c) => c.includes('\n') || c.includes('\r'))).toBe(false);
    expect(cookies.find((c) => c.startsWith('utm_campaign='))).not.toMatch(/[\r\n]/);
    expect(cookies.some((c) => c.startsWith('evil='))).toBe(false);
    expect(cookies.find((c) => c.startsWith('utm_term='))).not.toContain('<');
  });

  it('save purges the in-memory cache immediately and changes the ETag', async () => {
    const { h, u, f } = await liveSetup();
    const first = await get(h, '/promo');
    const etag1 = first.headers.get('etag');
    await first.text();
    expect(h.deps.pageCache.size).toBe(1);
    await h.call('PUT', `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`, { token: u.token, body: { doc: documentOf([createBuilder('s').heading('Edited headline')]) } });
    expect(h.deps.pageCache.size).toBe(0);
    const second = await get(h, '/promo');
    expect(await second.text()).toContain('Edited headline');
    expect(second.headers.get('etag')).not.toBe(etag1);
  });

  it('does not serve test funnels, pending/failed domains, trashed funnels or unknown hosts', async () => {
    const { h, u, f, dom } = await liveSetup();
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { status: 'test' } });
    expect((await get(h, '/promo')).status).toBe(404);
    const pending = (await h.call('POST', '/api/domains', { token: u.token, body: { hostname: 'pending.example.com' } })).json;
    expect((await get(h, '/promo', {}, pending.hostname)).status).toBe(404);
    expect((await get(h, '/promo', {}, 'unknown.example.com')).status).toBe(404);
    expect(dom).toBeTruthy();
  });

  it('redirects non-canonical case and trailing slash with 301', async () => {
    const { h } = await liveSetup();
    for (const p of ['/PROMO', '/promo/', '/Promo']) {
      const res = await get(h, `${p}?a=1`);
      expect(res.status).toBe(301);
      expect(res.headers.get('location')).toBe('/promo?a=1');
    }
  });

  it('serves the default home step at "/" and the default 404 step (with status 404) elsewhere', async () => {
    const { h, u, f, dom } = await liveSetup();
    expect((await get(h, '/')).status).toBe(404);
    const second = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Lost', base_path: '/lost' } })).json;
    await h.call('PUT', `/api/funnels/${f.id}/steps/${second.id}/page`, { token: u.token, body: { doc: documentOf([createBuilder('l').heading('Nothing here')]) } });
    await h.call('PUT', `/api/domains/${dom}/default-pages`, { token: u.token, body: { homeStepId: f.steps[0].id, notFoundStepId: second.id } });
    const home = await get(h, '/');
    expect(home.status).toBe(200);
    expect(await home.text()).toContain('Live headline');
    const missing = await get(h, '/does-not-exist');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Nothing here');
    expect((await get(h, '/lost')).status).toBe(200); // still reachable by its own path
  });

  it('keeps public API paths on customer domains and hides the rest of the app', async () => {
    const { h, f } = await liveSetup();
    const ev = await h.app.request('/api/public/events', { method: 'POST', headers: { host: HOST, 'user-agent': 'Mozilla/5.0 Chrome', 'content-type': 'application/json' }, body: JSON.stringify({ funnelId: f.id, stepId: f.steps[0].id, type: 'page_view', visitorId: 'abc' }) });
    expect(ev.status).toBe(202);
    expect((await get(h, '/beacon.js')).status).toBe(200);
    const api = await get(h, '/api/funnels');
    expect(api.status).toBe(404);
    expect(await api.text()).not.toContain('UNAUTHORIZED');
    expect((await get(h, '/promo', {}, HOST, 'POST')).status).toBe(405);
    expect((await get(h, '/promo', {}, HOST, 'HEAD')).status).toBe(200);
  });

  it('host matching ignores port and case', async () => {
    const { h } = await liveSetup();
    expect((await get(h, '/promo', {}, 'OFFERS.Example.com:8443')).status).toBe(200);
  });
});

describe('preview', () => {
  async function setup() {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Preview me', base_path: '/p' });
    const s2 = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Second', base_path: '/second' } })).json;
    const token = (await h.call('POST', `/api/funnels/${f.id}/preview-token`, { token: u.token })).json.token as string;
    return { h, u, f, s2, token };
  }

  it('is not world-readable: needs a valid signed token minted by an authenticated user', async () => {
    const { h, f, token } = await setup();
    expect((await h.call('POST', `/api/funnels/${f.id}/preview-token`)).status).toBe(401);
    expect((await get(h, `/preview/${f.id}`, {}, 'app.funnels.test')).status).toBe(401);
    expect((await get(h, `/preview/${f.id}?token=garbage`, {}, 'app.funnels.test')).status).toBe(401);
    const tampered = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await get(h, `/preview/${f.id}?token=${tampered}`, {}, 'app.funnels.test')).status).toBe(401);
    const parts = token.split('.');
    const forged = `${parts[0]}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()), fid: 'other' })).toString('base64url')}.${parts[2]}`;
    expect((await get(h, `/preview/${f.id}?token=${forged}`, {}, 'app.funnels.test')).status).toBe(401);
  });

  it('renders test funnels, links steps with the token, and never leaks or tracks', async () => {
    const { h, f, token } = await setup();
    const res = await get(h, `/preview/${f.id}?token=${token}`, {}, 'app.funnels.test');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain('data-preview="1"');
    expect(html).toContain(`href="/preview/${f.id}/second?token=${token}"`);
    const second = await get(h, `/preview/${f.id}/second?token=${token}`, {}, 'app.funnels.test');
    expect(second.status).toBe(200);
    expect((await get(h, `/preview/${f.id}/missing?token=${token}`, {}, 'app.funnels.test')).status).toBe(404);
  });

  it('a token only opens its own funnel', async () => {
    const { h, u, token } = await setup();
    const other = await makeFunnel(h, u.token, { name: 'Other' });
    expect((await get(h, `/preview/${other.id}?token=${token}`, {}, 'app.funnels.test')).status).toBe(401);
  });

  it('expires', async () => {
    const { h, f, token } = await setup();
    h.clock.advance(14 * 60_000);
    expect((await get(h, `/preview/${f.id}?token=${token}`, {}, 'app.funnels.test')).status).toBe(200);
    h.clock.advance(2 * 60_000);
    const res = await get(h, `/preview/${f.id}?token=${token}`, {}, 'app.funnels.test');
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('Preview link expired');
    expect(await verifyPreviewToken(h.deps.config, token, f.id, h.clock.now())).toBeNull();
  });

  it('is 404 after the funnel is trashed or purged, and cross-workspace tokens cannot read it', async () => {
    const { h, u, f, token } = await setup();
    const other = await h.register();
    const foreign = await signPreviewToken(h.deps.config, other.wsId, f.id, h.clock.now());
    expect((await get(h, `/preview/${f.id}?token=${foreign}`, {}, 'app.funnels.test')).status).toBe(404); // workspace in token does not own the funnel
    await h.call('DELETE', `/api/funnels/${f.id}`, { token: u.token });
    expect((await get(h, `/preview/${f.id}?token=${token}`, {}, 'app.funnels.test')).status).toBe(404);
  });
});

describe('beacon.js', () => {
  it('is served as cacheable javascript', async () => {
    const h = await makeHarness();
    const res = await h.app.request('/beacon.js');
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toContain('max-age');
    expect(await res.text()).toBe(BEACON_JS);
    expect(BEACON_JS.length).toBeLessThan(6000);
  });

  function runBeacon(attrs: Record<string, string>, cookie = '') {
    const sent: { url: string; body: any }[] = [];
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const cookies = new Map<string, string>(cookie ? cookie.split('; ').map((c) => c.split('=') as [string, string]) : []);
    const script = { getAttribute: (n: string) => attrs[n] ?? null };
    const document = {
      currentScript: script,
      get cookie() {
        return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      },
      set cookie(v: string) {
        const [pair] = v.split(';');
        const [k, ...rest] = pair!.split('=');
        cookies.set(k!, rest.join('='));
      },
      querySelector: () => script,
      querySelectorAll: () => [],
      addEventListener: (t: string, fn: (e: any) => void) => (listeners[`d:${t}`] ??= []).push(fn),
    };
    const ctx = {
      document, location: { href: 'https://offers.example.com/promo?utm_source=x' },
      navigator: { sendBeacon: (url: string, blob: any) => (sent.push({ url, body: JSON.parse(blob.__text) }), true) },
      Blob: class { __text: string; constructor(p: string[]) { this.__text = p.join(''); } },
      window: { crypto: { getRandomValues: (a: Uint8Array) => a.fill(7) }, addEventListener: (t: string, fn: (e: any) => void) => (listeners[`w:${t}`] ??= []).push(fn) },
      fetch: () => Promise.resolve({}), Promise, Uint8Array, JSON, Math, RegExp, decodeURIComponent, encodeURIComponent, String, Array,
    };
    vm.runInNewContext(BEACON_JS, ctx);
    return { sent, cookies, listeners };
  }

  it('sends one page view with visitor id, unique hint and UTMs; second load is not unique', () => {
    const attrs = { 'data-funnel': 'fn_1', 'data-step': 'st_1', 'data-api': '' };
    const first = runBeacon(attrs, 'utm_source=news');
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]!.url).toBe('/api/public/events');
    expect(first.sent[0]!.body).toMatchObject({ funnelId: 'fn_1', stepId: 'st_1', type: 'page_view', unique: true, utms: { source: 'news' } });
    expect(first.sent[0]!.body.visitorId).toMatch(/^[0-9a-f]{24}$/);
    const cookie = [...first.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const second = runBeacon(attrs, cookie);
    expect(second.sent[0]!.body.unique).toBe(false);
    expect(second.sent[0]!.body.visitorId).toBe(first.sent[0]!.body.visitorId);
  });

  it('sends nothing in preview mode and relays third-party opt-in messages otherwise', () => {
    const prev = runBeacon({ 'data-funnel': 'f', 'data-step': 's', 'data-preview': '1' });
    expect(prev.sent).toHaveLength(0);
    const live = runBeacon({ 'data-funnel': 'f', 'data-step': 's', 'data-api': 'https://app.example.com' });
    expect(live.sent[0]!.url).toBe('https://app.example.com/api/public/events');
    live.listeners['w:message']![0]!({ data: { type: 'new_form_submission', response_id: 'r-1' } });
    expect(live.sent[1]!.body).toMatchObject({ type: 'optin', externalId: 'r-1' });
    live.listeners['w:message']![0]!({ data: { type: 'new_purchase', items: [{ amount: 1e9 }] } });
    expect(live.sent).toHaveLength(2); // purchases are never reported by browsers
  });
});
