import type { Deps } from '../deps.js';

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

/** Public URLs (https, with the home page "/" when it is the domain home) of a funnel's steps while it is live on a domain. */
export function liveUrlsForFunnel(deps: Deps, funnelId: string): string[] {
  const rows = deps.db.all<{ hostname: string; base_path: string; sid: string; home: string | null; nf: string | null }>(
    `SELECT d.hostname, s.base_path, s.id AS sid, d.default_home_step_id AS home, d.default_404_step_id AS nf
     FROM funnels f JOIN domains d ON d.id = f.domain_id JOIN steps s ON s.funnel_id = f.id
     WHERE f.id = ? AND f.status = 'live' AND f.deleted_at IS NULL`,
    funnelId,
  );
  const urls: string[] = [];
  for (const r of rows) {
    urls.push(`https://${r.hostname}${r.base_path}`);
    if (r.home === r.sid) urls.push(`https://${r.hostname}/`);
  }
  return urls;
}

/** Queues a purge job (retried with backoff by the job worker). Safe to call inside a transaction. */
export function schedulePurge(deps: Deps, urls: string[]): void {
  if (urls.length === 0) return;
  deps.jobs.enqueue('edge.purge', { urls: [...new Set(urls)] }, { maxAttempts: 5 });
}

export const purgeJob = (deps: Deps, payload: { urls: string[] }) => deps.purger.purgeUrls(payload.urls);
