import { isSuspended } from './suspension.js';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { denyError } from '../ratelimit/response.js';
import { newId } from '../util/ids.js';
import { sanitizeUtms } from './publicblocks.js';
import type { EventRow } from './eventbuffer.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * Public beacon payload. Only page views and opt-ins can be reported by a browser; orders are created
 * exclusively by the server-side checkout so a visitor can never forge revenue.
 */
export const PublicEventInput = z.object({
  funnelId: id,
  stepId: id,
  type: z.enum(['page_view', 'optin']),
  visitorId: id.optional(),
  unique: z.boolean().optional(),
  url: z.string().max(500).optional(),
  utms: z.unknown().optional(),
  externalId: z.string().regex(/^[A-Za-z0-9_.:-]{1,100}$/).optional(),
  /** Host of document.referrer (never the full URL). */
  referrer: z.string().max(253).regex(/^[A-Za-z0-9.-]+$/).optional(),
  preview: z.boolean().optional(),
});

export const BOT_UA = /bot\b|crawler|spider|crawl|slurp|headless|lighthouse|pingdom|uptimerobot|curl\/|wget\/|python-requests|go-http-client|httpclient|facebookexternalhit|preview|monitor/i;

/** Coarse device class from the User-Agent. 'unknown' only when there is no usable header. */
export function deviceOf(ua: string | undefined): 'desktop' | 'mobile' | 'tablet' | 'unknown' {
  if (!ua) return 'unknown';
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone|blackberry/i.test(ua)) return 'mobile';
  return 'desktop';
}

export const isBot = (ua: string | undefined): boolean => !ua || ua.length < 8 || BOT_UA.test(ua);

export interface EventResult {
  ok: true;
  recorded: boolean;
  reason?: 'bot' | 'unknown_funnel' | 'duplicate' | 'preview' | 'no_visitor' | 'suspended';
}

/**
 * `opts` is for events that were accepted earlier at the edge queue: `eventId` and `at` come from the edge, so a redelivered queue message is the same
 * row (same id and created_at) and the primary key drops it. `at` is trusted only within the last 48 hours and never in the future.
 */
export async function recordPublicEvent(deps: Deps, input: z.infer<typeof PublicEventInput>, userAgent: string | undefined, opts: { eventId?: string; at?: number; country?: string | null } = {}): Promise<EventResult> {
  if (isBot(userAgent)) return { ok: true, recorded: false, reason: 'bot' };
  if (input.preview) return { ok: true, recorded: false, reason: 'preview' };
  // The workspace is always derived from the funnel; unknown, trashed or mismatched ids are silently ignored.
  let workspaceId = deps.eventRefs.get(input.funnelId, input.stepId);
  if (!workspaceId) {
    const funnel = await deps.db.get<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM funnels WHERE id = ? AND deleted_at IS NULL', input.funnelId);
    const step = funnel ? await deps.db.get<{ id: string }>('SELECT id FROM steps WHERE id = ? AND funnel_id = ?', input.stepId, input.funnelId) : undefined;
    if (!funnel || !step) return { ok: true, recorded: false, reason: 'unknown_funnel' };
    workspaceId = funnel.workspace_id;
    deps.eventRefs.set(input.funnelId, input.stepId, workspaceId);
  }
  if (await isSuspended(deps, workspaceId)) return { ok: true, recorded: false, reason: 'suspended' };
  // Per-workspace admission: one tenant's flood is refused here (429 + Retry-After) before it can fill the queue or the buffer, and costs nobody else anything.
  const admit = await deps.limiter.check('ingest.workspace', { ip: 'workspace', workspaceId });
  if (!admit.allowed) throw denyError(admit);
  const funnel = { id: input.funnelId, workspace_id: workspaceId };
  const step = { id: input.stepId };

  const nowMs = deps.now().getTime();
  const at = new Date(opts.at !== undefined && opts.at <= nowMs && opts.at > nowMs - 48 * 3_600_000 ? opts.at : nowMs).toISOString();
  const utm = JSON.stringify(sanitizeUtms(input.utms));
  const row = (type: 'page_view' | 'optin', unique: number, external: string | null): EventRow => ({
    id: opts.eventId ? `evt_${opts.eventId}${type === 'optin' ? '_o' : ''}` : newId('evt'), workspace_id: funnel.workspace_id, funnel_id: funnel.id, step_id: step.id, type, visitor_id: input.visitorId ?? null,
    unique_visit: unique, lead_id: null, order_id: null, external_id: external, amount_cents: 0, currency: null, utm_json: utm, url: input.url ?? null, created_at: at,
    device: deviceOf(userAgent), country: opts.country ?? null, referrer_host: input.referrer ? input.referrer.toLowerCase() : null,
  });
  if (input.type === 'page_view') {
    if (!input.visitorId) return { ok: true, recorded: false, reason: 'no_visitor' };
    // "Unique" is decided by the server when the batch is written (visitor_steps), never by the client's claim.
    await deps.events.add(row('page_view', 0, null));
    return { ok: true, recorded: true };
  }
  const external = input.externalId ? `ext:${input.externalId}` : null;
  if (external) {
    const stored = await deps.db.get('SELECT 1 FROM event_dedupe WHERE funnel_id = ? AND type = ? AND external_id = ?', funnel.id, 'optin', external);
    if (stored !== undefined || deps.events.hasQueuedExternal(funnel.id, external)) return { ok: true, recorded: false, reason: 'duplicate' };
  }
  await deps.events.add(row('optin', 0, external));
  return { ok: true, recorded: true };
}
