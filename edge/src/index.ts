/**
 * Cloudflare Worker in front of the Funnels origin.
 *
 *  - Page requests (GET/HEAD): cache lookup (Cache API, key = the public URL without query, so the origin can purge by URL),
 *    stale-while-revalidate against a SIGNED origin endpoint, ETag/checksum revalidation, stale-if-error, friendly error page.
 *  - /api/public/* and /beacon.js: forwarded to the origin with the real client IP and a shared secret header.
 *  - Visitor, funnel, step and UTM cookies are set per request (never cached with the HTML).
 *
 * Every call to the origin's /internal/edge/resolve is HMAC-signed. Without EDGE_SHARED_SECRET the worker refuses to serve (fail closed).
 */

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

import { edgeLimit, RateLimiterDO, type RateEnv } from './ratelimit.js';

export { RateLimiterDO };

export interface Env extends RateEnv {
  ORIGIN_URL: string;
  EDGE_SHARED_SECRET?: string;
  CF_ORIGIN_SECRET?: string;
  CACHE_TTL_SECONDS?: string;
  STALE_SECONDS?: string;
  ROUTES?: KVLike;
}

export interface CacheLike {
  match(req: Request): Promise<Response | undefined>;
  put(req: Request, res: Response): Promise<void>;
}

export interface Runtime {
  cache: CacheLike;
  fetch: typeof fetch;
  now: () => number;
  randomHex: (bytes: number) => string;
}

export interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const enc = new TextEncoder();

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Must match server/src/edge/signing.ts: `${ts}.${nonce}.${METHOD}.${pathAndQuery}`. */
export async function signedHeaders(secret: string, method: string, pathAndQuery: string, rt: Runtime): Promise<Record<string, string>> {
  const ts = String(Math.floor(rt.now() / 1000));
  const nonce = rt.randomHex(12);
  return { 'x-edge-timestamp': ts, 'x-edge-nonce': nonce, 'x-edge-signature': await hmacHex(secret, `${ts}.${nonce}.${method.toUpperCase()}.${pathAndQuery}`) };
}

interface Resolved {
  kind: 'page' | 'redirect' | 'missing';
  status?: number;
  html?: string;
  checksum?: string;
  funnelId?: string;
  stepId?: string;
  location?: string;
  notModified?: boolean;
}

const PROXIED = /^\/(api\/public\/|beacon\.js$)/;

export const errorPage = (status: number, title: string, message: string): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1f2937;background:#f9fafb}main{text-align:center;padding:24px}h1{font-size:1.5rem}p{color:#6b7280}</style></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': status === 503 ? '30' : '0' } },
  );

const clean = (v: string | null) => (v ? v.replace(/[\u0000-\u001f\u007f;,\s]/g, '').slice(0, 100) : '');

function cookieHeaders(request: Request, funnelId: string, stepId: string, rt: Runtime): string[] {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  const base = `; Path=/; SameSite=Lax${secure}`;
  const out: string[] = [];
  if (!/(?:^|; )visitor_id=/.test(request.headers.get('cookie') ?? '')) out.push(`visitor_id=${rt.randomHex(12)}${base}`);
  out.push(`funnel_id=${funnelId}${base}`, `step_id=${stepId}${base}`);
  const url = new URL(request.url);
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = clean(url.searchParams.get(`utm_${k}`));
    if (v) out.push(`utm_${k}=${encodeURIComponent(v)}${base}`);
  }
  return out;
}

function pageResponse(request: Request, html: string, status: number, checksum: string, funnelId: string, stepId: string, rt: Runtime, extra: Record<string, string> = {}): Response {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', etag: `"${checksum}"`, 'cache-control': 'public, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff', ...extra });
  for (const c of cookieHeaders(request, funnelId, stepId, rt)) headers.append('set-cookie', c);
  if (status === 200 && request.headers.get('if-none-match') === `"${checksum}"`) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : html, { status, headers });
}

const cacheKey = (request: Request): Request => {
  const u = new URL(request.url);
  return new Request(`${u.protocol}//${u.host}${u.pathname}`, { method: 'GET' });
};

async function callOrigin(env: Env, request: Request, checksum: string | null, rt: Runtime): Promise<Resolved> {
  const u = new URL(request.url);
  const pq = `/internal/edge/resolve?${new URLSearchParams({ host: u.host.toLowerCase(), path: u.pathname, search: u.search })}`;
  const headers = await signedHeaders(env.EDGE_SHARED_SECRET!, 'GET', pq, rt);
  if (checksum) headers['x-edge-checksum'] = checksum;
  const res = await rt.fetch(new URL(pq, env.ORIGIN_URL).toString(), { headers });
  if (!res.ok) throw new Error(`origin responded ${res.status}`);
  return (await res.json()) as Resolved;
}

async function storeCached(request: Request, r: Resolved, rt: Runtime): Promise<void> {
  const res = new Response(r.html ?? '', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=86400', 'x-edge-fetched': String(rt.now()), 'x-edge-checksum': r.checksum!, 'x-edge-status': String(r.status ?? 200), 'x-edge-funnel': r.funnelId!, 'x-edge-step': r.stepId! },
  });
  await rt.cache.put(cacheKey(request), res);
}

async function revalidate(env: Env, request: Request, cached: Response, rt: Runtime): Promise<void> {
  const r = await callOrigin(env, request, cached.headers.get('x-edge-checksum'), rt);
  if (r.kind === 'page' && r.notModified) {
    const html = await cached.clone().text();
    await storeCached(request, { ...r, html, status: Number(cached.headers.get('x-edge-status')), funnelId: cached.headers.get('x-edge-funnel')!, stepId: cached.headers.get('x-edge-step')! }, rt);
  } else if (r.kind === 'page') await storeCached(request, r, rt);
}

async function proxyToOrigin(env: Env, request: Request, rt: Runtime): Promise<Response> {
  const u = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set('x-forwarded-host', u.host);
  const ip = request.headers.get('cf-connecting-ip');
  if (ip && env.CF_ORIGIN_SECRET) {
    headers.set('cf-connecting-ip', ip);
    headers.set('x-cf-origin-secret', env.CF_ORIGIN_SECRET);
  } else {
    headers.delete('cf-connecting-ip'); // never forward an IP claim the origin cannot verify
    headers.delete('x-cf-origin-secret');
  }
  headers.delete('host');
  return rt.fetch(new URL(u.pathname + u.search, env.ORIGIN_URL).toString(), { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body, redirect: 'manual' });
}

export async function handle(request: Request, env: Env, ctx: Ctx, rt: Runtime): Promise<Response> {
  if (!env.EDGE_SHARED_SECRET) return errorPage(503, 'Service unavailable', 'This site is not configured correctly.');
  const url = new URL(request.url);
  if (PROXIED.test(url.pathname)) {
    const limited = await edgeLimit(env, request, request.headers.get('cf-connecting-ip') ?? 'unknown');
    if (limited) return limited;
    try {
      return await proxyToOrigin(env, request, rt);
    } catch {
      return url.pathname.startsWith('/api/') ? new Response(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'Try again shortly' } }), { status: 503, headers: { 'content-type': 'application/json' } }) : errorPage(503, 'Service unavailable', 'Please try again in a moment.');
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return errorPage(405, 'Method not allowed', 'This page only accepts GET requests.');

  const ttl = Number(env.CACHE_TTL_SECONDS ?? 60) * 1000;
  const staleMax = Number(env.STALE_SECONDS ?? 86400) * 1000;
  const key = cacheKey(request);
  const cached = await rt.cache.match(key);
  const age = cached ? rt.now() - Number(cached.headers.get('x-edge-fetched') ?? 0) : Infinity;
  const fromCache = (c: Response, extra: Record<string, string> = {}) =>
    c.clone().text().then((html) => pageResponse(request, html, Number(c.headers.get('x-edge-status')), c.headers.get('x-edge-checksum')!, c.headers.get('x-edge-funnel')!, c.headers.get('x-edge-step')!, rt, extra));

  if (cached && age < ttl) return fromCache(cached, { 'x-edge-cache': 'hit' });
  if (cached && age < staleMax) {
    ctx.waitUntil(revalidate(env, request, cached, rt).catch(() => undefined));
    return fromCache(cached, { 'x-edge-cache': 'stale' });
  }

  const routeKey = `r:${url.host.toLowerCase()}${url.pathname}`;
  if (env.ROUTES && !cached) {
    const hit = await env.ROUTES.get(routeKey).catch(() => null);
    if (hit) {
      const r = JSON.parse(hit) as Resolved;
      return r.kind === 'redirect' ? new Response(null, { status: 301, headers: { location: r.location! } }) : errorPage(404, 'Page not found', 'The page you are looking for does not exist.');
    }
  }
  try {
    const r = await callOrigin(env, request, cached?.headers.get('x-edge-checksum') ?? null, rt);
    if (r.kind === 'redirect') {
      if (env.ROUTES) ctx.waitUntil(env.ROUTES.put(routeKey, JSON.stringify(r), { expirationTtl: 60 }).catch(() => undefined));
      return new Response(null, { status: 301, headers: { location: r.location! } });
    }
    if (r.kind === 'missing') {
      if (env.ROUTES) ctx.waitUntil(env.ROUTES.put(routeKey, JSON.stringify(r), { expirationTtl: 60 }).catch(() => undefined));
      return errorPage(404, 'Page not found', 'The page you are looking for does not exist.');
    }
    if (r.notModified && cached) {
      ctx.waitUntil(revalidate(env, request, cached, rt).catch(() => undefined));
      return fromCache(cached, { 'x-edge-cache': 'revalidated' });
    }
    ctx.waitUntil(storeCached(request, r, rt));
    return pageResponse(request, r.html!, r.status ?? 200, r.checksum!, r.funnelId!, r.stepId!, rt, { 'x-edge-cache': 'miss' });
  } catch {
    // Origin down or misbehaving: serve whatever we have, however old, before showing an error.
    if (cached) return fromCache(cached, { 'x-edge-cache': 'stale-if-error' });
    return errorPage(503, 'We will be right back', 'This page is temporarily unavailable. Please try again in a moment.');
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const cache = (caches as unknown as { default: CacheLike }).default;
    return handle(request, env, ctx, {
      cache,
      fetch,
      now: () => Date.now(),
      randomHex: (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join(''),
    });
  },
};
