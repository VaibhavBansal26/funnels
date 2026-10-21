import { isSuspended } from '../services/suspension.js';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { setCookie } from 'hono/cookie';
import { verifyPreviewToken } from '../auth/tokens.js';
import { esc } from '../blocks/index.js';
import type { Deps } from '../deps.js';
import { clientIp } from '../ratelimit/ip.js';
import { denyError } from '../ratelimit/response.js';
import { sanitizeUtms } from '../services/publicblocks.js';
import { listSteps } from '../repos/funnels.js';
import type { DomainRow, FunnelRow, PageRow, StepRow } from '../repos/types.js';
import { pathKey } from '../services/paths.js';
import { renderStep } from '../services/pages.js';
import { adTagsForStep } from '../services/adtags.js';
import { loadDoc } from '../pagemodel/doc.js';

export function messagePage(status: number, title: string, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;color:#1f2937;background:#f9fafb}main{text-align:center;padding:24px}h1{font-size:1.6rem;margin:0 0 8px}p{color:#6b7280;margin:0}</style></head><body><main><h1>${esc(title)}</h1><p>${esc(message)}</p></main></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

const hostOf = (c: Context, trustProxy: boolean): string => {
  const raw = (trustProxy ? c.req.header('x-forwarded-host') : undefined) ?? c.req.header('host') ?? '';
  return raw.split(',')[0]!.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
};

// Paths that stay reachable on customer domains because published pages call them.
const PASSTHROUGH = /^\/(api\/public\/|uploads\/|beacon\.js$|healthz$|readyz$)/;

/** Cache miss path, coalesced: a burst of requests for one page costs one database read per process (one per cluster with Redis). */
async function pageFor(deps: Deps, step: StepRow): Promise<{ html: string; checksum: string } | null> {
  const cached = deps.pageCache.get(step.id);
  if (cached) return cached;
  const page = await deps.flights.run('page', `page:${step.id}`, async () => {
    const row = await deps.db.get<PageRow>('SELECT html, checksum FROM step_pages WHERE step_id = ?', step.id);
    return row ? { html: row.html, checksum: row.checksum } : null;
  });
  if (page) deps.pageCache.set(step.id, page);
  return page;
}

function trackingCookies(deps: Deps, c: Context, funnelId: string, stepId: string): void {
  const secure = new URL(c.req.url).protocol === 'https:' || c.req.header('x-forwarded-proto') === 'https';
  const base = { path: '/', sameSite: 'Lax' as const, secure };
  const cookies = c.req.header('cookie') ?? '';
  if (!/(?:^|; )visitor_id=/.test(cookies)) setCookie(c, 'visitor_id', randomBytes(12).toString('hex'), base);
  setCookie(c, 'funnel_id', funnelId, base);
  setCookie(c, 'step_id', stepId, base);
  const url = new URL(c.req.url);
  const utms = sanitizeUtms(Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map((k) => [k, url.searchParams.get(`utm_${k}`)])));
  for (const [k, v] of Object.entries(utms ?? {})) setCookie(c, `utm_${k}`, encodeURIComponent(v), base);
}

async function sendPage(deps: Deps, c: Context, step: StepRow, status = 200): Promise<Response> {
  const page = await pageFor(deps, step);
  if (!page) return messagePage(404, 'Page not found', 'This page has no content yet.');
  trackingCookies(deps, c, step.funnel_id, step.id);
  const etag = `"${page.checksum}"`;
  const headers: Record<string, string> = { etag, 'cache-control': 'private, max-age=0, must-revalidate', 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' };
  if (status === 200 && c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
  return c.html(page.html, status as 200, headers);
}

export type Resolution =
  | { kind: 'none' }
  | { kind: 'inactive' }
  | { kind: 'suspended' }
  | { kind: 'redirect'; location: string }
  | { kind: 'page'; status: 200 | 404; step: StepRow }
  | { kind: 'missing' };

/** Maps (hostname, path, query) to what a visitor should get. Shared by the in-process host router and the signed edge endpoint. */
export function resolveLive(deps: Deps, host: string, pathname: string, search: string): Promise<Resolution> {
  // Coalesced per host and path (the query string only matters for the redirect target, which is appended below).
  return deps.flights.run('resolve', `resolve:${host}${pathname}`, () => resolveUncached(deps, host, pathname), { shareMs: 300 }).then((r) => (r.kind === 'redirect' ? { ...r, location: r.location + search } : r));
}

async function resolveUncached(deps: Deps, host: string, pathname: string): Promise<Resolution> {
  const search = '';
  const domain = host ? await deps.db.get<DomainRow>('SELECT * FROM domains WHERE hostname = ?', host) : undefined;
  if (!domain) return { kind: 'none' };
  // A registered hostname never falls through to the app (which would serve the admin UI on a customer's domain).
  if (domain.status !== 'active') return { kind: 'inactive' };
  if (await isSuspended(deps, domain.workspace_id)) return { kind: 'suspended' };
  const key = pathKey(pathname);
  const step = await deps.db.get<StepRow>(
    `SELECT s.* FROM steps s JOIN funnels f ON f.id = s.funnel_id
     WHERE f.domain_id = ? AND f.status = 'live' AND f.deleted_at IS NULL AND s.path_key = ? ORDER BY f.updated_at DESC LIMIT 1`,
    domain.id, key,
  );
  // Canonical form: a different case or trailing slash is a permanent redirect to the stored path.
  if (step) return pathname !== step.base_path ? { kind: 'redirect', location: step.base_path + search } : { kind: 'page', status: 200, step };
  const liveStep = async (id: string | null): Promise<StepRow | undefined> =>
    id
      ? deps.db.get<StepRow>(`SELECT s.* FROM steps s JOIN funnels f ON f.id = s.funnel_id WHERE s.id = ? AND f.domain_id = ? AND f.status = 'live' AND f.deleted_at IS NULL`, id, domain.id)
      : undefined;
  if (key === '/') {
    const home = await liveStep(domain.default_home_step_id);
    if (home) return { kind: 'page', status: 200, step: home };
  }
  const notFound = await liveStep(domain.default_404_step_id);
  return notFound ? { kind: 'page', status: 404, step: notFound } : { kind: 'missing' };
}

/** Resolves the Host header to an active domain and serves its live funnels' steps. Everything else falls through to the app. */
export function hostRouting(deps: Deps): MiddlewareHandler {
  return async (c, next) => {
    const host = hostOf(c, deps.config.TRUST_PROXY);
    if (!host || !(await deps.flights.run('host', `host:${host}`, async () => !!(await deps.db.get('SELECT 1 FROM domains WHERE hostname = ?', host)), { shareMs: 300 }))) return next();
    const url = new URL(c.req.url);
    if (PASSTHROUGH.test(url.pathname)) return next();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return messagePage(405, 'Method not allowed', 'This page only accepts GET requests.');
    const rl = await deps.limiter.evaluate(['ip.global', 'public.page'], { ip: clientIp(c, deps.config) });
    if (rl.denied) throw denyError(rl.denied);
    const r = await resolveLive(deps, host, url.pathname, url.search);
    switch (r.kind) {
      case 'redirect':
        return c.redirect(r.location, 301);
      case 'page':
        return sendPage(deps, c, r.step, r.status);
      case 'inactive':
        return messagePage(404, 'Domain not connected', 'This domain has not been connected yet.');
      case 'suspended':
        return messagePage(503, 'Site unavailable', 'This site is currently unavailable.');
      default:
        return messagePage(404, 'Page not found', 'The page you are looking for does not exist.');
    }
  };
}

/** GET /preview/:funnelId/<step path>?token=... renders any funnel (test or live) from its stored documents for holders of a valid preview token. */
export function previewRoutes(deps: Deps): Hono {
  const r = new Hono();
  const handle = async (c: Context): Promise<Response> => {
    const funnelId = c.req.param('funnelId') as string;
    const token = c.req.query('token') ?? '';
    const claims = token ? await verifyPreviewToken(deps.config, token, funnelId, deps.now()) : null;
    // Previews are served from the app's own origin, so they are sandboxed: the page gets an opaque origin and can never read the admin app's
    // storage or call its API as the signed-in user (it can still run its own scripts, submit its forms to the public endpoints and open links).
    const noStore = { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox', 'x-content-type-options': 'nosniff' };
    if (!claims) return messagePage(401, 'Preview link expired', 'Open the preview again from the builder to get a fresh link.');
    const funnel = await deps.db.get<FunnelRow>('SELECT * FROM funnels WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', funnelId, claims.workspaceId);
    if (!funnel) return messagePage(404, 'Funnel not found', 'This funnel no longer exists.');
    if (await isSuspended(deps, funnel.workspace_id)) return messagePage(503, 'Site unavailable', 'This site is currently unavailable.');
    const steps = await listSteps(deps.db, funnel.workspace_id, funnel.id);
    const prefix = `/preview/${encodeURIComponent(funnel.id)}`;
    const rest = new URL(c.req.url).pathname.slice(prefix.length) || '/';
    const step = rest === '/' && !steps.some((s) => s.path_key === '/') ? steps[0] : steps.find((s) => s.path_key === pathKey(rest));
    if (!step) return messagePage(404, 'Step not found', 'No step of this funnel uses this path.');
    const page = await deps.db.get<PageRow>('SELECT * FROM step_pages WHERE step_id = ?', step.id);
    if (!page) return messagePage(404, 'Step not found', 'This step has no content yet.');
    const workspaceScripts = (await deps.db.get<{ v: number }>('SELECT allow_custom_scripts AS v FROM workspaces WHERE id = ?', funnel.workspace_id))?.v === 1;
    const { html } = renderStep(deps, {
      funnel, steps, step, docJson: page.doc_json, scriptsOk: page.scripts_ok === 1, workspaceScripts, mode: 'preview',
      adTags: await adTagsForStep(deps, funnel.workspace_id, funnel.id, step.id, loadDoc(page.doc_json), 'preview'),
      hrefFor: (s) => `${prefix}${s.base_path}?token=${encodeURIComponent(token)}`,
    });
    return c.html(html, 200, noStore);
  };
  r.get('/preview/:funnelId', handle);
  r.get('/preview/:funnelId/*', handle);
  return r;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain',
};

/** Serves the built web app (when present) with an index.html fallback for client-side routes. */
export function staticRoutes(deps: Deps): MiddlewareHandler | null {
  const root = deps.config.WEB_DIST ? resolve(deps.config.WEB_DIST) : null;
  if (!root || !existsSync(join(root, 'index.html'))) return null;
  const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; font-src 'self' data:; frame-src *; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'";
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return next();
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/') || path.startsWith('/preview/')) return next();
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return messagePage(400, 'Bad request', 'The URL is not valid.');
    }
    const file = resolve(root, '.' + normalize('/' + decoded));
    const isFile = (file === root || file.startsWith(root + sep)) && existsSync(file) && statSync(file).isFile();
    // Missing assets are real 404s; only extension-less routes fall back to the SPA shell.
    if (!isFile && extname(path)) return messagePage(404, 'Not found', 'There is nothing here.');
    const target = isFile ? file : join(root, 'index.html');
    const type = TYPES[extname(target)] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'content-type': type, 'x-content-type-options': 'nosniff' };
    if (target.endsWith('index.html')) Object.assign(headers, { 'cache-control': 'no-cache', 'content-security-policy': csp, 'x-frame-options': 'SAMEORIGIN' });
    else if (path.startsWith('/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
    return new Response(readFileSync(target), { status: 200, headers });
  };
}
