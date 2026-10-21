import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { isUniqueViolation } from '../db/index.js';
import { inTx } from '../db/scope.js';
import { conflict, notFound } from '../errors.js';
import type { DomainRow, FunnelRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { CF_TARGETS_SQL } from '../publish/target.js';

/**
 * Where a funnel lives on the internet. Three kinds of address, all stored as a row in `domains` (see migration 042):
 *
 *   custom   a hostname the customer owns, DNS verified.                       https://offers.example.com/<step path>
 *   builtin  free, one per workspace, no DNS. Served by THIS app.             <APP_PUBLIC_URL>/s/<workspace slug>/<funnel slug>/<step path>
 *   pages    free, one per funnel published to Cloudflare Pages.              https://<project>.pages.dev/<step path>
 *
 * System domains (builtin, pages) get a synthetic ".invalid" hostname so they can never match a Host header; every host lookup also filters on kind = 'custom'.
 */
export type AddressKind = 'custom' | 'builtin' | 'pages';

export const BUILTIN_MOUNT = '/s';
/** 1 to 40 characters, lower-case letters, digits and single hyphens inside. Safe in a URL path segment without encoding. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,39}$/;
export const SlugInput = z.string().trim().toLowerCase().min(1).max(40).regex(SLUG_RE, 'Use 1 to 40 lower-case letters, digits and single hyphens');

export function slugify(input: string, fallback: string): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || fallback;
}

export function appOrigin(deps: Pick<Deps, 'config'>): string {
  try {
    return new URL(deps.config.APP_PUBLIC_URL).origin;
  } catch {
    return deps.config.APP_PUBLIC_URL.replace(/\/+$/, '');
  }
}

export const appHost = (deps: Pick<Deps, 'config'>): string => {
  try {
    return new URL(deps.config.APP_PUBLIC_URL).host.toLowerCase();
  } catch {
    return '';
  }
};

export const builtinPrefix = (workspaceSlug: string, funnelSlug: string): string => `${BUILTIN_MOUNT}/${workspaceSlug}/${funnelSlug}`;
/** Cookies of built-in pages are scoped to the workspace so one tenant's page can never read another's visitor id. */
export const builtinCookiePath = (workspaceSlug: string): string => `${BUILTIN_MOUNT}/${workspaceSlug}`;

const suffix = () => randomBytes(2).toString('hex');
const withSuffix = (base: string, s: string) => `${base.slice(0, 40 - s.length - 1).replace(/-+$/, '')}-${s}`;

/** `base`, `base-2`, `base-3`, then `base-<random>`: the first one `taken` does not know. */
async function pickSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string[]> {
  const out: string[] = [];
  for (let n = 1; n <= 40 && out.length < 6; n++) {
    const candidate = n === 1 ? base : withSuffix(base, String(n));
    if (!(await taken(candidate))) out.push(candidate);
  }
  out.push(withSuffix(base, suffix()), withSuffix(base, suffix()));
  return out;
}

// ---- slugs ----------------------------------------------------------------------------------------------------------------------------------------------

export async function workspaceSlugOf(deps: Pick<Deps, 'db'>, ws: string): Promise<string | null> {
  return (await deps.db.get<{ slug: string | null }>('SELECT slug FROM workspaces WHERE id = ?', ws))?.slug ?? null;
}

/** The workspace's public slug, created from its name the first time it is needed. Stable afterwards (renaming the workspace does not change it). */
export async function ensureWorkspaceSlug(deps: Deps, ws: string): Promise<string> {
  const row = await deps.db.get<{ slug: string | null; name: string }>('SELECT slug, name FROM workspaces WHERE id = ?', ws);
  if (!row) throw notFound('Workspace');
  if (row.slug) return row.slug;
  const candidates = await pickSlug(slugify(row.name, 'workspace'), async (s) => !!(await deps.db.get('SELECT 1 FROM workspaces WHERE slug = ?', s)));
  for (const slug of candidates) {
    try {
      await inTx(deps, (d) => d.db.run('UPDATE workspaces SET slug = ? WHERE id = ? AND slug IS NULL', slug, ws));
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
    const now = await workspaceSlugOf(deps, ws);
    if (now) return now;
  }
  throw conflict('SLUG_UNAVAILABLE', 'Could not find a free address name for this workspace');
}

export async function ensureFunnelSlug(deps: Deps, f: Pick<FunnelRow, 'id' | 'workspace_id' | 'name' | 'public_slug'>): Promise<string> {
  if (f.public_slug) return f.public_slug;
  const current = (await deps.db.get<{ public_slug: string | null }>('SELECT public_slug FROM funnels WHERE id = ? AND workspace_id = ?', f.id, f.workspace_id))?.public_slug;
  if (current) return current;
  const candidates = await pickSlug(slugify(f.name, 'funnel'), async (s) => !!(await deps.db.get('SELECT 1 FROM funnels WHERE workspace_id = ? AND public_slug = ?', f.workspace_id, s)));
  for (const slug of candidates) {
    try {
      await inTx(deps, (d) => d.db.run('UPDATE funnels SET public_slug = ? WHERE id = ? AND workspace_id = ? AND public_slug IS NULL', slug, f.id, f.workspace_id));
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
    const now = (await deps.db.get<{ public_slug: string | null }>('SELECT public_slug FROM funnels WHERE id = ?', f.id))?.public_slug;
    if (now) return now;
  }
  throw conflict('SLUG_UNAVAILABLE', 'Could not find a free address name for this funnel');
}

/** Changes a funnel's address name. The old URL stops working (there is no redirect: the name is part of the address people were given). */
export async function setFunnelSlug(deps: Deps, ws: string, funnelId: string, slug: string): Promise<void> {
  const taken = await deps.db.get<{ id: string }>('SELECT id FROM funnels WHERE workspace_id = ? AND public_slug = ? AND id <> ?', ws, slug, funnelId);
  if (taken) throw conflict('SLUG_TAKEN', 'Another funnel in this workspace already uses this address name', { suggestions: await pickSlug(slug, async (s) => !!(await deps.db.get('SELECT 1 FROM funnels WHERE workspace_id = ? AND public_slug = ?', ws, s))).then((l) => l.slice(0, 3)) });
  try {
    await inTx(deps, (d) => d.db.run('UPDATE funnels SET public_slug = ? WHERE id = ? AND workspace_id = ?', slug, funnelId, ws));
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('SLUG_TAKEN', 'Another funnel in this workspace already uses this address name');
    throw e;
  }
}

export async function setWorkspaceSlug(deps: Deps, ws: string, slug: string): Promise<void> {
  const taken = await deps.db.get('SELECT 1 FROM workspaces WHERE slug = ? AND id <> ?', slug, ws);
  if (taken) throw conflict('SLUG_TAKEN', 'This workspace address name is already taken');
  try {
    await inTx(deps, (d) => d.db.run('UPDATE workspaces SET slug = ? WHERE id = ?', slug, ws));
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('SLUG_TAKEN', 'This workspace address name is already taken');
    throw e;
  }
}

// ---- system domains -------------------------------------------------------------------------------------------------------------------------------------

const builtinHostname = (ws: string) => `${ws.toLowerCase()}.builtin.invalid`;
const pagesHostname = (funnelId: string) => `${funnelId.toLowerCase()}.pages.invalid`;

/** The workspace's built-in address record: created on first use, always active, never verified or deleted by the customer. */
export async function ensureBuiltinDomain(deps: Deps, ws: string): Promise<DomainRow> {
  const find = () => deps.db.get<DomainRow>("SELECT * FROM domains WHERE workspace_id = ? AND kind = 'builtin'", ws);
  const found = await find();
  if (found) return found;
  const at = deps.now().toISOString();
  await deps.db.run(
    `INSERT INTO domains (id, workspace_id, hostname, status, verification_token, provider, kind, verified_at, created_at, updated_at) VALUES (?, ?, ?, 'active', '', 'manual', 'builtin', ?, ?, ?)${deps.db.dialect.onConflictDoNothing()}`,
    newId('dom'), ws, builtinHostname(ws), at, at, at,
  );
  return (await find())!;
}

/** The record for a funnel's `<project>.pages.dev` address. Pending until the first deployment succeeds, then active. */
export async function ensurePagesDomain(deps: Deps, ws: string, funnelId: string, status: 'pending' | 'active' = 'pending'): Promise<DomainRow> {
  const find = () => deps.db.get<DomainRow>("SELECT * FROM domains WHERE workspace_id = ? AND kind = 'pages' AND system_funnel_id = ?", ws, funnelId);
  const found = await find();
  if (found) return found;
  const at = deps.now().toISOString();
  await deps.db.run(
    `INSERT INTO domains (id, workspace_id, hostname, status, verification_token, provider, kind, system_funnel_id, verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'manual', 'pages', ?, ?, ?, ?)${deps.db.dialect.onConflictDoNothing()}`,
    newId('dom'), ws, pagesHostname(funnelId), status, funnelId, status === 'active' ? at : null, at, at,
  );
  return (await find())!;
}

export const isSystemDomain = (d: Pick<DomainRow, 'kind'> | null | undefined): boolean => !!d && d.kind !== 'custom';

// ---- URLs -----------------------------------------------------------------------------------------------------------------------------------------------

export interface Address {
  kind: AddressKind;
  /** `https://host` (no trailing slash) */
  origin: string;
  /** '' for custom and pages addresses, `/s/<workspace>/<funnel>` for built-in ones */
  prefix: string;
  /** origin + prefix */
  base: string;
  /** The host people see: the custom hostname, the app host, or `<project>.pages.dev`. */
  host: string;
}

const hostOfOrigin = (o: string) => {
  try {
    return new URL(o).host;
  } catch {
    return o;
  }
};

/** Pure: the address of `funnel` on `domain`. Null when the pieces are not there yet (no slugs, no Pages host). */
export function addressFrom(deps: Pick<Deps, 'config'>, funnel: Pick<FunnelRow, 'public_slug'>, domain: Pick<DomainRow, 'kind' | 'hostname'>, extra: { workspaceSlug: string | null; pagesHost: string | null }): Address | null {
  if (domain.kind === 'builtin') {
    if (!extra.workspaceSlug || !funnel.public_slug) return null;
    const origin = appOrigin(deps);
    const prefix = builtinPrefix(extra.workspaceSlug, funnel.public_slug);
    return { kind: 'builtin', origin, prefix, base: origin + prefix, host: hostOfOrigin(origin) };
  }
  if (domain.kind === 'pages') {
    if (!extra.pagesHost) return null;
    const origin = `https://${extra.pagesHost}`;
    return { kind: 'pages', origin, prefix: '', base: origin, host: extra.pagesHost };
  }
  const origin = `https://${domain.hostname}`;
  return { kind: 'custom', origin, prefix: '', base: origin, host: domain.hostname };
}

export async function pagesHostOf(deps: Pick<Deps, 'db'>, funnelId: string): Promise<string | null> {
  return (await deps.db.get<{ pages_host: string | null }>(`SELECT pages_host FROM funnel_publish WHERE funnel_id = ? AND target IN ${CF_TARGETS_SQL}`, funnelId))?.pages_host ?? null;
}

/** Reads what addressFrom needs. Does not create slugs (lists must not write); use `ensure*` before attaching a built-in domain. */
export async function addressOf(deps: Deps, funnel: FunnelRow, domain: DomainRow | undefined | null): Promise<Address | null> {
  if (!domain) return null;
  return addressFrom(deps, funnel, domain, {
    workspaceSlug: domain.kind === 'builtin' ? await workspaceSlugOf(deps, funnel.workspace_id) : null,
    pagesHost: domain.kind === 'pages' ? await pagesHostOf(deps, funnel.id) : null,
  });
}

export const stepUrl = (a: Address, basePath: string): string => a.base + (basePath === '' ? '/' : basePath);

/** What the page renderer needs to serve a funnel under a path prefix: internal links, the canonical URL and the cookie scope. */
export interface Mount {
  prefix: string;
  origin: string;
  cookiePath: string;
}

/** The mount of a funnel (only built-in addresses have one). Creates missing slugs, so call it where writing is fine (render on save, attach). */
export async function mountOf(deps: Deps, funnel: FunnelRow): Promise<Mount | null> {
  if (!funnel.domain_id) return null;
  const domain = await deps.db.get<Pick<DomainRow, 'kind'>>('SELECT kind FROM domains WHERE id = ? AND workspace_id = ?', funnel.domain_id, funnel.workspace_id);
  if (domain?.kind !== 'builtin') return null;
  const wsSlug = await ensureWorkspaceSlug(deps, funnel.workspace_id);
  const funSlug = await ensureFunnelSlug(deps, funnel);
  return { prefix: builtinPrefix(wsSlug, funSlug), origin: appOrigin(deps), cookiePath: builtinCookiePath(wsSlug) };
}

/** Stable string for "did the way this funnel is rendered change?" comparisons. */
export const mountKey = (m: Mount | null): string => (m ? `${m.origin}${m.prefix}` : '');

export interface StepAddressRow {
  kind: DomainRow['kind'];
  hostname: string;
  ws_slug: string | null;
  public_slug: string | null;
  pages_host: string | null;
  base_path: string;
  step_id: string;
}

/** The public URL of each step of a funnel on the address it is attached to (`stepId` narrows it to one step). Reads only; empty when the funnel has no usable address. */
export async function stepUrls(deps: Pick<Deps, 'db' | 'config'>, ws: string, funnelId: string, stepId?: string | null): Promise<{ stepId: string; url: string; address: Address }[]> {
  const rows = await deps.db.all<StepAddressRow>(
    `SELECT d.kind, d.hostname, w.slug AS ws_slug, f.public_slug, fp.pages_host, s.base_path, s.id AS step_id
     FROM funnels f JOIN domains d ON d.id = f.domain_id JOIN workspaces w ON w.id = f.workspace_id JOIN steps s ON s.funnel_id = f.id
     LEFT JOIN funnel_publish fp ON fp.funnel_id = f.id
     WHERE f.workspace_id = ? AND f.id = ? ${stepId ? 'AND s.id = ?' : ''} ORDER BY s.position, s.id`,
    ws, funnelId, ...(stepId ? [stepId] : []),
  );
  const out: { stepId: string; url: string; address: Address }[] = [];
  for (const r of rows) {
    const a = addressFrom(deps, { public_slug: r.public_slug }, { kind: r.kind, hostname: r.hostname }, { workspaceSlug: r.ws_slug, pagesHost: r.pages_host });
    if (a) out.push({ stepId: r.step_id, url: stepUrl(a, r.base_path), address: a });
  }
  return out;
}

export { hostOfOrigin };
