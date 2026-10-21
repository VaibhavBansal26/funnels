import { createHash } from 'node:crypto';
import { z } from 'zod';
import { cspHosts } from '../ads/snippets.js';
import type { Auth } from '../auth/context.js';
import { decryptWithDataKey, encryptWithDataKey } from '../auth/dataCrypto.js';
import { BEACON_JS } from '../beacon.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { Job } from '../jobs/queue.js';
import { loadDoc } from '../pagemodel/doc.js';
import { RUNTIME_JS } from '../pagemodel/render.js';
import { buildBundle, buildPausedBundle, BundleError, beaconPath, findAssetRefs, type Bundle, type BundleAsset } from '../publish/bundle.js';
import { batches, CloudflareApiError, CloudflarePagesClient, deploymentState, domainState, type PagesCredentials } from '../publish/cfclient.js';
import { requireFunnel, listSteps } from '../repos/funnels.js';
import type { DomainRow, FunnelRow, PageRow } from '../repos/types.js';
import { newId } from '../util/ids.js';
import { assertWithinLimit } from '../billing/limits.js';
import { audit } from './audit.js';
import { adTagsFor, effectivePixels, loadPixelLevels } from './adtags.js';
import { renderStep, workspaceAllowsScripts } from './pages.js';
import { primeSnapshots, refreshForPublish } from './googlereviews.js';
import { addressFrom, ensurePagesDomain, workspaceSlugOf, type Address } from './addresses.js';

/**
 * Publishing: where a funnel is served from. `origin` (default) is this server by Host header; `cloudflare-pages` builds the funnel into a static site and deploys it with
 * the Direct Upload API (publish/cfclient.ts), one Pages project per funnel. Everything runs through the job queue and is persisted, so a restart loses nothing:
 *
 *   change -> schedulePublish (debounced, deduplicated per funnel) -> publish.deploy: lease, build, upload missing files, create deployment
 *          -> publish.poll (rescheduled every PAGES_POLL_INTERVAL_MS, never blocks the worker) -> succeeded | failed | timed out
 *
 * Single flight: a funnel has one lease at a time; changes that arrive while a deployment runs queue exactly one follow-up that builds from the then-current state, so the last
 * change always wins and intermediate states may be skipped. A rollback holds automatic deployments until someone redeploys, otherwise the next autosave would undo it.
 * Not exercised against real Cloudflare (docs/CLOUDFLARE-PAGES.md).
 */
/** Cloudflare Pages allows 100 projects per account and this app creates one per funnel: https://developers.cloudflare.com/pages/platform/limits/ (checked 2026-10-21). */
export const PAGES_PROJECT_LIMIT = 100;
export const PROJECT_NAME = /^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/;
const MAX_LOG = 60;
const DOMAIN_POLL_LIMIT = 2 * 3_600_000;

type Reason = 'publish' | 'save' | 'redeploy' | 'rollback' | 'unpublish';
export type DeployStatus = 'queued' | 'building' | 'uploading' | 'deploying' | 'succeeded' | 'failed' | 'superseded' | 'rolled_back';

interface PublishRow {
  funnel_id: string;
  workspace_id: string;
  target: 'origin' | 'cloudflare-pages';
  owner: 'workspace' | 'platform';
  project_name: string | null;
  pages_host: string | null;
  active_deployment_id: string | null;
  active_version: string | null;
  custom_domain: string | null;
  custom_domain_status: string | null;
  custom_domain_error: string | null;
  paused: number;
  project_created: number;
  hold: number;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface DeploymentRow {
  id: string;
  workspace_id: string;
  funnel_id: string;
  version_id: string | null;
  cf_deployment_id: string | null;
  reason: Reason;
  status: DeployStatus;
  file_count: number;
  bytes: number;
  url: string | null;
  error: string | null;
  log_json: string;
  attempts: number;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const iso = (deps: Pick<Deps, 'now'>) => deps.now().toISOString();

// ---- credentials ----------------------------------------------------------------------------------------------------------------------------------------

export const ConnectInput = z.object({
  accountId: z.string().trim().regex(/^[a-fA-F0-9]{32}$/, 'The account id is 32 hexadecimal characters (Cloudflare dashboard > Workers & Pages > Account details)'),
  token: z.string().trim().min(20, 'The API token looks too short').max(512).regex(/^[\x21-\x7e]+$/, 'The token may only contain visible ASCII characters'),
});

const credAad = (ws: string) => `pubcred:${ws}`;

interface CredRow {
  workspace_id: string;
  account_id: string;
  token_enc: string;
  token_hint: string;
  status: string;
  verified_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const clientFrom = (deps: Deps, c: PagesCredentials) => new CloudflarePagesClient(c, deps.outbound);

export async function platformAvailable(deps: Deps): Promise<boolean> {
  return !!(deps.config.CF_PAGES_ACCOUNT_ID && deps.config.CF_PAGES_API_TOKEN);
}

export async function getConnection(deps: Deps, ws: string) {
  const row = await deps.db.get<CredRow>('SELECT * FROM publish_credentials WHERE workspace_id = ?', ws);
  const platformUsed = Number((await deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM funnel_publish WHERE workspace_id = ? AND owner = 'platform' AND target = 'cloudflare-pages'", ws))!.n);
  return {
    connected: !!row,
    accountId: row?.account_id ?? null,
    tokenHint: row?.token_hint ?? null,
    status: row?.status ?? null,
    verifiedAt: row?.verified_at ?? null,
    lastError: row?.last_error ?? null,
    platform: { available: await platformAvailable(deps), projectsUsed: platformUsed },
  };
}

/** Explains a refused Cloudflare call in terms of what the person can fix. Never includes the token. */
function explain(e: unknown): string {
  if (e instanceof CloudflareApiError) {
    if (e.projectLimit) return `This Cloudflare account has reached its limit of ${PAGES_PROJECT_LIMIT} Pages projects (this app creates one per funnel). Delete projects you do not need in the Cloudflare dashboard (Workers & Pages), or connect another Cloudflare account.`;
    if (e.newAccountLimit) return 'Cloudflare limits how many Pages projects a new account can create in its first 48 hours. Try again later, or publish this funnel from this server for now.';
    if (e.permission) return 'Cloudflare refused the token. Check the account id and give the API token the permission "Cloudflare Pages: Edit" on that account.';
    if (e.rateLimited) return 'Cloudflare is rate limiting this account. The app will try again shortly.';
    if (e.status === 0) return e.message;
    return `Cloudflare answered ${e.status}${e.code ? ` (code ${e.code})` : ''}: ${e.message}`.slice(0, 300);
  }
  return e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300);
}

export async function connect(deps: Deps, auth: Auth, input: z.infer<typeof ConnectInput>, ip: string | null) {
  const ws = auth.workspaceId;
  const creds: PagesCredentials = { accountId: input.accountId.toLowerCase(), token: input.token, base: deps.config.CF_PAGES_API_BASE };
  try {
    await clientFrom(deps, creds).verify();
  } catch (e) {
    throw new AppError(422, 'CLOUDFLARE_REJECTED', explain(e));
  }
  const enc = encryptWithDataKey(deps.config, input.token, credAad(ws));
  const at = iso(deps);
  const hint = `••••${input.token.slice(-4)}`;
  await deps.db.run(
    `INSERT INTO publish_credentials (workspace_id, account_id, token_enc, token_hint, status, verified_at, last_error, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'connected', ?, NULL, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET account_id = excluded.account_id, token_enc = excluded.token_enc, token_hint = excluded.token_hint, status = 'connected', verified_at = excluded.verified_at, last_error = NULL, updated_at = excluded.updated_at`,
    ws, creds.accountId, enc, hint, at, auth.userId, at, at,
  );
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'publishing.connected', target: creds.accountId, detail: { accountId: creds.accountId, tokenHint: hint }, ip });
  return getConnection(deps, ws);
}

/** Re-checks the stored token with a read call and records the outcome. */
export async function verifyConnection(deps: Deps, auth: Auth) {
  const ws = auth.workspaceId;
  const row = await deps.db.get<CredRow>('SELECT * FROM publish_credentials WHERE workspace_id = ?', ws);
  if (!row) throw notFound('Cloudflare connection');
  const token = decryptWithDataKey(deps.config, row.token_enc, credAad(ws)).plain;
  let ok = true;
  let error: string | null = null;
  try {
    await clientFrom(deps, { accountId: row.account_id, token, base: deps.config.CF_PAGES_API_BASE }).verify();
  } catch (e) {
    ok = false;
    error = explain(e);
  }
  await deps.db.run('UPDATE publish_credentials SET status = ?, verified_at = ?, last_error = ?, updated_at = ? WHERE workspace_id = ?', ok ? 'connected' : 'invalid', ok ? iso(deps) : row.verified_at, error, iso(deps), ws);
  return { ok, error, connection: await getConnection(deps, ws) };
}

export async function disconnect(deps: Deps, auth: Auth, force: boolean, ip: string | null): Promise<void> {
  const ws = auth.workspaceId;
  const using = await deps.db.all<{ funnel_id: string }>("SELECT funnel_id FROM funnel_publish WHERE workspace_id = ? AND owner = 'workspace' AND target = 'cloudflare-pages'", ws);
  if (using.length && !force) {
    throw conflict('CONNECTION_IN_USE', `${using.length} funnel${using.length > 1 ? 's are' : ' is'} published with this connection. Disconnecting stops updates (the sites stay online on Cloudflare). Disconnect anyway to switch them back to this server.`, { funnels: using.map((u) => u.funnel_id) });
  }
  await deps.db.run("UPDATE funnel_publish SET target = 'origin', updated_at = ? WHERE workspace_id = ? AND owner = 'workspace' AND target = 'cloudflare-pages'", iso(deps), ws);
  for (const u of using) await releasePagesAddress(deps, ws, u.funnel_id);
  await deps.db.run('DELETE FROM publish_credentials WHERE workspace_id = ?', ws);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'publishing.disconnected', detail: { funnelsSwitched: using.length }, ip });
}

async function credentialsFor(deps: Deps, row: Pick<PublishRow, 'owner' | 'workspace_id'>): Promise<PagesCredentials> {
  if (row.owner === 'platform') {
    if (!deps.config.CF_PAGES_ACCOUNT_ID || !deps.config.CF_PAGES_API_TOKEN) throw new AppError(409, 'NO_CREDENTIALS', 'This installation has no Cloudflare account for hosted publishing');
    return { accountId: deps.config.CF_PAGES_ACCOUNT_ID, token: deps.config.CF_PAGES_API_TOKEN, base: deps.config.CF_PAGES_API_BASE };
  }
  const c = await deps.db.get<CredRow>('SELECT * FROM publish_credentials WHERE workspace_id = ?', row.workspace_id);
  if (!c) throw new AppError(409, 'NO_CREDENTIALS', 'Connect a Cloudflare account in Settings > Publishing first');
  return { accountId: c.account_id, token: decryptWithDataKey(deps.config, c.token_enc, credAad(row.workspace_id)).plain, base: deps.config.CF_PAGES_API_BASE };
}

// ---- settings --------------------------------------------------------------------------------------------------------------------------------------------

export const shortId = (funnelId: string): string => createHash('sha256').update(funnelId).digest('hex').slice(0, 8);
export const platformProjectName = (deps: Pick<Deps, 'config'>, funnelId: string): string => `${deps.config.PAGES_PROJECT_PREFIX}-${shortId(funnelId)}`;

export const SettingsInput = z.object({
  target: z.enum(['origin', 'cloudflare-pages']),
  /** Where the Pages project lives: the workspace's own Cloudflare account, or the platform's (hosted installations). */
  owner: z.enum(['workspace', 'platform']).optional(),
  /** A custom project name (workspace-owned only; platform projects are named fn-<id>). */
  projectName: z.string().trim().toLowerCase().regex(PROJECT_NAME, 'Use 2 to 58 lowercase letters, digits and hyphens, not starting or ending with a hyphen').optional(),
  /** Use a Pages project that already exists in the account (it will be overwritten by deployments). */
  adopt: z.boolean().optional(),
  /** When switching back to this server: what happens to the site on Cloudflare. */
  leave: z.enum(['pause', 'delete', 'keep']).optional(),
});

async function getRow(deps: Pick<Deps, 'db'>, funnelId: string): Promise<PublishRow | undefined> {
  return deps.db.get<PublishRow>('SELECT * FROM funnel_publish WHERE funnel_id = ?', funnelId);
}

const pagesUrl = (host: string | null) => (host ? `https://${host}` : null);

const summarize = (d: DeploymentRow | undefined | null, activeId: string | null) =>
  d
    ? { id: d.id, versionId: d.version_id, status: d.status, reason: d.reason, fileCount: d.file_count, bytes: Number(d.bytes), url: d.url, error: d.error, cloudflareDeploymentId: d.cf_deployment_id, createdAt: d.created_at, startedAt: d.started_at, finishedAt: d.finished_at, active: d.id === activeId, canRollback: d.status === 'succeeded' && d.id !== activeId && !!d.cf_deployment_id }
    : null;

export type PublishState = 'draft' | 'publishing' | 'live' | 'failed' | 'paused';

/**
 * What the person should see for this funnel, in one word.
 *  draft       not live (test mode)
 *  publishing  live on a Cloudflare address, the first deployment has not finished (or is being retried)
 *  failed      live on a Cloudflare address, nothing is deployed and the last deployment failed
 *  paused      unpublished or rolled back by hand: the funnel is live but the site shows the paused page
 *  live        reachable (a funnel on this server, or a deployment is online; a later failed deployment keeps the previous one online)
 */
export function publishState(funnel: Pick<FunnelRow, 'status'>, row: PublishRow | undefined, latest: DeploymentRow | undefined | null, active: DeploymentRow | undefined | null, domain: DomainRow | undefined | null): PublishState {
  if (funnel.status !== 'live' || !domain) return 'draft';
  if (!row || row.target !== 'cloudflare-pages') return 'live';
  if (row.paused === 1) return 'paused';
  if (active) return 'live';
  if (latest?.status === 'failed') return 'failed';
  return 'publishing';
}

export async function getSettings(deps: Deps, ws: string, funnelId: string) {
  const funnel = await requireFunnel(deps.db, ws, funnelId, true);
  const row = await getRow(deps, funnelId);
  const domain = funnel.domain_id ? await deps.db.get<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND id = ?', ws, funnel.domain_id) : undefined;
  const others = domain ? Number((await deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM funnels WHERE domain_id = ? AND id <> ? AND status = 'live' AND deleted_at IS NULL", domain.id, funnelId))!.n) : 0;
  const latest = row ? await deps.db.get<DeploymentRow>('SELECT * FROM publish_deployments WHERE funnel_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', funnelId) : undefined;
  const active = row?.active_deployment_id ? await deps.db.get<DeploymentRow>('SELECT * FROM publish_deployments WHERE id = ?', row.active_deployment_id) : undefined;
  const conn = await getConnection(deps, ws);
  const pagesDomain = await deps.db.get<DomainRow>("SELECT * FROM domains WHERE workspace_id = ? AND kind = 'pages' AND system_funnel_id = ?", ws, funnelId);
  const onPagesAddress = !!domain && domain.kind === 'pages';
  const address = domain ? addressFrom(deps, funnel, domain, { workspaceSlug: domain.kind === 'builtin' ? await workspaceSlugOf(deps, ws) : null, pagesHost: row?.pages_host ?? null }) : null;
  return {
    state: publishState(funnel, row, latest, active, domain),
    address: address ? { kind: address.kind, host: address.host, base: address.base } : null,
    pagesAddress: row?.target === 'cloudflare-pages' && row.pages_host ? { host: row.pages_host, url: pagesUrl(row.pages_host), domainId: pagesDomain?.id ?? null, status: pagesDomain?.status ?? null, selected: onPagesAddress } : null,
    projectLimit: PAGES_PROJECT_LIMIT,
    target: row?.target ?? 'origin',
    owner: row?.owner ?? null,
    project: row?.project_name ? { name: row.project_name, host: row.pages_host, url: pagesUrl(row.pages_host), created: row.project_created === 1 } : null,
    customDomain: row?.custom_domain ? { hostname: row.custom_domain, status: row.custom_domain_status, error: row.custom_domain_error, dns: { type: 'CNAME', name: row.custom_domain, value: row.pages_host } } : null,
    domain: domain ? { id: domain.id, hostname: domain.hostname, status: domain.status } : null,
    funnelStatus: funnel.status,
    paused: row?.paused === 1,
    hold: row?.hold === 1,
    lastError: row?.last_error ?? null,
    active: summarize(active, row?.active_deployment_id ?? null),
    latest: summarize(latest, row?.active_deployment_id ?? null),
    inFlight: !!latest && ['queued', 'building', 'uploading', 'deploying'].includes(latest.status),
    constraints: {
      workspaceConnected: conn.connected,
      platformAvailable: conn.platform.available,
      domainShared: others > 0,
      needsLiveDomain: !domain || funnel.status !== 'live',
      limits: { maxFiles: deps.config.PAGES_MAX_FILES, maxFileBytes: deps.config.PAGES_MAX_FILE_BYTES },
    },
  };
}

export async function updateSettings(deps: Deps, auth: Auth, funnelId: string, input: z.infer<typeof SettingsInput>, ip: string | null) {
  const ws = auth.workspaceId;
  const funnel = await requireFunnel(deps.db, ws, funnelId);
  const row = await getRow(deps, funnelId);
  const at = iso(deps);
  if (input.target === 'origin') {
    if (row && row.target === 'cloudflare-pages') {
      const leave = input.leave ?? 'pause';
      if (leave !== 'keep' && row.active_deployment_id) await unpublishNow(deps, auth, funnel, row, leave === 'delete' ? 'delete' : 'pause');
      await deps.db.run("UPDATE funnel_publish SET target = 'origin', updated_at = ? WHERE funnel_id = ?", at, funnelId);
      await releasePagesAddress(deps, ws, funnelId);
      await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'publishing.target_changed', target: funnelId, detail: { target: 'origin', leave }, ip });
    }
    return getSettings(deps, ws, funnelId);
  }
  const owner = input.owner ?? (row?.owner ?? ((await getConnection(deps, ws)).connected ? 'workspace' : 'platform'));
  if (owner === 'platform' && !(await platformAvailable(deps))) throw conflict('PLATFORM_UNAVAILABLE', 'This installation has no Cloudflare account for hosted publishing. Connect your own Cloudflare account instead.');
  if (owner === 'workspace' && !(await getConnection(deps, ws)).connected) throw conflict('NO_CREDENTIALS', 'Connect a Cloudflare account in Settings > Publishing first');
  if (owner === 'platform' && input.projectName) throw badRequest('PROJECT_NAME_FIXED', 'Projects in the platform account are named automatically');
  const name = owner === 'platform' ? platformProjectName(deps, funnelId) : (input.projectName ?? row?.project_name ?? platformProjectName(deps, funnelId));
  if (!PROJECT_NAME.test(name)) throw badRequest('INVALID_PROJECT_NAME', 'The project name is not valid');
  const sameProject = row?.project_name === name && row.owner === owner;
  if (!sameProject) {
    if (owner === 'platform' && !(row?.owner === 'platform' && row.target === 'cloudflare-pages')) await assertWithinLimit(deps, ws, 'pagesProjects');
    const clash = await deps.db.get('SELECT 1 FROM funnel_publish WHERE funnel_id <> ? AND project_name = ? AND (owner = \'platform\' AND ? = \'platform\' OR workspace_id = ? AND owner = ?)', funnelId, name, owner, ws, owner);
    if (clash) throw conflict('PROJECT_NAME_TAKEN', 'Another funnel already publishes to a project with this name');
  }
  const client = clientFrom(deps, await credentialsFor(deps, { owner, workspace_id: ws }));
  let project;
  let created = row?.project_created === 1 && sameProject;
  try {
    project = await client.getProject(name);
    if (!sameProject && !input.adopt) {
      throw conflict('PROJECT_EXISTS', `A Pages project named "${name}" already exists in this Cloudflare account. Choose another name, or confirm that this funnel may overwrite it.`);
    }
  } catch (e) {
    if (e instanceof CloudflareApiError && e.notFound) {
      // Refuse the 101st project BEFORE asking Cloudflare to create it: the limit error of the real API is not documented in detail.
      let used = 0;
      try {
        used = await client.countProjects();
      } catch (e3) {
        throw new AppError(422, 'CLOUDFLARE_REJECTED', explain(e3));
      }
      if (used >= PAGES_PROJECT_LIMIT) {
        throw conflict('PAGES_PROJECT_LIMIT', `This Cloudflare account already has ${used} Pages projects, the maximum is ${PAGES_PROJECT_LIMIT} (this app creates one per funnel). Delete projects you no longer need in the Cloudflare dashboard (Workers & Pages), or connect another Cloudflare account.`, { limit: PAGES_PROJECT_LIMIT, used });
      }
      try {
        project = await client.createProject(name);
        created = true;
      } catch (e2) {
        throw new AppError(e2 instanceof CloudflareApiError && (e2.projectLimit || e2.newAccountLimit) ? 409 : 422, e2 instanceof CloudflareApiError && e2.projectLimit ? 'PAGES_PROJECT_LIMIT' : e2 instanceof CloudflareApiError && e2.newAccountLimit ? 'PAGES_NEW_ACCOUNT_LIMIT' : 'CLOUDFLARE_REJECTED', explain(e2));
      }
    } else if (e instanceof AppError) throw e;
    else throw new AppError(422, 'CLOUDFLARE_REJECTED', explain(e));
  }
  const host = project.subdomain || `${name}.pages.dev`;
  await deps.db.run(
    `INSERT INTO funnel_publish (funnel_id, workspace_id, target, owner, project_name, pages_host, project_created, paused, hold, created_at, updated_at) VALUES (?, ?, 'cloudflare-pages', ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT (funnel_id) DO UPDATE SET target = 'cloudflare-pages', owner = excluded.owner, project_name = excluded.project_name, pages_host = excluded.pages_host, project_created = excluded.project_created,
       ${sameProject ? '' : 'active_deployment_id = NULL, active_version = NULL, custom_domain = NULL, custom_domain_status = NULL, custom_domain_error = NULL,'} paused = 0, last_error = NULL, updated_at = excluded.updated_at`,
    funnelId, ws, owner, name, host, created ? 1 : 0, at, at,
  );
  // The project's *.pages.dev address is the funnel's free system domain: pending until the first deployment succeeds. A different project means a different address.
  const pagesDomain = await ensurePagesDomain(deps, ws, funnelId);
  if (!sameProject && pagesDomain.status !== 'pending') await deps.db.run("UPDATE domains SET status = 'pending', verified_at = NULL, updated_at = ? WHERE id = ?", at, pagesDomain.id);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'publishing.target_changed', target: funnelId, detail: { target: 'cloudflare-pages', owner, project: name, adopted: !!input.adopt && !created }, ip });
  if (funnel.status === 'live') await schedulePublish(deps, ws, funnelId, 'publish', auth.userId, true);
  return getSettings(deps, ws, funnelId);
}

// ---- the *.pages.dev system domain --------------------------------------------------------------------------------------------------------------------

/** First successful (non-paused) deployment: the funnel's pages.dev address is reachable, so its system domain turns active. */
async function activatePagesAddress(deps: Deps, ws: string, funnelId: string): Promise<void> {
  const at = iso(deps);
  await deps.db.run("UPDATE domains SET status = 'active', failure_reason = NULL, verified_at = COALESCE(verified_at, ?), updated_at = ? WHERE workspace_id = ? AND kind = 'pages' AND system_funnel_id = ? AND status <> 'active'", at, at, ws, funnelId);
}

/**
 * The funnel stops using Cloudflare Pages (target switched back, connection removed, project deleted): its pages.dev address no longer exists. A funnel that was attached to it
 * goes back to test (the owner picks a new address in Go live), and the system domain record is removed.
 */
export async function releasePagesAddress(deps: Deps, ws: string, funnelId: string): Promise<void> {
  const d = await deps.db.get<DomainRow>("SELECT * FROM domains WHERE workspace_id = ? AND kind = 'pages' AND system_funnel_id = ?", ws, funnelId);
  if (!d) return;
  await deps.db.run("UPDATE funnels SET status = 'test', domain_id = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND domain_id = ?", iso(deps), ws, funnelId, d.id);
  await deps.db.run('DELETE FROM domains WHERE id = ?', d.id);
}

// ---- scheduling ------------------------------------------------------------------------------------------------------------------------------------------

/**
 * Queues a deployment of the funnel's current state. Safe to call inside a transaction and as often as you like: while one is queued, further calls reuse it (the build reads the
 * database when it RUNS, so it always carries the latest changes). `force` skips the "nothing changed" shortcut.
 */
export async function schedulePublish(deps: Deps, ws: string, funnelId: string, reason: Reason, requestedBy: string | null = null, force = false): Promise<string | null> {
  const row = await getRow(deps, funnelId);
  if (!row || row.target !== 'cloudflare-pages' || row.workspace_id !== ws) return null;
  const queued = await deps.db.get<{ id: string }>("SELECT id FROM publish_deployments WHERE funnel_id = ? AND status = 'queued' ORDER BY created_at DESC LIMIT 1", funnelId);
  let id = queued?.id ?? null;
  const at = iso(deps);
  if (reason !== 'save') await deps.db.run('UPDATE funnel_publish SET hold = 0, updated_at = ? WHERE funnel_id = ?', iso(deps), funnelId); // an explicit publish ends a rollback or unpublish hold
  if (!id) {
    id = newId('dep');
    await deps.db.run("INSERT INTO publish_deployments (id, workspace_id, funnel_id, reason, status, log_json, attempts, requested_by, created_at) VALUES (?, ?, ?, ?, 'queued', '[]', 0, ?, ?)", id, ws, funnelId, reason, requestedBy, at);
  } else if (reason !== 'save') {
    await deps.db.run('UPDATE publish_deployments SET reason = ?, requested_by = COALESCE(?, requested_by) WHERE id = ?', reason, requestedBy, id);
  }
  await deps.jobs.enqueue('publish.deploy', { funnelId, deploymentId: id, force: force || reason !== 'save' }, {
    delayMs: reason === 'save' ? deps.config.PAGES_DEBOUNCE_SECONDS * 1000 : 0, maxAttempts: 5, dedupeKey: `publish.deploy:${funnelId}`, group: ws,
  });
  return id;
}

/**
 * Called wherever a funnel's published content or serving state changes (page saved, settings, steps, status or domain changes). Cheap for funnels that are not published
 * to Pages: one primary key lookup.
 */
export async function onFunnelChanged(deps: Deps, funnelId: string): Promise<void> {
  const row = await getRow(deps, funnelId);
  if (!row || row.target !== 'cloudflare-pages') return;
  // A funnel that was never deployed and is not live has nothing to update; one that is online and stops being live is replaced by the paused page.
  const f = await deps.db.get<{ status: string; deleted_at: string | null; domain_id: string | null; workspace_id: string }>('SELECT status, deleted_at, domain_id, workspace_id FROM funnels WHERE id = ?', funnelId);
  if (!f) return;
  const live = (await wantsLive(deps, { ...f, id: funnelId } as unknown as FunnelRow)).live;
  if (!live && !row.active_deployment_id) return;
  if (!live && row.paused === 1) return;
  // After a rollback or a manual unpublish nothing is deployed automatically while the funnel is live: the person decides when (Redeploy). Going offline still pauses the site.
  if (live && row.hold === 1) return;
  await schedulePublish(deps, row.workspace_id, funnelId, 'save');
}

// ---- building --------------------------------------------------------------------------------------------------------------------------------------------

export const apiOriginOf = (deps: Pick<Deps, 'config'>): string => {
  if (deps.config.API_PUBLIC_URL) return deps.config.API_PUBLIC_URL.replace(/\/$/, '');
  try {
    return new URL(deps.config.APP_PUBLIC_URL).origin;
  } catch {
    return deps.config.APP_PUBLIC_URL.replace(/\/$/, '');
  }
};

/** Renders every step of a funnel for Pages (absolute API origin, the bundled beacon, pixels) and builds the static site. Throws BundleError for what cannot be published. */
export async function buildFunnelBundle(deps: Deps, funnel: FunnelRow): Promise<Bundle> {
  const ws = funnel.workspace_id;
  const steps = await listSteps(deps.db, ws, funnel.id);
  const pages = new Map((await deps.db.all<PageRow>('SELECT * FROM step_pages WHERE workspace_id = ? AND funnel_id = ?', ws, funnel.id)).map((p) => [p.step_id, p]));
  const workspaceScripts = await workspaceAllowsScripts(deps, ws);
  const levels = await loadPixelLevels(deps, ws, funnel.id);
  const apiBase = apiOriginOf(deps);
  const domain = funnel.domain_id ? await deps.db.get<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND id = ?', ws, funnel.domain_id) : undefined;
  const bundleSteps = [];
  for (const step of steps) {
    const page = pages.get(step.id);
    if (!page) continue;
    const tags = adTagsFor(levels, funnel.id, step.id, loadDoc(page.doc_json), 'live');
    // The bundle carries a snapshot of the review content taken now (fetched if the cache is empty or expired); the page refreshes it from the public endpoint.
    await refreshForPublish(deps, ws, loadDoc(page.doc_json));
    await primeSnapshots(deps, ws, loadDoc(page.doc_json));
    const { html } = renderStep(deps, { funnel, steps, step, docJson: page.doc_json, scriptsOk: page.scripts_ok === 1, workspaceScripts, mode: 'live', adTags: tags?.html, apiBase, beaconSrc: beaconPath(BEACON_JS) });
    bundleSteps.push({ id: step.id, basePath: step.base_path, html, knownInline: [RUNTIME_JS, ...(tags ? [tags.source] : [])], vendors: cspHosts(effectivePixels(levels, step.id)) });
  }
  const refs = new Set(bundleSteps.flatMap((s) => findAssetRefs(s.html)));
  const assets = new Map<string, BundleAsset>();
  for (const id of refs) {
    const a = await deps.db.get<{ name: string; mime: string; data_b64: string }>('SELECT name, mime, data_b64 FROM assets WHERE id = ? AND workspace_id = ?', id, ws);
    if (a) assets.set(id, { name: a.name, mime: a.mime, bytes: Buffer.from(a.data_b64, 'base64') });
  }
  const own = new Set(steps.map((s) => s.id));
  return buildBundle({
    steps: bundleSteps,
    // The pages.dev address has no home setting: when no step is at "/", the first step answers there.
    homeStepId: domain?.default_home_step_id && own.has(domain.default_home_step_id) ? domain.default_home_step_id : domain?.kind === 'pages' ? (steps[0]?.id ?? null) : null,
    notFoundStepId: domain?.default_404_step_id && own.has(domain.default_404_step_id) ? domain.default_404_step_id : null,
    assets, beaconJs: BEACON_JS, apiOrigin: apiBase,
    limits: { maxFiles: deps.config.PAGES_MAX_FILES, maxFileBytes: deps.config.PAGES_MAX_FILE_BYTES },
  });
}

// ---- the deployment state machine ---------------------------------------------------------------------------------------------------------------------

async function logLine(deps: Deps, id: string, level: 'info' | 'warn' | 'error', msg: string, secrets: string[] = []): Promise<void> {
  const r = await deps.db.get<{ log_json: string }>('SELECT log_json FROM publish_deployments WHERE id = ?', id);
  if (!r) return;
  let clean = msg;
  for (const s of secrets) if (s) clean = clean.split(s).join('[redacted]');
  const log = (JSON.parse(r.log_json) as unknown[]).slice(-(MAX_LOG - 1));
  log.push({ t: iso(deps), level, msg: clean.slice(0, 400) });
  await deps.db.run('UPDATE publish_deployments SET log_json = ? WHERE id = ?', JSON.stringify(log), id);
}

const setStatus = (deps: Deps, id: string, status: DeployStatus, fields: Record<string, string | number | null> = {}) => {
  const names = Object.keys(fields);
  return deps.db.run(`UPDATE publish_deployments SET status = ?${names.map((n) => `, ${n} = ?`).join('')} WHERE id = ?`, status, ...names.map((n) => fields[n]!), id);
};

async function acquireLease(deps: Deps, funnelId: string): Promise<boolean> {
  const now = iso(deps);
  const until = new Date(deps.now().getTime() + (deps.config.PAGES_DEPLOY_TIMEOUT_SECONDS + 120) * 1000).toISOString();
  return (await deps.db.run('UPDATE funnel_publish SET lease_until = ? WHERE funnel_id = ? AND (lease_until IS NULL OR lease_until < ?)', until, funnelId, now)).changes === 1;
}
const releaseLease = (deps: Deps, funnelId: string) => deps.db.run('UPDATE funnel_publish SET lease_until = NULL WHERE funnel_id = ?', funnelId);

const redact = (text: string, secrets: string[]) => secrets.reduce((t, s) => (s ? t.split(s).join('[redacted]') : t), text);

async function failDeployment(deps: Deps, dep: DeploymentRow, row: PublishRow, rawMessage: string, secrets: string[] = []): Promise<void> {
  const message = redact(rawMessage, secrets); // Cloudflare's own error text may echo what was sent
  await logLine(deps, dep.id, 'error', message, secrets);
  await setStatus(deps, dep.id, 'failed', { error: message.slice(0, 500), finished_at: iso(deps) });
  await deps.db.run('UPDATE funnel_publish SET last_error = ?, updated_at = ? WHERE funnel_id = ?', message.slice(0, 500), iso(deps), row.funnel_id);
  await releaseLease(deps, row.funnel_id);
}

async function wantsLive(deps: Deps, funnel: FunnelRow): Promise<{ live: boolean; domain: DomainRow | undefined }> {
  const domain = funnel.domain_id ? await deps.db.get<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND id = ?', funnel.workspace_id, funnel.domain_id) : undefined;
  const suspended = !!(await deps.db.get<{ suspended_at: string | null }>('SELECT suspended_at FROM workspaces WHERE id = ?', funnel.workspace_id))?.suspended_at;
  // The funnel's own pages.dev address counts as soon as it is chosen: the deployment that makes it reachable is what turns it active.
  const usable = domain?.status === 'active' || (domain?.kind === 'pages' && domain.system_funnel_id === funnel.id);
  return { live: funnel.status === 'live' && !funnel.deleted_at && !!usable && !suspended, domain };
}

export async function deployJob(deps: Deps, payload: { funnelId: string; deploymentId: string; force?: boolean; rateRetries?: number }, job: Pick<Job, 'attempts' | 'maxAttempts'>): Promise<void> {
  const row = await getRow(deps, payload.funnelId);
  const dep = await deps.db.get<DeploymentRow>('SELECT * FROM publish_deployments WHERE id = ?', payload.deploymentId);
  if (!dep || dep.status !== 'queued') return; // handled by an earlier run
  if (!row || row.target !== 'cloudflare-pages') {
    await setStatus(deps, dep.id, 'superseded', { error: 'The funnel is no longer published to Cloudflare Pages', finished_at: iso(deps) });
    return;
  }
  if (!(await acquireLease(deps, row.funnel_id))) {
    // Single flight: another deployment of this funnel is running. Come back when it is done; the dedupe key keeps exactly one waiting job.
    await deps.jobs.enqueue('publish.deploy', payload, { delayMs: 3000, maxAttempts: 5, dedupeKey: `publish.deploy:${row.funnel_id}`, group: row.workspace_id });
    return;
  }
  let secrets: string[] = [];
  try {
    await setStatus(deps, dep.id, 'building', { started_at: dep.started_at ?? iso(deps), attempts: dep.attempts + 1 });
    const creds = await credentialsFor(deps, row);
    secrets = [creds.token];
    const client = clientFrom(deps, creds);
    const funnel = await requireFunnel(deps.db, row.workspace_id, row.funnel_id, true);
    const { live, domain } = await wantsLive(deps, funnel);
    let bundle: Bundle;
    if (live) {
      const others = domain!.kind !== 'custom' ? 0 : Number((await deps.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM funnels WHERE domain_id = ? AND id <> ? AND status = 'live' AND deleted_at IS NULL", domain!.id, funnel.id))!.n);
      if (others > 0) throw new BundleError('EMPTY', `The domain ${domain!.hostname} also serves ${others} other live funnel${others > 1 ? 's' : ''}. A Pages project serves one funnel per domain: give each funnel its own domain, or publish this one from this server.`);
      bundle = await buildFunnelBundle(deps, funnel);
    } else bundle = buildPausedBundle();
    for (const w of bundle.warnings) await logLine(deps, dep.id, 'warn', w);
    await logLine(deps, dep.id, 'info', `Built version ${bundle.versionId}: ${bundle.files.length} files, ${(bundle.bytes / 1024).toFixed(0)} KB`);
    if (!payload.force && row.active_version === bundle.versionId && row.active_deployment_id && (row.paused === 0) === live) {
      await setStatus(deps, dep.id, 'superseded', { version_id: bundle.versionId, error: null, finished_at: iso(deps) });
      await logLine(deps, dep.id, 'info', 'Nothing changed since the live version; no deployment was made');
      await releaseLease(deps, row.funnel_id);
      if (live) await syncCustomDomain(deps, row.funnel_id).catch((e) => deps.log.warn('pages domain sync failed', { funnel: row.funnel_id, error: String((e as Error).message).slice(0, 200) })); // the domain may have changed without the content changing
      return;
    }
    let project = row.project_name!;
    try {
      await client.getProject(project);
    } catch (e) {
      if (!(e instanceof CloudflareApiError && e.notFound)) throw e;
      await logLine(deps, dep.id, 'warn', `The Pages project ${project} does not exist (deleted on Cloudflare?); creating it again`);
      const p = await client.createProject(project);
      await deps.db.run('UPDATE funnel_publish SET pages_host = ?, project_created = 1 WHERE funnel_id = ?', p.subdomain, row.funnel_id);
    }
    await setStatus(deps, dep.id, 'uploading', { version_id: bundle.versionId, file_count: bundle.files.length, bytes: bundle.bytes });
    const jwt = await client.uploadToken(project);
    const hashes = [...new Set(bundle.files.map((f) => f.hash))];
    const missing = new Set(await client.checkMissing(jwt, hashes));
    const toSend = bundle.files.filter((f, i, all) => missing.has(f.hash) && all.findIndex((x) => x.hash === f.hash) === i);
    await logLine(deps, dep.id, 'info', `${toSend.length} of ${hashes.length} files are new to Cloudflare`);
    for (const batch of batches(toSend.map((f) => ({ hash: f.hash, base64: Buffer.from(f.bytes).toString('base64'), contentType: f.contentType })))) await client.upload(jwt, batch);
    await client.upsertHashes(jwt, hashes);
    const cf = await client.createDeployment(project, { manifest: bundle.manifest, headers: bundle.headers, redirects: bundle.redirects, commitHash: bundle.versionId, commitMessage: `${dep.reason} ${bundle.versionId}` });
    await logLine(deps, dep.id, 'info', `Cloudflare created deployment ${cf.short_id ?? cf.id}`);
    await setStatus(deps, dep.id, 'deploying', { cf_deployment_id: cf.id, url: cf.url ?? null });
    await deps.jobs.enqueue('publish.poll', { deploymentId: dep.id, errors: 0 }, { delayMs: deps.config.PAGES_POLL_INTERVAL_MS, maxAttempts: 5, dedupeKey: `publish.poll:${dep.id}`, group: row.workspace_id });
  } catch (e) {
    await handleDeployError(deps, e, dep, row, payload, job, secrets);
  }
}

async function handleDeployError(deps: Deps, e: unknown, dep: DeploymentRow, row: PublishRow, payload: { rateRetries?: number } & Record<string, unknown>, job: Pick<Job, 'attempts' | 'maxAttempts'>, secrets: string[]): Promise<void> {
  const msg = e instanceof BundleError ? e.message : e instanceof AppError ? e.message : explain(e);
  if (e instanceof CloudflareApiError && e.retryable) {
    const rate = e.rateLimited;
    const exhausted = job.attempts >= job.maxAttempts || (rate && (payload.rateRetries ?? 0) >= 8);
    if (!exhausted) {
      await logLine(deps, dep.id, 'warn', `${msg} Will retry.`, secrets);
      await setStatus(deps, dep.id, 'queued', { error: redact(msg, secrets).slice(0, 300) });
      await releaseLease(deps, row.funnel_id);
      if (rate) {
        // Honour Retry-After instead of the generic backoff.
        await deps.jobs.enqueue('publish.deploy', { ...payload, rateRetries: (payload.rateRetries ?? 0) + 1 }, { delayMs: Math.max(1, e.retryAfterS ?? 30) * 1000, maxAttempts: 5, dedupeKey: `publish.deploy:${row.funnel_id}`, group: row.workspace_id });
        return;
      }
      throw e;
    }
  }
  await failDeployment(deps, dep, row, msg, secrets); // a final failure is recorded on the deployment and shown to the person; the job itself is done
}

export async function pollJob(deps: Deps, payload: { deploymentId: string; errors?: number }): Promise<void> {
  const dep = await deps.db.get<DeploymentRow>('SELECT * FROM publish_deployments WHERE id = ?', payload.deploymentId);
  if (!dep || dep.status !== 'deploying') return;
  const row = await getRow(deps, dep.funnel_id);
  if (!row) return;
  const again = (errors: number, delayMs = deps.config.PAGES_POLL_INTERVAL_MS) =>
    deps.jobs.enqueue('publish.poll', { deploymentId: dep.id, errors }, { delayMs, maxAttempts: 5, dedupeKey: `publish.poll:${dep.id}`, group: row.workspace_id });
  const elapsed = deps.now().getTime() - Date.parse(dep.started_at ?? dep.created_at);
  let secrets: string[] = [];
  try {
    const creds = await credentialsFor(deps, row);
    secrets = [creds.token];
    const d = await clientFrom(deps, creds).getDeployment(row.project_name!, dep.cf_deployment_id!);
    const st = deploymentState(d);
    if (st.state === 'running') {
      if (elapsed > deps.config.PAGES_DEPLOY_TIMEOUT_SECONDS * 1000) return failDeployment(deps, dep, row, `Cloudflare did not finish the deployment within ${deps.config.PAGES_DEPLOY_TIMEOUT_SECONDS} seconds`);
      await again(0);
      return;
    }
    if (st.state === 'failed') return failDeployment(deps, dep, row, st.message ?? 'Cloudflare reported the deployment as failed');
    const at = iso(deps);
    await setStatus(deps, dep.id, 'succeeded', { finished_at: at, error: null, url: d.url ?? dep.url });
    await logLine(deps, dep.id, 'info', `Deployment is live (${dep.version_id})`);
    const funnel = await requireFunnel(deps.db, row.workspace_id, row.funnel_id, true);
    const { live } = await wantsLive(deps, funnel);
    const paused = dep.reason === 'unpublish' || !live;
    await deps.db.run('UPDATE funnel_publish SET active_deployment_id = ?, active_version = ?, paused = ?, last_error = NULL, updated_at = ? WHERE funnel_id = ?', dep.id, dep.version_id, paused ? 1 : 0, at, row.funnel_id);
    await releaseLease(deps, row.funnel_id);
    await pruneHistory(deps, row.funnel_id, row.active_deployment_id);
    if (!paused) await activatePagesAddress(deps, row.workspace_id, row.funnel_id);
    if (!paused) await syncCustomDomain(deps, row.funnel_id).catch((e) => deps.log.warn('pages domain sync failed', { funnel: row.funnel_id, error: String((e as Error).message).slice(0, 200) }));
  } catch (e) {
    if (e instanceof CloudflareApiError && e.retryable && (payload.errors ?? 0) < 6) {
      await logLine(deps, dep.id, 'warn', `Checking the deployment failed (${explain(e)}); trying again`, secrets);
      await again((payload.errors ?? 0) + 1, Math.max(deps.config.PAGES_POLL_INTERVAL_MS, (e.retryAfterS ?? 5) * 1000));
      return;
    }
    await failDeployment(deps, dep, row, e instanceof AppError ? e.message : explain(e), secrets);
  }
}

async function pruneHistory(deps: Deps, funnelId: string, previousActive: string | null): Promise<void> {
  const keep = deps.config.PAGES_KEEP_DEPLOYMENTS;
  const rows = await deps.db.all<{ id: string; status: string }>('SELECT id, status FROM publish_deployments WHERE funnel_id = ? ORDER BY created_at DESC, id DESC', funnelId);
  const drop = rows.slice(keep).filter((r) => !['queued', 'building', 'uploading', 'deploying'].includes(r.status) && r.id !== previousActive);
  for (const r of drop) await deps.db.run('DELETE FROM publish_deployments WHERE id = ?', r.id);
}

// ---- custom domain ---------------------------------------------------------------------------------------------------------------------------------------

/** Makes the project's custom domain match the funnel's domain (adds, replaces or removes it) and schedules status polling until Cloudflare reports it active or failed. */
export async function syncCustomDomain(deps: Deps, funnelId: string): Promise<void> {
  const row = await getRow(deps, funnelId);
  if (!row || row.target !== 'cloudflare-pages' || !row.project_name) return;
  const funnel = await requireFunnel(deps.db, row.workspace_id, funnelId, true);
  const { live, domain } = await wantsLive(deps, funnel);
  const want = live && domain && domain.kind === 'custom' ? domain.hostname : null;
  if (want === row.custom_domain && (row.custom_domain_status === 'active' || !want)) return;
  const client = clientFrom(deps, await credentialsFor(deps, row));
  if (row.custom_domain && row.custom_domain !== want) {
    await client.deleteDomain(row.project_name, row.custom_domain).catch((e) => {
      if (!(e instanceof CloudflareApiError && e.notFound)) throw e;
    });
    await deps.db.run('UPDATE funnel_publish SET custom_domain = NULL, custom_domain_status = NULL, custom_domain_error = NULL WHERE funnel_id = ?', funnelId);
  }
  if (!want) return;
  let d;
  try {
    d = await client.addDomain(row.project_name, want);
  } catch (e) {
    if (e instanceof CloudflareApiError && e.status === 409) d = await client.getDomain(row.project_name, want);
    else throw e;
  }
  const st = domainState(d);
  await deps.db.run('UPDATE funnel_publish SET custom_domain = ?, custom_domain_status = ?, custom_domain_error = ?, updated_at = ? WHERE funnel_id = ?', want, st.status, st.error, iso(deps), funnelId);
  if (st.status === 'pending') await deps.jobs.enqueue('publish.domain', { funnelId, since: iso(deps) }, { delayMs: Math.max(deps.config.PAGES_POLL_INTERVAL_MS, 1000), maxAttempts: 3, dedupeKey: `publish.domain:${funnelId}`, group: row.workspace_id });
}

export async function domainJob(deps: Deps, payload: { funnelId: string; since: string }): Promise<void> {
  const row = await getRow(deps, payload.funnelId);
  if (!row || row.target !== 'cloudflare-pages' || !row.custom_domain || !row.project_name || row.custom_domain_status === 'active') return;
  const r = await refreshDomain(deps, row.workspace_id, row.funnel_id);
  if (r.status === 'pending' && deps.now().getTime() - Date.parse(payload.since) < DOMAIN_POLL_LIMIT) {
    const waited = deps.now().getTime() - Date.parse(payload.since);
    await deps.jobs.enqueue('publish.domain', payload, { delayMs: Math.min(300_000, Math.max(deps.config.PAGES_POLL_INTERVAL_MS, 5_000 + waited / 6)), maxAttempts: 3, dedupeKey: `publish.domain:${payload.funnelId}`, group: row.workspace_id });
  }
}

export async function refreshDomain(deps: Deps, ws: string, funnelId: string) {
  await requireFunnel(deps.db, ws, funnelId, true);
  const row = await getRow(deps, funnelId);
  if (!row || row.target !== 'cloudflare-pages' || !row.project_name) throw conflict('NOT_PUBLISHED_TO_PAGES', 'This funnel is not published to Cloudflare Pages');
  if (!row.custom_domain) {
    await syncCustomDomain(deps, funnelId);
    const again = await getRow(deps, funnelId);
    return { hostname: again?.custom_domain ?? null, status: again?.custom_domain_status ?? null, error: again?.custom_domain_error ?? null };
  }
  try {
    const d = await clientFrom(deps, await credentialsFor(deps, row)).getDomain(row.project_name, row.custom_domain);
    const st = domainState(d);
    await deps.db.run('UPDATE funnel_publish SET custom_domain_status = ?, custom_domain_error = ?, updated_at = ? WHERE funnel_id = ?', st.status, st.error, iso(deps), funnelId);
    return { hostname: row.custom_domain, status: st.status, error: st.error };
  } catch (e) {
    if (e instanceof CloudflareApiError && e.notFound) {
      await deps.db.run('UPDATE funnel_publish SET custom_domain = NULL, custom_domain_status = NULL, custom_domain_error = NULL WHERE funnel_id = ?', funnelId);
      await syncCustomDomain(deps, funnelId);
      const again = await getRow(deps, funnelId);
      return { hostname: again?.custom_domain ?? null, status: again?.custom_domain_status ?? null, error: again?.custom_domain_error ?? null };
    }
    throw new AppError(502, 'CLOUDFLARE_UNAVAILABLE', explain(e));
  }
}

// ---- manual actions --------------------------------------------------------------------------------------------------------------------------------------

async function requirePagesRow(deps: Deps, ws: string, funnelId: string): Promise<{ funnel: FunnelRow; row: PublishRow }> {
  const funnel = await requireFunnel(deps.db, ws, funnelId, true);
  const row = await getRow(deps, funnelId);
  if (!row || row.target !== 'cloudflare-pages') throw conflict('NOT_PUBLISHED_TO_PAGES', 'This funnel is not published to Cloudflare Pages');
  return { funnel, row };
}

export async function redeploy(deps: Deps, auth: Auth, funnelId: string, ip: string | null) {
  const { row } = await requirePagesRow(deps, auth.workspaceId, funnelId);
  await deps.db.run('UPDATE funnel_publish SET hold = 0, paused = 0, updated_at = ? WHERE funnel_id = ?', iso(deps), funnelId);
  const id = await schedulePublish(deps, auth.workspaceId, funnelId, 'redeploy', auth.userId, true);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'publishing.redeploy', target: funnelId, detail: { project: row.project_name }, ip });
  return { deploymentId: id };
}

export async function rollback(deps: Deps, auth: Auth, funnelId: string, deploymentId: string, ip: string | null) {
  const ws = auth.workspaceId;
  const { row } = await requirePagesRow(deps, ws, funnelId);
  const target = await deps.db.get<DeploymentRow>('SELECT * FROM publish_deployments WHERE workspace_id = ? AND funnel_id = ? AND id = ?', ws, funnelId, deploymentId);
  if (!target) throw notFound('Deployment');
  if (target.status !== 'succeeded' || !target.cf_deployment_id) throw conflict('NOT_ROLLBACK_TARGET', 'Only a deployment that finished successfully can be rolled back to');
  if (target.id === row.active_deployment_id) throw conflict('ALREADY_ACTIVE', 'This deployment is already the live one');
  if (!(await acquireLease(deps, funnelId))) throw conflict('DEPLOYMENT_IN_PROGRESS', 'A deployment is running for this funnel. Try again when it has finished.');
  const id = newId('dep');
  const at = iso(deps);
  try {
    const client = clientFrom(deps, await credentialsFor(deps, row));
    await deps.db.run("INSERT INTO publish_deployments (id, workspace_id, funnel_id, reason, status, version_id, cf_deployment_id, file_count, bytes, url, log_json, attempts, requested_by, created_at, started_at) VALUES (?, ?, ?, 'rollback', 'deploying', ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?)",
      id, ws, funnelId, target.version_id, target.cf_deployment_id, target.file_count, target.bytes, target.url, auth.userId, at, at);
    await logLine(deps, id, 'info', `Rolling back to version ${target.version_id}`);
    await client.rollback(row.project_name!, target.cf_deployment_id);
  } catch (e) {
    const msg = e instanceof AppError ? e.message : explain(e);
    await deps.db.run("UPDATE publish_deployments SET status = 'failed', error = ?, finished_at = ? WHERE id = ?", msg.slice(0, 500), iso(deps), id);
    await releaseLease(deps, funnelId);
    throw new AppError(422, 'ROLLBACK_FAILED', msg);
  }
  await deps.db.run("UPDATE publish_deployments SET status = 'succeeded', finished_at = ? WHERE id = ?", iso(deps), id);
  await deps.db.run("UPDATE publish_deployments SET status = 'rolled_back' WHERE id = ? AND status = 'succeeded'", row.active_deployment_id ?? '');
  // The rolled-back version is now live, as its own history entry; automatic deployments wait for an explicit redeploy.
  await deps.db.run('UPDATE funnel_publish SET active_deployment_id = ?, active_version = ?, hold = 1, paused = 0, last_error = NULL, updated_at = ? WHERE funnel_id = ?', id, target.version_id, iso(deps), funnelId);
  await releaseLease(deps, funnelId);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'publishing.rollback', target: funnelId, detail: { to: target.version_id, deployment: target.id }, ip });
  return getSettings(deps, ws, funnelId);
}

async function unpublishNow(deps: Deps, auth: Auth, funnel: FunnelRow, row: PublishRow, mode: 'pause' | 'delete'): Promise<void> {
  const creds = await credentialsFor(deps, row).catch(() => null);
  if (!creds) return;
  const client = clientFrom(deps, creds);
  if (row.custom_domain) await client.deleteDomain(row.project_name!, row.custom_domain).catch(() => undefined);
  if (mode === 'delete' && row.project_created === 1) {
    await client.deleteProject(row.project_name!).catch((e) => {
      if (!(e instanceof CloudflareApiError && e.notFound)) throw new AppError(422, 'CLOUDFLARE_REJECTED', explain(e));
    });
    await deps.db.run("UPDATE funnel_publish SET active_deployment_id = NULL, active_version = NULL, custom_domain = NULL, custom_domain_status = NULL, custom_domain_error = NULL, project_name = NULL, pages_host = NULL, project_created = 0, paused = 0, hold = 0, updated_at = ? WHERE funnel_id = ?", iso(deps), funnel.id);
    await releasePagesAddress(deps, funnel.workspace_id, funnel.id); // the project and its *.pages.dev address are gone
    return;
  }
  // pause (or a project we do not own): replace the site with the paused page, synchronously, so the person sees the result.
  const bundle = buildPausedBundle();
  const jwt = await client.uploadToken(row.project_name!);
  const hashes = bundle.files.map((f) => f.hash);
  const missing = new Set(await client.checkMissing(jwt, hashes));
  await client.upload(jwt, bundle.files.filter((f) => missing.has(f.hash)).map((f) => ({ hash: f.hash, base64: Buffer.from(f.bytes).toString('base64'), contentType: f.contentType })));
  await client.upsertHashes(jwt, hashes);
  const cf = await client.createDeployment(row.project_name!, { manifest: bundle.manifest, headers: bundle.headers, commitHash: bundle.versionId, commitMessage: `unpublish ${bundle.versionId}` });
  const id = newId('dep');
  const at = iso(deps);
  await deps.db.run("INSERT INTO publish_deployments (id, workspace_id, funnel_id, reason, status, version_id, cf_deployment_id, file_count, bytes, url, log_json, attempts, requested_by, created_at, started_at) VALUES (?, ?, ?, 'unpublish', 'deploying', ?, ?, ?, ?, ?, '[]', 1, ?, ?, ?)",
    id, funnel.workspace_id, funnel.id, bundle.versionId, cf.id, bundle.files.length, bundle.bytes, cf.url ?? null, auth.userId, at, at);
  await deps.db.run("UPDATE funnel_publish SET paused = 1, hold = 1, custom_domain = NULL, custom_domain_status = NULL, custom_domain_error = NULL, active_deployment_id = ?, active_version = ?, updated_at = ? WHERE funnel_id = ?", id, bundle.versionId, at, funnel.id);
  await deps.jobs.enqueue('publish.poll', { deploymentId: id, errors: 0 }, { delayMs: deps.config.PAGES_POLL_INTERVAL_MS, maxAttempts: 5, dedupeKey: `publish.poll:${id}`, group: funnel.workspace_id });
}

export const UnpublishInput = z.object({ mode: z.enum(['pause', 'delete']).default('pause') });

export async function unpublish(deps: Deps, auth: Auth, funnelId: string, input: z.infer<typeof UnpublishInput>, ip: string | null) {
  const { funnel, row } = await requirePagesRow(deps, auth.workspaceId, funnelId);
  if (!(await acquireLease(deps, funnelId))) throw conflict('DEPLOYMENT_IN_PROGRESS', 'A deployment is running for this funnel. Try again when it has finished.');
  try {
    await unpublishNow(deps, auth, funnel, row, input.mode);
  } catch (e) {
    throw e instanceof AppError ? e : new AppError(422, 'CLOUDFLARE_REJECTED', explain(e));
  } finally {
    await releaseLease(deps, funnelId);
  }
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'publishing.unpublish', target: funnelId, detail: { mode: input.mode, project: row.project_name }, ip });
  return getSettings(deps, auth.workspaceId, funnelId);
}

/** Job: deletes the Pages project of a purged funnel (the row is gone, so everything needed travels in the payload). */
export async function destroyJob(deps: Deps, p: { workspaceId: string; owner: 'workspace' | 'platform'; project: string; domain: string | null }): Promise<void> {
  const client = clientFrom(deps, await credentialsFor(deps, { owner: p.owner, workspace_id: p.workspaceId }));
  if (p.domain) await client.deleteDomain(p.project, p.domain).catch(() => undefined);
  await client.deleteProject(p.project).catch((e) => {
    if (!(e instanceof CloudflareApiError && e.notFound)) throw e;
  });
}

/** Called before a funnel is permanently deleted: removes the project we created for it. */
export async function onFunnelPurge(deps: Deps, ws: string, funnelId: string): Promise<void> {
  const row = await getRow(deps, funnelId);
  if (!row || row.target !== 'cloudflare-pages' || !row.project_name || row.project_created !== 1) return;
  await deps.jobs.enqueue('publish.destroy', { workspaceId: ws, owner: row.owner, project: row.project_name, domain: row.custom_domain }, { maxAttempts: 5, group: ws });
}

// ---- history ---------------------------------------------------------------------------------------------------------------------------------------------

export async function listDeployments(deps: Deps, ws: string, funnelId: string) {
  await requireFunnel(deps.db, ws, funnelId, true);
  const row = await getRow(deps, funnelId);
  const rows = await deps.db.all<DeploymentRow>('SELECT * FROM publish_deployments WHERE workspace_id = ? AND funnel_id = ? ORDER BY created_at DESC, id DESC LIMIT 50', ws, funnelId);
  return { data: rows.map((d) => summarize(d, row?.active_deployment_id ?? null)) };
}

export async function getDeployment(deps: Deps, ws: string, funnelId: string, id: string) {
  await requireFunnel(deps.db, ws, funnelId, true);
  const d = await deps.db.get<DeploymentRow>('SELECT * FROM publish_deployments WHERE workspace_id = ? AND funnel_id = ? AND id = ?', ws, funnelId, id);
  if (!d) throw notFound('Deployment');
  const row = await getRow(deps, funnelId);
  return { ...summarize(d, row?.active_deployment_id ?? null), log: JSON.parse(d.log_json) as { t: string; level: string; msg: string }[] };
}

/** Re-evaluates every Pages funnel of a workspace (suspension, restoration). */
export async function onWorkspaceChanged(deps: Deps, ws: string): Promise<void> {
  for (const r of await deps.db.all<{ funnel_id: string }>("SELECT funnel_id FROM funnel_publish WHERE workspace_id = ? AND target = 'cloudflare-pages'", ws)) await onFunnelChanged(deps, r.funnel_id);
}

/** CNAME targets that count as "pointing at us" for domain verification: the Pages hosts of this workspace's funnels. */
export async function pagesHostsOf(deps: Pick<Deps, 'db'>, ws: string): Promise<string[]> {
  return (await deps.db.all<{ pages_host: string }>("SELECT DISTINCT pages_host FROM funnel_publish WHERE workspace_id = ? AND target = 'cloudflare-pages' AND pages_host IS NOT NULL", ws)).map((r) => r.pages_host.toLowerCase());
}
