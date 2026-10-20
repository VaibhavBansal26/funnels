import { describe, expect, it } from 'vitest';
import { makeHarness } from './helpers.js';

const login = (h: Awaited<ReturnType<typeof makeHarness>>, email: string, password = 'correct horse battery') => h.call('POST', '/api/auth/login', { body: { email, password } });

describe('sessions and refresh tokens', () => {
  it('login returns an access token, a refresh token and the permissions; logout ends exactly that session', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const a = (await login(h, u.email)).json;
    const b = (await login(h, u.email)).json;
    expect(a).toMatchObject({ expiresIn: expect.any(Number), refreshToken: expect.stringMatching(/^rt_/), user: { permissions: expect.arrayContaining(['funnels:read']) } });
    expect((await h.call('GET', '/api/auth/me', { token: a.token })).status).toBe(200);
    expect((await h.call('POST', '/api/auth/logout', { token: a.token })).status).toBe(204);
    expect((await h.call('GET', '/api/auth/me', { token: a.token })).status).toBe(401); // the access token dies with its session, long before it expires
    expect((await h.call('GET', '/api/auth/me', { token: b.token })).status).toBe(200); // the other session is untouched
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: a.refreshToken } })).status).toBe(401); // and so does its refresh token
  });

  it('refresh rotates: the new tokens work, the old refresh token is spent', async () => {
    const h = await makeHarness({ env: { REFRESH_REUSE_GRACE_SECONDS: '0' } });
    const u = await h.register();
    const r1 = await h.call('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } });
    expect(r1.status).toBe(200);
    expect(r1.json.refreshToken).not.toBe(u.refreshToken);
    expect((await h.call('GET', '/api/auth/me', { token: r1.json.token })).status).toBe(200);
    const r2 = await h.call('POST', '/api/auth/refresh', { body: { refreshToken: r1.json.refreshToken } });
    expect(r2.status).toBe(200);
  });

  it('reuse of a spent refresh token revokes the whole session (theft detection), including the newest tokens', async () => {
    const h = await makeHarness({ env: { REFRESH_REUSE_GRACE_SECONDS: '0' } });
    const u = await h.register();
    const stolen = u.refreshToken;
    const legit = (await h.call('POST', '/api/auth/refresh', { body: { refreshToken: stolen } })).json;
    h.clock.advance(1000);
    const replay = await h.call('POST', '/api/auth/refresh', { body: { refreshToken: stolen } });
    expect(replay.status).toBe(401);
    expect((await h.call('GET', '/api/auth/me', { token: legit.token })).status).toBe(401); // the legitimate holder is signed out too: they must sign in again
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: legit.refreshToken } })).status).toBe(401);
    const reuse = (await h.deps.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action = 'session.refresh_reuse_detected'")).length;
    expect(reuse).toBe(1);
  });

  it('two tabs refreshing at once is a race, not theft: one wins, the other gets REFRESH_RACE and the session survives', async () => {
    const h = await makeHarness({ env: { REFRESH_REUSE_GRACE_SECONDS: '10' } });
    const u = await h.register();
    const [a, b] = await Promise.all([1, 2].map(() => h.call('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })));
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    const loser = a.status === 401 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect(loser.json.error.code).toBe('REFRESH_RACE');
    expect((await h.call('GET', '/api/auth/me', { token: winner.json.token })).status).toBe(200);
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: winner.json.refreshToken } })).status).toBe(200);
  });

  it('access tokens are short-lived and the refresh token renews them; refresh tokens and sessions have their own limits', async () => {
    const h = await makeHarness({ env: { ACCESS_TOKEN_TTL_SECONDS: '900', REFRESH_TOKEN_TTL_DAYS: '30', SESSION_MAX_DAYS: '40' } });
    const u = await h.register();
    h.clock.advance(901_000);
    expect((await h.call('GET', '/api/auth/me', { token: u.token })).status).toBe(401); // expired access token
    let tokens = (await h.call('POST', '/api/auth/refresh', { body: { refreshToken: u.refreshToken } })).json;
    expect((await h.call('GET', '/api/auth/me', { token: tokens.token })).status).toBe(200);
    // An active user keeps rolling: day 20 is inside both the 30-day refresh lifetime and the 40-day session cap...
    h.clock.advance(20 * 86_400_000);
    const day20 = await h.call('POST', '/api/auth/refresh', { body: { refreshToken: tokens.refreshToken } });
    expect(day20.status).toBe(200);
    tokens = day20.json;
    // ...but day 40 is past SESSION_MAX_DAYS, whatever the activity: the session ends and the user signs in again.
    h.clock.advance(20 * 86_400_000);
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: tokens.refreshToken } })).status).toBe(401);
    expect((await h.call('GET', '/api/auth/me', { token: tokens.token })).status).toBe(401);
    const idle = await makeHarness({ env: { REFRESH_TOKEN_TTL_DAYS: '30' } });
    const v = await idle.register();
    idle.clock.advance(31 * 86_400_000);
    expect((await idle.call('POST', '/api/auth/refresh', { body: { refreshToken: v.refreshToken } })).status).toBe(401); // unused for longer than the refresh lifetime
  });

  it('lists your sessions (the current one flagged), ends one, ends all the others; you cannot touch someone else\'s', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const other = await h.register();
    const s2 = (await login(h, u.email)).json;
    const s3 = (await login(h, u.email)).json;
    const list = (await h.call('GET', '/api/auth/sessions', { token: u.token })).json.data as { id: string; current: boolean }[];
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const s2id = (await h.call('GET', '/api/auth/me', { token: s2.token })).json.sessionId;
    expect((await h.call('DELETE', `/api/auth/sessions/${s2id}`, { token: other.token })).status).toBe(404);
    expect((await h.call('DELETE', `/api/auth/sessions/${s2id}`, { token: u.token })).status).toBe(204);
    expect((await h.call('GET', '/api/auth/me', { token: s2.token })).status).toBe(401);
    const revoked = await h.call('POST', '/api/auth/sessions/revoke-others', { token: u.token });
    expect(revoked.json.revoked).toBe(1);
    expect((await h.call('GET', '/api/auth/me', { token: s3.token })).status).toBe(401);
    expect((await h.call('GET', '/api/auth/me', { token: u.token })).status).toBe(200);
  });

  it('changing the password ends the other sessions, keeps this one, and needs the current password', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const other = (await login(h, u.email)).json;
    expect((await h.call('POST', '/api/auth/password', { token: u.token, body: { currentPassword: 'wrong password', newPassword: 'a brand new password' } })).json.error.code).toBe('WRONG_PASSWORD');
    const ok = await h.call('POST', '/api/auth/password', { token: u.token, body: { currentPassword: 'correct horse battery', newPassword: 'a brand new password' } });
    expect(ok.json).toEqual({ ok: true, otherSessionsEnded: 1 });
    expect((await h.call('GET', '/api/auth/me', { token: u.token })).status).toBe(200);
    expect((await h.call('GET', '/api/auth/me', { token: other.token })).status).toBe(401);
    expect((await login(h, u.email)).status).toBe(401);
    expect((await login(h, u.email, 'a brand new password')).status).toBe(200);
  });

  it('removing a member ends their sessions; a stream ticket is tied to the session that asked for it', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const m = await h.member(owner, 'member');
    const ticket = (await h.call('POST', '/api/events/ticket', { token: m.token })).json.ticket as string;
    await h.call('POST', '/api/auth/logout', { token: m.token });
    const stream = await h.app.request(`/api/events/stream?ticket=${ticket}`);
    expect(stream.status).toBe(401);
    const m2 = await h.member(owner, 'member');
    await h.call('DELETE', `/api/members/${m2.userId}`, { token: owner.token });
    expect((await h.call('GET', '/api/auth/me', { token: m2.token })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: m2.refreshToken } })).status).toBe(401);
  });

  it('a refresh token is stored only as a hash, and malformed ones are rejected before any lookup', async () => {
    const h = await makeHarness();
    const u = await h.register();
    const rows = await h.deps.db.all<{ token_hash: string }>('SELECT token_hash FROM refresh_tokens');
    expect(rows.every((r) => r.token_hash !== u.refreshToken && /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: 'short' } })).status).toBe(400);
    expect((await h.call('POST', '/api/auth/refresh', { body: { refreshToken: 'rt_' + 'x'.repeat(40) } })).status).toBe(401);
  });
});
