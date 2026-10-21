import type { Deps } from '../deps.js';
import { apiOriginOf } from './publishing.js';

/**
 * Which browser origins may call the public API (events, forms, checkout, attribution) with a readable answer. Pages served by this app on a customer domain are
 * same-origin; pages published to Cloudflare Pages call this app from another origin, so the answer must name them. Allowed: a hostname registered as a domain of any
 * workspace, the `<project>.pages.dev` host of a funnel published to Pages and its deployment preview subdomains, this app's own origin, and the opaque `null` origin of
 * sandboxed previews. Anything else gets no `Access-Control-Allow-Origin`, so another site's script cannot read responses (a beacon still reaches the server; it is
 * the same request an attacker could make with curl). PUBLIC_API_CORS=open restores the old `*`.
 */
const TTL_MS = 30_000;
const cache = new Map<string, { ok: boolean; until: number }>();

export function forgetCorsCache(): void {
  cache.clear();
}

export async function corsOriginFor(deps: Deps, origin: string | undefined): Promise<string | null> {
  if (deps.config.PUBLIC_API_CORS === 'open') return '*';
  if (!origin) return null;
  if (origin === 'null') return '*';
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  if (u.origin !== origin) return null; // paths, credentials or a trailing slash: not an origin
  const hit = cache.get(origin);
  const now = Date.now();
  if (hit && hit.until > now) return hit.ok ? origin : null;
  const ok = await allowed(deps, u);
  if (cache.size > 5000) cache.clear();
  cache.set(origin, { ok, until: now + TTL_MS });
  return ok ? origin : null;
}

async function allowed(deps: Deps, u: URL): Promise<boolean> {
  if (u.origin === apiOriginOf(deps)) return true;
  try {
    if (u.origin === new URL(deps.config.APP_PUBLIC_URL).origin) return true;
  } catch {
    /* configured value is not a URL */
  }
  if (deps.config.NODE_ENV !== 'production' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (await deps.db.get("SELECT 1 FROM domains WHERE hostname = ? AND kind = 'custom'", host)) return true;
  if (host.endsWith('.pages.dev')) {
    // name.pages.dev, or <deployment>.name.pages.dev / <branch>.name.pages.dev
    const labels = host.split('.');
    for (let i = 0; i <= labels.length - 3; i++) {
      const candidate = labels.slice(i).join('.');
      if (await deps.db.get('SELECT 1 FROM funnel_publish WHERE pages_host = ?', candidate)) return true;
    }
  }
  return false;
}
