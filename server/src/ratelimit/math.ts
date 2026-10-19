// The arithmetic shared (by hand-mirroring) between the in-memory store and the Lua scripts in scripts.ts.
// Keep the two in step: test/ratelimit.redis.test.ts replays random sequences against both and demands identical answers.

/**
 * Float tolerance in milliseconds. Epoch milliseconds (about 1.8e12) are only precise to about 2.4e-4 ms as doubles, and a GCRA state
 * accumulates one rounding per call, so an exact compare would refuse the last token of a burst after a few dozen calls (seen in tests).
 * 0.05 ms is far above that noise and far below anything a client could use.
 */
export const EPS = 0.05;

export interface GcraState {
  /** Theoretical arrival time in ms. */
  tat: number;
}

export interface GcraOutcome {
  allowed: boolean;
  newTat: number;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
}

/** Generic cell rate algorithm. One number of state per key; `capacity` is the burst size in cost units, `emissionMs` the time one unit takes to refill. */
export function gcra(tatIn: number | undefined, now: number, emissionMs: number, capacity: number, cost: number): GcraOutcome {
  const tat = tatIn === undefined || tatIn < now ? now : tatIn;
  const tau = emissionMs * capacity;
  const newTat = tat + cost * emissionMs;
  const diff = newTat - now;
  if (diff > tau + EPS) {
    return {
      allowed: false,
      newTat: tat,
      remaining: Math.max(0, Math.floor((tau - (tat - now)) / emissionMs + EPS)),
      resetMs: Math.ceil(tat - now),
      retryAfterMs: Math.max(1, Math.ceil(diff - tau - EPS)),
    };
  }
  return { allowed: true, newTat, remaining: Math.max(0, Math.floor((tau - diff) / emissionMs + EPS)), resetMs: Math.ceil(diff), retryAfterMs: 0 };
}

export interface WindowState {
  /** Index of the current fixed window, its count, and the previous window's count. */
  i: number;
  c: number;
  p: number;
}

export interface WindowOutcome {
  allowed: boolean;
  state: WindowState;
  remaining: number;
  resetMs: number;
  retryAfterMs: number;
}

/** Sliding-window counter: two adjacent fixed windows, the previous one weighted by how much of it still overlaps the sliding window. */
export function slidingWindow(prev: WindowState | undefined, now: number, limit: number, windowMs: number, cost: number, mode: 'consume' | 'check'): WindowOutcome {
  const idx = Math.floor(now / windowMs);
  let s: WindowState = prev ?? { i: idx, c: 0, p: 0 };
  if (idx === s.i + 1) s = { i: idx, c: 0, p: s.c };
  else if (idx > s.i + 1) s = { i: idx, c: 0, p: 0 };
  const elapsed = now - idx * windowMs;
  const weight = (windowMs - elapsed) / windowMs;
  const est = s.p * weight + s.c;
  const allowed = mode === 'check' ? est < limit - EPS : est + cost <= limit + EPS;
  const resetMs = Math.max(1, Math.ceil(windowMs - elapsed));
  if (allowed) {
    if (mode === 'consume') s = { ...s, c: s.c + cost };
    const after = mode === 'consume' ? est + cost : est;
    return { allowed, state: s, remaining: Math.max(0, Math.floor(limit - after + EPS)), resetMs, retryAfterMs: 0 };
  }
  const need = mode === 'check' ? 0 : cost;
  let retry: number;
  if (cost > limit && mode === 'consume') retry = windowMs; // can never fit: the wait is capped at one window
  else {
    const room = limit - s.c - need;
    if (room >= 0) {
      const fNeeded = s.p > 0 ? 1 - room / s.p : 0;
      retry = Math.max(0, (Math.max(fNeeded, elapsed / windowMs) - elapsed / windowMs) * windowMs);
    } else {
      const roomNext = limit - need;
      const fNext = s.c > 0 ? Math.max(0, 1 - roomNext / s.c) : 0;
      retry = windowMs - elapsed + fNext * windowMs;
    }
  }
  return { allowed, state: s, remaining: Math.max(0, Math.floor(limit - est + EPS)), resetMs, retryAfterMs: Math.max(1, Math.ceil(retry)) };
}
