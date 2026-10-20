import { z } from 'zod';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { AppError, notFound } from '../errors.js';
import { audit } from './audit.js';

/**
 * Feature flags (docs/ADMIN.md). A flag is evaluated per workspace: an explicit override wins, then the percentage rollout (a stable hash of flag and workspace, so a
 * workspace does not flip between requests and raising the percentage only adds workspaces), then the default. Flags the code knows (KNOWN_FLAGS) exist without a row,
 * with their built-in default, so a fresh install behaves normally and an administrator can switch a feature off for one workspace or everybody.
 * The table is cached in-process for a few seconds; other nodes follow within that time.
 */
export const KNOWN_FLAGS: Record<string, { description: string; default: boolean }> = {
  ai_assistant: { description: 'The AI writing assistant (/api/ai/*)', default: true },
  analytics_api: { description: 'The API-key analytics API (/api/v1/analytics/*)', default: true },
};

export const FlagKey = z.string().regex(/^[a-z][a-z0-9_.-]{1,62}$/, 'Use lowercase letters, digits, dot, dash or underscore (2 to 63 characters, starting with a letter)');
export const FlagInput = z.object({ description: z.string().trim().max(300).optional(), defaultEnabled: z.boolean().optional(), rolloutPercent: z.number().int().min(0).max(100).optional() });
export const OverrideInput = z.object({ enabled: z.boolean().nullable() });

interface FlagRow { key: string; description: string; default_enabled: number; rollout_percent: number }
interface Snapshot { flags: Map<string, FlagRow>; overrides: Map<string, boolean>; until: number }
const TTL_MS = 5_000;
const cache = new Map<string, Snapshot>(); // per workspace

export function forgetFlags(): void {
  cache.clear();
}

function bucket(key: string, ws: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${key}:${ws}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

async function snapshot(deps: Deps, ws: string): Promise<Snapshot> {
  const hit = cache.get(ws);
  if (hit && hit.until > Date.now()) return hit;
  const flags = new Map((await deps.db.all<FlagRow>('SELECT key, description, default_enabled, rollout_percent FROM feature_flags')).map((r) => [r.key, r]));
  const overrides = new Map((await deps.db.all<{ flag_key: string; enabled: number }>('SELECT flag_key, enabled FROM feature_flag_overrides WHERE workspace_id = ?', ws)).map((r) => [r.flag_key, r.enabled === 1]));
  if (cache.size > 5_000) cache.clear();
  const s = { flags, overrides, until: Date.now() + TTL_MS };
  cache.set(ws, s);
  return s;
}

function decide(s: Snapshot, key: string, ws: string): boolean {
  const o = s.overrides.get(key);
  if (o !== undefined) return o;
  const row = s.flags.get(key);
  if (row) return row.default_enabled === 1 || bucket(key, ws) < row.rollout_percent;
  return KNOWN_FLAGS[key]?.default ?? false;
}

export async function flagEnabled(deps: Deps, ws: string, key: string): Promise<boolean> {
  return decide(await snapshot(deps, ws), key, ws);
}

export async function requireFlag(deps: Deps, ws: string, key: string): Promise<void> {
  if (!(await flagEnabled(deps, ws, key))) throw new AppError(403, 'FEATURE_DISABLED', 'This feature is not available for your account');
}

/** Everything a client may want to know: the evaluated value of every flag for this workspace. */
export async function flagsFor(deps: Deps, ws: string): Promise<Record<string, boolean>> {
  const s = await snapshot(deps, ws);
  const keys = new Set([...Object.keys(KNOWN_FLAGS), ...s.flags.keys()]);
  return Object.fromEntries([...keys].sort().map((k) => [k, decide(s, k, ws)]));
}

export async function listFlags(deps: Deps) {
  const rows = await deps.db.all<FlagRow & { overrides: number }>('SELECT f.key, f.description, f.default_enabled, f.rollout_percent, (SELECT COUNT(*) FROM feature_flag_overrides o WHERE o.flag_key = f.key) AS overrides FROM feature_flags f ORDER BY f.key');
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out = Object.entries(KNOWN_FLAGS).filter(([k]) => !byKey.has(k)).map(([key, k]) => ({ key, description: k.description, defaultEnabled: k.default, rolloutPercent: 0, overrides: 0, builtIn: true, stored: false }));
  for (const r of rows) out.push({ key: r.key, description: r.description || KNOWN_FLAGS[r.key]?.description || '', defaultEnabled: r.default_enabled === 1, rolloutPercent: r.rollout_percent, overrides: Number(r.overrides), builtIn: r.key in KNOWN_FLAGS, stored: true });
  return { data: out.sort((a, b) => (a.key < b.key ? -1 : 1)) };
}

export async function upsertFlag(deps: Deps, auth: Auth, key: string, input: z.infer<typeof FlagInput>, ip?: string) {
  const at = deps.now().toISOString();
  const known = KNOWN_FLAGS[key];
  const cur = await deps.db.get<FlagRow>('SELECT key, description, default_enabled, rollout_percent FROM feature_flags WHERE key = ?', key);
  const next = {
    description: input.description ?? cur?.description ?? known?.description ?? '',
    def: input.defaultEnabled ?? (cur ? cur.default_enabled === 1 : (known?.default ?? false)),
    pct: input.rolloutPercent ?? cur?.rollout_percent ?? 0,
  };
  if (cur) await deps.db.run('UPDATE feature_flags SET description = ?, default_enabled = ?, rollout_percent = ?, updated_by = ?, updated_at = ? WHERE key = ?', next.description, next.def ? 1 : 0, next.pct, auth.userId, at, key);
  else await deps.db.run('INSERT INTO feature_flags (key, description, default_enabled, rollout_percent, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)', key, next.description, next.def ? 1 : 0, next.pct, auth.userId, at);
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.flag.updated', target: key, detail: { defaultEnabled: next.def, rolloutPercent: next.pct }, ip });
  forgetFlags();
  return { key, description: next.description, defaultEnabled: next.def, rolloutPercent: next.pct };
}

export async function deleteFlag(deps: Deps, auth: Auth, key: string, ip?: string): Promise<void> {
  const { changes } = await deps.db.run('DELETE FROM feature_flags WHERE key = ?', key);
  if (changes === 0) throw notFound('Flag');
  await audit(deps, { workspaceId: null, actorId: auth.userId, action: 'admin.flag.deleted', target: key, ip });
  forgetFlags();
}

/** `enabled: null` removes the override. A flag that has no row yet (a built-in one) gets one, so the override has something to point at. */
export async function setOverride(deps: Deps, auth: Auth, key: string, ws: string, enabled: boolean | null, ip?: string) {
  if (!(await deps.db.get('SELECT 1 FROM workspaces WHERE id = ?', ws))) throw notFound('Workspace');
  const at = deps.now().toISOString();
  if (!(await deps.db.get('SELECT 1 FROM feature_flags WHERE key = ?', key))) {
    const known = KNOWN_FLAGS[key];
    if (!known) throw notFound('Flag');
    await deps.db.run(`INSERT INTO feature_flags (key, description, default_enabled, rollout_percent, updated_by, updated_at) VALUES (?, ?, ?, 0, ?, ?)${deps.db.dialect.onConflictDoNothing()}`, key, known.description, known.default ? 1 : 0, auth.userId, at);
  }
  if (enabled === null) await deps.db.run('DELETE FROM feature_flag_overrides WHERE flag_key = ? AND workspace_id = ?', key, ws);
  else {
    await deps.db.run('DELETE FROM feature_flag_overrides WHERE flag_key = ? AND workspace_id = ?', key, ws);
    await deps.db.run('INSERT INTO feature_flag_overrides (flag_key, workspace_id, enabled, updated_at) VALUES (?, ?, ?, ?)', key, ws, enabled ? 1 : 0, at);
  }
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'admin.flag.override', target: key, detail: { enabled }, ip });
  forgetFlags();
  return { flag: key, workspaceId: ws, enabled };
}
