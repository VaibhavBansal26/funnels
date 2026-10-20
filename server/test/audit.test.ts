import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers.js';

describe('audit log', () => {
  it('records sign-in, members, roles, invitations and workspace changes with actor, target and IP, never secrets', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '100000', API_WORKSPACE_PER_MINUTE: '100000' } });
    const owner = await h.register();
    const role = (await h.call('POST', '/api/roles', { token: owner.token, body: { name: 'Support', permissions: ['funnels:read'] } })).json;
    await h.call('PATCH', `/api/roles/${role.id}`, { token: owner.token, body: { permissions: ['funnels:read', 'leads:read'] } });
    const m = await h.member(owner, role.id, 'agent@example.test');
    await h.call('PATCH', `/api/members/${m.userId}`, { token: owner.token, body: { roleId: 'viewer' } });
    await h.call('PATCH', '/api/workspace', { token: owner.token, body: { name: 'Acme' } });
    await h.call('DELETE', `/api/members/${m.userId}`, { token: owner.token });
    const log = (await h.call('GET', '/api/audit?limit=100', { token: owner.token })).json.data as { action: string; actorId: string; target: string | null; ip: string | null; detail: Record<string, unknown> }[];
    const actions = log.map((l) => l.action);
    for (const a of ['auth.register', 'role.created', 'role.updated', 'invitation.created', 'invitation.accepted', 'member.role_changed', 'workspace.updated', 'member.removed']) expect(actions, a).toContain(a);
    const updated = log.find((l) => l.action === 'role.updated')!;
    expect(updated.detail).toMatchObject({ added: ['leads:read'], removed: [] });
    expect(log.find((l) => l.action === 'member.role_changed')).toMatchObject({ target: m.userId, detail: { to: 'viewer' } });
    expect(log.find((l) => l.action === 'role.created')!.ip).toBe('203.0.113.7');
    const text = JSON.stringify(log);
    expect(text).not.toMatch(/password|token=|rt_/i);
  });

  it('is newest first, filterable by action and actor, and paginates with an opaque cursor without gaps or repeats', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '100000', API_WORKSPACE_PER_MINUTE: '100000' } });
    const owner = await h.register();
    for (let i = 0; i < 7; i++) {
      h.clock.advance(1000);
      await h.call('POST', '/api/roles', { token: owner.token, body: { name: `R${i}`, permissions: [] } });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const r: { json: { data: { id: string; action: string }[]; nextCursor: string | null } } = await h.call('GET', `/api/audit?limit=3${cursor ? `&cursor=${cursor}` : ''}`, { token: owner.token });
      ids.push(...r.json.data.map((d) => d.id));
      cursor = r.json.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toHaveLength(8); // register + 7 roles
    expect(new Set(ids).size).toBe(8);
    const created = (await h.call('GET', '/api/audit?action=role.created&limit=100', { token: owner.token })).json.data as { action: string; detail: { name: string } }[];
    expect(created.map((c) => c.detail.name)).toEqual(['R6', 'R5', 'R4', 'R3', 'R2', 'R1', 'R0']);
    const me = (await h.call('GET', '/api/auth/me', { token: owner.token })).json.user.id;
    expect(((await h.call('GET', `/api/audit?actor=${me}&limit=100`, { token: owner.token })).json.data as unknown[]).length).toBe(8);
    expect(((await h.call('GET', '/api/audit?actor=someone-else', { token: owner.token })).json.data as unknown[]).length).toBe(0);
  });

  it('needs audit:read and is scoped to the workspace', async () => {
    const h = await makeHarness();
    const a = await h.register();
    const b = await h.register();
    const reader = await h.memberWith(a, ['audit:read']);
    const nobody = await h.memberWith(a, ['funnels:read']);
    expect((await h.call('GET', '/api/audit', { token: nobody.token })).status).toBe(403);
    const mine = (await h.call('GET', '/api/audit?limit=100', { token: reader.token })).json.data as { actorId: string }[];
    expect(mine.length).toBeGreaterThan(0);
    const theirs = (await h.call('GET', '/api/audit?limit=100', { token: b.token })).json.data as { actorId: string }[];
    expect(theirs.every((r) => r.actorId === b.userId)).toBe(true);
    expect(theirs.some((r) => mine.some((m) => m.actorId === r.actorId && m.actorId !== r.actorId))).toBe(false);
  });

  it('login lockout is audited once per lock and logins are recorded', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    await h.call('POST', '/api/auth/login', { body: { email: owner.email, password: 'correct horse battery' } });
    for (let i = 0; i < 9; i++) await h.call('POST', '/api/auth/login', { body: { email: owner.email, password: 'wrong' } });
    const actions = (await h.deps.db.all<{ action: string }>('SELECT action FROM audit_log ORDER BY created_at, id')).map((r) => r.action);
    expect(actions.filter((a) => a === 'auth.login')).toHaveLength(1);
    expect(actions.filter((a) => a === 'auth.locked_out')).toHaveLength(1);
  });
});
