import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, isPermission, SYSTEM_ROLES, type Permission } from '../src/auth/permissions.js';
import { OPERATIONS } from '../src/routes/spec.js';
import { makeHarness } from './helpers.js';

/** Permissions that exist in the catalogue before any route needs them (their features are not built yet). The list only ever shrinks: a permission that is neither used nor listed here fails the test. */
const RESERVED = new Set<Permission>(['billing:read', 'billing:manage']);

/** Permissions enforced inside a service because they depend on the request body (not on which route is called); covered by `rbac.test.ts`. */
const ENFORCED_IN_SERVICES = new Set<Permission>(['funnels:tracking']);

describe('central route policy', () => {
  it('every authenticated route declares exactly one valid permission; every other kind of route declares none', () => {
    for (const o of OPERATIONS) {
      if (o.auth === 'user') {
        expect(o.permission, `${o.method} ${o.path} has no permission`).toBeDefined();
        if (o.permission !== 'any') expect(isPermission(o.permission!), `${o.method} ${o.path}: unknown permission ${o.permission}`).toBe(true);
      } else {
        expect(o.permission, `${o.method} ${o.path} (${o.auth}) must not declare a permission`).toBeUndefined();
        expect(o.also, `${o.method} ${o.path} (${o.auth}) must not declare further permissions`).toBeUndefined();
      }
      if (o.auth === 'apikey') expect(o.apiScope, `${o.method} ${o.path} needs an API key scope`).toBeDefined();
    }
  });

  it("the routes open to every signed-in member ('any') are exactly this list; adding one is a deliberate edit here", () => {
    const any = OPERATIONS.filter((o) => o.permission === 'any').map((o) => `${o.method} ${o.path}`).sort();
    expect(any).toEqual([
      'DELETE /api/auth/sessions/:id', 'GET /api/auth/me', 'GET /api/auth/sessions', 'GET /api/events/stream', 'GET /api/notifications', 'GET /api/permissions', 'GET /api/workspace',
      'POST /api/auth/2fa/disable', 'POST /api/auth/2fa/enable', 'POST /api/auth/2fa/recovery-codes', 'POST /api/auth/2fa/setup', 'POST /api/auth/logout', 'POST /api/auth/password',
      'POST /api/auth/sessions/revoke-others', 'POST /api/events/ticket', 'POST /api/notifications/:id/read', 'POST /api/notifications/read-all',
    ].sort());
  });

  it('the catalogue has no dead permissions: each is used by a route or explicitly reserved', () => {
    const used = new Set([...OPERATIONS.map((o) => o.permission), ...OPERATIONS.flatMap((o) => o.also ?? [])].filter((p): p is Permission => !!p && p !== 'any'));
    expect(ALL_PERMISSIONS.filter((p) => !used.has(p) && !RESERVED.has(p) && !ENFORCED_IN_SERVICES.has(p))).toEqual([]);
    expect([...RESERVED].filter((p) => used.has(p)), 'a reserved permission got a route: remove it from RESERVED').toEqual([]);
  });

  it('built-in roles only contain catalogue permissions, and the owner has all of them', () => {
    for (const r of Object.values(SYSTEM_ROLES)) expect(r.permissions.every(isPermission), r.id).toBe(true);
    expect(new Set(SYSTEM_ROLES.owner.permissions)).toEqual(new Set(ALL_PERMISSIONS));
    expect(SYSTEM_ROLES.viewer.permissions.some((p) => /:(write|manage|delete|purge|export)$/.test(p)), 'the viewer role must be read-only').toBe(false);
  });

  it('every authenticated route refuses a role that has every permission EXCEPT the one it needs, and admits a role that has only that one', async () => {
    const h = await makeHarness({ env: { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000' } }); // this test makes hundreds of requests as a few users
    const owner = await h.register();
    const fill = (p: string) => p.replace(/:[A-Za-z]+/g, 'x');
    const call = (o: (typeof OPERATIONS)[number], token: string) => h.call(o.method, fill(o.path), { token, body: o.method === 'GET' || o.method === 'DELETE' ? undefined : {} });
    const skip = (o: (typeof OPERATIONS)[number]) => o.path === '/api/events/stream'; // an endless stream; its authorization is the same code path as every other route
    const ops = OPERATIONS.filter((o) => o.auth === 'user' && !skip(o));

    const permissions = [...new Set(ops.map((o) => o.permission).filter((p): p is Permission => !!p && p !== 'any'))];
    const but = new Map<Permission, string>();
    for (const p of new Set([...permissions, ...ops.flatMap((o) => o.also ?? [])])) but.set(p, (await h.memberWith(owner, ALL_PERMISSIONS.filter((x) => x !== p))).token);
    const onlyKey = (o: (typeof OPERATIONS)[number]) => [o.permission as Permission, ...(o.also ?? [])].sort().join('+');
    const only = new Map<string, string>();
    for (const o of ops) if (o.permission !== 'any' && !only.has(onlyKey(o))) only.set(onlyKey(o), (await h.memberWith(owner, [o.permission as Permission, ...(o.also ?? [])])).token);
    const nobody = (await h.memberWith(owner, [])).token;

    const failures: string[] = [];
    for (const o of ops) {
      const label = `${o.method} ${o.path} [${o.permission}]`;
      if (o.permission === 'any') {
        if (o.path === '/api/auth/logout' || o.path === '/api/auth/sessions/revoke-others') continue; // would end the session the next calls use
        const r = await call(o, nobody);
        if (r.status === 401 || r.status === 403) failures.push(`${label}: a member with no permissions was refused (${r.status})`);
        continue;
      }
      const p = o.permission as Permission;
      const refused = await call(o, but.get(p)!);
      if (refused.status !== 403) failures.push(`${label}: a role with everything but "${p}" got ${refused.status}, expected 403`);
      for (const extra of o.also ?? []) {
        const short = await call(o, but.get(extra)!);
        if (short.status !== 403) failures.push(`${label}: a role with everything but the extra "${extra}" got ${short.status}, expected 403`);
      }
      const admitted = await call(o, only.get(onlyKey(o))!);
      if (admitted.status === 403 || admitted.status === 401) failures.push(`${label}: a role holding only "${p}"${o.also?.length ? ` and ${o.also.join(', ')}` : ''} got ${admitted.status}`);
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
