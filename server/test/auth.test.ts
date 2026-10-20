import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { signAccessToken, verifyAccessToken } from '../src/auth/tokens.js';
import { makeHarness, tamperSignature, type Harness } from './helpers.js';

describe('password hashing', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('secret-password');
    const b = await hashPassword('secret-password');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('secret-password', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('auth', () => {
  it('registers an owner with a workspace and returns a usable token', async () => {
    const h = await makeHarness();
    const r = await h.call('POST', '/api/auth/register', { body: { email: 'Ann@Example.test', password: 'long-enough-pw', name: 'Ann' } });
    expect(r.status).toBe(201);
    expect(r.json.user).toMatchObject({ email: 'ann@example.test', role: 'owner' });
    const me = await h.call('GET', '/api/auth/me', { token: r.json.token });
    expect(me.status).toBe(200);
    expect(me.json.workspace.id).toBe(r.json.user.workspaceId);
  });

  it('rejects duplicate emails (case-insensitive), short passwords and bad emails', async () => {
    const h = await makeHarness();
    await h.register('dup@example.test');
    expect((await h.call('POST', '/api/auth/register', { body: { email: 'DUP@example.test', password: 'long-enough-pw', name: 'x' } })).json.error.code).toBe('EMAIL_TAKEN');
    expect((await h.call('POST', '/api/auth/register', { body: { email: 'a@b.test', password: 'short', name: 'x' } })).status).toBe(400);
    expect((await h.call('POST', '/api/auth/register', { body: { email: 'nope', password: 'long-enough-pw', name: 'x' } })).json.error.code).toBe('VALIDATION_ERROR');
    expect((await h.call('POST', '/api/auth/register', { raw: '{bad json' })).json.error.code).toBe('INVALID_JSON');
  });

  it('logs in, and treats wrong password and unknown email identically', async () => {
    const h = await makeHarness();
    await h.register('login@example.test');
    const ok = await h.call('POST', '/api/auth/login', { body: { email: 'login@example.test', password: 'correct horse battery' } });
    expect(ok.status).toBe(200);
    const bad = await h.call('POST', '/api/auth/login', { body: { email: 'login@example.test', password: 'nope' } });
    const none = await h.call('POST', '/api/auth/login', { body: { email: 'ghost@example.test', password: 'nope' } });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.json.error.message).toBe(none.json.error.message);
  });

  it('rejects missing, malformed, tampered, wrong-use and expired tokens', async () => {
    const h = await makeHarness({ env: { ACCESS_TOKEN_TTL_SECONDS: String(12 * 3600) } });
    const u = await h.register();
    expect((await h.call('GET', '/api/funnels')).status).toBe(401);
    expect((await h.call('GET', '/api/funnels', { token: 'garbage' })).status).toBe(401);
    expect((await h.call('GET', '/api/funnels', { token: tamperSignature(u.token) })).status).toBe(401);
    const preview = await h.call('POST', '/api/funnels', { token: u.token, body: { name: 'x' } });
    const pt = await h.call('POST', `/api/funnels/${preview.json.id}/preview-token`, { token: u.token });
    expect((await h.call('GET', '/api/funnels', { token: pt.json.token })).status).toBe(401); // preview token is not an access token
    h.clock.advance(13 * 3600 * 1000);
    expect((await h.call('GET', '/api/funnels', { token: u.token })).status).toBe(401);
    expect(await verifyAccessToken(h.deps.config, u.token, h.clock.now())).toBeNull();
    const fresh = await signAccessToken(h.deps.config, u.userId, 'ses_x', h.clock.now());
    expect((await verifyAccessToken(h.deps.config, fresh, h.clock.now()))?.userId).toBe(u.userId);
  });

  it('explains why signature tampering must not target the last character: its 2 trailing bits are unused, so A-D decode alike', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const [head, payload, sig] = u.token.split('.');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const accepted = [] as string[];
    for (const c of alphabet) {
      const variant = `${head}.${payload}.${sig!.slice(0, -1)}${c}`;
      if ((await h.call('GET', '/api/auth/me', { token: variant })).status === 200) accepted.push(c);
    }
    // exactly the characters that share the original's 4 significant bits are accepted: 4 of 64, which is what made a naive "change the last char" test flaky
    expect(accepted).toHaveLength(4);
    expect(accepted).toContain(sig!.slice(-1));
    expect((await h.call('GET', '/api/auth/me', { token: tamperSignature(u.token) })).status).toBe(401);
  });

  it('a deleted user token stops working', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const m = await h.member(owner, 'member');
    expect((await h.call('GET', '/api/auth/me', { token: m.token })).status).toBe(200);
    await h.call('DELETE', `/api/members/${m.userId}`, { token: owner.token });
    expect((await h.call('GET', '/api/auth/me', { token: m.token })).status).toBe(401);
  });

  it('rate limits login attempts with 429 and Retry-After', async () => {
    const h = await makeHarness({ env: { AUTH_ATTEMPTS_PER_MINUTE: '3' } });
    const attempt = () => h.call('POST', '/api/auth/login', { body: { email: 'x@example.test', password: 'bad' } });
    expect((await attempt()).status).toBe(401);
    await attempt();
    await attempt();
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    h.clock.advance(61_000);
    expect((await attempt()).status).toBe(401);
  });
});

describe('roles', () => {
  it('only owners manage members and workspace settings', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const admin = await h.member(owner, 'admin');
    const member = await h.member(owner, 'member');
    for (const t of [admin, member]) {
      expect((await h.call('POST', '/api/invitations', { token: t.token, body: { email: 'z@example.test', roleId: 'member' } })).status).toBe(403);
      expect((await h.call('PATCH', '/api/workspace', { token: t.token, body: { name: 'Hacked' } })).status).toBe(403);
    }
    expect((await h.call('PATCH', '/api/workspace', { token: owner.token, body: { name: 'Acme', allowCustomScripts: true } })).json).toMatchObject({ name: 'Acme', allowCustomScripts: true });
    expect((await h.call('GET', '/api/members', { token: member.token })).json.data).toHaveLength(3);
  });

  it('members cannot delete funnels, manage domains or webhooks; admins can', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const admin = await h.member(owner, 'admin');
    const member = await h.member(owner, 'member');
    const f = (await h.call('POST', '/api/funnels', { token: member.token, body: { name: 'Member funnel' } })).json;
    expect((await h.call('DELETE', `/api/funnels/${f.id}`, { token: member.token })).status).toBe(403);
    expect((await h.call('POST', '/api/domains', { token: member.token, body: { hostname: 'a.example.com' } })).status).toBe(403);
    expect((await h.call('GET', '/api/webhooks', { token: member.token })).status).toBe(403);
    expect((await h.call('POST', '/api/webhooks', { token: member.token, body: { url: 'https://hooks.example.com/x', events: ['funnel.optin'] } })).status).toBe(403);
    expect((await h.call('GET', '/api/domains', { token: member.token })).status).toBe(200);
    expect((await h.call('POST', '/api/domains', { token: admin.token, body: { hostname: 'a.example.com' } })).status).toBe(201);
    expect((await h.call('POST', '/api/webhooks', { token: admin.token, body: { url: 'https://hooks.example.com/x', events: ['funnel.optin'] } })).status).toBe(201);
    expect((await h.call('DELETE', `/api/funnels/${f.id}`, { token: admin.token })).status).toBe(204);
  });

  it('only owners purge; the last owner is protected', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const admin = await h.member(owner, 'admin');
    const f = (await h.call('POST', '/api/funnels', { token: admin.token, body: { name: 'x' } })).json;
    await h.call('DELETE', `/api/funnels/${f.id}`, { token: admin.token });
    expect((await h.call('DELETE', `/api/funnels/${f.id}/purge`, { token: admin.token })).status).toBe(403);
    expect((await h.call('DELETE', `/api/funnels/${f.id}/purge`, { token: owner.token })).status).toBe(204);
    const me = await h.call('GET', '/api/auth/me', { token: owner.token });
    // the last owner can be neither demoted nor removed, and nobody removes themselves
    const demote = await h.call('PATCH', `/api/members/${me.json.user.id}`, { token: owner.token, body: { roleId: 'member' } });
    expect(demote.status).toBe(409);
    expect(demote.json.error.code).toBe('LAST_OWNER');
    expect((await h.call('DELETE', `/api/members/${me.json.user.id}`, { token: owner.token })).status).toBe(400);
    // an admin cannot touch the owner at all (it lacks permissions the owner has)
    expect((await h.call('PATCH', `/api/members/${me.json.user.id}`, { token: admin.token, body: { roleId: 'member' } })).status).toBe(403);
  });

  it('role changes apply immediately to existing tokens', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const m = await h.member(owner, 'admin');
    expect((await h.call('GET', '/api/webhooks', { token: m.token })).status).toBe(200);
    await h.call('PATCH', `/api/members/${m.userId}`, { token: owner.token, body: { roleId: 'member' } });
    expect((await h.call('GET', '/api/webhooks', { token: m.token })).status).toBe(403);
  });

  it('tracking code and scripts are admin/owner only', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const member = await h.member(owner, 'member');
    const f = (await h.call('POST', '/api/funnels', { token: member.token, body: { name: 'x' } })).json;
    expect((await h.call('PATCH', `/api/funnels/${f.id}`, { token: member.token, body: { header_tracking_code: '<script>1</script>' } })).status).toBe(403);
    expect((await h.call('PATCH', `/api/funnels/${f.id}`, { token: owner.token, body: { header_tracking_code: '<script>1</script>' } })).status).toBe(200);
  });
});
