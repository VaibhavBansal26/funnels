import { describe, expect, it } from 'vitest';
import { createBuilder, documentOf } from '../src/blocks/index.js';
import { MAX_BACKUPS } from '../src/services/pages.js';
import { makeFunnel, makeHarness } from './helpers.js';

async function setup() {
  const h = makeHarness();
  const u = await h.register();
  const f = await makeFunnel(h, u.token);
  const stepId = f.steps[0].id as string;
  const url = `/api/funnels/${f.id}/steps/${stepId}`;
  const doc = (text: string) => documentOf([createBuilder('p').heading(text)]);
  const save = (text: string, extra: object = {}, token = u.token) => h.call('PUT', `${url}/page`, { token, body: { doc: doc(text), ...extra } });
  const backups = async () => (await h.call('GET', `${url}/backups`, { token: u.token })).json.data as any[];
  return { h, u, f, stepId, url, save, backups, doc };
}

describe('page save', () => {
  it('stores the document, regenerates html, keeps a checksum and bumps the version', async () => {
    const { h, save, stepId, url, u } = await setup();
    const before = (await h.call('GET', `${url}/page`, { token: u.token })).json;
    const r = await save('Hello <b>World</b>');
    expect(r.status).toBe(200);
    expect(r.json.version).toBeGreaterThan(before.version);
    expect(r.json.checksum).not.toBe(before.checksum);
    const row = h.deps.db.get<{ html: string; checksum: string }>('SELECT html, checksum FROM step_pages WHERE step_id = ?', stepId)!;
    expect(row.html).toContain('Hello &lt;b&gt;World&lt;/b&gt;');
    expect(row.checksum).toBe(r.json.checksum);
    expect((await h.call('GET', `${url}/page`, { token: u.token })).json.doc.blocks[0].text).toBe('Hello <b>World</b>');
  });

  it('versions are strictly increasing even within the same millisecond', async () => {
    const { save } = await setup();
    const a = (await save('1')).json.version;
    const b = (await save('2')).json.version;
    const c = (await save('3')).json.version;
    expect(b).toBe(a + 1);
    expect(c).toBe(b + 1);
  });

  it('rejects invalid documents without changing anything', async () => {
    const { h, u, url, backups } = await setup();
    const put = (doc: unknown) => h.call('PUT', `${url}/page`, { token: u.token, body: { doc } });
    const r = await put({ version: 1, blocks: [{ id: 'a', type: 'button', text: 'x', action: { type: 'link', url: 'javascript:alert(1)' } }] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('INVALID_DOCUMENT');
    expect((await put({ version: 2, blocks: [] })).json.error.code).toBe('INVALID_DOCUMENT');
    expect((await put('nope')).json.error.code).toBe('INVALID_DOCUMENT');
    expect((await h.call('PUT', `${url}/page`, { token: u.token, body: {} })).status).toBe(400);
    expect(await backups()).toHaveLength(0);
  });

  it('rejects oversized documents', async () => {
    const { h, u, url } = await setup();
    const big = { version: 1, blocks: Array.from({ length: 190 }, (_, i) => ({ id: `p${i}`, type: 'paragraph', text: 'x'.repeat(9000) })) };
    const r = await h.call('PUT', `${url}/page`, { token: u.token, body: { doc: big } });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe('DOCUMENT_TOO_LARGE');
  });

  it('optimistic concurrency: a stale version is a 409', async () => {
    const { save } = await setup();
    const first = await save('a');
    expect((await save('b', { version: first.json.version })).status).toBe(200);
    const stale = await save('c', { version: first.json.version });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('VERSION_CONFLICT');
  });

  it('invalidates the in-memory page cache on save', async () => {
    const { h, stepId, save } = await setup();
    h.deps.pageCache.set(stepId, { html: 'stale', checksum: 'x' });
    await save('fresh');
    expect(h.deps.pageCache.get(stepId)).toBeUndefined();
  });
});

describe('backups', () => {
  it('stores the previous version on each save, newest first', async () => {
    const { h, save, backups, url, u } = await setup();
    expect(await backups()).toHaveLength(0);
    await save('one');
    await save('two');
    const list = await backups();
    expect(list).toHaveLength(2);
    expect(list[0].label).toMatch(/^Landing page \d{4}-\d{2}-\d{2}$/);
    const newest = (await h.call('GET', `${url}/backups/${list[0].id}`, { token: u.token })).json;
    expect(newest.doc.blocks[0].text).toBe('one'); // backup holds the version that was replaced
    const oldest = (await h.call('GET', `${url}/backups/${list[1].id}`, { token: u.token })).json;
    expect(JSON.stringify(oldest.doc)).toContain('My funnel'); // the auto-created default page
    expect(list[0].version).toBeGreaterThan(list[1].version);
  });

  it('keeps exactly 10: pruning at 10 and 11 saves, on save (no cron)', async () => {
    const { save, backups, h, stepId } = await setup();
    for (let i = 1; i <= MAX_BACKUPS; i++) await save(`v${i}`);
    expect(await backups()).toHaveLength(10);
    await save('v11');
    const list = await backups();
    expect(list).toHaveLength(10);
    await save('v12');
    expect(await backups()).toHaveLength(10);
    // the oldest were dropped: the initial default page and v1 are gone
    const docs = h.deps.db.all<{ doc_json: string }>('SELECT doc_json FROM step_backups WHERE step_id = ?', stepId).map((r) => r.doc_json);
    expect(docs.some((d) => d.includes('My funnel'))).toBe(false);
    expect(docs.some((d) => d.includes('"v1"'))).toBe(false);
    expect(docs.some((d) => d.includes('"v11"'))).toBe(true);
  });

  it('pruning is per step', async () => {
    const { h, u, f, save, backups } = await setup();
    const other = (await h.call('POST', `/api/funnels/${f.id}/steps`, { token: u.token, body: { name: 'Other' } })).json;
    await h.call('PUT', `/api/funnels/${f.id}/steps/${other.id}/page`, { token: u.token, body: { doc: documentOf([]) } });
    for (let i = 0; i < 12; i++) await save(`v${i}`);
    expect(await backups()).toHaveLength(10);
    expect(h.deps.db.get('SELECT COUNT(*) AS n FROM step_backups WHERE step_id = ?', other.id)).toEqual({ n: 1 });
  });

  it('autosave (backup:false) does not consume history slots', async () => {
    const { save, backups } = await setup();
    await save('a', { backup: false });
    await save('b', { backup: false });
    expect(await backups()).toHaveLength(0);
    await save('c');
    expect(await backups()).toHaveLength(1);
  });

  it('restoring brings back the old document and itself creates a backup of the replaced one', async () => {
    const { h, u, url, save, backups } = await setup();
    await save('original');
    await save('changed');
    const list = await backups();
    expect(list).toHaveLength(2);
    const target = list[0]; // holds "original"
    const r = await h.call('POST', `${url}/backups/${target.id}/restore`, { token: u.token });
    expect(r.status).toBe(200);
    expect((await h.call('GET', `${url}/page`, { token: u.token })).json.doc.blocks[0].text).toBe('original');
    const after = await backups();
    expect(after).toHaveLength(3);
    const newest = (await h.call('GET', `${url}/backups/${after[0].id}`, { token: u.token })).json;
    expect(newest.doc.blocks[0].text).toBe('changed'); // the replaced version can be restored again
  });

  it('restore at the pruning limit still keeps 10', async () => {
    const { h, u, url, save, backups } = await setup();
    for (let i = 0; i < 11; i++) await save(`v${i}`);
    const list = await backups();
    await h.call('POST', `${url}/backups/${list[list.length - 1].id}/restore`, { token: u.token });
    expect(await backups()).toHaveLength(10);
  });

  it('unknown backups are 404', async () => {
    const { h, u, url } = await setup();
    expect((await h.call('GET', `${url}/backups/nope`, { token: u.token })).status).toBe(404);
    expect((await h.call('POST', `${url}/backups/nope/restore`, { token: u.token })).status).toBe(404);
  });
});

describe('custom html scripts policy', () => {
  const htmlDoc = documentOf([{ id: 'h', type: 'html', html: '<p onclick="x()">hi</p><script>RUN()</script>' }]);
  const html = (h: Awaited<ReturnType<typeof setup>>['h'], stepId: string) => h.deps.db.get<{ html: string }>('SELECT html FROM step_pages WHERE step_id = ?', stepId)!.html;

  it('strips scripts unless the owner saved it AND the workspace allows custom scripts', async () => {
    const { h, u, f, url, stepId } = await setup();
    const admin = await h.member(u, 'admin');
    await h.call('PUT', `${url}/page`, { token: u.token, body: { doc: htmlDoc } });
    expect(html(h, stepId)).not.toContain('RUN()'); // flag off
    await h.call('PATCH', '/api/workspace', { token: u.token, body: { allowCustomScripts: true } });
    await h.call('PUT', `${url}/page`, { token: admin.token, body: { doc: htmlDoc } });
    expect(html(h, stepId)).not.toContain('RUN()'); // admin, not owner
    await h.call('PUT', `${url}/page`, { token: u.token, body: { doc: htmlDoc } });
    expect(html(h, stepId)).toContain('RUN()'); // owner + flag
    // unrelated changes by others (reordering, renaming) keep the owner's approval
    await h.call('PATCH', `/api/funnels/${f.id}/steps/${stepId}`, { token: admin.token, body: { title: 'New title' } });
    expect(html(h, stepId)).toContain('RUN()');
    await h.call('PATCH', '/api/workspace', { token: u.token, body: { allowCustomScripts: false } });
    expect(html(h, stepId)).not.toContain('RUN()');
    // the stored document still has the original html (source of truth)
    expect((await h.call('GET', `${url}/page`, { token: u.token })).json.doc.blocks[0].html).toContain('RUN()');
  });
});
