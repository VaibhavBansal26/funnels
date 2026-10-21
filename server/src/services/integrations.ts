import { z } from 'zod';
import { ID_FORMATS, ID_HINTS } from '../ads/ids.js';
import { PROVIDERS_BY_ID, providerFor } from '../ads/providers/index.js';
import { errorText, type ConversionEvent, type IntegrationTarget, type ProviderId } from '../ads/providers/types.js';
import type { Auth } from '../auth/context.js';
import { decryptWithDataKey, encryptWithDataKey } from '../auth/dataCrypto.js';
import { isUniqueViolation } from '../db/index.js';
import type { Deps } from '../deps.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { newId } from '../util/ids.js';
import { audit } from './audit.js';

export const MAX_INTEGRATIONS = 10;

const PIXEL_FORMAT: Record<ProviderId, { re: RegExp; hint: string }> = {
  meta: { re: ID_FORMATS.metaPixel, hint: ID_HINTS.metaPixel },
  ga4: { re: ID_FORMATS.ga4, hint: ID_HINTS.ga4 },
  tiktok: { re: ID_FORMATS.tiktok, hint: ID_HINTS.tiktok },
};

const secretField = z.string().trim().min(8, 'The access token looks too short').max(1024).regex(/^[\x21-\x7e]+$/, 'The token may only contain visible ASCII characters (no spaces)');
const testCode = z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/, 'A test event code has letters, digits, - and _');

export const IntegrationInput = z
  .object({
    provider: z.enum(['meta', 'ga4', 'tiktok']),
    name: z.string().trim().min(1).max(80),
    pixelId: z.string().trim().max(40),
    secret: secretField,
    testEventCode: testCode.nullable().optional(),
    enabled: z.boolean().optional(),
    sendLead: z.boolean().optional(),
    sendPurchase: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const f = PIXEL_FORMAT[v.provider];
    if (!f.re.test(v.pixelId)) ctx.addIssue({ code: 'custom', path: ['pixelId'], message: `Enter ${f.hint}` });
  });

export const IntegrationPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  secret: secretField.optional(),
  testEventCode: testCode.nullable().optional(),
  enabled: z.boolean().optional(),
  sendLead: z.boolean().optional(),
  sendPurchase: z.boolean().optional(),
});

export interface IntegrationRow {
  id: string;
  workspace_id: string;
  provider: ProviderId;
  name: string;
  pixel_id: string;
  secret_enc: string | null;
  secret_hint: string | null;
  test_event_code: string | null;
  enabled: number;
  send_lead: number;
  send_purchase: number;
  last_status: string | null;
  last_error: string | null;
  last_delivery_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** The API shape. The secret is never part of it: only whether one is stored and its last four characters. */
export const serializeIntegration = (r: IntegrationRow) => ({
  id: r.id,
  provider: r.provider,
  providerLabel: PROVIDERS_BY_ID[r.provider].label,
  name: r.name,
  pixelId: r.pixel_id,
  hasSecret: !!r.secret_enc,
  secretHint: r.secret_hint,
  testEventCode: r.test_event_code,
  enabled: r.enabled === 1,
  sendLead: r.send_lead === 1,
  sendPurchase: r.send_purchase === 1,
  lastStatus: r.last_status,
  lastError: r.last_error,
  lastDeliveryAt: r.last_delivery_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const aad = (ws: string, id: string) => `adint:${ws}:${id}`;
const hint = (secret: string) => (secret.length >= 12 ? `••••${secret.slice(-4)}` : '••••');

export async function requireIntegration(deps: Pick<Deps, 'db'>, ws: string, id: string): Promise<IntegrationRow> {
  const r = await deps.db.get<IntegrationRow>('SELECT * FROM ad_integrations WHERE workspace_id = ? AND id = ?', ws, id);
  if (!r) throw notFound('Integration');
  return r;
}

export async function listIntegrations(deps: Deps, ws: string) {
  const rows = await deps.db.all<IntegrationRow>('SELECT * FROM ad_integrations WHERE workspace_id = ? ORDER BY created_at, id', ws);
  return { data: rows.map(serializeIntegration) };
}

export async function createIntegration(deps: Deps, auth: Auth, input: z.infer<typeof IntegrationInput>, ip: string | null) {
  const ws = auth.workspaceId;
  const count = Number((await deps.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ad_integrations WHERE workspace_id = ?', ws))!.n);
  if (count >= MAX_INTEGRATIONS) throw conflict('INTEGRATION_LIMIT', `A workspace can have at most ${MAX_INTEGRATIONS} integrations`);
  const id = newId('adi');
  const at = deps.now().toISOString();
  const enc = encryptWithDataKey(deps.config, input.secret, aad(ws, id)); // throws 503 DATA_ENCRYPTION_KEY_REQUIRED in production without a key
  try {
    await deps.db.run(
      `INSERT INTO ad_integrations (id, workspace_id, provider, name, pixel_id, secret_enc, secret_hint, test_event_code, enabled, send_lead, send_purchase, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ws, input.provider, input.name, input.pixelId, enc, hint(input.secret), input.testEventCode ?? null, input.enabled === false ? 0 : 1, input.sendLead === false ? 0 : 1, input.sendPurchase === false ? 0 : 1, auth.userId, at, at,
    );
  } catch (e) {
    if (isUniqueViolation(e)) throw conflict('INTEGRATION_EXISTS', 'This pixel is already connected');
    throw e;
  }
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'integration.created', target: id, detail: { provider: input.provider, pixelId: input.pixelId, name: input.name }, ip });
  return serializeIntegration(await requireIntegration(deps, ws, id));
}

export async function updateIntegration(deps: Deps, auth: Auth, id: string, patch: z.infer<typeof IntegrationPatch>, ip: string | null) {
  const ws = auth.workspaceId;
  const cur = await requireIntegration(deps, ws, id);
  const fields: Record<string, string | number | null> = { updated_at: deps.now().toISOString() };
  const changed: string[] = [];
  if (patch.name !== undefined) (fields.name = patch.name, changed.push('name'));
  if (patch.secret !== undefined) {
    fields.secret_enc = encryptWithDataKey(deps.config, patch.secret, aad(ws, id));
    fields.secret_hint = hint(patch.secret);
    fields.last_error = null;
    fields.last_status = null;
    changed.push('secret');
  }
  if (patch.testEventCode !== undefined) (fields.test_event_code = patch.testEventCode, changed.push('testEventCode'));
  if (patch.enabled !== undefined) (fields.enabled = patch.enabled ? 1 : 0, changed.push('enabled'));
  if (patch.sendLead !== undefined) (fields.send_lead = patch.sendLead ? 1 : 0, changed.push('sendLead'));
  if (patch.sendPurchase !== undefined) (fields.send_purchase = patch.sendPurchase ? 1 : 0, changed.push('sendPurchase'));
  const names = Object.keys(fields);
  await deps.db.run(`UPDATE ad_integrations SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE workspace_id = ? AND id = ?`, ...names.map((n) => fields[n]!), ws, id);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'integration.updated', target: id, detail: { provider: cur.provider, pixelId: cur.pixel_id, changed }, ip });
  return serializeIntegration(await requireIntegration(deps, ws, id));
}

export async function deleteIntegration(deps: Deps, auth: Auth, id: string, ip: string | null): Promise<void> {
  const cur = await requireIntegration(deps, auth.workspaceId, id);
  await deps.db.run('DELETE FROM ad_integrations WHERE workspace_id = ? AND id = ?', auth.workspaceId, id);
  await audit(deps, { workspaceId: auth.workspaceId, actorId: auth.userId, action: 'integration.deleted', target: id, detail: { provider: cur.provider, pixelId: cur.pixel_id, name: cur.name }, ip });
}

export const targetOf = (deps: Pick<Deps, 'config'>, r: IntegrationRow): IntegrationTarget => ({
  pixelId: r.pixel_id,
  testEventCode: r.test_event_code,
  version: deps.config.META_GRAPH_VERSION,
  base: r.provider === 'meta' ? deps.config.META_GRAPH_BASE : r.provider === 'ga4' ? deps.config.GA4_MP_BASE : deps.config.TIKTOK_EVENTS_BASE,
});

export function secretOf(deps: Pick<Deps, 'config'>, r: IntegrationRow): string {
  if (!r.secret_enc) throw new AppError(409, 'NO_SECRET', 'This integration has no access token stored');
  return decryptWithDataKey(deps.config, r.secret_enc, aad(r.workspace_id, r.id)).plain;
}

export interface SendResult {
  ok: boolean;
  httpStatus: number | null;
  retry: boolean;
  message: string | null;
  response: string | null;
}

/** One call to the network. Network errors and timeouts are results (retry: true), never exceptions; the secret never appears in the message or the stored response. */
export async function sendCall(deps: Deps, r: IntegrationRow, built: ReturnType<(typeof PROVIDERS_BY_ID)['meta']['build']>, test: boolean): Promise<SendResult> {
  const provider = providerFor(r.provider)!;
  const secret = secretOf(deps, r);
  const call = provider.prepare(built, targetOf(deps, r), secret, { test });
  let status: number;
  let text: string;
  try {
    const res = await deps.outbound(call.url, { method: 'POST', headers: call.headers, body: call.body, signal: AbortSignal.timeout(deps.config.CONVERSIONS_TIMEOUT_MS) });
    status = res.status;
    text = (await res.text().catch(() => '')).slice(0, 4000);
  } catch (e) {
    const name = (e as Error).name === 'TimeoutError' || (e as Error).name === 'AbortError' ? 'timed out' : errorText((e as Error).message ?? 'network error', secret);
    return { ok: false, httpStatus: null, retry: true, message: `The request to ${provider.label} failed: ${name}`, response: null };
  }
  const o = provider.interpret(status, text, { test });
  const safe = errorText(text, secret).slice(0, 2000);
  return o.ok ? { ok: true, httpStatus: status, retry: false, message: null, response: safe } : { ok: false, httpStatus: status, retry: o.retry, message: errorText(o.message, secret), response: safe };
}

/** Sends one test event right now (not queued). Meta and TikTok test events need the test event code from the network's Events Manager, otherwise they would count as real events. */
export async function sendTestEvent(deps: Deps, auth: Auth, id: string, ip: string | null) {
  const ws = auth.workspaceId;
  const r = await requireIntegration(deps, ws, id);
  if ((r.provider === 'meta' || r.provider === 'tiktok') && !r.test_event_code) {
    throw badRequest('TEST_CODE_REQUIRED', 'Enter the test event code from the network\'s Events Manager first; without it this event would count as a real one.');
  }
  const provider = providerFor(r.provider)!;
  const eventId = `test_${newId('t')}`;
  const event: ConversionEvent = {
    name: 'Purchase', eventId, timeMs: deps.now().getTime(), sourceUrl: deps.config.APP_PUBLIC_URL,
    user: { email: 'test@example.com', externalId: 'funnels-test-event', ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (Funnels test event)' },
    value: 1, currency: 'USD', orderId: eventId, items: [{ id: 'test', name: 'Funnels test event', quantity: 1, price: 1 }],
  };
  const built = provider.build(event, targetOf(deps, r), { test: true });
  const result = await sendCall(deps, r, built, true);
  const at = deps.now().toISOString();
  const deliveryId = newId('cdl');
  await deps.db.run(
    `INSERT INTO conversion_deliveries (id, workspace_id, integration_id, funnel_id, event_name, event_id, is_test, status, attempts, http_status, error, payload_json, response_json, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?)`,
    deliveryId, ws, id, provider.eventName('Purchase'), eventId, result.ok ? 'sent' : 'failed', result.httpStatus, result.message, JSON.stringify(built), result.response, at, at,
  );
  await deps.db.run('UPDATE ad_integrations SET last_status = ?, last_error = ?, last_delivery_at = ?, updated_at = ? WHERE id = ?', result.ok ? 'ok' : 'error', result.message, at, at, id);
  await audit(deps, { workspaceId: ws, actorId: auth.userId, action: 'integration.tested', target: id, detail: { provider: r.provider, ok: result.ok }, ip });
  return { ok: result.ok, httpStatus: result.httpStatus, message: result.message, response: result.response, deliveryId, eventId };
}

export const DeliveryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(120).optional(),
  status: z.enum(['queued', 'sent', 'failed', 'dead', 'skipped']).optional(),
});

interface DeliveryRow {
  id: string;
  integration_id: string;
  funnel_id: string | null;
  event_name: string;
  event_id: string;
  is_test: number;
  status: string;
  attempts: number;
  http_status: number | null;
  error: string | null;
  response_json: string | null;
  created_at: string;
  updated_at: string;
}

export const serializeDelivery = (d: DeliveryRow) => ({
  id: d.id, integrationId: d.integration_id, funnelId: d.funnel_id, eventName: d.event_name, eventId: d.event_id, isTest: d.is_test === 1, status: d.status, attempts: d.attempts, httpStatus: d.http_status, error: d.error, response: d.response_json, createdAt: d.created_at, updatedAt: d.updated_at,
});

/** Newest first, keyset-paginated. Request payloads (hashed identifiers) are stored but not returned: the log shows what happened, not who. */
export async function listDeliveries(deps: Deps, ws: string, integrationId: string, q: z.infer<typeof DeliveryQuery>) {
  await requireIntegration(deps, ws, integrationId);
  const where = ['workspace_id = ?', 'integration_id = ?'];
  const params: (string | number)[] = [ws, integrationId];
  if (q.status) (where.push('status = ?'), params.push(q.status));
  if (q.cursor) {
    const [at, id] = Buffer.from(q.cursor, 'base64url').toString().split('|');
    if (at && id) (where.push('(created_at < ? OR (created_at = ? AND id < ?))'), params.push(at, at, id));
  }
  const rows = await deps.db.all<DeliveryRow>(
    `SELECT id, integration_id, funnel_id, event_name, event_id, is_test, status, attempts, http_status, error, response_json, created_at, updated_at FROM conversion_deliveries WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ...params, q.limit + 1,
  );
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return { data: page.map(serializeDelivery), nextCursor: rows.length > q.limit && last ? Buffer.from(`${last.created_at}|${last.id}`).toString('base64url') : null };
}
