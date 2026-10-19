import { describe, expect, it } from 'vitest';
import { copyPath, isValidPath, pathKey, slugPath, suggestPaths } from '../src/services/paths.js';
import { activeDomain, makeFunnel, makeHarness, type Harness } from './helpers.js';

describe('path regex', () => {
  const accept = ['/', '/a', '/offer-1', '/a/', '/Offer', '/%20x', '/abc-def-123', '/a1', '/x!', '/%E2%82%AC'];
  const reject = ['', 'a', 'offer', '/a/b', '/a.html', '/a b', '//', '/a//', '/.', '/a?x=1', '/a#b', '/..', '/a/.', ' /a', '/a\n', '/a?', '/a#', '/a\\', '/a\u0000', '/' + 'a'.repeat(250)];
  it.each(accept)('accepts %j', (p) => expect(isValidPath(p)).toBe(true));
  it.each(reject)('rejects %j', (p) => expect(isValidPath(p)).toBe(false));
  it('rejects non-strings', () => {
    for (const v of [null, undefined, 5, {}, []]) expect(isValidPath(v)).toBe(false);
  });
  it('normalises keys case-insensitively and ignores trailing slashes', () => {
    expect(pathKey('/Offer/')).toBe('/offer');
    expect(pathKey('/')).toBe('/');
  });
  it('slugs names into valid paths', () => {
    for (const n of ['Spring Sale!', 'Ünïcode  Name', '   ', '日本語', 'a'.repeat(100)]) expect(isValidPath(slugPath(n))).toBe(true);
    expect(slugPath('Spring Sale!')).toBe('/spring-sale');
  });
  it('suggests /path-NNNN skipping taken ones', () => {
    const s = suggestPaths('/offer', new Set(['/offer-1001']), 3);
    expect(s).toEqual(['/offer-1002', '/offer-1003', '/offer-1004']);
    expect(suggestPaths('/', new Set())[0]).toBe('/page-1001');
    expect(suggestPaths('/a/', new Set())[0]).toBe('/a-1001');
    for (const p of suggestPaths('/offer', new Set())) expect(isValidPath(p)).toBe(true);
    expect(copyPath('/offer', new Set(['/offer-copy']))).toBe('/offer-copy-2');
  });
});

describe('steps', () => {
  it('creates, updates, duplicates and deletes steps with contiguous positions', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Flow' });
    const base = `/api/funnels/${f.id}/steps`;
    const b = (await h.call('POST', base, { token: u.token, body: { name: 'Offer page' } })).json;
    const c = (await h.call('POST', base, { token: u.token, body: { name: 'Thanks', base_path: '/thanks' } })).json;
    expect([b.position, c.position]).toEqual([2, 3]);
    expect(b.path).toBe('/offer-page');

    const upd = (await h.call('PATCH', `${base}/${b.id}`, { token: u.token, body: { name: 'Offer', title: 'Buy now', seo_description: 'Great offer', custom_css: 'h1{color:red}' } })).json;
    expect(upd).toMatchObject({ name: 'Offer', title: 'Buy now', seoDescription: 'Great offer', customCss: 'h1{color:red}' });

    const dup = (await h.call('POST', `${base}/${b.id}/duplicate`, { token: u.token })).json;
    expect(dup).toMatchObject({ name: 'Offer copy', path: '/offer-page-copy', position: 4, title: 'Buy now' });
    const dup2 = (await h.call('POST', `${base}/${b.id}/duplicate`, { token: u.token })).json;
    expect(dup2).toMatchObject({ name: 'Offer copy 2', path: '/offer-page-copy-2' });

    expect((await h.call('DELETE', `${base}/${b.id}`, { token: u.token })).status).toBe(204);
    const list = (await h.call('GET', base, { token: u.token })).json.data;
    expect(list.map((s: any) => s.position)).toEqual([1, 2, 3, 4]);
    expect(list.map((s: any) => s.name)).toEqual(['Landing page', 'Thanks', 'Offer copy', 'Offer copy 2']);
  });

  it('the page content of a new step renders into the cached html with the settings', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    const s = f.steps[0];
    await h.call('PATCH', `/api/funnels/${f.id}/steps/${s.id}`, { token: u.token, body: { title: 'My Title', seo_description: 'Desc' } });
    const html = (await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', s.id))!.html;
    expect(html).toContain('<title>My Title</title>');
    expect(html).toContain('content="Desc"');
  });

  it('refuses to delete the last step', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token);
    expect((await h.call('DELETE', `/api/funnels/${f.id}/steps/${f.steps[0].id}`, { token: u.token })).json.error.code).toBe('LAST_STEP');
  });

  it('only admins edit step tracking code', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const member = await h.member(owner, 'member');
    const f = await makeFunnel(h, owner.token);
    const url = `/api/funnels/${f.id}/steps/${f.steps[0].id}`;
    expect((await h.call('PATCH', url, { token: member.token, body: { header_tracking_code: '<script>1</script>' } })).status).toBe(403);
    expect((await h.call('PATCH', url, { token: member.token, body: { title: 'ok' } })).status).toBe(200);
  });

  it('tracking code is only injected when the workspace allows custom scripts', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const f = await makeFunnel(h, owner.token);
    await h.call('PATCH', `/api/funnels/${f.id}/steps/${f.steps[0].id}`, { token: owner.token, body: { header_tracking_code: '<script>HEADCODE</script>' } });
    const html = async () => (await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', f.steps[0].id))!.html;
    expect(await html()).not.toContain('HEADCODE');
    await h.call('PATCH', '/api/workspace', { token: owner.token, body: { allowCustomScripts: true } });
    expect(await html()).toContain('HEADCODE');
    await h.call('PATCH', '/api/workspace', { token: owner.token, body: { allowCustomScripts: false } });
    expect(await html()).not.toContain('HEADCODE');
  });
});

describe('path uniqueness', () => {
  it('within a funnel: create, update and duplicate collide with suggestions (case/trailing slash insensitive)', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'Flow', base_path: '/start' });
    const base = `/api/funnels/${f.id}/steps`;
    for (const path of ['/start', '/START', '/start/']) {
      const r = await h.call('POST', base, { token: u.token, body: { name: 'dup', base_path: path } });
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('STEP_PATH_EXISTS');
      expect(r.json.error.details.uniquePaths[0]).toBe(`${path.replace(/\/$/, '')}-1001`);
    }
    const s2 = (await h.call('POST', base, { token: u.token, body: { name: 'two', base_path: '/two' } })).json;
    expect((await h.call('PATCH', `${base}/${s2.id}`, { token: u.token, body: { base_path: '/Start' } })).status).toBe(409);
    expect((await h.call('PATCH', `${base}/${s2.id}`, { token: u.token, body: { base_path: '/Two' } })).status).toBe(200); // only case changes: own path
    expect((await h.call('PATCH', `${base}/${s2.id}`, { token: u.token, body: { base_path: 'bad' } })).json.error.code).toBe('INVALID_PATH');
  });

  it('across a domain: other funnels block create/update/duplicate and validate-path reports them', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const a = await makeFunnel(h, u.token, { name: 'A', base_path: '/promo' });
    await h.call('PATCH', `/api/funnels/${a.id}`, { token: u.token, body: { domain_id: dom } });
    const b = await makeFunnel(h, u.token, { name: 'B', base_path: '/other' });
    // while B is off the domain, nothing collides
    expect((await h.call('POST', `/api/funnels/${b.id}/steps`, { token: u.token, body: { name: 'x', base_path: '/promo' } })).status).toBe(201);
    await h.call('DELETE', `/api/funnels/${b.id}/steps/${(await h.call('GET', `/api/funnels/${b.id}/steps`, { token: u.token })).json.data[1].id}`, { token: u.token });
    const c = await makeFunnel(h, u.token, { name: 'C', base_path: '/c', domain_id: dom });
    const r = await h.call('POST', `/api/funnels/${c.id}/steps`, { token: u.token, body: { name: 'x', base_path: '/PROMO' } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('PATH_CONFLICT');
    expect(r.json.error.details.uniquePaths).toEqual(['/PROMO-1001', '/PROMO-1002', '/PROMO-1003']);

    const v = (body: object) => h.call('POST', '/api/funnels/validate-path', { token: u.token, body });
    expect((await v({ path: '/free', domainId: dom })).json).toEqual({ success: true });
    const bad = (await v({ path: '/promo/', domainId: dom, funnelId: c.id })).json;
    expect(bad).toMatchObject({ success: false, reason: 'PATH_CONFLICT', conflicts: [{ scope: 'domain', funnelName: 'A' }] });
    expect(bad.uniquePaths[0]).toBe('/promo/-1001'.replace('/-', '-'));
    expect((await v({ path: '/promo', domainId: dom, funnelId: a.id, stepId: a.steps[0].id })).json.success).toBe(true); // a step may keep its own path
    expect((await v({ path: '/c', funnelId: c.id })).json).toMatchObject({ success: false, conflicts: [{ scope: 'funnel' }] });
    expect((await v({ path: '/c', funnelId: c.id, stepId: c.steps[0].id })).json.success).toBe(true);
    expect((await v({ path: 'nope' })).json).toMatchObject({ success: false, reason: 'INVALID_PATH' });
    expect((await v({ path: '/x', domainId: 'missing' })).status).toBe(404);
    expect((await v({ path: '/x', funnelId: 'missing' })).status).toBe(404);
  });

  it('duplicating a step on a domain picks a path free on the whole domain', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const a = await makeFunnel(h, u.token, { name: 'A', base_path: '/a' });
    await h.call('PATCH', `/api/funnels/${a.id}`, { token: u.token, body: { domain_id: dom } });
    const b = await makeFunnel(h, u.token, { name: 'B', base_path: '/b' });
    await h.call('POST', `/api/funnels/${b.id}/steps`, { token: u.token, body: { name: 'x', base_path: '/b-copy' } });
    await h.call('PATCH', `/api/funnels/${b.id}`, { token: u.token, body: { domain_id: dom } });
    const dup = (await h.call('POST', `/api/funnels/${b.id}/steps/${b.steps[0].id}/duplicate`, { token: u.token })).json;
    expect(dup.path).toBe('/b-copy-2');
  });
});

describe('conflict resolution on domain attach', () => {
  async function setup() {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const a = await makeFunnel(h, u.token, { name: 'A', base_path: '/promo' });
    await h.call('POST', `/api/funnels/${a.id}/steps`, { token: u.token, body: { name: 'A2', base_path: '/thanks' } });
    await h.call('PATCH', `/api/funnels/${a.id}`, { token: u.token, body: { domain_id: dom } });
    const b = await makeFunnel(h, u.token, { name: 'B', base_path: '/promo' });
    await h.call('POST', `/api/funnels/${b.id}/steps`, { token: u.token, body: { name: 'B2', base_path: '/thanks' } });
    await h.call('POST', `/api/funnels/${b.id}/steps`, { token: u.token, body: { name: 'B3', base_path: '/unique' } });
    const attach = (conflicts?: object[]) => h.call('PATCH', `/api/funnels/${b.id}`, { token: u.token, body: { domain_id: dom, ...(conflicts ? { conflicts } : {}) } });
    const paths = async () => (await h.call('GET', `/api/funnels/${b.id}`, { token: u.token })).json;
    return { h, u, dom, a, b, attach, paths };
  }

  it('returns the conflicts with suggestions and changes nothing when unresolved', async () => {
    const { attach, paths } = await setup();
    const r = await attach();
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('PATH_CONFLICT');
    expect(r.json.error.details.conflicts.map((c: any) => [c.path, c.resolved_path])).toEqual([['/promo', '/promo-1001'], ['/thanks', '/thanks-1001']]);
    const f = await paths();
    expect(f.domain).toBeNull();
    expect(f.steps.map((s: any) => s.path)).toEqual(['/promo', '/thanks', '/unique']);
  });

  it('applies a valid resolution (subset of server conflicts, covering all) in one go, including the funnel base path', async () => {
    const { attach, paths } = await setup();
    const r = await attach([{ path: '/promo', resolved_path: '/promo-2' }, { path: '/THANKS', resolved_path: '/thanks-2' }]);
    expect(r.status).toBe(200);
    expect(r.json.basePath).toBe('/promo-2');
    expect((await paths()).steps.map((s: any) => s.path)).toEqual(['/promo-2', '/thanks-2', '/unique']);
  });

  it('rejects resolutions that are not a subset of the real conflicts', async () => {
    const { attach, paths } = await setup();
    const code = async (c: object[]) => (await attach(c)).json.error.code;
    expect(await code([{ path: '/unique', resolved_path: '/u2' }])).toBe('ROUTES_MISMATCH'); // not a conflict
    expect(await code([{ path: '/promo', resolved_path: '/p2' }, { path: '/promo', resolved_path: '/p3' }])).toBe('ROUTES_MISMATCH'); // duplicate entry
    expect(await code([{ path: '/promo', resolved_path: '/p2' }, { path: '/thanks', resolved_path: '/t2' }, { path: '/extra', resolved_path: '/e2' }])).toBe('ROUTES_COUNT_MISMATCH');
    expect(await code([{ path: '/promo', resolved_path: '/p2' }])).toBe('PATH_CONFLICT_UNRESOLVED'); // partial
    expect((await paths()).domain).toBeNull();
  });

  it('rejects invalid or colliding replacement paths', async () => {
    const { attach } = await setup();
    const code = async (resolvedA: string, resolvedB = '/t2') => (await attach([{ path: '/promo', resolved_path: resolvedA }, { path: '/thanks', resolved_path: resolvedB }])).json.error.code;
    expect(await code('bad path')).toBe('INVALID_RESOLVED_PATH');
    expect(await code('/promo')).toBe('INVALID_RESOLVED_PATH'); // still taken on the domain
    expect(await code('/unique')).toBe('INVALID_RESOLVED_PATH'); // collides with own other step
    expect(await code('/same', '/same')).toBe('INVALID_RESOLVED_PATH'); // two replacements collide
  });

  it('creating a funnel straight onto a domain uses the same resolution', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const dom = await activeDomain(h, u.token);
    const a = await makeFunnel(h, u.token, { name: 'A', base_path: '/promo', domain_id: dom });
    expect(a.domain.id).toBe(dom);
    const clash = await h.call('POST', '/api/funnels', { token: u.token, body: { name: 'B', base_path: '/promo', domain_id: dom } });
    expect(clash.status).toBe(409);
    expect(clash.json.error.details.conflicts[0]).toMatchObject({ path: '/promo', resolved_path: '/promo-1001' });
    const ok = await h.call('POST', '/api/funnels', { token: u.token, body: { name: 'B', base_path: '/promo', domain_id: dom, conflicts: [{ path: '/promo', resolved_path: '/promo-1001' }] } });
    expect(ok.status).toBe(201);
    expect(ok.json.steps[0].path).toBe('/promo-1001');
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM funnels')).toEqual({ n: 2 }); // the failed attempt left nothing behind
  });
});

describe('reorder', () => {
  async function setup() {
    const h = await makeHarness();
    const u = await h.register();
    const f = await makeFunnel(h, u.token, { name: 'R' });
    const base = `/api/funnels/${f.id}/steps`;
    const s = [f.steps[0]];
    for (const n of ['B', 'C', 'D']) s.push((await h.call('POST', base, { token: u.token, body: { name: n } })).json);
    const put = (orders: unknown) => h.call('PUT', `${base}/order`, { token: u.token, body: { orders } });
    const names = async () => (await h.call('GET', base, { token: u.token })).json.data.map((x: any) => `${x.position}:${x.name}`);
    return { h, u, f, s, put, names };
  }

  it('applies a full permutation and normalises gaps to 1..n', async () => {
    const { s, put, names } = await setup();
    const r = await put([{ stepId: s[0].id, order: 40 }, { stepId: s[1].id, order: 10 }, { stepId: s[2].id, order: 30 }, { stepId: s[3].id, order: 20 }]);
    expect(r.status).toBe(200);
    expect(r.json.data.map((x: any) => x.position)).toEqual([1, 2, 3, 4]);
    expect(await names()).toEqual(['1:B', '2:D', '3:C', '4:Landing page']);
  });

  it('validation matrix', async () => {
    const { h, u, s, put, names } = await setup();
    const o = (i: number, order: number) => ({ stepId: s[i].id, order });
    const before = await names();
    const cases: [string, unknown, string][] = [
      ['duplicate ids', [o(0, 1), o(0, 2), o(2, 3), o(3, 4)], 'DUPLICATE_STEP'],
      ['duplicate orders', [o(0, 1), o(1, 1), o(2, 3), o(3, 4)], 'DUPLICATE_ORDER'],
      ['partial set', [o(0, 1), o(1, 2)], 'INCOMPLETE_ORDER'],
      ['unknown id', [o(0, 1), o(1, 2), o(2, 3), { stepId: 'nope', order: 4 }], 'INVALID_STEP_REFERENCE'],
      ['unknown id on partial', [{ stepId: 'nope', order: 1 }], 'INVALID_STEP_REFERENCE'],
    ];
    for (const [label, body, code] of cases) {
      const r = await put(body);
      expect([label, r.status, r.json.error.code]).toEqual([label, 400, code]);
    }
    for (const bad of [[], [o(0, 0), o(1, 2), o(2, 3), o(3, 4)], [o(0, -1), o(1, 2), o(2, 3), o(3, 4)], [o(0, 1.5), o(1, 2), o(2, 3), o(3, 4)], [{ stepId: s[0].id }], 'x']) {
      expect((await put(bad)).status).toBe(400);
    }
    expect(await names()).toEqual(before);
    // a step from another funnel of the same workspace is rejected too
    const other = await makeFunnel(h, u.token, { name: 'Other' });
    const r = await put([o(0, 1), o(1, 2), o(2, 3), { stepId: other.steps[0].id, order: 4 }]);
    expect(r.json.error.code).toBe('INVALID_STEP_REFERENCE');
  });

  it('re-renders next-step links after reordering', async () => {
    const { h, s, put } = await setup();
    const html = async (i: number) => (await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', s[i].id))!.html;
    expect(await html(0)).toContain('href="/b">Continue');
    await put([{ stepId: s[0].id, order: 2 }, { stepId: s[1].id, order: 1 }, { stepId: s[2].id, order: 3 }, { stepId: s[3].id, order: 4 }]);
    expect(await html(0)).toContain('href="/c">Continue');
  });
});
