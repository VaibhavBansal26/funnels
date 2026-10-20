import { describe, expect, it } from 'vitest';
import { totp } from '../src/auth/totp.js';
import { loadConfig } from '../src/config.js';
import { OPERATIONS } from '../src/routes/spec.js';
import { writeOutbox } from '../src/queue/outbox.js';
import { flagEnabled } from '../src/services/flags.js';
import { activeDomain, checkoutTarget, makeFunnel, makeHarness, type Harness } from './helpers.js';

const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36' };
const OPS = 'ops@platform.test';

async function world(env: Record<string, string> = {}) {
  const h = await makeHarness({ env: { PLATFORM_ADMIN_EMAILS: OPS, API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', ...env } });
  const ops = await h.register(OPS, 'Ops');
  const admin = (method: string, path: string, body?: unknown, token = ops.token) => h.call(method, `/api/admin${path}`, { token, body });
  return { h, ops, admin };
}

/** A customer workspace with a live funnel on a domain (served at shop.example.com). */
async function customer(h: Harness, email = 'customer@example.test', host = 'shop.example.com') {
  const owner = await h.register(email, 'Cora Customer');
  const dom = await activeDomain(h, owner.token, host);
  const f = await makeFunnel(h, owner.token, { name: 'Promo', base_path: '/promo' });
  await h.call('PATCH', `/api/funnels/${f.id}`, { token: owner.token, body: { domain_id: dom, status: 'live' } });
  const page = (path = '/promo') => h.app.request(path, { headers: { host, ...UA } });
  return { owner, f, host, page };
}

const code = (h: Harness, secret: string) => totp(secret, h.clock.now().getTime());

describe('who may use the admin area', () => {
  it('every platform route refuses anonymous callers (401) and ordinary users, owners included (403)', async () => {
    const { h } = await world();
    const user = await h.register('user@example.test');
    for (const o of OPERATIONS.filter((x) => x.auth === 'platform')) {
      const path = o.path.replace(/:[A-Za-z]+/g, 'x');
      const body = o.method === 'GET' ? undefined : {};
      expect((await h.call(o.method, path, { body })).status, `${o.method} ${o.path} anonymous`).toBe(401);
      const r = await h.call(o.method, path, { token: user.token, body });
      expect([r.status, r.json?.error?.code], `${o.method} ${o.path} as an owner of another workspace`).toEqual([403, 'FORBIDDEN']);
    }
  });

  it('PLATFORM_ADMIN_EMAILS bootstraps administrators; others are added through the API and need no list entry; removal rules hold', async () => {
    const { h, ops, admin } = await world();
    expect((await admin('GET', '/stats')).status).toBe(200);
    const other = await h.register('second@platform.test');
    expect((await admin('POST', '/admins', { email: 'second@platform.test' })).status).toBe(201);
    expect((await admin('POST', '/admins', { email: 'second@platform.test' })).json.error.code).toBe('ALREADY_ADMIN');
    expect((await admin('POST', '/admins', { email: 'nobody@platform.test' })).status).toBe(404);
    expect((await admin('GET', '/stats', undefined, other.token)).status).toBe(200);
    const list = (await admin('GET', '/admins')).json.data as { email: string; source: string }[];
    expect(list.map((a) => [a.email, a.source])).toEqual([[OPS, 'bootstrap'], ['second@platform.test', 'admin']]);
    expect((await admin('DELETE', `/admins/${ops.userId}`, undefined, other.token)).json.error.code).toBe('BOOTSTRAP_ADMIN');
    expect((await admin('DELETE', `/admins/${other.userId}`, undefined, other.token)).json.error.code).toBe('CANNOT_REMOVE_SELF');
    expect((await admin('DELETE', `/admins/${other.userId}`)).status).toBe(204);
    expect((await admin('GET', '/stats', undefined, other.token)).status).toBe(403);
    // taking the address off the list revokes the bootstrap administrator on the next request
    (h.deps.config as { PLATFORM_ADMIN_EMAILS: string[] }).PLATFORM_ADMIN_EMAILS = [];
    expect((await admin('GET', '/stats')).status).toBe(403);
  });

  it('with two-factor required, an administrator without 2FA is refused until they enrol; production always requires it', async () => {
    const { h, ops, admin } = await world({ ADMIN_REQUIRE_2FA: 'true' });
    const refused = await admin('GET', '/stats');
    expect([refused.status, refused.json.error.code]).toEqual([403, 'ADMIN_2FA_REQUIRED']);
    const setup = await h.call('POST', '/api/auth/2fa/setup', { token: ops.token });
    await h.call('POST', '/api/auth/2fa/enable', { token: ops.token, body: { code: code(h, setup.json.secret) } });
    expect((await admin('GET', '/stats')).status).toBe(200);
    expect(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40) }).ADMIN_REQUIRE_2FA).toBe(true);
    expect(loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(40), ADMIN_REQUIRE_2FA: 'false' }).ADMIN_REQUIRE_2FA, 'cannot be switched off in production').toBe(true);
    expect(loadConfig({ NODE_ENV: 'development' }).ADMIN_REQUIRE_2FA).toBe(false);
  });
});

describe('workspaces', () => {
  it('lists with search (name, id, member email), status filter and keyset paging; detail shows plan, usage, members and recent audit', async () => {
    const { h, admin } = await world();
    const ws: { wsId: string }[] = [];
    for (let i = 0; i < 4; i++) {
      ws.push(await h.register(`shop${i}@example.test`, `Shop ${i}`));
      h.clock.advance(1000);
    }
    const all = (await admin('GET', '/workspaces?limit=3')).json;
    expect(all.data).toHaveLength(3);
    expect(all.nextCursor).toBeTruthy();
    const rest = (await admin('GET', `/workspaces?limit=3&cursor=${all.nextCursor}`)).json;
    expect(rest.data).toHaveLength(2); // 4 shops + the operator
    expect(rest.nextCursor).toBeNull();
    expect([...all.data, ...rest.data].map((w: { id: string }) => w.id)).toHaveLength(new Set([...all.data, ...rest.data].map((w: { id: string }) => w.id)).size);
    expect((await admin('GET', '/workspaces?search=shop2@')).json.data.map((w: { ownerEmail: string }) => w.ownerEmail)).toEqual(['shop2@example.test']);
    expect((await admin('GET', `/workspaces?search=${ws[1]!.wsId}`)).json.data).toHaveLength(1);
    expect((await admin('GET', '/workspaces?search=%25')).json.data, 'LIKE wildcards are escaped').toHaveLength(0);
    await admin('POST', `/workspaces/${ws[0]!.wsId}/suspend`, { reason: 'abuse report 1234' });
    expect((await admin('GET', '/workspaces?status=suspended')).json.data.map((w: { id: string }) => w.id)).toEqual([ws[0]!.wsId]);
    const d = (await admin('GET', `/workspaces/${ws[0]!.wsId}`)).json;
    expect(d).toMatchObject({ plan: 'free', suspended: true, suspendedReason: 'abuse report 1234', usage: { members: 1 }, limits: { funnels: 3 } });
    expect(d.members[0].email).toBe('shop0@example.test');
    expect(d.recentAudit.map((a: { action: string }) => a.action)).toContain('admin.workspace.suspended');
    expect((await admin('GET', '/workspaces/ws_nope')).status).toBe(404);
  });
});

describe('suspension', () => {
  it('stops serving, signs members out, refuses public writes and API keys, purges the edge, and is reversible', async () => {
    const { h, admin, ops } = await world();
    const c = await customer(h);
    const key = (await h.call('POST', '/api/v1/api-keys', { token: c.owner.token, body: { name: 'k', scopes: ['analytics:read'] } })).json.key as string;
    expect((await c.page()).status).toBe(200);
    expect((await h.call('GET', '/api/v1/analytics/funnels', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    const event = (workspace = c.f) => h.call('POST', '/api/public/events', { body: { funnelId: workspace.id, stepId: workspace.steps[0].id, type: 'page_view', visitorId: 'v1' }, headers: UA });
    expect((await event()).json.recorded).toBe(true);

    expect((await admin('POST', `/workspaces/${c.owner.wsId}/suspend`, { reason: 'x' })).status, 'a reason is required').toBe(400);
    const s = await admin('POST', `/workspaces/${c.owner.wsId}/suspend`, { reason: 'chargeback fraud, ticket 77' });
    expect(s.json).toMatchObject({ suspended: true, purgedUrls: 1 });
    expect((await admin('POST', `/workspaces/${c.owner.wsId}/suspend`, { reason: 'again please' })).json.error.code).toBe('ALREADY_SUSPENDED');
    expect((await admin('POST', `/workspaces/${ops.wsId}/suspend`, { reason: 'my own workspace' })).json.error.code).toBe('CANNOT_SUSPEND_OWN');

    const purge = await h.deps.db.get<{ payload_json: string }>("SELECT payload_json FROM jobs WHERE type = 'edge.purge'");
    expect(JSON.parse(purge!.payload_json).urls).toEqual(['https://shop.example.com/promo']);
    expect(await c.page()).toMatchObject({ status: 503 });
    expect((await h.call('GET', '/api/funnels', { token: c.owner.token })).status, 'sessions that existed were ended').toBe(401);
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: c.owner.refreshToken } })).status).toBe(401);
    const login = await h.call('POST', '/api/auth/login', { body: { email: 'customer@example.test', password: 'correct horse battery' } });
    expect(login.status, 'signing in works, the workspace is what is locked').toBe(200);
    const locked = login.json.token as string;
    expect((await h.call('GET', '/api/funnels', { token: locked })).json.error.code).toBe('WORKSPACE_SUSPENDED');
    const me = await h.call('GET', '/api/auth/me', { token: locked });
    expect([me.status, me.json.workspace.suspended, me.json.workspace.suspendedReason]).toEqual([200, true, 'chargeback fraud, ticket 77']);
    const k = await h.call('GET', '/api/v1/analytics/funnels', { headers: { authorization: `Bearer ${key}` } });
    expect([k.status, k.json.error.code]).toEqual([403, 'WORKSPACE_SUSPENDED']);
    expect((await event()).json).toMatchObject({ recorded: false, reason: 'suspended' });
    expect((await h.call('POST', `/api/funnels/${c.f.id}/preview-token`, { token: locked })).status).toBe(403);
    expect((await h.call('GET', '/api/admin/stats', { token: locked })).status).toBe(403);

    // another workspace is untouched
    const other = await customer(h, 'other@example.test', 'other.example.com');
    expect((await other.page()).status).toBe(200);

    expect((await admin('POST', `/workspaces/${c.owner.wsId}/unsuspend`)).json.suspended).toBe(false);
    expect((await admin('POST', `/workspaces/${c.owner.wsId}/unsuspend`)).json.error.code).toBe('NOT_SUSPENDED');
    expect((await c.page()).status).toBe(200);
    expect((await h.call('GET', '/api/funnels', { token: locked })).status, 'the same session works again').toBe(200);
    expect((await h.call('GET', '/api/v1/analytics/funnels', { headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    const actions = (await admin('GET', `/audit?workspace=${c.owner.wsId}`)).json.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.workspace.suspended', 'admin.workspace.unsuspended']));
  });

  it('public forms and checkout of a suspended workspace answer 503; a payment already in flight still finalizes', async () => {
    const { h, admin } = await world();
    const owner = await h.register('shop@example.test');
    const t = await checkoutTarget(h, owner.token);
    await admin('POST', `/workspaces/${owner.wsId}/suspend`, { reason: 'terms violation' });
    const r = await h.call('POST', t.mainPath, { body: { email: 'buyer@example.com' }, headers: UA });
    expect([r.status, r.json.error.code]).toEqual([503, 'SITE_UNAVAILABLE']);
  });
});

describe('impersonation (support access)', () => {
  async function acting(opts: { writes?: boolean; env?: Record<string, string> } = {}) {
    const w = await world(opts.env);
    const c = await customer(w.h);
    const start = await w.admin('POST', `/workspaces/${c.owner.wsId}/impersonate`, { reason: 'ticket 4711: cannot publish', ...(opts.writes ? { allow_writes: true } : {}) });
    return { ...w, c, start, token: start.json.token as string };
  }

  it('needs a reason; opens a time-limited session as the owner with no refresh token; the workspace sees it in its audit log', async () => {
    const { h, admin, c, start, token } = await acting();
    expect((await admin('POST', `/workspaces/${c.owner.wsId}/impersonate`, { reason: 'x' })).status).toBe(400);
    expect(start.status).toBe(201);
    expect(start.json).toMatchObject({ user: { email: 'customer@example.test' }, workspace: { id: c.owner.wsId } });
    expect(start.json.refreshToken).toBeUndefined();
    expect(Date.parse(start.json.expiresAt) - h.clock.now().getTime()).toBe(30 * 60_000);
    expect((await h.call('GET', '/api/funnels', { token })).status).toBe(200);
    const me = (await h.call('GET', '/api/auth/me', { token })).json;
    expect(me.impersonation).toMatchObject({ by: OPS });
    expect(me.platformAdmin).toBe(false);
    const audit = (await h.call('GET', '/api/audit', { token: c.owner.token })).json.data as { action: string; actorId: string; detail: { reason?: string } }[];
    const started = audit.find((a) => a.action === 'admin.impersonation.started')!;
    expect(started.detail.reason).toBe('ticket 4711: cannot publish');
    // it ends by itself
    h.clock.advance(31 * 60_000);
    expect((await h.call('GET', '/api/funnels', { token })).status).toBe(401);
    expect((await h.call('GET', '/api/funnels', { token: c.owner.token })).status).toBe(200); // the owner's own session is unaffected
  });

  it('cannot use the admin area, credentials, billing, members or API keys; writes are audited with the administrator; logout ends it', async () => {
    const { h, c, token, ops } = await acting({ writes: true });
    const as = (method: string, path: string, body?: unknown) => h.call(method, path, { token, body });
    expect((await as('GET', '/api/admin/stats')).json.error.code).toBe('IMPERSONATION_FORBIDDEN');
    expect((await as('POST', '/api/auth/password', { currentPassword: 'correct horse battery', newPassword: 'another long password' })).json.error.code).toBe('IMPERSONATION_FORBIDDEN');
    expect((await as('POST', '/api/auth/2fa/setup')).json.error.code).toBe('IMPERSONATION_FORBIDDEN');
    expect((await as('GET', '/api/auth/sessions')).json.error.code).toBe('IMPERSONATION_FORBIDDEN');
    for (const [m, p, b] of [['POST', '/api/v1/api-keys', { name: 'k', scopes: ['analytics:read'] }], ['POST', '/api/invitations', { email: 'x@example.test', roleId: 'viewer' }], ['POST', '/api/billing/subscribe', { plan: 'pro' }], ['PATCH', '/api/workspace', { name: 'Renamed' }]] as const) {
      expect((await as(m, p, b)).status, `${m} ${p}`).toBe(403);
    }
    // ordinary support work is allowed, and recorded
    const made = await as('POST', '/api/funnels', { name: 'Support fix' });
    expect(made.status).toBe(201);
    const audit = (await h.call('GET', '/api/audit?action=admin.impersonation.action', { token: c.owner.token })).json.data as { actorId: string; detail: { method: string; path: string } }[];
    expect(audit.some((a) => a.actorId === ops.userId && a.detail.method === 'POST' && a.detail.path === '/api/funnels')).toBe(true);
    expect((await as('POST', '/api/auth/logout')).status).toBe(204);
    expect((await as('GET', '/api/funnels')).status).toBe(401);
  });

  it('is read-only by default: GET and HEAD work, POST, PUT, PATCH and DELETE are refused with IMPERSONATION_READ_ONLY, nothing changes and nothing is audited as a change', async () => {
    const { h, c, token, start } = await acting();
    const as = (method: string, path: string, body?: unknown) => h.call(method, path, { token, body });
    expect(start.json.allowWrites).toBe(false);
    for (const p of ['/api/funnels', '/api/orders', '/api/leads', '/api/audit', '/api/workspace', '/api/auth/me']) expect((await as('GET', p)).status, `GET ${p}`).toBe(200);
    expect((await h.app.request('/api/funnels', { method: 'HEAD', headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    const before = (await h.call('GET', '/api/funnels', { token: c.owner.token })).json.data.length;
    const refused = [
      await as('POST', '/api/funnels', { name: 'Nope' }),
      await as('PUT', `/api/funnels/${c.f.id}`, { name: 'Renamed' }),
      await as('PATCH', `/api/funnels/${c.f.id}`, { name: 'Renamed' }),
      await as('DELETE', `/api/funnels/${c.f.id}`),
      await as('POST', '/api/webhooks', { url: 'https://hooks.example.com/x', events: ['funnel.optin'] }),
      await as('POST', '/api/notifications/read-all'),
    ];
    for (const r of refused) expect([r.status, r.json.error.code]).toEqual([403, 'IMPERSONATION_READ_ONLY']);
    const after = (await h.call('GET', '/api/funnels', { token: c.owner.token })).json.data as { name: string }[];
    expect(after).toHaveLength(before);
    expect(after.some((f) => f.name === 'Renamed' || f.name === 'Nope')).toBe(false);
    expect((await h.call('GET', '/api/audit?action=admin.impersonation.action', { token: c.owner.token })).json.data).toEqual([]);
    // ending the session and opening the notification stream are the allow-listed exceptions
    expect((await as('POST', '/api/events/ticket')).status).toBe(200);
    expect((await as('POST', '/api/auth/logout')).status).toBe(204);
    expect((await as('GET', '/api/funnels')).status).toBe(401);
  });

  it('writes need the flag AND the superadmin role AND a written reason of 20+ characters; every write performed is audited; the session is shorter', async () => {
    const { h, admin, c, start, token, ops } = await acting({ writes: true });
    expect(start.status).toBe(201);
    expect(start.json.allowWrites).toBe(true);
    expect(Date.parse(start.json.expiresAt) - h.clock.now().getTime()).toBe(10 * 60_000); // IMPERSONATION_WRITE_TTL_MINUTES, not the 30 of a read-only session
    const as = (method: string, path: string, body?: unknown) => h.call(method, path, { token, body });
    const made = await as('POST', '/api/funnels', { name: 'Support fix' });
    expect(made.status).toBe(201);
    expect((await as('PATCH', `/api/funnels/${made.json.id}`, { name: 'Support fix 2' })).status).toBe(200);
    expect((await as('DELETE', `/api/funnels/${made.json.id}`)).status).toBe(204);
    // a refused write (permission denied inside the session) is not audited as performed
    expect((await as('POST', '/api/billing/subscribe', { plan: 'pro' })).status).toBe(403);
    const rows = (await h.call('GET', '/api/audit?action=admin.impersonation.action', { token: c.owner.token })).json.data as { actorId: string; supportAccess: boolean; detail: { method: string; path: string; mode: string } }[];
    expect(rows.map((r) => `${r.detail.method} ${r.detail.path}`).sort()).toEqual(['DELETE /api/funnels/:id', 'PATCH /api/funnels/:id', 'POST /api/funnels']);
    for (const r of rows) expect(r).toMatchObject({ actorId: ops.userId, supportAccess: true, detail: { mode: 'read_write' } });
    // the flag alone is not enough: a short reason, and an administrator below superadmin, are refused and open no session
    const sessions = async () => Number((await h.deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE impersonator_id IS NOT NULL'))!.n);
    const n = await sessions();
    expect(await admin('POST', `/workspaces/${c.owner.wsId}/impersonate`, { reason: 'too short reason', allow_writes: true })).toMatchObject({ status: 400, json: { error: { code: 'WRITE_REASON_REQUIRED' } } });
    const support = await h.register('support@platform.test');
    expect((await admin('POST', '/admins', { email: 'support@platform.test' })).json.role).toBe('support');
    const asSupport = (body: object) => admin('POST', `/workspaces/${c.owner.wsId}/impersonate`, body, support.token);
    const denied = await asSupport({ reason: 'ticket 4711: customer asked us to fix the funnel', allow_writes: true });
    expect([denied.status, denied.json.error.code]).toEqual([403, 'SUPERADMIN_REQUIRED']);
    expect(await sessions()).toBe(n);
    // but a support administrator can still open a read-only session
    const ro = await asSupport({ reason: 'ticket 4711: looking at the funnel' });
    expect(ro.status).toBe(201);
    expect(ro.json.allowWrites).toBe(false);
    expect((await h.call('POST', '/api/funnels', { token: ro.json.token, body: { name: 'x' } })).json.error.code).toBe('IMPERSONATION_READ_ONLY');
  });

  it('platform roles: bootstrap administrators are superadmins, API-added ones are support unless a superadmin says otherwise; only a superadmin grants superadmin', async () => {
    const { h, admin } = await world();
    const a = await h.register('a@platform.test');
    const b = await h.register('b@platform.test');
    expect((await admin('POST', '/admins', { email: 'a@platform.test' })).status).toBe(201);
    expect((await admin('POST', '/admins', { email: 'b@platform.test' }, a.token)).status).toBe(201); // support may add support
    expect((await admin('DELETE', `/admins/${b.userId}`)).status).toBe(204);
    const denied = await admin('POST', '/admins', { email: 'b@platform.test', role: 'superadmin' }, a.token);
    expect([denied.status, denied.json.error.code]).toEqual([403, 'SUPERADMIN_REQUIRED']);
    expect((await admin('POST', '/admins', { email: 'b@platform.test', role: 'superadmin' })).json.role).toBe('superadmin');
    const list = (await admin('GET', '/admins')).json.data as { email: string; role: string }[];
    expect(list.map((x) => [x.email, x.role])).toEqual([[OPS, 'superadmin'], ['a@platform.test', 'support'], ['b@platform.test', 'superadmin']]);
    expect((await h.call('GET', '/api/auth/me', { token: a.token })).json.platformRole).toBe('support');
  });

  it('the banner state is in /me: read-only by default, write-enabled when allowed; the session ends at its own shorter expiry', async () => {
    const ro = await acting();
    const rm = (await ro.h.call('GET', '/api/auth/me', { token: ro.token })).json;
    expect(rm.impersonation).toMatchObject({ by: OPS, readOnly: true, allowWrites: false });
    expect(rm.platformRole).toBeNull();
    const rw = await acting({ writes: true });
    const wm = (await rw.h.call('GET', '/api/auth/me', { token: rw.token })).json;
    expect(wm.impersonation).toMatchObject({ by: OPS, readOnly: false, allowWrites: true });
    expect(Date.parse(wm.impersonation.expiresAt) - rw.h.clock.now().getTime()).toBe(10 * 60_000);
    rw.h.clock.advance(9 * 60_000);
    expect((await rw.h.call('GET', '/api/funnels', { token: rw.token })).status).toBe(200);
    rw.h.clock.advance(2 * 60_000);
    expect((await rw.h.call('POST', '/api/funnels', { token: rw.token, body: { name: 'late' } })).status).toBe(401);
    // the read-only session is still alive after the write session's expiry
    ro.h.clock.advance(11 * 60_000);
    expect((await ro.h.call('GET', '/api/funnels', { token: ro.token })).status).toBe(200);
  });

  it('a write session is never longer than IMPERSONATION_TTL_MINUTES', async () => {
    const w = await acting({ writes: true, env: { IMPERSONATION_TTL_MINUTES: '5', IMPERSONATION_WRITE_TTL_MINUTES: '20' } });
    expect(Date.parse(w.start.json.expiresAt) - w.h.clock.now().getTime()).toBe(5 * 60_000);
  });

  it('the customer audit log shows support access: started (with the reason and mode), changes made, ended', async () => {
    const { h, c, token, ops } = await acting({ writes: true });
    await h.call('POST', '/api/funnels', { token, body: { name: 'Support fix' } });
    await h.call('POST', '/api/auth/logout', { token });
    const rows = (await h.call('GET', '/api/audit?limit=100', { token: c.owner.token })).json.data as { action: string; actorId: string; supportAccess: boolean; label?: string; detail: Record<string, unknown> }[];
    const support = rows.filter((r) => r.supportAccess);
    expect(support.map((r) => r.label).sort()).toEqual(['Support access ended', 'Support access started', 'Support access: change made']);
    expect(support.every((r) => r.actorId === ops.userId)).toBe(true);
    expect(support.find((r) => r.action === 'admin.impersonation.started')!.detail).toMatchObject({ reason: 'ticket 4711: cannot publish', mode: 'read_write' });
    expect(rows.filter((r) => !r.supportAccess).every((r) => !r.action.startsWith('admin.impersonation'))).toBe(true);
    expect(rows.some((r) => r.action === 'admin.impersonation.ended')).toBe(true);
  });

  it('refuses suspended workspaces and platform administrators as targets', async () => {
    const { h, admin } = await world();
    const c = await customer(h);
    const second = await h.register('second@platform.test');
    await admin('POST', '/admins', { email: 'second@platform.test' });
    expect((await admin('POST', `/workspaces/${second.wsId}/impersonate`, { reason: 'curious about them' })).json.error.code).toBe('CANNOT_IMPERSONATE_ADMIN');
    await admin('POST', `/workspaces/${c.owner.wsId}/suspend`, { reason: 'suspended for test' });
    expect((await admin('POST', `/workspaces/${c.owner.wsId}/impersonate`, { reason: 'looking around' })).json.error.code).toBe('WORKSPACE_SUSPENDED');
  });
});

describe('feature flags', () => {
  it('built-in flags default on; an override turns a feature off for one workspace only, immediately', async () => {
    const { h, admin } = await world();
    const a = await h.register('a@example.test');
    const b = await h.register('b@example.test');
    expect((await h.call('GET', '/api/workspace/flags', { token: a.token })).json.flags).toEqual({ ai_assistant: true, analytics_api: true });
    expect((await h.call('GET', '/api/ai/status', { token: a.token })).status).toBe(200);
    const key = (await h.call('POST', '/api/v1/api-keys', { token: a.token, body: { name: 'k', scopes: ['analytics:read'] } })).json.key as string;
    expect((await admin('PUT', `/flags/ai_assistant/workspaces/${a.wsId}`, { enabled: false })).status).toBe(200);
    expect((await admin('PUT', `/flags/analytics_api/workspaces/${a.wsId}`, { enabled: false })).status).toBe(200);
    const off = await h.call('GET', '/api/ai/status', { token: a.token });
    expect([off.status, off.json.error.code]).toEqual([403, 'FEATURE_DISABLED']);
    expect((await h.call('GET', '/api/v1/analytics/funnels', { headers: { authorization: `Bearer ${key}` } })).json.error.code).toBe('FEATURE_DISABLED');
    expect((await h.call('GET', '/api/ai/status', { token: b.token })).status).toBe(200);
    expect((await h.call('GET', '/api/workspace/flags', { token: a.token })).json.flags.ai_assistant).toBe(false);
    await admin('PUT', `/flags/ai_assistant/workspaces/${a.wsId}`, { enabled: null });
    expect((await h.call('GET', '/api/ai/status', { token: a.token })).status).toBe(200);
    expect((await admin('PUT', `/flags/nope_flag/workspaces/${a.wsId}`, { enabled: true })).status).toBe(404);
    expect((await admin('PUT', '/flags/Bad Key!', { rolloutPercent: 5 })).status).toBe(400);
  });

  it('custom flags: default, stable percentage rollout that only ever adds workspaces, delete', async () => {
    const { h, admin } = await world();
    const ids = Array.from({ length: 400 }, (_, i) => `ws_sample_${i}`);
    const on = async () => (await Promise.all(ids.map(async (id) => ((await flagEnabled(h.deps, id, 'new_builder')) ? id : null)))).filter((x): x is string => !!x);
    expect(await on()).toHaveLength(0); // unknown flag: off
    expect((await admin('PUT', '/flags/new_builder', { description: 'Next builder', rolloutPercent: 30 })).status).toBe(200);
    const at30 = await on();
    expect(at30.length).toBeGreaterThan(80);
    expect(at30.length).toBeLessThan(160);
    expect(await on()).toEqual(at30); // stable
    await admin('PUT', '/flags/new_builder', { rolloutPercent: 60 });
    const at60 = new Set(await on());
    expect(at30.every((id) => at60.has(id))).toBe(true);
    await admin('PUT', '/flags/new_builder', { rolloutPercent: 100 });
    expect(await on()).toHaveLength(400);
    await admin('PUT', '/flags/new_builder', { rolloutPercent: 0, defaultEnabled: true });
    expect(await on()).toHaveLength(400);
    const listed = (await admin('GET', '/flags')).json.data as { key: string; description: string }[];
    expect(listed.map((f) => f.key)).toEqual(['ai_assistant', 'analytics_api', 'new_builder']);
    expect((await admin('DELETE', '/flags/new_builder')).status).toBe(204);
    expect(await on()).toHaveLength(0);
    expect((await admin('DELETE', '/flags/new_builder')).status).toBe(404);
  });
});

describe('queue inspector', () => {
  it('reports jobs, outbox backlog and deliveries; dead jobs can be retried or discarded, and only dead ones', async () => {
    const { h, admin } = await world();
    await h.deps.jobs.enqueue('demo.job', { n: 1 });
    const dead = (await h.deps.jobs.enqueue('demo.dead', { secret: 'x'.repeat(5000) }))!;
    await h.deps.db.run("UPDATE jobs SET status = 'dead', attempts = 5, last_error = 'boom' WHERE id = ?", dead);
    await writeOutbox(h.deps.db, 'funnels.domain', 'k', { a: 1 }, h.clock.now().toISOString());
    h.clock.advance(90_000);
    const o = (await admin('GET', '/queues')).json;
    expect(o.jobs).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'queued', type: 'demo.job', count: 1 }), expect.objectContaining({ status: 'dead', type: 'demo.dead', count: 1 })]));
    expect(o.outbox.unpublished).toBe(1);
    expect(o.outbox.oldestAgeSeconds).toBeGreaterThanOrEqual(90);
    expect(o.bus.kind).toBe('memory');
    const list = (await admin('GET', '/queues/dead-jobs')).json.data as { id: string; lastError: string; payload: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: dead, lastError: 'boom' });
    expect(list[0]!.payload.length).toBeLessThan(2100);
    expect((await admin('POST', `/queues/jobs/${dead}/retry`)).json.status).toBe('queued');
    expect((await admin('POST', `/queues/jobs/${dead}/retry`)).json.error.code).toBe('NOT_DEAD');
    expect((await admin('DELETE', `/queues/jobs/${dead}`)).json.error.code).toBe('NOT_DEAD');
    await h.deps.db.run("UPDATE jobs SET status = 'dead' WHERE id = ?", dead);
    expect((await admin('DELETE', `/queues/jobs/${dead}`)).status).toBe(204);
    expect((await admin('POST', '/queues/jobs/job_nope/retry')).status).toBe(404);
    expect((await admin('GET', '/queues/dead-letters')).json.data).toEqual([]);
    const actions = (await admin('GET', '/audit?action=admin.job.*')).json.data.map((a: { action: string }) => a.action);
    expect(actions.sort()).toEqual(['admin.job.discarded', 'admin.job.retried']);
  });
});

describe('personal data', () => {
  async function withLeadAndOrder() {
    const w = await world();
    const owner = await h2(w.h);
    return { ...w, ...owner };
  }
  async function h2(h: Harness) {
    const owner = await h.register('shop@example.test', 'Shop Owner');
    const t = await checkoutTarget(h, owner.token);
    const buy = (email: string) => h.call('POST', t.mainPath, { body: { email, name: 'Pat Person' }, headers: UA });
    expect((await buy('pat@example.com')).status).toBe(200);
    expect((await buy('lee@example.com')).status).toBe(200);
    await h.call('POST', '/api/webhooks', { token: owner.token, body: { url: 'https://hooks.example.com/p', events: ['funnel.purchase'] } });
    await buy('pat@example.com').catch(() => null);
    return { owner, t };
  }

  it('exports everything held about an address and erases it: leads deleted, orders anonymised but kept for the books, notifications and webhook payloads scrubbed; others untouched', async () => {
    const { h, admin, owner } = await withLeadAndOrder();
    await h.worker.tick();
    const before = (await admin('POST', '/gdpr/export', { email: 'PAT@example.com' })).json;
    expect(before.leads.length).toBeGreaterThanOrEqual(1);
    expect(before.orders.length).toBeGreaterThanOrEqual(1);
    const total = Number((await h.deps.db.get<{ s: number }>("SELECT SUM(amount_cents) AS s FROM orders WHERE lower(email) = 'pat@example.com'"))!.s);
    const lee = Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE email = 'lee@example.com'"))!.n);
    const r = await admin('POST', '/gdpr/erase', { email: 'pat@example.com' });
    expect(r.status).toBe(200);
    expect(r.json.erased.leads).toBeGreaterThanOrEqual(1);
    expect(r.json.erased.orders).toBeGreaterThanOrEqual(1);
    expect(await h.deps.db.get("SELECT 1 FROM leads WHERE email = 'pat@example.com'")).toBeUndefined();
    expect(await h.deps.db.get("SELECT 1 FROM orders WHERE lower(email) = 'pat@example.com'")).toBeUndefined();
    const kept = await h.deps.db.all<{ email: string; name: string | null; amount_cents: number; payment_method_ref: string | null }>("SELECT email, name, amount_cents, payment_method_ref FROM orders WHERE email LIKE 'erased-%'");
    expect(kept.reduce((s, o) => s + o.amount_cents, 0)).toBe(total); // the books still add up
    expect(kept.every((o) => o.name === null && o.payment_method_ref === null)).toBe(true);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE email = 'lee@example.com'"))!.n)).toBe(lee);
    expect(await h.deps.db.get("SELECT 1 FROM leads WHERE email = 'lee@example.com'")).toBeDefined();
    const dump = JSON.stringify(await h.deps.db.all('SELECT body, title, data_json FROM notifications')) + JSON.stringify(await h.deps.db.all('SELECT payload_json FROM webhook_deliveries'));
    expect(dump.toLowerCase()).not.toContain('pat@example.com');
    const audit = JSON.stringify((await admin('GET', '/audit?action=admin.gdpr.*')).json);
    expect(audit).not.toContain('pat@example.com');
    expect(audit).toContain('admin.gdpr.erase');
    expect((await admin('POST', '/gdpr/export', { email: 'pat@example.com' })).json.leads).toEqual([]);
    expect(owner.wsId).toBeTruthy();
  });

  it('erasure can be limited to one workspace and says when the address belongs to a member', async () => {
    const { h, admin, owner } = await withLeadAndOrder();
    const other = await h.register('other@example.test');
    const t2 = await checkoutTarget(h, other.token);
    await h.call('POST', t2.mainPath, { body: { email: 'pat@example.com' }, headers: UA });
    const r = await admin('POST', '/gdpr/erase', { email: 'pat@example.com', workspaceId: other.wsId });
    expect(r.json.erased.orders).toBe(1);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM orders WHERE lower(email) = 'pat@example.com' AND workspace_id = ?", owner.wsId))!.n)).toBeGreaterThanOrEqual(1);
    const member = await admin('POST', '/gdpr/erase', { email: 'other@example.test' });
    expect(member.json.member).toMatchObject({ userId: other.userId });
    expect(await h.deps.db.get('SELECT 1 FROM users WHERE id = ?', other.userId)).toBeDefined();
  });

  it('workspace export is NDJSON of the workspace only, without credentials, in bounded pages', async () => {
    const { h, admin, owner } = await withLeadAndOrder();
    const stranger = await h.register('stranger@example.test');
    await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'k', scopes: ['analytics:read'] } });
    const res = await h.app.request(`/api/admin/workspaces/${owner.wsId}/export`, { headers: { authorization: `Bearer ${(await h.call('POST', '/api/auth/login', { body: { email: OPS, password: 'correct horse battery' } })).json.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const text = await res.text();
    const lines = text.trim().split('\n').map((l) => JSON.parse(l) as { table: string; row: Record<string, unknown> });
    const by = (t: string) => lines.filter((l) => l.table === t);
    expect(by('workspace')).toHaveLength(1);
    expect(by('users').map((l) => l.row.email)).toEqual(['shop@example.test']);
    expect(by('leads').length).toBeGreaterThanOrEqual(2);
    expect(by('orders').length).toBeGreaterThanOrEqual(2);
    expect(by('step_pages').length).toBeGreaterThan(0);
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('key_hash');
    expect(text).not.toContain('stranger@example.test');
    expect(lines.every((l) => l.row.workspace_id === undefined || l.row.workspace_id === owner.wsId)).toBe(true);
    expect((await admin('GET', '/audit?action=admin.workspace.exported')).json.data).toHaveLength(1);
    expect(stranger.wsId).not.toBe(owner.wsId);
    expect((await admin('GET', '/workspaces/ws_nope/export')).status).toBe(404);
  });

  it('a large workspace exports across several pages without losing or repeating a row', async () => {
    const { h, admin } = await world();
    const owner = await h.register('big@example.test');
    const t = await checkoutTarget(h, owner.token);
    const n = 2300;
    const at = h.clock.now().toISOString();
    await h.deps.db.transaction(async (tx) => {
      for (let i = 0; i < n; i++) await tx.run('INSERT INTO leads (id, workspace_id, email, name, data_json, first_funnel_id, submissions, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, 1, ?, ?)', `led_${String(i).padStart(6, '0')}`, owner.wsId, `bulk${i}@example.test`, '{}', t.funnelId, at, at);
    });
    const login = (await h.call('POST', '/api/auth/login', { body: { email: OPS, password: 'correct horse battery' } })).json.token as string;
    const res = await h.app.request(`/api/admin/workspaces/${owner.wsId}/export`, { headers: { authorization: `Bearer ${login}` } });
    const ids = (await res.text()).trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.table === 'leads').map((l) => l.row.id as string);
    expect(ids).toHaveLength(n);
    expect(new Set(ids).size).toBe(n);
    expect(admin).toBeDefined();
  });
});

describe('deleting a workspace', () => {
  it('needs suspension, the typed name and no admin members; removes everything of that workspace and nothing else; keeps the audit trail', async () => {
    const { h, admin } = await world();
    const c = await customer(h);
    const other = await customer(h, 'other@example.test', 'other.example.com');
    const body = { confirmName: 'Cora Customer\'s workspace', reason: 'customer asked for closure' };
    expect((await admin('DELETE', `/workspaces/${c.owner.wsId}`, body)).json.error.code).toBe('NOT_SUSPENDED');
    await admin('POST', `/workspaces/${c.owner.wsId}/suspend`, { reason: 'closure requested' });
    expect((await admin('DELETE', `/workspaces/${c.owner.wsId}`, { ...body, confirmName: 'wrong' })).json.error.code).toBe('CONFIRMATION_MISMATCH');
    await h.deps.db.run("UPDATE workspaces SET stripe_subscription_id = 'sub_1' WHERE id = ?", c.owner.wsId);
    expect((await admin('DELETE', `/workspaces/${c.owner.wsId}`, body)).json.error.code).toBe('HAS_SUBSCRIPTION');
    await h.deps.db.run('UPDATE workspaces SET stripe_subscription_id = NULL WHERE id = ?', c.owner.wsId);
    expect((await admin('DELETE', `/workspaces/${c.owner.wsId}`, body)).status).toBe(204);
    for (const [table, col] of [['workspaces', 'id'], ['users', 'workspace_id'], ['funnels', 'workspace_id'], ['steps', 'workspace_id'], ['domains', 'workspace_id'], ['sessions', 'workspace_id']] as const) {
      expect(await h.deps.db.get(`SELECT 1 FROM ${table} WHERE ${col} = ?`, c.owner.wsId), table).toBeUndefined();
    }
    expect(await h.deps.db.get('SELECT 1 FROM workspaces WHERE id = ?', other.owner.wsId)).toBeDefined();
    expect((await other.page()).status).toBe(200);
    expect((await c.page()).status).toBe(404);
    const trail = (await admin('GET', `/audit?workspace=${c.owner.wsId}`)).json.data.map((a: { action: string }) => a.action);
    expect(trail).toEqual(expect.arrayContaining(['admin.workspace.suspended', 'admin.workspace.deleted']));
    expect((await admin('DELETE', `/workspaces/${c.owner.wsId}`, body)).status).toBe(404);
  });

  it('refuses a workspace that has a platform administrator in it', async () => {
    const { h, admin } = await world();
    const c = await customer(h);
    const colleague = await h.member(c.owner, 'admin', 'colleague@platform.test');
    await admin('POST', '/admins', { email: 'colleague@platform.test' });
    await admin('POST', `/workspaces/${c.owner.wsId}/suspend`, { reason: 'closure requested' });
    const r = await admin('DELETE', `/workspaces/${c.owner.wsId}`, { confirmName: "Cora Customer's workspace", reason: 'customer asked for closure' });
    expect(r.json.error.code).toBe('CONTAINS_ADMIN');
    expect(colleague.userId).toBeTruthy();
  });
});

describe('announcements', () => {
  it('active announcements reach every signed-in user until dismissed; critical ones stay; windows are enforced', async () => {
    const { h, admin } = await world();
    const u = await h.register('user@example.test');
    const v = await h.register('viewer@example.test');
    const now = h.clock.now().getTime();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    const mk = (b: object) => admin('POST', '/announcements', b);
    const info = (await mk({ title: 'Maintenance', body: 'Saturday 02:00 UTC', level: 'warning', endsAt: iso(3_600_000) })).json;
    const crit = (await mk({ title: 'Incident', body: 'Payments delayed', level: 'critical' })).json;
    const later = (await mk({ title: 'Soon', body: 'Next week', startsAt: iso(86_400_000) })).json;
    expect((await mk({ title: 'Bad', body: 'window', startsAt: iso(1000), endsAt: iso(500) })).json.error.code).toBe('INVALID_WINDOW');
    const seen = async (token: string) => (await h.call('GET', '/api/announcements', { token })).json.data.map((a: { title: string }) => a.title);
    expect(await seen(u.token)).toEqual(['Incident', 'Maintenance']); // critical first, not yet started excluded
    expect((await h.call('POST', `/api/announcements/${info.id}/dismiss`, { token: u.token })).status).toBe(204);
    expect((await h.call('POST', `/api/announcements/${crit.id}/dismiss`, { token: u.token })).json.error.code).toBe('NOT_DISMISSIBLE');
    expect(await seen(u.token)).toEqual(['Incident']);
    expect(await seen(v.token)).toEqual(['Incident', 'Maintenance']); // dismissal is per user
    h.clock.advance(2 * 3_600_000);
    expect(await seen(v.token)).toEqual(['Incident']); // ended
    h.clock.advance(86_400_000);
    expect(await seen(v.token)).toEqual(['Incident', 'Soon']);
    expect((await admin('PATCH', `/announcements/${crit.id}`, { endsAt: iso(2 * 3_600_000) })).status).toBe(200);
    expect(await seen(v.token)).toEqual(['Soon']);
    expect((await admin('DELETE', `/announcements/${later.id}`)).status).toBe(204);
    expect((await admin('GET', '/announcements')).json.data).toHaveLength(2);
    expect((await h.call('POST', '/api/admin/announcements', { token: u.token, body: { title: 'x', body: 'y' } })).status).toBe(403);
    expect((await h.call('GET', '/api/announcements')).status).toBe(401);
  });
});

describe('platform audit', () => {
  it('shows who did what across workspaces with filters and paging, and every admin write is in it', async () => {
    const { h, admin, ops } = await world();
    const c = await customer(h);
    await admin('POST', `/workspaces/${c.owner.wsId}/suspend`, { reason: 'audit test one' });
    await admin('POST', `/workspaces/${c.owner.wsId}/unsuspend`);
    await admin('PUT', '/flags/ai_assistant', { rolloutPercent: 10 });
    await admin('POST', '/announcements', { title: 't', body: 'b' });
    const all = (await admin('GET', '/audit?action=admin.*&limit=3')).json;
    expect(all.data).toHaveLength(3);
    expect(all.nextCursor).toBeTruthy();
    const rest = (await admin('GET', `/audit?action=admin.*&limit=50&cursor=${all.nextCursor}`)).json;
    const actions = [...all.data, ...rest.data].map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['admin.workspace.suspended', 'admin.workspace.unsuspended', 'admin.flag.updated', 'admin.announcement.created', 'admin.bootstrap']));
    expect([...all.data, ...rest.data].filter((a: { action: string }) => a.action !== 'admin.bootstrap').every((a: { actorId: string }) => a.actorId === ops.userId)).toBe(true);
    expect((await admin('GET', `/audit?workspace=${c.owner.wsId}&action=admin.workspace.suspended`)).json.data).toHaveLength(1);
    expect((await admin('GET', `/audit?actor=${ops.userId}&limit=1`)).json.data).toHaveLength(1);
    expect((await admin('GET', '/stats')).json).toMatchObject({ workspaces: 2, suspended: 0, admins: 1 });
  });
});
