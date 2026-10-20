import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, SYSTEM_ROLES } from '../src/auth/permissions.js';
import { makeHarness } from './helpers.js';

const world = async () => {
  const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' } });
  const owner = await h.register();
  return { h, owner };
};

describe('roles and permissions', () => {
  it('lists built-in roles first, then custom ones, with member counts and the permission catalogue', async () => {
    const { h, owner } = await world();
    await h.memberWith(owner, ['funnels:read']);
    const roles = (await h.call('GET', '/api/roles', { token: owner.token })).json.data as { id: string; system: boolean; members: number; permissions: string[] }[];
    expect(roles.slice(0, 4).map((r) => r.id)).toEqual(['owner', 'admin', 'member', 'viewer']);
    expect(roles.find((r) => r.id === 'owner')).toMatchObject({ system: true, members: 1 });
    expect(roles[4]).toMatchObject({ system: false, members: 1, permissions: ['funnels:read'] });
    const cat = (await h.call('GET', '/api/permissions', { token: owner.token })).json.data as { id: string }[];
    expect(cat.map((p) => p.id)).toEqual(ALL_PERMISSIONS);
  });

  it('/auth/me returns the permission list of the role, and a custom role changes exactly what the member can do', async () => {
    const { h, owner } = await world();
    const reader = await h.memberWith(owner, ['funnels:read', 'leads:read']);
    const me = (await h.call('GET', '/api/auth/me', { token: reader.token })).json;
    expect(me.user.permissions).toEqual(['funnels:read', 'leads:read']);
    expect(me.user.roleName).toMatch(/^Role /);
    expect((await h.call('GET', '/api/funnels', { token: reader.token })).status).toBe(200);
    expect((await h.call('GET', '/api/leads', { token: reader.token })).status).toBe(200);
    expect((await h.call('POST', '/api/funnels', { token: reader.token, body: { name: 'x' } })).status).toBe(403);
    expect((await h.call('GET', '/api/orders', { token: reader.token })).status).toBe(403);
  });

  it('editing a role changes the permissions of its holders on their very next request', async () => {
    const { h, owner } = await world();
    const m = await h.memberWith(owner, ['funnels:read']);
    expect((await h.call('GET', '/api/orders', { token: m.token })).status).toBe(403);
    const edit = await h.call('PATCH', `/api/roles/${m.roleId}`, { token: owner.token, body: { permissions: ['funnels:read', 'orders:read'] } });
    expect(edit.status).toBe(200);
    expect((await h.call('GET', '/api/orders', { token: m.token })).status).toBe(200);
  });

  it('a holder of roles:manage cannot create or edit a role with permissions they lack (no privilege escalation)', async () => {
    const { h, owner } = await world();
    const mgr = await h.memberWith(owner, ['roles:manage', 'funnels:read']);
    const create = await h.call('POST', '/api/roles', { token: mgr.token, body: { name: 'Sneaky', permissions: ['funnels:read', 'billing:manage'] } });
    expect(create.status).toBe(403);
    expect(create.json.error.message).toContain('billing:manage');
    const ok = await h.call('POST', '/api/roles', { token: mgr.token, body: { name: 'Fine', permissions: ['funnels:read'] } });
    expect(ok.status).toBe(201);
    // cannot edit someone else's more powerful role either, not even to remove permissions
    const powerful = (await h.call('POST', '/api/roles', { token: owner.token, body: { name: 'Powerful', permissions: ['funnels:read', 'domains:manage'] } })).json;
    expect((await h.call('PATCH', `/api/roles/${powerful.id}`, { token: mgr.token, body: { permissions: ['funnels:read'] } })).status).toBe(403);
    expect((await h.call('DELETE', `/api/roles/${powerful.id}`, { token: mgr.token })).status).toBe(403);
    // and cannot promote themselves by editing their own role
    expect((await h.call('PATCH', `/api/roles/${mgr.roleId}`, { token: mgr.token, body: { permissions: ['roles:manage', 'funnels:read', 'members:manage'] } })).status).toBe(403);
  });

  it('a holder of members:manage cannot hand out roles above their own, and cannot touch an owner', async () => {
    const { h, owner } = await world();
    const hr = await h.memberWith(owner, ['members:manage', 'members:read', 'funnels:read']);
    const victim = await h.member(owner, 'member');
    expect((await h.call('PATCH', `/api/members/${victim.userId}`, { token: hr.token, body: { roleId: 'admin' } })).status).toBe(403);
    expect((await h.call('PATCH', `/api/members/${victim.userId}`, { token: hr.token, body: { roleId: 'viewer' } })).status).toBe(403); // viewer holds permissions hr lacks (leads:read...)
    const ownerRow = (await h.call('GET', '/api/auth/me', { token: owner.token })).json.user.id;
    expect((await h.call('PATCH', `/api/members/${ownerRow}`, { token: hr.token, body: { roleId: 'viewer' } })).status).toBe(403);
    expect((await h.call('DELETE', `/api/members/${ownerRow}`, { token: hr.token })).status).toBe(403);
    expect((await h.call('POST', '/api/invitations', { token: hr.token, body: { email: 'new@example.test', roleId: 'owner' } })).status).toBe(403);
  });

  it('built-in roles cannot be edited or deleted; custom role names are unique and cannot shadow built-in ones; unknown permissions are rejected', async () => {
    const { h, owner } = await world();
    expect((await h.call('PATCH', '/api/roles/admin', { token: owner.token, body: { permissions: [] } })).status).toBe(403);
    expect((await h.call('DELETE', '/api/roles/owner', { token: owner.token })).status).toBe(403);
    expect((await h.call('POST', '/api/roles', { token: owner.token, body: { name: 'admin', permissions: [] } })).json.error.code).toBe('ROLE_NAME_TAKEN');
    expect((await h.call('POST', '/api/roles', { token: owner.token, body: { name: 'Support', permissions: [] } })).status).toBe(201);
    expect((await h.call('POST', '/api/roles', { token: owner.token, body: { name: 'Support', permissions: [] } })).json.error.code).toBe('ROLE_NAME_TAKEN');
    const bad = await h.call('POST', '/api/roles', { token: owner.token, body: { name: 'Bad', permissions: ['funnels:read', 'everything:all'] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('UNKNOWN_PERMISSION');
  });

  it('a role in use cannot be deleted; once its members move it can', async () => {
    const { h, owner } = await world();
    const m = await h.memberWith(owner, ['funnels:read']);
    const blocked = await h.call('DELETE', `/api/roles/${m.roleId}`, { token: owner.token });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('ROLE_IN_USE');
    await h.call('PATCH', `/api/members/${m.userId}`, { token: owner.token, body: { roleId: 'viewer' } });
    expect((await h.call('DELETE', `/api/roles/${m.roleId}`, { token: owner.token })).status).toBe(204);
  });

  it('a workspace keeps at least one owner; a second owner makes demotion and removal possible', async () => {
    const { h, owner } = await world();
    const ownerId = (await h.call('GET', '/api/auth/me', { token: owner.token })).json.user.id;
    const second = await h.member(owner, 'owner');
    expect((await h.call('PATCH', `/api/members/${second.userId}`, { token: owner.token, body: { roleId: 'admin' } })).status).toBe(200);
    expect((await h.call('PATCH', `/api/members/${second.userId}`, { token: owner.token, body: { roleId: 'owner' } })).status).toBe(200);
    expect((await h.call('PATCH', `/api/members/${ownerId}`, { token: second.token, body: { roleId: 'member' } })).status).toBe(200); // another owner remains
    expect((await h.call('PATCH', `/api/members/${second.userId}`, { token: second.token, body: { roleId: 'member' } })).json.error.code).toBe('LAST_OWNER');
  });

  it('roles never leak across workspaces: a foreign role id is 404 for assignment and invitation', async () => {
    const { h, owner } = await world();
    const other = await h.register();
    const foreign = (await h.call('POST', '/api/roles', { token: other.token, body: { name: 'Theirs', permissions: ['funnels:read'] } })).json;
    const mine = await h.member(owner, 'member');
    expect((await h.call('PATCH', `/api/members/${mine.userId}`, { token: owner.token, body: { roleId: foreign.id } })).status).toBe(404);
    expect((await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'x@example.test', roleId: foreign.id } })).status).toBe(404);
    expect((await h.call('PATCH', `/api/roles/${foreign.id}`, { token: owner.token, body: { name: 'Hijack' } })).status).toBe(404);
    const roles = (await h.call('GET', '/api/roles', { token: owner.token })).json.data as { name: string }[];
    expect(roles.some((r) => r.name === 'Theirs')).toBe(false);
  });

  it('funnels:tracking (enforced in the service) lets a custom role edit tracking code; funnels:write alone does not', async () => {
    const { h, owner } = await world();
    const without = await h.memberWith(owner, ['funnels:read', 'funnels:write']);
    const withTracking = await h.memberWith(owner, ['funnels:read', 'funnels:write', 'funnels:tracking']);
    const f = (await h.call('POST', '/api/funnels', { token: without.token, body: { name: 'x' } })).json;
    const patch = (token: string) => h.call('PATCH', `/api/funnels/${f.id}`, { token, body: { header_tracking_code: '<script>1</script>' } });
    expect((await patch(without.token)).status).toBe(403);
    expect((await patch(withTracking.token)).status).toBe(200);
  });

  it('the built-in roles behave as documented: viewer is read-only, member builds, admin manages domains and webhooks but not people or billing', async () => {
    const { h, owner } = await world();
    const viewer = await h.member(owner, 'viewer');
    const member = await h.member(owner, 'member');
    const admin = await h.member(owner, 'admin');
    expect((await h.call('GET', '/api/funnels', { token: viewer.token })).status).toBe(200);
    expect((await h.call('POST', '/api/funnels', { token: viewer.token, body: { name: 'x' } })).status).toBe(403);
    expect((await h.call('POST', '/api/funnels', { token: member.token, body: { name: 'x' } })).status).toBe(201);
    expect((await h.call('POST', '/api/domains', { token: member.token, body: { hostname: 'm.example.com' } })).status).toBe(403);
    expect((await h.call('POST', '/api/domains', { token: admin.token, body: { hostname: 'a.example.com' } })).status).toBe(201);
    expect((await h.call('POST', '/api/invitations', { token: admin.token, body: { email: 'n@example.test', roleId: 'member' } })).status).toBe(403);
    expect((await h.call('GET', '/api/audit', { token: admin.token })).status).toBe(200);
    expect((await h.call('GET', '/api/audit', { token: member.token })).status).toBe(403);
    expect(SYSTEM_ROLES.admin.permissions).not.toContain('billing:manage');
  });
});
