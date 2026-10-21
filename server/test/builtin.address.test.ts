import { describe, expect, it } from 'vitest';
import { signEdge } from '../src/edge/signing.js';
import { forgetSuspensions } from '../src/services/suspension.js';
import { activeDomain, formTarget, fromTemplate, makeFunnel, makeHarness, type Harness } from './helpers.js';
import { store } from './support/stripeworld.js';

// The free built-in address: <APP_PUBLIC_URL>/s/<workspace slug>/<funnel slug>/<step path>, served by this app, no DNS.
const APP = 'https://app.funnels.test';

async function world(env: Record<string, string> = {}) {
  const h = await makeHarness({ env });
  const owner = await h.register();
  const f = await fromTemplate(h, owner.token, 'lead-magnet');
  const call = (m: string, p: string, body?: unknown, token = owner.token) => h.call(m, p, { token, body });
  const live = async (funnelId = f.id as string, tok = owner.token) => {
    const o = (await h.call('GET', `/api/funnels/${funnelId}/addresses`, { token: tok })).json;
    const b = o.options.find((x: any) => x.kind === 'builtin');
    const r = await h.call('POST', `/api/funnels/${funnelId}/go-live`, { token: tok, body: { address: { kind: 'builtin' } } });
    expect(r.status, r.text).toBe(200);
    return { options: o, builtin: b, detail: r.json.funnel };
  };
  return { h, owner, f, call, live };
}
const get = (h: Harness, path: string, headers: Record<string, string> = {}) => h.call('GET', path, { headers });

describe('built-in address: going live', () => {
  it('is always offered, creates the slugs and system domain on first use, and goes live without any DNS', async () => {
    const { h, f, live, call } = await world();
    const { builtin, detail } = await live();
    expect(builtin).toMatchObject({ kind: 'builtin', label: 'Built-in address (free)', available: true, status: 'active' });
    expect(builtin.url).toMatch(new RegExp(`^${APP}/s/[a-z0-9-]+/lead-magnet/`));
    expect(detail).toMatchObject({ status: 'live', publicSlug: 'lead-magnet', allowIndexing: false, domain: { kind: 'builtin', status: 'active', hostname: 'app.funnels.test' } });
    expect(detail.address).toMatchObject({ kind: 'builtin', url: expect.stringContaining('/s/') });
    expect((await call('GET', `/api/funnels/${f.id}/addresses`)).json).toMatchObject({ state: 'live', builtin: { funnelSlug: 'lead-magnet' } });
    // the system domain is not a customer domain
    expect((await call('GET', '/api/domains')).json.data).toEqual([]);
    expect((await call('GET', `/api/domains/${detail.domain.id}`)).status).toBe(404);
    expect((await call('DELETE', `/api/domains/${detail.domain.id}`)).status).toBe(404);
    expect(h).toBeTruthy();
  });

  it('the app host stays unregistrable and a spoofed Host never reaches a system domain', async () => {
    const { h, live, call } = await world();
    await live();
    expect((await call('POST', '/api/domains', { hostname: 'app.funnels.test' })).json.error.code).toBe('HOSTNAME_RESERVED');
    const ws = (await h.deps.db.get<{ id: string }>('SELECT id FROM workspaces'))!.id.toLowerCase();
    const res = await h.app.request('/', { headers: { host: `${ws}.builtin.invalid` } });
    expect(res.status).toBe(404); // not a customer host: falls through to the app, which has no web build in tests
  });
});

describe('built-in address: serving under the path prefix', () => {
  it('serves every step, rewrites links from step ids and keeps forms and the beacon on the app root', async () => {
    const { h, f, live, call, owner } = await world();
    const { detail } = await live();
    const base = new URL(detail.address.base).pathname; // /s/<ws>/lead-magnet
    const steps = detail.steps as { id: string; path: string }[];
    const landing = await get(h, `${base}${steps[0]!.path}`);
    expect(landing.status).toBe(200);
    // the lead form continues to the next step: its link carries the prefix, built from the step id, not from text
    expect(landing.text).toContain(`data-href="${base}${steps[1]!.path}"`);
    expect(landing.text).toContain('action="/api/public/forms/'); // forms keep calling the app's public API at its root
    expect(landing.text).toMatch(/<link rel="canonical" href="https:\/\/app\.funnels\.test\/s\/[a-z0-9-]+\/lead-magnet\//);
    expect(landing.text).toContain(`data-cookie-path="${base.split('/').slice(0, 3).join('/')}"`);
    const thanks = await get(h, `${base}${steps[1]!.path}`);
    expect(thanks.status).toBe(200);
    // the funnel root serves the first step when no step has the path "/"; the bare prefix redirects to the slash form
    expect((await get(h, base)).status).toBe(301);
    expect((await get(h, base)).headers.get('location')).toBe(`${base}/`);
    const root = await get(h, `${base}/`);
    expect(root.status).toBe(200);
    expect(root.text).toContain(`data-funnel="${f.id}"`);
    // case and trailing slash redirect to the stored path under the prefix, keeping the query
    const odd = await get(h, `${base}${steps[0]!.path.toUpperCase()}/?utm_source=a`);
    expect(odd.status).toBe(301);
    expect(odd.headers.get('location')).toBe(`${base}${steps[0]!.path}?utm_source=a`);
    expect((await get(h, `${base}/nope`)).status).toBe(404);
    // the same funnel on a custom domain is rendered WITHOUT a prefix (and its stored html is regenerated when the address changes)
    const dom = await activeDomain(h, owner.token, 'offers.example.com');
    await call('PATCH', `/api/funnels/${f.id}`, { status: 'live', domain_id: dom });
    const html = (await call('GET', `/api/funnels/${f.id}/steps/${steps[0]!.id}/html`)).json.html as string;
    expect(html).toContain(`data-href="${steps[1]!.path}"`);
    expect(html).not.toContain('/s/');
    expect(html).not.toContain('rel="canonical"');
  });

  it('records leads, page views and events for the funnel; cookies are scoped to the workspace prefix', async () => {
    const { h, owner, call } = await world();
    const t = await formTarget(h, owner.token);
    const o = (await call('GET', `/api/funnels/${t.funnelId}/addresses`)).json;
    expect(o.options.find((x: any) => x.kind === 'builtin')).toBeTruthy();
    const r = await h.call('POST', `/api/funnels/${t.funnelId}/go-live`, { token: owner.token, body: { address: { kind: 'builtin' } } });
    const base = new URL(r.json.funnel.address.base).pathname;
    const page = await get(h, `${base}${r.json.funnel.steps[0].path}?utm_source=news`);
    const cookies = page.headers.getSetCookie();
    const wsPath = base.split('/').slice(0, 3).join('/');
    expect(cookies.length).toBeGreaterThan(2);
    expect(cookies.every((c) => c.includes(`Path=${wsPath}`) && !c.includes('Path=/;'))).toBe(true);
    // the form posts to the public API at the root (same origin as the page, no path prefix)
    const submit = await h.call('POST', t.path, { body: { fields: { email: 'lead@example.com', name: 'Lee' }, visitorId: 'v1', _hp: '', consent: true }, headers: { origin: APP } });
    expect(submit.status, submit.text).toBe(200);
    const ev = await h.call('POST', '/api/public/events', { body: { funnelId: t.funnelId, stepId: t.stepId, type: 'page_view', visitorId: 'v1', unique: true, url: `${APP}${base}/` }, headers: { origin: APP } });
    expect(ev.status).toBe(202);
    await h.deps.events.flush();
    const leads = (await call('GET', '/api/leads')).json;
    expect(leads.data[0]).toMatchObject({ firstFunnelId: t.funnelId, email: 'lead@example.com' });
    const roll = await h.deps.db.get<{ page_views: number; optins: number }>('SELECT SUM(page_views) AS page_views, SUM(optins) AS optins FROM event_rollups WHERE funnel_id = ?', t.funnelId);
    expect(Number(roll!.page_views)).toBe(1);
    expect(Number(roll!.optins)).toBe(1);
    // the public API accepts the app's own origin and the sandbox origin (opaque "null")
    for (const origin of [APP, 'null']) expect((await h.call('OPTIONS', '/api/public/events', { headers: { origin } })).headers.get('access-control-allow-origin')).toBeTruthy();
  });

  it('checkout success and cancel URLs return to the prefixed address', async () => {
    const s = await store();
    const d = (await s.h.call('GET', `/api/funnels/${s.t.funnelId}/addresses`, { token: s.owner.token })).json.options.find((x: any) => x.kind === 'builtin');
    const r = await s.h.call('POST', `/api/funnels/${s.t.funnelId}/go-live`, { token: s.owner.token, body: { address: { kind: 'builtin' } } });
    expect(r.status, r.text).toBe(200);
    const base = r.json.funnel.address.base as string;
    expect(d.url.startsWith(base)).toBe(true);
    const buy = await s.buy();
    expect(buy.status, buy.text).toBe(200);
    const p = s.stripe.called('POST', /checkout\/sessions$/).at(-1)!.params;
    expect(p.cancel_url).toMatch(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[^?]*\\?purchase=cancelled$`));
    const stored = await s.h.deps.db.get<{ next_url: string; cancel_url: string }>('SELECT next_url, cancel_url FROM checkout_sessions ORDER BY created_at DESC LIMIT 1');
    expect(stored!.next_url.startsWith(`${base}/`)).toBe(true);
    expect(stored!.cancel_url.startsWith(`${base}/`)).toBe(true);
  });
});

describe('built-in address: isolation', () => {
  it('serves only live funnels of that workspace; two workspaces with the same funnel name do not mix; nothing else leaks', async () => {
    const a = await world();
    const h = a.h;
    const other = await h.register();
    const g = await fromTemplate(h, other.token, 'lead-magnet'); // same name, same slug in another workspace
    const ra = await a.live();
    const rb = await h.call('POST', `/api/funnels/${g.id}/go-live`, { token: other.token, body: { address: { kind: 'builtin' } } });
    const baseA = new URL(ra.detail.address.base).pathname;
    const baseB = new URL(rb.json.funnel.address.base).pathname;
    expect(baseA).not.toBe(baseB);
    expect(baseA.split('/')[3]).toBe(baseB.split('/')[3]); // both funnels are "lead-magnet"
    const pa = ra.detail.steps[0].path as string;
    expect((await get(h, `${baseA}${pa}`)).text).toContain(`data-funnel="${a.f.id}"`);
    expect((await get(h, `${baseB}${pa}`)).text).toContain(`data-funnel="${g.id}"`);
    // workspace A's name with B's funnel (or an unknown one) is not found, with the same answer as a funnel that does not exist
    const wsA = baseA.split('/')[2];
    const mix = await get(h, `/s/${wsA}/lead-magnet-2${pa}`);
    expect(mix.status).toBe(404);
    expect((await get(h, `/s/nope/lead-magnet${pa}`)).status).toBe(404);
    expect((await get(h, `/s/${wsA}/${'x'.repeat(80)}${pa}`)).status).toBe(404);
    expect((await get(h, `/s/${wsA}/..%2f..${pa}`)).status).toBe(404);
    // a test funnel, a trashed one and one on another kind of domain are not served
    await a.call('PATCH', `/api/funnels/${a.f.id}`, { status: 'test' });
    expect((await get(h, `${baseA}${pa}`)).status).toBe(404);
    await a.live();
    expect((await get(h, `${baseA}${pa}`)).status).toBe(200);
    await a.call('DELETE', `/api/funnels/${a.f.id}`);
    expect((await get(h, `${baseA}${pa}`)).status).toBe(404);
    await a.call('POST', `/api/funnels/${a.f.id}/restore`);
    expect((await get(h, `${baseA}${pa}`)).status, 'restored funnels are in test mode').toBe(404);
  });

  it('a suspended workspace serves nothing', async () => {
    const { h, owner, live } = await world();
    const { detail } = await live();
    const url = `${new URL(detail.address.base).pathname}${detail.steps[0].path}`;
    expect((await get(h, url)).status).toBe(200);
    await h.deps.db.run('UPDATE workspaces SET suspended_at = ? WHERE id = ?', h.clock.now().toISOString(), owner.wsId);
    forgetSuspensions();
    expect((await get(h, url)).status).toBe(503);
    await h.deps.db.run('UPDATE workspaces SET suspended_at = NULL WHERE id = ?', owner.wsId);
    forgetSuspensions();
    expect((await get(h, url)).status).toBe(200);
  });

  it('a funnel is served only while attached to the built-in address of ITS workspace', async () => {
    const { h, f, owner, live } = await world();
    const { detail } = await live();
    const url = `${new URL(detail.address.base).pathname}${detail.steps[0].path}`;
    const dom = await activeDomain(h, owner.token, 'offers.example.com');
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: owner.token, body: { domain_id: dom } });
    expect((await get(h, url)).status, 'moved to a custom domain: the built-in address no longer answers').toBe(404);
  });
});

describe('built-in address: slugs, renames and indexing', () => {
  it('slugs are unique per workspace, stable on rename, editable, and a change moves the address and re-renders links', async () => {
    const { h, owner, call, f } = await world();
    const second = await makeFunnel(h, owner.token, { name: 'Lead magnet', base_path: '/lm2' });
    const a = (await call('GET', `/api/funnels/${f.id}/addresses`)).json.builtin;
    const b = (await call('GET', `/api/funnels/${second.id}/addresses`)).json.builtin;
    expect(a.funnelSlug).toBe('lead-magnet');
    expect(b.funnelSlug).toBe('lead-magnet-2'); // collision inside the workspace
    // renaming does not change the address
    await call('PATCH', `/api/funnels/${f.id}`, { name: 'Totally different name' });
    expect((await call('GET', `/api/funnels/${f.id}`)).json.publicSlug).toBe('lead-magnet');
    // a taken or invalid name is refused, a free one is applied
    const taken = await call('PATCH', `/api/funnels/${f.id}`, { public_slug: 'lead-magnet-2' });
    expect(taken.status).toBe(409);
    expect(taken.json.error.code).toBe('SLUG_TAKEN');
    for (const bad of ['Has Space', '-lead', 'lead-', 'a--b', 'ünï', 'x'.repeat(41), '']) expect((await call('PATCH', `/api/funnels/${f.id}`, { public_slug: bad })).status, bad).toBe(400);
    const live = await h.call('POST', `/api/funnels/${f.id}/go-live`, { token: owner.token, body: { address: { kind: 'builtin' } } });
    const old = `${new URL(live.json.funnel.address.base).pathname}${live.json.funnel.steps[0].path}`;
    expect((await get(h, old)).status).toBe(200);
    const moved = await call('PATCH', `/api/funnels/${f.id}`, { public_slug: 'free-guide' });
    expect(moved.json.address.base).toContain('/free-guide');
    expect((await get(h, old)).status, 'the old address stops working').toBe(404);
    const fresh = await get(h, old.replace('/lead-magnet/', '/free-guide/'));
    expect(fresh.status).toBe(200);
    expect(fresh.text).toContain('/free-guide/'); // links and canonical were re-rendered with the new name
    expect(fresh.text).not.toContain('/lead-magnet/');
    // the workspace name is part of the address too
    const ws = await call('PATCH', '/api/workspace', { slug: 'acme-co' });
    expect(ws.json.slug).toBe('acme-co');
    expect((await get(h, `/s/acme-co/free-guide${live.json.funnel.steps[0].path}`)).status).toBe(200);
    expect((await call('PATCH', '/api/workspace', { slug: 'Bad Slug' })).status).toBe(400);
    const other = await h.register();
    expect((await h.call('PATCH', '/api/workspace', { token: other.token, body: { slug: 'acme-co' } })).json.error.code).toBe('SLUG_TAKEN');
  });

  it('is noindex by default and the funnel can allow search engines', async () => {
    const { h, call, f, live } = await world();
    const { detail } = await live();
    const url = `${new URL(detail.address.base).pathname}${detail.steps[0].path}`;
    expect((await get(h, url)).headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect((await call('PATCH', `/api/funnels/${f.id}`, { allow_indexing: true })).json.allowIndexing).toBe(true);
    h.deps.flights; // the resolve result is shared for a few hundred ms
    await new Promise((r) => setTimeout(r, 350));
    expect((await get(h, url)).headers.get('x-robots-tag')).toBeNull();
    // the redirect/404 pages are noindex as well
    expect((await get(h, `${new URL(detail.address.base).pathname}/nope`)).text).toContain('noindex');
  });
});

describe('built-in address: caching, ETag, CSP', () => {
  it('revalidates with ETag, changes it on save, sends CSP and the shared security headers', async () => {
    const { h, call, f, live } = await world();
    const { detail } = await live();
    const url = `${new URL(detail.address.base).pathname}${detail.steps[0].path}`;
    const r = await get(h, url);
    const etag = r.headers.get('etag')!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(r.headers.get('cache-control')).toContain('must-revalidate');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toMatch(/script-src 'self';/); // the platform's own scripts only: no owner code, no 'unsafe-inline' for scripts
    expect(csp).not.toContain('sandbox');
    expect((await get(h, url, { 'if-none-match': etag })).status).toBe(304);
    // a save changes the page: new ETag, immediately (the page cache is invalidated)
    const step = detail.steps[0];
    const page = (await call('GET', `/api/funnels/${f.id}/steps/${step.id}/page`)).json;
    const doc = JSON.parse(JSON.stringify(page.doc));
    doc.project.pages[0].frames[0].component.components[0].components?.push?.({ type: 'text', components: [{ type: 'textnode', content: 'Hello' }] });
    await call('PUT', `/api/funnels/${f.id}/steps/${step.id}/page`, { doc, version: page.version });
    const after = await get(h, url);
    expect(after.headers.get('etag')).not.toBe(etag);
  });

  it('a page with owner-authored code is served in a CSP sandbox so it can never act as the app', async () => {
    const { h, call, f, live, owner } = await world();
    await call('PATCH', '/api/workspace', { allowCustomScripts: true });
    await call('PATCH', `/api/funnels/${f.id}`, { header_tracking_code: '<script>window.x=1</script>' });
    const { detail } = await live();
    const url = `${new URL(detail.address.base).pathname}${detail.steps[0].path}`;
    const csp = (await get(h, url)).headers.get('content-security-policy')!;
    expect(csp).toContain('sandbox allow-scripts allow-forms');
    expect(csp).not.toContain('allow-same-origin');
    expect(owner).toBeTruthy();
  });
});

describe('built-in address: moves with the Cloudflare target', () => {
  it('leaving Cloudflare moves a live funnel to the built-in address; choosing the built-in address leaves Cloudflare', async () => {
    const { pagesWorld } = await import('./support/pagesworld.js');
    const w = await pagesWorld({ live: false, target: false });
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    await w.drain();
    const name = await w.projectName();
    // switching the target back keeps the funnel live, now on the built-in address
    const back = await w.call('PUT', `/api/funnels/${w.f.id}/publishing`, { target: 'origin', leave: 'pause' });
    expect(back.status).toBe(200);
    const d = (await w.call('GET', `/api/funnels/${w.f.id}`)).json;
    expect(d).toMatchObject({ status: 'live', domain: { kind: 'builtin' } });
    const path = `${new URL(d.address.base).pathname}${d.steps[0].path}`;
    expect((await get(w.h, path)).text).toContain('Version one');
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
    // the other way: go live on Cloudflare again, then pick the built-in address (switches the target back and pauses the site)
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    await w.drain();
    expect((await w.call('PATCH', `/api/funnels/${w.f.id}`, { domain_id: d.domain.id })).json.error.code).toBe('SWITCH_TARGET_FIRST');
    const to = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'builtin' } });
    expect(to.status, to.text).toBe(200);
    expect(to.json.funnel).toMatchObject({ status: 'live', domain: { kind: 'builtin' } });
    expect(to.json.publishing.target).toBe('origin');
    expect((await get(w.h, path)).status).toBe(200);
  });
});

describe('built-in address: the signed edge endpoint', () => {
  it('resolves /s/... on the app host with the cookie scope and response headers for the worker', async () => {
    const SECRET = 'edge-secret-edge-secret-edge-secret-1';
    const { h, live } = await world({ EDGE_SHARED_SECRET: SECRET });
    const { detail } = await live();
    const path = `${new URL(detail.address.base).pathname}${detail.steps[0].path}`;
    let n = 0;
    const resolve = (host: string, p: string) => {
      const pq = `/internal/edge/resolve?${new URLSearchParams({ host, path: p })}`;
      const ts = String(Math.floor(h.clock.now().getTime() / 1000));
      const nonce = `nonce-${String(++n).padStart(16, '0')}`;
      return h.call('GET', pq, { headers: { 'x-edge-timestamp': ts, 'x-edge-nonce': nonce, 'x-edge-signature': signEdge(SECRET, ts, nonce, 'GET', pq) } });
    };
    const r = await resolve('app.funnels.test', path);
    expect(r.json).toMatchObject({ kind: 'page', status: 200, cookiePath: expect.stringMatching(/^\/s\/[a-z0-9-]+$/), headers: { 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': expect.stringContaining("default-src 'self'") } });
    expect(r.json.html).toContain('data-cookie-path=');
    expect((await resolve('app.funnels.test', '/s/nope/x/y')).json.kind).toBe('missing');
    expect((await resolve('evil.example.com', path)).json.kind).toBe('missing'); // only the app's own host
    expect((await resolve('app.funnels.test', `${new URL(detail.address.base).pathname}`)).json).toMatchObject({ kind: 'redirect', location: expect.stringMatching(/\/$/) });
  });
});
