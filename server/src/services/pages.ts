import { createHash } from 'node:crypto';
import { parseDocument, renderPage, type PageDocument, type RenderContext, LIMITS } from '../blocks/index.js';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { AppError, conflict, notFound } from '../errors.js';
import { requireFunnel, requireStep, listSteps } from '../repos/funnels.js';
import type { BackupRow, FunnelRow, PageRow, StepRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { liveUrlsForFunnel, schedulePurge } from '../edge/purger.js';

export const MAX_BACKUPS = 10;

export const checksumOf = (html: string): string => createHash('sha256').update(html).digest('hex').slice(0, 32);

const iso = (deps: Deps) => deps.now().toISOString();

export function workspaceAllowsScripts(deps: Deps, ws: string): boolean {
  return deps.db.get<{ v: number }>('SELECT allow_custom_scripts AS v FROM workspaces WHERE id = ?', ws)?.v === 1;
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
export function regenerateFunnel(deps: Deps, ws: string, funnelId: string): void {
  const funnel = requireFunnel(deps.db, ws, funnelId, true);
  const steps = listSteps(deps.db, ws, funnelId);
  const workspaceScripts = workspaceAllowsScripts(deps, ws);
  const pages = new Map(deps.db.all<PageRow>('SELECT * FROM step_pages WHERE workspace_id = ? AND funnel_id = ?', ws, funnelId).map((p) => [p.step_id, p]));
  for (const step of steps) {
    const page = pages.get(step.id);
    if (!page) continue;
    const { html, checksum } = renderStep(deps, { funnel, steps, step, docJson: page.doc_json, scriptsOk: page.scripts_ok === 1, workspaceScripts, mode: 'live' });
    if (checksum !== page.checksum) deps.db.run('UPDATE step_pages SET html = ?, checksum = ? WHERE step_id = ?', html, checksum, step.id);
  }
  deps.pageCache.invalidate(steps.map((s) => s.id));
  schedulePurge(deps, liveUrlsForFunnel(deps, funnelId));
}

export function regenerateWorkspace(deps: Deps, ws: string): void {
  for (const f of deps.db.all<{ id: string }>('SELECT id FROM funnels WHERE workspace_id = ?', ws)) regenerateFunnel(deps, ws, f.id);
}

/** Creates the page row for a brand-new step (no backup: there is no previous version). */
export function insertPage(deps: Deps, ws: string, funnel: FunnelRow, step: StepRow, doc: unknown, scriptsOk: boolean): void {
  const docJson = JSON.stringify(doc);
  const steps = listSteps(deps.db, ws, funnel.id);
  const { html, checksum } = renderStep(deps, { funnel, steps, step, docJson, scriptsOk, workspaceScripts: workspaceAllowsScripts(deps, ws), mode: 'live' });
  deps.db.run(
    'INSERT INTO step_pages (step_id, workspace_id, funnel_id, doc_json, html, checksum, scripts_ok, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    step.id, ws, funnel.id, docJson, html, checksum, scriptsOk ? 1 : 0, iso(deps),
  );
}

export const scriptsAllowedFor = (deps: Deps, auth: Auth): boolean => auth.role === 'owner' && workspaceAllowsScripts(deps, auth.workspaceId);

function getPageRow(deps: Deps, ws: string, stepId: string): PageRow {
  const p = deps.db.get<PageRow>('SELECT * FROM step_pages WHERE workspace_id = ? AND step_id = ?', ws, stepId);
  if (!p) throw notFound('Page');
  return p;
}

export function getPage(deps: Deps, ws: string, funnelId: string, stepId: string) {
  requireFunnel(deps.db, ws, funnelId);
  const step = requireStep(deps.db, ws, funnelId, stepId);
  const page = getPageRow(deps, ws, stepId);
  return { stepId, version: step.version, checksum: page.checksum, updatedAt: page.updated_at, doc: JSON.parse(page.doc_json) as PageDocument };
}

export function validateDoc(raw: unknown): PageDocument {
  const r = parseDocument(raw);
  if (!r.ok) throw new AppError(400, 'INVALID_DOCUMENT', 'The page document is not valid', r.issues);
  if (JSON.stringify(r.doc).length > LIMITS.maxDocBytes) throw new AppError(413, 'DOCUMENT_TOO_LARGE', 'The page document is too large');
  return r.doc;
}

const nextVersion = (deps: Deps, prev: number): number => Math.max(prev + 1, deps.now().getTime());

function pruneBackups(deps: Deps, stepId: string): void {
  deps.db.run(
    `DELETE FROM step_backups WHERE step_id = ? AND id NOT IN (
       SELECT id FROM step_backups WHERE step_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    stepId, stepId, MAX_BACKUPS,
  );
}

export interface SaveOptions {
  expectedVersion?: number;
  /** Autosaves pass false so they do not flood the 10-slot history. */
  backup?: boolean;
}

/** The one write path for page content: backup previous -> store doc + html -> bump version -> prune. All in one transaction. */
export function savePage(deps: Deps, auth: Auth, funnelId: string, stepId: string, rawDoc: unknown, opts: SaveOptions = {}) {
  const ws = auth.workspaceId;
  const doc = validateDoc(rawDoc);
  return deps.db.tx(() => {
    const funnel = requireFunnel(deps.db, ws, funnelId);
    const step = requireStep(deps.db, ws, funnelId, stepId);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== step.version) {
      throw conflict('VERSION_CONFLICT', 'This page was changed elsewhere. Reload before saving.', { currentVersion: step.version });
    }
    const previous = getPageRow(deps, ws, stepId);
    const at = iso(deps);
    if (opts.backup !== false) {
      deps.db.run(
        `INSERT INTO step_backups (id, workspace_id, funnel_id, step_id, version, label, doc_json, html, checksum, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId('bk'), ws, funnelId, stepId, step.version, `${step.name} ${at.slice(0, 10)}`, previous.doc_json, previous.html, previous.checksum, auth.userId, at,
      );
    }
    const docJson = JSON.stringify(doc);
    const scriptsOk = scriptsAllowedFor(deps, auth);
    const steps = listSteps(deps.db, ws, funnelId);
    const { html, checksum } = renderStep(deps, { funnel, steps, step, docJson, scriptsOk, workspaceScripts: workspaceAllowsScripts(deps, ws), mode: 'live' });
    deps.db.run('UPDATE step_pages SET doc_json = ?, html = ?, checksum = ?, scripts_ok = ?, updated_at = ? WHERE step_id = ?', docJson, html, checksum, scriptsOk ? 1 : 0, at, stepId);
    const version = nextVersion(deps, step.version);
    deps.db.run('UPDATE steps SET version = ?, updated_at = ? WHERE id = ?', version, at, stepId);
    deps.db.run('UPDATE funnels SET updated_at = ? WHERE id = ?', at, funnelId);
    pruneBackups(deps, stepId);
    deps.pageCache.invalidate([stepId]);
    schedulePurge(deps, liveUrlsForFunnel(deps, funnelId));
    return { stepId, version, checksum, updatedAt: at };
  });
}

export function listBackups(deps: Deps, ws: string, funnelId: string, stepId: string) {
  requireFunnel(deps.db, ws, funnelId);
  requireStep(deps.db, ws, funnelId, stepId);
  return deps.db
    .all<BackupRow>('SELECT id, version, label, checksum, created_by, created_at FROM step_backups WHERE workspace_id = ? AND step_id = ? ORDER BY created_at DESC, rowid DESC', ws, stepId)
    .map((b) => ({ id: b.id, version: b.version, label: b.label, checksum: b.checksum, createdBy: b.created_by, createdAt: b.created_at }));
}

function requireBackup(deps: Deps, ws: string, stepId: string, backupId: string): BackupRow {
  const b = deps.db.get<BackupRow>('SELECT * FROM step_backups WHERE workspace_id = ? AND step_id = ? AND id = ?', ws, stepId, backupId);
  if (!b) throw notFound('Backup');
  return b;
}

export function getBackup(deps: Deps, ws: string, funnelId: string, stepId: string, backupId: string) {
  requireFunnel(deps.db, ws, funnelId);
  requireStep(deps.db, ws, funnelId, stepId);
  const b = requireBackup(deps, ws, stepId, backupId);
  return { id: b.id, version: b.version, label: b.label, createdAt: b.created_at, doc: JSON.parse(b.doc_json) as PageDocument };
}

/** Restoring is a normal save of the old document, so the version being replaced is itself backed up. */
export function restoreBackup(deps: Deps, auth: Auth, funnelId: string, stepId: string, backupId: string) {
  const ws = auth.workspaceId;
  requireFunnel(deps.db, ws, funnelId);
  requireStep(deps.db, ws, funnelId, stepId);
  const b = requireBackup(deps, ws, stepId, backupId);
  return savePage(deps, auth, funnelId, stepId, JSON.parse(b.doc_json));
}
