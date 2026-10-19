import { Hono } from 'hono';
import type { Deps } from '../deps.js';
import { NonceCache, verifyEdge } from '../edge/signing.js';
import type { PageRow } from '../repos/types.js';
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
  return r;
}
