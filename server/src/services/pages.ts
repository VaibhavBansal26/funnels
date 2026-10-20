import { createHash } from 'node:crypto';
import { z } from 'zod';
import { parseDocument, renderPage, type PageDocument, type RenderContext, LIMITS } from '../blocks/index.js';
import { can, type Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { AppError, conflict, notFound } from '../errors.js';
import { inTx } from '../db/scope.js';
import { lockFunnel, requireFunnel, requireStep, listSteps } from '../repos/funnels.js';
import type { BackupRow, FunnelRow, PageRow, StepRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { liveUrlsForFunnel, schedulePurge } from '../edge/purger.js';

export const MAX_BACKUPS = 10;

export const SaveInput = z.object({ doc: z.unknown(), version: z.number().int().optional(), backup: z.boolean().optional() });

export const checksumOf = (html: string): string => createHash('sha256').update(html).digest('hex').slice(0, 32);

const iso = (deps: Deps) => deps.now().toISOString();

export async function workspaceAllowsScripts(deps: Deps, ws: string): Promise<boolean> {
  return (await deps.db.get<{ v: number }>('SELECT allow_custom_scripts AS v FROM workspaces WHERE id = ?', ws))?.v === 1;
}

interface BuildInput {
  funnel: FunnelRow;
  steps: StepRow[];
  step: StepRow;
  docJson: string;
  scriptsOk: boolean;
  workspaceScripts: boolean;
  mode: 'live' | 'preview';
  hrefFor?: (s: StepRow) => string;
}

export function renderContext(deps: Deps, i: BuildInput): RenderContext {
  const join = (a: string | null, b: string | null) => [a, b].filter(Boolean).join('\n');
  return {
    funnelId: i.funnel.id,
    stepId: i.step.id,
    stepName: i.step.name,
    title: i.step.title,
    description: i.step.seo_description,
    customCss: i.step.custom_css,
    favicon: i.funnel.favicon,
    headerCode: join(i.funnel.header_tracking_code, i.step.header_tracking_code),
    footerCode: join(i.funnel.footer_tracking_code, i.step.footer_tracking_code),
    allowScripts: i.workspaceScripts && i.scriptsOk,
    allowTrackingCode: i.workspaceScripts,
    steps: i.steps.map((s) => ({ id: s.id, href: i.hrefFor ? i.hrefFor(s) : s.base_path })),
    mode: i.mode,
  };
}

export function renderStep(deps: Deps, i: BuildInput): { html: string; checksum: string } {
  const html = renderPage(JSON.parse(i.docJson), renderContext(deps, i));
  return { html, checksum: checksumOf(html) };
}

/** Re-renders every step of a funnel from its stored documents. Call after anything that changes links, ordering or shared settings. */
export async function regenerateFunnel(deps: Deps, ws: string, funnelId: string): Promise<void> {
  const funnel = await requireFunnel(deps.db, ws, funnelId, true);
  const steps = await listSteps(deps.db, ws, funnelId);
  const workspaceScripts = await workspaceAllowsScripts(deps, ws);
  const pages = new Map((await deps.db.all<PageRow>('SELECT * FROM step_pages WHERE workspace_id = ? AND funnel_id = ?', ws, funnelId)).map((p) => [p.step_id, p]));
  for (const step of steps) {
    const page = pages.get(step.id);
    if (!page) continue;
    const { html, checksum } = renderStep(deps, { funnel, steps, step, docJson: page.doc_json, scriptsOk: page.scripts_ok === 1, workspaceScripts, mode: 'live' });
    if (checksum !== page.checksum) await deps.db.run('UPDATE step_pages SET html = ?, checksum = ? WHERE step_id = ?', html, checksum, step.id);
  }
  deps.pageCache.invalidate(steps.map((s) => s.id));
  await schedulePurge(deps, await liveUrlsForFunnel(deps, funnelId));
}

export async function regenerateWorkspace(deps: Deps, ws: string): Promise<void> {
  for (const f of await deps.db.all<{ id: string }>('SELECT id FROM funnels WHERE workspace_id = ? ORDER BY id', ws)) await regenerateFunnel(deps, ws, f.id);
}

/** Creates the page row for a brand-new step (no backup: there is no previous version). */
export async function insertPage(deps: Deps, ws: string, funnel: FunnelRow, step: StepRow, doc: unknown, scriptsOk: boolean): Promise<void> {
  const docJson = JSON.stringify(doc);
  const steps = await listSteps(deps.db, ws, funnel.id);
  const { html, checksum } = renderStep(deps, { funnel, steps, step, docJson, scriptsOk, workspaceScripts: await workspaceAllowsScripts(deps, ws), mode: 'live' });
  await deps.db.run(
    'INSERT INTO step_pages (step_id, workspace_id, funnel_id, doc_json, html, checksum, scripts_ok, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    step.id, ws, funnel.id, docJson, html, checksum, scriptsOk ? 1 : 0, iso(deps),
  );
}

export const scriptsAllowedFor = async (deps: Deps, auth: Auth): Promise<boolean> => can(auth, 'workspace:manage') && (await workspaceAllowsScripts(deps, auth.workspaceId));

async function getPageRow(deps: Deps, ws: string, stepId: string): Promise<PageRow> {
  const p = await deps.db.get<PageRow>('SELECT * FROM step_pages WHERE workspace_id = ? AND step_id = ?', ws, stepId);
  if (!p) throw notFound('Page');
  return p;
}

export async function getPage(deps: Deps, ws: string, funnelId: string, stepId: string) {
  await requireFunnel(deps.db, ws, funnelId);
  const step = await requireStep(deps.db, ws, funnelId, stepId);
  const page = await getPageRow(deps, ws, stepId);
  return { stepId, version: step.version, checksum: page.checksum, updatedAt: page.updated_at, doc: JSON.parse(page.doc_json) as PageDocument };
}

export function validateDoc(raw: unknown): PageDocument {
  const r = parseDocument(raw);
  if (!r.ok) throw new AppError(400, 'INVALID_DOCUMENT', 'The page document is not valid', r.issues);
  if (JSON.stringify(r.doc).length > LIMITS.maxDocBytes) throw new AppError(413, 'DOCUMENT_TOO_LARGE', 'The page document is too large');
  return r.doc;
}

const nextVersion = (deps: Deps, prev: number): number => Math.max(prev + 1, deps.now().getTime());

async function pruneBackups(deps: Deps, stepId: string): Promise<void> {
  await deps.db.run(
    `DELETE FROM step_backups WHERE step_id = ? AND id NOT IN (
       SELECT id FROM step_backups WHERE step_id = ? ORDER BY created_at DESC, id DESC LIMIT ?)`,
    stepId, stepId, MAX_BACKUPS,
  );
}

export interface SaveOptions {
  expectedVersion?: number;
  /** Autosaves pass false so they do not flood the 10-slot history. */
  backup?: boolean;
}

/**
 * The one write path for page content: backup previous -> store doc + html -> bump version -> prune. All in one transaction.
 * The funnel row is locked first (lock order: domain, funnel, steps) and the step row next, so concurrent saves queue up and
 * the version check runs against the committed latest version: with N clients saving from the same base, exactly one wins.
 */
export async function savePage(deps: Deps, auth: Auth, funnelId: string, stepId: string, rawDoc: unknown, opts: SaveOptions = {}) {
  const ws = auth.workspaceId;
  const doc = validateDoc(rawDoc);
  return inTx(deps, async (d) => {
    const funnel = await lockFunnel(d.db, ws, funnelId);
    const step = await requireStep(d.db, ws, funnelId, stepId, true);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== step.version) {
      throw conflict('VERSION_CONFLICT', 'This page was changed elsewhere. Reload before saving.', { currentVersion: step.version });
    }
    const previous = await getPageRow(d, ws, stepId);
    const at = iso(d);
    if (opts.backup !== false) {
      await d.db.run(
        `INSERT INTO step_backups (id, workspace_id, funnel_id, step_id, version, label, doc_json, html, checksum, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('bk'), ws, funnelId, stepId, step.version, `${step.name} ${at.slice(0, 10)}`, previous.doc_json, previous.html, previous.checksum, auth.userId, at,
      );
    }
    const docJson = JSON.stringify(doc);
    const scriptsOk = await scriptsAllowedFor(d, auth);
    const steps = await listSteps(d.db, ws, funnelId);
    const { html, checksum } = renderStep(d, { funnel, steps, step, docJson, scriptsOk, workspaceScripts: await workspaceAllowsScripts(d, ws), mode: 'live' });
    await d.db.run('UPDATE step_pages SET doc_json = ?, html = ?, checksum = ?, scripts_ok = ?, updated_at = ? WHERE step_id = ?', docJson, html, checksum, scriptsOk ? 1 : 0, at, stepId);
    const version = nextVersion(d, step.version);
    // The WHERE on the old version is a second guard behind the row lock: it can only match once.
    const claimed = await d.db.run('UPDATE steps SET version = ?, updated_at = ? WHERE id = ? AND version = ?', version, at, stepId, step.version);
    if (claimed.changes !== 1) throw conflict('VERSION_CONFLICT', 'This page was changed elsewhere. Reload before saving.', { currentVersion: step.version });
    await d.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', at, funnelId);
    await pruneBackups(d, stepId);
    d.pageCache.invalidate([stepId]);
    await schedulePurge(d, await liveUrlsForFunnel(d, funnelId));
    return { stepId, version, checksum, updatedAt: at };
  });
}

export async function listBackups(deps: Deps, ws: string, funnelId: string, stepId: string) {
  await requireFunnel(deps.db, ws, funnelId);
  await requireStep(deps.db, ws, funnelId, stepId);
  return (await deps.db.all<BackupRow>('SELECT id, version, label, checksum, created_by, created_at FROM step_backups WHERE workspace_id = ? AND step_id = ? ORDER BY created_at DESC, id DESC', ws, stepId))
    .map((b) => ({ id: b.id, version: b.version, label: b.label, checksum: b.checksum, createdBy: b.created_by, createdAt: b.created_at }));
}

async function requireBackup(deps: Deps, ws: string, stepId: string, backupId: string): Promise<BackupRow> {
  const b = await deps.db.get<BackupRow>('SELECT * FROM step_backups WHERE workspace_id = ? AND step_id = ? AND id = ?', ws, stepId, backupId);
  if (!b) throw notFound('Backup');
  return b;
}

export async function getBackup(deps: Deps, ws: string, funnelId: string, stepId: string, backupId: string) {
  await requireFunnel(deps.db, ws, funnelId);
  await requireStep(deps.db, ws, funnelId, stepId);
  const b = await requireBackup(deps, ws, stepId, backupId);
  return { id: b.id, version: b.version, label: b.label, createdAt: b.created_at, doc: JSON.parse(b.doc_json) as PageDocument };
}

/** Restoring is a normal save of the old document, so the version being replaced is itself backed up. */
export async function restoreBackup(deps: Deps, auth: Auth, funnelId: string, stepId: string, backupId: string) {
  const ws = auth.workspaceId;
  await requireFunnel(deps.db, ws, funnelId);
  await requireStep(deps.db, ws, funnelId, stepId);
  const b = await requireBackup(deps, ws, stepId, backupId);
  return savePage(deps, auth, funnelId, stepId, JSON.parse(b.doc_json));
}
