import { z } from 'zod';
import { fbcFromClick, flat, mergeTouch, sanitizeBrowserIds, sanitizeTouch, type BrowserIds, type Touch, type TouchPair } from '../ads/touch.js';
import { inTx } from '../db/scope.js';
import type { Deps } from '../deps.js';
import { denyError } from '../ratelimit/response.js';
import { isBot } from './events.js';
import { isSuspended } from './suspension.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/**
 * What the beacon reports once per page load that carries a new touch (UTM parameters, a click id, an external referrer) or when the visitor makes a consent choice.
 * Everything is validated and length-capped by ads/touch.ts; nothing is trusted. The workspace is always derived from the funnel.
 */
export const AttributionInput = z.object({
  funnelId: id,
  stepId: id,
  visitorId: id,
  touch: z.unknown().optional(),
  ids: z.unknown().optional(),
  preview: z.boolean().optional(),
});

interface Row {
  workspace_id: string;
  visitor_id: string;
  first_json: string | null;
  last_json: string | null;
  fbp: string | null;
  fbc: string | null;
  ip: string | null;
  user_agent: string | null;
  ids_json: string | null;
  first_funnel_id: string | null;
  last_funnel_id: string | null;
}

const parseTouch = (json: string | null): Touch | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as Touch;
  } catch {
    return null;
  }
};

export interface Snapshot {
  first: Touch | null;
  last: Touch | null;
  ids: BrowserIds;
  ip: string | null;
  userAgent: string | null;
}

export async function recordAttribution(
  deps: Deps,
  input: z.infer<typeof AttributionInput>,
  client: { ip: string | null; userAgent: string | undefined; host?: string },
): Promise<{ ok: true; recorded: boolean; reason?: string }> {
  if (input.preview) return { ok: true, recorded: false, reason: 'preview' };
  if (isBot(client.userAgent)) return { ok: true, recorded: false, reason: 'bot' };
  let ws = deps.eventRefs.get(input.funnelId, input.stepId);
  if (!ws) {
    const f = await deps.db.get<{ workspace_id: string }>('SELECT workspace_id FROM funnels WHERE id = ? AND deleted_at IS NULL', input.funnelId);
    const s = f ? await deps.db.get('SELECT 1 FROM steps WHERE id = ? AND funnel_id = ?', input.stepId, input.funnelId) : undefined;
    if (!f || !s) return { ok: true, recorded: false, reason: 'unknown_funnel' };
    ws = f.workspace_id;
    deps.eventRefs.set(input.funnelId, input.stepId, ws);
  }
  if (await isSuspended(deps, ws)) return { ok: true, recorded: false, reason: 'suspended' };
  const admit = await deps.limiter.check('ingest.workspace', { ip: 'workspace', workspaceId: ws });
  if (!admit.allowed) throw denyError(admit);

  const at = deps.now();
  const touch = sanitizeTouch(input.touch, at, client.host);
  const ids = sanitizeBrowserIds(input.ids);
  const click = touch?.clickIds?.fbclid;
  if (click && !ids.fbc && /^[A-Za-z0-9_-]{4,400}$/.test(click)) ids.fbc = fbcFromClick(click, at.getTime());

  await inTx(deps, async (d) => {
    const iso = at.toISOString();
    await d.db.run(
      `INSERT INTO visitor_attribution (workspace_id, visitor_id, created_at, updated_at) VALUES (?, ?, ?, ?)${d.db.dialect.onConflictDoNothing(['workspace_id', 'visitor_id'])}`,
      ws, input.visitorId, iso, iso,
    );
    const row = (await d.db.get<Row>(`SELECT * FROM visitor_attribution WHERE workspace_id = ? AND visitor_id = ?${d.db.dialect.forUpdate()}`, ws, input.visitorId))!;
    const prev: TouchPair = { first: parseTouch(row.first_json), last: parseTouch(row.last_json) };
    const merged = mergeTouch(prev, touch);
    const prevIds = row.ids_json ? (JSON.parse(row.ids_json) as BrowserIds) : {};
    const nextIds: BrowserIds = { ...prevIds, ...ids };
    await d.db.run(
      `UPDATE visitor_attribution SET
         first_source = ?, first_medium = ?, first_campaign = ?, first_content = ?, first_term = ?, first_funnel_id = ?, first_at = ?, first_json = ?,
         last_source = ?, last_medium = ?, last_campaign = ?, last_content = ?, last_term = ?, last_funnel_id = ?, last_at = ?, last_json = ?,
         fbp = ?, fbc = ?, ip = ?, user_agent = ?, ids_json = ?, updated_at = ? WHERE workspace_id = ? AND visitor_id = ?`,
      merged.first?.source ?? null, merged.first?.medium ?? null, merged.first?.campaign ?? null, merged.first?.content ?? null, merged.first?.term ?? null,
      merged.first === prev.first ? row.first_funnel_id : input.funnelId, merged.first?.at ?? null, merged.first ? JSON.stringify(merged.first) : null,
      merged.last?.source ?? null, merged.last?.medium ?? null, merged.last?.campaign ?? null, merged.last?.content ?? null, merged.last?.term ?? null,
      merged.last === prev.last ? row.last_funnel_id : input.funnelId, merged.last?.at ?? null, merged.last ? JSON.stringify(merged.last) : null,
      ids.fbp ?? row.fbp, ids.fbc ?? row.fbc, client.ip ?? row.ip, client.userAgent?.slice(0, 512) ?? row.user_agent, JSON.stringify(nextIds), iso, ws, input.visitorId,
    );
  });
  return { ok: true, recorded: true };
}

/** What is known about a visitor, for the lead or order being recorded. Null when the visitor was never seen by the attribution endpoint. */
export async function snapshotFor(deps: Pick<Deps, 'db'>, ws: string, visitorId: string | null | undefined): Promise<Snapshot | null> {
  if (!visitorId) return null;
  const row = await deps.db.get<Row & { fbp: string | null }>('SELECT * FROM visitor_attribution WHERE workspace_id = ? AND visitor_id = ?', ws, visitorId);
  if (!row) return null;
  const ids: BrowserIds = row.ids_json ? (JSON.parse(row.ids_json) as BrowserIds) : {};
  if (row.fbp) ids.fbp = row.fbp;
  if (row.fbc) ids.fbc = row.fbc;
  return { first: parseTouch(row.first_json), last: parseTouch(row.last_json), ids, ip: row.ip, userAgent: row.user_agent };
}

/** Column values for the `first_*`, `last_*` and `attribution_json` columns of leads and orders. */
export function attributionColumns(s: Snapshot | null): Record<string, string | null> {
  return { ...flat(s?.first ?? null, 'first'), ...flat(s?.last ?? null, 'last'), attribution_json: s && (s.first || s.last) ? JSON.stringify({ first: s.first, last: s.last }) : null };
}

/** Writes a snapshot onto an order (at creation, once) — the lead keeps its first touch and takes the newest last touch. */
export async function stampOrder(deps: Pick<Deps, 'db'>, ws: string, orderId: string, s: Snapshot | null): Promise<void> {
  if (!s || (!s.first && !s.last)) return;
  const c = attributionColumns(s);
  await deps.db.run(
    `UPDATE orders SET first_source = ?, first_medium = ?, first_campaign = ?, first_content = ?, first_term = ?, last_source = ?, last_medium = ?, last_campaign = ?, last_content = ?, last_term = ?, attribution_json = ? WHERE workspace_id = ? AND id = ?`,
    c.first_source, c.first_medium, c.first_campaign, c.first_content, c.first_term, c.last_source, c.last_medium, c.last_campaign, c.last_content, c.last_term, c.attribution_json, ws, orderId,
  );
}

export async function stampLead(deps: Pick<Deps, 'db'>, ws: string, leadId: string, s: Snapshot | null): Promise<void> {
  if (!s || (!s.first && !s.last)) return;
  const c = attributionColumns(s);
  // The first touch is written once (while the lead has none); the last touch replaces the previous one as a whole, never field by field, so a lead never mixes two touches.
  if (s.first) {
    await deps.db.run(
      `UPDATE leads SET first_source = ?, first_medium = ?, first_campaign = ?, first_content = ?, first_term = ? WHERE workspace_id = ? AND id = ? AND first_source IS NULL AND first_medium IS NULL AND first_campaign IS NULL AND first_content IS NULL AND first_term IS NULL`,
      c.first_source, c.first_medium, c.first_campaign, c.first_content, c.first_term, ws, leadId,
    );
  }
  if (s.last) {
    await deps.db.run(
      `UPDATE leads SET last_source = ?, last_medium = ?, last_campaign = ?, last_content = ?, last_term = ?, attribution_json = ? WHERE workspace_id = ? AND id = ?`,
      c.last_source, c.last_medium, c.last_campaign, c.last_content, c.last_term, c.attribution_json, ws, leadId,
    );
  }
}

/** Removes IP addresses and user agents (personal data kept only for server-side conversions) from visitors not seen for `days`. */
export async function pruneAttributionPii(deps: Pick<Deps, 'db' | 'now'>, days: number): Promise<number> {
  const cutoff = new Date(deps.now().getTime() - days * 86_400_000).toISOString();
  return (await deps.db.run('UPDATE visitor_attribution SET ip = NULL, user_agent = NULL, fbp = NULL WHERE updated_at < ? AND (ip IS NOT NULL OR user_agent IS NOT NULL OR fbp IS NOT NULL)', cutoff)).changes;
}
