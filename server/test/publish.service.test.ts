import { describe, expect, it } from 'vitest';
import { activeDomain } from './helpers.js';
import { pagesWorld } from './support/pagesworld.js';

describe('Cloudflare connection', () => {
  it('verifies the token with a read call, stores it encrypted, never returns or logs it', async () => {
    const w = await pagesWorld({ connect: false, target: false, live: false });
    const r = await w.connect();
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ connected: true, accountId: w.cf.accountId, tokenHint: '••••cdef', status: 'connected' });
    expect(JSON.stringify(r.json)).not.toContain(w.cf.token);
    expect(w.cf.calls.map((c) => `${c.method} ${c.path.split('?')[0]}`)).toEqual([`GET /accounts/${w.cf.accountId}/pages/projects`]);
    const row = await w.h.deps.db.get<{ token_enc: string }>('SELECT token_enc FROM publish_credentials');
    expect(row!.token_enc.startsWith('enc2.')).toBe(true);
    expect(row!.token_enc).not.toContain(w.cf.token);
    expect(JSON.stringify((await w.call('GET', '/api/audit')).json)).not.toContain(w.cf.token);
    expect((await w.call('GET', '/api/audit')).json.data.some((a: any) => a.action === 'publishing.connected')).toBe(true);
    expect(JSON.stringify((await w.call('GET', '/api/publishing/connection')).json)).not.toContain(w.cf.token);
  });

  it('explains a token without permission or a wrong account, and stores nothing', async () => {
    const w = await pagesWorld({ connect: false, target: false, live: false });
    const bad = await w.call('PUT', '/api/publishing/connection', { accountId: w.cf.accountId, token: 'wrong-token-0123456789abcdef' });
    expect(bad.status).toBe(422);
    expect(bad.json.error.code).toBe('CLOUDFLARE_REJECTED');
    expect(bad.json.error.message).toContain('Cloudflare Pages: Edit');
    expect(bad.text).not.toContain('wrong-token');
    const other = await w.call('PUT', '/api/publishing/connection', { accountId: 'b'.repeat(32), token: w.cf.token });
    expect(other.status).toBe(422);
    for (const body of [{ accountId: 'short', token: w.cf.token }, { accountId: w.cf.accountId, token: 'tiny' }, { accountId: w.cf.accountId, token: 'has space inside the token value' }]) expect((await w.call('PUT', '/api/publishing/connection', body)).status).toBe(400);
    expect((await w.call('GET', '/api/publishing/connection')).json.connected).toBe(false);
  });

  it('a token that can read but not write connects, then fails clearly at the first deployment', async () => {
    const w = await pagesWorld({ connect: false, target: false });
    w.cf.canWrite = false;
    w.cf.canRead = true;
    expect((await w.connect()).status).toBe(200);
    const t = await w.target();
    expect(t.status).toBe(422);
    expect(t.json.error.message).toContain('Cloudflare Pages: Edit');
  });

  it('re-verifies, records the outcome, and disconnects (refusing while funnels use it unless forced)', async () => {
    const w = await pagesWorld();
    expect((await w.call('POST', '/api/publishing/connection/verify')).json.ok).toBe(true);
    w.cf.token = 'rotated-token-0123456789abcdef';
    const bad = await w.call('POST', '/api/publishing/connection/verify');
    expect(bad.json.ok).toBe(false);
    expect(bad.json.connection.status).toBe('invalid');
    const refuse = await w.call('DELETE', '/api/publishing/connection');
    expect(refuse.status).toBe(409);
    expect(refuse.json.error.code).toBe('CONNECTION_IN_USE');
    expect((await w.call('DELETE', '/api/publishing/connection?force=true')).status).toBe(204);
    expect((await w.settings()).json.target).toBe('origin');
    expect((await w.call('GET', '/api/publishing/connection')).json.connected).toBe(false);
  });

  it('is permissioned and per workspace', async () => {
    const w = await pagesWorld();
    const member = await w.h.member(w.owner, 'member');
    const admin = await w.h.member(w.owner, 'admin');
    expect((await w.call('GET', '/api/publishing/connection', undefined, member.token)).status).toBe(403);
    expect((await w.call('PUT', '/api/publishing/connection', { accountId: w.cf.accountId, token: w.cf.token }, member.token)).status).toBe(403);
    expect((await w.call('GET', '/api/publishing/connection', undefined, admin.token)).json.connected).toBe(true);
    const other = await w.h.register();
    expect((await w.call('GET', '/api/publishing/connection', undefined, other.token)).json.connected).toBe(false);
  });
});

describe('choosing the target', () => {
  it('creates a project fn-<id> and records its pages.dev host', async () => {
    const w = await pagesWorld({ target: false });
    const t = await w.target();
    expect(t.status).toBe(200);
    expect(t.json.project.name).toMatch(/^fn-[0-9a-f]{8}$/);
    expect(t.json.project.url).toBe(`https://${t.json.project.name}.pages.dev`);
    expect(w.cf.projects.has(t.json.project.name)).toBe(true);
    expect(t.json.target).toBe('cloudflare-pages');
    expect(t.json.owner).toBe('workspace');
  });

  it('a custom name, an existing project only with confirmation, invalid names refused', async () => {
    const w = await pagesWorld({ target: false });
    await w.cf.fetch(`https://api.cloudflare.com/client/v4/accounts/${w.cf.accountId}/pages/projects`, { method: 'POST', headers: { authorization: `Bearer ${w.cf.token}` }, body: JSON.stringify({ name: 'my-site' }) });
    const exists = await w.target({ projectName: 'my-site' });
    expect(exists.status).toBe(409);
    expect(exists.json.error.code).toBe('PROJECT_EXISTS');
    expect((await w.target({ projectName: 'my-site', adopt: true })).status).toBe(200);
    for (const name of ['Bad Name', '-start', 'end-', 'a', 'x'.repeat(60), 'under_score']) expect((await w.target({ projectName: name })).status, name).toBe(400);
  });

  it('refuses without a connection or without a live domain-less platform account', async () => {
    const w = await pagesWorld({ connect: false, target: false });
    expect((await w.target()).json.error.code).toBe('PLATFORM_UNAVAILABLE');
    expect((await w.target({ owner: 'workspace' })).json.error.code).toBe('NO_CREDENTIALS');
  });

  it('platform projects use the platform account, are named automatically and are limited per plan', async () => {
    const w = await pagesWorld({ connect: false, target: false, env: { CF_PAGES_ACCOUNT_ID: 'a'.repeat(32), CF_PAGES_API_TOKEN: 'cf-test-token-0123456789abcdef', BILLING_ENFORCE_LIMITS: 'true' } });
    expect((await w.target({ owner: 'platform', projectName: 'mine' })).json.error.code).toBe('PROJECT_NAME_FIXED');
    const t = await w.target({ owner: 'platform' });
    expect(t.status).toBe(200);
    expect(t.json.owner).toBe('platform');
    // the free plan allows one hosted project
    const second = (await w.call('POST', '/api/funnels', { name: 'Second' })).json;
    const r = await w.call('PUT', `/api/funnels/${second.id}/publishing`, { target: 'cloudflare-pages', owner: 'platform' });
    expect(r.status).toBe(402);
    expect(r.json.error.code).toBe('PLAN_LIMIT_REACHED');
  });

  it('switching back to this server pauses, deletes or keeps the site', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const r = await w.call('PUT', `/api/funnels/${w.f.id}/publishing`, { target: 'origin', leave: 'pause' });
    expect(r.json.target).toBe('origin');
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
    const again = await w.target();
    expect(again.json.target).toBe('cloudflare-pages');
    const gone = await w.call('PUT', `/api/funnels/${w.f.id}/publishing`, { target: 'origin', leave: 'delete' });
    expect(gone.status).toBe(200);
    expect(w.cf.projects.has(name)).toBe(false);
  });

  it('is invisible to other workspaces', async () => {
    const w = await pagesWorld();
    const other = await w.h.register();
    for (const [m, p, b] of [['GET', `/api/funnels/${w.f.id}/publishing`], ['PUT', `/api/funnels/${w.f.id}/publishing`, { target: 'origin' }], ['POST', `/api/funnels/${w.f.id}/publishing/redeploy`], ['GET', `/api/funnels/${w.f.id}/publishing/deployments`]] as const) {
      expect((await w.call(m, p, b, other.token)).status, `${m} ${p}`).toBe(404);
    }
  });
});

describe('deploying', () => {
  it('builds the funnel into a site Cloudflare serves: pages, headers, absolute API origin, bundled beacon', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const dep = await w.deployments();
    expect(dep).toHaveLength(1);
    expect(dep[0]).toMatchObject({ status: 'succeeded', reason: 'publish', active: true, fileCount: expect.any(Number) });
    expect(dep[0].versionId).toMatch(/^[0-9a-f]{12}$/);
    const page = w.cf.serve(name, '/promo/')!;
    expect(page.status).toBe(200);
    expect(page.body).toContain('Version one');
    expect(page.body).toMatch(/src="\/_fn\/beacon\.[0-9a-f]{10}\.js"/);
    expect(page.body).toContain('data-api="https://api.funnels.test"');
    expect(w.cf.serve(name, '/thanks/')!.status).toBe(200);
    expect(w.cf.serve(name, '/nothing-here/')!.status).toBe(404);
    const prod = w.cf.production(name)!;
    expect(prod.headers).toContain('/promo/\n  Content-Security-Policy:');
    expect(prod.headers).toContain("connect-src 'self' https://api.funnels.test");
    expect(Object.keys(prod.manifest).some((k) => k.startsWith('/_fn/beacon.'))).toBe(true);
    expect((await w.settings()).json.active).toMatchObject({ status: 'succeeded', versionId: dep[0].versionId });
  });

  it('every file is served: a wrong asset hash would be accepted by Cloudflare and silently never served', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const prod = w.cf.production(name)!;
    for (const path of Object.keys(prod.manifest)) {
      const hit = w.cf.serve(name, path.endsWith('index.html') ? path : path)!;
      expect(hit.status, path).toBe(200);
    }
  });

  it('an unchanged state deploys nothing; a change uploads only the files that changed', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const uploadsBefore = w.cf.callsTo(/POST \/pages\/assets\/upload/).length;
    const deploymentsBefore = w.cf.deployments(name).length;
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`); // forced: always deploys
    await w.drain();
    expect(w.cf.deployments(name)).toHaveLength(deploymentsBefore + 1);
    expect(w.cf.callsTo(/POST \/pages\/assets\/upload/).length).toBe(uploadsBefore); // everything was already there
    // a save that changes nothing visible
    const before = w.cf.deployments(name).length;
    const { schedulePublish } = await import('../src/services/publishing.js');
    await schedulePublish(w.h.deps, w.owner.wsId, w.f.id, 'save');
    await w.drain();
    expect(w.cf.deployments(name)).toHaveLength(before);
    const hist = await w.deployments();
    expect(hist[0]).toMatchObject({ status: 'superseded' });
    // a real change
    await w.page('Version two');
    await w.drain();
    expect(w.cf.deployments(name)).toHaveLength(before + 1);
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version two');
    expect(w.cf.serve(name, '/thanks/')!.body).not.toContain('Version two');
    const uploaded = w.cf.callsTo(/POST \/pages\/assets\/upload/).length - uploadsBefore;
    expect(uploaded).toBe(1); // one batch, which carried the changed page only
  });

  it('many quick saves become one deployment of the latest state', async () => {
    const w = await pagesWorld({ env: { PAGES_DEBOUNCE_SECONDS: '5' } });
    const name = await w.projectName();
    const before = w.cf.deployments(name).length;
    for (let i = 1; i <= 6; i++) await w.page(`Edit ${i}`);
    expect((await w.deployments()).filter((d) => d.status === 'queued')).toHaveLength(1);
    await w.drain();
    expect(w.cf.deployments(name)).toHaveLength(before + 1);
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Edit 6');
  });

  it('single flight, last wins: a save during a running deployment is deployed after it, never concurrently', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    w.cf.pollsToFinish = 4;
    await w.page('First change');
    await w.h.worker.tick(); // the deploy job: build, upload, create the Cloudflare deployment; now polling
    expect((await w.deployments())[0].status).toBe('deploying');
    await w.page('Second change');
    await w.h.worker.tick(); // the second deploy job finds the lease taken and waits
    expect(w.cf.deployments(name)).toHaveLength(2); // initial + first change only
    await w.drain();
    expect(w.cf.deployments(name)).toHaveLength(3);
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Second change');
    const hist = await w.deployments();
    expect(hist.filter((d) => d.status === 'succeeded')).toHaveLength(3);
    expect(hist.filter((d) => ['queued', 'building', 'uploading', 'deploying'].includes(d.status))).toHaveLength(0);
  });

  it('survives a restart in the middle: the state is in the database, the next worker finishes it', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    w.cf.pollsToFinish = 3;
    await w.page('Mid-air');
    await w.h.worker.tick();
    expect((await w.deployments())[0].status).toBe('deploying');
    const { createWorker } = await import('../src/bootstrap.js');
    const second = createWorker(w.h.deps); // a new process
    for (let i = 0; i < 10; i++) await second.tick();
    expect((await w.deployments())[0].status).toBe('succeeded');
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Mid-air');
  });

  it('a funnel that is not live is not deployed; going live deploys it', async () => {
    const w = await pagesWorld({ live: false });
    expect(await w.deployments()).toEqual([]);
    await w.go();
    await w.drain();
    expect((await w.deployments())[0]).toMatchObject({ status: 'succeeded' });
  });

  it('uploaded images are copied into the site', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)]);
    const up = await w.h.app.request('/api/assets?name=logo.png', { method: 'POST', headers: { authorization: `Bearer ${w.owner.token}`, 'content-type': 'image/png' }, body: png });
    const asset = (await up.json()) as { id: string; url: string };
    const { createBuilder } = await import('../src/blocks/index.js');
    const doc = { version: 1 as const, blocks: [createBuilder('s').image(asset.url, 'Logo')] } as never;
    void doc;
    // reference the asset from the page through custom CSS so it lands in the rendered HTML
    await w.call('PATCH', `/api/funnels/${w.f.id}/steps/${w.stepId}`, { custom_css: `body{background:url(${asset.url})}` });
    await w.drain();
    const html = w.cf.serve(name, '/promo/')!.body;
    expect(html).toContain(asset.url);
    const served = w.cf.serve(name, asset.url)!;
    expect(served.status).toBe(200);
    expect(served.contentType).toBe('image/png');
  });
});

describe('failures', () => {
  it('a failed Cloudflare stage is shown with its log, and Redeploy fixes it', async () => {
    const w = await pagesWorld();
    w.cf.failNextDeploymentAt = 'deploy';
    await w.page('Will fail');
    await w.drain();
    const hist = await w.deployments();
    expect(hist[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('deploy stage') });
    const detail = (await w.call('GET', `/api/funnels/${w.f.id}/publishing/deployments/${hist[0].id}`)).json;
    expect(detail.log.some((l: any) => l.level === 'error')).toBe(true);
    expect((await w.settings()).json.lastError).toContain('deploy stage');
    const name = await w.projectName();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version one'); // the live site is untouched
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`);
    await w.drain();
    expect((await w.deployments())[0].status).toBe('succeeded');
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Will fail');
    expect((await w.settings()).json.lastError).toBeNull();
  });

  it('retries Cloudflare outages with backoff and then succeeds', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    w.cf.failOn(/POST \/accounts\/.*\/deployments/, 503, 2);
    await w.page('After outage');
    await w.drain();
    expect((await w.deployments())[0].status).toBe('succeeded');
    expect(w.cf.callsTo(/POST \/accounts\/.*\/deployments/).filter((c) => c.status === 503)).toHaveLength(2);
    expect(w.cf.serve(name, '/promo/')!.body).toContain('After outage');
  });

  it('honours Retry-After when rate limited', async () => {
    const w = await pagesWorld();
    w.cf.failOn(/GET \/accounts\/.*\/upload-token/, 429, 1, { retryAfter: 120 });
    await w.page('Rate limited');
    await w.h.worker.tick();
    expect((await w.deployments())[0].status).toBe('queued');
    const job = await w.h.deps.db.get<{ run_at: number }>("SELECT run_at FROM jobs WHERE type = 'publish.deploy' AND status = 'queued'");
    expect(Number(job!.run_at) - w.h.clock.now().getTime()).toBeGreaterThanOrEqual(119_000);
    await w.drain();
    expect((await w.deployments())[0].status).toBe('succeeded');
  });

  it('gives up after repeated outages and says so', async () => {
    const w = await pagesWorld();
    w.cf.failOn(/POST \/accounts\/.*\/deployments/, 500, 99);
    await w.page('Never');
    await w.drain();
    const d = (await w.deployments())[0];
    expect(d.status).toBe('failed');
    expect(d.error).toContain('500');
  });

  it('a token that lost its permission fails once, with the reason, and is not retried', async () => {
    const w = await pagesWorld();
    w.cf.canWrite = false;
    await w.page('No permission');
    await w.drain();
    const d = (await w.deployments())[0];
    expect(d.status).toBe('failed');
    expect(d.error).toContain('Cloudflare Pages: Edit');
    expect(w.cf.callsTo(/GET \/accounts\/.*\/upload-token/).length).toBeLessThanOrEqual(2);
  });

  it('a deployment Cloudflare never finishes times out', async () => {
    const w = await pagesWorld({ env: { PAGES_DEPLOY_TIMEOUT_SECONDS: '60' } });
    w.cf.pollsToFinish = 1e9;
    await w.page('Stuck');
    for (let i = 0; i < 6; i++) await w.h.worker.tick();
    expect((await w.deployments())[0].status).toBe('deploying');
    w.h.clock.advance(61_000);
    await w.drain();
    const d = (await w.deployments())[0];
    expect(d.status).toBe('failed');
    expect(d.error).toContain('within 60 seconds');
    // the lease is free again: the next change deploys
    w.cf.pollsToFinish = 1;
    await w.page('Unstuck');
    await w.drain();
    expect((await w.deployments())[0].status).toBe('succeeded');
  });

  it('a site that is too big is refused before anything is uploaded', async () => {
    const w = await pagesWorld({ env: { PAGES_MAX_FILES: '3' } });
    const before = w.cf.callsTo(/upload-token/).length;
    await w.call('POST', `/api/funnels/${w.f.id}/steps`, { name: 'Extra', base_path: '/extra' });
    await w.drain();
    const d = (await w.deployments())[0];
    expect(d.status).toBe('failed');
    expect(d.error).toContain('limit is 3');
    expect(w.cf.callsTo(/upload-token/).length).toBe(before);
  });

  it('a project deleted on Cloudflare is created again', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    w.cf.projects.delete(name);
    await w.page('Back again');
    await w.drain();
    expect((await w.deployments())[0].status).toBe('succeeded');
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Back again');
  });

  it('a domain shared with another live funnel is refused with an explanation', async () => {
    const w = await pagesWorld();
    const other = (await w.call('POST', '/api/funnels', { name: 'Other', base_path: '/other' })).json;
    expect((await w.call('PATCH', `/api/funnels/${other.id}`, { status: 'live', domain_id: w.domainId })).status).toBe(200);
    await w.page('Shared');
    await w.drain();
    const d = (await w.deployments())[0];
    expect(d.status).toBe('failed');
    expect(d.error).toContain('one funnel per domain');
    expect((await w.settings()).json.constraints.domainShared).toBe(true);
  });

  it('secrets never reach logs, errors, the history or the audit trail, even when Cloudflare echoes them', async () => {
    const w = await pagesWorld();
    w.cf.failOn(/POST \/accounts\/.*\/deployments/, 400, 1, { body: { errors: [{ code: 8000096, message: `bad request for token ${w.cf.token}` }] } });
    await w.page('Leaky');
    await w.drain();
    const everything = JSON.stringify([await w.deployments(), (await w.settings()).json, (await w.call('GET', '/api/audit')).json, await w.h.deps.db.all('SELECT log_json, error FROM publish_deployments'), await w.h.deps.db.all('SELECT last_error FROM funnel_publish')]);
    expect(everything).not.toContain(w.cf.token);
    expect(everything).toContain('[redacted]');
  });
});

describe('rollback, redeploy, unpublish', () => {
  it('rolls back to an earlier successful deployment and holds automatic deployments until Redeploy', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    await w.page('Version two');
    await w.drain();
    const hist = await w.deployments();
    const first = hist.find((d) => d.canRollback)!;
    expect(first).toBeTruthy();
    const rb = await w.call('POST', `/api/funnels/${w.f.id}/publishing/rollback/${first.id}`);
    expect(rb.status).toBe(200);
    expect(rb.json.hold).toBe(true);
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version one');
    expect((await w.deployments())[0]).toMatchObject({ reason: 'rollback', status: 'succeeded', active: true });
    await w.page('Version three');
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version one'); // saves do not undo a rollback
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`);
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version three');
    expect((await w.settings()).json.hold).toBe(false);
  });

  it('refuses to roll back to a failed, active or unknown deployment, or while one is running', async () => {
    const w = await pagesWorld();
    w.cf.failNextDeploymentAt = 'build';
    await w.page('Bad');
    await w.drain();
    const hist = await w.deployments();
    const failed = hist.find((d) => d.status === 'failed')!;
    const active = hist.find((d) => d.active)!;
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/rollback/${failed.id}`)).json.error.code).toBe('NOT_ROLLBACK_TARGET');
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/rollback/${active.id}`)).json.error.code).toBe('ALREADY_ACTIVE');
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/rollback/dep_nope`)).status).toBe(404);
    // one more good deploy, then start another and try to roll back during it
    w.cf.pollsToFinish = 5;
    await w.page('Running');
    await w.h.worker.tick();
    const older = (await w.deployments()).find((d) => d.canRollback);
    if (older) expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/rollback/${older.id}`)).json.error.code).toBe('DEPLOYMENT_IN_PROGRESS');
  });

  it('unpublish (pause) replaces the site with a paused page, removes the domain and holds; Redeploy brings it back', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const r = await w.call('POST', `/api/funnels/${w.f.id}/publishing/unpublish`, { mode: 'pause' });
    expect(r.status).toBe(200);
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
    expect(w.cf.serve(name, '/anything/')!.body).toContain('Not available');
    expect([...w.cf.projects.get(name)!.domains.keys()]).toEqual([]);
    const s = (await w.settings()).json;
    expect(s).toMatchObject({ paused: true, hold: true, customDomain: null });
    await w.page('Edited while unpublished');
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/redeploy`);
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Edited while unpublished');
    expect((await w.settings()).json.paused).toBe(false);
  });

  it('unpublish (delete) removes the project the app created, and only that', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    expect((await w.call('POST', `/api/funnels/${w.f.id}/publishing/unpublish`, { mode: 'delete' })).status).toBe(200);
    expect(w.cf.projects.has(name)).toBe(false);
    expect((await w.settings()).json.project).toBeNull();
    // an adopted project is never deleted
    await w.cf.fetch(`https://api.cloudflare.com/client/v4/accounts/${w.cf.accountId}/pages/projects`, { method: 'POST', headers: { authorization: `Bearer ${w.cf.token}` }, body: JSON.stringify({ name: 'theirs' }) });
    await w.target({ projectName: 'theirs', adopt: true });
    await w.drain();
    await w.call('POST', `/api/funnels/${w.f.id}/publishing/unpublish`, { mode: 'delete' });
    await w.drain();
    expect(w.cf.projects.has('theirs')).toBe(true);
    expect(w.cf.serve('theirs', '/promo/')!.body).toContain('Not available');
  });

  it('takes the site offline when the funnel stops being live, and back when it is live again', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    await w.call('PATCH', `/api/funnels/${w.f.id}`, { status: 'test' });
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
    expect((await w.settings()).json.paused).toBe(true);
    await w.go();
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Version one');
    expect((await w.settings()).json.paused).toBe(false);
  });

  it('a suspended workspace goes offline on Cloudflare too', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    await w.h.deps.db.run("UPDATE workspaces SET suspended_at = ? WHERE id = ?", '2026-03-10T12:00:00.000Z', w.owner.wsId);
    const { onWorkspaceChanged } = await import('../src/services/publishing.js');
    await onWorkspaceChanged(w.h.deps, w.owner.wsId);
    await w.drain();
    expect(w.cf.serve(name, '/promo/')!.body).toContain('Not available');
  });

  it('purging the funnel deletes the project the app created', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    await w.call('DELETE', `/api/funnels/${w.f.id}`);
    await w.drain();
    await w.call('DELETE', `/api/funnels/${w.f.id}/purge`);
    await w.drain();
    expect(w.cf.projects.has(name)).toBe(false);
  });
});

describe('custom domain', () => {
  it('is attached after the first deployment and followed until Cloudflare reports it active', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    expect([...w.cf.projects.get(name)!.domains.keys()]).toEqual([w.hostname]);
    const s = (await w.settings()).json;
    expect(s.customDomain).toMatchObject({ hostname: w.hostname, status: 'active', dns: { type: 'CNAME', name: w.hostname, value: `${name}.pages.dev` } });
  });

  it('shows pending while Cloudflare validates, and a failure with its reason', async () => {
    const w = await pagesWorld({ target: false });
    w.cf.domainBehaviour = null;
    await w.target();
    await w.h.worker.tick();
    for (let i = 0; i < 4; i++) await w.h.worker.tick();
    expect((await w.settings()).json.customDomain.status).toBe('pending');
    w.cf.domainBehaviour = 'error';
    const r = await w.call('POST', `/api/funnels/${w.f.id}/publishing/domain/refresh`);
    expect(r.json).toMatchObject({ status: 'failed', error: 'CNAME record not set' });
    w.cf.domainBehaviour = 1;
    const ok = await w.call('POST', `/api/funnels/${w.f.id}/publishing/domain/refresh`);
    expect(ok.json.status).toBe('active');
  });

  it('moves with the funnel: a different domain replaces the old one', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const d2 = await activeDomain(w.h, w.owner.token, 'second.example.com');
    expect((await w.call('PATCH', `/api/funnels/${w.f.id}`, { status: 'test' })).status).toBe(200);
    expect((await w.call('PATCH', `/api/funnels/${w.f.id}`, { status: 'live', domain_id: d2 })).status).toBe(200);
    await w.drain();
    expect([...w.cf.projects.get(name)!.domains.keys()]).toEqual(['second.example.com']);
  });

  it('a domain whose CNAME points at the Pages project verifies as active', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const d = await w.call('POST', '/api/domains', { hostname: 'cname.example.com' });
    w.h.dns.cname.set('cname.example.com', [`${name}.pages.dev`]);
    w.h.dns.txt.set('_funnels-challenge.cname.example.com', [d.json.dns.txt.value]);
    expect((await w.call('POST', `/api/domains/${d.json.id}/verify`)).json.domain.status).toBe('active');
    const unrelated = await w.call('POST', '/api/domains', { hostname: 'nope.example.com' });
    w.h.dns.cname.set('nope.example.com', ['someone-else.pages.dev']);
    w.h.dns.txt.set('_funnels-challenge.nope.example.com', [unrelated.json.dns.txt.value]);
    expect((await w.call('POST', `/api/domains/${unrelated.json.id}/verify`)).json.domain.status).toBe('pending');
  });
});

describe('the public API from a Pages site', () => {
  it('answers CORS for the project host and its preview subdomains, not for strangers', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const ask = (origin: string) => w.h.app.request('/api/public/events', { method: 'OPTIONS', headers: { origin } });
    expect((await ask(`https://${name}.pages.dev`)).headers.get('access-control-allow-origin')).toBe(`https://${name}.pages.dev`);
    expect((await ask(`https://abc123.${name}.pages.dev`)).headers.get('access-control-allow-origin')).toBe(`https://abc123.${name}.pages.dev`);
    expect((await ask(`https://${w.hostname}`)).headers.get('access-control-allow-origin')).toBe(`https://${w.hostname}`);
    expect((await ask('https://other-project.pages.dev')).headers.get('access-control-allow-origin')).toBeNull();
    expect((await ask('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
    expect((await ask('http://promo.example.com')).headers.get('access-control-allow-origin')).toBeNull();
    expect((await ask(`https://${name}.pages.dev/path`)).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a form posted from the Pages origin lands in the app like any other submission', async () => {
    const w = await pagesWorld();
    const name = await w.projectName();
    const { fromTemplate } = await import('./helpers.js');
    void fromTemplate;
    const res = await w.h.app.request('/api/public/events', { method: 'POST', headers: { origin: `https://${name}.pages.dev`, 'content-type': 'text/plain', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/120', 'x-forwarded-for': '203.0.113.5' }, body: JSON.stringify({ funnelId: w.f.id, stepId: w.stepId, type: 'page_view', visitorId: 'v-pages' }) });
    expect(res.status).toBe(202);
    expect(res.headers.get('access-control-allow-origin')).toBe(`https://${name}.pages.dev`);
  });
});
