import { Hono } from 'hono';
import type { Deps } from '../deps.js';
import { NonceCache, verifyEdge } from '../edge/signing.js';
import type { PageRow } from '../repos/types.js';
import { PublicEventInput, recordPublicEvent } from '../services/events.js';
import { resolveLive } from './serve.js';

/**
 * Internal endpoint for the Cloudflare edge worker: GET /internal/edge/resolve?host=&path=&search=
 * Every request carries an HMAC (x-edge-signature) over timestamp, nonce, method and path+query.
 * Without EDGE_SHARED_SECRET the endpoint refuses everything (fail closed).
 */
export function edgeRoutes(deps: Deps): Hono {
  const r = new Hono();
  const nonces = new NonceCache(deps.config.EDGE_SKEW_SECONDS * 2000);
  r.get('/internal/edge/resolve', async (c) => {
    const url = new URL(c.req.url);
    const auth = verifyEdge(
      { secret: deps.config.EDGE_SHARED_SECRET, skewSeconds: deps.config.EDGE_SKEW_SECONDS, nonces, now: deps.now().getTime() },
      { method: c.req.method, pathAndQuery: url.pathname + url.search, headers: c.req.raw.headers },
    );
    if (!auth.ok) return c.json({ error: { code: auth.status === 503 ? 'EDGE_DISABLED' : 'EDGE_UNAUTHORIZED', message: auth.reason } }, auth.status);
    const host = (url.searchParams.get('host') ?? '').toLowerCase();
    const path = url.searchParams.get('path') ?? '/';
    const res = await resolveLive(deps, host, path, url.searchParams.get('search') ?? '');
    if (res.kind === 'redirect') return c.json({ kind: 'redirect', status: 301, location: res.location });
    if (res.kind !== 'page') return c.json({ kind: 'missing', status: 404 });
    const page = await deps.db.get<PageRow>('SELECT html, checksum FROM step_pages WHERE step_id = ?', res.step.id);
    if (!page) return c.json({ kind: 'missing', status: 404 });
    const base = { kind: 'page', status: res.status, funnelId: res.step.funnel_id, stepId: res.step.id, checksum: page.checksum };
    return c.json(c.req.header('x-edge-checksum') === page.checksum ? { ...base, notModified: true } : { ...base, html: page.html });
  });
  // POST /internal/edge/events: the queue consumer in the worker forwards batches of beacons that the edge already answered 202 for.
  r.post('/internal/edge/events', async (c) => {
    const url = new URL(c.req.url);
    const auth = verifyEdge(
      { secret: deps.config.EDGE_SHARED_SECRET, skewSeconds: deps.config.EDGE_SKEW_SECONDS, nonces, now: deps.now().getTime() },
      { method: c.req.method, pathAndQuery: url.pathname + url.search, headers: c.req.raw.headers },
    );
    if (!auth.ok) return c.json({ error: { code: auth.status === 503 ? 'EDGE_DISABLED' : 'EDGE_UNAUTHORIZED', message: auth.reason } }, auth.status);
    const text = await c.req.text();
    if (text.length > 2_000_000) return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Batch too large' } }, 413);
    let list: unknown;
    try {
      list = (JSON.parse(text) as { events?: unknown }).events;
    } catch {
      return c.json({ error: { code: 'INVALID_JSON', message: 'Body must be JSON' } }, 400);
    }
    if (!Array.isArray(list) || list.length > 500) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'events must be an array of at most 500' } }, 400);
    let accepted = 0;
    let rejected = 0;
    for (const e of list as { id?: unknown; at?: unknown; ua?: unknown; body?: unknown }[]) {
      const parsed = PublicEventInput.safeParse(e?.body);
      if (!parsed.success || typeof e.id !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(e.id)) {
        rejected++;
        continue;
      }
      // An INGEST_BACKPRESSURE error propagates: the whole batch is answered 503 and retried by the queue (already-published events dedupe on id and time).
      const res = await recordPublicEvent(deps, parsed.data, typeof e.ua === 'string' ? e.ua : undefined, { eventId: e.id, at: typeof e.at === 'number' ? e.at : undefined });
      if (res.recorded) accepted++;
      else rejected++;
    }
    return c.json({ accepted, rejected });
  });
  return r;
}
