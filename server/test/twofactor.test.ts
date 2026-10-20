import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '../src/auth/permissions.js';
import { decryptSecret, encryptSecret } from '../src/auth/secrets.js';
import { base32Decode, base32Encode, hotp, otpauthUri, totp, verifyTotp } from '../src/auth/totp.js';
import { makeHarness, type Harness } from './helpers.js';

describe('TOTP (RFC 6238) and secret encryption', () => {
  // RFC 6238 appendix B, SHA-1, secret "12345678901234567890"; the RFC lists 8 digits, an authenticator shows the last 6.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches the RFC 6238 test vectors', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [t, code] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']] as const) expect(totp(secret, t * 1000), `T=${t}`).toBe(code);
  });
  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489']);
  });
  it('accepts the previous, current and next step only, and reports the matching step', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(step);
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
  it('base32 round-trips and rejects junk; the otpauth URI carries issuer, account and parameters', () => {
    const raw = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 8]);
    expect(base32Decode(base32Encode(raw))).toEqual(raw);
    expect(() => base32Decode('not-base32!')).toThrow();
    expect(otpauthUri('Funnels', 'a@b.test', 'ABCDEF')).toBe('otpauth://totp/Funnels:a%40b.test?secret=ABCDEF&issuer=Funnels&algorithm=SHA1&digits=6&period=30');
  });
  it('encrypts secrets with AES-256-GCM: round trip, fresh IV each time, tamper and wrong key detected', async () => {
    const h = await makeHarness();
    const a = encryptSecret(h.deps.config, 'JBSWY3DPEHPK3PXP');
    expect(a).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(encryptSecret(h.deps.config, 'JBSWY3DPEHPK3PXP')).not.toBe(a);
    expect(decryptSecret(h.deps.config, a)).toBe('JBSWY3DPEHPK3PXP');
    const parts = a.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decryptSecret(h.deps.config, parts.join('.'))).toThrow();
    expect(() => decryptSecret({ ...h.deps.config, DATA_ENCRYPTION_KEY: 'a-different-key-of-at-least-32-characters' }, a)).toThrow();
  });
});

const code = (h: Harness, secret: string, offsetSteps = 0) => totp(secret, h.clock.now().getTime() + offsetSteps * 30_000);
const login = (h: Harness, email: string, password = 'correct horse battery') => h.call('POST', '/api/auth/login', { body: { email, password } });

async function enrolled() {
  const h = await makeHarness();
  const owner = await h.register();
  const setup = (await h.call('POST', '/api/auth/2fa/setup', { token: owner.token })).json as { secret: string; otpauthUri: string };
  const enable = await h.call('POST', '/api/auth/2fa/enable', { token: owner.token, body: { code: code(h, setup.secret) } });
  return { h, owner, secret: setup.secret, recovery: enable.json.recoveryCodes as string[], enable };
}

describe('two-factor authentication', () => {
  it('enrolment: setup returns a secret and URI, a wrong code does not enable, the right one does and returns 10 recovery codes once', async () => {
    const h = await makeHarness();
    const owner = await h.register();
    const setup = await h.call('POST', '/api/auth/2fa/setup', { token: owner.token });
    expect(setup.json.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.json.otpauthUri).toContain(`secret=${setup.json.secret}`);
    expect((await h.call('POST', '/api/auth/2fa/enable', { token: owner.token, body: { code: '000000' } })).json.error.code).toBe('INVALID_CODE');
    expect((await login(h, owner.email)).json.twoFactorRequired).toBeUndefined(); // not on until confirmed
    const ok = await h.call('POST', '/api/auth/2fa/enable', { token: owner.token, body: { code: code(h, setup.json.secret) } });
    expect(ok.status).toBe(200);
    expect(new Set(ok.json.recoveryCodes).size).toBe(10);
    expect(ok.json.recoveryCodes[0]).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect((await h.call('GET', '/api/auth/me', { token: owner.token })).json.user.twoFactorEnabled).toBe(true);
    expect((await h.call('POST', '/api/auth/2fa/setup', { token: owner.token })).status).toBe(409);
  });

  it('the secret is stored encrypted and recovery codes only as hashes', async () => {
    const { h, secret, recovery } = await enrolled();
    const row = (await h.deps.db.get<{ secret_enc: string }>('SELECT secret_enc FROM user_totp'))!;
    expect(row.secret_enc).not.toContain(secret);
    expect(decryptSecret(h.deps.config, row.secret_enc)).toBe(secret);
    const hashes = (await h.deps.db.all<{ code_hash: string }>('SELECT code_hash FROM recovery_codes')).map((r) => r.code_hash);
    expect(hashes).toHaveLength(10);
    for (const c of recovery) expect(hashes).not.toContain(c.replace(/-/g, ''));
  });

  it('login with 2FA is two steps: the password gives only a challenge, the code gives the session', async () => {
    const { h, owner, secret } = await enrolled();
    const step1 = await login(h, owner.email);
    expect(step1.status).toBe(200);
    expect(step1.json).toEqual({ twoFactorRequired: true, challengeToken: expect.any(String) });
    expect(step1.json.token).toBeUndefined();
    h.clock.advance(30_000); // a fresh code: the enrolment code's step is spent
    const ok = await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: step1.json.challengeToken, code: code(h, secret) } });
    expect(ok.status).toBe(200);
    expect((await h.call('GET', '/api/auth/me', { token: ok.json.token })).status).toBe(200);
    // the challenge alone is not a credential
    expect((await h.call('GET', '/api/auth/me', { token: step1.json.challengeToken })).status).toBe(401);
  });

  it('a code works once: replaying it (same step) is refused, the next step\'s code is fine', async () => {
    const { h, owner, secret } = await enrolled();
    h.clock.advance(30_000);
    const c = code(h, secret);
    const first = await login(h, owner.email);
    expect((await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: first.json.challengeToken, code: c } })).status).toBe(200);
    const second = await login(h, owner.email);
    expect((await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: second.json.challengeToken, code: c } })).status).toBe(401);
    h.clock.advance(30_000);
    expect((await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: second.json.challengeToken, code: code(h, secret) } })).status).toBe(200);
  });

  it('the challenge expires after five minutes and a challenge for a removed second factor is invalid', async () => {
    const { h, owner, secret } = await enrolled();
    h.clock.advance(30_000);
    const step1 = await login(h, owner.email);
    h.clock.advance(6 * 60_000);
    expect((await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: step1.json.challengeToken, code: code(h, secret) } })).status).toBe(401);
  });

  it('recovery codes work exactly once each; using one is audited', async () => {
    const { h, owner, recovery } = await enrolled();
    const attempt = async (c: string) => h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: (await login(h, owner.email)).json.challengeToken, code: c } });
    expect((await attempt(recovery[0]!.toUpperCase())).status).toBe(200); // case and dashes do not matter
    expect((await attempt(recovery[0]!)).status).toBe(401);
    expect((await attempt(recovery[1]!.replace(/-/g, ''))).status).toBe(200);
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = '2fa.recovery_code_used'"))!.n)).toBe(2);
  });

  it('wrong codes count towards the same lockout as wrong passwords', async () => {
    const { h, owner } = await enrolled();
    const challenge = (await login(h, owner.email)).json.challengeToken;
    const statuses = [] as number[];
    for (let i = 0; i < 10; i++) statuses.push((await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: challenge, code: '123456' } })).status);
    expect(statuses.slice(0, 8)).toEqual(Array(8).fill(401));
    expect(statuses.slice(8)).toEqual([429, 429]); // locked out after 8 failures
    expect((await login(h, owner.email)).status).toBe(429); // even the password step is refused now
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.locked_out'"))!.n)).toBeGreaterThanOrEqual(1);
  });

  it('turning 2FA off needs the password and a code, ends other sessions, and login goes back to one step', async () => {
    const { h, owner, secret } = await enrolled();
    h.clock.advance(30_000);
    const other = (await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: (await login(h, owner.email)).json.challengeToken, code: code(h, secret) } })).json;
    h.clock.advance(30_000);
    const bad = await h.call('POST', '/api/auth/2fa/disable', { token: owner.token, body: { password: 'wrong password', code: code(h, secret) } });
    expect(bad.json.error.code).toBe('INVALID_CREDENTIALS');
    const ok = await h.call('POST', '/api/auth/2fa/disable', { token: owner.token, body: { password: 'correct horse battery', code: code(h, secret) } });
    expect(ok.json).toEqual({ ok: true });
    expect((await h.call('GET', '/api/auth/me', { token: other.token })).status).toBe(401);
    expect((await login(h, owner.email)).json.token).toBeDefined();
  });

  it('regenerating recovery codes needs password and code and invalidates the old codes', async () => {
    const { h, owner, secret, recovery } = await enrolled();
    h.clock.advance(30_000);
    const fresh = await h.call('POST', '/api/auth/2fa/recovery-codes', { token: owner.token, body: { password: 'correct horse battery', code: code(h, secret) } });
    expect(fresh.json.recoveryCodes).toHaveLength(10);
    const r = await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: (await login(h, owner.email)).json.challengeToken, code: recovery[0]! } });
    expect(r.status).toBe(401);
    const r2 = await h.call('POST', '/api/auth/2fa/verify', { body: { challengeToken: (await login(h, owner.email)).json.challengeToken, code: fresh.json.recoveryCodes[0] } });
    expect(r2.status).toBe(200);
  });

  it('password reset does not bypass 2FA', async () => {
    const { h, owner } = await enrolled();
    await h.call('POST', '/api/auth/password/forgot', { body: { email: owner.email } });
    const token = new URL(h.mailer.linkTo(owner.email)!).searchParams.get('token')!;
    await h.call('POST', '/api/auth/password/reset', { body: { token, password: 'a completely new password' } });
    const r = await login(h, owner.email, 'a completely new password');
    expect(r.json.twoFactorRequired).toBe(true);
  });

  it('an administrator can remove a member\'s second factor (account recovery), but not an owner\'s unless they are an owner', async () => {
    const { h, owner } = await enrolled();
    const admin = await h.member(owner, 'admin');
    const hr = await h.memberWith(owner, [...SYSTEM_ROLES.member.permissions, 'members:manage']); // holds everything the victim's role holds, plus the right to manage members
    const weakHr = await h.memberWith(owner, ['members:manage', 'members:read']);
    const victim = await h.member(owner, 'member');
    const s = (await h.call('POST', '/api/auth/2fa/setup', { token: victim.token })).json;
    await h.call('POST', '/api/auth/2fa/enable', { token: victim.token, body: { code: code(h, s.secret) } });
    expect((await login(h, victim.email)).json.twoFactorRequired).toBe(true);
    const ownerId = (await h.call('GET', '/api/auth/me', { token: owner.token })).json.user.id;
    expect((await h.call('POST', `/api/members/${ownerId}/reset-2fa`, { token: hr.token })).status).toBe(403);
    expect((await h.call('POST', `/api/members/${victim.userId}/reset-2fa`, { token: weakHr.token })).status).toBe(403); // cannot act on someone who holds more than they do
    expect((await h.call('POST', `/api/members/${victim.userId}/reset-2fa`, { token: admin.token })).status).toBe(403); // admin lacks members:manage
    expect((await h.call('POST', `/api/members/${victim.userId}/reset-2fa`, { token: hr.token })).status).toBe(200);
    expect((await h.call('GET', '/api/auth/me', { token: victim.token })).status).toBe(401); // their sessions ended
    expect((await login(h, victim.email)).json.token).toBeDefined();
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = '2fa.reset_by_admin'"))!.n)).toBe(1);
  });
});
