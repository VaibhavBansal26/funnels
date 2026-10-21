import { describe, expect, it } from 'vitest';
import { pagesWorld } from './support/pagesworld.js';

// The free *.pages.dev address: a funnel goes live on Cloudflare Pages without owning a domain. Everything runs against the in-memory fake of the documented API.
const world = (o: Parameters<typeof pagesWorld>[0] = {}) => pagesWorld({ live: false, target: false, ...o });

async function createProject(w: Awaited<ReturnType<typeof world>>, name: string) {
  return w.cf.fetch(`https://api.cloudflare.com/client/v4/accounts/${w.cf.accountId}/pages/projects`, { method: 'POST', headers: { authorization: `Bearer ${w.cf.token}` }, body: JSON.stringify({ name }) });
}

describe('go live on the pages.dev address', () => {
  it('a funnel with no domain at all goes live: pending while deploying, active and served afterwards', async () => {
    const w = await world();
    const opts = (await w.call('GET', `/api/funnels/${w.f.id}/addresses`)).json;
    expect(opts.state).toBe('draft');
    expect(opts.options.find((o: any) => o.kind === 'pages')).toMatchObject({ available: true, domainId: null });

    const r = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(r.status).toBe(200);
    expect(r.json.funnel).toMatchObject({ status: 'live', domain: { kind: 'pages', status: 'pending' } });
    expect(r.json.publishing.state).toBe('publishing');
    const name = await w.projectName();
    expect(r.json.funnel.domain.hostname).toBe(`${name}.pages.dev`);

    await w.drain();
    const s = (await w.settings()).json;
    expect(s.state).toBe('live');
    expect(s.address).toMatchObject({ kind: 'pages', host: `${name}.pages.dev` });
    const detail = (await w.call('GET', `/api/funnels/${w.f.id}`)).json;
    expect(detail.domain).toMatchObject({ kind: 'pages', status: 'active' });
    expect(detail.address.url).toBe(`https://${name}.pages.dev/promo`);
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version one');
    // the options now mark it as the selected address
    expect((await w.call('GET', `/api/funnels/${w.f.id}/addresses`)).json.options.find((o: any) => o.kind === 'pages')).toMatchObject({ selected: true, status: 'active', host: `${name}.pages.dev` });
  });

  it('the system domain never shows up as a customer domain and cannot be managed as one', async () => {
    const w = await world();
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    const id = (await w.call('GET', `/api/funnels/${w.f.id}`)).json.domain.id;
    const list = (await w.call('GET', '/api/domains')).json.data;
    expect(list.map((d: any) => d.id)).toEqual([w.domainId]);
    for (const [m, p] of [['GET', `/api/domains/${id}`], ['DELETE', `/api/domains/${id}`], ['POST', `/api/domains/${id}/verify`]] as const) expect((await w.call(m, p)).status, `${m} ${p}`).toBe(404);
    // and the free addresses of Cloudflare cannot be registered as customer domains
    for (const host of ['mine.pages.dev', 'mine.workers.dev', 'x.builtin.invalid']) expect((await w.call('POST', '/api/domains', { hostname: host })).json.error.code, host).toBe('HOSTNAME_RESERVED');
  });

  it('a failed first deployment keeps the funnel live but in a clear "failed" state; Redeploy recovers', async () => {
    const w = await world();
    w.cf.failNextDeploymentAt = 'deploy';
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    await w.drain();
    const s = (await w.settings()).json;
    expect(s).toMatchObject({ state: 'failed', funnelStatus: 'live', active: null });
    expect(s.lastError).toMatch(/deploy stage as failure/);
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json.domain.status).toBe('pending');
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`)).status).toBe(202);
    await w.drain();
    expect((await w.settings()).json.state).toBe('live');
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json.domain.status).toBe('active');
  });

  it('a later failed deployment keeps the previous version online (state stays live)', async () => {
    const w = await world();
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    await w.drain();
    w.cf.failNextDeploymentAt = 'deploy';
    await w.page('Broken release');
    await w.drain();
    const s = (await w.settings()).json;
    expect(s.state).toBe('live');
    expect(s.latest.status).toBe('failed');
    expect(w.cf.serve(await w.projectName(), '/promo/')!.body).toContain('Version one');
  });

  it('unpublish pauses (state paused, address kept); Redeploy brings it back; taking it offline pauses the site and detaches the address', async () => {
    const w = await world();
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    await w.drain();
    const name = await w.projectName();
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/unpublish`, { mode: 'pause' })).json.state).toBe('paused');
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json.domain.kind).toBe('pages');
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`);
    await w.drain();
    expect((await w.settings()).json.state).toBe('live');
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version one');

    // test mode: the site shows the paused page, the funnel loses its address and the system domain stays ready for the next Go live
    const off = await w.call('PATCH', `/api/funnels/${w.f.id}`, { status: 'test' });
    expect(off.json).toMatchObject({ status: 'test', domain: null });
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
    const again = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(again.json.funnel).toMatchObject({ status: 'live', domain: { kind: 'pages' } });
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version one');
  });

  it('switching the target moves the address: back to this server the funnel moves to the built-in address and the pages.dev address is gone; a new project is a new address', async () => {
    const w = await world();
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    await w.drain();
    const first = await w.projectName();
    // a different project name: new host, address pending again
    const moved = await w.target({ projectName: 'my-promo' });
    expect(moved.status).toBe(200);
    const d1 = (await w.call('GET', `/api/funnels/${w.f.id}`)).json;
    expect(d1.domain).toMatchObject({ kind: 'pages', hostname: 'my-promo.pages.dev', status: 'pending' });
    await w.drain();
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json.domain).toMatchObject({ hostname: 'my-promo.pages.dev', status: 'active' });
    expect(w.cf.serve('my-promo', '/promo/')!.status).toBe(200);
    expect(first).not.toBe('my-promo');
    // back to origin
    const back = await w.call('PUT', `/api/funnels/${w.f.id}/publishing`, { target: 'origin', leave: 'pause' });
    expect(back.json.target).toBe('origin');
    // a live funnel keeps being reachable: its address moves to the free built-in address of this app
    const d2 = (await w.call('GET', `/api/funnels/${w.f.id}`)).json;
    expect(d2).toMatchObject({ status: 'live', domain: { kind: 'builtin', status: 'active' } });
    expect(await w.h.deps.db.get("SELECT 1 FROM domains WHERE kind = 'pages' AND system_funnel_id = ?", w.f.id)).toBeUndefined();
  });

  it('a custom domain stays an optional upgrade: the funnel can use it while the project keeps its pages.dev host', async () => {
    const w = await world();
    await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    await w.drain();
    const up = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'custom', domainId: w.domainId } });
    expect(up.json.funnel.domain).toMatchObject({ kind: 'custom', hostname: w.hostname });
    await w.drain();
    const s = (await w.settings()).json;
    expect(s.state).toBe('live');
    expect(s.pagesAddress).toMatchObject({ host: `${await w.projectName()}.pages.dev`, selected: false });
    expect(s.customDomain).toMatchObject({ hostname: w.hostname });
  });
});

describe('limits and refusals', () => {
  it('counts the projects although Cloudflare rejects big pages (real account: per_page=100 answered 400, code 8000024)', async () => {
    const w = await world();
    w.cf.maxPerPage = 5;
    for (let i = 0; i < 12; i++) expect((await createProject(w, `many-${i}`)).status).toBe(200);
    const r = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(r.status).toBe(200);
    const lists = w.cf.callsTo(/GET \/accounts\/[^/]+\/pages\/projects\?/);
    expect(lists.some((c) => /per_page=100/.test(c.path))).toBe(true); // it tried the big page first, then stepped down
  });

  it('a failing project count does not block publishing (Cloudflare itself refuses the 101st project)', async () => {
    const w = await world();
    w.cf.failList = { status: 400, code: 8000024, message: 'Invalid list options provided. Review the `page` or `per_page` parameter.' };
    const r = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(r.status).toBe(200);
    expect(w.cf.callsTo(/POST \/accounts\/[^/]+\/pages\/projects$/).length).toBe(1);
  });

  it('a token or permission problem on the count still stops with a clear message', async () => {
    const w = await world();
    w.cf.failList = { status: 403, code: 10000, message: 'Authentication error' };
    const r = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('CLOUDFLARE_REJECTED');
    expect(w.cf.callsTo(/POST \/accounts\/[^/]+\/pages\/projects$/).length).toBe(0);
  });

  it('refuses the 101st project before asking Cloudflare to create it', async () => {
    const w = await world();
    for (let i = 0; i < 100; i++) expect((await createProject(w, `other-${i}`)).status).toBe(200);
    const creates = () => w.cf.callsTo(/POST \/accounts\/[^/]+\/pages\/projects$/).length;
    const before = creates();
    const r = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatchObject({ code: 'PAGES_PROJECT_LIMIT', details: { limit: 100, used: 100 } });
    expect(r.json.error.message).toMatch(/maximum is 100/);
    expect(creates()).toBe(before); // never tried
    expect((await w.call('GET', `/api/funnels/${w.f.id}`)).json).toMatchObject({ status: 'test', domain: null });
    // an existing project of this funnel is not blocked by the limit (it is not a new project)
    const free = await world();
    await free.target();
    for (let i = 0; i < 99; i++) await createProject(free, `o-${i}`);
    expect((await free.call('POST', `/api/funnels/${free.f.id}/go-live`, { address: { kind: 'pages' } })).status).toBe(200);
  });

  it('maps the limit errors Cloudflare itself may answer with, and the 48 hour new-account limit', async () => {
    const w = await world();
    w.cf.maxProjects = 0; // the fake answers 400 / 8000027 like the real API is expected to
    const a = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(a.json.error.code).toBe('PAGES_PROJECT_LIMIT');
    w.cf.maxProjects = 100;
    w.cf.failOn(/POST \/accounts\/[^/]+\/pages\/projects$/, 400, 1, { body: { errors: [{ code: 8000000, message: 'New accounts can only create 3 projects during their first 48 hours.' }] } });
    const b = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(b.status).toBe(409);
    expect(b.json.error.code).toBe('PAGES_NEW_ACCOUNT_LIMIT');
    expect(b.json.error.message).toMatch(/first 48 hours/);
  });

  it('a token without write access is explained in terms of the permission to add', async () => {
    const w = await world();
    w.cf.canWrite = false;
    const r = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toContain('Cloudflare Pages: Edit');
    expect(JSON.stringify(r.json)).not.toContain(w.cf.token);
  });

  it('needs the publishing permission for the Pages address, not for a verified domain', async () => {
    const w = await world();
    const viewer = await w.h.member({ token: w.owner.token }, 'member');
    const denied = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } }, viewer.token);
    expect(denied.status).toBe(403);
    const ok = await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'custom', domainId: w.domainId } }, viewer.token);
    expect(ok.status).toBe(200);
  });

  it('without any Cloudflare connection the option explains what is missing', async () => {
    const w = await world({ connect: false });
    const o = (await w.call('GET', `/api/funnels/${w.f.id}/addresses`)).json.options.find((x: any) => x.kind === 'pages');
    expect(o).toMatchObject({ available: false });
    expect(o.reason).toMatch(/Connect a Cloudflare account/);
    expect((await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'pages' } })).status).toBe(409);
  });

  it('is invisible to other workspaces', async () => {
    const w = await world();
    const other = await w.h.register();
    expect((await w.call('GET', `/api/funnels/${w.f.id}/addresses`, undefined, other.token)).status).toBe(404);
    expect((await w.call('POST', `/api/funnels/${w.f.id}/go-live`, { address: { kind: 'custom', domainId: w.domainId } }, other.token)).status).toBe(404);
  });
});
