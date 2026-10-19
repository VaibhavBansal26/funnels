import { describe, expect, it } from 'vitest';
import { createBuilder, parseDocument, renderPage, collectBlocks } from '../src/blocks/index.js';
import { isValidPath } from '../src/services/paths.js';
import { CATEGORIES, SEED_TEMPLATES, seedTemplates } from '../src/templates/seed.js';
import { makeFunnel, makeHarness, type Harness } from './helpers.js';
import { columnNames } from './support/schema.js';

describe('seeded templates', () => {
  it('ships at least six distinct, valid, renderable templates covering the required use cases', () => {
    expect(SEED_TEMPLATES.length).toBeGreaterThanOrEqual(6);
    expect(new Set(SEED_TEMPLATES.map((t) => t.slug)).size).toBe(SEED_TEMPLATES.length);
    for (const slug of ['lead-magnet', 'webinar-registration', 'product-launch', 'sales-page-bump-upsell', 'thank-you-page', 'book-a-call']) expect(SEED_TEMPLATES.map((t) => t.slug)).toContain(slug);
    for (const t of SEED_TEMPLATES) {
      expect(CATEGORIES.map((c) => c.slug)).toContain(t.category);
      expect(t.steps.length).toBeGreaterThan(0);
      expect(new Set(t.steps.map((s) => s.path)).size).toBe(t.steps.length);
      for (const [i, s] of t.steps.entries()) {
        expect(isValidPath(s.path), `${t.slug} path ${s.path}`).toBe(true);
        const parsed = parseDocument(s.doc);
        expect(parsed.ok, `${t.slug}/${s.name}: ${JSON.stringify(parsed.ok ? '' : parsed.issues)}`).toBe(true);
        const html = renderPage(s.doc, { funnelId: 'f', stepId: `s${i}`, stepName: s.name, steps: t.steps.map((x, j) => ({ id: `s${j}`, href: x.path })) });
        expect(html).toContain('<h1');
        expect(html).not.toContain('unsupported block');
        expect(html).not.toContain('limit reached');
      }
    }
  });

  it('the sales template contains an offer with order bump plus a one-click upsell; the launch one a fixed countdown', () => {
    const sales = SEED_TEMPLATES.find((t) => t.slug === 'sales-page-bump-upsell')!;
    const kinds = sales.steps.flatMap((s) => collectBlocks(s.doc.blocks).filter((b) => b.type === 'checkout')) as { orderBump: boolean; oneClickUpsell: boolean }[];
    expect(kinds.some((c) => c.orderBump)).toBe(true);
    expect(kinds.some((c) => c.oneClickUpsell)).toBe(true);
    expect(kinds.some((c) => !c.orderBump && !c.oneClickUpsell)).toBe(true);
    const launch = SEED_TEMPLATES.find((t) => t.slug === 'product-launch')!;
    expect(launch.steps.flatMap((s) => collectBlocks(s.doc.blocks)).some((b) => b.type === 'countdown' && b.mode === 'fixed')).toBe(true);
  });

  it('seeding is idempotent and templates are workspace-less rows in their own tables', async () => {
    const h = await makeHarness();
    expect((await seedTemplates(h.deps.db)).inserted).toBe(0);
    const cols = await columnNames(h.deps.db, 'templates');
    expect(cols).not.toContain('workspace_id');
    expect(await h.deps.db.get('SELECT COUNT(*) AS n FROM funnels')).toEqual({ n: 0 });
    await h.deps.db.run(`UPDATE templates SET name = 'Edited by admin' WHERE slug = 'lead-magnet'`);
    await seedTemplates(h.deps.db);
    expect(await h.deps.db.get('SELECT name FROM templates WHERE slug = ?', 'lead-magnet')).toEqual({ name: 'Edited by admin' });
  });
});

describe('templates API', () => {
  it('lists, filters by category and search, and shows details with step documents', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const all = (await h.call('GET', '/api/templates', { token: u.token })).json.data;
    expect(all.length).toBe(SEED_TEMPLATES.length);
    expect(all[0]).toHaveProperty('heading');
    const cats = (await h.call('GET', '/api/templates/categories', { token: u.token })).json.data;
    expect(cats.map((c: any) => c.slug)).toEqual(CATEGORIES.map((c) => c.slug));
    expect(cats.reduce((n: number, c: any) => n + c.templateCount, 0)).toBe(SEED_TEMPLATES.length);
    const sales = (await h.call('GET', '/api/templates?category=sales', { token: u.token })).json.data;
    expect(sales.map((t: any) => t.slug).sort()).toEqual(['product-launch', 'sales-page-bump-upsell']);
    expect((await h.call('GET', `/api/templates?category=${cats[0].id}`, { token: u.token })).json.data.length).toBeGreaterThan(0);
    expect((await h.call('GET', '/api/templates?search=webinar', { token: u.token })).json.data).toHaveLength(1);
    expect((await h.call('GET', '/api/templates?search=%25', { token: u.token })).json.data).toHaveLength(0);
    const detail = (await h.call('GET', '/api/templates/book-a-call', { token: u.token })).json;
    expect(detail.steps).toHaveLength(2);
    expect(detail.steps[0].doc.version).toBe(1);
    expect((await h.call('GET', '/api/templates/nope', { token: u.token })).status).toBe(404);
    expect((await h.call('GET', '/api/templates')).status).toBe(401);
  });

  it('"use template" clones into the caller workspace, allows multiples with unique names, and is independent of the template', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    const use = (token: string) => h.call('POST', '/api/templates/lead-magnet/use', { token });
    const first = (await use(a.token)).json;
    const second = (await use(a.token)).json;
    const third = (await use(a.token)).json;
    expect([first.name, second.name, third.name]).toEqual(['Lead magnet', 'Lead magnet 2', 'Lead magnet 3']);
    expect(first).toMatchObject({ status: 'test', domain: null, stepCount: 2 });
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(first.steps[0].id).not.toBe(second.steps[0].id);
    expect((await use(b.token)).json.name).toBe('Lead magnet'); // names are unique per workspace only
    const page = (await h.call('GET', `/api/funnels/${first.id}/steps/${first.steps[0].id}/page`, { token: a.token })).json;
    await h.call('PUT', `/api/funnels/${first.id}/steps/${first.steps[0].id}/page`, { token: a.token, body: { doc: { version: 1, blocks: [] } } });
    expect(page.doc.blocks.length).toBeGreaterThan(0);
    const fresh = (await h.call('GET', '/api/templates/lead-magnet', { token: a.token })).json;
    expect(fresh.steps[0].doc.blocks.length).toBeGreaterThan(0); // template untouched
    expect(first.steps[0].path).toBe('/free-guide');
    expect((await h.call('POST', '/api/templates/nope/use', { token: a.token })).status).toBe(404);
    expect((await h.call('GET', '/api/funnels', { token: b.token })).json.data).toHaveLength(1);
  });
});

describe('template administration (PLATFORM_ADMIN_EMAILS)', () => {
  it('is closed by default: nobody is a platform admin, whatever the host or role', async () => {
    const h = await makeHarness();
    const owner = await h.register('boss@dashclicks.com');
    const f = await makeFunnel(h, owner.token);
    for (const host of ['app.dashclicks.com', 'localhost', 'app.funnels.test']) {
      const r = await h.call('POST', '/api/admin/templates', { token: owner.token, body: { funnelId: f.id, name: 'T' }, headers: { host } });
      expect(r.status).toBe(403);
    }
    expect((await h.call('POST', '/api/admin/template-categories', { token: owner.token, body: { name: 'New' } })).status).toBe(403);
    expect((await h.call('DELETE', '/api/admin/templates/lead-magnet', { token: owner.token })).status).toBe(403);
  });

  it('allows only listed emails (case-insensitive) to create, edit and delete templates and categories', async () => {
    const h = await makeHarness({ env: { PLATFORM_ADMIN_EMAILS: 'Admin@Platform.test, other@platform.test' } });
    const admin = await h.register('admin@platform.test');
    const nobody = await h.register('nobody@platform.test');
    const adminFunnel = await makeFunnel(h, admin.token, { name: 'Gold standard' });
    const nobodyFunnel = await makeFunnel(h, nobody.token);
    expect((await h.call('POST', '/api/admin/templates', { token: nobody.token, body: { funnelId: nobodyFunnel.id, name: 'Nope' } })).status).toBe(403);

    const cat = (await h.call('POST', '/api/admin/template-categories', { token: admin.token, body: { name: 'Black Friday' } })).json;
    expect(cat).toMatchObject({ name: 'Black Friday', slug: 'black-friday' });
    expect((await h.call('POST', '/api/admin/template-categories', { token: admin.token, body: { name: 'black friday' } })).json.error.code).toBe('CATEGORY_EXISTS');

    const created = await h.call('POST', '/api/admin/templates', { token: admin.token, body: { funnelId: adminFunnel.id, name: 'Gold standard', description: 'Best one', categoryId: cat.id } });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ slug: 'gold-standard', categoryName: 'Black Friday', stepCount: 1 });
    const again = (await h.call('POST', '/api/admin/templates', { token: admin.token, body: { funnelId: adminFunnel.id, name: 'Gold standard' } })).json;
    expect(again.slug).toBe('gold-standard-2');
    // every user can now see and use it
    expect((await h.call('GET', '/api/templates?category=black-friday', { token: nobody.token })).json.data).toHaveLength(1);
    expect((await h.call('POST', `/api/templates/${created.json.id}/use`, { token: nobody.token })).status).toBe(201);
    // another tenant's funnel cannot be published as a template
    expect((await h.call('POST', '/api/admin/templates', { token: admin.token, body: { funnelId: nobodyFunnel.id, name: 'Steal' } })).status).toBe(404);

    const patched = (await h.call('PATCH', `/api/admin/templates/${created.json.id}`, { token: admin.token, body: { name: 'Renamed', categoryId: null } })).json;
    expect(patched).toMatchObject({ name: 'Renamed', categoryId: null });
    expect((await h.call('PATCH', `/api/admin/templates/${created.json.id}`, { token: admin.token, body: { categoryId: 'missing' } })).status).toBe(404);
    expect((await h.call('PATCH', `/api/admin/templates/${created.json.id}`, { token: nobody.token, body: { name: 'x' } })).status).toBe(403);
    expect((await h.call('DELETE', `/api/admin/templates/${created.json.id}`, { token: nobody.token })).status).toBe(403);
    expect((await h.call('DELETE', `/api/admin/templates/${created.json.id}`, { token: admin.token })).status).toBe(204);
    expect((await h.call('GET', `/api/templates/${created.json.id}`, { token: admin.token })).status).toBe(404);
    expect((await h.call('DELETE', `/api/admin/template-categories/${cat.id}`, { token: nobody.token })).status).toBe(403);
    expect((await h.call('DELETE', `/api/admin/template-categories/${cat.id}`, { token: admin.token })).status).toBe(204);
    expect(await h.deps.db.get('SELECT category_id FROM templates WHERE id = ?', again.id)).toEqual({ category_id: null });
  });
});

describe('saved custom blocks', () => {
  const block = createBuilder('c').heading('Reusable headline', { level: 1 });

  it('saves, lists and deletes per workspace', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    const saved = await h.call('POST', '/api/blocks', { token: a.token, body: { name: 'Hero heading', block } });
    expect(saved.status).toBe(201);
    expect(saved.json.block).toMatchObject({ type: 'heading', text: 'Reusable headline' });
    expect((await h.call('GET', '/api/blocks', { token: a.token })).json.data).toHaveLength(1);
    expect((await h.call('GET', '/api/blocks', { token: b.token })).json.data).toHaveLength(0);
    expect((await h.call('DELETE', `/api/blocks/${saved.json.id}`, { token: b.token })).status).toBe(404);
    expect((await h.call('DELETE', `/api/blocks/${saved.json.id}`, { token: a.token })).status).toBe(204);
    expect((await h.call('GET', '/api/blocks', { token: a.token })).json.data).toHaveLength(0);
  });

  it('validates blocks with the same schema as pages', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const save = (body: object) => h.call('POST', '/api/blocks', { token: u.token, body });
    expect((await save({ name: 'x', block: { id: 'a', type: 'button', text: 'x', action: { type: 'link', url: 'javascript:alert(1)' } } })).json.error.code).toBe('INVALID_BLOCK');
    expect((await save({ name: 'x', block: { id: 'a', type: 'nope' } })).status).toBe(400);
    expect((await save({ name: '', block })).status).toBe(400);
    expect((await save({ name: 'x' })).status).toBe(400);
    expect((await save({ name: 'x', block: { ...block, extra: '<script>' } })).json.block).not.toHaveProperty('extra');
  });

  it('caps the number of saved blocks per workspace', async () => {
    const h = await makeHarness();
    const u = await h.register();
    for (let i = 0; i < 200; i++) await h.deps.db.run('INSERT INTO custom_blocks (id, workspace_id, name, block_json, created_at) VALUES (?, ?, ?, ?, ?)', `blk_${i}`, u.wsId, 'b', JSON.stringify(block), '2026-01-01T00:00:00Z');
    const r = await h.call('POST', '/api/blocks', { token: u.token, body: { name: 'one too many', block } });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('LIMIT_REACHED');
  });
});
