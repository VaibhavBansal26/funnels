import { describe, expect, it } from 'vitest';
import { pagesWorld } from './support/pagesworld.js';

// The EXPERIMENTAL Workers Static Assets target with its free workers.dev address, against the in-memory fake of the documented upload flow.
const world = (o: Parameters<typeof pagesWorld>[0] = {}) => pagesWorld({ live: false, target: false, ...o });
const goLive = (w: Awaited<ReturnType<typeof world>>, kind = 'workers') => w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind } });

describe('Workers static assets target', () => {
  it('goes live on the workers.dev address: pending while deploying, then served with headers', async () => {
    const w = await world();
    const o = (await w.call('GET', `/api/funnels/${w.f.id}/addresses`)).json.options.find((x: any) => x.kind === 'workers');
    expect(o).toMatchObject({ available: true, label: expect.stringContaining('experimental') });
    const r = await goLive(w);
    expect(r.status).toBe(200);
    const name = await w.projectName();
    expect(r.json.funnel.domain).toMatchObject({ kind: 'pages', status: 'pending', hostname: `${name}.acct-sub.workers.dev` });
    expect(r.json.publishing).toMatchObject({ state: 'publishing', target: 'cloudflare-workers-assets' });
    await w.drain();
    expect((await w.settings()).json.state).toBe('live');
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json.address.url).toBe(`https://${name}.acct-sub.workers.dev/promo`);
    expect(w.cf.serveWorker(name, '/promo/')!.body).toContain('Version one');
    expect(w.cf.serveWorker(name, '/thanks/')!.status).toBe(200);
    expect(w.cf.serveWorker(name, '/nothing/')!.status).toBe(404);
    expect(w.cf.workerHeaders(name)).toContain('Content-Security-Policy');
    // every file is served: a wrong asset hash would be accepted and never served
    const live = w.cf.workers.get(name)!;
    expect(live.workersDev).toBe(true);
    expect((await w.deployments())[0]).toMatchObject({ status: 'succeeded', active: true });
  });

  it('creates the deployment itself when the script upload does not deploy', async () => {
    const w = await world();
    w.cf.putDeploys = false;
    await goLive(w);
    await w.drain();
    expect((await w.settings()).json.state).toBe('live');
    expect(w.cf.serveWorker(await w.projectName(), '/promo/')!.body).toContain('Version one');
  });

  it('a change is deployed as a new version; rollback returns to the first; unpublish pauses; delete removes the Worker', async () => {
    const w = await world();
    await goLive(w);
    await w.drain();
    const name = await w.projectName();
    await w.page('Version two');
    await w.drain();
    expect(w.cf.serveWorker(name, '/promo/')!.body).toContain('Version two');
    const first = (await w.deployments()).find((d) => d.reason === 'publish');
    expect(first.canRollback).toBe(true);
    const rb = await w.call('POST', `/api/funnels/${w.f.id}/publishing/rollback/${first.id}`);
    expect(rb.status).toBe(200);
    expect(w.cf.serveWorker(name, '/promo/')!.body).toContain('Version one');
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/unpublish`, { mode: 'pause' })).json.state).toBe('paused');
    await w.drain();
    expect(w.cf.serveWorker(name, '/promo/')!.body).toContain('Not available');
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`);
    await w.drain();
    expect(w.cf.serveWorker(name, '/promo/')!.body).toContain('Version two');
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/unpublish`, { mode: 'delete' })).status).toBe(200);
    expect(w.cf.workers.has(name)).toBe(false);
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json).toMatchObject({ status: 'test', domain: null });
  });

  it('explains a missing workers.dev subdomain and leaves the funnel in test mode', async () => {
    const w = await world();
    w.cf.workersSubdomain = null;
    const r = await goLive(w);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('WORKERS_SUBDOMAIN_MISSING');
    expect(r.json.error.message).toMatch(/workers\.dev subdomain/);
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json).toMatchObject({ status: 'test', domain: null });
  });

  it('a refused upload is a clear "publishing failed" state, and Redeploy recovers', async () => {
    const w = await world();
    w.cf.failOn(/PUT \/accounts\/[^/]+\/workers\/scripts\//, 403, 1);
    await goLive(w);
    await w.drain();
    const s = (await w.settings()).json;
    expect(s).toMatchObject({ state: 'failed', funnelStatus: 'live' });
    expect(s.lastError).toContain('Workers Scripts: Edit');
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`);
    await w.drain();
    expect((await w.settings()).json.state).toBe('live');
  });

  it('refuses the 501st Worker before uploading, and a token without write access is explained', async () => {
    const w = await world();
    for (let i = 0; i < 500; i++) w.cf.addWorker(`other-${i}`);
    const r = await goLive(w);
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'WORKERS_LIMIT', details: { limit: 500, used: 500 } });
    const w2 = await world();
    w2.cf.canWrite = false;
    expect((await goLive(w2)).status).toBe(200); // nothing is written to Cloudflare until the first upload
    await w2.drain();
    const s2 = (await w2.settings()).json;
    expect(s2).toMatchObject({ state: 'failed' });
    expect(s2.lastError).toContain('Workers Scripts: Edit');
    expect(JSON.stringify(s2)).not.toContain(w2.cf.token);
  });

  it('one Cloudflare option per funnel: the other asks to switch back to this server first', async () => {
    const w = await world();
    await goLive(w);
    await w.drain();
    const opts = (await w.call('GET', `/api/funnels/${w.f.id}/addresses`)).json.options;
    expect(opts.find((o: any) => o.kind === 'pages')).toMatchObject({ available: false });
    expect(opts.find((o: any) => o.kind === 'workers')).toMatchObject({ selected: true });
    const r = await goLive(w, 'pages');
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('SWITCH_TARGET_FIRST');
    await w.call('PUT', `/api/funnels/${w.f.id}/publishing`, { target: 'origin', leave: 'delete' });
    expect((await goLive(w, 'pages')).status).toBe(200);
    await w.drain();
    expect((await w.settings()).json).toMatchObject({ state: 'live', target: 'cloudflare-pages' });
  });

  it('custom domains are not offered by this target: choosing one still works and serves the funnel on this server', async () => {
    const w = await world();
    await goLive(w);
    await w.drain();
    const r = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'custom', domainId: w.domainId } });
    expect(r.status).toBe(200);
    await w.drain();
    expect((await w.settings()).json.customDomain).toBeNull();
  });
});
