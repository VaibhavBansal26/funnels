import { describe, expect, it } from 'vitest';
import { activeDomain, failOn, makeFunnel, makeHarness, type Harness } from './helpers.js';

async function newDomain(h: Harness, token: string, hostname = 'shop.example.com') {
  const r = await h.call('POST', '/api/domains', { token, body: { hostname } });
  return r.json;
}
const dnsOk = (h: Harness, d: any) => {
  h.dns.cname.set(d.hostname, ['sites.funnels.test']);
  h.dns.txt.set(`_funnels-challenge.${d.hostname}`, [d.dns.txt.value]);
};
const verify = (h: Harness, token: string, id: string) => h.call('POST', `/api/domains/${id}/verify`, { token });

describe('domain registry', () => {
  it('adds a pending domain with DNS instructions', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const d = await newDomain(h, u.token, 'Shop.Example.COM');
    expect(d).toMatchObject({ hostname: 'shop.example.com', status: 'pending', funnelCount: 0 });
    expect(d.dns.cname).toEqual({ type: 'CNAME', name: 'shop.example.com', value: 'sites.funnels.test' });
    expect(d.dns.txt.name).toBe('_funnels-challenge.shop.example.com');
    expect(d.dns.txt.value).toMatch(/^funnels-verify=[A-Za-z0-9_-]{20,}$/);
    expect((await h.call('GET', '/api/domains', { token: u.token })).json.data).toHaveLength(1);
  });

  it('validates hostnames and keeps them globally unique', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    const add = (hostname: string, token = a.token) => h.call('POST', '/api/domains', { token, body: { hostname } });
    for (const bad of ['http://x.example.com', 'x.example.com/path', 'x.example.com:8080', 'nodots', '-a.example.com', 'a b.example.com', '127.0.0.1', '1.2.3.4', 'a..example.com', 'x_y.example.com', 'ab', 'a'.repeat(64) + '.example.com']) {
      const r = await add(bad);
      expect([bad, r.status]).toEqual([bad, 400]);
    }
    expect((await add('localhost')).status).toBe(400);
    expect((await add('app.funnels.test')).json.error.code).toBe('HOSTNAME_RESERVED'); // the app's own host
    expect((await add('sites.funnels.test')).json.error.code).toBe('HOSTNAME_RESERVED'); // the CNAME target
    expect((await add('ok.example.com')).status).toBe(201);
    expect((await add('OK.example.com.')).json.error.code).toBe('DOMAIN_TAKEN');
    expect((await add('ok.example.com', b.token)).json.error.code).toBe('DOMAIN_TAKEN'); // no leak of who owns it, but unique globally
    expect((await add('xn--bcher-kva.example')).status).toBe(201);
  });
});

describe('DNS verification states', () => {
  it('pending with a reason until both records match, then active', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const d = await newDomain(h, u.token);
    let r = (await verify(h, u.token, d.id)).json;
    expect(r.domain.status).toBe('pending');
    expect(r.checks).toEqual({ cname: { ok: false, found: [] }, txt: { ok: false } });
    expect(r.domain.failureReason).toContain('TXT record');

    h.dns.txt.set(`_funnels-challenge.${d.hostname}`, ['funnels-verify=wrong']);
    h.dns.cname.set(d.hostname, ['sites.funnels.test']);
    r = (await verify(h, u.token, d.id)).json;
    expect(r.domain.status).toBe('pending');
    expect(r.checks.txt.ok).toBe(false);
    expect(r.checks.cname.ok).toBe(true);

    h.dns.txt.set(`_funnels-challenge.${d.hostname}`, ['v=spf1', d.dns.txt.value]);
    h.dns.cname.set(d.hostname, ['other.example.net']);
    r = (await verify(h, u.token, d.id)).json;
    expect(r.domain.status).toBe('pending');
    expect(r.domain.failureReason).toContain('CNAME');
    expect(r.checks).toMatchObject({ cname: { ok: false, found: ['other.example.net'] }, txt: { ok: true } });

    h.dns.cname.set(d.hostname, ['sites.funnels.test']);
    r = (await verify(h, u.token, d.id)).json;
    expect(r.domain).toMatchObject({ status: 'active', failureReason: null });
    expect(r.domain.verifiedAt).toBe(h.clock.now().toISOString());
  });

  it('a DNS resolver error leaves the status untouched and reports a retryable error', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const d = await newDomain(h, u.token);
    h.dns.fail = true;
    const r = (await verify(h, u.token, d.id)).json;
    expect(r.domain.status).toBe('pending');
    expect(r.checks).toBeNull();
    expect(r.error).toContain('temporary');
    expect(r.domain.lastCheckedAt).toBeTruthy();
  });

  it('pending domains fail after the timeout and can recover', async () => {
    const h = await makeHarness({ env: { DOMAIN_VERIFY_TIMEOUT_HOURS: '48', ACCESS_TOKEN_TTL_SECONDS: '864000' } });
    const u = await h.register();
    const d = await newDomain(h, u.token);
    h.clock.advance(47 * 3600_000);
    expect((await verify(h, u.token, d.id)).json.domain.status).toBe('pending');
    h.clock.advance(2 * 3600_000);
    const failed = (await verify(h, u.token, d.id)).json.domain;
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('Timed out');
    expect((await verify(h, u.token, d.id)).json.domain.status).toBe('failed'); // stays failed while DNS is wrong
    dnsOk(h, d);
    expect((await verify(h, u.token, d.id)).json.domain.status).toBe('active');
  });

  it('an active domain that loses its DNS becomes failed and its funnels revert to test in one step', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const f1 = await makeFunnel(h, u.token, { name: 'One', base_path: '/one' });
    const f2 = await makeFunnel(h, u.token, { name: 'Two', base_path: '/two' });
    for (const f of [f1, f2]) await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
    await h.call('PUT', `/api/domains/${dom}/default-pages`, { token: u.token, body: { homeStepId: f1.steps[0].id } });
    h.dns.cname.clear();
    const r = (await verify(h, u.token, dom)).json;
    expect(r.domain).toMatchObject({ status: 'failed', defaultHomeStepId: null });
    expect(r.domain.failureReason).toContain('Verification lost');
    for (const f of [f1, f2]) expect((await h.call('GET', `/api/funnels/${f.id}`, { token: u.token })).json).toMatchObject({ status: 'test', domain: null });
  });

  it('active domains stay active across re-verification', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const first = (await h.call('GET', `/api/domains/${dom}`, { token: u.token })).json;
    h.clock.advance(1000);
    const r = (await verify(h, u.token, dom)).json.domain;
    expect(r.status).toBe('active');
    expect(r.verifiedAt).toBe(first.verifiedAt);
  });
});

describe('background re-verification (job queue)', () => {
  it('polls pending domains with backoff until active', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const d = await newDomain(h, u.token);
    expect(await h.worker.tick()).toBe(0); // not due yet
    h.clock.advance(61_000);
    expect(await h.worker.tick()).toBe(1);
    expect((await h.call('GET', `/api/domains/${d.id}`, { token: u.token })).json.status).toBe('pending');
    const queued = await h.deps.db.all<{ run_at: number }>(`SELECT run_at FROM jobs WHERE type = 'domain.verify' AND status = 'queued'`);
    expect(queued).toHaveLength(1); // exactly one pending job per domain (dedupe)
    expect(queued[0]!.run_at - h.clock.now().getTime()).toBe(120_000); // backoff doubled
    dnsOk(h, d);
    h.clock.advance(121_000);
    await h.worker.tick();
    expect((await h.call('GET', `/api/domains/${d.id}`, { token: u.token })).json.status).toBe('active');
    h.clock.advance(3600_000);
    expect(await h.worker.tick()).toBe(0); // no more polling once active
  });
});

describe('deleting a domain', () => {
  async function withFunnels() {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const f1 = await makeFunnel(h, u.token, { name: 'One', base_path: '/one' });
    const f2 = await makeFunnel(h, u.token, { name: 'Two', base_path: '/two' });
    for (const f of [f1, f2]) await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
    return { h, u, dom, f1, f2 };
  }

  it('reverts every funnel to test and detaches the domain', async () => {
    const { h, u, dom, f1, f2 } = await withFunnels();
    expect((await h.call('DELETE', `/api/domains/${dom}`, { token: u.token })).status).toBe(204);
    for (const f of [f1, f2]) expect((await h.call('GET', `/api/funnels/${f.id}`, { token: u.token })).json).toMatchObject({ status: 'test', domain: null });
    expect((await h.call('GET', `/api/domains/${dom}`, { token: u.token })).status).toBe(404);
  });

  it('is atomic: when the delete fails the funnels are left exactly as they were', async () => {
    const { h, u, dom, f1, f2 } = await withFunnels();
    await failOn(h.deps.db, 'domains', 'DELETE');
    const r = await h.call('DELETE', `/api/domains/${dom}`, { token: u.token });
    expect(r.status).toBe(500);
    for (const f of [f1, f2]) expect((await h.call('GET', `/api/funnels/${f.id}`, { token: u.token })).json).toMatchObject({ status: 'live', domain: { id: dom } });
    expect((await h.call('GET', `/api/domains/${dom}`, { token: u.token })).json.status).toBe('active');
  });

  it('is atomic when the status change of a lost domain fails midway', async () => {
    const { h, u, dom, f1 } = await withFunnels();
    await failOn(h.deps.db, 'domains', 'UPDATE', 'status');
    h.dns.cname.clear();
    expect((await verify(h, u.token, dom)).status).toBe(500);
    expect((await h.call('GET', `/api/funnels/${f1.id}`, { token: u.token })).json).toMatchObject({ status: 'live', domain: { id: dom } });
  });
});

describe('default home and 404 pages', () => {
  it('assigns steps of funnels on the domain and clears them when the step goes away', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const f = await makeFunnel(h, u.token, { name: 'F', base_path: '/f' });
    const s2 = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Missing page', base_path: '/missing' } })).json;
    const set = (body: object) => h.call('PUT', `/api/domains/${dom}/default-pages`, { token: u.token, body });
    expect((await set({ homeStepId: f.steps[0].id })).json.error.code).toBe('STEP_NOT_ON_DOMAIN'); // funnel not attached yet
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom } });
    expect((await set({ homeStepId: f.steps[0].id, notFoundStepId: s2.id })).json).toMatchObject({ defaultHomeStepId: f.steps[0].id, default404StepId: s2.id });
    const detail = (await h.call('GET', `/api/funnels/${f.id}`, { token: u.token })).json;
    expect(detail.steps.map((s: any) => [s.isDomainHome, s.isDomain404])).toEqual([[true, false], [false, true]]);
    expect((await h.call('GET', `/api/domains/${dom}/routes`, { token: u.token })).json.data.map((r: any) => r.path)).toEqual(['/f', '/missing']);
    expect((await set({ homeStepId: null })).json.defaultHomeStepId).toBeNull();
    expect((await set({})).json.default404StepId).toBe(s2.id); // omitted = unchanged
    await h.call('DELETE', `/api/funnels/${f.id}/steps/${s2.id}`, { token: u.token });
    expect((await h.call('GET', `/api/domains/${dom}`, { token: u.token })).json.default404StepId).toBeNull();
    expect((await set({ homeStepId: 'nope' })).json.error.code).toBe('STEP_NOT_ON_DOMAIN');
  });
});
