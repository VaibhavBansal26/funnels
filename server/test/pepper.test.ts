import { createHash, createHmac, randomBytes } from 'node:crypto';
import AjvPkg from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import { DOCUMENTS, jsonSchemaOf } from '../src/analyticsapi/schemas.js';
import { pepperFingerprint, validatePepper } from '../src/analyticsapi/pepperRules.js';
import { dataKeys, decryptWithDataKey, encryptWithDataKey } from '../src/auth/dataCrypto.js';
import { identityPepper } from '../src/services/analyticsapi.js';
import { insertEvents, type EventInsert } from '../src/services/rollups.js';
import { newId } from '../src/util/ids.js';
import { activeDomain, makeFunnel, makeHarness, type Harness } from './helpers.js';

const Ajv2020 = ((AjvPkg as unknown as { default?: typeof AjvPkg }).default ?? AjvPkg) as unknown as new (o: object) => { compile(s: object): ValidateFunction };
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (a: object) => void;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validShape = (body: unknown) => {
  const v = ajv.compile(jsonSchemaOf(DOCUMENTS['identity-pepper']));
  expect(v(body), JSON.stringify(v.errors)).toBe(true);
};

const hex = () => randomBytes(32).toString('hex');
const KEY_A = `${hex()}`;
const KEY_B = `${hex()}`;
const URL = '/api/v1/analytics/identity-pepper';
const BIG = { API_USER_PER_MINUTE: '1000000', API_WORKSPACE_PER_MINUTE: '1000000', ANALYTICS_API_PER_MINUTE: '100000', ANALYTICS_EXPORT_PER_MINUTE: '100000' };

async function world(env: Record<string, string> = {}) {
  const h = await makeHarness({ env: { ...BIG, ...env } });
  const owner = await h.register();
  const mk = async (scopes: string[]) => {
    const r = await h.call('POST', '/api/v1/api-keys', { token: owner.token, body: { name: 'k', scopes } });
    if (r.status !== 201) throw new Error(`key failed: ${r.text}`);
    return r.json.key as string;
  };
  return { h, owner, mk };
}

describe('pepper rules', () => {
  it('accepts 32 random bytes as hex or base64 and any long random-looking string', () => {
    for (const ok of [hex(), randomBytes(32).toString('base64'), randomBytes(32).toString('base64url'), 'correct-Horse_battery.staple/Zx9!qLm2#vB7kRt4', randomBytes(48).toString('hex')]) expect(validatePepper(ok)).toBe(ok);
  });
  it('refuses short, low-entropy, patterned, padded and non-string values with INVALID_PEPPER', () => {
    const bad: [unknown, RegExp][] = [
      [undefined, /string/],
      ['short', /at least 32/],
      [randomBytes(16).toString('hex'), /hex pepper must be at least 64/],
      ['a'.repeat(64), /random enough/],
      ['abcd'.repeat(16), /random enough/],
      ['0123456789abcdef'.repeat(4), /random enough/],
      ['abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', /random enough/],
      [` ${hex()}`, /printable ASCII/],
      [`${hex()}\n`, /printable ASCII/],
      ['x'.repeat(300), /at most 256/],
      [`enc2.${hex()}`, /enc2/],
    ];
    for (const [v, why] of bad) {
      try {
        validatePepper(v);
        throw new Error(`accepted ${String(v).slice(0, 20)}`);
      } catch (e) {
        expect((e as { code?: string }).code, String(e)).toBe('INVALID_PEPPER');
        expect((e as Error).message).toMatch(why);
      }
    }
  });
  it('the fingerprint is the first 8 hex characters of SHA-256 over the pepper', () => {
    const p = hex();
    expect(pepperFingerprint(p)).toBe(createHash('sha256').update(p).digest('hex').slice(0, 8));
  });
});

describe('pepper endpoints', () => {
  it('one path, one shape: a person and a key with both scopes get the same document, with the fingerprint', async () => {
    const { h, owner, mk } = await world();
    const key = await mk(['analytics:read', 'analytics:export', 'analytics_identity:manage']);
    const person = await h.call('GET', URL, { token: owner.token });
    const viaKey = await h.call('GET', URL, { token: key });
    expect(person.status).toBe(200);
    for (const r of [person, viaKey]) {
      validShape(r.json);
      expect(Object.keys(r.json).sort()).toEqual(['algorithm', 'fingerprint', 'pepper', 'rotatedAt', 'version']);
      expect(r.json).toMatchObject({ algorithm: 'HMAC-SHA256', version: 1 });
      expect(r.json.fingerprint).toBe(pepperFingerprint(r.json.pepper));
    }
    expect(viaKey.json).toEqual(person.json);
  });

  it('a key needs BOTH analytics:export and analytics_identity:manage and can never change the pepper; a key cannot be created with a scope its creator lacks', async () => {
    const { h, owner, mk } = await world();
    for (const scopes of [['analytics:read'], ['analytics:read', 'analytics:export'], ['analytics:read', 'analytics_identity:manage']]) {
      const r = await h.call('GET', URL, { token: await mk(scopes) });
      expect(r.status, scopes.join()).toBe(403);
      expect(r.json.error.message).toMatch(/lacks the/);
    }
    const both = await mk(['analytics:read', 'analytics:export', 'analytics_identity:manage']);
    expect((await h.call('PUT', URL, { token: both, body: { pepper: hex() } })).status).toBe(403);
    expect((await h.call('POST', `${URL}/rotate`, { token: both })).status).toBe(403);
    const admin = await h.member(owner, 'admin'); // has analytics:export, lacks analytics_identity:manage
    const r = await h.call('POST', '/api/v1/api-keys', { token: admin.token, body: { name: 'x', scopes: ['analytics_identity:manage'] } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it('a person needs both permissions: an admin, a member with only the identity permission and no credentials are refused', async () => {
    const { h, owner } = await world();
    const admin = await h.member(owner, 'admin');
    const onlyIdentity = await h.memberWith(owner, ['analytics_identity:manage']);
    for (const t of [admin.token, onlyIdentity.token]) {
      expect((await h.call('GET', URL, { token: t })).status).toBe(403);
      expect((await h.call('PUT', URL, { token: t, body: { pepper: hex() } })).status).toBe(403);
    }
    expect((await h.call('GET', URL)).status).toBe(401);
  });

  it('PUT imports a pepper: exports use it, version bumps, the same value is a no-op, the audit entry holds the fingerprint but never the pepper, it is stored encrypted', async () => {
    const { h, owner, mk } = await world();
    const key = await mk(['analytics:read', 'analytics:export', 'analytics_identity:manage']);
    expect((await h.call('GET', URL, { token: owner.token })).json.version).toBe(1);
    const mine = randomBytes(32).toString('base64url');
    const set = await h.call('PUT', URL, { token: owner.token, body: { pepper: mine, confirm: mine } });
    expect(set.status).toBe(200);
    validShape(set.json);
    expect(set.json).toMatchObject({ pepper: mine, version: 2, algorithm: 'HMAC-SHA256', fingerprint: pepperFingerprint(mine) });
    expect((await h.call('GET', URL, { token: key })).json.pepper).toBe(mine);
    const again = await h.call('PUT', URL, { token: owner.token, body: { pepper: mine } });
    expect(again.json.version).toBe(2);
    expect(again.json.rotatedAt).toBe(set.json.rotatedAt);
    // exports are keyed with it
    const f = await makeFunnel(h, owner.token, { name: 'P' });
    const d = await activeDomain(h, owner.token, 'pepper.example.com');
    await h.call('PATCH', `/api/funnels/${f.id}`, { token: owner.token, body: { status: 'live', domain_id: d } });
    const row: EventInsert = { id: newId('evt'), workspace_id: owner.wsId, funnel_id: f.id, step_id: f.steps[0].id, type: 'page_view', visitor_id: 'stable-visitor', unique_visit: 0, lead_id: null, order_id: null, external_id: null, amount_cents: 0, currency: null, utm_json: null, url: null, created_at: '2026-03-10T12:00:00.000Z' };
    await h.deps.db.transaction((tx) => insertEvents(tx, [row], { decideUnique: true }));
    const ex = await h.call('GET', '/api/v1/analytics/export/events?from=2026-03-10&to=2026-03-10', { token: key });
    expect(JSON.parse(ex.text.split('\n')[0]!).visitor_key).toBe(createHmac('sha256', mine).update('v:stable-visitor').digest('hex'));
    // audit and storage
    const audit = await h.deps.db.all<{ action: string; detail_json: string }>("SELECT action, detail_json FROM audit_log WHERE action LIKE 'analytics.pepper%'");
    expect(audit.map((a) => a.action)).toEqual(['analytics.pepper_set']);
    expect(audit[0]!.detail_json).toContain(pepperFingerprint(mine));
    expect(JSON.stringify(audit)).not.toContain(mine);
    const stored = (await h.deps.db.get<{ identity_pepper: string }>('SELECT identity_pepper FROM workspaces WHERE id = ?', owner.wsId))!.identity_pepper;
    expect(stored.startsWith('enc2.')).toBe(true);
    expect(stored).not.toContain(mine);
  });

  it('PUT rejects bad input with a clean 400 and changes nothing', async () => {
    const { h, owner } = await world();
    const before = (await h.call('GET', URL, { token: owner.token })).json;
    for (const body of [{}, { pepper: 'tooshort' }, { pepper: 'a'.repeat(64) }, { pepper: randomBytes(16).toString('hex') }, { pepper: 42 }]) {
      expect((await h.call('PUT', URL, { token: owner.token, body })).status, JSON.stringify(body)).toBe(400);
    }
    const mismatch = await h.call('PUT', URL, { token: owner.token, body: { pepper: hex(), confirm: hex() } });
    expect(mismatch.status).toBe(400);
    expect(mismatch.json.error.code).toBe('PEPPER_CONFIRM_MISMATCH');
    expect((await h.call('PUT', URL, { token: owner.token, body: { pepper: 'tooshort' } })).json.error.code).toBe('INVALID_PEPPER');
    expect((await h.call('GET', URL, { token: owner.token })).json).toEqual(before);
  });

  it('rotate still generates a new random pepper, bumps the version and is audited', async () => {
    const { h, owner } = await world();
    const a = (await h.call('GET', URL, { token: owner.token })).json;
    const r = await h.call('POST', `${URL}/rotate`, { token: owner.token });
    expect(r.status).toBe(200);
    validShape(r.json);
    expect(r.json.pepper).not.toBe(a.pepper);
    expect(r.json).toMatchObject({ version: 2, fingerprint: pepperFingerprint(r.json.pepper) });
    expect(Number((await h.deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'analytics.pepper_rotated'"))!.n)).toBe(1);
  });

  it('the analytics read limits apply to a key reading the pepper', async () => {
    const { h, mk } = await world({ ANALYTICS_API_PER_MINUTE: '2' });
    const key = await mk(['analytics:read', 'analytics:export', 'analytics_identity:manage']);
    expect((await h.call('GET', URL, { token: key })).status).toBe(200);
    expect((await h.call('GET', URL, { token: key })).status).toBe(200);
    const limited = await h.call('GET', URL, { token: key });
    expect(limited.status).toBe(429);
    expect(limited.json.error.policy).toBe('analytics.read');
  });
});

describe('pepper encryption key', () => {
  const stored = (h: Harness, ws: string) => h.deps.db.get<{ identity_pepper: string; identity_pepper_version: number; identity_pepper_rotated_at: string | null }>('SELECT identity_pepper, identity_pepper_version, identity_pepper_rotated_at FROM workspaces WHERE id = ?', ws);

  it('a pepper stored in clear by earlier versions is read unchanged and encrypted on that read', async () => {
    const { h, owner } = await world({ DATA_ENCRYPTION_KEY: KEY_A });
    const legacy = hex();
    await h.deps.db.run('UPDATE workspaces SET identity_pepper = ?, identity_pepper_rotated_at = ? WHERE id = ?', legacy, '2026-01-01T00:00:00.000Z', owner.wsId);
    const got = await h.call('GET', URL, { token: owner.token });
    expect(got.json).toMatchObject({ pepper: legacy, version: 1, rotatedAt: '2026-01-01T00:00:00.000Z' });
    const row = await stored(h, owner.wsId);
    expect(row!.identity_pepper.startsWith('enc2.')).toBe(true);
    expect(row!.identity_pepper).not.toContain(legacy);
    expect((await h.call('GET', URL, { token: owner.token })).json.pepper).toBe(legacy);
  });

  it('a pepper that never had a rotation date reports the workspace creation time', async () => {
    const { h, owner } = await world();
    await h.deps.db.run('UPDATE workspaces SET identity_pepper = ?, identity_pepper_rotated_at = NULL WHERE id = ?', hex(), owner.wsId);
    const created = (await h.deps.db.get<{ created_at: string }>('SELECT created_at FROM workspaces WHERE id = ?', owner.wsId))!.created_at;
    expect((await h.call('GET', URL, { token: owner.token })).json.rotatedAt).toBe(created);
  });

  it('changing JWT_SECRET does not touch a pepper stored under DATA_ENCRYPTION_KEY', async () => {
    const { h, owner } = await world({ DATA_ENCRYPTION_KEY: KEY_A });
    const before = (await h.call('GET', URL, { token: owner.token })).json.pepper;
    Object.assign(h.deps.config, { JWT_SECRET: 'a-completely-different-secret-value-1234567890' });
    expect((await identityPepper(h.deps, owner.wsId)).pepper).toBe(before);
  });

  it('rotating the data key: the previous key still decrypts and the row moves to the new key; without it the answer is 409 PEPPER_UNREADABLE, never a 500', async () => {
    const { h, owner } = await world({ DATA_ENCRYPTION_KEY: KEY_A });
    const pepper = (await h.call('GET', URL, { token: owner.token })).json.pepper;
    Object.assign(h.deps.config, { DATA_ENCRYPTION_KEY: KEY_B });
    const lost = await h.call('GET', URL, { token: owner.token });
    expect(lost.status).toBe(409);
    expect(lost.json.error.code).toBe('PEPPER_UNREADABLE');
    expect(lost.json.error.message).not.toMatch(/Unsupported state|Decipher|auth tag/i);
    Object.assign(h.deps.config, { DATA_ENCRYPTION_KEY_PREVIOUS: KEY_A });
    expect((await h.call('GET', URL, { token: owner.token })).json.pepper).toBe(pepper);
    Object.assign(h.deps.config, { DATA_ENCRYPTION_KEY_PREVIOUS: undefined });
    expect((await h.call('GET', URL, { token: owner.token })).json.pepper).toBe(pepper); // now under KEY_B alone
  });

  it('an unreadable pepper is recovered by setting a new one or rotating; exports answer 409 until then', async () => {
    const { h, owner, mk } = await world({ DATA_ENCRYPTION_KEY: KEY_A });
    const key = await mk(['analytics:read', 'analytics:export']);
    await h.call('GET', URL, { token: owner.token });
    Object.assign(h.deps.config, { DATA_ENCRYPTION_KEY: KEY_B });
    const exp = await h.call('GET', '/api/v1/analytics/export/events', { token: key });
    expect(exp.status).toBe(409);
    expect(exp.json.error.code).toBe('PEPPER_UNREADABLE');
    const mine = hex();
    expect((await h.call('PUT', URL, { token: owner.token, body: { pepper: mine } })).json.pepper).toBe(mine);
    expect((await h.call('GET', '/api/v1/analytics/export/events', { token: key })).status).toBe(200);
    Object.assign(h.deps.config, { DATA_ENCRYPTION_KEY: KEY_A });
    expect((await h.call('GET', URL, { token: owner.token })).status).toBe(409);
    expect((await h.call('POST', `${URL}/rotate`, { token: owner.token })).status).toBe(200);
  });

  it('production without DATA_ENCRYPTION_KEY refuses with a clear 503; a ciphertext is bound to its workspace', async () => {
    const { h, owner } = await world({ DATA_ENCRYPTION_KEY: KEY_A });
    await h.call('GET', URL, { token: owner.token });
    Object.assign(h.deps.config, { DATA_ENCRYPTION_KEY: undefined, NODE_ENV: 'production' });
    const r = await h.call('GET', URL, { token: owner.token });
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe('DATA_ENCRYPTION_KEY_REQUIRED');
    expect(dataKeys({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) }).current).toBeNull();
    const c = { NODE_ENV: 'test', JWT_SECRET: 'x'.repeat(32), DATA_ENCRYPTION_KEY: KEY_A };
    const blob = encryptWithDataKey(c, 'secret-value', 'pepper:ws_1');
    expect(decryptWithDataKey(c, blob, 'pepper:ws_1')).toEqual({ plain: 'secret-value', needsRewrite: false });
    expect(() => decryptWithDataKey(c, blob, 'pepper:ws_2')).toThrow(/cannot be decrypted/);
  });
});
