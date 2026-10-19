import { AppError } from '../errors.js';
import type { Decision } from './types.js';

const secs = (ms: number) => Math.max(0, Math.ceil(ms / 1000));
/** Draft IETF RateLimit headers plus the legacy X-RateLimit-* trio, for the tightest decision; Retry-After only when refusing. */
export function limitHeaders(d: Decision): Record<string, string> {
  const h: Record<string, string> = {
    'RateLimit-Policy': `"${d.policyId}";q=${d.limit};w=${secs(d.windowMs)}`,
    RateLimit: `"${d.policyId}";r=${d.remaining};t=${secs(d.resetMs)}`,
    'X-RateLimit-Limit': String(d.limit),
    'X-RateLimit-Remaining': String(d.remaining),
    'X-RateLimit-Reset': String(secs(d.resetMs)),
  };
  if (!d.allowed) h['Retry-After'] = String(Math.max(1, secs(d.retryAfterMs)));
  return h;
}

/** The decision to report: the refusal if any, else the one with the least headroom. */
export function tightest(ds: Decision[]): Decision | undefined {
  const real = ds.filter((d) => d.outcome === 'allowed' || !d.allowed);
  return real.find((d) => !d.allowed) ?? real.sort((a, b) => a.remaining / a.capacity - b.remaining / b.capacity)[0];
}

export function denyError(d: Decision): AppError {
  const shed = d.status === 503;
  const retry = Math.max(1, secs(d.retryAfterMs));
  return new AppError(
    d.status,
    d.outcome === 'error' ? 'RATE_LIMITER_UNAVAILABLE' : shed ? 'OVERLOADED' : 'RATE_LIMITED',
    d.outcome === 'error' ? 'This request cannot be admitted right now. Try again shortly.' : shed ? 'Too many concurrent requests. Try again shortly.' : 'Too many requests. Slow down and retry later.',
    undefined,
    limitHeaders(d),
    { retry_after_s: retry, policy: d.policyId },
  );
}

