import { describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers.js';

const tokenFrom = (h: Harness, email: string) => new URL(h.mailer.linkTo(email)!).searchParams.get('token')!;
const world = async (env: Record<string, string> = {}) => {
  const h = await makeHarness({ env });
  return { h, owner: await h.register() };
};

describe('invitations', () => {
  it('mails a one-time link (never returned by the API when mail was delivered); accepting creates the account with the role and signs it in', async () => {
    const { h, owner } = await world();
    const r = await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'Ada@Example.test', roleId: 'viewer' } });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ delivered: true, invitation: { email: 'ada@example.test', roleName: 'Viewer', status: 'pending' } });
    expect(r.json.link).toBeUndefined();
    expect(JSON.stringify(r.json)).not.toContain('token=');
    const mail = h.mailer.sent.at(-1)!;
    expect(mail.to).toBe('ada@example.test');
    expect(mail.text).toContain('/accept-invite?token=');
    const token = tokenFrom(h, 'ada@example.test');
    const look = await h.call('GET', `/api/auth/invitations/lookup?token=${token}`);
    expect(look.json).toMatchObject({ email: 'ada@example.test', roleName: 'Viewer' });
    const accepted = await h.call('POST', '/api/auth/invitations/accept', { body: { token, name: 'Ada', password: 'correct horse battery' } });
    expect(accepted.status).toBe(201);
    expect(accepted.json.user).toMatchObject({ email: 'ada@example.test', roleId: 'viewer', permissions: expect.arrayContaining(['funnels:read']) });
    expect((await h.call('GET', '/api/funnels', { token: accepted.json.token })).status).toBe(200);
    expect((await h.call('POST', '/api/funnels', { token: accepted.json.token, body: { name: 'x' } })).status).toBe(403);
    const list = (await h.call('GET', '/api/invitations', { token: owner.token })).json.data as { status: string }[];
    expect(list[0]!.status).toBe('accepted');
  });

  it('the link works once; used, unknown, revoked and expired links all answer the same 404', async () => {
    const { h, owner } = await world({ INVITATION_TTL_DAYS: '7' });
    await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'a@example.test', roleId: 'member' } });
    const t1 = tokenFrom(h, 'a@example.test');
    const accept = (token: string) => h.call('POST', '/api/auth/invitations/accept', { body: { token, name: 'A', password: 'correct horse battery' } });
    expect((await accept(t1)).status).toBe(201);
    expect((await accept(t1)).status).toBe(404);
    expect((await accept('x'.repeat(43))).status).toBe(404);
    const inv = (await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'b@example.test', roleId: 'member' } })).json.invitation;
    await h.call('DELETE', `/api/invitations/${inv.id}`, { token: owner.token });
    expect((await accept(tokenFrom(h, 'b@example.test'))).status).toBe(404);
    await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'c@example.test', roleId: 'member' } });
    h.clock.advance(8 * 86_400_000);
    expect((await accept(tokenFrom(h, 'c@example.test'))).status).toBe(404);
    expect((await h.call('GET', `/api/auth/invitations/lookup?token=${tokenFrom(h, 'c@example.test')}`)).status).toBe(404);
  });

  it('two people racing to accept the same link: exactly one account is created', async () => {
    const { h, owner } = await world();
    await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'r@example.test', roleId: 'member' } });
    const token = tokenFrom(h, 'r@example.test');
    const results = await Promise.all([1, 2, 3].map((i) => h.call('POST', '/api/auth/invitations/accept', { body: { token, name: `R${i}`, password: 'correct horse battery' } })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE email = 'r@example.test'"))!.n)).toBe(1);
  });

  it('resend gives a new link and kills the old one; a new invitation to the same address replaces the pending one', async () => {
    const { h, owner } = await world();
    const inv = (await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 's@example.test', roleId: 'member' } })).json.invitation;
    const first = tokenFrom(h, 's@example.test');
    await h.call('POST', `/api/invitations/${inv.id}/resend`, { token: owner.token });
    const second = tokenFrom(h, 's@example.test');
    expect(second).not.toBe(first);
    expect((await h.call('GET', `/api/auth/invitations/lookup?token=${first}`)).status).toBe(404);
    expect((await h.call('GET', `/api/auth/invitations/lookup?token=${second}`)).status).toBe(200);
    await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 's@example.test', roleId: 'viewer' } });
    expect((await h.call('GET', `/api/auth/invitations/lookup?token=${second}`)).status).toBe(404);
    const pending = ((await h.call('GET', '/api/invitations', { token: owner.token })).json.data as { email: string; status: string }[]).filter((i) => i.email === 's@example.test' && i.status === 'pending');
    expect(pending).toHaveLength(1);
  });

  it('refuses an address that already has an account, a weak password, and a role the inviter cannot grant', async () => {
    const { h, owner } = await world();
    expect((await h.call('POST', '/api/invitations', { token: owner.token, body: { email: owner.email, roleId: 'member' } })).json.error.code).toBe('EMAIL_TAKEN');
    await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'w@example.test', roleId: 'member' } });
    const weak = await h.call('POST', '/api/auth/invitations/accept', { body: { token: tokenFrom(h, 'w@example.test'), name: 'W', password: 'short' } });
    expect(weak.status).toBe(400);
    expect((await h.call('GET', `/api/auth/invitations/lookup?token=${tokenFrom(h, 'w@example.test')}`)).status).toBe(200); // the failed attempt did not burn the link
    const hr = await h.memberWith(owner, ['members:manage', 'members:read', 'funnels:read']);
    expect((await h.call('POST', '/api/invitations', { token: hr.token, body: { email: 'z@example.test', roleId: 'admin' } })).status).toBe(403);
  });

  it('with no mail transport the link is returned to the inviter instead (and only then)', async () => {
    const { h, owner } = await world();
    h.deps.mailer = { kind: 'none', send: async () => false };
    const r = await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'n@example.test', roleId: 'member' } });
    expect(r.json.delivered).toBe(false);
    expect(r.json.link).toMatch(/\/accept-invite\?token=[\w-]{43}$/);
    h.deps.mailer = { kind: 'webhook', send: async () => { throw new Error('mail webhook answered 500'); } };
    const failed = await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'f@example.test', roleId: 'member' } });
    expect(failed.status).toBe(201); // a mail outage does not fail the invitation
    expect(failed.json.link).toBeDefined();
  });

  it('invitations are scoped to the workspace: another workspace cannot list, revoke or resend them', async () => {
    const { h, owner } = await world();
    const other = await h.register();
    const inv = (await h.call('POST', '/api/invitations', { token: owner.token, body: { email: 'p@example.test', roleId: 'member' } })).json.invitation;
    expect((await h.call('GET', '/api/invitations', { token: other.token })).json.data).toEqual([]);
    expect((await h.call('DELETE', `/api/invitations/${inv.id}`, { token: other.token })).status).toBe(404);
    expect((await h.call('POST', `/api/invitations/${inv.id}/resend`, { token: other.token })).status).toBe(404);
  });
});

describe('password reset', () => {
  it('answers identically for known and unknown addresses; only a known one gets mail', async () => {
    const { h, owner } = await world();
    const known = await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } });
    const unknown = await h.call('POST', '/api/auth/password/forgot', { body: { email: 'nobody@example.test' } });
    expect(known.status).toBe(200);
    expect(known.json).toEqual(unknown.json);
    expect(h.mailer.sent.map((m) => m.to)).toEqual([owner.email]);
    expect(h.mailer.sent[0]!.text).toContain('/reset-password?token=');
  });

  it('the link sets a new password once, ends every session, and the old password stops working', async () => {
    const { h, owner } = await world();
    const session2 = (await h.call('POST', '/api/auth/login', { body: { email: owner.email, password: 'correct horse battery' } })).json;
    await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } });
    const token = tokenFrom(h, owner.email);
    const reset = await h.call('POST', '/api/auth/password/reset', { body: { token, password: 'a completely new password' } });
    expect(reset.json).toEqual({ ok: true });
    expect((await h.call('GET', '/api/auth/me', { token: owner.token })).status).toBe(401);
    expect((await h.call('GET', '/api/auth/me', { token: session2.token })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { body: { email: owner.email, password: 'correct horse battery' } })).status).toBe(401);
    expect((await h.call('POST', '/api/auth/login', { body: { email: owner.email, password: 'a completely new password' } })).status).toBe(200);
    const again = await h.call('POST', '/api/auth/password/reset', { body: { token, password: 'yet another password!' } });
    expect(again.status).toBe(400);
    expect(again.json.error.code).toBe('INVALID_RESET_TOKEN');
  });

  it('expires after PASSWORD_RESET_TTL_MINUTES, a newer request replaces the older link, and a weak password does not burn the link', async () => {
    const { h, owner } = await world({ PASSWORD_RESET_TTL_MINUTES: '60' });
    await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } });
    const old = tokenFrom(h, owner.email);
    await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } });
    const fresh = tokenFrom(h, owner.email);
    expect((await h.call('POST', '/api/auth/password/reset', { body: { token: old, password: 'a completely new password' } })).status).toBe(400);
    expect((await h.call('POST', '/api/auth/password/reset', { body: { token: fresh, password: 'short' } })).status).toBe(400);
    h.clock.advance(61 * 60_000);
    expect((await h.call('POST', '/api/auth/password/reset', { body: { token: fresh, password: 'a completely new password' } })).status).toBe(400);
  });

  it('stops mail bombing: at most 3 reset mails per address per hour, with the same answer throughout', async () => {
    const { h, owner } = await world();
    const answers = [] as number[];
    for (let i = 0; i < 4; i++) answers.push((await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } })).status);
    expect(answers).toEqual([200, 200, 200, 200]); // the 4th is silently dropped, not refused: the answer reveals nothing
    expect(h.mailer.sent.filter((m) => m.to === owner.email)).toHaveLength(3);
    h.clock.advance(2 * 60 * 60_000); // sliding window over two adjacent hours: fully recovered after two
    await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } });
    expect(h.mailer.sent.filter((m) => m.to === owner.email)).toHaveLength(4);
  });

  it('a reset token is stored only as a hash and the audit trail records the request and the reset without the token', async () => {
    const { h, owner } = await world();
    await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } });
    const token = tokenFrom(h, owner.email);
    await h.call('POST', '/api/auth/password/reset', { body: { token, password: 'a completely new password' } });
    const rows = await h.deps.db.all<{ token_hash: string }>('SELECT token_hash FROM password_resets');
    expect(rows.every((r) => r.token_hash !== token)).toBe(true);
    const audit = await h.deps.db.all<{ action: string; detail_json: string }>("SELECT action, detail_json FROM audit_log WHERE action LIKE 'auth.password_reset%'");
    expect(audit.map((a) => a.action).sort()).toEqual(['auth.password_reset', 'auth.password_reset_requested']);
    expect(JSON.stringify(audit)).not.toContain(token);
  });
});
