import type { Deps } from '../deps.js';
import { stepUrls } from '../services/addresses.js';

export interface CloudflarePurger {
  /** Purges absolute URLs from the CDN cache. Implementations must be idempotent. */
  purgeUrls(urls: string[]): Promise<void>;
}

export class NoopPurger implements CloudflarePurger {
  async purgeUrls(): Promise<void> {}
}

/** Cloudflare "purge by URL" (max 30 files per call). */
export class CloudflareApiPurger implements CloudflarePurger {
  constructor(private opts: { zoneId: string; token: string; base: string; fetch?: typeof fetch }) {}

  async purgeUrls(urls: string[]): Promise<void> {
    const f = this.opts.fetch ?? fetch;
    const unique = [...new Set(urls)];
    for (let i = 0; i < unique.length; i += 30) {
      const res = await f(`${this.opts.base}/zones/${this.opts.zoneId}/purge_cache`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ files: unique.slice(i, i + 30) }),
      });
      if (!res.ok) throw new Error(`Cloudflare purge failed: HTTP ${res.status}`);
    }
  }
}

/**
 * Public URLs of a funnel's steps while it is live on an address a CDN may cache: https URLs on a customer domain, and the app's own URLs under the path prefix of a
 * built-in address (the app host may sit behind the edge Worker). Includes the home page "/" when it is the domain home, and the funnel root of a built-in address.
 * Pages and Workers hosts are not purged: every deployment replaces the whole site.
 */
export async function liveUrlsForFunnel(deps: Deps, funnelId: string): Promise<string[]> {
  const f = await deps.db.get<{ workspace_id: string; domain_id: string | null }>("SELECT workspace_id, domain_id FROM funnels WHERE id = ? AND status = 'live' AND deleted_at IS NULL", funnelId);
  if (!f?.domain_id) return [];
  const rows = await deps.db.all<{ hostname: string; kind: string; sid: string; home: string | null }>(
    `SELECT d.hostname, d.kind, s.id AS sid, d.default_home_step_id AS home FROM domains d JOIN steps s ON s.funnel_id = ? WHERE d.id = ?`,
    funnelId, f.domain_id,
  );
  const urls: string[] = [];
  for (const r of rows) {
    if (r.kind === 'custom' && r.home === r.sid) urls.push(`https://${r.hostname}/`);
  }
  for (const u of await stepUrls(deps, f.workspace_id, funnelId)) {
    if (u.address.kind === 'pages') continue;
    urls.push(u.url);
    if (u.address.kind === 'builtin') urls.push(`${u.address.base}/`);
  }
  return urls;
}

/** Queues a purge job (retried with backoff by the job worker). Safe to call inside a transaction. */
export async function schedulePurge(deps: Deps, urls: string[]): Promise<void> {
  if (urls.length === 0) return;
  await deps.jobs.enqueue('edge.purge', { urls: [...new Set(urls)] }, { maxAttempts: 5 });
}

export const purgeJob = (deps: Deps, payload: { urls: string[] }) => deps.purger.purgeUrls(payload.urls);
