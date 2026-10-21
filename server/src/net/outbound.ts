import { assertPublicUrl, type HostLookup } from './ssrf.js';

/**
 * `fetch` for calls to third-party APIs (ad networks, Cloudflare): the target must be an http(s) URL whose host resolves only to public addresses (the same check
 * webhooks use), redirects are never followed (a redirect to an internal address is how SSRF filters are usually bypassed), and every call has a timeout.
 *
 * Limit: Node's `fetch` resolves the name again when it connects, so a hostile DNS server could answer differently the second time (rebinding). The destinations here are
 * fixed vendor hosts taken from configuration, never from users, which is why this is accepted; user-supplied destinations (webhooks) go through the pinned
 * `HttpClient` in ssrf.ts instead.
 */
export function guardedFetch(lookup: HostLookup, base: typeof fetch = fetch, timeoutMs = 20_000): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    await assertPublicUrl(url, lookup);
    return base(input, { ...init, redirect: 'manual', signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  };
}
