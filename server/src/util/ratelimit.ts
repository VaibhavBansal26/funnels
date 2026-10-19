import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors.js';

interface Bucket {
  tokens: number;
  updated: number;
}

export interface Limit {
  capacity: number;
  /** Tokens added per minute. */
  perMinute: number;
}

/** In-memory token bucket. Good enough for a single node; see ARCHITECTURE.md for the scaling note. */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private now: () => number = () => Date.now()) {}

  take(key: string, limit: Limit): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const t = this.now();
    const refill = limit.perMinute / 60_000;
    const b = this.buckets.get(key) ?? { tokens: limit.capacity, updated: t };
    b.tokens = Math.min(limit.capacity, b.tokens + (t - b.updated) * refill);
    b.updated = t;
    this.buckets.set(key, b);
    if (this.buckets.size > 50_000) this.prune(t);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - b.tokens) / refill / 1000)) };
  }

  private prune(t: number) {
    for (const [k, b] of this.buckets) if (t - b.updated > 10 * 60_000) this.buckets.delete(k);
  }
}

export function enforce(limiter: RateLimiter, key: string, limit: Limit): void {
  const r = limiter.take(key, limit);
  if (!r.ok) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many requests, slow down', { retryAfterSeconds: r.retryAfterSeconds }, {
      'Retry-After': String(r.retryAfterSeconds),
    });
  }
}

export function clientIp(c: { req: { header(n: string): string | undefined }; env?: unknown }, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = c.req.header('x-forwarded-for');
    if (fwd) return fwd.split(',')[0]!.trim();
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

export function rateLimit(
  limiter: RateLimiter,
  name: string,
  limit: Limit,
  keyOf: (c: Parameters<MiddlewareHandler>[0]) => string,
): MiddlewareHandler {
  return async (c, next) => {
    enforce(limiter, `${name}:${keyOf(c)}`, limit);
    await next();
  };
}
