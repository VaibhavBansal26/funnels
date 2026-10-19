import { z } from 'zod';
import type { Deps } from '../deps.js';
import { badRequest, conflict, notFound } from '../errors.js';
import type { DomainRow, StepRow } from '../repos/types.js';
import { newId, newToken } from '../util/ids.js';
import { liveUrlsForFunnel, schedulePurge } from '../edge/purger.js';

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
export const CHALLENGE_PREFIX = '_funnels-challenge.';

export const DomainInput = z.object({ hostname: z.string().trim().min(3).max(253) });
export const DefaultPagesInput = z.object({
  homeStepId: z.string().max(64).nullable().optional(),
  notFoundStepId: z.string().max(64).nullable().optional(),
});

export function normalizeHostname(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.$/, '');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function serializeDomain(deps: Deps, d: DomainRow, funnelCount = 0) {
  const extra = d.provider_records ? (JSON.parse(d.provider_records) as { type: string; name: string; value: string }[]) : [];
  return {
    provider: d.provider,
    extraRecords: extra,
    id: d.id,
    hostname: d.hostname,
    status: d.status,
    failureReason: d.failure_reason,
    verifiedAt: d.verified_at,
    lastCheckedAt: d.last_checked_at,
    createdAt: d.created_at,
    defaultHomeStepId: d.default_home_step_id,
    default404StepId: d.default_404_step_id,
    funnelCount,
    dns: {
      cname: { type: 'CNAME', name: d.hostname, value: deps.config.APP_PUBLIC_CNAME_TARGET },
      txt: { type: 'TXT', name: `${CHALLENGE_PREFIX}${d.hostname}`, value: `funnels-verify=${d.verification_token}` },
    },
  };
}

export function requireDomain(deps: Deps, ws: string, id: string): DomainRow {
  const d = deps.db.get<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? AND id = ?', ws, id);
  if (!d) throw notFound('Domain');
  return d;
}

const countFor = (deps: Deps, id: string) => deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM funnels WHERE domain_id = ? AND deleted_at IS NULL', id)!.n;

export function listDomains(deps: Deps, ws: string) {
  const rows = deps.db.all<DomainRow>('SELECT * FROM domains WHERE workspace_id = ? ORDER BY created_at DESC', ws);
  return { data: rows.map((d) => serializeDomain(deps, d, countFor(deps, d.id))) };
}

export function getDomain(deps: Deps, ws: string, id: string) {
  const d = requireDomain(deps, ws, id);
  return serializeDomain(deps, d, countFor(deps, id));
}

export function enqueueVerification(deps: Deps, domainId: string, attempt = 0): void {
  const delayMs = Math.min(60_000 * 2 ** attempt, 3_600_000);
  deps.jobs.enqueue('domain.verify', { domainId, attempt }, { delayMs, maxAttempts: 3, dedupeKey: `domain.verify:${domainId}` });
}

export async function createDomain(deps: Deps, ws: string, input: z.infer<typeof DomainInput>) {
  const hostname = normalizeHostname(input.hostname);
  const reserved = new Set([hostOf(deps.config.APP_PUBLIC_URL), deps.config.APP_PUBLIC_CNAME_TARGET.toLowerCase(), 'localhost']);
  if (!HOST_RE.test(hostname)) throw badRequest('INVALID_HOSTNAME', 'Enter a valid hostname such as offers.example.com (no protocol, path or port)');
  if (reserved.has(hostname)) throw badRequest('HOSTNAME_RESERVED', 'This hostname is reserved');
  const id = newId('dom');
  const at = deps.now().toISOString();
  if (deps.db.get('SELECT 1 FROM domains WHERE hostname = ?', hostname)) throw conflict('DOMAIN_TAKEN', 'This hostname is already registered');
  const external = await deps.domainProvider.create(hostname);
  try {
    deps.db.run(
      'INSERT INTO domains (id, workspace_id, hostname, status, verification_token, provider, provider_ref, provider_records, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, ws, hostname, 'pending', newToken(18), deps.domainProvider.name, external?.externalId ?? null, external?.records ? JSON.stringify(external.records) : null, at, at,
    );
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) throw conflict('DOMAIN_TAKEN', 'This hostname is already registered');
    throw e;
  }
  enqueueVerification(deps, id);
  return getDomain(deps, ws, id);
}

/**
 * Funnels on a domain that stops being active (or is deleted) go back to test and lose the domain.
 * Callers invoke this inside the same transaction that changes the domain, so both succeed or neither does.
 */
export function revertFunnelsOnDomain(deps: Deps, ws: string, domainId: string): string[] {
  const at = deps.now().toISOString();
  const ids = deps.db.all<{ id: string }>('SELECT id FROM funnels WHERE workspace_id = ? AND domain_id = ?', ws, domainId).map((r) => r.id);
  for (const id of ids) schedulePurge(deps, liveUrlsForFunnel(deps, id));
  deps.db.run(`UPDATE funnels SET status = 'test', domain_id = NULL, updated_at = ? WHERE workspace_id = ? AND domain_id = ?`, at, ws, domainId);
  deps.db.run('UPDATE domains SET default_home_step_id = NULL, default_404_step_id = NULL WHERE workspace_id = ? AND id = ?', ws, domainId);
  return ids;
}

export async function deleteDomain(deps: Deps, ws: string, id: string): Promise<void> {
  const d = requireDomain(deps, ws, id);
  if (d.provider === 'cloudflare' && d.provider_ref) await deps.domainProvider.remove(d.provider_ref).catch((e) => deps.log.warn('provider delete failed', { error: (e as Error).message }));
  deps.db.tx(() => {
    requireDomain(deps, ws, id);
    revertFunnelsOnDomain(deps, ws, id);
    deps.db.run('DELETE FROM domains WHERE workspace_id = ? AND id = ?', ws, id);
  });
}

export interface VerifyResult {
  domain: ReturnType<typeof serializeDomain>;
  checks: { cname: { ok: boolean; found: string[] }; txt: { ok: boolean } } | null;
  error?: string;
}

/** Real DNS check through the injected resolver; applies the pending/active/failed transitions. */
export async function verifyDomain(deps: Deps, ws: string, id: string): Promise<VerifyResult> {
  const d = requireDomain(deps, ws, id);
  const at = deps.now();
  if (d.provider === 'cloudflare' && d.provider_ref) return verifyViaProvider(deps, d, at);
  const target = deps.config.APP_PUBLIC_CNAME_TARGET.toLowerCase().replace(/\.$/, '');
  const expectedTxt = `funnels-verify=${d.verification_token}`;
  let cname: string[];
  let txt: string[];
  try {
    [cname, txt] = await Promise.all([deps.dns.resolveCname(d.hostname), deps.dns.resolveTxt(`${CHALLENGE_PREFIX}${d.hostname}`)]);
  } catch (e) {
    deps.log.warn('dns lookup failed', { hostname: d.hostname, error: (e as Error).message });
    deps.db.run('UPDATE domains SET last_checked_at = ?, updated_at = ? WHERE id = ?', at.toISOString(), at.toISOString(), id);
    return { domain: getDomain(deps, ws, id), checks: null, error: 'DNS lookup failed. This is usually temporary; try again shortly.' };
  }
  const cnameOk = cname.includes(target);
  const txtOk = txt.some((v) => v.trim() === expectedTxt);
  const ok = cnameOk && txtOk;
  const ageHours = (at.getTime() - Date.parse(d.created_at)) / 3_600_000;
  const reason = !txtOk ? `TXT record ${CHALLENGE_PREFIX}${d.hostname} with value ${expectedTxt} was not found` : `CNAME for ${d.hostname} does not point to ${target}`;
  let status: DomainRow['status'] = d.status;
  let failure: string | null = null;
  if (ok) status = 'active';
  else if (d.status === 'active') [status, failure] = ['failed', `Verification lost: ${reason}`];
  else if (d.status === 'pending' && ageHours >= deps.config.DOMAIN_VERIFY_TIMEOUT_HOURS) [status, failure] = ['failed', `Timed out after ${deps.config.DOMAIN_VERIFY_TIMEOUT_HOURS}h: ${reason}`];
  else failure = reason;

  deps.db.tx(() => {
    deps.db.run(
      'UPDATE domains SET status = ?, failure_reason = ?, verified_at = ?, last_checked_at = ?, updated_at = ? WHERE id = ?',
      status, ok ? null : failure, ok ? (d.verified_at ?? at.toISOString()) : d.verified_at, at.toISOString(), at.toISOString(), id,
    );
    if (d.status === 'active' && status !== 'active') revertFunnelsOnDomain(deps, ws, id);
  });
  return { domain: getDomain(deps, ws, id), checks: { cname: { ok: cnameOk, found: cname }, txt: { ok: txtOk } } };
}

/** Cloudflare for SaaS: the provider owns hostname + certificate validation; we mirror its status and apply the same transitions. */
async function verifyViaProvider(deps: Deps, d: DomainRow, at: Date): Promise<VerifyResult> {
  let p;
  try {
    p = await deps.domainProvider.get(d.provider_ref!);
  } catch (e) {
    deps.log.warn('provider lookup failed', { hostname: d.hostname, error: (e as Error).message });
    deps.db.run('UPDATE domains SET last_checked_at = ?, updated_at = ? WHERE id = ?', at.toISOString(), at.toISOString(), d.id);
    return { domain: getDomain(deps, d.workspace_id, d.id), checks: null, error: 'The domain provider could not be reached. Try again shortly.' };
  }
  deps.db.tx(() => {
    deps.db.run(
      'UPDATE domains SET status = ?, failure_reason = ?, provider_records = ?, verified_at = ?, last_checked_at = ?, updated_at = ? WHERE id = ?',
      p.status, p.status === 'active' ? null : (p.reason ?? null), p.records ? JSON.stringify(p.records) : d.provider_records,
      p.status === 'active' ? (d.verified_at ?? at.toISOString()) : d.verified_at, at.toISOString(), at.toISOString(), d.id,
    );
    if (d.status === 'active' && p.status !== 'active') revertFunnelsOnDomain(deps, d.workspace_id, d.id);
  });
  return { domain: getDomain(deps, d.workspace_id, d.id), checks: null };
}

/** Job handler: re-checks a pending domain, rescheduling with backoff until it is active or has failed. */
export async function verificationJob(deps: Deps, payload: { domainId: string; attempt: number }): Promise<void> {
  const d = deps.db.get<DomainRow>('SELECT * FROM domains WHERE id = ?', payload.domainId);
  if (!d || d.status !== 'pending') return;
  const r = await verifyDomain(deps, d.workspace_id, d.id);
  if (r.domain.status === 'pending') enqueueVerification(deps, d.id, payload.attempt + 1);
}

export function domainRoutes(deps: Deps, ws: string, id: string) {
  requireDomain(deps, ws, id);
  const rows = deps.db.all<StepRow & { funnel_name: string }>(
    `SELECT s.*, f.name AS funnel_name FROM steps s JOIN funnels f ON f.id = s.funnel_id
     WHERE f.workspace_id = ? AND f.domain_id = ? AND f.deleted_at IS NULL ORDER BY f.name, s.position`, ws, id,
  );
  return { data: rows.map((r) => ({ stepId: r.id, stepName: r.name, funnelId: r.funnel_id, funnelName: r.funnel_name, path: r.base_path })) };
}

/** Home page serves "/" and the 404 page serves unknown paths. Steps must belong to a live funnel on this domain. */
export function setDefaultPages(deps: Deps, ws: string, id: string, input: z.infer<typeof DefaultPagesInput>) {
  return deps.db.tx(() => {
    const d = requireDomain(deps, ws, id);
    const check = (stepId: string | null | undefined): string | null => {
      if (!stepId) return null;
      const hit = deps.db.get(
        `SELECT s.id FROM steps s JOIN funnels f ON f.id = s.funnel_id WHERE s.workspace_id = ? AND s.id = ? AND f.domain_id = ? AND f.deleted_at IS NULL`, ws, stepId, id,
      );
      if (!hit) throw badRequest('STEP_NOT_ON_DOMAIN', 'The step must belong to a funnel attached to this domain');
      return stepId;
    };
    const home = input.homeStepId === undefined ? d.default_home_step_id : check(input.homeStepId);
    const nf = input.notFoundStepId === undefined ? d.default_404_step_id : check(input.notFoundStepId);
    deps.db.run('UPDATE domains SET default_home_step_id = ?, default_404_step_id = ?, updated_at = ? WHERE id = ?', home, nf, deps.now().toISOString(), id);
    return getDomain(deps, ws, id);
  });
}

