import { z } from 'zod';
import type { Deps } from '../deps.js';
import { newId } from '../util/ids.js';
import { sanitizeUtms } from './publicblocks.js';

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

export function recordPublicEvent(deps: Deps, input: z.infer<typeof PublicEventInput>, userAgent: string | undefined): EventResult {
  if (isBot(userAgent)) return { ok: true, recorded: false, reason: 'bot' };
  if (input.preview) return { ok: true, recorded: false, reason: 'preview' };
  // The workspace is always derived from the funnel; unknown, trashed or mismatched ids are silently ignored.
  const funnel = deps.db.get<{ id: string; workspace_id: string }>('SELECT id, workspace_id FROM funnels WHERE id = ? AND deleted_at IS NULL', input.funnelId);
  const step = funnel ? deps.db.get<{ id: string }>('SELECT id FROM steps WHERE id = ? AND funnel_id = ?', input.stepId, input.funnelId) : undefined;
  if (!funnel || !step) return { ok: true, recorded: false, reason: 'unknown_funnel' };

  const at = deps.now().toISOString();
  const utm = JSON.stringify(sanitizeUtms(input.utms));
  if (input.type === 'page_view') {
    if (!input.visitorId) return { ok: true, recorded: false, reason: 'no_visitor' };
    // "Unique" is decided by the server from history, not by the client's claim.
    const seen = deps.db.get('SELECT 1 FROM events WHERE funnel_id = ? AND step_id = ? AND type = ? AND visitor_id = ? LIMIT 1', funnel.id, step.id, 'page_view', input.visitorId);
    deps.db.run(
      `INSERT INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, utm_json, url, created_at) VALUES (?, ?, ?, ?, 'page_view', ?, ?, ?, ?, ?)`,
      newId('evt'), funnel.workspace_id, funnel.id, step.id, input.visitorId, seen ? 0 : 1, utm, input.url ?? null, at,
    );
    return { ok: true, recorded: true };
  }
  try {
    deps.db.run(
      `INSERT INTO events (id, workspace_id, funnel_id, step_id, type, visitor_id, unique_visit, external_id, utm_json, url, created_at) VALUES (?, ?, ?, ?, 'optin', ?, 0, ?, ?, ?, ?)`,
      newId('evt'), funnel.workspace_id, funnel.id, step.id, input.visitorId ?? null, input.externalId ? `ext:${input.externalId}` : null, utm, input.url ?? null, at,
    );
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message)) return { ok: true, recorded: false, reason: 'duplicate' };
    throw e;
  }
  return { ok: true, recorded: true };
}
