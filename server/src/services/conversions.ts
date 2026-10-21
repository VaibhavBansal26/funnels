import { providerFor } from '../ads/providers/index.js';
import type { ConversionEvent, ConversionItem, ConversionName, ConversionUser } from '../ads/providers/types.js';
import type { Auth } from '../auth/context.js';
import type { Deps } from '../deps.js';
import { conflict, notFound } from '../errors.js';
import { PermanentJobError, type Job } from '../jobs/queue.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';
import { effectivePixels, loadPixelLevels } from './adtags.js';
import { snapshotFor } from './attribution.js';
import { requireIntegration, secretOf, sendCall, targetOf, type IntegrationRow } from './integrations.js';

/**
 * Server-side conversions: a Lead (opt-in form) or a Purchase (a verified, persisted order) becomes one queued delivery per enabled integration.
 * The request is built and hashed here, at the time of the event, and stored WITHOUT its secret: the delivery log never holds a raw email, phone or token, and a retry
 * sends exactly what the first attempt would have. Unique (integration, event name, event id) makes enqueueing idempotent: a redelivered webhook, a retried
 * transaction or a double-clicked form produces one delivery.
 */
export interface ConversionInput {
  ws: string;
  funnelId: string;
  stepId?: string | null;
  kind: ConversionName;
  eventId: string;
  visitorId?: string | null;
  user: { email: string; name?: string | null; phone?: string | null; zip?: string | null; country?: string | null; city?: string | null; state?: string | null };
  value?: number;
  currency?: string;
  orderId?: string;
  items?: ConversionItem[];
}

const LEAD_KEYS = {
  zip: ['zip', 'zipcode', 'zip_code', 'postal', 'postal_code', 'postcode'],
  country: ['country', 'country_code'],
  city: ['city', 'town'],
  state: ['state', 'region', 'province'],
};

/** Customer details from the lead's stored form values, by the field names forms commonly use. */
export function userFromLead(lead: { email: string; name?: string | null; phone?: string | null; data_json?: string | null }): ConversionInput['user'] {
  let data: Record<string, unknown> = {};
  try {
    data = lead.data_json ? (JSON.parse(lead.data_json) as Record<string, unknown>) : {};
  } catch {
    /* ignored */
  }
  const lower = new Map(Object.entries(data).map(([k, v]) => [k.toLowerCase().replace(/[^a-z_]/g, ''), typeof v === 'string' ? v : undefined]));
  const pick = (keys: string[]) => keys.map((k) => lower.get(k)).find((v) => !!v);
  return { email: lead.email, name: lead.name, phone: lead.phone, zip: pick(LEAD_KEYS.zip), country: pick(LEAD_KEYS.country), city: pick(LEAD_KEYS.city), state: pick(LEAD_KEYS.state) };
}

async function pageUrl(deps: Pick<Deps, 'db'>, ws: string, funnelId: string, stepId: string | null | undefined): Promise<string | null> {
  const row = await deps.db.get<{ hostname: string; base_path: string }>(
    `SELECT d.hostname, s.base_path FROM funnels f JOIN domains d ON d.id = f.domain_id JOIN steps s ON s.funnel_id = f.id
     WHERE f.workspace_id = ? AND f.id = ? ${stepId ? 'AND s.id = ?' : ''} ORDER BY s.position LIMIT 1`,
    ws, funnelId, ...(stepId ? [stepId] : []),
  );
  return row ? `https://${row.hostname}${row.base_path}` : null;
}

/**
 * Queues the conversion for every enabled integration of the workspace. Call it inside the transaction that records the lead or order (pass the transaction-scoped
 * deps) so the deliveries exist if and only if the record does. Never throws for "nothing to do".
 */
export async function enqueueConversions(deps: Deps, c: ConversionInput): Promise<number> {
  const integrations = await deps.db.all<IntegrationRow>(
    `SELECT * FROM ad_integrations WHERE workspace_id = ? AND enabled = 1 AND ${c.kind === 'Lead' ? 'send_lead' : 'send_purchase'} = 1 ORDER BY created_at, id`,
    c.ws,
  );
  if (!integrations.length) return 0;
  const snap = await snapshotFor(deps, c.ws, c.visitorId);
  const consent = effectivePixels(await loadPixelLevels(deps, c.ws, c.funnelId), c.stepId ?? '').consent;
  const reported = snap?.ids.consent;
  // Consent: with a banner in use the visitor must have accepted; without one a recorded refusal (Do Not Track, an earlier banner) still counts.
  const allowed = consent.enabled ? reported === 'granted' : reported !== 'denied';
  const clicks = { ...(snap?.first?.clickIds ?? {}), ...(snap?.last?.clickIds ?? {}) };
  const user: ConversionUser = {
    ...c.user,
    externalId: c.visitorId ?? null,
    ip: snap?.ip ?? null,
    userAgent: snap?.userAgent ?? null,
    fbp: snap?.ids.fbp ?? null,
    fbc: snap?.ids.fbc ?? null,
    ttp: snap?.ids.ttp ?? null,
    ttclid: clicks.ttclid ?? null,
    gclid: clicks.gclid ?? null,
    gaClientId: snap?.ids.gaClientId ?? null,
    gaSessionId: snap?.ids.gaSessionId ?? null,
  };
  const event: ConversionEvent = { name: c.kind, eventId: c.eventId, timeMs: deps.now().getTime(), sourceUrl: await pageUrl(deps, c.ws, c.funnelId, c.stepId), user, value: c.value, currency: c.currency, orderId: c.orderId, items: c.items };
  const at = deps.now().toISOString();
  let queued = 0;
  for (const r of integrations) {
    const provider = providerFor(r.provider)!;
    const built = provider.build(event, targetOf(deps, r), { test: false });
    const id = newId('cdl');
    const inserted = await deps.db.run(
      `INSERT INTO conversion_deliveries (id, workspace_id, integration_id, funnel_id, event_name, event_id, is_test, status, attempts, error, payload_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)${deps.db.dialect.onConflictDoNothing(['integration_id', 'event_name', 'event_id'])}`,
      id, c.ws, r.id, c.funnelId, provider.eventName(c.kind), c.eventId, allowed ? 'queued' : 'skipped', allowed ? null : 'The visitor has not agreed to advertising cookies (or sent Do Not Track): nothing was sent', JSON.stringify(built), at, at,
    );
    if (inserted.changes !== 1 || !allowed) continue;
    await deps.jobs.enqueue('conversion.deliver', { deliveryId: id }, { maxAttempts: deps.config.CONVERSIONS_MAX_ATTEMPTS, group: c.ws });
    queued++;
  }
  return queued;
}

interface Delivery {
  id: string;
  workspace_id: string;
  integration_id: string;
  status: string;
  attempts: number;
  payload_json: string;
}

/**
 * Job handler. A permanent refusal (bad token, invalid parameter) ends the delivery as `dead` at once; a temporary one (timeout, 5xx, rate limit) is retried by the
 * job queue with exponential backoff (30 s, 60 s, ... up to an hour) until CONVERSIONS_MAX_ATTEMPTS, then `dead` too. `dead` deliveries stay in the log and can be re-sent by hand.
 */
export async function deliverConversion(deps: Deps, payload: { deliveryId: string }, job: Pick<Job, 'attempts' | 'maxAttempts'>): Promise<void> {
  const d = await deps.db.get<Delivery>('SELECT id, workspace_id, integration_id, status, attempts, payload_json FROM conversion_deliveries WHERE id = ?', payload.deliveryId);
  if (!d || d.status === 'sent' || d.status === 'skipped' || d.status === 'dead') return;
  const at = () => deps.now().toISOString();
  const finish = (status: string, fields: { http?: number | null; error?: string | null; response?: string | null }) =>
    deps.db.run('UPDATE conversion_deliveries SET status = ?, attempts = ?, http_status = ?, error = ?, response_json = ?, updated_at = ? WHERE id = ?', status, d.attempts + 1, fields.http ?? null, fields.error ?? null, fields.response ?? null, at(), d.id);
  const r = await deps.db.get<IntegrationRow>('SELECT * FROM ad_integrations WHERE id = ? AND workspace_id = ?', d.integration_id, d.workspace_id);
  if (!r || !r.enabled) {
    await finish('skipped', { error: r ? 'The integration is switched off' : 'The integration was removed' });
    return;
  }
  let result;
  try {
    secretOf(deps, r); // fail early and permanently when the key is missing or the stored value cannot be decrypted
    result = await sendCall(deps, r, JSON.parse(d.payload_json), false);
  } catch (e) {
    await finish('dead', { error: (e as Error).message.slice(0, 300) });
    await deps.db.run('UPDATE ad_integrations SET last_status = ?, last_error = ?, last_delivery_at = ? WHERE id = ?', 'error', (e as Error).message.slice(0, 300), at(), r.id);
    throw new PermanentJobError((e as Error).message);
  }
  if (result.ok) {
    await finish('sent', { http: result.httpStatus, response: result.response });
    await deps.db.run('UPDATE ad_integrations SET last_status = ?, last_error = NULL, last_delivery_at = ? WHERE id = ?', 'ok', at(), r.id);
    return;
  }
  const exhausted = job.attempts >= job.maxAttempts;
  const dead = !result.retry || exhausted;
  await finish(dead ? 'dead' : 'failed', { http: result.httpStatus, error: result.message, response: result.response });
  await deps.db.run('UPDATE ad_integrations SET last_status = ?, last_error = ?, last_delivery_at = ? WHERE id = ?', 'error', result.message, at(), r.id);
  if (!dead) throw new Error(result.message ?? 'delivery failed'); // the queue retries with backoff
  if (!result.retry) return; // permanent refusal: the job is done, the delivery is dead
  throw new PermanentJobError(result.message ?? 'delivery failed');
}

/** Puts a dead or failed delivery back in the queue (a person decided to try again, for example after fixing the token). */
export async function retryDelivery(deps: Deps, auth: Auth, deliveryId: string, ip: string | null) {
  const ws = auth.workspaceId;
  const d = await deps.db.get<Delivery & { is_test: number }>('SELECT id, workspace_id, integration_id, status, attempts, payload_json, is_test FROM conversion_deliveries WHERE workspace_id = ? AND id = ?', ws, deliveryId);
  if (!d) throw notFound('Delivery');
  if (d.is_test === 1) throw conflict('TEST_DELIVERY', 'Test events are not re-sent; send a new test event instead');
  if (d.status !== 'dead' && d.status !== 'failed') throw conflict('NOT_RETRYABLE', 'Only failed or dead deliveries can be sent again');
  await requireIntegration(deps, ws, d.integration_id);
  await deps.db.run("UPDATE conversion_deliveries SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?", deps.now().toISOString(), d.id);
  await deps.jobs.enqueue('conversion.deliver', { deliveryId: d.id }, { maxAttempts: deps.config.CONVERSIONS_MAX_ATTEMPTS, group: ws, dedupeKey: `conversion.deliver:${d.id}` });
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'integration.delivery_retried', target: d.id, detail: { integrationId: d.integration_id }, ip });
  return { ok: true as const };
}
