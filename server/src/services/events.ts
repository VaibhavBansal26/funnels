import { z } from 'zod';
import type { Deps } from '../deps.js';
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
  preview: z.boolean().optional(),
});

export const BOT_UA = /bot\b|crawler|spider|crawl|slurp|headless|lighthouse|pingdom|uptimerobot|curl\/|wget\/|python-requests|go-http-client|httpclient|facebookexternalhit|preview|monitor/i;

export const isBot = (ua: string | undefined): boolean => !ua || ua.length < 8 || BOT_UA.test(ua);

export interface EventResult {
  ok: true;
  recorded: boolean;
  reason?: 'bot' | 'unknown_funnel' | 'duplicate' | 'preview' | 'no_visitor';
}

/**
 * `opts` is for events that were accepted earlier at the edge queue: `eventId` and `at` come from the edge, so a redelivered queue message is the same
 * row (same id and created_at) and the primary key drops it. `at` is trusted only within the last 48 hours and never in the future.
 */
export async function recordPublicEvent(deps: Deps, input: z.infer<typeof PublicEventInput>, userAgent: string | undefined, opts: { eventId?: string; at?: number } = {}): Promise<EventResult> {
  if (isBot(userAgent)) return { ok: true, recorded: false, reason: 'bot' };
  if (input.preview) return { ok: true, recorded: false, reason: 'preview' };
  // The workspace is always derived from the funnel; unknown, trashed or mismatched ids are silently ignored.
  const funnel = await deps.db.get<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM funnels WHERE id = ? AND deleted_at IS NULL', input.funnelId);
  const step = funnel ? await deps.db.get<{ id: string }>('SELECT id FROM steps WHERE id = ? AND funnel_id = ?', input.stepId, input.funnelId) : undefined;
  if (!funnel || !step) return { ok: true, recorded: false, reason: 'unknown_funnel' };

  const nowMs = deps.now().getTime();
  const at = new Date(opts.at !== undefined && opts.at <= nowMs && opts.at > nowMs - 48 * 3_600_000 ? opts.at : nowMs).toISOString();
  const utm = JSON.stringify(sanitizeUtms(input.utms));
  const row = (type: 'page_view' | 'optin', unique: number, external: string | null): EventRow => ({
    id: opts.eventId ? `evt_${opts.eventId}${type === 'optin' ? '_o' : ''}` : newId('evt'), workspace_id: funnel.workspace_id, funnel_id: funnel.id, step_id: step.id, type, visitor_id: input.visitorId ?? null,
    unique_visit: unique, lead_id: null, order_id: null, external_id: external, amount_cents: 0, currency: null, utm_json: utm, url: input.url ?? null, created_at: at,
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
