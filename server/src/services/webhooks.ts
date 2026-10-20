import { createHmac, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { PermanentJobError, type Job } from '../jobs/queue.js';
import { assertPublicUrl, SsrfError } from '../net/ssrf.js';
import { newId } from '../util/ids.js';

export const WEBHOOK_EVENTS = ['funnel.optin', 'funnel.purchase', 'analytics.daily_rollup_ready'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | 'funnel.test';

export const WebhookInput = z.object({
  url: z.string().url().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).max(WEBHOOK_EVENTS.length),
  active: z.boolean().optional(),
});
export const WebhookPatch = WebhookInput.partial();

interface WebhookRow {
  id: string;
  workspace_id: string;
  url: string;
  secret: string;
  events_json: string;
  active: number;
  created_at: string;
}

interface DeliveryRow {
  id: string;
  workspace_id: string;
  webhook_id: string;
  event: string;
  payload_json: string;
  status: 'queued' | 'delivered' | 'failed' | 'dead';
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const serialize = (w: WebhookRow) => ({
  id: w.id,
  url: w.url,
  events: JSON.parse(w.events_json) as string[],
  active: w.active === 1,
  secretPreview: `whsec_…${w.secret.slice(-4)}`,
  createdAt: w.created_at,
});

const newSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** HMAC-SHA256 over `${timestamp}.${body}`; receivers recompute it and compare in constant time. */
export const signPayload = (secret: string, timestamp: string, body: string): string => createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

async function assertDeliverable(deps: Deps, url: string): Promise<void> {
  try {
    await assertPublicUrl(url, deps.lookup);
  } catch (e) {
    if (e instanceof SsrfError) throw badRequest('INVALID_WEBHOOK_URL', `Webhook URL rejected: ${e.message}`);
    throw e;
  }
}

async function requireWebhook(deps: Deps, ws: string, id: string): Promise<WebhookRow> {
  const w = await deps.db.get<WebhookRow>('SELECT * FROM webhooks WHERE workspace_id = ? AND id = ?', ws, id);
  if (!w) throw notFound('Webhook');
  return w;
}

export const listWebhooks = async (deps: Deps, ws: string) => ({ data: (await deps.db.all<WebhookRow>('SELECT * FROM webhooks WHERE workspace_id = ? ORDER BY created_at DESC, id DESC', ws)).map(serialize) });

export async function createWebhook(deps: Deps, ws: string, input: z.infer<typeof WebhookInput>) {
  await assertDeliverable(deps, input.url);
  const id = newId('whk');
  const secret = newSecret();
  await deps.db.run('INSERT INTO webhooks (id, workspace_id, url, secret, events_json, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ws, input.url, secret, JSON.stringify([...new Set(input.events)]), input.active === false ? 0 : 1, deps.now().toISOString());
  return { ...serialize(await requireWebhook(deps, ws, id)), secret };
}

export async function updateWebhook(deps: Deps, ws: string, id: string, patch: z.infer<typeof WebhookPatch>) {
  const w = await requireWebhook(deps, ws, id);
  if (patch.url !== undefined) await assertDeliverable(deps, patch.url);
  await deps.db.run(
    'UPDATE webhooks SET url = ?, events_json = ?, active = ? WHERE id = ?',
    patch.url ?? w.url, patch.events ? JSON.stringify([...new Set(patch.events)]) : w.events_json, patch.active === undefined ? w.active : patch.active ? 1 : 0, id,
  );
  return serialize(await requireWebhook(deps, ws, id));
}

export async function rotateSecret(deps: Deps, ws: string, id: string) {
  await requireWebhook(deps, ws, id);
  const secret = newSecret();
  await deps.db.run('UPDATE webhooks SET secret = ? WHERE id = ?', secret, id);
  return { ...serialize(await requireWebhook(deps, ws, id)), secret };
}

export async function deleteWebhook(deps: Deps, ws: string, id: string): Promise<void> {
  await requireWebhook(deps, ws, id);
  await deps.db.run('DELETE FROM webhooks WHERE workspace_id = ? AND id = ?', ws, id);
}

const serializeDelivery = (d: DeliveryRow) => ({
  id: d.id, webhookId: d.webhook_id, event: d.event, status: d.status, attempts: d.attempts, responseStatus: d.response_status, error: d.error, createdAt: d.created_at, updatedAt: d.updated_at,
});

export async function listDeliveries(deps: Deps, ws: string, webhookId: string, limit = 50) {
  await requireWebhook(deps, ws, webhookId);
  return { data: (await deps.db.all<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE workspace_id = ? AND webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT ?', ws, webhookId, Math.min(limit, 100))).map(serializeDelivery) };
}

async function queueDelivery(deps: Deps, w: WebhookRow, event: WebhookEvent, data: unknown): Promise<string> {
  const id = newId('dlv');
  const at = deps.now().toISOString();
  const payload = JSON.stringify({ id, event, createdAt: at, data });
  await deps.db.run('INSERT INTO webhook_deliveries (id, workspace_id, webhook_id, event, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)', id, w.workspace_id, w.id, event, payload, 'queued', at, at);
  await deps.jobs.enqueue('webhook.deliver', { deliveryId: id }, { maxAttempts: deps.config.WEBHOOK_MAX_ATTEMPTS, group: w.workspace_id });
  return id;
}

/** Records a delivery per subscribed, active webhook and queues the HTTP work. Safe to call inside a transaction. */
export async function fireWebhookEvent(deps: Deps, ws: string, event: Exclude<WebhookEvent, 'funnel.test'>, data: unknown): Promise<number> {
  const hooks = (await deps.db.all<WebhookRow>('SELECT * FROM webhooks WHERE workspace_id = ? AND active = 1 ORDER BY id', ws)).filter((w) => (JSON.parse(w.events_json) as string[]).includes(event));
  for (const w of hooks) await queueDelivery(deps, w, event, data);
  return hooks.length;
}

export async function sendTestEvent(deps: Deps, ws: string, id: string) {
  const w = await requireWebhook(deps, ws, id);
  return { deliveryId: await queueDelivery(deps, w, 'funnel.test', { message: 'This is a test event from Funnels.' }) };
}

export async function retryDelivery(deps: Deps, ws: string, deliveryId: string) {
  const d = await deps.db.get<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE workspace_id = ? AND id = ?', ws, deliveryId);
  if (!d) throw notFound('Delivery');
  await deps.db.run(`UPDATE webhook_deliveries SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?`, deps.now().toISOString(), deliveryId);
  await deps.jobs.enqueue('webhook.deliver', { deliveryId }, { maxAttempts: deps.config.WEBHOOK_MAX_ATTEMPTS, group: ws });
  return { ok: true };
}

/** Job handler for `webhook.deliver`. Throws to trigger the queue's exponential backoff; PermanentJobError dead-letters at once. */
export async function deliverWebhook(deps: Deps, payload: { deliveryId: string }, job: Job): Promise<void> {
  const d = await deps.db.get<DeliveryRow>('SELECT * FROM webhook_deliveries WHERE id = ?', payload.deliveryId);
  if (!d) return;
  const w = await deps.db.get<WebhookRow>('SELECT * FROM webhooks WHERE id = ?', d.webhook_id);
  const at = () => deps.now().toISOString();
  const finish = (status: DeliveryRow['status'], error: string | null, responseStatus: number | null) =>
    deps.db.run('UPDATE webhook_deliveries SET status = ?, attempts = ?, error = ?, response_status = ?, updated_at = ? WHERE id = ?', status, job.attempts, error, responseStatus, at(), d.id);

  if (!w || w.active !== 1) {
    await finish('dead', 'webhook disabled or removed', null);
    throw new PermanentJobError('webhook disabled');
  }
  let target;
  try {
    target = await assertPublicUrl(w.url, deps.lookup);
  } catch (e) {
    if (e instanceof SsrfError) {
      await finish('dead', `blocked: ${e.message}`, null);
      throw new PermanentJobError(e.message);
    }
    await finish(job.attempts >= job.maxAttempts ? 'dead' : 'failed', 'dns resolution failed', null);
    throw e;
  }
  const timestamp = String(Math.floor(deps.now().getTime() / 1000));
  const body = d.payload_json;
  try {
    const res = await deps.http.post({
      target,
      timeoutMs: 10_000,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Funnels-Webhooks/1.0',
        'x-funnels-event': d.event,
        'x-funnels-delivery': d.id,
        'x-funnels-timestamp': timestamp,
        'x-funnels-signature': `sha256=${signPayload(w.secret, timestamp, body)}`,
        // The analytics contract's signature: HMAC-SHA-256 of the body alone (no timestamp), for consumers that only verify the body.
        'x-signature': `sha256=${createHmac('sha256', w.secret).update(body).digest('hex')}`,
      },
    });
    if (res.status >= 200 && res.status < 300) {
      await finish('delivered', null, res.status);
      return;
    }
    // 3xx is treated as a failure on purpose: redirects are never followed.
    await finish(job.attempts >= job.maxAttempts ? 'dead' : 'failed', `HTTP ${res.status}`, res.status);
    throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    if (!/^HTTP \d+$/.test((e as Error).message)) await finish(job.attempts >= job.maxAttempts ? 'dead' : 'failed', (e as Error).message.slice(0, 200), null);
    throw e;
  }
}
