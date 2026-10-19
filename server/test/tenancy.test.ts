import { describe, expect, it } from 'vitest';
import { createBuilder } from '../src/blocks/index.js';
import { activeDomain, checkoutTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';

/** Everything workspace A owns, so workspace B can try to reach each resource type. */
async function world() {
  const h = await makeHarness();
  const a = await h.register('a@example.test');
  const b = await h.register('b@example.test');
  const memberOfA = await h.member(a, 'member');
  const t = await checkoutTarget(h, a.token);
  const f = t.funnel;
  const step = f.steps[0].id as string;
  const dom = await activeDomain(h, a.token, 'tenant-a.example.com');
  const tag = (await h.call('POST', '/api/tags', { token: a.token, body: { name: 'A-tag' } })).json;
  const hook = (await h.call('POST', '/api/webhooks', { token: a.token, body: { url: 'https://hooks.example.com/a', events: ['funnel.purchase'] } })).json;
  const block = (await h.call('POST', '/api/blocks', { token: a.token, body: { name: 'blk', block: createBuilder('z').divider() } })).json;
  const current = (await h.call('GET', `/api/funnels/${f.id}/steps/${step}/page`, { token: a.token })).json.doc;
  await h.call('PUT', `/api/funnels/${f.id}/steps/${step}/page`, { token: a.token, body: { doc: current } }); // creates a backup, content unchanged
  const backup = (await h.call('GET', `/api/funnels/${f.id}/steps/${step}/backups`, { token: a.token })).json.data[0];
  const buy = await h.call('POST', t.mainPath, { body: { email: 'buyer@example.com' }, headers: { 'user-agent': 'Mozilla/5.0' } });
  const delivery = (await h.deps.db.get<{ id: string }>('SELECT id FROM webhook_deliveries'))!;
  const note = (await h.call('GET', '/api/notifications', { token: a.token })).json.data[0];
  return { h, a, b, memberOfA, t, f, step, dom, tag, hook, block, backup, order: buy.json.orderId as string, delivery, note };
}

describe('cross-tenant access returns 404 (never 403) for every resource type', () => {
  it('funnels, steps, pages, backups, analytics, previews', async () => {
    const { h, b, f, step, backup } = await world();
    const F = `/api/funnels/${f.id}`;
    const S = `${F}/steps/${step}`;
    const reqs: [string, string, object?][] = [
      ['GET', F], ['PATCH', F, { name: 'x' }], ['PUT', F, { name: 'x' }], ['DELETE', F], ['POST', `${F}/restore`], ['DELETE', `${F}/purge`], ['POST', `${F}/duplicate`],
      ['POST', `${F}/preview-token`], ['GET', `${F}/analytics`], ['GET', `${F}/steps`], ['POST', `${F}/steps`, { name: 'x' }],
      ['PUT', `${F}/steps/order`, { orders: [{ stepId: step, order: 1 }] }], ['PATCH', S, { name: 'x' }], ['DELETE', S], ['POST', `${S}/duplicate`], ['GET', `${S}/analytics`],
      ['GET', `${S}/page`], ['PUT', `${S}/page`, { doc: { version: 1, blocks: [] } }], ['GET', `${S}/backups`], ['GET', `${S}/backups/${backup.id}`], ['POST', `${S}/backups/${backup.id}/restore`],
    ];
    for (const [method, path, body] of reqs) {
      const r = await h.call(method, path, { token: b.token, body });
      expect([method, path, r.status, r.json?.error?.code]).toEqual([method, path, 404, 'NOT_FOUND']);
    }
    // B's view of A's funnel is indistinguishable from a funnel that never existed
    const real = await h.call('GET', F, { token: b.token });
    const fake = await h.call('GET', '/api/funnels/fn_doesnotexist', { token: b.token });
    expect(real.json).toEqual(fake.json);
  });

  it('tags, domains, webhooks, orders, blocks, notifications, members, AI, validate-path and bulk-tag', async () => {
    const { h, a, b, f, tag, dom, hook, block, order, delivery, note, memberOfA } = await world();
    const memberId = (await h.call('GET', '/api/members', { token: a.token })).json.data.find((m: any) => m.role === 'member').id;
    const reqs: [string, string, object?][] = [
      ['PUT', `/api/tags/${tag.id}`, { name: 'x' }], ['DELETE', `/api/tags/${tag.id}`], ['DELETE', `/api/tags?ids=${tag.id}`],
      ['GET', `/api/domains/${dom}`], ['GET', `/api/domains/${dom}/routes`], ['POST', `/api/domains/${dom}/verify`], ['PUT', `/api/domains/${dom}/default-pages`, { homeStepId: null }], ['DELETE', `/api/domains/${dom}`],
      ['PATCH', `/api/webhooks/${hook.id}`, { active: false }], ['DELETE', `/api/webhooks/${hook.id}`], ['POST', `/api/webhooks/${hook.id}/rotate-secret`], ['POST', `/api/webhooks/${hook.id}/test`], ['GET', `/api/webhooks/${hook.id}/deliveries`],
      ['POST', `/api/webhooks/deliveries/${delivery.id}/retry`],
      ['GET', `/api/orders/${order}`], ['DELETE', `/api/blocks/${block.id}`], ['POST', `/api/notifications/${note.id}/read`],
      ['PATCH', `/api/members/${memberId}`, { role: 'admin' }], ['DELETE', `/api/members/${memberId}`],
      ['POST', '/api/ai/insights', { funnelId: f.id }],
      ['POST', '/api/funnels/validate-path', { path: '/x', funnelId: f.id }], ['POST', '/api/funnels/validate-path', { path: '/x', domainId: dom }],
      ['POST', '/api/funnels/bulk-tag', { funnelIds: [f.id], addTagIds: [] }], ['POST', '/api/funnels', { name: 'x', tags: [tag.id] }], ['POST', '/api/funnels', { name: 'x', domain_id: dom }],
    ];
    for (const [method, path, body] of reqs) {
      const r = await h.call(method, path, { token: b.token, body });
      expect([method, path, r.status, r.json?.error?.code]).toEqual([method, path, 404, 'NOT_FOUND']);
    }
    expect(memberOfA.token).toBeTruthy();
    // A's data is intact after all those attempts
    expect((await h.call('GET', `/api/funnels/${f.id}`, { token: a.token })).status).toBe(200);
    expect((await h.call('GET', '/api/tags', { token: a.token })).json.data).toHaveLength(1);
    expect((await h.call('GET', `/api/domains/${dom}`, { token: a.token })).json.status).toBe('active');
    expect((await h.call('GET', '/api/members', { token: a.token })).json.data).toHaveLength(2);
  });

  it('list endpoints never include another workspace\'s rows', async () => {
    const { h, b, f } = await world();
    for (const path of ['/api/funnels', '/api/funnels/trash', '/api/tags', '/api/domains', '/api/leads', '/api/orders', '/api/webhooks', '/api/notifications', '/api/blocks', '/api/members']) {
      const r = await h.call('GET', path, { token: b.token });
      const rows = r.json.data;
      if (path === '/api/members') expect(rows).toHaveLength(1);
      else expect([path, rows]).toEqual([path, []]);
    }
    expect((await h.call('GET', `/api/leads?funnelId=${f.id}`, { token: b.token })).json.data).toEqual([]);
    expect((await h.call('GET', `/api/orders?funnelId=${f.id}`, { token: b.token })).json.data).toEqual([]);
    expect((await h.call('GET', '/api/leads/export', { token: b.token })).text.trim().split('\r\n')).toHaveLength(1); // header only
    expect((await h.call('GET', '/api/funnels/filters', { token: b.token })).json).toMatchObject({ status: { live: 0, test: 0 }, tags: [] });
    expect((await h.call('GET', '/api/ai/status', { token: b.token })).json.usedToday).toBe(0);
  });

  it('a step id of the same workspace but another funnel is also a 404', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const f1 = await makeFunnel(h, u.token, { name: 'One' });
    const f2 = await makeFunnel(h, u.token, { name: 'Two' });
    const wrong = `/api/funnels/${f2.id}/steps/${f1.steps[0].id}`;
    for (const [m, p, body] of [['PATCH', wrong, { name: 'x' }], ['DELETE', wrong], ['GET', `${wrong}/page`], ['PUT', `${wrong}/page`, { doc: { version: 1, blocks: [] } }], ['POST', `${wrong}/duplicate`], ['GET', `${wrong}/backups`]] as [string, string, object?][]) {
      expect([m, (await h.call(m, p, { token: u.token, body })).status]).toEqual([m, 404]);
    }
  });

  it('public endpoints derive the workspace from the funnel, so a client-supplied workspace is ignored', async () => {
    const { h, a, b, t } = await world();
    const before = (await h.call('GET', '/api/orders', { token: b.token })).json.data.length;
    await h.call('POST', t.mainPath, { body: { email: 'x@example.com', workspaceId: b.wsId, workspace_id: b.wsId }, headers: { 'user-agent': 'Mozilla/5.0', 'x-workspace-id': b.wsId } });
    expect((await h.call('GET', '/api/orders', { token: b.token })).json.data).toHaveLength(before);
    expect((await h.call('GET', '/api/orders', { token: a.token })).json.data.length).toBeGreaterThan(1);
  });

  it('a token cannot be turned into another workspace by header tricks', async () => {
    const { h, a, b, f } = await world();
    const r = await h.call('GET', `/api/funnels/${f.id}`, { token: b.token, headers: { 'x-workspace-id': a.wsId, 'x-account-id': a.wsId } });
    expect(r.status).toBe(404);
  });
});
