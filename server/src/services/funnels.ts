import { createHash } from 'node:crypto';
import { z } from 'zod';
import { atLeast, type Auth } from '../auth/context.js';
import { defaultStepDocument, firstHeading, safeUrl, type PageDocument } from '../blocks/index.js';
import type { Deps } from '../deps.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  activeFunnelNames, insertFunnel, listSteps, patchFunnel, requireFunnel, requireTags, setFunnelTags, tagsByFunnel,
} from '../repos/funnels.js';
import { like, placeholders } from '../repos/sql.js';
import type { DomainRow, FunnelRow, StepRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { copyName, copyPath, isValidPath, pathKey, slugPath, suggestPaths } from './paths.js';
import { domainPathIndex, funnelDomainConflicts } from './pathconflicts.js';
import { regenerateFunnel, scriptsAllowedFor } from './pages.js';
import { remapStepRefs } from './docs.js';
import { liveUrlsForFunnel, schedulePurge } from '../edge/purger.js';
import { insertStep, assertValidPath, serializeStep } from './steps.js';

const iso = (deps: Deps) => deps.now().toISOString();

const faviconSchema = z.string().max(2048).refine((u) => safeUrl(u, ['http', 'https']) !== null, 'Favicon must be an http(s) or relative URL');
const code = z.string().max(20_000).nullable();

export const ConflictResolution = z.array(z.object({ path: z.string().max(300), resolved_path: z.string().max(300) })).max(500);

export const CreateFunnelInput = z.object({
  name: z.string().trim().min(1).max(120),
  base_path: z.string().max(200).optional(),
  domain_id: z.string().max(64).nullish(),
  status: z.enum(['live', 'test']).optional(),
  favicon: faviconSchema.nullish(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  header_tracking_code: code.optional(),
  footer_tracking_code: code.optional(),
  conflicts: ConflictResolution.optional(),
});

export const UpdateFunnelInput = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['live', 'test']).optional(),
  favicon: faviconSchema.nullish(),
  domain_id: z.string().max(64).nullish(),
  tags: z.array(z.string().max(64)).max(50).optional(),
  header_tracking_code: code.optional(),
  footer_tracking_code: code.optional(),
  conflicts: ConflictResolution.optional(),
});

export const ListQuery = z.object({
  search: z.string().max(100).optional(),
  status: z.string().max(20).optional(),
  tags: z.string().max(2000).optional(),
  domain_connected: z.enum(['true', 'false']).optional(),
  sort: z.enum(['updated', 'created', 'name']).default('updated'),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function gradientFor(id: string): { from: string; to: string } {
  const h = createHash('sha256').update(id).digest();
  const hue = ((h[0]! << 8) | h[1]!) % 360;
  return { from: `hsl(${hue} 70% 55%)`, to: `hsl(${(hue + 50) % 360} 75% 40%)` };
}

export interface FunnelStats {
  visits: number;
  optins: number;
  orders: number;
  sales: number;
}

function statsFor(deps: Deps, ws: string, ids: string[]): Map<string, FunnelStats> {
  const map = new Map<string, FunnelStats>();
  if (ids.length === 0) return map;
  deps.events.flush();
  const rows = deps.db.all<{ funnel_id: string; visits: number; optins: number; orders: number; cents: number }>(
    `SELECT funnel_id, SUM(page_views) AS visits, SUM(optins) AS optins, SUM(orders) AS orders, SUM(cents) AS cents
     FROM event_rollups WHERE workspace_id = ? AND funnel_id IN (${placeholders(ids.length)}) GROUP BY funnel_id`,
    ws, ...ids,
  );
  for (const r of rows) map.set(r.funnel_id, { visits: r.visits, optins: r.optins, orders: r.orders, sales: r.cents / 100 });
  return map;
}

function thumbnails(deps: Deps, ids: string[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  if (ids.length === 0) return map;
  const rows = deps.db.all<{ funnel_id: string; doc_json: string }>(
    `SELECT s.funnel_id, p.doc_json FROM steps s JOIN step_pages p ON p.step_id = s.id
     WHERE s.funnel_id IN (${placeholders(ids.length)}) AND s.position = (SELECT MIN(position) FROM steps WHERE funnel_id = s.funnel_id)`,
    ...ids,
  );
  for (const r of rows) {
    try {
      map.set(r.funnel_id, firstHeading(JSON.parse(r.doc_json) as PageDocument));
    } catch {
      map.set(r.funnel_id, null);
    }
  }
  return map;
}

type Summary = ReturnType<typeof summarize>;

function summarize(f: FunnelRow, extra: { domain: Pick<DomainRow, 'id' | 'hostname' | 'status'> | null; tags: { id: string; name: string }[]; stepCount: number; stats: FunnelStats; heading: string | null }) {
  return {
    id: f.id,
    name: f.name,
    basePath: f.base_path,
    status: f.status,
    favicon: f.favicon,
    headerTrackingCode: f.header_tracking_code,
    footerTrackingCode: f.footer_tracking_code,
    domain: extra.domain ? { id: extra.domain.id, hostname: extra.domain.hostname, status: extra.domain.status } : null,
    tags: extra.tags,
    stepCount: extra.stepCount,
    stats: extra.stats,
    thumbnail: { heading: extra.heading ?? f.name, ...gradientFor(f.id) },
    createdAt: f.created_at,
    updatedAt: f.updated_at,
    deletedAt: f.deleted_at,
  };
}

const EMPTY_STATS: FunnelStats = { visits: 0, optins: 0, orders: 0, sales: 0 };

function summaries(deps: Deps, ws: string, rows: FunnelRow[]): Summary[] {
  const ids = rows.map((r) => r.id);
  const stats = statsFor(deps, ws, ids);
  const tags = tagsByFunnel(deps.db, ws, ids);
  const headings = thumbnails(deps, ids);
  const counts = new Map(
    ids.length
      ? deps.db.all<{ funnel_id: string; n: number }>(`SELECT funnel_id, COUNT(*) AS n FROM steps WHERE workspace_id = ? AND funnel_id IN (${placeholders(ids.length)}) GROUP BY funnel_id`, ws, ...ids).map((r) => [r.funnel_id, r.n])
      : [],
  );
  const domainIds = [...new Set(rows.map((r) => r.domain_id).filter(Boolean))] as string[];
  const domains = new Map(
    domainIds.length
      ? deps.db.all<DomainRow>(`SELECT * FROM domains WHERE workspace_id = ? AND id IN (${placeholders(domainIds.length)})`, ws, ...domainIds).map((d) => [d.id, d])
      : [],
  );
  return rows.map((f) =>
    summarize(f, {
      domain: f.domain_id ? (domains.get(f.domain_id) ?? null) : null,
      tags: tags.get(f.id) ?? [],
      stepCount: counts.get(f.id) ?? 0,
      stats: stats.get(f.id) ?? EMPTY_STATS,
      heading: headings.get(f.id) ?? null,
    }),
  );
}

export function listFunnels(deps: Deps, ws: string, q: z.infer<typeof ListQuery>) {
  const where = ['f.workspace_id = ?', 'f.deleted_at IS NULL'];
  const params: (string | number)[] = [ws];
  if (q.search?.trim()) {
    where.push(`f.name LIKE ? ESCAPE '\\'`);
    params.push(like(q.search.trim()));
  }
  const statuses = (q.status ?? '').split(',').map((s) => s.trim()).filter((s) => s === 'live' || s === 'test');
  if (statuses.length) {
    where.push(`f.status IN (${placeholders(statuses.length)})`);
    params.push(...statuses);
  }
  const tagIds = (q.tags ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (tagIds.length) {
    where.push(`f.id IN (SELECT ft.funnel_id FROM funnel_tags ft JOIN tags t ON t.id = ft.tag_id WHERE t.workspace_id = ? AND ft.tag_id IN (${placeholders(tagIds.length)}))`);
    params.push(ws, ...tagIds);
  }
  if (q.domain_connected) where.push(q.domain_connected === 'true' ? 'f.domain_id IS NOT NULL' : 'f.domain_id IS NULL');
  const column = { updated: 'f.updated_at', created: 'f.created_at', name: 'f.name COLLATE NOCASE' }[q.sort];
  const dir = (q.order ?? (q.sort === 'name' ? 'asc' : 'desc')).toUpperCase();
  const clause = where.join(' AND ');
  const total = deps.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM funnels f WHERE ${clause}`, ...params)!.n;
  const rows = deps.db.all<FunnelRow>(
    `SELECT f.* FROM funnels f WHERE ${clause} ORDER BY ${column} ${dir}, f.id ${dir} LIMIT ? OFFSET ?`,
    ...params, q.limit, (q.page - 1) * q.limit,
  );
  return { data: summaries(deps, ws, rows), pagination: { page: q.page, limit: q.limit, total, totalPages: Math.max(1, Math.ceil(total / q.limit)) } };
}

export function listTrash(deps: Deps, ws: string) {
  const rows = deps.db.all<FunnelRow>('SELECT * FROM funnels WHERE workspace_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC', ws);
  return { data: summaries(deps, ws, rows) };
}

export function filterCounts(deps: Deps, ws: string) {
  const status = deps.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM funnels WHERE workspace_id = ? AND deleted_at IS NULL GROUP BY status', ws);
  const domain = deps.db.get<{ connected: number; total: number }>(
    'SELECT COALESCE(SUM(domain_id IS NOT NULL), 0) AS connected, COUNT(*) AS total FROM funnels WHERE workspace_id = ? AND deleted_at IS NULL', ws,
  )!;
  const tags = deps.db.all<{ id: string; name: string; n: number }>(
    `SELECT t.id, t.name, COUNT(f.id) AS n FROM tags t
     LEFT JOIN funnel_tags ft ON ft.tag_id = t.id LEFT JOIN funnels f ON f.id = ft.funnel_id AND f.deleted_at IS NULL
     WHERE t.workspace_id = ? GROUP BY t.id ORDER BY t.name_lower`, ws,
  );
  return {
    status: { live: status.find((s) => s.status === 'live')?.n ?? 0, test: status.find((s) => s.status === 'test')?.n ?? 0 },
    domainConnected: { connected: domain.connected, notConnected: domain.total - domain.connected },
    tags: tags.map((t) => ({ id: t.id, name: t.name, count: t.n })),
  };
}

export function getFunnelDetail(deps: Deps, ws: string, id: string, includeDeleted = false) {
  const f = requireFunnel(deps.db, ws, id, includeDeleted);
  const [summary] = summaries(deps, ws, [f]);
  const domain = f.domain_id ? deps.db.get<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND id = ?', ws, f.domain_id) : undefined;
  const steps = listSteps(deps.db, ws, id).map((s) =>
    serializeStep(s, { isHome: domain?.default_home_step_id === s.id, is404: domain?.default_404_step_id === s.id }),
  );
  return { ...summary!, steps };
}

function requireDomain(deps: Deps, ws: string, id: string): DomainRow {
  const d = deps.db.get<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND id = ?', ws, id);
  if (!d) throw notFound('Domain');
  return d;
}

function assertTrackingRole(auth: Auth, input: { header_tracking_code?: unknown; footer_tracking_code?: unknown }): void {
  if ((input.header_tracking_code !== undefined || input.footer_tracking_code !== undefined) && !atLeast(auth.role, 'admin')) {
    throw forbidden('Only admins can edit tracking code');
  }
}

/**
 * Validates the client's conflict-resolution payload against a fresh server-side computation and
 * applies the renames. The client list must be a subset of what the server finds (never invents
 * paths) and must cover every conflict; replacement paths must themselves be valid and free.
 */
function resolveDomainConflicts(deps: Deps, ws: string, funnel: FunnelRow, domainId: string, client: z.infer<typeof ConflictResolution> | undefined): boolean {
  const server = funnelDomainConflicts(deps.db, ws, funnel.id, domainId);
  if (server.length === 0) return false;
  if (!client || client.length === 0) throw conflict('PATH_CONFLICT', 'Some step paths are already used on this domain', { conflicts: server });
  if (client.length > server.length) throw badRequest('ROUTES_COUNT_MISMATCH', 'More conflicts were supplied than exist');
  const byKey = new Map(server.map((c) => [pathKey(c.path), c]));
  const chosen = new Map<string, string>();
  for (const item of client) {
    const key = pathKey(item.path);
    if (!byKey.has(key) || chosen.has(key)) throw badRequest('ROUTES_MISMATCH', `"${item.path}" is not a conflicting path of this funnel`);
    chosen.set(key, item.resolved_path);
  }
  const unresolved = server.filter((c) => !chosen.has(pathKey(c.path)));
  if (unresolved.length) throw conflict('PATH_CONFLICT_UNRESOLVED', 'Every conflicting path needs a replacement', { conflicts: unresolved });

  const reserved = new Set([...domainPathIndex(deps.db, ws, domainId, funnel.id).keys(), ...listSteps(deps.db, ws, funnel.id).map((s) => s.path_key)]);
  const used = new Set<string>();
  for (const [key, resolved] of chosen) {
    const rk = pathKey(resolved);
    if (!isValidPath(resolved) || reserved.has(rk) || used.has(rk)) {
      throw badRequest('INVALID_RESOLVED_PATH', `"${resolved}" cannot be used as a replacement`, { uniquePaths: suggestPaths(byKey.get(key)!.path, new Set([...reserved, ...used])) });
    }
    used.add(rk);
  }
  const at = iso(deps);
  for (const c of server) {
    const resolved = chosen.get(pathKey(c.path))!;
    deps.db.run('UPDATE steps SET base_path = ?, path_key = ?, updated_at = ? WHERE id = ?', resolved, pathKey(resolved), at, c.stepId);
    if (pathKey(funnel.base_path) === pathKey(c.path)) patchFunnel(deps.db, ws, funnel.id, { base_path: resolved });
  }
  return true;
}

export function createFunnel(deps: Deps, auth: Auth, input: z.infer<typeof CreateFunnelInput>) {
  const ws = auth.workspaceId;
  assertTrackingRole(auth, input);
  const basePath = input.base_path ?? slugPath(input.name);
  assertValidPath(basePath);
  return deps.db.tx(() => {
    const at = iso(deps);
    const domain = input.domain_id ? requireDomain(deps, ws, input.domain_id) : null;
    if (domain && domain.status !== 'active') throw conflict('DOMAIN_NOT_ACTIVE', 'The domain is not verified yet');
    const status = input.status ?? 'test';
    if (status === 'live' && !domain) throw conflict('DOMAIN_NOT_ADDED', 'Publishing needs an active domain');
    const id = newId('fn');
    requireTags(deps.db, ws, input.tags ?? []);
    insertFunnel(deps.db, {
      id, workspace_id: ws, name: input.name, base_path: basePath, domain_id: domain?.id ?? null, status,
      favicon: input.favicon ?? null, header_tracking_code: input.header_tracking_code ?? null, footer_tracking_code: input.footer_tracking_code ?? null,
      created_by: auth.userId, created_at: at, updated_at: at,
    });
    const funnel = requireFunnel(deps.db, ws, id);
    if (domain) {
      const hit = domainPathIndex(deps.db, ws, domain.id).get(pathKey(basePath));
      if (hit) {
        const resolved = input.conflicts?.find((c) => pathKey(c.path) === pathKey(basePath))?.resolved_path;
        const taken = new Set(domainPathIndex(deps.db, ws, domain.id).keys());
        if (!resolved) throw conflict('PATH_CONFLICT', `The path is already used on this domain by "${hit.funnelName}"`, { conflicts: [{ path: basePath, resolved_path: suggestPaths(basePath, taken, 1)[0] }], uniquePaths: suggestPaths(basePath, taken) });
        if (!isValidPath(resolved) || taken.has(pathKey(resolved))) throw badRequest('INVALID_RESOLVED_PATH', `"${resolved}" cannot be used as a replacement`);
        patchFunnel(deps.db, ws, id, { base_path: resolved });
        funnel.base_path = resolved;
      }
    }
    insertStep(deps, ws, funnel, { name: 'Landing page', base_path: funnel.base_path, doc: defaultStepDocument(input.name), scriptsOk: false });
    if (input.tags?.length) setFunnelTags(deps.db, ws, id, input.tags);
    regenerateFunnel(deps, ws, id);
    return getFunnelDetail(deps, ws, id);
  });
}

/**
 * Status/domain state machine.
 *  - `status: "test"` always detaches the domain (a test funnel never keeps one).
 *  - `domain_id: null` detaches; a live funnel without a domain falls back to test.
 *  - `status: "live"` needs an attached, ACTIVE domain.
 *  - attaching a domain needs it to be ACTIVE and runs the cross-funnel path conflict check.
 */
export function updateFunnel(deps: Deps, auth: Auth, id: string, input: z.infer<typeof UpdateFunnelInput>) {
  const ws = auth.workspaceId;
  assertTrackingRole(auth, input);
  return deps.db.tx(() => {
    const funnel = requireFunnel(deps.db, ws, id);
    const urlsBefore = liveUrlsForFunnel(deps, id);
    let domainId: string | null = input.domain_id !== undefined ? (input.domain_id ?? null) : funnel.domain_id;
    let status = input.status ?? funnel.status;
    if (input.status === 'test') domainId = null;
    if (input.domain_id === null && input.status === undefined && status === 'live') status = 'test';
    if (status === 'live' && !domainId) throw conflict('DOMAIN_NOT_ADDED', 'Publishing needs an active domain');

    let pathsChanged = false;
    if (domainId) {
      const domain = requireDomain(deps, ws, domainId);
      if (domain.status !== 'active') throw conflict('DOMAIN_NOT_ACTIVE', 'The domain is not verified yet');
      if (domainId !== funnel.domain_id) pathsChanged = resolveDomainConflicts(deps, ws, funnel, domainId, input.conflicts);
    }

    const fields: Record<string, string | number | null> = { status, domain_id: domainId, updated_at: iso(deps) };
    if (input.name !== undefined) fields.name = input.name;
    if (input.favicon !== undefined) fields.favicon = input.favicon;
    if (input.header_tracking_code !== undefined) fields.header_tracking_code = input.header_tracking_code || null;
    if (input.footer_tracking_code !== undefined) fields.footer_tracking_code = input.footer_tracking_code || null;
    patchFunnel(deps.db, ws, id, fields);
    if (input.tags) setFunnelTags(deps.db, ws, id, input.tags);
    if (pathsChanged || input.favicon !== undefined || input.header_tracking_code !== undefined || input.footer_tracking_code !== undefined) regenerateFunnel(deps, ws, id);
    schedulePurge(deps, [...urlsBefore, ...liveUrlsForFunnel(deps, id)]);
    return getFunnelDetail(deps, ws, id);
  });
}

export function duplicateFunnel(deps: Deps, auth: Auth, id: string) {
  const ws = auth.workspaceId;
  return deps.db.tx(() => {
    const source = requireFunnel(deps.db, ws, id);
    const at = iso(deps);
    const newFunnelId = newId('fn');
    const takenPaths = new Set(deps.db.all<{ p: string }>('SELECT base_path AS p FROM funnels WHERE workspace_id = ? AND deleted_at IS NULL', ws).map((r) => pathKey(r.p)));
    insertFunnel(deps.db, {
      ...source, id: newFunnelId, name: copyName(source.name, activeFunnelNames(deps.db, ws)), base_path: copyPath(source.base_path, takenPaths),
      domain_id: null, status: 'test', created_by: auth.userId, created_at: at, updated_at: at,
    });
    const funnel = requireFunnel(deps.db, ws, newFunnelId);
    cloneSteps(deps, auth, source.id, funnel);
    for (const t of tagsByFunnel(deps.db, ws, [id]).get(id) ?? []) deps.db.run('INSERT INTO funnel_tags (funnel_id, tag_id) VALUES (?, ?)', newFunnelId, t.id);
    regenerateFunnel(deps, ws, newFunnelId);
    return getFunnelDetail(deps, ws, newFunnelId);
  });
}

/** Copies every step of `sourceId` (same workspace) into `target`, remapping "go to step" actions to the new step ids. */
function cloneSteps(deps: Deps, auth: Auth, sourceId: string, target: FunnelRow): void {
  const ws = auth.workspaceId;
  const steps = listSteps(deps.db, ws, sourceId);
  const pages = new Map(deps.db.all<{ step_id: string; doc_json: string; scripts_ok: number }>('SELECT step_id, doc_json, scripts_ok FROM step_pages WHERE workspace_id = ? AND funnel_id = ?', ws, sourceId).map((p) => [p.step_id, p]));
  const idMap = new Map(steps.map((s) => [s.id, newId('stp')]));
  const canScripts = scriptsAllowedFor(deps, auth);
  for (const s of steps) {
    const page = pages.get(s.id);
    const doc = remapStepRefs(page ? JSON.parse(page.doc_json) : defaultStepDocument(s.name), idMap);
    const copy = insertStep(deps, ws, target, { name: s.name, base_path: s.base_path, doc, scriptsOk: page?.scripts_ok === 1 && canScripts }, idMap.get(s.id));
    deps.db.run('UPDATE steps SET title = ?, seo_description = ?, custom_css = ?, header_tracking_code = ?, footer_tracking_code = ? WHERE id = ?', s.title, s.seo_description, s.custom_css, s.header_tracking_code, s.footer_tracking_code, copy.id);
  }
}

export type TemplateStepInput = { name: string; base_path: string; doc: PageDocument };

/** Creates a funnel with the given steps (templates, AI generation). Step ids in "go to step" actions are remapped by position index key. */
export function createFunnelFromSteps(deps: Deps, auth: Auth, opts: { name: string; basePath: string; steps: (TemplateStepInput & { refId?: string })[] }) {
  const ws = auth.workspaceId;
  return deps.db.tx(() => {
    const at = iso(deps);
    const id = newId('fn');
    const name = uniqueFunnelName(deps, ws, opts.name);
    insertFunnel(deps.db, {
      id, workspace_id: ws, name, base_path: opts.basePath, domain_id: null, status: 'test', favicon: null,
      header_tracking_code: null, footer_tracking_code: null, created_by: auth.userId, created_at: at, updated_at: at,
    });
    const funnel = requireFunnel(deps.db, ws, id);
    const idMap = new Map(opts.steps.map((s) => [s.refId ?? s.base_path, newId('stp')]));
    for (const s of opts.steps) {
      insertStep(deps, ws, funnel, { name: s.name, base_path: s.base_path, doc: remapStepRefs(s.doc, idMap), scriptsOk: false }, idMap.get(s.refId ?? s.base_path));
    }
    regenerateFunnel(deps, ws, id);
    return getFunnelDetail(deps, ws, id);
  });
}

function uniqueFunnelName(deps: Deps, ws: string, base: string): string {
  const used = new Set(activeFunnelNames(deps.db, ws).map((n) => n.toLowerCase()));
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
  return name;
}

/** Soft delete: the funnel leaves lists and public serving, loses its domain (freeing the paths) but keeps all data. */
export function softDeleteFunnel(deps: Deps, auth: Auth, id: string): void {
  const ws = auth.workspaceId;
  deps.db.tx(() => {
    requireFunnel(deps.db, ws, id);
    schedulePurge(deps, liveUrlsForFunnel(deps, id));
    const at = iso(deps);
    patchFunnel(deps.db, ws, id, { deleted_at: at, status: 'test', domain_id: null, updated_at: at });
    deps.pageCache.invalidate(listSteps(deps.db, ws, id).map((s) => s.id));
  });
}

export function restoreFunnel(deps: Deps, auth: Auth, id: string) {
  const ws = auth.workspaceId;
  deps.db.tx(() => {
    const f = requireFunnel(deps.db, ws, id, true);
    if (!f.deleted_at) throw conflict('NOT_DELETED', 'The funnel is not in the trash');
    patchFunnel(deps.db, ws, id, { deleted_at: null, updated_at: iso(deps) });
  });
  return getFunnelDetail(deps, ws, id);
}

/** Hard delete (owner only, trash only). Steps, pages, backups, events and orders go with it via ON DELETE CASCADE. */
export function purgeFunnel(deps: Deps, auth: Auth, id: string): void {
  const ws = auth.workspaceId;
  deps.db.tx(() => {
    const f = requireFunnel(deps.db, ws, id, true);
    if (!f.deleted_at) throw conflict('NOT_IN_TRASH', 'Move the funnel to the trash before purging it');
    const stepIds = listSteps(deps.db, ws, id).map((s) => s.id);
    deps.db.run('UPDATE domains SET default_home_step_id = NULL WHERE workspace_id = ? AND default_home_step_id IN (SELECT id FROM steps WHERE funnel_id = ?)', ws, id);
    deps.db.run('UPDATE domains SET default_404_step_id = NULL WHERE workspace_id = ? AND default_404_step_id IN (SELECT id FROM steps WHERE funnel_id = ?)', ws, id);
    deps.db.run('DELETE FROM funnels WHERE workspace_id = ? AND id = ?', ws, id);
    deps.pageCache.invalidate(stepIds);
  });
}

export const BulkTagInput = z.object({
  funnelIds: z.array(z.string().max(64)).min(1).max(200),
  addTagIds: z.array(z.string().max(64)).max(50).default([]),
  removeTagIds: z.array(z.string().max(64)).max(50).default([]),
});

export function bulkTag(deps: Deps, ws: string, input: z.infer<typeof BulkTagInput>) {
  return deps.db.tx(() => {
    const funnels = input.funnelIds.map((id) => requireFunnel(deps.db, ws, id));
    requireTags(deps.db, ws, [...input.addTagIds, ...input.removeTagIds]);
    for (const f of funnels) {
      for (const t of input.addTagIds) deps.db.run('INSERT OR IGNORE INTO funnel_tags (funnel_id, tag_id) VALUES (?, ?)', f.id, t);
      for (const t of input.removeTagIds) deps.db.run('DELETE FROM funnel_tags WHERE funnel_id = ? AND tag_id = ?', f.id, t);
      patchFunnel(deps.db, ws, f.id, { updated_at: iso(deps) });
    }
    return { updated: funnels.length };
  });
}

export type { StepRow };
