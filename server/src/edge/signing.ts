import { createHmac, timingSafeEqual } from 'node:crypto';

/** Canonical string the edge worker signs: timestamp, nonce, method and the path with query. */
export const edgeSigningString = (ts: string, nonce: string, method: string, pathAndQuery: string): string => `${ts}.${nonce}.${method.toUpperCase()}.${pathAndQuery}`;

export const signEdge = (secret: string, ts: string, nonce: string, method: string, pathAndQuery: string): string =>
  createHmac('sha256', secret).update(edgeSigningString(ts, nonce, method, pathAndQuery)).digest('hex');

/** Remembers nonces for the skew window so a captured request cannot be replayed. Per process. */
export class NonceCache {
  private seen = new Map<string, number>();
  constructor(private ttlMs: number) {}

  /** Returns false when the nonce was already used. */
  use(nonce: string, now: number): boolean {
    for (const [n, exp] of this.seen) {
      if (exp > now) break; // insertion order is expiry order
      this.seen.delete(n);
    }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, now + this.ttlMs);
    return true;
  }
}

export type EdgeAuth = { ok: true } | { ok: false; status: 401 | 503; reason: string };

/**
 * Verifies an edge request. Fails closed: with no configured secret every request is refused
 * (the legacy implementation skipped verification when its secret was unset).
 */
export function verifyEdge(
  opts: { secret: string | undefined; skewSeconds: number; nonces: NonceCache; now: number },
  req: { method: string; pathAndQuery: string; headers: { get(name: string): string | null | undefined } },
): EdgeAuth {
  if (!opts.secret) return { ok: false, status: 503, reason: 'edge access is not configured' };
  const ts = req.headers.get('x-edge-timestamp') ?? '';
  const nonce = req.headers.get('x-edge-nonce') ?? '';
  const sig = req.headers.get('x-edge-signature') ?? '';
  if (!/^\d{9,12}$/.test(ts) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[0-9a-f]{64}$/.test(sig)) return { ok: false, status: 401, reason: 'malformed signature headers' };
  if (Math.abs(opts.now / 1000 - Number(ts)) > opts.skewSeconds) return { ok: false, status: 401, reason: 'timestamp outside the allowed window' };
  const expected = Buffer.from(signEdge(opts.secret, ts, nonce, req.method, req.pathAndQuery), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, status: 401, reason: 'bad signature' };
  // Only a correctly signed request may consume a nonce, so attackers cannot burn legitimate nonces.
  if (!opts.nonces.use(nonce, opts.now)) return { ok: false, status: 401, reason: 'nonce already used' };
  return { ok: true };
}
