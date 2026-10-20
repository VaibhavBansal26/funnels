import { describe, expect, it } from 'vitest';
import { createBuilder, documentOf, field } from '../src/blocks/index.js';
import { migrateLegacyPages } from '../src/services/pagemigration.js';
import { seedTemplates } from '../src/templates/seed.js';
import { createPageBuilder } from '../src/pagemodel/shared/build.js';
import { headingText, makeFunnel, makeHarness, type Harness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };

async function setup() {
  const h = await makeHarness();
  const u = await h.register();
  const f = await makeFunnel(h, u.token);
  const stepId = f.steps[0].id as string;
  const url = `/api/funnels/${f.id}/steps/${stepId}`;
  const put = (body: unknown) => h.call('PUT', `${url}/page`, { token: u.token, body });
  const get = async () => (await h.call('GET', `${url}/page`, { token: u.token })).json;
  const project = (build: (pm: ReturnType<typeof createPageBuilder>) => any[]) => {
    const pm = createPageBuilder('t');
    return pm.project(build(pm));
  };
  return { h, u, f, stepId, url, put, get, project };
}

describe('page save: the server is the authority', () => {
  it('stores a version 2 document, derives forms and products itself and renders the published html from the project only', async () => {
    const { h, put, get, stepId, project } = await setup();
    const p = project((pm) => [pm.section([pm.stack([
      pm.heading('Hello', { level: 1 }),
      pm.form('lead', { fields: [field('email', 'email', 'Email', true)], submitLabel: 'Go' }),
      pm.checkout('buy', { productName: 'Thing', price: 10, currency: 'USD' }),
    ])])]);
    const r = await put({ doc: { version: 2, project: p } });
    expect(r.status).toBe(200);
    const page = await get();
    expect(page.format).toBe('grapesjs');
    expect(page.doc.version).toBe(2);
    expect(page.doc.forms.map((f: any) => f.id)).toEqual(['lead']);
    expect(page.doc.products).toMatchObject([{ id: 'buy', price: 10, currency: 'USD', productName: 'Thing' }]);
    const row = (await h.deps.db.get<{ html: string; checksum: string }>('SELECT html, checksum FROM step_pages WHERE step_id = ?', stepId))!;
    expect(row.html).toContain('$10.00');
    expect(row.html).toContain('data-fn-form');
    expect(row.checksum).toBe(r.json.checksum);
  });

  it('ignores client supplied html, css, forms and products (a tampered price or action never reaches a buyer)', async () => {
    const { h, put, get, stepId, project, f } = await setup();
    const p = project((pm) => [pm.section([pm.stack([pm.heading('H', { level: 1 }), pm.checkout('buy', { productName: 'Thing', price: 99 })])])]);
    const evil = {
      version: 2,
      project: p,
      html: '<script>steal()</script><form action="https://evil.example"></form>',
      css: 'body{background:url(javascript:alert(1))}',
      forms: [{ id: 'x', type: 'form', fields: [], submitLabel: 'x' }],
      products: [{ id: 'buy', type: 'checkout', productName: 'Thing', price: 0.01, currency: 'USD', orderBump: false, oneClickUpsell: false, buttonLabel: 'x', success: { type: 'next_step' } }],
    };
    expect((await put({ doc: evil, html: '<script>steal()</script>', css: 'x{}', products: [] })).status).toBe(200);
    const page = await get();
    expect(page.doc.products[0].price).toBe(99);
    expect(page.doc.forms).toHaveLength(0);
    const html = (await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', stepId))!.html;
    expect(html).toContain('$99.00');
    expect(html).not.toMatch(/steal|evil\.example|\$0\.01/);
    // and the purchase itself is priced from the stored definition, whatever the buyer's request says
    const r = await h.call('POST', `/api/public/checkout/${f.id}/${stepId}/buy`, { body: { email: 'b@example.com', amountCents: 1, price: 0.01, productName: 'free' }, headers: UA });
    expect(r.status).toBe(200);
    expect(r.json.orders.map((o: any) => [o.productName, o.amountCents])).toEqual([['Thing', 9900]]);
  });

  it('editing a price in the editor changes what buyers pay only after a save (and is audited by the backup)', async () => {
    const { h, put, project, f, stepId, url, u } = await setup();
    const doc = (price: number) => ({ version: 2, project: project((pm) => [pm.section([pm.stack([pm.heading('H'), pm.checkout('buy', { productName: 'Thing', price })])])]) });
    await put({ doc: doc(20) });
    await put({ doc: doc(30) });
    const buy = () => h.call('POST', `/api/public/checkout/${f.id}/${stepId}/buy`, { body: { email: `b${Math.random()}@example.com` }, headers: UA });
    expect((await buy()).json.orders[0].amountCents).toBe(3000);
    const backups = (await h.call('GET', `${url}/backups`, { token: u.token })).json.data;
    const old = (await h.call('GET', `${url}/backups/${backups[0].id}`, { token: u.token })).json;
    expect(old.doc.products[0].price).toBe(20);
  });

  it('validation errors name the offending component and nothing is stored', async () => {
    const { put, project, get } = await setup();
    const before = await get();
    const bad = project((pm) => [pm.section([pm.stack([pm.video('https://evil.example/x', 'v')])])]);
    const r = await put({ doc: { version: 2, project: bad } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('INVALID_DOCUMENT');
    expect(JSON.stringify(r.json.error.details)).toMatch(/YouTube, Vimeo/);
    expect((await get()).checksum).toBe(before.checksum);
    const noEmail = project((pm) => [pm.section([pm.stack([pm.form('f', { fields: [field('name', 'name', 'Name')] })])])]);
    expect((await put({ doc: { version: 2, project: noEmail } })).status).toBe(400);
  });

  it('size limit: oversized projects are a 413', async () => {
    const { put, project } = await setup();
    const big = project((pm) => Array.from({ length: 230 }, () => pm.section([pm.stack([pm.text('x'.repeat(9_900))])])));
    expect((await put({ doc: { version: 2, project: big } })).status).toBe(413);
  });

  it('optimistic concurrency, backups (newest 10) and restore keep working for version 2 pages', async () => {
    const { h, u, put, get, url, project } = await setup();
    const doc = (t: string) => ({ version: 2, project: project((pm) => [pm.section([pm.stack([pm.heading(t, { level: 1 })])])]) });
    const first = await put({ doc: doc('one') });
    expect(first.status).toBe(200);
    expect((await put({ doc: doc('two'), version: first.json.version })).status).toBe(200);
    expect((await put({ doc: doc('stale'), version: first.json.version })).status).toBe(409);
    for (let i = 0; i < 12; i++) await put({ doc: doc(`v${i}`) });
    const list = (await h.call('GET', `${url}/backups`, { token: u.token })).json.data;
    expect(list).toHaveLength(10);
    const target = list[3];
    const was = headingText((await h.call('GET', `${url}/backups/${target.id}`, { token: u.token })).json.doc);
    await h.call('POST', `${url}/backups/${target.id}/restore`, { token: u.token });
    expect(headingText((await get()).doc)).toBe(was);
    expect((await h.call('GET', `${url}/backups`, { token: u.token })).json.data).toHaveLength(10); // restoring made a backup, pruning kept 10
  });

  it('autosave does not use history slots', async () => {
    const { h, u, put, url, project } = await setup();
    const doc = project((pm) => [pm.section([pm.stack([pm.heading('a')])])]);
    await put({ doc: { version: 2, project: doc }, backup: false });
    await put({ doc: { version: 2, project: doc }, backup: false });
    expect((await h.call('GET', `${url}/backups`, { token: u.token })).json.data).toHaveLength(0);
  });
});

describe('legacy documents open in the new builder', () => {
  const b = createBuilder('l');
  const legacy = documentOf([b.section([b.heading('Old page', { level: 1 }), b.form({ fields: [field('email', 'email', 'Email', true)] })], { background: '#0f172a' })]);

  it('a version 1 page is converted on first open, persisted, and its original is kept', async () => {
    const { h, get, stepId } = await setup();
    await h.deps.db.run('UPDATE step_pages SET doc_json = ?, legacy_doc_json = NULL WHERE step_id = ?', JSON.stringify(legacy), stepId);
    const page = await get();
    expect(page.doc.version).toBe(2);
    expect(headingText(page.doc)).toBe('Old page');
    expect(page.doc.forms).toHaveLength(1);
    const row = (await h.deps.db.get<{ doc_json: string; legacy_doc_json: string }>('SELECT doc_json, legacy_doc_json FROM step_pages WHERE step_id = ?', stepId))!;
    expect(row.doc_json).toMatch(/^\{"version":2/);
    expect(JSON.parse(row.legacy_doc_json)).toEqual(legacy);
    expect(JSON.stringify(await get())).toBe(JSON.stringify(page)); // converting again changes nothing
  });

  it('the startup migration converts every page and template step, re-renders published html and is idempotent', async () => {
    const { h, f, stepId } = await setup();
    await h.deps.db.run('UPDATE step_pages SET doc_json = ?, html = ?, checksum = ? WHERE step_id = ?', JSON.stringify(legacy), '<html>legacy</html>', 'old', stepId);
    await h.deps.db.run(`UPDATE template_steps SET doc_json = ? WHERE id = 'tpl_thank-you-page_1'`, JSON.stringify(legacy));
    const first = await migrateLegacyPages(h.deps);
    expect(first).toMatchObject({ pages: 1, templateSteps: 1, funnels: 1 });
    const row = (await h.deps.db.get<{ doc_json: string; html: string; legacy_doc_json: string }>('SELECT doc_json, html, legacy_doc_json FROM step_pages WHERE step_id = ?', stepId))!;
    expect(row.doc_json).toMatch(/^\{"version":2/);
    expect(row.html).toContain('fn-section');
    expect(row.html).not.toContain('legacy</html>');
    expect(row.legacy_doc_json).toContain('"blocks"');
    expect(await migrateLegacyPages(h.deps)).toEqual({ pages: 0, templateSteps: 0, funnels: 0 });
    expect((await h.deps.db.get<{ doc_json: string }>(`SELECT doc_json FROM template_steps WHERE id = 'tpl_thank-you-page_1'`))!.doc_json).toMatch(/^\{"version":2/);
    void f;
  });

  it('seeding upgrades a seeded template that is still stored as legacy blocks, and leaves everything else alone', async () => {
    const h = await makeHarness();
    await h.deps.db.run(`UPDATE template_steps SET doc_json = ? WHERE id = 'tpl_newsletter-signup_1'`, JSON.stringify(legacy));
    expect((await seedTemplates(h.deps.db)).upgraded).toBe(1);
    expect((await h.deps.db.get<{ doc_json: string }>(`SELECT doc_json FROM template_steps WHERE id = 'tpl_newsletter-signup_1'`))!.doc_json).toContain('The Friday Brief');
    expect((await seedTemplates(h.deps.db)).upgraded).toBe(0);
  });

  it('a legacy backup can be listed, read and restored (converted on the way)', async () => {
    const { h, u, stepId, url, put, get, project } = await setup();
    await put({ doc: { version: 2, project: project((pm) => [pm.section([pm.stack([pm.heading('Current')])])]) } });
    const bk = (await h.deps.db.get<{ id: string }>('SELECT id FROM step_backups WHERE step_id = ?', stepId))!;
    await h.deps.db.run('UPDATE step_backups SET doc_json = ? WHERE id = ?', JSON.stringify(legacy), bk.id);
    const read = (await h.call('GET', `${url}/backups/${bk.id}`, { token: u.token })).json;
    expect(read.doc.version).toBe(2);
    expect(headingText(read.doc)).toBe('Old page');
    expect((await h.call('POST', `${url}/backups/${bk.id}/restore`, { token: u.token })).status).toBe(200);
    expect(headingText((await get()).doc)).toBe('Old page');
  });

  it('the legacy API shape is still accepted on save (older clients, tools and the AI generator)', async () => {
    const { put, get } = await setup();
    expect((await put({ doc: legacy })).status).toBe(200);
    expect(headingText((await get()).doc)).toBe('Old page');
  });
});

describe('custom code permission', () => {
  const code = (html: string, js: string) => ({ version: 2, project: { styles: [], pages: [{ frames: [{ component: { type: 'wrapper', components: [{ type: 'fn-code', tagName: 'div', attributes: { id: 'k' }, fnCode: { html, css: '', js } }] } }] }] } });
  const published = async (h: Harness, stepId: string) => (await h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', stepId))!.html;

  it('scripts need the workspace flag AND an owner as the last saver; other users only ever publish sanitised code', async () => {
    const { h, u, put, url, stepId } = await setup();
    const admin = await h.member(u, 'admin');
    const putAs = (token: string, doc: unknown) => h.call('PUT', `${url}/page`, { token, body: { doc } });
    await put({ doc: code('<p onclick="x()">hi</p><script>RUN()</script>', 'RUN2()') });
    expect(await published(h, stepId)).not.toMatch(/RUN|onclick/); // flag off
    await h.call('PATCH', '/api/workspace', { token: u.token, body: { allowCustomScripts: true } });
    await putAs(admin.token, code('<script>ADMIN()</script>', 'ADMIN2()'));
    expect(await published(h, stepId)).not.toMatch(/ADMIN/); // admin may not author scripts
    expect(JSON.stringify((await h.call('GET', `${url}/page`, { token: u.token })).json.doc)).not.toContain('ADMIN2');
    await putAs(u.token, code('<script>OWNER()</script>', 'OWNER2()'));
    expect(await published(h, stepId)).toContain('<script>OWNER2()</script>');
    // an admin saving unrelated edits keeps the owner's code in the stored document but cannot keep it live
    await putAs(admin.token, code('<script>OWNER()</script>', 'OWNER2()'));
    expect(JSON.stringify((await h.call('GET', `${url}/page`, { token: u.token })).json.doc)).toContain('OWNER2');
    expect(await published(h, stepId)).not.toContain('OWNER2');
    await putAs(admin.token, code('<script>OWNER()</script>', 'EVIL()'));
    expect(JSON.stringify((await h.call('GET', `${url}/page`, { token: u.token })).json.doc)).not.toContain('EVIL');
  });
});

describe('preview and published pages', () => {
  it('previews are sandboxed (opaque origin) and published html contains no editor chrome', async () => {
    const { h, u, f, put, project } = await setup();
    await put({ doc: { version: 2, project: project((pm) => [pm.section([pm.stack([pm.heading('Published', { level: 1 })])])]) } });
    const token = (await h.call('POST', `/api/funnels/${f.id}/preview-token`, { token: u.token })).json.token as string;
    const r = await h.app.request(`/preview/${f.id}?token=${token}`, { headers: { host: 'app.funnels.test' } });
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/^sandbox /);
    expect(csp).not.toContain('allow-same-origin');
    const html = await r.text();
    expect(html).toContain('Published');
    expect(html).not.toMatch(/gjs-|data-gjs|grapesjs|contenteditable|fn-editor/);
  });
});
