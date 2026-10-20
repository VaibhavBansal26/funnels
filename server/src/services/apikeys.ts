import { isSuspended } from './suspension.js';
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { clientIp, inCidr } from '../ratelimit/ip.js';
import { isIP } from 'node:net';
import { newId } from '../util/ids.js';
import { assertWithinLimit } from '../billing/limits.js';
import { audit } from './audit.js';
import { assertCanGrant } from './roles.js';
import type { Permission } from '../auth/permissions.js';

/**
 * Workspace API keys for the analytics API (docs/ANALYTICS-API.md). Format `fa_live_<random>` or `fa_test_<random>`; only the SHA-256 is stored and the
 * plaintext is shown once, at creation. A key has scopes (`analytics:read`, `analytics:export`), an optional expiry and an optional IP allow-list, can be
 * revoked, and records when it was last used. `live` keys see live funnels, `test` keys see test funnels (the same split as everywhere else in the app).
 */
export const SCOPES = ['analytics:read', 'analytics:export'] as const;
export type Scope = (typeof SCOPES)[number];
export const MODES = ['live', 'test'] as const;

const MAX_KEYS = 50;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const cidrOrIp = z.string().trim().refine((v) => {
  const [addr, bits] = v.split('/');
  if (!addr || !isIP(addr)) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= 0 && n <= (isIP(addr) === 4 ? 32 : 128);
}, 'Use an IP address or a CIDR range such as 203.0.113.0/24');

export const ApiKeyInput = z.object({
  name: z.string().trim().min(1).max(80),
  mode: z.enum(MODES).default('live'),
  scopes: z.array(z.enum(SCOPES)).min(1).max(SCOPES.length),
  expiresAt: z.string().datetime().nullable().optional(),
  ipAllowlist: z.array(cidrOrIp).max(20).default([]),
});
export const ApiKeyPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  ipAllowlist: z.array(cidrOrIp).max(20).optional(),
});

interface KeyRow {
  id: string;
  workspace_id: string;
  name: string;
  mode: 'live' | 'test';
  prefix: string;
  key_hash: string;
  scopes_json: string;
  ip_allowlist_json: string;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
}

const shape = (r: KeyRow) => ({
  id: r.id, name: r.name, mode: r.mode, prefix: r.prefix, scopes: JSON.parse(r.scopes_json) as Scope[], ipAllowlist: JSON.parse(r.ip_allowlist_json) as string[],
  createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, lastUsedAt: r.last_used_at, revokedAt: r.revoked_at,
});

/** The permission a user needs to create a key with a given scope: a key can never do more than the person who made it. */
const NEEDS: Record<Scope, Permission> = { 'analytics:read': 'analytics:read', 'analytics:export': 'analytics:export' };

export async function listKeys(deps: Deps, ws: string) {
  return { data: (await deps.db.all<KeyRow>('SELECT * FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC, id DESC', ws)).map(shape) };
}

export async function createKey(deps: Deps, auth: Auth, input: z.infer<typeof ApiKeyInput>, ip?: string) {
  assertCanGrant(auth, input.scopes.map((s) => NEEDS[s]));
  if (input.expiresAt && Date.parse(input.expiresAt) <= deps.now().getTime()) throw badRequest('INVALID_EXPIRY', 'The expiry must be in the future');
  const live = Number((await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL', auth.workspaceId))!.n);
  if (live >= MAX_KEYS) throw conflict('API_KEY_LIMIT', `A workspace can have at most ${MAX_KEYS} active API keys; revoke one first`);
  await assertWithinLimit(deps, auth.workspaceId, 'apiKeys');
  const secret = randomBytes(24).toString('base64url');
  const key = `fa_${input.mode}_${secret}`;
  const id = newId('key');
  const at = deps.now().toISOString();
  await deps.db.run(
    'INSERT INTO api_keys (id, workspace_id, name, mode, prefix, key_hash, scopes_json, ip_allowlist_json, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, auth.workspaceId, input.name, input.mode, key.slice(0, 12), sha(key), JSON.stringify(input.scopes), JSON.stringify(input.ipAllowlist), auth.userId, at, input.expiresAt ?? null,
  );
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'api_key.created', target: id, ip, detail: { name: input.name, mode: input.mode, scopes: input.scopes } });
  return { key, apiKey: shape((await deps.db.get<KeyRow>('SELECT * FROM api_keys WHERE id = ?', id))!) };
}

async function owned(deps: Deps, ws: string, id: string): Promise<KeyRow> {
  const r = await deps.db.get<KeyRow>('SELECT * FROM api_keys WHERE workspace_id = ? AND id = ?', ws, id);
  if (!r) throw notFound('API key');
  return r;
}

export async function updateKey(deps: Deps, auth: Auth, id: string, patch: z.infer<typeof ApiKeyPatch>, ip?: string) {
  const r = await owned(deps, auth.workspaceId, id);
  if (r.revoked_at) throw conflict('API_KEY_REVOKED', 'A revoked key cannot be changed');
  if (patch.expiresAt && Date.parse(patch.expiresAt) <= deps.now().getTime()) throw badRequest('INVALID_EXPIRY', 'The expiry must be in the future');
  await deps.db.run('UPDATE api_keys SET name = ?, expires_at = ?, ip_allowlist_json = ? WHERE id = ?', patch.name ?? r.name, patch.expiresAt === undefined ? r.expires_at : patch.expiresAt, patch.ipAllowlist ? JSON.stringify(patch.ipAllowlist) : r.ip_allowlist_json, id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'api_key.updated', target: id, ip, detail: { name: patch.name, ipAllowlist: patch.ipAllowlist, expiresAt: patch.expiresAt } });
  return shape((await deps.db.get<KeyRow>('SELECT * FROM api_keys WHERE id = ?', id))!);
}

export async function revokeKey(deps: Deps, auth: Auth, id: string, ip?: string): Promise<void> {
  const r = await owned(deps, auth.workspaceId, id);
  await deps.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', deps.now().toISOString(), id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'api_key.revoked', target: id, ip, detail: { name: r.name } });
}

export interface ApiAuth {
  keyId: string;
  workspaceId: string;
  mode: 'live' | 'test';
  scopes: Scope[];
}

const KEY_FORMAT = /^fa_(live|test)_[A-Za-z0-9_-]{20,64}$/;
const TOUCH_MS = 60_000;

/**
 * Authenticates a request by API key and checks the scope the route declares. Unknown, malformed, expired and revoked keys all answer the same 401 (the caller
 * learns nothing about which keys exist); a valid key from a disallowed address or without the scope is a 403 naming the problem.
 */
export async function authenticateKey(deps: Deps, c: Context, requiredScope: Scope): Promise<ApiAuth> {
  const bearer = /^Bearer (.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
  if (!bearer || !KEY_FORMAT.test(bearer)) throw unauthorized('A valid API key is required (Authorization: Bearer fa_live_...)');
  const r = await deps.db.get<KeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', sha(bearer));
  const now = deps.now();
  if (!r || r.revoked_at || (r.expires_at && r.expires_at <= now.toISOString())) throw unauthorized('A valid API key is required (Authorization: Bearer fa_live_...)');
  const allow = JSON.parse(r.ip_allowlist_json) as string[];
  if (allow.length) {
    const ip = clientIp(c, deps.config);
    if (!allow.some((a) => (a.includes('/') ? inCidr(ip, a) : ip === a || inCidr(ip, `${a}/${a.includes(':') ? 128 : 32}`)))) throw forbidden('This API key may not be used from this address');
  }
  if (await isSuspended(deps, r.workspace_id)) throw new AppError(403, 'WORKSPACE_SUSPENDED', 'This account is suspended');
  const scopes = JSON.parse(r.scopes_json) as Scope[];
  if (!scopes.includes(requiredScope)) throw forbidden(`This API key lacks the "${requiredScope}" scope`);
  if (!r.last_used_at || now.getTime() - Date.parse(r.last_used_at) > TOUCH_MS) await deps.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now.toISOString(), r.id);
  return { keyId: r.id, workspaceId: r.workspace_id, mode: r.mode, scopes };
}
