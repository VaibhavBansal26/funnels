import { describe, expect, it } from 'vitest';
import { copyName, uniqueName } from '../src/services/paths.js';
import { activeDomain, makeFunnel, makeHarness, type Harness } from './helpers.js';

describe('funnel create and read', () => {
  it('creates a funnel with an auto-created first step and default page', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Spring Sale' });
    expect(f).toMatchObject({ name: 'Spring Sale', status: 'test', basePath: '/spring-sale', domain: null, stepCount: 1 });
    expect(f.steps[0]).toMatchObject({ path: '/spring-sale', position: 1 });
    const page = await h.call('GET', `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`, { token: u.token });
    expect(page.json.doc.blocks.length).toBeGreaterThan(0);
    expect(f.thumbnail.heading).toBe('Spring Sale');
  });

  it('validates input', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const bad = [{ name: '' }, { name: 'x', base_path: 'no-slash' }, { name: 'x', base_path: '/a/b' }, { name: 'x', status: 'live' }, { name: 'x', favicon: 'javascript:alert(1)' }, { name: 'x'.repeat(200) }];
    for (const body of bad) expect([400, 409]).toContain((await h.call('POST', '/api/funnels', { token: u.token, body })).status);
    expect((await h.call('POST', '/api/funnels', { token: u.token, body: { name: 'x', status: 'live' } })).json.error.code).toBe('DOMAIN_NOT_ADDED');
    expect((await h.call('POST', '/api/funnels', { token: u.token, body: { name: 'x', base_path: '/a/b' } })).json.error.code).toBe('INVALID_PATH');
  });

  it('rejects unknown tags and domains as not found', async () => {
    const h = await makeHarness();
    const u = await h.register();
    expect((await h.call('POST', '/api/funnels', { token: u.token, body: { name: 'x', tags: ['nope'] } })).status).toBe(404);
    expect((await h.call('POST', '/api/funnels', { token: u.token, body: { name: 'x', domain_id: 'nope' } })).status).toBe(404);
  });
});

describe('funnel list', () => {
  async function seed() {
    const h = await makeHarness();
    const u = await h.register();
    const tagA = (await h.call('POST', '/api/tags', { token: u.token, body: { name: 'Promo' } })).json;
    const tagB = (await h.call('POST', '/api/tags', { token: u.token, body: { name: 'Evergreen' } })).json;
    const domainId = await activeDomain(h, u.token);
    const names = ['Alpha', 'bravo', 'Charlie', 'Delta'];
    const ids: string[] = [];
    for (const [i, name] of names.entries()) {
      h.clock.advance(1000);
      const f = await makeFunnel(h, u.token, { name, tags: i % 2 === 0 ? [tagA.id] : [tagB.id] });
      ids.push(f.id);
    }
    await h.call('PATCH', `/api/funnels/${ids[0]}`, { token: u.token, body: { domain_id: domainId, status: 'live' } });
    return { h, u, tagA, tagB, ids, domainId };
  }

  it('searches by name case-insensitively and escapes wildcards', async () => {
    const { h, u } = await seed();
    expect((await h.call('GET', '/api/funnels?search=BRA', { token: u.token })).json.data.map((f: any) => f.name)).toEqual(['bravo']);
    expect((await h.call('GET', '/api/funnels?search=%25', { token: u.token })).json.data).toHaveLength(0);
    expect((await h.call('GET', '/api/funnels?search=_', { token: u.token })).json.data).toHaveLength(0);
  });

  it('filters by status, tags and domain connection', async () => {
    const { h, u, tagA, tagB } = await seed();
    const names = async (q: string) => (await h.call('GET', `/api/funnels?${q}&sort=name&order=asc`, { token: u.token })).json.data.map((f: any) => f.name);
    expect(await names('status=live')).toEqual(['Alpha']);
    expect(await names('status=test')).toEqual(['bravo', 'Charlie', 'Delta']);
    expect(await names('status=live,test')).toHaveLength(4);
    expect(await names(`tags=${tagA.id}`)).toEqual(['Alpha', 'Charlie']);
    expect(await names(`tags=${tagA.id},${tagB.id}`)).toHaveLength(4);
    expect(await names('domain_connected=true')).toEqual(['Alpha']);
    expect(await names('domain_connected=false')).toHaveLength(3);
  });

  it('sorts by updated, created and name, with pagination metadata', async () => {
    const { h, u, ids } = await seed();
    const get = async (q: string) => (await h.call('GET', `/api/funnels?${q}`, { token: u.token })).json;
    expect((await get('sort=name')).data.map((f: any) => f.name)).toEqual(['Alpha', 'bravo', 'Charlie', 'Delta']); // case-insensitive
    expect((await get('sort=name&order=desc')).data[0].name).toBe('Delta');
    expect((await get('sort=created')).data.map((f: any) => f.id)).toEqual([...ids].reverse());
    h.clock.advance(5000);
    await h.call('PATCH', `/api/funnels/${ids[1]}`, { token: u.token, body: { name: 'bravo2' } });
    expect((await get('sort=updated')).data[0].name).toBe('bravo2');
    const p = await get('limit=2&page=2&sort=name');
    expect(p.data.map((f: any) => f.name)).toEqual(['Charlie', 'Delta']);
    expect(p.pagination).toEqual({ page: 2, limit: 2, total: 4, totalPages: 2 });
    expect((await h.call('GET', '/api/funnels?limit=101', { token: u.token })).status).toBe(400);
    expect((await h.call('GET', '/api/funnels?page=0', { token: u.token })).status).toBe(400);
    expect((await get('page=9')).data).toEqual([]);
  });

  it('returns aggregate stats and filter counts', async () => {
    const { h, u, ids, tagA } = await seed();
    const f = (await h.call('GET', `/api/funnels/${ids[1]}`, { token: u.token })).json;
    const step = f.steps[0].id;
    const ua = { 'user-agent': 'Mozilla/5.0 Chrome/120' };
    for (const v of ['v1', 'v2', 'v1']) await h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: step, type: 'page_view', visitorId: v }, headers: ua });
    await h.call('POST', '/api/public/events', { body: { funnelId: f.id, stepId: step, type: 'optin', visitorId: 'v1' }, headers: ua });
    const list = (await h.call('GET', '/api/funnels?search=bravo', { token: u.token })).json.data[0];
    expect(list.stats).toEqual({ visits: 3, optins: 1, orders: 0, sales: 0 });
    expect(list.stepCount).toBe(1);
    const filters = (await h.call('GET', '/api/funnels/filters', { token: u.token })).json;
    expect(filters.status).toEqual({ live: 1, test: 3 });
    expect(filters.domainConnected).toEqual({ connected: 1, notConnected: 3 });
    expect(filters.tags.find((t: any) => t.id === tagA.id).count).toBe(2);
  });
});

describe('funnel update and status/domain state machine', () => {
  it('publishing needs an attached ACTIVE domain; test detaches the domain', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const patch = (body: object) => h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body });
    expect((await patch({ status: 'live' })).json.error.code).toBe('DOMAIN_NOT_ADDED');
    const pending = (await h.call('POST', '/api/domains', { token: u.token, body: { hostname: 'pending.example.com' } })).json;
    expect((await patch({ domain_id: pending.id })).json.error.code).toBe('DOMAIN_NOT_ACTIVE');
    const dom = await activeDomain(h, u.token);
    const live = await patch({ domain_id: dom, status: 'live' });
    expect(live.json).toMatchObject({ status: 'live', domain: { id: dom } });
    expect((await patch({ name: 'Renamed' })).json).toMatchObject({ status: 'live', domain: { id: dom } });
    const test = await patch({ status: 'test' });
    expect(test.json).toMatchObject({ status: 'test', domain: null });
    // attaching without a status keeps the funnel in test, ready to publish
    expect((await patch({ domain_id: dom })).json).toMatchObject({ status: 'test', domain: { id: dom } });
    expect((await patch({ status: 'live' })).json.status).toBe('live');
    // detaching a live funnel puts it back to test
    expect((await patch({ domain_id: null })).json).toMatchObject({ status: 'test', domain: null });
    // status test wins over a domain in the same request
    expect((await patch({ domain_id: dom, status: 'test' })).json.domain).toBeNull();
    expect((await patch({ domain_id: 'missing', status: 'test' })).status).toBe(200);
    expect((await patch({ domain_id: 'missing' })).status).toBe(404);
  });
});

describe('duplicate', () => {
  it('names copies " copy", " copy 2", ...', () => {
    expect(copyName('Funnel', ['Funnel'])).toBe('Funnel copy');
    expect(copyName('Funnel', ['Funnel', 'Funnel copy'])).toBe('Funnel copy 2');
    expect(copyName('Funnel', ['Funnel', 'Funnel copy', 'Funnel copy 2'])).toBe('Funnel copy 3');
    expect(copyName('Funnel copy', ['Funnel', 'Funnel copy'])).toBe('Funnel copy 2');
    expect(copyName('Funnel copy 2', ['Funnel copy', 'Funnel copy 2'])).toBe('Funnel copy 3');
    expect(copyName('funnel', ['FUNNEL COPY'])).toBe('funnel copy 2');
    expect(uniqueName('Lead', ['lead'])).toBe('Lead 2');
  });

  it('clones steps, content and tags; forces test; drops the domain; remaps step links', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const tag = (await h.call('POST', '/api/tags', { token: u.token, body: { name: 'T' } })).json;
    const dom = await activeDomain(h, u.token);
    const f = await makeFunnel(h, u.token, { name: 'Orig', tags: [tag.id] });
    const s2 = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Second' } })).json;
    await h.call('PUT', `/api/funnels/${f.id}/steps/${f.steps[0].id}/page`, {
      token: u.token,
      body: { doc: { version: 1, blocks: [{ id: 'b', type: 'button', text: 'Go', action: { type: 'step', stepId: s2.id } }] } },
    });
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });

    const dup1 = (await h.call('POST', `/api/funnels/${f.id}/duplicate`, { token: u.token })).json;
    const dup2 = (await h.call('POST', `/api/funnels/${f.id}/duplicate`, { token: u.token })).json;
    expect(dup1.name).toBe('Orig copy');
    expect(dup2.name).toBe('Orig copy 2');
    expect(dup1).toMatchObject({ status: 'test', domain: null, stepCount: 2 });
    expect(dup1.tags).toHaveLength(1);
    expect(dup1.basePath).not.toBe(f.basePath);
    const newSecond = dup1.steps[1].id;
    expect(newSecond).not.toBe(s2.id);
    const page = (await h.call('GET', `/api/funnels/${dup1.id}/steps/${dup1.steps[0].id}/page`, { token: u.token })).json;
    expect(page.doc.blocks[0].action.stepId).toBe(newSecond); // points at the clone, not the original
    expect(new Set(dup1.steps.map((s: any) => s.path)).size).toBe(2);
    expect((await h.call('GET', `/api/funnels/${f.id}`, { token: u.token })).json.status).toBe('live'); // original untouched
  });
});

describe('soft delete, restore and purge', () => {
  it('moves to trash, hides everywhere, restores, and purges only from trash', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const f = await makeFunnel(h, u.token, { name: 'Gone' });
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { domain_id: dom, status: 'live' } });
    expect((await h.call('DELETE', `/api/funnels/${f.id}/purge`, { token: u.token })).json.error.code).toBe('NOT_IN_TRASH');
    expect((await h.call('POST', `/api/funnels/${f.id}/restore`, { token: u.token })).json.error.code).toBe('NOT_DELETED');
    expect((await h.call('DELETE', `/api/funnels/${f.id}`, { token: u.token })).status).toBe(204);

    expect((await h.call('GET', '/api/funnels', { token: u.token })).json.data).toHaveLength(0);
    for (const p of [`/api/funnels/${f.id}`, `/api/funnels/${f.id}/steps`, `/api/funnels/${f.id}/analytics`]) expect((await h.call('GET', p, { token: u.token })).status).toBe(404);
    expect((await h.call('PATCH', `/api/funnels/${f.id}`, { token: u.token, body: { name: 'x' } })).status).toBe(404);
    const trash = (await h.call('GET', '/api/funnels/trash', { token: u.token })).json.data;
    expect(trash.map((t: any) => t.id)).toEqual([f.id]);
    expect(trash[0]).toMatchObject({ status: 'test', domain: null });
    const host = await h.app.request('/offers', { headers: { host: 'offers.example.com' } });
    expect(host.status).toBe(404); // not served while trashed

    const restored = await h.call('POST', `/api/funnels/${f.id}/restore`, { token: u.token });
    expect(restored.json).toMatchObject({ id: f.id, deletedAt: null, status: 'test' });
    expect((await h.call('GET', '/api/funnels', { token: u.token })).json.data).toHaveLength(1);

    await h.call('DELETE', `/api/funnels/${f.id}`, { token: u.token });
    expect((await h.call('DELETE', `/api/funnels/${f.id}/purge`, { token: u.token })).status).toBe(204);
    expect((await h.call('GET', '/api/funnels/trash', { token: u.token })).json.data).toHaveLength(0);
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM steps')).toEqual({ n: 0 });
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM step_pages')).toEqual({ n: 0 });
  });

  it('a trashed funnel frees its domain paths', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const a = await makeFunnel(h, u.token, { name: 'Same Path', base_path: '/promo' });
    await h.call('PATCH', `/api/funnels/${a.id}`, { token: u.token, body: { domain_id: dom } });
    const b = await makeFunnel(h, u.token, { name: 'Other', base_path: '/promo' });
    expect((await h.call('PATCH', `/api/funnels/${b.id}`, { token: u.token, body: { domain_id: dom } })).status).toBe(409);
    await h.call('DELETE', `/api/funnels/${a.id}`, { token: u.token });
    expect((await h.call('PATCH', `/api/funnels/${b.id}`, { token: u.token, body: { domain_id: dom } })).status).toBe(200);
  });
});

describe('tags', () => {
  it('names are unique per workspace, case-insensitively', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    expect((await h.call('POST', '/api/tags', { token: a.token, body: { name: 'Sale' } })).status).toBe(201);
    for (const name of ['sale', 'SALE', ' Sale ']) expect((await h.call('POST', '/api/tags', { token: a.token, body: { name } })).json.error.code).toBe('TAG_EXISTS');
    expect((await h.call('POST', '/api/tags', { token: b.token, body: { name: 'sale' } })).status).toBe(201); // other workspace is independent
    const t2 = (await h.call('POST', '/api/tags', { token: a.token, body: { name: 'Other' } })).json;
    expect((await h.call('PUT', `/api/tags/${t2.id}`, { token: a.token, body: { name: 'SALE' } })).json.error.code).toBe('TAG_EXISTS');
    expect((await h.call('PUT', `/api/tags/${t2.id}`, { token: a.token, body: { name: 'Renamed' } })).json.name).toBe('Renamed');
    expect((await h.call('PUT', `/api/tags/${t2.id}`, { token: a.token, body: { name: 'renamed' } })).status).toBe(200); // same tag, new case
  });

  it('deleting a tag removes it only from this workspace funnels', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    const tagA = (await h.call('POST', '/api/tags', { token: a.token, body: { name: 'Shared' } })).json;
    const tagB = (await h.call('POST', '/api/tags', { token: b.token, body: { name: 'Shared' } })).json;
    const fa = await makeFunnel(h, a.token, { tags: [tagA.id] });
    const fb = await makeFunnel(h, b.token, { tags: [tagB.id] });
    // a funnel can never carry another workspace's tag
    expect((await h.call('PATCH', `/api/funnels/${fb.id}`, { token: b.token, body: { tags: [tagA.id] } })).status).toBe(404);
    expect((await h.call('DELETE', `/api/tags/${tagA.id}`, { token: b.token })).status).toBe(404);
    expect((await h.call('DELETE', `/api/tags/${tagA.id}`, { token: a.token })).status).toBe(204);
    expect((await h.call('GET', `/api/funnels/${fa.id}`, { token: a.token })).json.tags).toEqual([]);
    expect((await h.call('GET', `/api/funnels/${fb.id}`, { token: b.token })).json.tags).toHaveLength(1);
  });

  it('bulk delete is all-or-nothing and bulk tag works', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const t1 = (await h.call('POST', '/api/tags', { token: u.token, body: { name: 'One' } })).json;
    const t2 = (await h.call('POST', '/api/tags', { token: u.token, body: { name: 'Two' } })).json;
    const f1 = await makeFunnel(h, u.token, { name: 'F1' });
    const f2 = await makeFunnel(h, u.token, { name: 'F2' });
    expect((await h.call('POST', '/api/funnels/bulk-tag', { token: u.token, body: { funnelIds: [f1.id, f2.id], addTagIds: [t1.id, t2.id] } })).json.updated).toBe(2);
    expect((await h.call('POST', '/api/funnels/bulk-tag', { token: u.token, body: { funnelIds: [f1.id], removeTagIds: [t2.id] } })).status).toBe(200);
    expect((await h.call('GET', `/api/funnels/${f1.id}`, { token: u.token })).json.tags.map((t: any) => t.name)).toEqual(['One']);
    expect((await h.call('DELETE', `/api/tags?ids=${t1.id},missing`, { token: u.token })).status).toBe(404);
    expect((await h.call('GET', '/api/tags', { token: u.token })).json.data).toHaveLength(2);
    expect((await h.call('DELETE', `/api/tags?ids=${t1.id},${t2.id}`, { token: u.token })).json.deleted).toBe(2);
    expect((await h.call('POST', '/api/funnels/bulk-tag', { token: u.token, body: { funnelIds: ['nope'], addTagIds: [] } })).status).toBe(404);
  });
});
